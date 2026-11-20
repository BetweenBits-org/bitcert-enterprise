/**
 * Vectors that hold the Java settlement rail to the reference (`apps/core/src/remit/`): the reference's own answers,
 * written to `src/test/resources/vectors/remit.json`.
 *
 *   node apps/core-java/tools/make-remit-vectors.mjs [<env file>]          write the file
 *   node apps/core-java/tools/make-remit-vectors.mjs [<env file>] --check  fail when the file on disk differs
 *
 * Sections of remit.json — what each holds, and how a Java test is meant to read it. Inputs stand beside answers;
 * an input that is JSON is kept as the text it was (`…Json`), because member order, a member named twice and `-0`
 * do not survive a second writer. An answer is `{ value }`, `{ status, body }` (a refusal as the reference's error
 * mapper answers it), `{ plain }` (its code threw a sentence of its own that is no refusal) or `{ engine }` (its
 * runtime threw: the Java service answers in words of its own, docs/JAVA-INTENDED-DIFFERENCES.md D-01).
 *
 *   quotes        mul / add: mulDecimal(a, b, scale), addDecimal(a, b, scale) over a table of operands and scales.
 *                 build: buildQuote(request, configuration, now) → the quote as the text JSON.stringify gives (its id is
 *                 `QT-<id>`), or the refusal. `order`: requests wrong in k ways and more, answered for the first.
 *   sourceRefs    strict: sourceRefOf(document) → the reference as read, with its twin key and the very text the key is
 *                 the SHA-256 of (`twinText`) — or the refusal. legacy: legacySourceRefOf(document, paymentId).
 *   duplicates    sequences: instructions handed to the reference's real RemitStore.createFromMessage on MySQL, one after
 *                 the other, an organisation per sequence: each step's outcome (accepted / the id is taken / the conflict)
 *                 and the rows of remit_source_refs and remit_source_matches the sequence left. A Java test replays the
 *                 steps on its own store, stamping each accepted settlement's `created_at` as given.
 *                 backfill: settlements as an earlier platform stored them, `backfillSourceRefs()`, and the exact lookups.
 *                 conflicts: the refusal each kind of conflict is answered with (through the acceptance handler).
 *   requestHashes body text → the hash the reference stores under an Idempotency-Key (sha256 of JSON.stringify of it parsed).
 *   fieldsAssertion  fieldsAssertionProblem(statement, expectation) → one of three sentences, or null.
 *   acceptance    POST /v1/settlements through the reference's own handler on a store on MySQL (`world`: the rows it
 *                 started from): the ladder (request k wrong in check k and every later one), single faults, the doors,
 *                 and what is accepted — with the rows an acceptance left (`stored`). Requests are signed once and kept.
 *   signing       events: every event of the recorded settlements — who signed, the payload text as stored, the SHA-256 of
 *                 the bytes that were signed (domain ‖ canonical form) and the signature, which verifies with `spki`.
 *                 elements: every evidence element of those settlements with its digest.
 *   webhooks      envelopes: every delivery the recorded settlements queued — type, sequence, state, data, and the stored
 *                 body with its signature (verifies with the platform key). ladder: what a failed attempt leaves, for each
 *                 limit and each count of attempts (`reschedule`).
 *   cursors       issued: the cursor text for a row. read: texts → the place they name, or `invalid_cursor`.
 *   evidence      for recorded event logs (`recordings` holds their rows): collectElements, the settlement evidence
 *                 document, reconcilePayment (the whole verdict, pass, reasons) with the registry as recorded and with a
 *                 row whose key is no key, and — where it passes — assemblePackage as the text JSON.stringify gives
 *                 (clock fixed: `taken_at`, `generated_at`) with packageCommitment for a fixed nonce.
 *   chain         chainTxStatus for the stand-in chain node's kinds of transaction (tools/stand-in-eth-rpc.mjs): the answer,
 *                 and the node's own answers to the four reads, so that a Java test can script a node of its own.
 *   search        store.search on MySQL: a table of stored reference values × needles → the settlements found.
 *   manifests     POST / GET /v1/manifests/daily through the handler: the verdict, the commitment (and the text it is
 *                 the SHA-256 of), the answer.
 *   recordings    the rows of the settlements the sections above were computed from: made by the reference's own
 *                 handlers, orchestrator and partner connector against the partner stand-in, in this process.
 *
 * What is random is made once and kept in `src/test/resources/vectors/remit-materials.json` (made when absent, never
 * otherwise): keys — test keys, their private halves protect nothing —, everything signed with them, and the recorded
 * settlements (their events carry signatures). Everything else is computed from that file on every run, with the
 * clock and the random id fixed, so that a second run writes the same bytes.
 *
 * The parts that need MySQL run on a schema of this tool's own, `stonehash_test_remit_vec…` (the env file's; default
 * `.env.rref-vec`), which it empties before it starts and when it is done; it refuses any other schema. The chain
 * section starts the stand-in chain node for its length on that settings file's own PORT (8797 here; no server is
 * ever started from that file) and stops it by its process id. Nothing live is touched: no address is called but
 * those two.
 */
import crypto, { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../core/src/db.ts';
import { AttestService, ServiceError } from '../../core/src/service.ts';
import { HttpError, HttpResult } from '../../core/src/http/server.ts';
import { mulDecimal, addDecimal, buildQuote } from '../../core/src/remit/quotes.ts';
import { sourceRefOf, legacySourceRefOf, RemitStore } from '../../core/src/remit/store.ts';
import { RemitOrchestrator, fieldsAssertionProblem } from '../../core/src/remit/orchestrator.ts';
import { Registry } from '../../core/src/remit/registry.ts';
import { WebhookOutbox } from '../../core/src/remit/webhook.ts';
import { TripleAProfileSim } from '../../core/src/remit/partners-client.ts';
import { registerRemitRoutes } from '../../core/src/remit/routes.ts';
import { chainTxStatus } from '../../core/src/remit/chain-status.ts';
import { collectElements, buildSettlementEvidence, reconcilePayment, assemblePackage, packageCommitment } from '../../core/src/remit/evidence.ts';
import { elementDigest, eventSigningBytes, loadOrCreatePlatformKey, sha256hex, signEvent, spkiFromPublicKey, verifyEvent } from '../../core/src/remit/sign.ts';
import { generateEncryptionKey } from '../../core/src/remit/jwe.ts';
import { RemitClient, finishElement } from '../../../packages/attest-remit/src/index.ts';
import { jcs } from '../../../packages/attest-verify/src/index.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../../core/src/btc/tx.ts';
import { problems, readEnvFile } from './check-test-env.mjs';
import { asFetch, createStandIn, loadPartnerKeys, registrations, INSTITUTIONS } from './stand-in-partner.mjs';
import { TX, TX_FAULT, TX_FAULT_AT, txHash } from './stand-in-eth-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../src/test/resources/vectors');
const OUT = path.join(DIR, 'remit.json');
const MATERIALS = path.join(DIR, 'remit-materials.json');
const TMP = path.resolve(HERE, '../target/remit-vectors-tmp');
const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null; // development: one section, nothing written
const envFile = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? path.resolve(HERE, '../.env.rref-vec'));
if (path.dirname(envFile) !== path.resolve(HERE, '..') || !path.basename(envFile).startsWith('.env.')) { console.error('not a settings file of this module (apps/core-java/.env.*)'); process.exit(1); }
if (!existsSync(envFile)) { console.error(`${path.basename(envFile)} is not there — make it once: tools/make-dev-env.mjs .env.rref-a .env.rref-vec PORT=8797 DB=stonehash_test_remit_vec … and tools/create-schema.mjs (see parity/README.md)`); process.exit(1); }
const env = readEnvFile(envFile);
const unsafe = problems(env);
if (unsafe.length) { for (const p of unsafe) console.error(`${path.basename(envFile)}: ${p}`); process.exit(1); }
const schema = new URL(env.STONEHASH_DB_URL).pathname.replace(/^\//, '');
if (!/^stonehash_test_(w\d+_)?remit_vec[a-z0-9_]*$/.test(schema)) { console.error(`refusing: ${schema} is not a schema of this tool's own (stonehash_test_remit_vec…): it empties the schema it is given`); process.exit(1); }
// The settings file's own port: no server is ever started from this file, so the port is this tool's to listen on.
const CHAIN_PORT = Number(env.PORT);
if (!Number.isInteger(CHAIN_PORT) || CHAIN_PORT < 1024) { console.error(`${path.basename(envFile)} gives no port for the stand-in chain node (PORT)`); process.exit(1); }
const listening = (port) => new Promise((resolve) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });

// ── the clock and the random id are this tool's ─────────────────────────────────────────────────────────────────
// The clock stands still between the times this tool sets (`at`): what a library asks of it in between cannot move an
// answer. Only while the materials are recorded — once — does every reading move it on by a millisecond.
const RealDate = Date;
let clock = RealDate.parse('2026-11-19T06:00:00.000Z');
let ticking = false;
const tick = () => (ticking ? clock++ : clock);
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(tick()); else super(...a); }
  static now() { return tick(); }
};
const at = (iso) => { clock = RealDate.parse(iso); };
const iso = (ms) => new RealDate(ms).toISOString();
const T0 = RealDate.parse('2026-11-19T06:00:00.000Z');
const realUuid = crypto.randomUUID;
let uuidSpace = 'start'; let uuidN = 0;
const fixedUuid = () => { const h = sha256hex(`remit vectors ${uuidSpace} ${uuidN++}`); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
crypto.randomUUID = fixedUuid; syncBuiltinESMExports();
/** A section starts at a time and an id of its own, whatever ran before it. */
const section = (name, t = '2026-11-19T06:00:00.000Z') => { uuidSpace = name; uuidN = 0; at(t); };

// ── answers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const refusal = (e) => {
  if (e instanceof ServiceError) return { status: e.status, body: { ...(e.detail ?? {}), error: e.code, message: e.message } };
  if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message } };
  return e?.constructor === Error ? { plain: e.message } : { engine: `${e?.constructor?.name}: ${e?.message}` };
};
const answer = (fn) => { try { return { value: fn() }; } catch (e) { return refusal(e); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const sha = (label) => createHash('sha256').update(`remit vectors file: ${label}`).digest('hex');

// ── materials: keys and what was signed with them, made once ────────────────────────────────────────────────────
const pemOf = (k) => k.export({ format: 'pem', type: 'pkcs8' });
const spkiOf = (pem) => spkiFromPublicKey(createPublicKey(createPrivateKey(pem)));
const BANK = { id: 'VN-BANK-VEC', name: 'Vector Collection Bank', country: 'VN' };
const BANK2 = { id: 'VN-BANK-VEC2', name: 'Second Vector Bank', country: 'VN' };
const PARTNER_BASE = 'http://partner.vectors.invalid';
const CORE = 'http://core.vectors.invalid';
const HOOK = 'http://hooks.vectors.invalid/hooks/vec';
const RATES = { usdVnd: '25380', usdSgd: '1.3350' };
const quoteCfg = (over = {}) => ({ rates: RATES, feeUsd: '25.00', ttlMs: 600_000, chainLabel: 'eip155:31337', ...over });
const PARTIES = { debtor: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi Blvd, District 1, Ho Chi Minh City', registration_number: 'VN-0312345678', account: 'VN-ACC-000777' },
  creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-000009', bank: 'DBS (sim)' } };
const ANSWERS = { purpose: 'Payment for machine parts under purchase order PO-7781', shipping_reference: 'B/L MAEU-2026-118822' };
const QUOTE_REQUEST = (amount) => ({ corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } });
const QUOTE_NOW = new RealDate('2026-11-19T05:30:00.000Z');
const FAR = '2099-01-01T00:00:00.000Z';
/** A quote as the handler stores one, under an id of this tool's choosing. */
const quoteOf = (id, amount, expires = FAR) => ({ ...buildQuote(QUOTE_REQUEST(amount), quoteCfg(), QUOTE_NOW), quote_id: id, expires_at: expires });

mkdirSync(TMP, { recursive: true });
/** The stand-in's key file, written from the materials for the length of a run (the stand-in reads its keys from a file). */
function partnerKeysOf(M) {
  const file = path.join(TMP, 'partner-keys.json');
  writeFileSync(file, JSON.stringify({ institutions: M.keys.partner }), { mode: 0o600 });
  return loadPartnerKeys(file);
}
function platformOf(M) {
  const file = path.join(TMP, 'platform.pem');
  writeFileSync(file, M.keys.platformPem, { mode: 0o600 });
  return loadOrCreatePlatformKey(file);
}

// ── the reference's services, in this process, on the tool's own schema ─────────────────────────────────────────
const db = await openDb(env.STONEHASH_DB_URL);
const all = async (sql, ...params) => db.prepare(sql).all(...params);
const tables = async () => (await all("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", schema)).map((r) => r.t ?? r.T ?? r.TABLE_NAME);
async function empty() {
  await db.exec('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of await tables()) await db.exec(`TRUNCATE TABLE \`${t}\``);
  await db.exec('SET FOREIGN_KEY_CHECKS = 1');
}
const lines = [];
const log = (msg, extra) => { lines.push({ msg, ...(extra ?? {}) }); };
const realFetch = globalThis.fetch;
const realConsoleError = console.error;
const turn = () => new Promise((ok) => setImmediate(ok));
// An anchor backend that builds a transaction and broadcasts nothing (as tools/seed-reference.mjs has it).
const chainStates = new Map(); let submitted = 0;
const backend = {
  network: 'regtest', name: 'bitcoind:regtest',
  async submit(payload) {
    const legacy = serializeLegacy([{ txid: sha256hex(`vector input ${submitted++}`), vout: 0 }], [{ value: 0, scriptPubKey: opReturnScript(payload) }, { value: 9_000, scriptPubKey: Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xab)]) }]);
    return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy), anchorPayloadHex: Buffer.from(payload).toString('hex') };
  },
  async poll(handle) { return chainStates.get(handle.txid) ?? { status: 'pending' }; },
  async health() { return { ok: true }; },
};

/**
 * The rail as apps/core/src/main.ts wires it, with the partner stand-in inside this process (its `fetch`) and the
 * route handlers called as the router calls them. `pipeline: false` leaves an accepted settlement where acceptance
 * left it (nothing runs behind the answer).
 */
