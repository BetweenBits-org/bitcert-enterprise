/**
 * Differential test: the same inputs through the TypeScript SDK and through the Java port,
 * and every place the two answers differ.
 *
 * Inputs are the samples and the golden cases' inputs, each mutated in ways an export or a
 * careless system really produces — a deleted line, a doubled field, a swapped character,
 * changed white space, a cut-off tail, bytes of another encoding. The mutations come from a
 * seeded generator, so a run is repeatable: `node diff-fuzz.mjs <classpath> <count> [seed]`.
 */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SwiftMappingError, isoFieldNames, mapSwiftPayment, parseSwiftMessages, swiftContentDigest, swiftPaymentId,
} from '../../../packages/attest-remit/src/index.ts';

const [classpath, countArg = '2000', seedArg = '1'] = process.argv.slice(2);
if (!classpath) { console.error('usage: node tools/diff-fuzz.mjs <classpath with the SDK classes and the test classes> [count] [seed]\n  e.g. after ./run-tests.sh:  node tools/diff-fuzz.mjs dist/stonehash-attest-remit-0.1.0.jar:build/test-classes 6000 1'); process.exit(2); }
const COUNT = Number(countArg);
const INSTITUTIONS = ['VN-BANK-T1', 'VN-BANK-001'];
const GOLDEN = fileURLToPath(new URL('../src/test/resources/golden/parse.json', import.meta.url));

// xorshift32: the same sequence on every run for a given seed.
let state = (Number(seedArg) >>> 0) || 1;
const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0x100000000; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const int = (n) => Math.floor(rnd() * n);

const seeds = JSON.parse(readFileSync(GOLDEN, 'utf8')).cases
  .filter((c) => c.input.base64 || c.input.text !== undefined)
  .map((c) => (c.input.base64 ? Buffer.from(c.input.base64, 'base64') : Buffer.from(c.input.text, 'utf8')))
  .filter((b) => b.length > 0 && b.length < 20000);

const ODD = [' ', ' ', '﻿', '　', '\t', '\r', '\u0085', '\u000b', ' ', '​', 'é', '한', '😀', '&', '<', '"', "'", '$', '-}', '{', '}', ':', '/', ',', '.'];
function mutate(buf) {
  const latin = buf.toString('latin1');
  const lines = latin.split('\n');
  switch (int(14)) {
    case 0: { const i = int(lines.length); lines.splice(i, 1); return Buffer.from(lines.join('\n'), 'latin1'); }
    case 1: { const i = int(lines.length); lines.splice(i, 0, lines[i]); return Buffer.from(lines.join('\n'), 'latin1'); }
    case 2: { const i = int(lines.length); const j = int(lines.length); [lines[i], lines[j]] = [lines[j], lines[i]]; return Buffer.from(lines.join('\n'), 'latin1'); }
    case 3: { const at = int(latin.length); return Buffer.from(latin.slice(0, at), 'latin1'); }
    case 4: { const at = int(latin.length); return Buffer.concat([buf.subarray(0, at), Buffer.from(pick(ODD), 'utf8'), buf.subarray(at)]); }
    case 5: { const at = int(latin.length); const n = 1 + int(6); return Buffer.concat([buf.subarray(0, at), buf.subarray(at + n)]); }
    case 6: { const out = Buffer.from(buf); out[int(out.length)] = int(256); return out; }
    case 7: return Buffer.from(latin.replace(/\r?\n/g, pick(['\r\n', '\r', '\n\n', '\n '])), 'latin1');
    case 8: { const m = [...latin.matchAll(/[0-9]+/g)]; if (!m.length) return buf; const hit = pick(m); const v = pick(['0', '00', '1e3', '-1', '9'.repeat(16), '1,5', '1.123456', '']); return Buffer.from(latin.slice(0, hit.index) + v + latin.slice(hit.index + hit[0].length), 'latin1'); }
    case 9: { const m = [...latin.matchAll(/[A-Z]{2,}/g)]; if (!m.length) return buf; const hit = pick(m); return Buffer.from(latin.slice(0, hit.index) + hit[0].toLowerCase() + latin.slice(hit.index + hit[0].length), 'latin1'); }
    case 10: { const other = pick(seeds); const at = int(latin.length); return Buffer.concat([buf.subarray(0, at), other.subarray(int(other.length))]); }
    case 11: { const m = [...latin.matchAll(/<\/?[A-Za-z][A-Za-z0-9]*|:[0-9]{2}[A-Z]?:/g)]; if (!m.length) return buf; const a = pick(m); const b = pick(m); return Buffer.from(latin.slice(0, a.index) + b[0] + latin.slice(a.index + a[0].length), 'latin1'); }
    case 12: return Buffer.concat([Buffer.from(pick(['﻿', ' ', '\n', ' ', '{1:F01DEMOVNVXAXXX0000000000}', '<?xml version="1.0" encoding="' + pick(['utf-8', 'UTF-16', 'latin1', 'ISO-8859-1', 'windows-1252', 'ascii', 'x']) + '"?>']), 'utf8'), buf]);
    default: { let out = buf; for (let k = 0; k < 2 + int(3); k++) out = mutate(out); return out; }
  }
}

