/**
 * Fills the two test schemas with the same records — organisations, API
 * keys, issuer keys, accounts with sessions, attestations in every state,
 * and what the console shows of the three products (subscriptions,
 * institutions, settlements, reserve snapshots, an audit trail) — so that
 * the reference service and the Java one can be asked the same questions
 * about the same data.
 *
 *   node apps/core-java/tools/seed-reference.mjs apps/core-java/.env.ref apps/core-java/.env.dev
 *
 * The records are made by the reference service's own code (its store and
 * its `AttestService`), on the reference's test schema, with an anchor
 * backend that builds a transaction and broadcasts nothing. They are then
 * copied row for row into the Java service's test schema. Nothing is read
 * from or written to the live schema: both schema names have to start with
 * `stonehash_test_`, or nothing happens.
 *
 * Every run clears the data of both test schemas first (never the table the
 * migrations keep their own record in), so it can be run again at any time —
 * with both servers stopped: a running server remembers things about rows
 * that are about to be replaced.
 *
 * What the cases need to know (ids, the test API keys, a session token, a
 * few freshly signed statements) is written to parity/seed.json, readable by
 * its owner only. These are credentials of two throw-away schemas.
 *
 * The settlement rail's rows — organisations of its own, the partner
 * stand-in's institutions, quotes, settlements in every state, manifests —
 * are made by tools/seed-remit.mjs, called at the end (see there, and
 * parity/README.md). They are the same in both schemas but for one thing: a
 * seeded organisation's webhook address names the partner stand-in of the
 * server that reads the schema. PARITY_SEED_OUT=<file> writes the seed file
 * elsewhere, for a seed of other schemas than the comparison pair's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../core/src/db.ts';
import { AttestService } from '../../core/src/service.ts';
import { hashKey } from '../../core/src/auth.ts';
import { createAccount, createSession, verifyPassword } from '../../core/src/account.ts';
import { recordAudit } from '../../core/src/audit.ts';
import { Registry } from '../../core/src/remit/registry.ts';
import { signEvent } from '../../core/src/remit/sign.ts';
import { porSnapshotCommitment } from '../../../packages/attest-verify/src/merkle-sum.ts';
import { RemitStore } from '../../core/src/remit/store.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../../core/src/btc/tx.ts';
import { buildStatement, statementSigningInput } from '../../../packages/attest-verify/src/statement.ts';
import { DEFAULT_SOFT_CAP_BYTES, HARD_CEILING_BYTES } from '../../core/src/btc/inscription.ts';
import { overLimit } from '../parity/documents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [refEnvFile, devEnvFile] = process.argv.slice(2);
if (!refEnvFile || !devEnvFile) { console.error('usage: node seed-reference.mjs <reference env file> <java env file>'); process.exit(2); }

const readEnv = (file) => {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
};
const refUrl = readEnv(refEnvFile).STONEHASH_DB_URL;
const devUrl = readEnv(devEnvFile).STONEHASH_DB_URL;
const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
const REF = schemaOf(refUrl);
const DEV = schemaOf(devUrl);
const TEST = /^stonehash_test_[a-z0-9_]+$/;
if (!TEST.test(REF) || !TEST.test(DEV) || REF === DEV) { console.error('refusing: both schemas must be different stonehash_test_ schemas'); process.exit(1); }
{
  const a = new URL(refUrl); const b = new URL(devUrl);
  if (a.host !== b.host || a.username !== b.username) { console.error('refusing: the two schemas must be on the same server, under the same account'); process.exit(1); }
}

const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const u = new URL(refUrl);
const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const OWN = 'flyway_schema_history';
const tablesOf = async (schema) => (await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [schema])).map((r) => r.t).filter((t) => t !== OWN);
const clear = async (schema) => {
  await q('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of await tablesOf(schema)) await q(`TRUNCATE TABLE \`${schema}\`.\`${t}\``);
  await q('SET FOREIGN_KEY_CHECKS = 1');
};
await clear(REF);

// ── the reference service's own code, on the reference schema ───────────────

const sha256 = (s) => createHash('sha256').update(s).digest();
const hex = (b) => Buffer.from(b).toString('hex');
const P2TR = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xab)]);
const states = new Map();
let submitted = 0;
const anchorTx = (payload) => {
  const legacy = serializeLegacy([{ txid: hex(sha256(`seed input ${submitted++}`)), vout: 0 }],
    [{ value: 0, scriptPubKey: opReturnScript(payload) }, { value: 9_000, scriptPubKey: P2TR }]);
  return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy) };
};
/** An anchor backend that builds the transaction and broadcasts nothing. */
const backend = {
  network: 'regtest', name: 'bitcoind:regtest',
  async submit(payload) { return { ...anchorTx(payload), anchorPayloadHex: hex(payload) }; },
  async poll(handle) { return states.get(handle.txid) ?? { status: 'pending' }; },
  async health() { return { ok: true }; },
};
const inscriber = async (body, contentType) => {
  const leaf = sha256(body);
  const tx = anchorTx(leaf);
  return { commitTxid: hex(sha256(`commit of ${tx.txid}`)), revealTxid: tx.txid, revealTxHex: tx.rawTxHex, anchorPayloadHex: hex(leaf), leafHex: hex(leaf),
    contentType, protocolTag: 'stonehash', bodyLength: body.length, inputIndex: 0 };
};

const db = await openDb(refUrl);
const svc = new AttestService(db, backend, 1024, inscriber);
let tick = 0;
const nextTime = () => new Date(Date.parse('2026-11-01T00:00:00.000Z') + 1000 * tick++).toISOString();
const stamp = async (table, id, column = 'created_at', key = 'id') => { await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(nextTime(), id); };
const digest = (label) => hex(sha256(`parity seed: ${label}`));

const orgA = await svc.ensureOrg('parity-bank', 'Parity Bank');
const orgB = await svc.ensureOrg('parity-other', 'Another Organisation');
const publicOrg = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');

