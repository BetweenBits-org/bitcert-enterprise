/**
 * The way back, read from views nobody had tried — found by porting the
 * status report to Java and testing the reference with them. Each test pins
 * one fix: a status that named another event's time, dropped a reference or
 * a question, disagreed with its own report, or crashed on a view of the
 * wrong shape is now given correctly. And every report the module can produce
 * keeps to the pacs.002.001.10 schema, checked here by its rules: element
 * order, Max35Text and Max105Text counted by character, the date-time and
 * UUID forms, no empty element, no half of a surrogate pair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, findFirst, textAt } from '../src/swift/xml.ts';
import type { XmlElement } from '../src/swift/xml.ts';
import { buildPacs002, sourceMessageOf, swiftStatusOf } from '../src/index.ts';
import type { Pacs002Options, StatusView } from '../src/index.ts';

const UETR_4 = '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10';
const T0 = '2026-11-17T00:00:00.000Z';
const SMILE = '\u{1F600}';
const time = (seq: number): string => `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`;
const ev = (seq: number, type: string, payload: unknown = {}, at: unknown = time(seq)): Record<string, unknown> =>
  ({ seq, type, issuer: 'X', at, payload });
/** The bank's evidence a view of a payment from a SWIFT message starts with. */
const evidence = (source: Record<string, unknown> = {}, at: unknown = T0): Record<string, unknown> => ev(0, 'BANK_EVIDENCE_SUBMITTED', {
  bankInstruction: { sourceMessage: {
    type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: 'M-1', instructionId: 'I-1', endToEndId: 'E-1', uetr: UETR_4, ...source,
  } },
}, at);
/** A view as the platform sends it — or as it never should: any JSON at all. */
const viewOf = (state: unknown, events: unknown, paymentId: unknown = 'PAY-1'): StatusView =>
  ({ payment_id: paymentId, state, events }) as unknown as StatusView;
const report = (view: unknown, opts: Pacs002Options = { createdAt: T0 }): string => buildPacs002(view as StatusView, opts);
const txOf = (xml: string): XmlElement => findFirst(parseXml(xml), 'TxInfAndSts')!;
const names = (el: XmlElement | undefined): string[] => (el ? el.children.map((c) => c.name) : []);
/** The AddtlInf lines of a report, exactly as written. */
const addtl = (tx: XmlElement): string[] => (findFirst(tx, 'StsRsnInf')?.children ?? []).filter((c) => c.name === 'AddtlInf').map((c) => c.text);
const msgId = (xml: string): string => findFirst(parseXml(xml), 'MsgId')!.text;
const codePoints = (s: string): number => [...s].length;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The children of TxInfAndSts this module can write, in the order PaymentTransaction110 sets them out. */
const TX_ORDER = ['StsId', 'OrgnlGrpInf', 'OrgnlInstrId', 'OrgnlEndToEndId', 'OrgnlUETR', 'TxSts', 'StsRsnInf', 'AccptncDtTm', 'FctvIntrBkSttlmDt', 'AcctSvcrRef'];
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** An xs:dateTime in the form the platform writes, on a day the calendar has. */
function isDateTime(t: string): boolean {
  const m = DATE_TIME.exec(t);
  if (!m) return false;
  const n = (i: number): number => Number(m[i] ?? 0);
  const day = new Date(0);
  day.setUTCFullYear(n(1), n(2) - 1, n(3));
  return n(1) >= 1 && day.getUTCFullYear() === n(1) && day.getUTCMonth() === n(2) - 1 && day.getUTCDate() === n(3)
    && n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(8) <= 59 && n(7) * 60 + n(8) <= 14 * 60;
}

/** Max35Text, Max105Text: 1 to `n` characters, counted as the schema counts them. */
function assertText(el: XmlElement | undefined, n: number, where: string): void {
  assert.ok(el, `${where}: present`);
  const length = codePoints(el.text);
  assert.ok(length >= 1 && length <= n, `${where}: ${length} characters where Max${n}Text allows 1 to ${n}`);
}

