// The reference's answers for the six hand-written Java tests rewritten after the hardening of the
// mapping (A1–A10): each line is a value SwiftMappingTest asserts, computed here by mapSwiftPayment on
// the same golden payment with the same JSON patch. `node probe/hardening.ts [section]`.
import { mapSwiftPayment, SwiftMappingError, swiftContentDigest, swiftPaymentId } from '../../../../../packages/attest-remit/src/index.ts';
import { compareDecimal } from '../../../../../packages/attest-remit/src/swift/mapping.ts';
import type { SwiftMapping } from '../../../../../packages/attest-remit/src/index.ts';
import { payment } from './expect.ts';

const what = process.argv[2] ?? 'all';
const section = (name: string): boolean => what === 'all' || what === name;
const show = (label: string, v: unknown): void => console.log(`${label}\n  ${JSON.stringify(v)}`);
/** As the Java test writes a string literal of the value: JSON.stringify of it. */
const lit = (label: string, v: unknown): void => console.log(`${label}\n  ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))}`);

const map = (b: string, patch: string, options = '{}'): SwiftMapping => mapSwiftPayment(payment(b, patch), JSON.parse(options));
const field = (m: SwiftMapping, target: string) => m.fields.find((f) => f.target === target);
const row = (m: SwiftMapping, target: string): string | null => {
  const f = field(m, target);
  return f ? `${f.target}|${f.value}|${f.basis}|${f.source}` : null;
};
const targetsAndSources = (m: SwiftMapping): string[] => m.issues.map((i) => `${i.target}|${i.source}`);
const problems = (m: SwiftMapping): string[] => m.issues.map((i) => i.problem);
const INVOICE = 'CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)';
const further = (m: SwiftMapping): string[] => m.unmapped.filter((u) => u.source === INVOICE).map((u) => u.value);

if (section('amounts')) {
  // [instructed, settled] → which one is taken (by the source of the trade amount's field or issue), and
  // what comes of it: the trade amount, or "refused" when the amount check refuses the one taken.
  const pairs: [string, string][] = [
    // What Number() read as a number, and the old table held: none of it is a plain decimal.
    ['0x10', '15'], ['1e1', '9.5'], ['', '5'], ['abc', '5'], ['5', 'abc'], ['.5', '0.6'], ['5.', '5.01'], [' 7 ', '8'],
    [' 7　', '8'], ['᠎7', '8'], ['0b11', '4'], ['0o7', '8'], ['0b2', '4'], ['+3', '4'], ['-3', '0'], ['Infinity', '1e400'],
    ['+Infinity', '5'], ['-Infinity', '5'], ['infinity', '5'], ['0X1F', '32'], ['-0x1', '5'], ['1_0', '20'], ['1e', '5'], ['0x', '5'],
    ['1d', '5'], ['0x1p3', '9'], ['١', '5'], ['１', '5'], ['NaN', '5'], ['1.2.3', '5'], ['+.5e-3', '0.001'], ['0', '-0'],
    ['1' + '0'.repeat(30), '1e30'], ['abc', 'xyz'], ['', ''],
    // Plain decimals, compared digit by digit.
    ['9007199254740993', '9007199254740992'], ['9007199254740992', '9007199254740993'], ['0.1', '0.10000000000000001'],
    ['999999999999999.98', '999999999999999.99'], ['999999999999999.99', '999999999999999.98'],
    ['123456789012345.12', '123456789012345.13'], ['1' + '0'.repeat(30), '9'.repeat(30) + '.99'],
    ['00012', '13'], ['0100', '100'], ['100', '0100'], ['007.50', '7.5'],
    ['12', '12.0'], ['7000.5', '7000.50'], ['100.10', '100.1'], ['0.00', '0'],
    ['99.999', '100'], ['100.001', '100'], ['12499.995', '12500'], ['12500.001', '12500.00'], ['7010.50', '7000.50'], ['1000', '1015'],
  ];
  const rows: [string, string, string, string][] = [];
  for (const [i, s] of pairs) {
    const m = map('pacs008', JSON.stringify({ instructedAmount: { currency: 'USD', value: i }, amount: { currency: 'USD', value: i }, settlementAmount: { currency: 'USD', value: s } }));
    const f = m.fields.find((x) => x.target === 'trade.amount');
    const issue = m.issues.find((x) => x.target === 'trade.amount');
    const source = f?.source ?? issue!.source;
    const taken = source === 'CdtTrfTxInf/InstdAmt' ? 'instructed' : source === 'CdtTrfTxInf/IntrBkSttlmAmt' ? 'settled' : `?${source}`;
    // A refusal names the amount taken, by its element and its value.
    if (issue && issue.problem !== `${JSON.stringify(taken === 'instructed' ? i : s)} is not a positive USD amount with at most two decimals`) {
      throw new Error(`unexpected refusal for ${JSON.stringify([i, s])}: ${issue.problem}`);
    }
    if (m.issues.length > (issue ? 1 : 0)) throw new Error(`other issues for ${JSON.stringify([i, s])}`);
    rows.push([i, s, taken, f ? m.input!.tradeAmount : 'refused']);
  }
  console.log('amount rows (Java literals)');
  for (const r of rows) console.log(`  {${r.map((x) => javaString(x)).join(', ')}},`);

  const past = map('pacs008', '{"instructedAmount":{"currency":"USD","value":"123456789012345.12"},"amount":{"currency":"USD","value":"123456789012345.12"},"settlementAmount":{"currency":"USD","value":"123456789012345.13"}}');
  show('past double precision: trade amount', past.input!.tradeAmount);
  show('past double precision: trade field', row(past, 'trade.amount'));
  show('past double precision: unmapped', past.unmapped.map((u) => `${u.source}|${u.value}|${u.why}`));
  const odd = map('pacs008', '{"instructedAmount":{"currency":"USD","value":"twelve"}}');
  show('instructed "twelve": issues', odd.issues.map((x) => `${x.target}|${x.source}|${x.problem}`));
  const oddSettled = map('pacs008', '{"settlementAmount":{"currency":"USD","value":"twelve"}}');
  show('settled "twelve": issues', oddSettled.issues.map((x) => `${x.target}|${x.source}|${x.problem}`));
  const oddMt = map('mt103', '{"instructedAmount":{"currency":"USD","value":"1,000.00"},"settlementAmount":{"currency":"USD","value":"990.75"}}');
  show('mt103 instructed "1,000.00": issues', oddMt.issues.map((x) => `${x.target}|${x.source}|${x.problem}`));
}