const key = async (orgId, secret, label, revoked = false) => {
  const id = randomUUID();
  await db.prepare('INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, hashKey(secret), 'sk_test_', label, nextTime(), revoked ? nextTime() : null);
  return { id, secret, label };
};
const secret = (word) => `sk_test_${Buffer.from(sha256(`parity key ${word}`)).subarray(0, 24).toString('base64url')}`;
const keyA = await key(orgA, secret('a'), 'parity-runner');
const keyARevoked = await key(orgA, secret('a-old'), 'old-key', true);
const keyB = await key(orgB, secret('b'), 'other-org');

const fixed = JSON.parse(fs.readFileSync(path.join(HERE, '../src/test/resources/vectors/statement-keys.json'), 'utf8'));
const issuerEs = await svc.registerIssuerKey(orgA, fixed.es256.spki, 'signing-key');
await stamp('issuer_keys', issuerEs.id);
const issuerRs = await svc.registerIssuerKey(orgA, fixed.rs256.spki, 'rsa-key', 'RS256');
await stamp('issuer_keys', issuerRs.id);
const issuerGone = await svc.registerIssuerKey(orgA, fixed.otherKeys.secondP256, 'retired-key');
await stamp('issuer_keys', issuerGone.id);
await stamp('issuer_keys', issuerGone.id, 'revoked_at');

const issue = async (orgId, label, contentType, descriptor) => {
  const a = await svc.issue(orgId, digest(label), contentType, descriptor);
  await stamp('attestations', a.id);
  return a.id;
};
const ids = { confirmed: [], submitted: [], batched: [], accepted: [], other: [], public: {}, inscription: {} };
const confirm = async (batchId, height) => {
  const txid = await svc.anchorBatch(batchId);
  states.set(txid, { status: 'confirmed', blockHeight: height, blockHash: hex(sha256(`block ${height}`)), confirmations: 6 });
  await svc.refreshConfirmations();
  return txid;
};

// A batch of several leaves, confirmed: an odd number, so one level pairs a node with itself.
for (const [i, [contentType, descriptor]] of [[undefined, undefined], ['application/pdf', { invoice: 'INV-7781', pages: 3 }], ['text/plain; charset=utf-8', {}],
  ['', { 2: 'two', a: 1, 1: 'one' }], [undefined, { nested: { a: [1, 2, { b: null }] }, note: 'é😀' }]].entries()) {
  ids.confirmed.push(await issue(orgA, `confirmed ${i}`, contentType, descriptor));
}
const signedRs = await svc.issueSigned(orgA, fixed.rs256.signed, { descriptor: { purpose: 'signed, key on file' } });
await stamp('attestations', signedRs.id);
ids.signedRegistered = signedRs.id;
ids.batchConfirmed = await svc.sealBatch();
await confirm(ids.batchConfirmed, 10_100);

// Submitted, not yet in a block.
ids.submitted.push(await issue(orgA, 'submitted 0'), await issue(orgA, 'submitted 1', 'application/json'));
ids.batchSubmitted = await svc.sealBatch();
await svc.anchorBatch(ids.batchSubmitted);

// The free tier's own batch, confirmed. (A batch holds one organisation's records.)
const publicIssue = async (label, expiresAt) => {
  const a = await svc.issue(publicOrg, digest(label), undefined, { tier: 'free' }, { source: 'public', expiresAt });
  await stamp('attestations', a.id);
  return a.id;
};
ids.public.confirmed = await publicIssue('public confirmed', '2099-01-01T00:00:00.000Z');
ids.public.batch = await svc.sealBatch();
await confirm(ids.public.batch, 10_101);

// Sealed, not yet submitted.
ids.batched.push(await issue(orgA, 'batched 0'), await issue(orgA, 'batched 1', 'image/png', { w: 640, h: 480 }));
ids.batchSealed = await svc.sealBatch();

// ── the console's organisation: records of all three products, in two months ──
// The console counts by calendar month (UTC) and by day, so these are placed against the day the seed is made:
// "this month" from its first second, "last month" from its 12th day, "today" from midnight.
const today = new Date();
const MONTH = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
const LAST_MONTH = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 12);
const TODAY = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
const iso = (ms) => new Date(ms).toISOString();
const put = async (table, id, value, column = 'created_at', key = 'id') => { await db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(value, id); };
let ctick = 0;
const orgC = await svc.ensureOrg('parity-console', 'Console Parity');
const materials = JSON.parse(fs.readFileSync(path.join(HERE, '../src/test/resources/vectors/key-materials.json'), 'utf8'));
const consoleIssuer = {};
consoleIssuer.es256 = (await svc.registerIssuerKey(orgC, fixed.es256.spki, 'signing-key')).id;
await stamp('issuer_keys', consoleIssuer.es256);
/** A record of orgC made by one product, placed `seconds` after `base`. */
const consoleIssue = async (label, base, seconds, product = 'attest', contentType = undefined, descriptor = undefined) => {
  const a = await svc.issue(orgC, digest(`console ${label}`), contentType, descriptor, { product });
  await put('attestations', a.id, iso(base + 1000 * seconds));
  return a.id;
};
const consoleIds = { attest: { confirmed: [], lastMonth: [], submitted: [], batched: [], accepted: [] }, remit: {}, por: {}, inscription: {} };
// Proof of reserves has an organisation of its own (parity/cases/por.mjs): its records join the batches below, one in each state.
const orgP = await svc.ensureOrg('parity-por', 'Reserve Parity');
const porRecord = async (label, base, seconds) => {
  const a = await svc.issue(orgP, digest(`por ${label}`), 'application/json', { kind: 'por-snapshot', snapshot_id: `seeded-${label}` }, { product: 'por' });
  await put('attestations', a.id, iso(base + 1000 * seconds));
  return a.id;
};
const porRecords = {};
const batchTime = async (batchId, confirmedAt) => { await put('anchor_txs', batchId, confirmedAt, 'confirmed_at', 'batch_id'); };

// Last month, confirmed: two of document anchoring's own, one of each other product.
consoleIds.attest.lastMonth.push(await consoleIssue('attest last month 0', LAST_MONTH, 0), await consoleIssue('attest last month 1', LAST_MONTH, 60, 'attest', 'application/pdf', { invoice: 'INV-1001' }));
consoleIds.remit.lastMonth = await consoleIssue('remit last month', LAST_MONTH, 120, 'remit', 'application/json', { kind: 'settlement-evidence' });
consoleIds.por.lastMonth = await consoleIssue('por last month', LAST_MONTH, 180, 'por', 'application/json', { kind: 'reserve-snapshot' });
consoleIds.batchLastMonth = await svc.sealBatch();
const consoleTxLastMonth = await confirm(consoleIds.batchLastMonth, 10_110);
// Confirmed 400 s after the first record of the batch: 400 s and 340 s for document anchoring's two; the other
// products' records (280 s, 220 s) are not part of document anchoring's time to confirm.
await batchTime(consoleIds.batchLastMonth, iso(LAST_MONTH + 400_000));

// This month, confirmed: three of document anchoring's own (two of them signed), one of each other product. The
// batch confirmed 90 s into the month: 90 s, 60 s and 30 s for the first three; the record made at 120 s is
// "confirmed before it was made" and is left out of the average, as are the other products' two.
consoleIds.attest.confirmed.push(await consoleIssue('attest confirmed 0', MONTH, 0), await consoleIssue('attest confirmed 1', MONTH, 30, 'attest', 'text/plain', { note: 'é😀' }));
{
  const registered = await svc.issueSigned(orgC, fixed.es256.signed, { descriptor: { purpose: 'console, key on file' } });
  await put('attestations', registered.id, iso(MONTH + 60_000));
  consoleIds.attest.signedRegistered = registered.id;
  // Signed with a key that is registered only afterwards: what a record says about its key is settled when it is made.
  const unregistered = await svc.issueSigned(orgC, fixed.rs256.signed, {});
  await put('attestations', unregistered.id, iso(MONTH + 120_000));
  consoleIds.attest.signedUnregistered = unregistered.id;
}
consoleIds.remit.confirmed = await consoleIssue('remit confirmed', MONTH, 5, 'remit', 'application/json', { kind: 'settlement-evidence', payment: 'P-DONE' });
consoleIds.por.confirmed = await consoleIssue('por confirmed', MONTH, 10, 'por', 'application/json', { kind: 'reserve-snapshot' });
porRecords.confirmed = await porRecord('confirmed', MONTH, 15);
consoleIds.batchConfirmed = await svc.sealBatch();
const consoleTxConfirmed = await confirm(consoleIds.batchConfirmed, 10_111);
await batchTime(consoleIds.batchConfirmed, iso(MONTH + 90_000));
consoleIssuer.rs256 = (await svc.registerIssuerKey(orgC, fixed.rs256.spki, 'rsa-key', 'RS256')).id;
await stamp('issuer_keys', consoleIssuer.rs256);

