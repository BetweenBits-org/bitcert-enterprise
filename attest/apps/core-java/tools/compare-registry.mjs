/**
 * Do the two test schemas hold the same institutions and subscriptions after
 * the same run?
 *
 *   node apps/core-java/tools/compare-registry.mjs apps/core-java/.env.ref apps/core-java/.env.parity
 *
 * The console's product routes write these two tables — activating a
 * product, switching one off, an institution's signing key, the key its
 * console session signs with — and the product screen does not show all of
 * it (the console key, for one). So the rows themselves are compared.
 *
 * Read-only, and only on stonehash_test_ schemas. A row is compared as what
 * it says: the institution's id, role, name, country, both keys, its
 * encryption key and what it may assert; the subscription's product, plan,
 * status and configuration; each with the organisation it belongs to, by
 * slug. What a service made up on the way differs on every run and is read
 * as "an id": the id of an institution it issued (country, role, six random
 * characters), the slug of an organisation that signed up. Times are left
 * out. No key material is printed: a difference names the row and the
 * column.
 *
 * The platform's own institution (role STONEHASH), which the settlement rail
 * registers when it starts, is compared like any other row but for one
 * column: its signing key is the key file of the server that started on the
 * schema, and each server may have its own. (The comparison pair shares one
 * key file; whether the two rows hold the same key is said, and does not
 * decide.) Everything else in the row — id, role, name, country, what the
 * platform may assert, no organisation, no other key — has to be the same.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const [refEnv, devEnv] = process.argv.slice(2);
if (!refEnv || !devEnv) { console.error('usage: node compare-registry.mjs <reference env file> <java env file>'); process.exit(2); }
const urlOf = (file) => { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const t = line.trim(); if (t.startsWith('STONEHASH_DB_URL=')) return t.slice('STONEHASH_DB_URL='.length).trim(); } throw new Error(`${file} names no STONEHASH_DB_URL`); };
/**
 * One thing in these tables differs between the two schemas by design: a seeded organisation's webhook address
 * names the partner stand-in of the server that reads the schema (tools/seed-remit.mjs) —
 * `<REMIT_PARTNERS_BASE of that env file>/hooks/<name>`. That prefix, and nothing else, is read as "its own stand-in".
 */
const hooksOf = (file) => { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const t = line.trim(); if (t.startsWith('REMIT_PARTNERS_BASE=')) return `${t.slice('REMIT_PARTNERS_BASE='.length).trim().replace(/\/+$/, '')}/hooks/`; } return null; };
const own = (v, hooks) => (typeof v === 'string' && hooks ? v.split(hooks).join('<its own stand-in>/hooks/') : v);
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const ISSUED = /-(BANK|EX)-[0-9A-F]{6}\b/g;
const SIGNED_UP = /^sandbox-[0-9a-f]{8}$/;
const blur = (v) => (typeof v === 'string' ? v.replace(ISSUED, '-$1-<id>') : v);
const slug = (v) => (v === null ? null : SIGNED_UP.test(v) ? 'sandbox-<id>' : v);
/** A key, a long text: said by its length and a few characters of its digest, never whole. */
const brief = (v) => (typeof v === 'string' && v.length > 40 ? `<${v.length} characters, sha256 ${createHash('sha256').update(v).digest('hex').slice(0, 12)}…>` : v);

const platformRows = [];
async function read(url, ownHooks) {
  const u = new URL(url);
  const schema = u.pathname.replace(/^\//, '');
  if (!/^stonehash_test_[a-z0-9_]+$/.test(schema)) throw new Error(`refusing: ${schema} is not a stonehash_test_ schema`);
  const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: schema, charset: 'utf8mb4_bin' });
  const [all] = await conn.query('SELECT i.id, o.slug AS org, i.role, i.name, i.country, i.signing_spki, i.console_spki, i.encryption_jwk, i.authority FROM institutions i LEFT JOIN orgs o ON o.id = i.org_id');
  const platform = all.filter((r) => r.role === 'STONEHASH');
  const institutions = all.map((r) => (r.role === 'STONEHASH' ? { ...r, signing_spki: r.signing_spki === null ? null : '<the key of the server on this schema>' } : r));
  platformRows.push({ rows: platform.length, keys: platform.map((r) => createHash('sha256').update(String(r.signing_spki)).digest('hex')).join(',') });
  const [subscriptions] = await conn.query('SELECT o.slug AS org, s.product, s.plan, s.status, s.config FROM subscriptions s JOIN orgs o ON o.id = s.org_id');
  await conn.end();
  return {
    institutions: institutions.map((r) => ({ ...r, id: blur(r.id), org: slug(r.org) })),
    subscriptions: subscriptions.map((r) => ({ ...r, org: slug(r.org), config: own(blur(r.config), ownHooks) })),
  };
}
const [ref, java] = await Promise.all([read(urlOf(refEnv), hooksOf(refEnv)), read(urlOf(devEnv), hooksOf(devEnv))]);
const failures = [];
for (const [table, name] of [['institutions', (r) => `${r.id} (${r.role}, ${r.org})`], ['subscriptions', (r) => `${r.org} / ${r.product}`]]) {
  const rows = (list) => { const m = new Map(); for (const r of list) { const k = name(r); m.set(k, [...(m.get(k) ?? []), r]); } return m; };
  const a = rows(ref[table]); const b = rows(java[table]);
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = (a.get(k) ?? []).map((r) => JSON.stringify(r)).sort();
    const y = (b.get(k) ?? []).map((r) => JSON.stringify(r)).sort();
    if (x.length !== y.length) { failures.push(`${table}: ${k} — ${x.length} in the reference's store, ${y.length} in the Java service's`); continue; }
    for (const [i, row] of x.entries()) {
      if (row === y[i]) continue;
      const r = JSON.parse(row); const j = JSON.parse(y[i]);
      for (const column of Object.keys(r)) if (r[column] !== j[column]) failures.push(`${table}: ${k} — ${column}: ${JSON.stringify(brief(r[column]))} there, ${JSON.stringify(brief(j[column]))} here`);
    }
  }
}
for (const f of failures.slice(0, 40)) console.log(`FAIL ${f}`);
const count = (list, f) => list.filter(f).length;
console.log(`the platform's own institution: ${platformRows[0].rows} in the reference's store, ${platformRows[1].rows} in the Java service's — compared but for its signing key `
  + `(${platformRows[0].rows === 1 && platformRows[0].keys === platformRows[1].keys ? 'the same key in both: one key file' : 'not the same key in both'})`);
console.log(`${ref.institutions.length} institutions (${count(ref.institutions, (r) => r.console_spki !== null)} with a console key) and ${ref.subscriptions.length} subscriptions (${count(ref.subscriptions, (r) => r.status === 'inactive')} inactive) in the reference's store, `
  + `${java.institutions.length} and ${java.subscriptions.length} in the Java service's: ${failures.length === 0 ? 'the same' : `${failures.length} differences`}`);
process.exit(failures.length === 0 ? 0 : 1);