function world(M, { pipeline = true, webhookMaxAttempts = 5 } = {}) {
  const platform = platformOf(M);
  const keys = partnerKeysOf(M);
  const svc = new AttestService(db, backend, 1024, null);
  const registry = new Registry(db);
  const store = new RemitStore(db);
  const outbox = new WebhookOutbox(db, platform, webhookMaxAttempts, log);
  const connector = new TripleAProfileSim(PARTNER_BASE);
  const orchestrator = new RemitOrchestrator({ store, registry, svc, bfi: connector, wallet: connector, outbox, platform, acceptDemoFinality: true, chainLabel: 'eip155:31337', log });
  const cfg = { remit: { adminToken: 'vectors-admin-token', explorerTxUrl: 'https://explorer.example/tx/{tx}', chainRpc: '', chainLabel: 'eip155:31337' }, console: { monthlyQuota: 100 }, pricing: {} };
  const routes = new Map();
  const collector = { add(method, p, h) { routes.set(`${method} ${p}`, h); return collector; }, get(p, h) { return collector.add('GET', p, h); }, post(p, h) { return collector.add('POST', p, h); } };
  registerRemitRoutes(collector, { cfg, db, svc, remit: { store, registry, orchestrator, platform, quoteCfg: quoteCfg() },
    requireAuth: async (ctx) => { if (!ctx.org) throw new HttpError(401, 'unauthorized', 'supply a valid sk_test_… key as "Authorization: Bearer <key>"'); return ctx.org; },
    requireSession: async () => { throw new HttpError(401, 'unauthorized', 'a console session is required'); } });
  /** One request to a route of the rail, handled as the router would. `bodyJson` is the body's text: parsed here as the server parses it. */
  async function call(route, { org, params = {}, query = '', headers = {}, body, bodyJson } = {}) {
    const handler = routes.get(route);
    if (!handler) throw new Error(`the reference registers no route ${route}`);
    const ctx = { req: { method: route.split(' ')[0], headers }, res: {}, path: route.split(' ')[1], params, query: new URLSearchParams(query), token: undefined, org,
      body: async () => { if (bodyJson !== undefined) { if (bodyJson === '') return {}; try { return JSON.parse(bodyJson); } catch { throw new HttpError(400, 'invalid_json', 'request body is not valid JSON'); } } return body === undefined ? {} : plain(body); } };
    try {
      const out = await handler(ctx);
      return out instanceof HttpResult ? { status: out.status, body: out.body } : { status: 200, body: out };
    } catch (e) {
      if (e instanceof ServiceError) return { status: e.status, body: { ...(e.detail ?? {}), error: e.code, message: e.message } };
      if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message } };
      // 500 `internal` either way; `engine` says the sentence is the runtime's or the database driver's, not one the reference wrote.
      return { status: 500, engine: e?.constructor !== Error || e?.sqlState !== undefined || e?.errno !== undefined, body: { error: 'internal', message: e instanceof Error ? e.message : String(e) } };
    }
  }
  const pipelines = new Map(); const stops = new Map();
  const own = { advance: orchestrator.advance.bind(orchestrator), approvalLeg: orchestrator.approvalLeg.bind(orchestrator), transferLeg: orchestrator.transferLeg.bind(orchestrator) };
  orchestrator.advance = (id) => { const run = !pipeline || stops.get(id) === 'authorized' ? Promise.resolve() : own.advance(id); pipelines.set(id, [...(pipelines.get(id) ?? []), run]); return run; };
  orchestrator.approvalLeg = (p) => (stops.get(p.id) === 'received' ? Promise.resolve() : own.approvalLeg(p));
  orchestrator.transferLeg = (p) => (stops.get(p.id) === 'pre-approved' ? Promise.resolve() : own.transferLeg(p));
  const partner = createStandIn({ name: 'vectors', core: null, keys, platformSpki: platform.publicSpkiBase64, deliver: async (text) => { const r = await call('POST /v1/remit/callbacks', { body: JSON.parse(text) }); return { status: r.status, body: r.body }; } });
  const toPartner = asFetch(partner, PARTNER_BASE);
  globalThis.fetch = async (input, init = {}) => {
    const address = String(input);
    if (address.startsWith(`${PARTNER_BASE}/`)) return toPartner(address, init);
    if (address === `${CORE}/v1/remit/meta`) return Response.json((await call('GET /v1/remit/meta')).body);
    throw new TypeError(`fetch failed (the vector tool reaches nothing but its own partner stand-in: ${address.split('?')[0]})`);
  };
  console.error = (...a) => { lines.push({ msg: a.map(String).join(' ') }); };
  /** Waits until nothing moves for a settlement any more. */
  async function rest(id) {
    await turn(); await turn();
    for (let quiet = 0; quiet < 3;) {
      const runs = pipelines.get(id) ?? [];
      await Promise.all(runs);
      const busy = partner.running(id) > 0;
      await partner.idle(id);
      await turn();
      quiet = !busy && (pipelines.get(id) ?? []).length === runs.length && partner.running(id) === 0 ? quiet + 1 : 0;
    }
  }
  const close = () => { globalThis.fetch = realFetch; console.error = realConsoleError; };
  return { platform, keys, svc, registry, store, outbox, orchestrator, call, partner, rest, stops, close, cfg };
}
/** An organisation with the rail, a collection bank and — unless said otherwise — a webhook address. */
async function organisation(w, slug, bank, { hook = HOOK, subscribed = true, active = true, spki } = {}) {
  const id = await w.svc.ensureOrg(slug, `Vectors ${slug}`);
  if (bank) await w.registry.upsert({ id: bank.id, role: 'COLLECTION_BANK', name: bank.name, country: bank.country, org_id: id, ...(spki ? { signing_spki: spki } : {}), authority: ['FIAT_FUNDS_RECEIVED', 'PAYMENT_RELEASE_AUTHORIZED', 'bankInstruction', 'bankApproval', 'commercialDocs'] });
  if (subscribed) { await w.registry.subscribe(id, 'remit', { ...(bank ? { institution_id: bank.id } : {}), ...(hook ? { webhook_url: hook } : {}) }); if (!active) await w.registry.unsubscribe(id, 'remit'); }
  return id;
}
async function partners(w) {
  await w.registry.upsert({ id: 'STONEHASH', role: 'STONEHASH', name: 'StoneHash (platform)', signing_spki: w.platform.publicSpkiBase64,
    authority: ['REQUEST_ACCEPTED', 'BANK_AUTHORIZATION_VERIFIED', 'TRAVEL_RULE_SENT', 'SETTLEMENT_INSTRUCTED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'EVIDENCE_ANCHORED', 'webhook'] });
  for (const { body } of registrations(w.keys)) await w.registry.upsert(body);
}
const TABLES = ['remit_payments', 'remit_events', 'remit_webhook_deliveries', 'remit_travel_rule', 'remit_idempotency', 'remit_source_refs', 'remit_source_matches'];
const rowsOf = async (table, where, ...params) => (await all(`SELECT * FROM ${table} WHERE ${where}`, ...params)).map((r) => ({ ...r }));

// ── materials ───────────────────────────────────────────────────────────────────────────────────────────────────
async function makeMaterials() {
  crypto.randomUUID = realUuid; syncBuiltinESMExports(); // what is made once may be as random as it likes
  ticking = true;
  const key = () => pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey);
  const M = { note: 'Made once by apps/core-java/tools/make-remit-vectors.mjs and kept: keys, signatures and the recorded settlements are random. Test keys; the private halves here protect nothing.',
    keys: { platformPem: key(), bankPem: key(), bank2Pem: key(), strangerPem: key(), partner: {} } };
  for (const [slug, inst] of Object.entries(INSTITUTIONS)) {
    const pem = key();
    M.keys.partner[slug] = { id: inst.id, signing: { pem, spki: spkiOf(pem) } };
    if (inst.encrypts) { const enc = generateEncryptionKey(); M.keys.partner[slug].encryption = { pem: enc.privatePem, jwk: enc.publicJwk }; }
  }
  const bankKey = createPrivateKey(M.keys.bankPem); const bank2Key = createPrivateKey(M.keys.bank2Pem); const stranger = createPrivateKey(M.keys.strangerPem);
  const sdk = new RemitClient({ core: CORE, apiKey: 'sk_test_vectors', institutionId: BANK.id, institutionName: BANK.name, key: bankKey });
  const sdk2 = new RemitClient({ core: CORE, apiKey: 'sk_test_vectors2', institutionId: BANK2.id, institutionName: BANK2.name, key: bank2Key });
  const sign = (payload, k = bankKey, who = BANK) => signEvent(payload, k, who.id, who.name);
  const element = (core, k = bankKey) => finishElement(core, k, BANK.id, BANK.name);
  const unsigned = ({ signature: _s, digest: _d, ...core }) => core;

  // ── recorded settlements: the reference's own flow against the stand-in ──────────────────────────────────────
  await empty();
  at('2026-11-18T01:00:00.000Z');
  const w = world(M);
  try {
    await partners(w);
    const org = await organisation(w, 'vec-recorded', BANK, { spki: spkiOf(M.keys.bankPem) });
    const orgNoHook = await organisation(w, 'vec-recorded-nohook', BANK2, { spki: spkiOf(M.keys.bank2Pem), hook: null });
    M.recordings = [];
    let n = 0;
    const record = async (name, note, { amount = '1200.00', mode = 'A', bfi = 'bfi', plan, stop, creditor, source, then, client = sdk, o = org } = {}) => {
      const id = `PAY-VEC-R${String(++n).padStart(2, '0')}`;
      at(iso(RealDate.parse('2026-11-18T01:00:00.000Z') + n * 600_000));
      const quote = (await w.call('POST /v1/quotes', { org: o, body: QUOTE_REQUEST(amount) })).body;
      const opts = { paymentId: id, invoiceRef: `INV-${id}`, beneficiaryInstitution: w.keys.institutions[bfi].id, ...(source ? { source } : {}), ...(mode === 'B' ? { travelRule: 'B' } : {}) };
      const parties = { debtor: PARTIES.debtor, creditor: { ...PARTIES.creditor, ...(creditor ?? {}) } };
      const body = mode === 'B' ? (await client.buildInstructionAsync(quote, parties, opts)).body : client.buildInstruction(quote, parties, opts).body;
      if (plan) w.partner.plan({ payment_id: id, ...plan });
      if (stop) w.stops.set(id, stop);
      const accepted = await w.call('POST /v1/settlements', { org: o, headers: { 'idempotency-key': `vec-${id}` }, body });
      if (accepted.status !== 202) throw new Error(`${name}: not accepted — ${JSON.stringify(accepted.body)}`);
      await w.rest(id);
      const cb = async (what) => { const r = await w.partner.callback({ payment_id: id, ...(typeof what === 'string' ? { type: what } : what) }); return r.answer; };
      if (then) { await then({ id, cb, o }); await w.rest(id); }
      const p = await w.store.get(id);
      M.recordings.push({ name, note, payment_id: id, state: p.state, mode, org: o, request: { key: `vec-${id}`, bodyJson: JSON.stringify(body) }, rows: {} });
      return id;
    };
    const answerRfi = async (id, answers = ANSWERS) => { const r = await w.call('POST /v1/settlements/:id/rfi-response', { org, params: { id }, body: { answers, sig: sign({ payment_id: id, answers }) } }); await w.rest(id); return r; };
    const anchored = await record('anchored', 'credited, its evidence anchored and confirmed: promoted by the worker\'s sweep');
    { // The batcher seals and anchors what waits; the backend confirms; the sweep promotes.
      const batch = await w.svc.sealBatch();
      const txid = await w.svc.anchorBatch(batch);
      chainStates.set(txid, { status: 'confirmed', blockHeight: 10_500, blockHash: sha256hex('vector block'), confirmations: 6 });
      await w.svc.refreshConfirmations();
      const promoted = await w.orchestrator.promoteAnchored();
      if (promoted < 1 || (await w.store.get(anchored)).state !== 'EVIDENCE_ANCHORED') throw new Error('the recorded settlement was not promoted to EVIDENCE_ANCHORED');
    }
    await record('normal-a', 'normal flow, mode A, completed with the bank\'s own confirmation (L3)');
    await record('normal-b', 'normal flow, mode B: the bank encrypted the travel-rule message', { mode: 'B', amount: '1350.50' });
    await record('l2', 'completed at L2: the institution\'s signature, no bank reference', { amount: '980.02' });
    await record('l1-hold', 'completed at L1 (unsigned): held, not confirmed', { amount: '1000.01' });
    await record('l1-then-l3', 'completed at L1 and then with the bank\'s confirmation: the reference reconciles the first completion', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'PAYOUT_COMPLETED', level: 'L3' }] } } });
    await record('receipt-other-amount', 'the receipt states another amount', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { with: { amount: '9999.99' } } }] } } });
    await record('chain-other-address', 'the wallet\'s chain element is for another address than the one approved', { plan: { steps: { transfer: { element: { with: { toAddress: `0x${'ee'.repeat(20)}` } } } } } });
    await record('receipt-digest', 'a receipt whose digest is not that of its content', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { after: { digest: 'f'.repeat(64) } } }] } } });
    await record('receipt-signature', 'a receipt whose signature is broken', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { breakSignature: true } }] } } });
    await record('receipt-stranger', 'a receipt signed by a key nobody registered', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { signedBy: 'stranger' } }] } } });
    await record('completed-before-the-chain', 'a completion for a settlement that was pre-approved and never transferred: no chain element', { stop: 'pre-approved', then: async ({ cb }) => { await cb('PAYOUT_COMPLETED'); } });
    await record('rfi-answered', 'a question from the institution, answered and accepted', { amount: '25000.00', then: ({ id }) => answerRfi(id) });
    await record('rfi-rejected', 'a question, the answers blank: rejected after the question', { amount: '26000.00', then: ({ id }) => answerRfi(id, { purpose: ' ', shipping_reference: '' }) });
    await record('returned', 'the payout failed and the USDC came back', { amount: '1000.13' });
    await record('cancelled-by-bank', 'cancelled by the bank while a question was open', { amount: '27000.00', then: async ({ id }) => { await w.call('POST /v1/settlements/:id/cancel', { org, params: { id }, body: { reason: 'the importer withdrew the order', sig: sign({ payment_id: id, reason: 'the importer withdrew the order' }) } }); } });
    await record('rejected', 'travel rule rejected: a beneficiary on the screening list', { creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } });
    await record('exception-approval', 'the approval was refused by the institution', { plan: { steps: { 'payout-approval': { do: 'refuse', status: 409, message: 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)' } } } });
    await record('bfi2', 'to the second receiving institution', { bfi: 'bfi2', amount: '777.00' });
    await record('from-a-message', 'made from a bank\'s message: the reference is signed into the instruction', { source: { type: 'pacs.008.001.08', sha256: sha('recorded'), uetr: '5eed0000-1111-4222-8333-444455556666', messageId: 'VEC-MSG-1', instructionId: 'VEC-INS-1', endToEndId: 'VEC-E2E-1', valueDate: '2026-11-17', content: sha('recorded content') } });
    await record('no-webhook', 'of an organisation without a webhook address: no delivery is queued', { client: sdk2, o: orgNoHook });
    // What the reference fills in where a partner leaves something out, and where each call's failure ends.
    const cancelWith = (reason) => async ({ id }) => { await w.call('POST /v1/settlements/:id/cancel', { org, params: { id }, body: { ...(reason === undefined ? {} : { reason }), sig: sign({ payment_id: id, reason: reason ?? 'cancelled by instructing bank' }) } }); };
    const callbacks = (...sequence) => ({ callbacks: { sequence } });
    const step = (name, behaviour) => ({ steps: { [name]: behaviour } });
    await record('rfi-bare', 'a question without an id or a list: the platform names both', { plan: step('travel-rule', { do: 'rfi-bare' }) });
    await record('rfi-bare-reason', 'a question given as a reason alone', { plan: step('travel-rule', { do: 'rfi-bare', reason: 'the beneficiary account is not in the stated bank\'s format' }) });
    await record('rfi-with-a-signature', 'a question whose answer carries a signature object: stored beside the event as it came, never verified', { plan: step('travel-rule', { do: 'rfi', top: { ack: { sig: { alg: 'ES256', key_id: w.keys.institutions.bfi.id, issuer: 'whoever sent it', sig: 'bm90LWEtc2lnbmF0dXJl' } } } }) });
    await record('rejected-no-reason', 'travel rule rejected without a reason', { plan: step('travel-rule', { do: 'reject' }) });
    await record('rfi-rejected-no-reason', 'a question, answered, and then rejected without a reason', { amount: '28000.00', plan: step('travel-rule-response', { do: 'reject' }), then: ({ id }) => answerRfi(id) });
    await record('callbacks-bare', 'callbacks without their optional members: no transaction hash, no rail, no level', { plan: callbacks({ type: 'USDC_RECEIVED', omit: ['tx_hash'] }, { type: 'PAYOUT_SUBMITTED', omit: ['local_rail'] }, { type: 'PAYOUT_COMPLETED', level: 'none' }) });
    await record('failed-no-reason', 'the payout failed and no reason was given; nothing has come back', { plan: callbacks('USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_FAILED', omit: ['reason'] }) });
    await record('returned-without-failure', 'the USDC came back with no failure before it, the callback naming no transaction', { plan: callbacks('USDC_RECEIVED', { type: 'USDC_RETURNED', omit: ['tx_hash'] }) });
    await record('returned-after-failure-without-reason', 'the USDC came back after a failure that gave no reason: the reference marks the settlement RETURNED and then fails to write the notice (the callback is answered 500)', { plan: callbacks('USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_FAILED', omit: ['reason'] }, 'USDC_RETURNED') });
    await record('cancelled-no-reason', 'cancelled by the bank without a reason, while a question was open', { amount: '29000.00', then: cancelWith(undefined) });
    await record('cancelled-before-travel-rule', 'cancelled before anything was sent: the stored request still holds the travel-rule data in clear (docs/JAVA-REMIT-DESIGN.md 13: the Java service deletes it)', { stop: 'authorized', then: cancelWith('withdrawn before anything was sent') });
    await record('exception-travel-rule', 'the institution answered the travel rule with a 503', { plan: step('travel-rule', { do: 'fail', status: 503, message: 'the screening service is down' }) });
    await record('exception-travel-rule-unexpected', 'a travel-rule answer of a status nobody knows', { plan: step('travel-rule', { do: 'ack', top: { status: 'MAYBE' } }) });
    await record('exception-approval-restated', 'an approval that restates another amount', { plan: step('payout-approval', { with: { usdc_amount: '1.00' } }) });
    await record('exception-approval-signature', 'an approval whose signature is broken', { plan: step('payout-approval', { breakSignature: true }) });
    await record('exception-approval-stranger', 'an approval signed by a key nobody registered', { plan: step('payout-approval', { signedBy: 'stranger' }) });
    await record('exception-approval-role', 'an approval signed by the settlement entity', { plan: step('payout-approval', { signedBy: 'wallet' }) });
    await record('exception-transfer', 'the wallet refused the transfer', { plan: step('transfer', { do: 'refuse', status: 403, message: 'transfer refused: the pre-approval has expired' }) });
    await record('exception-transfer-other-payment', 'the wallet\'s result names another payment', { plan: step('transfer', { with: { payment_id: 'PAY-VEC-SOMEONE-ELSE' } }) });
    await record('exception-notice', 'the institution answered the settlement notice with a 500, the USDC having moved', { plan: step('settlement-notice', { do: 'fail', status: 500, message: 'notice not taken' }) });
    for (const r of M.recordings) {
      for (const t of ['remit_payments']) r.rows[t] = await rowsOf(t, 'id = ?', r.payment_id);
      r.state = r.rows.remit_payments[0].state; // the sweep above promoted every settlement of the first organisation whose evidence was in the batch
      for (const t of ['remit_events', 'remit_webhook_deliveries', 'remit_travel_rule', 'remit_source_refs']) r.rows[t] = await rowsOf(t, `payment_id = ? ORDER BY ${t === 'remit_events' ? 'seq' : 'created_at'}`, r.payment_id);
      r.rows.remit_quotes = await rowsOf('remit_quotes', 'id = ?', r.rows.remit_payments[0].quote_id);
      r.rows.remit_idempotency = await rowsOf('remit_idempotency', 'idem_key = ?', r.request.key);
      r.rows.attestations = r.rows.remit_payments[0].attestation_id ? (await rowsOf('attestations', 'id = ?', r.rows.remit_payments[0].attestation_id)).map(({ rowseq: _r, ...rest }) => rest) : [];
      const partnerLog = w.partner.entries({ payment_id: r.payment_id });
      r.partner = partnerLog.map((e) => (e.dir === 'in' ? { dir: 'in', path: e.path, body: e.body, answer: e.answer } : { dir: 'out', type: e.type, body: e.body, answer: e.answer }));
    }
    M.registry = { orgs: await rowsOf('orgs', '1 = 1 ORDER BY created_at, id'), institutions: await rowsOf('institutions', '1 = 1 ORDER BY created_at, id'), subscriptions: (await rowsOf('subscriptions', '1 = 1 ORDER BY created_at, id')) };
  } finally { w.close(); }

  // ── signed once: what the acceptance section sends ───────────────────────────────────────────────────────────
  at('2026-11-19T05:40:00.000Z');
  const Q = { good: quoteOf('QT-VEC-GOOD', '1200.00'), other: quoteOf('QT-VEC-OTHER', '4300.00'), expired: quoteOf('QT-VEC-EXPIRED', '1200.00', '2026-11-01T00:10:00.000Z'), ofB: quoteOf('QT-VEC-OF-B', '1200.00') };
  M.quotes = Q;
  const ID = 'PAY-VEC-ACCEPT';
  const BFI = M.keys.partner.bfi.id;
  const good = (id = ID, opts = {}, client = sdk, quote = Q.good) => client.buildInstruction(quote, PARTIES, { paymentId: id, invoiceRef: `INV-${id}`, beneficiaryInstitution: BFI, ...opts }).body;
  const requests = [];
  const req = (group, name, body, { key = `vec-key-${String(requests.length + 1).padStart(3, '0')}`, org = 'a', text } = {}) => requests.push({ group, name, org, key, bodyJson: text ?? JSON.stringify(body) });
  const change = (fn, id = ID) => { const b = good(id); return fn(b) ?? b; };
  const other = good('PAY-VEC-OTHER-REF', {}, sdk, Q.other);
  const badSource = { type: 'MT103', sha256: 'ab'.repeat(32), uetr: 'not-a-uuid' };
  const instructionOf = (amount, ref, source) => element({ ...unsigned(good().evidence_elements.bankInstruction), amount, ref, ...(source ? { sourceMessage: source } : {}) });
  const rungs = [
    ['invalid_payment_id', 'payment_id', (b) => { b.payment_id = 'abc'; }], ['missing_field', 'quote_id', (b) => { b.quote_id = ''; }], ['duplicate_payment', 'payment_id', (b) => { b.payment_id = 'PAY-VEC-TAKEN'; }],
    ['quote_not_found', 'quote_id', (b) => { b.quote_id = 'QT-00000000-0000'; }], ['quote_expired', 'quote_id', (b) => { b.quote_id = Q.expired.quote_id; }],
    ['amount_mismatch', 'collected', (b) => { b.amount = { ...b.amount, collected: { currency: 'VND', value: '1' } }; }], ['amount_mismatch', 'payout', (b) => { b.amount = { ...b.amount, payout: { currency: 'SGD', value: '1.00' } }; }],
    ['missing_field', 'beneficiary', (b) => { b.beneficiary = { beneficiary_ref: 'x' }; }], ['unknown_beneficiary_institution', 'beneficiary', (b) => { b.beneficiary = { institution_id: 'SG-BFI-NOBODY' }; }],
    ['bfi_has_no_encryption_key', 'beneficiary', (b) => { b.beneficiary = { institution_id: 'SG-BFI-NOENC' }; }], ['missing_field', 'authorization', (b) => { b.bank_authorization = 'authorised'; }],
    ['missing_field', 'signature', (b) => { delete b.bank_signature; }], ['invalid_signature', 'signature', (b) => { b.bank_signature = signEvent(b.bank_authorization, stranger, BANK.id, BANK.name); }],
    ['travel_rule_incomplete', 'compliance', (b) => { b.compliance_payload = { format: 'IVMS101-2023', mode: 'A' }; }], ['missing_evidence_element', 'instruction', (b) => { delete b.evidence_elements.bankInstruction; }],
    ['invalid_evidence_signature', 'instruction', (b) => { b.evidence_elements.bankInstruction = { ...other.evidence_elements.bankInstruction, sourceMessage: badSource }; }],
    ['missing_evidence_element', 'approval', (b) => { delete b.evidence_elements.bankApproval; }], ['invalid_evidence_signature', 'approval', (b) => { b.evidence_elements.bankApproval = { ...good().evidence_elements.bankApproval, approvedByRole: 'somebody else' }; }],
    ['missing_evidence_element', 'documents', (b) => { delete b.evidence_elements.commercialDocs; }], ['invalid_evidence_signature', 'documents', (b) => { b.evidence_elements.commercialDocs = { ...good().evidence_elements.commercialDocs, amount: '1.00' }; }],
    ['evidence_inconsistent', 'instruction', (b) => { b.evidence_elements.bankInstruction = instructionOf(Q.other.trade.amount, 'PAY-VEC-OTHER-REF', badSource); }],
    ['evidence_inconsistent', 'instruction', (b) => { b.evidence_elements.bankInstruction = instructionOf(Q.good.trade.amount, 'PAY-VEC-OTHER-REF', badSource); }],
    ['invalid_source_message', 'instruction', (b) => { b.evidence_elements.bankInstruction = instructionOf(Q.good.trade.amount, ID, badSource); }],
  ];
  for (let i = 0; i < rungs.length; i++) {
    const b = good(); const done = new Set(); const apply = [];
    for (let j = i; j < rungs.length; j++) { if (done.has(rungs[j][1])) continue; done.add(rungs[j][1]); apply.push(j); }
    for (const j of apply.reverse()) rungs[j][2](b);
    req('ladder', `rung ${String(i + 1).padStart(2, '0')}: ${rungs[i][0]} — wrong in this check and in every later one`, b);
  }
  // The key header and the body, before anything of the instruction is read.
  req('header', 'no key header', good(), { key: null }); req('header', 'a key of seven characters', good(), { key: 'seven-7' }); req('header', 'a key of eight characters, an empty body', {}, { key: 'eight--8' });
  req('header', 'a key of 191 characters, an empty body', {}, { key: 'k'.repeat(191) }); req('header', 'a key of 192 characters, an empty body', {}, { key: 'k'.repeat(192) });
  req('header', 'a key of 192 characters, a body that is no JSON', null, { key: 'j'.repeat(192), text: '{' });
  req('header', 'a key of 191 characters, an instruction that is fine', good('PAY-VEC-KEY-191'), { key: 'a'.repeat(191) });
  req('header', 'a key of 192 characters, an instruction that is fine', good('PAY-VEC-KEY-192'), { key: 'b'.repeat(192) });
  req('body', 'a body that is no JSON', null, { text: '{"payment_id":' }); req('body', 'a body that is null', null, { text: 'null' }); req('body', 'a body that is a list', null, { text: '[]' }); req('body', 'a body that is text', null, { text: '"PAY"' });
  req('body', 'an empty body', {}); req('body', 'a member named twice: the last counts', null, { text: `{"payment_id":"${ID}","payment_id":"abc"}` });
  req('stored', 'the key of a stored answer, the same body: the stored answer', { stored: 'body' }, { key: 'vec-stored-key' }); req('stored', 'the key of a stored answer, the same members in another order: another body', { body: 'stored' }, { key: 'vec-stored-key' });
  req('stored', 'the key of a stored answer, another body', {}, { key: 'vec-stored-key' }); req('stored', 'that key as another organisation: its own keys', {}, { key: 'vec-stored-key', org: 'b' });
  // The doors.
  for (const [org, why] of [['none', 'no key'], ['nosub', 'no subscription'], ['off', 'a subscription switched off'], ['nobank', 'no bank'], ['nokey', 'a bank without a key']]) req('door', `an organisation with ${why}, and a body that is no JSON`, null, { org, text: '{' });
  // Single faults.
  for (const id of ['abc', 'A'.repeat(65), 'PAY VEC', 'PAY/VEC', '-PAY-VEC', '_PAY_VEC', 'PAY-VEC\n', ' PAY-VEC', '', 'reconcile', 'bundle', 'PAY-ÅÄÖ', 'PAY.VEC', 'PAY-VEC\u0000']) req('payment id', `payment id ${JSON.stringify(id)}`, { ...good(), payment_id: id });
  // … and ids that are fine, each on an instruction of its own: accepted.
  for (const id of ['abcd', 'A'.repeat(64), 'Reconcile', 'BUNDLE', '0000', 'a_-_', 'Z---']) req('payment id', `payment id ${JSON.stringify(id)}, on an instruction of its own`, good(id));
  req('payment id', 'no payment id', change((b) => { delete b.payment_id; })); req('payment id', 'a payment id that is null', { ...good(), payment_id: null });
  req('payment id', 'the id of a settlement that exists', good('PAY-VEC-TAKEN')); req('payment id', 'the id of another organisation\'s settlement', good('PAY-VEC-OTHERS'));
  req('quote', 'no quote id', change((b) => { delete b.quote_id; })); req('quote', 'a quote nobody made', { ...good(), quote_id: 'QT-00000000-0000' }); req('quote', 'a quote of another organisation', { ...good(), quote_id: Q.ofB.quote_id });
  req('quote', 'a quote that has expired', { ...good(), quote_id: Q.expired.quote_id }); req('quote', 'a quote whose stored text is no JSON', { ...good(), quote_id: 'QT-VEC-BROKEN' }); req('quote', 'a quote for another amount', { ...good(), quote_id: Q.other.quote_id });
  const withAmount = (leg, over) => change((b) => { b.amount = { ...b.amount, [leg]: { ...b.amount[leg], ...over } }; });
  req('amounts', 'another collected amount', withAmount('collected', { value: '1' })); req('amounts', 'the collected amount as a number', withAmount('collected', { value: Number(Q.good.collect.amount) }));
  req('amounts', 'another collected currency', withAmount('collected', { currency: 'USD' })); req('amounts', 'another payout amount', withAmount('payout', { value: '1.00' }));
  req('amounts', 'the payout amount without its cents', withAmount('payout', { value: Q.good.payout.amount.replace(/\.\d+$/, '') })); req('amounts', 'no amounts', change((b) => { delete b.amount; })); req('amounts', 'amounts that are null', { ...good(), amount: null });
  const toward = (institution_id) => change((b) => { b.beneficiary = { ...b.beneficiary, institution_id }; });
  req('institution', 'no beneficiary', change((b) => { delete b.beneficiary; })); req('institution', 'an empty institution id', toward('')); req('institution', 'an institution nobody registered', toward('SG-BFI-NOBODY'));
  req('institution', 'the bank itself', toward(BANK.id)); req('institution', 'the settlement entity', toward(M.keys.partner.wallet.id)); req('institution', 'the platform', toward('STONEHASH')); req('institution', 'an institution without an encryption key', toward('SG-BFI-NOENC'));
  req('signature', 'no authorisation', change((b) => { delete b.bank_authorization; })); req('signature', 'an authorisation that is text', { ...good(), bank_authorization: 'yes' }); req('signature', 'an authorisation that is a list', { ...good(), bank_authorization: [] });
  req('signature', 'no signature', change((b) => { delete b.bank_signature; })); req('signature', 'a signature without its value', change((b) => { b.bank_signature = { alg: 'ES256', key_id: BANK.id, issuer: BANK.name }; }));
  req('signature', 'an authorisation changed after it was signed', change((b) => { b.bank_authorization = { ...b.bank_authorization, payment_release: 'AUTHORIZED ' }; })); req('signature', 'a signature of another key', change((b) => { b.bank_signature = signEvent(b.bank_authorization, stranger, BANK.id, BANK.name); }));
  req('signature', 'a signature of the other bank', change((b) => { b.bank_signature = sign(b.bank_authorization, bank2Key, BANK2); })); req('signature', 'a signature under another algorithm\'s name', change((b) => { b.bank_signature = { ...b.bank_signature, alg: 'ES384' }; }));
  req('signature', 'an authorisation with a fraction in it', change((b) => { b.bank_authorization = { ...b.bank_authorization, weight: 0.5 }; }));
  const comply = (fn) => change((b) => { const c = structuredClone(b.compliance_payload); b.compliance_payload = fn(c) ?? c; });
  req('travel rule', 'no travel-rule data', change((b) => { delete b.compliance_payload; })); req('travel rule', 'travel-rule data that is null', { ...good(), compliance_payload: null });
  for (const field of ['originator.name', 'originator.country', 'originator.address', 'originator.registration_number', 'beneficiary.name', 'beneficiary.country', 'beneficiary.account', 'beneficiary.bank']) { const [party, m] = field.split('.'); req('travel rule', `without ${field}`, comply((c) => { delete c[party][m]; })); }
  req('travel rule', 'an originator name that is white space', comply((c) => { c.originator.name = ' \t '; })); req('travel rule', 'a beneficiary account that is a number', comply((c) => { c.beneficiary.account = 9; }));
  req('travel rule', 'three fields missing: named in the fixed order', comply((c) => { delete c.beneficiary.bank; delete c.originator.registration_number; delete c.beneficiary.name; }));
  const ciphertext = 'eyJhbGciOiJFQ0RILUVTIiwiZW5jIjoiQTI1NkdDTSJ9..aXY.Y2lwaGVydGV4dA.dGFn';
  const digest = sha256hex('the message this ciphertext is said to hold');
  const statement = (over = {}, k = bankKey) => { const payload = plain({ payment_id: ID, required_fields_present: true, field_count: 8, schema: 'IVMS101-2023', ivms101_digest: digest, ciphertext_sha256: sha256hex(Buffer.from(ciphertext, 'utf8')), ...over }); return { payload, sig: signEvent(payload, k, BANK.id, BANK.name) }; };
  const modeB = (over) => ({ ...good(), compliance_payload: plain({ format: 'IVMS101-2023', mode: 'B', ciphertext, ivms101_digest: digest, fields_assertion: statement(), ...over }) });
  req('mode B', 'nothing but the mode', { ...good(), compliance_payload: { mode: 'B' } }); req('mode B', 'a ciphertext and no digest', modeB({ ivms101_digest: undefined })); req('mode B', 'a digest in capitals', modeB({ ivms101_digest: digest.toUpperCase() }));
  req('mode B', 'a digest and a line feed', modeB({ ivms101_digest: `${digest}\n` })); req('mode B', 'no statement of the bank', modeB({ fields_assertion: undefined })); req('mode B', 'a statement signed by another key', modeB({ fields_assertion: statement({}, stranger) }));
  req('mode B', 'a statement about another payment', modeB({ fields_assertion: statement({ payment_id: 'PAY-VEC-ANOTHER' }) })); req('mode B', 'a statement that says "true" in words', modeB({ fields_assertion: statement({ required_fields_present: 'true' }) }));
  req('mode B', 'a statement about another message', modeB({ fields_assertion: statement({ ivms101_digest: sha256hex('another message') }) })); req('mode B', 'a statement about another ciphertext', modeB({ fields_assertion: statement({ ciphertext_sha256: sha256hex('another ciphertext') }) }));
  req('mode B', 'a statement that names no ciphertext', modeB({ fields_assertion: statement({ ciphertext_sha256: undefined }) }));
  const withElement = (name, fn) => change((b) => { b.evidence_elements = { ...b.evidence_elements, [name]: fn(structuredClone(b.evidence_elements[name])) }; });
  req('elements', 'no evidence elements', change((b) => { delete b.evidence_elements; })); req('elements', 'evidence elements that are null', { ...good(), evidence_elements: null });
  for (const name of ['bankInstruction', 'bankApproval', 'commercialDocs']) {
    req('elements', `no ${name}`, change((b) => { const { [name]: _g, ...rest } = b.evidence_elements; b.evidence_elements = rest; })); req('elements', `${name} that is text`, withElement(name, () => 'an element'));
    req('elements', `${name} with a member more than was signed`, withElement(name, (e) => ({ ...e, changed: 'afterwards' }))); req('elements', `${name} without its signature`, withElement(name, (e) => { delete e.signature; return e; }));
    req('elements', `${name} signed by another key`, withElement(name, (e) => element(unsigned(e), stranger))); req('elements', `${name} with its digest changed`, withElement(name, (e) => ({ ...e, digest: sha256hex('another digest') })));
  }
  req('elements', 'the approval element where the instruction belongs', change((b) => { b.evidence_elements = { ...b.evidence_elements, bankInstruction: b.evidence_elements.bankApproval }; }));
  req('elements', 'an instruction element for another amount, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), amount: '1.00' }))); req('elements', 'an instruction element whose amount is a number, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), amount: 1200 })));
  req('elements', 'an instruction element in another currency, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), currency: 'USDC' }))); req('elements', 'an instruction element with another reference, signed', withElement('bankInstruction', (e) => element({ ...unsigned(e), ref: 'PAY-VEC-OTHER-REF' })));
  const msg = { type: 'pacs.008.001.08', sha256: sha('accept'), uetr: 'acce5500-1111-4222-8333-444455556666', messageId: 'VEC-ACC-MSG', instructionId: 'VEC-ACC-INS', endToEndId: 'VEC-ACC-E2E', valueDate: '2026-11-17', content: sha('accept content') };
  const from = (source, id = ID) => { const b = good(id); b.evidence_elements = { ...b.evidence_elements, bankInstruction: element({ ...unsigned(b.evidence_elements.bankInstruction), sourceMessage: plain(source) }) }; return b; };
  for (const [what, source] of [['is text', 'MT103'], ['is a list', [msg]], ['has no type', { ...msg, type: undefined }], ['has a type of 41 characters', { ...msg, type: 't'.repeat(41) }], ['has no file digest', { ...msg, sha256: undefined }],
    ['has a file digest with a line feed', { ...msg, sha256: `${msg.sha256.slice(1)}\n` }], ['has a position that is negative', { ...msg, index: -1 }], ['has a position that is text', { ...msg, index: '0' }], ['has a position above a million', { ...msg, index: 1000001 }],
    ['has a UETR that is no UUID', { ...msg, uetr: 'not-a-uuid' }], ['has an empty UETR', { ...msg, uetr: '' }], ['has a content digest that is no digest', { ...msg, content: 'cd' }], ['has a value date without hyphens', { ...msg, valueDate: '20261117' }],
    ['has a value date the calendar has not', { ...msg, valueDate: '2026-02-30' }], ['has a value date with a line feed', { ...msg, valueDate: '2026-11-17\n' }], ['has a value date in the year 99', { ...msg, valueDate: '0099-01-01' }],
    ['has an instruction id of 257 characters', { ...msg, instructionId: 'i'.repeat(257) }], ['has a message id that is a number', { ...msg, messageId: 7 }]]) req('source', `a reference that ${what}`, from(source));
  // Accepted — each on a payment id of its own; then what the transaction refuses.
  req('accepted', 'mode A', good('PAY-VEC-OK-A'), { key: 'vec-ok-a' });
  req('accepted', 'the same bytes under the same key: the stored answer', good('PAY-VEC-OK-A'), { key: 'vec-ok-a', text: requests.at(-1).bodyJson });
  req('accepted', 'the same bytes under another key: the settlement exists', null, { key: 'vec-ok-a-other', text: requests.at(-1).bodyJson });
  req('accepted', 'mode B (a ciphertext the platform cannot read, and the bank\'s statement about it)', (() => { const b = good('PAY-VEC-OK-B'); b.compliance_payload = plain({ format: 'IVMS101-2023', mode: 'B', ciphertext, ivms101_digest: digest, fields_assertion: statement({ payment_id: 'PAY-VEC-OK-B' }) }); return b; })(), { key: 'vec-ok-b' });
  req('accepted', 'made from a message', from(msg, 'PAY-VEC-OK-SRC'), { key: 'vec-ok-src' });
  req('accepted', 'the same message under another id: refused by the transaction', from(msg, 'PAY-VEC-OK-SRC-2'), { key: 'vec-ok-src-2' });
  req('accepted', 'with the second receiving institution, members nobody reads and a signature under another name', (() => { const b = good('PAY-VEC-OK-BFI2', { beneficiaryInstitution: M.keys.partner.bfi2.id }); b.note = 'x'; b.bank_signature = { ...b.bank_signature, key_id: 'SOMEBODY', issuer: 'Somebody' }; return b; })(), { key: 'vec-ok-bfi2' });
  req('accepted', 'of an organisation without a webhook address', good('PAY-VEC-OK-B-ORG', {}, sdk2, Q.ofB), { key: 'vec-ok-b-org', org: 'b' });
  M.acceptance = { paymentId: ID, requests, storedKey: { key: 'vec-stored-key', bodyJson: JSON.stringify({ stored: 'body' }), response: { payment_id: 'PAY-VEC-STORED', state: 'BANK_AUTHORIZED', accepted_at: '2026-11-18T00:00:00.000Z' } } };

  // ── the conflicts' sentences: pairs of instructions, the second running into the first ───────────────────────
  const pair = (name, first, second) => ({ name, first: { key: `vec-c-${name}-1`, bodyJson: JSON.stringify(from(first, `PAY-VEC-C-${name}-1`)) }, second: { key: `vec-c-${name}-2`, bodyJson: JSON.stringify(from(second, `PAY-VEC-C-${name}-2`)) } });
  const c = (over) => ({ ...msg, ...over });
  M.conflicts = [
    pair('MESSAGE', c({ sha256: sha('c message'), uetr: 'c0000001-1111-4222-8333-444455556666', instructionId: 'C-1' }), c({ sha256: sha('c message'), uetr: 'c0000001-1111-4222-8333-444455556666', instructionId: 'C-1', content: sha('another reading') })),
    pair('UETR', c({ sha256: sha('c uetr'), uetr: 'c0000002-1111-4222-8333-444455556666', instructionId: 'C-2' }), c({ sha256: sha('c uetr again'), uetr: 'C0000002-1111-4222-8333-444455556666', instructionId: 'C-2' })),
    pair('REUSED', c({ sha256: sha('c reused'), uetr: 'c0000003-1111-4222-8333-444455556666', instructionId: 'C-3' }), c({ sha256: sha('c reused other'), uetr: 'c0000003-1111-4222-8333-444455556666', instructionId: 'C-3', content: sha('other content') })),
    pair('TWIN', c({ sha256: sha('c twin'), uetr: undefined, instructionId: 'C-4' }), c({ sha256: sha('c twin again'), uetr: 'c0000004-1111-4222-8333-444455556666', instructionId: 'C-4' })),
    pair('UNDATED', c({ sha256: sha('c undated'), uetr: undefined, instructionId: 'C-5', valueDate: undefined }), c({ sha256: sha('c undated again'), uetr: undefined, instructionId: 'C-5', valueDate: undefined })),
  ];

  // ── the bank's statement in mode B, right and wrong in each way ──────────────────────────────────────────────
  const expectation = { paymentId: ID, ivms101Digest: digest, ciphertext };
  M.assertions = { expectation, cases: [
    ['as it should be', statement()], ['with members more than are read', statement({ note: 'x', fields: ['originator.name'] })], ['absent', undefined], ['null', null], ['without a payload', { sig: statement().sig }], ['without a signature', { payload: statement().payload }],
    ['with a payload that is null', { payload: null, sig: statement().sig }], ['signed by another key', statement({}, stranger)], ['changed after it was signed', { ...statement(), payload: { ...statement().payload, field_count: 9 } }],
    ['with a signature under another algorithm\'s name', { ...statement(), sig: { ...statement().sig, alg: 'ES384' } }], ['about another payment', statement({ payment_id: 'PAY-VEC-ANOTHER' })], ['about the payment in lower case', statement({ payment_id: ID.toLowerCase() })],
    ['that says "true" in words', statement({ required_fields_present: 'true' })], ['that says 1', statement({ required_fields_present: 1 })], ['that says false', statement({ required_fields_present: false })], ['that does not say', statement({ required_fields_present: undefined })],
    ['about another message', statement({ ivms101_digest: sha256hex('another message') })], ['with the message digest in capitals', statement({ ivms101_digest: digest.toUpperCase() })], ['without the message digest', statement({ ivms101_digest: undefined })],
    ['about another ciphertext', statement({ ciphertext_sha256: sha256hex('another') })], ['with the ciphertext digest in capitals', statement({ ciphertext_sha256: sha256hex(Buffer.from(ciphertext, 'utf8')).toUpperCase() })], ['without the ciphertext digest', statement({ ciphertext_sha256: undefined })],
    ['another payment and another message: the payment is answered', statement({ payment_id: 'PAY-VEC-ANOTHER', ivms101_digest: sha256hex('another message') })],
    ['signed by another key and about another payment: the signature is answered', statement({ payment_id: 'PAY-VEC-ANOTHER' }, stranger)],
  ].map(([name, fa]) => ({ name, statementJson: fa === undefined ? null : JSON.stringify(fa) })) };

  // ── a day's manifest, signed ─────────────────────────────────────────────────────────────────────────────────
  const manifest = (date, ids, more = {}) => ({ date, institution_id: BANK.id, payment_ids: ids, count: ids.length, ...more });
  const signedManifest = (name, m, { sig = sign(m), org = 'a' } = {}) => ({ name, org, bodyJson: JSON.stringify(plain({ manifest: m, sig })) });
  const day = ['PAY-VEC-M1', 'PAY-VEC-M2', 'PAY-VEC-M3'];
  M.manifests = [
    { name: 'an empty body', org: 'a', bodyJson: '{}' }, signedManifest('a date of another shape', manifest('17-11-2026', [])), signedManifest('a date with a line feed', manifest('2026-11-17\n', [])), signedManifest('a date that is a number', manifest(20261117, [])),
    signedManifest('ids that are text', { date: '2026-11-17', institution_id: BANK.id, payment_ids: 'PAY-VEC-M1', count: 1 }), signedManifest('a count that does not match', { date: '2026-11-17', institution_id: BANK.id, payment_ids: day, count: 2 }),
    signedManifest('a count that is text', { date: '2026-11-17', institution_id: BANK.id, payment_ids: day, count: '3' }), { name: 'no signature', org: 'a', bodyJson: JSON.stringify({ manifest: manifest('2026-11-17', day) }) },
    signedManifest('a signature of another key', manifest('2026-11-17', day), { sig: signEvent(manifest('2026-11-17', day), stranger, BANK.id, BANK.name) }), signedManifest('a manifest changed after it was signed', manifest('2026-11-17', [...day, 'PAY-ADDED']), { sig: sign(manifest('2026-11-17', day)) }),
    signedManifest('a wrong date, a wrong count and a wrong signature: the date', { date: 'today', payment_ids: [], count: 3 }, { sig: sign({}) }), signedManifest('a wrong count and a wrong signature: the count', { date: '2026-11-17', payment_ids: [], count: 3 }, { sig: sign({}) }),
    signedManifest('everything of the day', manifest('2026-11-17', day)), signedManifest('the day in another order', manifest('2026-11-17', [...day].reverse())), signedManifest('one left out', manifest('2026-11-17', day.slice(1))),
    signedManifest('one left out, one nobody knows twice, one of another organisation, one that is no text', manifest('2026-11-17', [day[0], day[2], 'PAY-NOBODY', 'PAY-NOBODY', 'PAY-VEC-OTHERS-M', 7])), signedManifest('each id twice', manifest('2026-11-17', [...day, ...day])),
    signedManifest('a day nothing was instructed on, with nothing', manifest('2020-01-01', [])), signedManifest('a day nothing was instructed on, with something', manifest('2020-01-02', ['PAY-VEC-M1'])), signedManifest('the next day: one settlement', manifest('2026-11-18', ['PAY-VEC-M4'])),
    signedManifest('of the other organisation, signed by its bank', { date: '2026-11-17', institution_id: BANK2.id, payment_ids: ['PAY-VEC-OTHERS-M'], count: 1 }, { sig: sign({ date: '2026-11-17', institution_id: BANK2.id, payment_ids: ['PAY-VEC-OTHERS-M'], count: 1 }, bank2Key, BANK2), org: 'b' }),
    signedManifest('of an organisation without a subscription', manifest('2026-11-17', []), { org: 'nosub' }),
  ];
  crypto.randomUUID = fixedUuid; syncBuiltinESMExports();
  ticking = false;
  return M;
}

