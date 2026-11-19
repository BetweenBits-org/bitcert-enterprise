/**
 * Evidence — where the remit rail meets the six-axis engine.
 *
 * The elements are collected from the parties that signed them (bank at
 * submission, BFI and settlement entity during the run), assembled into the
 * same `SettlementEvidence` document the Bank Evidence Lab evaluates, and
 * judged by the same `evaluate()` — so the verdict a bank sees on a live
 * sandbox payment is produced by the code path they already trusted with the
 * synthetic scenarios, with one difference: the keyring is the Trust
 * Registry, so the issuer axis reports real `ATTESTED` identities instead of
 * demo keys.
 *
 * The package then commits through the ordinary attestation path: nonce'd
 * SHA-256 commitment → `svc.issue()` under the bank's own org → batch →
 * Merkle → regtest anchor. Payment completion is never held hostage to the
 * chain: `BENEFICIARY_CREDIT_CONFIRMED` is announced first and
 * `EVIDENCE_ANCHORED` follows when the batch confirms (§3 steps 15/16).
 */
import { randomBytes } from 'node:crypto';
import { evaluate, verifyEvidenceSignatures, validatePolicy } from '@stonehash/attest-rules';
import type { MatchingResult, Policy, SettlementEvidence } from '@stonehash/attest-rules';
import { jcsString } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import { elementDigest, sha256hex } from './sign.ts';
import type { Registry } from './registry.ts';
import type { RemitPayment, RemitEvent, RemitStore } from './store.ts';

/**
 * The corridor policy. USD and USDC are one unit of account — the substantive
 * (and visible) judgement that a USDC settlement discharges a USD obligation
 * at par; the VND funding leg and SGD payout leg ride inside the elements as
 * locked conversions of the USD amounts, so every figure the engine compares
 * is in one unit and the quote that locked the legs is cited in the evidence.
 */
export const REMIT_POLICY: Policy = {
  policyVersion: 'remit-corridor-v1',
  currencies: ['USD', 'USDC'],
  unitOfAccountGroups: [['USD', 'USDC']],
  amountTolerance: '0.00',
  amountToleranceBps: 0,
  fxReference: 'STONEHASH-QUOTE',
  settlementWindow: 'P2D',
  fees: { deductible: false, maxBps: 0 },
  splitPayments: { allowed: false, aggregate: false },
  partyIDMatch: 'normalized',
  sourceTrustLevel: 'ATTESTED',
  requiredElements: ['chainTransfer', 'payoutReceipts', 'bankInstruction', 'commercialDocs', 'travelRule', 'bankApproval'],
  signatureRequiredElements: ['payoutReceipts', 'bankInstruction', 'commercialDocs', 'travelRule', 'bankApproval', 'chainTransfer'],
  regulatoryFields: [
    'originator', 'beneficiary', 'amount', 'currency', 'purpose',
    'jurisdictionFrom', 'jurisdictionTo', 'chainTxRef', 'originatorAddress',
    'beneficiaryAddress', 'invoiceRef', 'payoutRef', 'iso20022',
  ],
  requireTravelRulePreflight: true,
  enforceFxQuoteWindow: true,
  settlementIdRequiredIn: ['bankInstruction', 'chainTransfer', 'payoutReceipts', 'bankApproval'],
};

// Fail at module load, not at the first payment, if the policy is malformed
// (validatePolicy throws with the offending rule named).
validatePolicy(REMIT_POLICY);

/** Element kinds the parties hand over pre-signed. */
export interface SubmittedElements {
  bankInstruction?: Record<string, unknown>;
  bankApproval?: Record<string, unknown>;
  commercialDocs?: Record<string, unknown>;
  travelRule?: Record<string, unknown>;
  chainTransfer?: Record<string, unknown>;
  payoutReceipt?: Record<string, unknown>;
}

/**
 * Collect the signed elements from the event log.
 *
 * Elements arrive inside the events that carried them: the bank's three in
 * the settlement request, the BFI's travelRule with the payout approval, the
 * settlement entity's chainTransfer with the transfer confirmation, and the
 * BFI's payoutReceipt with completion. Verbatim JSON throughout — the
 * signature covers the canonical form of exactly these bytes.
 */
