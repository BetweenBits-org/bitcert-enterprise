/**
 * The settlement rail's flows, run against ONE core and written down in a form two runs can be compared in.
 *
 *   node apps/core-java/tools/remit-flows.mjs --core http://127.0.0.1:8791 --partner http://127.0.0.1:3302 --env apps/core-java/.env.ref --out ref.json
 *        [--only <text>] [--no-slow] [--tag F]
 *   node apps/core-java/tools/compare-remit-flows.mjs ref.json java.json
 *
 * `--core` is a running test server, `--partner` its own listener of the partner stand-in
 * (tools/stand-in-partner.mjs: its control API and its webhook receiver are paths on that listener), `--env` that
 * server's settings file — read for the schema, which this tool only reads from. Every scenario runs on an
 * organisation of its own, made the way a bank is made: signed up at the server's console, its signing key
 * registered, the rail activated with a webhook address at the stand-in's receiver. The bank's side is the deployed
 * SDK (packages/attest-remit). So the tool works the same against the reference and against the Java server, and
 * writes nothing into either store by hand.
 *
 * For each scenario it writes the ledger it left, in a normal form:
 *
 *   answers      what the bank and the receiving institution were answered, request by request (status, body)
 *   payment      the settlement's columns — the state, the amounts, deposit address, chain transaction, evidence level;
 *                whether `request_body` still holds the party data in plaintext; the stored verdict and package (member
 *                order kept); whether the commitment recomputes from the package and its nonce, and is the anchored leaf;
 *                the anchor record's product, content type and descriptor
 *   events       type, issuer, who signed and whether that signature verifies, the payload in the order written
 *   webhooks     the deliveries queued: type, sequence, state, data, the address's path, whether the envelope's
 *                signature verifies with the platform key — and what the stand-in's receiver got, when a worker delivers
 *   travel_rule  the row: recipient, status, digest, and the ciphertext as what it is (five parts, the header, the
 *                sizes, who can open it and the SHA-256 of what is inside)
 *   partner      every request the stand-in received for the payment, in order: path, the Idempotency-Key header as
 *                sent (or null), content type, whether the sender's signature verified, the body, the answer given —
 *                and every callback it sent, with the server's answer
 *   idempotency  the stored answer under the instruction's key, and whether the stored request hash is the SHA-256 of
 *                JSON.stringify of the body as parsed
 *
 * What is new on every run is reduced to its kind, and only that: a time of exactly the reference's shape
 * (`yyyy-MM-ddTHH:mm:ss.SSSZ` — any other shape is left as written, so that it shows), an ECDSA signature, a digest
 * or commitment over something that holds a time or a nonce, an id a server draws, a quote's id, the port in a
 * sentence that quotes the server's own partner address. Payment ids, and with them deposit addresses, transaction
 * hashes and bank references, are the same on every run (`--tag` is part of them: compare runs of the same tag, each
 * on a schema that has not seen that tag).
 *
 * A scenario may be marked: `design13` — its outcome in the reference is one the Java design changes on purpose
 * (docs/JAVA-REMIT-DESIGN.md section 13; the row is quoted); `race` — its outcome in the reference depends on which of
 * two things happens first, so its ledger is written under `observed` and not compared.
 *
 * Nothing live is touched: the core and the partner must be on this machine and not on a live port, the settings
 * file must be safe for a test server (tools/check-test-env.mjs), and the store is only read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RemitClient, signEvent, verifyEvent } from '../../../packages/attest-remit/src/index.ts';
import { packageCommitment } from '../../core/src/remit/evidence.ts';
import { decryptJwe } from '../../core/src/remit/jwe.ts';
import { problems, readEnvFile } from './check-test-env.mjs';
import { loadPartnerKeys } from './stand-in-partner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const CORE = (opt('--core') ?? '').replace(/\/+$/, '');
const PARTNER = (opt('--partner') ?? '').replace(/\/+$/, '');
const envFile = opt('--env');
const outFile = opt('--out');
const only = opt('--only');
const TAG = (opt('--tag') ?? 'F').toUpperCase();
const slow = !args.includes('--no-slow');
if (!CORE || !PARTNER || !envFile || !outFile || !/^[A-Z0-9]{1,4}$/.test(TAG)) {
  console.error('usage: node remit-flows.mjs --core <address> --partner <its stand-in listener> --env <its settings file> --out <file> [--only <text>] [--no-slow] [--tag <1-4 letters>]');
  process.exit(2);
}
const LIVE = new Set(['8787', '3100', '3200', '3300', '3400', '3500', '5106', '8545', '18443']);
for (const [what, address] of [['--core', CORE], ['--partner', PARTNER]]) {
  const u = new URL(address);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || LIVE.has(u.port)) { console.error(`refusing: ${what} must be a test address on this machine, not a live port`); process.exit(1); }
}
const env = readEnvFile(envFile);
const unsafe = problems(env);
if (unsafe.length > 0) { for (const p of unsafe) console.error(`refusing: ${path.basename(envFile)}: ${p}`); process.exit(1); }
const schema = new URL(env.STONEHASH_DB_URL).pathname.replace(/^\//, '');
if (Number(new URL(CORE).port) !== Number(env.PORT)) { console.error(`refusing: ${path.basename(envFile)} is the settings file of a server on port ${env.PORT}, not of ${CORE}`); process.exit(1); }

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha256hex = (v) => createHash('sha256').update(v).digest('hex');
const require = createRequire(new URL('../../core/package.json', import.meta.url));
const mysql = require('mysql2/promise');
const dbUrl = new URL(env.STONEHASH_DB_URL);
const db = await mysql.createConnection({ host: dbUrl.hostname, port: dbUrl.port ? Number(dbUrl.port) : 3306, user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: schema, charset: 'utf8mb4_bin' });
const rows = async (sql, params = []) => (await db.query(sql, params))[0];
const hasJobs = (await rows("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'remit_jobs'", [schema]))[0].n > 0;

// ── talking to the core and to its stand-in ─────────────────────────────────────────────────────────────────────
async function ask(base, method, target, { headers = {}, body } = {}) {
  const res = await fetch(`${base}${target}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
/** The stand-in's control API. While a scenario has the listener refuse connections, it is asked again until it is back. */
async function ctl(method, target, body) {
  for (let i = 0; ; i++) {
    try { return (await ask(PARTNER, method, target, body === undefined ? {} : { body })).body; } catch (e) { if (i > 100) throw e; await sleep(100); }
  }
}
const meta = (await ask(CORE, 'GET', '/v1/remit/meta')).body;
if (!meta?.platform_signer?.spki) { console.error(`${CORE} does not answer GET /v1/remit/meta with a platform key — is the rail enabled there?`); process.exit(1); }
const PLATFORM = meta.platform_signer;
const status = await ctl('GET', '/control/status');
if (status?.core !== CORE) { console.error(`refusing: the listener at ${PARTNER} is the partner of ${status?.core}, not of ${CORE}`); process.exit(1); }
const K = loadPartnerKeys().institutions;
const P = Object.fromEntries(Object.values(K).map((i) => [i.slug, i.id]));
const registered = Object.values(K).filter((i) => i.registered).every((i) => meta.institutions.some((m) => m.id === i.id && m.signing_spki === i.spki));
if (!registered) { console.error(`refusing: the registry of ${CORE} does not hold the stand-in's keys (parity/partner-keys.json) — seed its schema first`); process.exit(1); }