let M;
if (existsSync(MATERIALS)) M = JSON.parse(readFileSync(MATERIALS, 'utf8'));
else {
  if (check) { console.error('remit-materials.json is missing — run without --check once'); await db.close(); process.exit(1); }
  M = await makeMaterials();
  writeFileSync(MATERIALS, `${JSON.stringify(M, null, 1)}\n`);
  console.log(`made ${path.relative(process.cwd(), MATERIALS)} (once; it is kept): ${M.recordings.length} recorded settlements, ${M.acceptance.requests.length} signed requests`);
}
const SPKI = { platform: spkiOf(M.keys.platformPem), bank: spkiOf(M.keys.bankPem), bank2: spkiOf(M.keys.bank2Pem), stranger: spkiOf(M.keys.strangerPem), ...Object.fromEntries(Object.entries(M.keys.partner).map(([slug, k]) => [slug, k.signing.spki])) };
const want = (name) => !only || only === name;
const V = {};

// ── quotes ──────────────────────────────────────────────────────────────────────────────────────────────────────
if (want('quotes')) {
  const operands = ['0', '0.0', '1', '1.5', '2.5', '10000', '10000.00', '007.50', '0.004', '0.005', '0.0049', '0.015', '0.994', '0.995', '1.005', '1.0049999', '999.995', '0.05', '49999.99', '25380', '25380.5', '1.3350', '25.00', '25',
    '123456789012345678901234567890.123456789012345678901234567890', '0.000000000000000001', '99999999999999999999', '', '.5', '5.', '+1', '-1', '1e3', ' 1', '1 ', '1,5', '１', '1\n', '\n1', 'abc', '1.2.3', '0x10', 'NaN', 'Infinity'];
  const mul = [];
  for (const a of operands) for (const [b, scale] of [['1', 2], ['1', 0], ['25380', 0], ['25380.5', 0], ['1.3350', 2], ['0.5', 0], ['0.005', 2], ['1', 18], ['3', 1], ['0.1', 3]]) mul.push({ a, b, scale, answer: answer(() => mulDecimal(a, b, scale)) });
  for (const b of ['', 'x', '1.', '-2', '1\n', ' 2']) mul.push({ a: '10', b, scale: 2, answer: answer(() => mulDecimal('10', b, 2)) });
  const add = [];
  for (const a of ['0', '10000', '10000.00', '0.005', '0.004', '1.005', '999.995', '49999.99', '0.994', '', 'x', '1e2', '1\n']) for (const [b, scale] of [['25.00', 2], ['25', 2], ['0.005', 2], ['0.004', 2], ['0', 0], ['0.5', 0], ['0.49', 0], ['abc', 2], ['25.005', 2], ['0.0000001', 6]]) add.push({ a, b, scale, answer: answer(() => addDecimal(a, b, scale)) });
  const good = QUOTE_REQUEST('10000');
  const cfgs = [['the defaults', quoteCfg()], ['a rate with decimals', quoteCfg({ rates: { usdVnd: '25380.5', usdSgd: '1.3' } })], ['no fee', quoteCfg({ feeUsd: '0' })], ['a fee of three decimals', quoteCfg({ feeUsd: '25.005' })], ['a fee without decimals', quoteCfg({ feeUsd: '25' })],
    ['a collection rate that is no number', quoteCfg({ rates: { usdVnd: 'abc', usdSgd: '1.3350' } })], ['a payout rate that is empty', quoteCfg({ rates: { usdVnd: '25380', usdSgd: '' } })], ['a fee that is no number', quoteCfg({ feeUsd: 'free' })], ['another chain, no lifetime', quoteCfg({ chainLabel: 'eip155:1', ttlMs: 0 })]];
  const quoteAnswer = (requestJson, cfg) => { const a = answer(() => JSON.stringify({ ...buildQuote(JSON.parse(requestJson), cfg, QUOTE_NOW), quote_id: 'QT-<id>' })); return a.value !== undefined ? { quoteJson: a.value } : a; };
  const row = (name, request, [cfgName, cfg]) => { const requestJson = JSON.stringify(request); return { name: `${name}, ${cfgName}`, requestJson, cfg: { rateUsdVnd: cfg.rates.usdVnd, rateUsdSgd: cfg.rates.usdSgd, feeUsd: cfg.feeUsd, ttlMs: cfg.ttlMs, chainLabel: cfg.chainLabel }, now: QUOTE_NOW.getTime(), answer: quoteAnswer(requestJson, cfg) }; };
  const build = [];
  for (const cfg of cfgs) for (const amount of ['10000', '1.005', '0.005', '0']) build.push(row(`amount ${JSON.stringify(amount)}`, QUOTE_REQUEST(amount), cfg));
  for (const amount of ['0.00', '1', '0.0049', '0.994', '0.995', '999.995', '1200.00', '007.50', '00012.50', '49999.99', '50000.01', '123456789012345678901234567890.12', '1e3', '-5', '+5', '', ' 1', '1 ', '1\n', '１', '.5', '5.', '1,000', 'abc']) build.push(row(`amount ${JSON.stringify(amount)}`, QUOTE_REQUEST(amount), cfgs[0]));
  const places = { '$': (r, v) => v, corridor: (r, v) => ({ ...r, corridor: v }), 'corridor.origin': (r, v) => ({ ...r, corridor: { ...r.corridor, origin: v } }), 'corridor.destination': (r, v) => ({ ...r, corridor: { ...r.corridor, destination: v } }),
    trade: (r, v) => ({ ...r, trade: v }), 'trade.currency': (r, v) => ({ ...r, trade: { ...r.trade, currency: v } }), 'trade.amount': (r, v) => ({ ...r, trade: { ...r.trade, amount: v } }), collect: (r, v) => ({ ...r, collect: v }),
    'collect.currency': (r, v) => ({ ...r, collect: { currency: v } }), payout: (r, v) => ({ ...r, payout: v }), 'payout.currency': (r, v) => ({ ...r, payout: { currency: v } }) };
  const kinds = [null, true, false, 0, 1, 12.5, 1e21, '', ' ', 'VN', 'vn', 'USD', 'usd', '12.50', [], ['VN'], ['12.50'], {}, { origin: 'VN' }, { currency: 'USD' }];
  const table = [];
  for (const [place, put] of Object.entries(places)) for (const value of kinds) { const requestJson = JSON.stringify(put(good, value)); table.push({ place, valueJson: JSON.stringify(value), requestJson, answer: quoteAnswer(requestJson, cfgs[0][1]) }); }
  for (const [place, put] of Object.entries(places)) if (place !== '$') { const r = put(good, undefined); table.push({ place, valueJson: null, requestJson: JSON.stringify(r), answer: quoteAnswer(JSON.stringify(r), cfgs[0][1]) }); }
  const wrong = [['unsupported_corridor', (b) => { b.corridor = { origin: 'XX', destination: 'YY' }; }], ['unsupported_trade_currency', (b) => { b.trade = { ...b.trade, currency: 'EUR' }; }], ['unsupported_leg_currency', (b) => { b.collect = { currency: 'USD' }; }], ['invalid_amount', (b) => { b.trade = { ...b.trade, amount: 'a lot' }; }]];
  const order = wrong.map((_, i) => { const b = plain(good); for (let j = wrong.length - 1; j >= i; j--) wrong[j][1](b); const requestJson = JSON.stringify(b); return { first: wrong[i][0], requestJson, answer: quoteAnswer(requestJson, cfgs[0][1]) }; });
  V.quotes = { mul, add, build, table, order };
}

