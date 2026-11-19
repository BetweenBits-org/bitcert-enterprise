/**
 * SWIFT messages in, ISO 20022 status out.
 *
 * The samples under `samples/` are what the guide tells a bank to try first,
 * so they are also the fixtures: if a sample stops reading the way the guide
 * says, this file fails before a customer finds out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml, XmlError, findFirst, textAt } from '../src/swift/xml.ts';
import {
  SwiftMappingError, SwiftMessageError, buildPacs002, isoFieldNames, mapSwiftPayment,
  parseSwiftMessage, parseSwiftMessages, sourceMessageOf, swiftContentDigest, swiftPaymentId, swiftStatusOf, SWIFT_STATUS_TABLE,
} from '../src/index.ts';
import type { StatusView } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string): Buffer => readFileSync(path.join(HERE, '..', 'samples', name));
const parties = JSON.parse(sample('parties.sample.json').toString('utf8')) as Record<string, { debtor?: Record<string, string> }>;

// ── The XML reader ─────────────────────────────────────────────────────────

test('xml: namespaces, prefixes, CDATA, comments and entities are read', () => {
  const root = parseXml(`<?xml version="1.0"?>
    <!-- a comment with <tags> in it -->
    <e:Envelope xmlns:e="urn:env" xmlns="urn:default">
      <Doc a="1 &amp; 2" e:b='x'><![CDATA[5 < 6 & more]]> tail &lt;ok&gt; &#x41;&#66;</Doc>
      <Empty/>
    </e:Envelope>`);
  assert.equal(root.name, 'Envelope');
  assert.equal(root.ns, 'urn:env');
  const doc = findFirst(root, 'Doc')!;
  assert.equal(doc.ns, 'urn:default');
  assert.equal(doc.attrs.a, '1 & 2');
  assert.equal(doc.attrs.b, undefined, 'an attribute with a prefix belongs to another vocabulary and is not kept');
  assert.equal(doc.text.trim(), '5 < 6 & more tail <ok> AB');
  assert.equal(textAt(root, 'Empty'), undefined);
});

test('xml: a document type declaration is refused, and so is anything that is not well formed', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'), XmlError);
  assert.throws(() => parseXml('<a>&undefined;</a>'), /not defined/);
  assert.throws(() => parseXml('<a>R & D</a>'), /&amp;/);
  assert.throws(() => parseXml('<a><b></a></b>'), /closes/);
  assert.throws(() => parseXml('<a></a><b></b>'), /second root/);
  assert.throws(() => parseXml('<a><b>'), /never closed/);
  assert.throws(() => parseXml('<p:a/>'), /not declared/);
  assert.throws(() => parseXml(`<a>${'<b>'.repeat(70)}`), /nested deeper/);
});

// ── pacs.008 ───────────────────────────────────────────────────────────────

test('pacs.008: the sample reads field for field', () => {
  const bytes = sample('pacs008.sample.xml');
  const p = parseSwiftMessage(bytes);
  assert.equal(p.format, 'pacs.008');
  assert.equal(p.messageType, 'pacs.008.001.08');
  assert.equal(p.digest, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(p.messageId, 'DEMOVNVX20261117000123');
  assert.equal(p.instructionId, 'OUT-2026-000123');
  assert.equal(p.endToEndId, 'PO-7781');
  assert.equal(p.uetr, '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10');
  assert.deepEqual(p.amount, { currency: 'USD', value: '12500.00' });
  assert.equal(p.valueDate, '2026-11-17');
  assert.equal(p.chargeBearer, 'DEBT');
  assert.equal(p.debtor.name, 'Vina Trading Co., Ltd.');
  assert.equal(p.debtor.country, 'VN');
  assert.deepEqual(p.debtor.addressLines, ['Le Loi Boulevard 12', 'District 1', 'Ho Chi Minh City']);
  assert.equal(p.debtor.identification, '0312345678');
  assert.equal(p.debtor.identificationScheme, 'TXID');
  assert.equal(p.debtor.account, 'VN-ACC-000777');
  assert.equal(p.debtorAgent?.bic, 'DEMOVNVX');
  assert.equal(p.creditor.name, 'Pacific Supply Pte Ltd');
  assert.equal(p.creditor.country, 'SG');
  assert.equal(p.creditor.account, 'SG-ACC-000009');
  assert.deepEqual(p.creditorAgent, { bic: 'DEMOSGSG', name: 'Demo Payout Bank (SG)' });
  assert.equal(p.purpose, 'GDDS');
  assert.deepEqual(p.invoiceReferences, ['INV-2026-0457']);
  assert.ok(p.present.includes('UETR') && p.present.includes('Dbtr') && p.present.includes('RmtInf'));
});

test('pacs.008: an envelope, prefixes, free-text addresses and /INV/ in unstructured text', () => {
  const p = parseSwiftMessage(sample('pacs008.envelope.sample.xml'));
  assert.equal(p.messageType, 'pacs.008.001.08');
  assert.equal(p.debtor.name, 'Saigon Machinery & Parts JSC');
  assert.deepEqual(p.debtor.addressLines, ['88 Nguyen Hue, Ben Nghe Ward', 'District 1, Ho Chi Minh City']);
  assert.equal(p.debtor.identification, undefined);
  assert.deepEqual(p.amount, { currency: 'USD', value: '8400.5' });
  assert.equal(p.instructedAmount, undefined);
  assert.equal(p.chargeBearer, 'SHAR');
  // A slash inside the reference is part of the reference.
  assert.deepEqual(p.invoiceReferences, ['INV/2026/0461 spare parts, PO 7790']);
  assert.equal(p.endToEndId, 'NOTPROVIDED');
});

test('pacs.008: older spellings (BIC, BICOrBEI) and a bare document are accepted', () => {
  const p = parseSwiftMessage(`<FIToFICstmrCdtTrf>
    <GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-01-02T03:04:05Z</CreDtTm></GrpHdr>
    <CdtTrfTxInf>
      <PmtId><EndToEndId>E1</EndToEndId></PmtId>
      <IntrBkSttlmAmt Ccy="USD">10</IntrBkSttlmAmt>
      <Dbtr><Nm>A</Nm><Id><OrgId><BICOrBEI>AAAAVNVX</BICOrBEI></OrgId></Id></Dbtr>
      <DbtrAgt><FinInstnId><BIC>BBBBVNVX</BIC></FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId><BIC>CCCCSGSG</BIC></FinInstnId></CdtrAgt>
      <Cdtr><Nm>B</Nm></Cdtr>
    </CdtTrfTxInf></FIToFICstmrCdtTrf>`);
  assert.equal(p.messageType, 'pacs.008');
  assert.equal(p.debtor.bic, 'AAAAVNVX');
  assert.equal(p.debtorAgent?.bic, 'BBBBVNVX');
  assert.equal(p.creditorAgent?.bic, 'CCCCSGSG');
});

// ── pain.001 ───────────────────────────────────────────────────────────────

test('pain.001: debtor from the payment block, creditor from the transaction', () => {
  const p = parseSwiftMessage(sample('pain001.sample.xml'));
  assert.equal(p.format, 'pain.001');
  assert.equal(p.messageType, 'pain.001.001.09');
  assert.equal(p.messageId, 'VINATRD-20261117-0031');
  assert.equal(p.instructionId, 'VINATRD-INS-0031-1');
  assert.equal(p.endToEndId, 'PO-7803');
  assert.equal(p.uetr, undefined);
  assert.deepEqual(p.amount, { currency: 'USD', value: '4300.00' });
  assert.equal(p.valueDate, '2026-11-17');
  assert.equal(p.chargeBearer, 'DEBT');
  assert.equal(p.debtor.name, 'Vina Trading Co., Ltd.');
  assert.equal(p.debtor.identification, '0312345678');
  assert.equal(p.debtorAgent?.bic, 'DEMOVNVX');
  assert.equal(p.creditor.account, 'SG-ACC-000009');
  assert.deepEqual(p.invoiceReferences, ['INV-2026-0470']);
});

// ── MT103 ──────────────────────────────────────────────────────────────────

test('MT103: free-format parties, CRLF, block 3 UETR, comma amounts, residence codes', () => {
  const bytes = sample('mt103.sample.txt');
  assert.ok(bytes.includes('\r\n'), 'the sample keeps its CRLF line ends');
  const p = parseSwiftMessage(bytes);
  assert.equal(p.format, 'MT103');
  assert.equal(p.messageId, 'OUT2026000125');
  assert.equal(p.uetr, 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57');
  assert.equal(p.valueDate, '2026-11-17');
  assert.deepEqual(p.amount, { currency: 'USD', value: '6150' });
  assert.deepEqual(p.settlementAmount, { currency: 'USD', value: '6150' });
  assert.equal(p.chargeBearer, 'DEBT', '71A OUR is the debtor bearing the charges');
  assert.equal(p.debtor.account, 'VN-ACC-000777');
  assert.equal(p.debtor.name, 'VINA TRADING CO LTD');
  assert.deepEqual(p.debtor.addressLines, ['12 LE LOI BLVD DISTRICT 1', 'HO CHI MINH CITY']);
  assert.equal(p.debtor.country, 'VN', 'from 77B /ORDERRES/');
  assert.equal(p.creditor.country, 'SG', 'from 77B /BENEFRES/');
  assert.equal(p.creditor.account, 'SG-ACC-000009');
  assert.equal(p.debtorAgent?.bic, 'DEMOVNVX');
  assert.equal(p.creditorAgent?.bic, 'DEMOSGSG');
  assert.deepEqual(p.invoiceReferences, ['INV-2026-0475']);
  assert.equal(p.endToEndId, 'PO-7811', '/ROC/ is the ordering customer\'s reference');
  assert.deepEqual(p.present, ['20', '23B', '32A', '33B', '50K', '52A', '57A', '59', '70', '71A', '77B', '121']);
});

test('MT103: structured options 50F and 59F', () => {
  const p = parseSwiftMessage(sample('mt103.structured.sample.txt'));
  assert.equal(p.debtor.name, 'VINA TRADING CO LTD');
  assert.equal(p.debtor.country, 'VN');
  assert.deepEqual(p.debtor.addressLines, ['12 LE LOI BLVD DISTRICT 1', 'HO CHI MINH CITY']);
  assert.equal(p.debtor.identification, '0312345678');
  assert.equal(p.debtor.account, 'VN-ACC-000777');
  assert.equal(p.creditor.name, 'PACIFIC SUPPLY PTE LTD');
  assert.equal(p.creditor.country, 'SG');
  assert.deepEqual(p.amount, { currency: 'USD', value: '990.75' });
  assert.equal(p.chargeBearer, 'SHAR');
  // No 52A: the ordering institution is the sender in block 1.
  assert.equal(p.debtorAgent?.bic, 'DEMOVNVX');
});

test('MT103: the text block alone, a coded party identifier, and an output header', () => {
  const bare = parseSwiftMessage(':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50F:TXID/VN/0312345678\n1/A CO\n2/1 STREET\n3/VN/HANOI\n:59:/ACC9\nB LTD\n:71A:BEN\n');
  assert.equal(bare.debtor.identification, '0312345678');
  assert.equal(bare.debtor.identificationScheme, 'TXID');
  assert.equal(bare.debtor.account, undefined);
  assert.equal(bare.chargeBearer, 'CRED');
  assert.deepEqual(bare.amount, { currency: 'USD', value: '100.5' });
  assert.equal(bare.debtorAgent, undefined);

  const out = parseSwiftMessage('{1:F01RCVRSGSGAXXX0000000000}{2:O1031200261117SNDRVNVXAXXX00000000002611171201N}{4:\n:20:R2\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:B\n:71A:SHA\n-}');
  assert.equal(out.debtorAgent?.bic, 'SNDRVNVX', 'the sender sits in the input reference of an output header');
  assert.equal(out.creditorAgent?.bic, 'RCVRSGSG');
});

// ── What is refused ────────────────────────────────────────────────────────

test('messages that are not one customer credit transfer are refused with a reason', () => {
  const code = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof SwiftMessageError) return e.code; throw e; }
    return 'no error';
  };
  assert.equal(code(() => parseSwiftMessage('hello')), 'not_a_swift_message');
  assert.equal(code(() => parseSwiftMessage('')), 'not_a_swift_message');
  assert.equal(code(() => parseSwiftMessage('{1:F01AAAAVNVXAXXX0000000000}{2:I202BBBBSGSGXXXXN}{4:\n:20:X\n-}')), 'unsupported_message');
  assert.equal(code(() => parseSwiftMessage('{1:F01AAAAVNVXAXXX0000000000}{2:I103BBBBSGSGXXXXN}{4:\n:20:X\n:32A:261117USD1,')), 'malformed_message');
  assert.equal(code(() => parseSwiftMessage('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document>')), 'unsupported_message');
  assert.equal(code(() => parseSwiftMessage('<!DOCTYPE x><Document/>')), 'malformed_message');
  assert.equal(code(() => parseSwiftMessage(':20:X\n:23B:CRED\n:32A:261117USD1,\n:59:B\n')), 'missing_field');

  // Two transactions: never picked by accident.
  const two = sample('pacs008.sample.xml').toString('utf8').replace('</CdtTrfTxInf>',
    '</CdtTrfTxInf><CdtTrfTxInf><PmtId><EndToEndId>E2</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="USD">1</IntrBkSttlmAmt><Dbtr><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr></CdtTrfTxInf>');
  assert.equal(code(() => parseSwiftMessage(two)), 'multiple_transactions');
  assert.equal(parseSwiftMessages(two).length, 2);
  assert.equal(parseSwiftMessage(two, { index: 1 }).endToEndId, 'E2');
});

test('a file with several messages yields every payment, never just one of them', () => {
  const code = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof SwiftMessageError) return e.code; throw e; }
    return 'no error';
  };
  const one = sample('mt103.sample.txt').toString('latin1');
  const two = sample('mt103.structured.sample.txt').toString('latin1');
  // One after another, or separated the way a batch export does it.
  for (const sep of ['', '\r\n', '$', '$\r\n', '\r\n$\r\n']) {
    const all = parseSwiftMessages(one + sep + two);
    assert.deepEqual(all.map((p) => [p.index, p.transactionCount, p.instructionId, p.uetr?.slice(0, 8)]),
      [[0, 2, 'OUT2026000125', 'b4d9e7a1'], [1, 2, 'OUT2026000126', 'e2a8c5f0']], JSON.stringify(sep));
  }
  assert.equal(code(() => parseSwiftMessage(one + two)), 'multiple_transactions');
  assert.equal(parseSwiftMessage(one + two, { index: 1 }).instructionId, 'OUT2026000126');
  // A message of another type among them refuses the file and says which one.
  assert.throws(() => parseSwiftMessages(`${one}{1:F01AAAAVNVXAXXX0000000000}{2:I202BBBBSGSGXXXXN}{4:\n:20:X\n-}`), /message 2 of 2: MT202/);
  assert.throws(() => parseSwiftMessages(`${one}\nstray text`), /not another message/);

  // Two text blocks without headers cannot be told apart — refused, not "the first one".
  const bare = ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n';
  assert.equal(parseSwiftMessages(bare).length, 1);
  assert.equal(parseSwiftMessages(`${bare}-}`).length, 1);
  assert.equal(parseSwiftMessages(`${bare}-}{5:{CHK:123456789ABC}}`).length, 1, 'trailer blocks may follow the text');
  assert.equal(code(() => parseSwiftMessages(bare + bare)), 'malformed_message');
  assert.equal(code(() => parseSwiftMessages(`${bare}-}\n${bare}`)), 'malformed_message');

  // XML: a wrapper around two documents, and a multi-transaction document inside a wrapper.
  const doc = sample('pacs008.sample.xml').toString('utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
  const second = doc.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '11111111-2222-4333-8444-555555555555');
  const batch = parseSwiftMessages(`<Batch>${doc}${second}</Batch>`);
  assert.deepEqual(batch.map((p) => [p.index, p.transactionCount, p.uetr?.slice(0, 8)]), [[0, 2, '3f1c9a52'], [1, 2, '11111111']]);
  const mixed = parseSwiftMessages(`<Batch>${doc}${sample('pain001.sample.xml').toString('utf8').replace(/^<\?xml[^>]*\?>\s*/, '')}</Batch>`);
  assert.deepEqual(mixed.map((p) => p.format), ['pacs.008', 'pain.001']);
  // A document of another kind among them refuses the file rather than being passed over.
  assert.equal(code(() => parseSwiftMessages(
    `<Batch>${doc}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document></Batch>`)), 'unsupported_message');
  assert.equal(code(() => parseSwiftMessages(`<Batch>${doc}<Document><Something/></Document></Batch>`)), 'unsupported_message');
});

test('a text block without headers has to be an MT103, not merely resemble one', () => {
  const code = (fn: () => unknown): string => {
    try { fn(); } catch (e) { if (e instanceof SwiftMessageError) return e.code; throw e; }
    return 'no error';
  };
  // MT102: several transactions under one settlement amount. Read as an MT103
  // it was one payment of the total to the first beneficiary.
  const mt102 = ':20:BATCH1\n:23:CREDIT\n:50K:/VN-ACC-1\nA CO\n:52A:DEMOVNVX\n:71A:SHA\n'
    + ':21:TX1\n:32B:USD1000,\n:57A:DEMOSGSG\n:59:/SG-ACC-000001\nFIRST SUPPLIER\n'
    + ':21:TX2\n:32B:USD49000,\n:59:/SG-ACC-000002\nSECOND SUPPLIER\n:32A:261117USD50000,\n:19:50000,\n';
  assert.equal(code(() => parseSwiftMessages(mt102)), 'unsupported_message');
  // MT202 COV: the cover of an MT103 carries the same two customers.
  const cover = ':20:COV1\n:21:OUT2026000125\n:32A:261117USD6150,\n:52A:DEMOVNVX\n:58A:DEMOSGSG\n'
    + ':50K:/VN-ACC-000777\nVINA TRADING CO LTD\n:59:/SG-ACC-000009\nPACIFIC SUPPLY PTE LTD\n:70:/INV/INV-2026-0475\n';
  assert.equal(code(() => parseSwiftMessages(cover)), 'unsupported_message');
  assert.equal(code(() => parseSwiftMessages(`{1:F01DEMOVNVXAXXX0000000000}{4:\n${cover}-}`)), 'unsupported_message', 'block 1 alone states no type either');
  assert.throws(() => parseSwiftMessages(cover), /send the message with them/);

  // Every mandatory field of an MT103 has to be there — which is also what
  // catches a text block cut off while it was being written.
  const whole = ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:70:/INV/INV-2026-0475\n:71A:BEN\n';
  assert.equal(parseSwiftMessage(whole).invoiceReferences[0], 'INV-2026-0475');
  const cut = whole.slice(0, whole.indexOf('75\n:71A'));
  assert.throws(() => parseSwiftMessage(cut), (e: unknown) => e instanceof SwiftMessageError && e.code === 'missing_field' && /71A/.test(e.message) && /cut short/.test(e.message));
  assert.equal(code(() => parseSwiftMessage(whole.replace(':23B:CRED\n', ''))), 'missing_field');
  assert.equal(code(() => parseSwiftMessage(':20:REF1\n:23B:CRED\n:50K:A CO\n:59:B LTD\n:71A:BEN\n')), 'not_a_swift_message');
});

test('MT103: a field written twice, in two forms, or under a malformed tag is refused', () => {
  const mt = (extra: string): string =>
    `{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n:20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n${extra}:59:/ACC1\nB\n:71A:SHA\n-}`;
  assert.equal(parseSwiftMessage(mt('')).creditor.account, 'ACC1');
  assert.equal(parseSwiftMessage(mt(':23E:SDVA\n:23E:INTC\n')).creditor.account, 'ACC1', 'a field that may repeat, repeats');
  const refused: [string, RegExp][] = [
    [':59:/ACC2\nC\n', /field 59 occurs twice/],
    [':59A:/ACC2\nDEMOSGSG\n', /59A and 59 are both present/],
    [':50A:DEMOVNVX\n', /50K and 50A are both present/],
    [':32A:261117USD6,\n', /field 32A occurs twice/],
    [':57a:REALSGSG\n', /starts like a field tag but is not one/],
    ['\t:70:/INV/X\n', /is indented/],
    [':21:RELATED\n', /field 21 is not an MT103 field/],
  ];
  for (const [extra, why] of refused) {
    assert.throws(() => parseSwiftMessage(mt(extra)), (e: unknown) => e instanceof SwiftMessageError && e.code === 'malformed_message' && why.test(e.message), extra);
  }
  // An end-of-text marker in the middle: what follows is not read past.
  assert.throws(() => parseSwiftMessage('{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n:20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:B\n:70:X\n-}\n:71A:SHA\n-}'),
    /not another message/);
});

test('XML: what could be read two ways is refused, and what belongs to another vocabulary is not read', () => {
  assert.throws(() => parseXml('<a x="1" x="2"/>'), /written twice/);
  assert.throws(() => parseXml('<a p:x="1"/>'), /not declared/);
  assert.equal(parseXml('<a xmlns:p="urn:p" Ccy="USD" p:Ccy="EUR"/>').attrs.Ccy, 'USD');
  assert.equal(parseXml('<a xml:lang="en" Ccy="USD"/>').attrs.Ccy, 'USD');
  // The words inside a comment or a CDATA section are text, not a declaration.
  assert.equal(parseXml('<a><!-- <!DOCTYPE x> --><![CDATA[<!ENTITY y>]]></a>').text, '<!ENTITY y>');
  assert.throws(() => parseXml('<a><!DOCTYPE x></a>'), /document type declaration/);
  assert.throws(() => parseXml('<a>\u0001</a>'), /U\+0001/);
  assert.throws(() => parseXml('<a>\uD800</a>'), /not allowed/);
  assert.equal(parseXml('<a>\uD83D\uDE00</a>').text, '\uD83D\uDE00', 'a proper surrogate pair is a character');
  const prefixes = (n: number): string => Array.from({ length: n }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
  assert.equal(parseXml(`<a ${prefixes(60)}><p59:b/></a>`).children[0]!.ns, 'urn:59');
  assert.throws(() => parseXml(`<a ${prefixes(65)}/>`), /namespace prefixes/);

  const xml = sample('pacs008.sample.xml').toString('utf8');
  // An element from another namespace beside the real one is not the name.
  const injected = parseSwiftMessage(xml.replace('<Cdtr>', '<Cdtr xmlns:e="urn:evil"><e:Nm>Injected Name</e:Nm>'));
  assert.equal(injected.creditor.name, 'Pacific Supply Pte Ltd');
  const attr = parseSwiftMessage(xml.replace('<InstdAmt Ccy="USD">', '<InstdAmt xmlns:x="urn:x" Ccy="USD" x:Ccy="EUR">'));
  assert.deepEqual(attr.amount, { currency: 'USD', value: '12500.00' });
  // The same element twice where one is expected: which one was meant?
  for (const [from, to] of [
    ['<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Pacific Supply Pte Ltd</Nm><Nm>Another Name</Nm>'],
    ['<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">12500.00</InstdAmt><InstdAmt Ccy="USD">1.00</InstdAmt>'],
    ['<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', '<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR><UETR>11111111-2222-4333-8444-555555555555</UETR>'],
  ] as const) {
    assert.ok(xml.includes(from));
    assert.throws(() => parseSwiftMessage(xml.replace(from, to)),
      (e: unknown) => e instanceof SwiftMessageError && e.code === 'malformed_message' && /more than once/.test(e.message), from);
  }
});

test('bytes are read in the encoding the message declares, and never guessed for XML', () => {
  const xml = sample('pacs008.sample.xml').toString('utf8').replace('Vina Trading Co., Ltd.', 'Công ty TNHH Nguyễn Thị Hương');
  assert.equal(parseSwiftMessage(Buffer.from(xml, 'utf8')).debtor.name, 'Công ty TNHH Nguyễn Thị Hương');
  assert.equal(parseSwiftMessage(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')])).debtor.name, 'Công ty TNHH Nguyễn Thị Hương');
  // One stray byte must not turn the whole message into another code page.
  const bytes = Buffer.from(xml, 'utf8');
  const at = bytes.indexOf('<Ctry>VN');
  const stray = Buffer.concat([bytes.subarray(0, at), Buffer.from([0x92]), bytes.subarray(at)]);
  assert.throws(() => parseSwiftMessage(stray), (e: unknown) => e instanceof SwiftMessageError && e.code === 'malformed_message' && /not valid/.test(e.message));
  // A declared single-byte encoding is honoured.
  const latin = Buffer.from(xml.replace('UTF-8', 'ISO-8859-1').replace('Công ty TNHH Nguyễn Thị Hương', 'Société Générale Import'), 'latin1');
  assert.equal(parseSwiftMessage(latin).debtor.name, 'Société Générale Import');
  assert.throws(() => parseSwiftMessage(Buffer.from(xml.replace('UTF-8', 'KLINGON-1'), 'utf8')), /does not know/);
  // UTF-16 with a byte-order mark.
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace('UTF-8', 'UTF-16'), 'utf16le')]);
  assert.equal(parseSwiftMessage(utf16).debtor.name, 'Công ty TNHH Nguyễn Thị Hương');
  // FIN text in a legacy single-byte code page still reads.
  const fin = Buffer.from(sample('mt103.sample.txt').toString('latin1').replace('HO CHI MINH CITY', 'HÔ CHI MINH CITY'), 'latin1');
  assert.deepEqual(parseSwiftMessage(fin).debtor.addressLines, ['12 LE LOI BLVD DISTRICT 1', 'HÔ CHI MINH CITY']);
});

test('a large file is read in time proportional to its size', () => {
  // 3,000 transactions under one payment block: quadratic work here took minutes.
  const tx = (i: number): string => `<CdtTrfTxInf><PmtId><InstrId>I-${i}</InstrId><EndToEndId>E-${i}</EndToEndId></PmtId>`
    + '<Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr><CdtrAcct><Id><Othr><Id>ACC</Id></Othr></Id></CdtrAcct></CdtTrfTxInf>';
  const big = '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn><GrpHdr><MsgId>M</MsgId></GrpHdr>'
    + `<PmtInf><PmtInfId>P</PmtInfId><Dbtr><Nm>A</Nm></Dbtr>${Array.from({ length: 3000 }, (_, i) => tx(i)).join('')}</PmtInf></CstmrCdtTrfInitn></Document>`;
  let t0 = performance.now();
  const all = parseSwiftMessages(big);
  assert.equal(all.length, 3000);
  assert.equal(all[2999]!.instructionId, 'I-2999');
  assert.notEqual(all[0]!.debtor, all[1]!.debtor, 'each payment has its own debtor object');
  assert.ok(performance.now() - t0 < 4_000, `3,000 transactions took ${Math.round(performance.now() - t0)} ms`);
  // Many namespace prefixes in scope used to be copied for every element.
  const prefixes = Array.from({ length: 60 }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
  t0 = performance.now();
  parseXml(`<a ${prefixes}>${'<b><c>x</c></b>'.repeat(60_000)}</a>`);
  assert.ok(performance.now() - t0 < 4_000, `60 prefixes over 120,000 elements took ${Math.round(performance.now() - t0)} ms`);
});

// ── The mapping table ──────────────────────────────────────────────────────

test('mapping: a complete message is ready, and every value names its source', () => {
  const m = mapSwiftPayment(parseSwiftMessage(sample('pacs008.sample.xml')));
  assert.deepEqual(m.issues, []);
  const input = m.input!;
  assert.equal(input.tradeAmount, '12500.00');
  assert.deepEqual(input.parties.debtor, {
    name: 'Vina Trading Co., Ltd.', country: 'VN',
    address: 'Le Loi Boulevard 12, District 1, Ho Chi Minh City',
    registration_number: '0312345678', account: 'VN-ACC-000777',
  });
  assert.deepEqual(input.parties.creditor, {
    name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-000009', bank: 'Demo Payout Bank (SG) · BIC DEMOSGSG',
  });
  assert.equal(input.invoiceRef, 'INV-2026-0457');
  assert.equal(input.purposeCode, 'GDDS');
  assert.equal(input.instructionRef, 'OUT-2026-000123');
  assert.deepEqual(input.source, {
    type: 'pacs.008.001.08', sha256: m.payment.digest,
    messageId: 'DEMOVNVX20261117000123', instructionId: 'OUT-2026-000123',
    endToEndId: 'PO-7781', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10',
    valueDate: '2026-11-17', content: swiftContentDigest(m.payment),
  });
  assert.match(input.source.content!, /^[0-9a-f]{64}$/);
  assert.ok(m.fields.every((f) => f.source && f.basis === 'stated'));
  assert.deepEqual(m.unmapped.map((u) => u.source), ['ChrgBr', 'IntrBkSttlmDt']);
});

test('mapping: what a message lacks is reported in its own vocabulary, and the customer master fills it', () => {
  const p = parseSwiftMessage(sample('mt103.sample.txt'));
  const bare = mapSwiftPayment(p);
  assert.equal(bare.input, undefined);
  assert.deepEqual(bare.issues.map((i) => i.target), ['debtor.registration_number']);
  assert.match(bare.issues[0]!.source, /50F/);
  assert.match(new SwiftMappingError(bare).message, /debtor\.registration_number/);

  const filled = mapSwiftPayment(p, { supplement: parties[p.debtor.account!]! });
  assert.deepEqual(filled.issues, []);
  assert.equal(filled.input!.parties.debtor.registration_number, '0312345678');
  assert.equal(filled.fields.find((f) => f.target === 'debtor.registration_number')!.basis, 'supplied');
  assert.equal(filled.input!.invoiceRef, 'INV-2026-0475');
  assert.equal(filled.input!.source.endToEndId, 'PO-7811');
});

test('mapping: a country may be inferred from the agent\'s BIC, and says so; NOTPROVIDED is not a reference', () => {
  const p = parseSwiftMessage(':20:R\n:23B:CRED\n:32A:261117USD10,\n:50K:/A1\nA CO\n1 STREET\n:52A:AAAAVNVX\n:57A:BBBBSGSG\n:59:/B1\nB LTD\n:70:SPARE PARTS\n:71A:SHA\n');
  const m = mapSwiftPayment(p, { supplement: { debtor: { registration_number: '1' } } });
  assert.deepEqual(m.issues, []);
  const dc = m.fields.find((f) => f.target === 'debtor.country')!;
  assert.deepEqual([dc.value, dc.basis], ['VN', 'inferred']);
  assert.equal(m.fields.find((f) => f.target === 'creditor.country')!.value, 'SG');
  assert.equal(m.input!.invoiceRef, 'SPARE PARTS');
  const strict = mapSwiftPayment(p, { inferCountryFromBic: false, supplement: { debtor: { registration_number: '1' } } });
  assert.deepEqual(strict.issues.map((i) => i.target), ['debtor.country', 'creditor.country']);

  const env = mapSwiftPayment(parseSwiftMessage(sample('pacs008.envelope.sample.xml')),
    { supplement: parties['VN-ACC-000812']! });
  assert.deepEqual(env.issues, []);
  assert.equal(env.input!.source.endToEndId, undefined);
  assert.equal(env.input!.tradeAmount, '8400.5');
});

test('mapping: the corridor denominates in USD — another currency is an issue, not a conversion', () => {
  const vnd = sample('pacs008.sample.xml').toString('utf8').replaceAll('Ccy="USD"', 'Ccy="VND"');
  const m = mapSwiftPayment(parseSwiftMessage(vnd));
  assert.deepEqual(m.issues.map((i) => i.target), ['trade.amount']);
  // Instructed in VND, settled between banks in USD: the USD leg denominates the trade.
  const mixed = sample('pacs008.sample.xml').toString('utf8')
    .replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="VND">322537500</InstdAmt>');
  const mm = mapSwiftPayment(parseSwiftMessage(mixed));
  assert.deepEqual(mm.issues, []);
  assert.equal(mm.input!.tradeAmount, '12500.00');
  assert.deepEqual(mm.fields.find((f) => f.target === 'trade.amount'),
    { target: 'trade.amount', value: '12500.00 USD', source: 'CdtTrfTxInf/IntrBkSttlmAmt', basis: 'stated' });
  assert.ok(mm.unmapped.some((u) => u.source === 'CdtTrfTxInf/InstdAmt' && u.value === '322537500 VND'));
  // Settled between banks in another currency, instructed in USD: the instructed amount names the trade.
  const sgd = sample('pacs008.sample.xml').toString('utf8')
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="SGD">16687.50</IntrBkSttlmAmt>');
  const ms = mapSwiftPayment(parseSwiftMessage(sgd));
  assert.deepEqual([ms.issues.length, ms.input!.tradeAmount, ms.fields.find((f) => f.target === 'trade.amount')!.source],
    [0, '12500.00', 'CdtTrfTxInf/InstdAmt']);
});

test('mapping: the amount moved is the settled amount — charges already deducted are not funded twice', () => {
  // Charges on the beneficiary: 7,010.50 was instructed, 10.00 was taken, 7,000.50 moves between the banks.
  const cred = sample('pacs008.sample.xml').toString('utf8')
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD">7000.50</IntrBkSttlmAmt>')
    .replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">7010.50</InstdAmt>')
    .replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>CRED</ChrgBr><ChrgsInf><Amt Ccy="USD">10.00</Amt><Agt><FinInstnId><BICFI>DEMOVNVX</BICFI></FinInstnId></Agt></ChrgsInf>');
  const m = mapSwiftPayment(parseSwiftMessage(cred));
  assert.deepEqual(m.issues, []);
  assert.equal(m.input!.tradeAmount, '7000.50');
  assert.deepEqual(m.unmapped.filter((u) => /InstdAmt|ChrgsInf/.test(u.source)).map((u) => [u.source, u.value]),
    [['CdtTrfTxInf/InstdAmt', '7010.50 USD'], ['ChrgsInf', '10.00 USD (DEMOVNVX)']]);

  // The same in an MT103: 33B instructed, 71F taken, 32A settled.
  const ben = sample('mt103.structured.sample.txt').toString('latin1')
    .replace(':32A:261117USD990,75', ':32A:261117USD980,75\r\n:33B:USD990,75').replace(':71A:SHA', ':71A:BEN\r\n:71F:USD10,');
  const mt = mapSwiftPayment(parseSwiftMessage(ben));
  assert.deepEqual(mt.issues, []);
  assert.equal(mt.input!.tradeAmount, '980.75');
  assert.deepEqual(mt.unmapped.filter((u) => /33B|71F/.test(u.source)).map((u) => [u.source, u.value]),
    [['field 33B', '990.75 USD'], ['field 71F / 71G', 'sender\'s charges USD10,']]);
  // Charges on the debtor, with the receiving bank's charges prepaid: 1,000 was
  // instructed, 15 is for the receiving bank, 1,015 moves. The beneficiary is owed 1,000.
  const our = sample('mt103.structured.sample.txt').toString('latin1')
    .replace(':32A:261117USD990,75', ':32A:261117USD1015,\r\n:33B:USD1000,').replace(':71A:SHA', ':71A:OUR\r\n:71G:USD15,');
  const mo = mapSwiftPayment(parseSwiftMessage(our));
  assert.deepEqual([mo.issues.length, mo.input!.tradeAmount, mo.fields.find((f) => f.target === 'trade.amount')!.source], [0, '1000', 'field 33B']);
  assert.deepEqual(mo.unmapped.filter((u) => /32A|71F/.test(u.source) && /USD/.test(u.value)).map((u) => [u.source, u.value, /prepaid for the receiving bank/.test(u.why)]),
    [['field 32A', '1015 USD', true], ['field 71F / 71G', 'receiver\'s charges USD15,', false]]);
  const debt = sample('pacs008.sample.xml').toString('utf8')
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD">12515.00</IntrBkSttlmAmt>')
    .replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>DEBT</ChrgBr><ChrgsInf><Amt Ccy="USD">15.00</Amt><Agt><FinInstnId><BICFI>DEMOSGSG</BICFI></FinInstnId></Agt></ChrgsInf>');
  assert.equal(mapSwiftPayment(parseSwiftMessage(debt)).input!.tradeAmount, '12500.00');
  // Equal amounts written differently are not a difference.
  assert.ok(!mapSwiftPayment(parseSwiftMessage(sample('mt103.sample.txt'))).unmapped.some((u) => u.source === 'field 33B'));
});

test('mapping: the invoice is the document the message calls an invoice', () => {
  const xml = sample('pacs008.sample.xml').toString('utf8');
  const doc = (type: string, nb: string): string =>
    `<RfrdDocInf><Tp><CdOrPrtry><Cd>${type}</Cd></CdOrPrtry></Tp><Nb>${nb}</Nb></RfrdDocInf>`;
  const strd = /<Strd>[\s\S]*<\/Strd>/.exec(xml)![0];
  // A purchase order first, then two invoices and a credit note.
  const many = xml.replace(strd, `<Strd>${doc('PUOR', 'PO-88812')}${doc('CINV', 'SI-2026-5531')}${doc('CINV', 'SI-2026-5532')}${doc('CREN', 'CN-2026-0077')}</Strd>`);
  const p = parseSwiftMessage(many);
  assert.deepEqual([p.invoiceReferences, p.otherDocuments], [['SI-2026-5531', 'SI-2026-5532'], ['PUOR PO-88812', 'CREN CN-2026-0077']]);
  const m = mapSwiftPayment(p);
  assert.equal(m.input!.invoiceRef, 'SI-2026-5531');
  assert.deepEqual(m.unmapped.filter((u) => /RmtInf/.test(u.source)).map((u) => u.value), ['SI-2026-5532', 'PUOR PO-88812', 'CREN CN-2026-0077']);
  // An untyped document still counts, after the typed ones.
  const untyped = parseSwiftMessage(xml.replace(strd, `<Strd><RfrdDocInf><Nb>REF-1</Nb></RfrdDocInf>${doc('CINV', 'SI-9')}</Strd>`));
  assert.deepEqual(untyped.invoiceReferences, ['SI-9', 'REF-1']);
  // A reference with three capital letters between slashes is one reference, in both families.
  const free = parseSwiftMessage(xml.replace(strd, '<Ustrd>/INV/EQP/SGP/2026/0457/RFB/BEN-REF-1</Ustrd>'));
  assert.deepEqual(free.invoiceReferences, ['EQP/SGP/2026/0457']);
  const mt = parseSwiftMessage(sample('mt103.sample.txt').toString('latin1').replace('/INV/INV-2026-0475', '/INV/EQP/SGP/2026/0475'));
  assert.deepEqual([mt.invoiceReferences, mt.endToEndId], [['EQP/SGP/2026/0475'], 'PO-7811']);
  // The message reference guide's own example: two invoices under one code word, then another code word.
  const guide = parseSwiftMessage(sample('mt103.sample.txt').toString('latin1')
    .replace(/:70:[\s\S]*?:71A:/, ':70:/RFB/BET072\r\n/INV/abc/SDF-96//1234-234///ROC/98IU87\r\n:71A:'));
  assert.deepEqual([guide.invoiceReferences, guide.endToEndId], [['abc/SDF-96', '1234-234'], '98IU87']);
});

test('mapping: a private person is not sent as a company, and a test message is not a payment', () => {
  const xml = sample('pacs008.sample.xml').toString('utf8');
  const org = /<OrgId>[\s\S]*?<\/OrgId>/.exec(xml)![0];
  const person = xml.replace(org, '<PrvtId><DtAndPlcOfBirth><BirthDt>1980-01-01</BirthDt><CityOfBirth>Hanoi</CityOfBirth><CtryOfBirth>VN</CtryOfBirth></DtAndPlcOfBirth>'
    + '<Othr><Id>C1234567</Id><SchmeNm><Cd>CCPT</Cd></SchmeNm></Othr></PrvtId>');
  const m = mapSwiftPayment(parseSwiftMessage(person));
  assert.deepEqual(m.issues.map((i) => [i.target, i.source]), [['debtor', 'CdtTrfTxInf/Dbtr/Id/PrvtId']]);
  assert.match(m.issues[0]!.problem, /private person/);
  assert.equal(m.fields.find((f) => f.target === 'debtor.registration_number')!.source, 'CdtTrfTxInf/Dbtr/Id/PrvtId/Othr/Id — CCPT');

  const mt = sample('mt103.structured.sample.txt').toString('latin1');
  for (const line of ['4/19800101', '5/VN/HANOI', '7/VN/012345678901']) {
    const born = mapSwiftPayment(parseSwiftMessage(mt.replace('6/VN/GDT/0312345678', line)));
    assert.ok(born.issues.some((i) => i.target === 'debtor' && /private person/.test(i.problem)), line);
  }
  assert.ok(mapSwiftPayment(parseSwiftMessage(mt.replace(':50F:/VN-ACC-000777', ':50F:CCPT/VN/C1234567'))).issues.some((i) => i.target === 'debtor'));

  // 23B CRTS marks a test message.
  const test = parseSwiftMessage(mt.replace(':23B:CRED', ':23B:CRTS'));
  assert.equal(test.bankOperationCode, 'CRTS');
  assert.deepEqual(mapSwiftPayment(test).issues.map((i) => [i.target, i.source]), [['instruction', 'field 23B']]);
  const allowed = mapSwiftPayment(test, { allowTestMessages: true });
  assert.deepEqual(allowed.issues, []);
  assert.ok(allowed.unmapped.some((u) => u.source === 'field 23B' && u.value === 'CRTS'));
});

test('mapping: a payment of another route is refused, not quoted on this one', () => {
  const xml = sample('pacs008.sample.xml').toString('utf8');
  const targets = (m: string, opts = {}): string[] => mapSwiftPayment(parseSwiftMessage(m), opts).issues.map((i) => `${i.target}: ${i.problem}`);
  assert.deepEqual(targets(xml), []);
  // The beneficiary in the United States, paid through a US bank.
  const us = xml.replace('<Ctry>SG</Ctry>', '<Ctry>US</Ctry>').replaceAll('<BICFI>DEMOSGSG</BICFI>', '<BICFI>AAAAUS33</BICFI>');
  assert.deepEqual(targets(us), [
    'corridor: the beneficiary is in US; this corridor carries payments from VN to SG',
    'corridor: the beneficiary\'s bank is in US; the payout of this corridor is made in SG',
  ]);
  // The ordering customer in Thailand.
  assert.deepEqual(targets(xml.replace('<Ctry>VN</Ctry>', '<Ctry>TH</Ctry>')),
    ['corridor: the ordering customer is in TH; this corridor carries payments from VN to SG']);
  // A beneficiary in Singapore whose account is at a bank elsewhere is not paid out in Singapore.
  assert.deepEqual(targets(xml.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>', '<BICFI>DEMOMYKL</BICFI>')),
    ['corridor: the beneficiary\'s bank is in MY; the payout of this corridor is made in SG']);
  // The route is the client's to state; another corridor takes its own payments.
  assert.deepEqual(targets(us.replace('<Ctry>VN</Ctry>', '<Ctry>KR</Ctry>'), { corridor: { origin: 'KR', destination: 'US' } }), []);
});

test('test and training traffic is not a payment, however it says so', () => {
  const issue = (m: string | Buffer): string[] => mapSwiftPayment(parseSwiftMessage(m)).issues.map((i) => `${i.source}: ${i.problem.split(' — ')[0]}`);
  const mt = sample('mt103.structured.sample.txt').toString('latin1');
  assert.deepEqual(issue(mt), []);
  // "0" in the eighth position of a BIC marks a test and training address.
  assert.deepEqual(issue(mt.replace('{1:F01DEMOVNVXAXXX', '{1:F01DEMOVNV0AXXX')), ['header blocks 1 and 2: test and training BIC DEMOVNV0']);
  assert.deepEqual(issue(mt.replace('{2:I103DEMOSGSGXXXXN}', '{2:I103DEMOSGS0XXXXN}')), ['header blocks 1 and 2: test and training BIC DEMOSGS0']);
  const doc = sample('pacs008.sample.xml').toString('utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
  const pilot = `<Saa:DataPDU xmlns:Saa="urn:swift:saa:xsd:saa.2.0"><Saa:Header><Saa:Message><Saa:NetworkInfo><Saa:Service>swift.finplus!p</Saa:Service></Saa:NetworkInfo></Saa:Message></Saa:Header><Saa:Body>${doc}</Saa:Body></Saa:DataPDU>`;
  assert.deepEqual(issue(pilot), ['envelope header, Service: pilot service swift.finplus!p']);
  assert.deepEqual(issue(pilot.replace('!p', '')), []);
  const bah = `<Envelope><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"><Fr><FIId><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></FIId></Fr></AppHdr>${doc}</Envelope>`;
  assert.deepEqual(issue(bah), ['Business Application Header: test and training BIC DEMOVNV0']);
  assert.deepEqual(mapSwiftPayment(parseSwiftMessage(bah), { allowTestMessages: true }).issues, []);
  // A bare body that declares its namespace keeps its version.
  const bare = doc.replace(/<Document[^>]*>/, '').replace('</Document>', '')
    .replace('<FIToFICstmrCdtTrf>', '<FIToFICstmrCdtTrf xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
  assert.equal(parseSwiftMessage(bare).messageType, 'pacs.008.001.08');
  // Size is bounded for every family, and a damaged UTF-16 file is a refusal, not a crash.
  assert.throws(() => parseSwiftMessage(`${mt}${' '.repeat(4 * 1024 * 1024)}`), (e: unknown) => e instanceof SwiftMessageError && /larger than/.test(e.message));
  assert.throws(() => parseSwiftMessage(Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x00, 0xd8])), (e: unknown) => e instanceof SwiftMessageError && /UTF-16/.test(e.message));
  // MT103 REMIT: field 77T is named as not read, not passed over.
  const remit = mapSwiftPayment(parseSwiftMessage(mt.replace(':71A:SHA', ':71A:SHA\r\n:77T:/NARR/INVOICES RR-2026-001')));
  assert.ok(remit.unmapped.some((u) => u.source === 'field 77T'));
});

