/**
 * The settlement rail's part of the seed: organisations, institutions,
 * quotes, settlements in every state, manifests — made on the reference
 * schema by the reference service's own code, to be copied row for row into
 * the second schema by tools/seed-reference.mjs, which calls this.
 *
 *   seedRemit({ db, svc, states, refEnv, devEnv })   before the copy; returns what goes into parity/seed.json as `remit`
 *   afterCopy({ q, REF, DEV, refEnv, devEnv, seeded }) after it: the one thing that differs between the two schemas
 *
 * How the rows are made. Nothing listens and nothing is called over the
 * network. The reference's own route handlers (`registerRemitRoutes`) are
 * called as its router calls them, with the body a request would carry; its
 * `RemitOrchestrator` runs its pipeline; its own partner connector
 * (`TripleAProfileSim`) makes the partner calls — into the partner stand-in
 * (tools/stand-in-partner.mjs) running in this process, through a `fetch`
 * that is replaced for the length of this function. The bank's side is the
 * published SDK (packages/attest-remit). So a settlement's events, webhook
 * rows, travel-rule row, idempotency row, package and anchor record are what
 * the reference writes for that flow, and a settlement "waiting at a step"
 * is one whose flow was stopped there.
 *
 * Time. While this runs the clock is the seed's: finished settlements are
 * made on fixed past days (2026-10-05 … 2026-10-10), so that a day's
 * manifest, a `from`/`to` filter and the batcher's "oldest first" come out
 * the same on every run; what a case is meant to carry on (the write
 * organisation's open questions and settlements in flight) is made three
 * hours before the real time of seeding, because the corridor policy refuses
 * a transfer more than two days after the bank's approval. No row is
 * re-stamped afterwards.
 *
 * What is not the reference's doing is listed in the result under
 * `handMade`: a bare `REQUEST_ACCEPTED` row, an anchor record id that leads
 * nowhere, a manifest without an anchor record, a quote whose stored text is
 * no JSON, a beneficiary institution without an encryption key.
 *
 * By itself (development; only schemas named stonehash_test_remit…):
 *
 *   node apps/core-java/tools/seed-remit.mjs <reference env file> <second env file> [--out <file>]
 *   node apps/core-java/tools/seed-remit.mjs --prepare <env file>      the reference's tables in an empty schema
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto, { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../core/src/config.ts';
import { insertionOrder, openDb } from '../../core/src/db.ts';
import { AttestService, ServiceError } from '../../core/src/service.ts';
import { hashKey } from '../../core/src/auth.ts';
import { createAccount } from '../../core/src/account.ts';
import { HttpError, HttpResult } from '../../core/src/http/server.ts';
import { Registry } from '../../core/src/remit/registry.ts';
import { RemitStore } from '../../core/src/remit/store.ts';
import { RemitOrchestrator } from '../../core/src/remit/orchestrator.ts';
import { WebhookOutbox } from '../../core/src/remit/webhook.ts';
import { TripleAProfileSim } from '../../core/src/remit/partners-client.ts';
import { registerRemitRoutes } from '../../core/src/remit/routes.ts';
import { loadOrCreatePlatformKey, signEvent, spkiFromPublicKey } from '../../core/src/remit/sign.ts';
import { RemitClient } from '../../../packages/attest-remit/src/index.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../../core/src/btc/tx.ts';
import { problems } from './check-test-env.mjs';
import { asFetch, createStandIn, loadPartnerKeys, registrations, KEYS_FILE } from './stand-in-partner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(HERE, '../../../packages/attest-remit/samples');
const sha256hex = (v) => createHash('sha256').update(v).digest('hex');
const turn = () => new Promise((ok) => setImmediate(ok));
/** The address the bank's SDK is given for the platform while the seed runs: answered in this process, by the handlers. */
const CORE = 'http://core.seed.invalid';
/** Settings that shape seeded rows: the two env files have to agree on them. */
const SHARED = ['REMIT_RATE_USD_VND', 'REMIT_RATE_USD_SGD', 'REMIT_FEE_USD', 'REMIT_CHAIN_LABEL', 'REMIT_ACCEPT_DEMO_FINALITY', 'REMIT_PLATFORM_KEY_PATH', 'REMIT_ENABLED'];
const DAY = (n) => Date.UTC(2026, 9, n); // October 2026
const TEN_YEARS = 10 * 365 * 86_400_000;
const PARTIES = {
  debtor: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi Blvd, District 1, Ho Chi Minh City', registration_number: 'VN-0312345678', account: 'VN-ACC-000777' },
  creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-000009', bank: 'DBS (sim)' },
};
const ANSWERS = { purpose: 'Payment for machine parts under purchase order PO-7781', shipping_reference: 'B/L MAEU-2026-118822' };
/** What the reference registers for itself when it starts (apps/core/src/main.ts) — the same row, made before any server is up. */
const PLATFORM_ROW = {
  id: 'STONEHASH', role: 'STONEHASH', name: 'StoneHash (platform)',
  authority: ['REQUEST_ACCEPTED', 'BANK_AUTHORIZATION_VERIFIED', 'TRAVEL_RULE_SENT', 'SETTLEMENT_INSTRUCTED', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'EVIDENCE_ANCHORED', 'webhook'],
};
const BANK_AUTHORITY = ['FIAT_FUNDS_RECEIVED', 'PAYMENT_RELEASE_AUTHORIZED', 'bankInstruction', 'bankApproval', 'commercialDocs'];

