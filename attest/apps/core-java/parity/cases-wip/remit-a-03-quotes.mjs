/**
 * The settlement rail, quotes: `POST /v1/quotes`.
 *
 * The arithmetic is exact and done on text (apps/core/src/remit/quotes.ts): the trade amount to two places, the
 * fee added, the collection leg to whole dong, the payout leg from the amount as it was asked — so an amount of
 * three places rounds one way in one leg and is used unrounded in the other. The refusals come in one order
 * (corridor, trade currency, the two legs, the amount), which the ladder below states: a request wrong in several
 * ways is answered for the first. A quote's id and its two times are each server's own; everything else of an
 * answer is compared to the letter, the order of its members included.
 */
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-03: the settlement rail is not seeded — no cases'); return []; }
  const { O, J, key, jkey } = k;
  const cases = [];
  const Q = '/v1/quotes';
  const NEWQ = ['$.quote_id', '$.quoted_at', '$.expires_at'];
  const good = { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '1200.00' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } };
  const quote = (name, body, more = {}, o = O.rail) => cases.push({ name: `quote: ${name}`, method: 'POST', target: Q, headers: jkey(o), body, volatile: NEWQ, ...more });
  const amount = (a) => ({ ...good, trade: { currency: 'USD', amount: a } });

  quote('the corridor, a round amount', good, { expect: { '$.trade.amount': '1200.00', '$.settlement.asset': 'USDC', '$.collect.currency': 'VND', '$.payout.currency': 'SGD' } });
  quote('the same again: another id', good);
  quote('of another organisation', good, {}, O.b);
  quote('of an organisation without a webhook', good, {}, O.nohook);

  // ── amounts: what is accepted, and how each leg rounds ───────────────────────────────────────────────────────
  for (const a of ['1', '0', '0.0', '0.00', '0.004', '0.005', '0.0049', '0.015', '0.994', '0.995', '1.005', '1.0049999', '2.5', '12.345', '999.995', '1200', '1200.5', '1200.00', '1200.005',
    '00012.50', '007', '49999.99', '50000.00', '50000.01', '20000', '19999.995', '123456789.12', '999999999999999999999999999999.99',
    '0.000000000000000000000000000001', '1.10000000000000000000000000000000000001']) {
    quote(`amount ${JSON.stringify(a)}`, amount(a));
  }
  // ── amounts that are no amount ───────────────────────────────────────────────────────────────────────────────
  for (const a of ['', ' ', '1.', '.5', '-1', '+1', '1e3', '1E3', ' 1', '1 ', '1\n', '\t1', '1,000.00', '1.000,00', '1_000', '0x10', '１２', '١٢', '1.2.3', 'abc', 'NaN', 'Infinity', '1 200', '$1200', '1200 USD']) {
    quote(`amount ${JSON.stringify(a)}`, amount(a));
  }
  quote('an amount that is a whole number', { ...good, trade: { currency: 'USD', amount: 1200 } });
  quote('an amount that is a fraction as a number', { ...good, trade: { currency: 'USD', amount: 12.5 } });
  quote('an amount that is a number too large to write out', { ...good, trade: { currency: 'USD', amount: 1e21 } });
  quote('an amount that is zero as a number', { ...good, trade: { currency: 'USD', amount: 0 } });
  quote('an amount that is true', { ...good, trade: { currency: 'USD', amount: true } });
  quote('an amount that is null', { ...good, trade: { currency: 'USD', amount: null } });
  quote('an amount that is a list of one amount', { ...good, trade: { currency: 'USD', amount: ['12.50'] } });
  quote('an amount that is a list of two', { ...good, trade: { currency: 'USD', amount: ['1', '2'] } });
  quote('an amount that is an object', { ...good, trade: { currency: 'USD', amount: { value: '12.50' } } });
  quote('no amount', { ...good, trade: { currency: 'USD' } });

  // ── the refusals, one at a time ──────────────────────────────────────────────────────────────────────────────
  quote('the corridor the other way', { ...good, corridor: { origin: 'SG', destination: 'VN' } }, { expect: { '$.error': 'unsupported_corridor' } });
  quote('the corridor in lower case', { ...good, corridor: { origin: 'vn', destination: 'sg' } });
  quote('a corridor with only an origin', { ...good, corridor: { origin: 'VN' } });
  quote('a corridor with only a destination', { ...good, corridor: { destination: 'SG' } });
  quote('a corridor that is text', { ...good, corridor: 'VN-SG' });
  quote('a corridor that is a list', { ...good, corridor: ['VN', 'SG'] });
  quote('a corridor that is null', { ...good, corridor: null });
  quote('no corridor', { trade: good.trade, collect: good.collect, payout: good.payout });
  quote('a trade in euro', { ...good, trade: { currency: 'EUR', amount: '1200.00' } }, { expect: { '$.error': 'unsupported_trade_currency' } });
  quote('a trade in USDC', { ...good, trade: { currency: 'USDC', amount: '1200.00' } });
  quote('a trade currency in lower case', { ...good, trade: { currency: 'usd', amount: '1200.00' } });
  quote('a trade that is null', { ...good, trade: null });
  quote('a trade that is text', { ...good, trade: '1200.00 USD' });
  quote('no trade', { corridor: good.corridor, collect: good.collect, payout: good.payout });
  quote('collection in dollars', { ...good, collect: { currency: 'USD' } }, { expect: { '$.error': 'unsupported_leg_currency' } });
  quote('payout in dong', { ...good, payout: { currency: 'VND' } }, { expect: { '$.error': 'unsupported_leg_currency' } });
  quote('the two legs the other way round', { ...good, collect: { currency: 'SGD' }, payout: { currency: 'VND' } });
  quote('no collection leg', { corridor: good.corridor, trade: good.trade, payout: good.payout });
  quote('no payout leg', { corridor: good.corridor, trade: good.trade, collect: good.collect });
  quote('legs that are null', { ...good, collect: null, payout: null });
  quote('legs that are text', { ...good, collect: 'VND', payout: 'SGD' });

  // ── the order: a request wrong in every way from here on is answered for the first ───────────────────────────
  const wrong = [
    ['unsupported_corridor', (b) => { b.corridor = { origin: 'XX', destination: 'YY' }; }],
    ['unsupported_trade_currency', (b) => { b.trade = { ...b.trade, currency: 'EUR' }; }],
    ['unsupported_leg_currency', (b) => { b.collect = { currency: 'USD' }; b.payout = { currency: 'USD' }; }],
    ['invalid_amount', (b) => { b.trade = { ...b.trade, amount: 'a lot' }; }],
  ];
  for (let i = 0; i < wrong.length; i++) {
    const b = structuredClone(good);
    for (let j = wrong.length - 1; j >= i; j--) wrong[j][1](b);
    quote(`the order of refusals, from "${wrong[i][0]}" on`, b, { expect: { '$.error': wrong[i][0] } });
  }

  // ── more and less than is asked for ──────────────────────────────────────────────────────────────────────────
  quote('with members nobody reads', { ...good, note: 'x', beneficiary_institution: 'SG-BFI-001', trade: { currency: 'USD', amount: '77.70', more: [1, { a: null }] }, quote_id: 'QT-mine', expires_at: '2099-01-01T00:00:00.000Z' });
  quote('the members in another order', { payout: good.payout, collect: good.collect, trade: { amount: '77.70', currency: 'USD' }, corridor: { destination: 'SG', origin: 'VN' } });
  quote('a member named twice: the last one counts', '{"corridor":{"origin":"VN","destination":"SG"},"trade":{"currency":"EUR","amount":"1"},"trade":{"currency":"USD","amount":"88.80"},"collect":{"currency":"VND"},"payout":{"currency":"SGD"}}');
  quote('white space around the JSON', `\n\t ${JSON.stringify(good)} \n`);
  quote('an empty body', {});
  quote('a body that is null', 'null');
  quote('a body that is a list', '[]');
  quote('a body that is a list of a quote', JSON.stringify([good]));
  quote('a body that is text', '"VN to SG"');
  quote('a body that is a number', '1200');
  quote('a body that is true', 'true');
  quote('a body that is no JSON', '{"corridor":');
  quote('a body that is JSON and something after it', `${JSON.stringify(good)} x`);
  quote('a body with a byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(good))]));
  quote('a body that is not UTF-8', Buffer.concat([Buffer.from('{"corridor":{"origin":"VN","destination":"SG"},"trade":{"currency":"USD","amount":"1.00"},"collect":{"currency":"VND"},"payout":{"currency":"SGD"},"note":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"}')]));
  cases.push({ name: 'quote: no body at all', method: 'POST', target: Q, headers: key(O.rail) });
  cases.push({ name: 'quote: a body and no content type', method: 'POST', target: Q, headers: key(O.rail), body: JSON.stringify(good), volatile: NEWQ });
  cases.push({ name: 'quote: a body sent as a form', method: 'POST', target: Q, headers: { ...key(O.rail), 'Content-Type': 'application/x-www-form-urlencoded' }, body: JSON.stringify(good), volatile: NEWQ });
  cases.push({ name: 'quote: with a query', method: 'POST', target: `${Q}?amount=5`, headers: jkey(O.rail), body: good, volatile: NEWQ });
  cases.push({ name: 'quote: a body of one megabyte and a byte', method: 'POST', target: Q, headers: jkey(O.rail), body: JSON.stringify({ ...good, pad: 'x'.repeat((1 << 20) - 150) }).padEnd((1 << 20) + 1, ' ') });
  cases.push({ name: 'quote: a body just under one megabyte', method: 'POST', target: Q, headers: jkey(O.rail), body: JSON.stringify({ ...good, pad: 'x'.repeat((1 << 20) - 400) }), volatile: NEWQ });
  void J;
  return cases;
};