// ── what is new on every run, reduced to its kind ───────────────────────────────────────────────────────────────
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const QUOTE = /QT-[0-9a-f]{8}-[0-9a-f]{4}/g;
const ADDRESS = new RegExp(PARTNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
/** Digests and draws by the name of their member: over a time, a nonce, or a fresh ciphertext. */
const DRAWN = new Set(['digest', 'approvalDigest', 'commitment', 'ciphertext_commitment', 'nonce', 'ack_digest', 'ciphertext_sha256']);
const DRAWN_ID = new Set(['attestation_id', 'event_id']);
const jweSeen = { iv: new Map(), epk: new Map() };
/** A compact JWE as what it is: its parts and sizes, its header, and — opened with the stand-in's keys — what is inside. */
function jweShape(compact) {
  const parts = String(compact).split('.');
  const out = { parts: parts.length, key_part_empty: parts[1] === '' };
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    out.header = { ...header, ...(header.epk ? { epk: { kty: header.epk.kty, crv: header.epk.crv, x_bytes: Buffer.from(String(header.epk.x ?? ''), 'base64url').length, y_bytes: Buffer.from(String(header.epk.y ?? ''), 'base64url').length } } : {}) };
    out.header_members = Object.keys(header).join(',');
    out.iv_bytes = Buffer.from(parts[2] ?? '', 'base64url').length;
    out.tag_bytes = Buffer.from(parts[4] ?? '', 'base64url').length;
    jweSeen.iv.set(parts[2], (jweSeen.iv.get(parts[2]) ?? new Set()).add(compact));
    if (header.epk?.x) jweSeen.epk.set(header.epk.x, (jweSeen.epk.get(header.epk.x) ?? new Set()).add(compact));
    const named = Object.values(K).find((i) => i.enc && `${i.id}-ENC` === header.kid);
    for (const who of [named, K.bfi, K.bfi2].filter(Boolean)) {
      try { const plain = decryptJwe(compact, who.enc.key); out.opened = { by: who.id, plaintext_sha256: sha256hex(plain), plaintext_is_json: (() => { try { JSON.parse(plain.toString('utf8')); return true; } catch { return false; } })() }; break; } catch { /* the next key */ }
    }
    if (!out.opened) out.opened = null;
  } catch (e) { out.unreadable = String(e.message ?? e); }
  return out;
}
function reduce(v, key) {
  if (typeof v === 'string') {
    if (TIME.test(v)) return '<time>';
    if (v === PLATFORM.key_id) return '<the platform key id>';
    if ((key === 'sig' || key === 'value') && SIGNATURE.test(v)) return '<signature>';
    if (DRAWN.has(key) && HEX64.test(v)) return '<digest>';
    if (DRAWN_ID.has(key) && UUID.test(v)) return '<id>';
    if ((key === 'jwe' || key === 'ciphertext') && v.split('.').length === 5) return { jwe: jweShape(v) };
    if (key === 'signing_spki' && v.length > 80) return '<key>';
    return v.replace(QUOTE, '<quote>').replace(ADDRESS, '<its partner>');
  }
  if (Array.isArray(v)) return v.map((x) => reduce(x));
  if (v !== null && typeof v === 'object') {
    if (key === 'encryption_jwk' || key === 'epk') return Object.fromEntries(Object.entries(v).map(([k2, x]) => [k2, k2 === 'x' || k2 === 'y' ? '<key>' : x]));
    return Object.fromEntries(Object.entries(v).map(([k2, x]) => [k2, reduce(x, k2)]));
  }
  return v;
}
const parsed = (text) => { try { return JSON.parse(text); } catch { return { not_json: String(text).slice(0, 80) }; } };

// ── an organisation of its own for every scenario: signed up, its key registered, the rail activated ────────────
let orgs = 0;
async function organisation(word, { webhook = true } = {}) {
  const n = String(++orgs).padStart(3, '0');
  const from = { 'X-Forwarded-For': `10.88.${Math.floor(orgs / 200)}.${(orgs % 200) + 1}` };
  const email = `flows-${TAG.toLowerCase()}-${n}@remit-flows.example`;
  const signup = await ask(CORE, 'POST', '/v1/console/signup', { headers: from, body: { email, password: `flows ${TAG} ${n} — a test account` } });
  if (signup.status !== 201) throw new Error(`organisation ${n}: sign-up answered ${signup.status} ${JSON.stringify(signup.body).slice(0, 200)} — has this schema seen tag ${TAG} before? (seed afresh, or give another --tag)`);
  const cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const apiKey = signup.body.api_key_secret;
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const registeredKey = await ask(CORE, 'POST', '/v1/console/issuer-keys', { headers: { ...from, cookie }, body: { public_key: spki, label: 'bank signing key' } });
  if (registeredKey.status !== 201) throw new Error(`organisation ${n}: registering its key answered ${registeredKey.status} ${JSON.stringify(registeredKey.body).slice(0, 200)}`);
  const bank = { id: `VN-BANK-FL${TAG}${n}`, name: `Flows bank ${n}`, country: 'VN' };
  const hook = `fl${TAG.toLowerCase()}-${n}`;
  const activated = await ask(CORE, 'POST', '/v1/console/products', { headers: { ...from, cookie }, body: { product: 'remit', institution: bank, issuer_key_id: registeredKey.body.id, ...(webhook ? { webhook_url: `${PARTNER}/hooks/${hook}` } : {}) } });
  if (activated.status !== 201) throw new Error(`organisation ${n}: activating the rail answered ${activated.status} ${JSON.stringify(activated.body).slice(0, 200)}`);
  const client = new RemitClient({ core: CORE, apiKey, institutionId: bank.id, institutionName: bank.name, key: pair.privateKey });
  return { n, word, apiKey, bank, key: pair.privateKey, spki, hook: webhook ? hook : null, client, auth: { authorization: `Bearer ${apiKey}` } };
}

