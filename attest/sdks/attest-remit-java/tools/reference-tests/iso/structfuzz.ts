/**
 * Random ISO 20022 files built from the structures the hardening round changed: Documents and bare
 * messages side by side and nested, extra elements in a Document, agents identified every way,
 * charge bearers at both levels, test BICs anywhere. Strings, compared through FuzzDriver's "message" kind.
 *   node probe/structfuzz.ts <n> <seed> <inputs.json> <expected.json>
 */
import { writeFileSync } from 'node:fs';
import { parseSwiftMessages } from '../../../../../packages/attest-remit/src/index.ts';

let state = 1;
// The high bits: the low bits of this generator repeat with a short period.
const rand = (n: number): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) % n; };
const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!;
const maybe = (s: string, p = 2): string => (rand(p) === 0 ? s : '');
const NS = ['urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08', 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09', 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08',
  'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03', 'urn:other', '', 'urn:iso:std:iso:20022:tech:xsd:pacs.009.001.08', 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.12'];
const BIC = (): string => pick(['DEMOVNVX', 'DEMOVNV0', 'DEMOSGS0XXX', 'DEMOSGSG', 'AAAAUS33']);
const CHRG = ['', '', '', '', '', '', '', '', '<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>DEBT</ChrgBr>', '<ChrgBr>CRED</ChrgBr>', '<ChrgBr> SHAR </ChrgBr>', '<ChrgBr>SLEV</ChrgBr>', '<ChrgBr>OUR</ChrgBr>',
  '<ChrgBr/>', '<ChrgBr>shar</ChrgBr>', '<ChrgBr>BEN</ChrgBr>'];
const othr = (): string => `<Othr>${maybe(`<Id>${pick(['X-1', ' Y ', ''])}</Id>`, 4) || '<Id>O-1</Id>'}${maybe(`<SchmeNm>${pick(['<Cd>NCCC</Cd>', '<Prtry>BANK</Prtry>', '<Cd>A</Cd><Prtry>B</Prtry>', ''])}</SchmeNm>`)}</Othr>`;
const fin = (): string => {
  const parts = [maybe(`<BICFI>${BIC()}</BICFI>`, 3),
    maybe(`<ClrSysMmbId>${maybe(`<ClrSysId>${pick(['<Cd>USABA</Cd>', '<Prtry>SGIBG</Prtry>'])}</ClrSysId>`)}${maybe('<MmbId>021000021</MmbId>')}</ClrSysMmbId>`, 3),
    maybe('<LEI>5493001KJTIIGC8Y1R12</LEI>', 5), maybe('<Nm>Bank</Nm>', 4), maybe(othr(), 2), maybe(othr(), 25), maybe('<PstlAdr><Ctry>SG</Ctry></PstlAdr>', 5)];
  return `<FinInstnId>${parts.join('')}</FinInstnId>`;
};
const agent = (name: string): string => maybe(`<${name}>${fin()}</${name}>`, 2);
const pacsTx = (i: number): string => `<CdtTrfTxInf><PmtId><InstrId>I${i}</InstrId><EndToEndId>E${i}</EndToEndId></PmtId>`
  + `<IntrBkSttlmAmt Ccy="USD">${rand(25) === 0 ? '12,5' : pick(['10.00', '7'])}</IntrBkSttlmAmt>${pick(CHRG)}${agent('IntrmyAgt1')}${agent('IntrmyAgt2')}`
  + `${agent('DbtrAgt')}<Dbtr><Nm>A</Nm></Dbtr>${agent('CdtrAgt')}<Cdtr><Nm>B</Nm></Cdtr></CdtTrfTxInf>`;
const painTx = (i: number): string => `<CdtTrfTxInf><PmtId><EndToEndId>E${i}</EndToEndId></PmtId><Amt><InstdAmt Ccy="USD">1</InstdAmt></Amt>`
  + `${pick(CHRG)}${agent('CdtrAgt')}<Cdtr><Nm>B</Nm></Cdtr></CdtTrfTxInf>`;
const body = (p: string): string => {
  const tag = (n: string): string => (p ? `${p}:${n}` : n);
  const q = (s: string): string => (p ? s.replace(/<(\/?)([A-Za-z])/g, `<$1${p}:$2`) : s);
  if (rand(2) === 0) {
    return `<${tag('FIToFICstmrCdtTrf')}>${q(`<GrpHdr><MsgId>M</MsgId>${maybe(`<InstgAgt>${fin()}</InstgAgt>`, 3)}</GrpHdr>`)}${q(pacsTx(1))}${maybe(q(pacsTx(2)), 3)}</${tag('FIToFICstmrCdtTrf')}>`;
  }
  const blocks = Array.from({ length: 1 + rand(2) }, (_, b) => `<PmtInf><PmtInfId>P${b}</PmtInfId><Dbtr><Nm>A</Nm></Dbtr>${agent('DbtrAgt')}${pick(CHRG)}`
    + `${rand(12) === 0 ? '' : painTx(1)}${maybe(painTx(2), 3)}</PmtInf>`).join('');
  return `<${tag('CstmrCdtTrfInitn')}>${q(`<GrpHdr><MsgId>M</MsgId></GrpHdr>${blocks}`)}</${tag('CstmrCdtTrfInitn')}>`;
};
const other = (): string => pick(['<Extra/>', '<AppHdr/>', '<x:Sig xmlns:x="urn:x"/>', '<toString/>', '<constructor/>', '<FICdtTrf/>',
  `<AppHdr><Fr><FIId><FinInstnId><BICFI>${BIC()}</BICFI></FinInstnId></FIId></Fr></AppHdr>`, '<Hdr><Service>swift.finplus!p</Service></Hdr>',
  `<Routing><BICFI>${BIC()}</BICFI></Routing>`, ' text ', '<!-- c -->']);
const prefixed = (): string => (rand(4) === 0 ? 'p' : '');
const doc = (depth: number): string => {
  const ns = pick(NS);
  const count = ((r) => (r < 2 ? 0 : r < 32 ? 2 : 1))(rand(40));
  const kids = Array.from({ length: count }, () => {
    const r = rand(10);
    if (r < 8) { const p = prefixed(); const b = body(p); return p ? b.replace(/^<p:([A-Za-z]+)/, `<p:$1 xmlns:p="${pick(NS) || 'urn:p'}"`) : b; }
    if (r < 9 || depth > 1) return other();
    return doc(depth + 1);
  }).join('');
  return `<Document${ns ? ` xmlns="${ns}"` : ''}>${kids}</Document>`;
};
const node = (depth: number): string => {
  const r = rand(10);
  if (r < 4) return doc(depth);
  if (r < 7) return body('');
  if (r < 9 && depth < 3) return `<${pick(['Batch', 'Envelope', 'AppHdr', 'Inner'])}>${Array.from({ length: 1 + rand(3) }, () => node(depth + 1)).join('')}</${pick(['X'])}>`.replace(/<\/X>$/, '') + '';
  return other();
};
// wrappers need their own closing tag: build them explicitly
const wrap = (depth: number): string => {
  const r = rand(10);
  if (r < 5) return doc(depth);
  if (r < 7) return body('');
  if (r < 9 && depth < 3) { const name = pick(['Batch', 'Envelope', 'AppHdr', 'Inner', 'FIToFICstmrCdtTrf']); return `<${name}>${Array.from({ length: 1 + rand(3) }, () => wrap(depth + 1)).join('')}</${name}>`; }
  return other();
};
void node;
const errorOf = (e: unknown): Record<string, unknown> => {
  const x = e as { name: string; code?: string; field?: string; message: string };
  const out: Record<string, unknown> = { name: x.name };
  if (x.code !== undefined) out.code = x.code;
  if (x.field !== undefined) out.field = x.field;
  out.message = x.message;
  return out;
};
const answer = (t: string): unknown => { try { return { payments: parseSwiftMessages(t) }; } catch (e) { return { error: errorOf(e) }; } };
const [n, seed, inFile, expFile] = process.argv.slice(2);
state = Number(seed);
const inputs: { kind: string; text: string }[] = [];
for (let i = 0; i < Number(n); i++) {
  let t = wrap(0);
  if (!t.startsWith('<')) t = `<R>${t}</R>`;
  inputs.push({ kind: 'message', text: t });
}
const answers = inputs.map((c) => answer(c.text));
writeFileSync(inFile!, JSON.stringify(inputs));
writeFileSync(expFile!, JSON.stringify(answers));
const counts: Record<string, number> = {};
for (const a of answers as { error?: { code?: string; message: string } }[]) {
  const k = a.error ? `${a.error.code}: ${a.error.message.replace(/document \d+ of \d+/, 'document k of n').slice(0, 60)}` : 'read';
  counts[k] = (counts[k] ?? 0) + 1;
}
console.log(inputs.length, 'cases'); for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(v).padStart(6), k);