if (section('refusal')) {
  const live = map('mt103', '{"test":{"where":"field 23B","what":"CRTS"}}', '{"supplement":{"debtor":{"registration_number":"1"}}}');
  show('live: problems', problems(live));
  show('live: issues', targetsAndSources(live));
  show('live: unmapped', live.unmapped.map((u) => `${u.source}|${u.value}`));
  const allowed = map('mt103', '{"debtor":{"person":true},"creditor":{"person":true},"test":{"where":"field 23B","what":"CRTS"}}', '{"allowTestMessages":true}');
  show('allowed: issues', targetsAndSources(allowed));
  show('allowed: unmapped', allowed.unmapped.map((u) => `${u.source}|${u.value}`));
  show('allowed: last', allowed.unmapped.at(-1));
  const off = map('mt103', '{"test":{"where":"field 23B","what":"CRTS"}}', '{"allowTestMessages":false}');
  show('allowTestMessages false: issues', targetsAndSources(off));
  show('allowTestMessages false: unmapped', off.unmapped.map((u) => `${u.source}|${u.value}`));
  const bare = map('pacs008', '{"test":{"where":"x"}}');
  show('bare live: problems', problems(bare));
  show('bare live: unmapped', bare.unmapped.map((u) => `${u.source}|${u.value}`));
  const bareTaken = map('pacs008', '{"test":{"where":"x"}}', '{"allowTestMessages":true}');
  show('bare taken: issues', bareTaken.issues);
  lit('bare taken: last unmapped (JSON)', bareTaken.unmapped.at(-1));
  const persons = map('pacs008', '{"debtor":{"person":true},"creditor":{"person":true},"test":{"where":"Business Application Header","what":"test and training BIC DEMOVNV0"}}');
  show('persons-and-test-iso: unmapped', persons.unmapped.map((u) => `${u.source}|${u.value}`));
  show('persons-and-test-iso: error', new SwiftMappingError(persons).message);
}

