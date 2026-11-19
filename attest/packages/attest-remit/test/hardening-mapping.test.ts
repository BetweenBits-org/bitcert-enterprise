/**
 * The mapping table and the client: what the Java port's testers found by
 * feeding the reference inputs nobody had tried. Each test is one fix, and
 * says what it proves; the rule they all follow is the SDK's own — refuse
 * rather than guess.
 *
 * Several inputs here are payments handed over already parsed (`submitSwift`
 * and `mapSwiftPayment` take one): the readers trim what they read, a payment
 * built by the bank's own code need not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RemitApiError, RemitClient, mapSwiftPayment, parseSwiftMessage, swiftContentDigest, swiftPaymentId,
} from '../src/index.ts';
import type { SettlementView, SwiftMapping, SwiftPayment } from '../src/index.ts';
import { compareDecimal } from '../src/swift/mapping.ts';
import { travelRuleQuestionOpen } from '../src/client.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string): string => readFileSync(path.join(HERE, '..', 'samples', name)).toString('latin1');
const PACS = readFileSync(path.join(HERE, '..', 'samples', 'pacs008.sample.xml'), 'utf8');
const pacs = (): SwiftPayment => parseSwiftMessage(PACS);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reader = (): RemitClient => new RemitClient({
  core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank', readOnly: true,
});

test('A1: of two amounts in the corridor\'s currency the smaller is found digit by digit — past fifteen significant digits too', () => {
  const amounts = (instructed: string, settled: string): SwiftPayment => parseSwiftMessage(PACS
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00<', `<IntrBkSttlmAmt Ccy="USD">${settled}<`)
    .replace('<InstdAmt Ccy="USD">12500.00<', `<InstdAmt Ccy="USD">${instructed}<`));
  const taken = (p: SwiftPayment): [string | undefined, string | undefined] => {
    const m = mapSwiftPayment(p);
    return [m.input?.tradeAmount, m.fields.find((f) => f.target === 'trade.amount')?.source];
  };
  // As floating-point numbers these are one number, and the larger one was paid.
  assert.deepEqual(taken(amounts('999999999999999.98', '999999999999999.99')), ['999999999999999.98', 'CdtTrfTxInf/InstdAmt']);
  assert.deepEqual(taken(amounts('999999999999999.99', '999999999999999.98')), ['999999999999999.98', 'CdtTrfTxInf/IntrBkSttlmAmt']);
  // What was decided before is decided the same: equal amounts written differently are the settled one.
  assert.deepEqual(taken(amounts('7010.50', '7000.50')), ['7000.50', 'CdtTrfTxInf/IntrBkSttlmAmt']);
  assert.deepEqual(taken(amounts('1000', '1015')), ['1000', 'CdtTrfTxInf/InstdAmt']);
  assert.deepEqual(taken(amounts('7000.5', '7000.50')), ['7000.50', 'CdtTrfTxInf/IntrBkSttlmAmt']);
  // An amount that is not a plain decimal cannot be put in order: it is refused by name, not passed over.
  const p = pacs();
  const odd = mapSwiftPayment({ ...p, instructedAmount: { currency: 'USD', value: 'twelve' } });
  assert.deepEqual(odd.issues.map((i) => [i.target, i.source, i.problem]),
    [['trade.amount', 'CdtTrfTxInf/InstdAmt', '"twelve" is not a positive USD amount with at most two decimals']]);
  // The comparison itself: exact, and undefined for what is not a plain decimal.
  assert.deepEqual([
    compareDecimal('999999999999999.98', '999999999999999.99'), compareDecimal('100.5', '100.50'), compareDecimal('0100', '100'),
    compareDecimal('99.999', '100'), compareDecimal('100.001', '100'), compareDecimal('0.00', '0'), compareDecimal(`1${'0'.repeat(30)}`, `9${'9'.repeat(29)}.99`),
  ], [-1, 0, 0, -1, 1, 0, 1]);
  for (const bad of ['1e3', '', '1.', '.5', '-1', ' 1', '1,5', '١٢']) assert.equal(compareDecimal(bad, '1'), undefined, JSON.stringify(bad));
});

test('A1 (quote): the quote is taken only for the amount asked, compared digit by digit', async () => {
  const quote = (amount: string) => ({
    quote_id: 'QT-1', corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount },
    settlement: { asset: 'USDC', amount, chain: 'eip155:31337' },
    collect: { currency: 'VND', amount: '1', rate: '25803', rate_pair: 'USD/VND' },
    payout: { currency: 'SGD', amount: '1', rate: '1.3350', rate_pair: 'USD/SGD' },
    fees: [], quoted_at: '2026-11-17T00:00:00.000Z', expires_at: '2026-11-17T00:10:00.000Z', required_travel_rule_fields: [],
  });
  const c = new RemitClient({ core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank',
    key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey });
  const real = globalThis.fetch;
  try {
    // Something in between answers for a cent more. As numbers the two were equal, and the bank signed it.
    globalThis.fetch = (async () => json(201, quote('999999999999999.99'))) as typeof fetch;
    await assert.rejects(c.quote('999999999999999.98'),
      (e: unknown) => e instanceof RemitApiError && e.code === 'quote_mismatch' && /nothing was signed/.test(e.message));
    // The platform writes the amount with two decimals; the same amount written so is the same amount.
    globalThis.fetch = (async () => json(201, quote('12500.00'))) as typeof fetch;
    assert.equal((await c.quote('12500')).trade.amount, '12500.00');
    assert.equal((await c.quote('12500.0')).trade.amount, '12500.00');
    await assert.rejects(c.quote('12500.001'), (e: unknown) => e instanceof RemitApiError && e.code === 'quote_mismatch');
  } finally { globalThis.fetch = real; }
});

test('A2: a beneficiary\'s country taken from its bank\'s address is labelled as that, not as the letters of a BIC', () => {
  // The beneficiary states no country; its bank has no BIC and states its country in its address.
  const noCountry = PACS.replace('<Ctry>SG</Ctry>\n        </PstlAdr>\n      </Cdtr>', '</PstlAdr>\n      </Cdtr>');
  const xml = noCountry.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>',
    '<Nm>Demo Payout Bank (SG)</Nm><PstlAdr><Ctry>SG</Ctry></PstlAdr>');
  const m = mapSwiftPayment(parseSwiftMessage(xml));
  assert.deepEqual(m.issues, []);
  assert.deepEqual(m.fields.find((f) => f.target === 'creditor.country'), {
    target: 'creditor.country', value: 'SG', basis: 'inferred',
    source: 'CdtTrfTxInf/CdtrAgt/FinInstnId/PstlAdr/Ctry (the country of the beneficiary\'s bank)',
  });
  // With a BIC, it is the BIC's letters, and says so — as before.
  assert.equal(mapSwiftPayment(parseSwiftMessage(noCountry)).fields.find((f) => f.target === 'creditor.country')!.source,
    'CdtTrfTxInf/CdtrAgt/FinInstnId (country letters of the BIC)');
  // An MT103 handed over already parsed: the field, and what it was taken as.
  const mt = parseSwiftMessage(sample('mt103.structured.sample.txt'));
  const fromAgent = mapSwiftPayment({
    ...mt, creditor: { ...mt.creditor, country: undefined, countryFrom: undefined }, creditorAgent: { name: 'DEMO PAYOUT BANK', country: 'SG' },
  });
  assert.deepEqual(fromAgent.issues, []);
  assert.equal(fromAgent.fields.find((f) => f.target === 'creditor.country')!.source,
    'field 57a or the receiver BIC (the country of the beneficiary\'s bank)');
  // Told not to infer, it does not — from either.
  assert.deepEqual(mapSwiftPayment(parseSwiftMessage(xml), { inferCountryFromBic: false }).issues.map((i) => i.target), ['creditor.country']);
});

test('A3: the first remittance line is cut at 64 characters counted by code point — never inside a surrogate pair', () => {
  const remitting = (line: string): string | undefined => mapSwiftPayment(parseSwiftMessage(PACS
    .replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>')
    .replace(/<Strd>[\s\S]*<\/Strd>/, `<Ustrd>${line}</Ustrd>`))).input?.invoiceRef;
  // The 64th character is a pair of UTF-16 units. Cut by unit, its first half was signed into the instruction.
  const at64 = remitting(`${'x'.repeat(63)}\u{1F600}tail`)!;
  assert.equal(at64, `${'x'.repeat(63)}\u{1F600}`);
  assert.doesNotMatch(at64, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no half of a pair');
  assert.equal(remitting(`${'x'.repeat(64)}\u{1F600}`), 'x'.repeat(64));
  assert.equal(remitting('\u{1F600}'.repeat(70)), '\u{1F600}'.repeat(64));
  // Collapsed and trimmed as before, and a cut that ends on a space does not keep it.
  assert.equal(remitting('SPARE   PARTS'), 'SPARE PARTS');
  assert.equal(remitting(`${'x'.repeat(63)} tail`), 'x'.repeat(63));
});

test('A4: an empty LEI is no LEI — the identification the message does state is taken', () => {
  const p = pacs();
  for (const lei of ['', '   ']) {
    const m = mapSwiftPayment({ ...p, debtor: { ...p.debtor, lei } });
    assert.deepEqual(m.issues, [], JSON.stringify(lei));
    assert.deepEqual(m.fields.find((f) => f.target === 'debtor.registration_number'), {
      target: 'debtor.registration_number', value: '0312345678', source: 'CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID', basis: 'stated',
    });
  }
  // An LEI that says something comes first, and is labelled as the LEI.
  const lei = mapSwiftPayment({ ...p, debtor: { ...p.debtor, lei: '9845003X7Y4K2B1Q8W63' } });
  assert.deepEqual([lei.input!.parties.debtor.registration_number, lei.fields.find((f) => f.target === 'debtor.registration_number')!.source],
    ['9845003X7Y4K2B1Q8W63', 'CdtTrfTxInf/Dbtr/Id/OrgId/LEI']);
  // Nothing but empty values is still nothing: refused, naming what is missing.
  assert.deepEqual(mapSwiftPayment({ ...p, debtor: { ...p.debtor, lei: '', identification: ' ' } }).issues.map((i) => i.target),
    ['debtor.registration_number']);
});

test('A5: an empty instruction id does not hide the payment-information id or the message id', () => {
  const pain = parseSwiftMessage(sample('pain001.sample.xml'));
  const ref = (p: SwiftPayment): string | undefined => mapSwiftPayment(p).input!.instructionRef;
  assert.equal(ref(pain), 'VINATRD-INS-0031-1');
  assert.equal(ref({ ...pain, instructionId: '' }), 'VINATRD-PMT-0031');
  assert.equal(ref({ ...pain, instructionId: ' ', paymentInfoId: '' }), 'VINATRD-20261117-0031');
  assert.equal(ref({ ...pacs(), instructionId: '' }), 'DEMOVNVX20261117000123');
  // None at all: none is invented here — the client's own default applies.
  assert.equal(ref({ ...pacs(), instructionId: '', messageId: '' }), undefined);
});

test('A6: a member id under an empty clearing system is a "clearing member", with one space', () => {
  const p = pacs();
  const bank = (agent: NonNullable<SwiftPayment['creditorAgent']>): string => mapSwiftPayment({ ...p, creditorAgent: agent }).input!.parties.creditor.bank;
  for (const clearingSystem of [undefined, '', '  ']) {
    assert.equal(bank({ name: 'Demo Payout Bank (SG)', bic: 'DEMOSGSG', memberId: '7171', clearingSystem }),
      'Demo Payout Bank (SG) · BIC DEMOSGSG · clearing member 7171', JSON.stringify(clearingSystem));
  }
  assert.equal(bank({ name: 'Demo Payout Bank (SG)', memberId: '7171', clearingSystem: 'SGIBG' }), 'Demo Payout Bank (SG) · SGIBG 7171');
});

test('A4–A6 (sweep): every other value the mapping falls back from is no value when it is empty', () => {
  const p = pacs();
  // An empty trade currency is the default one, not a corridor in "" that refuses every message.
  const usd = mapSwiftPayment(p, { tradeCurrency: '' });
  assert.deepEqual([usd.issues, usd.input!.tradeCurrency], [[], 'USD']);
  // A blank country of the beneficiary's bank states no country: it is not a bank "in  ".
  const blank = mapSwiftPayment({ ...p, creditorAgent: { name: 'Demo Payout Bank (SG)', country: ' ' } });
  assert.deepEqual(blank.issues, []);
  // An intermediary is named by what it does state.
  const via = mapSwiftPayment({ ...p, intermediaryAgents: [{ bic: '', name: 'Correspondent Bank' }, { bic: ' ', name: '', memberId: '' }] });
  assert.deepEqual(via.unmapped.filter((u) => u.source === 'IntrmyAgt1…3').map((u) => u.value), ['Correspondent Bank', '?']);
});

test('A7: the invoice taken is compared trimmed, as it was taken — it is not also listed as a further invoice', () => {
  const p = pacs();
  const further = (m: SwiftMapping): string[] => m.unmapped
    .filter((u) => u.source === 'CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)').map((u) => u.value);
  const padded = mapSwiftPayment({ ...p, invoiceReferences: [' INV-1 '] });
  assert.deepEqual([padded.input!.invoiceRef, further(padded)], ['INV-1', []]);
  const several = mapSwiftPayment({ ...p, invoiceReferences: [' INV-1 ', 'INV-1', 'INV-2\n'] });
  assert.deepEqual([several.input!.invoiceRef, further(several)], ['INV-1', ['INV-2\n']]);
  // An empty entry is no invoice: neither the one taken nor a further one.
  const empty = mapSwiftPayment({ ...p, invoiceReferences: ['', ' ', 'INV-3'] });
  assert.deepEqual([empty.input!.invoiceRef, further(empty)], ['INV-3', []]);
  // The same reference from the customer master is the same reference.
  const supplied = mapSwiftPayment({ ...p, invoiceReferences: [' INV-1 '] }, { supplement: { invoiceRef: 'INV-1' } });
  assert.deepEqual([supplied.fields.find((f) => f.target === 'invoice_ref')!.basis, further(supplied)], ['supplied', []]);
});

test('A8: a test message that a live key refuses is not also said to be taken', async () => {
  const crts = sample('mt103.structured.sample.txt').replace(':23B:CRED', ':23B:CRTS');
  const live = mapSwiftPayment(parseSwiftMessage(crts));
  assert.deepEqual(live.issues.map((i) => [i.target, i.source]), [['instruction', 'field 23B']]);
  assert.deepEqual(live.unmapped.filter((u) => u.source === 'field 23B'), [], 'refused, and nothing says otherwise');
  const withTestKey = mapSwiftPayment(parseSwiftMessage(crts), { allowTestMessages: true });
  assert.deepEqual(withTestKey.issues, []);
  assert.deepEqual(withTestKey.unmapped.filter((u) => u.source === 'field 23B').map((u) => [u.value, /taken because this client uses a test key/.test(u.why)]),
    [['CRTS', true]]);
  // As the client decides it, by its key.
  const as = (apiKey: string): RemitClient => new RemitClient({ core: 'http://platform.test', apiKey, institutionId: 'VN-BANK-T1', institutionName: 'Test Bank', readOnly: true });
  const byLive = await as('sk_live_x').inspectSwift(crts);
  assert.deepEqual([byLive.issues.length, byLive.unmapped.some((u) => u.source === 'field 23B')], [1, false]);
  const byTest = await as('sk_test_x').inspectSwift(crts);
  assert.deepEqual([byTest.issues.length, byTest.unmapped.some((u) => u.source === 'field 23B')], [0, true]);
});

test('A9: without a UETR, an end-to-end id written NOTPROVIDED and one left out name the same payment', () => {
  const noUetr = PACS.replace(/\s*<UETR>[^<]+<\/UETR>/, '');
  const written = (e2e: string): SwiftPayment => parseSwiftMessage(noUetr.replace('<EndToEndId>PO-7781</EndToEndId>', `<EndToEndId>${e2e}</EndToEndId>`));
  const leftOut: SwiftPayment = { ...written('NOTPROVIDED'), endToEndId: undefined };
  const id = swiftPaymentId('VN-BANK-T1', leftOut);
  for (const word of ['NOTPROVIDED', 'notprovided', 'NONREF', 'NoRef']) assert.equal(swiftPaymentId('VN-BANK-T1', written(word)), id, word);
  // Handed over already parsed: white space around the word, or nothing but white space, is no reference either.
  for (const e2e of [' NOTPROVIDED', 'NOTPROVIDED\n', '\tnonref ', '', '  ']) {
    assert.equal(swiftPaymentId('VN-BANK-T1', { ...leftOut, endToEndId: e2e }), id, JSON.stringify(e2e));
  }
  // A real end-to-end id still tells two payments apart; a word that only contains one of them is a real id.
  assert.notEqual(swiftPaymentId('VN-BANK-T1', written('PO-7781')), id);
  assert.notEqual(swiftPaymentId('VN-BANK-T1', written('NOTPROVIDED-1')), id);
  // A message with a UETR keeps the form it had: the UETR's first group, then a hash of the institution and the UETR.
  const uetr = '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10';
  const hash = createHash('sha256').update(`VN-BANK-T1\nuetr|${uetr}`).digest('hex');
  const withUetr = parseSwiftMessage(PACS.replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>'));
  assert.equal(swiftPaymentId('VN-BANK-T1', withUetr), `PAY-3f1c9a52-${hash.slice(0, 10)}`);
  assert.equal(swiftPaymentId('VN-BANK-T1', pacs()), `PAY-3f1c9a52-${hash.slice(0, 10)}`);
  for (const p of [leftOut, written('PO-7781'), withUetr]) assert.equal(swiftPaymentId('VN-BANK-T1', p).length, 23);
});

test('A10: a word for "no reference" with white space around it is still no reference — and never the invoice', () => {
  const p = pacs();
  const none: SwiftPayment = { ...p, endToEndId: undefined };
  for (const e2e of [' NOTPROVIDED', 'NOTPROVIDED\n', '\tnonref ', 'NOREF\r\n']) {
    const m = mapSwiftPayment({ ...p, endToEndId: e2e, invoiceReferences: [] });
    // Nothing else names the commercial basis: refused for that — not paid against "NOTPROVIDED".
    assert.deepEqual(m.issues.map((i) => i.target), ['invoice_ref'], JSON.stringify(e2e));
    assert.equal(m.fields.some((f) => f.target === 'sourceMessage.endToEndId' || f.target === 'invoice_ref'), false);
    // The content digest and the payment id read it the same way.
    assert.equal(swiftContentDigest({ ...p, endToEndId: e2e }), swiftContentDigest(none));
  }
  // A real end-to-end id is taken trimmed — as the invoice, and as the reference the instruction cites.
  const padded = mapSwiftPayment({ ...p, endToEndId: ' PO-7781\n', invoiceReferences: [] });
  assert.deepEqual([padded.input!.invoiceRef, padded.input!.source.endToEndId], ['PO-7781', 'PO-7781']);
  assert.deepEqual(padded.fields.find((f) => f.target === 'invoice_ref'), {
    target: 'invoice_ref', value: 'PO-7781', source: 'end-to-end identification (no invoice reference in the message)', basis: 'inferred',
  });
});

test('C1: RemitApiError names itself, as the SDK\'s other errors do', async () => {
  const e = new RemitApiError(409, 'reference_reused', 'already on another payment');
  assert.deepEqual([e.name, String(e), e instanceof Error], ['RemitApiError', 'RemitApiError: already on another payment', true]);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => json(404, { error: 'not_found', message: 'no such settlement' })) as typeof fetch;
  try {
    await assert.rejects(reader().status('PAY-none'), (x: unknown) => x instanceof RemitApiError && x.name === 'RemitApiError' && x.code === 'not_found');
  } finally { globalThis.fetch = real; }
});

test('C2: a second question, asked after an earlier answer, is open — and track() stops for the bank to answer it', async () => {
  const events = (...types: string[]): SettlementView['events'] => ['REQUEST_ACCEPTED', 'BANK_EVIDENCE_SUBMITTED', 'TRAVEL_RULE_SENT', ...types]
    .map((type, seq) => ({ seq, type, issuer: 'X', at: `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`, payload: {}, sig: null }));
  const RFI = 'TRAVEL_RULE_RFI';
  const ANSWERED = ['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED'];
  assert.equal(travelRuleQuestionOpen(events()), false);
  assert.equal(travelRuleQuestionOpen(events(RFI)), true);
  assert.equal(travelRuleQuestionOpen(events(RFI, ...ANSWERED)), false);
  // The case that was missed: answered once, asked again.
  assert.equal(travelRuleQuestionOpen(events(RFI, ...ANSWERED, RFI)), true);
  assert.equal(travelRuleQuestionOpen(events(RFI, 'TRAVEL_RULE_RFI_RESOLVED', RFI)), true);
  // Each of the three closing events closes it on its own.
  for (const closing of ['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_REJECTED']) {
    assert.equal(travelRuleQuestionOpen(events(RFI, closing)), false, closing);
  }

  // track() against a platform whose settlement shows the second question: it returns, it does not wait it out.
  const views: SettlementView[] = [];
  const view = (state: string, ev: SettlementView['events']): SettlementView => ({
    payment_id: 'PAY-1', state, evidence_level: null, evidence_available: false, chain_tx: null, attestation: null, events: ev,
  });
  const real = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = (async () => json(200, views[Math.min(asked++, views.length - 1)])) as typeof fetch;
  try {
    views.push(view('TRAVEL_RULE_PENDING', events(RFI, ...ANSWERED, RFI)));
    const paused = await reader().track('PAY-1', { intervalMs: 5, timeoutMs: 1_000 });
    assert.deepEqual([paused.state, asked], ['TRAVEL_RULE_PENDING', 1]);
    // A question that has been answered is not a pause: track() goes on until the payment moves.
    views.length = 0;
    asked = 0;
    views.push(view('TRAVEL_RULE_PENDING', events(RFI, ...ANSWERED)), view('EVIDENCE_ANCHORED', events(RFI, ...ANSWERED)));
    const seen: string[] = [];
    const done = await reader().track('PAY-1', { intervalMs: 5, timeoutMs: 1_000, onState: (s) => seen.push(s) });
    assert.deepEqual([done.state, seen], ['EVIDENCE_ANCHORED', ['TRAVEL_RULE_PENDING', 'EVIDENCE_ANCHORED']]);
  } finally { globalThis.fetch = real; }
});