test('what a party states is kept whole and labelled with where it stood', () => {
  const xml = sample('pacs008.sample.xml').toString('utf8');
  // The newer address elements, a clearing-system member, residence instead of an address country.
  const p = parseSwiftMessage(xml
    .replace('<StrtNm>Raffles Place</StrtNm>', '<CareOf>Pacific Group Services</CareOf><StrtNm>Raffles Place</StrtNm>')
    .replace('<BldgNb>1</BldgNb>\n          <PstCd>048616</PstCd>', '<BldgNb>1</BldgNb><Flr>17</Flr><UnitNb>17-01</UnitNb>\n          <PstCd>048616</PstCd>')
    .replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>', '<ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>026009593</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (US)</Nm>')
    .replace('<Ctry>VN</Ctry>\n        </PstlAdr>', '</PstlAdr>\n        <CtryOfRes>VN</CtryOfRes>'));
  assert.deepEqual(p.creditor.addressLines, ['c/o Pacific Group Services', 'Raffles Place 1', '17', '17-01', '048616 Singapore']);
  assert.deepEqual(p.creditorAgent, { name: 'Demo Payout Bank (US)', memberId: '026009593', clearingSystem: 'USABA' });
  const m = mapSwiftPayment(p);
  assert.equal(m.input!.parties.creditor.bank, 'Demo Payout Bank (US) · USABA 026009593');
  assert.deepEqual(m.fields.find((f) => f.target === 'debtor.country'), { target: 'debtor.country', value: 'VN', source: 'CdtTrfTxInf/Dbtr/CtryOfRes', basis: 'stated' });
  assert.equal(m.fields.find((f) => f.target === 'debtor.registration_number')!.source, 'CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID');

  // Regulatory reporting in the newest version's spelling.
  const reg = parseSwiftMessage(xml.replace('<Purp>', '<RgltryRptg><Dtls><Tp><Cd>CRED</Cd></Tp><Ctry>VN</Ctry><RptgCd>EXPORT</RptgCd><Inf>CERAMICS</Inf></Dtls></RgltryRptg><Purp>'));
  assert.deepEqual(reg.regulatoryReporting, ['CRED EXPORT VN CERAMICS']);

  // pain.001: the block's id is not the instruction's.
  const pain = parseSwiftMessage(sample('pain001.sample.xml').toString('utf8').replace(/<InstrId>[^<]*<\/InstrId>\s*/, ''));
  assert.deepEqual([pain.instructionId, pain.paymentInfoId], [undefined, 'VINATRD-PMT-0031']);
  const pm = mapSwiftPayment(pain);
  assert.equal(pm.input!.instructionRef, 'VINATRD-PMT-0031');
  assert.equal(pm.input!.source.instructionId, undefined);

  // MT103 option F: a second 3/ continues the address, 8/ continues the identifier of the first line.
  const mt = sample('mt103.structured.sample.txt').toString('latin1');
  const f = parseSwiftMessage(mt
    .replace(':50F:/VN-ACC-000777', ':50F:TXID/VN/0790123456')
    .replace(/3\/VN\/HO CHI MINH CITY\r?\n6\/VN\/GDT\/0312345678/, '3/VN/HO CHI MINH CITY\n3/700000\n8/78'));
  assert.deepEqual([f.debtor.country, f.debtor.addressLines, f.debtor.identification],
    ['VN', ['12 LE LOI BLVD DISTRICT 1', 'HO CHI MINH CITY', '700000'], '079012345678']);
  assert.equal(mapSwiftPayment(f).fields.find((x) => x.target === 'debtor.registration_number')!.source, 'field 50F party identifier — TXID');
  // Option A: the identifier is a BIC. A BIC is not a registration number, and is not passed off as one.
  const a = mapSwiftPayment(parseSwiftMessage(mt.replace(/:50F:[\s\S]*?:57A:/, ':50A:/VN-ACC-000777\r\nAAAAVNVX\r\n:57A:')),
    { supplement: { debtor: { name: 'Vina Trading', address: '12 Le Loi', country: 'VN' } } });
  assert.deepEqual(a.issues.map((x) => x.target), ['debtor.registration_number']);
  assert.match(a.issues[0]!.problem, /only the BIC AAAAVNVX, which is not one/);
  assert.equal(mapSwiftPayment(parseSwiftMessage(sample('mt103.sample.txt'))).fields.find((x) => x.target === 'debtor.country')!.source, 'field 77B /ORDERRES/');
});