/** The reference's own reading of an env file's settings: its `loadConfig`, on those settings. */
function referenceConfig(env) {
  const before = new Map();
  for (const [k, v] of Object.entries(env)) { before.set(k, process.env[k]); process.env[k] = v; }
  try { return loadConfig(); } finally { for (const [k, v] of before) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/** A clock that is the seed's while it is set: each reading one millisecond after the last, unless frozen. */
function seedClock() {
  const Real = Date;
  const c = { now: null, frozen: false, Real };
  const read = () => (c.now === null ? Real.now() : c.frozen ? c.now : (c.now += 1));
  globalThis.Date = class extends Real {
    constructor(...a) { if (a.length === 0) super(read()); else super(...a); }
    static now() { return read(); }
  };
  c.set = (t) => {
    if (c.now !== null && t < c.now) throw new Error(`the seed's clock does not run backwards (${new Real(c.now).toISOString()} → ${new Real(t).toISOString()})`);
    c.now = t;
  };
  c.restore = () => { globalThis.Date = Real; };
  return c;
}

export async function seedRemit({ db, svc, states, refEnv, devEnv }) {
  // ── may this be done at all? ───────────────────────────────────────────────
  const unsafe = [...problems(refEnv).map((p) => `reference env file: ${p}`), ...problems(devEnv).map((p) => `second env file: ${p}`)];
  if (unsafe.length > 0) throw new Error(`refusing to seed the settlement rail — a server started with these files could reach something live:\n  ${unsafe.join('\n  ')}`);
  const differing = SHARED.filter((k) => (refEnv[k] ?? '') !== (devEnv[k] ?? ''));
  if (differing.length > 0) throw new Error(`refusing to seed the settlement rail: the two env files differ in ${differing.join(', ')} — the seeded rows would fit one server only`);
  const cfg = referenceConfig(refEnv);
  if (!cfg.remit.enabled) return { skipped: 'REMIT_ENABLED is off in the reference env file: no rail, no rail rows' };
  if (!refEnv.REMIT_PLATFORM_KEY_PATH || !path.isAbsolute(refEnv.REMIT_PLATFORM_KEY_PATH)) {
    throw new Error('refusing to seed the settlement rail: REMIT_PLATFORM_KEY_PATH must be an absolute path, the same in both env files — the two servers start in different folders, and every seeded platform signature depends on that one key');
  }
  const refBase = cfg.remit.partnersBase.replace(/\/+$/, '');
  const devBase = String(devEnv.REMIT_PARTNERS_BASE).replace(/\/+$/, '');

  // ── the platform's key: the reference's own function, once (an existing file is kept) ──
  const platform = loadOrCreatePlatformKey(cfg.remit.platformKeyPath);
  fs.chmodSync(path.dirname(cfg.remit.platformKeyPath), 0o700);
  fs.chmodSync(cfg.remit.platformKeyPath, 0o600);

  const lines = [];
  const log = (msg, extra) => { lines.push({ msg, ...(extra ?? {}) }); };
  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;
  const clock = seedClock();
  const seededAt = clock.Real.now();
  const iso = (ms) => new clock.Real(ms).toISOString();

  try {
    console.error = (...a) => { lines.push({ msg: a.map(String).join(' ') }); }; // the keyring names the rows it leaves out, at every reconciliation
    clock.set(DAY(1));

    // ── the reference's services, wired as apps/core/src/main.ts wires them ─────
    const registry = new Registry(db);
    const store = new RemitStore(db);
    const outbox = new WebhookOutbox(db, platform, cfg.remit.webhookMaxAttempts, log);
    const connector = new TripleAProfileSim(cfg.remit.partnersBase);
    const orchestrator = new RemitOrchestrator({ store, registry, svc, bfi: connector, wallet: connector, outbox, platform, acceptDemoFinality: cfg.remit.acceptDemoFinality, chainLabel: cfg.remit.chainLabel, log });
    const quoteCfg = { rates: cfg.remit.rates, feeUsd: cfg.remit.feeUsd, ttlMs: cfg.remit.quoteTtlMs, chainLabel: cfg.remit.chainLabel };
    const routes = new Map();
    const collector = { add(method, p, h) { routes.set(`${method} ${p}`, h); return collector; }, get(p, h) { return collector.add('GET', p, h); }, post(p, h) { return collector.add('POST', p, h); } };
    registerRemitRoutes(collector, {
      cfg, db, svc, remit: { store, registry, orchestrator, platform, quoteCfg },
      requireAuth: async (ctx) => { if (!ctx.org) throw new HttpError(401, 'unauthorized', 'the seed did not say which organisation asks'); return ctx.org; },
      requireSession: async () => { throw new HttpError(401, 'unauthorized', 'the seed has no console session'); },
    });
    /** One request to a route of the rail, handled as the router would: the answer's status and body. */
    async function call(route, { org, params = {}, query = '', headers = {}, body } = {}) {
      const handler = routes.get(route);
      if (!handler) throw new Error(`the reference registers no route ${route}`);
      const ctx = { req: { method: route.split(' ')[0], headers }, res: {}, path: route.split(' ')[1], params, query: new URLSearchParams(query), token: undefined, org,
        body: async () => (body === undefined ? {} : JSON.parse(JSON.stringify(body))) };
      try {
        const out = await handler(ctx);
        return out instanceof HttpResult ? { status: out.status, body: out.body } : { status: 200, body: out };
      } catch (e) {
        if (e instanceof ServiceError) return { status: e.status, body: { ...(e.detail ?? {}), error: e.code, message: e.message } };
        if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message } };
        return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : String(e) } };
      }
    }
    const must = async (status, route, args) => {
      const r = await call(route, args);
      if (r.status !== status) throw new Error(`${route}${args?.params?.id ? ` (${args.params.id})` : ''}: expected ${status}, the reference answered ${r.status} ${r.body?.error ?? ''}: ${r.body?.message ?? ''}`);
      return r.body;
    };

    // ── the pipeline: followed, and stopped where a settlement is to wait ───────
    const pipelines = new Map();
    const stops = new Map();
    const own = { advance: orchestrator.advance.bind(orchestrator), approvalLeg: orchestrator.approvalLeg.bind(orchestrator), transferLeg: orchestrator.transferLeg.bind(orchestrator) };
    orchestrator.advance = (id) => {
      const run = stops.get(id) === 'authorized' ? Promise.resolve() : own.advance(id);
      pipelines.set(id, [...(pipelines.get(id) ?? []), run]);
      return run;
    };
    orchestrator.approvalLeg = (p) => (stops.get(p.id) === 'received' ? Promise.resolve() : own.approvalLeg(p));
    orchestrator.transferLeg = (p) => (stops.get(p.id) === 'pre-approved' ? Promise.resolve() : own.transferLeg(p));

    // ── the partner, in this process ───────────────────────────────────────────
    const keys = loadPartnerKeys(KEYS_FILE);
    const K = keys.institutions;
    const partner = createStandIn({ name: 'seed', core: null, keys, platformSpki: platform.publicSpkiBase64,
      deliver: async (text) => call('POST /v1/remit/callbacks', { body: JSON.parse(text) }) });
    const toPartner = asFetch(partner, refBase);
    const apiKeys = new Map(); // secret → organisation id, for the SDK's own two requests
    globalThis.fetch = async (input, init = {}) => {
      const address = String(input);
      if (address.startsWith(`${refBase}/`)) return toPartner(address, init);
      if (address === `${CORE}/v1/remit/meta`) return Response.json(await must(200, 'GET /v1/remit/meta'));
      if (address === `${CORE}/v1/quotes` && init.method === 'POST') {
        const r = await call('POST /v1/quotes', { org: apiKeys.get(String(init.headers?.authorization ?? '').replace(/^Bearer /, '')), body: JSON.parse(init.body) });
        return Response.json(r.body, { status: r.status });
      }
      throw new TypeError(`fetch failed (the seed reaches nothing but its own partner stand-in and handlers: ${address.split('?')[0]})`);
    };
    /** Waits until nothing moves for this settlement any more — or, where its flow is held in a partner call, until that call has arrived. */
    async function rest(id, heldAt) {
      await turn(); await turn();
      if (heldAt) {
        if (!(await partner.waitFor({ dir: 'in', payment_id: id, step: heldAt }, 1, 5000))) throw new Error(`${id}: the ${heldAt} call it was to wait in never came`);
        await turn();
        return;
      }
      for (let quiet = 0; quiet < 3;) {
        const runs = pipelines.get(id) ?? [];
        await Promise.all(runs);
        const busy = partner.running(id) > 0;
        await partner.idle(id);
        await turn();
        quiet = !busy && (pipelines.get(id) ?? []).length === runs.length && partner.running(id) === 0 ? quiet + 1 : 0;
      }
    }

    // ── institutions: the platform's own, then the partner's, as their set-up registers them ──
    await registry.upsert({ ...PLATFORM_ROW, signing_spki: platform.publicSpkiBase64 });
    for (const { body } of registrations(keys)) await must(201, 'POST /v1/remit/registry/institutions', { headers: { 'x-admin-token': cfg.remit.adminToken }, body });
    const extra = { noEnc: 'SG-BFI-NOENC' };
    // A beneficiary institution nobody can encrypt to (502 bfi_has_no_encryption_key); its signing key is one nobody holds.
    await registry.upsert({ id: extra.noEnc, role: 'BENEFICIARY_FI', name: 'Beneficiary FI without an encryption key', country: 'SG',
      signing_spki: spkiFromPublicKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey), authority: ['PAYOUT_ACCEPTED'] });
    // Not seeded, on purpose: an institution whose key does not convert (the sign-up placeholder, a brainpool key). The
    // reference's keyring leaves such a row out, but every package lists it — and the bank SDK's verifyEvidencePackage builds
    // its keyring from that list and then fails for every package of every tenant. A case that wants the row registers it
    // itself, through the operator's route, and takes it out again.

    // ── organisations ──────────────────────────────────────────────────────────
    const secretOf = (word) => `sk_test_${createHash('sha256').update(`parity remit key ${word}`).digest().subarray(0, 24).toString('base64url')}`;
    const O = {};
    /** An organisation as a sign-up and an activation leave it: document anchoring, a key, and — where `bank` is given — a collection bank whose key this run holds. */
    async function organisation(name, slug, title, { bank = null, hook = null, remit = true, keyless = false } = {}) {
      const id = await svc.ensureOrg(slug, title);
      const secret = secretOf(name);
      await db.prepare('INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), id, hashKey(secret), 'sk_test_', `rail-${name}`, new Date().toISOString(), null);
      await db.prepare("INSERT IGNORE INTO subscriptions (id, org_id, product, plan, status, config, created_at) VALUES (?, ?, 'attest', 'sandbox', 'active', '{}', ?)").run(randomUUID(), id, new Date().toISOString());
      const o = { name, id, slug, key: secret, bank: null, hook: hook ? { name: hook, reference: `${refBase}/hooks/${hook}`, second: `${devBase}/hooks/${hook}` } : null };
      if (bank) {
        const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        o.bank = { ...bank, key: pair.privateKey, pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), spki: spkiFromPublicKey(pair.publicKey) };
        if (!keyless) await svc.registerIssuerKey(id, o.bank.spki, 'bank-signing-key');
        await registry.upsert({ id: bank.id, role: 'COLLECTION_BANK', name: bank.name, country: bank.country, org_id: id, ...(keyless ? {} : { signing_spki: o.bank.spki }), authority: BANK_AUTHORITY });
      }
      if (remit) await registry.subscribe(id, 'remit', { ...(bank ? { institution_id: bank.id } : {}), ...(o.hook ? { webhook_url: o.hook.reference } : {}) });
      apiKeys.set(secret, id);
      O[name] = o;
      return o;
    }
    await organisation('rail', 'parity-remit', 'Rail Parity', { bank: { id: 'VN-BANK-RAIL', name: 'Rail Collection Bank', country: 'VN' }, hook: 'rail' });
    await organisation('read', 'parity-remit-read', 'Rail Parity (read only)', { bank: { id: 'VN-BANK-READ', name: 'Read-only Collection Bank', country: 'VN' }, hook: 'read' });
    await organisation('b', 'parity-remit-b', 'Another Rail Organisation', { bank: { id: 'VN-BANK-RAILB', name: 'Another Collection Bank', country: 'VN' } });
    await organisation('nohook', 'parity-remit-nohook', 'Rail Without A Webhook', { bank: { id: 'VN-BANK-NOHOOK', name: 'Collection Bank Without A Webhook', country: 'VN' } });
    // Switched off at the very end of the seed, after a settlement of its own was made: a webhook address is read for a
    // settlement's events also when the subscription has been switched off since.
    await organisation('off', 'parity-remit-off', 'Rail Switched Off', { bank: { id: 'VN-BANK-OFF', name: 'Collection Bank Switched Off', country: 'VN' }, hook: 'off' });
    await organisation('nosub', 'parity-remit-nosub', 'No Rail Subscription', { remit: false });
    await organisation('nobank', 'parity-remit-nobank', 'Rail Without A Bank');
    await organisation('nokey', 'parity-remit-nokey', 'Rail With A Keyless Bank', { bank: { id: 'VN-BANK-NOKEY', name: 'Collection Bank Without A Key', country: 'VN' }, keyless: true });
    // An organisation with an account, subscribed to all three products: what the operator's deactivate route is asked about.
    await organisation('deact', 'parity-remit-deact', 'Rail To Be Deactivated', { bank: { id: 'VN-BANK-DEACT', name: 'Collection Bank To Be Deactivated', country: 'VN' }, hook: 'deact' });
    // A quote that has long expired by the time anybody reads it: made now, on the seed's first day, with the env file's lifetime.
    const expiredQuote = await quoting('expired rail', false, () => must(201, 'POST /v1/quotes', { org: O.rail.id,
      body: { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount: '1200.00' }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } } }));
    const deactAccount = { email: 'ops@parity-remit-deact.example', password: 'deactivate me from the operator route' };
    await createAccount(db, deactAccount.email, deactAccount.password, O.deact.id);
    await registry.upsert({ id: 'KR-EX-DEACT', role: 'EXCHANGE', name: 'Exchange To Be Deactivated', country: 'KR', org_id: O.deact.id, signing_spki: O.deact.bank.spki, authority: ['POR_SNAPSHOT'] });
    await registry.subscribe(O.deact.id, 'por', { institution_id: 'KR-EX-DEACT' });

    // ── what the bank does ─────────────────────────────────────────────────────
    const clients = new Map();
    const clientOf = (o) => { if (!clients.has(o.name)) clients.set(o.name, new RemitClient({ core: CORE, apiKey: o.key, institutionId: o.bank.id, institutionName: o.bank.name, key: o.bank.key })); return clients.get(o.name); };
    const bankSig = (o, payload) => signEvent(payload, o.bank.key, o.bank.id, o.bank.name);
    /**
     * Runs `fn` — one request for a quote — with the quote's id made a function of `label`: the handler draws its id
     * at random, and for this one call the draw is fixed, so that a seeded quote has the same id on every run.
     * `long` makes it a quote that outlives a comparison run (ten years instead of the env file's lifetime).
     */
    async function quoting(label, long, fn) {
      const h = sha256hex(`parity remit quote\n${label}`);
      const fixed = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const realUuid = crypto.randomUUID;
      const ttl = quoteCfg.ttlMs;
      crypto.randomUUID = () => fixed; syncBuiltinESMExports();
      if (long) quoteCfg.ttlMs = TEN_YEARS;
      try { return await fn(); } finally { crypto.randomUUID = realUuid; syncBuiltinESMExports(); quoteCfg.ttlMs = ttl; }
    }
    /** A quote from the reference's handler. */
    const quoteFor = (o, amount, label, { long = false } = {}) => quoting(label, long, () => must(201, 'POST /v1/quotes', { org: o.id,
      body: { corridor: { origin: 'VN', destination: 'SG' }, trade: { currency: 'USD', amount }, collect: { currency: 'VND' }, payout: { currency: 'SGD' } } }));
    const cancel = (o, id, reason) => must(200, 'POST /v1/settlements/:id/cancel', { org: o.id, params: { id },
      body: reason === undefined ? { sig: bankSig(o, { payment_id: id, reason: 'cancelled by instructing bank' }) } : { reason, sig: bankSig(o, { payment_id: id, reason }) } });
    const answer = async (o, id, answers = ANSWERS) => {
      const r = await must(200, 'POST /v1/settlements/:id/rfi-response', { org: o.id, params: { id }, body: { answers, sig: bankSig(o, { payment_id: id, answers }) } });
      await rest(id);
      return r;
    };

    // ── one settlement ─────────────────────────────────────────────────────────
    const made = []; // every settlement of the seed, in the order made
    const search = []; // the references a ledger search can find a settlement by
    const handMade = [];
    /**
     * One settlement, from quote to wherever its flow comes to rest.
     *   org, name, id, at (the seed clock at its start), amount, mode ('A' | 'B'), bfi ('bfi' | 'bfi2'), long (a quote that outlives a comparison run),
     *   plan (the partner's script for it), stop ('authorized' | 'received' | 'pre-approved': the pipeline is cut there), heldAt (the partner
     *   call its flow stays in), then (what follows: callbacks, a cancel, an answer), expect (the state it must rest in),
     *   debtor / creditor / instructionRef / invoiceRef / source (what the bank signs), prepared (an instruction made elsewhere)
     */
    async function settlement(spec) {
      const o = spec.org;
      if (spec.at !== undefined) clock.set(spec.at);
      let { id } = spec;
      let quote; let body;
      if (spec.prepared) ({ paymentId: id, quote, body } = spec.prepared);
      else {
        quote = await quoteFor(o, spec.amount ?? '1200.00', `settlement ${id}`, { long: spec.long });
        const parties = { debtor: { ...PARTIES.debtor, ...(spec.debtor ?? {}) }, creditor: { ...PARTIES.creditor, ...(spec.creditor ?? {}) } };
        const opts = { paymentId: id, beneficiaryInstitution: K[spec.bfi ?? 'bfi'].id, invoiceRef: spec.invoiceRef ?? `INV-${id}`,
          ...(spec.instructionRef !== undefined ? { instructionRef: spec.instructionRef } : {}), ...(spec.source ? { source: spec.source } : {}), ...(spec.mode === 'B' ? { travelRule: 'B' } : {}) };
        body = spec.mode === 'B' ? (await clientOf(o).buildInstructionAsync(quote, parties, opts)).body : clientOf(o).buildInstruction(quote, parties, opts).body;
      }
      if (spec.plan) partner.plan({ payment_id: id, ...spec.plan });
      if (spec.stop) stops.set(id, spec.stop);
      const accepted = await call('POST /v1/settlements', { org: o.id, headers: { 'idempotency-key': spec.idempotencyKey ?? `${spec.prepared ? 'swift' : 'sdk'}-${id}` }, body });
      if (accepted.status !== 202) throw new Error(`${spec.name} (${id}): not accepted — ${accepted.status} ${accepted.body?.error}: ${accepted.body?.message}`);
      await rest(id, spec.heldAt);
      const cb = async (what) => {
        const r = await partner.callback({ payment_id: id, ...(typeof what === 'string' ? { type: what } : what) });
        if (r.answer.status !== 200) throw new Error(`${spec.name} (${id}): the callback ${r.sent.type} was answered ${r.answer.status} ${r.answer.body?.error ?? r.answer.error}: ${r.answer.body?.message ?? ''}`);
        return r;
      };
      if (spec.then) { await spec.then({ id, o, cb, quote, body }); if (!spec.heldAt) await rest(id); }
      const p = await store.get(id);
      if (spec.expect && p.state !== spec.expect) {
        const last = (await store.events(id)).at(-1);
        throw new Error(`${spec.name} (${id}): expected to rest in ${spec.expect}, is ${p.state} (last event ${last?.type}: ${String(last?.payload).slice(0, 300)})`);
      }
      made.push({ org: o.name, name: spec.name, id, mode: spec.mode ?? 'A', amount: quote.trade.amount, quote_id: quote.quote_id, group: spec.group ?? null, note: spec.note ?? null, from_message: Boolean(spec.prepared || spec.source) });
      if (spec.instructionRef !== undefined) search.push({ payment_id: id, org: o.name, where: 'bank_authorization.instruction_ref', value: spec.instructionRef });
      const src = spec.source ?? body.evidence_elements?.bankInstruction?.sourceMessage;
      if (src) for (const k of ['uetr', 'instructionId', 'endToEndId', 'messageId']) if (src[k]) search.push({ payment_id: id, org: o.name, where: `bankInstruction.sourceMessage.${k}`, value: src[k] });
      return { id, quote, body };
    }
    let slotAt = 0;
    const slots = (from, stepMs) => { slotAt = from; return () => { const t = slotAt; slotAt += stepMs; return t; }; };

    // ── anchor records: sealed, sent and confirmed by the reference's own batcher ──
    const order = insertionOrder(db);
    /** Seals what `o` has waiting. The batcher takes the organisation of the oldest waiting record: it has to be this one. */
    async function seal(o) {
      const head = await db.prepare(`SELECT org_id FROM attestations WHERE batch_id IS NULL ORDER BY created_at ASC, ${order} ASC LIMIT 1`).get();
      if (head?.org_id !== o.id) throw new Error(`the batcher would not take ${o.slug} first: an older record of another organisation waits — the rail's seed must not seal that`);
      return svc.sealBatch();
    }
    let height = 10_200;
    const confirmBatch = async (batchId) => {
      const txid = await svc.anchorBatch(batchId);
      height += 1;
      states.set(txid, { status: 'confirmed', blockHeight: height, blockHash: sha256hex(`block ${height}`), confirmations: 6 });
      await svc.refreshConfirmations();
      return txid;
    };

    // ════ day 1 (2026-10-05): finished and anchored ════════════════════════════
    let next = slots(DAY(5) + 8 * 3_600_000, 240_000);
    const R = (name, spec) => settlement({ org: O.read, name, id: `PAY-SEED-${name.toUpperCase()}`, at: next(), ...spec });
    const done = { expect: 'BENEFICIARY_CREDIT_CONFIRMED' };
    await R('anchored-a', { ...done });
    await R('anchored-b', { ...done, mode: 'B', amount: '1350.50' });
    await R('anchored-l2', { ...done, amount: '980.02', note: 'completed at L2: no bank reference' });
    await R('anchored-rfi', { ...done, amount: '25000.00', then: ({ id, o }) => answer(o, id), note: 'a question was asked and answered' });
    await R('anchored-bfi2', { ...done, amount: '777.00', bfi: 'bfi2', note: 'the second beneficiary institution' });
    // Made from a SWIFT message, by the SDK: the message's own references are signed into the instruction.
    const swift = async (o, file, { supplement, paymentId, edit, long = false } = {}) => {
      const text = edit ? edit(fs.readFileSync(path.join(SAMPLES, file), 'utf8')) : fs.readFileSync(path.join(SAMPLES, file));
      const built = await quoting(`from ${file}${paymentId ? ` as ${paymentId}` : ''}`, long, () => clientOf(o).instructionFromSwift(text,
        { beneficiaryInstitution: K.bfi.id, ...(supplement ? { supplement } : {}), ...(paymentId ? { paymentId } : {}) }));
      return { paymentId: built.paymentId, quote: built.quote, body: built.body, source: built.mapping.input.source };
    };
    const master = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'parties.sample.json'), 'utf8'));
    const fromMaster = (payment) => master[payment.debtor?.account ?? ''] ?? undefined;
    clock.set(next());
    const pacs008 = await swift(O.read, 'pacs008.sample.xml');
    await settlement({ org: O.read, name: 'anchored-swift', prepared: pacs008, ...done, note: 'made from pacs008.sample.xml (a UETR)' });
    await settlement({ org: O.rail, name: 'terminal-anchored', id: 'PAY-RAIL-ANCHORED', at: next(), ...done, group: 'terminal' });
    await settlement({ org: O.nohook, name: 'anchored', id: 'PAY-NOHOOK-ANCHORED', at: next(), ...done });
    await settlement({ org: O.b, name: 'anchored', id: 'PAY-OTHER-ANCHORED', at: next(), ...done });

    // The day's manifest of the read organisation: everything it instructed that day, and nothing else.
    const manifests = {};
    const manifest = async (o, day, ids, extraIds = []) => {
      const date = iso(day).slice(0, 10);
      const m = { date, institution_id: o.bank.id, payment_ids: [...ids, ...extraIds], count: ids.length + extraIds.length };
      const r = await must(201, 'POST /v1/manifests/daily', { org: o.id, body: { manifest: m, sig: bankSig(o, m) } });
      manifests[date] = { org: o.name, status: r.verdict.status, payment_ids: m.payment_ids, missing_in_manifest: r.verdict.missing_in_manifest, unknown_to_platform: r.verdict.unknown_to_platform, attestation_id: r.attestation_id };
      return r;
    };
    const idsOfDay = async (o, day) => (await db.prepare('SELECT id FROM remit_payments WHERE org_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at').all(o.id, iso(day).slice(0, 10))).map((r) => r.id);
    clock.set(DAY(5) + 23 * 3_600_000);
    await manifest(O.read, DAY(5), await idsOfDay(O.read, DAY(5)));
    for (const o of [O.read, O.rail, O.nohook, O.b]) await confirmBatch(await seal(o));
    const promoted = await orchestrator.promoteAnchored();
    if (promoted !== 9) throw new Error(`the reference promoted ${promoted} settlements to EVIDENCE_ANCHORED, 9 were made for it`);

    // ════ day 2 (2026-10-06): credited, in each state its anchor record can be in ══
    next = slots(DAY(6) + 8 * 3_600_000, 240_000);
    await R('confirmed-anchor-confirmed', { ...done, note: 'its anchor record is confirmed; the worker has not promoted it yet' });
    await R('confirmed-anchor-confirmed-b', { ...done, mode: 'B', amount: '2100.00' });
    await settlement({ org: O.rail, name: 'confirmed-0', id: 'PAY-RAIL-CONFIRMED-0', at: next(), ...done, group: 'confirmed', note: 'anchor record confirmed: a worker promotes it' });
    await settlement({ org: O.rail, name: 'confirmed-1', id: 'PAY-RAIL-CONFIRMED-1', at: next(), ...done, group: 'confirmed', mode: 'B' });
    for (const o of [O.read, O.rail]) await confirmBatch(await seal(o));
    await R('confirmed-anchor-submitted', { ...done, amount: '1500.00' });
    await svc.anchorBatch(await seal(O.read));
    await R('confirmed-anchor-batched', { ...done, amount: '1600.00' });
    await seal(O.read);
    await R('confirmed-anchor-accepted', { ...done, amount: '1700.00' });
    // Credited, and the package could not be made: for the length of this one flow a registry row states a fraction, which has
    // no canonical form. The reference logs it and leaves the settlement confirmed without a package (orchestrator.ts, "evidence packaging failed").
    const authorityBefore = (await db.prepare('SELECT authority FROM institutions WHERE id = ?').get(extra.noEnc)).authority;
    await db.prepare('UPDATE institutions SET authority = ? WHERE id = ?').run('[0.5]', extra.noEnc);
    try {
      await R('confirmed-no-package', { ...done, amount: '1800.00', note: 'credited; packaging failed (a fraction in the registry), so no package and no anchor record' });
    } finally { await db.prepare('UPDATE institutions SET authority = ? WHERE id = ?').run(authorityBefore, extra.noEnc); }
    if (!lines.some((l) => l.msg === 'evidence packaging failed')) throw new Error('the packaging failure that confirmed-no-package was made for did not happen');
    const lost = await R('confirmed-anchor-unknown', { ...done, amount: '1900.00', note: 'its anchor record id leads nowhere (written by hand)' });
    await db.prepare('UPDATE remit_payments SET attestation_id = ? WHERE id = ?').run('00000000-0000-4000-8000-00000000dead', lost.id);
    handMade.push({ what: 'remit_payments.attestation_id of PAY-SEED-CONFIRMED-ANCHOR-UNKNOWN', why: 'an anchor record id that leads nowhere: the ledger answers status "unknown", the view attestation null, the evidence route 404 not_found' });
    clock.set(DAY(6) + 23 * 3_600_000);
    { // The day's manifest, one settlement left out and one named that the platform never saw.
      const ids = await idsOfDay(O.read, DAY(6));
      await manifest(O.read, DAY(6), ids.slice(0, -1), ['PAY-NEVER-SEEN-BY-THE-PLATFORM']);
    }

    // ════ day 3 (2026-10-07): ended otherwise ══════════════════════════════════
    next = slots(DAY(7) + 8 * 3_600_000, 240_000);
    const cancelled = { expect: 'CANCELLED' }; const exception = { expect: 'EXCEPTION' };
    await R('cancelled-sanctioned', { ...cancelled, creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' }, note: 'travel rule rejected, with the partner\'s reason' });
    await R('cancelled-rejected-bare', { ...cancelled, plan: { steps: { 'travel-rule': { do: 'reject' } } }, note: 'travel rule rejected, no reason given' });
    await R('cancelled-after-rfi', { ...cancelled, amount: '26000.00', then: ({ id, o }) => answer(o, id, { purpose: ' ', shipping_reference: '' }), note: 'the answers were empty: rejected after the question' });
    await R('cancelled-after-rfi-bare', { ...cancelled, amount: '26500.00', plan: { steps: { 'travel-rule-response': { do: 'reject' } } }, then: ({ id, o }) => answer(o, id), note: 'rejected after the question, no reason given' });
    await R('cancelled-by-bank-rfi', { ...cancelled, amount: '27000.00', then: ({ id, o }) => cancel(o, id, 'the importer withdrew the order'), note: 'the bank cancelled while a question was open' });
    await R('cancelled-by-bank-authorized', { ...cancelled, stop: 'authorized', then: ({ id, o }) => cancel(o, id), note: 'cancelled before the travel rule went out; the default reason; the party data is still in request_body' });
    await R('cancelled-by-bank-in-call', { ...cancelled, plan: { steps: { 'travel-rule': { do: 'hold' } } }, heldAt: 'travel-rule', then: ({ id, o }) => cancel(o, id, 'cancelled while the travel rule was on its way'), note: 'cancelled while the travel-rule call was unanswered' });
    await R('returned-after-failure', { expect: 'RETURNED', amount: '1000.13', note: 'the payout failed and the USDC came back' });
    await R('returned-bare', { expect: 'RETURNED', plan: { callbacks: 'manual' }, then: async ({ cb }) => { await cb('USDC_RECEIVED'); await cb('USDC_RETURNED'); }, note: 'returned with no failure reported before' });
    await R('exception-reconciliation', { ...exception, plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', element: { with: { amount: '9999.99' } } }] } }, note: 'the receipt states another amount' });
    await R('exception-l1-then-signed', { ...exception, plan: { callbacks: { sequence: ['USDC_RECEIVED', 'PAYOUT_SUBMITTED', { type: 'PAYOUT_COMPLETED', level: 'L1' }, { type: 'PAYOUT_COMPLETED', level: 'L3' }] } },
      note: 'L1 first, then a signed completion: the reference reconciles with the first receipt (design 13)' });
    await R('exception-travel-rule-refused', { ...exception, plan: { steps: { 'travel-rule': { do: 'refuse', status: 422, message: 'the receiving institution does not take this corridor today' } } } });
    await R('exception-travel-rule-unreachable', { ...exception, plan: { steps: { 'travel-rule': 'drop' } }, note: 'no answer: the reference\'s "not reachable" sentence, which quotes its partner address' });
    await R('exception-travel-rule-page', { ...exception, plan: { steps: { 'travel-rule': 'html' } }, note: 'a page of HTML under 200' });
    await R('exception-approval-refused', { ...exception, plan: { steps: { 'payout-approval': { do: 'refuse', status: 409, message: 'no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)' } } } });
    await R('exception-approval-stranger', { ...exception, plan: { steps: { 'payout-approval': { signedBy: 'stranger' } } }, note: 'the approval is signed by a key nobody registered' });
    await R('exception-approval-other-amount', { ...exception, plan: { steps: { 'payout-approval': { with: { usdc_amount: '1.00' } } } }, note: 'the approval does not restate the amount' });
    await R('exception-transfer-refused', { ...exception, plan: { steps: { transfer: { do: 'refuse', status: 403, message: 'per-payment cap exceeded (sandbox: 50,000 mUSDC)' } } } });
    await R('exception-transfer-failed-after', { ...exception, plan: { steps: { transfer: { do: 'fail-after', status: 500 } } }, note: 'the wallet moved the funds and answered 500' });
    await R('exception-transfer-other-payment', { ...exception, plan: { steps: { transfer: { with: { payment_id: 'PAY-SOMEBODY-ELSES' } } } }, note: 'the wallet\'s result names another payment' });
    await R('exception-notice-refused', { ...exception, plan: { steps: { 'settlement-notice': { do: 'refuse', status: 404, message: 'unknown payment' } } }, note: 'on chain, and the notice was refused' });
    await settlement({ org: O.rail, name: 'terminal-cancelled', id: 'PAY-RAIL-CANCELLED', at: next(), ...cancelled, group: 'terminal', creditor: { name: 'Pacific Supply Pte Ltd (SANCTIONED TEST)' } });
    await settlement({ org: O.rail, name: 'terminal-returned', id: 'PAY-RAIL-RETURNED', at: next(), expect: 'RETURNED', group: 'terminal', amount: '1000.13' });
    await settlement({ org: O.rail, name: 'terminal-exception', id: 'PAY-RAIL-EXCEPTION', at: next(), ...exception, group: 'terminal', plan: { steps: { 'payout-approval': { do: 'fail', status: 503, message: 'the stand-in is down for maintenance' } } } });
    { // A manifest from before manifests were anchored: the route's row, its anchor record taken off by hand.
      clock.set(DAY(7) + 23 * 3_600_000);
      const date = iso(DAY(7)).slice(0, 10);
      await manifest(O.read, DAY(7), await idsOfDay(O.read, DAY(7)));
      await db.prepare('UPDATE remit_manifests SET attestation_id = NULL WHERE org_id = ? AND date = ?').run(O.read.id, date);
      manifests[date].attestation_id = null;
      handMade.push({ what: `remit_manifests.attestation_id of ${date} (read organisation)`, why: 'a manifest without an anchor record: the list answers attestation null' });
    }

    // ════ day 4 (2026-10-08): waiting, at every place a settlement can wait ═════
    next = slots(DAY(8) + 8 * 3_600_000, 180_000);
    /** A row as an acceptance that died half-way left it before acceptance was one transaction: the settlement, and no event. */
    async function bareRow(o, name, id, at) {
      clock.set(at);
      const quote = await quoteFor(o, '1200.00', `settlement ${id}`);
      const { compliance_payload: plaintext, ...kept } = clientOf(o).buildInstruction(quote, PARTIES, { paymentId: id, invoiceRef: `INV-${id}` }).body;
      await store.create({ id, org_id: o.id, quote_id: quote.quote_id, corridor_origin: quote.corridor.origin, corridor_destination: quote.corridor.destination,
        trade_currency: quote.trade.currency, trade_amount: quote.trade.amount, collect_currency: quote.collect.currency, collect_amount: quote.collect.amount, usdc_amount: quote.settlement.amount,
        payout_currency: quote.payout.currency, payout_amount: quote.payout.amount, beneficiary_institution: K.bfi.id, request_body: JSON.stringify({ ...kept, compliance_plaintext: plaintext }) });
      made.push({ org: o.name, name, id, mode: 'A', amount: quote.trade.amount, quote_id: quote.quote_id, group: null, note: 'a bare row: REQUEST_ACCEPTED and no event (written through the store, not through acceptance)', from_message: false });
      handMade.push({ what: `remit_payments ${id}`, why: 'REQUEST_ACCEPTED with no event: acceptance has been one transaction since 2026-11-18 and leaves none; the state is still cancellable' });
      return id;
    }
    await bareRow(O.read, 'waiting-accepted', 'PAY-SEED-WAITING-ACCEPTED', next());
    await cancel(O.read, await bareRow(O.read, 'cancelled-by-bank-accepted', 'PAY-SEED-CANCELLED-BY-BANK-ACCEPTED', next()), 'cancelled before anything was verified');
    await R('waiting-authorized', { expect: 'BANK_AUTHORIZED', stop: 'authorized', note: 'accepted; the pipeline never started (the party data is still in request_body)' });
    await R('waiting-travel-rule', { expect: 'TRAVEL_RULE_PENDING', plan: { steps: { 'travel-rule': { do: 'hold' } } }, heldAt: 'travel-rule', note: 'travel rule sent, nothing back' });
    await R('waiting-rfi', { expect: 'TRAVEL_RULE_PENDING', amount: '25000.00', note: 'a question is open' });
    await R('waiting-rfi-b', { expect: 'TRAVEL_RULE_PENDING', amount: '31000.00', mode: 'B' });
    await R('waiting-rfi-bare', { expect: 'TRAVEL_RULE_PENDING', plan: { steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment' } } }, note: 'a question given as a bare reason: the reference makes the id' });
    await R('waiting-approval', { expect: 'TRAVEL_RULE_PENDING', stop: 'received', note: 'travel rule accepted; no approval asked for yet' });
    await R('waiting-approval-after-rfi', { expect: 'TRAVEL_RULE_PENDING', stop: 'received', amount: '28000.00', then: ({ id, o }) => answer(o, id), note: 'question answered and accepted; no approval yet' });
    await R('waiting-transfer', { expect: 'PAYOUT_PRE_APPROVED', stop: 'pre-approved', note: 'pre-approved; no instruction yet' });
    await R('waiting-wallet', { expect: 'PAYOUT_PRE_APPROVED', plan: { steps: { transfer: { do: 'hold' } } }, heldAt: 'transfer', note: 'instructed; the wallet has not answered' });
    // On chain, the callbacks still to come: one for each thing the chain node can say about the transfer.
    const chainKinds = [['confirmed', null], ['confirmedNoLog', null], ['confirmedOtherLog', null], ['confirmedZero', null], ['confirmedNoStatus', null], ['confirmedNoBlock', null], ['confirmedAhead', null],
      ['confirmedSecond', null], ['confirmedUpper', null], ['failed', null], ['failedWithLog', null], ['pool', null], ['noReceipt', null], ['unknown', null],
      ['confirmed', { at: 'tx', how: 'error' }], ['confirmed', { at: 'tx', how: 'empty' }], ['confirmed', { at: 'receipt', how: 'http500' }], ['confirmed', { at: 'receipt', how: 'empty' }],
      ['confirmed', { at: 'block', how: 'page' }], ['confirmed', { at: 'block', how: 'empty' }], ['confirmed', { at: 'head', how: 'error' }], ['confirmed', { at: 'head', how: 'empty' }],
      ['noReceipt', { at: 'head', how: 'gateway' }], ['confirmed', { at: 'tx', how: 'cut' }], ['confirmed', { at: 'receipt', how: 'nothing' }], ['confirmed', { at: 'tx', how: 'slow' }]];
    const chain = {};
    for (const [kind, fault] of chainKinds) {
      const name = `onchain-${kind.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}${fault ? `-${fault.at}-${fault.how}` : ''}`;
      const { id } = await R(name, { expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { steps: { transfer: { tx: { kind, fault } } }, callbacks: 'manual' } });
      chain[`${kind}${fault ? `/${fault.at}/${fault.how}` : ''}`] = id;
    }
    chain['not a hash'] = (await R('onchain-not-a-hash', { expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { steps: { transfer: { with: { tx_hash: 'mock-transfer-0001' } } }, callbacks: 'manual' }, note: 'chain_tx is no transaction hash' })).id;
    await R('in-progress', { expect: 'PAYOUT_IN_PROGRESS', plan: { callbacks: 'manual' }, then: ({ cb }) => cb('USDC_RECEIVED') });
    await R('in-progress-submitted', { expect: 'PAYOUT_IN_PROGRESS', plan: { callbacks: 'manual' }, then: async ({ cb }) => { await cb('USDC_RECEIVED'); await cb('PAYOUT_SUBMITTED'); } });
    await R('in-progress-failed', { expect: 'PAYOUT_IN_PROGRESS', plan: { callbacks: 'manual' }, then: async ({ cb }) => { await cb('USDC_RECEIVED'); await cb('PAYOUT_SUBMITTED'); await cb('PAYOUT_FAILED'); }, note: 'the payout failed; the return has not come' });
    await R('l1-hold', { expect: 'PAYOUT_IN_PROGRESS', amount: '1000.01', note: 'completed at L1: not confirmed, waiting for better evidence' });
    await R('l1-hold-b', { expect: 'PAYOUT_IN_PROGRESS', amount: '2000.01', mode: 'B' });
    await settlement({ org: O.b, name: 'waiting-rfi', id: 'PAY-OTHER-WAITING-RFI', at: next(), expect: 'TRAVEL_RULE_PENDING', amount: '25000.00' });
    // Made from messages: one known by its identifiers alone, recognised again in another rendering — which brings a UETR along.
    clock.set(next());
    const pain001 = await swift(O.read, 'pain001.sample.xml');
    await settlement({ org: O.read, name: 'swift-pain001', prepared: pain001, expect: 'ONCHAIN_SETTLED', group: 'swift', plan: { callbacks: 'manual' }, note: 'made from pain001.sample.xml (no UETR)' });
    const source = { 'pacs008.sample.xml': { payment_id: pacs008.paymentId, source: pacs008.source }, 'pain001.sample.xml': { payment_id: pain001.paymentId, source: pain001.source } };
    { // The same instruction written out again — a new creation time, a UETR — under an id of its own: refused, recognised, and the UETR handed over.
      clock.set(next());
      const uetr = '7d4c2b1a-9e8f-4a6b-8c3d-5e1f0a9b8c7d';
      const again = await swift(O.read, 'pain001.sample.xml', { paymentId: 'PAY-SEED-SWIFT-TWIN-REFUSED',
        edit: (xml) => xml.replace(/<CreDtTm>[^<]*<\/CreDtTm>/, '<CreDtTm>2026-11-18T10:15:00+07:00</CreDtTm>').replace('</EndToEndId>', `</EndToEndId>\n          <UETR>${uetr}</UETR>`) });
      const refused = await call('POST /v1/settlements', { org: O.read.id, headers: { 'idempotency-key': `swift-${again.paymentId}` }, body: again.body });
      if (refused.status !== 409 || refused.body.error !== 'duplicate_source_message' || refused.body.ground !== 'twin' || refused.body.existing_payment_id !== pain001.paymentId) {
        throw new Error(`the second rendering of pain001.sample.xml was to be recognised as ${pain001.paymentId}: ${refused.status} ${JSON.stringify(refused.body).slice(0, 300)}`);
      }
      source.twin = { of: pain001.paymentId, refused_payment_id: again.paymentId, source: again.source, inherited_uetr: uetr, answer: refused.body };
      search.push({ payment_id: pain001.paymentId, org: 'read', where: 'remit_source_refs.uetr (inherited; not in the signed instruction)', value: uetr });
    }
    clock.set(next());
    const mt103 = await swift(O.read, 'mt103.sample.txt', { supplement: fromMaster });
    await settlement({ org: O.read, name: 'swift-mt103', prepared: mt103, expect: 'ONCHAIN_SETTLED', group: 'swift', plan: { callbacks: 'manual' }, note: 'made from mt103.sample.txt (a UETR in block 3)' });
    source['mt103.sample.txt'] = { payment_id: mt103.paymentId, source: mt103.source };
    { // Its UETR on another payment: refused as a reference used twice, nothing recognised.
      clock.set(next());
      const other = await swift(O.read, 'mt103.sample.txt', { supplement: fromMaster, paymentId: 'PAY-SEED-SWIFT-REUSED-REFUSED', edit: (text) => text.replaceAll('USD6150,', 'USD6151,') });
      const refused = await call('POST /v1/settlements', { org: O.read.id, headers: { 'idempotency-key': `swift-${other.paymentId}` }, body: other.body });
      if (refused.status !== 409 || refused.body.error !== 'reference_reused') throw new Error(`a UETR on another payment was to be refused as reused: ${refused.status} ${JSON.stringify(refused.body).slice(0, 300)}`);
      source.reused = { of: mt103.paymentId, refused_payment_id: other.paymentId, source: other.source, answer: refused.body };
    }
    clock.set(DAY(8) + 23 * 3_600_000);

    // ════ days 5 and 6 (2026-10-09, 2026-10-10): a ledger long enough to page through, findable by every kind of reference ══
    next = slots(DAY(9) + 6 * 3_600_000, 600_000);
    const refs = ['INST-2026-000401', 'inst-lower-case-0402', 'INST/100%_DONE!', 'INST_UNDER_SCORE', 'Réf-ß-Straße-0405', '지시-2026-0406', 'INST "quoted" 0407', 'INST\\back\\slash', 'INST 0409 with spaces',
      'null', 'true', 'INST-😀-0412', "INST-'apostrophe'", 'INST-TAB\there', 'INST%0415', 'A', 'payment_id', 'INST-0418-' + 'x'.repeat(60)];
    const paging = [];
    for (let i = 0; i < 44; i++) {
      const n = String(i + 1).padStart(3, '0');
      const kind = i % 4;
      if (i === 24) next = slots(DAY(10) + 6 * 3_600_000, 600_000);
      if (i === 30) clock.frozen = true; // six acceptances in one millisecond: a page boundary among them falls back on the id
      const spec = { group: 'paging', instructionRef: refs[i] ?? `INST-PAGE-${n}`,
        ...(kind === 0 ? { expect: 'BANK_AUTHORIZED', stop: 'authorized' } : kind === 1 ? { expect: 'TRAVEL_RULE_PENDING', amount: `${20000 + i}.00` }
          : kind === 2 ? { expect: 'ONCHAIN_SETTLED', plan: { callbacks: 'manual' }, amount: `${300 + i}.00` } : { expect: 'PAYOUT_IN_PROGRESS', amount: `${400 + i}.01` }) };
      if (i >= 30 && i < 36) Object.assign(spec, { expect: 'BANK_AUTHORIZED', stop: 'authorized', amount: '1200.00', plan: undefined });
      const at = i >= 31 && i < 36 ? undefined : next();
      paging.push((await settlement({ org: O.read, name: `page-${n}`, id: `PAY-SEED-PAGE-${n}`, at, ...spec })).id);
      if (i === 35) clock.frozen = false;
    }
    const sameMillisecond = paging.slice(30, 36);
    {
      const stamps = new Set((await db.prepare(`SELECT created_at FROM remit_payments WHERE id IN (${sameMillisecond.map(() => '?').join(', ')})`).all(...sameMillisecond)).map((r) => r.created_at));
      if (stamps.size !== 1) throw new Error(`six settlements were to share one millisecond; they have ${stamps.size} different times`);
    }

    // ════ three hours before now: what the cases carry on (the write organisation) ══
    const recentFrom = seededAt - 3 * 3_600_000;
    next = slots(recentFrom, 20_000);
    const W = (name, spec) => settlement({ org: O.rail, name, id: `PAY-RAIL-${name.toUpperCase()}`, at: next(), long: true, ...spec });
    const openRfi = { expect: 'TRAVEL_RULE_PENDING', group: 'rfi' };
    for (let i = 0; i < 10; i++) await W(`rfi-${String(i).padStart(2, '0')}`, { ...openRfi, amount: `${25000 + i}.00`, ...(i >= 8 ? { mode: 'B' } : {}) });
    await W('rfi-bare-remembered', { ...openRfi, group: 'rfi-bare', plan: { steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment', remember: true } } }, note: 'a bare question the partner remembers: an answer to it can be accepted' });
    await W('rfi-bare', { ...openRfi, group: 'rfi-bare', plan: { steps: { 'travel-rule': { do: 'rfi-bare', reason: 'please state the purpose of the payment' } } }, note: 'a bare question the partner kept nothing of, as the simulator: an answer cannot verify there' });
    for (let i = 0; i < 2; i++) await bareRow(O.rail, `cancellable-accepted-${i}`, `PAY-RAIL-CANCELLABLE-ACCEPTED-${i}`, next());
    for (let i = 0; i < 3; i++) await W(`cancellable-authorized-${i}`, { expect: 'BANK_AUTHORIZED', stop: 'authorized', group: 'cancellable' });
    for (let i = 0; i < 3; i++) await W(`cancellable-rfi-${i}`, { ...openRfi, group: 'cancellable', amount: `${30000 + i}.00` });
    await W('cancellable-in-call', { expect: 'TRAVEL_RULE_PENDING', group: 'cancellable', plan: { steps: { 'travel-rule': { do: 'hold' } } }, heldAt: 'travel-rule' });
    for (let i = 0; i < 2; i++) await W(`received-${i}`, { expect: 'TRAVEL_RULE_PENDING', stop: 'received', group: 'received' });
    for (let i = 0; i < 2; i++) await W(`pre-approved-${i}`, { expect: 'PAYOUT_PRE_APPROVED', stop: 'pre-approved', group: 'pre-approved' });
    await W('instructed', { expect: 'PAYOUT_PRE_APPROVED', group: 'instructed', plan: { steps: { transfer: { do: 'hold' } } }, heldAt: 'transfer' });
    for (let i = 0; i < 16; i++) await W(`onchain-${String(i).padStart(2, '0')}`, { expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { callbacks: 'manual' }, amount: `${1200 + i}.00`, ...(i >= 12 ? { mode: 'B' } : {}), ...(i === 15 ? { bfi: 'bfi2' } : {}) });
    for (let i = 0; i < 6; i++) await W(`in-progress-${i}`, { expect: 'PAYOUT_IN_PROGRESS', group: 'in-progress', plan: { callbacks: 'manual' }, amount: `${1300 + i}.00`, then: ({ cb }) => cb('USDC_RECEIVED') });
    for (let i = 0; i < 2; i++) await W(`submitted-${i}`, { expect: 'PAYOUT_IN_PROGRESS', group: 'submitted', plan: { callbacks: 'manual' }, amount: `${1400 + i}.00`, then: async ({ cb }) => { await cb('USDC_RECEIVED'); await cb('PAYOUT_SUBMITTED'); } });
    for (let i = 0; i < 4; i++) await W(`l1-${i}`, { expect: 'PAYOUT_IN_PROGRESS', group: 'l1', amount: `${1500 + i}.01` });
    for (let i = 0; i < 2; i++) await W(`failed-${i}`, { expect: 'PAYOUT_IN_PROGRESS', group: 'failed', plan: { callbacks: 'manual' }, amount: `${1600 + i}.00`, then: async ({ cb }) => { await cb('USDC_RECEIVED'); await cb('PAYOUT_SUBMITTED'); await cb('PAYOUT_FAILED'); } });
    await settlement({ org: O.nohook, name: 'rfi', id: 'PAY-NOHOOK-RFI', at: next(), long: true, ...openRfi, amount: '25000.00' });
    for (let i = 0; i < 2; i++) await settlement({ org: O.nohook, name: `onchain-${i}`, id: `PAY-NOHOOK-ONCHAIN-${i}`, at: next(), long: true, expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { callbacks: 'manual' } });
    // Two organisations whose subscription is, or will be, switched off while a settlement of theirs is under way.
    await settlement({ org: O.off, name: 'onchain', id: 'PAY-OFF-ONCHAIN', at: next(), long: true, expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { callbacks: 'manual' }, note: 'made while the subscription was on; it is off now' });
    await settlement({ org: O.deact, name: 'onchain', id: 'PAY-DEACT-ONCHAIN', at: next(), long: true, expect: 'ONCHAIN_SETTLED', group: 'onchain', plan: { callbacks: 'manual' } });
    await settlement({ org: O.deact, name: 'rfi', id: 'PAY-DEACT-RFI', at: next(), long: true, ...openRfi, amount: '25000.00' });

    // ── quotes for the cases: fresh ones that outlive a run, an expired one, one whose stored text is no JSON ──
    const quotes = { fresh: {}, expired: expiredQuote, broken: null };
    const ladder = ['1200.00', '1200.00', '1200.00', '1200.00', '1200.00', '1200.00', '1200.00', '1200.00', '4300.00', '6150.00', '12500.00', '990.75', '25000.00', '25000.00', '25000.00', '25000.00',
      '1000.13', '1000.01', '1000.02', '60000.00', '0.01', '49999.99', '50000.00', '50000.01'];
    for (const [name, amounts] of [['rail', ladder], ['nohook', ladder.slice(0, 6)], ['b', ladder.slice(0, 3)], ['deact', ladder.slice(0, 2)]]) {
      quotes.fresh[name] = [];
      for (const [i, amount] of amounts.entries()) { clock.set(next()); quotes.fresh[name].push(await quoteFor(O[name], amount, `fresh ${name} ${i}`, { long: true })); }
    }
    {
      const row = await db.prepare('SELECT expires_at FROM remit_quotes WHERE id = ?').get(quotes.expired.quote_id);
      if (!(Date.parse(row.expires_at) < seededAt)) throw new Error('the quote made to be expired is not');
      clock.set(next());
      quotes.broken = 'QT-5eedbad0-0bad';
      await db.prepare(`INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at) VALUES (?, ?, 'VN', 'SG', '{}', ?, ?, ?)`)
        .run(quotes.broken, O.rail.id, 'not JSON at all', iso(seededAt + TEN_YEARS), new Date().toISOString());
      handMade.push({ what: `remit_quotes ${quotes.broken}`, why: 'a stored quote that is no JSON: acceptance fails on it inside the reference (a 500 worded by its engine)' });
    }
    handMade.push({ what: `institutions ${extra.noEnc}`, why: 'a beneficiary institution without an encryption key, written through the registry: nobody holds its signing key' });
    await registry.unsubscribe(O.off.id, 'remit');
    const recentTo = clock.now;
    if (recentTo >= seededAt) throw new Error('the seed made more than three hours of recent rows: they would lie in the future');

    // ── nothing may be left for the reference to do when it starts ──────────────
    const backfilled = await store.backfillSourceRefs();
    if (Object.values(backfilled).some((v) => (Array.isArray(v) ? v.length : v) !== 0)) throw new Error(`the reference would give seeded settlements their place when it starts (${JSON.stringify(backfilled)}): the two schemas would differ before the first request`);
    const unplaced = await db.prepare(`SELECT COUNT(*) AS n FROM remit_payments p JOIN remit_events e ON e.payment_id = p.id AND e.type = 'BANK_EVIDENCE_SUBMITTED'
      WHERE e.payload LIKE '%"sourceMessage"%' AND NOT EXISTS (SELECT 1 FROM remit_source_refs r WHERE r.payment_id = p.id)`).get();
    if (Number(unplaced.n) !== 0) throw new Error(`${unplaced.n} seeded settlements made from a message have no source reference row`);
    const held = partner.held();
    const stillRunning = partner.running();
    if (stillRunning !== 0) throw new Error(`${stillRunning} callback runs of the stand-in are still under way`);

    // ── what the cases are told ────────────────────────────────────────────────
    const rows = new Map((await db.prepare(`SELECT p.id, p.state, p.chain_tx, p.deposit_address, p.evidence_level, p.attestation_id, p.created_at, p.package_json IS NOT NULL AS packaged, a.status AS anchor
      FROM remit_payments p LEFT JOIN attestations a ON a.id = p.attestation_id WHERE p.org_id IN (${Object.values(O).map(() => '?').join(', ')})`).all(...Object.values(O).map((o) => o.id))).map((r) => [r.id, r]));
    const settlements = {};
    const byState = {};
    const byDay = {};
    for (const m of made) {
      const r = rows.get(m.id);
      const entry = { id: m.id, state: r.state, mode: m.mode, amount: m.amount, quote_id: m.quote_id, chain_tx: r.chain_tx, evidence_level: r.evidence_level, packaged: Boolean(Number(r.packaged)),
        attestation: r.attestation_id ? { id: r.attestation_id, status: r.anchor ?? 'unknown' } : null, created_at: r.created_at, from_message: m.from_message, ...(m.group ? { group: m.group } : {}), ...(m.note ? { note: m.note } : {}) };
      (settlements[m.org] ??= {})[m.name] = entry;
      byState[r.state] = (byState[r.state] ?? 0) + 1;
      ((byDay[m.org] ??= {})[r.created_at.slice(0, 10)] ??= []).push(m.id);
    }
    const groups = {};
    for (const m of made) if (m.group) ((groups[m.org] ??= {})[m.group] ??= []).push(m.id);
    search.push({ payment_id: 'PAY-SEED-ANCHORED-A', org: 'read', where: 'payment id', value: 'PAY-SEED-ANCHORED-A' });
    search.push({ payment_id: pacs008.paymentId, org: 'read', where: 'quote id', value: pacs008.quote.quote_id });
    const completed = await db.prepare(`SELECT e.payment_id, JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.bank_reference')) AS ref FROM remit_events e JOIN remit_payments p ON p.id = e.payment_id
      WHERE e.type = 'PAYOUT_COMPLETED' AND p.org_id = ? AND JSON_EXTRACT(e.payload, '$.bank_reference') IS NOT NULL ORDER BY e.created_at LIMIT 6`).all(O.read.id);
    for (const c of completed) search.push({ payment_id: c.payment_id, org: 'read', where: 'PAYOUT_COMPLETED.bank_reference', value: c.ref });
    for (const m of made.filter((x) => x.org === 'read').slice(0, 4)) {
      search.push({ payment_id: m.id, org: 'read', where: 'bankApproval.approvalRef', value: `APPR-${m.id}` });
      if (rows.get(m.id).chain_tx) search.push({ payment_id: m.id, org: 'read', where: 'chain_tx', value: rows.get(m.id).chain_tx });
    }
    const show = (o) => ({ id: o.id, slug: o.slug, key: o.key, ...(o.bank ? { bank: { id: o.bank.id, name: o.bank.name, country: o.bank.country, pem: o.bank.pem, spki: o.bank.spki } } : {}),
      ...(o.hook ? { webhook: { name: o.hook.name, reference: o.hook.reference, second: o.hook.second } } : {}) });
    const counts = { organisations: Object.keys(O).length, settlements: made.length, by_state: byState, quotes: (await db.prepare(`SELECT COUNT(*) AS n FROM remit_quotes WHERE org_id IN (${Object.values(O).map(() => '?').join(', ')})`).get(...Object.values(O).map((o) => o.id))).n,
      manifests: Object.keys(manifests).length, held_partner_calls: held.length };
    return {
      note: 'Written by tools/seed-remit.mjs (through tools/seed-reference.mjs). The settlement rail\'s seeded rows; the same in both schemas but for the webhook address of the organisations that have one.',
      seeded_at: iso(seededAt), fixed_days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], recent: { from: iso(recentFrom), to: iso(recentTo) },
      carry_on_before: iso(recentFrom + 44 * 3_600_000),
      admin_token_setting: 'REMIT_ADMIN_TOKEN',
      platform: { key_id: platform.keyId, spki: platform.publicSpkiBase64 },
      partner: {
        keys_file: 'parity/partner-keys.json',
        institutions: Object.fromEntries(Object.values(K).map((i) => [i.slug, { id: i.id, role: i.role, name: i.name, registered: i.registered, spki: i.spki, ...(i.enc ? { encryption_jwk: i.enc.jwk } : {}) }])),
        ledger: partner.ledger(),
      },
      institutions: { ...extra, deact_exchange: 'KR-EX-DEACT' },
      orgs: { ...Object.fromEntries(Object.values(O).map((o) => [o.name, show(o)])), deact: { ...show(O.deact), account: deactAccount } },
      parties: PARTIES, rfi_answers: ANSWERS,
      quotes,
      settlements, groups, by_day: byDay,
      paging: { org: 'read', ids: paging, same_millisecond: sameMillisecond, total: Object.keys(settlements.read).length },
      chain, source, search, manifests, hand_made: handMade, counts,
    };
  } finally {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
    clock.restore();
  }
}

/**
 * After the rows were copied: an organisation's webhook address names the partner stand-in of the server that
 * reads the schema — `<REMIT_PARTNERS_BASE of its env file>/hooks/<name>`. In the reference schema that is what
 * was seeded; here the second schema's subscriptions and seeded delivery rows are given theirs.
 */
export async function afterCopy({ q, DEV, refEnv, devEnv, seeded }) {
  if (!seeded || seeded.skipped) { console.log(`the settlement rail: not seeded (${seeded?.skipped ?? 'nothing was made'})`); return { changed: 0 }; }
  const from = `${String(refEnv.REMIT_PARTNERS_BASE).replace(/\/+$/, '')}/hooks/`;
  const to = `${String(devEnv.REMIT_PARTNERS_BASE).replace(/\/+$/, '')}/hooks/`;
  let own = { changed: 0, subscriptions: 0, deliveries: 0 };
  if (from !== to) {
    const a = await q(`UPDATE \`${DEV}\`.subscriptions SET config = REPLACE(config, ?, ?) WHERE product = 'remit' AND INSTR(config, ?) > 0`, [from, to, from]);
    const b = await q(`UPDATE \`${DEV}\`.remit_webhook_deliveries SET url = CONCAT(?, SUBSTRING(url, ?)) WHERE LEFT(url, ?) = ?`, [to, from.length + 1, from.length, from]);
    own = { changed: a.affectedRows + b.affectedRows, subscriptions: a.affectedRows, deliveries: b.affectedRows };
  }
  console.log(`the settlement rail: ${seeded.counts.settlements} settlements of ${seeded.counts.organisations} organisations (${Object.entries(seeded.counts.by_state).map(([k, v]) => `${k} ${v}`).join(', ')}), `
    + `${seeded.counts.quotes} quotes, ${seeded.counts.manifests} manifests; in ${DEV} ${own.subscriptions} subscriptions and ${own.deliveries} seeded deliveries name that server's own stand-in`);
  return own;
}

// ── by itself: the rail's rows alone, on two schemas of the reference-harness's own ─────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readEnv = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.indexOf('=') > 0).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const schemaOf = (url) => new URL(url).pathname.replace(/^\//, '');
  const MINE = /^stonehash_test_remit[a-z0-9_]*$/;
  if (args[0] === '--prepare' && args[1]) {
    const url = readEnv(args[1]).STONEHASH_DB_URL;
    if (!MINE.test(schemaOf(url))) { console.error('refusing: --prepare makes the reference\'s tables in a stonehash_test_remit… schema only'); process.exit(1); }
    const db = await openDb(url);
    await db.close();
    console.log(`${schemaOf(url)}: the reference's tables are there`);
    process.exit(0);
  }
  const [refEnvFile, devEnvFile] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.resolve(HERE, '../parity/seed.rail-only.json');
  if (!refEnvFile || !devEnvFile) { console.error('usage: node seed-remit.mjs <reference env file> <second env file> [--out <file>]   |   node seed-remit.mjs --prepare <env file>'); process.exit(2); }
  const [refEnv, devEnv] = [readEnv(refEnvFile), readEnv(devEnvFile)];
  const [REF, DEV] = [schemaOf(refEnv.STONEHASH_DB_URL), schemaOf(devEnv.STONEHASH_DB_URL)];
  if (!MINE.test(REF) || !MINE.test(DEV) || REF === DEV) { console.error('refusing: by itself this tool seeds two different stonehash_test_remit… schemas only (the comparison pair is seeded by seed-reference.mjs)'); process.exit(1); }
  const require = createRequire(new URL('../../core/package.json', import.meta.url));
  const mysql = require('mysql2/promise');
  const u = new URL(refEnv.STONEHASH_DB_URL);
  const conn = await mysql.createConnection({ host: u.hostname, port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), charset: 'utf8mb4_bin' });
  const q = async (sql, params = []) => (await conn.query(sql, params))[0];
  const tablesOf = async (schema) => (await q("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [schema])).map((r) => r.t).filter((t) => t !== 'flyway_schema_history');
  const clear = async (schema) => { await q('SET FOREIGN_KEY_CHECKS = 0'); for (const t of await tablesOf(schema)) await q(`TRUNCATE TABLE \`${schema}\`.\`${t}\``); await q('SET FOREIGN_KEY_CHECKS = 1'); };
  const started = Date.now();
  await clear(REF);
  // An anchor backend that builds a transaction and broadcasts nothing, as in seed-reference.mjs.
  const states = new Map(); let submitted = 0;
  const P2TR = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 0xab)]);
  const backend = {
    network: 'regtest', name: 'bitcoind:regtest',
    async submit(payload) {
      const legacy = serializeLegacy([{ txid: sha256hex(`rail seed input ${submitted++}`), vout: 0 }], [{ value: 0, scriptPubKey: opReturnScript(payload) }, { value: 9_000, scriptPubKey: P2TR }]);
      return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy), anchorPayloadHex: Buffer.from(payload).toString('hex') };
    },
    async poll(handle) { return states.get(handle.txid) ?? { status: 'pending' }; },
    async health() { return { ok: true }; },
  };
  const db = await openDb(refEnv.STONEHASH_DB_URL);
  const svc = new AttestService(db, backend, 1024, null);
  let seeded;
  try { seeded = await seedRemit({ db, svc, states, refEnv, devEnv }); } finally { await db.close(); }
  if ((await tablesOf(DEV)).length === 0) { const second = await openDb(devEnv.STONEHASH_DB_URL); await second.close(); }
  await clear(DEV);
  await q('SET FOREIGN_KEY_CHECKS = 0');
  const copied = [];
  for (const t of await tablesOf(REF)) {
    const cols = (await q('SELECT column_name AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position', [REF, t])).map((r) => `\`${r.c}\``).join(', ');
    const [result] = await conn.query(`INSERT INTO \`${DEV}\`.\`${t}\` (${cols}) SELECT ${cols} FROM \`${REF}\`.\`${t}\``);
    if (result.affectedRows > 0) copied.push(`${t} ${result.affectedRows}`);
  }
  await q('SET FOREIGN_KEY_CHECKS = 1');
  const own = await afterCopy({ q, REF, DEV, refEnv, devEnv, seeded });
  await conn.end();
  fs.writeFileSync(outFile, `${JSON.stringify({ note: 'Written by tools/seed-remit.mjs run by itself: the rail\'s rows only.', remit: seeded }, null, 1)}\n`, { mode: 0o600 });
  fs.chmodSync(outFile, 0o600);
  console.log(`seeded the rail's rows in ${REF} and copied to ${DEV} in ${((Date.now() - started) / 1000).toFixed(1)} s: ${copied.join(', ')}`);
  console.log(`settlements by state: ${JSON.stringify(seeded.counts?.by_state ?? seeded)}`);
  console.log(`webhook addresses given to the second schema: ${JSON.stringify(own)}; written: ${outFile}`);
}
