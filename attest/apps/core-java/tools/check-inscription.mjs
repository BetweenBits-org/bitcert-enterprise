/**
 * Real inscriptions, end to end, through a running server whose worker is
 * on: three documents in through the API — text, a small binary, and one a
 * little over 520 bytes so that its body spans two pushes — each onto the
 * regtest chain in a commit and a reveal, confirmed, its bundle handed to the
 * published TypeScript verifier (which shares no code with the producer), and
 * the document read back out of the reveal's witness as the node holds it.
 *
 *   node apps/core-java/tools/check-inscription.mjs --base http://127.0.0.1:8790 --env apps/core-java/.env.dev-worker [--out result.json] [--reference]
 *
 * The env file is the one the server was started with: it names the node,
 * the wallet (attest-java, no other) and the test schema (stonehash_test_
 * only) whose rows are read afterwards. An inscription costs a commit and a
 * reveal: the documents are small, and there are three.
 *
 * What is required of either service: 201 and `submitted` at once; then
 * `confirmed`; the bundle verifies in witness mode (links A and C1; there is
 * no tree, so B is skipped) both before and after the block; what the bundle
 * says about its block is what the node says; the reveal's first output is
 * OP_RETURN <sha256 of the document>; the witness holds the document, split
 * at 520 bytes, under the NUMS internal key; and a refusal by the node (every
 * coin of the wallet held back) is answered as the node worded it and leaves
 * no record and no transaction.
 *
 * What is required of the Java service besides (docs/JAVA-INTENDED-DIFFERENCES.md,
 * D-08): an inscription is never swept into a batch — the status only goes
 * `submitted` → `confirmed`, `batch_id` and `leaf_index` stay null, no batch
 * row is made, and `bundle_available` is true from the first answer. With
 * `--reference` those points are recorded instead of required: the reference
 * service does sweep its inscriptions. `--out` writes what was found in a
 * shape two runs can be compared in (tools/compare-inscription.mjs).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import { extractWitnessItems, parseEnvelope, verifyBundle } from '../../../packages/attest-verify/src/index.ts';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const BASE = arg('--base');
const ENV_FILE = arg('--env');
const OUT = arg('--out');
const REFERENCE = process.argv.includes('--reference');
if (!BASE || !ENV_FILE) { console.error('usage: node check-inscription.mjs --base <url> --env <env file> [--out file] [--reference]'); process.exit(2); }
const env = {};
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i < 1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const dbUrl = new URL(env.STONEHASH_DB_URL);
const SCHEMA = dbUrl.pathname.replace(/^\//, '');
if (!/^stonehash_test_[a-z0-9_]+$/.test(SCHEMA)) { console.error('refusing: the env file must name a stonehash_test_ schema'); process.exit(1); }
const WALLET = env.BITCOIND_WALLET;
if (WALLET !== 'attest-java') { console.error('refusing: this check uses the wallet attest-java and no other'); process.exit(1); }
const FLUSH_MS = Number(env.BATCH_FLUSH_INTERVAL_MS ?? 5000);
const TICK_MS = Number(env.WORKER_TICK_MS ?? 2000);
if (!(TICK_MS > 0)) { console.error('refusing: the server of this env file has no worker (WORKER_TICK_MS=0), so nothing would be confirmed'); process.exit(1); }
const NUMS = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

const sha256 = (b) => createHash('sha256').update(b).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sat = (btc) => Math.round(btc * 1e8);
const failures = [];
const must = (ok, what) => { if (!ok) failures.push(what); return ok; };
let address = 0;
const from = () => `10.78.${Math.floor(address / 250)}.${1 + (address++ % 250)}`;

/** One request, with exactly the headers given: a document goes out as its bytes, with a content type or with none. */
function send(method, path, { key, headers = {}, body } = {}) {
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const u = new URL(BASE + path);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: { 'x-forwarded-for': from(), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers, ...(payload ? { 'content-length': payload.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}
const rpc = async (method, params = [], wallet = '') => {
  const res = await fetch((env.BITCOIND_URL || 'http://127.0.0.1:18443').replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.BITCOIND_USER ?? ''}:${env.BITCOIND_PASSWORD ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
};
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({ host: dbUrl.hostname, port: dbUrl.port ? Number(dbUrl.port) : 3306, user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: SCHEMA, charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];

// ── before ──────────────────────────────────────────────────────────────────

const meta = await send('GET', '/v1/meta');
must(meta.status === 200 && meta.json?.inscription?.enabled === true, `/v1/meta does not say inscription is enabled: ${meta.text.slice(0, 120)}`);
const walletBefore = await rpc('getbalances', [], WALLET);
const txcountBefore = (await rpc('getwalletinfo', [], WALLET)).txcount;
const batchesBefore = (await q('SELECT COUNT(*) AS n FROM batches'))[0].n;
const tag = hex(randomBytes(3));
const signup = await send('POST', '/v1/sandbox/keys', { headers: { 'content-type': 'application/json' }, body: { slug: `insc-${tag}`, name: 'Inscription check', label: 'check-inscription' } });
if (signup.status !== 201) { console.error(`could not make an organisation: ${signup.status} ${signup.text.slice(0, 200)}`); process.exit(1); }
const KEY = signup.json.api_key;
const ORG = signup.json.org.id;

// ── a refusal by the node: every coin held back ─────────────────────────────

const refusal = {};
{
  const coins = (await rpc('listunspent', [0], WALLET)).map((c) => ({ txid: c.txid, vout: c.vout }));
  await rpc('lockunspent', [false, coins], WALLET);
  let r;
  try {
    r = await send('POST', '/v1/attestations/inscribe', { key: KEY, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`inscription check ${tag}: the wallet cannot pay for this one`) });
  } finally {
    await rpc('lockunspent', [true, coins], WALLET);
  }
  Object.assign(refusal, { status: r.status, error: r.json?.error ?? null, message: r.json?.message ?? r.text.slice(0, 120) });
  must(r.status === 500 && r.json?.error === 'internal' && r.json?.message === 'bitcoind rpc -4: Insufficient funds', `with every coin held back: ${r.status} ${r.text.slice(0, 160)}`);
  const list = await send('GET', '/v1/attestations', { key: KEY });
  must(list.status === 200 && list.json?.data?.length === 0, `the refused inscription left a record: ${list.text.slice(0, 160)}`);
  must((await rpc('getwalletinfo', [], WALLET)).txcount === txcountBefore, 'the refused inscription left a transaction in the wallet');
  must((await rpc('listlockunspent', [], WALLET)).length === 0, 'coins are still held back');
}

// ── three documents, one after another ──────────────────────────────────────

const documents = [
  { name: 'text', contentType: 'text/plain; charset=utf-8', body: Buffer.from(`StoneHash inscription check ${tag}.\nThis text is on the chain itself: 원문이 체인에 있습니다.\n`) },
  // Every byte value once, and no content type at all: recorded as application/octet-stream.
  { name: 'small binary', contentType: null, body: Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(44)]) },
  // 600 bytes: one push of 520 and one of 80.
  { name: 'over one push', contentType: 'application/pdf', body: Buffer.concat([Buffer.from(`%PDF-1.4 inscription check ${tag} `), Buffer.alloc(600, 0x2e)]).subarray(0, 600) },
];
const shape = (o) => (o === null || o === undefined ? 'null' : Array.isArray(o) ? `[${o.map(shape).join(',')}]` : typeof o === 'object'
  ? `{${Object.entries(o).map(([k, v]) => `${k}:${shape(v)}`).join(',')}}` : typeof o === 'number' ? 'number' : typeof o === 'boolean' ? 'boolean'
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o) ? 'time' : /^[0-9a-f]{64}$/.test(o) ? 'hex64' : /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(o) ? 'uuid' : /^[0-9a-f]+$/.test(o) ? 'hex' : 'text');
const linksOf = (bundle) => {
  const report = verifyBundle(bundle);
  return { verified: report.verified === true, witnessMode: report.witnessMode === true, A: report.links.A, B: report.links.B, C1: report.links.C1, C2: report.links.C2, network: report.network,
    failed: report.checks.filter((c) => c.state === 'fail').map((c) => c.id) };
};
const good = (l) => l.verified && l.witnessMode && l.A === 'pass' && l.C1 === 'pass' && l.B === 'skip' && l.network === 'regtest';
const settle = Math.max(2 * FLUSH_MS + 2 * TICK_MS, 4000);

for (const d of documents) {
  d.leaf = hex(sha256(d.body));
  const r = await send('POST', '/v1/attestations/inscribe', { key: KEY, headers: d.contentType ? { 'content-type': d.contentType } : {}, body: d.body });
  if (!must(r.status === 201 && r.json?.id, `${d.name}: ${r.status} ${r.text.slice(0, 200)}`)) continue;
  d.id = r.json.id;
  d.first = r.json;
  must(r.json.status === 'submitted' && r.json.leaf_bytes === d.leaf && r.json.content_type === (d.contentType ?? 'application/octet-stream'),
    `${d.name}: first answered ${r.json.status}, ${r.json.content_type}, leaf ${String(r.json.leaf_bytes).slice(0, 12)}…`);
  // The bundle exists at once — the reveal transaction is the whole proof — and verifies before any block.
  const early = await send('GET', `/v1/attestations/${d.id}/bundle`, { key: KEY });
  d.early = { status: early.status, links: early.status === 200 ? linksOf(early.json) : null, confirmed: early.json?.anchor?.confirmed !== undefined };
  must(early.status === 200 && good(d.early.links), `${d.name}: the bundle before the block: ${early.status} ${JSON.stringify(d.early.links)}`);

  // Watched closely until it is confirmed, and then for as long as a batcher would need to take it.
  d.trail = []; d.batchTrail = []; d.availableTrail = [];
  const note = (trail, v) => { if (trail.at(-1) !== v) trail.push(v); };
  note(d.trail, r.json.status); note(d.batchTrail, r.json.batch_id === null ? 'no batch' : 'in a batch'); note(d.availableTrail, r.json.bundle_available);
  let confirmedAt = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const v = await send('GET', `/v1/attestations/${d.id}`, { key: KEY });
    if (v.status === 200) {
      note(d.trail, v.json.status); note(d.batchTrail, v.json.batch_id === null ? 'no batch' : 'in a batch'); note(d.availableTrail, v.json.bundle_available);
      if (v.json.status === 'confirmed') confirmedAt ??= Date.now(); else confirmedAt = null;
      d.last = v.json;
    }
    if (confirmedAt !== null && Date.now() - confirmedAt >= settle) break;
    await sleep(30);
  }
  must(d.trail.at(-1) === 'confirmed', `${d.name}: did not reach confirmed: ${d.trail.join(' → ')}`);
  if (!REFERENCE) {
    must(d.trail.join(' → ') === 'submitted → confirmed', `${d.name}: the status went ${d.trail.join(' → ')}`);
    must(d.batchTrail.join() === 'no batch' && d.last?.batch_id === null && d.last?.leaf_index === null, `${d.name}: it was given a batch (${d.batchTrail.join(' → ')})`);
    must(d.availableTrail.join() === 'true', `${d.name}: bundle_available went ${d.availableTrail.join(' → ')}`);
  }
}