test('the payment id is the message\'s identity, not its bytes', () => {
  const a = parseSwiftMessage(sample('pacs008.sample.xml'));
  const reformatted = parseSwiftMessage(sample('pacs008.sample.xml').toString('utf8').replace(/\n\s+/g, '\n'));
  assert.notEqual(a.digest, reformatted.digest);
  const id = swiftPaymentId('VN-BANK-1', a);
  assert.equal(id, swiftPaymentId('VN-BANK-1', reformatted), 'the same UETR names the same payment');
  assert.match(id, /^PAY-3f1c9a52-[0-9a-f]{10}$/, 'the first group is the UETR\'s own, to be matched by eye');
  assert.notEqual(id, swiftPaymentId('VN-BANK-2', a), 'another institution, another payment');
  // No date is part of the id. Written out again the next day — or with the
  // same instant in another offset — the payment is the same payment.
  for (const stamp of ['2026-11-18T09:00:00+07:00', '2026-11-16T22:30:00Z']) {
    const later = parseSwiftMessage(sample('pacs008.sample.xml').toString('utf8').replace(/<CreDtTm>[^<]+</, `<CreDtTm>${stamp}<`));
    assert.equal(swiftPaymentId('VN-BANK-1', later), id, stamp);
    assert.equal(swiftContentDigest(later), swiftContentDigest(a), 'and its content digest does not move either');
  }
  assert.equal(swiftContentDigest(reformatted), swiftContentDigest(a));
  const otherInvoice = parseSwiftMessage(sample('pacs008.sample.xml').toString('utf8').replace('INV-2026-0457', 'INV-2026-0999'));
  assert.notEqual(swiftContentDigest(otherInvoice), swiftContentDigest(a), 'another invoice is another payment');
  const mt = parseSwiftMessage(sample('mt103.sample.txt'));
  assert.match(swiftPaymentId('VN-BANK-1', mt), /^PAY-b4d9e7a1-[0-9a-f]{10}$/);
  // The same MT103 without its header blocks: no UETR, the same content.
  const text = sample('mt103.sample.txt').toString('latin1');
  const stripped = parseSwiftMessage(text.slice(text.indexOf(':20:'), text.indexOf('-}')));
  assert.equal(stripped.uetr, undefined);
  assert.match(swiftPaymentId('VN-BANK-1', stripped), /^PAY-[0-9a-f]{8}-[0-9a-f]{10}$/);
  assert.equal(swiftContentDigest(stripped), swiftContentDigest(mt));
  assert.deepEqual(isoFieldNames(mt), ['InstrId', 'IntrBkSttlmAmt', 'IntrBkSttlmDt', 'InstdAmt', 'Dbtr', 'DbtrAcct',
    'DbtrAgt', 'CdtrAgt', 'Cdtr', 'CdtrAcct', 'RmtInf', 'ChrgBr', 'RgltryRptg', 'UETR']);
});