// Submitted, not yet in a block: one of document anchoring's, one settlement anchor.
consoleIds.attest.submitted.push(await consoleIssue('attest submitted', MONTH, 200));
consoleIds.remit.submitted = await consoleIssue('remit submitted', MONTH, 210, 'remit');
porRecords.submitted = await porRecord('submitted', MONTH, 215);
consoleIds.batchSubmitted = await svc.sealBatch();
const consoleTxSubmitted = await svc.anchorBatch(consoleIds.batchSubmitted);

// Sealed, not yet submitted.
consoleIds.attest.batched.push(await consoleIssue('attest batched', MONTH, 300, 'attest', 'image/png', { w: 640, h: 480 }));
porRecords.batched = await porRecord('batched', MONTH, 305);
consoleIds.batchSealed = await svc.sealBatch();

// Accepted and waiting; from here on nothing is sealed.
consoleIds.attest.accepted.push(await consoleIssue('attest accepted 0', MONTH, 400), await consoleIssue('attest accepted 1', MONTH, 410, 'attest', 'application/pdf', { note: 'x', n: 1 }));
consoleIds.remit.accepted = await consoleIssue('remit accepted', MONTH, 420, 'remit');
consoleIds.por.accepted = await consoleIssue('por accepted', MONTH, 430, 'por');
porRecords.accepted = await porRecord('accepted', MONTH, 435);

// An organisation one record short of the month's allowance. Only document anchoring's own records of this month
// count: the others here (the other products', last month's) would put it over if they did.
// The allowance is the reference env file's. An env file that says otherwise would start a server these rows do not fit;
// one that does not say (the worker files, which run no console case) is left alone.
const QUOTA = Number(readEnv(refEnvFile).CONSOLE_MONTHLY_QUOTA ?? '1000');
const otherQuota = readEnv(devEnvFile).CONSOLE_MONTHLY_QUOTA;
if (!(QUOTA >= 2 && QUOTA <= 60) || (otherQuota !== undefined && Number(otherQuota) !== QUOTA)) {
  console.error('refusing: CONSOLE_MONTHLY_QUOTA must be a small number (2 to 60) in the reference env file, and the same wherever the other file gives one'); process.exit(1);
}
const orgE = await svc.ensureOrg('parity-quota', 'Quota Parity');
for (let i = 0; i < QUOTA - 1; i++) {
  const a = await svc.issue(orgE, digest(`quota attest ${i}`));
  await put('attestations', a.id, iso(MONTH + 1000 * i));
}
for (const [label, base, product] of [['remit 0', MONTH, 'remit'], ['remit 1', MONTH, 'remit'], ['remit 2', MONTH, 'remit'], ['por 0', MONTH, 'por'], ['por 1', MONTH, 'por'],
  ['attest last month 0', LAST_MONTH, 'attest'], ['attest last month 1', LAST_MONTH, 'attest'], ['attest last month 2', LAST_MONTH, 'attest']]) {
  const a = await svc.issue(orgE, digest(`quota ${label}`), undefined, undefined, { product });
  await put('attestations', a.id, iso(base + 1000 * (500 + ctick++)));
}
ids.accepted.push(await issue(orgA, 'accepted 0'), await issue(orgA, 'accepted 1', 'application/pdf', { note: 'x', n: 1, nested: { a: [1, 2] } }));
ids.other.push(await issue(orgB, 'accepted 0'), await issue(orgB, 'only in the other organisation'));
const signedUnregistered = await svc.issueSigned(orgB, fixed.es256.signed, {});
await stamp('attestations', signedUnregistered.id);
ids.signedUnregistered = signedUnregistered.id;
ids.public.accepted = await publicIssue('public accepted', '2099-01-01T00:00:00.000Z');
ids.public.expired = await publicIssue('public expired', '2020-01-01T00:00:00.000Z');

// Documents inscribed whole: one in a block, one not yet. Each is longer than this deployment inscribes (the rows are
// written here, not by a wallet): a case that hands one in again is refused as a duplicate, and — were that rule ever
// broken in a build under test — as too large. See parity/documents.mjs.
const limitOf = (file) => Math.min(Math.max(Number(readEnv(file).INSCRIPTION_MAX_BYTES ?? DEFAULT_SOFT_CAP_BYTES), 1), HARD_CEILING_BYTES);
const LIMIT = limitOf(refEnvFile);
if (limitOf(devEnvFile) !== LIMIT) { console.error('refusing: INSCRIPTION_MAX_BYTES must be the same in both env files'); process.exit(1); }
const inscribed = await svc.inscribe(orgA, overLimit('parity seed: an inscribed document', LIMIT), 'text/plain');
await stamp('attestations', inscribed.id);
states.set(inscribed.reveal_txid, { status: 'confirmed', blockHeight: 10_102, blockHash: hex(sha256('block 10102')), confirmations: 3 });
await svc.refreshConfirmations();
const waiting = await svc.inscribe(orgA, overLimit('parity seed: an inscribed document, not yet in a block', LIMIT), 'application/pdf', { file: 'report.pdf' });
await stamp('attestations', waiting.id);
ids.inscription = { confirmed: inscribed.id, submitted: waiting.id };

// A console account and its sessions, for the keyed API's session door.
const account = await createAccount(db, 'ops@parity-bank.example', 'correct horse battery staple', orgA);
const session = await createSession(db, account.id, 'parity-seed');
const expired = await createSession(db, account.id, 'parity-seed-expired');
await db.prepare('UPDATE sessions SET expires_at = ? WHERE user_agent = ?').run('2020-01-01T00:00:00.000Z', 'parity-seed-expired');
const disabledAccount = await createAccount(db, 'gone@parity-bank.example', 'correct horse battery staple', orgA);
const disabledSession = await createSession(db, disabledAccount.id, 'parity-seed-disabled');
await db.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').run('2026-11-01T00:00:00.000Z', disabledAccount.id);