// ── what a scenario does, and what is written down of it ────────────────────────────────────────────────────────
const PARTIES = { debtor: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi Blvd, District 1, Ho Chi Minh City', registration_number: 'VN-0312345678', account: 'VN-ACC-000777' },
  creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-000009', bank: 'DBS (sim)' } };
const ANSWERS = { purpose: 'Payment for machine parts under purchase order PO-7781', shipping_reference: 'B/L MAEU-2026-118822' };
const REST = {
  confirmed: ['BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_COMMITTED'], rfi: ['TRAVEL_RULE_PENDING', 'TRAVEL_RULE_RFI'], rejected: ['CANCELLED', 'TRAVEL_RULE_REJECTED'], returned: ['RETURNED', 'USDC_RETURNED'],
  l1: ['PAYOUT_IN_PROGRESS', 'EVIDENCE_INSUFFICIENT'], exception: ['EXCEPTION', 'EXCEPTION'], mismatch: ['EXCEPTION', 'SETTLEMENT_RECONCILED'], onchain: ['ONCHAIN_SETTLED', 'USDC_TRANSFER_CONFIRMED'], cancelled: ['CANCELLED', undefined],
};
function context(sc, org) {
  const made = [];
  const answers = [];
  const sent = new Map(); // payment id → the body it was instructed with
  const note = (step, r) => { answers.push({ step, status: r.status, body: reduce(r.body) }); return r; };
  const view = async (id) => (await ask(CORE, 'GET', `/v1/settlements/${encodeURIComponent(id)}`, { headers: org.auth })).body;
  const types = (v) => (v?.events ?? []).map((e) => e.type);
  const S = {
    org, P, id: (word) => `PAY-FL${TAG}-${org.n}-${word}`.slice(0, 60),
    plan: (id, plan) => ctl('POST', '/control/plan', { payment_id: id, ...plan }),
    /** An instruction on a quote of its own; `plan` is given to the stand-in first. Answers with the id; the answer is written down. */
    async submit(word, { amount = '1200.00', mode = 'A', plan, creditor, bfi, source, idem, expect = 202, mutate } = {}) {
      const id = S.id(word);
      if (plan) await S.plan(id, plan);
      const quote = await org.client.quote(amount);
      const parties = { debtor: PARTIES.debtor, creditor: { ...PARTIES.creditor, ...(creditor ?? {}) } };
      const opts = { paymentId: id, invoiceRef: `INV-${id}`, beneficiaryInstitution: P[bfi ?? 'bfi'], ...(source ? { source } : {}), ...(mode === 'B' ? { travelRule: 'B' } : {}) };
      const built = (mode === 'B' ? await org.client.buildInstructionAsync(quote, parties, opts) : org.client.buildInstruction(quote, parties, opts)).body;
      const body = mutate ? mutate(built) : built;
      const r = note(`instruction ${word}`, await ask(CORE, 'POST', '/v1/settlements', { headers: { ...org.auth, 'idempotency-key': idem ?? `flows-${id}` }, body }));
      if (r.status !== expect) throw new Error(`${id}: the instruction was answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}, not ${expect}`);
      if (r.status === 202) { made.push(id); sent.set(id, { body, key: idem ?? `flows-${id}` }); }
      return id;
    },
    /** The same bytes again (or other bytes) under a key: the answer is written down. */
    async again(word, id, { key, change } = {}) {
      const first = sent.get(id);
      const body = change ? change(structuredClone(first.body)) : first.body;
      return note(word, await ask(CORE, 'POST', '/v1/settlements', { headers: { ...org.auth, 'idempotency-key': key ?? first.key }, body }));
    },
    view, types,
    /** Asks the settlement until it rests at [state, last event type] and the stand-in has no callbacks under way. */
    async until(id, [state, last], timeout = 15_000) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await view(id);
        if (v.state === state && (last === undefined || types(v).at(-1) === last) && (await ctl('GET', `/control/idle?payment_id=${encodeURIComponent(id)}&timeout=20`)).idle) return v;
        if (Date.now() > end) throw new Error(`${id} did not come to rest at ${state}${last ? ` after ${last}` : ''} within ${timeout} ms: it is ${v.state} after ${types(v).slice(-3).join(', ')}`);
        await sleep(50);
      }
    },
    async arrived(id, step, { n = 1, answered = false, timeout = 8000 } = {}) {
      const r = await ctl('GET', `/control/wait?payment_id=${encodeURIComponent(id)}&step=${step}&n=${n}&timeout=${timeout}${answered ? '&answered=1' : ''}`);
      if (!r.arrived) throw new Error(`${id}: the ${step} call never arrived at the stand-in`);
    },
    release: (id, more = {}) => ctl('POST', '/control/release', { payment_id: id, ...more }),
    idle: (id) => ctl('GET', `/control/idle?payment_id=${encodeURIComponent(id)}&timeout=8000`),
    /** The stand-in signs and sends one callback; the server's answer is written down. */
    async callback(id, spec) {
      const r = await ctl('POST', '/control/callback', { payment_id: id, ...(typeof spec === 'string' ? { type: spec } : spec) });
      answers.push({ step: `callback ${typeof spec === 'string' ? spec : `${spec.type}${spec.again ? ` again (${spec.again})` : ''}${spec.level ? ` at ${spec.level}` : ''}`}`, status: r.answer?.status ?? null, body: reduce(r.answer?.body ?? r.answer) });
      return r;
    },
    async cancel(id, reason, word = 'cancel') {
      const body = reason === undefined ? { sig: signEvent({ payment_id: id, reason: 'cancelled by instructing bank' }, org.key, org.bank.id, org.bank.name) } : { reason, sig: signEvent({ payment_id: id, reason }, org.key, org.bank.id, org.bank.name) };
      return note(word, await ask(CORE, 'POST', `/v1/settlements/${encodeURIComponent(id)}/cancel`, { headers: org.auth, body }));
    },
    async answer(id, answers2 = ANSWERS, word = 'answer') {
      return note(word, await ask(CORE, 'POST', `/v1/settlements/${encodeURIComponent(id)}/rfi-response`, { headers: org.auth, body: { answers: answers2, sig: signEvent({ payment_id: id, answers: answers2 }, org.key, org.bank.id, org.bank.name) } }));
    },
    /** Refuse connections at the stand-in for a while (the answer to this goes out first), and wait until it listens again. */
    async close(ms) { await ctl('POST', '/control/close', { ms }); },
    async reopened() { for (let i = 0; i < 200; i++) { try { if ((await ask(PARTNER, 'GET', '/healthz')).status === 200) return; } catch { /* closed */ } await sleep(50); } throw new Error('the stand-in did not come back'); },
    sleep,
  };
  return { S, made, answers, sent };
}

/** Waits until nothing is written for a settlement any more: its events, its webhook rows and its row stay as they are for a moment. */
async function quiet(id) {
  let last = ''; let since = Date.now();
  for (let i = 0; i < 200; i++) {
    const [e] = await rows('SELECT COUNT(*) AS n FROM remit_events WHERE payment_id = ?', [id]);
    const [w] = await rows('SELECT COUNT(*) AS n FROM remit_webhook_deliveries WHERE payment_id = ?', [id]);
    const [p] = await rows('SELECT state, updated_at, attestation_id FROM remit_payments WHERE id = ?', [id]);
    const now = `${e.n}/${w.n}/${p?.state}/${p?.updated_at}/${p?.attestation_id}`;
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 300) return;
    await sleep(60);
  }
}

