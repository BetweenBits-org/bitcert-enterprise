/**
 * The corridor controls, and the salted commitment.
 *
 * These are the assertions a bank's own reviewer would want to make before
 * believing any of it: that the pre-flight gate is enforced as arithmetic rather
 * than asserted, that a failure lands on the right axis, and — the one that
 * matters most for a data-protection review — that nothing derived from the
 * Travel Rule content can be recovered from what goes on-chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CORRIDOR_SCENARIOS, SWIFT_MAPPING, assertNoPiiInLeaf, auditLeaf, buildCorridorScenario,
  COMMITTED_FIELDS, evaluate, selectAuditFields, verifyAuditLeaf,
} from '../src/index.ts';
import type { MatchingResult, Policy, SettlementEvidence } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(path.resolve(HERE, '..', rel), 'utf8'));
const BASE = read('fixtures/corridor-vn-sg-normal.json') as SettlementEvidence;
const POLICY = read('policies/corridor-vn-sg-v1.json') as Policy;
const SALT = 'a1'.repeat(32);

const run = (id: 'N' | 'P' | 'Q' | 'W' | 'R', policy: Policy = POLICY): MatchingResult =>
  evaluate(buildCorridorScenario(id, BASE), policy);
const codes = (r: MatchingResult): string[] => r.findings.map((f) => f.code);
const why = (r: MatchingResult): string =>
  Object.entries(r.axes).map(([k, v]) => `${k}=${v.state}`).join(' ') + ' | ' + codes(r).join(',');

// ── the controls ───────────────────────────────────────────────────────────

test('N · a clean corridor payment reconciles across all six sources', () => {
  const r = run('N');
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
  assert.equal(r.axes.integrity.state, 'VALID', why(r));
  assert.equal(r.axes.completeness.state, 'COMPLETE', why(r));
  // No corridor control fired.
  for (const c of ['PREFLIGHT_VIOLATED', 'TRAVEL_RULE_NOT_APPROVED', 'FX_QUOTE_EXPIRED',
    'SETTLEMENT_ID_MISSING', 'SETTLEMENT_ID_NOT_CARRIED']) {
    assert.ok(!codes(r).includes(c), `${c} should not fire on a clean payment`);
  }
});

test('P · releasing before Travel Rule approval is blocking, and nothing else breaks', () => {
  const r = run('P');
  assert.equal(r.axes.issuer.state, 'INVALID', why(r));
  const f = r.findings.find((x) => x.code === 'PREFLIGHT_VIOLATED');
  assert.ok(f, 'the pre-flight gate must be enforced, not assumed');
  assert.equal(f.severity, 'blocking');
  assert.equal(f.element, 'travelRule');
  // The point a single pass/fail would hide: the figures are perfect.
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
  assert.equal(r.axes.integrity.state, 'VALID');
  assert.equal(r.axes.completeness.state, 'COMPLETE');
});

test('Q · an incomplete Travel Rule exchange lands on the issuer axis', () => {
  const r = run('Q');
  assert.equal(r.axes.issuer.state, 'INVALID', why(r));
  const f = r.findings.find((x) => x.code === 'TRAVEL_RULE_NOT_APPROVED');
  assert.equal(f?.expected, 'APPROVED');
  assert.equal(f?.actual, 'PENDING');
  // A question about authorisation, not about arithmetic.
  assert.equal(r.axes.matching.state, 'MATCH', why(r));
});

test('W · settling after the locked quote expired is a matching break', () => {
  const r = run('W');
  assert.equal(r.axes.matching.state, 'MISMATCH', why(r));
  const f = r.findings.find((x) => x.code === 'FX_QUOTE_EXPIRED');
  assert.ok(f);
  assert.equal(f.expected, '2026-11-04T02:35:00Z');
  assert.equal(f.actual, '2026-11-04T03:50:00Z');
  // The USD amounts are identical throughout — an amount-only reconciliation
  // would pass this payment.
  assert.ok(!codes(r).includes('AMOUNT_MISMATCH'));
});

test('R · a refund with no original reference is blocking', () => {
  const r = run('R');
  assert.equal(r.axes.matching.state, 'MISMATCH', why(r));
  assert.ok(codes(r).includes('REFUND_WITHOUT_ORIGINAL'));
  // And a linked refund with no reason is a warning, not a block.
  const linked = structuredClone(buildCorridorScenario('R', BASE));
  linked.relatedSettlementId = 'VN-SG-20261104-0007';
  delete linked.refundReasonCode;
  const r2 = evaluate(linked, POLICY);
  assert.ok(codes(r2).includes('REFUND_WITHOUT_REASON'));
  assert.ok(!codes(r2).includes('REFUND_WITHOUT_ORIGINAL'));
});

test('a missing settlement id is blocking: the layers would be unlinked', () => {
  const ev = structuredClone(BASE);
  delete ev.settlementId;
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  const f = r.findings.find((x) => x.code === 'SETTLEMENT_ID_MISSING');
  assert.match(f!.detail, /UETR/, 'the explanation should name the SWIFT equivalent');
});

test('a layer that does not cite the settlement id is flagged per layer', () => {
  const ev = structuredClone(BASE);
  delete ev.elements.chainTransfer!.settlementIdMemo;
  ev.elements.chainTransfer!.txRef = 'UNRELATED-TX';
  const r = evaluate(ev, POLICY);
  const f = r.findings.find((x) => x.code === 'SETTLEMENT_ID_NOT_CARRIED');
  assert.equal(f?.element, 'chainTransfer');
  assert.equal(f?.expected, 'VN-SG-20261104-0007');
});

test('paying an address the counterparty did not whitelist is blocking', () => {
  const ev = structuredClone(BASE);
  ev.elements.chainTransfer!.toAddress = '0xSOMEWHERE-ELSE-000000000000000000000';
  const r = evaluate(ev, POLICY);
  assert.equal(r.axes.matching.state, 'MISMATCH');
  assert.ok(codes(r).includes('BENEFICIARY_ADDRESS_NOT_APPROVED'));
});

test('the generic policy does not apply corridor controls', () => {
  // Same evidence, looser policy: the corridor checks are opt-in, so a
  // deployment that has not adopted them is not silently failing payments.
  const generic = read('policies/settlement-match-v1.json') as Policy;
  const r = evaluate(buildCorridorScenario('P', BASE), generic);
  assert.ok(!codes(r).includes('PREFLIGHT_VIOLATED'));
  assert.ok(!codes(r).includes('SETTLEMENT_ID_NOT_CARRIED'));
});

// ── the salted commitment ──────────────────────────────────────────────────

test('the committed leaf covers the audit fields and nothing else', () => {
  const fields = selectAuditFields(BASE);
  assert.equal(fields.settlementId, 'VN-SG-20261104-0007');
  assert.equal(fields.travelRuleDigest, BASE.elements.travelRule!.ivms101Digest);
  assert.equal(fields.chainTxRef, BASE.elements.chainTransfer!.txRef);
  assert.equal(fields.regulatorReportRef, 'SBV-FX-2026-Q1-004412');
  // Every selected key must be one of the declared committed fields: an
  // accidental addition would quietly change what goes on a public ledger.
  for (const k of Object.keys(fields)) {
    assert.ok((COMMITTED_FIELDS as readonly string[]).includes(k), `${k} is not a declared field`);
  }
  // And no content — only references and digests.
  const serialised = JSON.stringify(fields);
  assert.ok(!serialised.includes('Acme Trading'), 'no party name may be committed');
  assert.ok(!serialised.includes('Pacific Supply'), 'no party name may be committed');
  assert.ok(!serialised.includes('50000'), 'no amount may be committed');
});

test('the leaf is deterministic, and the salt is what makes it opaque', () => {
  const a = auditLeaf(BASE, SALT);
  const b = auditLeaf(BASE, SALT);
  assert.equal(a.leafBytes, b.leafBytes, 'an auditor must reproduce it years later');
  assert.match(a.leafBytes, /^[0-9a-f]{64}$/);
  // A different salt over identical evidence yields an unrelated commitment.
  const c = auditLeaf(BASE, 'b2'.repeat(32));
  assert.notEqual(a.leafBytes, c.leafBytes);
});

test('an observer with the chain alone cannot enumerate the committed fields', () => {
  // The attack the salt exists to stop: a settlement id is a guessable shape
  // (corridor, date, counter), so without a salt an observer holding a
  // candidate could confirm a payment happened by recomputing the digest.
  const { leafBytes } = auditLeaf(BASE, SALT);
  const domain = 'attest:settlement:v1\n';
  const fields = JSON.stringify(selectAuditFields(BASE), Object.keys(selectAuditFields(BASE)).sort());
  for (let counter = 1; counter <= 50; counter++) {
    const guess = `VN-SG-20261104-${String(counter).padStart(4, '0')}`;
    const unsalted = createHash('sha256').update(domain + fields.replace('0007', guess.slice(-4))).digest('hex');
    assert.notEqual(unsalted, leafBytes,
      'an unsalted guess must never reproduce the commitment');
  }
});

test('a short salt is refused rather than quietly accepted', () => {
  assert.throws(() => auditLeaf(BASE, 'ab'.repeat(8)), /at least 32 bytes/);
  assert.throws(() => auditLeaf(BASE, ''), /at least 32 bytes/);
  // Random 32-byte salts are what production should use.
  const ok = auditLeaf(BASE, randomBytes(32).toString('hex'));
  assert.equal(ok.saltBytes, 32);
});

test('a settlement with no id cannot be committed at all', () => {
  const ev = structuredClone(BASE);
  delete ev.settlementId;
  assert.throws(() => auditLeaf(ev, SALT), /settlementId is required/);
});

test('verification recomputes the leaf and shows a mismatch rather than only reporting it', () => {
  const { leafBytes } = auditLeaf(BASE, SALT);
  const good = verifyAuditLeaf(BASE, SALT, leafBytes);
  assert.equal(good.ok, true);
  assert.equal(good.computed, leafBytes);

  // Alter one committed field: the commitment must no longer verify. This is
  // the whole mechanism — later alteration becomes arithmetic, not an opinion.
  const altered = structuredClone(BASE);
  altered.elements.commercialDocs!.digest = 'ff'.repeat(32);
  const bad = verifyAuditLeaf(altered, SALT, leafBytes);
  assert.equal(bad.ok, false);
  assert.notEqual(bad.computed, leafBytes);
  assert.equal(bad.fields.documentDigest, 'ff'.repeat(32), 'the caller can see what differed');
});

test('a field naming personal data is refused from the committed set', () => {
  // The guardrail. Travel Rule content is exchanged privately under FATF R.16;
  // committing it — or a field derived from it — would trade a transmission
  // obligation for a permanent public disclosure.
  assertNoPiiInLeaf(selectAuditFields(BASE));
  for (const bad of ['originatorName', 'beneficiary_address', 'taxId', 'accountNumber', 'dateOfBirth']) {
    assert.throws(() => assertNoPiiInLeaf({ [bad]: 'x' } as never),
      /personal data|FATF R\.16/, `${bad} must be refused`);
  }
});

// ── orientation material ───────────────────────────────────────────────────

test('every corridor scenario explains its control and what it teaches', () => {
  assert.equal(CORRIDOR_SCENARIOS.length, 5);
  for (const s of CORRIDOR_SCENARIOS) {
    assert.ok(s.control.length > 40, `${s.id}: state the control in a sentence`);
    assert.ok(s.teaches.length > 80, `${s.id}: explain what a reviewer learns`);
    // Each must actually build.
    assert.ok(buildCorridorScenario(s.id, BASE).scenario.length > 0);
  }
});

test('the SWIFT mapping covers every artefact a reviewer will look for', () => {
  const swift = SWIFT_MAPPING.map((m) => m.swift.toLowerCase()).join(' | ');
  for (const needle of ['uetr', '50:', '59:', 'correspondent', 'nostro', 'archive']) {
    assert.ok(swift.includes(needle), `the mapping should address ${needle}`);
  }
  for (const m of SWIFT_MAPPING) {
    assert.ok(m.note.length > 50, `${m.swift}: the note should say why, not just what`);
  }
  // The row that carries the argument: an archive can be restated by its
  // operator, an anchor cannot.
  const archive = SWIFT_MAPPING.find((m) => /archive/i.test(m.swift));
  assert.match(archive!.note, /restated/i);
});