// ── Status going back ──────────────────────────────────────────────────────

const view = (state: string, events: [string, Record<string, unknown>?][], source = true): StatusView => ({
  payment_id: 'PAY-20261117-abcdef0123',
  state,
  events: [
    ['BANK_EVIDENCE_SUBMITTED', { bankInstruction: source ? { sourceMessage: {
      type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: 'M-1', instructionId: 'I-1',
      endToEndId: 'E-1', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10',
    } } : {} }] as [string, Record<string, unknown>],
    ...events,
  ].map(([type, payload], seq) => ({ seq, type, issuer: 'X', at: `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`, payload: payload ?? {} })),
});

test('status: each situation maps to one ISO 20022 code', () => {
  const s = (v: StatusView) => { const r = swiftStatusOf(v); return `${r.code}/${r.reason ?? ''}/${r.final}`; };
  assert.equal(s(view('BANK_AUTHORIZED', [])), 'ACTC//false');
  assert.equal(s(view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_SENT']])), 'PDNG/TRAVEL_RULE_PENDING/false');
  assert.equal(s(view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }]])), 'PDNG/RFI/false');
  assert.equal(s(view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RECEIVED']])), 'PDNG/TRAVEL_RULE_PENDING/false');
  assert.equal(s(view('PAYOUT_PRE_APPROVED', [])), 'ACSP/PAYOUT_PRE_APPROVED/false');
  assert.equal(s(view('ONCHAIN_SETTLED', [])), 'ACSP/ONCHAIN_SETTLED/false');
  assert.equal(s(view('PAYOUT_IN_PROGRESS', [])), 'ACSP/PAYOUT_IN_PROGRESS/false');
  assert.equal(s(view('PAYOUT_IN_PROGRESS', [['EVIDENCE_INSUFFICIENT']])), 'PDNG/EVIDENCE_INSUFFICIENT/false');
  assert.equal(s(view('BENEFICIARY_CREDIT_CONFIRMED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }]])), 'ACCC//true');
  assert.equal(s(view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }]])), 'ACCC//true');
  // Withdrawn at the bank's request: an interbank report says RJCT, with the reason — CANC is kept for API contexts.
  assert.equal(s(view('CANCELLED', [['CANCEL_REQUESTED', { reason: 'customer' }]])), 'RJCT/CANCELLED_BY_BANK/true');
  // A payout that failed and has not come back yet is no longer "in process".
  assert.equal(s(view('PAYOUT_IN_PROGRESS', [['PAYOUT_FAILED', { reason: 'closed account' }]])), 'PDNG/PAYOUT_FAILED/false');
  assert.equal(s(view('CANCELLED', [['TRAVEL_RULE_REJECTED', { reason: 'screening' }]])), 'RJCT/TRAVEL_RULE_REJECTED/true');
  assert.equal(s(view('RETURNED', [['PAYOUT_FAILED', { reason: 'closed account' }], ['USDC_RETURNED', { tx_hash: '0xabc' }]])), 'RJCT/RETURNED/true');
  assert.equal(s(view('EXCEPTION', [['EXCEPTION', { error: 'boom' }]])), 'PDNG/EXCEPTION/false');
  // Who has to act, where the payment will not move by itself.
  assert.equal(swiftStatusOf(view('EXCEPTION', [['EXCEPTION', { error: 'boom' }]])).needs, 'manual_resolution');
  assert.match(swiftStatusOf(view('EXCEPTION', [['EXCEPTION', { error: 'boom' }]])).detail[0]!, /No further status follows automatically/);
  assert.equal(swiftStatusOf(view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }]])).needs, 'bank_answer');
  assert.equal(swiftStatusOf(view('ONCHAIN_SETTLED', [])).needs, undefined);
  assert.equal(swiftStatusOf(view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }]])).creditReference, 'FAST-1');
  // The published table and the function agree on every state it lists.
  for (const row of SWIFT_STATUS_TABLE) assert.match(row.code, /^(ACTC|ACSP|ACCC|PDNG|RJCT)$/);
});

