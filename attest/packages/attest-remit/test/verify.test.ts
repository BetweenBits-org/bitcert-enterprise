/**
 * verifyEvidencePackage(): what the "signatures" check counts, and how the
 * "verdict" check compares the two verdicts.
 *
 * The checks are exercised end to end against the platform; this file pins
 * the rules a package cannot be allowed to bend — only a signature this
 * verifier checked itself is "valid" — and the one a stored file must not
 * trip over: the order its axes are written in is not part of the verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { SAMPLE_POLICY, SAMPLE_SETTLEMENT } from '@stonehash/attest-rules';
import type { SettlementEvidence } from '@stonehash/attest-rules';
import { finishElement, spkiOf, verifyEvidencePackage } from '../src/index.ts';
import type { EvidenceResponse } from '../src/index.ts';

const bank = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const signed = (core: Record<string, unknown>): Record<string, unknown> =>
  finishElement(core, bank.privateKey, 'VN-BANK-T1', 'Test Bank');

/** A package around the given elements; its commitment and anchor are not what is under test. */
function packageWith(elements: Record<string, unknown>): EvidenceResponse {
  return {
    package: {
      evidence: { ...structuredClone(SAMPLE_SETTLEMENT), elements } as unknown as SettlementEvidence,
      policy: SAMPLE_POLICY,
      verdict: { axes: {} },
      trust_registry: { institutions: [{ id: 'VN-BANK-T1', name: 'Test Bank', signing_spki: spkiOf(bank.privateKey) }] },
    },
    commitment: { value: '00'.repeat(32), nonce: '00'.repeat(16) },
    attestation: null,
  };
}
const signatures = async (elements: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> => {
  const report = await verifyEvidencePackage(packageWith(elements));
  const check = report.checks.find((c) => c.name === 'signatures')!;
  return { ok: check.ok, detail: check.detail };
};

test('evidence signatures: only what this verifier checked itself is valid', async () => {
  const instruction = signed({ id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-1', amount: '12500.00', currency: 'USD' });

  // An element the bank signed, under a key the registry in the package carries.
  assert.deepEqual(await signatures({ bankInstruction: instruction }), { ok: true, detail: 'bankInstruction:VALID' });

  // The same element with one character changed after signing.
  const tampered = await signatures({ bankInstruction: { ...instruction, amount: '12500.01' } });
  assert.equal(tampered.ok, false);
  assert.doesNotMatch(tampered.detail, /bankInstruction:VALID/);

  // An element under a name this verifier does not check, calling itself valid: it is not taken at its word.
  const selfDeclared = await signatures({ bankInstruction: instruction, notarisation: { signature: { status: 'VALID' } } });
  assert.deepEqual(selfDeclared, { ok: false, detail: 'bankInstruction:VALID notarisation:NOT_VERIFIED' });
  // …nor a list of them.
  assert.equal((await signatures({ bankInstruction: instruction, extras: [{ signature: { status: 'VALID' } }] })).detail,
    'bankInstruction:VALID extras:NOT_VERIFIED');

  // A package with no element has shown nothing — it does not pass by having nothing to fail.
  assert.deepEqual(await signatures({}), { ok: false, detail: 'the package carries no evidence element' });

  // A status written into a known element is recomputed, not read.
  const forged = await signatures({ bankInstruction: { id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-1', signature: { status: 'VALID' } } });
  assert.equal(forged.ok, false);
});

test('evidence verification reports; it does not throw on a package it cannot make sense of', async () => {
  // Evidence the engine cannot evaluate (no amount): the verdict check fails, with the reason.
  const odd = await verifyEvidencePackage(packageWith({ bankInstruction: signed({ id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-1' }) }));
  assert.equal(odd.verified, false);
  const verdict = odd.checks.find((c) => c.name === 'verdict')!;
  assert.deepEqual([verdict.ok, /could not be re-evaluated/.test(verdict.detail)], [false, true]);
  assert.deepEqual(odd.checks.map((c) => c.name), ['commitment', 'signatures', 'verdict', 'anchor'], 'all four are reported');

  // A registry snapshot whose key cannot be read: the signatures are not checked, and the verdict is not taken on trust either.
  const broken = packageWith({ bankInstruction: signed({ id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-1', amount: '12500.00', currency: 'USD' }) });
  broken.package.trust_registry.institutions[0]!.signing_spki = 'bm90IGEga2V5';
  const report = await verifyEvidencePackage(broken);
  assert.deepEqual(report.checks.map((c) => [c.name, c.ok]), [['commitment', false], ['signatures', false], ['verdict', false], ['anchor', false]]);
  assert.match(report.checks[1]!.detail, /could not be checked/);
  assert.match(report.checks[2]!.detail, /not re-evaluated/);
});

test('the stated verdict is compared axis by axis; the order it is written in is not compared', async () => {
  const instruction = signed({ id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-1', amount: '12500.00', currency: 'USD' });
  const verdictOf = async (axes: unknown): Promise<{ ok: boolean; detail: string }> => {
    const res = packageWith({ bankInstruction: instruction });
    (res.package as { verdict: unknown }).verdict = { axes };
    const check = (await verifyEvidencePackage(res)).checks.find((c) => c.name === 'verdict')!;
    return { ok: check.ok, detail: check.detail };
  };
  const stating = (state: unknown): Record<string, unknown> => ({ state, findings: [] });

  // What this verifier computes, read off its own report: against a verdict that states nothing, every axis differs.
  const nothing = await verdictOf({});
  assert.equal(nothing.ok, false);
  const local = /^local (\{.*\}) ≠ platform \{\}$/.exec(nothing.detail)![1]!;
  const computed = Object.entries(JSON.parse(local) as Record<string, string>);
  assert.equal(computed.length, 6);
  const said = computed.map(([axis, state]) => `${axis}=${state}`).join(' ');
  const stated = (order: [string, string][]): Record<string, unknown> => Object.fromEntries(order.map(([axis, state]) => [axis, stating(state)]));

  // The verdict as the platform writes it — and the same verdict as a tool that re-serialised the file left it.
  assert.deepEqual(await verdictOf(stated(computed)), { ok: true, detail: said });
  assert.deepEqual(await verdictOf(stated([...computed].reverse())), { ok: true, detail: said });
  assert.deepEqual(await verdictOf(stated([...computed].sort(([a], [b]) => (a < b ? -1 : 1)))), { ok: true, detail: said });

  // The order hides nothing: one state that is another, an axis less, an axis more.
  const reversed = stated([...computed].reverse());
  const first = computed[0]![0];
  const other = await verdictOf({ ...reversed, [first]: stating('SOMETHING_ELSE') });
  assert.equal(other.ok, false);
  assert.equal(other.detail, `local ${local} ≠ platform ${local.replace(`"${first}":"${computed[0]![1]}"`, `"${first}":"SOMETHING_ELSE"`)}`,
    'both verdicts are shown in the engine\'s order, whatever order the file had');
  const less = await verdictOf(stated([...computed].reverse().slice(1)));
  assert.deepEqual([less.ok, less.detail], [false, `local ${local} ≠ platform ${local.replace(`,"${computed[5]![0]}":"${computed[5]![1]}"`, '')}`]);
  const more = await verdictOf({ zeta: stating('VALID'), 10: stating('VALID'), 9: stating('VALID'), ...reversed });
  assert.deepEqual([more.ok, more.detail], [false, `local ${local} ≠ platform ${local.slice(0, -1)},"10":"VALID","9":"VALID","zeta":"VALID"}`],
    'axes only the package has come after the engine\'s, by name — not in the order an object lists whole-number names');

  // An axis named without a state is still an axis only the package has; the sentence says so, as the maps cannot.
  const silent = await verdictOf({ note: 'for the record', ...stated(computed) });
  assert.deepEqual([silent.ok, silent.detail], [false, `local ${local} ≠ platform ${local} — the package also names "note", without a state`]);
  // One of the engine's own axes without a state: a difference, shown as it always was — the axis is not among the stated ones.
  const unstated = await verdictOf({ ...stated(computed), [first]: { findings: [] } });
  assert.deepEqual([unstated.ok, unstated.detail], [false, `local ${local} ≠ platform ${local.replace(`"${first}":"${computed[0]![1]}",`, '')}`]);
  // A state is the same only when it is the same text.
  for (const state of [null, 0, true, '', [computed[0]![1]], { state: computed[0]![1] }, computed[0]![1].toLowerCase(), `${computed[0]![1]} `]) {
    const odd = await verdictOf({ ...stated(computed), [first]: stating(state) });
    assert.deepEqual([odd.ok, odd.detail], [false, `local ${local} ≠ platform ${local.replace(`"${first}":"${computed[0]![1]}"`, `"${first}":${JSON.stringify(state)}`)}`]);
  }
  // What cannot be read is still not compared at all.
  assert.match((await verdictOf({ ...stated(computed), [first]: null })).detail, /^could not be re-evaluated — /);
  assert.match((await verdictOf(null)).detail, /^could not be re-evaluated — /);
});