// ── the console: inscriptions, accounts, sessions, keys ─────────────────────
{
  const done = await svc.inscribe(orgC, overLimit('parity console: an inscribed document', LIMIT), 'text/plain');
  await put('attestations', done.id, iso(MONTH + 500_000));
  states.set(done.reveal_txid, { status: 'confirmed', blockHeight: 10_112, blockHash: hex(sha256('block 10112')), confirmations: 2 });
  await svc.refreshConfirmations();
  const waitingC = await svc.inscribe(orgC, overLimit('parity console: an inscribed document, not yet in a block', LIMIT), 'application/pdf');
  await put('attestations', waitingC.id, iso(MONTH + 510_000));
  consoleIds.inscription = { confirmed: done.id, submitted: waitingC.id };
  consoleIds.txids = { reveal: waitingC.reveal_txid, commit: waitingC.commit_txid, revealConfirmed: done.reveal_txid,
    batchLastMonth: consoleTxLastMonth, batchConfirmed: consoleTxConfirmed, batchSubmitted: consoleTxSubmitted };
}
const PASSWORD = 'parity console password';
const consoleAccount = await createAccount(db, 'console@parity.example', PASSWORD, orgC);
const colleague = await createAccount(db, 'colleague@parity.example', 'a colleague of parity', orgC);
const otherAccount = await createAccount(db, 'other@parity-other.example', 'another organisation', orgB);
const quotaAccount = await createAccount(db, 'quota@parity.example', 'one record left this month', orgE);
// Accounts whose stored password is not what a new one gets today: other parameters (made by the same function of
// the runtime, in the reference's format, and checked with the reference's own verifier), and strings it cannot use.
const orgD = await svc.ensureOrg('parity-odd', 'Odd Accounts');
const stored = (password, N, r, p, keylen = 32) => {
  const salt = randomBytes(16);
  return ['scrypt', N, r, p, salt.toString('base64'), scryptSync(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }).toString('base64')].join('$');
};
const oddAccount = async (email, password, hash, expected) => {
  if (verifyPassword(password, hash) !== expected) throw new Error(`seed: the reference does not answer ${expected} for ${email}`);
  const id = randomUUID();
  await db.prepare('INSERT INTO accounts (id, email, password_hash, org_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, hash, orgD, nextTime());
  return { id, email, password };
};
const odd = {
  otherParameters: await oddAccount('odd-parameters@parity.example', 'made with other parameters', stored('made with other parameters', 4096, 4, 2), true),
  longerDigest: await oddAccount('longer-digest@parity.example', 'a digest of 64 bytes', stored('a digest of 64 bytes', 16384, 8, 1, 64), true),
  malformed: await oddAccount('malformed@parity.example', 'no password matches this', 'scrypt$32768$8$1$bm90IGVub3VnaCBwYXJ0cw==', false),
  badParameters: await oddAccount('bad-parameters@parity.example', 'no password matches this', stored('no password matches this', 1024, 8, 1).replace('$1024$', '$1000$'), false),
  otherScheme: await oddAccount('other-scheme@parity.example', 'no password matches this', '$2b$12$abcdefghijklmnopqrstuuAbCdEfGhIjKlMnOpQrStUvWxYz0123456', false),
};
const disabledC = await createAccount(db, 'disabled@parity.example', PASSWORD, orgD);
await db.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').run('2026-11-01T00:00:00.000Z', disabledC.id);
const consoleSessions = {};
for (const [name, accountId] of [['main', consoleAccount.id], ['second', consoleAccount.id], ['third', consoleAccount.id], ['fourth', consoleAccount.id], ['expired', consoleAccount.id],
  ['colleague', colleague.id], ['other', otherAccount.id], ['quota', quotaAccount.id], ['disabled', disabledC.id]]) {
  consoleSessions[name] = (await createSession(db, accountId, `parity-console-${name}`)).token;
}
await db.prepare('UPDATE sessions SET expires_at = ? WHERE user_agent = ?').run('2020-01-01T00:00:00.000Z', 'parity-console-expired');

// Keys of the console's organisation in every state: two that work (the newer one is what the overview shows) and one revoked.
const consoleKeys = { ci: await key(orgC, secret('console-ci'), 'ci'), revoked: await key(orgC, secret('console-old'), 'retired', true), primary: await key(orgC, secret('console-primary'), 'primary') };
const quotaKey = await key(orgE, secret('quota'), 'quota-org');
// Issuer keys: the two registered above, one more P-256 key, one revoked, and the placeholder a sign-up leaves.
consoleIssuer.spare = (await svc.registerIssuerKey(orgC, materials.spki.p256, 'spare')).id;
await stamp('issuer_keys', consoleIssuer.spare);
consoleIssuer.revoked = (await svc.registerIssuerKey(orgC, fixed.otherKeys.secondP256, 'retired-key')).id;
await stamp('issuer_keys', consoleIssuer.revoked);
await stamp('issuer_keys', consoleIssuer.revoked, 'revoked_at');
consoleIssuer.placeholder = randomUUID();
await db.prepare("INSERT INTO issuer_keys (id, org_id, label, public_key, algorithm, created_at) VALUES (?, ?, 'demo issuer (sandbox)', 'DEMO-PUBLIC-KEY-PLACEHOLDER', 'ES256', ?)")
  .run(consoleIssuer.placeholder, orgC, nextTime());
const otherIssuer = (await svc.registerIssuerKey(orgB, materials.spki.p256, 'other-org-key')).id;

// ── the console: products as activation leaves them ─────────────────────────
const registry = new Registry(db);
const subscribed = async (orgId, product, config) => { const sub = await registry.subscribe(orgId, product, config); await stamp('subscriptions', sub.id); return sub; };
// A sign-up subscribes to document anchoring; activating the other two registers an institution with one of the organisation's keys.
for (const orgId of [orgC, orgD, orgE]) {
  await db.prepare("INSERT IGNORE INTO subscriptions (id, org_id, product, plan, status, config, created_at) VALUES (?, ?, 'attest', 'sandbox', 'active', '{}', ?)").run(randomUUID(), orgId, nextTime());
}
const BANK_AUTHORITY = ['FIAT_FUNDS_RECEIVED', 'PAYMENT_RELEASE_AUTHORIZED', 'bankInstruction', 'bankApproval', 'commercialDocs'];
const institutions = { bank: 'VN-BANK-PARITY', exchange: 'KR-EX-PARITY', ofAnother: 'SG-BANK-OTHER', partner: 'SG-BFI-PARITY', quotaExchange: 'KR-EX-QUOTA' };
await registry.upsert({ id: institutions.bank, role: 'COLLECTION_BANK', name: 'Parity Collection Bank', country: 'VN', org_id: orgC, signing_spki: fixed.es256.spki, authority: BANK_AUTHORITY });
await subscribed(orgC, 'remit', { institution_id: institutions.bank, webhook_url: 'https://bank.example/hooks/stonehash' });
await registry.upsert({ id: institutions.exchange, role: 'EXCHANGE', name: 'Parity Exchange', country: 'KR', org_id: orgC, signing_spki: fixed.es256.spki, authority: ['POR_SNAPSHOT'] });
await subscribed(orgC, 'por', { institution_id: institutions.exchange });
// Another organisation's institution, a partner's (it belongs to no organisation), and a subscription that was switched off.
await registry.upsert({ id: institutions.ofAnother, role: 'COLLECTION_BANK', name: 'Another Bank', country: 'SG', org_id: orgB, signing_spki: materials.spki.p256, authority: BANK_AUTHORITY });
await subscribed(orgB, 'remit', { institution_id: institutions.ofAnother });
await registry.upsert({ id: institutions.partner, role: 'BENEFICIARY_FI', name: 'Parity Beneficiary FI', country: 'SG', signing_spki: materials.spki.p256, authority: ['PAYOUT_ACCEPTED'] });
await registry.upsert({ id: institutions.quotaExchange, role: 'EXCHANGE', name: 'Quota Exchange', country: 'KR', org_id: orgE, signing_spki: materials.spki.p256, authority: ['POR_SNAPSHOT'] });
await subscribed(orgE, 'por', { institution_id: institutions.quotaExchange });
await registry.unsubscribe(orgE, 'por');
for (const id of Object.values(institutions)) await stamp('institutions', id);

// ── proof of reserves: exchanges whose keys this run holds, so that the cases can sign statements as them ──────
const pair = () => { const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }); return { key: k.privateKey, pem: k.privateKey.export({ format: 'pem', type: 'pkcs8' }), spki: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }; };
const porKeys = { exchange: pair(), console: pair(), rotated: pair(), stranger: pair() };
const porOrgs = { list: await svc.ensureOrg('parity-por-list', 'Reserve List'), noKey: await svc.ensureOrg('parity-por-nokey', 'Reserve Without A Key'),
  rotated: await svc.ensureOrg('parity-por-rotated', 'Reserve Rotated') };
