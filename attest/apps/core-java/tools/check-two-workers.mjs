/**
 * After two instances of the service ran side by side on one schema, both
 * with their batch worker on: was every batch sealed once and broadcast once,
 * and did only one of them work at a time?
 *
 *   node apps/core-java/tools/check-two-workers.mjs --env apps/core-java/.env.dev-worker --logs <log of instance 1> <log of instance 2>
 *
 * Read from the test schema (stonehash_test_ only), from the wallet
 * attest-java (its own transactions) and from the two logs. Required: each
 * batch has exactly one anchor transaction and exactly one recorded attempt,
 * and exactly one transaction of the wallet carries its payload; every
 * record is in exactly one batch; the lease has one owner; and in the logs,
 * between an instance saying it holds the lease and saying it stands by,
 * only that instance sealed and anchored.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const ENV_FILE = arg('--env');
const logsAt = process.argv.indexOf('--logs');
const LOGS = logsAt < 0 ? [] : process.argv.slice(logsAt + 1, logsAt + 3);
const env = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const dbUrl = new URL(env.STONEHASH_DB_URL);
const SCHEMA = dbUrl.pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(SCHEMA) || env.BITCOIND_WALLET !== 'attest-java') { console.error('refusing: a stonehash_test_ schema and the wallet attest-java only'); process.exit(1); }
const rpc = async (method, params = [], wallet = '') => {
  const res = await fetch((env.BITCOIND_URL || 'http://127.0.0.1:18443').replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.BITCOIND_USER ?? ''}:${env.BITCOIND_PASSWORD ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
};
const failures = [];
const must = (ok, what) => { if (!ok) failures.push(what); };

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({ host: dbUrl.hostname, port: dbUrl.port ? Number(dbUrl.port) : 3306, user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: SCHEMA, charset: 'utf8mb4_bin' });
const q = async (sql) => (await conn.query(sql))[0];
const batches = await q('SELECT id, status, merkle_root, leaf_count, anchor_txid FROM batches');
const anchors = await q('SELECT txid, batch_id, status FROM anchor_txs');
const attempts = await q('SELECT batch_id, attempt, txid, state FROM anchor_attempts');
const records = await q('SELECT id, batch_id, leaf_index, status FROM attestations');
const proofs = await q('SELECT attestation_id, batch_id FROM merkle_proofs');
const lease = await q('SELECT name, owner FROM worker_leases');
await conn.end();

// The wallet's own transactions, each once.
const wallet = new Map();
for (const e of await rpc('listtransactions', ['*', 5000, 0, true], 'attest-java')) {
  if (!wallet.has(e.txid)) wallet.set(e.txid, (await rpc('gettransaction', [e.txid], 'attest-java')).hex);
}
for (const b of batches) {
  const own = anchors.filter((a) => a.batch_id === b.id);
  const tried = attempts.filter((a) => a.batch_id === b.id);
  const payload = `6a3542433031` + `01` + b.merkle_root + b.id.replace(/-/g, '');
  const carried = [...wallet.values()].filter((h) => h.includes(payload)).length;
  must(b.status === 'confirmed' && own.length === 1 && own[0].txid === b.anchor_txid, `batch ${b.id} is ${b.status} with ${own.length} anchor transaction(s)`);
  must(tried.length === 1 && tried[0].state === 'sent' && tried[0].txid === b.anchor_txid, `batch ${b.id} has ${tried.length} recorded attempt(s): ${tried.map((t) => t.state).join(', ')}`);
  must(carried === 1, `${carried} transactions of the wallet carry batch ${b.id}`);
  must(records.filter((r) => r.batch_id === b.id).length === b.leaf_count, `batch ${b.id} says ${b.leaf_count} leaves`);
}
must(records.every((r) => r.status === 'confirmed' && r.batch_id !== null), `${records.filter((r) => r.status !== 'confirmed').length} records are not confirmed`);
must(proofs.length === records.length && new Set(proofs.map((p) => p.attestation_id)).size === records.length, `${proofs.length} proofs for ${records.length} records`);
must(new Set(records.map((r) => `${r.batch_id}#${r.leaf_index}`)).size === records.length, 'two records share a place in a batch');
must(lease.filter((l) => l.name === 'batch').length <= 1, 'more than one lease row');

// The logs: who worked when.
const lines = [];
LOGS.forEach((file, i) => {
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text.startsWith('{')) continue;
    try { const l = JSON.parse(text); lines.push({ ...l, who: i }); } catch { /* not a log line */ }
  }
});
lines.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
const worked = [0, 0];
let holder = null;
let turns = 0;
for (const l of lines) {
  if (l.msg === 'worker holds the lease') { holder = l.who; turns++; }
  if (l.msg === 'batch sealed' || l.msg === 'batch anchored') {
    worked[l.who]++;
    must(holder === l.who, `instance ${l.who + 1} worked at ${l.ts} while instance ${holder === null ? '?' : holder + 1} held the lease`);
  }
}
const sealedLines = lines.filter((l) => l.msg === 'batch sealed').length;
if (LOGS.length === 2) must(sealedLines === batches.length, `${sealedLines} "batch sealed" lines for ${batches.length} batches`);
for (const f of failures.slice(0, 20)) console.error(`FAIL ${f}`);
console.log(`two instances on ${SCHEMA}: ${batches.length} batches, ${anchors.length} anchor transactions, ${attempts.length} recorded attempts, ${records.length} records in ${new Set(records.map((r) => r.batch_id)).size} batches; `
  + `the lease changed hands ${Math.max(0, turns - 1)} time(s), instance 1 did ${worked[0]} steps and instance 2 ${worked[1]}; ${failures.length === 0 ? 'every batch sealed once and broadcast once' : `${failures.length} thing(s) not as required`}`);
process.exit(failures.length === 0 ? 0 : 1);