// ── the source reference ────────────────────────────────────────────────────────────────────────────────────────
if (want('sourceRefs')) {
  const U = 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57';
  const full = { type: 'MT103', sha256: 'ab'.repeat(32), uetr: U, messageId: 'M-1', instructionId: 'I-1', endToEndId: 'E-1', valueDate: '2026-11-17', content: 'cd'.repeat(32) };
  /** The text a twin key is the SHA-256 of — written out again here from the rule (docs/REMIT-HANDOVER.md 1.1), and held to the reference's key. */
  const twinText = (r) => {
    if (r === null || r.content === null) return null;
    const m = r.source; const t = (k) => (typeof m[k] === 'string' ? m[k] : '').trim();
    const e2e = /^(NOTPROVIDED|NONREF|NOREF)$/i.test(t('endToEndId')) ? '' : t('endToEndId');
    if (t('instructionId') !== '' || e2e !== '') return JSON.stringify(['stonehash:remit:twin:v1', t('instructionId'), e2e, r.valueDate ?? '', r.content]);
    if (t('messageId') !== '') return JSON.stringify(['stonehash:remit:twin-by-message:v1', r.messageType, t('messageId'), r.index, r.valueDate ?? '', r.content]);
    return null;
  };
  const strictOf = (json) => {
    const a = answer(() => sourceRefOf(JSON.parse(json)));
    if (a.value) {
      const text = twinText({ ...a.value, source: JSON.parse(json) });
      if ((text === null) !== (a.value.twinKey === null) || (text !== null && sha256hex(text) !== a.value.twinKey)) throw new Error(`the twin key of ${json} is not the SHA-256 of the text this tool writes for it`);
      a.twinText = text;
    }
    return a;
  };
  const edge = ['a"b', 'a\\b', 'a/b', 'tab\there', 'line\nbreak', '\u0000', '\u0001', '\u001f', '\u007f', '\u0080', ' ', ' ', 'é', '안녕', '😀', '\ud83d', '\ude00', '\ude00\ud83d', 'à', 'ﬁ', 'İ',
    ' pad ', ' pad ', '﻿pad﻿', ' pad ', '　pad ', '\u0085pad\u0085', '​pad​', '᠎pad', '\u001cpad\u001f', '\tpad\n', '\u000bpad\u000c', ' pad ', ' pad '];
  const cases = [
    full, { ...full, index: 3 }, { ...full, index: 0 }, { ...full, index: 1000000 }, { ...full, index: 1000001 }, { ...full, index: 0.5 }, { ...full, index: -1 }, { ...full, index: '0' }, { ...full, index: true }, { ...full, index: [] }, { ...full, index: null }, { ...full, index: {} },
    { ...full, uetr: undefined, type: 'pacs.008.001.08', sha256: 'ef'.repeat(32), messageId: 'Z9', index: 4 }, { ...full, valueDate: '2026-11-18' }, { ...full, content: 'ee'.repeat(32) }, { ...full, endToEndId: 'PO-2' }, { ...full, content: undefined }, { ...full, content: null },
    { ...full, uetr: U.toUpperCase(), sha256: 'AB'.repeat(32), content: 'CD'.repeat(32) }, { ...full, instructionId: ' I-1 ', endToEndId: 'E-1\t' },
    ...['NOTPROVIDED', 'notprovided', ' NONREF ', 'NoRef', '', '   ', 'NOTPROVIDED.', 'NONE', 'NOT PROVIDED', 'N/A', 'NOREF\n'].map((endToEndId) => ({ ...full, instructionId: undefined, endToEndId })),
    ...['NOTPROVIDED', 'nonref'].map((instructionId) => ({ ...full, instructionId, endToEndId: undefined })),
    { ...full, endToEndId: undefined }, { ...full, instructionId: undefined, endToEndId: undefined }, { ...full, instructionId: undefined, endToEndId: 'NOTPROVIDED', type: 'pain.001.001.09', messageId: 'FILE-7' },
    { ...full, instructionId: undefined, endToEndId: 'NOTPROVIDED', type: 'pain.001.001.09', messageId: ' FILE-7 ', sha256: 'ef'.repeat(32), uetr: undefined }, { ...full, instructionId: undefined, endToEndId: undefined, messageId: undefined },
    { ...full, instructionId: '', endToEndId: '', messageId: '' }, { ...full, instructionId: null, endToEndId: null, messageId: null }, { ...full, valueDate: undefined }, { ...full, valueDate: null },
    ...edge.map((instructionId) => ({ ...full, instructionId })), ...edge.slice(0, 18).map((messageId) => ({ ...full, instructionId: undefined, endToEndId: undefined, messageId })), ...edge.slice(0, 12).map((endToEndId) => ({ ...full, endToEndId })),
    ...['MT"103', 'pacs.008\\001', 'type\twith tab', '유형', '😀', '\ud83d', 'x'.repeat(40), 'x'.repeat(41), ' MT103 ', ''].map((type) => ({ ...full, instructionId: undefined, endToEndId: undefined, type })),
    { ...full, messageId: 'm'.repeat(256), instructionId: undefined, endToEndId: undefined }, { ...full, messageId: 'm'.repeat(257) }, { ...full, instructionId: '😀'.repeat(128) }, { ...full, instructionId: `${'😀'.repeat(128)}x` }, { ...full, endToEndId: ' '.repeat(256) }, { ...full, endToEndId: ' '.repeat(257) },
    { ...full, uetr: `${U} ` }, { ...full, uetr: U.replaceAll('-', '') }, { ...full, uetr: 7 }, { ...full, uetr: '' }, { ...full, uetr: `${U}\n` }, { ...full, uetr: `{${U.slice(1, -1)}}` }, { ...full, uetr: [U] }, { ...full, uetr: U.replace('b', 'g') }, { ...full, uetr: null },
    { ...full, content: 'cd' }, { ...full, content: '' }, { ...full, content: `${'cd'.repeat(32)}\n` }, { ...full, content: `${'cd'.repeat(31)}c\n` }, { ...full, content: 5 }, { ...full, content: 'zz'.repeat(32) },
    { ...full, sha256: undefined }, { ...full, sha256: null }, { ...full, sha256: 'zz'.repeat(32) }, { ...full, sha256: 5 }, { ...full, sha256: '' }, { ...full, sha256: `${'ab'.repeat(31)}a\n` }, { ...full, sha256: ` ${'ab'.repeat(32)}` }, { ...full, sha256: 'ab'.repeat(33) },
    { ...full, type: '' }, { ...full, type: undefined }, { ...full, type: null }, { ...full, type: 5 }, { ...full, type: ['MT103'] }, { ...full, instructionId: ['I-1'] }, { ...full, instructionId: 5 }, { ...full, endToEndId: 'x'.repeat(300) }, { ...full, messageId: 7 }, { ...full, messageId: {} },
    ...['20261117', '2026-11-17T00:00:00Z', ' 2026-11-17', '2026-11-17 ', '17/11/2026', '2026-02-31', '2026-02-29', '2028-02-29', '2100-02-29', '2000-02-29', '2026-13-01', '2026-00-10', '2026-01-00', '2026-04-31', '0099-01-01', '0100-01-01', '0000-01-01', '9999-12-31',
      '2026-11-17\n', '', '２０２６-11-17', '2026-1-7', '+2026-11-17', '2026-11-1７'].map((valueDate) => ({ ...full, valueDate })), { ...full, valueDate: 20261117 }, { ...full, valueDate: ['2026-11-17'] }, { ...full, valueDate: 'x'.repeat(33) },
    { type: 'MT103' }, { sha256: 'ab'.repeat(32) }, {}, { ...full, extra: { nested: [1, 2] }, paymentInfoId: 'P-1' },
  ].map((v) => JSON.stringify(v)).concat(['"MT103"', `[${JSON.stringify(full)}]`, '7', 'true', 'false', 'null', '""', '0', '[]', `{"type":"MT103","type":"pacs.008","sha256":"${'ab'.repeat(32)}"}`, `{"index":-0,"type":"MT103","sha256":"${'ab'.repeat(32)}"}`,
    `{"index":1e3,"type":"MT103","sha256":"${'ab'.repeat(32)}"}`, `{"index":5.0,"type":"MT103","sha256":"${'ab'.repeat(32)}"}`, `{"index":1e6,"type":"MT103","sha256":"${'ab'.repeat(32)}"}`, `{"index":1e21,"type":"MT103","sha256":"${'ab'.repeat(32)}"}`]);
  const strict = cases.map((json) => ({ json, answer: strictOf(json) }));
  const legacyCases = [full, { uetr: U.toUpperCase(), index: '1', valueDate: '20261117', instructionId: ' I-1 ', content: 'CD'.repeat(32) }, { uetr: U }, {}, { type: 'x'.repeat(41) }, { type: 5, sha256: 'zz', index: -3 }, { index: '0000007' }, { index: '12345678' }, { index: 1000001 }, { index: 1.5 },
    { index: '1.5' }, { index: ' 3' }, { index: true }, { sha256: 'AB'.repeat(32) }, { sha256: ` ${'ab'.repeat(32)}` }, { uetr: ` ${U} ` }, { uetr: 'not-a-uuid' }, { uetr: 7 }, { content: 'CD'.repeat(32) }, { content: 'cd' }, { valueDate: ' 2026-11-17 ' }, { valueDate: '2026-02-30' },
    { valueDate: 20261117 }, { endToEndId: ' NOTPROVIDED ', messageId: 'FILE-7', content: 'cc'.repeat(32), type: 'pain.001.001.09' }, { instructionId: 'i'.repeat(257), content: 'cc'.repeat(32) }, { instructionId: 7, endToEndId: ['x'], messageId: null, content: 'cc'.repeat(32) },
    { ...full, type: '' }, { ...full, sha256: undefined }, { ...full, valueDate: undefined }, { ...full, uetr: U.toUpperCase(), sha256: 'AB'.repeat(32) }].map((v) => JSON.stringify(v)).concat(['"MT103"', '[]', '7', 'null', 'true']);
  const legacy = [];
  for (const json of legacyCases) for (const paymentId of ['PAY-OLD', 'PAY-OTHER']) legacy.push({ json, paymentId, answer: answer(() => legacySourceRefOf(JSON.parse(json), paymentId)) });
  V.sourceRefs = { strict, legacy };
}

