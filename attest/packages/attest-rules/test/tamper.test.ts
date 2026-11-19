/**
 * The tamper transforms take the name of an element from a caller. These
 * tests hold them to the evidence's own members: a name every JavaScript
 * object answers to (`__proto__`, `constructor`, `toString`) is not an
 * element, and aiming a tamper at one must change nothing outside the copy
 * the transform returns — least of all `Object.prototype`, which every other
 * request in the same process reads from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_SETTLEMENT } from '../src/samples.ts';
import { breakDigest, breakSignature, changeAmount, removeDocument } from '../src/tamper.ts';

const INHERITED = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

function untouched(run: () => unknown): void {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const beforeCtor = Object.getOwnPropertyNames(Object).sort();
  try { run(); } catch { /* a refusal is the expected outcome; what matters is what was written */ }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before, 'Object.prototype gained a member');
  assert.deepEqual(Object.getOwnPropertyNames(Object).sort(), beforeCtor, 'Object gained a member');
  assert.equal(({} as { digestVerified?: boolean }).digestVerified, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype.toString).includes('digestVerified'), false);
}

test('a digest tamper aimed at a member every object inherits is refused and writes nothing', () => {
  for (const name of INHERITED) {
    untouched(() => breakDigest(SAMPLE_SETTLEMENT, name as never));
    assert.throws(() => breakDigest(SAMPLE_SETTLEMENT, name as never), new RegExp(`breakDigest: no ${name} to modify`));
  }
});

test('a signature tamper aimed at a member every object inherits is refused the same way', () => {
  for (const name of INHERITED) {
    untouched(() => breakSignature(SAMPLE_SETTLEMENT, name as never));
    assert.throws(() => breakSignature(SAMPLE_SETTLEMENT, name as never), new RegExp(`breakSignature: no ${name} to modify`));
  }
});

test('the other transforms write nothing outside their copy either', () => {
  for (const name of INHERITED) {
    untouched(() => changeAmount(SAMPLE_SETTLEMENT, name as never, '1.00'));
    untouched(() => removeDocument(SAMPLE_SETTLEMENT, name));
  }
});

test('the elements the evidence does carry are still tampered with, in the copy only', () => {
  const before = structuredClone(SAMPLE_SETTLEMENT);
  for (const target of ['chainTransfer', 'bankInstruction', 'commercialDocs', 'payoutReceipt'] as const) {
    const out = breakDigest(SAMPLE_SETTLEMENT, target);
    const item = target === 'payoutReceipt' ? out.elements.payoutReceipts?.[0] : out.elements[target];
    assert.equal(item?.digestVerified, false, target);
    assert.match(out.scenario, new RegExp(`${target} document bytes altered`));
  }
  assert.deepEqual(SAMPLE_SETTLEMENT, before, 'the fixture itself is never changed');
});

test('an element the evidence names itself, even one called __proto__, is its own and is tampered with as such', () => {
  // JSON.parse makes "__proto__" an ordinary member; such a document tampers with its own member, not with the engine's.
  const ev = JSON.parse(JSON.stringify(SAMPLE_SETTLEMENT).replace('"elements":{', '"elements":{"__proto__":{"digest":"00"},')) as typeof SAMPLE_SETTLEMENT;
  assert.ok(Object.prototype.hasOwnProperty.call(ev.elements, '__proto__'));
  untouched(() => breakDigest(ev, '__proto__' as never));
  const out = breakDigest(ev, '__proto__' as never);
  assert.equal((Object.getOwnPropertyDescriptor(out.elements, '__proto__')?.value as { digestVerified?: boolean }).digestVerified, false);
});
