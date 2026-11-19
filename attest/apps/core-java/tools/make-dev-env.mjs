/**
 * Writes the settings file of a development server from the live one.
 *
 *   node apps/core-java/tools/make-dev-env.mjs <live env file> <new env file> KEY=value …
 *
 * Every line of the live file is kept, except the keys given, which are set
 * to the values given — with one special form: `DB=<schema>` keeps the
 * server and the account of STONEHASH_DB_URL and changes only the schema it
 * names. The new file is readable by its owner alone. No value is printed.
 *
 * A development server never reads the live file as it is: that would be the
 * live port, the live schema, the live wallet and the platform's own key.
 * The keys below are refused unless they are changed.
 */
import fs from 'node:fs';

const [from, to, ...pairs] = process.argv.slice(2);
if (!from || !to) { console.error('usage: node make-dev-env.mjs <live env file> <new env file> KEY=value …'); process.exit(2); }
const set = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
const lines = fs.readFileSync(from, 'utf8').split('\n');
const seen = new Set();
const out = [];
let liveSchema = null;
for (const line of lines) {
  const t = line.trim();
  const i = t.indexOf('=');
  if (!t || t.startsWith('#') || i < 1) { out.push(line); continue; }
  const key = t.slice(0, i).trim();
  if (key === 'STONEHASH_DB_URL') {
    const u = new URL(t.slice(i + 1).trim());
    liveSchema = u.pathname.replace(/^\//, '');
    if (set.has('DB')) { u.pathname = `/${set.get('DB')}`; out.push(`STONEHASH_DB_URL=${u.toString()}`); seen.add('DB'); seen.add(key); continue; }
  }
  if (set.has(key)) { out.push(`${key}=${set.get(key)}`); seen.add(key); } else { out.push(line); }
}
for (const [key, value] of set) if (!seen.has(key) && key !== 'DB') { out.push(`${key}=${value}`); seen.add(key); }
for (const must of ['PORT', 'DB', 'STONEHASH_DATA_DIR', 'BITCOIND_WALLET', 'WORKER_TICK_MS']) {
  if (!seen.has(must)) { console.error(`refusing: ${must} must be given — a development server does not share it with the live one`); process.exit(1); }
}
if (!/^stonehash_test_[a-z0-9_]+$/.test(set.get('DB')) || set.get('DB') === liveSchema) { console.error('refusing: DB must be a schema named stonehash_test_…'); process.exit(1); }
fs.writeFileSync(to, out.join('\n'), { mode: 0o600 });
fs.chmodSync(to, 0o600);
console.log(`wrote ${to} (owner-only): ${[...set.keys()].join(', ')} changed, the rest as in ${from}`);
