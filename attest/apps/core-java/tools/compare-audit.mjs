/**
 * Do the two test schemas hold the same audit trail after the same run?
 *
 *   node apps/core-java/tools/compare-audit.mjs apps/core-java/.env.ref apps/core-java/.env.dev
 *
 * Read-only, and only on stonehash_test_ schemas. A row is compared as who
 * acted (kind and label), for which product, with which method, on which
 * path, with which status; ids, times and durations differ on every request
 * and are left out (an id inside a path is read as "an id"). The rows that
 * differ because the two services answer differently on purpose are listed
 * in parity/expected.json under `audit`; anything else fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [refEnv, devEnv] = process.argv.slice(2);
const urlOf = (file) => { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const t = line.trim(); if (t.startsWith('STONEHASH_DB_URL=')) return t.slice('STONEHASH_DB_URL='.length).trim(); } throw new Error(`${file} names no database`); };
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
async function rows(url) {
  const u = new URL(url);
  const schema = u.pathname.replace(/^\//, '');
  if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) throw new Error(`refusing: ${schema} is not a stonehash_test_ schema`);
  const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: schema, charset: 'utf8mb4_bin' });
  const [found] = await conn.query('SELECT actor_type, actor_label, service, method, path, status, duration_ms, at, id, actor_id, org_id FROM audit_log ORDER BY at, id');
  await conn.end();
  return found;
}
const [ref, java] = await Promise.all([rows(urlOf(refEnv)), rows(urlOf(devEnv))]);
const failures = [];
// Every row has the shape a row has, on both sides.
for (const [who, list] of [['reference', ref], ['java', java]]) {
  for (const r of list) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.at) || !/^[0-9a-f-]{36}$/.test(r.id) || !Number.isInteger(r.duration_ms) || r.duration_ms < 0 || r.path.length > 512 || !r.actor_id || !r.org_id) {
      failures.push(`${who}: a row that is not shaped as a row is — ${JSON.stringify(r)}`);
    }
  }
}
const keyOf = (r) => JSON.stringify([r.actor_type, r.actor_label, r.service, r.method, r.path.replace(UUID, '<id>'), r.status]);
const count = (list) => { const m = new Map(); for (const r of list) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1); return m; };
const a = count(ref); const b = count(java);
const only = (x, y) => [...x.entries()].flatMap(([k, n]) => Array.from({ length: Math.max(0, n - (y.get(k) ?? 0)) }, () => JSON.parse(k)));
let refOnly = only(a, b); let javaOnly = only(b, a);
const expected = JSON.parse(fs.readFileSync(path.resolve(HERE, '../parity/expected.json'), 'utf8')).audit ?? [];
for (const e of expected) {
  const i = refOnly.findIndex((r) => r[3] === e.method && r[4] === e.path && r[5] === e.reference);
  const j = javaOnly.findIndex((r) => r[3] === e.method && r[4] === e.path && r[5] === e.java);
  if (i < 0 || j < 0) { failures.push(`expected.json lists an audit difference that did not occur: ${e.method} ${e.path} ${e.reference}/${e.java} (${e.why})`); continue; }
  refOnly.splice(i, 1); javaOnly.splice(j, 1);
}
for (const r of refOnly) failures.push(`only the reference recorded ${JSON.stringify(r)}`);
for (const r of javaOnly) failures.push(`only the Java service recorded ${JSON.stringify(r)}`);
// The order too, where the rows are the same: a request is recorded when it is answered.
const sequence = (list) => list.map(keyOf);
const sameOrder = refOnly.length + javaOnly.length === 0 && expected.length === 0 ? JSON.stringify(sequence(ref)) === JSON.stringify(sequence(java)) : null;
for (const f of failures.slice(0, 30)) console.log(`FAIL ${f}`);
console.log(`audit rows: ${ref.length} in the reference schema, ${java.length} in the Java schema, ${a.size} kinds; ${expected.length} listed differences; `
  + `${failures.length === 0 ? 'the same otherwise' : `${failures.length} not as expected`}${sameOrder === null ? '' : sameOrder ? ', in the same order' : ', in another order'}`);
process.exit(failures.length === 0 ? 0 : 1);
