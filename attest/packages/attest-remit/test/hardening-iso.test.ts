/**
 * Inputs nobody had tried, found by porting the reader to Java and testing
 * the reference with them. Each test pins one fix: a message that was misread,
 * crashed the reader, or lost a payment without a word is now read correctly
 * or refused with a reason — never guessed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml, XmlError } from '../src/swift/xml.ts';
import { normaliseAmount } from '../src/swift/model.ts';
import { SwiftMessageError, mapSwiftPayment, parseSwiftMessage, parseSwiftMessages, swiftContentDigest } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string): string => readFileSync(path.join(HERE, '..', 'samples', name)).toString('utf8');
/** A sample without its XML declaration, to be put inside a wrapper. */
const docOf = (name: string): string => sample(name).replace(/^<\?xml[^>]*\?>\s*/, '');
const bodyOf = (xml: string): string => /<FIToFICstmrCdtTrf>[\s\S]*<\/FIToFICstmrCdtTrf>/.exec(xml)![0];
const UETR_1 = '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10';
const UETR_2 = '11111111-2222-4333-8444-555555555555';
const UETR_3 = '66666666-7777-4888-9999-000000000000';

/** The refusal a call ends in; anything else fails the test. */
const refusal = (fn: () => unknown): { code: string; message: string; field: string | undefined } => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SwiftMessageError) return { code: e.code, message: e.message, field: e.field };
    throw e;
  }
  return assert.fail('expected the message to be refused');
};

test('X1 xml: &valueOf; and every other Object.prototype name is an undefined entity, never text', () => {
  for (const name of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__']) {
    assert.throws(() => parseXml(`<Nm>&${name};</Nm>`), (e: unknown) => e instanceof XmlError && /is not defined/.test(e.message), name);
    assert.throws(() => parseXml(`<a b="&${name};"/>`), /is not defined/, `${name} in an attribute`);
  }
  // Through the whole reader: refused, not a company called "function valueOf() { [native code] }".
  const xml = sample('pacs008.sample.xml').replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>&valueOf;</Nm>');
  assert.throws(() => parseSwiftMessage(xml),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'malformed_message' && /entity &valueOf; is not defined/.test(e.message));
  // The five XML defines still read.
  assert.equal(parseXml('<a>&amp;&lt;&gt;&quot;&apos;</a>').text, '&<>"\'');
});

