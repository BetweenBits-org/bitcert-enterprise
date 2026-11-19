/**
 * Do the two test schemas hold the same reserve snapshots after the same run?
 *
 *   node apps/core-java/tools/compare-por.mjs apps/core-java/.env.ref apps/core-java/.env.parity
 *
 * Every row of `por_snapshots`, in the order the rows were made, column by
 * column: the statement and the signature as text (what a reader of the
 * public material is later given back), the commitment, the root, the as-of
 * time, the leaf count, the totals, the state, the key the signature was
 * verified with, the challenge, the problems and the reserve report.
 *
 * What is each service's own on every request is compared as what it is:
 * the id of a row a route made, the times in a challenge and in a
 * measurement, the eight leaves a service drew out of more than eight, and
 * the id of the record a commitment became (only whether there is one). The
 * sentences listed in parity/expected.json as different on purpose — a
 * problem or a measurement the reference worded with its runtime's complaint
 * (D-03, D-16) — are compared as "a sentence of that kind".
 *
 * It also says which rows the key backfill filled: the reference fills them
 * when it starts, the Java service when `backfill-snapshot-keys` is run.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const [refEnvFile, javaEnvFile] = process.argv.slice(2);
if (!refEnvFile || !javaEnvFile) { console.error('usage: node compare-por.mjs <reference env file> <java env file>'); process.exit(2); }
const urlOf = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.startsWith('STONEHASH_DB_URL=')).slice('STONEHASH_DB_URL='.length);
const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
const [REF, DEV] = [schemaOf(urlOf(refEnvFile)), schemaOf(urlOf(javaEnvFile))];
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(REF) || !TEST.test(DEV) || REF === DEV) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(urlOf(refEnvFile));
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A sentence the reference took from its runtime, or the one the Java service has in its place. */
const WORDED = /Cannot read properties of|Cannot convert (undefined|null|object)|is required: |cannot be read: |Unexpected (token|end)|is not valid JSON|did not answer in JSON|answered null|Unterminated string/;
const json = (text, change) => { if (text === null) return null; try { return JSON.stringify(change(JSON.parse(text))); } catch { return text; } };
const rowsOf = async (schema) => {
  const [rows] = await conn.query(`SELECT s.*, o.slug FROM \`${schema}\`.por_snapshots s JOIN \`${schema}\`.orgs o ON o.id = s.org_id ORDER BY s.created_at, s.id`);
  return rows.map((r) => ({
    seeded: r.id.startsWith('seeded-') || r.id.startsWith('snap-'),
    row: {
      id: r.id.startsWith('seeded-') || r.id.startsWith('snap-') ? r.id : '<made by a route>',
      org: r.slug, institution_id: r.institution_id, status: r.status, statement: r.statement, sig: r.sig, commitment: r.commitment, root: r.root, asof: r.asof,
      leaf_count: r.leaf_count, totals: r.totals, signing_spki: r.signing_spki,
      challenge: json(r.challenge, (c) => (c && typeof c === 'object' ? { ...c,
        ...(TIME.test(c.issued_at ?? '') ? { issued_at: '<time>' } : {}), ...(TIME.test(c.expires_at ?? '') ? { expires_at: '<time>' } : {}),
        ...(Array.isArray(c.indices) && r.leaf_count > 8 && !r.id.startsWith('seeded-') ? { indices: `<${c.indices.length} of ${r.leaf_count}>` } : {}) } : c)),
      problems: json(r.problems, (p) => (Array.isArray(p) ? p.map((x) => (typeof x === 'string' && WORDED.test(x) ? x.replace(/: .*$/s, ': <a sentence about the opening>') : x)) : p)),
      reserves: json(r.reserves, (v) => (v && Array.isArray(v.measurements) ? { ...v, measurements: v.measurements.map((m) => ({ ...m,
        ...(TIME.test(m.measured_at ?? '') ? { measured_at: '<time>' } : {}), ...(typeof m.detail === 'string' && WORDED.test(m.detail) ? { detail: '<what was wrong with the answer>' } : {}) })) } : v)),
      has_record: r.attestation_id !== null,
      // A seeded row keeps the time it was seeded with; when a route settled it since, that is a time of the run.
      times: `${r.id.startsWith('seeded-') || r.id.startsWith('snap-') ? r.created_at : (TIME.test(r.created_at) ? '<time>' : r.created_at)} ${r.updated_at === r.created_at ? 'not changed since' : (TIME.test(r.updated_at) ? 'changed at <time>' : r.updated_at)}`,
    },
  }));
};
const [ref, dev] = [await rowsOf(REF), await rowsOf(DEV)];
await conn.end();
const differences = [];
if (ref.length !== dev.length) differences.push(`${ref.length} snapshots in the reference schema, ${dev.length} in the Java one`);
for (let i = 0; i < Math.min(ref.length, dev.length); i++) {
  for (const k of Object.keys(ref[i].row)) {
    if (ref[i].row[k] !== dev[i].row[k]) differences.push(`snapshot ${i} (${ref[i].row.id}, ${ref[i].row.org}, ${ref[i].row.status}) ${k}:\n  reference ${String(ref[i].row[k]).slice(0, 260)}\n  java      ${String(dev[i].row[k]).slice(0, 260)}`);
  }
}
for (const d of differences.slice(0, 12)) console.log(d);
const made = ref.filter((r) => !r.seeded).length;
const byStatus = {};
for (const r of ref) byStatus[r.row.status] = (byStatus[r.row.status] ?? 0) + 1;
console.log(`${ref.length} snapshots in the reference schema, ${dev.length} in the Java one (${made} made by the routes; ${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')}): `
  + `${differences.length === 0 ? 'the same rows, column by column' : `${differences.length} difference(s)`}`);
process.exit(differences.length === 0 && made > 0 ? 0 : 1);
