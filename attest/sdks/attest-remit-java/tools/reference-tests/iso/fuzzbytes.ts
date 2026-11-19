/**
 * Differential fuzzing of how bytes become text (parse.ts: P1, P2, P3) — the Java half is FuzzDriver's "bytes" kind.
 *   node probe/fuzzbytes.ts gen <n> <seed> <inputs.json> <expected.json>
 * Compare with: node probe/fuzz.ts cmp <inputs.json> <expected.json> <actual.json>
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSwiftMessages } from '../../../../../packages/attest-remit/src/index.ts';

const SAMPLES = fileURLToPath(new URL('../../../../../packages/attest-remit/samples/', import.meta.url));
const seeds = ['pacs008.sample.xml', 'pacs008.envelope.sample.xml', 'pain001.sample.xml'].map((f) => readFileSync(SAMPLES + f, 'latin1'));
let state = 1;
// The high bits: the low bits of this generator repeat with a short period.
const rand = (n: number): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) % n; };
const pick = <T>(xs: readonly T[]): T => xs[rand(xs.length)]!;
const LABELS = ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8', 'utf-16', 'utf-16le', 'ucs-2', 'unicode',
  'csunicode', 'iso-10646-ucs-2', 'unicodefeff', 'utf-16be', 'unicodefffe', 'iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987',
  'iso-ir-100', 'csisolatin1', 'latin1', 'l1', 'cp819', 'ibm819', 'us-ascii', 'ascii', 'ansi_x3.4-1968', 'windows-1252', 'cp1252', 'x-cp1252',
  'EUC-KR', 'Shift_JIS', 'ISO-8859-2', 'windows-1251', 'UTF-7', 'utf 8', '', 'latin-1', 'utf-32', 'x-user-defined', 'iso-8859-15', 'koi8-r'];
const SPACE = [' ', '\t', '\n', '\r', '\f', '\v', ' ', '\u0085', ''];
const casing = (s: string): string => [...s].map((c) => (rand(2) ? c.toUpperCase() : c)).join('');
const LEADS: number[][] = [[], [], [0x20], [0x09, 0x0a], [0x0d, 0x0a], [0x0b], [0x0c], [0xa0], [0x85], [0xef, 0xbb, 0xbf], [0xc2, 0xa0], [0xff, 0xfe], [0xfe, 0xff], [0x78], [0xef, 0xbb]];

function mutate(text: string): Buffer {
  let s = text;
  // the declaration
  switch (rand(6)) {
    case 0: break;
    case 1: s = s.replace(/^<\?xml[^>]*\?>/, ''); break;
    case 2: s = s.replace('encoding="UTF-8"', ''); break;
    default: {
      const q = rand(5) === 0 ? "'" : '"';
      const label = pick(SPACE) + (rand(2) ? casing(pick(LABELS)) : pick(LABELS)) + pick(SPACE);
      s = s.replace('encoding="UTF-8"', `encoding${pick(['', ' ', '\t'])}=${pick(['', ' ', '\n'])}${q}${label}${q}`);
      if (rand(6) === 0) s = s.replace('<?xml version="1.0"', `<?xml version="1.0" x="${'y'.repeat(150 + rand(60))}"`);
    }
  }
  // characters of the name, as bytes of some code page
  const nameAt = s.indexOf('Vina Trading');
  let body: Buffer;
  const k = rand(5);
  if (k === 0) body = Buffer.from(s.replace('Vina Trading', 'Viña Tradíng €“'), 'utf8');
  else if (k === 1) body = Buffer.from(s, 'latin1');
  else {
    const raw = Array.from({ length: 1 + rand(6) }, () => (rand(3) === 0 ? 0x80 + rand(0x20) : rand(4) === 0 ? 0x20 + rand(0x5f) : 0xa0 + rand(0x60)));
    body = Buffer.concat([Buffer.from(s.slice(0, nameAt + 4), 'latin1'), Buffer.from(raw), Buffer.from(s.slice(nameAt + 4), 'latin1')]);
  }
  // a different file form now and then
  switch (rand(10)) {
    case 0: body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body.toString('latin1'), 'utf16le')]); break;
    case 1: body = Buffer.from(body.toString('latin1'), 'utf16le'); break;
    case 2: body = body.subarray(0, rand(body.length)); break;
    default:
  }
  return Buffer.concat([Buffer.from(pick(LEADS)), body]);
}

const errorOf = (e: unknown): Record<string, unknown> => {
  const x = e as { name: string; code?: string; field?: string; message: string };
  const out: Record<string, unknown> = { name: x.name };
  if (x.code !== undefined) out.code = x.code;
  if (x.field !== undefined) out.field = x.field;
  out.message = x.message;
  return out;
};
const answer = (b: Buffer): unknown => { try { return { payments: parseSwiftMessages(b) }; } catch (e) { return { error: errorOf(e) }; } };

const [mode, n, seed, inFile, expFile] = process.argv.slice(2);
if (mode === 'gen') {
  state = Number(seed);
  const inputs: { kind: string; text: string }[] = [];
  for (let i = 0; i < Number(n); i++) inputs.push({ kind: 'bytes', text: mutate(pick(seeds)).toString('base64') });
  writeFileSync(inFile!, JSON.stringify(inputs));
  const answers = inputs.map((c) => answer(Buffer.from(c.text, 'base64')));
  writeFileSync(expFile!, JSON.stringify(answers));
  const counts: Record<string, number> = {};
  for (const a of answers as { error?: { code?: string; message: string } }[]) {
    const key = a.error ? `${a.error.code}: ${a.error.message.slice(0, 40)}` : 'read';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(inputs.length, 'cases', JSON.stringify(counts, null, 1));
}
