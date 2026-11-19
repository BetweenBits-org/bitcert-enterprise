/**
 * Rule-level tests.
 *
 * `scenarios.test.ts` proves the five demonstration cases land correctly;
 * this file pins the individual rules so a failure says *which* rule broke
 * rather than "scenario C regressed". It also covers the paths the five
 * scenarios never reach: timing, parties, references, fees and FX.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEMO_ISSUER_KEYS, DEMO_KEYRING, evaluate, keyring, validatePolicy, partyEquals,
  durationToMs, sameUnitOfAccount, verifyEvidenceSignatures,
} from '../src/index.ts';
import type { MatchingResult, Policy, SettlementEvidence } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(path.resolve(HERE, '..', rel), 'utf8'));
const POLICY = read('policies/settlement-match-v1.json') as Policy;

/**
 * The fixture, with its signatures actually verified.
 *
 * Verification is a separate async pass (see `src/signature.ts` for why), and
 * doing it once here means the rule tests below — which are not about
 * signatures — read exactly as they did before while now running against
 * cryptographically checked evidence rather than a declared status.
 */
const BASE = await verifyEvidenceSignatures(
  read('fixtures/a-normal-trade-payment.json') as SettlementEvidence, DEMO_KEYRING);

const clone = (): SettlementEvidence => structuredClone(BASE);
const codes = (r: MatchingResult): string[] => r.findings.map((f) => f.code);
const find = (r: MatchingResult, code: string) => r.findings.find((f) => f.code === code);

// ── integrity ──────────────────────────────────────────────────────────────
test('an unverified digest reports NOT_CHECKED, never VALID', () => {
  const ev = clone();
  for (const k of ['chainTransfer', 'bankInstruction', 'commercialDocs'] as const) {
    delete (ev.elements[k] as { digestVerified?: boolean }).digestVerified;
  }
  delete ev.elements.payoutReceipts![0]!.digestVerified;
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.integrity.state, 'NOT_CHECKED');
  assert.ok(codes(r).includes('DIGEST_NOT_CHECKED'));
  // A check that never ran must not be reported as a failure either.
  assert.ok(!codes(r).includes('DIGEST_MISMATCH'));
});

test('a failed digest is INVALID and is attributed to its element', () => {
  const ev = clone();
  ev.elements.commercialDocs!.digestVerified = false;
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.integrity.state, 'INVALID');
  assert.equal(find(r, 'DIGEST_MISMATCH')?.element, 'commercialDocs');
});

// ── issuer ─────────────────────────────────────────────────────────────────
test('a demo-trust key verifies cryptographically but yields UNKNOWN_ISSUER', () => {
  const ev = clone();
  // Not hand-written: this is what `verifyEvidenceSignatures` computed from the
  // fixture's real ECDSA signature against the published demo public key.
  const sig = ev.elements.payoutReceipts![0]!.signature!;
  assert.equal(sig.checked, true, 'the signature must have actually been verified');
  assert.equal(sig.status, 'DEMO_VALID', 'a demo key that verifies is DEMO_VALID, never VALID');
  assert.equal(sig.trustLevel, 'DEMO');

  const r = evaluate(ev, POLICY);
  // The signature is not INVALID — the cryptography passed. Identity did not.
  assert.equal(r.axes.issuer.state, 'UNKNOWN_ISSUER');
  assert.ok(!codes(r).includes('SIGNATURE_INVALID'));
  const f = find(r, 'ISSUER_TRUST_INSUFFICIENT');
  assert.equal(f?.expected, 'ATTESTED');
  assert.equal(f?.actual, 'DEMO');
});

test('an absent signature is a warning about origin, not a verification failure', () => {
  const ev = clone();
  ev.elements.bankInstruction!.signature = { status: 'ABSENT' };
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.issuer.state, 'UNKNOWN_ISSUER');
  assert.equal(find(r, 'SIGNATURE_ABSENT')?.severity, 'warning');
});