const keyOf = new Map(meta.institutions.map((i) => [i.id, i.signing_spki]));
async function ledgerOf(id, org, sentBody) {
  await quiet(id);
  const [p] = await rows('SELECT * FROM remit_payments WHERE id = ?', [id]);
  if (!p) return { payment: null };
  const institutions = (await ask(CORE, 'GET', '/v1/remit/meta')).body.institutions;
  for (const i of institutions) keyOf.set(i.id, i.signing_spki);
  const request = parsed(p.request_body);
  const pkg = p.package_json === null ? null : parsed(p.package_json);
  const [att] = p.attestation_id ? await rows('SELECT * FROM attestations WHERE id = ?', [p.attestation_id]) : [];
  const payment = {
    id: p.id, state: p.state, corridor: `${p.corridor_origin}>${p.corridor_destination}`, trade: `${p.trade_amount} ${p.trade_currency}`, collect: `${p.collect_amount} ${p.collect_currency}`, usdc: p.usdc_amount,
    payout: `${p.payout_amount} ${p.payout_currency}`, quote_id: reduce(p.quote_id), beneficiary_institution: p.beneficiary_institution, deposit_address: p.deposit_address, chain_tx: p.chain_tx, evidence_level: p.evidence_level,
    org_is_its_own: p.org_id !== null && p.org_id.length > 0, created_at: reduce(p.created_at), updated_at: reduce(p.updated_at),
    request_body: { members: Object.keys(request).join(','), holds_plaintext: Object.hasOwn(request, 'compliance_plaintext'), holds_ciphertext: Object.hasOwn(request, 'compliance_ciphertext'), is_what_json_stringify_writes: JSON.stringify(request) === p.request_body },
    verdict: p.verdict === null ? null : reduce(parsed(p.verdict)),
    package: pkg === null ? null : reduce({ ...pkg, trust_registry: { ...pkg.trust_registry, institutions: (pkg.trust_registry?.institutions ?? []).map((i) => ({ ...i, id: String(i.id).replace(/-(BANK|EX)-[0-9A-F]{6}$/, '-$1-<issued>') })) } }),
    package_is_what_json_stringify_writes: pkg === null ? null : JSON.stringify(pkg) === p.package_json,
    commitment: p.commitment === null ? null : (HEX64.test(p.commitment) ? '<digest>' : p.commitment), nonce: p.nonce === null ? null : (HEX64.test(p.nonce) ? '<32 bytes of hex>' : p.nonce),
    commitment_recomputes: pkg === null || p.nonce === null ? null : packageCommitment(pkg, p.nonce) === p.commitment,
    anchor_record: att ? { product: att.product, content_type: att.content_type, descriptor: reduce(parsed(att.descriptor)), status: att.status, kind: att.kind, source: att.source, leaf_is_the_commitment: att.leaf_bytes === p.commitment } : null,
  };
  const events = (await rows('SELECT seq, type, issuer, payload, sig, created_at FROM remit_events WHERE payment_id = ? ORDER BY seq', [id])).map((e) => {
    const payload = parsed(e.payload);
    const sig = e.sig === null ? null : parsed(e.sig);
    const spki = sig === null ? null : sig.key_id === PLATFORM.key_id ? PLATFORM.spki : sig.key_id === org.bank.id ? org.spki : keyOf.get(sig.key_id) ?? null;
    return { seq: e.seq, type: e.type, issuer: e.issuer, at: reduce(e.created_at), signed_by: sig === null ? null : sig.key_id === PLATFORM.key_id ? '<the platform key>' : sig.key_id, signer_name: sig?.issuer ?? null,
      signature_verifies: sig === null ? null : spki === null ? 'no such key is registered' : verifyEvent(payload, sig, spki), payload_is_what_json_stringify_writes: JSON.stringify(payload) === e.payload,
      ...(e.type === 'SETTLEMENT_INSTRUCTED' && payload.signature ? { instruction_signature_verifies: verifyEvent((({ signature: _s, ...rest }) => rest)(payload), payload.signature, PLATFORM.spki) } : {}),
      payload: reduce(payload) };
  });
  const webhooks = (await rows('SELECT url, body, attempts, status, last_error, next_attempt_at, created_at FROM remit_webhook_deliveries WHERE payment_id = ?', [id])).map((w) => {
    const body = parsed(w.body);
    return { sequence: body.envelope?.sequence, type: body.envelope?.type, state: body.envelope?.state, data: reduce(body.envelope?.data), members: Object.keys(body).join(','), envelope_members: Object.keys(body.envelope ?? {}).join(','),
      event_id_is_a_uuid: UUID.test(String(body.envelope?.event_id)), occurred_at: reduce(body.envelope?.occurred_at), signed_by: body.signature?.key_id === PLATFORM.key_id ? '<the platform key>' : body.signature?.key_id ?? null,
      signature_verifies: body.envelope && body.signature ? verifyEvent(body.envelope, body.signature, PLATFORM.spki) : false, body_is_what_json_stringify_writes: JSON.stringify(body) === w.body,
      to: (() => { try { const u = new URL(w.url); return `${u.origin === PARTNER ? '<its partner>' : u.origin}${u.pathname}`; } catch { return w.url; } })(), status: w.status, attempts: w.attempts, last_error: w.last_error, next_attempt_at: reduce(w.next_attempt_at) };
  }).sort((a, b) => (a.sequence - b.sequence) || String(a.type).localeCompare(String(b.type)));
  const travel = (await rows('SELECT protocol, recipient, ciphertext, ivms101_digest, status, response FROM remit_travel_rule WHERE payment_id = ? ORDER BY created_at', [id])).map((t) => ({ protocol: t.protocol, recipient: t.recipient, status: t.status, ivms101_digest: t.ivms101_digest, ciphertext: jweShape(t.ciphertext), response: t.response === null ? null : reduce(parsed(t.response)) }));
  const partner = ((await ctl('GET', `/log?payment_id=${encodeURIComponent(id)}`)).entries ?? []).map((e) => (e.dir === 'in'
    ? { dir: 'in', step: e.step, path: e.path, idempotency_key: e.headers?.['idempotency-key'] ?? null, content_type: e.headers?.['content-type'] ?? null, sender_signature: e.sender, behaviour: e.behaviour, body: reduce(e.body),
      answer: e.answer === null ? 'none yet (held)' : e.answer.cut ? 'the connection was cut' : { status: e.answer.status, body: reduce(e.answer.body) } }
    : { dir: 'out', callback: e.type, signed_by: e.signed_by, again: e.again, body: reduce(e.body), answer: e.answer === null ? null : e.answer.error !== undefined ? { error: e.answer.error } : { status: e.answer.status, body: reduce(e.answer.body) } }));
  const idem = sentBody ? (await rows('SELECT request_hash, response_status, response_body FROM remit_idempotency WHERE org_id = ? AND idem_key = ?', [p.org_id, sentBody.key])).map((r) => ({ response_status: r.response_status, response_body: reduce(parsed(r.response_body)),
    request_hash_is_sha256_of_the_body_as_stringified: r.request_hash === sha256hex(JSON.stringify(sentBody.body)) })) : [];
  const source = (await rows('SELECT message_type, sha256, idx, uetr, value_date, content, twin_key FROM remit_source_refs WHERE payment_id = ?', [id]));
  const own = hasJobs ? { jobs: (await rows('SELECT kind, lane, state, attempts, last_error, call_started_at IS NOT NULL AS call_started FROM remit_jobs WHERE payment_id = ? ORDER BY created_at, id', [id])) } : {};
  return { payment, events, webhooks, travel_rule: travel, partner, idempotency: idem, source_reference: source, ...(hasJobs ? { own } : {}) };
}