// ── request hashes ──────────────────────────────────────────────────────────────────────────────────────────────
if (want('requestHashes')) {
  const texts = ['{}', '{"a":1,"b":2}', '{"b":2,"a":1}', '{ "a" : 1 , "b" : [ 1 , 2 ] }', '{"b":1,"2":0,"10":0,"a":1,"1":7}', '{"a":1,"a":2,"b":3}', '{"b":0,"a":1,"b":3}', '{"__proto__":{"x":1},"y":2}', '{"constructor":1,"toString":2}',
    '{"n":1.0}', '{"n":1e3}', '{"n":-0}', '{"n":0.0}', '{"n":1e21}', '{"n":1e-7}', '{"n":0.1}', '{"n":123456789012345680000}', '{"n":0.30000000000000004}', '{"n":9007199254740993}', '{"n":1E+2}', '{"n":-1.50}', '{"n":5e-324}', '{"n":1.7976931348623157e308}',
    '{"s":"\\u00e9"}', '{"s":"é"}', '{"s":"\\/"}', '{"s":"\\ud83d"}', '{"s":"\\ude00\\ud83d"}', '{"s":"\\ud83d\\ude00"}', '{"s":"\\u2028\\u2029"}', '{"s":"\\u0000\\u0001\\u001f\\"\\\\"}', '{"s":"line\\nbreak\\ttab\\r\\b\\f"}', '{"s":"\\u007f\\u0080"}', '{"\\u00e9":"key"}',
    '[]', '[1,"2",null,true,false,{"a":[]}]', '"text"', '7', 'true', 'null', '{"a":{"b":{"c":{"d":[{"e":null}]}}}}', '\n {"a":1}\n', '{"한글":"값","emoji":"😀"}', '{"":""}', `{"deep":${'['.repeat(300)}${']'.repeat(300)}}`,
    '{"payment_id":"PAY-1","quote_id":"QT-1","amount":{"collected":{"currency":"VND","value":"1"},"payout":{"currency":"SGD","value":"1.00"}}}', M.acceptance.requests.find((r) => r.name === 'mode A').bodyJson, M.acceptance.storedKey.bodyJson];
  V.requestHashes = texts.map((text) => ({ text, hash: sha256hex(JSON.stringify(JSON.parse(text))) }));
}

// ── the bank's statement in mode B ──────────────────────────────────────────────────────────────────────────────
if (want('fieldsAssertion')) {
  const e = M.assertions.expectation;
  V.fieldsAssertion = { expectation: { ...e, bankSpki: SPKI.bank }, cases: M.assertions.cases.map((c) => ({ ...c, problem: fieldsAssertionProblem(c.statementJson === null ? undefined : JSON.parse(c.statementJson), { ...e, bankSpki: SPKI.bank }) })) };
}

// ── webhooks: the ladder; cursors ───────────────────────────────────────────────────────────────────────────────
if (want('webhooks')) {
  // `reschedule` writes one of two statements; a store that only remembers what it was told to write shows which.
  const ladder = [];
  for (const maxAttempts of [0, 1, 2, 3, 4, 5, 6, 7, 9, 12]) {
    for (let attempts = 0; attempts <= 10; attempts++) {
      let written = null;
      const fake = { prepare: (sql) => ({ run: async (...p) => { written = { sql: sql.replace(/\s+/g, ' ').trim(), params: p }; return { changes: 1 }; } }) };
      const outbox = new WebhookOutbox(fake, platformOf(M), maxAttempts, () => {});
      at('2026-11-19T06:00:00.000Z');
      await outbox.reschedule('delivery-1', attempts, 'HTTP 500');
      const exhausted = written.sql.includes("status = 'exhausted'");
      ladder.push({ maxAttempts, attemptsBefore: attempts, after: exhausted ? { status: 'exhausted', attempts: written.params[0], last_error: written.params[1] }
        : { status: 'pending', attempts: written.params[0], last_error: written.params[1], delayMs: RealDate.parse(written.params[2]) - RealDate.parse('2026-11-19T06:00:00.000Z') } });
    }
  }
  const envelopes = [];
  for (const r of M.recordings) for (const w of r.rows.remit_webhook_deliveries) {
    const body = JSON.parse(w.body);
    if (!verifyEvent(body.envelope, body.signature, SPKI.platform)) throw new Error(`a recorded webhook of ${r.name} does not verify`);
    if (JSON.stringify(body) !== w.body) throw new Error('a recorded webhook body is not what JSON.stringify writes');
    envelopes.push({ recording: r.name, type: body.envelope.type, sequence: body.envelope.sequence, state: body.envelope.state, dataJson: JSON.stringify(body.envelope.data), url: w.url, body: w.body,
      signedBytesSha256: sha256hex(eventSigningBytes(body.envelope)), status: w.status, attempts: w.attempts });
  }
  V.webhooks = { platformSpki: SPKI.platform, ladder, envelopes, noAddress: M.recordings.filter((r) => r.rows.remit_webhook_deliveries.length === 0).map((r) => r.name) };
}
if (want('cursors')) {
  const fakeStore = (rows2) => new RemitStore({ dialect: 'mysql', prepare: () => ({ get: async () => ({ n: rows2.length }), all: async () => rows2 }) });
  const issued = [];
  for (const [c, i] of [['2026-11-19T06:00:00.000Z', 'PAY-1'], ['2026-10-05T08:00:00.001Z', 'PAY-SEED-ANCHORED-A'], ['', ''], ['2026-11-19T06:00:00.000Z', 'A'.repeat(64)], ['time "quoted"', 'id\\with\\backslash'], ['시각', '결제-😀'], ['2026-11-19T06:00:00.000Z', 'PAY?>~'], ['\ud83d', 'lone surrogate']]) {
    const page = await fakeStore([{ created_at: c, id: i }, { created_at: 'next', id: 'next' }]).search('org', { limit: 1 });
    issued.push({ created_at: c, id: i, cursor: page.nextCursor });
  }
  const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const texts = [b64({ c: '2026-10-05T00:00:00.000Z', i: 'PAY-1' }), `${b64({ c: '2026-10-05T00:00:00.000Z', i: 'PAY-1' })}=`, `${b64({ c: 'a', i: 'b' })}==`, Buffer.from(JSON.stringify({ c: 'a?>', i: 'b~~' })).toString('base64'), b64({ i: 'PAY-1', c: 'x' }), b64({ c: 'x', i: 'y', more: 1 }),
    b64({ c: '', i: '' }), b64({}), b64({ c: 'x' }), b64({ i: 'y' }), b64({ c: 5, i: 'y' }), b64({ c: 'x', i: 6 }), b64({ c: null, i: 'y' }), b64({ c: ['x'], i: 'y' }), b64([]), b64('null'), b64('"text"'), b64('7'), b64('{"c":"a","i":"b"}x'), b64('{c:1}'), b64(' {"c":"a","i":"b"} '),
    'x', 'next', '.', '%', ' ', '', `${b64({ c: 'a', i: 'b' }).slice(0, 6)} ${b64({ c: 'a', i: 'b' }).slice(6)}`, `${b64({ c: 'a', i: 'b' })}*!`, `${b64({ c: 'a', i: 'b' })}\n`, b64({ c: 'a', i: 'b' }).slice(0, -1), b64({ c: 'a', i: 'b' }).slice(0, -2),
    Buffer.from([0x7b, 0x22, 0x63, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x2c, 0x22, 0x69, 0x22, 0x3a, 0x22, 0x61, 0x22, 0x7d]).toString('base64url'), b64({ c: '\ud83d', i: '😀' }), b64('{"c":"a","i":"b","c":"z"}'), b64('{"__proto__":{"c":"a","i":"b"}}')];
  const read = [];
  for (const cursor of texts) {
    let seen = null;
    const store = new RemitStore({ dialect: 'mysql', prepare: (sql) => ({ get: async () => ({ n: 0 }), all: async (...p) => { if (sql.includes('created_at < ?')) seen = { c: p[p.length - 3], i: p[p.length - 1] }; return []; } }) });
    try { await store.search('org', { cursor, limit: 5 }); read.push({ cursor, answer: cursor === '' ? { value: null, note: 'an empty cursor is no cursor' } : { value: seen } }); } catch (e) { read.push({ cursor, answer: refusal(e) }); }
  }
  V.cursors = { issued, read };
}

// ── what needs the store ────────────────────────────────────────────────────────────────────────────────────────
const basePayment = (org, id, quote) => ({ id, org_id: org, quote_id: quote, corridor_origin: 'VN', corridor_destination: 'SG', trade_currency: 'USD', trade_amount: '1200.00', collect_currency: 'VND', collect_amount: '31090500', usdc_amount: '1200.00',
  payout_currency: 'SGD', payout_amount: '1602.00', beneficiary_institution: M.keys.partner.bfi.id, request_body: '{}' });
