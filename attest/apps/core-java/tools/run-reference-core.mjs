/**
 * Runs the service this one replaces as the reference to compare with: the
 * same TypeScript code, on a port and a schema of its own.
 *
 *   node apps/core-java/tools/run-reference-core.mjs <env file>
 *
 * The env file is read by the rules of deploy/ecosystem.config.cjs. It is
 * refused unless it names a stonehash_test_ schema and a port other than the
 * live one: the TypeScript service applies its own table definitions to
 * whatever schema it opens, and runs its workers on it.
 */
import fs from 'node:fs';
import { problems } from './check-test-env.mjs';

const envFile = process.argv[2];
if (!envFile) { console.error('usage: node run-reference-core.mjs <env file>'); process.exit(2); }
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const schema = new URL(process.env.STONEHASH_DB_URL ?? 'mysql://x/').pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) { console.error('refusing: the reference runs on a stonehash_test_ schema only'); process.exit(1); }
if ((process.env.PORT ?? '8787') === '8787') { console.error('refusing: the reference does not take the live port'); process.exit(1); }
if (!process.env.STONEHASH_DATA_DIR) { console.error('refusing: STONEHASH_DATA_DIR must be set — the default is the live data directory'); process.exit(1); }
// Everything a test server must not reach — the live schema, wallet, data directory, partner simulator and chain node
// (see check-test-env.mjs). A setting that is absent falls back to a live address, so absence is refused too.
const unsafe = problems(process.env);
if (unsafe.length > 0) { for (const p of unsafe) console.error(`refusing: ${p}`); process.exit(1); }
process.chdir(new URL('../../core/', import.meta.url).pathname);
await import('../../core/src/main.ts');