// ── the scenarios ───────────────────────────────────────────────────────────────────────────────────────────────
const scenarios = [];
/** `fn(S)` drives one organisation's payments; opts: design13 (the row of section 13 it belongs to), race, slow, closes (it makes the stand-in refuse connections), webhook: false */
const scenario = (name, fn, opts = {}) => scenarios.push({ name, fn, ...opts });
const D = {
  cancelVsApproval: '취소와 승인이 겹침 — TypeScript: 취소가 승인으로 덮이고 전송이 나갈 수 있음 / Java: 먼저 커밋한 쪽만 성공 (T3 · T7: a result that arrives after the cancellation writes nothing)',
  unreachable: '파트너에 연결이 되지 않음 — TypeScript: 첫 실패에 EXCEPTION / Java: 같은 키로 세 번까지 다시 시도한 뒤 EXCEPTION (REMIT_STEP_RETRY_MS=off: 첫 실패에); 문장의 괄호 안 원인이 다름',
  walletUnknown: '지갑 전송의 응답을 받지 못함 · 지갑이 5xx로 답하거나 검증되지 않는 답을 줌 — TypeScript: EXCEPTION, 파트너 오류 문장 / Java: EXCEPTION, "결과를 모름" 문장, 작업은 attention',
  outOfState: '전제 상태가 아닌 콜백 — TypeScript: 이벤트를 추가한 뒤 500 invalid_transition, 또는 이벤트와 웹훅을 쓰고 200 / Java: 409 wrong_state, 아무것도 쓰지 않음',
  repeated: '같은 콜백이 다시 옴 — TypeScript: 이벤트와 웹훅이 한 번 더 / Java: 200, 다시 쓰지 않음',
  l1ThenSigned: 'L1 뒤에 서명된 완료 통보가 옴 — TypeScript: 첫(서명 없는) 영수증으로 대사해 EXCEPTION / Java: 그 통보의 영수증으로 대사',
  reconcileThrows: '대사가 안에서 실패 — TypeScript: 콜백에 500, 그 상태에 멈춤 / Java: 콜백에 200, 다시 시도, 한도 뒤 사람에게 알림',
  packageFails: '패키지 조립이 실패 — TypeScript: 콜백에 200, 로그만 남기고 그 상태에 멈춤 / Java: 콜백에 200, 다시 시도, 한도 뒤 사람에게 알림',
  cancelAnswer: '취소의 응답 — TypeScript: 수취기관 통지가 끝난 뒤 / Java: 취소를 커밋한 즉시. 통지는 뒤에서 (the ledger is the same; the partner hears of it either way)',
  twoAnswers: '겹친 RFI 답변, 늦은 쪽이 거절됨 — TypeScript: 먼저 수락된 송금이 취소됨 / Java: 409 already_resolved, 송금은 그대로',
  plaintext: '종결될 때 남아 있던 평문 — TypeScript: 그대로 둠 / Java: 지움',
  pageUnder200: '2xx인데 JSON이 아닌 응답 (design 3.5) — payout-approval: Java의 문장 / transfer: 결과를 모름 / 통지 둘: 성공 (기준과 같음)',
  idempotencyKey: '파트너가 받는 요청 — TypeScript: 헤더 없음 / Java: Idempotency-Key 헤더 (every scenario: partner[].idempotency_key)',
};
const NORMAL = (S, word, opts) => S.submit(word, opts).then((id) => S.until(id, REST.confirmed));

scenario('normal flow, mode A', async (S) => { await NORMAL(S, 'NORMAL-A'); });
scenario('normal flow, mode B (the bank encrypts)', async (S) => { await NORMAL(S, 'NORMAL-B', { mode: 'B' }); });
scenario('normal flow to the second receiving institution', async (S) => { await NORMAL(S, 'BFI2', { bfi: 'bfi2' }); });
scenario('normal flow of an organisation without a webhook address: no delivery is queued', async (S) => { await NORMAL(S, 'NO-HOOK'); }, { webhook: false });
scenario('completed at L2 (no bank reference)', async (S) => { await NORMAL(S, 'L2', { amount: '1000.02' }); });
scenario('completed with no level stated (read as L2)', async (S) => { await NORMAL(S, 'NO-LEVEL', { plan: { callbacks: { level: 'none' } } }); });
scenario('the same instruction again: the first answer, to the letter; other bytes under its key; its bytes under another key', async (S) => {
  const id = await S.submit('AGAIN'); await S.until(id, REST.confirmed);
  const first = await S.again('the same bytes, the same key', id);
  const [stored] = await rows('SELECT response_body FROM remit_idempotency WHERE idem_key = ?', [`flows-${id}`]);
  S.org.replayIsTheStoredAnswer = JSON.stringify(first.body) === JSON.stringify(parsed(stored?.response_body ?? 'null'));
  await S.again('other bytes, the same key', id, { change: (b) => ({ ...b, request_id: 'REQ-CHANGED' }) });
  await S.again('the same bytes, another key', id, { key: `flows-${id}-other` });
});
scenario('a refusal is not remembered: refused, then corrected under the same key', async (S) => {
  const key = `flows-refused-then-fixed-${S.org.n}`;
  await S.submit('FIXED', { idem: key, expect: 400, mutate: (b) => ({ ...b, amount: { ...b.amount, payout: { currency: 'SGD', value: '1.00' } } }) });
  const id = await S.submit('FIXED', { idem: key }); await S.until(id, REST.confirmed);
});
scenario('made from a bank\'s message; the message again; a twin with a UETR, which the settlement takes', async (S) => {
  const file = (l) => sha256hex(`remit-flows ${TAG} ${l}`);
  const src = { type: 'pacs.008.001.08', sha256: file('F'), messageId: 'FL-MSG-1', instructionId: 'FL-INS-1', endToEndId: 'FL-E2E-1', valueDate: '2026-11-17', content: file('content') };
  const id = await S.submit('SRC', { source: src }); await S.until(id, REST.confirmed);
  await S.submit('SRC-AGAIN', { source: src, expect: 409 });
  await S.submit('SRC-TWIN', { source: { ...src, sha256: file('F again'), uetr: 'f10e5000-1111-4222-8333-444455556666' }, expect: 409 });
  await S.submit('SRC-UETR', { source: { ...src, sha256: file('F a third time'), uetr: 'f10e5000-1111-4222-8333-444455556666' }, expect: 409 });
});

