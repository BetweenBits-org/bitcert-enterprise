// Differential fuzz after the hardening (A1–A10), reference side — gen.ts with mutations dense in the values
// the hardening is about (empty and untrimmed strings, plain and malformed decimals, cuts at a surrogate pair).
// Differential fuzz, reference side: mutated golden payments and options → what the TypeScript SDK answers.
// Writes one JSON line per case: { payment, options, expect: { mapping | threw, error?, digest, ids, iso } }.
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { isoFieldNames, swiftPaymentId, mapSwiftPayment, swiftContentDigest, SwiftMappingError } from '../../../../../packages/attest-remit/src/index.ts';

const GOLDEN = fileURLToPath(new URL('../../../src/test/resources/golden', import.meta.url));
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node gen2.ts <output file> [cases, default 4000] [seed, default 1]'); process.exit(2); }
const N = Number(process.argv[3] ?? 4000);
const SEED = Number(process.argv[4] ?? 1);

let s = SEED >>> 0;
const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const parse = JSON.parse(readFileSync(`${GOLDEN}/parse.json`, 'utf8'));
const bases: any[] = [];
for (const c of parse.cases) if (c.expect.payments) bases.push(...c.expect.payments);

const U = undefined;
const WS = ['', ' ', '  ', '　', '﻿', ' ', ' ', '\t', '\n', '᠎', '\u0085', '​'];
const ws = (): string => pick(WS);
const str = (xs: (string | undefined)[]) => (): string | undefined => pick(xs);
const set = (o: any, k: string, v: any) => { if (v === U) delete o[k]; else o[k] = v; };
const amountValues = ['12500.00', '12500', '12500.5', '12500.50', '0.00', '0', '00.10', '12.345', '1e3', '', ' 12 ', '123456789012345.12',
  '123456789012345.13', '0x10', 'Infinity', 'abc', '.5', '5.', '007.50', '12499.99', '12500.001', '100.10', '1000', '99999999999999999999'];
const currencies = ['USD', 'EUR', 'VND', 'SGD'];
const amount = () => ({ currency: pick(currencies), value: pick(amountValues) });
const decimalPairs: [string, string][] = [
  ['999999999999999.98', '999999999999999.99'], ['123456789012345.12', '123456789012345.13'], ['9007199254740992', '9007199254740993'],
  ['0.1', '0.10000000000000001'], ['00012', '13'], ['0100', '100'], ['007.50', '7.5'], ['7000.5', '7000.50'], ['99.999', '100'],
  ['12499.995', '12500'], ['0.00', '0'], ['1' + '0'.repeat(30), '9'.repeat(30) + '.99'], ['twelve', '12500.00'], ['12500.00', 'twelve'],
  ['1e3', '1e2'], ['', ''], [' 7 ', '8'], ['0', '-0'], ['12', '12.0'], ['1000', '1015'], ['0x10', '15'],
];
const longLine = 'A'.repeat(62) + '😀' + 'tail of the line beyond sixty-four';