const porInstitutions = { exchange: 'KR-EX-POR', list: 'KR-EX-PORLIST', noKey: 'KR-EX-PORNOKEY', rotated: 'KR-EX-PORROT' };
await registry.upsert({ id: porInstitutions.exchange, role: 'EXCHANGE', name: 'Reserve Parity Exchange', country: 'KR', org_id: orgP, signing_spki: porKeys.exchange.spki, authority: ['POR_SNAPSHOT'] });
// The console's key, as the console sent it: with the white space around it that the store keeps.
const consoleSpkiStored = `  ${porKeys.console.spki}\n`;
await registry.setConsoleKey(porInstitutions.exchange, consoleSpkiStored);
await subscribed(orgP, 'por', { institution_id: porInstitutions.exchange });
await registry.upsert({ id: porInstitutions.list, role: 'EXCHANGE', name: 'Reserve List Exchange', country: 'KR', org_id: porOrgs.list, signing_spki: porKeys.stranger.spki, authority: ['POR_SNAPSHOT'] });
await subscribed(porOrgs.list, 'por', { institution_id: porInstitutions.list });
// Subscribed, with an exchange that has no key to verify a statement with.
await registry.upsert({ id: porInstitutions.noKey, role: 'EXCHANGE', name: 'Keyless Exchange', country: 'KR', org_id: porOrgs.noKey, authority: ['POR_SNAPSHOT'] });
await subscribed(porOrgs.noKey, 'por', { institution_id: porInstitutions.noKey });
// An exchange that has replaced its key since it published: its institution row holds the new one.
await registry.upsert({ id: porInstitutions.rotated, role: 'EXCHANGE', name: 'Rotated Exchange', country: 'KR', org_id: porOrgs.rotated, signing_spki: porKeys.rotated.spki, authority: ['POR_SNAPSHOT'] });
await subscribed(porOrgs.rotated, 'por', { institution_id: porInstitutions.rotated });
for (const id of Object.values(porInstitutions)) await stamp('institutions', id);
const porApiKeys = { exchange: await key(orgP, secret('por'), 'por-runner'), list: await key(porOrgs.list, secret('por-list'), 'por-list'),
  noKey: await key(porOrgs.noKey, secret('por-nokey'), 'por-nokey'), rotated: await key(porOrgs.rotated, secret('por-rotated'), 'por-rotated') };

// ── the console: settlements, webhooks, manifests and reserve snapshots the dashboard counts ──
const store = new RemitStore(db);
await db.prepare(`INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at)
  VALUES ('Q-PARITY', ?, 'VN', 'SG', '{}', '{}', '2099-01-01T00:00:00.000Z', ?), ('Q-PARITY-QUOTA', ?, 'VN', 'SG', '{}', '{}', '2099-01-01T00:00:00.000Z', ?)`).run(orgC, iso(LAST_MONTH), orgE, iso(LAST_MONTH));
