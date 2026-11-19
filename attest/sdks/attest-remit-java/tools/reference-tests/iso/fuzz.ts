/**
 * Differential fuzzing of the Java ISO 20022 reader against the reference.
 *
 *   node probe/fuzz.ts gen <n> <seed> <inputs.json> <expected.json>   — mutate seeds, record the reference's answers
 *   node probe/fuzz.ts cmp <inputs.json> <expected.json> <actual.json> — compare with what the Java driver wrote
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseXml } from '../../../../../packages/attest-remit/src/swift/xml.ts';
import type { XmlElement } from '../../../../../packages/attest-remit/src/swift/xml.ts';
import { invoiceTokens } from '../../../../../packages/attest-remit/src/swift/iso20022.ts';
import { parseSwiftMessages } from '../../../../../packages/attest-remit/src/index.ts';

const SAMPLES = fileURLToPath(new URL('../../../../../packages/attest-remit/samples/', import.meta.url));
const seeds = ['pacs008.sample.xml', 'pacs008.envelope.sample.xml', 'pain001.sample.xml'].map((f) => readFileSync(SAMPLES + f, 'utf8'));
seeds.push(
  `<Envelope><AppHdr><Fr><FIId><FinInstnId><BICFI>DEMOVNV0</BICFI></FinInstnId></FIId></Fr></AppHdr><Service>x!p</Service><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn><GrpHdr><MsgId>M</MsgId></GrpHdr><PmtInf><PmtInfId>P</PmtInfId><ReqdExctnDt>2026-11-20</ReqdExctnDt><Dbtr><Nm>A</Nm><PstlAdr><StrtNm>S</StrtNm><BldgNb>1</BldgNb><PstCd>9</PstCd><TwnNm>T</TwnNm><Ctry>VN</Ctry></PstlAdr><Id><PrvtId><Othr><Id>X</Id><SchmeNm><Prtry>P</Prtry></SchmeNm></Othr></PrvtId></Id></Dbtr><DbtrAgt><FinInstnId><ClrSysMmbId><ClrSysId><Cd>USABA</Cd></ClrSysId><MmbId>1</MmbId></ClrSysMmbId></FinInstnId></DbtrAgt><ChrgBr>SHAR</ChrgBr><CdtTrfTxInf><PmtId><EndToEndId>E</EndToEndId></PmtId><Amt><EqvtAmt><Amt Ccy="EUR">1,5</Amt></EqvtAmt></Amt><Cdtr><Nm>B</Nm><CtryOfRes>SG</CtryOfRes></Cdtr><RmtInf><Ustrd>/INV/A//B/RFB/C</Ustrd><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>I</Nb></RfrdDocInf></Strd></RmtInf><RgltryRptg><Dtls><Tp>T</Tp><Cd>C</Cd><Inf>I</Inf></Dtls></RgltryRptg></CdtTrfTxInf></PmtInf></CstmrCdtTrfInitn></Document></Envelope>`,
  `<FIToFICstmrCdtTrf xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.02"><GrpHdr><MsgId>M</MsgId><IntrBkSttlmDt>2026-01-01</IntrBkSttlmDt></GrpHdr><CdtTrfTxInf><PmtId><InstrId>I</InstrId><TxId>T</TxId><UETR>3F1C9A52-7B0E-4D6A-9C1F-2E8B5A7D4C10</UETR></PmtId><IntrBkSttlmAmt Ccy="USD">10</IntrBkSttlmAmt><InstdAmt Ccy="EUR">9</InstdAmt><XchgRate>1.1</XchgRate><ChrgsInf><Amt Ccy="USD">1</Amt><Agt><FinInstnId><BIC>AAAAUS33</BIC></FinInstnId></Agt></ChrgsInf><IntrmyAgt1><FinInstnId><BICFI>BBBBUS33</BICFI><LEI>L</LEI><Nm>N</Nm><PstlAdr><Ctry>US</Ctry></PstlAdr></FinInstnId></IntrmyAgt1><Dbtr><Nm>A &amp; B</Nm><Id><OrgId><BICOrBEI>AAAAVNVX</BICOrBEI><LEI>5493001KJTIIGC8Y1R12</LEI></OrgId></Id></Dbtr><Cdtr><Nm><![CDATA[C < D]]></Nm></Cdtr><Purp><Prtry>P</Prtry></Purp></CdtTrfTxInf></FIToFICstmrCdtTrf>`,
);

let state = 1;
const rand = (n: number): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
const pick = <T>(xs: T[]): T => xs[rand(xs.length)]!;
const PIECES = ['<', '>', '&', ';', '"', "'", '/', ':', ' ', '\n', '\r', '\t', ' ', ' ', '\u0085', '﻿', '#', 'x', '!', '?', '-', '[', ']', '=',
  'A', '0', ',', '.', '😀', '&amp;', '&#x41;', '&#65;', '&bogus;', '&constructor;', '&#xD800;', '<!-- c -->', '<![CDATA[z]]>', '<?pi?>', '<!DOCTYPE x>',
  'xmlns:q="urn:q"', ' q:a="1"', ' Ccy="USD"', '<x:E xmlns:x="urn:x"/>', '/INV/', '//', '/RFB/', '\u0001', '￾', '<Nm>N</Nm>', '<Ctry>VN</Ctry>', '<toString/>', '<Document/>'];
const NAMES = ['Nm', 'Ctry', 'PstlAdr', 'AdrLine', 'Dbtr', 'Cdtr', 'Id', 'OrgId', 'PrvtId', 'Othr', 'BICFI', 'InstdAmt', 'IntrBkSttlmAmt', 'UETR', 'EndToEndId',
  'InstrId', 'GrpHdr', 'MsgId', 'CdtTrfTxInf', 'PmtInf', 'RmtInf', 'Ustrd', 'Strd', 'ChrgBr', 'DbtrAgt', 'CdtrAgt', 'FinInstnId', 'IntrBkSttlmDt', 'Amt', 'Document',
  'ReqdExctnDt', 'CtryOfRes', 'SchmeNm', 'Cd', 'Prtry', 'PmtId', 'DbtrAcct', 'CdtrAcct', 'IBAN', 'Purp', 'RgltryRptg', 'Dtls', 'ChrgsInf', 'Service', 'AppHdr'];

function elementSpan(s: string): [number, number] | null {
  const name = pick(NAMES);
  const opens: number[] = [];
  const re = new RegExp(`<(?:[A-Za-z]+:)?${name}[ >/]`, 'g');
  for (let m = re.exec(s); m; m = re.exec(s)) opens.push(m.index);
  if (opens.length === 0) return null;
  const start = pick(opens);
  const prefix = /^<([A-Za-z]+:)?/.exec(s.slice(start))![1] ?? '';
  const selfClose = s.indexOf('/>', start);
  const gt = s.indexOf('>', start);
  if (selfClose !== -1 && selfClose + 1 === gt) return [start, gt + 1];
  const close = s.indexOf(`</${prefix}${name}>`, start);
  return close === -1 ? null : [start, close + `</${prefix}${name}>`.length];
}

function mutate(s: string): string {
  const k = 1 + rand(3);
  for (let i = 0; i < k; i++) {
    const at = rand(s.length + 1);
    switch (rand(9)) {
      case 0: s = s.slice(0, at) + s.slice(at + 1); break;
      case 1: case 2: s = s.slice(0, at) + pick(PIECES) + s.slice(at); break;
      case 3: { const sp = elementSpan(s); if (sp) s = s.slice(0, sp[1]) + s.slice(sp[0], sp[1]) + s.slice(sp[1]); break; }
      case 4: { const sp = elementSpan(s); if (sp) s = s.slice(0, sp[0]) + s.slice(sp[1]); break; }
      case 5: { const sp = elementSpan(s); if (sp) { const inner = s.slice(sp[0], sp[1]); const gt = inner.indexOf('>'); s = s.slice(0, sp[0]) + inner.slice(0, gt + 1) + pick(PIECES) + inner.slice(gt + 1) + s.slice(sp[1]); } break; }
      case 6: { const m = />([^<>]{1,40})</g; const hits: [number, number][] = []; for (let x = m.exec(s); x; x = m.exec(s)) hits.push([x.index + 1, x.index + 1 + x[1]!.length]);
        if (hits.length) { const [a, b] = pick(hits); s = s.slice(0, a) + pick(['', ' ', '1,000.00', '00.5', 'usd', 'VN', 'Vietnam', '2026-11-17T00:00', '17/11/2026', '/INV/X//Y', 'DEMOVNV0', 'a!P', '3f1c9a52-7b0e-4d6a-9c1f', 'CINV', 'PUOR', 'DEBT', 'OUR', '&lt;']) + s.slice(b); } break; }
      case 7: s = s.replace(/xmlns="[^"]*"/, pick(['', 'xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08"', 'xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.12"', 'xmlns="urn:other"', 'xmlns=""', 'xmlns:p="urn:p"'])); break;
      default: { const a = rand(s.length); const b = rand(s.length); if (a < b) s = s.slice(0, a) + s.slice(b, b + 1) + s.slice(a + 1, b) + s.slice(a, a + 1) + s.slice(b + 1); }
    }
  }
  return s;
}

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
const answer = (kind: string, text: string): unknown => {
  try {
    if (kind === 'xml') return { elements: elements(parseXml(text)) };
    if (kind === 'tokens') return { tokens: invoiceTokens(text) };
    return { payments: parseSwiftMessages(text) };
  } catch (e) { return { error: errorOf(e) }; }
};

const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;

const [mode, ...args] = process.argv.slice(2);
if (mode === 'gen') {
  const [n, seed, inFile, expFile] = args as [string, string, string, string];
  state = Number(seed);
  const inputs: { kind: string; text: string }[] = [];
  for (let i = 0; i < Number(n); i++) {
    const text = mutate(pick(seeds));
    inputs.push({ kind: 'message', text });
    if (i % 4 === 0) inputs.push({ kind: 'xml', text });
    if (i % 10 === 0) { const m = /\/INV\/[^<]{0,60}/.exec(text); if (m) inputs.push({ kind: 'tokens', text: mutate(m[0]) }); }
  }
  writeFileSync(inFile, JSON.stringify(inputs));
  writeFileSync(expFile, JSON.stringify(inputs.map((c) => answer(c.kind, c.text))));
  const counts: Record<string, number> = {};
  for (const c of inputs) { const a = answer(c.kind, c.text) as { error?: { name: string; code?: string } }; const k = `${c.kind}:${a.error ? a.error.name + '/' + (a.error.code ?? '') : 'ok'}`; counts[k] = (counts[k] ?? 0) + 1; }
  console.log(inputs.length, 'cases', JSON.stringify(counts));
} else if (mode === 'cmp') {
  const [inFile, expFile, actFile] = args as [string, string, string];
  const inputs = JSON.parse(readFileSync(inFile, 'utf8')) as { kind: string; text: string }[];
  const expected = JSON.parse(readFileSync(expFile, 'utf8')) as unknown[];
  const actual = JSON.parse(readFileSync(actFile, 'utf8')) as unknown[];
  let bad = 0;
  for (let i = 0; i < inputs.length; i++) {
    const e = JSON.stringify(canon(expected[i])); const a = JSON.stringify(canon(actual[i]));
    if (e !== a) {
      if (bad < 8) console.log(`#${i} ${inputs[i]!.kind}\n  input: ${JSON.stringify(inputs[i]!.text).slice(0, 300)}\n  ts:    ${e.slice(0, 400)}\n  java:  ${a.slice(0, 400)}`);
      bad++;
    }
  }
  console.log(`${inputs.length - bad} of ${inputs.length} agree, ${bad} differ`);
}
