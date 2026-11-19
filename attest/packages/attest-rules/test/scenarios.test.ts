/**
 * The five Bank Review scenarios, pinned to the verdicts the design specifies.
 *
 * These are the assertions that matter commercially: a reviewer is going to
 * break the data on purpose and the engine has to attribute the failure to the
 * right axis. Scenario C in particular — integrity passing while the issuer
 * fails — is the case a single pass/fail would hide, and it is tested as such.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildScenario, DEMO_KEYRING, evaluate, SCENARIOS, verifyEvidenceSignatures } from '../src/index.ts';
import type { MatchingResult, Policy, SettlementEvidence, ScenarioId } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(path.resolve(HERE, '..', rel), 'utf8'));

const BASE = read('fixtures/a-normal-trade-payment.json') as SettlementEvidence;
const POLICY = read('policies/settlement-match-v1.json') as Policy;

/**
 * Build a scenario, verify its signatures, then evaluate.
 *
 * The verification has to happen *after* the scenario transform, not before:
 * scenario C corrupts the signature bytes and E synthesises two receipts the
 * provider never signed, so a verdict computed from a pre-verified base would
 * describe evidence that no longer exists. This ordering is also what the
 * Playground and the HTTP route do.
 */
const run = async (
  id: ScenarioId, policy: Policy = POLICY,
): Promise<MatchingResult> =>
  evaluate(await verifyEvidenceSignatures(buildScenario(id, BASE), DEMO_KEYRING), policy);

const codes = (r: MatchingResult): string[] => r.findings.map((f) => f.code);
const why = (r: MatchingResult): string =>
  Object.entries(r.axes).map(([k, v]) => `${k}=${v.state}`).join(' ') + ' | ' + codes(r).join(',');

test('A · normal payment reconciles; the remaining gaps are honest ones', async () => {
  const r = await run('A');
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
  assert.equal(r.axes.integrity.state, 'VALID', why(r));
  assert.equal(r.axes.completeness.state, 'COMPLETE', why(r));
  // Synthetic data can never reach VERIFIED_BY_SOURCE or PRESENT, and the
  // engine enforces that from the data rather than relying on a UI label.
  assert.equal(r.axes.businessFinality.state, 'DEMO_ONLY', why(r));
  assert.equal(r.axes.regulatoryMapping.state, 'REVIEW_REQUIRED', why(r));
  // So a clean reconciliation still asks for a human. That is correct, not a bug.
  assert.equal(r.manualReviewRequired, true);
  assert.equal(r.regulatoryDecision, 'NOT_EVALUATED');
});

test('B · amount mismatch names the field, the values and the tolerance', async () => {
  const r = await run('B');
  assert.equal(r.axes.matching.state, 'MISMATCH', why(r));
  const f = r.findings.find((x) => x.code === 'AMOUNT_MISMATCH');
  assert.ok(f, 'expected an AMOUNT_MISMATCH finding');
  assert.equal(f.element, 'chainTransfer');
  assert.equal(f.expected, '50000.00');
  assert.equal(f.actual, '48000.00');
  assert.equal(f.tolerance, '0.00');
  assert.equal(f.severity, 'blocking');
  // "Amounts do not match" is not actionable; the detail has to carry the delta.
  assert.match(f.detail, /2000\.00/);
  // Everything else is untouched: only the amount is wrong.
  assert.equal(r.axes.integrity.state, 'VALID', why(r));
  assert.equal(r.axes.completeness.state, 'COMPLETE', why(r));
});

test('C · a broken payout signature fails the issuer axis while integrity holds', async () => {
  const r = await run('C');
  assert.equal(r.axes.issuer.state, 'INVALID', why(r));
  // The headline assertion of the whole workflow.
  assert.equal(r.axes.integrity.state, 'VALID',
    'the digest still verifies — only the signature failed');
  assert.equal(r.axes.matching.state, 'MATCH', 'the amounts never changed');
  const f = r.findings.find((x) => x.code === 'SIGNATURE_INVALID');
  assert.ok(f);
  assert.equal(f.element, 'payoutReceipts');
  assert.equal(f.severity, 'blocking');
});

test('D · a missing invoice is INCOMPLETE, never INVALID', async () => {
  const r = await run('D');
  assert.equal(r.axes.completeness.state, 'INCOMPLETE', why(r));
  // Missing is not contradicted. Integrity must not be dragged down with it.
  assert.equal(r.axes.integrity.state, 'VALID', why(r));
  assert.notEqual(r.axes.integrity.state, 'INVALID');
  const f = r.findings.find((x) => x.code === 'DOCUMENT_CITED_NOT_ATTACHED');
  assert.ok(f, 'expected the cited-not-attached finding');
  assert.equal(f.field, 'invoice');
  // And nothing claims the invoice was forged.
  assert.ok(!codes(r).includes('DIGEST_MISMATCH'));
});