// ── bundles out, under the independent verifier; and what the chain holds ───

let verified = 0; let readBack = 0;
const fees = { commit: 0, reveal: 0, batchAnchors: 0, transactions: 0 };
const heights = new Set();
for (const d of documents.filter((x) => x.id)) {
  const b = await send('GET', `/v1/attestations/${d.id}/bundle`, { key: KEY });
  if (!must(b.status === 200 && b.json?.schema === 'bitcert-proof-bundle/v1', `bundle of ${d.name}: ${b.status} ${b.text.slice(0, 160)}`)) continue;
  d.bundle = b.json;
  d.links = linksOf(b.json);
  verified += must(good(d.links), `bundle of ${d.name} under the verifier: ${JSON.stringify(d.links)}`) ? 1 : 0;
  must(b.json.record.leaf_bytes === d.leaf && b.json.anchor.op_return_payload_hex === d.leaf && b.json.merkle === undefined, `bundle of ${d.name}: its payload is not the document's digest alone`);
  const env0 = b.json.anchor.witness_envelope ?? {};
  must(env0.input_index === 0 && env0.content_type === (d.contentType ?? 'application/octet-stream') && env0.protocol_tag === 'bcrt', `bundle of ${d.name}: witness envelope ${JSON.stringify(env0)}`);

  // The node's copy of the reveal, from the block it is in.
  const txid = b.json.anchor.reveal_txid;
  const inWallet = await rpc('gettransaction', [txid], WALLET).catch((e) => ({ error: e.message }));
  if (!must(!inWallet.error && inWallet.confirmations >= 1, `${d.name}: the node says of the reveal: ${inWallet.error ?? `${inWallet.confirmations} confirmations`}`)) continue;
  const tx = await rpc('getrawtransaction', [txid, true, inWallet.blockhash]);
  heights.add(inWallet.blockheight);
  const c = b.json.anchor.confirmed ?? {};
  d.confirmedKeys = Object.keys(c).join(',');
  d.blockAgrees = c.block_hash === inWallet.blockhash && c.block_height === inWallet.blockheight;
  must(tx.hex === b.json.anchor.reveal_tx_hex, `${d.name}: the bundle's reveal is not the transaction in the block`);
  if (!REFERENCE) must(d.blockAgrees, `${d.name}: the bundle says block ${c.block_height} ${String(c.block_hash).slice(0, 12)}…, the node says ${inWallet.blockheight} ${inWallet.blockhash.slice(0, 12)}…`);
  must(tx.vout[0].value === 0 && tx.vout[0].scriptPubKey.hex === `6a20${d.leaf}` && sat(tx.vout[1].value) === 1000 && tx.vout.length === 2, `${d.name}: the reveal's outputs are not the digest and the 1000-satoshi return`);
  const witness = tx.vin[0].txinwitness ?? [];
  const envelope = witness.length === 3 ? parseEnvelope(Uint8Array.from(Buffer.from(witness[1], 'hex'))) : null;
  const back = envelope !== null && Buffer.from(envelope.body).equals(d.body) && Buffer.from(envelope.contentType).toString('utf8') === (d.contentType ?? 'application/octet-stream')
    && Buffer.from(envelope.protocolTag).toString('utf8') === 'bcrt';
  readBack += must(back, `${d.name}: the document in the block's witness is not the document that was sent`) ? 1 : 0;
  // The same through the verifier's own reader of the bundle.
  const fromBundle = parseEnvelope(extractWitnessItems(b.json.anchor.reveal_tx_hex, 0)[1]);
  must(Buffer.from(fromBundle.body).equals(d.body), `${d.name}: the document in the bundle's witness is not the document that was sent`);
  must(witness.length === 3 && witness[0].length === 128 && witness[2] === `c${witness[2][1]}${NUMS}` && ['0', '1'].includes(witness[2][1]), `${d.name}: the witness is not [signature, script, control block under the NUMS key]`);
  // The pushes of the body: 520 bytes each, the rest in the last.
  const script = Buffer.from(witness[1] ?? '', 'hex');
  d.pushes = Math.ceil(d.body.length / 520);
  must(script.length > d.body.length && (d.body.length <= 520 || script.includes(Buffer.concat([Buffer.from([0x4d, 0x08, 0x02]), d.body.subarray(0, 520)]))), `${d.name}: the body is not split at 520 bytes`);

  // What it cost: the commit's fee as the wallet paid it, and what the reveal left to the miner.
  const commitTxid = b.json.commit_txid;
  must(commitTxid === tx.vin[0].txid, `${d.name}: the reveal does not spend the commit the bundle names`);
  const commit = await rpc('gettransaction', [commitTxid, true, true], WALLET).catch((e) => ({ error: e.message }));
  if (must(!commit.error, `${d.name}: the wallet does not know the commit: ${commit.error}`)) {
    const funded = commit.decoded.vout[tx.vin[0].vout];
    must(funded.scriptPubKey.hex.startsWith('5120') && funded.scriptPubKey.hex.length === 68, `${d.name}: the commit output is not a taproot output`);
    d.commitFee = -sat(commit.fee);
    d.revealFee = sat(funded.value) - 1000;
    d.revealVsize = tx.vsize;
    must(d.revealFee === tx.vsize * 2, `${d.name}: the reveal pays ${d.revealFee} sat for ${tx.vsize} vB; 2 sat/vB was funded`);
    fees.commit += d.commitFee; fees.reveal += d.revealFee; fees.transactions += 2;
  }
}

