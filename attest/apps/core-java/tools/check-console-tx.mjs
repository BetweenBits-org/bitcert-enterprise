/**
 * The console's transaction view, on transactions the node really has — the
 * part of `GET /v1/console/tx/:txid` that the comparison run cannot reach,
 * because its seeded transactions were never broadcast.
 *
 *   node apps/core-java/tools/check-console-tx.mjs --java http://127.0.0.1:8790 --ref http://127.0.0.1:8791 \
 *        --java-env apps/core-java/.env.dev --ref-env apps/core-java/.env.ref
 *
 * Both servers running on the seeded test schemas (tools/seed-reference.mjs).
 * What it does:
 *
 *  1. ONE real inscription, through the Java service's console route
 *     (`POST /v1/console/attestations/inscribe`, signed in as the seeded
 *     console account): a document of a few dozen bytes, a commit and a
 *     reveal from the wallet `attest-java`. The answer has to be the console's
 *     shape — the record as the store holds it, with the month's allowance —
 *     and the record an inscription (D-08: `submitted`, no batch).
 *  2. Both transactions are in the node's mempool. The Java service's view of
 *     each is held to what the node itself says (`getmempoolentry`).
 *  3. The record is copied into the reference's schema, so that the reference
 *     owns the same anchor, and the reference is asked for the same two
 *     transactions: the two services' answers have to be the same, field for
 *     field. (The mempool is the node's, not a wallet's — which is why this
 *     path can be compared and the next one cannot.)
 *  4. A transaction the wallet holds in a block (its funding), read through
 *     the Java service and held to what the wallet itself says
 *     (`gettransaction`). For this one row is written into the Java schema
 *     that claims that transaction as an anchor of the console's
 *     organisation, and removed again. The reference of the comparison run
 *     names a wallet it does not have, so this path is the Java service's alone.
 *
 * Read-only towards the node but for the one inscription. Only stonehash_test_
 * schemas, only the wallet `attest-java`; the reference is never asked to
 * inscribe. No credential is printed.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchange } from '../parity/http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const JAVA = arg('--java'); const REF = arg('--ref'); const JAVA_ENV = arg('--java-env'); const REF_ENV = arg('--ref-env');
if (!JAVA || !REF || !JAVA_ENV || !REF_ENV) { console.error('usage: node check-console-tx.mjs --java <url> --ref <url> --java-env <env file> --ref-env <env file>'); process.exit(2); }
const readEnv = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.indexOf('=') > 0).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const javaEnv = readEnv(JAVA_ENV); const refEnv = readEnv(REF_ENV);
const schemaOf = (e) => new URL(e.STONEHASH_DB_URL).pathname.replace(/^\//, '');
const J = schemaOf(javaEnv); const R = schemaOf(refEnv);
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(J) || !TEST.test(R) || J === R) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
if (javaEnv.BITCOIND_WALLET !== 'attest-java') { console.error('refusing: the Java service must be on the wallet attest-java'); process.exit(1); }

const failures = [];
const check = (what, ok, found) => { if (!ok) failures.push(`${what}${found === undefined ? '' : `: ${typeof found === 'string' ? found : JSON.stringify(found)}`}`); };
const AUTH = `Basic ${Buffer.from(`${javaEnv.BITCOIND_USER ?? ''}:${javaEnv.BITCOIND_PASSWORD ?? ''}`).toString('base64')}`;
async function rpc(method, params = [], wallet = '') {
  const res = await fetch(javaEnv.BITCOIND_URL.replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: AUTH }, body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }) });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`), { rpc: j.error.code });
  return j.result;
}
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(javaEnv.STONEHASH_DB_URL);
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const seed = JSON.parse(fs.readFileSync(path.resolve(HERE, '../parity/seed.json'), 'utf8')).console;
const json = (r) => JSON.parse(r.body.toString('utf8'));
const signIn = async (base, address) => {
  const r = await exchange(base, { method: 'POST', target: '/v1/console/login', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': address }, body: { email: seed.account.email, password: seed.account.password } });
  const cookie = (r.headers['set-cookie'] ?? [])[0];
  if (r.status !== 200 || !cookie) throw new Error(`could not sign in to ${base}: ${r.status}`);
  return { Cookie: cookie.split(';')[0] };
};
const tx = async (base, session, txid) => { const r = await exchange(base, { target: `/v1/console/tx/${txid}`, headers: session }); return { status: r.status, body: json(r) }; };

let synthetic = null; let copied = null;
try {
  const before = await rpc('getbalances', [], 'attest-java');
  const [javaSession, refSession] = [await signIn(JAVA, '198.51.100.250'), await signIn(REF, '198.51.100.250')];

  // 1. One real inscription, through the console.
  const document = `check-console-tx ${new Date().toISOString()} ${randomBytes(8).toString('hex')}`;
  const made = await exchange(JAVA, { method: 'POST', target: '/v1/console/attestations/inscribe', headers: { ...javaSession, 'Content-Type': 'text/plain' }, body: document });
  const row = json(made);
  check('the console inscribes: 201', made.status === 201, `${made.status} ${made.body.toString('utf8').slice(0, 300)}`);
  if (made.status !== 201) throw new Error('nothing was inscribed');
  const digest = createHash('sha256').update(document).digest('hex');
  const stored = (await q(`SELECT * FROM \`${J}\`.attestations WHERE id = ?`, [row.id]))[0];
  delete stored.rowseq;
  check('the answer is the record as the store holds it, with the allowance', JSON.stringify({ ...stored, quota: row.quota }) === JSON.stringify(row), { keys: Object.keys(row) });
  check('the record is an inscription of that document', row.kind === 'inscription' && row.leaf_bytes === digest && row.content_type === 'text/plain' && row.body_length === document.length && row.product === 'attest');
  check('D-08: submitted, and in no batch', row.status === 'submitted' && row.batch_id === null && row.leaf_index === null, [row.status, row.batch_id, row.leaf_index]);
  check('the allowance counts it', Number.isInteger(row.quota?.used) && row.quota.limit === Number(javaEnv.CONSOLE_MONTHLY_QUOTA ?? 1000) && row.quota.remaining === Math.max(0, row.quota.limit - row.quota.used), row.quota);
  const again = await exchange(JAVA, { method: 'POST', target: '/v1/console/attestations/inscribe', headers: { ...javaSession, 'Content-Type': 'text/plain' }, body: document });
  check('the same document again is refused before a coin moves', again.status === 409 && json(again).error === 'duplicate_digest', `${again.status} ${again.body.toString('utf8').slice(0, 200)}`);

  // 2. Both transactions wait in the mempool: the Java service's view against the node's own.
  const views = {};
  for (const [name, txid] of [['reveal', row.reveal_txid], ['commit', row.commit_txid]]) {
    let entry;
    try { entry = await rpc('getmempoolentry', [txid]); } catch (e) { throw new Error(`the ${name} is not in the mempool (${e.message}) — a block may have arrived in between; run again`); }
    const view = await tx(JAVA, javaSession, txid);
    views[name] = view;
    const want = { txid, network: 'regtest', backend: 'bitcoind:regtest', ...(javaEnv.EXPLORER_BASE_URL ? { explorer_url: `${javaEnv.EXPLORER_BASE_URL.replace(/\/+$/, '')}/tx/${txid}` } : {}),
      state: 'mempool', vsize: entry.vsize, weight: entry.weight, fee_sats: Math.round(entry.fees.base * 1e8), seen_at: new Date(entry.time * 1000).toISOString() };
    check(`the ${name} as the Java service sees it is what the node says`, view.status === 200 && JSON.stringify(view.body) === JSON.stringify(want), { java: view.body, node: want });
  }

  // 3. The same record in the reference's schema, and the reference's view of the same two transactions.
  const cols = (await q('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [J, 'attestations'])).map((r) => r.c).filter((c) => c !== 'rowseq').map((c) => `\`${c}\``).join(', ');
  await q(`INSERT INTO \`${R}\`.attestations (${cols}) SELECT ${cols} FROM \`${J}\`.attestations WHERE id = ?`, [row.id]);
  copied = row.id;
  for (const [name, txid] of [['reveal', row.reveal_txid], ['commit', row.commit_txid]]) {
    const view = await tx(REF, refSession, txid);
    check(`the ${name}: the reference and the Java service answer the same`, view.status === views[name].status && JSON.stringify(view.body) === JSON.stringify(views[name].body), { reference: view.body, java: views[name].body });
  }
  const stranger = await tx(JAVA, javaSession, createHash('sha256').update(document).digest('hex'));
  check('a transaction id that anchors nothing of the organisation is not looked up', stranger.status === 404 && stranger.body.error === 'not_found', stranger);

  // 4. A transaction the wallet holds in a block, through the Java service, against the wallet's own answer.
  const held = (await rpc('listtransactions', ['*', 200], 'attest-java')).filter((t) => t.confirmations > 0 && t.category === 'receive').at(-1);
  if (!held) throw new Error('the wallet holds no confirmed transaction to read');
  synthetic = randomUUID();
  await q(`INSERT INTO \`${J}\`.attestations (id, org_id, leaf_bytes, content_type, descriptor, status, created_at, source, kind, commit_txid, product)
           VALUES (?, ?, ?, NULL, ?, 'submitted', ?, 'api', 'inscription', ?, 'attest')`,
    [synthetic, seed.org.id, createHash('sha256').update(`check-console-tx: claims ${held.txid}`).digest('hex'), JSON.stringify({ tool: 'check-console-tx', note: 'claims a wallet transaction, to read the wallet path; removed afterwards' }), new Date().toISOString(), held.txid]);
  const inBlock = await tx(JAVA, javaSession, held.txid.toUpperCase());
  const wallet = await rpc('gettransaction', [held.txid, true, true], 'attest-java');
  const want = { txid: held.txid, network: 'regtest', backend: 'bitcoind:regtest', ...(javaEnv.EXPLORER_BASE_URL ? { explorer_url: `${javaEnv.EXPLORER_BASE_URL.replace(/\/+$/, '')}/tx/${held.txid}` } : {}),
    state: 'confirmed', confirmations: inBlock.body.confirmations, block_hash: wallet.blockhash, block_height: wallet.blockheight, block_time: new Date(wallet.blocktime * 1000).toISOString(), size_bytes: wallet.hex.length / 2 };
  check('a transaction in a block as the Java service sees it is what the wallet says', inBlock.status === 200 && JSON.stringify(inBlock.body) === JSON.stringify(want)
    && inBlock.body.confirmations >= 1 && inBlock.body.confirmations <= wallet.confirmations, { java: inBlock.body, wallet: { ...want, confirmations: wallet.confirmations } });

  const after = await rpc('getbalances', [], 'attest-java');
  const sat = (b) => Math.round((b.mine.trusted + b.mine.untrusted_pending + b.mine.immature) * 1e8);
  const fees = views.reveal.body.fee_sats + views.commit.body.fee_sats;
  console.log(`inscribed ${document.length} bytes as ${row.id}: commit ${row.commit_txid} (${views.commit.body.vsize} vB, ${views.commit.body.fee_sats} sat), reveal ${row.reveal_txid} (${views.reveal.body.vsize} vB, ${views.reveal.body.fee_sats} sat)`);
  console.log(`the wallet attest-java: ${sat(before)} sat before, ${sat(after)} sat after (${sat(before) - sat(after)} sat less; the two fees are ${fees} sat)`);
  console.log(`in a block, read through the wallet: ${held.txid} at height ${wallet.blockheight}, ${inBlock.body.confirmations} confirmations`);
} catch (e) {
  failures.push(e.message);
} finally {
  if (synthetic) await q(`DELETE FROM \`${J}\`.attestations WHERE id = ?`, [synthetic]);
  if (copied) await q(`DELETE FROM \`${R}\`.attestations WHERE id = ?`, [copied]);
  await conn.end();
}
for (const f of failures) console.log(`FAIL ${f.slice(0, 1500)}`);
console.log(failures.length === 0 ? 'the console\'s transaction view: the mempool path is the same through both services and as the node says; the wallet path is as the wallet says' : `${failures.length} not as expected`);
process.exit(failures.length === 0 ? 0 : 1);
