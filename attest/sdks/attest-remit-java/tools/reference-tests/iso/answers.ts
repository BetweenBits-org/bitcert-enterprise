/**
 * Runs the TypeScript reference on the probe inputs of the Java ISO 20022
 * tests and writes its answers as Java source:
 *
 *   node probe/answers.ts > test/swift/Iso20022Answers.java   (from the work copy; in the repository the test folder is src/test/java/com/stonehash/attest/remit/swift)
 *
 * Every expected value in Iso20022Answers comes from here — none is written
 * by hand. A case is [label, input, answer]; the answer is JSON:
 *   {"elements": […]} | {"payments": […]} | {"tokens": […]} | {"escaped": "…"}
 * where "elements" is the parsed tree in document order, each element with
 * its depth (a flat list: the JSON reader of the Java tests stops at 100 levels).
 *   | {"error": {"name", "code"?, "field"?, "message"}}
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseXml } from '../../../../../packages/attest-remit/src/swift/xml.ts';
import type { XmlElement } from '../../../../../packages/attest-remit/src/swift/xml.ts';
import { xmlEscape } from '../../../../../packages/attest-remit/src/swift/xml.ts';
import { invoiceTokens } from '../../../../../packages/attest-remit/src/swift/iso20022.ts';
import { parseSwiftMessages } from '../../../../../packages/attest-remit/src/index.ts';

const SAMPLES = fileURLToPath(new URL('../../../../../packages/attest-remit/samples/', import.meta.url));
const sample = (name: string): string => readFileSync(SAMPLES + name, 'utf8');

type Case = [string, string];

const errorOf = (e: unknown): Record<string, unknown> => {
  const x = e as { name: string; code?: string; field?: string; message: string };
  const out: Record<string, unknown> = { name: x.name };
  if (x.code !== undefined) out.code = x.code;
  if (x.field !== undefined) out.field = x.field;
  out.message = x.message;
  return out;
};
const elements = (el: XmlElement, depth = 0, out: unknown[] = []): unknown[] => {
  out.push({ depth, name: el.name, ns: el.ns, attrs: el.attrs, text: el.text });
  for (const c of el.children) elements(c, depth + 1, out);
  return out;
};
const answer = (fn: () => unknown): string => {
  try { return JSON.stringify(fn()); } catch (e) { return JSON.stringify({ error: errorOf(e) }); }
};

// ── The XML reader ─────────────────────────────────────────────────────────
const prefixes = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => `xmlns:p${i + from}="urn:${i + from}"`).join(' ');
const xml: Case[] = [
  ['namespaces, prefixes, CDATA, comments and entities', `<?xml version="1.0"?>
    <!-- a comment with <tags> in it -->
    <e:Envelope xmlns:e="urn:env" xmlns="urn:default">
      <Doc a="1 &amp; 2" e:b='x'><![CDATA[5 < 6 & more]]> tail &lt;ok&gt; &#x41;&#66;</Doc>
      <Empty/>
    </e:Envelope>`],
  ['text between children belongs to the parent', '<a>x<b/>y<c>z</c>w</a>'],
  ['a byte-order mark is dropped and offsets count after it', '﻿<a></b>'],
  ['a byte-order mark inside the text is a character', '<a>﻿x</a>'],
  ['a surrogate pair is a character', '<a>😀</a>'],
  ['the default namespace can be undone', '<a xmlns="urn:a"><b xmlns=""><c/></b><p:d xmlns:p="urn:a"/></a>'],
  ['a prefix can be declared again further down', '<p:a xmlns:p="urn:1"><p:b xmlns:p="urn:2"/><p:c/></p:a>'],
  ['a quoted ">" does not end the tag', `<a x="1>2" y='"'/>`],
  ['whitespace around "=" and between attributes', '<a\n x = "1"\t y=\'2\' />'],
  ['xml: attributes need no declaration', '<a xml:lang="en" Ccy="USD"/>'],
  ['a prefixed attribute is not kept', '<a xmlns:p="urn:p" Ccy="USD" p:Ccy="EUR"/>'],
  ['a prefixed attribute may use a prefix declared after it', '<a p:x="1" xmlns:p="urn:p"/>'],
  ['the words inside a comment or CDATA are not markup', '<a><!-- <!DOCTYPE x> --><![CDATA[<!ENTITY y>]]></a>'],
  ['processing instructions and comments around the root', '<?xml version="1.0"?><!--c--><a/><!--d--><?pi x?>\n  '],
  ['60 prefixes', `<a ${prefixes(60)}><p59:b/></a>`],
  ['64 prefixes', `<a ${prefixes(64)}/>`],
  ['63 prefixes and a default namespace', `<a xmlns="urn:d" ${prefixes(63)}/>`],
  ['64 prefixes, then 1 more further down', `<a ${prefixes(64)}><b ${prefixes(1, 64)}/></a>`],
  ['64 prefixes, one declared again', `<a ${prefixes(64)}><b xmlns:p0="urn:again"/></a>`],
  ['64 levels deep', `${'<a>'.repeat(64)}${'</a>'.repeat(64)}`],
  ['entities at the edge of the 32 characters', `<a>&${'a'.repeat(32)};</a>`],
  ['numeric references', '<a>&#0000065;&#x00041;&#x42;&#1114111;&#x10FFFF;&#9;&#xD;&#xa;</a>'],
  ['an entity in an attribute', '<a x="&lt;&#65;&quot;"/>'],
  ['the predefined entities only', '<a>&amp;&lt;&gt;&quot;&apos;</a>'],
  // X1: a name Object.prototype answers for is an entity that is not defined
  ...['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
    '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__'].map((name): Case =>
    [`the entity &${name}; is not defined`, `<a>x&${name};</a>`]),
  ['an entity named after Object.prototype in an attribute', '<a x="&__proto__;"/>'],
  ['an entity named after Object.prototype after a good one', '<a>&amp;&hasOwnProperty;</a>'],
  // X2: hexadecimal is written &#x, never &#X
  ['a hexadecimal reference written &#X is malformed', '<a>&#X42;</a>'],
  ['a hexadecimal reference written &#X in an attribute', '<root>\n<a x="&#X41;"/></root>'],
  ['&#X with nothing after it', '<a>&#X;</a>'],
  ['&#x with upper-case digits is hexadecimal', '<a>&#x4A;&#x4a;</a>'],
  // an attribute named __proto__ is read, counted, and not kept (a plain object in the reference)
  ['an attribute named __proto__ is not kept', '<a __proto__="x" constructor="y" toString="z" Ccy="USD"/>'],
  ['an attribute named __proto__ written twice', '<a __proto__="x" __proto__="y"/>'],
  ['an attribute named __proto__ is decoded', '<a __proto__="&nope;"/>'],
  ['a closing tag may carry whitespace', '<a><b></b \n></a >'],
  // refusals
  ['a document type declaration', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'],
  ['a lower-case doctype', '<!doctype a><a/>'],
  ['an entity declaration', '<a><!EnTiTy x "y"></a>'],
  ['a doctype inside the root', '<a><!DOCTYPE x></a>'],
  ['another markup declaration', '<a><!ELEMENT a ANY></a>'],
  ['"<!" alone', '<a><!></a>'],
  ['an undefined entity', '<a>&undefined;</a>'],
  ['a bare ampersand', '<a>R & D</a>'],
  ['an ampersand at the end', '<a>R &</a>'],
  ['an entity without its semicolon', '<a>&amp</a>'],
  ['an empty entity', '<a>x&;</a>'],
  ['an entity name of 33 characters', `<a>&${'a'.repeat(33)};</a>`],
  ['20 surrogate pairs are 40 code units', `<a>&${'\u{1F600}'.repeat(20)};</a>`],
  ['31 characters and a surrogate pair', `<a>&${'a'.repeat(31)}\u{1F600};</a>`],
  ['16 surrogate pairs fill the 32 code units', `<a>&${'\u{1F600}'.repeat(16)};</a>`],
  ['a reference without digits', '<a>&#;</a>'],
  ['a hexadecimal reference without digits', '<a>&#x;</a>'],
  ['eight decimal digits', '<a>&#00000065;</a>'],
  ['seven hexadecimal digits', '<a>&#x0000041;</a>'],
  ['a reference beyond Unicode', '<a>&#x110000;</a>'],
  ['a reference to a surrogate', '<a>&#xD800;</a>'],
  ['a reference to U+FFFE', '<a>&#xFFFE;</a>'],
  ['a reference to NUL', '<a>&#0;</a>'],
  ['a reference with a sign', '<a>&#-1;</a>'],
  ['a bad entity in an attribute names the tag offset', '<root>\n  <a x="&nope;"/></root>'],
  ['a bad entity in text names the start of the text', '<root>\n  <a>abc &nope; def</a></root>'],
  ['mismatched tags', '<a><b></a></b>'],
  ['a second root', '<a></a><b></b>'],
  ['a second root after a self-closed one', '<a/>\n<b/>'],
  ['a second root with a bad name', '<a/><1b/>'],
  ['never closed', '<a><b>'],
  ['undeclared element prefix', '<p:a/>'],
  ['the xml prefix on an element', '<xml:a/>'],
  ['nested deeper than 64', `<a>${'<b>'.repeat(70)}`],
  ['65 levels', `${'<a>'.repeat(65)}${'</a>'.repeat(65)}`],
  ['an attribute written twice', '<a x="1" x="2"/>'],
  ['a namespace declared twice', '<a xmlns:p="urn:1" xmlns:p="urn:2"/>'],
  ['an undeclared attribute prefix', '<a p:x="1"/>'],
  ['65 prefixes', `<a ${prefixes(65)}/>`],
  ['64 prefixes and a default namespace', `<a xmlns="urn:d" ${prefixes(64)}/>`],
  ['65 prefixes over two elements', `<a ${prefixes(64)}><b ${prefixes(1, 64)}/></a>`],
  ['a control character', '<a>\u0001</a>'],
  ['a control character in a comment', '<!-- \u0008 --><a/>'],
  ['a lone high surrogate', '<a>\uD800</a>'],
  ['a lone high surrogate before another', '<a>\uD800😀</a>'],
  ['a lone low surrogate', '<a>x\uDC00</a>'],
  ['a low surrogate after a pair', '<a>😀\uDE00</a>'],
  ['U+FFFF', '<a>￿</a>'],
  ['a byte-order mark, then a control character', '﻿<a>\u001F</a>'],
  ['text before the root', 'x<a/>'],
  ['text after the root', '<a/> x'],
  ['an entity outside the root', '<a/>&amp;'],
  ['CDATA outside the root', '<![CDATA[x]]><a/>'],
  ['an unterminated comment', '<a><!-- x</a>'],
  ['an unterminated CDATA section', '<a><![CDATA[x</a>'],
  ['an unterminated processing instruction', '<?xml version="1.0"<a/>'],
  ['an unterminated closing tag', '<a></a'],
  ['an unterminated tag', '<a x="1>"'],
  ['a closing tag with nothing open', '</a>'],
  ['a closing tag after the root', '<a></a></a>'],
  ['an empty closing tag', '<a></>'],
  ['a space before the name', '< a/>'],
  ['a name that starts with a digit', '<1a/>'],
  ['two colons', '<a:b:c xmlns:a="urn:a"/>'],
  ['a long bad name is cut at 40', `<${'n'.repeat(50)}?/>`],
  ['a bad attribute name', '<a 1x="1"/>'],
  ['an unquoted attribute', '<a x=1/>'],
  ['attributes without a space between them', `<a x='1'y='2'/>`],
  ['an attribute without a value', '<a x/>'],
  ['an unclosed attribute quote inside the tag', `<a x="1' y='2'/>`],
  ['the attribute value is decoded before its name is checked', '<a 1x="&nope;"/>'],
  ['nothing at all', ''],
  ['only whitespace', '  \n '],
  ['only a comment', '<!-- x -->'],
];

// ── The ISO 20022 reader ────────────────────────────────────────────────────
const NS8 = 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08';
const NS1 = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';
const HDR = '<GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-11-17T09:00:00Z</CreDtTm></GrpHdr>';
const pacs = (txs: string, hdr = HDR, ns = NS8): string => `<Document xmlns="${ns}"><FIToFICstmrCdtTrf>${hdr}${txs}</FIToFICstmrCdtTrf></Document>`;
const tx = (inner: string): string => `<CdtTrfTxInf>${inner}</CdtTrfTxInf>`;
const ID = '<PmtId><InstrId>I1</InstrId><EndToEndId>E1</EndToEndId></PmtId>';
const AMT = '<IntrBkSttlmAmt Ccy="USD">100.00</IntrBkSttlmAmt>';
const PARTIES = '<Dbtr><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr>';
const basic = (extra = ''): string => tx(`${ID}${AMT}${PARTIES}${extra}`);
const pain = (blocks: string, hdr = HDR, ns = NS1): string => `<Document xmlns="${ns}"><CstmrCdtTrfInitn>${hdr}${blocks}</CstmrCdtTrfInitn></Document>`;
const block = (shared: string, txs: string): string => `<PmtInf>${shared}${txs}</PmtInf>`;
const ptx = (inner: string): string => `<CdtTrfTxInf>${inner}</CdtTrfTxInf>`;
const PTX = ptx('<PmtId><EndToEndId>E1</EndToEndId></PmtId><Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr>');
const pacsSample = sample('pacs008.sample.xml');
const bareDoc = pacsSample.replace(/^<\?xml[^>]*\?>\s*/, '');
const painSample = sample('pain001.sample.xml').replace(/^<\?xml[^>]*\?>\s*/, '');