test('X2 xml: a hexadecimal character reference is written &#x — &#X is refused as malformed', () => {
  assert.equal(parseXml('<a>&#x43;&#67;</a>').text, 'CC');
  assert.throws(() => parseXml('<a>&#X43;</a>'), (e: unknown) => e instanceof XmlError && /malformed character reference &#X43;/.test(e.message));
  assert.throws(() => parseXml('<a b="&#X43;"/>'), /malformed character reference &#X43;/);
});

test('I1 iso: an element named after an Object.prototype member is refused as unsupported, not a TypeError', () => {
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    for (const xml of [
      `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><${name}/></Document>`,
      `<Document><${name}/></Document>`,
      `<Wrapper><${name}/></Wrapper>`,
      `<${name}/>`,
    ]) {
      assert.equal(refusal(() => parseSwiftMessages(xml)).code, 'unsupported_message', xml);
    }
  }
});

test('I2 iso: a remittance line with 200,000 /INV/ references is read in full, not a stack overflow', () => {
  const words = Array.from({ length: 200_000 }, (_, i) => `/INV/${i}`).join('');
  const xml = sample('pacs008.sample.xml').replace(/<Strd>[\s\S]*<\/Strd>/, `<Ustrd>${words}</Ustrd>`);
  const t0 = performance.now();
  const p = parseSwiftMessage(xml);
  assert.equal(p.invoiceReferences.length, 200_000);
  assert.deepEqual([p.invoiceReferences[0], p.invoiceReferences[199_999]], ['0', '199999']);
  assert.ok(performance.now() - t0 < 4_000, `200,000 references took ${Math.round(performance.now() - t0)} ms`);
});

test('I3 iso: a message standing outside a Document, beside documents, refuses the file instead of being dropped', () => {
  const doc = docOf('pacs008.sample.xml');
  const bare = bodyOf(doc).replace(UETR_1, UETR_2);
  for (const file of [`<Batch>${doc}${bare}</Batch>`, `<Batch>${bare}${doc}</Batch>`, `<Batch>${doc}<Inner>${bare}</Inner></Batch>`]) {
    const r = refusal(() => parseSwiftMessages(file));
    assert.equal(r.code, 'malformed_message', file.slice(0, 60));
    assert.equal(r.message, '<FIToFICstmrCdtTrf> stands outside a Document, beside the file\'s documents — put each message in a Document of its own');
  }
  // Only bare messages, or only documents: every payment is still read.
  assert.deepEqual(parseSwiftMessages(`<Batch>${bare}${bare.replace(UETR_2, UETR_3)}</Batch>`).map((p) => p.uetr), [UETR_2, UETR_3]);
  assert.deepEqual(parseSwiftMessages(`<Batch>${doc}${doc.replace(UETR_1, UETR_2)}</Batch>`).map((p) => p.uetr), [UETR_1, UETR_2]);
});

test('I4 iso: a Document holding two messages is refused, not read as the first of them', () => {
  const xml = sample('pacs008.sample.xml');
  const body = bodyOf(xml);
  const two = refusal(() => parseSwiftMessages(xml.replace(body, body + body.replace(UETR_1, UETR_2))));
  assert.equal(two.code, 'malformed_message');
  assert.equal(two.message, 'the document holds 2 messages (<FIToFICstmrCdtTrf>) — a Document carries one message; put each in a Document of its own');
  // A pain.001 beside the pacs.008 in the same Document: the same.
  const pain = /<CstmrCdtTrfInitn>[\s\S]*<\/CstmrCdtTrfInitn>/.exec(sample('pain001.sample.xml'))![0];
  const mixed = refusal(() => parseSwiftMessages(xml.replace(body, body + pain)));
  assert.equal(mixed.code, 'malformed_message');
  assert.match(mixed.message, /holds 2 messages \(<FIToFICstmrCdtTrf>, <CstmrCdtTrfInitn>\)/);
});

test('I5 iso: an element before, after or instead of the message is named — the document is not called another type', () => {
  const xml = sample('pacs008.sample.xml');
  const before = refusal(() => parseSwiftMessages(xml.replace('<FIToFICstmrCdtTrf>', '<Extra/><FIToFICstmrCdtTrf>')));
  assert.deepEqual([before.code, before.message], ['unsupported_message',
    'the document holds <Extra> before its message <FIToFICstmrCdtTrf> — a Document carries its message and nothing else']);
  const after = refusal(() => parseSwiftMessages(xml.replace('</FIToFICstmrCdtTrf>', '</FIToFICstmrCdtTrf><FICdtTrf/>')));
  assert.deepEqual([after.code, after.message], ['unsupported_message',
    'the document holds <FICdtTrf> after its message <FIToFICstmrCdtTrf> — a Document carries its message and nothing else']);
  const instead = refusal(() => parseSwiftMessages('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><Extra/></Document>'));
  assert.deepEqual([instead.code, instead.message], ['unsupported_message',
    'the document declares pain.001.001.09 but holds <Extra> where its message <CstmrCdtTrfInitn> belongs']);
  const empty = refusal(() => parseSwiftMessages('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"/>'));
  assert.equal(empty.message, 'the document declares pacs.008.001.08 but holds nothing where its message <FIToFICstmrCdtTrf> belongs');
  for (const r of [before, after, instead, empty]) assert.doesNotMatch(r.message, /not a customer credit transfer/);
  // A document of another kind is still called what it is.
  assert.match(refusal(() => parseSwiftMessages('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document>')).message,
    /^the document is pacs\.009\.001\.08, not a customer credit transfer/);
});

test('I6 iso: a test BIC in a bare message\'s own agent still marks a test, reported by its path — not as a header it lacks', () => {
  const doc = docOf('pacs008.sample.xml');
  const bare = doc.replace(/<Document[^>]*>/, '').replace('</Document>', '')
    .replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>', '<BICFI>DEMOSGS0</BICFI>\n          <Nm>');
  const where = 'FIToFICstmrCdtTrf/CdtTrfTxInf/CdtrAgt/FinInstnId/BICFI';
  const p = parseSwiftMessage(bare);
  assert.deepEqual(p.test, { where, what: 'test and training BIC DEMOSGS0' });
  assert.ok(mapSwiftPayment(p).issues.some((i) => i.target === 'instruction' && i.source === where));
  // Inside a wrapper the path starts at the wrapper.
  assert.equal(parseSwiftMessage(`<Batch>${bare}</Batch>`).test?.where, `Batch/${where}`);
  // In a real Business Application Header it is still the header.
  const bah = `<Envelope><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"><Fr><FIId><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></FIId></Fr></AppHdr>${doc}</Envelope>`;
  assert.deepEqual(parseSwiftMessage(bah).test, { where: 'Business Application Header', what: 'test and training BIC DEMOVNV0' });
});

test('I7 iso: an agent identified only by FinInstnId/Othr is kept, with its scheme, and named as not carried', () => {
  const xml = sample('pacs008.sample.xml').replace('<Dbtr>',
    '<IntrmyAgt1><FinInstnId><Othr><Id>INTERMEDIARY-77</Id><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr></FinInstnId></IntrmyAgt1>'
    + '<IntrmyAgt2><FinInstnId><Othr><Id>CORR-2</Id><SchmeNm><Prtry>BANKCODE</Prtry></SchmeNm></Othr></FinInstnId></IntrmyAgt2>'
    + '<IntrmyAgt3><FinInstnId><Othr><Id>CORR-3</Id></Othr></FinInstnId></IntrmyAgt3><Dbtr>');
  const p = parseSwiftMessage(xml);
  assert.deepEqual(p.intermediaryAgents, [
    { memberId: 'INTERMEDIARY-77', clearingSystem: 'NCCC' }, { memberId: 'CORR-2', clearingSystem: 'BANKCODE' }, { memberId: 'CORR-3' },
  ]);
  const notCarried = mapSwiftPayment(p).unmapped.filter((u) => /INTERMEDIARY-77|CORR-2|CORR-3/.test(u.value));
  assert.equal(notCarried.length, 3, 'each intermediary is listed as not carried');
  // A clearing-system member id still comes first, with its own clearing system.
  const both = parseSwiftMessage(sample('pacs008.sample.xml').replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>',
    '<ClrSysMmbId><ClrSysId><Cd>SGIBG</Cd></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'
    + '<Othr><Id>X-1</Id><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr>'));
  assert.deepEqual(both.creditorAgent, { name: 'Demo Payout Bank (SG)', memberId: '7171', clearingSystem: 'SGIBG' });
});