// The receiving institution asks, rejects, is slow.
scenario('a question (USD 20,000 or more), answered and accepted', async (S) => { const id = await S.submit('RFI-OK', { amount: '25000.00' }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.confirmed); });
scenario('a question in mode B, answered and accepted', async (S) => { const id = await S.submit('RFI-B', { amount: '25000.00', mode: 'B' }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.confirmed); });
scenario('a question, every answer blank: rejected', async (S) => { const id = await S.submit('RFI-BLANK', { amount: '25000.00' }); await S.until(id, REST.rfi); await S.answer(id, { purpose: '  ', shipping_reference: '' }); await S.until(id, REST.rejected); });
scenario('a question, the answer rejected with a reason', async (S) => { const id = await S.submit('RFI-REJECT', { amount: '25000.00', plan: { steps: { 'travel-rule-response': { do: 'reject', reason: 'the documents do not support the stated purpose' } } } }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.rejected); });
scenario('a question, the answer rejected with no reason', async (S) => { const id = await S.submit('RFI-REJECT-BARE', { amount: '25000.00', plan: { steps: { 'travel-rule-response': { do: 'reject' } } } }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.rejected); });
scenario('a question as a bare reason, remembered by the institution: answered and accepted', async (S) => { const id = await S.submit('RFI-BARE', { plan: { steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment', remember: true } } } }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.confirmed); });
scenario('a question, the answer acknowledged under a status of RFI: taken as accepted', async (S) => { const id = await S.submit('RFI-STATUS', { amount: '25000.00', plan: { steps: { 'travel-rule-response': { do: 'ack', top: { status: 'RFI' } } } } }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.confirmed); });
scenario('a question, the answer acknowledged by a key nobody registered: the bank is told, the question stays open', async (S) => { const id = await S.submit('RFI-STRANGER', { amount: '25000.00', plan: { steps: { 'travel-rule-response': [{ do: 'ack', signedBy: 'stranger' }] } } }); await S.until(id, REST.rfi); await S.answer(id); await S.until(id, REST.rfi); });
scenario('a question, the institution refusing (409) and failing (500) before it takes the answer', async (S) => {
  const id = await S.submit('RFI-RETRY', { amount: '25000.00', plan: { steps: { 'travel-rule-response': [{ do: 'refuse', status: 409, message: 'the compliance desk is closed' }, { do: 'fail', status: 500, message: 'boom' }] } } });
  await S.until(id, REST.rfi); await S.answer(id, ANSWERS, 'answer, refused by the institution'); await S.answer(id, ANSWERS, 'answer, the institution failing'); await S.answer(id, ANSWERS, 'answer, taken'); await S.until(id, REST.confirmed);
});
scenario('a question, the institution out of reach when the answer is sent, then back', async (S) => {
  const id = await S.submit('RFI-UNREACHABLE', { amount: '25000.00' }); await S.until(id, REST.rfi);
  await S.close(700); await S.sleep(80); await S.answer(id, ANSWERS, 'answer, the institution not reachable'); await S.reopened(); await S.answer(id, ANSWERS, 'answer, taken'); await S.until(id, REST.confirmed);
}, { closes: true, design13: D.unreachable });
scenario('travel rule rejected: a beneficiary on the screening list', async (S) => { const id = await S.submit('SANCTIONED', { creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } }); await S.until(id, REST.rejected); });
scenario('travel rule rejected with no reason', async (S) => { const id = await S.submit('REJECT-BARE', { plan: { steps: { 'travel-rule': { do: 'reject' } } } }); await S.until(id, REST.rejected); });

// Cancelling.
scenario('cancel while a question is open', async (S) => { const id = await S.submit('CANCEL-RFI', { amount: '25000.00' }); await S.until(id, REST.rfi); await S.cancel(id, 'the importer withdrew the order'); await S.arrived(id, 'cancel', { answered: true }); await S.until(id, REST.cancelled); });
scenario('cancel with no reason while a question is open, the institution answering 500 to the notice', async (S) => { const id = await S.submit('CANCEL-NOTICE-500', { amount: '25000.00', plan: { steps: { cancel: { do: 'fail', status: 500, message: 'the desk is closed' } } } }); await S.until(id, REST.rfi); await S.cancel(id, undefined); await S.arrived(id, 'cancel', { answered: true }); await S.until(id, REST.cancelled); });
scenario('cancel while the travel rule is out and unanswered; the acknowledgement arrives afterwards', async (S) => {
  const id = await S.submit('CANCEL-TR-HELD', { plan: { steps: { 'travel-rule': { do: 'hold' } } } }); await S.arrived(id, 'travel-rule');
  await S.cancel(id, 'changed our mind'); await S.arrived(id, 'cancel', { answered: true }); await S.release(id); await S.arrived(id, 'travel-rule', { answered: true }); await S.sleep(400); await S.until(id, REST.cancelled);
}, { design13: D.cancelVsApproval });
scenario('cancel while the approval request waits at the institution; looked at afterwards, it is refused there', async (S) => {
  const id = await S.submit('CANCEL-AP-HELD', { plan: { steps: { 'payout-approval': { do: 'hold' } } } }); await S.arrived(id, 'payout-approval');
  await S.cancel(id, 'changed our mind'); await S.release(id); await S.arrived(id, 'payout-approval', { answered: true }); await S.sleep(400); await S.until(id, REST.cancelled);
});
scenario('cancel after the institution approved but before its answer arrived; the approval arrives afterwards', async (S) => {
  const id = await S.submit('CANCEL-AP-LATE', { plan: { steps: { 'payout-approval': { do: 'hold-after' } } } }); await S.arrived(id, 'payout-approval');
  await S.cancel(id, 'changed our mind'); await S.release(id); await S.arrived(id, 'payout-approval', { answered: true }); await S.sleep(400); await S.until(id, REST.cancelled);
}, { design13: D.cancelVsApproval });
scenario('cancel too late: the transfer is under way; it then completes', async (S) => {
  const id = await S.submit('CANCEL-LATE', { plan: { steps: { transfer: { do: 'hold' } } } }); await S.arrived(id, 'transfer');
  await S.cancel(id, 'too late'); await S.release(id); await S.until(id, REST.confirmed);
});
scenario('cancel after everything: credited', async (S) => { const id = await S.submit('CANCEL-DONE'); await S.until(id, REST.confirmed); await S.cancel(id, 'much too late'); });
scenario('cancel and the held approval let go at the same moment', async (S) => {
  const id = await S.submit('CANCEL-RACE', { plan: { steps: { 'payout-approval': { do: 'hold-after' } } } }); await S.arrived(id, 'payout-approval');
  await Promise.all([S.cancel(id, 'at the same moment'), S.release(id)]); await S.arrived(id, 'payout-approval', { answered: true }); await S.sleep(1500); await S.idle(id);
}, { race: true, design13: D.cancelVsApproval });
scenario('two answers to one question at the same moment', async (S) => {
  const id = await S.submit('RFI-TWICE', { amount: '25000.00' }); await S.until(id, REST.rfi);
  await Promise.all([S.answer(id, ANSWERS, 'answer, one of two'), S.answer(id, { ...ANSWERS, purpose: 'the same, said otherwise' }, 'answer, the other')]); await S.sleep(2000); await S.idle(id);
}, { race: true, design13: D.twoAnswers });

// Evidence levels, failures after the chain.
scenario('completed at L1: held', async (S) => { const id = await S.submit('L1', { amount: '1000.01' }); await S.until(id, REST.l1); });
scenario('completed at L1, then with the bank\'s confirmation (L3)', async (S) => {
  const id = await S.submit('L1-L3', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'PAYOUT_COMPLETED', level: 'L3' }] } } }); await S.until(id, REST.mismatch);
}, { design13: D.l1ThenSigned });
scenario('payout failed, the USDC returned', async (S) => { const id = await S.submit('FAILED', { amount: '1000.13' }); await S.until(id, REST.returned); });
scenario('the USDC returned with no failure reported', async (S) => { const id = await S.submit('RETURNED', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'USDC_RETURNED'] } } }); await S.until(id, REST.returned); });
scenario('reconciliation fails: the receipt states another amount', async (S) => { const id = await S.submit('MISMATCH', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { with: { amount: '9999.99' } } }] } } }); await S.until(id, REST.mismatch); });
scenario('reconciliation fails: the receipt\'s signature is broken', async (S) => { const id = await S.submit('BROKEN-RECEIPT', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { breakSignature: true } }] } } }); await S.until(id, REST.mismatch); });
scenario('reconciliation fails: the receipt is signed by a key nobody registered', async (S) => { const id = await S.submit('STRANGER-RECEIPT', { plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { signedBy: 'stranger' } }] } } }); await S.until(id, REST.mismatch); });
scenario('reconciliation fails: the wallet\'s chain element is for another address', async (S) => { const id = await S.submit('OTHER-ADDRESS', { plan: { steps: { transfer: { element: { with: { toAddress: `0x${'ee'.repeat(20)}` } } } } } }); await S.until(id, REST.mismatch); });
scenario('reconciliation cannot be done: the wallet\'s chain element states its amount as a number', async (S) => {
  const id = await S.submit('RECON-THROWS', { plan: { steps: { transfer: { element: { with: { amount: 1200 } } } } } }); await S.until(id, ['PAYOUT_IN_PROGRESS', 'PAYOUT_COMPLETED']);
}, { design13: D.reconcileThrows });

