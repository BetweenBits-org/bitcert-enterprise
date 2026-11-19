// The reference's answers for the hand-written Java tests (SwiftMappingTest). Each case is a base payment
// from parse.json, a patch (deep merge; null deletes a key) and options; the same patches are in the Java test.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { isoFieldNames, swiftPaymentId, mapSwiftPayment, swiftContentDigest, SwiftMappingError } from '../../../../../packages/attest-remit/src/index.ts';

const GOLDEN = fileURLToPath(new URL('../../../src/test/resources/golden', import.meta.url));
const parse = JSON.parse(readFileSync(`${GOLDEN}/parse.json`, 'utf8'));
const base = (name: string): any => JSON.parse(JSON.stringify(parse.cases.find((c: any) => c.name === name).expect.payments[0]));
const BASES: Record<string, string> = { pacs008: 'sample/pacs008', mt103: 'sample/mt103-structured', pain001: 'sample/pain001' };

function merge(into: any, patch: any): any {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete into[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof into[k] === 'object' && into[k] !== null && !Array.isArray(into[k])) merge(into[k], v);
    else into[k] = v;
  }
  return into;
}
export const payment = (b: string, patch: string): any => merge(base(BASES[b]!), JSON.parse(patch));

const main = process.argv[1]!.endsWith('expect.ts');
const what = main ? (process.argv[2] ?? 'all') : 'none';
const out = (label: string, v: unknown) => console.log(`${label}\n  ${JSON.stringify(JSON.stringify(v))}`);