test('a policy accepting DEMO trust reaches VALID on the same evidence', () => {
  const ev = clone();
  // chainTransfer legitimately carries no signature — a public ledger has no issuer.
  delete (ev.elements.chainTransfer as { signature?: unknown }).signature;
  const demoOk: Policy = { ...POLICY, sourceTrustLevel: 'DEMO' };
  const r = evaluate(ev, demoOk);
  assert.equal(r.axes.issuer.state, 'VALID', codes(r).join(','));
});

// ── matching: timing ───────────────────────────────────────────────────────
test('settlement outside the window is a mismatch', () => {
  const ev = clone();
  ev.elements.chainTransfer!.observedAt = '2026-03-10T08:15:00Z'; // 7 days later
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  const f = find(r, 'SETTLEMENT_WINDOW_EXCEEDED');
  assert.equal(f?.expected, 'P3D');
  assert.match(f!.actual!, /^\d+h$/);
});

test('funds moving before the instruction was approved is a mismatch', () => {
  const ev = clone();
  ev.elements.chainTransfer!.observedAt = '2026-03-01T08:15:00Z'; // before approval
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  assert.ok(codes(r).includes('SETTLEMENT_BEFORE_APPROVAL'));
});

test('absent timestamps mean the window was not evaluated, not that it passed', () => {
  const ev = clone();
  delete ev.elements.bankInstruction!.approvedAt;
  const r = evaluate(ev, POLICY);
  assert.ok(codes(r).includes('WINDOW_NOT_EVALUATED'));
  assert.ok(!codes(r).includes('SETTLEMENT_WINDOW_EXCEEDED'));
  assert.equal(r.axes.matching.state, 'MATCH');
});

test('the window is measured from evidence timestamps, so verdicts never age', () => {
  // The fixture is dated 2026-03. Were the window measured against wall-clock
  // time, this assertion would start failing by itself one day.
  const r1 = evaluate(clone(), POLICY);
  assert.equal(r1.axes.matching.state, 'MATCH');
  const ev = clone();
  ev.elements.bankInstruction!.approvedAt = '1999-01-01T00:00:00Z';
  ev.elements.chainTransfer!.observedAt = '1999-01-02T00:00:00Z';
  ev.elements.payoutReceipts![0]!.paidAt = '1999-01-02T00:00:00Z';
  assert.equal(evaluate(ev, POLICY).axes.matching.state, 'MATCH',
    'a 1999 payment inside a 3-day window still reconciles');
});

// ── matching: parties and references ───────────────────────────────────────
test('normalized party matching tolerates corporate suffix differences', () => {
  assert.ok(partyEquals('Acme Trading Co., Ltd.', 'Acme Trading Corporation', 'normalized'));
  assert.ok(!partyEquals('Acme Trading Co., Ltd.', 'Acme Trading Corporation', 'exact'));
  assert.ok(!partyEquals('Acme Trading', 'Beta Trading', 'normalized'));
  assert.ok(!partyEquals(undefined, 'Acme', 'normalized'));
});

test('a different counterparty is a blocking mismatch', () => {
  const ev = clone();
  ev.elements.commercialDocs!.buyer = 'Completely Different Holdings';
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  const f = find(r, 'PARTY_MISMATCH');
  assert.equal(f?.field, 'debtor');
  assert.equal(f?.expected, 'Completely Different Holdings');
});

test('an instruction that does not cite the invoice is flagged but not blocking', () => {
  const ev = clone();
  ev.elements.bankInstruction!.ref = 'UNRELATED-REF';
  ev.elements.bankInstruction!.iso20022Fields = ['Dbtr', 'Cdtr'];
  const r = evaluate(ev, POLICY);
  const f = find(r, 'REFERENCE_NOT_LINKED');
  assert.equal(f?.severity, 'warning');
  // A loose reference does not by itself contradict the amounts.
  assert.equal(r.axes.matching.state, 'MATCH');
});

