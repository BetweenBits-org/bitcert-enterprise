/**
 * Real anchoring, end to end, through a running server whose batch worker is
 * on: records in through the API, the worker seals, anchors on the regtest
 * chain and confirms, bundles out — and every bundle is handed to the
 * published TypeScript verifier, which shares no code with the producer.
 *
 *   node apps/core-java/tools/check-anchoring.mjs --base http://127.0.0.1:8790 --env apps/core-java/.env.dev-worker [--out result.json]
 *
 * The env file is the one the server was started with: it names the node,
 * the wallet and the test schema (stonehash_test_ only) whose rows are read
 * afterwards. Works the same against the Java service and the reference one;
 * `--out` writes what was found in a shape two runs can be compared in
 * (tools/compare-anchoring.mjs).
 *
 * What is required: every record reaches `confirmed`; every bundle verifies
 * (links A, B and C1); what a bundle says about its block is what the node
 * says about that transaction; a batch holds one organisation's records, at
 * most BATCH_MAX_LEAVES of them, in the order they arrived; each batch has
 * exactly one anchor transaction, carrying BC01(root, batch id).
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { verifyBundle } from '../../../packages/attest-verify/src/index.ts';
import { buildStatement, statementSigningInput } from '../../../packages/attest-verify/src/statement.ts';

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const BASE = arg('--base');
const ENV_FILE = arg('--env');
const OUT = arg('--out');
if (!BASE || !ENV_FILE) { console.error('usage: node check-anchoring.mjs --base <url> --env <env file> [--out file]'); process.exit(2); }
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
const MAX_LEAVES = Number(env.BATCH_MAX_LEAVES ?? 1024);

const sha256 = (b) => createHash('sha256').update(b).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const must = (ok, what) => { if (!ok) failures.push(what); return ok; };
let address = 0;
const from = () => `10.77.${Math.floor(address / 250)}.${1 + (address++ % 250)}`;
async function api(method, path, { key, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': from(), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}
const rpc = async (method, params = [], wallet = '') => {
  const res = await fetch((env.BITCOIND_URL || 'http://127.0.0.1:18443').replace(/\/$/, '') + (wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/'), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.BITCOIND_USER ?? ''}:${env.BITCOIND_PASSWORD ?? ''}`).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.code} ${j.error.message}`);
  return j.result;
};

// ── records in ──────────────────────────────────────────────────────────────

const tag = hex(randomBytes(3));
const org = async (letter) => {
  const r = await api('POST', '/v1/sandbox/keys', { body: { slug: `anch-${tag}-${letter}`, name: `Anchoring check ${letter}`, label: 'check-anchoring' } });
  if (r.status !== 201) throw new Error(`could not make organisation ${letter}: ${r.status} ${r.text.slice(0, 200)}`);
  return { letter, id: r.json.org.id, key: r.json.api_key };
};
const A = await org('a');
const B = await org('b');
const records = []; // { where, id, original, signed, publicId }
for (let i = 0; i < 6; i++) {
  const original = Buffer.from(`anchoring check ${tag}: document a${i}`);
  const r = await api('POST', '/v1/attestations', { key: A.key, body: { leaf_bytes: hex(sha256(original)), content_type: 'text/plain', descriptor: { n: i, run: tag } } });
  must(r.status === 201 && r.json.status === 'accepted', `org a record ${i}: ${r.status} ${r.text.slice(0, 160)}`);
  records.push({ where: 'a', id: r.json?.id, original, key: A.key });
}
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const signedStatement = (keyPair, original) => {
  const core = buildStatement({ documentSha256: hex(sha256(original)), contentType: 'application/pdf', keyId: 'check-anchoring-key',
    publicKeySpkiBase64: keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), issuedAt: new Date().toISOString() });
  const s = createSign('SHA256'); s.update(statementSigningInput(core));
  return { ...core, signature: s.sign({ key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
};
{
  const reg = await api('POST', '/v1/issuer-keys', { key: B.key, body: { public_key: spki, label: 'check-anchoring' } });
  must(reg.status === 201, `issuer key: ${reg.status} ${reg.text.slice(0, 160)}`);
  for (const [i, pair] of [[0, keys], [1, stranger]]) {
    const original = Buffer.from(`anchoring check ${tag}: signed document b${i}`);
    const r = await api('POST', '/v1/attestations/signed', { key: B.key, body: { statement: signedStatement(pair, original), descriptor: { signed: true } } });
    must(r.status === 201 && r.json.issuer_trust === (i === 0 ? 'registered' : 'unregistered'), `org b signed record ${i}: ${r.status} ${r.text.slice(0, 200)}`);
    records.push({ where: 'b', id: r.json?.id, original, key: B.key, signed: true, trust: r.json?.issuer_trust });
  }
  for (let i = 0; i < 2; i++) {
    const original = Buffer.from(`anchoring check ${tag}: document b${i}`);
    const r = await api('POST', '/v1/attestations', { key: B.key, body: { leaf_bytes: hex(sha256(original)) } });
    must(r.status === 201, `org b record ${i}: ${r.status} ${r.text.slice(0, 160)}`);
    records.push({ where: 'b', id: r.json?.id, original, key: B.key });
  }
}
for (let i = 0; i < 2; i++) {
  const original = Buffer.from(`anchoring check ${tag}: free-tier document ${i}`);
  const r = await api('POST', '/v1/public/anchors', { body: { sha256: hex(sha256(original)) } });
  must(r.status === 202 && r.json.status === 'accepted', `free-tier record ${i}: ${r.status} ${r.text.slice(0, 160)}`);
  records.push({ where: 'public', id: r.json?.id, original, free: true });
}

// ── the worker's turn ───────────────────────────────────────────────────────

const view = (r) => (r.free ? api('GET', `/v1/public/anchors/${r.id}`) : api('GET', `/v1/attestations/${r.id}`, { key: r.key }));
const seen = new Map();
const deadline = Date.now() + 120_000;
for (;;) {
  let waiting = 0;
  for (const r of records) {
    if (seen.get(r.id)?.at(-1) === 'confirmed') continue;
    const v = await view(r);
    const status = v.json?.status ?? `HTTP ${v.status}`;
    const trail = seen.get(r.id) ?? [];
    if (trail.at(-1) !== status) trail.push(status);
    seen.set(r.id, trail);
    if (status !== 'confirmed') waiting++;
  }
  if (waiting === 0 || Date.now() > deadline) break;
  await sleep(400);
}
for (const r of records) must(seen.get(r.id)?.at(-1) === 'confirmed', `${r.where} ${r.id} did not reach confirmed: ${seen.get(r.id)?.join(' → ')}`);
const ORDER = ['accepted', 'batched', 'submitted', 'confirmed'];
for (const r of records) {
  const trail = seen.get(r.id) ?? [];
  must(trail.every((s, i) => ORDER.includes(s) && (i === 0 || ORDER.indexOf(s) > ORDER.indexOf(trail[i - 1]))), `${r.where} ${r.id}: the status went ${trail.join(' → ')}`);
}

// ── bundles out, under the independent verifier; and what the chain says ────

const txids = new Map();
let verified = 0;
for (const r of records) {
  const b = r.free ? await api('GET', `/v1/public/anchors/${r.id}/bundle`) : await api('GET', `/v1/attestations/${r.id}/bundle`, { key: r.key });
  if (!must(b.status === 200 && b.json?.schema === 'bitcert-proof-bundle/v1', `bundle of ${r.where} ${r.id}: ${b.status} ${b.text.slice(0, 160)}`)) continue;
  const report = verifyBundle(b.json, { originalBytes: new Uint8Array(r.original) });
  const ok = report.verified === true && report.links.A === 'pass' && report.links.B === 'pass' && report.links.C1 === 'pass' && report.network === 'regtest';
  must(ok, `bundle of ${r.where} ${r.id} under the verifier: ${report.checks.map((c) => `${c.state} ${c.id}`).join(' | ')}`);
  verified += ok ? 1 : 0;
  must(b.json.record.preimage.scheme === (r.signed ? 'sha256-signed-statement/v1' : 'sha256-file'), `bundle of ${r.id}: scheme ${b.json.record.preimage.scheme}`);
  r.bundle = b.json;
  const txid = b.json.anchor.reveal_txid;
  if (!txids.has(txid)) txids.set(txid, await rpc('gettransaction', [txid, true, true], WALLET).catch((e) => ({ error: e.message })));
  const tx = txids.get(txid);
  const c = b.json.anchor.confirmed ?? {};
  must(!tx.error && tx.confirmations >= 1 && c.block_hash === tx.blockhash && c.block_height === tx.blockheight && tx.hex === b.json.anchor.reveal_tx_hex,
    `bundle of ${r.id}: says block ${c.block_height} ${String(c.block_hash).slice(0, 12)}…, the node says ${tx.error ?? `${tx.blockheight} ${String(tx.blockhash).slice(0, 12)}…`}`);
  must(!tx.error && tx.hex.includes(`6a35${b.json.anchor.op_return_payload_hex}`), `bundle of ${r.id}: the transaction does not carry the payload`);
}

// ── the rows ────────────────────────────────────────────────────────────────

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({ host: dbUrl.hostname, port: dbUrl.port ? Number(dbUrl.port) : 3306, user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: SCHEMA, charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const ids = records.map((r) => r.id).filter(Boolean);
const atts = await q(`SELECT * FROM attestations WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY rowseq`, ids);
const batchIds = [...new Set(atts.map((a) => a.batch_id).filter(Boolean))];
const batches = batchIds.length ? await q(`SELECT * FROM batches WHERE id IN (${batchIds.map(() => '?').join(',')})`, batchIds) : [];
const members = batchIds.length ? await q(`SELECT id, org_id, batch_id, leaf_index, rowseq, created_at, status FROM attestations WHERE batch_id IN (${batchIds.map(() => '?').join(',')}) ORDER BY batch_id, leaf_index`, batchIds) : [];
const proofs = batchIds.length ? await q(`SELECT * FROM merkle_proofs WHERE batch_id IN (${batchIds.map(() => '?').join(',')})`, batchIds) : [];
const anchors = batchIds.length ? await q(`SELECT * FROM anchor_txs WHERE batch_id IN (${batchIds.map(() => '?').join(',')})`, batchIds) : [];
const attempts = batchIds.length ? await q(`SELECT batch_id, attempt, txid, state FROM anchor_attempts WHERE batch_id IN (${batchIds.map(() => '?').join(',')})`, batchIds) : [];
const lease = await q('SELECT name, owner FROM worker_leases');
await conn.end();

must(atts.length === records.length, `${atts.length} of ${records.length} records are in the store`);
const nulls = (row, skip = []) => Object.keys(row).filter((k) => !skip.includes(k)).map((k) => `${k}:${row[k] === null ? 'null' : typeof row[k] === 'number' ? 'number' : 'text'}`).join(' ');
const shapes = { attestations: new Set(), batches: new Set(), merkle_proofs: new Set(), anchor_txs: new Set() };
for (const a of atts) {
  must(a.status === 'confirmed' && a.batch_id !== null && a.kind === 'digest', `record ${a.id} is ${a.status}`);
  shapes.attestations.add(`${a.source}/${a.statement === null ? 'unsigned' : `signed-${a.issuer_trust}`}: ${nulls(a, ['rowseq'])}`);
}
const sizes = [];
for (const b of batches) {
  const rows = members.filter((m) => m.batch_id === b.id);
  sizes.push(rows.length);
  must(b.status === 'confirmed' && b.leaf_count === rows.length && rows.length <= MAX_LEAVES && b.opened_at === b.sealed_at, `batch ${b.id}: ${b.status}, ${b.leaf_count} leaves for ${rows.length} records`);
  must(new Set(rows.map((m) => m.org_id)).size === 1, `batch ${b.id} holds more than one organisation's records`);
  must(rows.every((m, i) => m.leaf_index === i && (i === 0 || BigInt(m.rowseq) > BigInt(rows[i - 1].rowseq)) && (i === 0 || m.created_at >= rows[i - 1].created_at)),
    `batch ${b.id}: the leaf order is not the order the records arrived in`);
  const tx = anchors.filter((x) => x.batch_id === b.id);
  const payload = `42433031` + `01` + b.merkle_root + b.id.replace(/-/g, '');
  must(tx.length === 1 && tx[0].status === 'confirmed' && tx[0].txid === b.anchor_txid && tx[0].payload_hex === payload && tx[0].network === 'regtest'
    && tx[0].block_height !== null && tx[0].block_hash !== null && tx[0].confirmations >= 1 && tx[0].confirmed_at !== null,
    `batch ${b.id}: ${tx.length} anchor transaction(s), ${tx[0]?.status}`);
  shapes.batches.add(nulls(b));
  if (tx[0]) shapes.anchor_txs.add(nulls(tx[0]));
  for (const m of rows) {
    const p = proofs.find((x) => x.attestation_id === m.id);
    const depth = Math.ceil(Math.log2(rows.length));
    const compact = (s) => { try { return JSON.stringify(JSON.parse(s)) === s; } catch { return false; } };
    must(p && p.leaf_index === m.leaf_index && compact(p.siblings) && compact(p.directions) && JSON.parse(p.siblings).length === depth && JSON.parse(p.directions).length === depth
      && JSON.parse(p.siblings).every((h) => /^[0-9a-f]{64}$/.test(h)) && JSON.parse(p.directions).every((d) => d === 'left' || d === 'right'), `proof of ${m.id} in batch ${b.id}`);
    if (p) shapes.merkle_proofs.add(`${nulls(p)} | siblings ${rows.length <= 1 ? '[]' : '[hex64,…]'}`);
  }
}
// An organisation's batches, taken in the order they were sealed, are its records in the order they arrived.
for (const orgId of new Set(members.map((m) => m.org_id))) {
  const own = batches.filter((b) => members.some((m) => m.batch_id === b.id && m.org_id === orgId))
    .map((b) => members.filter((m) => m.batch_id === b.id)).sort((x, y) => (BigInt(x[0].rowseq) < BigInt(y[0].rowseq) ? -1 : 1));
  const flat = own.flat().map((m) => BigInt(m.rowseq));
  must(flat.every((v, i) => i === 0 || v > flat[i - 1]), `organisation ${orgId}: its batches do not follow the order its records arrived in`);
}
must(new Set(anchors.map((x) => x.txid)).size === batches.length, `${anchors.length} anchor transactions for ${batches.length} batches`);

const summary = {
  records: records.length, confirmed: atts.filter((a) => a.status === 'confirmed').length, bundlesVerified: verified,
  leavesInBatches: sizes.reduce((s, n) => s + n, 0), anchorsPerBatch: batches.length === 0 ? null : anchors.length / batches.length,
  statusTrails: [...new Set([...seen.values()].map((t) => t.filter((s) => s === 'accepted' || s === 'confirmed').join('→')))].sort(),
  shapes: Object.fromEntries(Object.entries(shapes).map(([k, v]) => [k, [...v].sort()])),
  bundleKeys: [...new Set(records.filter((r) => r.bundle).map((r) => `${r.where}${r.signed ? '/signed' : ''}: ${Object.keys(r.bundle).join(',')} | record ${Object.keys(r.bundle.record).join(',')} | preimage ${Object.keys(r.bundle.record.preimage).join(',')} | descriptor ${Object.keys(r.bundle.record.descriptor ?? {}).join(',')} | anchor ${Object.keys(r.bundle.anchor).join(',')} | confirmed ${Object.keys(r.bundle.anchor.confirmed ?? {}).join(',')}`))].sort(),
};
if (OUT) fs.writeFileSync(OUT, `${JSON.stringify({ base: BASE, schema: SCHEMA, summary, timing: { batchSizes: sizes.sort((x, y) => y - x), attempts: attempts.length, lease: lease.map((l) => l.name) } }, null, 1)}\n`);
for (const f of failures.slice(0, 25)) console.error(`FAIL ${f}`);
const heights = [...new Set([...txids.values()].map((t) => t.blockheight))].sort();
console.log(`anchoring through ${BASE} (${SCHEMA}): ${records.length} records → ${batches.length} batches (${sizes.join('+')} leaves), ${summary.confirmed} confirmed; `
  + `${verified} bundles pass the TypeScript verifier (A, B, C1); ${txids.size} anchor transactions in blocks ${heights.join(', ')}; `
  + `${failures.length === 0 ? 'everything as required' : `${failures.length} thing(s) not as required`}`);
process.exit(failures.length === 0 ? 0 : 1);