const insert = async (table, row) => { const cols = Object.keys(row); await db.prepare(`INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c])); };

if (want('duplicates')) {
  await empty();
  section('duplicates');
  const store = new RemitStore(db);
  const U = ['b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57', '0b5f6c1e-2a47-4c3d-9e8f-7a6b5c4d3e2f', '7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f', '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a'];
  const base = (over = {}) => ({ type: 'MT103', sha256: 'ab'.repeat(32), uetr: U[0], messageId: 'A1', instructionId: 'A1', valueDate: '2026-11-17', content: 'cd'.repeat(32), ...over });
  const f = (label) => createHash('sha256').update(`file:${label}`).digest('hex');
  const instalment = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'BATCH-1', endToEndId: 'RENT', content: 'aa'.repeat(32) };
  const bare = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, endToEndId: 'NOTPROVIDED', messageId: 'FILE-7', content: 'cc'.repeat(32) };
  const undated = { uetr: undefined, instructionId: 'C3', messageId: 'C3', valueDate: undefined, content: 'dd'.repeat(32) };
  const anonymous = { uetr: undefined, instructionId: undefined, messageId: undefined };
  const h = { instructionId: 'H1', messageId: 'H1', content: '10'.repeat(32) };
  const inBatch = { type: 'pain.001.001.09', uetr: undefined, instructionId: 'INS-7', messageId: 'BATCH-2', content: 'bb'.repeat(32) };
  const two = { type: 'pain.001.001.09', uetr: undefined, instructionId: undefined, messageId: 'F', endToEndId: 'SAME', valueDate: '2026-11-17', content: 'f0'.repeat(32) };
  const S = (id, over, org) => ({ id, source: base(over), ...(org ? { org } : {}) });
  const named = [
    ['apps/core/test/remit.test.ts — one message is one settlement (its steps one after the other)', [S('PAY-1', {}), S('PAY-2', {}), S('PAY-2b', { content: 'e0'.repeat(32) }), S('PAY-2c', { sha256: f('again') }), S('PAY-3', { sha256: f('other amount'), content: 'ee'.repeat(32) }),
      S('PAY-3b', { index: 1 }), S('PAY-4', { sha256: f('stripped'), uetr: undefined }), S('PAY-5', { sha256: f('own uetr'), uetr: U[1] }), S('PAY-6', { sha256: f('next day'), uetr: undefined, valueDate: '2026-11-18' }), S('PAY-7', {}, 'other'),
      S('PAY-1', { sha256: f('new'), uetr: U[2], instructionId: 'F6' }), S('PAY-24', { sha256: f('new'), uetr: U[2], instructionId: 'F6' }), S('PAY-18', { ...anonymous, sha256: f('anon 1') }), S('PAY-19', { ...anonymous, sha256: f('anon 2') }),
      S('PAY-20', { sha256: f('race'), uetr: U[3], instructionId: 'D4' }), S('PAY-21', { sha256: f('race'), uetr: U[3], instructionId: 'D4' }), S('PAY-22', { sha256: f('race bare'), uetr: undefined, instructionId: 'E5' }),
      S('PAY-23', { sha256: f('race full'), uetr: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', instructionId: 'E5' }), S('PAY-25', { sha256: f('id race 1'), uetr: undefined, instructionId: 'G1' }), S('PAY-25', { sha256: f('id race 2'), uetr: undefined, instructionId: 'G2' })]],
    ['apps/core/test/remit.test.ts — a twin is matched one to one', [S('PAY-H', { ...h, sha256: f('H bare'), uetr: undefined }), S('PAY-W1', { ...h, sha256: f('H with U1'), uetr: U[0] }), S('PAY-W2', { ...h, sha256: f('H with U2'), uetr: U[1] }), S('PAY-W1b', { ...h, sha256: f('H with U1'), uetr: U[0] }),
      S('PAY-W1c', { ...h, sha256: f('H with U1, again'), uetr: U[0] }), S('PAY-W3', { ...h, sha256: f('H bare, later'), uetr: undefined }), S('PAY-F0', { ...instalment, sha256: f('F'), index: 0 }), S('PAY-X0', { ...instalment, messageId: 'BATCH-1R', sha256: f('F again'), index: 0 }),
      S('PAY-F1R', { ...instalment, messageId: 'BATCH-1R', sha256: f('F again'), index: 1 }), S('PAY-X1', { ...instalment, sha256: f('F'), index: 1 }), S('PAY-X0b', { ...instalment, messageId: 'BATCH-1R', sha256: f('F again'), index: 0 }), S('PAY-X1b', { ...instalment, sha256: f('F'), index: 1 }),
      S('PAY-Y1', { ...instalment, sha256: f('F third'), index: 1 }), S('PAY-Y0', { ...instalment, sha256: f('F third'), index: 0 }), S('PAY-B7', { ...inBatch, sha256: f('batch 2'), index: 6 }), S('PAY-B7x', { ...inBatch, messageId: 'SINGLE-9', sha256: f('alone'), index: 0 }),
      S('PAY-N0', { ...bare, sha256: f('file 7') }), S('PAY-N0x', { ...bare, sha256: f('file 7, new creation time') }), S('BANK-RETRY-2', { ...bare, sha256: f('file 7, third time'), endToEndId: undefined }), S('PAY-N1', { ...bare, sha256: f('file 7'), index: 1 }),
      S('PAY-N8', { ...bare, sha256: f('file 8'), messageId: 'FILE-8' }), S('PAY-16', { ...undated, sha256: f('undated') }), S('PAY-17', { ...undated, sha256: f('undated again') }), S('PAY-17', { ...undated, sha256: f('undated again') }), S('PAY-17b', { ...undated, sha256: f('undated') })]],
    ['apps/core/test/mysql-parity.test.ts — the rules as its last sub-test states them', [S('PAY-SRC-1', { sha256: f('base') }), S('PAY-SRC-2', { sha256: f('base') }), S('PAY-SRC-3', { sha256: f('other amount'), content: 'ee'.repeat(32) }), S('PAY-SRC-4', { sha256: f('stripped'), uetr: undefined }),
      S('PAY-SRC-4', { sha256: f('stripped'), uetr: undefined }), S('PAY-SRC-5', { sha256: f('own uetr'), uetr: U[1] }), S('PAY-SRC-1', { sha256: f('new'), uetr: undefined, instructionId: 'Z9' }), S('PAY-F0', { ...instalment, sha256: f('F'), index: 0 }),
      S('PAY-X0', { ...instalment, sha256: f('F again'), index: 0 }), S('PAY-F1R', { ...instalment, sha256: f('F again'), index: 1 }), S('PAY-X1', { ...instalment, sha256: f('F'), index: 1 }), S('PAY-H', { ...h, sha256: f('H bare'), uetr: undefined }),
      S('PAY-W1', { ...h, sha256: f('H with U1'), uetr: U[2] }), S('PAY-W2', { ...h, sha256: f('H with U2'), uetr: '11111111-2222-4333-8444-555555555555' }), S('PAY-N0', { ...bare, sha256: f('file 7') }), S('PAY-N0x', { ...bare, sha256: f('file 7 again') }),
      S('PAY-U0', { uetr: undefined, instructionId: 'C3', valueDate: undefined, content: 'dd'.repeat(32), sha256: f('undated') }), S('PAY-U1', { uetr: undefined, instructionId: 'C3', valueDate: undefined, content: 'dd'.repeat(32), sha256: f('undated again') })]],
    ['docs/REMIT-HANDOVER.md 1.1 — two like transactions of one file, written out again, the second with a UETR', [{ id: 'PAY-F0', source: { ...two, sha256: f('F'), index: 0 } }, { id: 'PAY-F1', source: { ...two, sha256: f('F'), index: 1 } },
      { id: 'PAY-G0', source: { ...two, messageId: 'F-again', sha256: f('F prime'), index: 0 } }, { id: 'PAY-G1', source: { ...two, messageId: 'F-again', sha256: f('F prime'), index: 1, uetr: U[1] } },
      { id: 'PAY-G1b', source: { ...two, messageId: 'F-third', sha256: f('F third'), index: 1, uetr: U[1] } }, { id: 'PAY-G2', source: { ...two, messageId: 'F-third', sha256: f('F third'), index: 0, uetr: U[2] } }]],
    // One branch of the four steps at a time.
    ['step 1 — the same transaction of the same file, whatever else differs', [S('P1', {}), S('P2', { uetr: U[1], instructionId: 'OTHER', content: 'e1'.repeat(32), valueDate: '2026-12-01', type: 'pacs.008.001.08' }), S('P3', { uetr: undefined, content: undefined }), S('P4', { sha256: 'AB'.repeat(32) })]],
    ['step 1 — another position of the same file is another transaction', [S('P1', { uetr: undefined }), S('P2', { uetr: undefined, index: 1 }), S('P3', { uetr: undefined, index: 1 }), S('P4', { uetr: undefined, index: 2, instructionId: 'A2' })]],
    ['step 2 — a recognition stands, also after what it was recognised by is gone from the picture', [S('P1', { uetr: undefined }), S('P2', { sha256: f('s2 a'), uetr: U[1] }), S('P3', { sha256: f('s2 a'), uetr: U[2], instructionId: 'ELSE', content: 'e2'.repeat(32) }), S('P4', { sha256: f('s2 a'), uetr: undefined, index: 0 })]],
    ['step 3 — the same UETR: the same payment, or a reference used twice', [S('P1', {}), S('P2', { sha256: f('s3 a') }), S('P3', { sha256: f('s3 b'), content: 'e3'.repeat(32) }), S('P4', { sha256: f('s3 c'), content: undefined }), S('P5', { sha256: f('s3 d'), uetr: U[0].toUpperCase() }), S('P6', { index: 5 }),
      S('P7', { sha256: f('s3 e'), instructionId: 'ANOTHER', valueDate: '2026-12-24' })]],
    ['step 3 — a first settlement without content: its UETR is never "reused" for content', [S('P1', { content: undefined }), S('P2', { sha256: f('s3 f'), content: 'e4'.repeat(32) }), S('P3', { sha256: f('s3 g'), content: undefined })]],
    ['step 4 — with a UETR in hand, only a settlement without one can be the twin', [S('P1', {}), S('P2', { sha256: f('s4 a'), uetr: U[1] }), S('P3', { sha256: f('s4 b'), uetr: undefined }), S('P4', { sha256: f('s4 c'), uetr: undefined }), S('P5', { sha256: f('s4 d'), uetr: U[2] })]],
    ['step 4 — the oldest free twin, by time and then by id', [S('P-B', { uetr: undefined, sha256: f('s4 e') }), S('P-A', { uetr: undefined, sha256: f('s4 f'), valueDate: '2026-11-18' }), S('P-C', { uetr: undefined, sha256: f('s4 g'), valueDate: '2026-11-18' }), S('P-D', { uetr: undefined, sha256: f('s4 h'), valueDate: '2026-11-18' })]],
    ['step 4 — undated: refused each time, never recorded; dated on one side only is no twin', [S('P1', { uetr: undefined, valueDate: undefined }), S('P2', { uetr: undefined, valueDate: undefined, sha256: f('s4 i') }), S('P3', { uetr: undefined, valueDate: undefined, sha256: f('s4 i') }),
      S('P4', { uetr: undefined, sha256: f('s4 j') }), S('P5', { uetr: U[1], valueDate: undefined, sha256: f('s4 k') }), S('P6', { uetr: U[2], valueDate: undefined, sha256: f('s4 l') })]],
    ['step 4 — no content, no key: nothing is a twin', [S('P1', { uetr: undefined, content: undefined }), S('P2', { uetr: undefined, content: undefined, sha256: f('s4 m') }), S('P3', { uetr: undefined, sha256: f('s4 n') }), S('P4', { uetr: undefined, sha256: f('s4 o') })]],
    ['letter case and white space tell nothing apart', [S('P1', { sha256: f('case') }), S('P2', { sha256: f('case').toUpperCase() }), S('P3', { sha256: f('case 2'), uetr: U[0].toUpperCase() }), S('P4', { sha256: f('case 3'), uetr: undefined, instructionId: ' A1 ', content: 'CD'.repeat(32) }),
      S('P5', { sha256: f('case 4'), uetr: undefined, endToEndId: 'nonref' }), S('P6', { sha256: f('case 5'), uetr: undefined, instructionId: 'a1' })]],
    ['another organisation\'s ledger is its own', [S('P1', {}), S('Q1', {}, 'other'), S('Q2', {}, 'other'), S('P2', { sha256: f('org a'), uetr: undefined }), S('Q3', { sha256: f('org a'), uetr: undefined }, 'other'), S('Q4', { sha256: f('org b'), uetr: U[1] }, 'other')]],
  ];
  // The 54 cases the Java SDK's suite holds (golden/scenarios.json): what its submitSwift posted, in order, handed to the store.
  const golden = JSON.parse(readFileSync(path.resolve(HERE, '../../../sdks/attest-remit-java/src/test/resources/golden/scenarios.json'), 'utf8'));
  for (const c of golden.cases) {
    const posted = c.steps.map((s) => s.expect?.posted).filter((p) => p && p.payment_id && p.sourceMessage !== undefined);
    if (posted.length > 0) named.push([`sdks/attest-remit-java golden/scenarios.json — ${c.name}`, posted.map((p) => ({ id: p.payment_id, source: p.sourceMessage }))]);
  }
  // Drawn sequences over a small alphabet: the steps run into each other in every way the four steps know.
  const rng = (() => { let a = 20261120; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const pick = (list) => list[Math.floor(rng() * list.length)];
  for (let n = 0; n < 60; n++) {
    const steps = []; const count = 9 + Math.floor(rng() * 8);
    for (let i = 0; i < count; i++) {
      const ids = pick(['both', 'instruction', 'e2e', 'message', 'none', 'both', 'message']);
      steps.push({ id: rng() < 0.07 && i > 0 ? `P${Math.floor(rng() * i)}` : `P${i}`, ...(rng() < 0.12 ? { org: 'other' } : {}), source: plain({ type: pick(['MT103', 'pacs.008.001.08', 'pain.001.001.09']), sha256: f(`drawn ${pick(['a', 'b', 'c', 'd'])}`), index: pick([0, 0, 0, 1, 2]),
        uetr: pick([undefined, undefined, undefined, U[0], U[1], U[2]]), valueDate: pick(['2026-11-17', '2026-11-17', '2026-11-18', undefined]), content: pick(['c1'.repeat(32), 'c1'.repeat(32), 'c2'.repeat(32), undefined]),
        messageId: ids === 'none' ? undefined : pick(['M1', 'M2']), instructionId: ids === 'both' || ids === 'instruction' ? pick(['I1', 'I2']) : undefined, endToEndId: ids === 'both' || ids === 'e2e' ? pick(['E1', 'NOTPROVIDED', 'E2']) : undefined }) });
    }
    named.push([`drawn ${String(n).padStart(2, '0')}`, steps]);
  }
  const sequences = [];
  let k = 0;
  for (const [name, steps] of named) {
    const n = String(k++).padStart(3, '0');
    const orgs = { own: `vecseq-${n}`, other: `vecseq-${n}-other` };
    for (const o of Object.values(orgs)) { await insert('orgs', { id: o, slug: o, name: `Vector sequence ${o}`, created_at: '2026-01-01T00:00:00.000Z' }); await store.saveQuote(o, `QT-${o}`, 'VN', 'SG', {}, {}, FAR); }
    const out = { name, orgs, prefix: `VS${n}-`, steps: [] };
    for (const [i, s] of steps.entries()) {
      const org = orgs[s.org ?? 'own'];
      const sourceJson = JSON.stringify(s.source);
      // Each step at a time of its own: step 4 orders twins by the time their settlement was made.
      at(iso(T0 + k * 100_000 + i * 1000));
      const step = { id: `${out.prefix}${s.id}`, org: s.org ?? 'own', sourceJson };
      let ref;
      try { ref = sourceRefOf(JSON.parse(sourceJson)); } catch (e) { step.refused = refusal(e); out.steps.push(step); continue; }
      if (ref === null) { step.noReference = true; out.steps.push(step); continue; }
      const made = await store.createFromMessage(basePayment(org, step.id, `QT-${org}`), ref);
      if ('conflict' in made) step.conflict = made.conflict; else if ('idTaken' in made) step.idTaken = true; else { step.accepted = true; step.createdAt = made.payment.created_at; }
      out.steps.push(step);
    }
    out.refs = await all(`SELECT org_id, payment_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at FROM remit_source_refs WHERE org_id IN (?, ?) ORDER BY org_id, payment_id`, orgs.own, orgs.other);
    out.matches = await all('SELECT org_id, sha256, idx, payment_id, created_at FROM remit_source_matches WHERE org_id IN (?, ?) ORDER BY org_id, sha256, idx', orgs.own, orgs.other);
    sequences.push(out);
  }
  // Settlements as an earlier platform stored them: the reference only inside the signed evidence. (apps/core/test/remit.test.ts, "the ledger answers …")
  const org = 'vecseq-backfill'; const org2 = 'vecseq-backfill-2';
  for (const o of [org, org2]) { await insert('orgs', { id: o, slug: o, name: `Vector ${o}`, created_at: '2026-01-01T00:00:00.000Z' }); await store.saveQuote(o, `QT-${o}`, 'VN', 'SG', {}, {}, FAR); }
  const olds = [[org, 'VB-A', base()], [org, 'VB-B', base()], [org, 'VB-C', base({ sha256: f('C'), uetr: undefined, instructionId: 'ZZ', messageId: 'ZZ', content: 'ee'.repeat(32) })], [org, 'VB-D', undefined],
    [org, 'VB-E', { uetr: U[1].toUpperCase(), index: '1', valueDate: '20261117' }], [org, 'VB-E2', { type: 'MT103', sha256: f('E2'), uetr: 'NOT-A-UUID', instructionId: 'E2' }], [org2, 'VB-F', base()],
    [org, 'VB-G1', base({ sha256: f('G'), uetr: U[2], instructionId: 'G' }), 'CANCELLED'], [org, 'VB-G2', base({ sha256: f('G'), uetr: U[2], instructionId: 'G' })], [org, 'VB-TEXT', 'MT103'], [org, 'VB-RETURNED', base({ sha256: f('R'), uetr: U[3], instructionId: 'R' }), 'RETURNED'],
    [org, 'VB-RETURNED-2', base({ sha256: f('R'), uetr: U[3], instructionId: 'R' }), 'EXCEPTION']];
  const before = [];
  for (const [i, [o, id, source, state]] of olds.entries()) {
    at(iso(T0 + 9_000_000 + i * 1000));
    await store.create(basePayment(o, id, `QT-${o}`));
    const payload = { bankInstruction: { ref: id, ...(source === undefined ? {} : { sourceMessage: source }) }, bankApproval: {}, commercialDocs: {} };
    await store.appendEvent(id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', payload);
    if (state) await store.transition(id, state);
    before.push({ org: o, id, createdAt: (await store.get(id)).created_at, state: state ?? 'REQUEST_ACCEPTED', evidencePayloadJson: JSON.stringify(payload) });
  }
  at(iso(T0 + 9_500_000));
  const first = await store.backfillSourceRefs();
  const second = await store.backfillSourceRefs();
  const refsAfter = await all('SELECT org_id, payment_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at FROM remit_source_refs WHERE org_id IN (?, ?) ORDER BY org_id, payment_id', org, org2);
  const lookups = [];
  for (const [o, s] of [[org, { sourceUetr: U[0] }], [org, { sourceUetr: U[0].toUpperCase() }], [org, { sourceUetr: 'b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a58' }], [org, { sourceContent: 'ee'.repeat(32) }], [org, { sourceContent: 'ee'.repeat(32), sourceValueDate: '2026-11-17' }],
    [org, { sourceContent: 'ee'.repeat(32), sourceValueDate: '2026-11-18' }], [org, { sourceContent: 'ee'.repeat(32), state: 'EVIDENCE_ANCHORED' }], [org2, { sourceUetr: U[0] }], [org, { sourceUetr: U[1] }], [org, { sourceUetr: U[2] }], [org, { sourceUetr: U[3] }],
    [org, { sourceContent: 'cd'.repeat(32) }], [org, { sourceContent: 'CD'.repeat(32), sourceValueDate: '2026-11-17' }], [org, { sourceUetr: U[0], sourceContent: 'cd'.repeat(32) }], [org, { sourceUetr: U[0], sourceContent: 'ee'.repeat(32) }]]) {
    const page = await store.search(o, { ...s, limit: 100 });
    lookups.push({ org: o, search: s, ids: page.items.map((p) => p.id), total: page.total });
  }
  // A row from before the platform keyed a payment by its message id gets its key at the next start.
  const plainSource = base({ type: 'pain.001.001.09', sha256: f('plain'), uetr: undefined, instructionId: undefined, messageId: 'FILE-7', content: 'cc'.repeat(32) });
  at(iso(T0 + 9_600_000));
  await store.create(basePayment(org, 'VB-P', `QT-${org}`));
  await store.appendEvent('VB-P', 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-001', { bankInstruction: { ref: 'VB-P', sourceMessage: plainSource }, bankApproval: {}, commercialDocs: {} });
  await insert('remit_source_refs', { payment_id: 'VB-P', org_id: org, message_type: 'pain.001.001.09', sha256: f('plain'), idx: 0, uetr: null, value_date: '2026-11-17', content: 'cc'.repeat(32), twin_key: null, created_at: '2026-11-17T00:00:00.000Z' });
  const rekey = [await store.backfillSourceRefs(), await store.backfillSourceRefs()];
  const rekeyed = (await all('SELECT twin_key FROM remit_source_refs WHERE payment_id = ?', 'VB-P'))[0].twin_key;
  V.duplicates = { sequences, backfill: { orgs: [org, org2], before, first, second, refsAfter, lookups, keyless: { paymentId: 'VB-P', sourceJson: JSON.stringify(plainSource), runs: rekey, twinKeyAfter: rekeyed } } };
}

/** The rows the acceptance section starts from, and the organisations by the short names the requests use. */
async function acceptanceWorld(w) {
  await partners(w);
  await w.registry.upsert({ id: 'SG-BFI-NOENC', role: 'BENEFICIARY_FI', name: 'Beneficiary FI without an encryption key', country: 'SG', signing_spki: SPKI.stranger, authority: ['PAYOUT_ACCEPTED'] });
  const O = { a: await organisation(w, 'vec-a', BANK, { spki: SPKI.bank }), b: await organisation(w, 'vec-b', BANK2, { spki: SPKI.bank2, hook: null }), nosub: await organisation(w, 'vec-nosub', null, { subscribed: false }),
    off: await organisation(w, 'vec-off', { id: 'VN-BANK-VEC-OFF', name: 'Switched off', country: 'VN' }, { spki: SPKI.stranger, active: false }), nobank: await organisation(w, 'vec-nobank', null), nokey: await organisation(w, 'vec-nokey', { id: 'VN-BANK-VEC-NOKEY', name: 'No key', country: 'VN' }) };
  const save = (org, q) => w.store.saveQuote(org, q.quote_id, 'VN', 'SG', QUOTE_REQUEST(q.trade.amount), q, q.expires_at);
  await save(O.a, M.quotes.good); await save(O.a, M.quotes.other); await save(O.a, M.quotes.expired); await save(O.b, M.quotes.ofB);
  await insert('remit_quotes', { id: 'QT-VEC-BROKEN', org_id: O.a, corridor_origin: 'VN', corridor_destination: 'SG', request: '{}', response: 'not JSON at all', expires_at: FAR, created_at: '2026-11-19T05:00:00.000Z' });
  await w.store.create(basePayment(O.a, 'PAY-VEC-TAKEN', 'QT-VEC-GOOD')); await w.store.create(basePayment(O.b, 'PAY-VEC-OTHERS', 'QT-VEC-OF-B'));
  const sk = M.acceptance.storedKey;
  await w.store.idempotencyStore(O.a, sk.key, sha256hex(JSON.stringify(JSON.parse(sk.bodyJson))), 202, sk.response);
  return O;
}
const dump = async (names) => Object.fromEntries(await Promise.all(names.map(async (t) => [t, await all(`SELECT * FROM ${t} ORDER BY 1, 2`)])));
/** A platform signature is new every time it is made: verified here, then written as its kind. */
const blurSig = (sigText, payloadText, what) => { const sig = JSON.parse(sigText); if (!verifyEvent(JSON.parse(payloadText), sig, SPKI.platform)) throw new Error(`${what}: the platform's signature does not verify`); return JSON.stringify({ ...sig, sig: '<sig>' }); };

if (want('acceptance')) {
  await empty();
  section('acceptance', '2026-11-19T05:50:00.000Z');
  const w = world(M, { pipeline: false });
  try {
    const O = await acceptanceWorld(w);
    const start = await dump(['orgs', 'institutions', 'subscriptions', 'remit_quotes', 'remit_payments', 'remit_idempotency']);
    const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await all(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)])));
    const requests = [];
    // Where the Java service answers otherwise on purpose (docs/JAVA-INTENDED-DIFFERENCES.md), the case says so beside the reference's answer.
    const javaAnswer = (r) => (r.key !== null && r.key.length > 191 && !['none', 'nosub', 'off', 'nobank', 'nokey'].includes(r.org)
      ? { java: { status: 400, body: { error: 'invalid_idempotency_key', message: 'the Idempotency-Key header is longer than 191 characters' }, wrote: {} },
        why: 'D-19: a key longer than the column that stores it is refused before the body is read, and nothing is accepted' } : {});
    for (const [i, r] of M.acceptance.requests.entries()) {
      at(iso(RealDate.parse('2026-11-19T05:50:00.000Z') + (i + 1) * 60_000));
      const before = await counts();
      const a = await w.call('POST /v1/settlements', { org: r.org === 'none' ? undefined : O[r.org], headers: r.key === null ? {} : { 'idempotency-key': r.key }, bodyJson: r.bodyJson });
      const after = await counts();
      const wrote = Object.fromEntries(TABLES.filter((t) => after[t] !== before[t]).map((t) => [t, after[t] - before[t]]));
      requests.push({ group: r.group, name: r.name, org: r.org, idempotencyKey: r.key, bodyJson: r.bodyJson, answer: a.engine ? { status: 500, engine: a.body.message } : { status: a.status, body: a.body }, wrote, ...javaAnswer(r) });
    }
    // What an acceptance left: the settlement's row, its three opening events, the webhook, the idempotency row, the reference row.
    const stored = [];
    for (const id of ['PAY-VEC-OK-A', 'PAY-VEC-OK-B', 'PAY-VEC-OK-SRC', 'PAY-VEC-OK-BFI2', 'PAY-VEC-OK-B-ORG']) {
      const [p] = await rowsOf('remit_payments', 'id = ?', id);
      const events = (await rowsOf('remit_events', 'payment_id = ? ORDER BY seq', id)).map((e) => ({ seq: e.seq, type: e.type, issuer: e.issuer, payload: e.payload, sig: e.sig === null ? null : blurSig(e.sig, e.payload, `${id} ${e.type}`), created_at: e.created_at }));
      const webhooks = (await rowsOf('remit_webhook_deliveries', 'payment_id = ?', id)).map((x) => { const b = JSON.parse(x.body); if (!verifyEvent(b.envelope, b.signature, SPKI.platform)) throw new Error('a webhook of the acceptance section does not verify');
        return { url: x.url, envelopeJson: JSON.stringify(b.envelope), signature: { ...b.signature, sig: '<sig>' }, status: x.status, attempts: x.attempts, next_attempt_at: x.next_attempt_at, created_at: x.created_at }; });
      stored.push({ paymentId: id, payment: p, events, webhooks, idempotency: await all('SELECT org_id, idem_key, request_hash, response_status, response_body, created_at FROM remit_idempotency WHERE response_body LIKE ?', `%"${id}"%`), sourceRefs: await rowsOf('remit_source_refs', 'payment_id = ?', id) });
    }
    V.acceptance = { paymentId: M.acceptance.paymentId, orgs: O, world: start, requests, stored, bankSpki: SPKI.bank, platformSpki: SPKI.platform };
  } finally { w.close(); }
}