export const mappingCases: [string, string, string, string][] = [
  // name, base, patch, options
  ['nothing-iso', 'pacs008', '{"debtor":{"name":null,"country":null,"addressLines":[],"identification":null,"identificationFrom":null,"identificationScheme":null,"bic":"AAAAVNVX","account":null},"creditor":{"name":null,"country":null,"account":null},"creditorAgent":null,"debtorAgent":null,"invoiceReferences":[],"endToEndId":"NOTPROVIDED","remittanceInformation":[],"amount":{"currency":"EUR","value":"10.00"},"instructedAmount":{"currency":"EUR","value":"10.00"},"settlementAmount":{"currency":"EUR","value":"10.00"}}', '{}'],
  ['nothing-mt', 'mt103', '{"debtor":{"name":null,"country":null,"addressLines":[],"identification":null,"identificationFrom":null,"identificationScheme":null,"account":null},"creditor":{"name":null,"country":null,"account":null},"creditorAgent":null,"debtorAgent":null,"invoiceReferences":[],"remittanceInformation":[],"amount":{"currency":"USD","value":"0.00"},"settlementAmount":{"currency":"USD","value":"0.00"}}', '{}'],
  ['nothing-pain', 'pain001', '{"debtor":{"name":"  ","country":null,"addressLines":[],"identification":null,"bic":""},"creditor":{"name":"\\u3000","country":null,"account":"\\ufeff"},"creditorAgent":{},"debtorAgent":{"bic":"bad"},"invoiceReferences":[],"endToEndId":"noref","remittanceInformation":["\\u00a0"],"amount":{"currency":"USD","value":"12.345"},"instructedAmount":{"currency":"USD","value":"12.345"}}', '{}'],
  ['persons-and-test-iso', 'pacs008', '{"debtor":{"person":true},"creditor":{"person":true},"test":{"where":"Business Application Header","what":"test and training BIC DEMOVNV0"}}', '{}'],
  ['persons-and-test-mt', 'mt103', '{"debtor":{"person":true},"creditor":{"person":true},"test":{"where":"field 23B","what":"CRTS"},"bankOperationCode":"CRTS"}', '{"allowTestMessages":true}'],
  ['unmapped-everything', 'pacs008', '{"exchangeRate":"1.1","intermediaryAgents":[{"bic":"INTMSGSG","name":"Correspondent"},{"name":"Correspondent"},{"memberId":"021000021"},{},{"bic":""}],"instructedAmount":{"currency":"USD","value":"12510.00"},"amount":{"currency":"USD","value":"12510.00"},"charges":["10.00 USD (DEMOVNVX)"],"invoiceReferences":["INV-1"," INV-2 ","INV-1"],"otherDocuments":["PUOR PO-88812"],"regulatoryReporting":["CRED EXPORT VN CERAMICS"],"present":["MsgId","PmtId","UltmtDbtr","UltmtCdtr","InstrForCdtrAgt","InstrForNxtAgt","77T","72","23E"]}', '{}'],
  ['why-prepaid', 'mt103', '{"instructedAmount":{"currency":"USD","value":"1000"},"amount":{"currency":"USD","value":"1000"},"settlementAmount":{"currency":"USD","value":"1015"},"chargeBearer":"DEBT","charges":["receiver\'s charges USD15,"]}', '{"supplement":{"debtor":{"registration_number":"0312345678"}}}'],
  ['why-converted-before', 'pacs008', '{"instructedAmount":{"currency":"VND","value":"322537500"},"amount":{"currency":"VND","value":"322537500"}}', '{}'],
  ['why-settled-elsewhere', 'pacs008', '{"settlementAmount":{"currency":"SGD","value":"16687.50"}}', '{}'],
  ['equal-amounts-written-differently', 'pacs008', '{"instructedAmount":{"currency":"USD","value":"100.10"},"amount":{"currency":"USD","value":"100.10"},"settlementAmount":{"currency":"USD","value":"100.1"}}', '{}'],
  ['beyond-double-precision', 'pacs008', '{"instructedAmount":{"currency":"USD","value":"123456789012345.12"},"amount":{"currency":"USD","value":"123456789012345.12"},"settlementAmount":{"currency":"USD","value":"123456789012345.13"}}', '{}'],
  ['invoice-from-e2e', 'pacs008', '{"invoiceReferences":[],"endToEndId":"E2E-77"}', '{}'],
  ['invoice-from-remittance', 'pacs008', '{"invoiceReferences":[],"endToEndId":"notprovided","remittanceInformation":["  Payment\\u3000for \\u00a0 goods ' + 'x'.repeat(45) + '\\ud83d\\ude00 and more","second line"]}', '{}'],
  ['invoice-missing', 'pacs008', '{"invoiceReferences":[],"endToEndId":"NONREF","remittanceInformation":[" "]}', '{}'],
  ['supplement-trimmed', 'pacs008', '{}', '{"supplement":{"debtor":{"name":" Vina\\u3000Trading\\ufeff ","country":"  ","registration_number":"\\u00a0","account":null},"creditor":"not an object","invoiceRef":" INV-SUP ","purposeCode":"  "}}'],
  ['supplement-everything', 'mt103', '{"debtor":{"identification":null}}', '{"supplement":{"debtor":{"name":"Vina Trading","country":"VN","address":"12 Le Loi","registration_number":"0312345678","account":"ACC-1"},"creditor":{"name":"Pacific","country":"SG","account":"SG-1","bank":"Example Bank Ltd"},"invoiceRef":"INV-2026-0478","purposeCode":"GDDS"}}'],
  ['source-of-a-batch', 'pain001', '{"transactionCount":3,"index":2,"endToEndId":"NOTPROVIDED"}', '{}'],
  ['empty-instruction-id', 'pain001', '{"instructionId":""}', '{}'],
  ['corridor-vn-us', 'pacs008', '{}', '{"corridor":{"origin":"VN","destination":"US"}}'],
  ['corridor-without-destination', 'pacs008', '{"debtor":{"country":"TH"}}', '{"corridor":{"origin":"VN"}}'],
  ['empty-trade-currency', 'pacs008', '{}', '{"tradeCurrency":""}'],
  ['inferred-countries', 'mt103', '{"debtor":{"country":null},"creditor":{"country":null},"debtorAgent":{"bic":"aaaavnvx"},"creditorAgent":{"country":"SG","memberId":"7171","clearingSystem":""}}', '{"supplement":{"debtor":{"registration_number":"1"}}}'],
  ['no-inference', 'mt103', '{"debtor":{"country":null},"creditor":{"country":null},"creditorAgent":{"country":"SG","memberId":"7171"}}', '{"inferCountryFromBic":false}'],
  ['where-it-stood', 'mt103', '{"debtor":{"countryFrom":"CtryOfRes","lei":"","identification":"0312345678"},"creditor":{"countryFrom":"field 77B /BENEFRES/"}}', '{}'],
  ['lei-stated', 'pacs008', '{"debtor":{"lei":"5493001KJTIIGC8Y1R12","countryFrom":"CtryOfRes","identificationFrom":""}}', '{}'],
  ['test-mark-without-words', 'pacs008', '{"test":{"where":"x"}}', '{}'],
  ['country-from-agent-country', 'pacs008', '{"creditor":{"country":null},"creditorAgent":{"bic":null,"name":null,"country":"SG","memberId":"026009593","clearingSystem":"SGIBG"}}', '{}'],
  ['agent-in-another-country', 'pacs008', '{"creditorAgent":{"bic":"DEMOMYKL","country":"SG"}}', '{}'],
  ['amount-of-its-own', 'pacs008', '{"amount":{"currency":"EUR","value":"10.00"},"instructedAmount":{"currency":"SGD","value":"5"},"settlementAmount":{"currency":"EUR","value":"10.00"}}', '{}'],
  ['address-with-a-gap', 'pacs008', '{"debtor":{"addressLines":[null,"Le Loi Boulevard 12",null]}}', '{}'],
  // The hardening (A1–A10): payments handed over already parsed, with values the readers never produce.
  ['past-double-precision-the-other-way', 'pacs008', '{"instructedAmount":{"currency":"USD","value":"999999999999999.99"},"amount":{"currency":"USD","value":"999999999999999.99"},"settlementAmount":{"currency":"USD","value":"999999999999999.98"}}', '{}'],
  ['instructed-not-a-decimal', 'pacs008', '{"instructedAmount":{"currency":"USD","value":"twelve"}}', '{}'],
  ['settled-not-a-decimal', 'pacs008', '{"settlementAmount":{"currency":"USD","value":"twelve"}}', '{}'],
  ['country-from-agent-country-mt', 'mt103', '{"creditor":{"country":null,"countryFrom":null},"creditorAgent":{"bic":null,"name":"DEMO PAYOUT BANK","country":"SG"}}', '{}'],
  ['remittance-cut-after-a-pair', 'pacs008', '{"invoiceReferences":[],"endToEndId":"NOTPROVIDED","remittanceInformation":["' + 'x'.repeat(63) + '\\ud83d\\ude00tail"]}', '{}'],
  ['remittance-cut-at-a-space', 'pacs008', '{"invoiceReferences":[],"endToEndId":"NOTPROVIDED","remittanceInformation":["' + 'x'.repeat(63) + ' tail"]}', '{}'],
  ['empty-lei', 'pacs008', '{"debtor":{"lei":""}}', '{}'],
  ['blank-lei', 'pacs008', '{"debtor":{"lei":"   "}}', '{}'],
  ['blank-lei-and-identification', 'pacs008', '{"debtor":{"lei":"","identification":" "}}', '{}'],
  ['blank-instruction-id', 'pain001', '{"instructionId":" ","paymentInfoId":""}', '{}'],
  ['empty-instruction-id-pacs', 'pacs008', '{"instructionId":""}', '{}'],
  ['no-instruction-reference', 'pacs008', '{"instructionId":"","messageId":""}', '{}'],
  ['blank-clearing-system', 'pacs008', '{"creditorAgent":{"memberId":"7171","clearingSystem":"  "}}', '{}'],
  ['blank-trade-currency', 'pacs008', '{}', '{"tradeCurrency":"  "}'],
  ['blank-agent-country', 'pacs008', '{"creditorAgent":{"bic":null,"country":" "}}', '{}'],
  ['empty-intermediaries', 'pacs008', '{"intermediaryAgents":[{"bic":"","name":"Correspondent Bank"},{"bic":" ","name":"","memberId":""}]}', '{}'],
  ['padded-invoices', 'pacs008', '{"invoiceReferences":[" INV-1 ","INV-1","INV-2\\n"]}', '{}'],
  ['empty-invoices', 'pacs008', '{"invoiceReferences":[""," ","INV-3"]}', '{}'],
  ['padded-invoice-supplied', 'pacs008', '{"invoiceReferences":[" INV-1 "]}', '{"supplement":{"invoiceRef":"INV-1"}}'],
  ['test-mark-live', 'mt103', '{"test":{"where":"field 23B","what":"CRTS"}}', '{"supplement":{"debtor":{"registration_number":"1"}}}'],
  ['no-reference-with-white-space', 'pacs008', '{"invoiceReferences":[],"endToEndId":"\\tnonref "}', '{}'],
  ['no-reference-line-end', 'pacs008', '{"invoiceReferences":[],"endToEndId":"NOTPROVIDED\\n"}', '{}'],
  ['padded-end-to-end-id', 'pacs008', '{"invoiceReferences":[],"endToEndId":" PO-7781\\n"}', '{}'],
];