test('E · a split payment matches when the policy aggregates', async () => {
  const r = await run('E');
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
  assert.ok(!codes(r).includes('AMOUNT_MISMATCH'));
});

test('E · the same split is PENDING when the policy does not aggregate', async () => {
  const noAgg: Policy = { ...POLICY, splitPayments: { allowed: true, aggregate: false } };
  const r = await run('E', noAgg);
  assert.equal(r.axes.matching.state, 'PENDING', why(r));
  assert.ok(codes(r).includes('SPLIT_AGGREGATION_DISABLED'));
  // PENDING is not MISMATCH: the sources do not disagree, the policy cannot decide.
  assert.notEqual(r.axes.matching.state, 'MISMATCH');
});

test('E · the same split is MISMATCH when splits are forbidden outright', async () => {
  const noSplit: Policy = { ...POLICY, splitPayments: { allowed: false, aggregate: false } };
  const r = await run('E', noSplit);
  assert.equal(r.axes.matching.state, 'MISMATCH', why(r));
  assert.ok(codes(r).includes('SPLIT_NOT_ALLOWED'));
});

test('changing the policy changes the digest, so verdicts cannot be re-read under new rules', async () => {
  const a = await run('A');
  const tweaked: Policy = { ...POLICY, amountTolerance: '0.01' };
  const b = evaluate(buildScenario('A', BASE), tweaked);
  assert.notEqual(a.policyDigest, b.policyDigest);
  // The version string is a human label and can be reused by mistake; the digest cannot.
  assert.equal(a.policyVersion, b.policyVersion);
});

test('B passes under a policy whose tolerance covers the gap', async () => {
  const loose: Policy = { ...POLICY, amountTolerance: '2000.00' };
  const r = await run('B', loose);
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
  // Same evidence, different policy, different verdict — and the digest says which.
  assert.notEqual(r.policyDigest, (await run('B')).policyDigest);
});

test('every scenario is deterministic and side-effect free', async () => {
  for (const s of SCENARIOS) {
    const first = JSON.stringify(await run(s.id));
    const second = JSON.stringify(await run(s.id));
    assert.equal(first, second, `${s.id} is not deterministic`);
  }
  // The base fixture must survive every transform untouched.
  assert.equal(BASE.elements.chainTransfer?.amount, '50000.00');
  assert.equal(BASE.elements.payoutReceipts?.length, 1);
  assert.deepEqual(BASE.elements.commercialDocs?.citedOnly, []);
  assert.ok(!BASE.scenario.includes('tampered'));
});

test('tampered evidence labels itself, so a downloaded verdict cannot pass as clean', async () => {
  for (const id of ['B', 'C', 'D', 'E'] as const) {
    const ev = buildScenario(id, BASE);
    assert.match(ev.scenario, /tampered:/, `${id} should record what was altered`);
    assert.equal(evaluate(ev, POLICY).scenario, ev.scenario);
  }
  assert.ok(!buildScenario('A', BASE).scenario.includes('tampered'));
});

test('every scenario declares what it teaches, and the ids are unique', async () => {
  assert.ok(SCENARIOS.length >= 6, 'A-F at minimum');
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
  for (const s of SCENARIOS) {
    assert.ok(s.teaches.length > 60, `${s.id}: explain what a reviewer learns`);
    assert.ok(s.title.length > 0);
  }
});

/**
 * F is the scenario the other five cannot express.
 *
 * Every other failure here leaves a mark on the evidence — a changed number,
 * corrupted signature bytes, a document that is not there. A resubmission
 * leaves none: both copies are the receipt the provider signed. So integrity
 * and issuer have to pass, and the payment still has to be stopped. A product
 * that answered "is this document genuine?" and called it "may we pay?" would
 * release this one.
 */
test('F: a genuine receipt submitted twice passes integrity and issuer, and still blocks', async () => {
  const r = await run('F');

  assert.equal(r.axes.integrity.state, 'VALID', why(r));
  assert.equal(r.axes.issuer.state, (await run('A')).axes.issuer.state,
    'resubmitting a signed document changes nothing about who signed it');
  assert.equal(r.axes.matching.state, 'MISMATCH', why(r));
  assert.ok(r.manualReviewRequired);

  const dup = r.findings.find((f) => f.code === 'DUPLICATE_PAYOUT_REF');
  assert.ok(dup, `expected DUPLICATE_PAYOUT_REF, got ${codes(r).join(',')}`);
  assert.equal(dup.severity, 'blocking');
  assert.equal(dup.element, 'payoutReceipts');
  // The reviewer has to be sent after a double release, not after a shortfall.
  assert.match(String(dup.actual), /x2$/);
  assert.doesNotMatch(codes(r).join(','), /AMOUNT_MISMATCH/,
    'a duplicate reported as an amount mismatch sends the reviewer the wrong way');
});