if (section('unmapped')) {
  const m = map('pacs008', '{"exchangeRate":"1.1","intermediaryAgents":[{"bic":"INTMSGSG","name":"Correspondent"},{"name":"Correspondent"},{"memberId":"021000021"},{},{"bic":""}],"instructedAmount":{"currency":"USD","value":"12510.00"},"amount":{"currency":"USD","value":"12510.00"},"charges":["10.00 USD (DEMOVNVX)"],"invoiceReferences":["INV-1"," INV-2 ","INV-1"],"otherDocuments":["PUOR PO-88812"],"regulatoryReporting":["CRED EXPORT VN CERAMICS"],"present":["MsgId","PmtId","UltmtDbtr","UltmtCdtr","InstrForCdtrAgt","InstrForNxtAgt","77T","72","23E"]}');
  lit('unmapped-everything: unmapped (JSON)', m.unmapped);
  show('unmapped-everything: trade', `${field(m, 'trade.amount')!.value}|${field(m, 'trade.amount')!.source}`);
  const via = map('pacs008', '{"intermediaryAgents":[{"bic":"","name":"Correspondent Bank"},{"bic":" ","name":"","memberId":""},{"bic":" INTMSGSG "},{"name":"\\u3000","memberId":" 021000021"},{"bic":"\\n","name":"\\t"}]}');
  show('intermediaries: values', via.unmapped.filter((u) => u.source === 'IntrmyAgt1…3').map((u) => u.value));
  show('intermediaries: issues', via.issues);
  const viaMt = map('mt103', '{"intermediaryAgents":[{"bic":"","name":"CORRESPONDENT BANK"},{"bic":" "}]}');
  show('mt103 intermediaries', viaMt.unmapped.filter((u) => u.source === 'field 56a').map((u) => `${u.source}|${u.value}`));
  const whys: [string, string][] = [
    ['mt103', '{"instructedAmount":{"currency":"USD","value":"1000"},"amount":{"currency":"USD","value":"1000"},"settlementAmount":{"currency":"USD","value":"1015"}}'],
    ['pacs008', '{"instructedAmount":{"currency":"VND","value":"322537500"},"amount":{"currency":"VND","value":"322537500"}}'],
    ['pacs008', '{"settlementAmount":{"currency":"SGD","value":"16687.50"}}'],
    ['pacs008', '{"instructedAmount":{"currency":"USD","value":"100.10"},"amount":{"currency":"USD","value":"100.10"},"settlementAmount":{"currency":"USD","value":"100.1"}}'],
  ];
  for (const [b, p] of whys) {
    const x = map(b, p, '{"supplement":{"debtor":{"registration_number":"0312345678"}}}');
    let got: string | null = null;
    for (const u of x.unmapped) if (/^[0-9.]+ [A-Z]{3}$/.test(u.value)) got = `${u.source}|${u.value}|${u.why}`;
    show(`why ${p}`, got);
  }
}