if (what === 'all' || what === 'mapping') {
  for (const [name, b, patch, options] of mappingCases) {
    const m = mapSwiftPayment(payment(b, patch), JSON.parse(options));
    out(`${name} fields`, m.fields);
    out(`${name} issues`, m.issues);
    out(`${name} unmapped`, m.unmapped);
    out(`${name} input`, m.input ?? null);
    if (m.issues.length) console.log(`${name} error\n  ${JSON.stringify(new SwiftMappingError(m).message)}`);
  }
}

if (what === 'all' || what === 'numbers') {
  const pairs = [['0x10', '15'], ['1e1', '9.5'], ['', '5'], ['abc', '5'], ['5', 'abc'], ['.5', '0.6'], ['5.', '5.01'], [' 7 ', '8'],
    [' 7　', '8'], ['᠎7', '8'], ['0b11', '4'], ['0o7', '8'], ['0b2', '4'], ['+3', '4'], ['-3', '0'], ['Infinity', '1e400'],
    ['+Infinity', '5'], ['-Infinity', '5'], ['infinity', '5'], ['0X1F', '32'], ['-0x1', '5'], ['1_0', '20'], ['1e', '5'], ['0x', '5'],
    ['9007199254740993', '9007199254740992'], ['0.1', '0.10000000000000001'], ['1' + '0'.repeat(30), '1e30'], ['1d', '5'], ['0x1p3', '9'],
    ['١', '5'], ['１', '5'], ['NaN', '5'], ['00012', '13'], ['1.2.3', '5'], ['+.5e-3', '0.001'], ['12', '12.0'], ['0', '-0']];
  const rows: [string, string, string][] = [];
  for (const [i, s] of pairs) {
    const p = payment('pacs008', JSON.stringify({ instructedAmount: { currency: 'USD', value: i }, amount: { currency: 'USD', value: i }, settlementAmount: { currency: 'USD', value: s } }));
    const m = mapSwiftPayment(p);
    const t = m.fields.find((f) => f.target === 'trade.amount') ?? m.issues.find((x) => x.target === 'trade.amount');
    rows.push([i, s, t!.source === 'CdtTrfTxInf/InstdAmt' ? 'instructed' : 'settled']);
  }
  console.log('numbers'); console.log('  ' + JSON.stringify(JSON.stringify(rows)));
}

