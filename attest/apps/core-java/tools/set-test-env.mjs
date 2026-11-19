/**
 * Sets settings in a test server's settings file, in place.
 *
 *   node apps/core-java/tools/set-test-env.mjs <env file> KEY=value …
 *
 * Only a file of this module (apps/core-java/.env.*) — never the live
 * service's. A key the file has is replaced where it stands; a new one is
 * added at the end. The file stays readable by its owner alone, and no value
 * is printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [file, ...pairs] = process.argv.slice(2);
if (!file || pairs.length === 0) { console.error('usage: node set-test-env.mjs <env file> KEY=value …'); process.exit(2); }
const full = path.resolve(file);
if (path.dirname(full) !== path.resolve(HERE, '..') || !path.basename(full).startsWith('.env.')) {
  console.error('refusing: only a settings file of this module (apps/core-java/.env.*) is changed by this tool'); process.exit(1);
}
const set = new Map(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
const seen = new Set();
const out = fs.readFileSync(full, 'utf8').split('\n').map((line) => {
  const t = line.trim(); const i = t.indexOf('=');
  if (!t || t.startsWith('#') || i < 1) return line;
  const key = t.slice(0, i).trim();
  if (!set.has(key)) return line;
  seen.add(key);
  return `${key}=${set.get(key)}`;
});
while (out.length && out[out.length - 1] === '') out.pop();
for (const [key, value] of set) if (!seen.has(key)) out.push(`${key}=${value}`);
fs.writeFileSync(full, `${out.join('\n')}\n`, { mode: 0o600 });
fs.chmodSync(full, 0o600);
console.log(`${path.basename(full)}: ${[...set.keys()].join(', ')} set`);