test('pacs.002: well formed, in schema order, pointing at the bank\'s own identifiers', () => {
  const long = 'Please describe the purpose of the payment and the nature of the underlying trade in full, '
    + 'and give the reference of the shipping documents that correspond to the invoice.';
  const xml = buildPacs002(view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: [long, 'B/L number <required> & date'] }]]),
    { createdAt: '2026-11-17T00:00:00.000Z' });
  const doc = parseXml(xml);
  assert.equal(doc.ns, 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10');
  const tx = findFirst(doc, 'TxInfAndSts')!;
  assert.deepEqual(tx.children.map((c) => c.name),
    ['StsId', 'OrgnlGrpInf', 'OrgnlInstrId', 'OrgnlEndToEndId', 'OrgnlUETR', 'TxSts', 'StsRsnInf', 'AccptncDtTm']);
  assert.equal(textAt(tx, 'OrgnlGrpInf/OrgnlMsgId'), 'M-1');
  assert.equal(textAt(tx, 'OrgnlGrpInf/OrgnlMsgNmId'), 'pacs.008.001.08');
  assert.equal(textAt(tx, 'OrgnlUETR'), '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10');
  assert.equal(textAt(tx, 'TxSts'), 'PDNG');
  assert.equal(textAt(tx, 'StsRsnInf/Rsn/Prtry'), 'RFI');
  const info = findFirst(tx, 'StsRsnInf')!.children.filter((c) => c.name === 'AddtlInf').map((c) => c.text);
  assert.ok(info.length >= 3 && info.every((t) => t.length <= 105), 'AddtlInf is Max105Text');
  assert.equal(info.join(' ').replace(/\s+/g, ' '), `${long} B/L number <required> & date`);
  assert.equal(textAt(findFirst(doc, 'GrpHdr'), 'MsgId')!.length <= 35, true);

  // The acceptance time is the time the instruction was accepted, whatever the status has become.
  assert.equal(textAt(tx, 'AccptncDtTm'), '2026-11-17T00:00:00.000Z');

  // A settlement that did not come from a SWIFT message still gets a report.
  const plain = parseXml(buildPacs002(view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-9' }]], false)));
  const ptx = findFirst(plain, 'TxInfAndSts')!;
  assert.deepEqual(ptx.children.map((c) => c.name), ['StsId', 'TxSts', 'AccptncDtTm', 'FctvIntrBkSttlmDt', 'AcctSvcrRef']);
  // …with the time of the credit where the schema puts it, apart from the acceptance time.
  assert.deepEqual([textAt(ptx, 'AccptncDtTm'), textAt(ptx, 'FctvIntrBkSttlmDt/DtTm')], ['2026-11-17T00:00:00.000Z', '2026-11-17T00:00:01.000Z']);
  assert.equal(sourceMessageOf(view('BANK_AUTHORIZED', [], false)), undefined);
  // A reference too long for its element is given in words, not cut short.
  const longRef = 'FAST-20261117-0000000000000000000099999';
  const lx = findFirst(parseXml(buildPacs002(view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: longRef }]]))), 'TxInfAndSts')!;
  assert.equal(textAt(lx, 'AcctSvcrRef'), undefined);
  assert.equal(textAt(lx, 'StsRsnInf/AddtlInf'), `Credit reference ${longRef}`);
});