if (what === 'all' || what === 'ids') {
  const idCases: [string, string, string, string | undefined][] = [
    ['uetr', 'pacs008', '{}', 'VN-BANK-T1'],
    ['ids-distinct', 'pacs008', '{"uetr":null}', 'VN-BANK-T1'],
    ['ids-not-distinct', 'pacs008', '{"uetr":null,"distinctIds":false,"index":4}', 'VN-BANK-T1'],
    ['ids-unmarked', 'pacs008', '{"uetr":null,"distinctIds":null}', 'VN-BANK-T1'],
    ['ids-no-type', 'pacs008', '{"uetr":null,"messageType":null,"endToEndId":null,"valueDate":null}', 'VN-BANK-T1'],
    ['ids-instruction-only', 'mt103', '{"uetr":null,"messageId":""}', 'VN-BANK-T1'],
    ['bytes', 'pacs008', '{"uetr":"","messageId":"","instructionId":null,"index":1}', 'VN-BANK-T1'],
    ['bytes-without-digest', 'pacs008', '{"uetr":null,"messageId":null,"instructionId":null,"digest":null}', 'VN-BANK-T1'],
    ['surrogate-institution', 'pacs008', '{}', 'VN-\ud800BANK'],
    ['surrogate-reference', 'pacs008', '{"uetr":null,"messageId":"M-\udc00-1"}', 'VN-BANK-T1'],
    ['no-institution', 'pacs008', '{}', undefined],
  ];
  for (const [name, b, patch, inst] of idCases) out(`id ${name}`, swiftPaymentId(inst as string, payment(b, patch)));
  const digestCases: [string, string, string][] = [
    ['base', 'pacs008', '{}'],
    ['trailing-zeros', 'pacs008', '{"settlementAmount":{"currency":"USD","value":"12500.0"},"instructedAmount":{"currency":"USD","value":"12500"},"amount":{"currency":"USD","value":"12500.000"}}'],
    ['whitespace', 'pacs008', '{"debtor":{"name":"  Vina\\u00a0Trading \\u3000 Co.,\\nLtd.\\ufeff"}}'],
    ['no-reference', 'pacs008', '{"endToEndId":"NOTPROVIDED"}'],
    ['no-e2e', 'pacs008', '{"endToEndId":null}'],
    ['lone-surrogate', 'pacs008', '{"debtor":{"name":"Vina \\ud800 Trading"}}'],
    ['lists', 'mt103', '{"invoiceReferences":[" A ","B  C"],"remittanceInformation":["/INV/A\\r\\n/RFB/X","\\u2028"],"transactionId":" T 1 "}'],
    ['no-amounts', 'pacs008', '{"instructedAmount":null,"settlementAmount":null}'],
  ];
  for (const [name, b, patch] of digestCases) out(`digest ${name}`, swiftContentDigest(payment(b, patch)));
  const isoCases: [string, string, string][] = [
    ['mt-tags', 'mt103', '{"present":["20","20","59","50K","99Z","121","32A","33B","36","52D","56C","57D","59A","26T","77B","71A","70","23B","50A"]}'],
    ['iso-duplicates', 'pacs008', '{"present":["MsgId","PmtId","InstrId","PmtId","InstrId","Dbtr"]}'],
    ['other-format', 'mt103', '{"format":"other","present":["20","PmtId","32A"]}'],
  ];
  for (const [name, b, patch] of isoCases) out(`iso ${name}`, isoFieldNames(payment(b, patch)));
}
