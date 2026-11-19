/**
 * Two runs of the settlement rail's flows (tools/remit-flows.mjs), compared scenario by scenario.
 *
 *   node apps/core-java/tools/compare-remit-flows.mjs <reference.json> <java.json> [--expected <file> | --expected none] [--only <text>] [--show]
 *
 * The first file is the reference's ledger, the second the Java service's (or, to prove the scenarios themselves, a
 * second run against the reference: nothing may differ then). What is compared is each scenario's `ledger` as the
 * tool wrote it — the answers, the settlement's columns, its events, its webhook deliveries, its travel-rule row,
 * what the partner stand-in was asked and answered, the idempotency row — member by member, the order of members
 * included; what is new on every run was reduced to its kind by the tool that wrote the files.
 *
 * A difference is either a defect or it is written down: the list of expected differences (default
 * parity/expected-flows.json) names them — the rows of docs/JAVA-REMIT-DESIGN.md section 13, each with its number
 * in docs/JAVA-INTENDED-DIFFERENCES.md — in the style of parity/expected.json:
 *
 *   { "scenario": "a callback twice, the same bytes", "path": "$.settlements[0].events.length", "ref": 16, "java": 13, "why": "D-..: …" }
 *
 * `scenario` may end in `*` (every scenario whose name starts so) or be `*`; `path` may end in `*` (every path under
 * it), or `pathMatches` gives a pattern; `ref` / `java` narrow an entry to those two values. Exit status 1 when a
 * difference is not on the list, when an entry of the list no longer occurs (unless the run is narrowed with
 * `--only`), or when a scenario did not run as scripted on either side.
 *
 * A scenario the tool marked `race` (its outcome in the reference depends on which of two things happens first) is
 * not compared: what each side did is printed. A scenario marked with a row of design section 13 is compared like
 * any other; the row is printed beside its differences, as the place to look for their reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const files = args.filter((a, i) => !a.startsWith('--') && !['--expected', '--only'].includes(args[i - 1]));
if (files.length !== 2) { console.error('usage: node compare-remit-flows.mjs <reference.json> <java.json> [--expected <file> | --expected none] [--only <text>] [--show]'); process.exit(2); }
const [A, B] = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const only = opt('--only');
const show = args.includes('--show');
const expectedFile = opt('--expected') ?? path.resolve(HERE, '../parity/expected-flows.json');
const expected = expectedFile === 'none' || !fs.existsSync(expectedFile) ? [] : JSON.parse(fs.readFileSync(expectedFile, 'utf8')).differences;
const used = new Set();

function differences(a, b, where, out) {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length !== b.length) out.push({ path: `${where}.length`, ref: a.length, java: b.length });
      for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${where}[${i}]`, out);
      return;
    }
    const [ka, kb] = [Object.keys(a), Object.keys(b)];
    for (const k of ka) { if (!(k in b)) out.push({ path: `${where}.${k}`, ref: a[k], java: '<absent>' }); else differences(a[k], b[k], `${where}.${k}`, out); }
    for (const k of kb) if (!(k in a)) out.push({ path: `${where}.${k}`, ref: '<absent>', java: b[k] });
    if (ka.length === kb.length && ka.every((k) => k in b) && ka.join('\u0000') !== kb.join('\u0000')) out.push({ path: `${where}.<member order>`, ref: ka.join(','), java: kb.join(',') });
    return;
  }
  if (a !== b) out.push({ path: where, ref: a, java: b });
}
const isExpected = (scenario, d) => expected.findIndex((e, i) => {
  const hit = (e.scenario === '*' || e.scenario === scenario || (e.scenario.endsWith('*') && scenario.startsWith(e.scenario.slice(0, -1))))
    && (e.pathMatches !== undefined ? new RegExp(e.pathMatches).test(d.path) : (e.path === d.path || (e.path.endsWith('*') && d.path.startsWith(e.path.slice(0, -1)))))
    && (!('ref' in e) || JSON.stringify(e.ref) === JSON.stringify(d.ref)) && (!('java' in e) || JSON.stringify(e.java) === JSON.stringify(d.java));
  if (hit) used.add(i);
  return hit;
}) >= 0;
const brief = (v) => { const s = JSON.stringify(v); return s === undefined ? 'undefined' : s.length > 240 ? `${s.slice(0, 240)}… (${s.length} characters)` : s; };

let unlisted = 0; let listed = 0; let same = 0; let races = 0; let broken = 0;
if (A.tag !== B.tag) { console.log(`DIFF  the two runs have different tags (${A.tag}, ${B.tag}): their payment ids differ, and everything made from them`); unlisted++; }
for (const [what, a, b] of [['the platform key id has the reference\'s shape', A.platform_key_id_is_of_the_reference_shape, B.platform_key_id_is_of_the_reference_shape],
  ['initialisation vectors used for two ciphertexts', A.ciphertexts?.initialisation_vectors_used_twice, B.ciphertexts?.initialisation_vectors_used_twice],
  ['ephemeral keys used for two ciphertexts', A.ciphertexts?.ephemeral_keys_used_twice, B.ciphertexts?.ephemeral_keys_used_twice]]) {
  if (a !== b || (typeof a === 'number' && a !== 0) || a === false) { console.log(`DIFF  ${what}: reference ${brief(a)}, java ${brief(b)}`); unlisted++; }
}
const byName = new Map(B.scenarios.map((s) => [s.name, s]));
const namesA = A.scenarios.map((s) => s.name);
for (const s of B.scenarios) if (!namesA.includes(s.name) && (!only || s.name.includes(only))) { console.log(`DIFF  scenario "${s.name}" is in the second file only`); unlisted++; }
for (const a of A.scenarios) {
  if (only && !a.name.includes(only)) continue;
  const b = byName.get(a.name);
  if (!b) { console.log(`DIFF  scenario "${a.name}" is in the first file only`); unlisted++; continue; }
  if (a.error || b.error) { broken++; console.log(`FAIL  ${a.name}\n      did not run as scripted — reference: ${a.error ?? 'as scripted'}; java: ${b.error ?? 'as scripted'}`); }
  if (a.race || b.race) {
    races++;
    const ends = (s) => (s.observed?.settlements ?? []).map((x) => `${x.payment?.state} ← ${(x.events ?? []).map((e) => e.type).slice(3).join(', ')}`).join(' | ') || '-';
    const said = (s) => (s.observed?.answers ?? []).map((x) => `${x.step}: ${x.status}${x.body?.error ? ` ${x.body.error}` : ''}`).join('; ');
    console.log(`race  ${a.name}\n      reference: ${ends(a)}\n                 ${said(a)}\n      java:      ${ends(b)}\n                 ${said(b)}${a.design13 ? `\n      design 13: ${a.design13}` : ''}`);
    continue;
  }
  const diffs = [];
  differences(a.ledger, b.ledger, '$', diffs);
  const news = diffs.filter((d) => !isExpected(a.name, d));
  if (diffs.length === 0) { same++; if (show) console.log(`same  ${a.name}`); continue; }
  if (news.length === 0) { listed++; if (show) console.log(`known ${a.name} → ${diffs.length} listed difference(s)`); continue; }
  unlisted++;
  console.log(`DIFF  ${a.name}${a.design13 ? `\n      design 13: ${a.design13}` : ''}`);
  for (const d of news.slice(0, 40)) console.log(`      ${d.path}\n        reference ${brief(d.ref)}\n        java      ${brief(d.java)}`);
  if (news.length > 40) console.log(`      … and ${news.length - 40} more`);
}
const stale = only ? [] : expected.filter((_, i) => !used.has(i));
for (const e of stale) console.log(`STALE the list names a difference that no longer occurs: ${e.scenario} ${e.path ?? e.pathMatches} (${e.why})`);
console.log(`${same + listed + unlisted + races} scenarios: ${same} the same, ${listed} different as listed${expectedFile === 'none' ? '' : ` in ${path.basename(expectedFile)}`}, ${unlisted} different and not listed, ${races} races (not compared)`
  + `${broken ? `, ${broken} did not run as scripted` : ''}${stale.length ? `, ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}` : ''}`);
process.exit(unlisted === 0 && stale.length === 0 && broken === 0 ? 0 : 1);
