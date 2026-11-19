/**
 * The settlement orchestrator — the state machine's only driver.
 *
 * Two invariants run the whole rail (arch doc §3):
 *
 *   1. No USDC moves before the BFI's signed payout approval is held.
 *   2. `BENEFICIARY_CREDIT_CONFIRMED` is never declared before an L2+ signed
 *      payout completion arrives *and* the six-axis reconciliation passes.
 *
 * Both are enforced by construction: the wallet instruction is derived from
 * the approval event, and the confirmed transition sits behind
 * `reconcilePayment`. Everything the orchestrator asserts itself is signed
 * with the platform key; everything a partner asserts arrives signed by that
 * partner and is verified against the Trust Registry before it is stored.
 */
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import { signedBytes, fromBase64Url } from '@stonehash/attest-rules';
import { verify as cryptoVerify } from 'node:crypto';
import { signEvent, verifyEvent, publicKeyFromSpki, sha256hex } from './sign.ts';
import type { EventSig, PlatformKey } from './sign.ts';
import { buildIvms101, missingTravelRuleFields } from './ivms101.ts';
import type { CompliancePayloadInput } from './ivms101.ts';
import { encryptJwe } from './jwe.ts';
import { reconcilePayment, assemblePackage, packageCommitment, newNonce } from './evidence.ts';
import type { Registry, Institution } from './registry.ts';
import type { RemitStore, RemitPayment } from './store.ts';
import { isDuplicateKeyError } from '../db.ts';
import { sourceRefOf } from './store.ts';
import type { SourceConflict, SourceRef } from './store.ts';
import type { BfiConnector, SettlementWallet } from './partners-client.ts';
import type { WebhookOutbox } from './webhook.ts';
import type { QuoteResponse } from './quotes.ts';

type Dict = Record<string, unknown>;

export interface SettlementRequest {
  request_id?: string;
  payment_id?: string;
  quote_id?: string;
  corridor?: { origin?: string; destination?: string };
  amount?: {
    collected?: { currency?: string; value?: string };
    payout?: { currency?: string; value?: string };
  };
  bank_authorization?: Dict;
  bank_signature?: EventSig;
  commercial_reference?: { invoice_ref?: string; invoice_commitment?: string };
  beneficiary?: { institution_id?: string; beneficiary_ref?: string };
  compliance_payload?: CompliancePayloadInput & {
    mode?: 'A' | 'B';
    ciphertext?: string;
    ivms101_digest?: string;
    fields_assertion?: { payload: Dict; sig: EventSig };
  };
  /** Mode B storage shape (set by redactCompliance). */
  compliance_ciphertext?: { ciphertext: string; ivms101_digest: string };
  evidence_elements?: {
    bankInstruction?: Dict;
    bankApproval?: Dict;
    commercialDocs?: Dict;
  };
}

export interface OrchestratorDeps {
  store: RemitStore;
  registry: Registry;
  svc: AttestService;
  bfi: BfiConnector;
  wallet: SettlementWallet;
  outbox: WebhookOutbox;
  platform: PlatformKey;
  acceptDemoFinality: boolean;
  chainLabel: string;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Verify an attest-rules-convention element signature with node crypto. */
function elementSigValid(element: Dict, spkiBase64: string): boolean {
  const sig = element.signature as { value?: string } | undefined;
  if (!sig?.value) return false;
  try {
    return cryptoVerify('sha256', Buffer.from(signedBytes(element)),
      { key: publicKeyFromSpki(spkiBase64), dsaEncoding: 'ieee-p1363' },
      Buffer.from(fromBase64Url(sig.value)));
  } catch {
    return false;
  }
}

/**
 * Mode B: is the bank's signed statement about *this* message?
 *
 * The platform cannot read a mode B message, so everything rests on what
 * the bank put its key to. A statement that says only "the required fields
 * are present" stays true of any other ciphertext put in its place — and
 * with it another beneficiary account. So the statement must also carry the
 * digest of the message and the SHA-256 of the compact JWE, and both must be
 * the ones submitted. Returns what is wrong, or null.
 */
export function fieldsAssertionProblem(
  fa: { payload: Dict; sig: EventSig } | undefined,
  expect: { paymentId: string; ivms101Digest: string; ciphertext: string; bankSpki: string },
): string | null {
  if (!fa?.payload || !fa.sig || !verifyEvent(fa.payload, fa.sig, expect.bankSpki)) {
    return 'mode B requires a bank-signed fields_assertion over the required-fields claim';
  }
  if (fa.payload.payment_id !== expect.paymentId || fa.payload.required_fields_present !== true) {
    return 'fields_assertion must name this payment_id and assert required_fields_present: true';
  }
  if (fa.payload.ivms101_digest !== expect.ivms101Digest
    || fa.payload.ciphertext_sha256 !== sha256hex(Buffer.from(expect.ciphertext, 'utf8'))) {
    return 'fields_assertion must carry ivms101_digest and ciphertext_sha256 (the SHA-256 of the compact JWE), and both must be '
      + 'the ones submitted — the bank\'s signature has to cover the message it vouches for, or another could be put in its place';
  }
  return null;
}

export class RemitOrchestrator {
  private readonly d: OrchestratorDeps;
  constructor(d: OrchestratorDeps) { this.d = d; }

  private async webhookUrl(orgId: string): Promise<string | undefined> {
    const sub = await this.d.registry.subscription(orgId, 'remit');
    if (!sub) return undefined;
    const cfg = JSON.parse(sub.config) as { webhook_url?: string };
    return cfg.webhook_url;
  }