/** A settlement placed `seconds` after `base`, moved to `state`; `events` are [type, payload, seconds after the settlement]. */
const settlement = async (id, amount, base, seconds, state, { level, events = [], org = orgC, quote = 'Q-PARITY' } = {}) => {
  await store.create({ id, org_id: org, quote_id: quote, corridor_origin: 'VN', corridor_destination: 'SG', trade_currency: 'USD', trade_amount: amount,
    collect_currency: 'VND', collect_amount: '1', usdc_amount: amount, payout_currency: 'SGD', payout_amount: '13.35', beneficiary_institution: institutions.partner, request_body: '{}' });
  const created = base + 1000 * seconds;
  for (const [type, payload, after] of events) {
    const e = await store.appendEvent(id, type, 'STONEHASH', payload);
    await put('remit_events', e.id, iso(created + 1000 * after));
  }
  if (state !== 'REQUEST_ACCEPTED') await store.transition(id, state);
  if (level) await store.patch(id, { evidence_level: level });
  await db.prepare('UPDATE remit_payments SET created_at = ?, updated_at = ? WHERE id = ?').run(iso(created), iso(created), id);
};
const LONG = `partner timeout: ${'the payout bank did not answer within the window; '.repeat(4)}giving up`;
await settlement('P-TODAY-1', '10.00', TODAY, 1, 'REQUEST_ACCEPTED');
await settlement('P-TODAY-2', '1234567.89', TODAY, 2, 'BANK_AUTHORIZED');
await settlement('P-TODAY-3', '0.10', TODAY, 3, 'EVIDENCE_ANCHORED', { level: 'L3', events: [['SETTLEMENT_RECONCILED', { ok: true }, 95]] });
await settlement('P-RFI-1', '250.00', MONTH, 1000, 'TRAVEL_RULE_PENDING', { events: [['TRAVEL_RULE_RFI', { question: 'purpose of payment?' }, 5]] });
await settlement('P-RFI-2', '251.00', MONTH, 1010, 'TRAVEL_RULE_PENDING', { events: [['TRAVEL_RULE_RFI', { question: 'beneficiary address?' }, 5], ['TRAVEL_RULE_RECEIVED', { ok: true }, 9]] });
await settlement('P-RFI-3', '252.00', MONTH, 1020, 'TRAVEL_RULE_PENDING');
for (let i = 0; i < 6; i++) await settlement(`P-HELD-${i}`, '100.00', MONTH, 1100 + i, 'PAYOUT_IN_PROGRESS', { level: 'L1' });
await settlement('P-HELD-L2', '100.00', MONTH, 1110, 'PAYOUT_IN_PROGRESS', { level: 'L2' });
await settlement('P-EXC-1', '75.50', MONTH, 1200, 'EXCEPTION', { events: [['EXCEPTION', { at_state: 'ONCHAIN_SETTLED', error: 'wallet transfer failed:  insufficient gas\n\t at step 4 ' }, 2]] });
await settlement('P-EXC-2', '75.50', MONTH, 1201, 'EXCEPTION', { events: [['EXCEPTION', { error: LONG }, 2]] });
await settlement('P-EXC-3', '75.50', MONTH, 1202, 'EXCEPTION', { events: [['EXCEPTION', { at_state: 'BANK_AUTHORIZED' }, 2]] });
await settlement('P-EXC-4', '75.50', MONTH, 1203, 'EXCEPTION');
await settlement('P-EXC-5', '75.50', MONTH, 1204, 'EXCEPTION', { events: [['EXCEPTION', { error: 'the first reason' }, 2], ['EXCEPTION', { error: 'the latest reason' }, 3]] });
await settlement('P-EXC-6', '75.50', MONTH, 1205, 'EXCEPTION', { events: [['EXCEPTION', { error: { code: 7 } }, 2]] });
await settlement('P-EXC-7', '75.50', MONTH, 1206, 'EXCEPTION', { events: [['EXCEPTION', { error: '   ' }, 2]] });
await settlement('P-RET', '500.00', MONTH, 1300, 'RETURNED');
await settlement('P-CAN', '501.00', MONTH, 1301, 'CANCELLED');
await settlement('P-DONE', '999.99', MONTH, 1302, 'BENEFICIARY_CREDIT_CONFIRMED', { level: 'L2', events: [['SETTLEMENT_RECONCILED', { ok: true }, 300.4]] });
// Last month's: outside this month's sums, inside the totals by state. One was "reconciled before it was requested" and is left out of the average.
await settlement('P-OLD-1', '42.00', LAST_MONTH, 0, 'EVIDENCE_ANCHORED', { level: 'L3', events: [['SETTLEMENT_RECONCILED', { ok: true }, -60]] });
await settlement('P-OLD-2', '43.00', LAST_MONTH, 10, 'EXCEPTION', { events: [['EXCEPTION', { error: 'last month' }, 2]] });
await settlement('P-QUOTA-1', '7.00', LAST_MONTH, 20, 'REQUEST_ACCEPTED', { org: orgE, quote: 'Q-PARITY-QUOTA' });
const delivery = async (id, org, payment, status, error, seconds) => {
  await db.prepare(`INSERT INTO remit_webhook_deliveries (id, org_id, payment_id, event_id, url, body, attempts, status, last_error, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'https://bank.example/hooks/stonehash', '{}', ?, ?, ?, ?, ?)`).run(id, org, payment, `ev-${id}`, status === 'pending' ? 0 : 5, status, error, iso(MONTH + 1000 * seconds), iso(MONTH + 1000 * seconds));
};
await delivery('wd-1', orgC, 'P-HELD-0', 'exhausted', 'fetch failed (first)', 2000);
await delivery('wd-2', orgC, 'P-HELD-0', 'exhausted', 'fetch failed (latest)', 2005);
await delivery('wd-3', orgC, 'P-EXC-1', 'exhausted', `HTTP 503\n${'service unavailable '.repeat(12)}`, 2010);
await delivery('wd-4', orgC, 'P-DONE', 'exhausted', null, 2015);
await delivery('wd-5', orgC, 'P-DONE', 'delivered', null, 2020);
await delivery('wd-6', orgC, 'P-TODAY-1', 'pending', null, 2025);
await delivery('wd-7', orgC, 'P-TODAY-2', 'delivered', null, 2030);
await delivery('wd-8', orgA, 'P-ELSEWHERE', 'exhausted', 'another organisation', 2035);
const manifest = async (org, date, status) => {
  await db.prepare(`INSERT INTO remit_manifests (id, org_id, date, manifest, sig, verdict, platform_sig, commitment, attestation_id, created_at)
    VALUES (?, ?, ?, '{}', '{}', ?, '{}', ?, NULL, ?)`).run(randomUUID(), org, date, JSON.stringify({ status, date, checked: 3 }), digest(`manifest ${org} ${date}`), iso(Date.parse(`${date}T23:00:00.000Z`)));
};
await manifest(orgC, iso(TODAY).slice(0, 10), 'MATCHED');
await manifest(orgC, iso(LAST_MONTH).slice(0, 10), 'DISCREPANCY');
await manifest(orgE, iso(LAST_MONTH).slice(0, 10), 'MATCHED');
const snapshot = async (id, org, institution, status, seconds, reserves, attestationId = null, base = MONTH) => {
  await db.prepare(`INSERT INTO por_snapshots (id, org_id, institution_id, status, statement, sig, commitment, root, asof, leaf_count, totals, challenge, problems, reserves, attestation_id, created_at, updated_at, signing_spki)
    VALUES (?, ?, ?, ?, '{}', '{}', ?, ?, ?, ?, ?, '{}', NULL, ?, ?, ?, ?, ?)`).run(id, org, institution, status, digest(`snapshot commitment ${id}`), digest(`snapshot root ${id}`), iso(base + 1000 * seconds - 3_600_000),
    1000 + seconds, JSON.stringify({ BTC: '12.50000000', USDT: String(100000 + seconds) }), reserves, attestationId, iso(base + 1000 * seconds), iso(base + 1000 * seconds), fixed.es256.spki);
};
const solvency = (...lines) => JSON.stringify({ measured_at: iso(MONTH), solvency: lines });
await snapshot('snap-last-month', orgC, institutions.exchange, 'VERIFIED', 0, solvency({ asset: 'BTC', coverage: '1.0100' }), consoleIds.por.lastMonth, LAST_MONTH);
await snapshot('snap-01', orgC, institutions.exchange, 'ACCEPTED', 3000, null);
await snapshot('snap-02', orgC, institutions.exchange, 'CHALLENGED', 3010, null);
await snapshot('snap-03', orgC, institutions.exchange, 'REJECTED', 3020, '{oops');
await snapshot('snap-04', orgC, institutions.exchange, 'VERIFIED', 3030, 'null');
await snapshot('snap-05', orgC, institutions.exchange, 'VERIFIED', 3040, JSON.stringify({ solvency: 'n/a' }));
await snapshot('snap-06', orgC, institutions.exchange, 'VERIFIED', 3050, solvency({ asset: 'ETH' }, {}, { coverage: null, asset: 'USDT', extra: 1 }));
await snapshot('snap-07', orgC, institutions.exchange, 'VERIFIED', 3060, solvency(null));
await snapshot('snap-08', orgC, institutions.exchange, 'VERIFIED', 3070, solvency('BTC', 5));
await snapshot('snap-09', orgC, institutions.exchange, 'VERIFIED', 3080, JSON.stringify({ measured_at: iso(MONTH) }));
await snapshot('snap-10', orgC, institutions.exchange, 'ACCEPTED', 3090, '');
await snapshot('snap-11', orgC, institutions.exchange, 'VERIFIED', 3100, solvency({ asset: 'BTC', coverage: '1.0312' }, { asset: 'USDT', coverage: null }), consoleIds.por.confirmed);
await snapshot('snap-quota', orgE, institutions.quotaExchange, 'ACCEPTED', 3200, null);