if (section('reference')) {
  const e2e = map('pacs008', '{"invoiceReferences":[],"endToEndId":"E2E-77"}');
  show('e2e: invoice', `${field(e2e, 'invoice_ref')!.value}|${field(e2e, 'invoice_ref')!.source}|${field(e2e, 'invoice_ref')!.basis}`);
  const line = map('pacs008', '{"invoiceReferences":[],"endToEndId":"notprovided","remittanceInformation":["  Payment\\u3000for \\u00a0 goods ' + 'x'.repeat(45) + '\\ud83d\\ude00 and more","second line"]}');
  const f = field(line, 'invoice_ref')!;
  show('line: value', f.value);
  show('line: value code points / units', [[...f.value].length, f.value.length]);
  show('line: source|basis', `${f.source}|${f.basis}`);
  show('line: source endToEndId', line.input!.source.endToEndId ?? null);
  show('line: sourceMessage.endToEndId field', field(line, 'sourceMessage.endToEndId') ?? null);
  lit('line: JSON of the invoiceRef', line.input!.invoiceRef);
  const none = map('pacs008', '{"invoiceReferences":[],"endToEndId":"NONREF","remittanceInformation":[" "]}');
  show('none: error', new SwiftMappingError(none).message);
  show('none: fix', none.issues[0]!.fix);

  // A3: cut at 64 code points; a cut that ends on a space does not keep it.
  const cuts: [string, string][] = [
    ['x'.repeat(63) + '\u{1F600}tail', 'x63 + emoji + tail'], ['x'.repeat(64) + '\u{1F600}', 'x64 + emoji'], ['\u{1F600}'.repeat(70), 'emoji x70'],
    ['SPARE   PARTS', 'SPARE   PARTS'], ['x'.repeat(63) + ' tail', 'x63 + space + tail'], ['x'.repeat(62) + '\u{1F600} tail', 'x62 + emoji + space + tail'],
    ['x'.repeat(63) + '　 tail', 'x63 + U+3000 NBSP + tail'], ['x'.repeat(63) + '\ud800tail', 'x63 + lone high surrogate + tail'],
  ];
  for (const [l, label] of cuts) {
    const m = map('pacs008', JSON.stringify({ invoiceReferences: [], endToEndId: 'NOTPROVIDED', remittanceInformation: [l] }));
    const v = m.input?.invoiceRef;
    show(`cut ${label}`, [v, v === undefined ? null : [...v].length, v === undefined ? null : v.length, field(m, 'invoice_ref')?.source ?? null]);
  }

  // A7: the invoice taken is compared trimmed; an empty entry is no invoice.
  const invoiceCases: [string, string][] = [
    ['{"invoiceReferences":[" INV-1 "]}', '{}'],
    ['{"invoiceReferences":[" INV-1 ","INV-1","INV-2\\n"]}', '{}'],
    ['{"invoiceReferences":["","  ","INV-3"]}', '{}'],
    ['{"invoiceReferences":[""," ","INV-3"]}', '{}'],
    ['{"invoiceReferences":[" INV-1 "]}', '{"supplement":{"invoiceRef":"INV-1"}}'],
    ['{"invoiceReferences":[" INV-1 ","INV-9"]}', '{"supplement":{"invoiceRef":" INV-9 "}}'],
    ['{"invoiceReferences":["","\\u3000"],"endToEndId":"E2E-5"}', '{}'],
  ];
  for (const [p, o] of invoiceCases) {
    const m = map('pacs008', p, o);
    show(`invoices ${p} ${o}`, [row(m, 'invoice_ref'), further(m), m.input?.invoiceRef ?? null, m.issues.length]);
  }

  // A10: the words for "no reference", with white space around them, are no reference.
  for (const e of [' NOTPROVIDED', 'NOTPROVIDED\n', '\tnonref ', 'NOREF\r\n', '　NoRef﻿', '  ', '']) {
    const m = map('pacs008', JSON.stringify({ invoiceReferences: [], endToEndId: e }));
    show(`e2e ${JSON.stringify(e)}`, [targetsAndSources(m), m.fields.filter((x) => x.target === 'invoice_ref' || x.target === 'sourceMessage.endToEndId').length]);
  }
  const padded = map('pacs008', '{"invoiceReferences":[],"endToEndId":" PO-7781\\n"}');
  show('padded e2e: invoice row', row(padded, 'invoice_ref'));
  show('padded e2e: source field row', row(padded, 'sourceMessage.endToEndId'));
  show('padded e2e: input invoiceRef / source.endToEndId', [padded.input!.invoiceRef, padded.input!.source.endToEndId]);
  const similar = map('pacs008', '{"invoiceReferences":[],"endToEndId":"NOTPROVIDED-1"}');
  show('NOTPROVIDED-1: invoice row', row(similar, 'invoice_ref'));
  const nl = map('pacs008', '{"invoiceReferences":[],"endToEndId":"NOTPROVIDED\\n"}');
  show('NOTPROVIDED\\n: issues', targetsAndSources(nl));
  show('NOTPROVIDED\\n: invoice field', field(nl, 'invoice_ref') ?? null);
  // An end-to-end word with white space, with a remittance line: the line is the invoice.
  const withLine = map('pacs008', '{"invoiceReferences":[],"endToEndId":" NOTPROVIDED","remittanceInformation":["Invoice 77"]}');
  show('NOTPROVIDED + remittance: invoice row', row(withLine, 'invoice_ref'));
}