// ── the rows ────────────────────────────────────────────────────────────────

const ids = documents.map((d) => d.id).filter(Boolean);
const atts = ids.length ? await q(`SELECT * FROM attestations WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY rowseq`, ids) : [];
const batchIds = [...new Set(atts.map((a) => a.batch_id).filter(Boolean))];
const proofs = ids.length ? await q(`SELECT attestation_id FROM merkle_proofs WHERE attestation_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
const anchors = batchIds.length ? await q(`SELECT txid, status FROM anchor_txs WHERE batch_id IN (${batchIds.map(() => '?').join(',')})`, batchIds) : [];
const batchesMade = (await q('SELECT COUNT(*) AS n FROM batches'))[0].n - batchesBefore;
const others = (await q('SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND id NOT IN (?)', [ORG, ids.length ? ids : ['']]))[0].n;
await conn.end();
for (const x of anchors) {
  const t = await rpc('gettransaction', [x.txid], WALLET).catch(() => null);
  if (t) { fees.batchAnchors += -sat(t.fee); fees.transactions += 1; if (t.blockheight) heights.add(t.blockheight); }
}
const nulls = (row, skip = []) => Object.keys(row).filter((k) => !skip.includes(k)).map((k) => `${k}:${row[k] === null ? 'null' : typeof row[k] === 'number' ? 'number' : 'text'}`).join(' ');
must(atts.length === documents.length && others === 0, `${atts.length} of ${documents.length} records are in the store, and ${others} others of this organisation`);
for (const a of atts) {
  const d = documents.find((x) => x.id === a.id);
  d.row = nulls(a, ['rowseq']);
  d.rowBlock = a.block_height !== null && a.block_hash !== null;
  must(a.kind === 'inscription' && a.status === 'confirmed' && a.leaf_bytes === d.leaf && a.body_length === d.body.length && a.protocol_tag === 'bcrt' && a.source === 'api'
    && a.content_type === (d.contentType ?? 'application/octet-stream') && a.descriptor === '{}' && a.expires_at === null && a.statement === null
    && a.reveal_txid === d.bundle?.anchor.reveal_txid && a.commit_txid === d.bundle?.commit_txid && a.reveal_tx_hex === d.bundle?.anchor.reveal_tx_hex, `${d.name}: the row is not what was inscribed`);
  if (!REFERENCE) must(a.batch_id === null && a.leaf_index === null && d.rowBlock && a.confirmations >= 1, `${d.name}: the row has batch ${a.batch_id}, block ${a.block_height}`);
}
if (!REFERENCE) must(batchesMade === 0 && proofs.length === 0 && anchors.length === 0, `${batchesMade} batches, ${proofs.length} proofs and ${anchors.length} anchor transactions were made for inscriptions`);

const walletAfter = await rpc('getbalances', [], WALLET);
const total = fees.commit + fees.reveal + fees.batchAnchors;
const done = documents.filter((d) => d.id);
const summary = {
  refusal,
  documents: done.map((d) => ({
    name: d.name, bytes: d.body.length, pushes: d.pushes, contentTypeSent: d.contentType,
    first: { shape: shape(d.first), status: d.first.status, batch_id: d.first.batch_id === null ? null : 'uuid', leaf_index: d.first.leaf_index === null ? null : 'number', bundle_available: d.first.bundle_available },
    early: d.early, statusTrail: d.trail, batchTrail: d.batchTrail, availableTrail: d.availableTrail,
    last: d.last ? { shape: shape(d.last), status: d.last.status, batch_id: d.last.batch_id === null ? null : 'uuid', leaf_index: d.last.leaf_index === null ? null : 'number', bundle_available: d.last.bundle_available } : null,
    bundle: d.bundle ? shape({ ...d.bundle, record: { ...d.bundle.record, descriptor: Object.keys(d.bundle.record.descriptor ?? {}).join(',') } }) : null,
    links: d.links ?? null, confirmedKeys: d.confirmedKeys ?? null, blockAgrees: d.blockAgrees ?? null, row: d.row ?? null, rowHasItsBlock: d.rowBlock ?? null,
    revealVsize: d.revealVsize ?? null, commitFee: d.commitFee ?? null, revealFee: d.revealFee ?? null,
  })),
  rows: { batchesMade, proofs: proofs.length, batchAnchors: anchors.length },
  verified, readBack,
};
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify({ base: BASE, schema: SCHEMA, reference: REFERENCE, summary, cost: { fees, total, blocks: [...heights].sort(), trustedBefore: sat(walletBefore.mine.trusted), trustedAfter: sat(walletAfter.mine.trusted) } }, null, 1)}\n`);
for (const f of failures.slice(0, 25)) console.error(`FAIL ${f}`);
const trails = [...new Set(done.map((d) => d.trail.join(' → ')))];
console.log(`inscription through ${BASE} (${SCHEMA}): ${done.length} documents (${done.map((d) => d.body.length).join(', ')} bytes; ${done.map((d) => d.pushes).join(', ')} pushes) — `
  + `${trails.join(' | ')}; ${batchesMade} batches made, bundle_available ${[...new Set(done.map((d) => d.availableTrail.join(' → ')))].join(' | ')}; `
  + `${verified} bundles pass the TypeScript verifier (witness mode: A, C1); ${readBack} documents read back from the block's witness equal what was sent; `
  + `a refusal by the node answered ${refusal.status} "${refusal.message}" and left nothing; ${fees.transactions} transactions, ${total} sat in fees, blocks ${[...heights].sort().join(', ')}; `
  + `${failures.length === 0 ? 'everything as required' : `${failures.length} thing(s) not as required`}`);
process.exit(failures.length === 0 ? 0 : 1);