test('I9 iso: an XML amount with a comma is refused, while an MT103 keeps its decimal comma', () => {
  const xml = sample('pacs008.sample.xml');
  for (const [from, to, field] of [
    ['<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">12,500</InstdAmt>', 'CdtTrfTxInf[1]/InstdAmt'],
    ['<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD">12500,00</IntrBkSttlmAmt>', 'CdtTrfTxInf[1]/IntrBkSttlmAmt'],
  ] as const) {
    const r = refusal(() => parseSwiftMessage(xml.replace(from, to)));
    assert.deepEqual([r.code, r.field], ['invalid_field', field]);
    assert.match(r.message, /is not an amount/);
  }
  const pain = refusal(() => parseSwiftMessage(sample('pain001.sample.xml').replace('<InstdAmt Ccy="USD">4300.00', '<InstdAmt Ccy="USD">4300,00')));
  assert.deepEqual([pain.code, pain.field], ['invalid_field', 'PmtInf[1]/CdtTrfTxInf[1]/Amt/InstdAmt']);
  // The function: a comma is a decimal mark only where the caller — a reader of FIN — says so.
  // Said nothing, it is refused: nobody reads a thousands separator as a decimal mark by default.
  assert.throws(() => normaliseAmount('12,5', '32A'),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'invalid_field' && e.message === '32A: "12,5" is not an amount');
  assert.equal(normaliseAmount('12,5', '32A', { decimalComma: true }), '12.5');
  assert.equal(normaliseAmount('12500.00', 'InstdAmt', { decimalComma: false }), '12500.00');
  assert.throws(() => normaliseAmount('12,500', 'InstdAmt', { decimalComma: false }),
    (e: unknown) => e instanceof SwiftMessageError && e.code === 'invalid_field' && e.message === 'InstdAmt: "12,500" is not an amount');
  // MT103 still reads its amounts.
  assert.deepEqual(parseSwiftMessage(sample('mt103.sample.txt')).amount, { currency: 'USD', value: '6150' });
});