if (section('source')) {
  const batch = map('pain001', '{"transactionCount":3,"index":2,"endToEndId":"NOTPROVIDED"}');
  lit('batch: source (JSON)', batch.input!.source);
  show('batch: instructionRef', batch.input!.instructionRef);
  show('batch: keys', Object.keys(batch.input!));
  const empty = map('pain001', '{"instructionId":""}');
  show('empty: instructionRef', empty.input!.instructionRef ?? null);
  show('empty: keys', Object.keys(empty.input!));
  lit('empty: source (JSON)', empty.input!.source);
  show('empty: sourceMessage fields', empty.fields.filter((x) => x.target.startsWith('sourceMessage.')).map((x) => `${x.target}|${x.value}`));
  const refs: [string, string][] = [
    ['pain001', '{}'],
    ['pain001', '{"instructionId":""}'],
    ['pain001', '{"instructionId":" ","paymentInfoId":""}'],
    ['pain001', '{"instructionId":"","paymentInfoId":"\\t","messageId":""}'],
    ['pain001', '{"instructionId":" VINATRD-INS-0031-1 "}'],
    ['pacs008', '{"instructionId":""}'],
    ['pacs008', '{"instructionId":"","messageId":""}'],
    ['pacs008', '{"instructionId":null,"messageId":" "}'],
    ['mt103', '{"instructionId":"","messageId":""}'],
  ];
  for (const [b, p] of refs) {
    const m = map(b, p);
    show(`ref ${b} ${p}`, [m.input!.instructionRef ?? null, 'instructionRef' in m.input!, m.issues.length]);
  }
  // White space alone is no instruction reference — but it is still what the message states, and the source cites it.
  const blank = map('pain001', '{"instructionId":" ","paymentInfoId":""}');
  lit('blank: source (JSON)', blank.input!.source);
  show('blank: sourceMessage fields', blank.fields.filter((x) => x.target.startsWith('sourceMessage.')).map((x) => `${x.target}|${JSON.stringify(x.value)}`));
  const paddedId = map('pain001', '{"instructionId":" VINATRD-INS-0031-1 "}');
  show('padded id: instructionRef, source.instructionId', [paddedId.input!.instructionRef, paddedId.input!.source.instructionId]);
}

if (section('countries')) {
  const inferred = map('mt103', '{"debtor":{"country":null},"creditor":{"country":null},"debtorAgent":{"bic":"aaaavnvx"},"creditorAgent":{"country":"SG","memberId":"7171","clearingSystem":""}}', '{"supplement":{"debtor":{"registration_number":"1"}}}');
  show('inferred: rows', [row(inferred, 'debtor.country'), row(inferred, 'creditor.country'), row(inferred, 'creditor.bank')]);
  const agentCountry = map('pacs008', '{"creditor":{"country":null},"creditorAgent":{"bic":null,"name":null,"country":"SG","memberId":"026009593","clearingSystem":"SGIBG"}}');
  show('agentCountry: rows', [row(agentCountry, 'creditor.country'), row(agentCountry, 'creditor.bank')]);
  show('agentCountry: issues', agentCountry.issues);
  const mtAgent = map('mt103', '{"creditor":{"country":null,"countryFrom":null},"creditorAgent":{"bic":null,"name":"DEMO PAYOUT BANK","country":"SG"}}');
  show('mt agent country: row', row(mtAgent, 'creditor.country'));
  show('mt agent country: issues', mtAgent.issues);
  const notInferred = map('pacs008', '{"creditor":{"country":null},"creditorAgent":{"bic":null,"name":"Demo Payout Bank (SG)","country":"SG"}}', '{"inferCountryFromBic":false}');
  show('agent country, no inference: issues', targetsAndSources(notInferred));
  const bicFirst = map('pacs008', '{"creditor":{"country":null},"creditorAgent":{"country":"MY"}}');
  show('BIC and a stated agent country: row', row(bicFirst, 'creditor.country'));
  show('BIC and a stated agent country: problems', problems(bicFirst));
  const strict = map('mt103', '{"debtor":{"country":null},"creditor":{"country":null},"creditorAgent":{"country":"SG","memberId":"7171"}}', '{"inferCountryFromBic":false}');
  show('strict: issues', targetsAndSources(strict));
  show('strict: bank', row(strict, 'creditor.bank'));
  for (const cs of ['{"memberId":"7171"}', '{"memberId":"7171","clearingSystem":""}', '{"memberId":"7171","clearingSystem":"  "}', '{"bic":null,"memberId":"7171","clearingSystem":"SGIBG"}', '{"memberId":"7171","clearingSystem":" SGIBG "}']) {
    const m = map('pacs008', `{"creditorAgent":${cs}}`);
    show(`bank ${cs}`, [m.input?.parties.creditor.bank ?? null, row(m, 'creditor.bank')]);
  }
  const us = map('pacs008', '{}', '{"corridor":{"origin":"VN","destination":"US"}}');
  show('us: problems', problems(us));
  show('us: fix', us.issues[0]!.fix);
  const noDestination = map('pacs008', '{"debtor":{"country":"TH"}}', '{"corridor":{"origin":"VN"}}');
  show('noDestination: problems', problems(noDestination));
  const my = map('pacs008', '{"creditorAgent":{"bic":"DEMOMYKL","country":"SG"}}');
  show('my: problems', problems(my));
  for (const agent of ['{"bic":null,"country":" "}', '{"bic":null,"country":""}', '{"bic":null,"country":"\\u3000"}', '{"bic":null,"country":" MY "}', '{"bic":null,"country":"SG"}']) {
    const m = map('pacs008', `{"creditorAgent":${agent}}`);
    show(`agent ${agent}: problems / bank`, [problems(m), row(m, 'creditor.bank')]);
  }
  for (const tc of ['""', '"  "', 'null', '" USD "', '" EUR "', '"EUR"']) {
    const m = map('pacs008', '{}', `{"tradeCurrency":${tc}}`);
    show(`tradeCurrency ${tc}`, [m.issues.map((i) => `${i.problem}|${i.fix}`), m.input?.tradeCurrency ?? null]);
  }
  const where = map('mt103', '{"debtor":{"countryFrom":"CtryOfRes","lei":"","identification":"0312345678"},"creditor":{"countryFrom":"field 77B /BENEFRES/"}}');
  show('where: rows', [row(where, 'debtor.country'), row(where, 'creditor.country'), row(where, 'debtor.registration_number')]);
  show('where: issues', targetsAndSources(where));
  const lei = map('pacs008', '{"debtor":{"lei":"5493001KJTIIGC8Y1R12","countryFrom":"CtryOfRes","identificationFrom":""}}');
  show('lei: rows', [row(lei, 'debtor.country'), row(lei, 'debtor.registration_number')]);
  for (const d of ['{"lei":""}', '{"lei":"   "}', '{"lei":"\\u3000"}', '{"lei":"","identification":" "}', '{"lei":" ","identification":""}', '{"lei":"9845003X7Y4K2B1Q8W63"}', '{"lei":" 9845003X7Y4K2B1Q8W63 "}', '{"identification":" 0312345678 "}']) {
    const m = map('pacs008', `{"debtor":${d}}`);
    show(`debtor ${d}`, [row(m, 'debtor.registration_number'), targetsAndSources(m), m.input?.parties.debtor.registration_number ?? null]);
  }
  const blankId = map('pacs008', '{"debtor":{"lei":"","identification":" "}}');
  show('blank id: issues (full)', blankId.issues);
}

