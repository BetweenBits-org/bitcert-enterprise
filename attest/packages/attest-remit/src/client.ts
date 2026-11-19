/**
 * RemitClient — what a bank adapter actually calls, in the order the
 * corridor runs: quote → buildInstruction (your key signs everything) →
 * submit → track → evidence. Each method is one HTTP exchange; the signing
 * side effects all happen locally, so what leaves the machine is exactly
 * what the bank signed and nothing else.
 *
 * Two ways in:
 *   - from your own data: `quote()` + `buildInstruction()` + `submit()`;
 *   - from the message your payment system already writes:
 *     `submitSwift(message)` reads an MT103, a pacs.008 or a pain.001 and
 *     does the same three steps, carrying the message's own references
 *     (UETR, instruction id, end-to-end id) into the signed instruction.
 *
 * Two ways to sign:
 *   - `key`: a private key held by this process (a sandbox PEM);
 *   - `signer`: an HSM, a KMS or a signing service — see `signer.ts`.
 */
import { createHash, randomUUID, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { signedBytes, toBase64Url } from '@stonehash/attest-rules';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import {
  elementDigest, eventSigningBytes, finishElement, signEvent, sha256hex, spkiOf, verifyEvent,
} from './signing.ts';
import type { EventSig } from './signing.ts';
import { signWith, spkiBase64Of } from './signer.ts';
import type { ExternalSigner } from './signer.ts';
import { buildTravelRuleMessage, encryptToInstitution } from './travelrule.ts';
import { compareDecimal, mapSwiftPayment, ownReference, SwiftMappingError } from './swift/mapping.ts';
import type {
  MappedParties, PartySupplement, SourceMessageRef, SwiftMapping,
} from './swift/mapping.ts';
import { parseSwiftMessage } from './swift/parse.ts';
import type { SwiftPayment } from './swift/model.ts';
import { buildPacs002, sourceMessageOf, swiftStatusOf } from './swift/status.ts';
import type { SwiftStatus } from './swift/status.ts';
import type { EvidenceResponse } from './verify.ts';

export interface RemitClientOptions {
  /** Platform origin, e.g. https://api.stonehash.example or the sandbox. */
  core: string;
  apiKey: string;
  /** Registered COLLECTION_BANK institution id. */
  institutionId: string;
  institutionName: string;
  /** The signing key the Trust Registry knows this institution by, held in process… */
  key?: KeyObject;
  /** …or a signer that keeps that key elsewhere (HSM, KMS). Give exactly one of the two. */
  signer?: ExternalSigner;
  /**
   * A client that holds no signing key and only reads: the status, the status
   * report, the ledger, the evidence. For the system that follows payments —
   * monitoring, operations, reconciliation — and must not be able to
   * authorise one. It sends nothing but reads; whatever would sign or send
   * throws before anything leaves this machine.
   */
  readOnly?: boolean;
  /**
   * Travel Rule mode B: the encryption keys your bank expects, by institution
   * id, each as the RFC 7638 thumbprint of the institution's public JWK
   * (base64url). The registry is where the key is fetched from; with a
   * thumbprint here it is not also what vouches for it — a key that does not
   * match is refused, and nothing is encrypted to it. Exchange the thumbprint
   * with the institution out of band. `jwkThumbprint()` computes one.
   */
  beneficiaryKeys?: Record<string, string>;
}

/** The RFC 7638 thumbprint (SHA-256, base64url) of an EC public JWK. */
export function jwkThumbprint(jwk: { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown }): string {
  // The required members of an EC key, in lexicographic order, without whitespace.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

export interface Quote {
  quote_id: string;
  corridor: { origin: string; destination: string };
  trade: { currency: string; amount: string };
  settlement: { asset: string; amount: string; chain: string };
  collect: { currency: string; amount: string; rate: string; rate_pair: string };
  payout: { currency: string; amount: string; rate: string; rate_pair: string };
  fees: { type: string; currency: string; amount: string }[];
  quoted_at: string;
  expires_at: string;
  required_travel_rule_fields: string[];
}

/**
 * The two companies of the trade.
 * `debtor` is the importing company — also the Travel Rule originator;
 * `creditor` the exporting company — also the Travel Rule beneficiary.
 */
export type TradeParties = MappedParties;

/**
 * What the bank's own review concluded. These are the bank's assertions and
 * are signed with its key, so set them from your approval system. The
 * defaults exist for a first sandbox run, not for production.
 */
export interface ReviewAssertions {
  /** KYB outcome for the debtor. Default `VERIFIED`. */
  kybStatus?: string;
  /** Version of the policy the KYB was done under. Default `sdk-1`. */
  kybPolicyVersion?: string;
  /** Outcome of the trade-document review. Default `APPROVED`. */
  tradeReview?: string;
  /** Your regulatory report reference for this payment. Default `SDK-DEMO`. */
  regulatorReportRef?: string;
  /** Role of the approver, never a name. Default `FX Compliance Officer`. */
  approvedByRole?: string;
  /** Your receipt for the funds collected from the debtor. Default `RCPT-<payment id>`. */
  fiatReceivedRef?: string;
}

export interface InstructionOptions {
  paymentId?: string;
  invoiceRef?: string;
  beneficiaryInstitution?: string;
  /** Purpose of the payment, your code list or ISO 20022's. Default `GOODS_PAYMENT`. */
  purposeCode?: string;
  /** Your own reference for the instruction. Default `INST-<payment id>`. */
  instructionRef?: string;
  review?: ReviewAssertions;
  /** Reference to the message the instruction was made from; signed into it. */
  source?: SourceMessageRef;
  /** ISO 20022 element names the instruction's content corresponds to. */
  messageFields?: string[];
  /**
   * Travel Rule mode. `A` (default): the party fields go to the platform,
   * which encrypts them for the beneficiary institution. `B`: this SDK
   * encrypts them here and the platform relays a ciphertext it cannot read
   * (`buildInstructionAsync` only — it needs the institution's key).
   */
  travelRule?: 'A' | 'B';
}

export interface Instruction { paymentId: string; body: Record<string, unknown> }

export interface SettlementView {
  payment_id: string;
  state: string;
  evidence_level: string | null;
  evidence_available: boolean;
  chain_tx: string | null;
  attestation: { id: string; status: string } | null;
  events: { seq: number; type: string; issuer: string; at: string; payload: unknown; sig: unknown }[];
  [k: string]: unknown;
}

export interface SwiftOptions {
  /** Which transaction, when the message carries several. */
  index?: number;
  /**
   * What your bank knows beyond the message — typically the customer master
   * record of the debtor. A value, or a lookup that receives the parsed
   * payment (so it can key on the debtor's account).
   */
  supplement?: PartySupplement
    | ((payment: SwiftPayment) => PartySupplement | undefined | Promise<PartySupplement | undefined>);
  /** Take a missing party country from its agent's BIC. Default true; reported in the mapping. */
  inferCountryFromBic?: boolean;
  /**
   * Name the settlement yourself, instead of the id derived from the
   * message's references. It is a name and nothing more: a message that
   * already has a settlement is answered with that settlement
   * (`already: true`) whatever id is passed here — an id of your own does
   * not make a second payment out of one message.
   */
  paymentId?: string;
  beneficiaryInstitution?: string;
  review?: ReviewAssertions;
  travelRule?: 'A' | 'B';
}

export interface SwiftInstruction extends Instruction {
  quote: Quote;
  /** The full mapping table: where every value came from, and what had no place. */
  mapping: SwiftMapping;
}

export interface SwiftSubmission {
  paymentId: string;
  state: string;
  /** True when this message had been submitted before; nothing new was sent. */
  already: boolean;
  mapping: SwiftMapping;
  quote?: Quote;
}

export interface WebhookEnvelope {
  event_id: string;
  payment_id: string;
  sequence: number;
  type: string;
  state: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

interface RemitMeta {
  platform_signer?: { key_id?: string; spki?: string };
  institutions?: {
    id: string; role?: string; name?: string; country?: string | null;
    signing_spki?: string | null; encryption_jwk?: Record<string, unknown> | string | null;
  }[];
}

export class RemitApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * With `duplicate_source_message` and `reference_reused`: the settlement
   * that already stands for the message — for a program to act on, so that
   * it does not have to read the id out of the sentence.
   */
  readonly existingPaymentId: string | undefined;
  /**
   * With `duplicate_source_message`: on what ground the platform took the
   * two for one payment — `message` (the same transaction of the same file),
   * `uetr`, `twin` (the same payment in another message) or `twin_undated`
   * (nothing tells the two apart: a refusal, not a recognition).
   */
  readonly ground: string | undefined;
  constructor(status: number, code: string, message: string, existingPaymentId?: string, ground?: string) {
    super(message);
    this.name = 'RemitApiError';
    this.status = status;
    this.code = code;
    this.existingPaymentId = existingPaymentId;
    this.ground = ground;
  }
}

/**
 * The events that answer the receiving institution's question or settle the
 * Travel Rule exchange: the bank's answer was taken (`TRAVEL_RULE_RFI_RESOLVED`),
 * the institution accepted (`TRAVEL_RULE_RECEIVED`), or it refused
 * (`TRAVEL_RULE_REJECTED`).
 */
const TRAVEL_RULE_CLOSING = new Set(['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_REJECTED']);

/**
 * Is a question of the receiving institution waiting for the bank's answer?
 * It is when the last `TRAVEL_RULE_RFI` comes after the last event that
 * answers or settles the exchange — not merely when no answer was ever
 * given: a second question, asked after an earlier answer, is as open as the
 * first. Events in the order the platform lists them (by sequence).
 */
export function travelRuleQuestionOpen(events: readonly { type: string }[]): boolean {
  let open = false;
  for (const e of events) {
    if (e.type === 'TRAVEL_RULE_RFI') open = true;
    else if (TRAVEL_RULE_CLOSING.has(e.type)) open = false;
  }
  return open;
}

/** ISO 20022 element names the default (non-SWIFT) instruction declares. */
const DEFAULT_MESSAGE_FIELDS = ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf'];

/** FIN field tag → the ISO 20022 element the same content travels in. */
const MT_TO_ISO: Record<string, string[]> = {
  '20': ['InstrId'], '121': ['UETR'], '32A': ['IntrBkSttlmAmt', 'IntrBkSttlmDt'], '33B': ['InstdAmt'],
  '36': ['XchgRate'], '50A': ['Dbtr', 'DbtrAcct'], '50F': ['Dbtr', 'DbtrAcct'], '50K': ['Dbtr', 'DbtrAcct'],
  '52A': ['DbtrAgt'], '52D': ['DbtrAgt'], '56A': ['IntrmyAgt1'], '56C': ['IntrmyAgt1'], '56D': ['IntrmyAgt1'],
  '57A': ['CdtrAgt'], '57C': ['CdtrAgt'], '57D': ['CdtrAgt'],
  '59': ['Cdtr', 'CdtrAcct'], '59A': ['Cdtr', 'CdtrAcct'], '59F': ['Cdtr', 'CdtrAcct'],
  '70': ['RmtInf'], '71A': ['ChrgBr'], '26T': ['Purp'], '77B': ['RgltryRptg'],
};

/** The ISO 20022 element names a parsed message's content corresponds to. */
export function isoFieldNames(payment: SwiftPayment): string[] {
  if (payment.format !== 'MT103') return payment.present.filter((n) => n !== 'PmtId');
  return [...new Set(payment.present.flatMap((tag) => MT_TO_ISO[tag] ?? []))];
}

/**
 * The payment id a SWIFT message always maps to. It is derived from the
 * message's own references and from nothing else — the UETR when there is
 * one — so the same payment written out again (a retry, a re-export the next
 * day, a file dropped twice) names the same settlement instead of creating a
 * second one. The creation time is no part of it: it is new on every
 * re-export, and an id that moved with it made two payments out of one.
 *
 * Without a UETR the identity is the message's own identifiers and its
 * value date — the reference-and-date rule a bank's duplicate check uses,
 * so a reference that a system reuses on a later day is a new payment. The
 * position in the file is part of it only where the identifiers do not tell
 * the file's transactions apart: a payment that is retried alone, after
 * having gone out in a batch, is still the same payment. An end-to-end id
 * that is a word for "none" (`NOTPROVIDED`, `NONREF`, `NOREF`, in any case,
 * white space around it ignored) is no identifier: written so or left out,
 * the payment is the same payment.
 *
 * The form is `PAY-<8>-<10>` — the length the ledger's column is laid out
 * for. For a message with a UETR the first group is the UETR's own first
 * group, so an operator can match the id to the bank's reference by eye; the
 * second is a hash that also covers the institution.
 */
export function swiftPaymentId(institutionId: string, payment: SwiftPayment): string {
  const identity = payment.uetr
    ? `uetr|${payment.uetr}`
    : payment.messageId || payment.instructionId
      ? ['ids', payment.messageType, payment.messageId ?? '', payment.instructionId ?? '',
        ownReference(payment.endToEndId) === undefined ? '' : payment.endToEndId!,
        payment.valueDate ?? '', payment.distinctIds ? '' : `#${payment.index}`].join('|')
      : `bytes|${payment.digest}|${payment.index}`;
  const hash = createHash('sha256').update(`${institutionId}\n${identity}`).digest('hex');
  return payment.uetr
    ? `PAY-${payment.uetr.slice(0, 8)}-${hash.slice(0, 10)}`
    : `PAY-${hash.slice(0, 8)}-${hash.slice(8, 18)}`;
}

/**
 * The platform's answers that mean "this payment is here already": the
 * payment id or the idempotency key is taken, or the message it was made
 * from already has a settlement.
 */
const TAKEN_ALREADY: ReadonlySet<string> = new Set(
  ['duplicate_payment', 'idempotency_conflict', 'duplicate_source_message', 'reference_reused']);

/** A message as the bank's system wrote it — or a payment already parsed out of one. */
export type SwiftMessageInput = string | Uint8Array | SwiftPayment;

const isParsed = (message: SwiftMessageInput): message is SwiftPayment =>
  typeof message === 'object' && !(message instanceof Uint8Array);

/**
 * An answer that did not come from the platform. Reported as a 502 so that
 * callers treat it as "not reached, try again" and never as an outcome.
 */
function notThePlatform(method: string, path: string, what: string): RemitApiError {
  return new RemitApiError(502, 'not_a_platform_answer',
    `${method} ${path.split('?')[0]} was answered with ${what} — not the platform's own answer. `
    + 'Something between this machine and the platform replied instead, so nothing is taken to have happened');
}

export class RemitClient {
  private readonly o: RemitClientOptions;
  private metaCache: Promise<RemitMeta> | null = null;
  private metaAt = 0;

  constructor(o: RemitClientOptions) {
    if (o.readOnly) {
      if (o.key || o.signer) {
        throw new TypeError('a read-only RemitClient holds no signing key — leave out `key` and `signer`, or leave out `readOnly`');
      }
    } else if (!o.key && !o.signer) {
      throw new TypeError('RemitClient needs a signing key: pass `key` (a private key in this process) or `signer` (an HSM/KMS signer) — '
        + 'or `readOnly: true` for a client that only reads');
    }
    if (o.key && o.signer) {
      throw new TypeError('RemitClient takes `key` or `signer`, not both — one key signs for the institution');
    }
    this.o = o;
  }

  /** Where a read-only client stops: it has nothing to sign with. */
  private mustSign(what: string): void {
    if (this.o.readOnly) {
      throw new TypeError(`${what} needs the signing key, and this client is read-only — build one with \`key\` or \`signer\``);
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
    if (this.o.readOnly && method !== 'GET') {
      throw new TypeError(`${method} ${path.split('?')[0]}: this client is read-only — it reads, and sends nothing else`);
    }
    const send = (): Promise<Response> => fetch(`${this.o.core.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.o.apiKey}`,
        'content-type': 'application/json',
        ...(idemKey ? { 'idempotency-key': idemKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A redirect is an answer from something in between, not from the platform.
      redirect: 'manual',
    });
    // A read is asked once more when the connection failed under it: a server
    // closes an idle connection, and the request that was just then sent on it
    // is lost. A write is not repeated here — its caller decides.
    const res = await send().catch((e: unknown) => {
      if (method !== 'GET') throw e;
      return send();
    });
    const text = await res.text().catch(() => '');
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    const object = json !== null && typeof json === 'object' && !Array.isArray(json);
    if (res.status >= 400) {
      const e = (object ? json : {}) as { error?: unknown; message?: unknown; existing_payment_id?: unknown; ground?: unknown };
      // The platform refuses in its own JSON, with a code. An error page from a
      // gateway or a proxy (502, 503, a login wall) is something in between
      // answering — the request may or may not have arrived.
      if (typeof e.error !== 'string') {
        throw notThePlatform(method, path, `HTTP ${res.status} ${res.headers.get('content-type') ?? 'with no content type'}`);
      }
      throw new RemitApiError(res.status, e.error, typeof e.message === 'string' ? e.message : `HTTP ${res.status}`,
        typeof e.existing_payment_id === 'string' ? e.existing_payment_id : undefined,
        typeof e.ground === 'string' ? e.ground : undefined);
    }
    // Success is the platform saying so, in its own JSON. A proxy, a gateway or
    // a maintenance page answering 200 with something else has accepted nothing.
    if (res.status < 200 || res.status > 299 || !object) {
      throw notThePlatform(method, path, `HTTP ${res.status} ${res.headers.get('content-type') ?? 'with no content type'}`);
    }
    return json as T;
  }

  // ── Signing: one place decides between the in-process key and the signer ──

  /** The public key this client signs with, SPKI base64. */
  publicKey(): string {
    this.mustSign('publicKey()');
    return this.o.key ? spkiOf(this.o.key) : spkiBase64Of(this.o.signer!.publicKey);
  }

  private requireKey(method: string): KeyObject {
    this.mustSign(`${method}()`);
    if (!this.o.key) {
      throw new TypeError(`${method}() signs synchronously and needs an in-process \`key\`; `
        + `this client was built with an external \`signer\` — use ${method}Async()`);
    }
    return this.o.key;
  }

  private async signRaw(bytes: Uint8Array): Promise<Uint8Array> {
    this.mustSign('a signature');
    if (this.o.key) return cryptoSign('sha256', bytes, { key: this.o.key, dsaEncoding: 'ieee-p1363' });
    return signWith(this.o.signer!, bytes);
  }

  private async signEventAsync(payload: unknown): Promise<EventSig> {
    const raw = await this.signRaw(eventSigningBytes(payload));
    return { alg: 'ES256', key_id: this.o.institutionId, issuer: this.o.institutionName, sig: toBase64Url(new Uint8Array(raw)) };
  }

  private async finishElementAsync<T extends Record<string, unknown>>(element: T):
  Promise<T & { digest: string; signature: Record<string, unknown> }> {
    const withDigest = { ...element, digest: elementDigest(element) };
    const raw = await this.signRaw(signedBytes(withDigest));
    return {
      ...withDigest,
      signature: {
        status: 'VALID', keyId: this.o.institutionId, algorithm: 'ES256', issuer: this.o.institutionName,
        trustLevel: 'ATTESTED', value: toBase64Url(new Uint8Array(raw)),
      },
    };
  }

  /**
   * The Trust Registry, kept for five minutes: long enough not to ask for it
   * with every payment, short enough that a rotated key is picked up. `fresh`
   * asks again — but not more than once in ten seconds, so that a stream of
   * deliveries that do not verify cannot be turned into a stream of requests.
   */
  private meta(fresh = false): Promise<RemitMeta> {
    const age = Date.now() - this.metaAt;
    if (!this.metaCache || age > 300_000 || (fresh && age > 10_000)) {
      this.metaAt = Date.now();
      this.metaCache = this.call<RemitMeta>('GET', '/v1/remit/meta').catch((e) => {
        this.metaCache = null;
        throw e;
      });
    }
    return this.metaCache;
  }

  /** Confirm the registry knows this institution by exactly this key. */
  async assertRegistered(): Promise<void> {
    const meta = await this.meta(true);
    const inst = meta.institutions?.find((i) => i.id === this.o.institutionId);
    if (!inst) {
      throw new RemitApiError(404, 'institution_unregistered',
        `${this.o.institutionId} is not in the Trust Registry — activate Cross-border Settlement in the console `
        + '(Subscriptions); the institution id is issued there');
    }
    if (inst.signing_spki !== this.publicKey()) {
      throw new RemitApiError(409, 'key_mismatch',
        `the signing key given to this client is not the one registered for ${this.o.institutionId} — `
        + 'use the key file whose public half the institution verifies with (console: Integrate → institutions), '
        + 'or apply this key\'s public half there');
    }
  }

  async quote(tradeAmountUsd: string): Promise<Quote> {
    const quote = await this.call<Quote>('POST', '/v1/quotes', {
      corridor: { origin: 'VN', destination: 'SG' },
      trade: { currency: 'USD', amount: tradeAmountUsd },
      collect: { currency: 'VND' },
      payout: { currency: 'SGD' },
    });
    if (typeof quote.quote_id !== 'string' || typeof quote.trade?.amount !== 'string') {
      throw notThePlatform('POST', '/v1/quotes', 'a body that is not a quote');
    }
    // The bank signs what the quote says. It is checked to be what was asked
    // for — amount, currency, route, legs — before anything is signed on it.
    // The amounts are compared as decimals: as floating-point numbers, two
    // that differ past the fifteenth significant digit compared equal.
    const same = compareDecimal(quote.trade.amount, tradeAmountUsd) === 0 && quote.trade.currency === 'USD'
      && quote.corridor?.origin === 'VN' && quote.corridor?.destination === 'SG'
      && quote.collect?.currency === 'VND' && quote.payout?.currency === 'SGD';
    if (!same) {
      throw new RemitApiError(502, 'quote_mismatch',
        `a quote for ${tradeAmountUsd} USD, VN to SG, was asked for; the answer is for ${quote.trade.amount} ${quote.trade.currency}, `
        + `${quote.corridor?.origin ?? '?'} to ${quote.corridor?.destination ?? '?'} — nothing was signed`);
    }
    return quote;
  }

  // ── Building the instruction ─────────────────────────────────────────────

  /** Everything about an instruction except its signatures. */
  private draft(quote: Quote, parties: TradeParties, opts: InstructionOptions) {
    // Ten hex characters (40 bits), not six: at a bank's volume six made two of a day's payments
    // draw the same id often enough to notice — about one day in two at 5,000 payments — and the
    // second was refused as a duplicate. The id is 23 characters, the same length as one made
    // from a SWIFT message, which is the width the console's ledger is laid out for.
    const paymentId = opts.paymentId
      ?? `PAY-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const invoiceRef = opts.invoiceRef ?? `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    const review = opts.review ?? {};
    const purpose = opts.purposeCode ?? 'GOODS_PAYMENT';

    const bank_authorization: Record<string, unknown> = {
      bank_id: this.o.institutionId,
      instruction_ref: opts.instructionRef ?? `INST-${paymentId}`,
      fiat_received_ref: review.fiatReceivedRef ?? `RCPT-${paymentId}`,
      kyb_status: review.kybStatus ?? 'VERIFIED', kyb_policy_version: review.kybPolicyVersion ?? 'sdk-1',
      trade_review: review.tradeReview ?? 'APPROVED', purpose_code: purpose,
      payment_release: 'AUTHORIZED', approved_at: now,
      ...(opts.source?.uetr ? { uetr: opts.source.uetr } : {}),
    };
    const elements = {
      bankInstruction: {
        ref: paymentId, amount: quote.trade.amount, currency: quote.trade.currency,
        debtor: parties.debtor.name, creditor: parties.creditor.name,
        approvedAt: now,
        iso20022Fields: [...(opts.messageFields ?? DEFAULT_MESSAGE_FIELDS), invoiceRef],
        ...(opts.source ? { sourceMessage: opts.source } : {}),
      },
      bankApproval: {
        approvalRef: `APPR-${paymentId}`,
        regulatorReportRef: review.regulatorReportRef ?? 'SDK-DEMO',
        approvedByRole: review.approvedByRole ?? 'FX Compliance Officer',
        approvedAt: now,
        fxQuote: { pair: quote.collect.rate_pair, rate: quote.collect.rate,
          quotedAt: quote.quoted_at, validUntil: quote.expires_at },
      },
      commercialDocs: {
        invoiceRef, amount: quote.trade.amount, currency: quote.trade.currency,
        buyer: parties.debtor.name, seller: parties.creditor.name,
        attached: ['invoice'], citedOnly: [] as string[],
      },
    };
    const beneficiaryInstitution = opts.beneficiaryInstitution ?? 'SG-BFI-001';
    const base = {
      request_id: `REQ-${paymentId}`,
      payment_id: paymentId,
      quote_id: quote.quote_id,
      corridor: quote.corridor,
      amount: {
        collected: { currency: quote.collect.currency, value: quote.collect.amount },
        payout: { currency: quote.payout.currency, value: quote.payout.amount },
      },
      commercial_reference: {
        invoice_ref: invoiceRef,
        invoice_commitment: sha256hex(`${invoiceRef}|${quote.trade.amount} ${quote.trade.currency}|${parties.debtor.name}`),
      },
      beneficiary: { institution_id: beneficiaryInstitution, beneficiary_ref: `BEN-${paymentId}` },
    };
    const compliancePlain = {
      format: 'IVMS101-2023', mode: 'A',
      originator: parties.debtor,
      beneficiary: parties.creditor,
      purpose_code: purpose,
    };
    return { paymentId, purpose, beneficiaryInstitution, bank_authorization, elements, base, compliancePlain };
  }

  /**
   * Everything the platform needs to accept an instruction, signed here with
   * the in-process key: the three evidence elements, the payment-release
   * authorization, and the Travel Rule payload (mode A) assembled from the
   * same party data.
   *
   * With an external `signer`, or for Travel Rule mode B, use
   * `buildInstructionAsync` — same arguments, same result.
   */
  buildInstruction(quote: Quote, parties: TradeParties, opts: InstructionOptions = {}): Instruction {
    const key = this.requireKey('buildInstruction');
    if (opts.travelRule === 'B') {
      throw new TypeError('Travel Rule mode B fetches the beneficiary institution\'s encryption key — use buildInstructionAsync()');
    }
    const d = this.draft(quote, parties, opts);
    const sign = <T extends Record<string, unknown>>(el: T) =>
      finishElement(el, key, this.o.institutionId, this.o.institutionName);
    return {
      paymentId: d.paymentId,
      body: {
        ...d.base,
        bank_authorization: d.bank_authorization,
        bank_signature: signEvent(d.bank_authorization, key, this.o.institutionId, this.o.institutionName),
        compliance_payload: d.compliancePlain,
        evidence_elements: {
          bankInstruction: sign(d.elements.bankInstruction),
          bankApproval: sign(d.elements.bankApproval),
          commercialDocs: sign(d.elements.commercialDocs),
        },
      },
    };
  }

  /**
   * `buildInstruction` for every signing arrangement: an in-process key, an
   * HSM or KMS behind `signer`, and Travel Rule mode B. Four signatures are
   * requested, one after another.
   */
  async buildInstructionAsync(quote: Quote, parties: TradeParties, opts: InstructionOptions = {}): Promise<Instruction> {
    const d = this.draft(quote, parties, opts);
    const bankInstruction = await this.finishElementAsync(d.elements.bankInstruction);
    const bankApproval = await this.finishElementAsync(d.elements.bankApproval);
    const commercialDocs = await this.finishElementAsync(d.elements.commercialDocs);
    const bank_signature = await this.signEventAsync(d.bank_authorization);
    const compliance_payload = opts.travelRule === 'B'
      ? await this.encryptTravelRule(d.paymentId, d.purpose, d.beneficiaryInstitution, quote, parties)
      : d.compliancePlain;
    return {
      paymentId: d.paymentId,
      body: {
        ...d.base,
        bank_authorization: d.bank_authorization,
        bank_signature,
        compliance_payload,
        evidence_elements: { bankInstruction, bankApproval, commercialDocs },
      },
    };
  }

  /** Mode B: shape the Travel Rule message here and encrypt it to the beneficiary institution. */
  private async encryptTravelRule(paymentId: string, purpose: string, beneficiaryInstitution: string,
    quote: Quote, parties: TradeParties): Promise<Record<string, unknown>> {
    const meta = await this.meta();
    const institutions = meta.institutions ?? [];
    const self = institutions.find((i) => i.id === this.o.institutionId);
    const bfi = institutions.find((i) => i.id === beneficiaryInstitution);
    const settle = institutions.find((i) => i.role === 'SETTLEMENT_ENTITY');
    if (!bfi?.encryption_jwk) {
      throw new RemitApiError(502, 'bfi_has_no_encryption_key',
        `${beneficiaryInstitution} publishes no encryption key in /v1/remit/meta, so the Travel Rule message cannot be encrypted to it`);
    }
    if (!settle) throw new RemitApiError(502, 'no_settlement_entity', 'the Trust Registry lists no settlement entity');
    const jwk = typeof bfi.encryption_jwk === 'string'
      ? JSON.parse(bfi.encryption_jwk) as Record<string, unknown> : bfi.encryption_jwk;
    const pinned = this.o.beneficiaryKeys?.[bfi.id];
    if (pinned !== undefined && jwkThumbprint(jwk) !== pinned) {
      throw new RemitApiError(502, 'bfi_key_mismatch',
        `the registry names an encryption key for ${bfi.id} (thumbprint ${jwkThumbprint(jwk)}) that is not the one this bank expects `
        + `(${pinned}) — nothing was encrypted to it. If the institution rotated its key, confirm the new thumbprint with it and update beneficiaryKeys`);
    }

    const message = buildTravelRuleMessage(parties, {
      paymentId,
      tradeAmount: quote.trade.amount,
      tradeCurrency: quote.trade.currency,
      purposeCode: purpose,
      originatingInstitution: { id: this.o.institutionId, name: self?.name ?? this.o.institutionName, country: self?.country ?? quote.corridor.origin },
      beneficiaryInstitution: { id: bfi.id, name: bfi.name ?? bfi.id, country: bfi.country ?? quote.corridor.destination },
      settlementEntity: { id: settle.id, name: settle.name ?? settle.id },
      settlementAmount: quote.settlement.amount,
    });
    const ivms101_digest = sha256hex(jcs(message as JcsValue));
    const ciphertext = encryptToInstitution(Buffer.from(JSON.stringify(message), 'utf8'), jwk, `${bfi.id}-ENC`);
    // What the bank puts its key to: not only that the fields are there, but
    // which message they are in. The digest of the message and of the
    // ciphertext are signed, so whoever relays the instruction cannot put
    // another message — another beneficiary account — in its place.
    const assertion = {
      payment_id: paymentId,
      required_fields_present: true,
      field_count: quote.required_travel_rule_fields.length,
      schema: 'IVMS101-2023',
      ivms101_digest,
      ciphertext_sha256: sha256hex(ciphertext),
    };
    return {
      format: 'IVMS101-2023', mode: 'B',
      ciphertext, ivms101_digest,
      fields_assertion: { payload: assertion, sig: await this.signEventAsync(assertion) },
    };
  }

  // ── From a SWIFT message ─────────────────────────────────────────────────

  private async mapSwift(message: SwiftMessageInput, opts: SwiftOptions): Promise<SwiftMapping> {
    // A file of many payments is parsed once by the caller and handed over one
    // payment at a time; parsing the whole file again for each would be quadratic.
    const payment = isParsed(message)
      ? message
      : parseSwiftMessage(message, opts.index === undefined ? {} : { index: opts.index });
    const supplement = typeof opts.supplement === 'function' ? await opts.supplement(payment) : opts.supplement;
    return mapSwiftPayment(payment, {
      // A message marked as a test is taken with a test key and with no other.
      allowTestMessages: this.o.apiKey.startsWith('sk_test_'),
      ...(supplement ? { supplement } : {}),
      ...(opts.inferCountryFromBic === undefined ? {} : { inferCountryFromBic: opts.inferCountryFromBic }),
    });
  }

  /**
   * Read an MT103, a pacs.008 or a pain.001 and say what would be sent:
   * the mapping table, what is missing, what has no place. Nothing is
   * signed and nothing leaves the machine.
   */
  inspectSwift(message: SwiftMessageInput, opts: SwiftOptions = {}): Promise<SwiftMapping> {
    return this.mapSwift(message, opts);
  }

  /**
   * A signed settlement instruction made from a SWIFT message: parse, map,
   * quote, sign. Not submitted — `submit(body)` does that, or use
   * `submitSwift()` for the whole path. Throws `SwiftMappingError` (with
   * every missing field named in the message's own vocabulary) when the
   * message lacks something the corridor requires.
   */
  async instructionFromSwift(message: SwiftMessageInput, opts: SwiftOptions = {}): Promise<SwiftInstruction> {
    this.mustSign('instructionFromSwift()');
    const mapping = await this.mapSwift(message, opts);
    if (!mapping.input) throw new SwiftMappingError(mapping);
    return this.instructionFromMapping(mapping, opts);
  }

  private async instructionFromMapping(mapping: SwiftMapping, opts: SwiftOptions): Promise<SwiftInstruction> {
    const input = mapping.input!;
    const quote = await this.quote(input.tradeAmount);
    const built = await this.buildInstructionAsync(quote, input.parties, {
      paymentId: opts.paymentId ?? swiftPaymentId(this.o.institutionId, mapping.payment),
      invoiceRef: input.invoiceRef,
      source: input.source,
      messageFields: isoFieldNames(mapping.payment),
      ...(input.purposeCode ? { purposeCode: input.purposeCode } : {}),
      ...(input.instructionRef ? { instructionRef: input.instructionRef } : {}),
      ...(opts.beneficiaryInstitution ? { beneficiaryInstitution: opts.beneficiaryInstitution } : {}),
      ...(opts.review ? { review: opts.review } : {}),
      ...(opts.travelRule ? { travelRule: opts.travelRule } : {}),
    });
    return { ...built, quote, mapping };
  }

  /**
   * How one settlement in the ledger relates to the payment in hand.
   *
   *   same       the same payment: byte for byte, or written out again
   *   reused     the same reference on a different payment. This is the one
   *              that must never be answered "already submitted": that would
   *              drop a payment without a word.
   *   unrelated  another payment altogether — as far as this pair shows
   *
   * "The same reference" is claimed on strong grounds only: the same UETR,
   * or — where neither message has one — a settlement that stands under the
   * id derived from this message's own identifiers (`byDerivedId`; an id the
   * caller chose says nothing about the message). Only then can the answer
   * be "reused".
   *
   * Short of that, the settlement may still be this payment in another
   * message: the same instruction and end-to-end identifiers, value date and
   * content — or, for a payment that carries neither identifier, the same
   * message id, position, value date and content. That is the payment a bank
   * retries alone after a batch, an MT103 once with and once without its
   * header blocks, a file exported again.
   *
   * This judges ONE settlement the caller already has in hand — the one
   * under the payment id, or the one that holds the UETR. It is not used to
   * pick "the" twin out of several settlements that read alike: which of two
   * like instalments a re-exported transaction stands for is the platform's
   * to decide, one to one, when the instruction is sent.
   */
  private relate(view: SettlementView, mapping: SwiftMapping, byDerivedId: boolean): 'same' | 'reused' | 'unrelated' {
    const ref = mapping.input!.source;
    const stored = sourceMessageOf(view);
    if (!stored) return 'unrelated';
    const sameBytes = stored.sha256 === ref.sha256;
    const sameIndex = (stored.index ?? 0) === (ref.index ?? 0);
    if (sameBytes && sameIndex) return 'same';

    const both = !!ref.uetr && !!stored.uetr;
    const neither = !ref.uetr && !stored.uetr;
    const sameIds = (stored.instructionId ?? '') === (ref.instructionId ?? '')
      && (stored.endToEndId ?? '') === (ref.endToEndId ?? '');
    const sameMessage = stored.type === ref.type && (stored.messageId ?? '') === (ref.messageId ?? '');
    const sameDay = (stored.valueDate ?? '') === (ref.valueDate ?? '');
    const strong = both
      ? ref.uetr === stored.uetr
      : byDerivedId && neither && !!(ref.messageId || ref.instructionId) && sameMessage && sameIds && sameDay;
    if (strong) {
      // Two transactions of one file under one reference are two payments, whatever each says.
      if (sameBytes) return 'reused';
      return this.sameContent(view, stored, mapping) ? 'same' : 'reused';
    }
    // Two different UETRs are two payments; so are two transactions of one file.
    if (both || sameBytes) return 'unrelated';
    const ownIds = !!(ref.instructionId || ref.endToEndId);
    const twin = sameIds && !!ref.valueDate && sameDay && !!ref.content && ref.content === stored.content
      && (ownIds || (sameMessage && !!ref.messageId && sameIndex));
    return twin ? 'same' : 'unrelated';
  }

  /** Do the stored instruction and the message in hand describe one payment? */
  private sameContent(view: SettlementView, stored: SourceMessageRef, mapping: SwiftMapping): boolean {
    const input = mapping.input!;
    if (stored.content && input.source.content) return stored.content === input.source.content;
    // A settlement made before instructions carried a content digest: what its signed elements state.
    const was = (view.events.find((e) => e.type === 'BANK_EVIDENCE_SUBMITTED')?.payload ?? {}) as {
      bankInstruction?: { amount?: unknown; debtor?: unknown; creditor?: unknown };
      commercialDocs?: { invoiceRef?: unknown };
    };
    const [whole, frac = ''] = input.tradeAmount.split('.') as [string, string?];
    return was.bankInstruction?.amount === `${whole}.${(frac ?? '').padEnd(2, '0')}`
      && was.bankInstruction?.debtor === input.parties.debtor.name
      && was.bankInstruction?.creditor === input.parties.creditor.name
      && (was.commercialDocs?.invoiceRef === undefined || was.commercialDocs.invoiceRef === input.invoiceRef)
      && (stored.instructionId ?? '') === (input.source.instructionId ?? '')
      && (stored.endToEndId ?? '') === (input.source.endToEndId ?? '');
  }

  /**
   * Is this payment in the ledger already — as far as can be said for
   * certain before anything is sent? Returns its settlement when it is;
   * throws `reference_reused` when its reference is there on a different
   * payment; returns null otherwise.
   *
   * Two things are certain without the platform's judgement: the settlement
   * that stands under this payment's id (the one a caller chose, and the one
   * derived from the message's own identifiers — a payment this SDK
   * submitted before), and the settlement that holds its UETR. Each is one
   * settlement, looked up exactly.
   *
   * Everything else — the same payment in another message, under another id
   * — is NOT searched for here. The platform decides that when the
   * instruction arrives: it refuses a message that already has a settlement,
   * also when two requests arrive at the same moment, names the settlement,
   * and `submitSwift()` answers with it. Guessing it here would mean picking
   * one of several settlements that read alike, and calling a payment made
   * because one like it was.
   */
  private async knownSwift(paymentId: string, derivedId: string, mapping: SwiftMapping): Promise<SettlementView | null> {
    const ref = mapping.input!.source;
    const reused = (view: SettlementView): RemitApiError => new RemitApiError(409, 'reference_reused',
      `this message's reference${ref.uetr ? ` (UETR ${ref.uetr})` : ''} is already on settlement ${view.payment_id} `
      + `(${view.state}), which is a different payment — `
      + (sourceMessageOf(view)?.sha256 === ref.sha256
        ? 'the same reference appears on two transactions of this file'
        : 'its amount, parties, accounts or identifiers differ')
      + ', and nothing was sent. A reference names one payment: '
      + (ref.uetr
        ? 'give this one its own UETR'
        : 'give this one a reference of its own, or pass an explicit paymentId if it is meant as a payment of its own'),
      view.payment_id);

    const byId = await this.find(paymentId);
    if (byId) {
      const relation = this.relate(byId, mapping, paymentId === derivedId);
      if (relation === 'same') return byId;
      if (relation === 'reused') throw reused(byId);
      throw new RemitApiError(409, 'payment_id_conflict',
        `${paymentId} already names a settlement made from a different message; give this payment an id of its own`,
        byId.payment_id);
    }
    // A caller's own id names the settlement; it does not hide the one this SDK made from
    // the same message before. (Where that one is a DIFFERENT payment under the same
    // identifiers, the caller's own id is its statement that this is a payment of its own.)
    if (paymentId !== derivedId) {
      const derived = await this.find(derivedId);
      if (derived && this.relate(derived, mapping, true) === 'same') return derived;
    }

    // The settlement that holds this UETR, if any: at most one.
    if (ref.uetr) {
      const page = await this.list({ sourceUetr: ref.uetr, limit: 50 });
      for (const row of page.data) {
        const id = row.payment_id;
        if (typeof id !== 'string' || id === paymentId) continue;
        const view = await this.find(id);
        if (!view) continue;
        const relation = this.relate(view, mapping, false);
        if (relation === 'same') return view;
        if (relation === 'reused') throw reused(view);
      }
    }
    return null;
  }

  /**
   * The whole path for a SWIFT message: parse → map → quote → sign → submit.
   *
   * Safe to repeat. The payment id is derived from the message's own
   * references, and the ledger is asked for them first, so a payment handed
   * over twice is recognised: the second call sends nothing and returns the
   * settlement's current state with `already: true`. A reference that comes
   * back on a *different* payment (another amount, other parties, another
   * account or invoice) is refused as `reference_reused` — it is never
   * mistaken for a repeat.
   *
   * The platform holds the line at acceptance: one message is one
   * settlement there — the same payment in another message, under another
   * id, or handed over by two processes at the same moment. The one that
   * came second is answered `duplicate_source_message` with the settlement
   * that stands, and this call turns that into the same `already: true`
   * (it costs a quote and a signature that are then not used). The one
   * exception is two messages that nothing tells apart — the same
   * identifiers and content, and no value date: that is passed on as the
   * refusal it is.
   *
   * Without a UETR a payment is recognised by its own identifiers and its
   * value date — the reference-and-date rule of a bank's duplicate check. A
   * payment that comes again with the same instruction and end-to-end
   * identifiers, the same value date and the same content is the same
   * payment, in whatever message it stands; on another day, or with other
   * content, it is a new one. The UETR is what makes a payment recognisable
   * beyond doubt.
   */
  async submitSwift(message: SwiftMessageInput, opts: SwiftOptions = {}): Promise<SwiftSubmission> {
    this.mustSign('submitSwift()');
    const mapping = await this.mapSwift(message, opts);
    if (!mapping.input) throw new SwiftMappingError(mapping);
    const derivedId = swiftPaymentId(this.o.institutionId, mapping.payment);
    const paymentId = opts.paymentId ?? derivedId;
    const already = (view: SettlementView): SwiftSubmission =>
      ({ paymentId: view.payment_id, state: view.state, already: true, mapping });

    const before = await this.knownSwift(paymentId, derivedId, mapping);
    if (before) return already(before);
    const built = await this.instructionFromMapping(mapping, { ...opts, paymentId });
    try {
      const accepted = await this.submit(built.body, `swift-${paymentId}`);
      return { paymentId, state: accepted.state, already: false, mapping, quote: built.quote };
    } catch (e) {
      if (e instanceof RemitApiError && TAKEN_ALREADY.has(e.code)) {
        // The platform has this payment: under another id, from another rendering of the
        // message, or from the process that got there first. Where it names the settlement,
        // that settlement is the answer — except when it says the two cannot be told apart.
        if (e.code === 'duplicate_source_message' && e.existingPaymentId && e.ground !== 'twin_undated') {
          const stands = await this.find(e.existingPaymentId);
          if (stands) return already(stands);
        }
        // Otherwise the ledger now says which: the same id or UETR taken a moment ago.
        const after = await this.knownSwift(paymentId, derivedId, mapping);
        if (after) return already(after);
      }
      throw e;
    }
  }

  /** The settlement's state as an ISO 20022 transaction status. */
  async swiftStatus(paymentId: string): Promise<SwiftStatus & { view: SettlementView }> {
    const view = await this.status(paymentId);
    return { ...swiftStatusOf(view), view };
  }

  /** The settlement's state as a `pacs.002` status report (XML). */
  async statusReport(paymentId: string): Promise<string> {
    return buildPacs002(await this.status(paymentId));
  }

  // ── Submitting, reading, and what follows ────────────────────────────────

  /**
   * Submit a signed instruction. Resolves only when the platform has named
   * the payment it accepted: an answer without that is not an acceptance.
   */
  async submit(body: Record<string, unknown>, idemKey?: string): Promise<{ payment_id: string; state: string }> {
    const accepted = await this.call<{ payment_id?: unknown; state?: unknown }>(
      'POST', '/v1/settlements', body, idemKey ?? `sdk-${body.payment_id as string}`);
    if (accepted.payment_id !== body.payment_id || typeof accepted.state !== 'string') {
      throw notThePlatform('POST', '/v1/settlements', 'a body that does not name the payment and its state');
    }
    return { payment_id: accepted.payment_id as string, state: accepted.state };
  }

  async status(paymentId: string): Promise<SettlementView> {
    const view = await this.call<SettlementView>('GET', `/v1/settlements/${encodeURIComponent(paymentId)}`);
    if (typeof view.payment_id !== 'string' || typeof view.state !== 'string' || !Array.isArray(view.events)) {
      throw notThePlatform('GET', '/v1/settlements/{id}', 'a body that is not a settlement');
    }
    return view;
  }

  /** `status()`, or null when the organisation has no such settlement. */
  async find(paymentId: string): Promise<SettlementView | null> {
    try {
      return await this.status(paymentId);
    } catch (e) {
      if (e instanceof RemitApiError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * One page of the settlement ledger. Server-side filters, keyset cursor:
   * pass `next_cursor` from one page as `cursor` of the next. Built for the
   * org with thousands of rows — the SDK never pulls the whole ledger.
   * `q` matches the payment id, quote id, chain transaction, payout bank
   * reference and the references of the originating SWIFT message (UETR,
   * instruction id, end-to-end id, message id) — a part of any of them.
   *
   * `sourceUetr` and `sourceContent` are exact lookups on the message a
   * settlement was made from: the whole UETR, or the content digest signed
   * into the instruction (`sourceValueDate`, `YYYY-MM-DD`, narrows the
   * latter to one value date). They answer "is this payment here already?".
   */
  async list(opts: {
    q?: string; sourceUetr?: string; sourceContent?: string; sourceValueDate?: string;
    state?: string; from?: string; to?: string;
    cursor?: string; limit?: number;
  } = {}): Promise<{
    data: Record<string, unknown>[];
    page: { total: number; returned: number; next_cursor: string | null };
  }> {
    const qs = new URLSearchParams();
    if (opts.q) qs.set('q', opts.q);
    if (opts.sourceUetr) qs.set('source_uetr', opts.sourceUetr);
    if (opts.sourceContent) qs.set('source_content', opts.sourceContent);
    if (opts.sourceValueDate) qs.set('source_value_date', opts.sourceValueDate);
    if (opts.state) qs.set('state', opts.state);
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const tail = qs.toString();
    type Page = { data: Record<string, unknown>[]; page: { total: number; returned: number; next_cursor: string | null } };
    const page = await this.call<Page>('GET', `/v1/settlements${tail ? `?${tail}` : ''}`);
    if (!Array.isArray(page.data) || typeof page.page !== 'object' || page.page === null) {
      throw notThePlatform('GET', '/v1/settlements', 'a body that is not a ledger page');
    }
    return page;
  }

  evidence(paymentId: string): Promise<EvidenceResponse> {
    return this.call('GET', `/v1/settlements/${encodeURIComponent(paymentId)}/evidence`);
  }

  async cancel(paymentId: string, reason: string): Promise<{ payment_id: string; state: string }> {
    return this.call('POST', `/v1/settlements/${encodeURIComponent(paymentId)}/cancel`, {
      reason, sig: await this.signEventAsync({ payment_id: paymentId, reason }),
    });
  }

  async answerRfi(paymentId: string, answers: Record<string, string>): Promise<{ payment_id: string; state: string }> {
    return this.call('POST', `/v1/settlements/${encodeURIComponent(paymentId)}/rfi-response`, {
      answers, sig: await this.signEventAsync({ payment_id: paymentId, answers }),
    });
  }

  async submitDailyManifest(date: string, paymentIds: string[]): Promise<Record<string, unknown>> {
    const manifest = { date, institution_id: this.o.institutionId, payment_ids: paymentIds, count: paymentIds.length };
    return this.call('POST', '/v1/manifests/daily', { manifest, sig: await this.signEventAsync(manifest) });
  }

  /**
   * Check a webhook delivery before acting on it: the platform signs every
   * envelope, and this verifies the signature against the platform key the
   * Trust Registry publishes. Returns the envelope only when it verifies.
   * Deliveries are at-least-once — dedupe on `event_id`, order by `sequence`.
   */
  async verifyWebhook(delivery: unknown): Promise<{ valid: boolean; envelope: WebhookEnvelope | null }> {
    const d = delivery as { envelope?: WebhookEnvelope; signature?: EventSig } | null;
    if (!d?.envelope || !d.signature) return { valid: false, envelope: null };
    for (const fresh of [false, true]) {
      // A second look with a fresh key covers a platform key rotation.
      const spki = (await this.meta(fresh)).platform_signer?.spki;
      if (spki && verifyEvent(d.envelope, d.signature, spki)) return { valid: true, envelope: d.envelope };
    }
    return { valid: false, envelope: null };
  }

  /**
   * Wait for a terminal-or-paused outcome. Resolves on EVIDENCE_ANCHORED and
   * on every state where the pipeline stops moving on its own (RFI pause,
   * CANCELLED, RETURNED, EXCEPTION, L1 hold) — the caller decides what each
   * of those means for its ledger.
   */
  async track(paymentId: string, opts: {
    onState?: (state: string, view: SettlementView) => void;
    timeoutMs?: number; intervalMs?: number;
  } = {}): Promise<SettlementView> {
    const t0 = Date.now();
    let last = '';
    for (;;) {
      const view = await this.status(paymentId);
      if (view.state !== last) {
        last = view.state;
        opts.onState?.(last, view);
      }
      const types = view.events.map((e) => e.type);
      // A question asked after an earlier answer waits for the bank as much as the first did.
      const paused =
        (last === 'TRAVEL_RULE_PENDING' && travelRuleQuestionOpen(view.events))
        || (last === 'PAYOUT_IN_PROGRESS' && types.includes('EVIDENCE_INSUFFICIENT'));
      if (last === 'EVIDENCE_ANCHORED' || ['CANCELLED', 'RETURNED', 'EXCEPTION'].includes(last) || paused) {
        return view;
      }
      if (Date.now() - t0 > (opts.timeoutMs ?? 180_000)) {
        throw new RemitApiError(408, 'tracking_timeout', `payment ${paymentId} still ${last} after timeout`);
      }
      await new Promise((ok) => setTimeout(ok, opts.intervalMs ?? 1_500));
    }
  }
}