export function collectElements(events: RemitEvent[]): SubmittedElements {
  const out: SubmittedElements = {};
  const grab = (type: string, key: string): Record<string, unknown> | undefined => {
    const ev = events.find((e) => e.type === type);
    if (!ev) return undefined;
    const payload = JSON.parse(ev.payload) as Record<string, unknown>;
    const el = payload[key];
    return el && typeof el === 'object' ? el as Record<string, unknown> : undefined;
  };
  const bankEls = events.find((e) => e.type === 'BANK_EVIDENCE_SUBMITTED');
  if (bankEls) {
    const p = JSON.parse(bankEls.payload) as Record<string, Record<string, unknown>>;
    out.bankInstruction = p.bankInstruction;
    out.bankApproval = p.bankApproval;
    out.commercialDocs = p.commercialDocs;
  }
  out.travelRule = grab('PAYOUT_ACCEPTED', 'travel_rule_element');
  out.chainTransfer = grab('USDC_TRANSFER_CONFIRMED', 'chain_transfer_element');
  out.payoutReceipt = grab('PAYOUT_COMPLETED', 'payout_receipt_element');
  return out;
}

export function buildSettlementEvidence(p: RemitPayment, els: SubmittedElements): SettlementEvidence {
  return {
    schemaVersion: 'settlement-evidence/0.1',
    scenario: `remit · ${p.corridor_origin}→${p.corridor_destination} · ${p.id}`,
    settlementId: p.id,
    dataMode: 'SYNTHETIC',       // sandbox rail: mock USDC on a private chain
    notRealPayment: true,
    jurisdiction: { from: p.corridor_origin, to: p.corridor_destination },
    purpose: `Import trade payment under quote ${p.quote_id}`,
    elements: {
      ...(els.chainTransfer ? { chainTransfer: els.chainTransfer as never } : {}),
      ...(els.payoutReceipt ? { payoutReceipts: [els.payoutReceipt as never] } : {}),
      ...(els.bankInstruction ? { bankInstruction: els.bankInstruction as never } : {}),
      ...(els.commercialDocs ? { commercialDocs: els.commercialDocs as never } : {}),
      ...(els.travelRule ? { travelRule: els.travelRule as never } : {}),
      ...(els.bankApproval ? { bankApproval: els.bankApproval as never } : {}),
    },
  };
}

export interface ReconcileOutcome {
  evidence: SettlementEvidence;
  verdict: MatchingResult;
  /** All axes green, with businessFinality's sandbox allowance applied. */
  pass: boolean;
  reasons: string[];
}

/** Recompute each element's declared digest and stamp the verdict. */
function stampDigests(els: SubmittedElements): SubmittedElements {
  const out: SubmittedElements = {};
  for (const [key, el] of Object.entries(els) as [keyof SubmittedElements, Record<string, unknown> | undefined][]) {
    if (!el) continue;
    out[key] = typeof el.digest === 'string'
      ? { ...el, digestVerified: elementDigest(el) === el.digest }
      : el;
  }
  return out;
}

