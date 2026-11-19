/**
 * One-shot copy: the SQLite store -> the MySQL store.
 *
 * Boots the target schema through the real `openDb` (same DDL the service
 * runs), then copies table by table in foreign-key order, preserving
 * attestation insertion order so MySQL's `rowseq` reproduces what SQLite's
 * `rowid` meant. Verifies row counts at the end and prints them.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-mysql.mjs \
 *     --sqlite /path/attest-test.sqlite \
 *     --mysql  "mysql://user:pass@127.0.0.1:3306/stonehash_attest" [--wipe]
 *
 * Stop the service first: a live writer on either side makes the counts a
 * coin toss.
 */
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const sqlitePath = arg('sqlite');
const mysqlUrl = arg('mysql');
const wipe = process.argv.includes('--wipe');
if (!sqlitePath || !mysqlUrl) {
  console.error('usage: migrate-sqlite-to-mysql.mjs --sqlite <file> --mysql <url> [--wipe]');
  process.exit(2);
}

/** FK order: parents before children. */
const TABLES = [
  'orgs', 'api_keys', 'batches', 'attestations', 'merkle_proofs', 'anchor_txs',
  'accounts', 'sessions', 'issuer_keys', 'subscriptions', 'institutions',
  'remit_quotes', 'remit_payments', 'remit_events', 'remit_travel_rule',
  'remit_idempotency', 'remit_webhook_deliveries', 'por_snapshots', 'remit_manifests',
];

const src = new DatabaseSync(sqlitePath, { readOnly: true });
const dst = await openDb(mysqlUrl, (m, x) => console.log(`[schema] ${m}`, x ?? ''));

const dstCount = async (t) =>
  Number((await dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n);

const existing = await dstCount('orgs');
if (existing > 0 && !wipe) {
  console.error(`target already holds data (orgs=${existing}); pass --wipe to replace it`);
  process.exit(1);
}
if (wipe) {
  await dst.exec('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await dst.exec(`TRUNCATE TABLE ${t}`);
  await dst.exec('SET FOREIGN_KEY_CHECKS = 1');
  console.log('[wipe] target emptied');
}

let grand = 0;
for (const table of TABLES) {
  // Insertion order matters only for attestations (batching fairness reads
  // rowseq); harmless elsewhere, so copy every table in rowid order.
  const rows = src.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  if (rows.length === 0) { console.log(`[copy] ${table}: 0`); continue; }
  const cols = Object.keys(rows[0]);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  await dst.tx(async (tx) => {
    const stmt = tx.prepare(sql);
    for (const row of rows) await stmt.run(...cols.map((c) => row[c] ?? null));
  });
  console.log(`[copy] ${table}: ${rows.length}`);
  grand += rows.length;
}

let mismatched = 0;
for (const table of TABLES) {
  const a = src.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const b = await dstCount(table);
  const ok = Number(a) === b;
  if (!ok) { mismatched++; console.error(`[verify] ${table}: sqlite=${a} mysql=${b}  << MISMATCH`); }
  else console.log(`[verify] ${table}: ${b} ok`);
}

// rowseq must reproduce rowid order on the one table that cares.
const firstSqlite = src.prepare('SELECT id FROM attestations ORDER BY rowid LIMIT 1').get();
if (firstSqlite) {
  const firstMysql = await dst.prepare('SELECT id FROM attestations ORDER BY rowseq LIMIT 1').get();
  if (firstMysql.id !== firstSqlite.id) {
    mismatched++;
    console.error(`[verify] insertion order: sqlite first=${firstSqlite.id} mysql first=${firstMysql.id}  << MISMATCH`);
  } else {
    console.log('[verify] attestation insertion order preserved');
  }
}

src.close();
await dst.close();
if (mismatched > 0) { console.error(`FAILED: ${mismatched} table(s) mismatched`); process.exit(1); }
console.log(`DONE: ${grand} rows migrated, all counts match`);
