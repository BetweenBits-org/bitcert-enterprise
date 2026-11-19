/**
 * The inputs the golden vectors are made from.
 *
 * Every case is an input the TypeScript SDK has an answer for — a message
 * that is read, or one that is refused and why. `make-golden.mjs` runs them
 * through `packages/attest-remit` and writes what comes back; the Java port
 * has to give the same answer to the same bytes.
 *
 * A case is data, never a call into the SDK: this file must not import it.
 * Add a case by adding an entry; the name is how a failing Java test names it.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES = path.resolve(HERE, '../../../packages/attest-remit/samples');
const bytes = (name) => readFileSync(path.join(SAMPLES, name));
const text = (name) => bytes(name).toString('utf8');
const latin1 = (name) => bytes(name).toString('latin1');

/** The institutions a payment id is computed for: the id depends on who sends. */
export const INSTITUTIONS = ['VN-BANK-T1', 'VN-BANK-001'];

void randomUUID; // inputs are fixed text: a vector that changed from run to run would prove nothing

const PACS = text('pacs008.sample.xml');
const PAIN = text('pain001.sample.xml');
const ENVELOPE = text('pacs008.envelope.sample.xml');
const MT_FREE = latin1('mt103.sample.txt');
const MT_STRUCT = latin1('mt103.structured.sample.txt');
/** The pain.001 sample as many systems write it: no instruction id, and NOTPROVIDED where the end-to-end id goes. */
const PAIN_PLAIN = PAIN.replace(/\s*<InstrId>[^<]+<\/InstrId>/, '').replace(/<EndToEndId>[^<]+<\/EndToEndId>/, '<EndToEndId>NOTPROVIDED</EndToEndId>');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const block4 = (mt) => /\{4:\r?\n[\s\S]*?\r?\n-\}/.exec(mt)[0];
const fieldLines = (mt) => block4(mt).replace(/^\{4:\r?\n/, '').replace(/\r?\n-\}$/, '');
const secondMt = MT_STRUCT.replace('e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b28', '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f').replaceAll('OUT2026000126', 'OUT2026000127');

/**
 * Parse cases. `input` is a Buffer (handed over as bytes) or a string (handed
 * over as text). `repeat` describes an input too large to store.
 */