const mutations: ((p: any) => void)[] = [
  (p) => set(p, 'uetr', pick([U, '', '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', 'ABCDEF12-0000-4000-8000-000000000000', 'short'])),
  (p) => set(p, 'messageId', pick([U, '', 'MSG-1', ' MSG-1 ', 'M\ud800X'])),
  (p) => set(p, 'instructionId', pick([U, '', 'INSTR-1', 'INSTR-1 '])),
  (p) => set(p, 'endToEndId', pick([U, '', 'NOTPROVIDED', 'notprovided', 'NONREF', 'NOREF', 'NOTPROVIDED\n', ' NOTPROVIDED', 'NOTPROVIDEDX', 'E2E-1', ' E2E 1 '])),
  (p) => set(p, 'transactionId', pick([U, '', 'TX-1', ' TX　1 '])),
  (p) => set(p, 'paymentInfoId', pick([U, '', 'PMT-1'])),
  (p) => set(p, 'valueDate', pick([U, '', '2026-11-17', '2026-11-18'])),
  (p) => set(p, 'messageType', pick([U, '', 'pacs.008.001.08', 'MT103'])),
  (p) => set(p, 'digest', pick([U, '', 'a'.repeat(64)])),
  (p) => set(p, 'distinctIds', pick([U, true, false])),
  (p) => { p.transactionCount = pick([1, 2, 3]); p.index = pick([0, 1, 2]); },
  (p) => set(p, 'settlementAmount', pick([U, amount(), amount()])),
  (p) => set(p, 'instructedAmount', pick([U, amount(), amount()])),
  (p) => { p.amount = amount(); },
  (p) => { const v = pick(amountValues); p.settlementAmount = { currency: 'USD', value: v }; p.instructedAmount = { currency: 'USD', value: pick(amountValues) }; p.amount = p.instructedAmount; },
  (p) => { p.settlementAmount = { currency: 'USD', value: '123456789012345.13' }; p.instructedAmount = { currency: 'USD', value: '123456789012345.12' }; p.amount = p.instructedAmount; },
  (p) => { p.settlementAmount = { currency: pick(currencies), value: '100.10' }; p.instructedAmount = { currency: pick(currencies), value: '100.1' }; p.amount = p.instructedAmount; },
  (p) => set(p, 'chargeBearer', pick([U, '', 'DEBT', 'CRED', 'SHAR'])),
  (p) => set(p, 'exchangeRate', pick([U, '', '1.2345'])),
  (p) => { p.charges = pick([[], ['USD 10.00'], ['a', 'b']]); },
  (p) => set(p, 'test', pick([U, { where: 'field 23B', what: 'CRTS' }, { where: 'x' }, { what: 'y' }, {}])),
  (p) => set(p.debtor, 'name', pick([U, '', '  ', ` Name${ws()}`, '﻿Name', 'A B', `${ws()}Vina${ws()}`])),
  (p) => set(p.debtor, 'country', pick([U, 'VN', 'TH', '', 'vn', ' VN '])),
  (p) => set(p.debtor, 'countryFrom', pick([U, 'field 77B /ORDERRES/', 'CtryOfRes', ''])),
  (p) => { p.debtor.addressLines = pick([[], ['a'], ['a', 'b'], ['  '], [' x ', ''], ['　']]); },
  (p) => set(p.debtor, 'lei', pick([U, '', '  ', '5493001KJTIIGC8Y1R12'])),
  (p) => set(p.debtor, 'identification', pick([U, '', '0312345678', ' 0312345678　'])),
  (p) => set(p.debtor, 'identificationScheme', pick([U, '', 'TXID'])),
  (p) => set(p.debtor, 'identificationFrom', pick([U, '', 'Id/PrvtId/Othr/Id', 'field 50F party identifier', 'Id/OrgId/Othr/Id'])),
  (p) => set(p.debtor, 'person', pick([U, true, false])),
  (p) => set(p.debtor, 'bic', pick([U, '', 'AAAAVNVX'])),
  (p) => set(p.debtor, 'account', pick([U, '', ' ACC ', 'VN-ACC-1'])),
  (p) => set(p.creditor, 'name', pick([U, '', '  ', 'Pacific Supply ', 'P😀'])),
  (p) => set(p.creditor, 'country', pick([U, 'SG', 'US', '', ' SG'])),
  (p) => set(p.creditor, 'countryFrom', pick([U, 'field 77B /BENEFRES/', 'CtryOfRes', ''])),
  (p) => set(p.creditor, 'person', pick([U, true, false])),
  (p) => set(p.creditor, 'account', pick([U, '', ' SG-ACC '])),
  (p) => set(p, 'debtorAgent', pick([U, { bic: 'AAAAVNVX' }, { bic: 'aaaavnvx' }, { bic: 'AAAATHBK' }, { bic: 'bad' }, { bic: '' }, {}])),
  (p) => set(p, 'creditorAgent', pick([U, { bic: 'DEMOSGSG', name: 'Bank' }, { name: 'Bank' }, { memberId: '026009593', clearingSystem: 'USABA' },
    { memberId: '1', clearingSystem: '' }, { memberId: '1' }, { country: 'SG' }, { country: 'US' }, { country: '' }, { bic: 'AAAAUS33' },
    { name: '', bic: 'DEMOSGSG' }, { name: ' Bank ', bic: 'DEMOSGSGXXX', memberId: '7', clearingSystem: 'SGIBG' }, { bic: 'demosgsg', country: 'US' }, {}])),
  (p) => { p.intermediaryAgents = pick([[], [{ bic: 'A' }], [{ name: 'N' }], [{ memberId: 'M' }], [{}], [{ bic: '' }], [{ name: 'N', memberId: 'M' }, { bic: 'B' }]]); },
  (p) => set(p, 'purpose', pick([U, '', 'GDDS', '  GDDS '])),
  (p) => { p.remittanceInformation = pick([[], ['short'], ['x'.repeat(100)], [longLine], ['  a   b  '], [''], ['　'], ['first', 'second'], ['A'.repeat(63) + '😀']]); },
  (p) => { p.invoiceReferences = pick([[], ['INV-1'], [' INV-1 '], ['INV-1', 'INV-2'], ['INV-1', 'INV-1'], ['', 'INV-2'], ['  ']]); },
  (p) => { p.otherDocuments = pick([[], ['PUOR PO-1'], ['A', 'B']]); },
  (p) => { p.regulatoryReporting = pick([[], ['X'], ['X', 'Y']]); },
  (p) => { p.present = [...p.present, ...pick([['77T'], ['72'], ['23E'], ['UltmtDbtr'], ['UltmtCdtr', 'InstrForCdtrAgt'], ['InstrForNxtAgt'], ['PmtId'], ['PmtId', 'PmtId'], ['99Z'], ['50K', '59', '121'], ['20', '20'], ['constructorX']])]; },
  (p) => { p.format = pick(['MT103', 'pacs.008', 'pain.001', 'other']); },
  (p) => { p.uetr = U; p.messageId = pick([U, '']); p.instructionId = pick([U, '']); },
  (p) => { p.uetr = U; p.messageId = pick([U, 'M', '']); p.instructionId = pick([U, 'I']); p.distinctIds = pick([U, true, false]); },
  (p) => { if (rnd() < 0.3) delete p.amount; },

  // ── The hardening (A1–A10): values the readers never produce, in a payment handed over already parsed.
  (p) => { const pair = pick(decimalPairs); p.instructedAmount = { currency: 'USD', value: pair[0] }; p.settlementAmount = { currency: 'USD', value: pair[1] }; p.amount = { ...p.instructedAmount }; },
  (p) => { const pair = pick(decimalPairs); p.settlementAmount = { currency: 'USD', value: pair[0] }; p.instructedAmount = { currency: 'USD', value: pair[1] }; p.amount = { ...p.instructedAmount }; },
  (p) => set(p.debtor, 'lei', pick(['', '   ', '　', ' 5493001KJTIIGC8Y1R12 ', '\t'])),
  (p) => set(p.debtor, 'identification', pick(['', ' ', '\n', ' 0312345678 '])),
  (p) => { p.debtor.lei = pick(['', ' ']); p.debtor.identification = pick(['', ' ', U]); },
  (p) => set(p, 'instructionId', pick(['', ' ', '\t', ' INS-1 '])),
  (p) => set(p, 'paymentInfoId', pick(['', ' ', 'PMT-9', ' PMT-9 '])),
  (p) => set(p, 'messageId', pick(['', ' ', ' MSG-9 '])),
  (p) => { p.instructionId = pick(['', ' ', U]); p.paymentInfoId = pick(['', ' ', U, 'PMT-2']); p.messageId = pick(['', ' ', U, 'MSG-2']); },
  (p) => { p.creditorAgent = { ...(p.creditorAgent ?? {}), memberId: pick(['7171', '', ' ']), clearingSystem: pick(['', '  ', '　', ' SGIBG ', 'USABA', U]) }; },
  (p) => { p.creditorAgent = { ...(p.creditorAgent ?? {}), country: pick([' ', '', '　', ' SG ', ' MY ', 'SG', 'US']) }; if (rnd() < 0.6) delete p.creditorAgent.bic; },
  (p) => { p.creditor.country = U; p.creditor.countryFrom = U; p.creditorAgent = pick([{ name: 'B', country: 'SG' }, { name: 'B', country: ' SG ' }, { country: ' ' }, { bic: 'DEMOSGSG', country: 'MY' }, { bic: '', country: 'SG' }, { bic: 'bad', country: 'SG' }]); },
  (p) => { p.intermediaryAgents = pick([[{ bic: '', name: 'Correspondent Bank' }, { bic: ' ', name: '', memberId: '' }], [{ bic: ' INTM ' }], [{ name: '　', memberId: ' 021000021' }], [{ bic: '\n', name: '\t' }], [{ bic: '' }]]); },
  (p) => { p.invoiceReferences = pick([[' INV-1 '], ['', ' ', 'INV-3'], [' INV-1 ', 'INV-1', 'INV-2\n'], ['　'], ['', ''], ['INV-1', ' INV-1', 'INV-1 ']]); },
  (p) => set(p, 'endToEndId', pick([' NOTPROVIDED', 'NOTPROVIDED\n', '\tnonref ', 'NOREF\r\n', ' PO-7781\n', '　NoRef﻿', '  ', 'NOTPROVIDED-1', ' NOTPROVIDED X'])),
  (p) => { p.remittanceInformation = pick([['x'.repeat(63) + '\u{1F600}tail'], ['x'.repeat(64) + '\u{1F600}'], ['\u{1F600}'.repeat(70)], ['SPARE   PARTS'], ['x'.repeat(63) + ' tail'], ['x'.repeat(62) + '\u{1F600} tail'], ['x'.repeat(63) + '　 tail'], ['x'.repeat(63) + '\ud800tail'], ['x'.repeat(63) + '\udc00\ud83dtail'], [' ' + 'y'.repeat(70)]]); if (rnd() < 0.7) { p.invoiceReferences = []; p.endToEndId = pick(['NOTPROVIDED', U, ' nonref ']); } },
];

