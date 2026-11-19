/**
 * The bill is arithmetic over the price list and the meters — tested as such,
 * without a server. The sandbox prices everything at 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyCharges } from '../src/billing.ts';
import { SANDBOX_PRICING } from '../src/config.ts';

const NOV = new Date(Date.UTC(2026, 10, 1));

test('the sandbox bills nothing, and says so line by line', () => {
  const c = monthlyCharges(SANDBOX_PRICING, { anchors: 12, settlements: 53, snapshots: 2 },
    new Set(['attest', 'remit', 'por']), NOV);
  assert.equal(c.currency, 'KRW');
  assert.equal(c.total, 0);
  assert.deepEqual(c.lines.map((l) => [l.product, l.quantity, l.amount]),
    [['remit', 53, 0], ['por', 2, 0], ['attest', 12, 0]], 'every active product is listed, at nothing');
  assert.deepEqual(c.period, { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' });
});

test('a priced plan is the monthly fee plus the metered units, for active products only', () => {
  const c = monthlyCharges({
    currency: 'USD',
    attest: { monthly_fee: 10, per_anchor: 0.5 },
    por: { monthly_fee: 500, per_snapshot: 0 },
    remit: { monthly_fee: 100, per_settlement: 2 },
  }, { anchors: 3, settlements: 53, snapshots: 9 }, new Set(['attest', 'remit']), NOV);
  assert.deepEqual(c.lines, [
    { product: 'remit', unit: 'settlement', quantity: 53, monthly_fee: 100, unit_price: 2, amount: 206 },
    { product: 'attest', unit: 'anchor', quantity: 3, monthly_fee: 10, unit_price: 0.5, amount: 11.5 },
  ], 'PoR is not subscribed, so neither its fee nor its snapshots are charged');
  assert.equal(c.total, 217.5);
});

test('amounts are rounded to the cent, and December rolls into the next year', () => {
  const c = monthlyCharges({
    currency: 'USD',
    attest: { monthly_fee: 0, per_anchor: 0.1 },
    por: { monthly_fee: 0, per_snapshot: 0 },
    remit: { monthly_fee: 0, per_settlement: 0 },
  }, { anchors: 3, settlements: 0, snapshots: 0 }, new Set(['attest']), new Date(Date.UTC(2026, 11, 1)));
  assert.equal(c.lines[0]!.amount, 0.3, '0.1 × 3 is 0.3, not 0.30000000000000004');
  assert.equal(c.period.end, '2027-01-01T00:00:00.000Z');
});

test('no active product means no lines and a total of zero, whatever the prices', () => {
  const c = monthlyCharges({
    currency: 'KRW',
    attest: { monthly_fee: 300000, per_anchor: 100 },
    por: { monthly_fee: 500000, per_snapshot: 0 },
    remit: { monthly_fee: 0, per_settlement: 1500 },
  }, { anchors: 40, settlements: 10, snapshots: 1 }, new Set(), NOV);
  assert.deepEqual(c.lines, []);
  assert.equal(c.total, 0);
});