// ── proof of reserves: snapshots as the API reads them back ──────────────────
const porStatement = (institutionId, asof, leafCount = 12) => ({
  schema: 'stonehash.por-snapshot.v1', exchange: { institution_id: institutionId, name: 'Seeded Exchange' }, asof,
  assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'USDT', decimals: 6 }],
  tree: { algo: 'merkle-sum-sha256-v2', leaf_count: leafCount, root: digest(`por root ${institutionId} ${asof}`), padding: 'empty' },
  totals: { BTC: '2463358024', USDT: '255810750000' },
  params: { user_ref_hash: 'sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)', salt: 'hmac-sha256(master_seed, user_ref)' },
  generated_at: asof,
});
const porSnapshots = {};
let porTick = 0;
/** A snapshot row exactly as given: `statement`, `sig`, `challenge`, `problems` and `reserves` are the stored text. */
const porRow = async (name, r) => {
  const st = r.statementObject ?? porStatement(r.institution, iso(MONTH + 60_000 * porTick));
  const at = iso(MONTH + 4_000_000 + 1000 * porTick++);
  const id = `seeded-${name}`;
  await db.prepare(`INSERT INTO por_snapshots (id, org_id, institution_id, status, statement, sig, commitment, root, asof, leaf_count, totals, challenge, problems, reserves, attestation_id, created_at, updated_at, signing_spki)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, r.org, r.institution, r.status, r.statement ?? JSON.stringify(st),
    r.sig ?? JSON.stringify(signEvent(st, (r.signedBy ?? porKeys.exchange).key, r.institution, r.institution)),
    porSnapshotCommitment(st), st.tree.root, st.asof, st.tree.leaf_count, JSON.stringify(st.totals), r.challenge ?? JSON.stringify({ spot_check: false, indices: [] }),
    r.problems ?? null, r.reserves ?? null, r.attestation ?? null, at, at, r.spki === undefined ? porKeys.exchange.spki : r.spki);
  porSnapshots[name] = id;
  return id;
};
const ex = porInstitutions.exchange;
const measured = JSON.stringify({ declared: 1, measurements: [{ chain: 'eip155:31337', asset: 'USDT', address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', status: 'MEASURED', balance: '300000000000', measured_at: iso(MONTH) }],
  solvency: [{ asset: 'BTC', liabilities: '2463358024', reserves_measured: '0', coverage: null, status: 'NOT_MEASURED' }, { asset: 'USDT', liabilities: '255810750000', reserves_measured: '300000000000', coverage: '117.27%', status: 'MEASURED' }],
  note: 'balances read on chain at acceptance time; address control is a declared claim in the sandbox' });
// Published, in every state its anchor can be in.
await porRow('acceptedConfirmed', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: porRecords.confirmed, reserves: measured });
await porRow('verifiedConfirmed', { org: orgP, institution: ex, status: 'VERIFIED', attestation: porRecords.confirmed,
  challenge: JSON.stringify({ indices: [0, 1, 2, 3, 4, 5, 6, 7], issued_at: iso(MONTH), expires_at: iso(MONTH + 3_600_000) }) });
await porRow('acceptedSubmitted', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: porRecords.submitted });
await porRow('acceptedBatched', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: porRecords.batched });
await porRow('acceptedWaiting', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: porRecords.accepted });
await porRow('acceptedNoRecord', { org: orgP, institution: ex, status: 'ACCEPTED' });
await porRow('acceptedRecordGone', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: 'no-such-record' });
await porRow('acceptedRecordOfAnother', { org: orgP, institution: ex, status: 'ACCEPTED', attestation: consoleIds.por.confirmed });
await porRow('verifiedThreeLeaves', { org: orgP, institution: ex, status: 'VERIFIED', statementObject: porStatement(ex, iso(MONTH + 7_000_000), 3), attestation: porRecords.accepted,
  challenge: JSON.stringify({ indices: [0, 1, 2], issued_at: iso(MONTH), expires_at: iso(MONTH + 3_600_000) }) });
// Not published.
await porRow('challengedOpen', { org: orgP, institution: ex, status: 'CHALLENGED', challenge: JSON.stringify({ indices: [0, 3, 7], issued_at: iso(TODAY), expires_at: iso(TODAY + 10 * 86_400_000) }) });
await porRow('challengedExpired', { org: orgP, institution: ex, status: 'CHALLENGED', challenge: JSON.stringify({ indices: [0, 3, 7], issued_at: iso(LAST_MONTH), expires_at: iso(LAST_MONTH + 3_600_000) }) });
await porRow('rejected', { org: orgP, institution: ex, status: 'REJECTED', challenge: JSON.stringify({ indices: [1], issued_at: iso(LAST_MONTH), expires_at: iso(LAST_MONTH + 3_600_000) }),
  problems: JSON.stringify(['openings must cover exactly the challenged indices 1 (got )']) });
// Signed by the console's key, and kept with it as the store holds it.
await porRow('byConsoleKey', { org: orgP, institution: ex, status: 'ACCEPTED', signedBy: porKeys.console, spki: consoleSpkiStored });
// What the stored text can be.
await porRow('reservesNull', { org: orgP, institution: ex, status: 'ACCEPTED', reserves: 'null' });
await porRow('reservesEmpty', { org: orgP, institution: ex, status: 'ACCEPTED', reserves: '' });
await porRow('keyEmpty', { org: orgP, institution: ex, status: 'ACCEPTED', spki: '' });
// Rows older than the key column: one its institution's key still verifies, one it does not (the exchange has rotated since).
await porRow('noKeyVerifies', { org: orgP, institution: ex, status: 'ACCEPTED', spki: null });
await porRow('noKeyRotated', { org: porOrgs.rotated, institution: porInstitutions.rotated, status: 'ACCEPTED', signedBy: porKeys.stranger, spki: null });
await porRow('noKeyNoInstitution', { org: porOrgs.rotated, institution: 'KR-EX-GONE', status: 'ACCEPTED', signedBy: porKeys.stranger, spki: null });
await porRow('noKeySigUnreadable', { org: porOrgs.rotated, institution: porInstitutions.rotated, status: 'VERIFIED', sig: 'null', spki: null });
// Text that is not JSON, each in a row of its own (an organisation's list fails as a whole on one of them).
await porRow('brokenReserves', { org: porOrgs.rotated, institution: porInstitutions.rotated, status: 'ACCEPTED', signedBy: porKeys.rotated, spki: porKeys.rotated.spki, reserves: '{oops' });
await porRow('brokenStatement', { org: porOrgs.rotated, institution: porInstitutions.rotated, status: 'ACCEPTED', spki: porKeys.rotated.spki, statementObject: porStatement(porInstitutions.rotated, iso(MONTH + 8_000_000)), statement: '{"schema":' });
// More than a page of them, all alike but for their time.
for (let i = 0; i < 105; i++) await porRow(`list${String(i).padStart(3, '0')}`, { org: porOrgs.list, institution: porInstitutions.list, status: i % 3 === 0 ? 'VERIFIED' : 'ACCEPTED', signedBy: porKeys.stranger, spki: porKeys.stranger.spki });

// ── the console: an audit trail across services and actors ──────────────────
const auditIds = [];
const audited = async (n, actor, method, pathname, status, at) => {
  await recordAudit(db, actor, { method, path: pathname, status, durationMs: n + 0.6 });
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await db.prepare("UPDATE audit_log SET id = ?, at = ? WHERE org_id = ? AND id NOT LIKE '00000000-0000-4000-8000-%'").run(id, at, actor.orgId);
  auditIds.push(id);
};
{
  const person = { orgId: orgC, actorType: 'session', actorId: consoleAccount.id, actorLabel: consoleAccount.email };
  const system = { orgId: orgC, actorType: 'api_key', actorId: consoleKeys.ci.id, actorLabel: 'ci' };
  const calls = [['POST', '/v1/attestations', 201], ['GET', '/v1/attestations', 200], ['POST', '/v1/console/keys', 201], ['POST', '/v1/console/keys/k_1/revoke', 200],
    ['POST', '/v1/settlements', 201], ['GET', '/v1/settlements/P-TODAY-1', 200], ['POST', '/v1/por/snapshots', 201], ['POST', '/v1/console/attestations', 429],
    ['POST', '/v1/quotes', 400], ['GET', '/v1/console/tx/ABCDEF', 404], ['POST', '/v1/console/login', 200], ['GET', '/v1/attestations/100%25_done', 404], ['POST', '/v1/manifests/daily', 201]];
  // 70 rows: more than two default pages hold. Every fifth row shares its time with the one before it, so a page
  // boundary has to fall back on the id.
  for (let n = 1; n <= 70; n++) {
    const [method, pathname, status] = calls[n % calls.length];
    await audited(n, n % 3 === 0 ? system : person, method, pathname, status, iso(LAST_MONTH + 3_600_000 * (n - (n % 5 === 0 ? 1 : 0))));
  }
  await audited(71, { orgId: orgE, actorType: 'session', actorId: quotaAccount.id, actorLabel: quotaAccount.email }, 'POST', '/v1/console/attestations', 201, iso(LAST_MONTH));
}

// Statements signed just now, for the cases that anchor one: a statement can be anchored once per organisation.
const fresh = (algorithm, label) => {
  const pair = algorithm === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const core = buildStatement({ documentSha256: digest(`signed ${label}`), contentType: 'application/pdf', keyId: `${label}-key`, algorithm,
    publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), issuedAt: '2026-11-18T06:00:00.000Z' });
  const s = createSign('SHA256'); s.update(statementSigningInput(core));
  return { ...core, signature: (algorithm === 'ES256' ? s.sign({ key: pair.privateKey, dsaEncoding: 'ieee-p1363' }) : s.sign(pair.privateKey)).toString('base64url') };
};
// One whose key the console's organisation has on file: a record made from it says so.
const consoleOnFile = fresh('ES256', 'console-on-file');
consoleIssuer.statementKey = (await svc.registerIssuerKey(orgC, consoleOnFile.issuer.public_key, 'statement-key')).id;
await stamp('issuer_keys', consoleIssuer.statementKey);
const signed = { es256Known: fixed.es256.signed, rs256Known: fixed.rs256.signed, es256Fresh: fresh('ES256', 'fresh-es'), es256Fresh2: fresh('ES256', 'fresh-es-2'), rs256Fresh: fresh('RS256', 'fresh-rs') };

// ── the settlement rail: organisations of its own, institutions, quotes, settlements in every state, manifests ──
// Made by the reference's own handlers and pipeline against the partner stand-in, in this process (tools/seed-remit.mjs).
const remitSeed = await (await import('./seed-remit.mjs')).seedRemit({ db, svc, states, refEnv: readEnv(refEnvFile), devEnv: readEnv(devEnvFile) });

await db.close();

// ── the same rows in the Java service's schema ──────────────────────────────

await clear(DEV);
await q('SET FOREIGN_KEY_CHECKS = 0');
const copied = [];
for (const t of await tablesOf(REF)) {
  const cols = (await q('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [REF, t])).map((r) => `\`${r.c}\``).join(', ');
  const [result] = await conn.query(`INSERT INTO \`${DEV}\`.\`${t}\` (${cols}) SELECT ${cols} FROM \`${REF}\`.\`${t}\``);
  if (result.affectedRows > 0) copied.push(`${t} ${result.affectedRows}`);
}
await q('SET FOREIGN_KEY_CHECKS = 1');
// The one thing the two schemas do not share: an organisation's webhook address names the partner stand-in of its own server.
await (await import('./seed-remit.mjs')).afterCopy({ q, REF, DEV, refEnv: readEnv(refEnvFile), devEnv: readEnv(devEnvFile), seeded: remitSeed });
await conn.end();