const supplements = [
  U, {}, { debtor: { registration_number: '0312345678' } }, { debtor: { name: '  ', country: 'VN' } }, { debtor: 'x' }, { creditor: { bank: 'Demo Payout Bank' } },
  { invoiceRef: ' INV-X ' }, { purposeCode: '' }, { debtor: null }, { debtor: { account: 'A' } }, { invoiceRef: 'INV-1' }, { creditor: ['x'] },
  { debtor: { registration_number: '0312345678', country: 'TH' }, creditor: { country: 'SG', name: '　' } }, { creditor: { country: 'US' } },
  { debtor: { name: 'N', country: 'VN', address: 'A', registration_number: 'R' }, creditor: { name: 'C', country: 'SG', account: 'X', bank: 'B' }, invoiceRef: 'I', purposeCode: 'P' },
  { debtor: { name: 5 } }, { invoiceRef: true }, { debtor: { country: ['VN'] } }, { debtor: { name: null } }, { creditor: { bank: {} } },
];
const optionMutations: ((o: any) => void)[] = [
  (o) => set(o, 'supplement', pick(supplements)),
  (o) => set(o, 'tradeCurrency', pick([U, 'EUR', 'VND', '', 'USD', '  ', ' USD ', ' EUR ', '\u3000'])),
  (o) => set(o, 'inferCountryFromBic', pick([U, false, true])),
  (o) => set(o, 'allowTestMessages', pick([U, true, false])),
  (o) => set(o, 'corridor', pick([U, { origin: 'VN', destination: 'US' }, { origin: 'TH', destination: 'SG' }, { origin: 'VN' }, { origin: 'VN', destination: 'SG' }])),
];