  private async notify(p: RemitPayment, seq: number, type: string, data: Record<string, unknown>): Promise<void> {
    const fresh = (await this.d.store.get(p.id))!;
    await this.d.outbox.enqueue(p.org_id, await this.webhookUrl(p.org_id), p.id, seq, type, fresh.state, data);
  }

  private async platformEvent(paymentId: string, type: string, payload: Dict): Promise<number> {
    const sig = signEvent(payload, this.d.platform.key, this.d.platform.keyId, 'STONEHASH');
    return (await this.d.store.appendEvent(paymentId, type, 'STONEHASH', payload, sig)).seq;
  }

  // ── Settlement acceptance (synchronous half) ─────────────────────────────

  /**
   * Validate and accept a settlement request. Throws a 4xx before anything is
   * stored — an instruction that fails verification is refused, not recorded
   * (§8-2 row one). On success the payment exists in `BANK_AUTHORIZED` and the
   * asynchronous pipeline is scheduled.
   */
  async acceptSettlement(orgId: string, bank: Institution, body: SettlementRequest): Promise<{
    payment_id: string; state: string; accepted_at: string;
  }> {
    const paymentId = must(body.payment_id, 'payment_id');
    const quoteId = must(body.quote_id, 'quote_id');
    if (await this.d.store.get(paymentId)) throw duplicatePayment(paymentId);

    // Quote: must exist, belong to this org, and still be alive.
    const quoteRow = await this.d.store.quote(orgId, quoteId);
    if (!quoteRow) throw new ServiceError(400, 'quote_not_found', `no quote ${quoteId} for this organisation`);
    if (Date.parse(quoteRow.expires_at) < Date.now()) {
      throw new ServiceError(409, 'quote_expired',
        `quote ${quoteId} expired at ${quoteRow.expires_at}; request a fresh quote`);
    }
    const quote = JSON.parse(quoteRow.response) as QuoteResponse;

    // Amounts must restate the quote exactly — the instruction is the bank
    // committing to the quoted legs, not proposing new ones.
    const collected = body.amount?.collected;
    const payout = body.amount?.payout;
    if (collected?.currency !== quote.collect.currency || collected?.value !== quote.collect.amount) {
      throw new ServiceError(400, 'amount_mismatch',
        `collected amount must restate the quote: ${quote.collect.amount} ${quote.collect.currency}`);
    }
    if (payout?.currency !== quote.payout.currency || payout?.value !== quote.payout.amount) {
      throw new ServiceError(400, 'amount_mismatch',
        `payout amount must restate the quote: ${quote.payout.amount} ${quote.payout.currency}`);
    }

    // Beneficiary institution: registered, right role, able to receive PII.
    const bfiId = must(body.beneficiary?.institution_id, 'beneficiary.institution_id');
    const bfi = await this.d.registry.institution(bfiId);
    if (!bfi || bfi.role !== 'BENEFICIARY_FI') {
      throw new ServiceError(400, 'unknown_beneficiary_institution',
        `${bfiId} is not a registered BENEFICIARY_FI`);
    }
    if (!bfi.encryption_jwk) {
      throw new ServiceError(502, 'bfi_has_no_encryption_key',
        `${bfiId} has no encryption key registered, so the Travel Rule payload cannot be protected`);
    }

    // The bank's authorisation signature — the legal heart of the request.
    const authz = body.bank_authorization;
    const bankSig = body.bank_signature;
    if (!authz || typeof authz !== 'object') throw new ServiceError(400, 'missing_field', 'bank_authorization is required');
    if (!bankSig?.sig) throw new ServiceError(400, 'missing_field', 'bank_signature is required');
    if (!bank.signing_spki || !verifyEvent(authz, bankSig, bank.signing_spki)) {
      throw new ServiceError(400, 'invalid_signature',
        'bank_signature does not verify over bank_authorization with the registered COLLECTION_BANK key');
    }

    // Travel Rule completeness, before anything is accepted.
    const compliance = body.compliance_payload ?? {};
    if (compliance.mode === 'B') {
      /*
       * Bank-SDK mode: the PII is already ciphertext and this service cannot
       * check the fields. What it can check: the ciphertext exists, and the
       * bank signed an assertion that the required fields are present —
       * which puts the claim on the bank's key, where it belongs. The
       * substantive check is the BFI's ACK after decryption.
       */
      if (!compliance.ciphertext || !/^[0-9a-f]{64}$/.test(compliance.ivms101_digest ?? '')) {
        throw new ServiceError(400, 'travel_rule_incomplete',
          'mode B requires ciphertext (compact JWE) and ivms101_digest');
      }
      const problem = fieldsAssertionProblem(compliance.fields_assertion, {
        paymentId, ivms101Digest: compliance.ivms101_digest!, ciphertext: compliance.ciphertext, bankSpki: bank.signing_spki,
      });
      if (problem) throw new ServiceError(400, 'invalid_fields_assertion', problem);
    } else {
      const missing = missingTravelRuleFields(compliance);
      if (missing.length > 0) {
        throw new ServiceError(400, 'travel_rule_incomplete',
          `compliance_payload is missing required fields: ${missing.join(', ')}`);
      }
    }

    // Pre-signed bank evidence elements, verified and checked for consistency
    // with the quote they will later be reconciled against.
    const els = body.evidence_elements ?? {};
    for (const key of ['bankInstruction', 'bankApproval', 'commercialDocs'] as const) {
      const el = els[key];
      if (!el) throw new ServiceError(400, 'missing_evidence_element', `evidence_elements.${key} is required`);
      if (!elementSigValid(el, bank.signing_spki)) {
        throw new ServiceError(400, 'invalid_evidence_signature',
          `evidence_elements.${key} signature does not verify with the registered bank key`);
      }
    }
    const instr = els.bankInstruction!;
    if (instr.amount !== quote.trade.amount || instr.currency !== 'USD') {
      throw new ServiceError(400, 'evidence_inconsistent',
        `bankInstruction must instruct the quoted trade amount ${quote.trade.amount} USD`);
    }
    if (instr.ref !== paymentId) {
      throw new ServiceError(400, 'evidence_inconsistent',
        'bankInstruction.ref must carry the payment_id (the corridor settlement id)');
    }

    /*
     * One settlement per message. Where the instruction was made from a SWIFT
     * message, the bank signed a reference to that message into it; the same
     * message under another payment id is the same payment sent again — the
     * double payment a duplicate check exists to stop. It is stopped here, on
     * the platform, because only here can two requests arriving together not
     * both pass: a check in the bank's system sees neither while both are on
     * their way.
     */
    const source = sourceRefOf((instr as { sourceMessage?: unknown }).sourceMessage);
    const fresh = {
      id: paymentId,
      org_id: orgId,
      quote_id: quoteId,
      corridor_origin: quote.corridor.origin,
      corridor_destination: quote.corridor.destination,
      trade_currency: quote.trade.currency,
      trade_amount: quote.trade.amount,
      collect_currency: quote.collect.currency,
      collect_amount: quote.collect.amount,
      usdc_amount: quote.settlement.amount,
      payout_currency: quote.payout.currency,
      payout_amount: quote.payout.amount,
      beneficiary_institution: bfiId,
      request_body: JSON.stringify(redactCompliance(body)),
    };

    // Accept: the payment now exists, and every stored byte above was verified.
    // What the settlement is accepted on is written with it, in one transaction: its opening
    // events and its first state. A settlement never stands in the ledger without them — a
    // request that lost a race to this one reads it whole.
    const acceptedAt = new Date().toISOString();
    let seq = 0;
    const born = async (store: RemitStore): Promise<void> => {
      const platformEvent = async (type: string, payload: Dict): Promise<number> =>
        (await store.appendEvent(paymentId, type, 'STONEHASH', payload,
          signEvent(payload, this.d.platform.key, this.d.platform.keyId, 'STONEHASH'))).seq;
      await platformEvent('REQUEST_ACCEPTED',
        { payment_id: paymentId, request_id: body.request_id ?? null, quote_id: quoteId, accepted_at: acceptedAt });
      await store.appendEvent(paymentId, 'BANK_EVIDENCE_SUBMITTED', bank.id, {
        bankInstruction: els.bankInstruction!,
        bankApproval: els.bankApproval!,
        commercialDocs: els.commercialDocs!,
      });
      seq = await platformEvent('BANK_AUTHORIZATION_VERIFIED', {
        payment_id: paymentId,
        bank_authorization: authz as Dict,
        bank_signature: bankSig as unknown as Dict,
        verified_at: acceptedAt,
      });
      await store.transition(paymentId, 'BANK_AUTHORIZED');
    };

    let p: RemitPayment;
    try {
      if (source) {
        const made = await this.d.store.createFromMessage(fresh, source, born);
        if ('idTaken' in made) throw duplicatePayment(paymentId);
        if ('conflict' in made) throw sourceConflictError(source, made.conflict);
        p = made.payment;
      } else {
        p = await this.d.store.create(fresh, born);
      }
    } catch (e) {
      // Two requests under one payment id arrived together and both passed the check at the
      // top: the row of the first is the answer to the second — "exists", not a failure.
      if (isDuplicateKeyError(e)) throw duplicatePayment(paymentId);
      throw e;
    }

    await this.notify(p, seq, 'BANK_AUTHORIZED', { quote_id: quoteId });

    // The pipeline continues off this request's lifetime.
    setImmediate(() => {
      void this.advance(p.id).catch((e) => {
        this.d.log('remit advance failed', { payment: p.id, error: e instanceof Error ? e.message : String(e) });
      });
    });

    return { payment_id: p.id, state: 'BANK_AUTHORIZED', accepted_at: acceptedAt };
  }

