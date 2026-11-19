/**
 * Pins the decimal arithmetic, because every amount comparison in the engine
 * rests on it and a rounding artefact would surface as a false mismatch on a
 * real payment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abs, add, bps, cmp, diffString, formatDecimal, isZero, parseDecimal, sub }
  from '../src/decimal.ts';

test('the float trap this module exists to avoid', () => {
  // 0.1 + 0.2 !== 0.3 in IEEE-754. Here it must be exact.
  assert.equal(formatDecimal(add(parseDecimal('0.1'), parseDecimal('0.2'))), '0.3');
  assert.equal(cmp(add(parseDecimal('0.1'), parseDecimal('0.2')), parseDecimal('0.30')), 0);
  // The classic trade-finance case: a cent of difference must be visible.
  assert.equal(diffString('50000.10', '50000.00'), '0.10');
  assert.equal(cmp(parseDecimal('50000.10'), parseDecimal('50000.00')), 1);
});

test('mixed scales align exactly', () => {
  assert.equal(cmp(parseDecimal('50000'), parseDecimal('50000.00')), 0);
  assert.equal(cmp(parseDecimal('1.5'), parseDecimal('1.50')), 0);
  assert.equal(formatDecimal(sub(parseDecimal('50000'), parseDecimal('48000.00'))), '2000.00');
});

test('very large amounts do not lose precision', () => {
  // Beyond Number.MAX_SAFE_INTEGER once scaled — bigint handles it, double does not.
  const a = parseDecimal('999999999999999999.99');
  const b = parseDecimal('999999999999999999.98');
  assert.equal(cmp(a, b), 1);
  assert.equal(formatDecimal(sub(a, b)), '0.01');
});

test('negatives, zero and round-tripping', () => {
  assert.equal(formatDecimal(parseDecimal('-12.50')), '-12.50');
  assert.equal(formatDecimal(abs(parseDecimal('-12.50'))), '12.50');
  assert.ok(isZero(parseDecimal('0.000')));
  assert.ok(isZero(parseDecimal('-0.00')));
  for (const s of ['0', '0.00', '1', '1.5', '-1.05', '1000000.000001']) {
    assert.equal(formatDecimal(parseDecimal(s)), s, `round-trip ${s}`);
  }
});

test('malformed amounts throw instead of coercing to zero', () => {
  for (const bad of ['', ' ', 'abc', '1,000.00', '1e5', '1.2.3', '--1', '.5', '1.']) {
    assert.throws(() => parseDecimal(bad, 'amount'), /not a plain decimal|expected a decimal/,
      `${JSON.stringify(bad)} must be rejected`);
  }
  // A number would silently reintroduce float representation.
  assert.throws(() => parseDecimal(50000 as unknown as string), /expected a decimal string/);
});

test('basis points round away from zero, widening a tolerance rather than narrowing it', () => {
  // 50000.00 * 1bp = 5.00 exactly.
  assert.equal(formatDecimal(bps(parseDecimal('50000.00'), 1)), '5.00');
  // 1.00 * 1bp = 0.0001, which rounds up to 0.01 at scale 2 rather than to 0.
  assert.equal(formatDecimal(bps(parseDecimal('1.00'), 1)), '0.01');
  assert.equal(formatDecimal(bps(parseDecimal('50000.00'), 0)), '0.00');
  assert.throws(() => bps(parseDecimal('1.00'), -1), /non-negative/);
  assert.throws(() => bps(parseDecimal('1.00'), 1.5), /non-negative integer/);
});