const lines: string[] = [];
let throws = 0;
let identityChecks = 0;
for (let n = 0; n < N; n++) {
  const p = clone(pick(bases));
  const k = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < k; i++) pick(mutations)(p);
  const o: any = {};
  const ko = Math.floor(rnd() * 4);
  for (let i = 0; i < ko; i++) pick(optionMutations)(o);
  const pj = JSON.parse(JSON.stringify(p));
  const oj = JSON.parse(JSON.stringify(o));
  const expect: any = {};
  try {
    const m = mapSwiftPayment(clone(pj), clone(oj));
    expect.mapping = JSON.parse(JSON.stringify({ fields: m.fields, issues: m.issues, unmapped: m.unmapped, input: m.input }));
    if (m.issues.length) expect.error = new SwiftMappingError(m).message;
    // The readers link amount to the instructed (else the settled) object; the answer must not depend on it.
    const linked = clone(pj);
    const same = (a: any, b: any) => a && b && a.currency === b.currency && a.value === b.value;
    if (same(linked.amount, linked.instructedAmount)) linked.amount = linked.instructedAmount;
    else if (!linked.instructedAmount && same(linked.amount, linked.settlementAmount)) linked.amount = linked.settlementAmount;
    const m2 = mapSwiftPayment(linked, clone(oj));
    identityChecks++;
    if (JSON.stringify({ fields: m2.fields, issues: m2.issues, unmapped: m2.unmapped, input: m2.input }) !== JSON.stringify({ fields: m.fields, issues: m.issues, unmapped: m.unmapped, input: m.input })) {
      console.error('IDENTITY MATTERS', JSON.stringify(pj));
    }
  } catch (e) {
    throws++;
    expect.threw = (e as Error).name;
  }
  expect.digest = swiftContentDigest(clone(pj));
  expect.ids = { 'VN-BANK-T1': swiftPaymentId('VN-BANK-T1', clone(pj)), 'VN-B\ud800': swiftPaymentId('VN-B\ud800', clone(pj)) };
  expect.iso = isoFieldNames(clone(pj));
  lines.push(JSON.stringify({ payment: pj, options: oj, expect }));
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${N} cases written to ${OUT}; ${throws} threw; ${identityChecks} identity checks`);