// ── matching: currency and FX ──────────────────────────────────────────────
test('removing the unit-of-account group turns the same evidence into a mismatch', () => {
  const strict: Policy = { ...POLICY, unitOfAccountGroups: [] };
  const r = evaluate(clone(), strict);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  const f = find(r, 'CROSS_CURRENCY_WITHOUT_FX');
  assert.equal(f?.expected, 'USD');
  assert.equal(f?.actual, 'USDC');
});

test('naming an FX reference yields PENDING rather than an invented conversion', () => {
  const fx: Policy = { ...POLICY, unitOfAccountGroups: [], fxReference: 'ECB-daily' };
  const r = evaluate(clone(), fx);
  assert.equal(r.axes.matching.state, 'PENDING');
  assert.ok(codes(r).includes('FX_CONVERSION_REQUIRED'));
  assert.ok(!codes(r).includes('CROSS_CURRENCY_WITHOUT_FX'));
});

test('a currency outside the permitted list is rejected', () => {
  const ev = clone();
  ev.elements.chainTransfer!.currency = 'EURC';
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  assert.equal(find(r, 'CURRENCY_NOT_PERMITTED')?.actual, 'EURC');
});

// ── matching: tolerance and fees ───────────────────────────────────────────
test('a relative tolerance in basis points widens the band', () => {
  const ev = structuredClone(BASE);
  ev.elements.chainTransfer!.amount = '49995.00'; // 5.00 short = 1bp of 50000
  assert.equal(evaluate(ev, POLICY).axes.matching.state, 'MISMATCH');
  const loose: Policy = { ...POLICY, amountToleranceBps: 1 };
  assert.equal(evaluate(ev, loose).axes.matching.state, 'MATCH');
});

test('a deductible fee cap absorbs a short receipt', () => {
  const ev = structuredClone(BASE);
  ev.elements.payoutReceipts![0]!.amount = '49975.00'; // 25.00 short = 5bp
  assert.equal(evaluate(ev, POLICY).axes.matching.state, 'MISMATCH');
  const withFees: Policy = { ...POLICY, fees: { deductible: true, maxBps: 5 } };
  assert.equal(evaluate(ev, withFees).axes.matching.state, 'MATCH');
});

test('with no bank instruction there is no amount to reconcile to', () => {
  const ev = clone();
  delete ev.elements.bankInstruction;
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'PENDING');
  assert.ok(codes(r).includes('NO_REFERENCE_AMOUNT'));
  assert.equal(r.axes.completeness.state, 'INCOMPLETE');
});

// ── regulatory mapping and finality ────────────────────────────────────────
test('regulatory mapping lists missing checklist fields without judging compliance', () => {
  const ev = clone();
  delete ev.purpose;
  delete ev.elements.chainTransfer!.txRef;
  const r = evaluate(ev, POLICY);
  const missing = r.findings.filter((f) => f.code === 'REGULATORY_FIELD_MISSING').map((f) => f.field);
  assert.ok(missing.includes('purpose'));
  assert.ok(missing.includes('chainTxRef'));
  for (const f of r.axes.regulatoryMapping.findings) {
    assert.notEqual(f.severity, 'blocking', 'field coverage must never block on its own');
  }
  // The engine cannot express a compliance determination, by construction.
  assert.equal(r.regulatoryDecision, 'NOT_EVALUATED');
});

test('live data with full coverage reaches PRESENT and VERIFIED_BY_SOURCE', async () => {
  // `VERIFIED_BY_SOURCE` requires a signature above DEMO trust, and the demo
  // keyring is pinned to DEMO by design — so this path can only be reached by
  // re-verifying against a keyring that attests to the same keys. That is the
  // honest way to exercise it: the trust level comes from the keyring the
  // verifier was given, never from the evidence document.
  const attested = keyring(DEMO_ISSUER_KEYS.map((k) => ({ ...k, trustLevel: 'ATTESTED' as const })));
  const ev = await verifyEvidenceSignatures(clone(), attested);
  ev.dataMode = 'LIVE';
  ev.notRealPayment = false;
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.regulatoryMapping.state, 'PRESENT', codes(r).join(','));
  assert.equal(r.axes.businessFinality.state, 'VERIFIED_BY_SOURCE');
  // Everything satisfied, so no human is needed. The only path to this verdict.
  assert.equal(r.manualReviewRequired, false);
});