function tsAnswer(message) {
  try {
    const all = parseSwiftMessages(message);
    return {
      payments: all,
      derived: all.map((p) => ({ paymentIds: Object.fromEntries(INSTITUTIONS.map((i) => [i, swiftPaymentId(i, p)])), contentDigest: swiftContentDigest(p), isoFieldNames: isoFieldNames(p) })),
      mappings: all.map((p) => { const { payment: _p, ...rest } = mapSwiftPayment(p, {}); void _p; return { ...rest, input: rest.input ?? null }; }),
    };
  } catch (e) {
    const err = { code: e?.code };
    if (typeof e?.field === 'string') err.field = e.field;
    err.message = String(e?.message ?? e);
    if (typeof e?.code !== 'string') return { error: { crash: `${e?.name}: ${e?.message}` } };
    return { error: err };
  }
}
void SwiftMappingError;

const JAVA_WORDING = [['pass { index } to choose one, or use parseSwiftMessages() to take each in turn', 'pass an index to choose one, or use Swift.parseAll() to take each in turn']];
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const inputs = [];
for (const s of seeds) inputs.push({ buf: s, as: 'bytes' });
while (inputs.length < COUNT) {
  const buf = mutate(pick(seeds));
  if (buf.length === 0 || buf.length > 60000) continue;
  inputs.push({ buf, as: rnd() < 0.15 ? 'string' : 'bytes' });
}
// A message handed over as a string is its UTF-8 text on both sides.
const lines = inputs.map(({ buf, as }) => JSON.stringify({ base64: (as === 'string' ? Buffer.from(buf.toString('utf8'), 'utf8') : buf).toString('base64'), as }));
const java = spawnSync('java', ['-cp', classpath, 'com.stonehash.attest.remit.swift.SwiftProbe', ...INSTITUTIONS], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30 });
if (java.status !== 0) { console.error(java.stderr.slice(0, 4000)); process.exit(2); }
const answers = java.stdout.trim().split('\n');
if (answers.length !== inputs.length) { console.error(`java answered ${answers.length} of ${inputs.length} inputs`); process.exit(2); }

let differ = 0; let crashes = 0; let read = 0; let refused = 0;
const shown = [];
const byCode = new Map();
for (let i = 0; i < inputs.length; i++) {
  const { buf, as } = inputs[i];
  const message = as === 'string' ? buf.toString('utf8') : buf;
  const want = tsAnswer(message);
  const got = JSON.parse(answers[i]);
  if (want.error?.message) for (const [ts, jv] of JAVA_WORDING) want.error.message = want.error.message.replace(ts, jv);
  if (want.error) { refused++; byCode.set(want.error.code ?? 'crash', (byCode.get(want.error.code ?? 'crash') ?? 0) + 1); } else read++;
  if (got.error?.crash || want.error?.crash) crashes++;
  if (canon(want) !== canon(got)) {
    differ++;
    if (shown.length < 12) shown.push({ i, as, input: (as === 'string' ? Buffer.from(message, 'utf8') : buf).toString('base64'), want: canon(want).slice(0, 600), got: canon(got).slice(0, 600) });
  }
}
console.log(`inputs ${inputs.length} (seed ${seedArg}): read by the reference ${read}, refused ${refused} — ${[...byCode].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`differences ${differ}, crashes ${crashes}`);
if (shown.length) { writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), `differences-seed${seedArg}.json`), JSON.stringify(shown, null, 1)); for (const d of shown.slice(0, 6)) console.log(`#${d.i} (${d.as})\n  ts:   ${d.want.slice(0, 260)}\n  java: ${d.got.slice(0, 260)}`); }
process.exit(differ ? 1 : 0);