// PARITY_SEED_OUT names another file: a seed of other schemas than the comparison pair's must not replace the pair's seed file.
const out = path.resolve(process.env.PARITY_SEED_OUT ?? path.join(HERE, '../parity/seed.json'));
fs.writeFileSync(out, `${JSON.stringify({
  note: 'Written by tools/seed-reference.mjs. Test credentials of the two stonehash_test_ schemas; the same rows are in both.',
  orgA: { id: orgA, slug: 'parity-bank' }, orgB: { id: orgB, slug: 'parity-other' }, publicOrg,
  keys: { a: keyA.secret, aRevoked: keyARevoked.secret, b: keyB.secret },
  issuerKeys: { es256: issuerEs.id, rs256: issuerRs.id, revoked: issuerGone.id, es256Spki: fixed.es256.spki, rs256Spki: fixed.rs256.spki, otherKeys: fixed.otherKeys },
  sessions: { valid: session.token, expired: expired.token, disabled: disabledSession.token },
  console: {
    quota: QUOTA,
    org: { id: orgC, slug: 'parity-console' }, oddOrg: orgD, quotaOrg: orgE,
    account: { id: consoleAccount.id, email: consoleAccount.email, password: PASSWORD }, colleague: { id: colleague.id, email: colleague.email },
    accounts: { ...odd, disabled: { id: disabledC.id, email: disabledC.email, password: PASSWORD }, quota: { email: quotaAccount.email, password: 'one record left this month' },
      other: { email: otherAccount.email, password: 'another organisation' } },
    sessions: consoleSessions,
    keys: { ci: consoleKeys.ci, primary: consoleKeys.primary, revoked: consoleKeys.revoked, quota: quotaKey },
    issuerKeys: { ...consoleIssuer, ofAnother: otherIssuer, spareSpki: materials.spki.p256 },
    institutions,
    ids: consoleIds,
    audit: { first: auditIds[0], last: auditIds[69], count: 70 },
    signed: { es256: fresh('ES256', 'console-es'), es256Again: fresh('ES256', 'console-es-2'), rs256: fresh('RS256', 'console-rs'), onFile: consoleOnFile },
  },
  por: {
    org: orgP, orgs: porOrgs, institutions: porInstitutions, records: porRecords, snapshots: porSnapshots,
    keys: { exchange: porApiKeys.exchange.secret, list: porApiKeys.list.secret, noKey: porApiKeys.noKey.secret, rotated: porApiKeys.rotated.secret },
    signing: Object.fromEntries(Object.entries(porKeys).map(([name, k]) => [name, { pem: k.pem, spki: k.spki }])),
    consoleSpkiStored,
  },
  ids, digests: { accepted0: digest('accepted 0'), confirmed0: digest('confirmed 0'), publicConfirmed: digest('public confirmed'), publicAccepted: digest('public accepted') },
  signed,
  remit: remitSeed,
}, null, 1)}\n`, { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`seeded ${REF} and copied to ${DEV}: ${copied.join(', ')}`);