test('synthetic data can never reach PRESENT or VERIFIED_BY_SOURCE', () => {
  const r = evaluate(clone(), POLICY);
  assert.equal(r.dataMode, 'SYNTHETIC');
  assert.equal(r.axes.regulatoryMapping.state, 'REVIEW_REQUIRED');
  assert.equal(r.axes.businessFinality.state, 'DEMO_ONLY');
  assert.equal(r.manualReviewRequired, true);
});

test('live data whose payout lacks sufficient trust is UNVERIFIED, not DEMO_ONLY', () => {
  const ev = clone();
  ev.dataMode = 'LIVE';
  ev.elements.payoutReceipts![0]!.signature!.trustLevel = 'DEMO';
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.businessFinality.state, 'UNVERIFIED');
  assert.equal(find(r, 'PAYOUT_UNCONFIRMED')?.severity, 'blocking');
});

// ── policy plumbing ────────────────────────────────────────────────────────
test('policy validation refuses what it cannot evaluate deterministically', () => {
  const bad = (patch: Partial<Policy>, re: RegExp): void =>
    assert.throws(() => validatePolicy({ ...POLICY, ...patch }), re);
  bad({ amountTolerance: '1,000' }, /not a plain decimal/);
  bad({ amountToleranceBps: -1 }, /non-negative integer/);
  bad({ settlementWindow: 'P1M' }, /settlementWindow must be/);
  bad({ settlementWindow: 'three days' }, /settlementWindow must be/);
  bad({ partyIDMatch: 'fuzzy' as never }, /partyIDMatch/);
  bad({ sourceTrustLevel: 'MAYBE' as never }, /sourceTrustLevel/);
  bad({ currencies: [] }, /non-empty/);
  bad({ unitOfAccountGroups: [['USD'], ['USD', 'USDC']] }, /more than one unitOfAccountGroup/);
  bad({ unitOfAccountGroups: [['USD', 'GBP']] }, /not in currencies/);
});

test('durations cover days through seconds and reject calendar units', () => {
  assert.equal(durationToMs('P3D'), 3 * 86_400_000);
  assert.equal(durationToMs('PT12H'), 12 * 3_600_000);
  assert.equal(durationToMs('P1DT2H30M'), 86_400_000 + 2 * 3_600_000 + 30 * 60_000);
  // Months and years depend on a calendar position the engine deliberately lacks.
  assert.throws(() => durationToMs('P1M'), /unsupported duration/);
  assert.throws(() => durationToMs('P1Y'), /unsupported duration/);
});

test('unit-of-account membership is symmetric and reflexive', () => {
  assert.ok(sameUnitOfAccount('USD', 'USD', POLICY));
  assert.ok(sameUnitOfAccount('USD', 'USDC', POLICY));
  assert.ok(sameUnitOfAccount('USDC', 'USD', POLICY));
  assert.ok(!sameUnitOfAccount('USD', 'EURC', POLICY));
});

test('every finding carries a machine code and a human sentence', () => {
  const samples = [clone(), (() => { const e = clone(); e.elements.chainTransfer!.amount = '1.00'; return e; })()];
  for (const ev of samples) {
    for (const f of evaluate(ev, POLICY).findings) {
      assert.match(f.code, /^[A-Z][A-Z0-9_]+$/, `code ${f.code} should be a stable constant`);
      assert.ok(f.detail.length > 15, `${f.code} needs an explanatory detail`);
      assert.ok(['info', 'warning', 'blocking'].includes(f.severity));
    }
  }
});