test('pacs.002: text from another system cannot break the report', () => {
  const hostile = '<x> & "q" \u0001\u000B ]]> ' + 'long '.repeat(60);
  const xml = buildPacs002({
    payment_id: 'PAY-<&>-an-identifier-that-is-far-too-long-for-a-35-character-field',
    state: 'TRAVEL_RULE_PENDING',
    events: [
      { seq: 0, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'x', at: '2026-11-17T00:00:00Z', payload: { bankInstruction: { sourceMessage: {
        type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: hostile, instructionId: hostile, endToEndId: hostile, uetr: 'not-a-uuid',
      } } } },
      { seq: 1, type: 'TRAVEL_RULE_RFI', issuer: 'x', at: '2026-11-17T00:00:01Z', payload: { questions: [hostile, '', 3, null] } },
    ],
  });
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, 'no character XML 1.0 forbids');
  const tx = findFirst(parseXml(xml), 'TxInfAndSts')!;
  for (const name of ['StsId', 'OrgnlInstrId', 'OrgnlEndToEndId']) {
    const v = textAt(tx, name)!;
    assert.ok(v.length >= 1 && v.length <= 35, `${name} is Max35Text`);
  }
  assert.equal(textAt(tx, 'OrgnlUETR'), undefined, 'a reference that is not a UUID is left out, not emitted invalid');
  const info = findFirst(tx, 'StsRsnInf')!.children.filter((c) => c.name === 'AddtlInf');
  assert.ok(info.length > 0 && info.every((c) => c.text.length >= 1 && c.text.length <= 105));

  // A value made only of characters XML forbids is left out — never written as an empty element.
  const blank = buildPacs002({
    payment_id: 'PAY-1', state: 'TRAVEL_RULE_PENDING',
    events: [
      { seq: 0, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'x', at: '2026-11-17T00:00:00Z', payload: { bankInstruction: { sourceMessage: {
        type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: '\u0001\u0002\u0003', instructionId: '\u0001', endToEndId: 'E-1',
      } } } },
      { seq: 1, type: 'TRAVEL_RULE_RFI', issuer: 'x', at: '2026-11-17T00:00:01Z', payload: { questions: ['\u0001\u0002'] } },
    ],
  });
  assert.doesNotMatch(blank, /<(\w+)><\/\1>/, 'no empty element');
  const btx = findFirst(parseXml(blank), 'TxInfAndSts')!;
  assert.deepEqual(btx.children.map((c) => c.name), ['StsId', 'OrgnlEndToEndId', 'TxSts', 'StsRsnInf', 'AccptncDtTm']);
  assert.deepEqual(findFirst(btx, 'StsRsnInf')!.children.map((c) => c.name), ['Rsn']);
});

