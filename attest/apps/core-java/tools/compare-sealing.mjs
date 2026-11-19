/**
 * The same batches from the same records: gives the reference service and
 * the Java service the same waiting records, lets each seal them all, and
 * requires the same result — the same batches in the same order (their
 * Merkle roots say which records, in which order), the same leaf index and
 * the same stored proof, character for character, for every record.
 *
 *   node apps/core-java/tools/compare-sealing.mjs apps/core-java/.env.ref apps/core-java/.env.dev-worker
 *
 * Both servers must be stopped. The two test schemas are seeded afresh
 * (tools/seed-reference.mjs) and given, on top of the seed's waiting
 * records, the cases the ordering rule is about: several organisations
 * waiting, more records than a batch holds, records of the same millisecond
 * (the insertion order decides, never the id), and a record with an older
 * time that was inserted last. The reference side is the reference's own
 * `sealBatch`; the Java side is `SealParityIT`, run through Maven with the
 * second env file (its BATCH_MAX_LEAVES is the batch size for both).
 *
 * One thing is different on purpose, and is checked as exactly that
 * (docs/JAVA-INTENDED-DIFFERENCES.md, D-08): an inscription is not swept
 * into a batch. The reference's batcher takes every record without a batch,
 * the seed's two inscriptions among them; the Java service leaves them out.
 * So that like is compared with like, the reference seals the digests with
 * the inscriptions set aside, and is given them back afterwards: it must
 * then sweep them into a batch of their own, and the Java service — which
 * had them in its schema all along — must not have touched them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../core/src/db.ts';
import { AttestService } from '../../core/src/service.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [refEnvFile, javaEnvFile] = process.argv.slice(2);
if (!refEnvFile || !javaEnvFile) { console.error('usage: node compare-sealing.mjs <reference env file> <java env file>'); process.exit(2); }
const readEnv = (file) => {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
const refEnv = readEnv(refEnvFile);
const javaEnv = readEnv(javaEnvFile);
const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
const REF = schemaOf(refEnv.STONEHASH_DB_URL);
const DEV = schemaOf(javaEnv.STONEHASH_DB_URL);
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(REF) || !TEST.test(DEV) || REF === DEV) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
const MAX = Number(javaEnv.BATCH_MAX_LEAVES ?? 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1 — the seed, identical in both schemas.
execFileSync('node', [path.join(HERE, 'seed-reference.mjs'), refEnvFile, javaEnvFile], { stdio: ['ignore', 'ignore', 'inherit'] });

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(refEnv.STONEHASH_DB_URL);
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];

// 2 — what the ordering rule is about, on top of it.
const org = async (slug) => (await q(`SELECT id FROM \`${REF}\`.orgs WHERE slug = ?`, [slug]))[0].id;
const [bank, other, free] = [await org('parity-bank'), await org('parity-other'), await org('public-free-tier')];
let made = 0;
const add = async (orgId, createdAt, source = 'api') => {
  const n = made++;
  // Ids that sort against the order of arrival, so that an order by id would show.
  const id = `seal-${String(999 - n).padStart(3, '0')}-${createHash('sha256').update(`id ${n}`).digest('hex').slice(0, 12)}`;
  await q(`INSERT INTO \`${REF}\`.attestations (id, org_id, leaf_bytes, content_type, descriptor, status, created_at, source, expires_at, statement, issuer_trust, product)
           VALUES (?, ?, ?, NULL, '{}', 'accepted', ?, ?, ?, NULL, NULL, 'attest')`,
  [id, orgId, createHash('sha256').update(`sealing case ${n}`).digest('hex'), createdAt, source, source === 'public' ? '2099-01-01T00:00:00.000Z' : null]);
};
const SAME = '2026-11-02T00:00:00.000Z';
for (let i = 0; i < 14; i++) await add(i % 3 === 1 ? other : bank, SAME);            // one millisecond, two organisations interleaved
for (let i = 0; i < 3; i++) await add(free, '2026-11-02T00:00:00.001Z', 'public');   // the free tier's own
for (let i = 0; i < 5; i++) await add(other, `2026-11-02T00:00:0${i}.500Z`);          // more than a batch for the other organisation, with the above
for (let i = 0; i < 2; i++) await add(bank, '2026-11-01T23:59:59.999Z');             // older than all of these, inserted last
await q('SET FOREIGN_KEY_CHECKS = 0');
await q(`TRUNCATE TABLE \`${DEV}\`.attestations`);
await q(`INSERT INTO \`${DEV}\`.attestations SELECT * FROM \`${REF}\`.attestations`);
await q('SET FOREIGN_KEY_CHECKS = 1');
// The inscriptions that have no batch: set aside on the reference side for now (the Java schema keeps them).
const inscriptions = await q(`SELECT * FROM \`${REF}\`.attestations WHERE kind = 'inscription' AND batch_id IS NULL ORDER BY rowseq`);
if (inscriptions.length === 0) { console.error('the seed holds no inscription without a batch; the difference this tool expects cannot be shown'); process.exit(1); }
const inscriptionIds = new Set(inscriptions.map((r) => r.id));
await q(`DELETE FROM \`${REF}\`.attestations WHERE kind = 'inscription' AND batch_id IS NULL`);
const waiting = (await q(`SELECT COUNT(*) AS n FROM \`${REF}\`.attestations WHERE batch_id IS NULL`))[0].n;
const before = async (schema) => new Set((await q(`SELECT id FROM \`${schema}\`.batches`)).map((r) => r.id));
const [hadRef, hadDev] = [await before(REF), await before(DEV)];

// 3 — the reference seals.
const backend = { network: 'regtest', name: 'bitcoind:regtest', async submit() { throw new Error('nothing is anchored here'); }, async poll() { return { status: 'pending' }; }, async health() { return { ok: true }; } };
const db = await openDb(refEnv.STONEHASH_DB_URL);
const svc = new AttestService(db, backend, MAX);
let sealedByReference = 0;
while (await svc.sealBatch()) { sealedByReference++; await sleep(3); }
// And now with the inscriptions back: what the reference's batcher does with them.
for (const row of inscriptions) await conn.query(`INSERT INTO \`${REF}\`.attestations SET ?`, [row]);
const sweptBatches = [];
for (let id = await svc.sealBatch(); id; id = await svc.sealBatch()) { sweptBatches.push(id); await sleep(3); }
await db.close();

// 4 — the Java service seals.
// Its own requirements can fail (a digest left waiting, an inscription given a batch); the rows are compared all the same.
let javaSealing = null;
try {
  execFileSync(path.join(HERE, '../mvnw'), ['-B', '-q', '-o', 'test', '-Dtest=SealParityIT', `-Dstonehash.env=${path.resolve(javaEnvFile)}`],
    { cwd: path.join(HERE, '..'), env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/usr/lib/jvm/java-17-openjdk-amd64' }, stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  javaSealing = 'the Java sealing test (SealParityIT) failed — see apps/core-java/target/surefire-reports/com.stonehash.attest.core.SealParityIT.txt';
}

// 5 — the same?
const state = async (schema, had) => {
  const batches = (await q(`SELECT id, status, merkle_root, leaf_count, sealed_at FROM \`${schema}\`.batches ORDER BY sealed_at, id`)).filter((b) => !had.has(b.id) && !sweptBatches.includes(b.id));
  const rows = await q(`SELECT a.id, a.status, a.leaf_index, a.batch_id, b.merkle_root, p.leaf_index AS proof_index, p.siblings, p.directions
                          FROM \`${schema}\`.attestations a LEFT JOIN \`${schema}\`.batches b ON b.id = a.batch_id LEFT JOIN \`${schema}\`.merkle_proofs p ON p.attestation_id = a.id ORDER BY a.id`);
  return { batches, inscriptions: rows.filter((r) => inscriptionIds.has(r.id)),
    records: new Map(rows.filter((r) => !inscriptionIds.has(r.id)).map((r) => [r.id, JSON.stringify([r.status, r.leaf_index, r.merkle_root, r.proof_index, r.siblings, r.directions])])) };
};
const [ref, dev] = [await state(REF, hadRef), await state(DEV, hadDev)];
const stillWaiting = (await q(`SELECT COUNT(*) AS n FROM \`${DEV}\`.attestations WHERE batch_id IS NULL AND kind <> 'inscription'`))[0].n;
await conn.end();
const differences = [];
if (javaSealing) differences.push(javaSealing);
// The one difference there is meant to be (D-08), required exactly: swept and `batched` there, untouched here.
const was = new Map(inscriptions.map((r) => [r.id, r.status]));
for (const r of ref.inscriptions) {
  if (!(sweptBatches.includes(r.batch_id) && r.status === 'batched' && r.proof_index === r.leaf_index && r.leaf_index !== null)) {
    differences.push(`inscription ${r.id}: the reference was expected to sweep it into a batch; it is ${r.status}, batch ${r.batch_id}`);
  }
}
for (const r of dev.inscriptions) {
  if (!(r.batch_id === null && r.leaf_index === null && r.proof_index === null && r.status === was.get(r.id))) {
    differences.push(`inscription ${r.id}: the Java service was expected to leave it alone (${was.get(r.id)}, no batch); it is ${r.status}, batch ${r.batch_id}`);
  }
}
if (ref.inscriptions.length !== inscriptions.length || dev.inscriptions.length !== inscriptions.length) differences.push(`${inscriptions.length} inscriptions were seeded; ${ref.inscriptions.length} are in the reference schema, ${dev.inscriptions.length} in the Java one`);
if (sweptBatches.length === 0) differences.push('the reference made no batch of the inscriptions');
if (stillWaiting !== 0) differences.push(`${stillWaiting} digests still wait in the Java schema`);
const sequence = (s) => s.batches.map((b) => `${b.merkle_root}/${b.leaf_count}/${b.status}`);
if (JSON.stringify(sequence(ref)) !== JSON.stringify(sequence(dev))) {
  differences.push(`the batches differ:\n  reference ${ref.batches.map((b) => `${b.leaf_count}:${b.merkle_root.slice(0, 8)}`).join(' ')}\n  java      ${dev.batches.map((b) => `${b.leaf_count}:${b.merkle_root.slice(0, 8)}`).join(' ')}`);
}
for (const [id, v] of ref.records) if (dev.records.get(id) !== v) differences.push(`record ${id}:\n  reference ${v.slice(0, 220)}\n  java      ${String(dev.records.get(id)).slice(0, 220)}`);
if (ref.records.size !== dev.records.size) differences.push(`${ref.records.size} records in the reference schema, ${dev.records.size} in the Java one`);
for (const d of differences.slice(0, 12)) console.log(d);
console.log(`sealing ${waiting} waiting records, at most ${MAX} a batch: the reference made ${ref.batches.length} batches (${ref.batches.map((b) => b.leaf_count).join('+')}), `
  + `the Java service ${dev.batches.length} (${dev.batches.map((b) => b.leaf_count).join('+')}); ${ref.records.size} records and their proofs compared — `
  + `${differences.length === 0 ? `the same batches, the same order, the same proofs; and the ${inscriptions.length} inscriptions without a batch, as expected (D-08): the reference swept them into ${sweptBatches.length} more `
    + `batch${sweptBatches.length === 1 ? '' : 'es'} (${[...was.values()].map((s) => `${s} → batched`).join(', ')}), the Java service left them as they were` : `${differences.length} difference(s)`}`);
process.exit(differences.length === 0 && sealedByReference === ref.batches.length && ref.batches.length > 0 ? 0 : 1);