export function parseCases() {
  const c = [];
  const add = (name, input, note = '') => c.push({ name, input, note });

  // ── The samples the guide's examples read ──
  add('sample/pacs008', bytes('pacs008.sample.xml'), 'the guide\'s pacs.008');
  add('sample/pacs008-envelope', bytes('pacs008.envelope.sample.xml'), 'Business Application Header, prefixes, free-form address');
  add('sample/pain001', bytes('pain001.sample.xml'));
  add('sample/mt103-free-format', bytes('mt103.sample.txt'), '50K / 59: the customer master supplies the registration number');
  add('sample/mt103-structured', bytes('mt103.structured.sample.txt'), '50F / 59F');
  add('sample/pacs008-as-text', PACS, 'the same message handed over as a string');
  add('sample/mt103-as-text', MT_FREE, 'a FIN message handed over as a string');

  // ── MT103: the shapes an export really has ──
  add('mt/crlf', Buffer.from(crlf(MT_FREE), 'latin1'), 'CRLF line ends');
  add('mt/field-lines-only', Buffer.from(fieldLines(MT_FREE), 'latin1'), 'no header blocks: the fields from :20: on');
  add('mt/text-block-alone', Buffer.from(block4(MT_FREE), 'latin1'), '{4: … -} and nothing else');
  add('mt/two-text-blocks', Buffer.from(`${block4(MT_FREE)}\r\n${block4(MT_STRUCT)}`, 'latin1'), 'two messages cannot be told apart without their headers');
  add('mt/two-messages', Buffer.from(`${MT_STRUCT}${secondMt}`, 'latin1'), 'one after another');
  add('mt/batch-dollar', Buffer.from(`${MT_STRUCT}$\r\n${secondMt}`, 'latin1'), 'separated by $ as a batch export writes them');
  add('mt/same-ids-twice', Buffer.from(`${MT_STRUCT}$\r\n${MT_STRUCT}`, 'latin1'), 'the identifiers repeat inside the file: only the position tells them apart');
  add('mt/no-uetr', Buffer.from(MT_FREE.replace(/\{3:\{121:[^}]*\}\}/, ''), 'latin1'), 'no block 3');
  add('mt/uetr-upper-case', Buffer.from(MT_FREE.replace('b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', 'B4D9E7A1-5C36-4F82-A1D0-6E9F3C2B8A57'), 'latin1'));
  add('mt/uetr-not-a-uuid', Buffer.from(MT_FREE.replace('b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a5'), 'latin1'), 'one digit short');
  add('mt/mt202', Buffer.from('{1:F01DEMOVNVXAXXX0000000000}{2:I202DEMOSGSGXXXXN}{4:\r\n:20:COV1\r\n:21:REL1\r\n:32A:261117USD6150,\r\n:58A:DEMOSGSG\r\n-}', 'latin1'), 'not a customer credit transfer');
  add('mt/cover-without-headers', Buffer.from(':20:COV1\r\n:21:OUT2026000125\r\n:32A:261117USD6150,\r\n:52A:DEMOVNVX\r\n:58A:DEMOSGSG\r\n:50K:/VN-ACC-000777\r\nVINA TRADING CO LTD\r\n:59:/SG-ACC-000009\r\nPACIFIC SUPPLY PTE LTD\r\n', 'latin1'), 'a cover shares most of an MT103\'s fields');
  add('mt/field-twice', Buffer.from(MT_FREE.replace(':33B:USD6150,', ':32A:261117USD9999,'), 'latin1'), 'two 32A');
  add('mt/two-options', Buffer.from(MT_FREE.replace(':52A:DEMOVNVX', ':59A:DEMOSGSG'), 'latin1'), '59 and 59A');
  add('mt/lower-case-tag', Buffer.from(MT_FREE.replace(':71A:OUR', ':71a:OUR'), 'latin1'));
  add('mt/indented-tag', Buffer.from(MT_FREE.replace(':71A:OUR', ' :71A:OUR'), 'latin1'));
  add('mt/no-beneficiary', Buffer.from(MT_FREE.replace(/:59:[\s\S]*?(?=:70:)/, ''), 'latin1'), 'mandatory 59a missing');
  add('mt/text-after-end', Buffer.from(fieldLines(MT_FREE) + '\r\n-}\r\n:20:SECOND\r\n', 'latin1'));
  add('mt/crts', Buffer.from(MT_FREE.replace(':23B:CRED', ':23B:CRTS'), 'latin1'), 'says of itself that it is a test');
  add('mt/test-bic', Buffer.from(MT_FREE.replace('{1:F01DEMOVNVXAXXX', '{1:F01DEMOVNV0AXXX'), 'latin1'), 'a test and training BIC in the header');
  add('mt/charges', Buffer.from(MT_FREE.replace(':71A:OUR', ':71A:SHA\r\n:71F:USD15,\r\n:71F:USD5,50').replace(':33B:USD6150,', ':33B:USD6170,50'), 'latin1'), 'SHA with deducted charges');
  add('mt/intermediary-and-purpose', Buffer.from(MT_FREE.replace(':57A:DEMOSGSG', ':56A:AAAAUS33\r\n:57A:DEMOSGSG').replace(':70:/INV/', ':26T:GDS\r\n:70:/INV/'), 'latin1'));
  add('mt/eur', Buffer.from(MT_FREE.replace(':32A:261117USD6150,', ':32A:261117EUR6150,').replace(':33B:USD6150,', ':33B:EUR6150,'), 'latin1'), 'no USD amount at all');
  add('mt/amount-forms', Buffer.from(MT_FREE.replace(':32A:261117USD6150,', ':32A:261117USD6150,5').replace(':33B:USD6150,', ':33B:USD6150,50'), 'latin1'));

  // ── ISO 20022 ──
  add('xml/utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PACS, 'utf8')]));
  add('xml/utf16le-bom', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]));
  add('xml/utf16be-bom', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le').swap16()]));
  add('xml/utf16-cut-off', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PACS, 'utf16le').subarray(0, 401)]), 'an odd number of bytes');
  add('xml/latin1-declared', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace('Vina Trading Co., Ltd.', 'Viña Trading Co., Ltd.'), 'latin1'));
  add('xml/latin1-undeclared', Buffer.from(PACS.replace('Vina Trading Co., Ltd.', 'Viña Trading Co., Ltd.'), 'latin1'), 'bytes that are not valid UTF-8, and no other encoding declared');
  add('xml/unknown-encoding', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="KLINGON-8"'), 'utf8'));
  add('xml/doctype', Buffer.from(PACS.replace('<Document', '<!DOCTYPE Document [<!ENTITY x "y">]>\n<Document'), 'utf8'));
  add('xml/duplicate-debtor', Buffer.from(PACS.replace(/(<Dbtr>[\s\S]*?<\/Dbtr>)/, '$1\n      <Dbtr><Nm>Another Debtor</Nm></Dbtr>'), 'utf8'), 'an element that may occur once occurs twice');
  add('xml/foreign-namespace-twin', Buffer.from(PACS.replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<x:IntrBkSttlmAmt xmlns:x="urn:other" Ccy="USD">1.00</x:IntrBkSttlmAmt>\n      <IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>'), 'utf8'));
  add('xml/undeclared-prefix', Buffer.from(PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<q:Nm>Vina Trading Co., Ltd.</q:Nm>'), 'utf8'));
  add('xml/not-well-formed', Buffer.from(PACS.replace('</CdtTrfTxInf>', ''), 'utf8'));
  add('xml/control-character', Buffer.from(PACS.replace('PO-7781', 'PO-\u000177'), 'utf8'));
  add('xml/entities-and-cdata', Buffer.from(PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm>Vina &amp; Sons <![CDATA[<Trading>]]> &#x43;o., Ltd.</Nm>'), 'utf8'));
  add('xml/uetr-not-a-uuid', Buffer.from(PACS.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '3f1c9a52-7b0e-4d6a-9c1f'), 'utf8'));
  add('xml/no-uetr', Buffer.from(PACS.replace(/\s*<UETR>[^<]+<\/UETR>/, ''), 'utf8'));
  add('xml/pacs009', Buffer.from(PACS.replaceAll('pacs.008.001.08', 'pacs.009.001.08').replaceAll('FIToFICstmrCdtTrf', 'FICdtTrf'), 'utf8'), 'a bank-to-bank transfer, not a customer credit transfer');
  add('xml/version-12', Buffer.from(PACS.replaceAll('pacs.008.001.08', 'pacs.008.001.12'), 'utf8'));
  add('xml/two-transactions', Buffer.from(PACS.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m}\n    ${m.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f').replace('OUT-2026-000123', 'OUT-2026-000124').replace('12500.00</IntrBkSttlmAmt>', '800.25</IntrBkSttlmAmt>').replace('12500.00</InstdAmt>', '800.25</InstdAmt>')}`).replace('<NbOfTxs>1</NbOfTxs>', '<NbOfTxs>2</NbOfTxs>'), 'utf8'));
  add('xml/two-documents', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<Batch xmlns="urn:example:batch">\n${PACS.replace(/<\?xml[^>]*\?>\s*/, '').replace(/<!--[\s\S]*?-->\s*/, '')}\n${PACS.replace(/<\?xml[^>]*\?>\s*/, '').replace(/<!--[\s\S]*?-->\s*/, '').replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a').replace('DEMOVNVX20261117000123', 'DEMOVNVX20261117000124').replace('OUT-2026-000123', 'OUT-2026-000125')}\n</Batch>`, 'utf8'), 'a wrapper around several documents');
  add('xml/private-person', Buffer.from(PACS.replace(/<OrgId>[\s\S]*?<\/OrgId>/, '<PrvtId><Othr><Id>C1234567</Id><SchmeNm><Cd>CCPT</Cd></SchmeNm></Othr></PrvtId>'), 'utf8'));
  add('xml/creditor-in-us', Buffer.from(PACS.replace('<Ctry>SG</Ctry>', '<Ctry>US</Ctry>').replaceAll('<BICFI>DEMOSGSG</BICFI>', '<BICFI>AAAAUS33</BICFI>'), 'utf8'), 'another route');
  add('xml/instructed-less-than-settled', Buffer.from(PACS.replace('12500.00</InstdAmt>', '12480.00</InstdAmt>'), 'utf8'), 'OUR with prepaid receiver\'s charges');
  add('xml/settled-less-than-instructed', Buffer.from(PACS.replace('12500.00</IntrBkSttlmAmt>', '12475.00</IntrBkSttlmAmt>').replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>SHAR</ChrgBr>'), 'utf8'), 'charges already deducted');
  add('xml/eur-settled-usd-instructed', Buffer.from(PACS.replace('<IntrBkSttlmAmt Ccy="USD">12500.00', '<IntrBkSttlmAmt Ccy="EUR">11800.00'), 'utf8'));
  add('xml/pain001-two-blocks', Buffer.from(PAIN.replace(/(<PmtInf>[\s\S]*<\/PmtInf>)/, (m) => `${m}\n    ${m.replace('VINATRD-PMT-0031', 'VINATRD-PMT-0032').replaceAll('VINATRD-INS-0031-1', 'VINATRD-INS-0032-1')}`), 'utf8'));
  add('xml/pain001-same-ids', Buffer.from(PAIN.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m}\n      ${m}`), 'utf8'), 'the same identifiers on two transactions of one block');

  // ── Not a message at all ──
  add('other/empty', Buffer.alloc(0));
  add('other/whitespace', Buffer.from('  \r\n\t\n', 'utf8'));
  add('other/plain-text', Buffer.from('Dear bank, please pay 100 USD to Pacific Supply.\n', 'utf8'));
  add('other/json', Buffer.from('{"amount":"100.00"}', 'utf8'));
  add('other/html', Buffer.from('<html><body>Request blocked</body></html>', 'utf8'));
  c.push({ name: 'other/too-large', repeat: { text: 'A', times: 4 * 1024 * 1024 + 1 }, note: 'over the 4 MiB bound' });

  // ── The bound, from both sides. `as: 'string'` hands the repeated text over as
  //    a string, after `prefix`: a string is measured in UTF-16 units, bytes in bytes ──
  c.push({ name: 'other/at-the-bound', repeat: { text: 'A', times: 4 * 1024 * 1024 }, note: 'exactly 4 MiB: not refused for its size' });
  c.push({ name: 'other/too-large-as-text', as: 'string', repeat: { text: 'A', times: 4 * 1024 * 1024 + 1 } });
  c.push({ name: 'mt/padded-past-the-bound', as: 'string', repeat: { prefix: MT_STRUCT, text: ' ', times: 4 * 1024 * 1024 }, note: 'size is bounded for every family' });
  c.push({ name: 'other/text-under-the-bound-in-units', as: 'string', repeat: { text: 'é', times: 2 * 1024 * 1024 + 1 }, note: '2,097,153 characters, 4,194,306 bytes once written as UTF-8' });

  // ── test/swift.test.ts, top to bottom: every other input a test hands to the
  //    reader, built the way the test builds it ──

  // The XML reader's own tests. Through the parser their text gets the answer a
  // port's XML reader has to give: the same refusal, or no payment document.
  add('xml/reader-namespaces-cdata-entities', `<?xml version="1.0"?>
    <!-- a comment with <tags> in it -->
    <e:Envelope xmlns:e="urn:env" xmlns="urn:default">
      <Doc a="1 &amp; 2" e:b='x'><![CDATA[5 < 6 & more]]> tail &lt;ok&gt; &#x41;&#66;</Doc>
      <Empty/>
    </e:Envelope>`, 'read, and holds no payment document');
  add('xml/reader-external-entity', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', 'a document type declaration is refused, and every entity trick with it');
  add('xml/reader-undefined-entity', '<a>&undefined;</a>');
  add('xml/reader-bare-ampersand', '<a>R & D</a>');
  add('xml/reader-crossed-tags', '<a><b></a></b>');
  add('xml/reader-second-root', '<a></a><b></b>');
  add('xml/reader-never-closed', '<a><b>');
  add('xml/reader-undeclared-prefix', '<p:a/>');
  add('xml/reader-nested-too-deep', `<a>${'<b>'.repeat(70)}`);
  add('xml/reader-attribute-twice', '<a x="1" x="2"/>');
  add('xml/reader-undeclared-attribute-prefix', '<a p:x="1"/>');
  add('xml/reader-prefixed-attribute-beside-plain', '<a xmlns:p="urn:p" Ccy="USD" p:Ccy="EUR"/>');
  add('xml/reader-xml-lang', '<a xml:lang="en" Ccy="USD"/>');
  add('xml/reader-declaration-words-in-comment-and-cdata', '<a><!-- <!DOCTYPE x> --><![CDATA[<!ENTITY y>]]></a>', 'the words inside a comment or a CDATA section are text, not a declaration');
  add('xml/reader-doctype-inside-element', '<a><!DOCTYPE x></a>');
  add('xml/reader-control-character', '<a>\u0001</a>');
  add('xml/reader-lone-surrogate', '<a>\uD800</a>');
  add('xml/reader-surrogate-pair', '<a>\uD83D\uDE00</a>', 'a proper surrogate pair is a character');
  const prefixes = (n) => Array.from({ length: n }, (_, i) => `xmlns:p${i}="urn:${i}"`).join(' ');
  add('xml/reader-60-prefixes', `<a ${prefixes(60)}><p59:b/></a>`);
  add('xml/reader-65-prefixes', `<a ${prefixes(65)}/>`);

  // "pacs.008: older spellings (BIC, BICOrBEI) and a bare document are accepted"
  add('xml/older-spellings-bare-body', `<FIToFICstmrCdtTrf>
    <GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-01-02T03:04:05Z</CreDtTm></GrpHdr>
    <CdtTrfTxInf>
      <PmtId><EndToEndId>E1</EndToEndId></PmtId>
      <IntrBkSttlmAmt Ccy="USD">10</IntrBkSttlmAmt>
      <Dbtr><Nm>A</Nm><Id><OrgId><BICOrBEI>AAAAVNVX</BICOrBEI></OrgId></Id></Dbtr>
      <DbtrAgt><FinInstnId><BIC>BBBBVNVX</BIC></FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId><BIC>CCCCSGSG</BIC></FinInstnId></CdtrAgt>
      <Cdtr><Nm>B</Nm></Cdtr>
    </CdtTrfTxInf></FIToFICstmrCdtTrf>`, 'BIC and BICOrBEI, and no Document around the body');

  // "MT103: the text block alone, a coded party identifier, and an output header"
  add('mt/bare-coded-party-identifier', ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50F:TXID/VN/0312345678\n1/A CO\n2/1 STREET\n3/VN/HANOI\n:59:/ACC9\nB LTD\n:71A:BEN\n');
  add('mt/output-header', '{1:F01RCVRSGSGAXXX0000000000}{2:O1031200261117SNDRVNVXAXXX00000000002611171201N}{4:\n:20:R2\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:B\n:71A:SHA\n-}', 'the sender sits in the input reference of an output header');

  // "messages that are not one customer credit transfer are refused with a reason"
  add('other/hello', 'hello');
  add('other/empty-string', '');
  add('mt/mt202-minimal', '{1:F01AAAAVNVXAXXX0000000000}{2:I202BBBBSGSGXXXXN}{4:\n:20:X\n-}');
  add('mt/no-end-of-text-marker', '{1:F01AAAAVNVXAXXX0000000000}{2:I103BBBBSGSGXXXXN}{4:\n:20:X\n:32A:261117USD1,');
  add('xml/pacs009-minimal', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document>');
  add('xml/doctype-before-document', '<!DOCTYPE x><Document/>');
  add('mt/bare-without-ordering-customer', ':20:X\n:23B:CRED\n:32A:261117USD1,\n:59:B\n');
  add('xml/second-transaction-bare', PACS.replace('</CdtTrfTxInf>',
    '</CdtTrfTxInf><CdtTrfTxInf><PmtId><EndToEndId>E2</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="USD">1</IntrBkSttlmAmt><Dbtr><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr></CdtTrfTxInf>'),
  'two transactions, never picked by accident; the second states almost nothing');

  // "a file with several messages yields every payment, never just one of them"
  for (const [sep, label] of [['', 'back-to-back'], ['\r\n', 'crlf'], ['$', 'dollar'], ['$\r\n', 'dollar-crlf'], ['\r\n$\r\n', 'crlf-dollar-crlf']]) {
    add(`mt/free-then-structured-${label}`, MT_FREE + sep + MT_STRUCT, `one after another, separated by ${JSON.stringify(sep)}`);
  }
  add('mt/free-then-mt202', `${MT_FREE}{1:F01AAAAVNVXAXXX0000000000}{2:I202BBBBSGSGXXXXN}{4:\n:20:X\n-}`, 'a message of another type among them refuses the file and says which one');
  add('mt/free-then-stray-text', `${MT_FREE}\nstray text`);
  const BARE = ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n';
  add('mt/bare', BARE);
  add('mt/bare-with-end-marker', `${BARE}-}`);
  add('mt/bare-with-trailer', `${BARE}-}{5:{CHK:123456789ABC}}`, 'trailer blocks may follow the text');
  add('mt/bare-twice', BARE + BARE, 'two text blocks without headers cannot be told apart');
  add('mt/bare-end-marker-then-another', `${BARE}-}\n${BARE}`);
  const DOC = PACS.replace(/^<\?xml[^>]*\?>\s*/, '');
  add('xml/batch-same-ids-other-uetrs', `<Batch>${DOC}${DOC.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '11111111-2222-4333-8444-555555555555')}</Batch>`, 'a wrapper around two documents');
  add('xml/batch-pacs008-and-pain001', `<Batch>${DOC}${PAIN.replace(/^<\?xml[^>]*\?>\s*/, '')}</Batch>`);
  add('xml/batch-with-pacs009', `<Batch>${DOC}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document></Batch>`, 'a document of another kind among them refuses the file');
  add('xml/batch-with-unknown-document', `<Batch>${DOC}<Document><Something/></Document></Batch>`);

  // "a text block without headers has to be an MT103, not merely resemble one"
  add('mt/mt102-without-headers', ':20:BATCH1\n:23:CREDIT\n:50K:/VN-ACC-1\nA CO\n:52A:DEMOVNVX\n:71A:SHA\n'
    + ':21:TX1\n:32B:USD1000,\n:57A:DEMOSGSG\n:59:/SG-ACC-000001\nFIRST SUPPLIER\n'
    + ':21:TX2\n:32B:USD49000,\n:59:/SG-ACC-000002\nSECOND SUPPLIER\n:32A:261117USD50000,\n:19:50000,\n', 'read as an MT103 it was one payment of the total to the first beneficiary');
  const COVER = ':20:COV1\n:21:OUT2026000125\n:32A:261117USD6150,\n:52A:DEMOVNVX\n:58A:DEMOSGSG\n'
    + ':50K:/VN-ACC-000777\nVINA TRADING CO LTD\n:59:/SG-ACC-000009\nPACIFIC SUPPLY PTE LTD\n:70:/INV/INV-2026-0475\n';
  add('mt/cover-with-invoice', COVER, 'MT202 COV: the cover of an MT103 carries the same two customers');
  add('mt/cover-with-block-1-only', `{1:F01DEMOVNVXAXXX0000000000}{4:\n${COVER}-}`, 'block 1 alone states no type either');
  const WHOLE = ':20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:70:/INV/INV-2026-0475\n:71A:BEN\n';
  add('mt/bare-with-invoice', WHOLE);
  add('mt/bare-cut-short', WHOLE.slice(0, WHOLE.indexOf('75\n:71A')), 'cut off while it was being written');
  add('mt/bare-without-23b', WHOLE.replace(':23B:CRED\n', ''));
  add('mt/bare-without-32a', ':20:REF1\n:23B:CRED\n:50K:A CO\n:59:B LTD\n:71A:BEN\n');

  // "MT103: a field written twice, in two forms, or under a malformed tag is refused"
  const minimalMt = (extra) => `{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n:20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n${extra}:59:/ACC1\nB\n:71A:SHA\n-}`;
  add('mt/minimal', minimalMt(''));
  add('mt/minimal-23e-twice', minimalMt(':23E:SDVA\n:23E:INTC\n'), 'a field that may repeat, repeats');
  add('mt/minimal-59-twice', minimalMt(':59:/ACC2\nC\n'));
  add('mt/minimal-59a-and-59', minimalMt(':59A:/ACC2\nDEMOSGSG\n'));
  add('mt/minimal-50a-and-50k', minimalMt(':50A:DEMOVNVX\n'));
  add('mt/minimal-32a-twice', minimalMt(':32A:261117USD6,\n'));
  add('mt/minimal-lower-case-57a', minimalMt(':57a:REALSGSG\n'));
  add('mt/minimal-tab-indented-70', minimalMt('\t:70:/INV/X\n'));
  add('mt/minimal-field-21', minimalMt(':21:RELATED\n'));
  add('mt/end-marker-in-the-middle', '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4:\n:20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:B\n:70:X\n-}\n:71A:SHA\n-}', 'what follows an end-of-text marker is not read past');

  // "XML: what could be read two ways is refused, and what belongs to another vocabulary is not read"
  add('xml/foreign-name-beside-creditor-name', PACS.replace('<Cdtr>', '<Cdtr xmlns:e="urn:evil"><e:Nm>Injected Name</e:Nm>'), 'an element from another namespace beside the real one is not the name');
  add('xml/foreign-currency-attribute', PACS.replace('<InstdAmt Ccy="USD">', '<InstdAmt xmlns:x="urn:x" Ccy="USD" x:Ccy="EUR">'));
  add('xml/creditor-name-twice', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Pacific Supply Pte Ltd</Nm><Nm>Another Name</Nm>'));
  add('xml/instructed-amount-twice', PACS.replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">12500.00</InstdAmt><InstdAmt Ccy="USD">1.00</InstdAmt>'));
  add('xml/uetr-twice', PACS.replace('<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', '<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR><UETR>11111111-2222-4333-8444-555555555555</UETR>'));

  // "bytes are read in the encoding the message declares, and never guessed for XML"
  const VIET = PACS.replace('Vina Trading Co., Ltd.', 'Công ty TNHH Nguyễn Thị Hương');
  const vietBytes = Buffer.from(VIET, 'utf8');
  const beforeCountry = vietBytes.indexOf('<Ctry>VN');
  add('xml/vietnamese-name', Buffer.from(VIET, 'utf8'));
  add('xml/vietnamese-name-utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VIET, 'utf8')]));
  add('xml/stray-byte', Buffer.concat([vietBytes.subarray(0, beforeCountry), Buffer.from([0x92]), vietBytes.subarray(beforeCountry)]), 'one stray byte must not turn the whole message into another code page');
  add('xml/latin1-declared-french-name', Buffer.from(VIET.replace('UTF-8', 'ISO-8859-1').replace('Công ty TNHH Nguyễn Thị Hương', 'Société Générale Import'), 'latin1'));
  add('xml/unknown-encoding-klingon-1', Buffer.from(VIET.replace('UTF-8', 'KLINGON-1'), 'utf8'));
  add('xml/vietnamese-name-utf16le-bom', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(VIET.replace('UTF-8', 'UTF-16'), 'utf16le')]));
  add('mt/latin1-bytes', Buffer.from(MT_FREE.replace('HO CHI MINH CITY', 'HÔ CHI MINH CITY'), 'latin1'), 'FIN text in a legacy single-byte code page still reads');

  // "a large file is read in time proportional to its size": the same file with
  // 12 transactions instead of 3,000.
  const smallTx = (i) => `<CdtTrfTxInf><PmtId><InstrId>I-${i}</InstrId><EndToEndId>E-${i}</EndToEndId></PmtId>`
    + '<Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr><CdtrAcct><Id><Othr><Id>ACC</Id></Othr></Id></CdtrAcct></CdtTrfTxInf>';
  add('xml/pain001-many-transactions', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><CstmrCdtTrfInitn><GrpHdr><MsgId>M</MsgId></GrpHdr>'
    + `<PmtInf><PmtInfId>P</PmtInfId><Dbtr><Nm>A</Nm></Dbtr>${Array.from({ length: 12 }, (_, i) => smallTx(i)).join('')}</PmtInf></CstmrCdtTrfInitn></Document>`,
  'one payment block, and each payment its own debtor');

  // "mapping: a country may be inferred from the agent's BIC, and says so"
  add('mt/bare-countries-from-agents', ':20:R\n:23B:CRED\n:32A:261117USD10,\n:50K:/A1\nA CO\n1 STREET\n:52A:AAAAVNVX\n:57A:BBBBSGSG\n:59:/B1\nB LTD\n:70:SPARE PARTS\n:71A:SHA\n');
  // "mapping: the corridor denominates in USD — another currency is an issue, not a conversion"
  add('xml/vnd', PACS.replaceAll('Ccy="USD"', 'Ccy="VND"'));
  add('xml/instructed-in-vnd', PACS.replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="VND">322537500</InstdAmt>'));
  add('xml/settled-in-sgd', PACS.replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="SGD">16687.50</IntrBkSttlmAmt>'));
  // "mapping: the amount moved is the settled amount — charges already deducted are not funded twice"
  add('xml/charges-on-the-creditor', PACS
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD">7000.50</IntrBkSttlmAmt>')
    .replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">7010.50</InstdAmt>')
    .replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>CRED</ChrgBr><ChrgsInf><Amt Ccy="USD">10.00</Amt><Agt><FinInstnId><BICFI>DEMOVNVX</BICFI></FinInstnId></Agt></ChrgsInf>'));
  add('mt/charges-on-the-beneficiary', MT_STRUCT.replace(':32A:261117USD990,75', ':32A:261117USD980,75\r\n:33B:USD990,75').replace(':71A:SHA', ':71A:BEN\r\n:71F:USD10,'), 'and CRLF inserted into an LF message, as the test does');
  add('mt/receiver-charges-prepaid', MT_STRUCT.replace(':32A:261117USD990,75', ':32A:261117USD1015,\r\n:33B:USD1000,').replace(':71A:SHA', ':71A:OUR\r\n:71G:USD15,'));
  add('xml/receiver-charges-prepaid', PACS
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD">12515.00</IntrBkSttlmAmt>')
    .replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>DEBT</ChrgBr><ChrgsInf><Amt Ccy="USD">15.00</Amt><Agt><FinInstnId><BICFI>DEMOSGSG</BICFI></FinInstnId></Agt></ChrgsInf>'));
  // "mapping: the invoice is the document the message calls an invoice"
  const rfrd = (type, nb) => `<RfrdDocInf><Tp><CdOrPrtry><Cd>${type}</Cd></CdOrPrtry></Tp><Nb>${nb}</Nb></RfrdDocInf>`;
  const STRD = /<Strd>[\s\S]*<\/Strd>/.exec(PACS)[0];
  add('xml/purchase-order-invoices-credit-note', PACS.replace(STRD, `<Strd>${rfrd('PUOR', 'PO-88812')}${rfrd('CINV', 'SI-2026-5531')}${rfrd('CINV', 'SI-2026-5532')}${rfrd('CREN', 'CN-2026-0077')}</Strd>`));
  add('xml/untyped-document-before-typed', PACS.replace(STRD, `<Strd><RfrdDocInf><Nb>REF-1</Nb></RfrdDocInf>${rfrd('CINV', 'SI-9')}</Strd>`), 'an untyped document still counts, after the typed ones');
  add('xml/unstructured-invoice-with-slashes', PACS.replace(STRD, '<Ustrd>/INV/EQP/SGP/2026/0457/RFB/BEN-REF-1</Ustrd>'), 'three capital letters between slashes are part of the reference');
  add('mt/invoice-with-slashes', MT_FREE.replace('/INV/INV-2026-0475', '/INV/EQP/SGP/2026/0475'));
  add('mt/70-reference-guide-example', MT_FREE.replace(/:70:[\s\S]*?:71A:/, ':70:/RFB/BET072\r\n/INV/abc/SDF-96//1234-234///ROC/98IU87\r\n:71A:'), 'two invoices under one code word, then another code word');
  // "mapping: a private person is not sent as a company, and a test message is not a payment"
  const ORG = /<OrgId>[\s\S]*?<\/OrgId>/.exec(PACS)[0];
  add('xml/private-person-born', PACS.replace(ORG, '<PrvtId><DtAndPlcOfBirth><BirthDt>1980-01-01</BirthDt><CityOfBirth>Hanoi</CityOfBirth><CtryOfBirth>VN</CtryOfBirth></DtAndPlcOfBirth>'
    + '<Othr><Id>C1234567</Id><SchmeNm><Cd>CCPT</Cd></SchmeNm></Othr></PrvtId>'));
  for (const [line, label] of [['4/19800101', 'birth-date'], ['5/VN/HANOI', 'birth-place'], ['7/VN/012345678901', 'national-identity-number']]) {
    add(`mt/50f-${label}`, MT_STRUCT.replace('6/VN/GDT/0312345678', line));
  }
  add('mt/50f-passport', MT_STRUCT.replace(':50F:/VN-ACC-000777', ':50F:CCPT/VN/C1234567'));
  add('mt/structured-crts', MT_STRUCT.replace(':23B:CRED', ':23B:CRTS'));
  // "mapping: a payment of another route is refused, not quoted on this one"
  add('xml/debtor-in-th', PACS.replace('<Ctry>VN</Ctry>', '<Ctry>TH</Ctry>'));
  add('xml/creditor-bank-in-my', PACS.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>', '<BICFI>DEMOMYKL</BICFI>'), 'a beneficiary in Singapore whose account is at a bank elsewhere');
  add('xml/kr-to-us', PACS.replace('<Ctry>SG</Ctry>', '<Ctry>US</Ctry>').replaceAll('<BICFI>DEMOSGSG</BICFI>', '<BICFI>AAAAUS33</BICFI>').replace('<Ctry>VN</Ctry>', '<Ctry>KR</Ctry>'));
  // "test and training traffic is not a payment, however it says so"
  add('mt/structured-test-bic-sender', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX', '{1:F01DEMOVNV0AXXX'));
  add('mt/structured-test-bic-receiver', MT_STRUCT.replace('{2:I103DEMOSGSGXXXXN}', '{2:I103DEMOSGS0XXXXN}'));
  const PILOT = `<Saa:DataPDU xmlns:Saa="urn:swift:saa:xsd:saa.2.0"><Saa:Header><Saa:Message><Saa:NetworkInfo><Saa:Service>swift.finplus!p</Saa:Service></Saa:NetworkInfo></Saa:Message></Saa:Header><Saa:Body>${DOC}</Saa:Body></Saa:DataPDU>`;
  add('xml/pilot-service', PILOT);
  add('xml/live-service', PILOT.replace('!p', ''));
  add('xml/bah-test-bic', `<Envelope><AppHdr xmlns="urn:iso:std:iso:20022:tech:xsd:head.001.001.02"><Fr><FIId><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></FIId></Fr></AppHdr>${DOC}</Envelope>`);
  const BODY = DOC.replace(/<Document[^>]*>/, '').replace('</Document>', '')
    .replace('<FIToFICstmrCdtTrf>', '<FIToFICstmrCdtTrf xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">');
  add('xml/bare-body-with-namespace', BODY, 'a bare body that declares its namespace keeps its version');
  add('xml/utf16-damaged', Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x00, 0xd8]), 'a damaged UTF-16 file is a refusal, not a crash');
  add('mt/77t-remit', MT_STRUCT.replace(':71A:SHA', ':71A:SHA\r\n:77T:/NARR/INVOICES RR-2026-001'), 'MT103 REMIT: 77T is named as not read');
  // "what a party states is kept whole and labelled with where it stood"
  add('xml/party-details', PACS
    .replace('<StrtNm>Raffles Place</StrtNm>', '<CareOf>Pacific Group Services</CareOf><StrtNm>Raffles Place</StrtNm>')
    .replace('<BldgNb>1</BldgNb>\n          <PstCd>048616</PstCd>', '<BldgNb>1</BldgNb><Flr>17</Flr><UnitNb>17-01</UnitNb>\n          <PstCd>048616</PstCd>')
    .replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>', '<ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>026009593</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (US)</Nm>')
    .replace('<Ctry>VN</Ctry>\n        </PstlAdr>', '</PstlAdr>\n        <CtryOfRes>VN</CtryOfRes>'), 'care-of, floor, unit, a clearing-system member, residence instead of an address country');
  add('xml/regulatory-reporting-newest', PACS.replace('<Purp>', '<RgltryRptg><Dtls><Tp><Cd>CRED</Cd></Tp><Ctry>VN</Ctry><RptgCd>EXPORT</RptgCd><Inf>CERAMICS</Inf></Dtls></RgltryRptg><Purp>'));
  add('xml/pain001-without-instruction-id', PAIN.replace(/<InstrId>[^<]*<\/InstrId>\s*/, ''), 'the block\'s id is not the instruction\'s');
  add('mt/50f-continuation-lines', MT_STRUCT.replace(':50F:/VN-ACC-000777', ':50F:TXID/VN/0790123456')
    .replace(/3\/VN\/HO CHI MINH CITY\r?\n6\/VN\/GDT\/0312345678/, '3/VN/HO CHI MINH CITY\n3/700000\n8/78'), 'a second 3/ continues the address, 8/ the identifier of the first line');
  add('mt/50a', MT_STRUCT.replace(/:50F:[\s\S]*?:57A:/, ':50A:/VN-ACC-000777\r\nAAAAVNVX\r\n:57A:'), 'the ordering customer named by a BIC, which is no registration number');
  // "the payment id is the message's identity, not its bytes"
  add('xml/reformatted', PACS.replace(/\n\s+/g, '\n'));
  add('xml/created-next-day-in-another-offset', PACS.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T09:00:00+07:00<'));
  add('xml/created-day-before-in-utc', PACS.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-16T22:30:00Z<'));
  add('xml/other-invoice', PACS.replace('INV-2026-0457', 'INV-2026-0999'), 'another invoice is another payment');
  add('mt/free-format-without-headers', MT_FREE.slice(MT_FREE.indexOf(':20:'), MT_FREE.indexOf('-}')), 'from :20: to the end-of-text marker, as the test cuts it');
  // "a UETR that is there but cannot be read refuses the message; the text block alone is read"
  add('mt/structured-uetr-one-digit-short', MT_STRUCT.replace('{121:e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b28}', '{121:e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b2}'));
  add('xml/uetr-upper-case', PACS.replace(/<UETR>([^<]+)<\/UETR>/, (_m, u) => `<UETR>${u.toUpperCase()}</UETR>`));
  add('mt/structured-text-block-alone', block4(MT_STRUCT));
  add('mt/structured-field-lines-only', fieldLines(MT_STRUCT));
  add('mt/structured-two-text-blocks', `${block4(MT_STRUCT)}\r\n${block4(MT_STRUCT)}`);

  // ── test/client.test.ts (the SWIFT parts), and what the submission scenarios
  //    hand over: the same payment written out again, or a reference re-used ──
  add('sample/pain001-as-text', PAIN);
  add('sample/mt103-structured-as-text', MT_STRUCT);
  add('xml/other-amount', PACS.replaceAll('12500.00', '9900.00'), 'the UETR re-used on another payment');
  add('xml/other-creditor-name', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Another Exporter Pte Ltd</Nm>'));
  add('xml/other-creditor-account', PACS.replace('SG-ACC-000009', 'SG-ACC-000010'));
  add('xml/other-identifiers', PACS.replace('OUT-2026-000123', 'OUT-2026-000999').replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000001'));
  const UETR7 = PACS.replaceAll('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '77777777-7b0e-4d6a-9c1f-2e8b5a7d4c10');
  const block7 = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(UETR7)[0];
  add('xml/two-invoices-one-uetr', UETR7.replace(block7, block7 + block7.replace('INV-2026-0457', 'INV-2026-0458').replace('OUT-2026-000123', 'OUT-2026-000124')), 'one file, two transactions under one UETR');
  const UETR8 = UETR7.replaceAll('77777777-', '88888888-');
  const block8 = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(UETR8)[0];
  add('xml/one-transaction-twice', UETR8.replace(block8, block8 + block8), 'the second transaction a copy of the first to the letter');
  add('xml/pain001-reformatted', PAIN.replace(/\n\s+/g, '\n'));
  add('xml/pain001-other-invoice', PAIN.replaceAll('INV-2026-0470', 'INV-2026-0471'));
  add('xml/pain001-later-day', PAIN.replace(/<ReqdExctnDt>\s*<Dt>[^<]+<\/Dt>/, '<ReqdExctnDt><Dt>2026-12-01</Dt>'), 'the same identifiers on another day');
  add('xml/exported-next-day', PACS.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T09:00:00+07:00<').replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000007'), 'a new message id and creation time: the same payment');
  const UETR9 = PACS.replaceAll('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '99999999-7b0e-4d6a-9c1f-2e8b5a7d4c10');
  add('xml/uetr-99999999', UETR9);
  add('xml/uetr-99999999-reformatted', UETR9.replace(/\n\s+/g, '\n'));
  const withoutHeaders = (m) => m.slice(m.indexOf(':20:'), m.indexOf('-}'));
  add('mt/structured-without-headers', withoutHeaders(MT_STRUCT), 'from :20: to the end-of-text marker, as the client test cuts it');
  const MT127 = MT_STRUCT.replaceAll('OUT2026000126', 'OUT2026000127').replace('e2a8c5f0-', 'aaaaaaaa-');
  add('mt/structured-127', MT127);
  add('mt/structured-127-without-headers', withoutHeaders(MT127));
  add('mt/structured-127-without-headers-next-day', withoutHeaders(MT127).replace(':32A:261117', ':32A:261118'), 'a field 20 that comes round again on a later day');
  add('mt/structured-other-uetr-other-amount', MT_STRUCT.replace('e2a8c5f0-', 'bbbbbbbb-').replace('USD990,75', 'USD991,75'), 'the same field 20 on the same day, with other content');
  add('mt/structured-other-uetr', MT_STRUCT.replace('e2a8c5f0-', 'cccccccc-'), 'reads exactly like the sample, under a UETR of its own');
  // Payments that read alike, and a payment with no identifier of its own — for the submission scenarios.
  add('xml/pain001-same-ids-exported-again', Buffer.from(PAIN.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m}\n      ${m}`)
    .replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:30:00+07:00<').replace('VINATRD-20261117-0031', 'VINATRD-20261118-0002'), 'utf8'),
    'xml/pain001-same-ids written out again: a new message id and creation time');
  add('xml/pain001-no-identifiers', PAIN_PLAIN, 'no UETR, no instruction id, NOTPROVIDED for the end-to-end id: all it has is the file\'s message id');
  add('xml/pain001-no-identifiers-exported-again', PAIN_PLAIN.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:30:00+07:00<'), 'the same file with a new creation time');
  add('xml/pain001-no-identifiers-other-message-id', PAIN_PLAIN.replace('VINATRD-20261117-0031', 'VINATRD-20261117-0099'));
  add('xml/pain001-no-identifiers-two', PAIN_PLAIN.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m}\n      ${m}`),
    'two transactions that read alike, neither with an identifier of its own: only the position tells them apart');
  add('xml/pain001-no-identifiers-two-exported-again', PAIN_PLAIN.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m}\n      ${m}`)
    .replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:30:00+07:00<'));
  add('mt/structured-without-headers-next-day', withoutHeaders(MT_STRUCT).replace(':32A:261117', ':32A:261118'));
  add('xml/adapter-broken', Buffer.from('<Document><FIToFICstmrCdtTrf></Document>', 'utf8'), 'the folder adapter test\'s broken.xml');
  add('other/adapter-not-a-payment', Buffer.from('not a payment message', 'utf8'), 'the folder adapter test\'s other.txt');
  add('xml/uetr-44444444', Buffer.from(PACS.replaceAll('3f1c9a52-', '44444444-'), 'utf8'));
  add('xml/uetr-55555555', Buffer.from(PACS.replaceAll('3f1c9a52-', '55555555-'), 'utf8'));
  const B = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(PACS)[0];
  const nth = (n) => B.replaceAll('3f1c9a52-', `6666666${n}-`).replaceAll('OUT-2026-000123', `OUT-2026-00020${n}`);
  add('xml/three-transactions-second-without-account', Buffer.from(PACS.replace(B, nth(1) + nth(2).replace(/<CdtrAcct>[\s\S]*?<\/CdtrAcct>/, '') + nth(3)), 'utf8'), 'the folder adapter test\'s f-three.xml');
  add('xml/latin1-declared-as-text', PACS.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace('Vina Trading Co., Ltd.', 'Viña Trading Co., Ltd.'), 'xml/latin1-declared as the text it decodes to');
  add('mt/structured-second', secondMt, 'the second message of mt/two-messages, alone');
  add('xml/two-transactions-second-alone', PACS.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f').replace('OUT-2026-000123', 'OUT-2026-000124')
    .replace('12500.00</IntrBkSttlmAmt>', '800.25</IntrBkSttlmAmt>').replace('12500.00</InstdAmt>', '800.25</InstdAmt>'), 'the second transaction of xml/two-transactions, alone');
  add('xml/pain001-second-block-alone', PAIN.replace('VINATRD-PMT-0031', 'VINATRD-PMT-0032').replaceAll('VINATRD-INS-0031-1', 'VINATRD-INS-0032-1'), 'the second block of xml/pain001-two-blocks, alone');
  const withoutBlock3 = (m) => m.replace(/\{3:\{121:[^}]*\}\}/, '');
  add('mt/two-messages-without-uetr', `${withoutBlock3(MT_STRUCT)}$\r\n${withoutBlock3(secondMt)}`);
  add('mt/structured-second-without-uetr', withoutBlock3(secondMt));
  add('xml/pain001-created-later', PAIN.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:00:00+07:00<'));
  add('xml/pain001-new-message-id', PAIN.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:00:00+07:00<').replace('VINATRD-20261117-0031', 'VINATRD-20261118-0001'));
  add('mt/structured-sent-again', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX0000000000}', '{1:F01DEMOVNVXAXXX4321098765}'), 'another session and sequence number');
  add('mt/structured-possible-duplicate', `${MT_STRUCT}{5:{PDE:}}`);
  add('mt/structured-other-amount', MT_STRUCT.replace('USD990,75', 'USD991,75'));
  const PACS_NO_UETR = PACS.replace(/\s*<UETR>[^<]+<\/UETR>/, '');
  add('xml/no-uetr-next-day', PACS_NO_UETR.replace('<IntrBkSttlmDt>2026-11-17</IntrBkSttlmDt>', '<IntrBkSttlmDt>2026-11-18</IntrBkSttlmDt>'));
  add('xml/no-uetr-other-amount', PACS_NO_UETR.replaceAll('12500.00', '9900.00'));
  add('xml/no-uetr-reformatted', PACS_NO_UETR.replace(/\n\s+/g, '\n'));
  const MT_NO_UETR = MT_FREE.replace(/\{3:\{121:[^}]*\}\}/, '');
  add('mt/no-uetr-next-day', MT_NO_UETR.replace(':32A:261117', ':32A:261118'));
  add('mt/no-uetr-other-amount', MT_NO_UETR.replace(':32A:261117USD6150,', ':32A:261117USD6151,').replace(':33B:USD6150,', ':33B:USD6151,'));
  add('xml/pain001-other-company-same-ids', PAIN.replace('VINATRD-20261117-0031', 'OTHERCO-20261117-0001').replaceAll('Vina Trading Co., Ltd.', 'Other Trading JSC')
    .replaceAll('4300.00', '999.00').replace('VN-ACC-000777', 'VN-ACC-000999'), 'another company\'s file with the same instruction and end-to-end ids');
  add('mt/structured-field-lines-only-other-payment', fieldLines(MT_STRUCT).replace('USD990,75', 'USD1990,75').replace('PACIFIC SUPPLY PTE LTD', 'ATLANTIC SUPPLY PTE LTD'), 'the same field 20 and day, another payment');
  add('xml/other-uetr-same-ids', PACS.replaceAll('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '14141414-7b0e-4d6a-9c1f-2e8b5a7d4c10').replaceAll('12500.00', '100.00'));
  add('xml/pain001-contained-instruction-ids', PAIN.replace(/(<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>)/, (m) => `${m.replace('VINATRD-INS-0031-1', 'INSTR-0001')}\n      ${m
    .replace('VINATRD-INS-0031-1', 'INSTR-00012').replace('PO-7803', 'PO-7804').replace('4300.00', '1200.00')}`), 'one instruction id inside the other: the ledger search finds both');
  add('mt/short-reference-without-headers', withoutHeaders(MT_STRUCT).replace(':20:OUT2026000126', ':20:R1'), 'a field 20 of two characters, and no other reference of its own');
  add('mt/short-reference', MT_STRUCT.replace(':20:OUT2026000126', ':20:R1'));
  const PACS_NO_DATE = PACS_NO_UETR.replace(/\s*<IntrBkSttlmDt>[^<]*<\/IntrBkSttlmDt>/, '');
  add('xml/no-uetr-no-date', PACS_NO_DATE);
  add('xml/no-uetr-no-date-new-message-id', PACS_NO_DATE.replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000009'));
  add('xml/no-uetr-no-date-reformatted', PACS_NO_DATE.replace(/\n\s+/g, '\n'));
  const ENVELOPE_NO_UETR = ENVELOPE.replace(/\s*<pacs:UETR>[^<]+<\/pacs:UETR>/, '');
  add('xml/envelope-no-uetr', ENVELOPE_NO_UETR, 'NOTPROVIDED, and no UETR');
  add('xml/envelope-no-uetr-new-message-id', ENVELOPE_NO_UETR.replaceAll('DEMOVNVX20261117000124', 'DEMOVNVX20261118000002'));
  add('xml/crlf-line-ends', crlf(PACS));

  // ── What a port could get wrong: inputs no TypeScript test pins ──

  // White space. JavaScript's trim() and \s take every Unicode space and U+FEFF;
  // Java's String.trim() takes none of them, and Java's \s only the ASCII ones.
  const SPACES = '\u00a0\u2003\u3000\u202f\u205f\u1680\u2028\u2029\ufeff\t ';
  const LINE_SPACES = '\u00a0\u2003\u3000\u202f\u205f\u1680\ufeff\t ';
  const around = (v, s = SPACES) => `${s}${v}${s}`;
  add('xml/unicode-spaces-around-values', PACS
    .replace('<Nm>Vina Trading Co., Ltd.</Nm>', `<Nm>${around('Vina Trading Co., Ltd.')}</Nm>`)
    .replace('<InstrId>OUT-2026-000123</InstrId>', `<InstrId>${around('OUT-2026-000123')}</InstrId>`)
    .replace('<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', `<UETR>${around('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10')}</UETR>`)
    .replace('>12500.00</IntrBkSttlmAmt>', `>${around('12500.00')}</IntrBkSttlmAmt>`)
    .replace('<Ctry>SG</Ctry>', `<Ctry>${around('SG')}</Ctry>`)
    .replace('<ChrgBr>DEBT</ChrgBr>', `<ChrgBr>${around('DEBT')}</ChrgBr>`)
    .replace('<Nb>INV-2026-0457</Nb>', `<Nb>${around('INV-2026-0457')}</Nb>`),
  'U+00A0 U+2003 U+3000 U+202F U+205F U+1680 U+2028 U+2029 U+FEFF, tab and space around values');
  add('xml/not-spaces-around-a-name', PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm>\u0085\u200bVina Trading Co., Ltd.\u180e\u200b</Nm>'), 'U+0085, U+200B and U+180E are not white space to JavaScript');
  add('xml/unicode-spaces-inside-a-name', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Pacific\u00a0Supply\u2003\u2003Pte\u3000Ltd</Nm>'));
  add('xml/remittance-with-unicode-spaces', PACS.replace(STRD, '<Ustrd>\u3000Payment\u00a0for\u2003\u2003ceramic\ttiles\u2028shipped 10 Nov\u00a0</Ustrd>').replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>'), 'the invoice reference falls back to the remittance text, its spaces collapsed');
  add('mt/unicode-spaces-around-values', MT_STRUCT
    .replace(':20:OUT2026000126', `:20:${around('OUT2026000126', LINE_SPACES)}`)
    .replace(':23B:CRED', `:23B:${around('CRED', LINE_SPACES)}`)
    .replace(':32A:261117USD990,75', `:32A:${around('261117USD990,75', LINE_SPACES)}`)
    .replace('1/VINA TRADING CO LTD', around('1/VINA TRADING CO LTD', LINE_SPACES))
    .replace('3/SG/SINGAPORE 048616', `3/SG/SINGAPORE 048616${LINE_SPACES}`)
    .replace(':71A:SHA', `:71A:${around('SHA', LINE_SPACES)}`)
    .replace('{121:e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b28}', `{121:${around('e2a8c5f0-17d4-4b9e-b3a6-9d0c4e7f1b28', LINE_SPACES)}}`),
  'the same spaces without U+2028 and U+2029, which end a line for a JavaScript regular expression');
  add('mt/unicode-spaces-before-block-1', `\u00a0\u3000\r\n${MT_STRUCT}`);
  add('mt/no-break-space-before-a-tag', MT_FREE.replace(':71A:OUR', '\u00a0:71A:OUR'), 'a tag indented with U+00A0');
  add('mt/line-separator-in-a-tag-line', MT_FREE.replace(':70:/INV/INV-2026-0475', ':70:/INV/INV-2026-0475\u2028'));
  add('mt/next-line-in-a-tag-line', MT_FREE.replace(':70:/INV/INV-2026-0475', ':70:/INV/INV-2026-0475\u0085'), 'U+0085 ends no line for a JavaScript regular expression; it does for Java\'s');
  add('mt/line-separator-in-a-continuation-line', MT_FREE.replace('VINA TRADING CO LTD', 'VINA TRADING CO LTD\u2028'));
  add('mt/unit-separator-at-a-line-end', MT_FREE.replace(':20:OUT2026000125', ':20:OUT2026000125\u001f'), 'U+001F is not trimmed by JavaScript; Java\'s strip() would take it');

  // Line ends and tabs.
  add('mt/cr-only-line-ends', Buffer.from(MT_FREE.replace(/\r\n/g, '\r'), 'latin1'));
  add('mt/lone-cr-inside-a-name', Buffer.from(MT_FREE.replace('VINA TRADING CO LTD', 'VINA TRADING\rCO LTD'), 'latin1'), 'a CR alone ends a line');
  add('mt/mixed-line-ends', Buffer.from(MT_FREE.replace(':23B:CRED\r\n', ':23B:CRED\n').replace(':52A:DEMOVNVX\r\n', ':52A:DEMOVNVX\r'), 'latin1'));
  add('mt/tab-after-tag', MT_FREE.replace(':20:OUT2026000125', ':20:\tOUT2026000125').replace(':71A:OUR', ':71A:\tOUR').replace(':70:/INV/', ':70:\t/INV/'));
  add('xml/crlf-inside-a-value', PACS.replace(STRD, '<Ustrd>first line\r\nsecond line</Ustrd>'), 'XML would make CR LF one LF; this reader keeps what is written');

  // Currencies.
  add('mt/lower-case-currency', MT_FREE.replace(':32A:261117USD6150,', ':32A:261117usd6150,'));
  add('mt/lower-case-instructed-currency', MT_FREE.replace(':33B:USD6150,', ':33B:usd6150,'));
  add('xml/lower-case-currency', PACS.replace('<IntrBkSttlmAmt Ccy="USD">', '<IntrBkSttlmAmt Ccy="usd">'));
  add('xml/no-currency', PACS.replace('<InstdAmt Ccy="USD">', '<InstdAmt>'));
  add('xml/currency-with-spaces', PACS.replace('<IntrBkSttlmAmt Ccy="USD">', '<IntrBkSttlmAmt Ccy=" USD ">'));
  add('xml/currency-as-character-references', PACS.replace('<IntrBkSttlmAmt Ccy="USD">', '<IntrBkSttlmAmt Ccy="&#85;&#x53;D">'));
  add('xml/single-quoted-attributes', PACS.replace(/="([^"]*)"/g, '=\'$1\''), 'every attribute, and the declaration, in single quotes');

  // Amounts.
  const mt32 = (amount, instructed = amount) => MT_FREE.replace(':32A:261117USD6150,', `:32A:261117USD${amount}`).replace(':33B:USD6150,', `:33B:USD${instructed}`);
  add('mt/amount-15-digits', mt32('123456789012345,'));
  add('mt/amount-16-digits', mt32('1234567890123456,'));
  add('mt/amount-5-decimals', mt32('6150,12345'));
  add('mt/amount-6-decimals', mt32('6150,123456'));
  add('mt/amount-two-commas', mt32('6150,50,'));
  add('mt/amount-comma-only', mt32(','));
  add('mt/amount-without-comma', mt32('6150'));
  add('mt/amount-leading-zeros', mt32('0006150,50'));
  add('mt/amount-zero', mt32('0,'));
  add('mt/amount-with-a-full-stop', mt32('6150.50'));
  const xmlAmount = (v) => PACS.replace('>12500.00</IntrBkSttlmAmt>', `>${v}</IntrBkSttlmAmt>`);
  add('xml/amount-16-digits', xmlAmount('1234567890123456.00'));
  add('xml/amount-6-decimals', xmlAmount('12500.000000'));
  add('xml/amount-decimal-comma', xmlAmount('12500,00'));
  add('xml/amount-grouping-comma', xmlAmount('12,500.00'));
  add('xml/amount-grouping-comma-only', xmlAmount('12,500'));
  add('xml/amount-trailing-full-stop', xmlAmount('12500.'));
  add('xml/amount-leading-full-stop', xmlAmount('.5'));
  add('xml/amount-negative', xmlAmount('-12500.00'));
  add('xml/amount-plus-sign', xmlAmount('+12500.00'));
  add('xml/amount-exponent', xmlAmount('1.25E4'));
  add('xml/amount-empty', PACS.replace('<IntrBkSttlmAmt Ccy="USD">12500.00</IntrBkSttlmAmt>', '<IntrBkSttlmAmt Ccy="USD"/>'));
  add('xml/amount-cdata-and-comment', xmlAmount('<![CDATA[12500]]><!-- cents -->.00'));
  add('xml/amounts-a-cent-apart-beyond-double-precision', PACS.replace('>12500.00</IntrBkSttlmAmt>', '>999999999999999.99</IntrBkSttlmAmt>').replace('>12500.00</InstdAmt>', '>999999999999999.98</InstdAmt>'), 'which of the two is smaller?');

  // MT103 option F, every line number.
  const f50 = (lines) => MT_STRUCT.replace(/:50F:[\s\S]*?(?=:57A:)/, `:50F:${lines.join('\n')}\n`);
  add('mt/50f-every-line-number', f50(['/VN-ACC-000777', '1/VINA TRADING', '1/CO LTD', '2/12 LE LOI BLVD', '2/DISTRICT 1', '3/VN/HO CHI MINH CITY', '3/700000',
    '4/19800101', '5/VN/HANOI', '6/VN/GDT/0312345678', '8/9', '7/VN/012345678901', '8/1']), '8/ continues the 6/ before it, not the 7/');
  add('mt/50f-line-number-9', f50(['/VN-ACC-000777', '1/VINA TRADING CO LTD', '9/SOMETHING']));
  add('mt/50f-line-number-0', f50(['/VN-ACC-000777', '0/VINA TRADING CO LTD']));
  add('mt/50f-unnumbered-line', f50(['/VN-ACC-000777', 'VINA TRADING CO LTD']));
  add('mt/50f-three-letter-country', f50(['/VN-ACC-000777', '1/VINA TRADING CO LTD', '2/12 LE LOI BLVD', '3/VNM/HO CHI MINH CITY', '6/VN/GDT/0312345678']));
  add('mt/50f-customer-code', f50(['CUST/VN/DEMOVNVX/123456', '1/VINA TRADING CO LTD', '2/12 LE LOI BLVD', '3/VN/HO CHI MINH CITY']), 'a code that is not a personal document');
  add('mt/50f-national-identity-code', f50(['NIDN/VN/012345678901', '1/NGUYEN VAN A', '2/12 LE LOI BLVD', '3/VN/HO CHI MINH CITY']));
  add('mt/50f-three-letter-code', f50(['TXI/VN/0312345678', '1/VINA TRADING CO LTD']));
  add('mt/50f-empty-account', f50(['/', '1/VINA TRADING CO LTD', '2/12 LE LOI BLVD', '3/VN/HO CHI MINH CITY', '6/VN/GDT/0312345678']));
  const f59 = (lines) => MT_STRUCT.replace(/:59F:[\s\S]*?(?=:70:)/, `:59F:${lines.join('\n')}\n`);
  add('mt/59f-without-account', f59(['1/PACIFIC SUPPLY PTE LTD', '2/1 RAFFLES PLACE', '3/SG/SINGAPORE 048616']));
  add('mt/59f-code-and-country', f59(['TXID/SG/201912345K', '1/PACIFIC SUPPLY PTE LTD', '2/1 RAFFLES PLACE', '3/SG/SINGAPORE 048616']));
  add('mt/59f-birth-date', f59(['/SG-ACC-000009', '1/TAN AH KOW', '2/1 RAFFLES PLACE', '3/SG/SINGAPORE 048616', '4/19750505']));
  add('mt/59f-town-before-country', f59(['/SG-ACC-000009', '1/PACIFIC SUPPLY PTE LTD', '3/SINGAPORE', '3/SG/048616']));

  // Field 70: each code word, "//" between references and at the start of a line.
  const f70 = (text) => MT_FREE.replace(/:70:[\s\S]*?(?=:71A:)/, `:70:${text}\r\n`);
  add('mt/70-every-code-word', f70('/INV/INV-1/IPI/IPI-2/RFB/RFB-3/ROC/ROC-4/TSU/TSU-5'));
  add('mt/70-invoices-separated-by-double-slash', f70('/INV/INV-1//INV-2//INV-3'));
  add('mt/70-continuation-lines', f70('/INV/INV-2026-\r\n//0475\r\n/ROC/PO-\r\n//7811'));
  add('mt/70-reference-only', f70('/ROC/PO-7811'));
  add('mt/70-free-text', f70('PAYMENT FOR SPARE PARTS\r\nAS PER CONTRACT 2026-17'));
  add('mt/70-long-free-text', f70('SETTLEMENT OF THE BALANCE DUE UNDER\r\nCONTRACT VN-SG-2026-0017 FOR CERAMIC\r\nTILES SHIPPED ON 10 NOVEMBER 2026 PER\r\nBILL OF LADING MAEU-2026-778812'));
  add('mt/70-lower-case-code-word', f70('/inv/INV-2026-0475'));
  add('mt/70-empty-invoice-before-another-code', f70('/INV//ROC/PO-7811'));
  add('mt/70-trailing-slash', f70('/INV/INV-2026-0475/'));
  add('mt/70-roc-notprovided', f70('/INV/INV-2026-0475\r\n/ROC/NOTPROVIDED'));
  add('mt/70-the-same-invoice-twice', f70('/INV/INV-2026-0475//INV-2026-0475'));

  // Field 77B, 71F / 71G, 71A, 23B.
  const f77 = (text) => MT_FREE.replace(/:77B:[\s\S]*?(?=-\})/, `:77B:${text}\r\n`);
  add('mt/77b-beneficiary-residence-only', f77('/BENEFRES/SG'));
  add('mt/77b-both-on-one-line', f77('/ORDERRES/VN//IMPORT/BENEFRES/SG'));
  add('mt/77b-lower-case', f77('/orderres/vn\r\n/benefres/sg'));
  add('mt/77b-three-letter-countries', f77('/ORDERRES/VNM\r\n/BENEFRES/SGP'));
  add('mt/77b-three-lines', f77('/ORDERRES/VN//IMPORT OF\r\n//CERAMIC TILES\r\n/BENEFRES/SG'));
  add('mt/77b-against-50f-and-59f', MT_STRUCT.replace(':71A:SHA', ':71A:SHA\n:77B:/ORDERRES/TH\n/BENEFRES/MY'));
  add('mt/71f-three-times-and-71g', MT_FREE.replace(':71A:OUR', ':71A:SHA\r\n:71F:USD1,\r\n:71F:USD2,50\r\n:71F:EUR3,\r\n:71G:USD4,'));
  add('mt/71g-twice', MT_FREE.replace(':71A:OUR', ':71A:OUR\r\n:71G:USD4,\r\n:71G:USD5,'));
  add('mt/71a-lower-case', MT_FREE.replace(':71A:OUR', ':71A:our'));
  add('mt/71a-unknown', MT_FREE.replace(':71A:OUR', ':71A:XYZ'));
  for (const code of ['SPAY', 'SSTD', 'SPRI', 'ABCD', 'cred', 'crts']) add(`mt/23b-${code}`, MT_FREE.replace(':23B:CRED', `:23B:${code}`));

  // BICs, agents and parties in their other options.
  add('mt/bic-11-and-lower-case', MT_FREE.replace(':52A:DEMOVNVX', ':52A:DEMOVNVXXXX').replace(':57A:DEMOSGSG', ':57A:demosgsg'));
  add('mt/bic-not-a-bic', MT_FREE.replace(':57A:DEMOSGSG', ':57A:DEMO12SG'), 'field 59 has no country line: the country would come from the BIC, and this is not one');
  add('mt/header-branch-codes', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX', '{1:F01DEMOVNVXA123').replace('{2:I103DEMOSGSGXXXXN}', '{2:I103DEMOSGSGX456N}').replace(':57A:DEMOSGSG\n', ''), 'no 57A: the receiver\'s logical terminal names the bank');
  add('mt/header-lower-case', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX', '{1:F01demovnvxAXXX'));
  add('mt/agents-in-options-c-and-d', MT_FREE.replace(':52A:DEMOVNVX', ':52D:/VN-NOSTRO-1\r\nDEMO BANK VIETNAM\r\nHANOI').replace(':57A:DEMOSGSG', ':56C:/CH123456\r\n:57D://SG7171\r\nDEMO PAYOUT BANK SINGAPORE'));
  add('mt/57a-party-qualifier', MT_FREE.replace(':57A:DEMOSGSG', ':57A:/C/SG-NOSTRO-9\r\nDEMOSGSG'));
  add('mt/59a', MT_FREE.replace(/:59:[\s\S]*?(?=:70:)/, ':59A:/SG-ACC-000009\r\nBBBBSGSG\r\n'), 'the beneficiary named by a BIC alone');
  add('mt/50k-without-account', MT_FREE.replace(':50K:/VN-ACC-000777\r\n', ':50K:'));
  add('mt/59-account-letter-and-slash', MT_FREE.replace(':59:/SG-ACC-000009', ':59:/S/SG-ACC-000009'));
  add('mt/59-account-only', MT_FREE.replace(/:59:[\s\S]*?(?=:70:)/, ':59:/SG-ACC-000009\r\n'));
  add('mt/72-and-23e', MT_FREE.replace(':71A:OUR', ':71A:OUR\r\n:72:/INS/DEMOSGSG\r\n//PAY BY FAST').replace(':23B:CRED', ':23B:CRED\r\n:23E:PHOB'));
  add('mt/instructed-in-vnd-with-rate', MT_FREE.replace(':33B:USD6150,', ':33B:VND158686950,\r\n:36:25803,'));
  add('mt/rate-without-instructed-amount', MT_FREE.replace(':33B:USD6150,', ':36:1,0'));

  // Header blocks.
  add('mt/block-3-other-fields-first', MT_FREE.replace('{3:{121:', '{3:{103:TGT}{108:MUR-2026-0001}{119:STP}{121:'));
  add('mt/block-3-without-121', MT_FREE.replace(/\{3:\{121:[^}]*\}\}/, '{3:{108:MUR-2026-0001}}'));
  add('mt/block-3-121-empty', MT_FREE.replace('{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}', '{121:}'));
  add('mt/block-3-121-twice', MT_FREE.replace('{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}', '{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}{121:11111111-2222-4333-8444-555555555555}'));
  add('mt/block-3-not-closed', MT_FREE.replace('{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}}', '{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}'));
  add('mt/blocks-out-of-order', MT_FREE.replace('{2:I103DEMOSGSGXXXXN}{3:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}}', '{3:{121:b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57}}{2:I103DEMOSGSGXXXXN}'));
  add('mt/trailer-blocks', MT_FREE.replace('-}{5:{CHK:8A1B2C3D4E5F}}', '-}{5:{MAC:12345678}{CHK:8A1B2C3D4E5F}{TNG:}}{S:{SAC:}{COP:P}}'));
  add('mt/utf8-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MT_FREE, 'latin1')]));
  add('mt/blank-lines-first', `\r\n\r\n  ${MT_FREE}`);
  add('mt/structured-output-header', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}', '{1:F01DEMOSGSGAXXX1234567890}{2:O1031230261117DEMOVNVXAXXX12345678902611171231N}'), 'as delivered: block 1 is the receiver');
  add('mt/output-header-test-sender', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}', '{1:F01DEMOSGSGAXXX1234567890}{2:O1031230261117DEMOVNV0AXXX12345678902611171231N}'));
  add('mt/output-header-cut-short', MT_STRUCT.replace('{2:I103DEMOSGSGXXXXN}', '{2:O103}'));
  add('mt/block-2-lower-case', MT_STRUCT.replace('{2:I103', '{2:i103'));
  add('mt/block-2-without-receiver', MT_STRUCT.replace('{2:I103DEMOSGSGXXXXN}', '{2:I103}'));
  add('mt/block-2-without-block-1', MT_STRUCT.replace('{1:F01DEMOVNVXAXXX0000000000}', ''));
  add('mt/text-block-on-the-tag-line', '{4::20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n-}', 'the text block alone, with :20: on the line of {4:');
  add('mt/headers-and-text-block-on-the-tag-line', '{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}{4::20:REF1\n:23B:CRED\n:32A:260105USD100,5\n:50K:A CO\n:59:/ACC9\nB LTD\n:71A:BEN\n-}');
  add('mt/batch-second-message-refused', `${MT_STRUCT}$\r\n${secondMt.replace(':71A:SHA', ':71A:XYZ')}`, 'the message that is wrong is named');
  add('mt/32a-year-79', MT_FREE.replace(':32A:261117', ':32A:791231'));
  add('mt/32a-year-80', MT_FREE.replace(':32A:261117', ':32A:800101'));
  add('mt/32a-impossible-date', MT_FREE.replace(':32A:261117', ':32A:261399'), 'month 13, day 99');

  // XML: CDATA, character references, comments and processing instructions inside values.
  add('xml/cdata-in-identifiers', PACS.replace('<InstrId>OUT-2026-000123</InstrId>', '<InstrId><![CDATA[OUT-2026-000123]]></InstrId>')
    .replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId> <![CDATA[PO-]]>7781 </EndToEndId>')
    .replace('<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', '<UETR><![CDATA[3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10]]></UETR>'));
  add('xml/cdata-keeps-entities', PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm><![CDATA[Vina &amp; Trading]]> Co., Ltd.</Nm>'), 'inside CDATA, &amp; is five characters');
  add('xml/character-references', PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm>&#86;ina &#x54;rading &#X43;o&#0000046;, Ltd&#x2E; &apos;&quot;&gt;</Nm>'));
  add('xml/character-reference-astral', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Pacific Supply Pte Ltd &#x1F600;</Nm>'));
  add('xml/character-reference-surrogate', PACS.replace('PO-7781', 'PO-&#xD800;7781'));
  add('xml/character-reference-beyond-unicode', PACS.replace('PO-7781', 'PO-&#x110000;7781'));
  add('xml/character-reference-nul', PACS.replace('PO-7781', 'PO-&#0;7781'));
  add('xml/character-reference-eight-digits', PACS.replace('PO-7781', 'PO-&#00000065;7781'));
  add('xml/character-reference-without-semicolon', PACS.replace('PO-7781', 'PO-&#65 7781'));
  add('xml/comments-inside-values', PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm>Vina Trading <!-- legal form --> Co., Ltd.</Nm>')
    .replace('<InstrId>OUT-2026-000123</InstrId>', '<InstrId>OUT-2026-<!-- sequence -->000123</InstrId>'));
  add('xml/processing-instruction-inside-a-value', PACS.replace('<Nm>Vina Trading Co., Ltd.</Nm>', '<Nm>Vina<?pi x?> Trading Co., Ltd.</Nm>'));

  // XML: namespaces and the Document.
  add('xml/prefixed-document', PACS.replace(/<(\/?)(?=[A-Za-z])/g, '<$1p:').replace('xmlns=', 'xmlns:p='), 'every element with a prefix');
  add('xml/prefixed-document-unqualified-children', PACS.replace('<Document xmlns=', '<p:Document xmlns:p=').replace('</Document>', '</p:Document>'), 'the Document in the ISO namespace, everything inside it in none');
  const SCHEMA = 'xsi:schemaLocation="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08 pacs.008.001.08.xsd"';
  add('xml/schema-location', PACS.replace('pacs.008.001.08">', `pacs.008.001.08" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${SCHEMA}>`));
  add('xml/schema-location-undeclared', PACS.replace('pacs.008.001.08">', `pacs.008.001.08" ${SCHEMA}>`));
  const deep = (levels) => PACS.replace('<Purp>', `<SplmtryData>${'<Envlp>'.repeat(levels)}<Leaf/>${'</Envlp>'.repeat(levels)}</SplmtryData>\n      <Purp>`);
  add('xml/nested-64-deep', deep(60), '64 elements open, and a self-closing one inside the last');
  add('xml/nested-65-deep', deep(61));
  const declaring = (n) => PACS.replace('<Document xmlns=', `<Document ${prefixes(n)} xmlns=`);
  add('xml/prefixes-63-and-the-default', declaring(63), 'the default namespace counts as one of the 64');
  add('xml/prefixes-64-and-the-default', declaring(64));
  add('xml/batch-document-and-bare-body', `<Batch>${DOC}${BODY.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '12121212-7b0e-4d6a-9c1f-2e8b5a7d4c10').replace('OUT-2026-000123', 'OUT-2026-000126')}</Batch>`, 'a document, and beside it a body without its Document');
  add('xml/document-with-two-bodies', PACS.replace('</FIToFICstmrCdtTrf>', `</FIToFICstmrCdtTrf>${/<FIToFICstmrCdtTrf>[\s\S]*<\/FIToFICstmrCdtTrf>/.exec(PACS)[0]
    .replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '13131313-7b0e-4d6a-9c1f-2e8b5a7d4c10').replace('OUT-2026-000123', 'OUT-2026-000127')}`));
  add('xml/document-other-element-first', PACS.replace('<FIToFICstmrCdtTrf>', '<Extra/><FIToFICstmrCdtTrf>'));
  add('xml/namespace-not-iso', PACS.replace('urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08', 'urn:example:payments'));
  add('xml/namespace-of-another-family', PACS.replace('urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08', 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09'), 'the namespace says pain.001, the body is a pacs.008');
  add('xml/group-header-twice', PACS.replace('<CdtTrfTxInf>', '<GrpHdr><MsgId>SECOND</MsgId></GrpHdr>\n    <CdtTrfTxInf>'));
  add('xml/no-transaction', PACS.replace(/<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/, ''));
  add('xml/no-debtor', PACS.replace(/<Dbtr>[\s\S]*?<\/Dbtr>/, ''));
  add('xml/no-creditor', PACS.replace(/<Cdtr>[\s\S]*?<\/Cdtr>/, ''));
  add('xml/no-amount', PACS.replace(/<IntrBkSttlmAmt[^>]*>[^<]*<\/IntrBkSttlmAmt>/, '').replace(/<InstdAmt[^>]*>[^<]*<\/InstdAmt>/, ''));

  // XML: empty elements, addresses, remittance, charges, agents.
  add('xml/empty-optional-elements', PACS.replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId/>')
    .replace('<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', '<UETR></UETR>')
    .replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr/>')
    .replace('<Ctry>SG</Ctry>', '<Ctry></Ctry>')
    .replace(/<Purp>\s*<Cd>GDDS<\/Cd>\s*<\/Purp>/, '<Purp><Cd/></Purp>')
    .replace('<Nb>INV-2026-0457</Nb>', '<Nb> </Nb>'));
  add('xml/empty-creditor-name', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm/>'));
  add('xml/empty-debtor', PACS.replace(/<Dbtr>[\s\S]*?<\/Dbtr>/, '<Dbtr/>'));
  const CDTR = /<Cdtr>\s*<Nm>Pacific Supply Pte Ltd<\/Nm>\s*<PstlAdr>[\s\S]*?<\/PstlAdr>/;
  add('xml/address-every-part', PACS.replace(CDTR, '<Cdtr><Nm>Pacific Supply Pte Ltd</Nm><PstlAdr>'
    + '<AdrTp><Cd>BIZZ</Cd></AdrTp><CareOf>Pacific Group Services</CareOf><Dept>Accounts Receivable</Dept><SubDept>Asia</SubDept>'
    + '<StrtNm>Raffles Place</StrtNm><BldgNb>1</BldgNb><BldgNm>One Raffles Place Tower 1</BldgNm><Flr>17</Flr><UnitNb>17-01</UnitNb>'
    + '<PstBx>PO Box 123</PstBx><Room>1701A</Room><PstCd>048616</PstCd><TwnNm>Singapore</TwnNm><TwnLctnNm>Downtown Core</TwnLctnNm>'
    + '<DstrctNm>Central Area</DstrctNm><CtrySubDvsn>Central Region</CtrySubDvsn><Ctry>SG</Ctry>'
    + '<AdrLine>Raffles Place MRT Exit B</AdrLine><AdrLine>Lobby 2</AdrLine></PstlAdr>'));
  add('xml/address-lines-only', PACS.replace(CDTR, '<Cdtr><Nm>Pacific Supply Pte Ltd</Nm><PstlAdr><AdrLine>1 Raffles Place</AdrLine><AdrLine>  </AdrLine><AdrLine>Singapore 048616</AdrLine></PstlAdr>'), 'no country in the address');
  add('xml/address-country-lower-case', PACS.replace('<Ctry>SG</Ctry>', '<Ctry>sg</Ctry>'));
  add('xml/address-twice', PACS.replace('</PstlAdr>\n      </Cdtr>', '</PstlAdr><PstlAdr><Ctry>SG</Ctry></PstlAdr>\n      </Cdtr>'));
  add('xml/remittance-several-strd-and-ustrd', PACS.replace(/<RmtInf>[\s\S]*<\/RmtInf>/, '<RmtInf>'
    + '<Ustrd>/INV/INV-2026-0457 ceramic tiles</Ustrd><Ustrd>  </Ustrd><Ustrd>second line /INV/INV-2026-0460</Ustrd>'
    + `<Strd>${rfrd('CINV', 'INV-2026-0458')}<CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>RF18539007547034</Ref></CdtrRefInf><AddtlRmtInf>shipped 2026-11-10</AddtlRmtInf></Strd>`
    + '<Strd><RfrdDocInf><Nb>INV-2026-0457</Nb></RfrdDocInf><AddtlRmtInf>a</AddtlRmtInf><AddtlRmtInf>b</AddtlRmtInf></Strd>'
    + '</RmtInf>'));
  add('xml/referred-document-types', PACS.replace(STRD, `<Strd>${rfrd('MSIN', 'MS-1')}${rfrd('HIRI', 'HI-1')}${rfrd('SBIN', 'SB-1')}${rfrd('DEBN', 'DN-1')}${rfrd('SOAC', 'SO-1')}${rfrd('cinv', 'LC-1')}`
    + '<RfrdDocInf><Tp><CdOrPrtry><Prtry>PROFORMA</Prtry></CdOrPrtry></Tp><Nb>PF-1</Nb></RfrdDocInf>'
    + '<RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp></RfrdDocInf><RfrdDocInf><Nb>  </Nb></RfrdDocInf></Strd>'),
  'the four invoice types, two other types, a code in lower case, a proprietary type, a document without a number');
  add('xml/remittance-cut-inside-a-surrogate-pair', PACS.replace(STRD, `<Ustrd>${'A'.repeat(63)}\u{1F600} and more</Ustrd>`).replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>'),
    'the invoice reference falls back to the first 64 UTF-16 units of the text');
  add('xml/charges-several', PACS.replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>SHAR</ChrgBr>'
    + '<ChrgsInf><Amt Ccy="USD">10.00</Amt><Agt><FinInstnId><BICFI>DEMOVNVX</BICFI></FinInstnId></Agt></ChrgsInf>'
    + '<ChrgsInf><Amt Ccy="USD">5</Amt></ChrgsInf>'
    + '<ChrgsInf><Amt>2.50</Amt><Agt><FinInstnId><BIC>DEMOSGSG</BIC></FinInstnId></Agt></ChrgsInf>'
    + '<ChrgsInf><Agt><FinInstnId><BICFI>AAAAUS33</BICFI></FinInstnId></Agt></ChrgsInf>'
    + '<ChrgsInf/>'));
  add('xml/charge-bearer-unknown', PACS.replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>OUR</ChrgBr>'), 'a value that is none of the four');
  add('xml/intermediaries-1-2-3', PACS.replace('<Dbtr>', '<IntrmyAgt1><FinInstnId><BICFI>AAAAUS33</BICFI></FinInstnId></IntrmyAgt1>'
    + '<IntrmyAgt1Acct><Id><Othr><Id>NOSTRO-1</Id></Othr></Id></IntrmyAgt1Acct>'
    + '<IntrmyAgt2><FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>021000021</MmbId></ClrSysMmbId></FinInstnId></IntrmyAgt2>'
    + '<IntrmyAgt3><FinInstnId><Nm>Correspondent Three</Nm><PstlAdr><Ctry>JP</Ctry></PstlAdr></FinInstnId></IntrmyAgt3>\n      <Dbtr>'));
  add('xml/intermediary-without-identification', PACS.replace('<Dbtr>', '<IntrmyAgt2><FinInstnId/></IntrmyAgt2>\n      <Dbtr>'));
  add('xml/bic-lower-case-and-11', PACS.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>', '<BICFI>demosgsgxxx</BICFI>\n          <Nm>')
    .replace(/<DbtrAgt>\s*<FinInstnId>\s*<BICFI>DEMOVNVX<\/BICFI>/, '<DbtrAgt><FinInstnId><BICFI>DEMOVNVXXXX</BICFI>'));
  add('xml/ultimate-parties-and-agent-instructions', PACS.replace('<Dbtr>', '<UltmtDbtr><Nm>Vina Group Holdings</Nm></UltmtDbtr>\n      <Dbtr>')
    .replace('<Purp>', '<UltmtCdtr><Nm>Pacific Group Ltd</Nm></UltmtCdtr><InstrForCdtrAgt><Cd>PHOB</Cd></InstrForCdtrAgt><InstrForNxtAgt><InstrInf>/ACC/BY FAST</InstrInf></InstrForNxtAgt>\n      <Purp>'));

  // XML: dates.
  add('xml/settlement-date-with-offset', PACS.replace('<IntrBkSttlmDt>2026-11-17</IntrBkSttlmDt>', '<IntrBkSttlmDt>2026-11-17+07:00</IntrBkSttlmDt>'));
  add('xml/settlement-date-not-a-date', PACS.replace('<IntrBkSttlmDt>2026-11-17</IntrBkSttlmDt>', '<IntrBkSttlmDt>17/11/2026</IntrBkSttlmDt>'));
  add('xml/settlement-date-in-group-header', PACS.replace('<IntrBkSttlmDt>2026-11-17</IntrBkSttlmDt>', '').replace('<NbOfTxs>1</NbOfTxs>', '<NbOfTxs>1</NbOfTxs>\n      <IntrBkSttlmDt>2026-11-16</IntrBkSttlmDt>'));
  add('xml/no-settlement-date', PACS.replace(/\s*<IntrBkSttlmDt>[^<]*<\/IntrBkSttlmDt>/, ''));
  add('xml/uetr-version-1', PACS.replace('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '3f1c9a52-7b0e-1d6a-9c1f-2e8b5a7d4c10'), 'a UUID, not of version 4');

  // pain.001: what the block states and what the transaction states.
  add('xml/pain001-charge-bearer-at-both-levels', PAIN.replace('<CdtTrfTxInf>', '<CdtTrfTxInf>\n        <ChrgBr>SHAR</ChrgBr>'), 'the transaction\'s own wins over the block\'s');
  add('xml/pain001-unknown-charge-bearer-in-transaction', PAIN.replace('<CdtTrfTxInf>', '<CdtTrfTxInf>\n        <ChrgBr>OUR</ChrgBr>'), 'where the block states DEBT');
  add('xml/pain001-without-debtor', PAIN.replace(/<Dbtr>[\s\S]*?<\/Dbtr>/, ''));
  add('xml/pain001-equivalent-amount', PAIN.replace('<InstdAmt Ccy="USD">4300.00</InstdAmt>', '<EqvtAmt><Amt Ccy="USD">4300.00</Amt><CcyOfTrf>SGD</CcyOfTrf></EqvtAmt>'));
  add('xml/pain001-plain-execution-date', PAIN.replace(/<ReqdExctnDt>\s*<Dt>([^<]+)<\/Dt>\s*<\/ReqdExctnDt>/, '<ReqdExctnDt>$1</ReqdExctnDt>'), 'the older versions\' plain date');
  add('xml/pain001-execution-date-time', PAIN.replace(/<ReqdExctnDt>\s*<Dt>([^<]+)<\/Dt>\s*<\/ReqdExctnDt>/, '<ReqdExctnDt><DtTm>$1T10:00:00+07:00</DtTm></ReqdExctnDt>'));
  add('xml/pain001-empty-block-first', PAIN.replace('<PmtInf>', '<PmtInf><PmtInfId>EMPTY</PmtInfId><PmtMtd>TRF</PmtMtd></PmtInf>\n    <PmtInf>'), 'a block without transactions needs no debtor');
  add('xml/pain001-exchange-rate', PAIN.replace('<CdtrAgt>', '<XchgRateInf><XchgRate>25803</XchgRate><RateTp>AGRD</RateTp></XchgRateInf>\n        <CdtrAgt>'));

  // The envelope: a header that says something else, test markers.
  add('xml/bah-other-message-definition', ENVELOPE.replace('<head:MsgDefIdr>pacs.008.001.08</head:MsgDefIdr>', '<head:MsgDefIdr>pacs.009.001.08</head:MsgDefIdr>'), 'the header names one message, the document is another');
  add('xml/bah-test-bic-receiver', ENVELOPE.replace('<head:BICFI>DEMOSGSG</head:BICFI>', '<head:BICFI>DEMOSGS0XXX</head:BICFI>'));
  add('xml/bah-lower-case-test-bic', ENVELOPE.replace('<head:BICFI>DEMOVNVX</head:BICFI>', '<head:BICFI>demovnv0</head:BICFI>'));
  add('xml/pilot-service-upper-case', PILOT.replace('!p', '!P'));

  // Encodings a TextDecoder reads its own way, and XML that does not start with "<".
  add('xml/utf16le-without-bom', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le'));
  add('xml/declared-utf16-written-in-utf8', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf8'));
  add('xml/declared-latin1-with-windows-1252-bytes', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace('Vina Trading Co., Ltd.', 'Vina Trading Co.\x92s \x80 Ltd.'), 'latin1'),
    'bytes 0x92 and 0x80 under a declared ISO-8859-1, a label TextDecoder takes as windows-1252');
  add('xml/declared-ascii-with-a-high-byte', Buffer.from(PACS.replace('encoding="UTF-8"', 'encoding="US-ASCII"').replace('Vina Trading Co., Ltd.', 'Vi\xf1a Trading Co., Ltd.'), 'latin1'));
  add('xml/latin1-undeclared-after-a-no-break-space', Buffer.concat([Buffer.from([0xa0]), Buffer.from(PACS.replace('Vina Trading Co., Ltd.', 'Vi\xf1a Trading Co., Ltd.'), 'latin1')]),
    'not valid UTF-8, nothing declared, and the first byte is not "<"');
  add('xml/after-a-no-break-space', ` ${PACS}`);

  // ── The hardening round: every input test/hardening-iso.test.ts and
  //    test/hardening-mt.test.ts hand to the reader, and every message
  //    test/hardening-mapping.test.ts maps, built the way the test builds it.
  //    Each group starts with the defect id of its test; an input that a case
  //    above already is, is named there instead of written twice ──

  // X1: &valueOf; and every other Object.prototype name is an undefined entity, never text.
  for (const name of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__']) {
    add(`xml/entity-named-${name}`, `<Nm>&${name};</Nm>`);
    add(`xml/entity-named-${name}-in-attribute`, `<a b="&${name};"/>`);
  }
  add('xml/entity-named-valueOf-as-creditor-name', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>&valueOf;</Nm>'),
    'refused, not a company called "function valueOf() { [native code] }"');
  add('xml/five-predefined-entities-in-a-name', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>&amp;&lt;&gt;&quot;&apos;</Nm>'),
    'the five XML defines still read (the test reads them with the XML reader alone)');

  // X2: a hexadecimal character reference is written &#x — &#X is malformed (xml/character-references holds one too).
  add('xml/character-reference-capital-x', '<a>&#X43;</a>');
  add('xml/character-reference-capital-x-in-attribute', '<a b="&#X43;"/>');
  add('xml/character-references-hex-and-decimal', PACS.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>&#x43;&#67;</Nm>'), 'the name reads CC');

  // I1: an element named after an Object.prototype member is an unsupported message, not a TypeError.
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    add(`xml/element-named-${name}-in-a-pacs008-document`, `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><${name}/></Document>`);
    add(`xml/element-named-${name}-in-a-document`, `<Document><${name}/></Document>`);
    add(`xml/element-named-${name}-in-a-wrapper`, `<Wrapper><${name}/></Wrapper>`);
    add(`xml/element-named-${name}-alone`, `<${name}/>`);
  }

  // I2: one remittance line of many /INV/ references is read in full. The test's 200,000 are neither stored
  //     (each would be in the expected payment) nor repeated (the repeat form ends with its repeated text,
  //     and the line sits inside the document): 200 of them, written the way the test writes them.
  add('xml/ustrd-200-invoice-references', PACS.replace(/<Strd>[\s\S]*<\/Strd>/, `<Ustrd>${Array.from({ length: 200 }, (_, i) => `/INV/${i}`).join('')}</Ustrd>`));

  // I3: a message standing outside a Document, beside documents, refuses the file. (Documents only: xml/batch-same-ids-other-uetrs.)
  const bodyOf = (xml) => /<FIToFICstmrCdtTrf>[\s\S]*<\/FIToFICstmrCdtTrf>/.exec(xml)[0];
  const UETR_1 = '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10';
  const UETR_2 = '11111111-2222-4333-8444-555555555555';
  const UETR_3 = '66666666-7777-4888-9999-000000000000';
  const BARE_MESSAGE = bodyOf(DOC).replace(UETR_1, UETR_2);
  add('xml/batch-document-then-bare-message', `<Batch>${DOC}${BARE_MESSAGE}</Batch>`);
  add('xml/batch-bare-message-then-document', `<Batch>${BARE_MESSAGE}${DOC}</Batch>`);
  add('xml/batch-document-and-bare-message-in-an-inner-wrapper', `<Batch>${DOC}<Inner>${BARE_MESSAGE}</Inner></Batch>`);
  add('xml/batch-two-bare-messages', `<Batch>${BARE_MESSAGE}${BARE_MESSAGE.replace(UETR_2, UETR_3)}</Batch>`, 'bare messages only: every payment is read');

  // I4: a Document holding two messages is refused, not read as the first of them.
  const PACS_BODY = bodyOf(PACS);
  add('xml/document-holding-two-pacs008-messages', PACS.replace(PACS_BODY, PACS_BODY + PACS_BODY.replace(UETR_1, UETR_2)));
  add('xml/document-holding-pacs008-and-pain001', PACS.replace(PACS_BODY, PACS_BODY + /<CstmrCdtTrfInitn>[\s\S]*<\/CstmrCdtTrfInitn>/.exec(PAIN)[0]));

  // I5: what stands after or instead of the message is named. (Before it: xml/document-other-element-first;
  //     a document of another kind: xml/pacs009-minimal.)
  add('xml/document-other-element-after-the-message', PACS.replace('</FIToFICstmrCdtTrf>', '</FIToFICstmrCdtTrf><FICdtTrf/>'));
  add('xml/pain001-document-holding-another-element', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"><Extra/></Document>');
  add('xml/pacs008-document-holding-nothing', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"/>');

  // I6: a test BIC in a bare message's own agent marks a test, reported by its path. (In a header: xml/bah-test-bic.)
  const BARE_TEST_BIC = DOC.replace(/<Document[^>]*>/, '').replace('</Document>', '')
    .replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>', '<BICFI>DEMOSGS0</BICFI>\n          <Nm>');
  add('xml/bare-message-test-bic-in-creditor-agent', BARE_TEST_BIC);
  add('xml/bare-message-test-bic-in-a-wrapper', `<Batch>${BARE_TEST_BIC}</Batch>`, 'the path starts at the wrapper');

  // I7: an agent identified only by FinInstnId/Othr is kept, with its scheme.
  add('xml/intermediaries-identified-by-othr', PACS.replace('<Dbtr>',
    '<IntrmyAgt1><FinInstnId><Othr><Id>INTERMEDIARY-77</Id><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr></FinInstnId></IntrmyAgt1>'
    + '<IntrmyAgt2><FinInstnId><Othr><Id>CORR-2</Id><SchmeNm><Prtry>BANKCODE</Prtry></SchmeNm></Othr></FinInstnId></IntrmyAgt2>'
    + '<IntrmyAgt3><FinInstnId><Othr><Id>CORR-3</Id></Othr></FinInstnId></IntrmyAgt3><Dbtr>'));
  add('xml/creditor-agent-member-id-beside-othr', PACS.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>',
    '<ClrSysMmbId><ClrSysId><Cd>SGIBG</Cd></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'
    + '<Othr><Id>X-1</Id><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr>'), 'the clearing-system member id comes first, with its own clearing system');

  // I9: an XML amount with a comma is refused, while an MT103 keeps its decimal comma.
  //     (12500,00 as IntrBkSttlmAmt: xml/amount-decimal-comma; the MT103 sample: sample/mt103-as-text.)
  add('xml/instructed-amount-grouping-comma', PACS.replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">12,500</InstdAmt>'));
  add('xml/pain001-amount-decimal-comma', PAIN.replace('<InstdAmt Ccy="USD">4300.00', '<InstdAmt Ccy="USD">4300,00'));
  add('mt/minimal-32a-amount-12-comma-5', minimalMt('').replace(':32A:261117USD5,', ':32A:261117USD12,5'), 'what normaliseAmount("12,5", "32A", { decimalComma: true }) reads: 12.5');

  // I10: a ChrgBr outside DEBT, CRED, SHAR, SLEV is refused at either level of a pain.001.
  //      (In a pacs.008: xml/charge-bearer-unknown; the block's DEBT: sample/pain001.)
  add('xml/pain001-charge-bearer-BEN-in-transaction', PAIN.replace('<Amt>', '<ChrgBr>BEN</ChrgBr><Amt>'), 'it no longer hides the block\'s DEBT');
  add('xml/pain001-charge-bearer-SHA-in-block', PAIN.replace('<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>SHA</ChrgBr>'));
  add('xml/pain001-charge-bearer-SLEV-in-transaction', PAIN.replace('<Amt>', '<ChrgBr>SLEV</ChrgBr><Amt>'), 'the transaction\'s own overrides its block\'s');

  // P1: XML behind a no-break space is refused as the same bytes without it are. (FIN in Latin-1: mt/latin1-bytes.)
  const FRENCH = PACS.replace('Vina Trading Co., Ltd.', 'Société Générale Import');
  add('xml/latin1-bytes-undeclared-french-name', Buffer.from(FRENCH, 'latin1'));
  add('xml/latin1-bytes-after-a-no-break-space', Buffer.concat([Buffer.from([0xa0]), Buffer.from(FRENCH, 'latin1')]));
  add('xml/latin1-bytes-after-space-no-break-space-line-feed', Buffer.concat([Buffer.from([0x20, 0xa0, 0x0a]), Buffer.from(FRENCH, 'latin1')]));
  add('xml/utf8-bytes-after-a-no-break-space', Buffer.concat([Buffer.from([0xa0]), Buffer.from(FRENCH, 'utf8')]), 'not read as "SociÃ©tÃ©"');

  // P2: a string is held to the 4 MiB bound by the UTF-8 bytes it is hashed as. Over the bound, the
  //     test's comment of é's ends with " -->"; the bound refuses the message before it is read, so here
  //     the repeated é's end it. Under the bound the comment has to close: é's in comments of 100.
  const OPEN_COMMENT = PACS.replace('</Document>\n', '</Document><!-- ');
  c.push({ name: 'xml/over-the-bound-in-utf8-bytes-as-text', as: 'string', repeat: { prefix: OPEN_COMMENT, text: 'é', times: 2_097_153 },
    note: 'fewer than 4 MiB UTF-16 units, more than 4 MiB bytes once written as UTF-8' });
  c.push({ name: 'xml/over-the-bound-in-utf8-bytes-as-bytes', repeat: { prefix: OPEN_COMMENT, text: '\u00c3\u00a9', times: 2_097_153 },
    note: 'the same message as its UTF-8 bytes: é is C3 A9, written here as the two Latin-1 characters of those bytes' });
  c.push({ name: 'xml/under-the-bound-in-utf8-bytes', as: 'string', repeat: { prefix: PACS, text: `<!--${'é'.repeat(100)}-->`, times: 20_249 },
    note: '4,194,279 bytes as UTF-8: read' });

  // P3: a declared encoding is decoded by the reader's own table, and any other label is refused.
  //     The debtor's name is "Co <the bytes> Ltd", the label written into the declaration as the test writes it.
  const declaredAs = (label, raw) => {
    const [a, b] = PACS.replace('encoding="UTF-8"', `encoding="${label}"`).split('Vina Trading Co., Ltd.');
    return Buffer.concat([Buffer.from(`${a}Co `, 'latin1'), Buffer.from(raw), Buffer.from(` Ltd${b}`, 'latin1')]);
  };
  const labelled = (label) => ({ ' Windows-1252 ': 'Windows-1252-with-spaces-around', '\tLatin1 ': 'Latin1-with-tab-and-space-around',
    'UTF8 ': 'UTF8-with-a-space-after', 'utf 8': 'utf-space-8', '': 'empty-label' })[label] ?? label;
  const HIGH_BYTES = Array.from({ length: 0x80 }, (_, i) => 0x80 + i);
  for (const label of ['windows-1252', 'cp1252', 'x-cp1252', 'WINDOWS-1252', ' Windows-1252 ']) {
    add(`xml/declared-${labelled(label)}-bytes-80-to-ff`, declaredAs(label, HIGH_BYTES), 'windows-1252: 0x80–0x9F by the WHATWG index');
  }
  for (const label of ['iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'iso-ir-100', 'csisolatin1',
    'latin1', 'l1', 'cp819', 'ibm819', 'ISO-8859-1', '\tLatin1 ']) {
    add(`xml/declared-${labelled(label)}-bytes-80-to-ff`, declaredAs(label, HIGH_BYTES), 'ISO-8859-1: each byte the code point of the same number');
  }
  for (const label of ['us-ascii', 'ascii', 'ansi_x3.4-1968', 'US-ASCII']) {
    add(`xml/declared-${labelled(label)}-bytes-41-7e`, declaredAs(label, [0x41, 0x7e]), 'A~');
    add(`xml/declared-${labelled(label)}-byte-e9`, declaredAs(label, [0x41, 0xe9]), 'a byte that is not ASCII');
  }
  for (const label of ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8', 'UTF8 ']) {
    add(`xml/declared-${labelled(label)}-bytes-c3-a9`, declaredAs(label, [0xc3, 0xa9]), 'é');
  }
  for (const label of ['EUC-KR', 'Shift_JIS', 'ISO-8859-2', 'windows-1251', 'UTF-7', 'KLINGON-1', 'utf 8', '']) {
    add(`xml/declared-${labelled(label)}-not-known`, declaredAs(label, [0x41]));
  }

  // follow-up (iso): an empty UETR element states no UETR — and the payment is still the one sent with it.
  for (const [empty, label] of [['<UETR></UETR>', 'empty'], ['<UETR/>', 'self-closing'], ['<UETR>  </UETR>', 'spaces-only']]) {
    add(`xml/uetr-element-${label}`, PACS.replace(/<UETR>[^<]+<\/UETR>/, empty));
  }
  add('xml/uetr-not-a-uuid-at-all', PACS.replace(/<UETR>[^<]+<\/UETR>/, '<UETR>not-a-uuid</UETR>'));
  // follow-up (iso): /INV/ with nothing behind it carries no invoice — the next code word is not taken for one.
  const ustrdAlone = (line) => PACS.replace(/<RmtInf>[\s\S]*<\/RmtInf>/, `<RmtInf><Ustrd>${line}</Ustrd></RmtInf>`);
  add('xml/ustrd-empty-invoice-then-roc', ustrdAlone('/INV//ROC/PO-7811'));
  add('xml/ustrd-two-invoices-then-roc', ustrdAlone('/INV/INV-1//INV-2/ROC/PO-7811'));
  add('xml/ustrd-invoice-code-word-alone', ustrdAlone('/INV/'));
  add('mt/70-invoice-code-word-alone-then-roc', MT_FREE.replace('/INV/INV-2026-0475', '/INV/'));

  // ── test/hardening-mt.test.ts: its mt() and withField(). mt(MT_BASE) is mt/minimal ──
  const MT_BASE = ':20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n';
  const finMt = (fields, b3 = '') => `{1:F01DEMOVNVXAXXX0000000000}{2:I103DEMOSGSGXXXXN}${b3}{4:\n${fields}-}`;
  const MT_UETR = 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57';
  /** MT_BASE with this field written so: in place of its own, or of 50K / 59, or added before 59. */
  const withField = (tag, body) => {
    if (tag.startsWith('50')) return MT_BASE.replace(':50K:A\n', `:${tag}:${body}\n`);
    if (tag.startsWith('59')) return MT_BASE.replace(':59:/ACC1\nB\n', `:${tag}:${body}\n`);
    const own = new RegExp(`:${tag}:[^\\n]*\\n`);
    return own.test(MT_BASE) ? MT_BASE.replace(own, `:${tag}:${body}\n`) : MT_BASE.replace(':59:', `:${tag}:${body}\n:59:`);
  };
  const before59 = (fields) => finMt(MT_BASE.replace(':59:', `${fields}:59:`));

  // M1: a code word in field 70 with nothing after it has no value; the next code word is read on its own.
  const with70 = (text70) => finMt(MT_BASE.replace(':71A:', `:70:${text70}\n:71A:`));
  add('mt/minimal-70-empty-roc-then-invoice', with70('/ROC//INV/X'), 'the invoice does not become the end-to-end reference');
  add('mt/minimal-70-empty-roc-then-roc', with70('/ROC//ROC/PO-7811'));
  add('mt/minimal-70-empty-roc-line-then-invoice', with70('/ROC/\n/INV/X'));
  add('mt/minimal-70-empty-invoice-then-roc', with70('/INV//ROC/PO-7811'));
  add('mt/minimal-70-reference-guide-example', with70('/RFB/BET072\n/INV/abc/SDF-96//1234-234///ROC/98IU87'));

  // M2: a second line under a field the standard writes on one line refuses the message, naming the field.
  for (const [tag, body] of [['20', 'R\nR2'], ['23B', 'CRED\nSPAY'], ['26T', 'K90\nA01'], ['32A', '261117USD5,\n9999'], ['33B', 'USD5,\n6,'],
    ['36', '1,25\n7'], ['56C', '/123\nBANK'], ['57C', '/123\nBANK'], ['71A', 'SHA\nOUR'], ['71F', 'USD1,\n2,'], ['71G', 'USD1,\n2,']]) {
    add(`mt/minimal-${tag.toLowerCase()}-second-line`, finMt(withField(tag, body)));
  }
  add('mt/minimal-32a-second-line-after-a-blank-line', finMt(withField('32A', '261117USD5,\n\n9999')));
  add('mt/minimal-71a-blank-lines-after-the-value', finMt(withField('71A', 'SHA\n   \n')), 'they are not a second line');
  add('mt/71a-second-line', MT_FREE.replace(':71A:OUR\r\n', ':71A:OUR\r\nSHA\r\n'), 'the bank\'s own CRLF file, a charges code added under 71A');

  // M3: block 3 with field 121 twice is refused, not read as its first UETR.
  add('mt/minimal-block-3-121-twice', finMt(MT_BASE, `{3:{121:${MT_UETR}}{121:11111111-2222-4333-8444-555555555555}}`));
  add('mt/minimal-block-3-121-twice-the-same', finMt(MT_BASE, `{3:{121:${MT_UETR}}{121:${MT_UETR}}}`));
  add('mt/minimal-block-3-121-among-other-fields', finMt(MT_BASE, `{3:{108:MUR-1}{121:${MT_UETR}}{119:STP}}`));

  // M4: every field the reader takes a value from refuses the message when it is present but empty.
  for (const tag of ['20', '23B', '26T', '32A', '33B', '36', '50A', '50F', '50K', '52A', '52D', '56A', '56C', '56D',
    '57A', '57C', '57D', '59', '59A', '59F', '70', '71A', '71F', '71G', '77B']) {
    add(`mt/minimal-${tag.toLowerCase()}-empty`, finMt(withField(tag, '')));
    add(`mt/minimal-${tag.toLowerCase()}-spaces-only`, finMt(withField(tag, '   ')));
  }
  add('mt/minimal-block-3-121-empty', finMt(MT_BASE, '{3:{121:}}'));
  add('mt/minimal-block-3-without-121', finMt(MT_BASE, '{3:{108:MUR-1}}'), 'states no UETR');

  // M5: the value date in 32A is a day of the calendar, and field 36 is a rate.
  for (const d of ['269999', '261301', '260001', '261100', '261131', '260230', '260229', '230229',
    '240229', '000229', '261130', '261231', '790101', '800101', '991231']) {
    add(`mt/minimal-32a-date-${d}`, finMt(MT_BASE.replace(':32A:261117', `:32A:${d}`)));
  }
  for (const [rate, label] of [['1,2,3', 'two-commas'], ['1.25', 'full-stop'], ['125', 'no-comma'], [',5', 'no-whole-digits'],
    ['1, 5', 'space-inside'], ['-1,5', 'minus-sign'], ['1,5E2', 'exponent'], ['1234567890,12', '13-characters'],
    ['0,9125', 'four-decimals'], ['1,', 'comma-last'], ['12345678901,', '12-characters-comma-last'], ['1234567,1234', '12-characters']]) {
    add(`mt/minimal-36-${label}`, finMt(MT_BASE.replace(':50K:', `:33B:EUR4,\n:36:${rate}\n:50K:`)), `field 36: ${rate}`);
  }

  // M6: an institution field that is only "//" names no clearing code, and the BIC of the header stands.
  add('mt/minimal-52d-and-57d-double-slash-only', before59(':52D://\n:57D://\n'));
  add('mt/minimal-57c-double-slash-only', before59(':57C://\n'));
  add('mt/minimal-57d-double-slash-then-name', before59(':57D://\nPAYOUT BANK\n'));
  add('mt/minimal-57d-clearing-code-and-name', before59(':57D://SC123456\nPAYOUT BANK\n'));

  // M7: option C with a space before its slash keeps its clearing code.
  add('mt/minimal-57c-space-before-slash', before59(':57C: /123456789\n'));
  add('mt/minimal-56c-space-before-slash', before59(':56C: /987654321\n'));

  // M9: in option F an empty name or address line adds nothing.
  add('mt/minimal-50f-empty-name-and-address-lines', finMt(withField('50F', '/ACC0\n1/A\n1/B\n1/\n2/\n2/1 STREET\n3/VN/HANOI')));
  add('mt/minimal-59f-empty-name-and-address-lines', finMt(withField('59F', '/ACC1\n1/\n1/PACIFIC SUPPLY\n2/\n3/SG')));

  // M10: lines 4/ to 8/ and the coded party identifier belong to 50F, and refuse the message in 59F.
  for (const line of ['4/19800101', '5/SG/SINGAPORE', '6/SG/ACRA/201912345K', '7/SG/S1234567A', '8/12']) {
    add(`mt/minimal-59f-line-${line[0]}-refused`, finMt(withField('59F', `/ACC1\n1/B\n3/SG/SINGAPORE\n${line}`)));
  }
  add('mt/minimal-59f-coded-party-identifier-refused', finMt(withField('59F', 'CCPT/SG/S1234567A\n1/B\n3/SG')));
  add('mt/minimal-50f-lines-4-to-8-kept', finMt(withField('50F', 'CCPT/VN/C1234567\n1/A\n3/VN\n4/19800101\n5/VN/HANOI\n7/VN/012345678901\n8/9')));

  // M13: in 50a and 59a the account is everything after the first slash; /C/ and /D/ come off in an institution field alone.
  add('mt/minimal-50k-and-59-account-after-a-letter', finMt(MT_BASE.replace(':59:/ACC1', ':59:/S/SG-ACC-000009').replace(':50K:A', ':50K:/C/VN-1\nA')));
  add('mt/minimal-50a-and-59a-account-after-a-letter', finMt(withField('50A', '/C/VN-2\nDEMOVNVX').replace(':59:/ACC1\nB\n', ':59A:/D/SG-2\nDEMOSGSG\n')));
  add('mt/minimal-59f-account-after-a-letter', finMt(withField('59F', '/S/SG-3\n1/B\n3/SG')));
  add('mt/minimal-59-account-after-a-double-slash', finMt(MT_BASE.replace(':59:/ACC1', ':59://CH123456')), '//CH123456 is not the beneficiary\'s name');
  for (const [first, label] of [['/C/026009593', 'credit-mark'], ['/D/026009593', 'debit-mark'], ['/S/026009593', 'other-letter']]) {
    add(`mt/minimal-57c-${label}`, before59(`:57C:${first}\n`));
  }

  // M14: in option F the first 3/ line starts with the country code, or the message is refused.
  for (const [tag, lines, label] of [['59F', '1/B\n3/SINGAPORE\n3/SG/048616', 'town-before-country'], ['50F', '1/A\n3/VNM/HO CHI MINH', 'three-letter-country'],
    ['59F', '1/B\n3/sg/SINGAPORE', 'lower-case-country'], ['59F', '1/B\n3/', 'empty-country-line'], ['59F', '1/B\n3/S/SINGAPORE', 'one-letter-country'],
    ['59F', '1/B\n3/SG SINGAPORE', 'country-and-town-without-a-slash']]) {
    add(`mt/minimal-${tag.toLowerCase()}-${label}`, finMt(withField(tag, `/ACC1\n${lines}`)));
  }
  for (const [lines, label] of [['3/SG', 'country-alone'], ['3/SG/', 'country-and-an-empty-town'], ['3/SG/SINGAPORE\n3/048616', 'second-3-line-continues-the-address']]) {
    add(`mt/minimal-59f-${label}`, finMt(withField('59F', `/ACC1\n1/B\n${lines}`)));
  }

  // M16: 23B is CRED, CRTS, SPAY, SPRI or SSTD exactly. (CRED: mt/minimal.)
  for (const code of ['crts', 'Crts', 'CRTS1', 'CRT', 'TEST', 'CRTS', 'SPAY', 'SPRI', 'SSTD']) {
    add(`mt/minimal-23b-${code}`, finMt(MT_BASE.replace(':23B:CRED', `:23B:${code}`)));
  }

  // A refusal in the second message of a file says which message it is, and comes before anything is read from the field.
  const FIRST_OF_TWO = finMt(MT_BASE, `{3:{121:${MT_UETR}}}`);
  for (const [second, label] of [
    [finMt(MT_BASE.replace(':71A:SHA', ':71A:')), '71a-empty'],
    [finMt(MT_BASE.replace(':32A:261117USD5,\n', ':32A:269999USD5,\n9999\n')), '32a-second-line-under-an-impossible-date'],
    [finMt(MT_BASE, `{3:{121:${MT_UETR}}{121:${MT_UETR}}}`), 'block-3-121-twice'],
    [finMt(MT_BASE.replace(':32A:261117', ':32A:261131')), '32a-31-november'],
    [finMt(MT_BASE.replace(':23B:CRED', ':23B:crts')), '23b-lower-case-crts'],
    [finMt(withField('59F', '/ACC1\n1/B\n3/SINGAPORE\n4/19800101')), '59f-town-before-country-then-line-4'],
    [finMt(withField('59F', '/ACC1\n1/B\n3/SG\n4/19800101')), '59f-line-4'],
  ]) {
    add(`mt/second-message-${label}`, `${FIRST_OF_TWO}\n${second}`);
  }

  // follow-up (mt): a space before the account slash does not turn the account into the name.
  add('mt/space-before-the-account-slash', MT_FREE.replace(':59:/SG-ACC-000009', ':59: /SG-ACC-000009').replace(':50K:/VN-ACC-000777', ':50K:  /VN-ACC-000777'),
    'the same payment as sample/mt103-as-text');

  // ── test/hardening-mapping.test.ts: the messages it maps (their mappings are in mappingCases). A test
  //    that hands over a payment already parsed is pinned where a message can carry the same values:
  //    a value written into its element, which the reader takes trimmed ──

  // A1: of two amounts in the corridor's currency the smaller is found digit by digit; the comparison's own
  //     pairs where a message can carry them. (999999999999999.98 instructed: xml/amounts-a-cent-apart-beyond-double-precision.)
  const twoAmounts = (instructed, settled) => PACS
    .replace('<IntrBkSttlmAmt Ccy="USD">12500.00<', `<IntrBkSttlmAmt Ccy="USD">${settled}<`)
    .replace('<InstdAmt Ccy="USD">12500.00<', `<InstdAmt Ccy="USD">${instructed}<`);
  for (const [instructed, settled] of [['999999999999999.99', '999999999999999.98'], ['7010.50', '7000.50'], ['1000', '1015'], ['7000.5', '7000.50'],
    ['100.5', '100.50'], ['99.999', '100'], ['100.001', '100'], ['0.00', '0']]) {
    add(`xml/amounts-instructed-${instructed}-settled-${settled}`, twoAmounts(instructed, settled));
  }

  // A2: a beneficiary's country taken from its bank's address is labelled as that, not as the letters of a BIC.
  const CREDITOR_NO_COUNTRY = PACS.replace('<Ctry>SG</Ctry>\n        </PstlAdr>\n      </Cdtr>', '</PstlAdr>\n      </Cdtr>');
  add('xml/creditor-without-country', CREDITOR_NO_COUNTRY, 'its bank has a BIC');
  add('xml/creditor-country-only-in-its-bank-address', CREDITOR_NO_COUNTRY.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>',
    '<Nm>Demo Payout Bank (SG)</Nm><PstlAdr><Ctry>SG</Ctry></PstlAdr>'), 'its bank has no BIC, and states its country in its address');

  // A3: the first remittance line is cut at 64 characters counted by code point — never inside a surrogate pair.
  const remittanceLine = (line) => PACS.replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>')
    .replace(/<Strd>[\s\S]*<\/Strd>/, `<Ustrd>${line}</Ustrd>`);
  add('xml/remittance-astral-character-64th', remittanceLine(`${'x'.repeat(63)}\u{1F600}tail`));
  add('xml/remittance-astral-character-65th', remittanceLine(`${'x'.repeat(64)}\u{1F600}`));
  add('xml/remittance-70-astral-characters', remittanceLine('\u{1F600}'.repeat(70)));
  add('xml/remittance-spaces-inside', remittanceLine('SPARE   PARTS'));
  add('xml/remittance-space-at-the-cut', remittanceLine(`${'x'.repeat(63)} tail`));

  // A4: an empty LEI is no LEI — the identification the message does state is taken.
  add('xml/debtor-lei-empty', PACS.replace('<OrgId>', '<OrgId><LEI></LEI>'));
  add('xml/debtor-lei-spaces-only', PACS.replace('<OrgId>', '<OrgId><LEI>   </LEI>'));
  add('xml/debtor-lei-beside-tax-id', PACS.replace('<OrgId>', '<OrgId><LEI>9845003X7Y4K2B1Q8W63</LEI>'), 'an LEI that says something comes first');
  add('xml/debtor-lei-and-tax-id-empty', PACS.replace('<OrgId>', '<OrgId><LEI></LEI>').replace('<Id>0312345678</Id>', '<Id> </Id>'));

  // A5: an empty instruction id does not hide the payment-information id or the message id. (Neither empty: sample/pain001.)
  add('xml/pain001-instruction-id-empty', PAIN.replace('<InstrId>VINATRD-INS-0031-1</InstrId>', '<InstrId></InstrId>'));
  add('xml/pain001-instruction-id-blank-block-id-empty', PAIN.replace('<InstrId>VINATRD-INS-0031-1</InstrId>', '<InstrId> </InstrId>')
    .replace('<PmtInfId>VINATRD-PMT-0031</PmtInfId>', '<PmtInfId></PmtInfId>'));
  add('xml/instruction-id-empty', PACS.replace('<InstrId>OUT-2026-000123</InstrId>', '<InstrId></InstrId>'));
  add('xml/instruction-id-and-message-id-empty', PACS.replace('<InstrId>OUT-2026-000123</InstrId>', '<InstrId></InstrId>')
    .replace('<MsgId>DEMOVNVX20261117000123</MsgId>', '<MsgId></MsgId>'));

  // A6: a member id under an empty clearing system is a "clearing member", with one space.
  const creditorAgent = (fin) => PACS.replace('<BICFI>DEMOSGSG</BICFI>\n          <Nm>Demo Payout Bank (SG)</Nm>', fin);
  add('xml/creditor-agent-member-id-without-clearing-system', creditorAgent('<BICFI>DEMOSGSG</BICFI><ClrSysMmbId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'));
  add('xml/creditor-agent-member-id-clearing-system-empty', creditorAgent('<BICFI>DEMOSGSG</BICFI><ClrSysMmbId><ClrSysId><Cd></Cd></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'));
  add('xml/creditor-agent-member-id-clearing-system-spaces-only', creditorAgent('<BICFI>DEMOSGSG</BICFI><ClrSysMmbId><ClrSysId><Cd>  </Cd></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'));
  add('xml/creditor-agent-member-id-in-sgibg', creditorAgent('<ClrSysMmbId><ClrSysId><Cd>SGIBG</Cd></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><Nm>Demo Payout Bank (SG)</Nm>'));

  // A4–A6 (sweep): every other value the mapping falls back from is no value when it is empty.
  add('xml/creditor-agent-name-and-blank-country', creditorAgent('<Nm>Demo Payout Bank (SG)</Nm><PstlAdr><Ctry> </Ctry></PstlAdr>'));
  add('xml/intermediaries-with-empty-values', PACS.replace('<Dbtr>', '<IntrmyAgt1><FinInstnId><BICFI></BICFI><Nm>Correspondent Bank</Nm></FinInstnId></IntrmyAgt1>'
    + '<IntrmyAgt2><FinInstnId><BICFI> </BICFI><Nm></Nm><ClrSysMmbId><MmbId></MmbId></ClrSysMmbId></FinInstnId></IntrmyAgt2><Dbtr>'), 'an agent that states nothing is no agent');

  // A9: without a UETR, an end-to-end id written NOTPROVIDED and one left out name the same payment (the ids are in `derived`).
  //     (PO-7781: xml/no-uetr, as bytes; with a UETR and PO-7781: sample/pacs008-as-text.)
  const noUetrEndToEnd = (e2e) => PACS_NO_UETR.replace('<EndToEndId>PO-7781</EndToEndId>', `<EndToEndId>${e2e}</EndToEndId>`);
  for (const [e2e, label] of [['NOTPROVIDED', 'NOTPROVIDED'], ['notprovided', 'notprovided'], ['NONREF', 'NONREF'], ['NoRef', 'NoRef'],
    [' NOTPROVIDED', 'space-NOTPROVIDED'], ['NOTPROVIDED\n', 'NOTPROVIDED-line-feed'], ['\tnonref ', 'tab-nonref-space'], ['', 'empty'], ['  ', 'spaces-only'],
    ['NOTPROVIDED-1', 'NOTPROVIDED-1']]) {
    add(`xml/no-uetr-end-to-end-id-${label}`, noUetrEndToEnd(e2e));
  }
  add('xml/no-uetr-no-end-to-end-id', PACS_NO_UETR.replace(/\s*<EndToEndId>PO-7781<\/EndToEndId>/, ''), 'the end-to-end id left out');
  add('xml/end-to-end-id-NOTPROVIDED', PACS.replace('<EndToEndId>PO-7781</EndToEndId>', '<EndToEndId>NOTPROVIDED</EndToEndId>'), 'with a UETR, the id is the UETR\'s');

  // A10: a word for "no reference" with white space around it is still no reference — and never the invoice.
  const noInvoiceEndToEnd = (e2e) => PACS.replace(/\s*<RmtInf>[\s\S]*<\/RmtInf>/, '').replace('<EndToEndId>PO-7781</EndToEndId>', `<EndToEndId>${e2e}</EndToEndId>`);
  for (const [e2e, label] of [[' NOTPROVIDED', 'space-NOTPROVIDED'], ['NOTPROVIDED\n', 'NOTPROVIDED-line-feed'], ['\tnonref ', 'tab-nonref-space'],
    ['NOREF\r\n', 'NOREF-crlf'], [' PO-7781\n', 'space-PO-7781-line-feed']]) {
    add(`xml/no-invoice-end-to-end-id-${label}`, noInvoiceEndToEnd(e2e));
  }

  return c;
}

/** Mapping cases: a payment out of a parse case, and the options it is mapped with. */
export function mappingCases() {
  const parties = JSON.parse(text('parties.sample.json'));
  const c = [];
  const add = (name, parse, options = {}, index = 0, note = '') => c.push({ name, parse, index, options, note });
  add('pacs008/default', 'sample/pacs008');
  add('pacs008-envelope/default', 'sample/pacs008-envelope');
  add('pain001/default', 'sample/pain001');
  add('mt103-structured/default', 'sample/mt103-structured');
  add('mt103-free/without-customer-master', 'sample/mt103-free-format', {}, 0, 'the registration number has no field in a free-format MT103');
  add('mt103-free/with-customer-master', 'sample/mt103-free-format', { supplement: parties['VN-ACC-000777'] });
  add('mt103-free/supplement-overrides', 'sample/mt103-free-format', { supplement: {
    debtor: { name: 'Vina Trading Company Limited', country: 'VN', address: '12 Le Loi Boulevard, District 1, Ho Chi Minh City', registration_number: '0312345678' },
    creditor: { bank: 'Example Bank Ltd' }, invoiceRef: 'INV-OVERRIDE-1', purposeCode: 'GDDS' } }, 0, 'a customer record wins over the message');
  add('mt103-no-uetr/default', 'mt/no-uetr', { supplement: parties['VN-ACC-000777'] });
  add('mt103-crts/refused', 'mt/crts', { supplement: parties['VN-ACC-000777'] });
  add('mt103-crts/allowed-with-a-test-key', 'mt/crts', { supplement: parties['VN-ACC-000777'], allowTestMessages: true });
  add('mt103-test-bic/refused', 'mt/test-bic', { supplement: parties['VN-ACC-000777'] });
  add('mt103-charges/default', 'mt/charges', { supplement: parties['VN-ACC-000777'] });
  add('mt103-intermediary/default', 'mt/intermediary-and-purpose', { supplement: parties['VN-ACC-000777'] });
  add('mt103-eur/no-usd-amount', 'mt/eur', { supplement: parties['VN-ACC-000777'] });
  add('mt103-eur/trade-currency-eur', 'mt/eur', { supplement: parties['VN-ACC-000777'], tradeCurrency: 'EUR' });
  add('pacs008/private-person', 'xml/private-person');
  add('pacs008/creditor-in-us', 'xml/creditor-in-us');
  add('pacs008/creditor-in-us-on-a-vn-us-corridor', 'xml/creditor-in-us', { corridor: { origin: 'VN', destination: 'US' } });
  add('pacs008/no-inference-from-bic', 'sample/pacs008', { inferCountryFromBic: false });
  add('pacs008-envelope/no-inference-from-bic', 'sample/pacs008-envelope', { inferCountryFromBic: false });
  add('pacs008/instructed-less-than-settled', 'xml/instructed-less-than-settled');
  add('pacs008/settled-less-than-instructed', 'xml/settled-less-than-instructed');
  add('pacs008/eur-settled-usd-instructed', 'xml/eur-settled-usd-instructed');
  add('pacs008/second-of-two', 'xml/two-transactions', {}, 1);
  add('pain001/second-block', 'xml/pain001-two-blocks', {}, 1);

  // ── What the TypeScript tests map, with the options they map with ──
  const master = parties['VN-ACC-000777'];
  add('pacs008/second-transaction-bare', 'xml/second-transaction-bare', {}, 1, 'every issue at once');
  add('mt103-bare/countries-from-agents', 'mt/bare-countries-from-agents', { supplement: { debtor: { registration_number: '1' } } });
  add('mt103-bare/no-inference-from-bic', 'mt/bare-countries-from-agents', { inferCountryFromBic: false, supplement: { debtor: { registration_number: '1' } } });
  add('pacs008-envelope/with-customer-master', 'sample/pacs008-envelope', { supplement: parties['VN-ACC-000812'] }, 0, 'NOTPROVIDED is not a reference');
  add('pacs008/vnd', 'xml/vnd', {}, 0, 'another currency is an issue, not a conversion');
  add('pacs008/instructed-in-vnd', 'xml/instructed-in-vnd');
  add('pacs008/settled-in-sgd', 'xml/settled-in-sgd');
  add('pacs008/charges-on-the-creditor', 'xml/charges-on-the-creditor', {}, 0, 'the amount moved is the settled amount');
  add('mt103/charges-on-the-beneficiary', 'mt/charges-on-the-beneficiary');
  add('mt103/receiver-charges-prepaid', 'mt/receiver-charges-prepaid', {}, 0, 'the beneficiary is owed the instructed amount');
  add('pacs008/receiver-charges-prepaid', 'xml/receiver-charges-prepaid');
  add('pacs008/purchase-order-invoices-credit-note', 'xml/purchase-order-invoices-credit-note', {}, 0, 'the invoice is the document the message calls an invoice');
  add('pacs008/untyped-document-before-typed', 'xml/untyped-document-before-typed');
  add('pacs008/unstructured-invoice-with-slashes', 'xml/unstructured-invoice-with-slashes');
  add('mt103/70-reference-guide-example', 'mt/70-reference-guide-example', { supplement: master });
  add('pacs008/private-person-born', 'xml/private-person-born', {}, 0, 'a private person is not sent as a company');
  add('mt103/50f-birth-date', 'mt/50f-birth-date');
  add('mt103/50f-birth-place', 'mt/50f-birth-place');
  add('mt103/50f-national-identity-number', 'mt/50f-national-identity-number');
  add('mt103/50f-passport', 'mt/50f-passport');
  add('mt103-structured-crts/refused', 'mt/structured-crts');
  add('mt103-structured-crts/allowed-with-a-test-key', 'mt/structured-crts', { allowTestMessages: true });
  add('pacs008/debtor-in-th', 'xml/debtor-in-th');
  add('pacs008/creditor-bank-in-my', 'xml/creditor-bank-in-my');
  add('pacs008/kr-to-us-on-its-corridor', 'xml/kr-to-us', { corridor: { origin: 'KR', destination: 'US' } }, 0, 'the route is the client\'s to state');
  add('pacs008/kr-to-us-on-the-default-corridor', 'xml/kr-to-us');
  add('mt103/test-bic-sender', 'mt/structured-test-bic-sender');
  add('mt103/test-bic-receiver', 'mt/structured-test-bic-receiver');
  add('pacs008/pilot-service', 'xml/pilot-service');
  add('pacs008/live-service', 'xml/live-service');
  add('pacs008/bah-test-bic', 'xml/bah-test-bic');
  add('pacs008/bah-test-bic-allowed', 'xml/bah-test-bic', { allowTestMessages: true });
  add('mt103/77t-remit', 'mt/77t-remit');
  add('pacs008/party-details', 'xml/party-details');
  add('pain001/without-instruction-id', 'xml/pain001-without-instruction-id');
  add('mt103/50f-continuation-lines', 'mt/50f-continuation-lines');
  add('mt103/50a-with-supplement', 'mt/50a', { supplement: { debtor: { name: 'Vina Trading', address: '12 Le Loi', country: 'VN' } } }, 0, 'a BIC is not a registration number');
  add('pacs008/three-transactions-second-without-account', 'xml/three-transactions-second-without-account', {}, 1);
  add('pacs008/older-spellings', 'xml/older-spellings-bare-body');

  // ── What a port could get wrong ──
  add('pacs008/unicode-spaces-around-values', 'xml/unicode-spaces-around-values');
  add('pacs008/unicode-spaces-inside-a-name', 'xml/unicode-spaces-inside-a-name');
  add('pacs008/not-spaces-around-a-name', 'xml/not-spaces-around-a-name');
  add('pacs008/remittance-with-unicode-spaces', 'xml/remittance-with-unicode-spaces');
  add('pacs008/remittance-cut-inside-a-surrogate-pair', 'xml/remittance-cut-inside-a-surrogate-pair');
  add('mt103/unicode-spaces-around-values', 'mt/unicode-spaces-around-values');
  add('mt103/next-line-in-a-tag-line', 'mt/next-line-in-a-tag-line', { supplement: master });
  add('mt103/amount-15-digits', 'mt/amount-15-digits', { supplement: master });
  add('mt103/amount-5-decimals', 'mt/amount-5-decimals', { supplement: master });
  add('mt103/amount-zero', 'mt/amount-zero', { supplement: master });
  add('pacs008/amount-trailing-full-stop', 'xml/amount-trailing-full-stop');
  add('pacs008/amounts-a-cent-apart-beyond-double-precision', 'xml/amounts-a-cent-apart-beyond-double-precision');
  add('mt103/50f-every-line-number', 'mt/50f-every-line-number');
  add('mt103/50f-customer-code', 'mt/50f-customer-code');
  add('mt103/50f-national-identity-code', 'mt/50f-national-identity-code');
  add('mt103/59f-without-account', 'mt/59f-without-account');
  add('mt103/59f-without-account-supplied', 'mt/59f-without-account', { supplement: { creditor: { account: 'SG-ACC-000009' } } });
  for (const name of ['70-every-code-word', '70-invoices-separated-by-double-slash', '70-continuation-lines', '70-reference-only', '70-free-text', '70-long-free-text',
    '70-lower-case-code-word', '70-empty-invoice-before-another-code', '70-roc-notprovided', '70-the-same-invoice-twice', '77b-beneficiary-residence-only',
    '77b-three-letter-countries', '71f-three-times-and-71g', 'bic-11-and-lower-case', 'agents-in-options-c-and-d', '59a', '59-account-letter-and-slash',
    '59-account-only', '72-and-23e', 'instructed-in-vnd-with-rate', 'rate-without-instructed-amount', 'lone-cr-inside-a-name']) {
    add(`mt103/${name}`, `mt/${name}`, { supplement: master });
  }
  add('mt103/77b-beneficiary-residence-only-no-inference', 'mt/77b-beneficiary-residence-only', { supplement: master, inferCountryFromBic: false });
  add('mt103/77b-against-50f-and-59f', 'mt/77b-against-50f-and-59f');
  add('mt103/59a-name-supplied', 'mt/59a', { supplement: { debtor: { registration_number: '0312345678' }, creditor: { name: 'Pacific Supply Pte Ltd' } } });
  add('mt103/bic-not-a-bic', 'mt/bic-not-a-bic', { supplement: master });
  add('mt103/header-branch-codes', 'mt/header-branch-codes');
  add('mt103/structured-output-header', 'mt/structured-output-header');
  add('mt103/output-header-test-sender', 'mt/output-header-test-sender');
  add('mt103/output-header-cut-short', 'mt/output-header-cut-short');
  add('pacs008/empty-optional-elements', 'xml/empty-optional-elements');
  add('pacs008/empty-creditor-name', 'xml/empty-creditor-name');
  add('pacs008/empty-debtor', 'xml/empty-debtor');
  add('pacs008/address-every-part', 'xml/address-every-part');
  add('pacs008/address-lines-only', 'xml/address-lines-only');
  add('pacs008/address-lines-only-no-inference', 'xml/address-lines-only', { inferCountryFromBic: false });
  add('pacs008/address-country-lower-case', 'xml/address-country-lower-case');
  add('pacs008/remittance-several-strd-and-ustrd', 'xml/remittance-several-strd-and-ustrd');
  add('pacs008/referred-document-types', 'xml/referred-document-types');
  add('pacs008/charges-several', 'xml/charges-several');
  add('pacs008/intermediaries-1-2-3', 'xml/intermediaries-1-2-3');
  add('pacs008/bic-lower-case-and-11', 'xml/bic-lower-case-and-11');
  add('pacs008/ultimate-parties-and-agent-instructions', 'xml/ultimate-parties-and-agent-instructions');
  add('pacs008/no-settlement-date', 'xml/no-settlement-date');
  add('pacs008/prefixed-document', 'xml/prefixed-document');
  add('pacs008/comments-inside-values', 'xml/comments-inside-values');
  add('pacs008/character-reference-astral', 'xml/character-reference-astral');
  add('pacs008/namespace-not-iso', 'xml/namespace-not-iso');
  add('pacs008/declared-latin1-with-windows-1252-bytes', 'xml/declared-latin1-with-windows-1252-bytes');
  add('pain001/charge-bearer-at-both-levels', 'xml/pain001-charge-bearer-at-both-levels');
  add('pain001/equivalent-amount', 'xml/pain001-equivalent-amount');
  add('pain001/exchange-rate', 'xml/pain001-exchange-rate');
  add('pain001/many-transactions-the-last', 'xml/pain001-many-transactions', { supplement: { debtor: { country: 'VN', address: '12 Le Loi', registration_number: '0312345678' }, creditor: { country: 'SG', bank: 'Example Bank Ltd' } } }, 11);
  add('pacs008-envelope/bah-other-message-definition', 'xml/bah-other-message-definition', { supplement: parties['VN-ACC-000812'] });
  add('pacs008-envelope/bah-test-bic-receiver', 'xml/bah-test-bic-receiver', { supplement: parties['VN-ACC-000812'] });
  add('pacs008-envelope/no-uetr', 'xml/envelope-no-uetr', { supplement: parties['VN-ACC-000812'] });

  // Options alone.
  add('pacs008/supplement-of-spaces', 'sample/pacs008', { supplement: { debtor: { name: '   ', country: '' }, creditor: { bank: ' \t ' }, invoiceRef: ' ' } }, 0, 'a value of spaces is no value: the message\'s stands');
  add('mt103-free/supplement-trimmed', 'sample/mt103-free-format', { supplement: { debtor: { registration_number: '  0312345678 　' } } });
  add('pacs008/supplement-moves-the-debtor', 'sample/pacs008', { supplement: { debtor: { country: 'TH' } } }, 0, 'the route is checked on what will be sent');
  add('pacs008/trade-currency-sgd', 'sample/pacs008', { tradeCurrency: 'SGD' });
  add('pacs008/corridor-in-lower-case', 'sample/pacs008', { corridor: { origin: 'vn', destination: 'sg' } });
  add('pacs008/test-messages-allowed-on-a-live-message', 'sample/pacs008', { allowTestMessages: true });

  // ── The hardening round: what test/hardening-iso.test.ts and
  //    test/hardening-mapping.test.ts map, with the options they map with ──
  add('pacs008/bare-message-test-bic-in-creditor-agent', 'xml/bare-message-test-bic-in-creditor-agent', {}, 0, 'I6: refused as a test, at the path of the BIC');
  add('pacs008/intermediaries-identified-by-othr', 'xml/intermediaries-identified-by-othr', {}, 0, 'I7: each intermediary listed as not carried');
  // A1 (999999999999999.98 instructed: pacs008/amounts-a-cent-apart-beyond-double-precision).
  for (const [instructed, settled] of [['999999999999999.99', '999999999999999.98'], ['7010.50', '7000.50'], ['1000', '1015'], ['7000.5', '7000.50'],
    ['100.5', '100.50'], ['99.999', '100'], ['100.001', '100'], ['0.00', '0']]) {
    add(`pacs008/amounts-instructed-${instructed}-settled-${settled}`, `xml/amounts-instructed-${instructed}-settled-${settled}`);
  }
  // A2
  add('pacs008/creditor-country-from-its-bank-bic', 'xml/creditor-without-country');
  add('pacs008/creditor-country-from-its-bank-address', 'xml/creditor-country-only-in-its-bank-address');
  add('pacs008/creditor-country-from-its-bank-address-no-inference', 'xml/creditor-country-only-in-its-bank-address', { inferCountryFromBic: false });
  // A3, A4, A5, A6, the A4–A6 sweep, A10
  for (const name of ['remittance-astral-character-64th', 'remittance-astral-character-65th', 'remittance-70-astral-characters', 'remittance-spaces-inside',
    'remittance-space-at-the-cut', 'debtor-lei-empty', 'debtor-lei-spaces-only', 'debtor-lei-beside-tax-id', 'debtor-lei-and-tax-id-empty',
    'instruction-id-empty', 'instruction-id-and-message-id-empty', 'creditor-agent-member-id-without-clearing-system',
    'creditor-agent-member-id-clearing-system-empty', 'creditor-agent-member-id-clearing-system-spaces-only', 'creditor-agent-member-id-in-sgibg',
    'creditor-agent-name-and-blank-country', 'intermediaries-with-empty-values', 'no-invoice-end-to-end-id-space-NOTPROVIDED',
    'no-invoice-end-to-end-id-NOTPROVIDED-line-feed', 'no-invoice-end-to-end-id-tab-nonref-space', 'no-invoice-end-to-end-id-NOREF-crlf',
    'no-invoice-end-to-end-id-space-PO-7781-line-feed']) {
    add(`pacs008/${name}`, `xml/${name}`);
  }
  add('pain001/instruction-id-empty', 'xml/pain001-instruction-id-empty');
  add('pain001/instruction-id-blank-block-id-empty', 'xml/pain001-instruction-id-blank-block-id-empty');
  add('pacs008/trade-currency-empty', 'sample/pacs008', { tradeCurrency: '' }, 0, 'A4–A6 sweep: the default currency, not a corridor in ""');
  add('pacs008/supplement-invoice-ref-the-message-states', 'sample/pacs008', { supplement: { invoiceRef: ' INV-2026-0457 ' } }, 0,
    'A7: the same reference from the customer master is not also a further invoice');
  return c;
}

/** A settlement view, the way the platform returns it — only the fields the status reads. */
const view = (state, events, source = true, paymentId = 'PAY-20261117-abcdef0123') => ({
  payment_id: paymentId,
  state,
  events: [
    ['BANK_EVIDENCE_SUBMITTED', { bankInstruction: source ? { sourceMessage: typeof source === 'object' ? source : {
      type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: 'M-1', instructionId: 'I-1',
      endToEndId: 'E-1', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10',
    } } : {} }],
    ...events,
  ].map(([type, payload], seq) => ({ seq, type, issuer: 'X', at: `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`, payload: payload ?? {} })),
});

/** Status cases: the view, and the options `buildPacs002` is given (`createdAt` is always fixed). */
export function statusCases() {
  const long = 'Please describe the purpose of the payment and the nature of the underlying trade in full, '
    + 'and give the reference of the shipping documents that correspond to the invoice.';
  const hostile = '<x> & "q" \u0001\u000B ]]> ' + 'long '.repeat(60);
  const c = [];
  const add = (name, v, options = {}) => c.push({ name, view: v, options: { createdAt: '2026-11-17T00:00:59.000Z', ...options } });
  add('accepted', view('BANK_AUTHORIZED', []));
  add('request-accepted', view('REQUEST_ACCEPTED', []));
  add('travel-rule-pending', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_SENT']]));
  add('question', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }]]));
  add('question-long', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: [long, 'B/L number <required> & date'] }]]));
  add('question-answered', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RECEIVED']]));
  add('payout-pre-approved', view('PAYOUT_PRE_APPROVED', []));
  add('onchain-settled', view('ONCHAIN_SETTLED', []));
  add('payout-in-progress', view('PAYOUT_IN_PROGRESS', []));
  add('evidence-insufficient', view('PAYOUT_IN_PROGRESS', [['EVIDENCE_INSUFFICIENT']]));
  add('payout-failed', view('PAYOUT_IN_PROGRESS', [['PAYOUT_FAILED', { reason: 'closed account' }]]));
  add('credited', view('BENEFICIARY_CREDIT_CONFIRMED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }]]));
  add('anchored', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }]]));
  add('anchored-without-reference', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', {}]]));
  add('anchored-long-reference', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-20261117-0000000000000000000099999' }]]));
  add('anchored-own-data', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-9' }]], false), {});
  add('cancelled-by-bank', view('CANCELLED', [['CANCEL_REQUESTED', { reason: 'customer' }]]));
  add('refused', view('CANCELLED', [['TRAVEL_RULE_REJECTED', { reason: 'screening' }]]));
  add('returned', view('RETURNED', [['PAYOUT_FAILED', { reason: 'closed account' }], ['USDC_RETURNED', { tx_hash: '0x' + 'ab12'.repeat(16) }]]));
  add('exception', view('EXCEPTION', [['EXCEPTION', { error: 'boom' }]]));
  add('unknown-state', view('SOMETHING_NEW', []));
  add('no-events', { payment_id: 'PAY-20261117-abcdef0123', state: 'BANK_AUTHORIZED', events: [] });
  add('mt103-source', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-2' }]], {
    type: 'MT103', sha256: 'b'.repeat(64), messageId: 'OUT2026000125', instructionId: 'OUT2026000125', endToEndId: 'PO-7811',
    uetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', valueDate: '2026-11-17', content: 'c'.repeat(64), index: 0 }, 'PAY-b4d9e7a1-0123456789'));
  add('pain001-source', view('BANK_AUTHORIZED', [], {
    type: 'pain.001.001.09', sha256: 'd'.repeat(64), messageId: 'VINATRD-20261117-0031', paymentInfoId: 'VINATRD-PMT-0031',
    instructionId: 'VINATRD-INS-0031-1', endToEndId: 'PO-7790', valueDate: '2026-11-17', content: 'e'.repeat(64), index: 0 }, 'PAY-0f1e2d3c-4b5a697887'));
  add('message-id-given', view('ONCHAIN_SETTLED', []), { messageId: 'BANK-STATUS-0001' });
  add('hostile-text', {
    payment_id: 'PAY-<&>-an-identifier-that-is-far-too-long-for-a-35-character-field',
    state: 'TRAVEL_RULE_PENDING',
    events: [
      { seq: 0, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'x', at: '2026-11-17T00:00:00Z', payload: { bankInstruction: { sourceMessage: {
        type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: hostile, instructionId: hostile, endToEndId: hostile, uetr: 'not-a-uuid',
      } } } },
      { seq: 1, type: 'TRAVEL_RULE_RFI', issuer: 'x', at: '2026-11-17T00:00:01Z', payload: { questions: [hostile, '', 3, null] } },
    ],
  });

  // ── Views the TypeScript tests build that are not cases above ──
  add('returned-short-hash', view('RETURNED', [['PAYOUT_FAILED', { reason: 'closed account' }], ['USDC_RETURNED', { tx_hash: '0xabc' }]]));
  add('accepted-own-data', view('BANK_AUTHORIZED', [], false));
  add('control-characters-only', {
    payment_id: 'PAY-1', state: 'TRAVEL_RULE_PENDING',
    events: [
      { seq: 0, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'x', at: '2026-11-17T00:00:00Z', payload: { bankInstruction: { sourceMessage: {
        type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: '\u0001\u0002\u0003', instructionId: '\u0001', endToEndId: 'E-1',
      } } } },
      { seq: 1, type: 'TRAVEL_RULE_RFI', issuer: 'x', at: '2026-11-17T00:00:01Z', payload: { questions: ['\u0001\u0002'] } },
    ],
  });

  // ── Odd shapes: what a platform or a proxy could hand back ──
  const P = 'PAY-20261117-abcdef0123';
  const at = (seq) => `2026-11-17T00:00:${String(seq).padStart(2, '0')}.000Z`;
  const ev = (seq, type, payload, when = at(seq)) => ({ seq, type, issuer: 'X', at: when, payload });
  const SOURCE = { type: 'pacs.008.001.08', sha256: 'a'.repeat(64), messageId: 'M-1', instructionId: 'I-1', endToEndId: 'E-1', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10' };
  const submitted = (source = SOURCE, seq = 0) => ev(seq, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: { sourceMessage: source } });
  add('events-out-of-seq-order', { payment_id: P, state: 'EVIDENCE_ANCHORED', events: [ev(3, 'PAYOUT_COMPLETED', { bank_reference: 'FAST-3' }), submitted(), ev(1, 'REQUEST_ACCEPTED', {}), ev(2, 'PAYOUT_COMPLETED', { bank_reference: 'FAST-2' })] });
  add('payload-a-string', { payment_id: P, state: 'TRAVEL_RULE_PENDING', events: [submitted(), ev(1, 'TRAVEL_RULE_RFI', 'Why?')] });
  add('payload-an-array', { payment_id: P, state: 'EVIDENCE_ANCHORED', events: [submitted(), ev(1, 'PAYOUT_COMPLETED', ['FAST-1'])] });
  add('payload-null', { payment_id: P, state: 'CANCELLED', events: [submitted(), ev(1, 'CANCEL_REQUESTED', null)] });
  add('submitted-payload-a-string', { payment_id: P, state: 'BANK_AUTHORIZED', events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', 'sourceMessage')] });
  add('bank-instruction-an-array', { payment_id: P, state: 'BANK_AUTHORIZED', events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: [{ sourceMessage: SOURCE }] })] });
  add('source-message-an-array', { payment_id: P, state: 'BANK_AUTHORIZED', events: [ev(0, 'BANK_EVIDENCE_SUBMITTED', { bankInstruction: { sourceMessage: [SOURCE] } })] });
  add('source-message-without-sha256', view('BANK_AUTHORIZED', [], { type: 'pacs.008.001.08', messageId: 'M-1', uetr: SOURCE.uetr }));
  add('source-message-type-a-number', view('BANK_AUTHORIZED', [], { ...SOURCE, type: 8 }));
  add('source-message-odd-values', view('BANK_AUTHORIZED', [], {
    ...SOURCE, index: '1', messageId: '', paymentInfoId: 7, endToEndId: null, valueDate: '2026-11-17', content: 'c'.repeat(64), extra: 'not part of it' }));
  add('source-message-index-0', view('BANK_AUTHORIZED', [], { ...SOURCE, index: 0 }));
  add('source-uetr-upper-case', view('BANK_AUTHORIZED', [], { ...SOURCE, uetr: SOURCE.uetr.toUpperCase() }));
  add('source-uetr-version-1', view('BANK_AUTHORIZED', [], { ...SOURCE, uetr: '3f1c9a52-7b0e-1d6a-9c1f-2e8b5a7d4c10' }));
  add('two-submitted-events', { payment_id: P, state: 'BANK_AUTHORIZED', events: [submitted({ ...SOURCE, messageId: 'FIRST' }), submitted({ ...SOURCE, messageId: 'SECOND' }, 1)] });
  add('questions-of-every-kind', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: [{ q: 'Why?' }, ['a', ['b', 'c']], [null], [], 42, -7, true, false, null, 'plain'] }]]));
  add('questions-a-string', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: 'Why?' }]]));
  add('questions-an-object', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: { 1: 'Why?' } }]]));
  add('question-without-spaces', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['x'.repeat(250)] }]]));
  add('question-early-space-only', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: [`${'a'.repeat(50)} ${'b'.repeat(150)}`] }]]));
  add('reference-a-number', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 12345 }]]));
  add('reference-empty', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: '' }]]));
  add('reference-with-spaces', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: ' FAST\t 1\n' }]]));
  add('reference-35', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: `FAST-${'1'.repeat(30)}` }]]));
  add('reference-36', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: `FAST-${'1'.repeat(31)}` }]]));
  add('reason-a-number', view('CANCELLED', [['CANCEL_REQUESTED', { reason: 42 }]]));
  add('payment-id-very-long', view('BANK_AUTHORIZED', [], true, `PAY-${'0123456789'.repeat(20)}`));
  add('payment-id-33', view('ONCHAIN_SETTLED', [['REQUEST_ACCEPTED']], true, `PAY-${'x'.repeat(29)}`));
  add('payment-id-34', view('ONCHAIN_SETTLED', [['REQUEST_ACCEPTED']], true, `PAY-${'x'.repeat(30)}`));
  add('payment-id-with-spaces', view('BANK_AUTHORIZED', [], true, ' PAY 1\t2 '));
  add('payment-id-control-characters-only', view('BANK_AUTHORIZED', [], true, '\u0001\u0002'));
  add('at-not-a-date', { payment_id: P, state: 'EVIDENCE_ANCHORED', events: [submitted(), ev(1, 'PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }, 'yesterday')].map((e) => ({ ...e, at: 'yesterday' })) });
  add('at-empty', { payment_id: P, state: 'TRAVEL_RULE_PENDING', events: [ev(0, 'REQUEST_ACCEPTED', {}, ''), ev(1, 'TRAVEL_RULE_RFI', { questions: ['Why?'] }, '')] });
  add('at-missing', { payment_id: P, state: 'EVIDENCE_ANCHORED', events: [{ seq: 0, type: 'REQUEST_ACCEPTED', issuer: 'X', payload: {} }, { seq: 1, type: 'PAYOUT_COMPLETED', issuer: 'X', payload: { bank_reference: 'FAST-1' } }] });
  add('no-events-key', { payment_id: P, state: 'PAYOUT_IN_PROGRESS' });
  add('events-null', { payment_id: P, state: 'RETURNED', events: null });
  add('accepted-event-not-first', { payment_id: P, state: 'BANK_AUTHORIZED', events: [submitted(), ev(1, 'REQUEST_ACCEPTED', {})] });
  add('state-empty', view('', []));
  add('state-unknown-and-long', view('A_STATE_THIS_SDK_HAS_NEVER_HEARD_OF_BEFORE', []));
  add('message-id-empty', view('ONCHAIN_SETTLED', []), { messageId: '' });
  add('message-id-control-characters-only', view('ONCHAIN_SETTLED', []), { messageId: '\u0001\u0002' });
  add('message-id-too-long', view('ONCHAIN_SETTLED', []), { messageId: `STATUS-${'9'.repeat(40)}` });

  // ── Every state of SWIFT_STATUS_TABLE without the event its row reads, and with events after it ──
  add('cancelled-without-events', view('CANCELLED', []));
  add('cancelled-refused-and-asked', view('CANCELLED', [['CANCEL_REQUESTED', { reason: 'customer' }], ['TRAVEL_RULE_REJECTED', { reason: 'screening' }]]));
  add('returned-without-events', view('RETURNED', []));
  add('returned-without-the-return', view('RETURNED', [['PAYOUT_FAILED', { reason: 'closed account' }]]));
  add('exception-without-event', view('EXCEPTION', []));
  add('credit-confirmed-without-payout-event', view('BENEFICIARY_CREDIT_CONFIRMED', []));
  add('anchored-two-payouts', view('EVIDENCE_ANCHORED', [['PAYOUT_COMPLETED', { bank_reference: 'FAST-1' }], ['PAYOUT_COMPLETED', { bank_reference: 'FAST-2' }]]));
  add('payout-failed-then-insufficient', view('PAYOUT_IN_PROGRESS', [['PAYOUT_FAILED', { reason: 'closed account' }], ['EVIDENCE_INSUFFICIENT']]));
  add('question-then-sent', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_SENT']]));
  add('question-asked-again-after-the-answer', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RECEIVED'], ['TRAVEL_RULE_RFI', { questions: ['And the B/L number?'] }]]));
  add('two-questions-unanswered', view('TRAVEL_RULE_PENDING', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RFI', { questions: ['And the B/L number?'] }]]));
  add('question-then-pre-approved', view('PAYOUT_PRE_APPROVED', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RECEIVED']]));
  add('question-then-cancelled', view('CANCELLED', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['CANCEL_REQUESTED', { reason: 'no answer' }]]));
  add('question-then-payout', view('PAYOUT_IN_PROGRESS', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['TRAVEL_RULE_RECEIVED'], ['PAYOUT_PRE_APPROVED']]));
  add('question-then-exception', view('EXCEPTION', [['TRAVEL_RULE_RFI', { questions: ['Why?'] }], ['EXCEPTION', { error: 'no answer within the window' }]]));
  return c;
}

/**
 * A settlement already in the ledger, the way the platform keeps it: made by
 * this SDK earlier, by an older one, or not from a message at all. In
 * `sourceMessage`, `{ sha256Of: <parse case> }` and `{ contentOf: <parse case>, index }`
 * stand for the digests of that message; the tool writes the values in their place.
 */
const settlement = (paymentId, sourceMessage, {
  state = 'BANK_AUTHORIZED', amount = '12500.00', debtor = 'Vina Trading Co., Ltd.', creditor = 'Pacific Supply Pte Ltd', invoiceRef = 'INV-2026-0457',
} = {}) => ({
  payment_id: paymentId, state, evidence_level: null, evidence_available: false, chain_tx: null, attestation: null,
  events: [
    { seq: 0, type: 'REQUEST_ACCEPTED', issuer: 'STONEHASH', at: '2026-11-16T00:00:00.000Z', payload: {}, sig: null },
    { seq: 1, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'VN-BANK-T1', at: '2026-11-16T00:00:00.100Z', payload: {
      bankInstruction: { ref: paymentId, amount, currency: 'USD', debtor, creditor, ...(sourceMessage ? { sourceMessage } : {}) },
      ...(invoiceRef === null ? {} : { commercialDocs: { invoiceRef, amount, currency: 'USD' } }),
    }, sig: null },
  ],
});

/**
 * Submission scenarios: what `RemitClient.submitSwift()` decides — a payment
 * already made, a new one, or a reference re-used on another payment — step by
 * step against one stand-in platform (the one `test/client.test.ts` builds).
 *
 * A step hands over `message` (a parse case by name, or `{ text }`) with
 * `options`; `paymentId` may be `{ step: n }`, the payment id step n answered,
 * and `supplementByAccount` is a customer master keyed by the debtor's account,
 * handed to the SDK as a lookup. `race: '<error>'` makes the platform answer
 * the POST with that error after taking the settlement, as when the same
 * request got there first; `race: { taken: settlement(…) }` puts another
 * process's settlement in the ledger at the moment of the POST — after the
 * client looked, before the platform decides. A step
 * `{ cancel: { step: n, reason } }` cancels the settlement step n made.
 * `ledger` is on the platform before the first step; `apiKey` is the client's
 * (default `sk_test_x`, a test key).
 */
export function scenarioCases() {
  const c = [];
  const add = (name, steps, more = {}) => c.push({ name, ...more, steps });
  const s = (message, options = {}, more = {}) => ({ message, options, ...more });
  const master = { 'VN-ACC-000777': { debtor: { registration_number: '0312345678' } } };
  const envelopeMaster = { 'VN-ACC-000812': { debtor: { registration_number: '0309876543' } } };
  const SOURCE = { type: 'pacs.008.001.08', messageId: 'DEMOVNVX20261117000123', instructionId: 'OUT-2026-000123', endToEndId: 'PO-7781', uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', valueDate: '2026-11-17' };

  // ── The sequences test/client.test.ts runs ──
  add('one-message-one-settlement', [
    s('sample/pacs008'), s('sample/pacs008'), s('xml/reformatted'),
    s('sample/pain001', { paymentId: { step: 0 } }),
    s('xml/other-amount'), s('xml/other-creditor-name'),
  ], { note: 'however many times it is handed over; a different payment forced onto its id, or carrying its UETR, is refused' });
  add('a-reused-reference-is-never-a-repeat', [
    s('sample/pacs008-as-text'), s('xml/other-invoice'), s('xml/other-creditor-account'), s('xml/other-identifiers'),
    s('xml/two-invoices-one-uetr', { index: 0 }), s('xml/two-invoices-one-uetr', { index: 1 }),
    s('xml/one-transaction-twice', { index: 0 }), s('xml/one-transaction-twice', { index: 1 }),
    s('sample/pain001-as-text'), s('xml/pain001-reformatted'), s('xml/pain001-other-invoice'), s('xml/pain001-later-day'),
    s('xml/other-invoice', { paymentId: 'PAY-OWN-0001' }),
  ]);
  add('the-same-payment-written-out-again', [
    s('sample/pacs008-as-text'), s('xml/exported-next-day'),
    s('xml/uetr-99999999', { paymentId: 'BANK-TX-2026-000777' }), s('xml/uetr-99999999-reformatted'),
    s('sample/mt103-structured-as-text'), s('mt/structured-without-headers'),
    s('mt/structured-127-without-headers'), s('mt/structured-127'),
    s('mt/structured-127-without-headers-next-day'), s('mt/structured-other-uetr-other-amount'),
  ]);
  add('an-incomplete-message-is-refused-before-a-quote', [
    s('sample/mt103-free-format'),
    s('sample/mt103-free-format', { supplementByAccount: master }),
  ]);
  add('the-same-field-20-on-two-days', [s('mt/structured-without-headers'), s('mt/structured-without-headers-next-day')], { note: 'the folder adapter test' });

  // ── Forms of the same message ──
  add('bytes-then-text', [
    s('sample/pacs008'), s('sample/pacs008-as-text'), s('xml/utf8-bom'), s('xml/utf16le-bom'), s('xml/crlf-line-ends'),
    s('sample/mt103-structured'), s('sample/mt103-structured-as-text'),
  ]);
  add('latin1-bytes-then-the-text-they-decode-to', [s('xml/latin1-declared'), s('xml/latin1-declared-as-text')]);
  add('with-then-without-header-blocks', [
    s('sample/mt103-free-format', { supplementByAccount: master }), s('mt/field-lines-only', { supplementByAccount: master }),
    s('mt/text-block-alone', { supplementByAccount: master }), s('mt/free-format-without-headers', { supplementByAccount: master }),
    s('mt/crlf', { supplementByAccount: master }), s('mt/cr-only-line-ends', { supplementByAccount: master }),
    s('mt/unicode-spaces-before-block-1'),
  ]);
  add('without-then-with-header-blocks', [s('mt/structured-field-lines-only'), s('sample/mt103-structured'), s('mt/structured-text-block-alone')]);
  add('a-short-field-20-without-then-with-headers', [s('mt/short-reference-without-headers'), s('mt/short-reference')],
    { note: 'a reference of two characters: the instruction is sent, the platform recognises the settlement\'s other rendering and names it, and that is the answer — nothing is paid twice' });
  add('a-short-field-20-with-then-without-headers', [s('mt/short-reference'), s('mt/short-reference-without-headers')]);

  // ── A batch, and one of its payments alone ──
  add('mt-batch-then-alone', [
    s('mt/two-messages', { index: 0 }), s('mt/two-messages', { index: 1 }), s('mt/two-messages'), s('mt/two-messages', { index: 2 }),
    s('sample/mt103-structured'), s('mt/structured-second'),
  ]);
  add('mt-batch-without-uetr-then-alone', [s('mt/two-messages-without-uetr', { index: 1 }), s('mt/structured-second-without-uetr'), s('mt/two-messages-without-uetr', { index: 0 }), s('mt/structured-field-lines-only')]);
  add('xml-batch-then-alone', [s('xml/two-transactions', { index: 1 }), s('xml/two-transactions-second-alone'), s('xml/two-transactions', { index: 0 }), s('sample/pacs008')]);
  add('pain001-batch-then-alone', [s('xml/pain001-two-blocks', { index: 1 }), s('xml/pain001-second-block-alone'), s('sample/pain001'), s('xml/pain001-two-blocks', { index: 0 })]);
  add('one-file-two-transactions-whose-ids-contain-each-other', [s('xml/pain001-contained-instruction-ids', { index: 1 }), s('xml/pain001-contained-instruction-ids', { index: 0 })]);
  add('one-file-the-same-ids-twice-without-uetr', [s('xml/pain001-same-ids', { index: 0 }), s('xml/pain001-same-ids', { index: 1 }), s('xml/pain001-same-ids', { index: 0 })]);
  add('mt-file-the-same-message-twice', [s('mt/same-ids-twice', { index: 0 }), s('mt/same-ids-twice', { index: 1 })]);

  // ── Exported again, with a new creation time or message id ──
  add('exported-again', [
    s('sample/pacs008'), s('xml/created-next-day-in-another-offset'), s('xml/created-day-before-in-utc'), s('xml/exported-next-day'),
    s('sample/pain001'), s('xml/pain001-created-later'), s('xml/pain001-new-message-id'),
    s('sample/mt103-structured'), s('mt/structured-sent-again'), s('mt/structured-possible-duplicate'),
    s('xml/envelope-no-uetr', { supplementByAccount: envelopeMaster }), s('xml/envelope-no-uetr-new-message-id', { supplementByAccount: envelopeMaster }),
  ]);
  add('no-uetr-and-no-value-date', [s('xml/no-uetr-no-date'), s('xml/no-uetr-no-date-new-message-id'), s('xml/no-uetr-no-date-reformatted')],
    { note: 'without a date the SDK does not call it the same payment, and sends it; the platform cannot tell the two apart either and refuses the second — the refusal is passed on, with the settlement it names' });

  // ── The same UETR on another payment ──
  add('same-uetr-other-payment', [
    s('sample/pacs008'), s('xml/other-amount'), s('xml/other-creditor-name'), s('xml/other-creditor-account'), s('xml/other-invoice'),
    s('xml/other-identifiers'), s('xml/settled-less-than-instructed'), s('xml/foreign-name-beside-creditor-name'), s('xml/unicode-spaces-around-values'),
    s('xml/uetr-upper-case'), s('sample/mt103-structured'), s('mt/structured-other-amount'), s('mt/structured-crts'),
  ]);
  add('no-uetr-same-ids-same-and-other-day', [
    s('xml/no-uetr'), s('xml/no-uetr-next-day'), s('xml/no-uetr-other-amount'), s('xml/no-uetr-reformatted'),
    s('mt/no-uetr', { supplementByAccount: master }), s('mt/no-uetr-next-day', { supplementByAccount: master }), s('mt/no-uetr-other-amount', { supplementByAccount: master }),
  ]);

  // ── A payment id chosen by the caller ──
  add('a-forced-payment-id', [
    s('sample/pacs008'), s('sample/pain001', { paymentId: { step: 0 } }), s('sample/pacs008', { paymentId: { step: 0 } }),
    s('sample/pacs008', { paymentId: 'PAY-MANUAL-0001' }), s('sample/pacs008'), s('xml/other-amount', { paymentId: 'PAY-MANUAL-0002' }),
    s('xml/uetr-99999999', { paymentId: 'PAY-MANUAL-0001' }),
    s('mt/short-reference', { paymentId: 'BANK-RETRY-0001' }), s('mt/short-reference-without-headers', { paymentId: 'BANK-RETRY-0002' }),
    s('sample/pain001', { paymentId: 'BANK-RETRY-0003' }), s('xml/pain001-other-invoice', { paymentId: 'BANK-RETRY-0004' }),
  ], { note: 'an explicit id names the settlement and nothing more: a message that already has one is answered with it, whatever id is passed; a UETR is not put on a second payment; without a UETR, a reference used again under an id of its own is a payment of its own' });

  // ── Two payments whose identifiers collide ──
  add('instruction-ids-collide', [
    s('sample/pain001'), s('xml/pain001-other-company-same-ids'),
    s('mt/structured-field-lines-only'), s('mt/structured-field-lines-only-other-payment'),
    s('sample/pacs008'), s('xml/other-uetr-same-ids'),
  ]);

  // ── The ledger already holds the payment, under an id this SDK did not make ──
  add('made-by-an-older-sdk-from-the-same-bytes', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: { sha256Of: 'sample/pacs008' } })] });
  add('made-by-an-older-sdk-from-another-export', [s('sample/pacs008'), s('xml/other-amount')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64) })],
      note: 'no content digest stored: amount, names, invoice and identifiers decide' });
  add('made-by-an-older-sdk-another-amount', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64) }, { amount: '9900.00' })] });
  add('made-by-an-older-sdk-another-invoice', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64) }, { invoiceRef: 'INV-2026-0999' })] });
  add('made-by-an-older-sdk-without-commercial-documents', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64) }, { invoiceRef: null })] });
  add('made-by-an-older-sdk-with-the-content-digest', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64), content: { contentOf: 'sample/pacs008' } })] });
  add('made-by-an-older-sdk-with-another-content-digest', [s('sample/pacs008')],
    { ledger: [settlement('PAY-20261117-0a1b2c3d4e', { ...SOURCE, sha256: 'f'.repeat(64), content: 'e'.repeat(64) })],
      note: 'a stored content digest decides; amount and names are not consulted' });
  add('made-by-an-older-sdk-mt103', [s('sample/mt103-free-format', { supplementByAccount: master })],
    { ledger: [settlement('PAY-20261117-1b2c3d4e5f', { type: 'MT103', sha256: 'f'.repeat(64), messageId: 'OUT2026000125', instructionId: 'OUT2026000125', endToEndId: 'PO-7811',
      uetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', valueDate: '2026-11-17' }, { amount: '6150.00', debtor: 'VINA TRADING CO LTD', creditor: 'PACIFIC SUPPLY PTE LTD', invoiceRef: 'INV-2026-0475' })],
      note: 'the trade amount 6150 is compared as 6150.00' });
  add('made-by-an-older-sdk-mt103-amount-without-decimals', [s('sample/mt103-free-format', { supplementByAccount: master })],
    { ledger: [settlement('PAY-20261117-1b2c3d4e5f', { type: 'MT103', sha256: 'f'.repeat(64), messageId: 'OUT2026000125', instructionId: 'OUT2026000125', endToEndId: 'PO-7811',
      uetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', valueDate: '2026-11-17' }, { amount: '6150', debtor: 'VINA TRADING CO LTD', creditor: 'PACIFIC SUPPLY PTE LTD', invoiceRef: 'INV-2026-0475' })] });
  add('a-reuse-and-a-repeat-in-the-ledger', [s('sample/pacs008')], {
    ledger: [
      settlement('PAY-20261116-0000000001', { ...SOURCE, sha256: 'f'.repeat(64) }, { amount: '9900.00' }),
      settlement('PAY-20261116-0000000002', { ...SOURCE, uetr: undefined, sha256: 'e'.repeat(64), content: { contentOf: 'sample/pacs008' } }),
    ],
    note: 'the same payment anywhere in the ledger wins over a reference re-used on another: the UETR stands on another payment, and the payment itself is there from a message without one',
  });
  add('a-settlement-not-made-from-a-message', [s('sample/pacs008', { paymentId: 'PAY-OWN-1' }), s('sample/pacs008')], {
    ledger: [settlement('PAY-OWN-1', null), settlement('PAY-3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10-manual', null)],
    note: 'found by its id: a conflict; a settlement not made from a message holds no place and is never the answer to a lookup',
  });
  add('the-lookups-are-exact', [s('sample/mt103-structured')], {
    ledger: [
      settlement('PAY-20261116-0000000003', { type: 'pacs.008.001.08', sha256: 'c'.repeat(64), instructionId: 'OUT2026000126-B', uetr: '12345678-1234-4234-8234-123456789012', valueDate: '2026-11-17' }),
      settlement('PAY-20261116-0000000004', { type: 'MT103', sha256: 'd'.repeat(64), messageId: 'OUT2026000126', instructionId: 'OUT2026000126', valueDate: '2026-11-17', content: 'e'.repeat(64) }, { amount: '990.75' }),
    ],
    note: 'a longer reference that contains this one, and the same field 20 without a UETR and with other content: neither is this payment, and neither is returned',
  });
  add('the-header-stripped-twin-in-the-ledger', [s('sample/mt103-structured')], {
    ledger: [settlement('PAY-20261116-0000000005', { type: 'MT103', sha256: 'd'.repeat(64), messageId: 'OUT2026000126', instructionId: 'OUT2026000126', valueDate: '2026-11-17',
      content: { contentOf: 'sample/mt103-structured' } }, { amount: '990.75' })],
  });

  // ── Payments that read alike; a payment with no identifier of its own ──
  add('two-instalments-and-the-file-again', [
    s('xml/pain001-same-ids', { index: 0 }),
    s('xml/pain001-same-ids-exported-again', { index: 0 }), s('xml/pain001-same-ids-exported-again', { index: 1 }),
    s('xml/pain001-same-ids', { index: 1 }),
    s('xml/pain001-same-ids-exported-again', { index: 1 }), s('xml/pain001-same-ids-exported-again', { index: 0 }), s('xml/pain001-same-ids', { index: 0 }),
  ], { note: 'only the first instalment went through before the file was written out again: the re-export\'s second transaction is the instalment that was never sent — a payment, not "already" — and afterwards each transaction keeps its own settlement' });
  add('both-instalments-then-the-file-again', [
    s('xml/pain001-same-ids', { index: 0 }), s('xml/pain001-same-ids', { index: 1 }),
    s('xml/pain001-same-ids-exported-again', { index: 1 }), s('xml/pain001-same-ids-exported-again', { index: 0 }),
  ], { note: 'each transaction of the re-export is ONE of the two settlements, not both the same one' });
  add('no-identifier-of-its-own', [
    s('xml/pain001-no-identifiers'), s('xml/pain001-no-identifiers-exported-again'),
    s('xml/pain001-no-identifiers-exported-again', { paymentId: 'BANK-RETRY-0002' }),
    s('xml/pain001-no-identifiers-other-message-id'),
  ], { note: 'no UETR, no instruction id, NOTPROVIDED: the same message id, position, value date and content is the same payment, under any payment id; under another message id nothing says so, and it is a new one' });
  add('without-a-uetr-then-two-that-read-alike', [
    s('mt/structured-without-headers'), s('sample/mt103-structured'), s('mt/structured-other-uetr'),
    s('sample/mt103-structured'), s('mt/structured-other-uetr'), s('mt/structured-field-lines-only'),
  ], { note: 'the settlement without a UETR takes the UETR of the rendering it is recognised in; a payment that reads alike under another UETR is then a payment of its own, and each UETR finds its own settlement' });
  // ── What an id of the bank's own does and does not say ──
  add('an-own-id-on-another-payment-with-the-same-identifiers', [
    s('xml/no-uetr', { paymentId: 'BANK-0007' }), s('xml/no-uetr-other-amount', { paymentId: 'BANK-0007' }),
    s('xml/no-uetr-reformatted', { paymentId: 'BANK-0007' }), s('xml/no-uetr-other-amount', { paymentId: 'BANK-0008' }),
  ], { note: 'an id the caller chose says nothing about the message: the same identifiers with other content under it are another payment under a taken id (payment_id_conflict), not a reference used twice; the same payment under it is found; under an id of its own the other payment is made' });
  add('an-own-id-and-a-payment-known-by-its-message-id', [
    s('xml/pain001-no-identifiers-two', { index: 0, paymentId: 'BANK-N-1' }),
    s('xml/pain001-no-identifiers-two-exported-again', { index: 0, paymentId: 'BANK-N-1' }),
    s('xml/pain001-no-identifiers-two-exported-again', { index: 1, paymentId: 'BANK-N-1' }),
    s('xml/pain001-no-identifiers-two-exported-again', { index: 1, paymentId: 'BANK-N-2' }),
    s('xml/pain001-no-identifiers-two', { index: 1 }),
  ], { note: 'with neither identifier, the settlement under the id is this payment only at the same position of the same message id: the file exported again is found at index 0; index 1 under the same id is another payment under a taken id' });
  add('the-derived-id-holds-the-same-identifiers-on-another-day', [s('xml/no-uetr')],
    { ledger: [settlement({ paymentIdOf: 'xml/no-uetr' }, { type: 'pacs.008.001.08', sha256: 'f'.repeat(64), messageId: 'DEMOVNVX20261117000123', instructionId: 'OUT-2026-000123',
      endToEndId: 'PO-7781', valueDate: '2026-11-18', content: { contentOf: 'xml/no-uetr' } })],
      note: 'the reference-and-date rule: the same identifiers on another value date are not "the same reference" — the id is taken by another payment' });
  add('made-before-content-digests-under-another-id', [s('xml/pain001-no-identifiers')],
    { ledger: [settlement('PAY-20261117-9z8y7x6w5v', { type: 'pain.001.001.09', sha256: { sha256Of: 'xml/pain001-no-identifiers' }, messageId: 'VINATRD-20261117-0031' },
      { amount: '4300.00', debtor: 'Vina Trading Co., Ltd.', creditor: 'Pacific Supply Pte Ltd', invoiceRef: 'INV-2026-0470' })],
      note: 'nothing the SDK can look up finds it; the platform knows the file, names the settlement, and that is the answer' });

  // ── Another process, a cancellation, a live key ──
  add('another-process-got-there-first', [s('sample/pacs008', {}, { race: 'duplicate_payment' }), s('sample/pain001', {}, { race: 'idempotency_conflict' })]);
  add('another-process-sent-the-same-message-under-its-own-id', [
    s('sample/pacs008', {}, { race: { taken: settlement('BANK-HUB-B-000001', { ...SOURCE, sha256: { sha256Of: 'sample/pacs008' }, content: { contentOf: 'sample/pacs008' } }) } }),
    s('sample/pacs008'),
  ], { note: 'the platform took the other one and refused this one (duplicate_source_message): the answer is that settlement, already' });
  add('another-process-sent-the-other-rendering', [
    s('mt/short-reference', {}, { race: { taken: settlement('PAY-OTHER-RENDERING-1', { type: 'MT103', sha256: { sha256Of: 'mt/short-reference-without-headers' }, messageId: 'R1', instructionId: 'R1',
      valueDate: '2026-11-17', content: { contentOf: 'mt/short-reference-without-headers' } }, { amount: '990.75', debtor: 'VINA TRADING CO LTD', creditor: 'PACIFIC SUPPLY PTE LTD', invoiceRef: 'INV-2026-0478' }) } }),
    s('mt/short-reference-without-headers'),
  ], { note: 'the MT103 with its header blocks, while the same one without them was being taken: refused by the twin rule, answered already' });
  add('another-process-put-the-uetr-on-another-payment', [
    s('sample/pacs008', {}, { race: { taken: settlement('BANK-HUB-B-000002', { ...SOURCE, sha256: 'f'.repeat(64), content: 'e'.repeat(64) }, { amount: '9900.00' }) } }),
  ], { note: 'refused as reference_reused by the platform; the SDK reads the ledger and says which settlement holds the UETR' });
  add('another-process-and-no-value-date', [
    s('xml/no-uetr-no-date-new-message-id', {}, { race: { taken: settlement('BANK-HUB-B-000003', { type: 'pacs.008.001.08', sha256: { sha256Of: 'xml/no-uetr-no-date' }, messageId: 'DEMOVNVX20261117000123',
      instructionId: 'OUT-2026-000123', endToEndId: 'PO-7781', content: { contentOf: 'xml/no-uetr-no-date' } }) } }),
  ], { note: 'the two cannot be told apart: the platform\'s refusal is passed on, not turned into "already"' });
  add('cancelled-then-handed-over-again', [s('sample/pacs008'), { cancel: { step: 0, reason: 'customer request' } }, s('sample/pacs008'), s('xml/exported-next-day')]);
  add('a-test-message-with-a-live-key', [s('mt/structured-crts'), s('sample/mt103-structured')], { apiKey: 'sk_live_x' });
  add('a-test-message-with-a-test-key', [s('mt/structured-crts'), s('sample/mt103-structured')]);
  add('nothing-to-read', [s('other/hello'), s('xml/doctype-before-document'), s('xml/three-transactions-second-without-account', { index: 1 }), s({ text: ':20:R\n:23B:CRED\n:32A:261117USD5,\n:50K:A\n:59:/ACC1\nB\n:71A:SHA\n' })]);
  return c;
}

/** Values the canonical form (RFC 8785) is pinned on. */
export function jcsValues() {
  return [
    null, true, false, 0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012, 0.1, 100, 2 ** 53 - 1,
    '', 'plain', 'quote " backslash \\ slash /', 'control \u0000\u0001\u001f tab\t newline\n', 'é ü 한글 €', '\ud83d\ude00', '\u2028\u2029',
    // A lone surrogate is written as its escape (well-formed JSON.stringify), not refused.
    'lone \ud83d surrogate',
    [], {}, [1, [2, [3]]], { b: 1, a: 2 }, { '\u00e9': 1, e: 2, E: 3, '': 4, '10': 5, '9': 6 },
    { amount: '12500.00', nested: { z: [true, null, { y: 'x' }], a: '' }, list: [] },
  ];
}

/** Event payloads and evidence elements the two signing conventions are pinned on. */
export function signingInputs() {
  return {
    events: [
      { payment_id: 'PAY-3f1c9a52-6b0d8e41c7', reason: 'customer request' },
      { payment_id: 'PAY-3f1c9a52-6b0d8e41c7', quote_id: 'QT-1', amount: '12500.00', currency: 'USD', debtor: { name: 'Vina Trading Co., Ltd.' }, answers: { purpose: '무역 대금' } },
      { manifest: { date: '2026-11-17', payment_ids: ['PAY-b', 'PAY-a'] } },
    ],
    elements: [
      { id: 'bankInstruction', issuer: 'VN-BANK-T1', ref: 'PAY-3f1c9a52-6b0d8e41c7', amount: '12500.00', currency: 'USD',
        sourceMessage: { type: 'pacs.008.001.08', sha256: 'a'.repeat(64), uetr: '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10' } },
      { id: 'bankApproval', issuer: 'VN-BANK-T1', ref: 'PAY-3f1c9a52-6b0d8e41c7', approvedByRole: 'Trade Operations', attached: true, citedOnly: false },
      { id: 'commercialDocs', issuer: 'VN-BANK-T1', invoiceRef: 'INV-2026-0457', digestVerified: true },
    ],
  };
}