/** The schema's rules, applied to what this module writes. */
function assertSchemaValid(xml: string, label: string): void {
  assert.doesNotMatch(xml, LONE, `${label}: half of a surrogate pair`);
  assert.doesNotMatch(xml, /<(\w+)><\/\1>/, `${label}: an empty element`);
  const doc = parseXml(xml); // well formed: the reader refuses every character XML does not allow
  assert.equal(doc.ns, 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10', label);
  assert.deepEqual(names(doc), ['FIToFIPmtStsRpt'], label);
  const rpt = doc.children[0]!;
  assert.deepEqual(names(rpt), ['GrpHdr', 'TxInfAndSts'], label);
  const [hdr, tx] = rpt.children as [XmlElement, XmlElement];
  assert.deepEqual(names(hdr), ['MsgId', 'CreDtTm'], label);
  assertText(hdr.children[0], 35, `${label}: MsgId`);
  assert.ok(isDateTime(hdr.children[1]!.text), `${label}: CreDtTm "${hdr.children[1]!.text}"`);
  const order = names(tx).map((name) => TX_ORDER.indexOf(name));
  assert.ok(order.every((i, k) => i !== -1 && (k === 0 || i > order[k - 1]!)), `${label}: TxInfAndSts out of order: ${names(tx).join(', ')}`);
  assert.ok(names(tx).includes('TxSts'), `${label}: TxSts`);
  for (const c of tx.children) {
    const where = `${label}: ${c.name}`;
    switch (c.name) {
      case 'StsId': case 'OrgnlInstrId': case 'OrgnlEndToEndId': case 'AcctSvcrRef':
        assertText(c, 35, where);
        break;
      case 'OrgnlGrpInf':
        assert.deepEqual(names(c), ['OrgnlMsgId', 'OrgnlMsgNmId'], where);
        for (const g of c.children) assertText(g, 35, `${where}/${g.name}`);
        break;
      case 'OrgnlUETR':
        assert.match(c.text, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, where);
        break;
      case 'TxSts':
        assert.match(c.text, /^(ACTC|ACSP|ACCC|PDNG|RJCT)$/, where);
        break;
      case 'StsRsnInf': {
        const inner = names(c);
        assert.ok(inner.length > 0 && inner.every((name, k) => (name === 'Rsn' ? k === 0 : name === 'AddtlInf')), `${where}: ${inner.join(', ')}`);
        for (const r of c.children) {
          if (r.name === 'AddtlInf') { assertText(r, 105, `${where}/AddtlInf`); continue; }
          assert.deepEqual(names(r), ['Prtry'], where);
          assertText(r.children[0], 35, `${where}/Rsn/Prtry`);
        }
        break;
      }
      case 'AccptncDtTm':
        assert.ok(isDateTime(c.text), `${where} "${c.text}"`);
        break;
      case 'FctvIntrBkSttlmDt':
        assert.deepEqual(names(c), ['DtTm'], where);
        assert.ok(isDateTime(c.children[0]!.text), `${where}/DtTm "${c.children[0]!.text}"`);
        break;
    }
  }
}

test('S1 status: a question asked after an earlier answer is open — PDNG/RFI with the question, waiting on the bank', () => {
  const first = ev(1, 'TRAVEL_RULE_RFI', { questions: ['First?'] });
  const again = (seq: number): Record<string, unknown> => ev(seq, 'TRAVEL_RULE_RFI', { questions: ['Again?'] });
  // The platform's own order: asked, answered, accepted — and asked again.
  const v = viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, 'TRAVEL_RULE_RFI_RESOLVED'), ev(3, 'TRAVEL_RULE_RECEIVED'), again(4)]);
  const s = swiftStatusOf(v);
  assert.deepEqual([s.code, s.reason, s.detail, s.needs, s.at], ['PDNG', 'RFI', ['Again?'], 'bank_answer', time(4)]);
  const xml = report(v);
  assertSchemaValid(xml, 'asked again');
  assert.equal(textAt(txOf(xml), 'StsRsnInf/Rsn/Prtry'), 'RFI');
  assert.deepEqual(addtl(txOf(xml)), ['Again?']);
  // Each of the three closes the question asked before it — and only that one.
  for (const closing of ['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_REJECTED']) {
    const answered = swiftStatusOf(viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, closing)]));
    assert.deepEqual([answered.reason, answered.detail, answered.needs], ['TRAVEL_RULE_PENDING', [], undefined], closing);
    const reopened = swiftStatusOf(viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, closing), again(3)]));
    assert.deepEqual([reopened.reason, reopened.detail, reopened.needs], ['RFI', ['Again?'], 'bank_answer'], closing);
  }
  // Two questions in a row: the last one is the one waiting.
  const twice = swiftStatusOf(viewOf('TRAVEL_RULE_PENDING', [evidence(), first, again(2)]));
  assert.deepEqual([twice.detail, twice.needs], [['Again?'], 'bank_answer']);
  // An event that neither answers nor settles the exchange leaves the question open.
  const other = swiftStatusOf(viewOf('TRAVEL_RULE_PENDING', [evidence(), first, ev(2, 'WEBHOOK_DELIVERED')]));
  assert.deepEqual([other.reason, other.detail, other.needs], ['RFI', ['First?'], 'bank_answer']);
});