// Callbacks: twice, out of order, late.
const manual = async (S, word, more = {}) => { const id = await S.submit(word, { plan: { callbacks: 'manual', ...(more.plan ?? {}) }, ...more, plan: { callbacks: 'manual', ...(more.plan ?? {}) } }); await S.until(id, REST.onchain); await S.arrived(id, 'settlement-notice', { answered: true }); return id; };
scenario('each callback once, sent by hand in order', async (S) => { const id = await manual(S, 'BY-HAND'); for (const t of ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED']) await S.callback(id, t); await S.until(id, REST.confirmed); });
scenario('a callback twice, the same bytes', async (S) => {
  const id = await manual(S, 'TWICE'); await S.callback(id, 'USDC_RECEIVED'); await S.callback(id, { type: 'USDC_RECEIVED', again: 'bytes' }); await S.callback(id, 'PAYOUT_SUBMITTED'); await S.callback(id, { type: 'PAYOUT_SUBMITTED', again: 'bytes' });
  await S.callback(id, 'PAYOUT_COMPLETED'); await S.callback(id, { type: 'PAYOUT_COMPLETED', again: 'bytes' }); await S.until(id, REST.confirmed);
}, { design13: D.repeated });
scenario('a callback twice, the same payload signed anew', async (S) => {
  const id = await manual(S, 'RESIGNED'); await S.callback(id, 'USDC_RECEIVED'); await S.callback(id, { type: 'USDC_RECEIVED', again: 'resign' }); await S.callback(id, 'PAYOUT_SUBMITTED'); await S.callback(id, { type: 'PAYOUT_SUBMITTED', again: 'resign', signedBy: 'bfi2' });
  await S.callback(id, 'PAYOUT_COMPLETED'); await S.until(id, REST.confirmed);
}, { design13: D.repeated });
scenario('callbacks out of order: submitted and completed before the USDC is said to have arrived', async (S) => { const id = await manual(S, 'ORDER'); await S.callback(id, 'PAYOUT_SUBMITTED'); await S.callback(id, 'PAYOUT_COMPLETED'); await S.until(id, REST.confirmed); });
scenario('a late callback: the USDC is said to have arrived after the credit was confirmed', async (S) => {
  const id = await manual(S, 'LATE'); await S.callback(id, 'PAYOUT_SUBMITTED'); await S.callback(id, 'PAYOUT_COMPLETED'); await S.until(id, REST.confirmed); await S.callback(id, 'USDC_RECEIVED'); await S.callback(id, 'PAYOUT_SUBMITTED');
}, { design13: D.outOfState });
scenario('a callback for a settlement that was cancelled, and one that was returned', async (S) => {
  const a = await S.submit('AFTER-CANCEL', { creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } }); await S.until(a, REST.rejected); await S.callback(a, 'USDC_RECEIVED'); await S.callback(a, 'PAYOUT_SUBMITTED');
  const b = await S.submit('AFTER-RETURN', { amount: '1000.13' }); await S.until(b, REST.returned); await S.callback(b, 'USDC_RECEIVED'); await S.callback(b, 'USDC_RETURNED');
}, { design13: D.outOfState });
scenario('a return after the credit was confirmed', async (S) => { const id = await S.submit('RETURN-AFTER-CREDIT'); await S.until(id, REST.confirmed); await S.callback(id, 'USDC_RETURNED'); }, { design13: D.outOfState });
scenario('callbacks the platform refuses: an unknown type, the wrong signers, an unknown payment', async (S) => {
  const id = await manual(S, 'REFUSED');
  await S.callback(id, { type: 'SOMETHING_ELSE' }); await S.callback(id, { type: 'USDC_RECEIVED', signedBy: 'stranger' }); await S.callback(id, { type: 'USDC_RECEIVED', signedBy: 'wallet' }); await S.callback(id, { type: 'USDC_RECEIVED', breakSignature: true });
  await S.callback(S.id('NOBODY-HAS-THIS'), { type: 'USDC_RECEIVED' });
});

// Each partner call, failing in each way.
const fails = (word, steps, rest = REST.exception, opts = {}) => scenario(word, async (S) => { const id = await S.submit(word.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase().slice(0, 34), { plan: { steps, ...(opts.callbacks ? { callbacks: opts.callbacks } : {}) } }); await S.until(id, rest, opts.timeout); }, opts);
fails('travel rule refused 422', { 'travel-rule': { do: 'refuse', status: 422, message: 'the receiving institution does not take this corridor today' } });
fails('travel rule refused 400 with a code alone', { 'travel-rule': { do: 'refuse', status: 400, body: { error: 'bad_request' } } });
fails('travel rule refused 404 with an empty body', { 'travel-rule': { do: 'refuse', status: 404, raw: '' } });
fails('travel rule failed 500', { 'travel-rule': { do: 'fail', status: 500, message: 'boom' } });
fails('travel rule a page under 200', { 'travel-rule': 'html' });
fails('travel rule dropped', { 'travel-rule': 'drop' });
fails('travel rule a status nobody knows', { 'travel-rule': { do: 'ack', top: { status: 'MAYBE' } } });
fails('travel rule ACK and no acknowledgement', { 'travel-rule': { do: 'ack', omit: ['ack'] } });
fails('travel rule acknowledged by a key nobody registered', { 'travel-rule': { signedBy: 'stranger' } });
fails('travel rule acknowledged by the settlement entity', { 'travel-rule': { signedBy: 'wallet' } });
fails('travel rule acknowledged with a broken signature', { 'travel-rule': { breakSignature: true } });
fails('approval refused 409', { 'payout-approval': { do: 'refuse', status: 409, message: 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)' } });
fails('approval failed 503', { 'payout-approval': { do: 'fail', status: 503, message: 'maintenance' } });
fails('approval a page under 200', { 'payout-approval': 'html' }, REST.exception, { design13: D.pageUnder200 });
fails('approval dropped after the work', { 'payout-approval': 'drop-after' });
fails('approval for another amount', { 'payout-approval': { with: { usdc_amount: '1.00' } } });
fails('approval for another payment', { 'payout-approval': { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } });
fails('approval signed by the settlement entity', { 'payout-approval': { signedBy: 'wallet' } });
fails('approval signed by a key nobody registered', { 'payout-approval': { signedBy: 'stranger' } });
fails('transfer refused 403', { transfer: { do: 'refuse', status: 403, message: 'per-payment cap exceeded (sandbox: 50,000 mUSDC)' } });
fails('transfer failed 500, nothing moved', { transfer: { do: 'fail', status: 500, message: 'the wallet is down' } }, REST.exception, { design13: D.walletUnknown });
fails('transfer: the funds moved, then 500', { transfer: { do: 'fail-after', status: 500 } }, REST.exception, { design13: D.walletUnknown });
fails('transfer dropped after the work', { transfer: 'drop-after' }, REST.exception, { design13: D.walletUnknown });
fails('transfer a page under 200', { transfer: 'html' }, REST.exception, { design13: D.walletUnknown });
fails('transfer result for another payment', { transfer: { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } }, REST.exception, { design13: D.walletUnknown });
fails('transfer result signed by the receiving institution', { transfer: { signedBy: 'bfi' } }, REST.exception, { design13: D.walletUnknown });
fails('transfer result with a broken signature', { transfer: { breakSignature: true } }, REST.exception, { design13: D.walletUnknown });
fails('settlement notice refused 404', { 'settlement-notice': { do: 'refuse', status: 404, message: 'unknown payment' } });
fails('settlement notice failed 500, nothing done', { 'settlement-notice': { do: 'fail', status: 500, message: 'notice desk down' } });
fails('settlement notice dropped', { 'settlement-notice': 'drop' });
scenario('settlement notice a page under 200: taken as answered, and no callback follows', async (S) => { const id = await S.submit('NOTICE-PAGE', { plan: { steps: { 'settlement-notice': 'html' } } }); await S.until(id, REST.onchain); await S.arrived(id, 'settlement-notice', { answered: true }); await S.sleep(300); });
scenario('settlement notice taken and answered 500; the institution\'s callbacks come all the same', async (S) => {
  // The callbacks start half a second later: sent at once they meet the reference while it writes its EXCEPTION (its event numbers collide).
  const id = await S.submit('NOTICE-500-AFTER', { plan: { steps: { 'settlement-notice': { do: 'fail-after', status: 500 } }, callbacks: { delay: 600 } } }); await S.until(id, ['EXCEPTION', undefined]); await S.idle(id); await S.sleep(200);
}, { design13: D.outOfState });
// The institution out of reach at each call: its listener refuses connections for a moment.
scenario('unreachable at the travel rule', async (S) => { await S.close(900); await S.sleep(80); const id = await S.submit('UNREACHABLE-TR'); await S.until(id, REST.exception); await S.reopened(); }, { closes: true, design13: D.unreachable });
scenario('unreachable at the approval', async (S) => { const id = await S.submit('UNREACHABLE-AP', { plan: { steps: { 'travel-rule': { thenClose: 900 } } } }); await S.until(id, REST.exception); await S.reopened(); }, { closes: true, design13: D.unreachable });
scenario('unreachable at the transfer', async (S) => { const id = await S.submit('UNREACHABLE-TX', { plan: { steps: { 'payout-approval': { thenClose: 900 } } } }); await S.until(id, REST.exception); await S.reopened(); }, { closes: true, design13: D.walletUnknown });
scenario('unreachable at the settlement notice', async (S) => { const id = await S.submit('UNREACHABLE-SN', { plan: { steps: { transfer: { thenClose: 900 } } } }); await S.until(id, REST.exception); await S.reopened(); }, { closes: true, design13: D.unreachable });
// No answer within the caller's limit (20 s).
fails('travel rule: no answer for 21 s', { 'travel-rule': { do: 'hold', ms: 21_000, then: 'drop' } }, REST.exception, { slow: true, timeout: 30_000 });
fails('approval: no answer for 21 s', { 'payout-approval': { do: 'hold', ms: 21_000, then: 'drop' } }, REST.exception, { slow: true, timeout: 30_000 });
fails('transfer: no answer for 21 s, and then the wallet moves the funds', { transfer: { do: 'hold', ms: 21_000 } }, REST.exception, { slow: true, timeout: 30_000, design13: D.walletUnknown });
fails('settlement notice: no answer for 21 s', { 'settlement-notice': { do: 'hold', ms: 21_000, then: 'drop' } }, REST.exception, { slow: true, timeout: 30_000 });

// ── run them ────────────────────────────────────────────────────────────────────────────────────────────────────
const chosen = scenarios.filter((sc) => (!only || sc.name.includes(only)) && (slow || !sc.slow));
const out = { tool: 'remit-flows', core: CORE, partner: PARTNER, schema, tag: TAG, platform_key_id_is_of_the_reference_shape: /^STONEHASH-SIGN-[0-9a-f]{8}$/.test(PLATFORM.key_id), jobs_table: hasJobs, scenarios: [] };
let failed = 0;
try {
  // Every organisation first, in the scenarios' order: the registry — which every evidence package lists — is then the same in every scenario of every run.
  for (const sc of chosen) sc.org = await organisation(sc.name, { webhook: sc.webhook !== false });
  const run = async (sc) => {
    const { S, made, answers, sent } = context(sc, sc.org);
    const record = { name: sc.name, design13: sc.design13 ?? null, race: sc.race === true };
    try {
      await sc.fn(S);
    } catch (e) { record.error = String(e.message ?? e); failed++; }
    const ledger = { answers, ...(sc.org.replayIsTheStoredAnswer !== undefined ? { replay_is_the_stored_answer: sc.org.replayIsTheStoredAnswer } : {}), settlements: [] };
    for (const id of made) ledger.settlements.push(await ledgerOf(id, sc.org, sent.get(id)));
    const [hooks] = sc.org.hook ? [await ctl('GET', `/hooks/${sc.org.hook}?summary=1`)] : [null];
    ledger.receiver = hooks ? (hooks.deliveries ?? []).map((d) => ({ answered: d.answered, body: reduce(d.body) })) : 'no webhook address';
    const [subscription] = await rows("SELECT s.status, s.config FROM subscriptions s JOIN institutions i ON i.org_id = s.org_id WHERE i.id = ? AND s.product = 'remit'", [sc.org.bank.id]);
    ledger.subscription = subscription ? { status: subscription.status, config: reduce(parsed(subscription.config)) } : null;
    record[sc.race ? 'observed' : 'ledger'] = ledger;
    console.log(`${record.error ? 'FAIL' : 'ok  '} ${sc.name}${sc.race ? '  (race: written down, not compared)' : ''}\n       ${ledger.settlements.map((s) => `${s.payment?.state} ← ${s.events?.map((e) => e.type).slice(3).join(', ')}`).join('\n       ') || '-'}${record.error ? `\n       ${record.error}` : ''}`);
    return record;
  };
  // Those that make the listener refuse connections first and alone (they would cut what the slow ones hold open); then the slow ones
  // beside everything else: each waits out the caller's 20 seconds on its own payment.
  const done = new Map();
  for (const sc of chosen.filter((x) => x.closes)) done.set(sc, await run(sc));
  const waiting = chosen.filter((x) => x.slow).map((sc) => run(sc).then((r) => done.set(sc, r)));
  for (const sc of chosen.filter((x) => !x.closes && !x.slow)) done.set(sc, await run(sc));
  await Promise.all(waiting);
  out.scenarios = chosen.map((sc) => done.get(sc));
  // An initialisation vector or an ephemeral key used for two ciphertexts is a broken encryption, whatever else is the same.
  out.ciphertexts = { seen: [...jweSeen.iv.values()].reduce((n, s) => n + s.size, 0), initialisation_vectors_used_twice: [...jweSeen.iv.values()].filter((s) => s.size > 1).length, ephemeral_keys_used_twice: [...jweSeen.epk.values()].filter((s) => s.size > 1).length };
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\n${out.scenarios.length} scenarios (${out.scenarios.filter((s) => s.race).length} of them races, written down and not compared), ${failed} did not run as scripted; ${out.ciphertexts.seen} ciphertexts, ${out.ciphertexts.initialisation_vectors_used_twice} initialisation vectors and ${out.ciphertexts.ephemeral_keys_used_twice} ephemeral keys used twice; written: ${outFile}`);
} catch (e) {
  failed++;
  console.error(`the flows could not run: ${e.stack ?? e}`);
} finally {
  await db.end();
}
process.exit(failed === 0 ? 0 : 1);