test('a UETR that is there but cannot be read refuses the message; the text block alone is read', () => {
  /*
   * A reviewer following the guide met both. A UETR one digit short was read
   * as "no UETR": no issue, nothing listed as not carried, the payment known
   * by its other references and its status report silent about the number the
   * bank's system had printed. And "the text block alone" — FIN's `{4:` … `-}`
   * with the header blocks cut away — was not recognised as a message at all.
   */
  const full = sample('mt103.structured.sample.txt').toString('latin1');
  const short = full.replace('{121:e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b28}', '{121:e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b2}');
  assert.throws(() => parseSwiftMessage(short),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'invalid_field' && e.field === 'block 3 field 121' && /not a UUID/.test(e.message));
  const xml = sample('pacs008.sample.xml').toString('utf8');
  assert.throws(() => parseSwiftMessage(xml.replace(/<UETR>[^<]+<\/UETR>/, '<UETR>3f1c9a52-7b0e-4d6a-9c1f</UETR>')),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'invalid_field' && e.field === 'PmtId/UETR');
  // Stating none is not an error, and an upper-case one is the same UETR.
  assert.equal(parseSwiftMessage(xml.replace(/\s*<UETR>[^<]+<\/UETR>/, '')).uetr, undefined);
  assert.equal(parseSwiftMessage(xml.replace(/<UETR>([^<]+)<\/UETR>/, (_m, u: string) => `<UETR>${u.toUpperCase()}</UETR>`)).uetr,
    '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10');

  // `{4:` … `-}` and nothing else: the same payment as the field lines alone.
  const block4 = /\{4:\r?\n[\s\S]*?\r?\n-\}/.exec(full)![0];
  const lines = block4.replace(/^\{4:\r?\n/, '').replace(/\r?\n-\}$/, '');
  const fromBlock = parseSwiftMessage(block4);
  const fromLines = parseSwiftMessage(lines);
  assert.equal(fromBlock.messageType, 'MT103');
  assert.deepEqual([fromBlock.instructionId, fromBlock.amount, fromBlock.debtor.name, fromBlock.creditor.account],
    [fromLines.instructionId, fromLines.amount, fromLines.debtor.name, fromLines.creditor.account]);
  assert.equal(swiftPaymentId('VN-BANK-T1', fromBlock), swiftPaymentId('VN-BANK-T1', fromLines));
  // Two of them in one file still cannot be told apart without their headers.
  assert.throws(() => parseSwiftMessages(`${block4}\r\n${block4}`),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'malformed_message');
});
