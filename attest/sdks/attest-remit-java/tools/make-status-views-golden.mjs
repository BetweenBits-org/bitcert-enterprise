/**
 * Writes the vectors that hold the Java status report to the reference for
 * views nobody would send on purpose: any JSON at all as a settlement view.
 *
 *   node sdks/attest-remit-java/tools/make-status-views-golden.mjs          write src/test/resources/golden/status-views.json
 *   node sdks/attest-remit-java/tools/make-status-views-golden.mjs --check  fail when the file on disk differs
 *
 * `status.json` (tools/make-golden.mjs) holds the situations a settlement can
 * be in. This file holds the rest: the views the reference SDK's own
 * hardening test (`packages/attest-remit/test/hardening-status.test.ts`) puts
 * to `swiftStatusOf`, `sourceMessageOf` and `buildPacs002` — values of the
 * wrong kind in every place, half surrogate pairs, times in every wrong form,
 * sequence numbers that are no numbers — and the views that test generates
 * from a fixed seed, here with what the reference answers for each.
 *
 * A view is stored as JSON holds it (what `JSON.stringify` drops or changes is
 * dropped or changed before the reference sees it, so both SDKs are handed
 * the same value). `options.createdAt` that is not a time in the platform's
 * form makes the report state when it was made: `expect.pacs002` then has
 * `<now>` where that time stands, and so has what the Java test compares.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPacs002, sourceMessageOf, swiftStatusOf } from '../../../packages/attest-remit/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/golden/status-views.json');
const check = process.argv.includes('--check');

const UETR_4 = '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10';
const T0 = '2026-11-17T00:00:00.000Z';
const SMILE = '\u{1F600}';
const time = (seq) => `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`;
const ev = (seq, type, payload = {}, at = time(seq)) => ({ seq, type, issuer: 'X', at, payload });
const evidence = (source = {}, at = T0) => ev(0, 'BANK_EVIDENCE_SUBMITTED', {
  bankInstruction: { sourceMessage: {
    type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: 'M-1', instructionId: 'I-1', endToEndId: 'E-1', uetr: UETR_4, ...source,
  } },
}, at);
const viewOf = (state, events, paymentId = 'PAY-1') => ({ payment_id: paymentId, state, events });

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const cases = [];
const names = new Set();
function add(name, view, options = { createdAt: T0 }) {
  if (names.has(name)) throw new Error(`two cases are named ${name}`);
  names.add(name);
  // The view and the options as JSON holds them: both SDKs are handed exactly this.
  const stored = JSON.parse(JSON.stringify({ view: view === undefined ? null : view, options }));
  const v = stored.view;
  const o = stored.options;
  const status = swiftStatusOf(v);
  const source = sourceMessageOf(v) ?? null;
  let report = buildPacs002(v, o);
  // A creation time the reference does not use is "now": not something two runs agree on.
  const created = /<CreDtTm>([^<]*)<\/CreDtTm>/.exec(report)[1];
  const given = typeof o.createdAt === 'string' && ISO_TIME.test(o.createdAt) && created === o.createdAt;
  if (!given) report = report.replace(`<CreDtTm>${created}</CreDtTm>`, '<CreDtTm><now></CreDtTm>');
  cases.push({ name, view: v, options: o, expect: { status: JSON.parse(JSON.stringify(status)), sourceMessage: source, pacs002: report } });
}

// ── A question asked again; a UETR the schema does not take ─────────────────

const first = ev(1, 'TRAVEL_RULE_RFI', { questions: ['First?'] });
const again = (seq) => ev(seq, 'TRAVEL_RULE_RFI', { questions: ['Again?'] });
add('S1 asked, answered, accepted, and asked again', viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, 'TRAVEL_RULE_RFI_RESOLVED'), ev(3, 'TRAVEL_RULE_RECEIVED'), again(4)]));
for (const closing of ['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_REJECTED']) {
  add(`S1 closed by ${closing}`, viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, closing)]));
  add(`S1 closed by ${closing} and asked again`, viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, closing), again(3)]));
}
add('S1 two questions in a row', viewOf('TRAVEL_RULE_PENDING', [evidence(), first, again(2)]));
add('S1 an event that answers nothing', viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, 'WEBHOOK_DELIVERED')]));
for (const uetr of ['a8098c1a-f86e-11da-bd1a-00112444be1e', '3f1c9a52-7b0e-5d6a-9c1f-2e8b5a7d4c10', '3F1C9A52-7B0E-4D6A-9C1F-2E8B5A7D4C10',
  '3f1c9a52-7b0e-4d6a-cc1f-2e8b5a7d4c10', 'not-a-uuid', ` ${UETR_4}\t`, `${UETR_4}\n`]) {
  add(`S2 UETR ${JSON.stringify(uetr)}`, viewOf('BANK_AUTHORIZED', [evidence({ uetr })]));
}
add('S2 a long UETR after a question', viewOf('TRAVEL_RULE_PENDING', [evidence({ uetr: 'u'.repeat(150) }), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?'] })]));

// ── The message id ──────────────────────────────────────────────────────────

const withSeq = (seq, paymentId = 'PAY-1') => viewOf('BANK_AUTHORIZED', [{ ...evidence(), seq }], paymentId);
for (const seq of [null, { a: 1 }, { toString: 'x' }, [1, 2], '7', 'x', true, -1, 1.5, 1e21, 2 ** 53, -0, 7, 2 ** 53 - 1, 12_345_678]) {
  add(`S3 sequence ${JSON.stringify(seq)}`, withSeq(seq));
}
add('S3 no sequence number', viewOf('BANK_AUTHORIZED', [{ type: 'BANK_EVIDENCE_SUBMITTED', at: T0, payload: {} }]));
add('S3 a given message id that is empty', withSeq('x'), { messageId: '', createdAt: T0 });
add('S3 a given message id that is empty once cleaned', withSeq(12), { messageId: ' \u0001\t ', createdAt: T0 });
add('S3 a given message id that is too long and untidy', withSeq(1, `PAY-${'0123456789'.repeat(4)}`), { messageId: `  BANK   STATUS\t${'Z'.repeat(40)}`, createdAt: T0 });
for (const paymentId of ['', ' \u0001 ', 5, null, ['PAY-1'], { toString: 1 }]) {
  add(`S3 payment id ${JSON.stringify(paymentId)}`, withSeq(3, paymentId));
}
const long = `PAY-${'0123456789'.repeat(4)}`;
add('S3 a payment id cleaned before it is measured', withSeq(0, ' PAY\u0001-1\u{a0}\u{2028} two\ttabs '));
add('S3 a long payment id', withSeq(7, long));
add('S3 a long payment id and a long number', withSeq(12_345_678, long));
add('S3 a long payment id and the largest number', withSeq(2 ** 53 - 1, long));
add('S3 a payment id of words', withSeq(1, `PAY ${'x '.repeat(20)}`));
add('S3 a payment id of exactly 33 characters', withSeq(7, 'P'.repeat(33)));
add('S3 a payment id of exactly 34 characters', withSeq(7, 'P'.repeat(34)));

// ── The group, the identifiers, code points ─────────────────────────────────

for (const type of ['', ' ', '\u0001\u0002', '\t\n', ' MT103 ']) add(`S4 message type ${JSON.stringify(type)}`, viewOf('BANK_AUTHORIZED', [evidence({ type })]));
add('S4 a message id that is empty once cleaned', viewOf('BANK_AUTHORIZED', [evidence({ messageId: '\u0001' })]));
for (const paymentId of ['  ', '\u0001\u0002', {}, []]) add(`S4 payment id ${JSON.stringify(paymentId)}`, { payment_id: paymentId, state: 'BANK_AUTHORIZED', events: [evidence()] });
add('S4 no payment id', { state: 'BANK_AUTHORIZED', events: [evidence()] });
add('S5 a payment id cut inside a pair', viewOf('BANK_AUTHORIZED', [{ ...evidence(), seq: 12 }], `PAY-${'x'.repeat(23)}${SMILE}${'y'.repeat(10)}`));
add('S5 a question with a pair across the 105th character', viewOf('TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [`${'u'.repeat(104)}${SMILE}${'v'.repeat(10)}`] })]));
add('S5 a reference of 35 characters outside the basic plane', viewOf('EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: SMILE.repeat(35) })]));
add('S5 a reference of 36 characters outside the basic plane', viewOf('EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: SMILE.repeat(36) })]));
add('S5 halves of pairs', viewOf('EVIDENCE_ANCHORED', [
  evidence({ instructionId: 'I-\uD800', endToEndId: '\uDC00' }), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R-\uD83D\u0001\uDE00' }), ev(2, 'X'),
], 'PAY-\uDBFF1'));
add('S5 questions of two thousand characters', viewOf('TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [SMILE.repeat(1000), 'word '.repeat(400), `${'n'.repeat(59)} ${'m'.repeat(300)}`, `${'n'.repeat(60)} ${'m'.repeat(44)} tail`, `${'n'.repeat(105)} tail`, `${'n'.repeat(104)} tail`] })]));

// ── Times; unknown states ───────────────────────────────────────────────────

add('S6 credited without a payout event', viewOf('BENEFICIARY_CREDIT_CONFIRMED', [evidence(), ev(1, 'SOMETHING_ELSE')]));
add('S6 a payout event without a time', viewOf('EVIDENCE_ANCHORED', [evidence(), { seq: 1, type: 'PAYOUT_COMPLETED', issuer: 'X', payload: { bank_reference: 'R' } }, ev(2, 'EVIDENCE_ANCHORED')]));
[
  ['CANCELLED', [evidence(), ev(1, 'SOMETHING_ELSE')]],
  ['CANCELLED', [evidence(), ev(1, 'CANCEL_REQUESTED', { reason: 'customer' }, ''), ev(2, 'X')]],
  ['EXCEPTION', [evidence(), ev(1, 'SOMETHING_ELSE')]],
  ['RETURNED', [evidence(), ev(1, 'SOMETHING_ELSE')]],
  ['RETURNED', [evidence(), ev(1, 'PAYOUT_FAILED', { reason: 'closed' }), ev(2, 'USDC_RETURNED', { tx_hash: '0xabc' }, null), ev(3, 'X')]],
  ['TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?'] }, null), ev(2, 'X')]],
  ['PAYOUT_IN_PROGRESS', [evidence(), ev(1, 'PAYOUT_FAILED', {}, null), ev(2, 'X')]],
  ['PAYOUT_IN_PROGRESS', [evidence(), ev(1, 'EVIDENCE_INSUFFICIENT', {}, 5), ev(2, 'X')]],
  ['EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R' }), ev(2, 'EVIDENCE_ANCHORED')]],
  ['RETURNED', [evidence(), ev(1, 'PAYOUT_FAILED'), ev(2, 'USDC_RETURNED'), ev(3, 'X')]],
  ['ONCHAIN_SETTLED', [evidence(), ev(1, 'X')]],
].forEach(([state, events], i) => add(`S6 ${i}: ${state} with ${events.map((e) => e.type).join(', ')}`, viewOf(state, events)));
for (const state of ['  A  VERY   LONG STATE NAME WITH SPACES THAT GOES ON AND ON ', 'bank_authorized', '\u0001NEW\u0002STATE\t', SMILE.repeat(40),
  `${'X'.repeat(34)}${SMILE}${SMILE}`, 'constructor', '__proto__', '\u0001\u0002', '', 'UNKNOWN']) {
  add(`S7 state ${JSON.stringify(state)}`, viewOf(state, [evidence()]));
}
for (const t of ['yesterday', '', '2026-11-17', '2026-11-17 00:00:00Z', '2026-11-17T00:00:00', '2026-11-17T00:00Z', '2026-13-01T00:00:00Z',
  '2026-00-10T00:00:00Z', '2026-02-29T00:00:00Z', '2026-11-31T00:00:00Z', '2026-11-00T00:00:00Z', '2026-11-17T24:00:00Z', '2026-11-17T23:60:00Z',
  '2026-11-17T23:59:60Z', '2026-11-17T00:00:00+15:00', '2026-11-17T00:00:00+14:30', '2026-11-17T00:00:00+05:60', '2026-11-17T00:00:00+0700',
  '0000-01-01T00:00:00Z', ' 2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z\n', '2026-11-17T00:00:00.Z', '2026-11-17t00:00:00z', '+2026-11-17T00:00:00Z',
  '\u{ff12}026-11-17T00:00:00Z', T0, '2026-11-17T00:00:00Z', '2026-11-17T09:30:00.123456+07:00', '2024-02-29T23:59:59Z', '2000-02-29T00:00:00-14:00',
  '2100-02-29T00:00:00Z', '2026-11-17T00:00:00+14:00', '2026-11-17T00:00:00-00:00', '0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999999Z']) {
  add(`S10 time ${JSON.stringify(t)}`, viewOf('EVIDENCE_ANCHORED', [evidence({}, t), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R' }, t)]));
}
for (const createdAt of ['', 'T', ' <T>&\u0001\t"\' ', '2026-11-17', '2026-11-17T25:00:00Z', '2026-11-17T09:30:00+07:00', 5, null, {}, [T0]]) {
  add(`S10 creation time ${JSON.stringify(createdAt)}`, viewOf('BANK_AUTHORIZED', [evidence()]), { createdAt });
}
add('S10 no creation time given', viewOf('BANK_AUTHORIZED', [evidence()]), {});

// ── Any JSON gives a status and a report ────────────────────────────────────

const good = (over = {}) => ({ payment_id: 'PAY-1', state: 'BANK_AUTHORIZED', events: [evidence()], ...over });
[
  ['a view that is null', null], ['a view that is a list', [good()]], ['a view that is text', 'PAY-1'], ['a view that is a number', 7],
  ['a view that is true', true], ['a view that is an empty object', {}],
  ['events that are text', good({ events: 'abc' })], ['events that are a number', good({ events: 5 })],
  ['events that are an object', good({ events: { 0: evidence() } })], ['events that are null', good({ events: null })],
  ['an event that is null', good({ events: [null] })], ['an event that is text', good({ events: ['x'] })],
  ['an event that is a list', good({ state: 'ONCHAIN_SETTLED', events: [evidence(), [1]] })], ['an event that is a number', good({ events: [5] })],
  ['a null event where the state looks back', good({ state: 'EXCEPTION', events: [ev(0, 'REQUEST_ACCEPTED'), null] })],
  ['a null event before the question', good({ state: 'TRAVEL_RULE_PENDING', events: [ev(0, 'REQUEST_ACCEPTED'), null, ev(2, 'TRAVEL_RULE_RFI', { questions: ['Why?'] })] })],
  ['an event whose type is not text', good({ state: 'EXCEPTION', events: [evidence(), { ...ev(1, 'X'), type: ['EXCEPTION'] }] })],
  ['a state that is a number', good({ state: 5 })], ['a state that is null', good({ state: null })],
  ['a state that is a list', good({ state: ['BANK_AUTHORIZED'] })], ['a state that is an object', good({ state: { toString: 'x' } })],
  ['a state that is not there', { payment_id: 'PAY-1', events: [evidence()] }],
  ['a payment id that is a number', good({ payment_id: 5 })], ['a payment id that is null', good({ payment_id: null })],
  ['a payment id that cannot be made text', good({ payment_id: { toString: 1 } })], ['a payment id that is a list', good({ payment_id: ['a', 'b'] })],
  ['a time that is a number', good({ state: 'EVIDENCE_ANCHORED', events: [evidence(), ev(1, 'PAYOUT_COMPLETED', {}, 5)] })],
  ['times that are an object and true', good({ state: 'EVIDENCE_ANCHORED', events: [evidence({}, { t: 1 }), ev(1, 'PAYOUT_COMPLETED', {}, true)] })],
  ['questions that cannot be made text', good({ state: 'TRAVEL_RULE_PENDING',
    events: [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?', { toString: 1 }, [{ valueOf: 1, toString: 2 }]] })] })],
  ['questions of every kind', good({ state: 'TRAVEL_RULE_PENDING',
    events: [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [{}, [1], null, 'Why?', 3, false, true, 0, -0, 1.5, 1e21, 1e-7, 0.1, 123456789012345680000, { toString: 1 }] })] })],
  ['questions that are text, not a list', good({ state: 'TRAVEL_RULE_PENDING', events: [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: 'Why?' })] })],
  ['a sequence number that cannot be made text', good({ events: [{ ...evidence(), seq: { toString: 'x' } }] })],
  ['a payload that is text', good({ state: 'PAYOUT_IN_PROGRESS', events: [evidence(), ev(1, 'PAYOUT_FAILED', 'closed account')] })],
  ['a payload that is null', good({ state: 'CANCELLED', events: [evidence(), ev(1, 'CANCEL_REQUESTED', null)] })],
  ['an instruction that is a list', good({ events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: [{ sourceMessage: {} }] })] })],
  ['a payload named after Object.prototype', good({ events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', JSON.parse('{"__proto__":{"bankInstruction":{}}}'))] })],
  ['a reference behind entries that are not events', viewOf('BANK_AUTHORIZED', [null, 'x', evidence()])],
  ['events that are not a list, cancelled', viewOf('CANCELLED', 'abc')],
  ['an index that is a number, a fraction and text', viewOf('BANK_AUTHORIZED', [evidence({ index: 2 }), evidence({ index: 1.5 }), evidence({ index: '2' })])],
  ['an index that is a fraction', viewOf('BANK_AUTHORIZED', [evidence({ index: 1.5 })])],
  ['an index beyond every number', JSON.parse(`{"payment_id":"PAY-1","state":"BANK_AUTHORIZED","events":[{"seq":0,"type":"BANK_EVIDENCE_SUBMITTED","at":"${T0}","payload":{"bankInstruction":{"sourceMessage":{"type":"MT103","sha256":"b","index":1e999}}}}]}`)],
  ['a source without a digest', viewOf('BANK_AUTHORIZED', [ev(0, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: { sourceMessage: { type: 'MT103', messageId: 'M' } } })])],
  ['a source whose references are of every kind', viewOf('BANK_AUTHORIZED', [evidence({ messageId: 5, instructionId: null, paymentInfoId: 'P-1', endToEndId: '', uetr: ['x'], valueDate: '2026-11-17', content: 'c'.repeat(64) })])],
].forEach(([what, view]) => add(`S9 ${what}`, view));

// ── The views the reference's own test generates, from its seed ─────────────

{
  let seed = 0x2545f491;
  const rnd = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const pick = (xs) => xs[rnd(xs.length)];
  const texts = ['', ' ', '\u0001', 'M-1', 'x'.repeat(40), `${'y'.repeat(34)}${SMILE}`, '\uD800', 'a\uDC00b', '<&>"\'', ' two  words\t',
    UETR_4, 'A8098C1A-F86E-11DA-BD1A-00112444BE1E', 'word '.repeat(50)];
  const values = [...texts, null, undefined, 0, -0, 7, 1.5, 1e21, true, [], ['x'], {}, { toString: 1 }];
  const times = [T0, '2026-11-17T09:30:00+07:00', 'yesterday', '', '2026-02-30T00:00:00Z', 5, null, undefined, {}];
  const types = ['BANK_EVIDENCE_SUBMITTED', 'REQUEST_ACCEPTED', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED',
    'TRAVEL_RULE_REJECTED', 'PAYOUT_FAILED', 'EVIDENCE_INSUFFICIENT', 'PAYOUT_COMPLETED', 'CANCEL_REQUESTED', 'USDC_RETURNED', 'EXCEPTION', 'X'];
  const states = ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED',
    'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED', 'CANCELLED', 'RETURNED', 'EXCEPTION', ...values];
  const event = () => {
    if (rnd(8) === 0) return pick(values);
    const type = pick(types);
    const payload = type === 'BANK_EVIDENCE_SUBMITTED'
      ? { bankInstruction: { sourceMessage: {
        type: pick(['pacs.008.001.08', 'MT103', ...values]), sha256: pick(['a'.repeat(64), ...values]), messageId: pick(values),
        instructionId: pick(values), endToEndId: pick(values), uetr: pick(values), index: pick(values),
      } } }
      : { questions: rnd(2) ? [pick(values), pick(values)] : pick(values), reason: pick(values), error: pick(values),
        bank_reference: pick(values), tx_hash: pick(values) };
    return { seq: pick([0, 1, 2, 12_345_678, ...values]), type, issuer: 'X', at: pick(times), payload: rnd(10) ? payload : pick(values) };
  };
  // The same sequence of choices as the reference's test makes; the first of its views are kept.
  for (let i = 0; i < 300; i++) {
    const view = rnd(20)
      ? { payment_id: pick(values), state: pick(states), events: rnd(15) ? Array.from({ length: rnd(6) }, event) : pick(values) }
      : pick(values);
    const opts = rnd(4) ? { createdAt: T0 } : { messageId: pick(texts), createdAt: pick(times) };
    add(`generated view ${i}`, view, opts);
  }
}

// ── Write, or compare ──────────────────────────────────────────────────────

const text = `${JSON.stringify({
  note: 'Generated by tools/make-status-views-golden.mjs from the reference SDK. Do not edit by hand.',
  cases,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('status-views.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`status-views.json is current (${cases.length} cases)`);
} else {
  writeFileSync(OUT, text);
  const codes = new Map();
  for (const c of cases) codes.set(`${c.expect.status.code}/${c.expect.status.reason ?? ''}`, (codes.get(`${c.expect.status.code}/${c.expect.status.reason ?? ''}`) ?? 0) + 1);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${cases.length} cases, ${(text.length / 1000).toFixed(0)} kB`);
  console.log(`  with a source reference: ${cases.filter((c) => c.expect.sourceMessage).length}; reports stating "now": ${cases.filter((c) => c.expect.pacs002.includes('<now>')).length}`);
  console.log(`  ${codes.size} code/reason pairs, e.g. ${[...codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k}×${n}`).join(' ')}`);
}