test('S2 status: a UETR the schema\'s pattern does not take is named in words, never left out of the report', () => {
  for (const uetr of [
    'a8098c1a-f86e-11da-bd1a-00112444be1e', // version 1
    '3f1c9a52-7b0e-5d6a-9c1f-2e8b5a7d4c10', // version 5
    '3F1C9A52-7B0E-4D6A-9C1F-2E8B5A7D4C10', // capitals
    '3f1c9a52-7b0e-4d6a-cc1f-2e8b5a7d4c10', // another variant
    'not-a-uuid',
  ]) {
    const xml = report(viewOf('BANK_AUTHORIZED', [evidence({ uetr })]));
    assertSchemaValid(xml, uetr);
    const tx = txOf(xml);
    assert.equal(textAt(tx, 'OrgnlUETR'), undefined, uetr);
    assert.deepEqual(addtl(tx), [`UETR ${uetr}`], uetr);
  }
  // A version-4 UUID stands in its own element, and only there.
  const tx = txOf(report(viewOf('BANK_AUTHORIZED', [evidence()])));
  assert.equal(textAt(tx, 'OrgnlUETR'), UETR_4);
  assert.equal(findFirst(tx, 'StsRsnInf'), undefined);
  // In words after the status's own detail; one too long for a line is split to fit AddtlInf.
  const long = 'u'.repeat(150);
  const lx = report(viewOf('TRAVEL_RULE_PENDING', [evidence({ uetr: long }), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?'] })]));
  assertSchemaValid(lx, 'a long UETR');
  assert.deepEqual(addtl(txOf(lx)), ['Why?', `UETR ${'u'.repeat(100)}`, 'u'.repeat(50)]);
});

test('S3 status: the message id is always tidy Max35Text — a sequence number that is not a whole number from 0 counts as 0', () => {
  const withSeq = (seq: unknown, paymentId: unknown = 'PAY-1'): StatusView => viewOf('BANK_AUTHORIZED', [{ ...evidence(), seq }], paymentId);
  for (const seq of [undefined, null, { a: 1 }, { toString: 'x' }, [1, 2], '7', 'x', true, -1, 1.5, 1e21, 2 ** 53, -0]) {
    const xml = report(withSeq(seq));
    assertSchemaValid(xml, String(JSON.stringify(seq)));
    assert.equal(msgId(xml), 'PAY-1-0', String(JSON.stringify(seq)));
  }
  assert.equal(msgId(report(withSeq(7))), 'PAY-1-7');
  assert.equal(msgId(report(withSeq(2 ** 53 - 1))), `PAY-1-${2 ** 53 - 1}`);
  // The fallback is tidy and fits too: for a given id that is empty once cleaned, and where no payment id names the report.
  assert.equal(msgId(report(withSeq('x  '.repeat(30)), { messageId: '', createdAt: T0 })), 'STATUS-0');
  assert.equal(msgId(report(withSeq(12), { messageId: ' \u0001\t ', createdAt: T0 })), 'STATUS-12');
  for (const paymentId of ['', ' \u0001 ', 5, null, ['PAY-1'], { toString: 1 }]) {
    assert.equal(msgId(report(withSeq(3, paymentId))), 'STATUS-3', String(JSON.stringify(paymentId)));
  }
  // The payment id is cleaned before it is measured; a long one gives way to the number, which stays whole.
  assert.equal(msgId(report(withSeq(0, ' PAY\u0001-1\u{a0}\u{2028} two\ttabs '))), 'PAY-1 two tabs-0');
  const long = `PAY-${'0123456789'.repeat(4)}`;
  assert.equal(msgId(report(withSeq(7, long))), `${long.slice(0, 28)}-7`);
  const big = msgId(report(withSeq(12_345_678, long)));
  assert.deepEqual([big, codePoints(big)], [`${long.slice(0, 26)}-12345678`, 35]);
  for (const id of [
    msgId(report(withSeq(2 ** 53 - 1, long))),
    msgId(report(withSeq(1, `PAY ${'x '.repeat(20)}`))),
    msgId(report(withSeq(1, long), { messageId: `  BANK   STATUS\t${'Z'.repeat(40)}`, createdAt: T0 })),
  ]) {
    assert.ok(codePoints(id) >= 1 && codePoints(id) <= 35 && !/^\s|\s$|\s\s|[\t\n\r]/.test(id), JSON.stringify(id));
  }
});

test('S4 status: OrgnlGrpInf is written with both of its elements or not at all, and no element is ever written empty', () => {
  const ungrouped = ['StsId', 'OrgnlInstrId', 'OrgnlEndToEndId', 'OrgnlUETR', 'TxSts', 'AccptncDtTm'];
  for (const type of ['', ' ', '\u0001\u0002', '\t\n']) {
    const xml = report(viewOf('BANK_AUTHORIZED', [evidence({ type })]));
    assertSchemaValid(xml, JSON.stringify(type));
    assert.deepEqual(names(txOf(xml)), ungrouped, JSON.stringify(type));
  }
  // The same when it is the message id that is missing.
  assert.deepEqual(names(txOf(report(viewOf('BANK_AUTHORIZED', [evidence({ messageId: '\u0001' })])))), ungrouped);
  // The group, whole, when both are there — each cleaned.
  const both = txOf(report(viewOf('BANK_AUTHORIZED', [evidence({ type: ' MT103 ' })])));
  assert.deepEqual(names(findFirst(both, 'OrgnlGrpInf')), ['OrgnlMsgId', 'OrgnlMsgNmId']);
  assert.deepEqual([textAt(both, 'OrgnlGrpInf/OrgnlMsgId'), findFirst(both, 'OrgnlMsgNmId')!.text], ['M-1', 'MT103']);
  // StsId: a payment id that is empty once cleaned, not text, or not there is left out — never written empty.
  const noId: Record<string, unknown> = { state: 'BANK_AUTHORIZED', events: [evidence()] };
  for (const view of [...['', '  ', '\u0001\u0002', 5, null, {}, []].map((paymentId) => ({ ...noId, payment_id: paymentId })), noId]) {
    const xml = report(view);
    const label = String(JSON.stringify(view.payment_id));
    assertSchemaValid(xml, label);
    assert.equal(findFirst(txOf(xml), 'StsId'), undefined, label);
    assert.equal(msgId(xml), 'STATUS-0', label);
  }
});

test('S5 status: text is measured and cut by code point, and half of a surrogate pair is never written', () => {
  // A payment id cut inside a pair: StsId keeps 35 characters with the pair whole; the message id keeps 28 and the number.
  const pid = `PAY-${'x'.repeat(23)}${SMILE}${'y'.repeat(10)}`;
  const xml = report(viewOf('BANK_AUTHORIZED', [{ ...evidence(), seq: 12 }], pid));
  assertSchemaValid(xml, 'a pair at the cut');
  assert.equal(findFirst(txOf(xml), 'StsId')!.text, `PAY-${'x'.repeat(23)}${SMILE}${'y'.repeat(7)}`);
  assert.equal(msgId(xml), `PAY-${'x'.repeat(23)}${SMILE}-12`);
  // A question with a pair across the 105th character: the pair stays whole, in the first line.
  const q = report(viewOf('TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [`${'u'.repeat(104)}${SMILE}${'v'.repeat(10)}`] })]));
  assertSchemaValid(q, 'a pair across 105');
  assert.deepEqual(addtl(txOf(q)), [`${'u'.repeat(104)}${SMILE}`, 'v'.repeat(10)]);
  // The schema counts characters: 35 of them outside the Basic Multilingual Plane are 35, not 70.
  const fits = txOf(report(viewOf('EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: SMILE.repeat(35) })])));
  assert.equal(findFirst(fits, 'AcctSvcrRef')!.text, SMILE.repeat(35));
  const over = txOf(report(viewOf('EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: SMILE.repeat(36) })])));
  assert.equal(findFirst(over, 'AcctSvcrRef'), undefined);
  assert.deepEqual(addtl(over), [`Credit reference ${SMILE.repeat(36)}`]);
  // Half a pair is dropped wherever it stands, and two halves that stood apart are not made into one.
  const halves = report(viewOf('EVIDENCE_ANCHORED', [
    evidence({ instructionId: 'I-\uD800', endToEndId: '\uDC00' }),
    ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R-\uD83D\u0001\uDE00' }),
    ev(2, 'X'),
  ], 'PAY-\uDBFF1'));
  assertSchemaValid(halves, 'halves');
  const htx = txOf(halves);
  assert.deepEqual([textAt(htx, 'StsId'), textAt(htx, 'OrgnlInstrId'), textAt(htx, 'OrgnlEndToEndId'), textAt(htx, 'AcctSvcrRef')],
    ['PAY-1', 'I-', undefined, 'R-']);
  assert.equal(msgId(halves), 'PAY-1-2');
  // In time: long questions are cut in one pass over them.
  const t0 = performance.now();
  const long = report(viewOf('TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [SMILE.repeat(500_000), 'word '.repeat(100_000)] })]));
  assert.ok(performance.now() - t0 < 4_000, `two long questions took ${Math.round(performance.now() - t0)} ms`);
  assert.doesNotMatch(long, LONE);
  const lines = addtl(txOf(long));
  assert.ok(lines.length > 9_000 && lines.every((t) => codePoints(t) >= 1 && codePoints(t) <= 105), `${lines.length} lines`);
});

test('S6 status: a status carries the time of the event it reflects, or none — never another event\'s', () => {
  const at = (v: StatusView): string | undefined => swiftStatusOf(v).at;
  const settled = (xml: string): string | undefined => textAt(txOf(xml), 'FctvIntrBkSttlmDt/DtTm');
  // Credited without a payout event: no settlement time, though a later, unrelated event has one.
  const credited = viewOf('BENEFICIARY_CREDIT_CONFIRMED', [evidence(), ev(1, 'SOMETHING_ELSE')]);
  assert.equal(at(credited), undefined);
  const xml = report(credited);
  assertSchemaValid(xml, 'credited without a payout event');
  assert.equal(settled(xml), undefined);
  assert.equal(textAt(txOf(xml), 'AccptncDtTm'), T0, 'the acceptance time is still known');
  // A payout event without a time: the same.
  const untimed = { seq: 1, type: 'PAYOUT_COMPLETED', issuer: 'X', payload: { bank_reference: 'R' } };
  assert.equal(settled(report(viewOf('EVIDENCE_ANCHORED', [evidence(), untimed, ev(2, 'EVIDENCE_ANCHORED')]))), undefined);
  // Every status that looks for one event: without it, or without its time, no time.
  const cases: [string, Record<string, unknown>[]][] = [
    ['CANCELLED', [evidence(), ev(1, 'SOMETHING_ELSE')]],
    ['CANCELLED', [evidence(), ev(1, 'CANCEL_REQUESTED', { reason: 'customer' }, ''), ev(2, 'X')]],
    ['EXCEPTION', [evidence(), ev(1, 'SOMETHING_ELSE')]],
    ['RETURNED', [evidence(), ev(1, 'SOMETHING_ELSE')]],
    ['RETURNED', [evidence(), ev(1, 'PAYOUT_FAILED', { reason: 'closed' }), ev(2, 'USDC_RETURNED', { tx_hash: '0xabc' }, null), ev(3, 'X')]],
    ['TRAVEL_RULE_PENDING', [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?'] }, null), ev(2, 'X')]],
    ['PAYOUT_IN_PROGRESS', [evidence(), ev(1, 'PAYOUT_FAILED', {}, null), ev(2, 'X')]],
    ['PAYOUT_IN_PROGRESS', [evidence(), ev(1, 'EVIDENCE_INSUFFICIENT', {}, 5), ev(2, 'X')]],
  ];
  for (const [state, events] of cases) {
    const label = `${state}: ${events.map((e) => e.type).join(', ')}`;
    assert.equal(at(viewOf(state, events)), undefined, label);
    assertSchemaValid(report(viewOf(state, events)), label);
  }
  // With its time, the event's own — not the latest one's.
  const paid = viewOf('EVIDENCE_ANCHORED', [evidence(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R' }), ev(2, 'EVIDENCE_ANCHORED')]);
  assert.equal(at(paid), time(1));
  assert.equal(settled(report(paid)), time(1));
  assert.equal(at(viewOf('RETURNED', [evidence(), ev(1, 'PAYOUT_FAILED'), ev(2, 'USDC_RETURNED'), ev(3, 'X')])), time(2));
  // A status no single event explains takes the latest event's time, as before.
  assert.equal(at(viewOf('ONCHAIN_SETTLED', [evidence(), ev(1, 'X')])), time(1));
});

test('S7 status: an unknown state gives one reason, tidied once — the same word in the status and in the report', () => {
  for (const state of ['  A  VERY   LONG STATE NAME WITH SPACES THAT GOES ON AND ON ', 'bank_authorized', '\u0001NEW\u0002STATE\t',
    SMILE.repeat(40), `${'X'.repeat(34)}${SMILE}${SMILE}`, 'constructor', '__proto__']) {
    const v = viewOf(state, [evidence()]);
    const s = swiftStatusOf(v);
    const xml = report(v);
    assertSchemaValid(xml, JSON.stringify(state));
    assert.equal(findFirst(txOf(xml), 'Prtry')!.text, s.reason, JSON.stringify(state));
    assert.deepEqual([s.code, s.state], ['PDNG', state], 'the state itself is given as the platform gave it');
  }
  assert.equal(swiftStatusOf(viewOf('  A  VERY   LONG STATE NAME WITH SPACES THAT GOES ON ', [])).reason, 'A VERY LONG STATE NAME WITH SPACES');
  assert.equal(swiftStatusOf(viewOf(SMILE.repeat(40), [])).reason, SMILE.repeat(35));
  assert.equal(swiftStatusOf(viewOf('\u0001NEW\u0002STATE\t', [])).reason, 'NEWSTATE');
  // A state made only of what XML forbids has no reason to give, in either.
  const blank = viewOf('\u0001\u0002', [evidence()]);
  assert.equal(swiftStatusOf(blank).reason, undefined);
  assert.equal(findFirst(txOf(report(blank)), 'StsRsnInf'), undefined);
});

test('S9 status: any JSON gives a status and a report — a value of the wrong kind is read as absent, never a TypeError', () => {
  const good = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ payment_id: 'PAY-1', state: 'BANK_AUTHORIZED', events: [evidence()], ...over });
  const views: [string, unknown][] = [
    ['a view that is null', null], ['a view that is a list', [good()]], ['a view that is text', 'PAY-1'], ['a view that is a number', 7],
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
    ['a sequence number that cannot be made text', good({ events: [{ ...evidence(), seq: { toString: 'x' } }] })],
    ['a payload that is text', good({ state: 'PAYOUT_IN_PROGRESS', events: [evidence(), ev(1, 'PAYOUT_FAILED', 'closed account')] })],
    ['an instruction that is a list', good({ events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: [{ sourceMessage: {} }] })] })],
    ['a payload named after Object.prototype', good({ events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', JSON.parse('{"__proto__":{"bankInstruction":{}}}'))] })],
  ];
  for (const [what, view] of views) {
    let xml = '';
    assert.doesNotThrow(() => {
      swiftStatusOf(view as StatusView);
      sourceMessageOf(view as StatusView);
      xml = report(view);
    }, what);
    assertSchemaValid(xml, what);
  }
  // A state that is not text is a state the table does not know.
  const unknown = swiftStatusOf(viewOf(5, [evidence()]));
  assert.deepEqual([unknown.code, unknown.state, unknown.reason], ['PDNG', 'UNKNOWN', 'UNKNOWN']);
  // An event that is text has no time, though "x".at is a method.
  const text = swiftStatusOf(viewOf('BANK_AUTHORIZED', ['x']));
  assert.deepEqual([text.at, text.acceptedAt], [undefined, undefined]);
  // Events that are not a list are no events.
  const none = swiftStatusOf(viewOf('CANCELLED', 'abc'));
  assert.deepEqual([none.code, none.reason, none.detail, none.at, none.acceptedAt], ['RJCT', 'CANCELLED_BY_BANK', [], undefined, undefined]);
  // Questions are given in words when they are text, numbers or true/false; nothing else is turned into text.
  const asked = swiftStatusOf(viewOf('TRAVEL_RULE_PENDING',
    [evidence(), ev(1, 'TRAVEL_RULE_RFI', { questions: [{}, [1], null, 'Why?', 3, false, { toString: 1 }] })]));
  assert.deepEqual(asked.detail, ['Why?', '3', 'false']);
  // The bank's reference is still found behind entries that are not events.
  assert.equal(sourceMessageOf(viewOf('BANK_AUTHORIZED', [null, 'x', evidence()]))?.messageId, 'M-1');
  assert.equal(sourceMessageOf(null as unknown as StatusView), undefined);
});

test('S10 status: a time is written only in the ISO 8601 form the platform writes — any other leaves its element out', () => {
  for (const bad of ['yesterday', '', '2026-11-17', '2026-11-17 00:00:00Z', '2026-11-17T00:00:00', '2026-11-17T00:00Z',
    '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-02-29T00:00:00Z', '2026-11-31T00:00:00Z', '2026-11-00T00:00:00Z',
    '2026-11-17T24:00:00Z', '2026-11-17T23:60:00Z', '2026-11-17T23:59:60Z', '2026-11-17T00:00:00+15:00', '2026-11-17T00:00:00+14:30',
    '2026-11-17T00:00:00+05:60', '2026-11-17T00:00:00+0700', '0000-01-01T00:00:00Z', ' 2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z\n',
    '2026-11-17T00:00:00.Z', '2026-11-17t00:00:00z', '+2026-11-17T00:00:00Z', '\u{ff12}026-11-17T00:00:00Z']) {
    const v = viewOf('EVIDENCE_ANCHORED', [evidence({}, bad), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R' }, bad)]);
    const s = swiftStatusOf(v);
    assert.deepEqual([s.at, s.acceptedAt], [undefined, undefined], JSON.stringify(bad));
    const xml = report(v);
    assertSchemaValid(xml, JSON.stringify(bad));
    assert.deepEqual(names(txOf(xml)).filter((name) => /DtTm$|Dt$/.test(name)), [], JSON.stringify(bad));
  }
  for (const good of [T0, '2026-11-17T00:00:00Z', '2026-11-17T09:30:00.123456+07:00', '2024-02-29T23:59:59Z',
    '2000-02-29T00:00:00-14:00', '2026-11-17T00:00:00+14:00', '0001-01-01T00:00:00Z']) {
    const tx = txOf(report(viewOf('EVIDENCE_ANCHORED', [evidence({}, good), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'R' }, good)])));
    assert.deepEqual([textAt(tx, 'AccptncDtTm'), textAt(tx, 'FctvIntrBkSttlmDt/DtTm')], [good, good], good);
  }
  // The creation time cannot be left out: one given in another form is not used, and the report says when it was made.
  const createdOf = (createdAt: string): string => findFirst(parseXml(report(viewOf('BANK_AUTHORIZED', [evidence()]), { createdAt })), 'CreDtTm')!.text;
  const before = Date.now();
  for (const createdAt of ['', 'T', ' <T>&\u0001\t"\' ', '2026-11-17', '2026-11-17T25:00:00Z']) {
    const created = createdOf(createdAt);
    assert.ok(isDateTime(created) && Date.parse(created) >= before - 1 && Date.parse(created) <= Date.now(), `${JSON.stringify(createdAt)} gave ${created}`);
  }
  assert.equal(createdOf('2026-11-17T09:30:00+07:00'), '2026-11-17T09:30:00+07:00');
});

test('status: every report made from any JSON keeps to the pacs.002.001.10 schema', () => {
  // A fixed sequence of choices among the values that broke something before.
  let seed = 0x2545f491;
  const rnd = (n: number): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)]!;
  const texts = ['', ' ', '\u0001', 'M-1', 'x'.repeat(40), `${'y'.repeat(34)}${SMILE}`, '\uD800', 'a\uDC00b', '<&>"\'', ' two  words\t',
    UETR_4, 'A8098C1A-F86E-11DA-BD1A-00112444BE1E', 'word '.repeat(50)];
  const values: unknown[] = [...texts, null, undefined, 0, -0, 7, 1.5, 1e21, true, [], ['x'], {}, { toString: 1 }];
  const times: unknown[] = [T0, '2026-11-17T09:30:00+07:00', 'yesterday', '', '2026-02-30T00:00:00Z', 5, null, undefined, {}];
  const types = ['BANK_EVIDENCE_SUBMITTED', 'REQUEST_ACCEPTED', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED',
    'TRAVEL_RULE_REJECTED', 'PAYOUT_FAILED', 'EVIDENCE_INSUFFICIENT', 'PAYOUT_COMPLETED', 'CANCEL_REQUESTED', 'USDC_RETURNED', 'EXCEPTION', 'X'];
  const states: unknown[] = ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED',
    'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED', 'CANCELLED', 'RETURNED', 'EXCEPTION', ...values];
  const event = (): unknown => {
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
  for (let i = 0; i < 3_000; i++) {
    const view = rnd(20)
      ? { payment_id: pick(values), state: pick(states), events: rnd(15) ? Array.from({ length: rnd(6) }, event) : pick(values) }
      : pick(values);
    const opts = rnd(4) ? { createdAt: T0 } : { messageId: pick(texts), createdAt: pick(times) as string };
    let xml = '';
    assert.doesNotThrow(() => {
      swiftStatusOf(view as StatusView);
      sourceMessageOf(view as StatusView);
      xml = report(view, opts);
    }, `view ${i}`);
    assertSchemaValid(xml, `view ${i}`);
  }
});