if (want('duplicates')) {
  // The sentences of each kind of conflict, through the handler: a first instruction accepted, a second that runs into it.
  await empty();
  section('conflicts', '2026-11-19T05:55:00.000Z');
  const w = world(M, { pipeline: false });
  try {
    const O = await acceptanceWorld(w);
    const conflicts = [];
    for (const c of M.conflicts) {
      const first = await w.call('POST /v1/settlements', { org: O.a, headers: { 'idempotency-key': c.first.key }, bodyJson: c.first.bodyJson });
      const second = await w.call('POST /v1/settlements', { org: O.a, headers: { 'idempotency-key': c.second.key }, bodyJson: c.second.bodyJson });
      if (first.status !== 202 || second.status !== 409) throw new Error(`conflict ${c.name}: expected 202 then 409, the reference answered ${first.status} then ${second.status}`);
      const src = (text) => JSON.stringify(JSON.parse(text).evidence_elements.bankInstruction.sourceMessage);
      conflicts.push({ name: c.name, firstSourceJson: src(c.first.bodyJson), secondSourceJson: src(c.second.bodyJson), existingPaymentId: JSON.parse(c.first.bodyJson).payment_id, answer: { status: second.status, body: second.body } });
    }
    const taken = await w.call('POST /v1/settlements', { org: O.a, headers: { 'idempotency-key': 'vec-c-taken' }, bodyJson: M.conflicts[0].first.bodyJson });
    conflicts.push({ name: 'DUPLICATE-PAYMENT', existingPaymentId: JSON.parse(M.conflicts[0].first.bodyJson).payment_id, answer: { status: taken.status, body: taken.body } });
    V.duplicates.conflicts = conflicts;
  } finally { w.close(); }
}

// ── the recorded settlements: what was signed, the evidence, the package ────────────────────────────────────────
const recordings = M.recordings.map((r) => ({ name: r.name, note: r.note, paymentId: r.payment_id, state: r.state, mode: r.mode, rows: r.rows }));
if (want('signing')) {
  const keyOfIssuer = (sig) => (sig.key_id.startsWith('STONEHASH-SIGN-') ? SPKI.platform : sig.key_id === BANK.id ? SPKI.bank : sig.key_id === BANK2.id ? SPKI.bank2 : Object.values(M.keys.partner).find((k) => k.id === sig.key_id)?.signing.spki ?? null);
  const events = []; const elements = [];
  for (const r of M.recordings) {
    for (const e of r.rows.remit_events) {
      const payload = JSON.parse(e.payload);
      if (JSON.stringify(payload) !== e.payload) throw new Error(`${r.name} ${e.type}: the stored payload is not what JSON.stringify writes`);
      const sig = e.sig === null ? null : JSON.parse(e.sig);
      const spki = sig === null ? null : keyOfIssuer(sig);
      const verifies = sig === null ? null : spki === null ? false : verifyEvent(payload, sig, spki);
      // A cancellation is stored with the bank's signature as it came — over {payment_id, reason} — beside a payload that also holds the time.
      let signed = payload;
      if (verifies === false && e.type === 'CANCEL_REQUESTED') { const { requested_at: _t, ...asSigned } = payload; if (verifyEvent(asSigned, sig, spki)) signed = asSigned; }
      // A question is stored with whatever signature object its answer carried: nothing verifies it.
      const asItCame = verifies === false && signed === payload && e.type === 'TRAVEL_RULE_RFI';
      if (verifies === false && signed === payload && !asItCame) throw new Error(`${r.name} ${e.type}: the stored signature does not verify with the key it names`);
      events.push({ recording: r.name, seq: e.seq, type: e.type, issuer: e.issuer, payloadJson: e.payload, members: Object.keys(payload).join(','), signedBy: sig === null ? null : sig.key_id, signerName: sig?.issuer ?? null,
        ...(signed === payload ? {} : { signedPayloadJson: JSON.stringify(signed), note: 'the signature is the bank\'s own over {payment_id, reason}: it does not cover the payload stored beside it' }),
        ...(asItCame ? { note: 'the signature object of the institution\'s answer, stored as it came: the reference verifies nothing of it' } : {}),
        signedBytesSha256: sig === null ? null : sha256hex(eventSigningBytes(signed)), canonicalJson: sig === null ? null : Buffer.from(jcs(signed)).toString('utf8'), sigJson: e.sig, spki, verifies });
      for (const [k, v] of Object.entries(payload)) if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.digest === 'string') elements.push({ recording: r.name, event: e.type, member: k, elementJson: JSON.stringify(v), declared: v.digest, recomputed: elementDigest(v) });
    }
  }
  const kinds = {};
  for (const e of events) { const k = `${e.type} by ${e.issuer === 'STONEHASH' ? 'the platform' : e.issuer.startsWith('VN-BANK') ? 'the bank' : e.issuer.startsWith('SETTLE') ? 'the settlement entity' : 'the receiving institution'}, ${e.signedBy === null ? 'unsigned' : `signed by ${e.signedBy.startsWith('STONEHASH') ? 'the platform' : e.signedBy === e.issuer ? 'its issuer' : `another (${e.signedBy})`}`}: ${e.members}`; kinds[k] = (kinds[k] ?? 0) + 1; }
  V.signing = { domain: 'stonehash:remit:event:v1\n', digestDomain: 'stonehash:evidence:digest:v1\n', platformSpki: SPKI.platform, platformKeyId: platformOf(M).keyId, shapes: Object.keys(kinds).sort().map((k) => ({ shape: k, seen: kinds[k] })), events, elements };
}

if (want('evidence')) {
  await empty();
  section('evidence', '2026-11-19T06:10:00.000Z');
  const registry = new Registry(db); const store = new RemitStore(db);
  for (const o of M.registry.orgs) await insert('orgs', o);
  for (const i of M.registry.institutions) await insert('institutions', i);
  for (const r of M.recordings) { for (const q of r.rows.remit_quotes) await insert('remit_quotes', q); for (const p of r.rows.remit_payments) await insert('remit_payments', { ...p, attestation_id: null }); for (const e of r.rows.remit_events) await insert('remit_events', e); }
  console.error = () => {};
  const NONCE = '11'.repeat(32);
  /** The log as one reconciliation saw it: nothing after `upTo`; with `completion`, of the completions only that one. */
  const view = (upTo, completion) => ({ events: async (id) => (await store.events(id)).filter((e) => e.seq <= upTo && (completion === undefined || e.type !== 'PAYOUT_COMPLETED' || e.seq === completion)) });
  const axesOf = (verdict) => Object.fromEntries(Object.entries(verdict.axes).map(([k, v]) => [k, v.state]));
  const reconcile = async (p, seen, demo) => { const o = await reconcilePayment(p, seen, registry, demo); return { pass: o.pass, reasons: o.reasons, axes: axesOf(o.verdict), verdictJson: JSON.stringify(o.verdict), evidenceJson: JSON.stringify(o.evidence), outcome: o }; };
  const shown = ({ outcome: _o, ...rest }) => rest;
  const summary = (els) => Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v === undefined ? null : { digest: v.digest ?? null, signedBy: v.signature?.keyId ?? null }]));
  const cases = [];
  for (const r of M.recordings) {
    const events = await store.events(r.payment_id);
    const completions = events.filter((e) => e.type === 'PAYOUT_COMPLETED');
    if (completions.length === 0) continue;
    const [p] = r.rows.remit_payments;
    // What the flow's own reconciliation saw: the log up to the completion that started it. (A completion at L1 starts none.)
    const reconciled = events.find((e) => e.type === 'SETTLEMENT_RECONCILED');
    const last = events.at(-1).seq;
    const seen = view(reconciled ? reconciled.seq - 1 : last);
    const collected = collectElements(await seen.events(r.payment_id));
    const item = { recording: r.name, note: r.note, paymentId: r.payment_id, eventsRead: (await seen.events(r.payment_id)).map((e) => e.seq), reconciledByTheFlow: reconciled !== undefined, completionRead: completions[0].seq,
      collected: summary(collected), settlementEvidenceJson: JSON.stringify(buildSettlementEvidence(p, collected)) };
    const withDemo = await reconcile(p, seen, true); const strict = await reconcile(p, seen, false);
    item.sandboxAllowance = shown(withDemo);
    item.withoutAllowance = { pass: strict.pass, reasons: strict.reasons };
    if (reconciled) { // … and what it wrote down then is what is computed here
      const said = JSON.parse(reconciled.payload);
      if (said.pass !== withDemo.pass || JSON.stringify(said.axes) !== JSON.stringify(withDemo.axes)) throw new Error(`${r.name}: the flow reconciled to ${said.pass} ${JSON.stringify(said.axes)}, this tool to ${withDemo.pass} ${JSON.stringify(withDemo.axes)}`);
      if (p.verdict !== withDemo.verdictJson) throw new Error(`${r.name}: the verdict the flow stored is not the one computed here`);
    }
    // The same with a registry row whose key is no key (left out of the keyring), and with the receiving institution's key gone (its signatures name a key nobody holds).
    await insert('institutions', { id: 'VEC-NO-KEY', org_id: null, role: 'LOCAL_PAYOUT_BANK', name: 'A key that is none', country: 'SG', signing_spki: 'DEMO-PUBLIC-KEY-PLACEHOLDER', console_spki: null, encryption_jwk: null, authority: '[]', created_at: '2026-11-19T00:00:00.000Z' });
    const odd = await reconcile(p, seen, true);
    item.withARowWhoseKeyIsNoKey = { pass: odd.pass, reasons: odd.reasons, sameVerdict: odd.verdictJson === withDemo.verdictJson };
    await db.prepare('DELETE FROM institutions WHERE id = ?').run('VEC-NO-KEY');
    const bfiId = p.beneficiary_institution;
    await db.prepare('UPDATE institutions SET signing_spki = NULL WHERE id = ?').run(bfiId);
    const gone = await reconcile(p, seen, true);
    item.withoutTheInstitutionsKey = { institution: bfiId, pass: gone.pass, reasons: gone.reasons, axes: gone.axes, verdictJson: gone.verdictJson };
    await db.prepare('UPDATE institutions SET signing_spki = ? WHERE id = ?').run(M.registry.institutions.find((i) => i.id === bfiId).signing_spki, bfiId);
    // The package, as the flow assembles it at the moment of confirmation: the state then, the events up to the reconciliation's own, the clock fixed.
    if (withDemo.pass) {
      at('2026-11-19T06:15:00.000Z');
      const then = view(reconciled ? reconciled.seq : last);
      const pkg = await assemblePackage({ ...p, state: 'BENEFICIARY_CREDIT_CONFIRMED' }, then, registry, withDemo.outcome.evidence, withDemo.outcome.verdict);
      item.package = { state: 'BENEFICIARY_CREDIT_CONFIRMED', events: pkg.events.map((e) => e.seq), takenAt: pkg.trust_registry.taken_at, generatedAt: pkg.generated_at, members: Object.keys(pkg).join(','), packageJson: JSON.stringify(pkg),
        canonicalSha256: sha256hex(Buffer.from(jcs(pkg))), nonce: NONCE, commitment: packageCommitment(pkg, NONCE) };
      if (p.package_json !== null) {
        // The package the flow stored is this one but for its two times, and it commits under the nonce the flow drew.
        const storedPkg = JSON.parse(p.package_json);
        if (JSON.stringify(storedPkg) !== p.package_json) throw new Error(`${r.name}: the stored package is not what JSON.stringify writes`);
        if (JSON.stringify({ ...storedPkg, trust_registry: { ...storedPkg.trust_registry, taken_at: pkg.trust_registry.taken_at }, generated_at: pkg.generated_at }) !== item.package.packageJson) throw new Error(`${r.name}: the package assembled here is not the one the flow stored (its two times apart)`);
        if (packageCommitment(storedPkg, p.nonce) !== p.commitment) throw new Error(`${r.name}: the stored commitment is not that of the stored package under the stored nonce`);
        item.stored = { note: 'recordings[].rows.remit_payments[0]: package_json, nonce, commitment — the same package but for taken_at and generated_at', nonce: p.nonce, commitment: p.commitment, takenAt: storedPkg.trust_registry.taken_at, generatedAt: storedPkg.generated_at };
      }
    }
    // A later completion: the reference never reads it (collectElements takes the first). What it would answer if that completion were the one read.
    item.laterCompletions = [];
    for (const c of completions.slice(1)) {
      const next = events.find((e) => e.type === 'SETTLEMENT_RECONCILED' && e.seq > c.seq);
      const only = view(next ? next.seq - 1 : last, c.seq);
      const o = await reconcile(p, only, true);
      item.laterCompletions.push({ completionRead: c.seq, collected: summary(collectElements(await only.events(r.payment_id))), ...shown(o),
        design13: 'docs/JAVA-REMIT-DESIGN.md 13, "L1 뒤에 서명된 완료 통보가 옴": the reference reconciles the first completion (the answer above); the Java service reconciles the completion that started the reconciliation (this answer)' });
    }
    cases.push(item);
  }
  console.error = realConsoleError;
  V.evidence = { acceptDemoFinality: true, nonce: NONCE, commitDomain: 'STONEHASH-EVIDENCE-V1', institutionsJson: JSON.stringify(M.registry.institutions), cases };
}