/** Verify signatures against the registry, evaluate, and apply the gate. */
export async function reconcilePayment(
  p: RemitPayment, store: RemitStore, registry: Registry, acceptDemoFinality: boolean,
): Promise<ReconcileOutcome> {
  const els = stampDigests(collectElements(await store.events(p.id)));
  const raw = buildSettlementEvidence(p, els);
  const evidence = await verifyEvidenceSignatures(raw, await registry.keyring());
  const verdict = evaluate(evidence, REMIT_POLICY);

  const reasons: string[] = [];
  const a = verdict.axes;
  if (a.integrity.state !== 'VALID') reasons.push(`integrity=${a.integrity.state}`);
  if (a.issuer.state !== 'VALID') reasons.push(`issuer=${a.issuer.state}`);
  if (a.matching.state !== 'MATCH') reasons.push(`matching=${a.matching.state}`);
  if (a.completeness.state !== 'COMPLETE') reasons.push(`completeness=${a.completeness.state}`);
  /*
   * SYNTHETIC data pins two axes by rule, not by measurement:
   * regulatoryMapping is at best REVIEW_REQUIRED and businessFinality at best
   * DEMO_ONLY. The sandbox allowance accepts exactly those two ceilings —
   * regulatory only when field coverage is actually complete (no
   * REGULATORY_FIELD_MISSING finding), so a genuinely missing field still
   * fails the gate in the sandbox.
   */
  const fieldsComplete = !a.regulatoryMapping.findings.some((x) => x.code === 'REGULATORY_FIELD_MISSING');
  const regulatoryOk = a.regulatoryMapping.state === 'PRESENT'
    || (acceptDemoFinality && a.regulatoryMapping.state === 'REVIEW_REQUIRED' && fieldsComplete);
  if (!regulatoryOk) reasons.push(`regulatoryMapping=${a.regulatoryMapping.state}`);
  const finalityOk = a.businessFinality.state === 'VERIFIED_BY_SOURCE'
    || (acceptDemoFinality && a.businessFinality.state === 'DEMO_ONLY');
  if (!finalityOk) reasons.push(`businessFinality=${a.businessFinality.state}`);

  return { evidence, verdict, pass: reasons.length === 0, reasons };
}

export const EVIDENCE_COMMIT_DOMAIN = 'STONEHASH-EVIDENCE-V1';

export interface EvidencePackage {
  schema: 'stonehash.payment-evidence.v1';
  payment_id: string;
  corridor: { origin: string; destination: string };
  state: string;
  amounts: {
    trade: { currency: string; value: string };
    collected: { currency: string; value: string };
    settled: { asset: string; value: string };
    paid: { currency: string; value: string };
  };
  quote_id: string;
  events: { seq: number; type: string; issuer: string; payload: unknown; sig: unknown; at: string }[];
  evidence: SettlementEvidence;
  policy: Policy;
  verdict: MatchingResult;
  trust_registry: { taken_at: string; institutions: Record<string, unknown>[] };
  generated_at: string;
}

export async function assemblePackage(p: RemitPayment, store: RemitStore, registry: Registry,
  evidence: SettlementEvidence, verdict: MatchingResult): Promise<EvidencePackage> {
  return {
    schema: 'stonehash.payment-evidence.v1',
    payment_id: p.id,
    corridor: { origin: p.corridor_origin, destination: p.corridor_destination },
    state: p.state,
    amounts: {
      trade: { currency: p.trade_currency, value: p.trade_amount },
      collected: { currency: p.collect_currency, value: p.collect_amount },
      settled: { asset: 'USDC', value: p.usdc_amount },
      paid: { currency: p.payout_currency, value: p.payout_amount },
    },
    quote_id: p.quote_id,
    events: (await store.events(p.id)).map((e) => ({
      seq: e.seq, type: e.type, issuer: e.issuer,
      payload: JSON.parse(e.payload) as unknown,
      sig: e.sig ? JSON.parse(e.sig) as unknown : null,
      at: e.created_at,
    })),
    evidence,
    policy: REMIT_POLICY,
    verdict,
    trust_registry: await registry.snapshot(),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Nonce'd commitment over the canonical package (arch doc §6-4): the anchor
 * leaf reveals nothing about the payment, and the nonce — disclosed inside
 * the package itself — lets its holder, and only its holder, re-derive the
 * leaf from the content.
 */
export function packageCommitment(pkg: EvidencePackage, nonceHex: string): string {
  const canonical = Buffer.from(jcsString(pkg as unknown as JcsValue), 'utf8');
  return sha256hex(Buffer.concat([
    Buffer.from(EVIDENCE_COMMIT_DOMAIN, 'utf8'),
    Buffer.from(nonceHex, 'hex'),
    canonical,
  ]));
}

export function newNonce(): string {
  return randomBytes(32).toString('hex');
}