const messages: Case[] = [
  ['older spellings and a bare document', `<FIToFICstmrCdtTrf>
    <GrpHdr><MsgId>M1</MsgId><CreDtTm>2026-01-02T03:04:05Z</CreDtTm></GrpHdr>
    <CdtTrfTxInf>
      <PmtId><EndToEndId>E1</EndToEndId></PmtId>
      <IntrBkSttlmAmt Ccy="USD">10</IntrBkSttlmAmt>
      <Dbtr><Nm>A</Nm><Id><OrgId><BICOrBEI>AAAAVNVX</BICOrBEI></OrgId></Id></Dbtr>
      <DbtrAgt><FinInstnId><BIC>BBBBVNVX</BIC></FinInstnId></DbtrAgt>
      <CdtrAgt><FinInstnId><BIC>CCCCSGSG</BIC></FinInstnId></CdtrAgt>
      <Cdtr><Nm>B</Nm></Cdtr>
    </CdtTrfTxInf></FIToFICstmrCdtTrf>`],
  ['every address part, in its order', pacs(tx(`${ID}${AMT}<Dbtr><Nm>A</Nm><PstlAdr><AdrTp><Cd>ADDR</Cd></AdrTp><CareOf>Ms Tran</CareOf><Dept>Treasury</Dept><SubDept>Payments</SubDept><StrtNm>Le Loi</StrtNm><BldgNb>12</BldgNb><BldgNm>Tower</BldgNm><Flr>9</Flr><UnitNb>9A</UnitNb><PstBx>PO 1</PstBx><Room>901</Room><PstCd>700000</PstCd><TwnNm>Ho Chi Minh City</TwnNm><TwnLctnNm>Ben Nghe</TwnLctnNm><DstrctNm>District 1</DstrctNm><CtrySubDvsn>HCM</CtrySubDvsn><Ctry>VN</Ctry><AdrLine>  line one  </AdrLine><AdrLine> </AdrLine><AdrLine>line two</AdrLine></PstlAdr></Dbtr><Cdtr><Nm>B</Nm><PstlAdr><BldgNb>7</BldgNb><TwnNm>Singapore</TwnNm><Ctry>sg</Ctry></PstlAdr><CtryOfRes>SG</CtryOfRes></Cdtr>`))],
  ['country of residence, and a private person', pacs(tx(`${ID}${AMT}<Dbtr><Nm> Nguyen Van A </Nm><CtryOfRes>VN</CtryOfRes><Id><PrvtId><DtAndPlcOfBirth><BirthDt>1980-01-01</BirthDt></DtAndPlcOfBirth><Othr><Id>P1234567</Id><SchmeNm><Prtry>PASSPORT</Prtry></SchmeNm></Othr><Othr><Id>second</Id></Othr></PrvtId></Id></Dbtr><Cdtr><Nm>B</Nm><PstlAdr><Ctry>SGP</Ctry></PstlAdr><CtryOfRes>SG</CtryOfRes></Cdtr>`))],
  ['an organisation with AnyBIC, LEI and a scheme code', pacs(tx(`${ID}${AMT}<Dbtr><Nm>A</Nm><Id><OrgId><AnyBIC>AAAAVNVX</AnyBIC><BICOrBEI>OLD</BICOrBEI><LEI>5493001KJTIIGC8Y1R12</LEI><Othr><Id>0312345678</Id><SchmeNm><Cd>TXID</Cd></SchmeNm></Othr></OrgId></Id></Dbtr><Cdtr><Nm>B</Nm><Id><OrgId><Othr><SchmeNm><Cd>CUST</Cd></SchmeNm></Othr></OrgId><PrvtId><Othr><Id>X</Id></Othr></PrvtId></Id></Cdtr>`))],
  ['an IBAN and another account', pacs(tx(`${ID}${AMT}${PARTIES}<DbtrAcct><Id><IBAN> VN00 1234 </IBAN><Othr><Id>ignored</Id></Othr></Id></DbtrAcct><CdtrAcct><Id><Othr><Id>SG-1</Id></Othr></Id></CdtrAcct>`))],
  ['agents: clearing members, LEI, name, country; an empty one is none', pacs(tx(`${ID}${AMT}${PARTIES}<DbtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>021000021</MmbId></ClrSysMmbId><LEI>5493001KJTIIGC8Y1R12</LEI><Nm>Demo Bank</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr></FinInstnId></DbtrAgt><CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Prtry>SGIBG</Prtry></ClrSysId><MmbId>7171</MmbId></ClrSysMmbId><PstlAdr><Ctry>Singapore</Ctry></PstlAdr></FinInstnId></CdtrAgt><IntrmyAgt1><FinInstnId><BICFI>INTAUS33</BICFI></FinInstnId></IntrmyAgt1><IntrmyAgt2><FinInstnId><Othr><Id>x</Id></Othr></FinInstnId></IntrmyAgt2><IntrmyAgt3><FinInstnId><BIC>INTCSGSG</BIC></FinInstnId></IntrmyAgt3>`))],
  ['charges as stated', pacs(tx(`${ID}${AMT}${PARTIES}<ChrgsInf><Amt Ccy="USD">10.00</Amt><Agt><FinInstnId><BICFI>DEMOSGSG</BICFI></FinInstnId></Agt></ChrgsInf><ChrgsInf><Amt> 5 </Amt></ChrgsInf><ChrgsInf><Agt><FinInstnId><BIC>OLDBSGSG</BIC></FinInstnId></Agt></ChrgsInf><ChrgsInf></ChrgsInf><ChrgsInf><Amt Ccy=" EUR ">  </Amt></ChrgsInf>`))],
  ['regulatory reporting, old and new forms', pacs(tx(`${ID}${AMT}${PARTIES}<RgltryRptg><Dtls><Tp>CRED</Tp><Cd>123</Cd><Ctry>VN</Ctry><Inf>goods</Inf><Inf> </Inf><Inf>more</Inf></Dtls><Dtls><Tp><Cd>DEBT</Cd></Tp><RptgCd>456</RptgCd></Dtls><Dtls><Tp> <Prtry>OWN</Prtry> </Tp></Dtls><Dtls></Dtls></RgltryRptg><RgltryRptg><Dtls><Inf>second</Inf></Dtls></RgltryRptg>`))],
  ['remittance: typed, untyped, other documents, references, words', pacs(tx(`${ID}${AMT}${PARTIES}<RmtInf><Ustrd>/INV/INV-3//INV-4/RFB/X</Ustrd><Ustrd>  </Ustrd><Ustrd>/ROC/R1/INV/INV-1</Ustrd><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>PUOR</Cd></CdOrPrtry></Tp><Nb>PO-88812</Nb></RfrdDocInf><RfrdDocInf><Nb>UNTYPED-1</Nb></RfrdDocInf><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>INV-1</Nb></RfrdDocInf><RfrdDocInf><Tp><CdOrPrtry><Prtry>SOMETHING</Prtry></CdOrPrtry></Tp><Nb>S-1</Nb></RfrdDocInf><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp></RfrdDocInf><CdtrRefInf><Ref>RF18539007547034</Ref></CdtrRefInf><AddtlRmtInf>first</AddtlRmtInf><AddtlRmtInf> </AddtlRmtInf></Strd><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CREN</Cd></CdOrPrtry></Tp><Nb>CN-1</Nb></RfrdDocInf><RfrdDocInf><Tp><CdOrPrtry><Cd>SBIN</Cd></CdOrPrtry></Tp><Nb>SB-1</Nb></RfrdDocInf></Strd></RmtInf>`))],
  ['dates: the transaction, else the header', pacs(basic('<IntrBkSttlmDt>2026-11-18</IntrBkSttlmDt>') + basic() + basic('<IntrBkSttlmDt>18/11/2026</IntrBkSttlmDt>'), `${HDR.slice(0, -9)}<IntrBkSttlmDt><Dt>2026-11-17</Dt></IntrBkSttlmDt></GrpHdr>`)],
  ['dates as a date-time', pacs(basic('<IntrBkSttlmDt><DtTm>2026-11-19T10:00:00</DtTm></IntrBkSttlmDt>'))],
  ['instructed beside settled, rate, purpose, charge bearer', pacs(tx(`${ID}<IntrBkSttlmAmt Ccy="EUR">90.5</IntrBkSttlmAmt><InstdAmt Ccy="USD">0100.10</InstdAmt><XchgRate>0.9</XchgRate><ChrgBr> CRED </ChrgBr>${PARTIES}<Purp><Prtry>SALARY</Prtry></Purp>`) + tx(`<PmtId><TxId>T2</TxId><UETR>11111111-2222-4333-8444-555555555555</UETR></PmtId><InstdAmt Ccy="USD">1</InstdAmt><ChrgBr>SLEV</ChrgBr>${PARTIES}<Purp><Cd>GDDS</Cd><Prtry>x</Prtry></Purp>`))],
  // I10: a charge bearer outside the code list refuses the message
  ['a charge bearer of the MT vocabulary is refused', pacs(basic('<ChrgBr>OUR</ChrgBr>'))],
  ['a charge bearer in lower case is refused', pacs(basic() + basic('<ChrgBr>shar</ChrgBr>'))],
  ['an empty charge bearer states none', pacs(basic('<ChrgBr/>') + basic('<ChrgBr>  </ChrgBr>'))],
  ['two faults: the remittance is read before the charge bearer', pacs(basic('<ChrgBr>X</ChrgBr><RmtInf/><RmtInf/>'))],
  ['two faults: the charge bearer before an intermediary', pacs(basic('<ChrgBr>X</ChrgBr><IntrmyAgt1/><IntrmyAgt1/>'))],
  ['two faults: the charge bearer after the creditor', pacs(tx(`${ID}${AMT}<Dbtr><Nm>A</Nm></Dbtr><ChrgBr>X</ChrgBr>`))],
  ['pain.001: a bad charge bearer in a block without transactions is not read', pain(block('<ChrgBr>XXX</ChrgBr>', '') + block('<Dbtr><Nm>A</Nm></Dbtr><ChrgBr>SHAR</ChrgBr>', PTX))],
  ['pain.001: a bad charge bearer of the block refuses before any transaction', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Cdtr><Nm>B</Nm></Cdtr>')) + block('<Dbtr><Nm>A</Nm></Dbtr><ChrgBr>SHA</ChrgBr>', PTX))],
  ['pain.001: the transaction\'s charge bearer overrides the block\'s', pain(block('<Dbtr><Nm>A</Nm></Dbtr><ChrgBr>SHAR</ChrgBr>',
    PTX + ptx('<PmtId><EndToEndId>E2</EndToEndId></PmtId><Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><ChrgBr>CRED</ChrgBr><Cdtr><Nm>B</Nm></Cdtr>')))],
  ['pain.001: a bad charge bearer in the second transaction', pain(block('<Dbtr><Nm>A</Nm></Dbtr><ChrgBr>SHAR</ChrgBr>',
    PTX + ptx('<PmtId><EndToEndId>E2</EndToEndId></PmtId><Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><ChrgBr>BEN</ChrgBr><Cdtr><Nm>B</Nm></Cdtr>')))],
  // I9: an XML amount is an xs:decimal — no comma, whichever side of it the digits stand
  ['a decimal comma in an instructed amount is refused', pacs(tx(`${ID}${AMT}<InstdAmt Ccy="USD">12,5</InstdAmt>${PARTIES}`))],
  ['pain.001: a comma in an equivalent amount is refused', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Amt><EqvtAmt><Amt Ccy="EUR">9,50</Amt><CcyOfTrf>USD</CcyOfTrf></EqvtAmt></Amt><Cdtr><Nm>B</Nm></Cdtr>')))],
  ['no group header', pacs(basic(), '')],
  ['the type is the family when the namespace names another one', pacs(basic(), HDR, NS1)],
  ['a newer version', pacs(basic(), HDR, 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.12')],
  ['a namespace that is not an ISO one', pacs(basic(), HDR, 'urn:example:pacs.008.001.08')],
  ['a namespace with a line feed after it', pacs(basic(), HDR, 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08&#10;')],
  ['a bare body inside a wrapper, with its own namespace', `<Wrapper><p:FIToFICstmrCdtTrf xmlns:p="${NS8}">${HDR.replace(/<(\/?)/g, '<$1p:')}${basic().replace(/<(\/?)/g, '<$1p:')}</p:FIToFICstmrCdtTrf><CstmrCdtTrfInitn>${block('<Dbtr><Nm>A</Nm></Dbtr>', PTX)}</CstmrCdtTrfInitn></Wrapper>`],
  ['a batch of several documents', `<Batch>${bareDoc}${painSample}${pacs(basic() + basic())}</Batch>`],
  ['a document of another kind in a batch', `<Batch>${pacs(basic())}<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"><FICdtTrf/></Document></Batch>`],
  ['a document holding something else', `<Batch>${pacs(basic())}<Document><Something/></Document></Batch>`],
  ['an empty document', '<Document xmlns="urn:x"/>'],
  ['a document in an envelope, nested inside another document', `<Env><Document><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf><Document><Other/></Document></Document></Env>`],
  // I3: messages inside and outside a Document in one file
  ['a Document inside a bare message', `<FIToFICstmrCdtTrf>${HDR}${basic()}${pacs(basic())}</FIToFICstmrCdtTrf>`],
  ['a message inside a bare message is not a second one', `<FIToFICstmrCdtTrf>${HDR}${basic()}<CstmrCdtTrfInitn>${block('<Dbtr><Nm>A</Nm></Dbtr>', PTX)}</CstmrCdtTrfInitn></FIToFICstmrCdtTrf>`],
  ['two bare messages of both families', `<Batch><CstmrCdtTrfInitn>${block('<Dbtr><Nm>A</Nm></Dbtr>', PTX)}</CstmrCdtTrfInitn><Inner><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf></Inner></Batch>`],
  ['the first bare message is the one named', `<Batch><CstmrCdtTrfInitn>${block('<Dbtr><Nm>A</Nm></Dbtr>', PTX)}</CstmrCdtTrfInitn>${pacs(basic())}<FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf></Batch>`],
  ['a bare message beside a document of another kind', `<Batch><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt/></Document></Batch>`],
  // I4: one message per Document
  ['three messages in the second of two documents', `<B>${pacs(basic())}<Document xmlns="${NS8}"><FIToFICstmrCdtTrf/><CstmrCdtTrfInitn/><FIToFICstmrCdtTrf/></Document></B>`],
  ['a second message of another namespace in one document', `<Document xmlns="${NS8}"><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf><x:CstmrCdtTrfInitn xmlns:x="urn:x"/></Document>`],
  ['two messages in a document refuse before a field of the first', `<B>${pacs(tx(`${ID}${PARTIES}`))}<Document><FIToFICstmrCdtTrf/><FIToFICstmrCdtTrf/></Document></B>`],
  // I5: what else a Document holds, and what a Document without a message is
  ['an element of another namespace after the message', `<Document xmlns="${NS8}"><FIToFICstmrCdtTrf>${HDR}${basic()}</FIToFICstmrCdtTrf><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></Document>`],
  ['an element before the message, in the second document', `<B>${pacs(basic())}${pacs(basic()).replace('<FIToFICstmrCdtTrf>', '<AppHdr/><FIToFICstmrCdtTrf>')}</B>`],
  ['text and comments beside the message are not elements', `<Document xmlns="${NS8}"> text <!-- c --><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf> </Document>`],
  ['the second document declares pain.001 and holds nothing', `<B>${pacs(basic())}<Document xmlns="${NS1}"/></B>`],
  ['a document declaring pain.001 holds a pacs.008 element of another name', `<Document xmlns="${NS1}"><FIToFICstmrCdtTrfX/></Document>`],
  ['a document of another ISO kind holding nothing', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"/>'],
  ['a document with no namespace holding nothing', '<Document/>'],
  ['a document with no namespace holding an element', '<Document><Something/><Other/></Document>'],
  ['the root declares another message', '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt/></Document>'],
  ['a root that declares another message, without a Document', '<BkToCstmrStmt xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"/>'],
  ['an HTML page', '<html><body>hello</body></html>'],
  ['no transaction', pacs('')],
  ['no amount', pacs(tx(`${ID}${PARTIES}`))],
  ['no debtor', pacs(tx(`${ID}${AMT}<Cdtr><Nm>B</Nm></Cdtr>`))],
  ['no creditor in the second transaction', pacs(basic() + tx(`${ID}${AMT}<Dbtr><Nm>A</Nm></Dbtr>`))],
  ['no currency', pacs(tx(`${ID}<IntrBkSttlmAmt>1</IntrBkSttlmAmt>${PARTIES}`))],
  ['a lower-case currency', pacs(tx(`${ID}<IntrBkSttlmAmt Ccy="usd">1</IntrBkSttlmAmt>${PARTIES}`))],
  ['a currency with spaces', pacs(tx(`${ID}<IntrBkSttlmAmt Ccy=" USD">1</IntrBkSttlmAmt>${PARTIES}`))],
  ['not an amount', pacs(tx(`${ID}<IntrBkSttlmAmt Ccy="USD">1,000.00</IntrBkSttlmAmt>${PARTIES}`))],
  ['an instructed amount that is not one, beside a good settled one', pacs(tx(`${ID}${AMT}<InstdAmt Ccy="USD">-1</InstdAmt>${PARTIES}`))],
  ['a UETR that is not a UUID, in upper case', pacs(tx(`<PmtId><UETR> NOT-A-UUID-AT-ALL-${'X'.repeat(40)} </UETR></PmtId>${AMT}${PARTIES}`))],
  ['a UETR in upper case', pacs(tx(`<PmtId><UETR>3F1C9A52-7B0E-4D6A-9C1F-2E8B5A7D4C10</UETR></PmtId>${AMT}${PARTIES}`))],
  // the order of checks: two faults, the reference reports one of them
  ['two faults: a duplicate header element before a missing transaction', pacs('', '<GrpHdr><MsgId>1</MsgId><MsgId>2</MsgId></GrpHdr>')],
  ['two faults: two group headers', pacs(tx(`${ID}${PARTIES}`), HDR + HDR)],
  ['two faults: a bad currency before a duplicate debtor', pacs(tx(`${ID}<IntrBkSttlmAmt Ccy="X">1</IntrBkSttlmAmt><Dbtr><Nm>A</Nm></Dbtr><Dbtr><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['two faults: a settled amount is read before the instructed one', pacs(tx(`${ID}<InstdAmt Ccy="usd">1</InstdAmt><IntrBkSttlmAmt Ccy="USD">x</IntrBkSttlmAmt>${PARTIES}`))],
  ['two faults: a duplicate name before a duplicate address', pacs(tx(`${ID}${AMT}<Dbtr><PstlAdr/><PstlAdr/><Nm>A</Nm><Nm>A</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['two faults: street before town before the care-of line', pacs(tx(`${ID}${AMT}<Dbtr><PstlAdr><CareOf>1</CareOf><CareOf>2</CareOf><TwnNm>1</TwnNm><TwnNm>2</TwnNm><BldgNb>1</BldgNb><BldgNb>2</BldgNb></PstlAdr></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['two faults: an invalid UETR before a duplicate agent', pacs(tx(`<PmtId><UETR>nope</UETR></PmtId>${AMT}${PARTIES}<CdtrAgt/><CdtrAgt/>`))],
  ['two faults: a duplicate intermediary before a duplicate charge amount', pacs(tx(`${ID}${AMT}${PARTIES}<ChrgsInf><Amt/><Amt/></ChrgsInf><IntrmyAgt2/><IntrmyAgt2/>`))],
  ['two faults: charges before regulatory reporting', pacs(tx(`${ID}${AMT}${PARTIES}<RgltryRptg><Dtls><Tp/><Tp/></Dtls></RgltryRptg><ChrgsInf><Amt/><Amt/></ChrgsInf>`))],
  ['two faults: the account before the creditor', pacs(tx(`${ID}${AMT}<Dbtr><Nm>A</Nm></Dbtr><DbtrAcct><Id/><Id/></DbtrAcct>`))],
  ['two faults: the first document before the second', `<B>${pacs(tx(`${ID}${PARTIES}`))}${pacs('')}</B>`],
  ['a CtryOfRes twice is not read when the address states a country', pacs(tx(`${ID}${AMT}<Dbtr><PstlAdr><Ctry>VN</Ctry></PstlAdr><CtryOfRes>VN</CtryOfRes><CtryOfRes>SG</CtryOfRes></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['a CtryOfRes twice is refused when the address states none', pacs(tx(`${ID}${AMT}<Dbtr><PstlAdr><Ctry>Vietnam</Ctry></PstlAdr><CtryOfRes>VN</CtryOfRes><CtryOfRes>SG</CtryOfRes></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['a second BIC is not read once AnyBIC is there', pacs(tx(`${ID}${AMT}<Dbtr><Id><OrgId><AnyBIC>AAAAVNVX</AnyBIC><BIC>1</BIC><BIC>2</BIC></OrgId></Id></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  ['a duplicate element of another namespace is not read', pacs(tx(`${ID}${AMT}<Dbtr xmlns:e="urn:e"><Nm>A</Nm><e:Nm>X</e:Nm><e:Nm>Y</e:Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`))],
  // pain.001
  ['pain.001: the block states the debtor, the transaction the rest', pain(block('<PmtInfId>P1</PmtInfId><PmtMtd>TRF</PmtMtd><ReqdExctnDt><Dt>2026-11-20</Dt></ReqdExctnDt><Dbtr><Nm>A</Nm><PstlAdr><Ctry>VN</Ctry><AdrLine>x</AdrLine></PstlAdr></Dbtr><DbtrAcct><Id><IBAN>VN1</IBAN></Id></DbtrAcct><DbtrAgt><FinInstnId><BICFI>DEMOVNVX</BICFI></FinInstnId></DbtrAgt><ChrgBr>SHAR</ChrgBr>',
    ptx('<PmtId><InstrId>I1</InstrId><EndToEndId>E1</EndToEndId><UETR>11111111-2222-4333-8444-555555555555</UETR></PmtId><Amt><InstdAmt Ccy="USD">10.00</InstdAmt></Amt><XchgRateInf><XchgRate>1.1</XchgRate></XchgRateInf><ChrgBr>DEBT</ChrgBr><IntrmyAgt1><FinInstnId><BICFI>INTAUS33</BICFI></FinInstnId></IntrmyAgt1><CdtrAgt><FinInstnId><BICFI>DEMOSGSG</BICFI></FinInstnId></CdtrAgt><Cdtr><Nm>B</Nm></Cdtr><CdtrAcct><Id><Othr><Id>SG1</Id></Othr></Id></CdtrAcct><Purp><Cd>SUPP</Cd></Purp><RgltryRptg><Dtls><Inf>x</Inf></Dtls></RgltryRptg><RmtInf><Ustrd>/INV/A1</Ustrd></RmtInf><ChrgsInf><Amt Ccy="USD">1</Amt></ChrgsInf>')
    + ptx('<PmtId><EndToEndId>E2</EndToEndId></PmtId><Amt><EqvtAmt><Amt Ccy="EUR">9.5</Amt><CcyOfTrf>USD</CcyOfTrf></EqvtAmt></Amt><Cdtr><Nm>C</Nm></Cdtr>')))],
  ['pain.001: an empty block is passed over, a plain requested date', pain(block('<PmtInfId>EMPTY</PmtInfId>', '') + block('<PmtInfId>P2</PmtInfId><ReqdExctnDt>2026-11-21</ReqdExctnDt><Dbtr><Nm>A</Nm></Dbtr><ChrgBr>CRED</ChrgBr>', PTX + PTX))],
  ['pain.001: a date-time requested date, no header', pain(block('<ReqdExctnDt><DtTm>2026-11-22T08:00:00</DtTm></ReqdExctnDt><Dbtr><Nm>A</Nm></Dbtr>', PTX), '')],
  ['pain.001: a block without a debtor', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', PTX) + block('<PmtInfId>P2</PmtInfId>', PTX))],
  ['pain.001: a transaction id and charges are not read from a transaction', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<PmtId><InstrId>I</InstrId><EndToEndId>E</EndToEndId><TxId>T</TxId></PmtId><Amt><InstdAmt Ccy="USD">1</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr><ChrgsInf><Amt Ccy="USD">1</Amt></ChrgsInf><IntrBkSttlmAmt Ccy="USD">2</IntrBkSttlmAmt>')))],
  ['pain.001: no transaction anywhere', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', '') + block('', ''))],
  ['pain.001: no amount', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Amt><EqvtAmt><CcyOfTrf>USD</CcyOfTrf></EqvtAmt></Amt><Cdtr><Nm>B</Nm></Cdtr>')))],
  ['pain.001: a bad instructed amount', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Amt><InstdAmt Ccy="USD">ten</InstdAmt></Amt><Cdtr><Nm>B</Nm></Cdtr>')))],
  ['pain.001: no creditor', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Amt><InstdAmt Ccy="USD">1</InstdAmt></Amt>')))],
  ['pain.001: two faults — every block is read before any transaction', pain(block('<Dbtr><Nm>A</Nm></Dbtr>', ptx('<Cdtr><Nm>B</Nm></Cdtr>')) + block('<Dbtr><Nm>A</Nm><Nm>B</Nm></Dbtr>', PTX))],
  ['pain.001: a block identification written twice is refused', pain(block('<PmtInfId>P</PmtInfId><Dbtr><Nm>A</Nm></Dbtr><PmtInfId>Q</PmtInfId>', PTX))],
  ['pain.001: the block\'s own names are present once, its transactions not among them', pain(block('<PmtMtd>TRF</PmtMtd><Dbtr><Nm>A</Nm></Dbtr><PmtMtd>CHK</PmtMtd><x:Ext xmlns:x="urn:x"/>', PTX + PTX))],
  ['pacs.008: names of another namespace are not present', pacs(tx(`<PmtId xmlns:x="urn:x"><x:Foo/><EndToEndId>E</EndToEndId><EndToEndId2/></PmtId>${AMT}${PARTIES}<x:Bar xmlns:x="urn:x"/><Dbtr2/>`))],
  // the test marker
  ['a pilot service in the envelope header', `<Envelope><Hdr><Service>swift.finplus!p</Service></Hdr>${bareDoc}</Envelope>`],
  ['a pilot service in capitals', `<Envelope><Service> swift.finplus!P </Service>${pacs(basic())}</Envelope>`],
  ['a service that is not a pilot one', `<Envelope><Service>swift.finplus</Service><Service>x!px</Service>${pacs(basic())}</Envelope>`],
  ['a test and training BIC in the header', `<Envelope><AppHdr><Fr><FIId><FinInstnId><BICFI>DEMOVNV0XXX</BICFI></FinInstnId></FIId></Fr></AppHdr>${pacs(basic())}</Envelope>`],
  ['a test BIC inside the document is not a marker', pacs(basic('<DbtrAgt><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></DbtrAgt>'))],
  ['a test BIC in a bare body is reported by its path', `<FIToFICstmrCdtTrf>${basic('<DbtrAgt><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></DbtrAgt>')}</FIToFICstmrCdtTrf>`],
  ['the first marker wins', `<Envelope><AppHdr><BICFI>AAAAVNV0</BICFI></AppHdr><Service>a!p</Service>${pacs(basic())}</Envelope>`],
  // I6: where a test BIC outside a header is reported
  ['a test BIC in an envelope element outside the header', `<Envelope><Routing><To><BICFI>DEMOVNV0</BICFI></To></Routing>${pacs(basic())}</Envelope>`],
  ['a test BIC in the instructing agent of a bare body', `<FIToFICstmrCdtTrf><GrpHdr><MsgId>M1</MsgId><InstgAgt><FinInstnId><BICFI>DEMOVNV0XXX</BICFI></FinInstnId></InstgAgt></GrpHdr>${basic()}</FIToFICstmrCdtTrf>`],
  ['a prefixed bare body: the path is of local names', `<w:Wrap xmlns:w="urn:w"><p:FIToFICstmrCdtTrf xmlns:p="${NS8}">${basic('<DbtrAgt><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></DbtrAgt>').replace(/<(\/?)/g, '<$1p:')}</p:FIToFICstmrCdtTrf></w:Wrap>`],
  ['a bare body inside an element named AppHdr is the header\'s', `<Envelope><AppHdr><FIToFICstmrCdtTrf>${basic('<CdtrAgt><FinInstnId><BICFI>DEMOSGS0</BICFI></FinInstnId></CdtrAgt>')}</FIToFICstmrCdtTrf></AppHdr></Envelope>`],
  ['the path is the first test BIC\'s, in document order', `<Envelope><A><BICFI>AAAAVNVX</BICFI><B><BICFI>BBBBVNV0</BICFI></B></A><C><BICFI>CCCCVNV0</BICFI></C>${pacs(basic())}</Envelope>`],
  // I7: an agent identified by another scheme
  ['an agent identified only by Othr, with a scheme code', pacs(basic('<DbtrAgt><FinInstnId><Othr><Id> DA-1 </Id><SchmeNm><Cd>NCCC</Cd><Prtry>ignored</Prtry></SchmeNm></Othr></FinInstnId></DbtrAgt><CdtrAgt><FinInstnId><Othr><Id>CA-1</Id><SchmeNm><Prtry>BANKCODE</Prtry></SchmeNm></Othr><Nm>Payout</Nm></FinInstnId></CdtrAgt>'))],
  ['an Othr id does not take the clearing system of a member id it lacks', pacs(basic('<CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId></ClrSysMmbId><Othr><Id>X-1</Id></Othr></FinInstnId></CdtrAgt>'))],
  ['a clearing system alone is still read', pacs(basic('<CdtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Prtry>SGIBG</Prtry></ClrSysId></ClrSysMmbId></FinInstnId></CdtrAgt>'))],
  ['a member id beside Othr: the member and its own clearing system', pacs(basic('<CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>7171</MmbId></ClrSysMmbId><Othr><Id>X-1</Id><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr></FinInstnId></CdtrAgt>'))],
  ['an Othr without an Id is no identification', pacs(basic('<IntrmyAgt1><FinInstnId><Othr><SchmeNm><Cd>NCCC</Cd></SchmeNm></Othr></FinInstnId></IntrmyAgt1>'))],
  ['two Othr where the agent is identified by Othr are refused', pacs(basic('<IntrmyAgt1><FinInstnId><Othr><Id>A</Id></Othr><Othr><Id>B</Id></Othr></FinInstnId></IntrmyAgt1>'))],
  ['two Othr beside a member id are not read', pacs(basic('<IntrmyAgt1><FinInstnId><ClrSysMmbId><MmbId>1</MmbId></ClrSysMmbId><Othr><Id>A</Id></Othr><Othr><Id>B</Id></Othr></FinInstnId></IntrmyAgt1>'))],
  ['two scheme names of an Othr id are refused', pacs(basic('<IntrmyAgt1><FinInstnId><Othr><Id>A</Id><SchmeNm><Cd>X</Cd></SchmeNm><SchmeNm><Cd>Y</Cd></SchmeNm></Othr></FinInstnId></IntrmyAgt1>'))],
  ['pain.001: a debtor agent identified only by Othr', pain(block('<Dbtr><Nm>A</Nm></Dbtr><DbtrAgt><FinInstnId><Othr><Id>DBTR-BANK-9</Id><SchmeNm><Prtry>LOCAL</Prtry></SchmeNm></Othr></FinInstnId></DbtrAgt>', PTX))],
  // XML refusals as the message reader words them
  ['the same element twice where one is expected', pacsSample.replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Pacific Supply Pte Ltd</Nm><Nm>Another Name</Nm>')],
  ['an instructed amount twice', pacsSample.replace('<InstdAmt Ccy="USD">12500.00</InstdAmt>', '<InstdAmt Ccy="USD">12500.00</InstdAmt><InstdAmt Ccy="USD">1.00</InstdAmt>')],
  ['a UETR twice', pacsSample.replace('<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR>', '<UETR>3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10</UETR><UETR>11111111-2222-4333-8444-555555555555</UETR>')],
  ['a name from another vocabulary is not the name', pacsSample.replace('<Cdtr>', '<Cdtr xmlns:e="urn:evil"><e:Nm>Injected Name</e:Nm>')],
  ['a currency from another vocabulary is not the currency', pacsSample.replace('<InstdAmt Ccy="USD">', '<InstdAmt xmlns:x="urn:x" Ccy="USD" x:Ccy="EUR">')],
  ['a message that is not well formed', `${pacs(basic())}<x>`],
  ['a doctype before the document', `<!DOCTYPE x>${pacs(basic())}`],
  ['a string with a byte-order mark', `﻿${pacs(basic()).replace('<Nm>A</Nm>', '<Nm>&amp;A</Nm>')}`],
  // names Object.prototype answers for: entities that are not defined, elements that are not messages (X1, I1)
  ['an entity named after Object.prototype is refused', pacs(tx(`${ID}${AMT}<Dbtr><Nm>&valueOf;</Nm></Dbtr><Cdtr><Nm>&__proto__;</Nm></Cdtr>`))],
  ['a document whose body is named toString, with a namespace', `<Document xmlns="${NS8}"><toString/></Document>`],
  ['a root named __proto__', '<__proto__/>'],
  ['an element named valueOf in a wrapper beside a bare message', `<B><valueOf/><FIToFICstmrCdtTrf>${basic()}</FIToFICstmrCdtTrf></B>`],
  ['an attribute named __proto__ on an amount', pacs(tx(`${ID}<IntrBkSttlmAmt __proto__="EUR" Ccy="USD">1</IntrBkSttlmAmt>${PARTIES}`))],
  ['a document whose body is named constructor', '<Document><constructor/></Document>'],
  ['a document whose body is named __proto__', `<Document xmlns="${NS8}"><__proto__/></Document>`],
  ['a bare element named toString', '<html><toString/></html>'],
  ['a good document, then one whose body is named hasOwnProperty', `<B>${pacs(basic())}<Document><hasOwnProperty/></Document></B>`],
  ['a refused document, then one whose body is named valueOf', `<B>${pacs('')}<Document><valueOf/></Document></B>`],
  ['an element named constructor beside a Document is not looked at', `<B><constructor/>${pacs(basic())}</B>`],
];

// ── invoiceTokens and xmlEscape ─────────────────────────────────────────────
const tokens: string[] = ['/INV/\nABC', '/INV//INV/X', '/INV/A/INV/B', '/INV/A//B/', '/INV/A//B//', '/INV/', '/INV/ ', '/INV/x',
  'x/INV/A/RFB/B/INV/C\nD/INV/E', '/INV/A\r\nB', '/INV/A B', '/INV/A//B\u0085', '/INV/ / ', '/INV/A/ROC/', '/INV/\u{1F600}/TSU/x',
  '/INV/a/b/c/IPI/', '/INV//RFB/x', '/INV/A /  ', '/inv/A', '/INV/A/INVX/B', '/INV/A/IN', 'INV/A', '/INV/A/RFB/', '/INV/A\n/INV/B\n',
  '/INV/A\rB', '/INV/A\u0085B', '/INV/A\u2029B//C', '/INV/\rA',
  // the follow-up: an empty code word carries no reference
  '/INV//ROC/PO-7811', '/INV/INV-1//INV-2/ROC/PO-7811', '/INV//INV//INV/', '/INV/\n/INV/A', '/INV/ /ROC/X', '/INV//IPI//INV/B', 'x/INV/'];
const escapes: string[] = ['plain', '<a href="x">R&D\'s</a>', 'tab\tline\nreturn\r', 'nul\u0000bell\u0007vt\u000Bff\u000Cso\u000Eus\u001F', 'del\u007F nbsp ',
  'nonchar￾￿', 'lone\uD800surrogate', 'pair😀', '&amp;',
  // a half surrogate is dropped, a pair is kept
  'high\uD800\uD83D\uDE00pair', 'low\uDE00\uD83Dhigh', 'x\uD800\u0001\uDC00y', 'end\uD83D', '\uDC00start', '\uDBFF\uDFFF', '<\uD800&\uDC00>'];

// ── Bytes: how a file becomes text (parse.ts) ───────────────────────────────
const latin = (s: string): Buffer => Buffer.from(s, 'latin1');
const XML_HEAD = (decl: string): string => `<?xml version="1.0"${decl}?>\n`;
const NAMED = (name: string): string => pacs(tx(`${ID}${AMT}<Dbtr><Nm>${name}</Nm></Dbtr><Cdtr><Nm>B</Nm></Cdtr>`));
const withBytes = (decl: string, raw: number[]): Buffer => {
  const [a, b] = (XML_HEAD(decl) + NAMED('Co @ Ltd')).split('@');
  return Buffer.concat([latin(a!), Buffer.from(raw), latin(b!)]);
};
const high = Array.from({ length: 0x80 }, (_, i) => 0x80 + i);
const bytes: [string, Buffer][] = [
  // P3: the declaration, matched as the reference matches it
  ['a label in single quotes', withBytes(' encoding=\'latin1\'', [0xe9])],
  ['a label written in mixed case', withBytes(' encoding="Iso-8859-1"', [0xe9])],
  ['standalone before the encoding', withBytes(' standalone="yes" encoding="latin1"', [0xe9])],
  ['"encoding" inside another word is not the declaration', withBytes(' x="myencoding=\'utf-7\'" encoding="latin1"', [0xe9])],
  ['the first "encoding" word is the one read', withBytes(' x="1 encoding=\'utf-7\'" encoding="latin1"', [0xe9])],
  ['a vertical tab around the label is not trimmed', withBytes(' encoding="\u000Blatin1"', [0xe9])],
  ['a no-break space around the label is not trimmed', withBytes(' encoding="latin1\u00A0"', [0xe9])],
  ['a form feed around the label is trimmed (the label is read; the character is then not XML)', withBytes(' encoding="\flatin1"', [0xe9])],
  ['a tab, a line feed, a carriage return and a space around the label are trimmed', withBytes(' encoding="\t\nlatin1\r "', [0xe9])],
  ['a label with a quote of the other kind inside', withBytes(' encoding="lat\'in1"', [0xe9])],
  ['spaces around "="', withBytes(' encoding \t=\n "latin1"', [0xe9])],
  ['a label that ends beyond the first 200 bytes is not seen', withBytes(` x="${'y'.repeat(180)}" encoding="latin1"`, [0xe9])],
  ['a label that ends beyond the first 200 bytes, in UTF-8', withBytes(` x="${'y'.repeat(180)}" encoding="latin1"`, [0xc3, 0xa9])],
  ['no declaration, UTF-8', Buffer.from(NAMED('Co é Ltd'), 'utf8')],
  ['a declaration without an encoding, UTF-8', Buffer.from(XML_HEAD('') + NAMED('Co é Ltd'), 'utf8')],
  ['windows-1252: the unassigned bytes stay', withBytes(' encoding="windows-1252"', [0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x80, 0x9f])],
  ['ISO-8859-1 is not windows-1252', withBytes(' encoding="ISO-8859-1"', [0x80, 0x93, 0x94])],
  ['US-ASCII names the label as written, trimmed', withBytes(' encoding=" Us-Ascii "', [0x41, 0x80])],
  ['US-ASCII with only ASCII', withBytes(' encoding="ascii"', [0x41, 0x7f])],
  ['an unknown label is quoted as written', withBytes(' encoding=" EUC-KR "', [0x41])],
  ['UTF-16LE declared over single bytes', withBytes(' encoding="UTF-16LE"', [0x41])],
  ['utf-16be declared over single bytes', withBytes(' encoding="utf-16be"', [0x41, 0x42])],
  ['a UTF-8 label other than "utf-8" names UTF-8 when the bytes are not', withBytes(' encoding="unicode-1-1-utf-8"', [0xe9])],
  ['a UTF-8 byte-order mark, then a declaration of latin1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withBytes(' encoding="latin1"', [0xe9])])],
  ['a UTF-8 byte-order mark, then UTF-8', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withBytes(' encoding="UTF-8"', [0xc3, 0xa9])])],
  ['windows-1252, every byte from 0x80', withBytes(' encoding="cp1252"', high)],
  // UTF-16 as the reference's strict decoder reads it: U+FFFE is a character, a half surrogate is not
  ['UTF-16 may hold U+FFFE: read, then refused as XML', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NAMED('Co ￾ Ltd'), 'utf16le')])],
  ['a big-endian byte-order mark, then U+FFFE', Buffer.concat([Buffer.from([0xfe, 0xff, 0xff, 0xfe]), Buffer.from(NAMED('A'), 'utf16le')])],
  ['UTF-16 with a pair reads', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(NAMED('Co 😀 Ltd'), 'utf16le')])],
  ['UTF-16 big-endian with a pair reads', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(NAMED('Co 😀 Ltd'), 'utf16le').swap16()])],
  ['UTF-16 with a lone low surrogate is refused', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a>', 'utf16le'), Buffer.from([0x00, 0xdc]), Buffer.from('</a>', 'utf16le')])],
  ['UTF-16 with two high surrogates is refused', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a>', 'utf16le'), Buffer.from([0x3d, 0xd8, 0x3d, 0xd8, 0x00, 0xde]), Buffer.from('</a>', 'utf16le')])],
  ['UTF-16 ending in a high surrogate is refused', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a/>', 'utf16le'), Buffer.from([0x3d, 0xd8])])],
  ['UTF-16 with an odd number of bytes is refused', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('<a/>', 'utf16le').swap16(), Buffer.from([0x20])])],
  ['a lone byte-order mark of UTF-16', Buffer.from([0xff, 0xfe])],
  ['declared UTF-16 over single bytes that hold U+FFFE', ((): Buffer => {
    const [a, b] = (XML_HEAD(' encoding="utf-16le"') + NAMED('@')).split('@');
    const pad = a!.length % 2 === 0 ? '' : ' ';
    return Buffer.concat([latin(a! + pad), Buffer.from([0xfe, 0xff]), latin(b!)]);
  })()],
  // P1: XML is never read in a guessed code page
  ['latin1 bytes after a vertical tab', Buffer.concat([Buffer.from([0x0b]), withBytes(' encoding="UTF-8"', [0xe9])])],
  ['latin1 bytes after a form feed', Buffer.concat([Buffer.from([0x0c]), withBytes('', [0xe9])])],
  ['latin1 bytes after U+0085 are not XML', Buffer.concat([Buffer.from([0x85]), withBytes('', [0xe9])])],
  ['latin1 bytes after text are not XML', Buffer.concat([latin('x'), withBytes('', [0xe9])])],
  ['a no-break space in UTF-8 before XML in UTF-8', Buffer.concat([Buffer.from([0xc2, 0xa0]), Buffer.from(NAMED('Co é Ltd'), 'utf8')])],
  ['a lone byte-order mark', Buffer.from([0xef, 0xbb, 0xbf])],
];

// ── Strings measured in UTF-8 bytes (P2): prefix + unit × times ──────────────
const repeated: [string, string, string, number][] = [
  ['é at the bound in bytes', '', 'é', 2_097_152],
  ['é one byte over', '', 'é', 2_097_153],
  ['astral characters at the bound', '', '😀', 1_048_576],
  ['astral characters over the bound', '', '😀', 1_048_577],
  ['lone surrogates count three bytes each, over', '', '\uD800', 1_398_102],
  ['lone surrogates count three bytes each, under', '<a>', '\uD800', 1_398_100],
  ['units over the bound', '', 'a', 4 * 1024 * 1024 + 1],
];

// ── Java source ────────────────────────────────────────────────────────────
const javaString = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c >= 0x20 && c < 0x7f) out += ch;
    else out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
  }
  return out + '"';
};
const rows = (cases: [string, string, string][]): string => cases
  .map(([label, input, expected]) => `        {${javaString(label)},\n            ${javaString(input)},\n            ${javaString(expected)}},`)
  .join('\n');

const xmlRows = xml.map(([label, input]): [string, string, string] => [label, input, answer(() => ({ elements: elements(parseXml(input)) }))]);
const messageRows = messages.map(([label, input]): [string, string, string] => [label, input, answer(() => ({ payments: parseSwiftMessages(input) }))]);
const tokenRows = tokens.map((t): [string, string, string] => [t, t, answer(() => ({ tokens: invoiceTokens(t) }))]);
const escapeRows = escapes.map((t): [string, string, string] => [t, t, answer(() => ({ escaped: xmlEscape(t) }))]);
const byteRows = bytes.map(([label, b]): [string, string, string] => [label, b.toString('base64'), answer(() => ({ payments: parseSwiftMessages(b) }))]);
const repeatedRows = repeated.map(([label, prefix, unit, times]): string => {
  const expected = answer(() => ({ payments: parseSwiftMessages(prefix + unit.repeat(times)) }));
  return `        {${javaString(label)}, ${javaString(prefix)}, ${javaString(unit)}, "${times}",\n            ${javaString(expected)}},`;
}).join('\n');

process.stdout.write(`package com.stonehash.attest.remit.swift;

/**
 * What the TypeScript reference answers for the probe inputs of the ISO 20022
 * tests — written by {@code probe/answers.ts}, which runs the reference on
 * each input; nothing here is written by hand. A row is
 * {@code {label, input, answer as JSON}}.
 */
final class Iso20022Answers {
    private Iso20022Answers() {
    }

    /** {@code parseXml(input)} → {@code {"elements": [{depth, name, ns, attrs, text} in document order]}} or {@code {"error": …}}. */
    static final String[][] XML = {
${rows(xmlRows)}
    };

    /** {@code parseSwiftMessages(input)} for a string → {@code {"payments": […]}} or {@code {"error": …}}. */
    static final String[][] MESSAGES = {
${rows(messageRows)}
    };

    /** {@code invoiceTokens(input)} → {@code {"tokens": […]}}. */
    static final String[][] TOKENS = {
${rows(tokenRows)}
    };

    /** {@code xmlEscape(input)} → {@code {"escaped": "…"}}. */
    static final String[][] ESCAPES = {
${rows(escapeRows)}
    };

    /** {@code parseSwiftMessages(bytes)}, the bytes written in base64 → {@code {"payments": […]}} or {@code {"error": …}}. */
    static final String[][] BYTES = {
${rows(byteRows)}
    };

    /** {@code parseSwiftMessages(prefix + unit.repeat(times))} for a string → {@code {label, prefix, unit, times, answer}}. */
    static final String[][] REPEATED = {
${repeatedRows}
    };
}
`);