if (section('compare')) {
  // The reference's compareDecimal on the pairs testAmountsAreComparedDigitByDigit asks SwiftMapper.compareDecimal about.
  const pairs: [string, string][] = [
    ['999999999999999.98', '999999999999999.99'], ['100.5', '100.50'], ['0100', '100'], ['99.999', '100'], ['100.001', '100'], ['0.00', '0'],
    ['1' + '0'.repeat(30), '9'.repeat(30) + '.99'], ['9007199254740993', '9007199254740992'], ['0.1', '0.10000000000000001'], ['000', '0.0'], ['10', '9'],
  ];
  show('compareDecimal', pairs.map(([a, b]) => compareDecimal(a, b)));
  const bad = ['1e3', '', '1.', '.5', '-1', ' 1', '1 ', '1,5', '١٢', '１', '+1', '0x1', '1\n', 'Infinity', 'NaN'];
  show('compareDecimal of what is not a plain decimal, either side', bad.map((b) => [compareDecimal(b, '1') ?? null, compareDecimal('1', b) ?? null]));
}

if (section('ids')) {
  // The rows added to testTheContentDigestIsThePaymentNotTheMessage and testThePaymentIdIsTheMessagesIdentity (A9, A10).
  for (const d of ['{"endToEndId":" NOTPROVIDED"}', '{"endToEndId":"NOTPROVIDED\\n"}', '{"endToEndId":"\\tnonref "}', '{"endToEndId":"NOREF\\r\\n"}',
    '{"endToEndId":" PO-7781\\n"}', '{"endToEndId":"NOTPROVIDED-1"}']) show(`digest ${d}`, swiftContentDigest(payment('pacs008', d)));
  for (const d of ['{"uetr":null,"endToEndId":"NOTPROVIDED\\n"}', '{"uetr":null,"endToEndId":"\\tnonref "}', '{"uetr":null,"endToEndId":""}',
    '{"uetr":null,"endToEndId":"  "}', '{"uetr":null,"endToEndId":"NOTPROVIDED-1"}', '{"uetr":null,"endToEndId":" PO-7781\\n"}', '{"uetr":null}'])
    show(`id ${d}`, swiftPaymentId('VN-BANK-T1', payment('pacs008', d)));
}

function javaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else for (let i = 0; i < ch.length; i++) out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return out + '"';
}
