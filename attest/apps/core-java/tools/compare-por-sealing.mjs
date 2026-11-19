/**
 * The reserve commitments a comparison run left waiting, sealed by each
 * service: the same records waiting in the same order, then the same
 * batches and the same proofs.
 *
 *   node apps/core-java/tools/compare-por-sealing.mjs apps/core-java/.env.ref-worker apps/core-java/.env.dev-worker
 *
 * Run it after parity/run.mjs, with both servers stopped, on the two test
 * schemas as the run left them (nothing is seeded here — the point is the
 * records the two services made themselves, through their own routes). A
 * commitment submitted to both is one leaf digest in both schemas; with the
 * workers off it waits, `accepted`, in both. A batch is one organisation's
 * (the oldest waiting record picks the organisation, and what else that
 * organisation has waiting joins it), so what the exchanges of the reserve
 * cases get depends on their own waiting lines and on nothing else. This
 * tool first requires those lines to be the same on both sides — the same
 * digests, in the same order of arrival — and then lets each service seal
 * everything it has: the reference with its own `sealBatch`, the Java
 * service with `SealParityIT`, both at the batch size of the second settings
 * file. For those organisations the batches have to come out the same (their
 * Merkle roots say which records, in which order), every record has to get
 * the same leaf index and the same stored proof, and every snapshot that
 * points at a record has to point at the same one.
 *
 * The other organisations' lines are not the same after a run, and are not
 * compared here: where one service refuses what the other takes on purpose
 * (parity/expected.json) a record exists on one side only, and a sandbox
 * organisation is made anew by each. What the batcher does with any line is
 * compared on identical lines by tools/compare-sealing.mjs.
 *
 * An inscription without a batch is set aside on the reference side first:
 * the reference's batcher would sweep it into a batch and the Java service
 * does not (docs/JAVA-INTENDED-DIFFERENCES.md, D-08; tools/compare-sealing.mjs
 * checks exactly that difference).
 *
 * The two schemas are sealed afterwards: seed them again before the next run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../core/src/db.ts';
import { AttestService } from '../../core/src/service.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [refEnvFile, javaEnvFile] = process.argv.slice(2);
if (!refEnvFile || !javaEnvFile) { console.error('usage: node compare-por-sealing.mjs <reference env file> <java env file>'); process.exit(2); }
const readEnv = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.indexOf('=') > 0)
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const refEnv = readEnv(refEnvFile);
const javaEnv = readEnv(javaEnvFile);
const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
const REF = schemaOf(refEnv.STONEHASH_DB_URL);
const DEV = schemaOf(javaEnv.STONEHASH_DB_URL);
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(REF) || !TEST.test(DEV) || REF === DEV) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
const MAX = Number(javaEnv.BATCH_MAX_LEAVES ?? 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(refEnv.STONEHASH_DB_URL);
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const differences = [];

// 1 — the waiting lines of the organisations that have a reserve commitment waiting. Ids are each service's own; a
// seeded organisation has the same slug on both sides.
const waitingOf = async (schema) => {
  const rows = await q(`SELECT a.id, o.slug, a.leaf_bytes, a.product, a.source, a.content_type, a.status, a.descriptor FROM \`${schema}\`.attestations a
                          JOIN \`${schema}\`.orgs o ON o.id = a.org_id WHERE a.batch_id IS NULL AND a.kind <> 'inscription' ORDER BY a.created_at, a.rowseq`);
  const all = rows.map((r) => {
    let kind = null;
    try { kind = JSON.parse(r.descriptor)?.kind ?? null; } catch { kind = '(unreadable)'; }
    return { id: r.id, slug: r.slug, key: `${r.slug}/${r.leaf_bytes}`, line: `${r.slug}/${r.leaf_bytes}/${r.product}/${r.source}/${r.content_type}/${r.status}/${kind}`, product: r.product, kind };
  });
  const exchanges = new Set(all.filter((r) => r.product === 'por').map((r) => r.slug));
  return { total: all.length, exchanges, line: all.filter((r) => exchanges.has(r.slug)) };
};
// The inscriptions that have no batch: set aside on the reference side (the Java schema keeps its own).
await q(`DELETE FROM \`${REF}\`.attestations WHERE kind = 'inscription' AND batch_id IS NULL`);
const [refAll, devAll] = [await waitingOf(REF), await waitingOf(DEV)];
const [refWaiting, devWaiting] = [refAll.line, devAll.line];
if ([...refAll.exchanges].sort().join() !== [...devAll.exchanges].sort().join()) differences.push(`organisations with a reserve commitment waiting: ${[...refAll.exchanges].sort()} in the reference schema, ${[...devAll.exchanges].sort()} in the Java one`);
if (refWaiting.length !== devWaiting.length) differences.push(`${refWaiting.length} records of those organisations wait in the reference schema, ${devWaiting.length} in the Java one`);
for (let i = 0; i < Math.min(refWaiting.length, devWaiting.length); i++) {
  if (refWaiting[i].line !== devWaiting[i].line) { differences.push(`waiting record ${i}:\n  reference ${refWaiting[i].line}\n  java      ${devWaiting[i].line}`); if (differences.length > 6) break; }
}
const commitments = refWaiting.filter((r) => r.product === 'por' && r.kind === 'por-snapshot').length;
const before = async (schema) => new Set((await q(`SELECT id FROM \`${schema}\`.batches`)).map((r) => r.id));
const [hadRef, hadDev] = [await before(REF), await before(DEV)];

// 2 — each seals its own.
const backend = { network: 'regtest', name: 'bitcoind:regtest', async submit() { throw new Error('nothing is anchored here'); }, async poll() { return { status: 'pending' }; }, async health() { return { ok: true }; } };
const db = await openDb(refEnv.STONEHASH_DB_URL);
const svc = new AttestService(db, backend, MAX);
let sealedByReference = 0;
while (await svc.sealBatch()) { sealedByReference++; await sleep(3); }
await db.close();
try {
  execFileSync(path.join(HERE, '../mvnw'), ['-B', '-q', '-o', 'test', '-Dtest=SealParityIT', `-Dstonehash.env=${path.resolve(javaEnvFile)}`],
    { cwd: path.join(HERE, '..'), env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/usr/lib/jvm/java-17-openjdk-amd64' }, stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
  differences.push('the Java sealing test (SealParityIT) failed — see apps/core-java/target/surefire-reports/com.stonehash.attest.core.SealParityIT.txt');
}

// 3 — the same batches, the same place and proof for every record.
const sealedOf = async (schema, had, waiting, exchanges) => {
  const made = (await q(`SELECT id, status, merkle_root, leaf_count, sealed_at FROM \`${schema}\`.batches ORDER BY sealed_at, id`)).filter((b) => !had.has(b.id));
  const byId = new Map(waiting.map((w) => [w.id, w.key]));
  const rows = await q(`SELECT a.id, a.status, a.leaf_index, a.batch_id, b.merkle_root, p.leaf_index AS proof_index, p.siblings, p.directions
                          FROM \`${schema}\`.attestations a LEFT JOIN \`${schema}\`.batches b ON b.id = a.batch_id LEFT JOIN \`${schema}\`.merkle_proofs p ON p.attestation_id = a.id`);
  const records = new Map();
  const theirs = new Set();
  for (const r of rows) {
    if (!byId.has(r.id)) continue;
    records.set(byId.get(r.id), JSON.stringify([r.status, r.leaf_index, r.merkle_root, r.proof_index, r.siblings, r.directions]));
    theirs.add(r.batch_id);
  }
  // The batches these organisations' records went into, in the order they were sealed.
  const batches = made.filter((b) => theirs.has(b.id));
  const slugs = [...exchanges];
  // A snapshot and the record its commitment became: by what both sides share — the commitment and the snapshot's state.
  const snapshots = (await q(`SELECT o.slug, s.commitment, s.status, a.leaf_bytes, a.status AS record_status, a.leaf_index, b.merkle_root
                                FROM \`${schema}\`.por_snapshots s JOIN \`${schema}\`.orgs o ON o.id = s.org_id
                                LEFT JOIN \`${schema}\`.attestations a ON a.id = s.attestation_id LEFT JOIN \`${schema}\`.batches b ON b.id = a.batch_id
                               WHERE s.attestation_id IS NOT NULL`)).filter((s) => slugs.includes(s.slug))
    .map((s) => JSON.stringify([s.slug, s.commitment, s.status, s.leaf_bytes, s.record_status, s.leaf_index, s.merkle_root])).sort();
  return { batches, all: made.length, records, snapshots };
};
const [ref, dev] = [await sealedOf(REF, hadRef, refWaiting, refAll.exchanges), await sealedOf(DEV, hadDev, devWaiting, devAll.exchanges)];
const stillWaiting = (await q(`SELECT COUNT(*) AS n FROM \`${DEV}\`.attestations WHERE batch_id IS NULL AND kind <> 'inscription'`))[0].n;
await conn.end();
if (stillWaiting !== 0) differences.push(`${stillWaiting} digests still wait in the Java schema`);
const sequence = (s) => s.batches.map((b) => `${b.merkle_root}/${b.leaf_count}/${b.status}`);
if (JSON.stringify(sequence(ref)) !== JSON.stringify(sequence(dev))) {
  differences.push(`the batches differ:\n  reference ${ref.batches.map((b) => `${b.leaf_count}:${b.merkle_root.slice(0, 8)}`).join(' ')}\n  java      ${dev.batches.map((b) => `${b.leaf_count}:${b.merkle_root.slice(0, 8)}`).join(' ')}`);
}
for (const [key, v] of ref.records) if (dev.records.get(key) !== v) differences.push(`record ${key}:\n  reference ${v.slice(0, 220)}\n  java      ${String(dev.records.get(key)).slice(0, 220)}`);
if (ref.records.size !== dev.records.size) differences.push(`${ref.records.size} records sealed in the reference schema, ${dev.records.size} in the Java one`);
if (JSON.stringify(ref.snapshots) !== JSON.stringify(dev.snapshots)) {
  const only = (a, b) => a.filter((x) => !b.includes(x)).slice(0, 3);
  differences.push(`the snapshots do not point at the same records:\n  only in the reference ${only(ref.snapshots, dev.snapshots).join(' ')}\n  only in java          ${only(dev.snapshots, ref.snapshots).join(' ')}`);
}
for (const d of differences.slice(0, 12)) console.log(d);
console.log(`${refAll.total} records waiting after the run in the reference schema, ${devAll.total} in the Java one; of ${[...refAll.exchanges].sort().join(', ')}: ${refWaiting.length} `
  + `(${commitments} of them reserve commitments the routes issued). At most ${MAX} a batch: the reference sealed ${ref.all} batches in all and the Java service ${dev.all}, `
  + `${ref.batches.length} and ${dev.batches.length} of them these organisations' (${ref.batches.map((b) => b.leaf_count).join('+')}); ${ref.records.size} records with their proofs and ${ref.snapshots.length} snapshots with a record compared — `
  + `${differences.length === 0 ? 'the same line waiting, the same batches, the same proofs, and every snapshot points at the same record' : `${differences.length} difference(s)`}`);
process.exit(differences.length === 0 && sealedByReference === ref.all && ref.batches.length > 0 && commitments > 0 ? 0 : 1);