test('I10 iso: a ChrgBr outside DEBT, CRED, SHAR, SLEV is refused — in pacs.008 and at either level of a pain.001', () => {
  const pacs = refusal(() => parseSwiftMessage(sample('pacs008.sample.xml').replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>OUR</ChrgBr>')));
  assert.deepEqual([pacs.code, pacs.field, pacs.message],
    ['invalid_field', 'CdtTrfTxInf[1]/ChrgBr', 'CdtTrfTxInf[1]/ChrgBr: "OUR" is not DEBT, CRED, SHAR or SLEV']);
  const pain = sample('pain001.sample.xml');
  // In the transaction it no longer hides the block's DEBT …
  const tx = refusal(() => parseSwiftMessage(pain.replace('<Amt>', '<ChrgBr>BEN</ChrgBr><Amt>')));
  assert.deepEqual([tx.code, tx.field], ['invalid_field', 'PmtInf[1]/CdtTrfTxInf[1]/ChrgBr']);
  // … and in the block it is not passed over either.
  const block = refusal(() => parseSwiftMessage(pain.replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>SHA</ChrgBr>')));
  assert.deepEqual([block.code, block.field], ['invalid_field', 'PmtInf[1]/ChrgBr']);
  // The four codes read, and a transaction's own value still overrides its block's.
  assert.equal(parseSwiftMessage(pain).chargeBearer, 'DEBT');
  assert.equal(parseSwiftMessage(pain.replace('<Amt>', '<ChrgBr>SLEV</ChrgBr><Amt>')).chargeBearer, 'SLEV');
});

test('P1 parse: XML behind a no-break space is refused as the same bytes without it are — never read in a guessed code page', () => {
  const xml = sample('pacs008.sample.xml').replace('Vina Trading Co., Ltd.', 'Société Générale Import');
  const latin = Buffer.from(xml, 'latin1');
  const plain = refusal(() => parseSwiftMessages(latin));
  assert.equal(plain.code, 'malformed_message');
  assert.match(plain.message, /^the message is read as UTF-8 but holds bytes that are not valid in it/);
  for (const lead of [[0xa0], [0x20, 0xa0, 0x0a]]) {
    assert.deepEqual(refusal(() => parseSwiftMessages(Buffer.concat([Buffer.from(lead), latin]))), plain, JSON.stringify(lead));
  }
  // UTF-8 behind a lone 0xA0 is not UTF-8 either: refused, not read as "SociÃ©tÃ©".
  assert.deepEqual(refusal(() => parseSwiftMessages(Buffer.concat([Buffer.from([0xa0]), Buffer.from(xml, 'utf8')]))), plain);
  // FIN text in a single-byte code page still reads.
  const fin = Buffer.from(sample('mt103.sample.txt').replace('HO CHI MINH CITY', 'HÔ CHI MINH CITY'), 'latin1');
  assert.deepEqual(parseSwiftMessage(fin).debtor.addressLines, ['12 LE LOI BLVD DISTRICT 1', 'HÔ CHI MINH CITY']);
});

test('P2 parse: a string is held to the 4 MiB bound by the UTF-8 bytes it is hashed as, not by its UTF-16 length', () => {
  const xml = sample('pacs008.sample.xml');
  const padded = (n: number): string => xml.replace('</Document>', `</Document><!-- ${'é'.repeat(n)} -->`);
  const over = padded(2_097_153);
  assert.ok(over.length < 4 * 1024 * 1024 && Buffer.byteLength(over) > 4 * 1024 * 1024);
  const r = refusal(() => parseSwiftMessages(over));
  assert.equal(r.code, 'malformed_message');
  assert.match(r.message, /^the message is larger than 4194304 bytes/);
  assert.deepEqual(refusal(() => parseSwiftMessages(Buffer.from(over, 'utf8'))), r, 'the same message as bytes, the same refusal');
  // Under the bound in bytes, the message is read.
  const under = padded(2_090_000);
  assert.ok(Buffer.byteLength(under) <= 4 * 1024 * 1024);
  assert.equal(parseSwiftMessages(under).length, 1);
});

test('P3 parse: a declared encoding is decoded by the reader\'s own table, the same on every runtime, and any other label is refused', () => {
  const xml = sample('pacs008.sample.xml');
  const withName = (label: string, raw: readonly number[]): Buffer => {
    const [a, b] = xml.replace('encoding="UTF-8"', `encoding="${label}"`).split('Vina Trading Co., Ltd.');
    return Buffer.concat([Buffer.from(`${a!}Co `, 'latin1'), Buffer.from(raw), Buffer.from(` Ltd${b!}`, 'latin1')]);
  };
  const nameIn = (label: string, raw: readonly number[]): string => parseSwiftMessage(withName(label, raw)).debtor.name!.slice(3, -4);
  const high = Array.from({ length: 0x80 }, (_, i) => 0x80 + i);
  const latin1 = String.fromCharCode(...high);
  // The WHATWG index for 0x80–0x9F, written out here apart from the reader's own table.
  const cp1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F'
    + '\u0090‘’“”•–—˜™š›œ\u009DžŸ' + latin1.slice(0x20);
  for (const label of ['windows-1252', 'cp1252', 'x-cp1252', 'WINDOWS-1252', ' Windows-1252 ']) {
    assert.equal(nameIn(label, high), cp1252, label);
  }
  for (const label of ['iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'iso-ir-100', 'csisolatin1',
    'latin1', 'l1', 'cp819', 'ibm819', 'ISO-8859-1', '\tLatin1 ']) {
    assert.equal(nameIn(label, high), latin1, label);
  }
  for (const label of ['us-ascii', 'ascii', 'ansi_x3.4-1968', 'US-ASCII']) {
    assert.equal(nameIn(label, [0x41, 0x7e]), 'A~', label);
    const r = refusal(() => parseSwiftMessage(withName(label, [0x41, 0xe9])));
    assert.deepEqual([r.code, r.message], ['malformed_message', `the message declares ${label} but holds bytes that are not ASCII — `
      + 'it was written in another code page; export it as UTF-8, or declare the encoding it is really in'], label);
  }
  for (const label of ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8', 'UTF8 ']) {
    assert.equal(nameIn(label, [0xc3, 0xa9]), 'é', label);
  }
  for (const label of ['EUC-KR', 'Shift_JIS', 'ISO-8859-2', 'windows-1251', 'UTF-7', 'KLINGON-1', 'utf 8', '']) {
    const r = refusal(() => parseSwiftMessage(withName(label, [0x41])));
    assert.deepEqual([r.code, r.message],
      ['malformed_message', `the message declares encoding "${label}", which this reader does not know — send it as UTF-8`], label);
  }
});

test('follow-up iso: an empty UETR element states no UETR — and the payment is still the one sent with it', () => {
  const xml = sample('pacs008.sample.xml');
  const withIt = parseSwiftMessage(xml);
  for (const empty of ['<UETR></UETR>', '<UETR/>', '<UETR>  </UETR>']) {
    const read = parseSwiftMessage(xml.replace(/<UETR>[^<]+<\/UETR>/, empty));
    assert.equal(read.uetr, undefined, empty);
    // Recognisable as the same payment by what the twin rule compares.
    assert.deepEqual([read.instructionId, read.endToEndId, read.valueDate, swiftContentDigest(read)],
      [withIt.instructionId, withIt.endToEndId, withIt.valueDate, swiftContentDigest(withIt)], empty);
  }
  // A UETR that is there and is not a UUID is another matter: it refuses the message.
  assert.deepEqual(refusal(() => parseSwiftMessage(xml.replace(/<UETR>[^<]+<\/UETR>/, '<UETR>not-a-uuid</UETR>'))).field, 'PmtId/UETR');
});

test('follow-up iso: /INV/ with nothing behind it carries no invoice — the next code word is not taken for one', () => {
  const xml = sample('pacs008.sample.xml');
  const ustrd = (text: string): string => xml.replace(/<RmtInf>[\s\S]*<\/RmtInf>/, `<RmtInf><Ustrd>${text}</Ustrd></RmtInf>`);
  assert.deepEqual(parseSwiftMessage(ustrd('/INV//ROC/PO-7811')).invoiceReferences, []);
  assert.deepEqual(parseSwiftMessage(ustrd('/INV/INV-1//INV-2/ROC/PO-7811')).invoiceReferences, ['INV-1', 'INV-2']);
  assert.deepEqual(parseSwiftMessage(ustrd('/INV/')).invoiceReferences, []);
  // The same line in an MT103's field 70.
  const mt = sample('mt103.sample.txt').replace('/INV/INV-2026-0475', '/INV/');
  const read = parseSwiftMessage(mt);
  assert.deepEqual([read.invoiceReferences, read.endToEndId], [[], 'PO-7811']);
});