  // ── Asynchronous pipeline: travel rule → approval → transfer ─────────────

  /**
   * Run the pipeline from wherever the payment currently stands. Resumable
   * by design: an RFI pause, a cancel, or a process restart leaves the state
   * machine describing exactly what remains, and this function reads it
   * rather than remembering it.
   */
  async advance(paymentId: string): Promise<void> {
    let p = await this.d.store.get(paymentId);
    if (!p) return;
    try {
      if (p.state === 'BANK_AUTHORIZED') {
        const outcome = await this.travelRuleLeg(p);
        if (outcome === 'RFI') return;   // paused: the bank must answer first
        p = (await this.d.store.get(paymentId))!;
      }
      if (p.state === 'TRAVEL_RULE_PENDING') {
        // Only proceed once the BFI's signed acceptance is on file — an
        // unanswered RFI leaves no TRAVEL_RULE_RECEIVED event and stops here.
        if (!(await this.d.store.eventOfType(p.id, 'TRAVEL_RULE_RECEIVED'))) return;
        await this.approvalLeg(p);
        p = (await this.d.store.get(paymentId))!;
      }
      if (p.state === 'PAYOUT_PRE_APPROVED') {
        await this.transferLeg(p);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const current = (await this.d.store.get(paymentId))?.state;
      // A leg that already parked the payment in a terminal state (e.g. a
      // travel-rule rejection → CANCELLED) throws to stop the pipeline; that
      // is a stop signal, not a second failure to record.
      if (current === 'CANCELLED' || current === 'RETURNED' || current === 'EXCEPTION') {
        this.d.log('remit pipeline stopped', { payment: paymentId, state: current, cause: msg });
        return;
      }
      const seq = await this.platformEvent(paymentId, 'EXCEPTION',
        { payment_id: paymentId, at_state: current ?? '?', error: msg });
      await this.d.store.transition(paymentId, 'EXCEPTION');
      await this.notify(p, seq, 'EXCEPTION', { error: msg });
      this.d.log('remit payment moved to EXCEPTION', { payment: paymentId, error: msg });
    }
  }

  private async travelRuleLeg(p: RemitPayment): Promise<'ACK' | 'RFI'> {
    const req = JSON.parse(p.request_body) as SettlementRequest & { compliance_plaintext?: CompliancePayloadInput };
    const bfi = (await this.d.registry.institution(p.beneficiary_institution))!;
    const bank = (await this.d.registry.institutionForOrg(p.org_id, 'COLLECTION_BANK'))!;
    const settle = await this.requireSettlementEntity();

    let ciphertext: string;
    let digest: string;
    let mode: 'A' | 'B';
    if (req.compliance_plaintext) {
      // Mode A (server mode): the relay maps and encrypts.
      mode = 'A';
      const ivms = buildIvms101(req.compliance_plaintext, {
        paymentId: p.id,
        tradeAmount: p.trade_amount,
        tradeCurrency: p.trade_currency,
        originatingInstitution: { id: bank.id, name: bank.name, country: bank.country ?? 'VN' },
        beneficiaryInstitution: { id: bfi.id, name: bfi.name, country: bfi.country ?? 'SG' },
        settlementEntity: { id: settle.id, name: settle.name },
        usdcAmount: p.usdc_amount,
      });
      digest = sha256hex(Buffer.from(jcs(ivms as JcsValue)));
      ciphertext = encryptJwe(Buffer.from(JSON.stringify(ivms), 'utf8'),
        JSON.parse(bfi.encryption_jwk!) as JsonWebKey, `${bfi.id}-ENC`);
    } else {
      // Mode B (bank SDK mode): the bank encrypted; the relay never saw
      // plaintext and cannot check the fields — the fields assertion was
      // verified at acceptance, and the real check is the BFI's ACK.
      mode = 'B';
      const cp = req.compliance_ciphertext;
      if (!cp?.ciphertext || !cp.ivms101_digest) {
        throw new Error('compliance payload absent from stored request');
      }
      ciphertext = cp.ciphertext;
      digest = cp.ivms101_digest;
    }

    // The plaintext's work is done: from here the relay holds digest and
    // ciphertext only (§6-5 Encrypted Relay Store).
    await this.d.store.saveTravelRule(p.id, bfi.id, ciphertext, digest, 'SENT', undefined);
    await this.scrubCompliance(p);

    const sentSeq = await this.platformEvent(p.id, 'TRAVEL_RULE_SENT', {
      payment_id: p.id,
      protocol: 'IVMS101/JWE',
      mode,
      recipient: bfi.id,
      ivms101_digest: digest,
      ciphertext_commitment: sha256hex(Buffer.from(ciphertext, 'utf8')),
      sent_at: new Date().toISOString(),
    });
    await this.d.store.transition(p.id, 'TRAVEL_RULE_PENDING');
    await this.notify(p, sentSeq, 'TRAVEL_RULE_PENDING', { ivms101_digest: digest, mode });

    const sender = signEvent({ payment_id: p.id, ivms101_digest: digest },
      this.d.platform.key, this.d.platform.keyId, 'STONEHASH');
    const ack = await this.d.bfi.sendTravelRule(p.id, ciphertext, digest, sender);

    if (ack.status === 'REJECTED') {
      const seq = (await this.d.store.appendEvent(p.id, 'TRAVEL_RULE_REJECTED', bfi.id,
        { payment_id: p.id, reason: ack.reason ?? 'rejected' }, null)).seq;
      await this.d.store.transition(p.id, 'CANCELLED');
      await this.notify(p, seq, 'CANCELLED', { reason: ack.reason ?? 'travel rule rejected' });
      throw new Error(`travel rule rejected: ${ack.reason ?? 'no reason given'}`);
    }
    if (ack.status === 'RFI') {
      // Not a failure: the receiving institution wants more before it will
      // accept the transfer. The pipeline pauses and the bank answers via
      // POST /v1/settlements/{id}/rfi-response (§8-2 row four).
      const rfi = ack.rfi ?? { id: `RFI-${p.id}`, questions: [ack.reason ?? 'additional information requested'] };
      const seq = (await this.d.store.appendEvent(p.id, 'TRAVEL_RULE_RFI', bfi.id,
        { payment_id: p.id, rfi_id: rfi.id, questions: rfi.questions, raised_at: new Date().toISOString() },
        ack.ack?.sig ?? null)).seq;
      await this.notify(p, seq, 'TRAVEL_RULE_RFI', { rfi_id: rfi.id, questions: rfi.questions });
      return 'RFI';
    }
    if (ack.status !== 'ACK' || !ack.ack) {
      throw new Error(`unexpected travel-rule response: ${ack.status}`);
    }
    await this.verifyPartnerSig(ack.ack.payload, ack.ack.sig, 'BENEFICIARY_FI');
    await this.d.store.appendEvent(p.id, 'TRAVEL_RULE_RECEIVED', bfi.id, ack.ack.payload, ack.ack.sig);
    return 'ACK';
  }

  /**
   * The bank answers an RFI. The answers are encrypted to the BFI exactly
   * like the original message; the platform stores digests, never content.
   */
  async respondRfi(orgId: string, bank: Institution, paymentId: string, body: {
    answers?: Record<string, string>; sig?: EventSig;
  }): Promise<{ payment_id: string; state: string }> {
    const p = await this.d.store.get(paymentId);
    if (!p || p.org_id !== orgId) throw new ServiceError(404, 'payment_not_found', `no payment ${paymentId}`);
    if (p.state !== 'TRAVEL_RULE_PENDING') {
      throw new ServiceError(409, 'wrong_state', `payment is ${p.state}; RFI answers apply while TRAVEL_RULE_PENDING`);
    }
    const rfiEvent = await this.d.store.eventOfType(p.id, 'TRAVEL_RULE_RFI');
    if (!rfiEvent) throw new ServiceError(409, 'no_rfi', 'no outstanding RFI on this payment');
    if (await this.d.store.eventOfType(p.id, 'TRAVEL_RULE_RECEIVED')) {
      throw new ServiceError(409, 'already_resolved', 'this RFI was already resolved');
    }
    const answers = body.answers;
    if (!answers || Object.keys(answers).length === 0) {
      throw new ServiceError(400, 'missing_field', 'answers is required');
    }
    if (!body.sig || !bank.signing_spki
      || !verifyEvent({ payment_id: p.id, answers }, body.sig, bank.signing_spki)) {
      throw new ServiceError(400, 'invalid_signature', 'sig must cover {payment_id, answers} with the bank key');
    }

    const bfi = (await this.d.registry.institution(p.beneficiary_institution))!;
    const rfiPayload = JSON.parse(rfiEvent.payload) as { rfi_id: string };
    const message = { payment_id: p.id, rfi_id: rfiPayload.rfi_id, answers };
    const ciphertext = encryptJwe(Buffer.from(JSON.stringify(message), 'utf8'),
      JSON.parse(bfi.encryption_jwk!) as JsonWebKey, `${bfi.id}-ENC`);
    const answersDigest = sha256hex(Buffer.from(jcs(message as unknown as JcsValue)));

    const sender = signEvent({ payment_id: p.id, rfi_id: rfiPayload.rfi_id, answers_digest: answersDigest },
      this.d.platform.key, this.d.platform.keyId, 'STONEHASH');
    const ack = await this.d.bfi.sendTravelRuleResponse(p.id, ciphertext, answersDigest, sender);
    if (ack.status === 'REJECTED' || !ack.ack) {
      const seq = (await this.d.store.appendEvent(p.id, 'TRAVEL_RULE_REJECTED', bfi.id,
        { payment_id: p.id, reason: ack.reason ?? 'rejected after RFI' }, null)).seq;
      await this.d.store.transition(p.id, 'CANCELLED');
      await this.notify(p, seq, 'CANCELLED', { reason: ack.reason ?? 'rejected after RFI' });
      return { payment_id: p.id, state: 'CANCELLED' };
    }
    await this.verifyPartnerSig(ack.ack.payload, ack.ack.sig, 'BENEFICIARY_FI');
    const seq = await this.platformEvent(p.id, 'TRAVEL_RULE_RFI_RESOLVED', {
      payment_id: p.id, rfi_id: rfiPayload.rfi_id, answers_digest: answersDigest,
      resolved_at: new Date().toISOString(),
    });
    await this.d.store.appendEvent(p.id, 'TRAVEL_RULE_RECEIVED', bfi.id, ack.ack.payload, ack.ack.sig);
    await this.notify(p, seq, 'TRAVEL_RULE_RFI_RESOLVED', { rfi_id: rfiPayload.rfi_id });

    setImmediate(() => {
      void this.advance(p.id).catch((e) => {
        this.d.log('remit advance after RFI failed', { payment: p.id, error: e instanceof Error ? e.message : String(e) });
      });
    });
    return { payment_id: p.id, state: (await this.d.store.get(p.id))!.state };
  }

  /**
   * Cancel before pre-approval (§8-2): allowed while the BFI has not yet
   * committed a deposit address. Funds have not moved — the VND stays at the
   * bank, which refunds its customer through its own ledger.
   */
  async cancel(orgId: string, bank: Institution, paymentId: string, body: {
    reason?: string; sig?: EventSig;
  }): Promise<{ payment_id: string; state: string }> {
    const p = await this.d.store.get(paymentId);
    if (!p || p.org_id !== orgId) throw new ServiceError(404, 'payment_not_found', `no payment ${paymentId}`);
    const cancellable = ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING'];
    if (!cancellable.includes(p.state)) {
      throw new ServiceError(409, 'not_cancellable',
        `payment is ${p.state}; cancellation is only possible before payout pre-approval`);
    }
    const reason = body.reason ?? 'cancelled by instructing bank';
    if (!body.sig || !bank.signing_spki
      || !verifyEvent({ payment_id: p.id, reason }, body.sig, bank.signing_spki)) {
      throw new ServiceError(400, 'invalid_signature', 'sig must cover {payment_id, reason} with the bank key');
    }
    const seq = (await this.d.store.appendEvent(p.id, 'CANCEL_REQUESTED', bank.id,
      { payment_id: p.id, reason, requested_at: new Date().toISOString() }, body.sig)).seq;
    await this.d.store.transition(p.id, 'CANCELLED');
    await this.notify(p, seq, 'CANCELLED', { reason, by: bank.id });
    // Best effort: the BFI drops its record so a stale pre-approval cannot
    // linger. Failure is logged, not fatal — the state machine already
    // guarantees no transfer can follow.
    try {
      await this.d.bfi.notifyCancel(p.id, reason, signEvent({ payment_id: p.id, reason },
        this.d.platform.key, this.d.platform.keyId, 'STONEHASH'));
    } catch (e) {
      this.d.log('BFI cancel notice failed', { payment: p.id, error: e instanceof Error ? e.message : String(e) });
    }
    return { payment_id: p.id, state: 'CANCELLED' };
  }

  private async approvalLeg(p: RemitPayment): Promise<void> {
    const bfi = (await this.d.registry.institution(p.beneficiary_institution))!;
    const quote = JSON.parse((await this.d.store.quote(p.org_id, p.quote_id))!.response) as QuoteResponse;
    const tr = await this.d.store.travelRule(p.id);

    const requestPayload = {
      payment_id: p.id,
      quote_id: p.quote_id,
      usdc_amount: p.usdc_amount,
      trade: { currency: p.trade_currency, amount: p.trade_amount },
      payout: { currency: p.payout_currency, amount: p.payout_amount },
      quote: { usd_sgd: quote.payout.rate, quoted_at: quote.quoted_at, expires_at: quote.expires_at },
      ivms101_digest: tr?.ivms101_digest ?? '',
    };
    const res = await this.d.bfi.requestPayoutApproval({
      ...requestPayload,
      sender: signEvent(requestPayload, this.d.platform.key, this.d.platform.keyId, 'STONEHASH'),
    });

    const approval = res.approval;
    await this.verifyPartnerSig(approval.payload, approval.sig, 'BENEFICIARY_FI');
    if (approval.payload.payment_id !== p.id || approval.payload.usdc_amount !== p.usdc_amount) {
      throw new Error('payout approval does not restate the payment it approves');
    }
    const seq = (await this.d.store.appendEvent(p.id, 'PAYOUT_ACCEPTED', bfi.id,
      approval.payload as unknown as Dict, approval.sig)).seq;
    await this.d.store.patch(p.id, { deposit_address: approval.payload.deposit_address });
    await this.d.store.transition(p.id, 'PAYOUT_PRE_APPROVED');
    await this.notify(p, seq, 'PAYOUT_PRE_APPROVED', {
      deposit_address: approval.payload.deposit_address,
      valid_until: approval.payload.valid_until,
    });
  }

  private async transferLeg(p: RemitPayment): Promise<void> {
    const fresh = (await this.d.store.get(p.id))!;
    // Invariant 1, enforced where it matters: the instruction is derived from
    // the stored, signature-verified approval event — no approval, no address,
    // no transfer.
    const approvalEvent = await this.d.store.eventOfType(p.id, 'PAYOUT_ACCEPTED');
    if (!approvalEvent || !fresh.deposit_address) {
      throw new Error('no signed payout approval on file — refusing to instruct the settlement wallet');
    }

    const instruction = {
      payment_id: p.id,
      to_address: fresh.deposit_address,
      usdc_amount: p.usdc_amount,
      chain: this.d.chainLabel,
      derived_from_approval_seq: approvalEvent.seq,
      issued_at: new Date().toISOString(),
    };
    const instructionSig = signEvent(instruction, this.d.platform.key, this.d.platform.keyId, 'STONEHASH');
    const instrSeq = await this.platformEvent(p.id, 'SETTLEMENT_INSTRUCTED',
      { ...instruction, signature: instructionSig as unknown as Dict });
    await this.notify(p, instrSeq, 'SETTLEMENT_INSTRUCTED', { to_address: fresh.deposit_address });

    const res = await this.d.wallet.transfer({ instruction: { payload: instruction, sig: instructionSig } });
    await this.verifyPartnerSig(res.result.payload, res.result.sig, 'SETTLEMENT_ENTITY');
    if (res.result.payload.payment_id !== p.id) throw new Error('wallet result names a different payment');

    const settle = await this.requireSettlementEntity();
    const seq = (await this.d.store.appendEvent(p.id, 'USDC_TRANSFER_CONFIRMED', settle.id,
      res.result.payload as unknown as Dict, res.result.sig)).seq;
    await this.d.store.patch(p.id, { chain_tx: res.result.payload.tx_hash });
    await this.d.store.transition(p.id, 'ONCHAIN_SETTLED');
    await this.notify(p, seq, 'ONCHAIN_SETTLED', {
      tx_hash: res.result.payload.tx_hash, block: res.result.payload.block,
    });

    await this.d.bfi.notifySettlement(p.id, res.result.payload.tx_hash,
      signEvent({ payment_id: p.id, tx_hash: res.result.payload.tx_hash },
        this.d.platform.key, this.d.platform.keyId, 'STONEHASH'));
  }

  // ── BFI callbacks: the receiving side reports in ─────────────────────────

  async handleCallback(body: { type?: string; payload?: Dict; sig?: EventSig }): Promise<{ accepted: boolean }> {
    const type = must(body.type, 'type');
    const payload = body.payload;
    const sig = body.sig;
    if (!payload || !sig) throw new ServiceError(400, 'missing_field', 'payload and sig are required');
    const paymentId = must(payload.payment_id as string | undefined, 'payload.payment_id');
    const p = await this.d.store.get(paymentId);
    if (!p) throw new ServiceError(404, 'payment_not_found', `no payment ${paymentId}`);

    const issuer = await this.verifyPartnerSig(payload, sig, 'BENEFICIARY_FI');

    switch (type) {
      case 'USDC_RECEIVED': {
        const seq = (await this.d.store.appendEvent(p.id, type, issuer.id, payload, sig)).seq;
        await this.d.store.transition(p.id, 'PAYOUT_IN_PROGRESS');
        await this.notify(p, seq, 'PAYOUT_IN_PROGRESS', { tx_hash: (payload.tx_hash as string) ?? null });
        return { accepted: true };
      }
      case 'PAYOUT_SUBMITTED': {
        const seq = (await this.d.store.appendEvent(p.id, type, issuer.id, payload, sig)).seq;
        await this.notify(p, seq, 'PAYOUT_SUBMITTED', { local_rail: (payload.local_rail as string) ?? 'FAST' });
        return { accepted: true };
      }
      case 'PAYOUT_COMPLETED': {
        const level = (payload.evidence_level as string) ?? 'L2';
        const seq = (await this.d.store.appendEvent(p.id, type, issuer.id, payload, sig)).seq;
        await this.d.store.patch(p.id, { evidence_level: level });
        await this.notify(p, seq, 'PAYOUT_COMPLETED', {
          bank_reference: (payload.bank_reference as string) ?? null,
          evidence_level: level,
        });
        if (level === 'L1') {
          /*
           * The last-mile rule, enforced: L1 is "we received a message",
           * not third-party-verifiable evidence, so the payment very likely
           * completed but BENEFICIARY_CREDIT_CONFIRMED is not declared. Not
           * a failure — INSUFFICIENT_EVIDENCE, which calls for requesting a
           * better confirmation, not for escalating (impl guide §4.3).
           */
          const s2 = await this.platformEvent(p.id, 'EVIDENCE_INSUFFICIENT', {
            payment_id: p.id,
            evidence_level: level,
            holds_at: 'PAYOUT_IN_PROGRESS',
            reason: 'payout completion arrived without an institution signature (L1); '
              + 'credit confirmation requires L2 or better',
            remediation: 'request a signed (L2) or bank-referenced (L3) confirmation from the BFI, '
              + 'or reconcile via the daily signed statement',
          });
          await this.notify(p, s2, 'EVIDENCE_INSUFFICIENT', { evidence_level: level });
          return { accepted: true };
        }
        await this.reconcileAndConfirm((await this.d.store.get(p.id))!);
        return { accepted: true };
      }
      case 'PAYOUT_FAILED': {
        const seq = (await this.d.store.appendEvent(p.id, type, issuer.id, payload, sig)).seq;
        await this.notify(p, seq, 'PAYOUT_FAILED', {
          reason: (payload.reason as string) ?? 'local payout failed',
          will_return: true,
        });
        return { accepted: true };
      }
      case 'USDC_RETURNED': {
        const seq = (await this.d.store.appendEvent(p.id, type, issuer.id, payload, sig)).seq;
        const failed = await this.d.store.eventOfType(p.id, 'PAYOUT_FAILED');
        const reason = failed ? (JSON.parse(failed.payload) as Dict).reason as string : 'returned';
        await this.d.store.transition(p.id, 'RETURNED');
        await this.notify(p, seq, 'RETURNED', {
          reason,
          return_tx: (payload.tx_hash as string) ?? null,
          note: 'USDC returned to the settlement entity; the bank refunds the customer VND on its own ledger',
        });
        return { accepted: true };
      }
      default:
        throw new ServiceError(400, 'unknown_callback_type', `unsupported callback type ${type}`);
    }
  }

  /** Invariant 2: reconciliation gates the confirmed state. */
  private async reconcileAndConfirm(p: RemitPayment): Promise<void> {
    const outcome = await reconcilePayment(p, this.d.store, this.d.registry, this.d.acceptDemoFinality);
    const axisStates = Object.fromEntries(
      Object.entries(outcome.verdict.axes).map(([k, v]) => [k, (v as { state: string }).state]));
    const reconPayload = {
      payment_id: p.id,
      policy_version: outcome.verdict.policyVersion,
      policy_digest: outcome.verdict.policyDigest,
      pass: outcome.pass,
      axes: axisStates,
      amounts: {
        collected: `${p.collect_currency} ${p.collect_amount}`,
        settled: `USDC ${p.usdc_amount}`,
        paid: `${p.payout_currency} ${p.payout_amount}`,
      },
      reconciled_at: new Date().toISOString(),
    };
    const seq = await this.platformEvent(p.id, 'SETTLEMENT_RECONCILED', reconPayload);
    await this.d.store.patch(p.id, { verdict: JSON.stringify(outcome.verdict) });

    if (!outcome.pass) {
      await this.d.store.transition(p.id, 'EXCEPTION');
      await this.notify(p, seq, 'RECONCILIATION_EXCEPTION', { reasons: outcome.reasons, axes: axisStates });
      this.d.log('remit reconciliation failed', { payment: p.id, reasons: outcome.reasons });
      return;
    }

    await this.d.store.transition(p.id, 'BENEFICIARY_CREDIT_CONFIRMED');
    const completed = await this.d.store.eventOfType(p.id, 'PAYOUT_COMPLETED');
    const completedPayload = completed ? JSON.parse(completed.payload) as Dict : {};
    await this.notify(p, seq, 'BENEFICIARY_CREDIT_CONFIRMED', {
      axes: axisStates,
      bank_reference: (completedPayload.bank_reference as string) ?? null,
      evidence_level: (await this.d.store.get(p.id))!.evidence_level,
    });

    // Package and commit through the ordinary anchoring path. Failure here
    // must not undo a confirmed payout — it is logged and retried by hand in
    // the sandbox rather than faked.
    try {
      const pkg = await assemblePackage((await this.d.store.get(p.id))!, this.d.store, this.d.registry,
        outcome.evidence, outcome.verdict);
      const nonce = newNonce();
      const commitment = packageCommitment(pkg, nonce);
      const att = await this.d.svc.issue(p.org_id, commitment, 'application/json',
        { kind: 'remit-evidence', payment_id: p.id, schema: pkg.schema }, { product: 'remit' });
      await this.d.store.patch(p.id, {
        package_json: JSON.stringify(pkg),
        nonce,
        commitment,
        attestation_id: att.id,
      });
      const anchorSeq = await this.platformEvent(p.id, 'EVIDENCE_COMMITTED', {
        payment_id: p.id, commitment, attestation_id: att.id, committed_at: new Date().toISOString(),
      });
      await this.notify(p, anchorSeq, 'EVIDENCE_COMMITTED', { attestation_id: att.id, commitment });
    } catch (e) {
      this.d.log('evidence packaging failed', { payment: p.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Step 15/16 separation: the payout confirmation already went out; this
   * promotes payments whose evidence batch has since confirmed on-chain.
   * Driven by the remit worker tick.
   */
  async promoteAnchored(): Promise<number> {
    let n = 0;
    for (const row of await this.d.store.anchoredPending()) {
      const p = await this.d.store.get(row.id);
      if (!p) continue;
      const seq = await this.platformEvent(p.id, 'EVIDENCE_ANCHORED', {
        payment_id: p.id,
        attestation_id: row.attestation_id,
        anchored_at: new Date().toISOString(),
      });
      await this.d.store.transition(p.id, 'EVIDENCE_ANCHORED');
      await this.notify(p, seq, 'EVIDENCE_ANCHORED', { attestation_id: row.attestation_id });
      n++;
    }
    return n;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async requireSettlementEntity(): Promise<Institution> {
    const settle = (await this.d.registry.list()).find((i) => i.role === 'SETTLEMENT_ENTITY');
    if (!settle) throw new Error('no SETTLEMENT_ENTITY registered — provision demo-partners first');
    return settle;
  }

  /**
   * A partner's signature must verify, and the key must belong to a
   * registered institution holding the role that may assert this fact.
   */
  private async verifyPartnerSig(payload: unknown, sig: EventSig, role: Institution['role']): Promise<Institution> {
    const inst = await this.d.registry.institution(sig.key_id);
    if (!inst || !inst.signing_spki) {
      throw new ServiceError(400, 'unknown_signer', `signature names unregistered key ${sig.key_id}`);
    }
    if (inst.role !== role) {
      throw new ServiceError(400, 'role_mismatch',
        `${inst.id} holds role ${inst.role}, which may not assert ${role} facts`);
    }
    if (!verifyEvent(payload, sig, inst.signing_spki)) {
      throw new ServiceError(400, 'invalid_signature', `signature by ${inst.id} does not verify`);
    }
    return inst;
  }

  private async scrubCompliance(p: RemitPayment): Promise<void> {
    const req = JSON.parse(p.request_body) as Dict;
    delete req.compliance_plaintext;
    await this.d.store.patchRequestBody(p.id, JSON.stringify(req));
  }
}

/**
 * A bank's payment hub resends when an answer is late. Tell it where the
 * answer is, instead of leaving it to guess that the first try landed.
 */
function duplicatePayment(paymentId: string): ServiceError {
  return new ServiceError(409, 'duplicate_payment',
    `payment_id ${paymentId} already exists — if this is a retry, read its state with `
    + `GET /v1/settlements/${paymentId} instead of resending; a new instruction needs a new payment_id`);
}

/**
 * The refusal of a second settlement for a message that already has one.
 *
 * Two codes, because the bank's system does two different things with them:
 * `duplicate_source_message` is the payment it already sent — read that
 * settlement, send nothing; `reference_reused` is a UETR standing on two
 * different payments — one of them needs a reference of its own. Either way
 * the answer carries, for a program to act on, the settlement that holds the
 * message (`existing_payment_id`) and the ground (`ground`: `message`,
 * `uetr`, `twin`, or `twin_undated` — the one case that is not a recognition:
 * two messages that nothing tells apart).
 */
function sourceConflictError(source: SourceRef, conflict: SourceConflict): ServiceError {
  const existing = conflict.paymentId;
  const own = 'a reference of its own — another instruction or end-to-end identifier';
  if (conflict.reused) {
    return new ServiceError(409, 'reference_reused',
      `UETR ${source.uetr} is already on settlement ${existing}, which is a different payment — `
      + 'its amount, parties, accounts or identifiers differ, or it is another transaction of the same file. '
      + 'Nothing was accepted. A UETR names one payment: give this one its own',
      { existing_payment_id: existing, ground: 'uetr' });
  }
  if (conflict.undated) {
    return new ServiceError(409, 'duplicate_source_message',
      `this payment cannot be told from settlement ${existing}: the same identifiers and the same content, and the `
      + 'message states no value date to tell two payments apart. Nothing was accepted. '
      + `If it is that payment, read its state with GET /v1/settlements/${existing}; if it is another one, give it ${own}`,
      { existing_payment_id: existing, ground: 'twin_undated' });
  }
  const ground = conflict.ground === 'uetr' ? `the same UETR (${source.uetr})`
    : conflict.ground === 'message' ? 'the same transaction of the same message'
      : 'the same identifiers, the same value date and the same content, in another message';
  return new ServiceError(409, 'duplicate_source_message',
    `this message's payment is already settlement ${existing} — ${ground}. Nothing was accepted; `
    + `read its state with GET /v1/settlements/${existing} instead of sending it again`
    + (conflict.ground === 'twin' ? `. If it is meant as another payment, give it ${own}` : ''),
    { existing_payment_id: existing, ground: conflict.ground });
}

function must<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null || v === '') {
    throw new ServiceError(400, 'missing_field', `${name} is required`);
  }
  return v;
}

/**
 * The stored request keeps the compliance payload under a key the travel-rule
 * leg consumes once and then deletes — PII transits, the digest stays. Mode B
 * stores ciphertext and digest only; there is no plaintext to hold at all.
 */
function redactCompliance(body: SettlementRequest): Dict {
  const { compliance_payload, ...rest } = body;
  if (compliance_payload?.mode === 'B') {
    return {
      ...rest,
      compliance_ciphertext: {
        ciphertext: compliance_payload.ciphertext!,
        ivms101_digest: compliance_payload.ivms101_digest!,
      },
    };
  }
  return { ...rest, compliance_plaintext: compliance_payload as unknown as Dict };
}