if (want('search')) {
  await empty();
  section('search');
  const store = new RemitStore(db);
  const org = 'vecsearch'; const other = 'vecsearch-other';
  for (const o of [org, other]) { await insert('orgs', { id: o, slug: o, name: `Vector ${o}`, created_at: '2026-01-01T00:00:00.000Z' }); for (const qid of [`QT-${o}-ALPHA`, `QT-${o}-beta`]) await store.saveQuote(o, qid, 'VN', 'SG', {}, {}, FAR); }
  const values = ['FAST-20261110-0001', 'fast-lower-0002', 'REF/100%_DONE!', 'REF_UNDER_SCORE', 'Réf-ß-Straße', '지시-2026', 'REF "quoted" 7', 'REF\\back\\slash', 'REF with spaces', 'null', 'true', 'REF-😀', "REF-'apostrophe'", 'REF-TAB\there', 'REF-LINE\nbreak', 'REF%0415', 'A',
    'payment_id', 'İstanbul-ı', 'ǆ-ŉ', 'x'.repeat(70), '', ' ', 12345, 0, -1.5, true, false, null, { branch: 'HANOI', n: 1 }, ['list', 'of', 'two'], [], {}];
  const rows2 = [];
  let n = 0;
  const pay = async (id, quote, state, chainTx, createdAt, events, o = org) => {
    await store.create({ ...basePayment(o, id, quote) });
    for (const [type, payload] of events) await store.appendEvent(id, type, 'VEC', payload);
    await db.prepare('UPDATE remit_payments SET state = ?, chain_tx = ?, created_at = ?, updated_at = ? WHERE id = ?').run(state, chainTx, createdAt, createdAt, id);
    rows2.push({ id, org: o, quote_id: quote, state, chain_tx: chainTx, created_at: createdAt, events: events.map(([type, payload]) => ({ type, payloadJson: JSON.stringify(payload) })) });
  };
  for (const v of values) { n++; await pay(`VS-C-${String(n).padStart(2, '0')}`, `QT-${org}-ALPHA`, 'PAYOUT_IN_PROGRESS', null, iso(T0 - 86_400_000 * 10 + n * 60_000), [['PAYOUT_COMPLETED', { payment_id: 'x', bank_reference: v }]]); }
  const fields = [['uetr', 'B4D9E7A1-5C36-4F82-A1D0-6E9F3C2B8A57'], ['instructionId', 'INSTR-Alpha/7'], ['endToEndId', 'E2E 100%'], ['messageId', 'MSG_one']];
  await pay('VS-B-01', `QT-${org}-beta`, 'BANK_AUTHORIZED', null, iso(T0 - 86_400_000 * 9), [['BANK_EVIDENCE_SUBMITTED', { bankInstruction: { ref: 'VS-B-01', sourceMessage: Object.fromEntries(fields) }, bankApproval: { approvalRef: 'APPR-2026-0001' }, commercialDocs: { invoiceRef: 'INV-NOT-SEARCHED' } }],
    ['BANK_AUTHORIZATION_VERIFIED', { payment_id: 'VS-B-01', bank_authorization: { instruction_ref: 'AUTH!ref', fiat_received_ref: 'RCPT-NOT-SEARCHED' } }]]);
  await pay('VS-B-02', `QT-${org}-beta`, 'EVIDENCE_ANCHORED', '0xABCDEF0123', iso(T0 - 86_400_000 * 9), [['PAYOUT_COMPLETED', { payment_id: 'VS-B-02', bank_reference: 'first-completion' }], ['PAYOUT_COMPLETED', { payment_id: 'VS-B-02', bank_reference: 'second-completion' }]]);
  await pay('VS-B-03', `QT-${org}-beta`, 'EXCEPTION', '0xabc', iso(T0 - 86_400_000 * 8), [['EXCEPTION', { payment_id: 'VS-B-03', error: 'FAST-20261110-0001 is quoted here and is not searched' }], ['USDC_RECEIVED', { payment_id: 'VS-B-03', bank_reference: 'not-a-completion' }]]);
  await pay('VS-B-04', `QT-${org}-beta`, 'CANCELLED', null, iso(T0 - 86_400_000 * 8), [['BANK_EVIDENCE_SUBMITTED', { bankInstruction: { sourceMessage: { messageId: '한글-메시지', endToEndId: 'NOTPROVIDED', uetr: null, instructionId: 7 } }, bankApproval: {} }]]);
  await pay('VS_B-05', `QT-${org}-beta`, 'RETURNED', null, iso(T0 - 86_400_000 * 7), []);
  await pay('VS-O-01', `QT-${other}-ALPHA`, 'PAYOUT_IN_PROGRESS', '0xabc', iso(T0 - 86_400_000 * 7), [['PAYOUT_COMPLETED', { payment_id: 'VS-O-01', bank_reference: 'FAST-20261110-0001' }]], other);
  const needles = ['VS-C', 'vs-c-0', 'VS_B', 'vs-', '_', '%', '!', '!%', '\\', '\\\\', '"', '""', 'alpha', 'ALPHA', 'BETA', 'qt-vecsearch', '0xabc', 'ABCDEF', '0XABC', 'fast-2026', 'FAST-20261110-0001', '0001', '"FAST', '0001"', 'fast-lower', 'ref/100%', '100%', '%_done', 'ref_under', 'REF-UNDER',
    'réf', 'RÉF', 'ß', 'ss', 'SS', 'straße', 'STRASSE', 'strasse', '지시', 'quoted', '"quoted"', '\\"quoted\\"', 'back\\slash', 'back\\\\slash', 'with spaces', 'null', 'NULL', 'nul', 'true', 'TRUE', 'ru', 'false', 'als', '😀', "'apostrophe'", 'tab', 'TAB\there', 'TAB\\there', 'TAB\\Tthere',
    'line\nbreak', 'LINE\\nbreak', 'LINE\\Nbreak', 'REF%0415', '%0415', 'A', 'a', 'payment_id', 'bank_reference', 'İstanbul', 'istanbul', 'i̇stanbul', 'ISTANBUL', 'ı', 'I', 'ǆ', 'Ǆ', 'ǅ', 'ŉ', 'ʼN', 'x'.repeat(70), 'x'.repeat(71), ' ', '  ', '12345', '234', '-1.5', '1.5', '0',
    'HANOI', 'branch', '"branch": "HANOI"', '"branch":"HANOI"', 'list', '"of"', '["list", "of", "two"]', '[]', '{}', 'b4d9e7a1', 'B4D9E7A1-5C36', 'instr-alpha', 'alpha/7', 'e2e 100%', 'msg_one', 'MSG-ONE', 'appr-2026', 'INV-NOT', 'auth!ref', 'AUTH', 'RCPT-NOT', 'first-completion',
    'second-completion', 'not-a-completion', 'is quoted here', '한글', 'NOTPROVIDED', '7', 'no such thing'];
  const ask = async (o, params) => { try { const page = await store.search(o, params); return { org: o, params, answer: { ids: page.items.map((p) => p.id), total: page.total, nextCursor: page.nextCursor } }; } catch (e) { return { org: o, params, refused: refusal(e) }; } };
  const searches = [];
  for (const q of needles) searches.push(await ask(org, { q, limit: 100 }));
  for (const q of ['FAST-20261110-0001', 'vs-', '0xabc']) searches.push(await ask(other, { q, limit: 100 }));
  for (const state of ['PAYOUT_IN_PROGRESS', 'EVIDENCE_ANCHORED,EXCEPTION', ' CANCELLED , RETURNED ,', 'CANCELLED,,RETURNED', 'PAID', 'EVIDENCE_ANCHORED,PAID', 'evidence_anchored', 'REQUEST_ACCEPTED']) searches.push(await ask(org, { state, limit: 100 }));
  for (const [from, to] of [[iso(T0 - 86_400_000 * 9), undefined], [undefined, iso(T0 - 86_400_000 * 9)], ['2026-11-10', '2026-11-11'], ['2027', undefined], [undefined, '2020']]) searches.push(await ask(org, { ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 100 }));
  searches.push(await ask(org, { q: 'vs-', state: 'PAYOUT_IN_PROGRESS,CANCELLED', from: iso(T0 - 86_400_000 * 10), to: iso(T0 - 86_400_000 * 8), limit: 100 }));
  for (const limit of [1, 7, 100, 0, 1000]) { let cursor; for (let i = 0; i < 60; i++) { const page = await ask(org, { limit, ...(cursor ? { cursor } : {}) }); searches.push(page); cursor = page.answer?.nextCursor; if (!cursor) break; } }
  searches.push(await ask(org, { cursor: 'not-a-cursor', limit: 5 })); searches.push(await ask(org, { cursor: 'not-a-cursor', state: 'PAID', limit: 5 }));
  V.search = { orgs: [org, other], rows: rows2, searches };
}

if (want('manifests')) {
  await empty();
  section('manifests', '2026-11-19T06:20:00.000Z');
  const w = world(M, { pipeline: false });
  try {
    const O = await acceptanceWorld(w);
    const made = [];
    for (const [id, org, day] of [['PAY-VEC-M1', O.a, '2026-11-17T08:00:00.000Z'], ['PAY-VEC-M2', O.a, '2026-11-17T08:00:00.000Z'], ['PAY-VEC-M3', O.a, '2026-11-17T23:59:59.999Z'], ['PAY-VEC-M4', O.a, '2026-11-18T00:00:00.000Z'], ['PAY-VEC-OTHERS-M', O.b, '2026-11-17T09:00:00.000Z']]) {
      await w.store.create(basePayment(org, id, org === O.a ? 'QT-VEC-GOOD' : 'QT-VEC-OF-B'));
      await db.prepare('UPDATE remit_payments SET created_at = ?, updated_at = ? WHERE id = ?').run(day, day, id);
      made.push({ id, org: org === O.a ? 'a' : 'b', created_at: day });
    }
    const cases = [];
    for (const [i, m] of M.manifests.entries()) {
      at(iso(RealDate.parse('2026-11-19T06:20:00.000Z') + (i + 1) * 60_000));
      const a = await w.call('POST /v1/manifests/daily', { org: O[m.org], bodyJson: m.bodyJson });
      const item = { name: m.name, org: m.org, bodyJson: m.bodyJson };
      if (a.status === 201) {
        const sent = JSON.parse(m.bodyJson);
        const text = Buffer.concat([Buffer.from('STONEHASH-MANIFEST-V1\n', 'utf8'), Buffer.from(jcs({ manifest: sent.manifest, verdict: a.body.verdict }))]);
        if (sha256hex(text) !== a.body.commitment) throw new Error(`manifest "${m.name}": the commitment is not the SHA-256 of the text this tool writes for it`);
        if (!verifyEvent({ manifest: sent.manifest, verdict: a.body.verdict }, a.body.platform_signature, SPKI.platform)) throw new Error(`manifest "${m.name}": the platform's signature does not verify`);
        const [row] = await all('SELECT org_id, date, manifest, sig, verdict, commitment, attestation_id, created_at FROM remit_manifests WHERE org_id = ? AND date = ?', O[m.org], sent.manifest.date);
        const [att] = await all('SELECT product, content_type, descriptor, status, leaf_bytes FROM attestations WHERE id = ?', a.body.attestation_id);
        item.answer = { status: 201, bodyJson: JSON.stringify({ ...a.body, platform_signature: { ...a.body.platform_signature, sig: '<sig>' } }) };
        item.committedTextSha256 = sha256hex(text); item.committedText = text.toString('utf8');
        item.row = row; item.anchorRecord = { ...att, leafIsTheCommitment: att.leaf_bytes === a.body.commitment };
      } else item.answer = a.engine ? { status: 500, engine: a.body.message } : { status: a.status, body: a.body };
      cases.push(item);
    }
    const reads = [];
    for (const [org, query] of [['a', ''], ['a', 'date=2026-11-17'], ['a', 'date=2026-11-18'], ['a', 'date=2020-01-01'], ['a', 'date=1999-01-01'], ['a', 'date='], ['a', 'date=yesterday'], ['b', ''], ['nosub', ''], ['nobank', 'date=2026-11-17']]) {
      const a = await w.call('GET /v1/manifests/daily', { org: O[org], query });
      reads.push({ org, query, answer: { status: a.status, bodyJson: JSON.stringify(a.body) } });
    }
    V.manifests = { settlements: made, platformSpki: SPKI.platform, bankSpki: SPKI.bank, domain: 'STONEHASH-MANIFEST-V1\n', cases, reads };
  } finally { w.close(); }
}

// ── the settlement chain's node, as the stand-in answers ────────────────────────────────────────────────────────
if (want('chain')) {
  if (await listening(CHAIN_PORT)) { console.error(`port ${CHAIN_PORT} is taken — the chain section starts the stand-in chain node there`); await db.close(); process.exit(2); }
  globalThis.Date = RealDate; // the node's limits are real time
  const child = spawn(process.execPath, [path.join(HERE, 'stand-in-eth-rpc.mjs'), '--port', String(CHAIN_PORT)], { stdio: 'ignore' });
  const RPC = `http://127.0.0.1:${CHAIN_PORT}/`;
  const chain = [];
  try {
    for (let i = 0; i < 100 && !(await listening(CHAIN_PORT)); i++) await new Promise((ok) => setTimeout(ok, 100));
    const hashes = [];
    for (const kind of Object.keys(TX)) hashes.push([kind, null, txHash(kind, 'remit vectors')]);
    for (const place of Object.keys(TX_FAULT_AT)) for (const how of Object.keys(TX_FAULT)) hashes.push(['confirmed', { at: place, how }, txHash('confirmed', 'remit vectors', { at: place, how })]);
    for (const how of ['error', 'empty', 'http500']) hashes.push(['failedWithLog', { at: 'head', how }, txHash('failedWithLog', 'remit vectors', { at: 'head', how })]);
    hashes.push(['noReceipt', { at: 'head', how: 'error' }, txHash('noReceipt', 'remit vectors', { at: 'head', how: 'error' })]);
    const others = [['not a hash', 'mock-transfer-0001'], ['63 hex', `0x${'a'.repeat(63)}`], ['65 hex', `0x${'a'.repeat(65)}`], ['no prefix', 'a'.repeat(64)], ['a hash and a line feed', `0x${'a'.repeat(64)}\n`], ['a hash in capitals', `0x${'A'.repeat(64)}`], ['an empty text', ''], ['0X in capitals', `0X${'a'.repeat(64)}`]];
    const one = async (label, fault, hash, rpc = RPC) => {
      const script = [];
      globalThis.fetch = async (input, init = {}) => {
        const call = JSON.parse(init.body);
        const entry = { method: call.method, paramsJson: JSON.stringify(call.params) };
        script.push(entry);
        const started = RealDate.now();
        try { const res = await realFetch(input, init); const text = await res.text(); entry.http = res.status; entry.contentType = res.headers.get('content-type'); entry.body = text; return new Response(text, { status: res.status, headers: res.headers }); } catch (e) {
          entry.failed = e.name === 'TimeoutError' || RealDate.now() - started > 4500 ? 'no answer within the limit (5 s)' : 'the connection was cut'; throw e;
        }
      };
      const silenced = console.error; console.error = () => {};
      let status; try { status = await chainTxStatus(rpc, 'eip155:31337', hash); } finally { globalThis.fetch = realFetch; console.error = silenced; }
      // The receipt and the head are asked for together: their order in the script is not part of the answer.
      chain.push({ kind: label, fault, txHash: hash, rpc: rpc === '' ? 'none configured' : 'the stand-in node', statusJson: JSON.stringify(status), node: script.sort((x, y) => ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber'].indexOf(x.method) - ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber'].indexOf(y.method)) });
    };
    // One after the other: the node's fault "at the head" is the answer to the next question about the head, whoever asks.
    // (The four slow ones each wait out the reference's five seconds.)
    for (const [kind, fault, hash] of hashes) await one(kind, fault, hash);
    for (const [label, hash] of others) await one(label, null, hash);
    await one('confirmed', null, txHash('confirmed', 'remit vectors'), '');
  } finally {
    child.kill('SIGTERM');
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await new Promise((ok) => setTimeout(ok, 100));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  V.chain = { chainLabel: 'eip155:31337', explorer: { template: 'https://explorer.example/tx/{tx}', note: 'the route puts the hash, percent-encoded, in place of the first {tx} only' }, cases: chain };
}

await empty();
await db.close();
rmSync(TMP, { recursive: true, force: true });

const count = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.values(v).reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0) : 0);
const summary = Object.entries({
  'quotes (products, sums, quotes, table cells, order)': V.quotes && [V.quotes.mul.length, V.quotes.add.length, V.quotes.build.length, V.quotes.table.length, V.quotes.order.length].join(' / '),
  'source references (strict, legacy)': V.sourceRefs && `${V.sourceRefs.strict.length} / ${V.sourceRefs.legacy.length}`,
  'duplicate rule (sequences, steps, conflict sentences, backfilled lookups)': V.duplicates && `${V.duplicates.sequences.length} / ${V.duplicates.sequences.reduce((n, s) => n + s.steps.length, 0)} / ${V.duplicates.conflicts?.length} / ${V.duplicates.backfill.lookups.length}`,
  'request hashes': V.requestHashes?.length, 'bank statements (mode B)': V.fieldsAssertion?.cases.length,
  'acceptance (requests, rows of accepted ones)': V.acceptance && `${V.acceptance.requests.length} / ${V.acceptance.stored.length}`,
  'signing (events, elements, shapes)': V.signing && `${V.signing.events.length} / ${V.signing.elements.length} / ${V.signing.shapes.length}`,
  'webhooks (envelopes, ladder cells)': V.webhooks && `${V.webhooks.envelopes.length} / ${V.webhooks.ladder.length}`, 'cursors (issued, read)': V.cursors && `${V.cursors.issued.length} / ${V.cursors.read.length}`,
  'evidence (event logs, packages, later completions)': V.evidence && `${V.evidence.cases.length} / ${V.evidence.cases.filter((c) => c.package).length} / ${V.evidence.cases.reduce((n, c) => n + c.laterCompletions.length, 0)}`, 'chain (transactions)': V.chain?.cases.length, 'search (settlements, searches)': V.search && `${V.search.rows.length} / ${V.search.searches.length}`,
  'manifests (submissions, reads)': V.manifests && `${V.manifests.cases.length} / ${V.manifests.reads.length}`, 'recorded settlements': recordings.length,
}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join('; ');
void count;
if (only) { console.log(`section ${only} computed, nothing written — ${summary}`); process.exit(0); }
const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-remit-vectors.mjs from apps/core/src/remit/ (the reference). Do not edit by hand; the header of that tool says what each section holds and how a test reads it. '
    + 'Keys and what was signed with them are in remit-materials.json (test keys).',
  keys: { platformSpki: SPKI.platform, bank: { ...BANK, spki: SPKI.bank }, bank2: { ...BANK2, spki: SPKI.bank2 }, partner: Object.fromEntries(Object.entries(M.keys.partner).map(([slug, k]) => [slug, { id: k.id, spki: k.signing.spki, ...(k.encryption ? { encryptionJwk: k.encryption.jwk } : {}) }])) },
  ...V, recordings,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) { console.error('remit.json differs from what the reference answers now — run without --check and review the change'); process.exit(1); }
  console.log(`remit.json is current (${summary})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${(text.length / 1024 / 1024).toFixed(1)} MB) — ${summary}`);
}
process.exit(0);
