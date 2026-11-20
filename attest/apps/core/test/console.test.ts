/**
 * The Sandbox Console — real server, real SQLite, real cookies.
 *
 * This is the surface a prospective customer touches first, and it is the only
 * part of the service that holds a password. The assertions below are mostly
 * about the two things that would be worst to get wrong: one tenant seeing
 * another's records, and a credential being recoverable from somewhere it
 * should not be.
 *
 * Only the chain is substituted. Signup, provisioning, sessions and quota are
 * exercised against the code that runs in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { AttestService } from '../src/service.ts';
import { Registry } from '../src/remit/registry.ts';
import { RemitStore } from '../src/remit/store.ts';
import { RemitOrchestrator } from '../src/remit/orchestrator.ts';
import { WebhookOutbox } from '../src/remit/webhook.ts';
import { TripleAProfileSim } from '../src/remit/partners-client.ts';
import { loadOrCreatePlatformKey } from '../src/remit/sign.ts';
import type { RemitServices } from '../src/remit/routes.ts';
import { buildRouter } from '../src/http/routes.ts';
import { HttpResult, Router } from '../src/http/server.ts';
import { isAudited, recordAudit, searchAudit, serviceOf } from '../src/audit.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import { hashPassword, normaliseEmail, passwordProblem, verifyPassword } from '../src/account.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from '../src/anchor/backend.ts';
import type { Server } from 'node:http';

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

class StubBackend implements AnchorBackend {
  readonly network = 'regtest' as const;
  readonly name = 'stub:regtest';
  async submit(payload: Uint8Array): Promise<AnchorHandle> {
    const legacy = serializeLegacy(
      [{ txid: '22'.repeat(32), vout: 0 }],
      [{ value: 0, scriptPubKey: opReturnScript(payload) }],
    );
    return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy), anchorPayloadHex: bytesToHex(payload) };
  }
  async poll(): Promise<AnchorState> { return { status: 'pending', confirmations: 0 }; }
  async health(): Promise<{ ok: boolean }> { return { ok: true }; }
}

interface Harness { base: string; svc: AttestService; db: Awaited<ReturnType<typeof openDb>>; close: () => void }

/**
 * The remit rail as main.ts wires it, against the in-memory db. The console's
 * product routes are mounted only when the router receives it, so the tests
 * that read `/v1/console/products` ask for it. The partner simulator is
 * constructed and never called; the platform key lives in a temp directory.
 */
function remitServices(db: Harness['db'], svc: AttestService, cfg: Config): { remit: RemitServices; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-console-remit-'));
  const platform = loadOrCreatePlatformKey(path.join(dir, 'platform.pem'));
  const store = new RemitStore(db);
  const registry = new Registry(db);
  const log = (): void => {};
  const outbox = new WebhookOutbox(db, platform, cfg.remit.webhookMaxAttempts, log);
  const partners = new TripleAProfileSim(cfg.remit.partnersBase);
  const orchestrator = new RemitOrchestrator({
    store, registry, svc, bfi: partners, wallet: partners, outbox, platform,
    acceptDemoFinality: cfg.remit.acceptDemoFinality, chainLabel: cfg.remit.chainLabel, log,
  });
  return {
    remit: {
      store, registry, orchestrator, platform,
      quoteCfg: { rates: cfg.remit.rates, feeUsd: cfg.remit.feeUsd, ttlMs: cfg.remit.quoteTtlMs, chainLabel: cfg.remit.chainLabel },
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function start(overrides: Record<string, unknown> = {}, opts: { remit?: boolean } = {}): Promise<Harness> {
  const db = await openDb(':memory:');
  const backend = new StubBackend();
  const cfg = loadConfig({
    env: 'test', host: '127.0.0.1', port: 0, dbPath: ':memory:',
    anchorBackend: 'regtest', bitcoinNetwork: 'regtest', workerTickMs: 0,
    // The console is only served when a built directory is configured, and
    // `/v1/meta` reports it on that basis — so the tests set it.
    consoleDir: '/tmp/console-not-really-served',
    ...overrides,
  } as Parameters<typeof loadConfig>[0]);
  const svc = new AttestService(db, backend, cfg.batch.maxLeaves);
  const publicOrgId = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
  const rail = opts.remit ? remitServices(db, svc, cfg) : null;
  const server: Server = buildRouter({ cfg, db, svc, backend, version: 'test', publicOrgId,
    ...(rail ? { remit: rail.remit } : {}) })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server did not bind a port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    svc,
    db,
    close: () => { server.closeAllConnections(); server.close(); void db.close(); rail?.cleanup(); },
  };
}

interface Reply { status: number; json: Record<string, any>; cookie: string | undefined }

/** `cookie` is the console's credential, `token` the keyed API's; a test that uses both is testing that they meet. */
async function call(
  base: string, method: string, path: string,
  opts: { body?: unknown; cookie?: string; token?: string } = {},
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, any>) : {},
    // Just the name=value pair, which is what a browser would send back.
    cookie: setCookie ? setCookie.split(';')[0] : undefined,
  };
}

const PASSWORD = 'correct-horse-battery';

/** Sign up and return the session cookie plus the one-time key. */
async function signUp(base: string, email: string): Promise<{ cookie: string; key: string; body: Record<string, any> }> {
  const r = await call(base, 'POST', '/v1/console/signup', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.cookie, 'signup must set a session cookie');
  return { cookie: r.cookie, key: r.json['api_key_secret'] as string, body: r.json };
}

// ── passwords, as units ────────────────────────────────────────────────────

test('a password verifies against its own hash and nothing else', () => {
  const stored = hashPassword(PASSWORD);
  assert.ok(verifyPassword(PASSWORD, stored));
  assert.ok(!verifyPassword(`${PASSWORD}x`, stored));
  assert.ok(!verifyPassword('', stored));
});

test('the stored hash contains neither the password nor a reusable form of it', () => {
  const stored = hashPassword(PASSWORD);
  assert.ok(!stored.includes(PASSWORD));
  // scrypt$N$r$p$salt$hash — the parameters travel with the digest so the cost
  // can be raised later without locking anyone out.
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.ok(Number(parts[1]) >= 16_384, 'scrypt N is too low to be worth having');
});

test('two accounts with the same password get different hashes', () => {
  // A shared salt would let one cracked password reveal every account using it.
  assert.notEqual(hashPassword(PASSWORD), hashPassword(PASSWORD));
});

test('a malformed stored hash fails closed rather than throwing', () => {
  for (const bad of ['', 'nonsense', 'scrypt$1$1$1$x$y', 'bcrypt$a$b$c$d$e']) {
    assert.equal(verifyPassword(PASSWORD, bad), false, bad);
  }
});

test('password length is the only rule, and it is enforced', () => {
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem(undefined));
  assert.ok(passwordProblem('x'.repeat(201)));
  assert.equal(passwordProblem('ten-chars!'), null);
});

test('emails are normalised so one address cannot register twice', () => {
  assert.equal(normaliseEmail('  Lead@Example.COM '), 'lead@example.com');
  for (const bad of ['notanemail', 'a@b', '@example.com', 'a@@b.com', '', 'a b@c.com']) {
    assert.equal(normaliseEmail(bad), null, bad);
  }
});

// ── signup ─────────────────────────────────────────────────────────────────

test('signup provisions a usable tenant in one call', async () => {
  const h = await start();
  try {
    const { body, key } = await signUp(h.base, 'lead@example.com');
    // The design requires a first successful call inside a minute, so an empty
    // dashboard with a "create your first attestation" prompt does not do —
    // that only moves the blank page.
    assert.match(key, /^sk_test_/);
    assert.ok(body['org']['slug'].startsWith('sandbox-'));
    assert.equal(body['issuer_keys'].length, 1, 'a demo issuer key should be registered');
    assert.equal(body['quota']['used'], 1, 'the seeded sample counts against the quota');
    assert.equal(body['quota']['limit'], 1000);

    const list = await call(h.base, 'GET', '/v1/console/attestations',
      { cookie: (await signUp(h.base, 'second@example.com')).cookie });
    assert.equal(list.json['data'].length, 1, 'each tenant is seeded with exactly one sample');
  } finally { h.close(); }
});

test('the key signup hands over works against the real keyed API', async () => {
  const h = await start();
  try {
    const { key } = await signUp(h.base, 'lead@example.com');
    // If the console minted something only the console accepted, the sandbox
    // would be demonstrating a product that does not exist.
    const res = await fetch(`${h.base}/v1/attestations`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200);
  } finally { h.close(); }
});

test('the secret key is returned once and never again', async () => {
  const h = await start();
  try {
    const { cookie, key } = await signUp(h.base, 'lead@example.com');
    const me = await call(h.base, 'GET', '/v1/console/me', { cookie });
    assert.equal(me.status, 200);
    assert.ok(!JSON.stringify(me.json).includes(key),
      'the dashboard must not be able to re-read the secret');
    // The prefix is fine to show — it is how a key is identified at a glance.
    assert.equal(me.json['api_key']['prefix'], 'sk_test_');
  } finally { h.close(); }
});

test('a second signup on the same address is refused', async () => {
  const h = await start();
  try {
    await signUp(h.base, 'lead@example.com');
    const again = await call(h.base, 'POST', '/v1/console/signup',
      { body: { email: 'LEAD@example.com', password: PASSWORD } });
    assert.equal(again.status, 409);
    assert.equal(again.json['error'], 'email_taken');
  } finally { h.close(); }
});

test('signup rejects what it cannot use', async () => {
  const h = await start();
  try {
    for (const body of [
      { email: 'notanemail', password: PASSWORD },
      { email: 'a@b.com', password: 'short' },
      { email: 'a@b.com' },
      {},
    ]) {
      assert.equal((await call(h.base, 'POST', '/v1/console/signup', { body })).status, 400,
        JSON.stringify(body));
    }
  } finally { h.close(); }
});

// ── sessions ───────────────────────────────────────────────────────────────

test('the session cookie is HttpOnly and SameSite=Lax', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/v1/console/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'lead@example.com', password: PASSWORD }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    // HttpOnly so a script cannot read it; Lax so it does not ride along on a
    // cross-site POST, which is what makes the absence of a CSRF token safe.
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    // Not Secure here: the test box is plain HTTP, and a Secure cookie would
    // simply never be stored. Production sets COOKIE_SECURE=1.
    assert.doesNotMatch(cookie, /Secure/);
  } finally { h.close(); }
});

test('the cookie is marked Secure when configured for HTTPS', async () => {
  // The one flag whose misconfiguration silently downgrades every session, in
  // both directions: omitted behind TLS the cookie travels in clear, and set on
  // plain HTTP the browser discards it and the console appears simply broken.
  const h = await start({
    console: {
      enabled: true, cookieSecure: true, monthlyQuota: 1000,
      authRateLimit: { windowMs: 900_000, max: 50 },
    },
  });
  try {
    const res = await fetch(`${h.base}/v1/console/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: PASSWORD }),
    });
    assert.equal(res.status, 201);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
  } finally { h.close(); }
});

test('signing out deletes the session rather than only clearing the cookie', async () => {
  const h = await start();
  try {
    const { cookie } = await signUp(h.base, 'lead@example.com');
    assert.equal((await call(h.base, 'GET', '/v1/console/me', { cookie })).status, 200);

    const out = await call(h.base, 'POST', '/v1/console/logout', { cookie });
    assert.equal(out.status, 200);
    // Replaying the same cookie must fail. A stateless signed token could not
    // be revoked like this, which is why sessions are stored.
    assert.equal((await call(h.base, 'GET', '/v1/console/me', { cookie })).status, 401);
  } finally { h.close(); }
});

test('a forged or absent cookie is not a session', async () => {
  const h = await start();
  try {
    await signUp(h.base, 'lead@example.com');
    for (const cookie of [
      undefined,
      'stonehash_session=',
      'stonehash_session=not-a-real-token',
      `stonehash_session=${'a'.repeat(43)}`,
    ]) {
      const r = await call(h.base, 'GET', '/v1/console/me', cookie ? { cookie } : {});
      assert.equal(r.status, 401, String(cookie));
    }
  } finally { h.close(); }
});

// ── isolation ──────────────────────────────────────────────────────────────

test('one tenant cannot read another tenant’s records', async () => {
  const h = await start();
  try {
    const a = await signUp(h.base, 'a@example.com');
    const b = await signUp(h.base, 'b@example.com');

    const aList = await call(h.base, 'GET', '/v1/console/attestations', { cookie: a.cookie });
    const aId = aList.json['data'][0]['id'] as string;

    // Not 403: B has no way to learn that this id exists, and saying "forbidden"
    // would confirm it does.
    assert.equal(
      (await call(h.base, 'GET', `/v1/console/attestations/${aId}/bundle`, { cookie: b.cookie })).status,
      404);

    const bList = await call(h.base, 'GET', '/v1/console/attestations', { cookie: b.cookie });
    assert.equal(bList.json['data'].length, 1);
    assert.notEqual(bList.json['data'][0]['id'], aId);
  } finally { h.close(); }
});

test('each tenant’s seeded sample digest differs', async () => {
  const h = await start();
  try {
    const a = await call(h.base, 'GET', '/v1/console/attestations',
      { cookie: (await signUp(h.base, 'a@example.com')).cookie });
    const b = await call(h.base, 'GET', '/v1/console/attestations',
      { cookie: (await signUp(h.base, 'b@example.com')).cookie });
    // A shared sample digest would collide on the per-org uniqueness constraint
    // for the second tenant, leaving them with an empty dashboard.
    assert.notEqual(a.json['data'][0]['leaf_bytes'], b.json['data'][0]['leaf_bytes']);
  } finally { h.close(); }
});

// ── the console does nothing the API cannot ────────────────────────────────

test('submitting a digest through the console takes the same path as the API', async () => {
  const h = await start();
  try {
    const { cookie } = await signUp(h.base, 'lead@example.com');
    const digest = sha256hex('a contract');
    const made = await call(h.base, 'POST', '/v1/console/attestations',
      { cookie, body: { sha256: digest, content_type: 'text/plain' } });
    assert.equal(made.status, 201);
    assert.equal(made.json['leaf_bytes'], digest);
    assert.equal(made.json['status'], 'accepted');
    assert.equal(made.json['quota']['used'], 2, 'the sample plus this one');
  } finally { h.close(); }
});

test('the record list holds every product\'s anchors and narrows to one on request', async () => {
  const h = await start();
  try {
    const { cookie, body } = await signUp(h.base, 'lead@example.com');
    const orgId = body['org']['id'] as string;
    // What the settlement rail and a reserve snapshot leave behind: records
    // of their own product, in the same table as a document's.
    await h.svc.issue(orgId, sha256hex('evidence of a settlement'), undefined,
      { kind: 'remit-evidence' }, { product: 'remit' });
    await h.svc.issue(orgId, sha256hex('a reserve snapshot'), undefined,
      { kind: 'por-snapshot' }, { product: 'por' });

    const products = async (query: string): Promise<string[]> => {
      const r = await call(h.base, 'GET', `/v1/console/attestations${query}`, { cookie });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return (r.json['data'] as { product: string }[]).map((a) => a.product).sort();
    };
    assert.deepEqual(await products(''), ['attest', 'por', 'remit'], 'unnarrowed: the seeded sample and both others');
    assert.deepEqual(await products('?product=remit'), ['remit']);
    assert.deepEqual(await products('?product=por'), ['por']);
    assert.deepEqual(await products('?product=attest'), ['attest']);
    // An empty value is the unnarrowed list — a form field left blank.
    assert.equal((await products('?product=')).length, 3);
    // Narrowed first, limited second. The seeded sample is the oldest of the
    // three, so a limit applied before the narrowing would find nothing.
    assert.deepEqual(await products('?product=attest&limit=1'), ['attest']);

    // A product that does not exist is refused, never answered with everything.
    const bad = await call(h.base, 'GET', '/v1/console/attestations?product=tokens', { cookie });
    assert.equal(bad.status, 400);
    assert.equal(bad.json['error'], 'unknown_product');

    // The quota still counts document anchoring alone.
    const me = await call(h.base, 'GET', '/v1/console/me', { cookie });
    assert.equal(me.json['quota']['used'], 1, 'the other products\' anchors are not on the Attest meter');
  } finally { h.close(); }
});

test('the dashboard\'s time to confirm is document anchoring\'s own', async () => {
  const h = await start();
  try {
    const { cookie, body } = await signUp(h.base, 'ops@example.com');
    const orgId = body['org']['id'] as string;
    // One confirmed record of each product: the document's took a minute,
    // the settlement evidence's an hour. The figure sits in the document
    // product's row, so the hour is not part of it.
    const confirmed = async (product: 'attest' | 'remit', leaf: string, created: string, at: string): Promise<void> => {
      const batch = `B-${product}`;
      await h.db.prepare("INSERT INTO batches (id, status, leaf_count, opened_at) VALUES (?, 'anchored', 1, ?)").run(batch, created);
      await h.db.prepare(
        `INSERT INTO anchor_txs (txid, batch_id, network, payload_hex, raw_tx_hex, status, confirmations, submitted_at, confirmed_at)
         VALUES (?, ?, 'regtest', '00', '00', 'confirmed', 1, ?, ?)`).run(`tx-${product}`, batch, created, at);
      const made = await h.svc.issue(orgId, leaf, undefined, {}, { product });
      await h.db.prepare("UPDATE attestations SET status = 'confirmed', batch_id = ?, leaf_index = 0, created_at = ? WHERE id = ?")
        .run(batch, created, made.id);
    };
    await confirmed('attest', sha256hex('a document'), '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
    await confirmed('remit', sha256hex('evidence of a settlement'), '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');

    const dash = await call(h.base, 'GET', '/v1/console/dashboard', { cookie });
    assert.equal(dash.status, 200, JSON.stringify(dash.json));
    assert.equal(dash.json['attest']['avg_confirm_seconds'], 60);
  } finally { h.close(); }
});

test('the console refuses a digest that is not one', async () => {
  const h = await start();
  try {
    const { cookie } = await signUp(h.base, 'lead@example.com');
    for (const body of [{}, { sha256: 'nope' }, { sha256: 123 }]) {
      const r = await call(h.base, 'POST', '/v1/console/attestations', { cookie, body });
      assert.ok(r.status === 400, `${JSON.stringify(body)} -> ${r.status}`);
    }
  } finally { h.close(); }
});

test('the quota is reported and enforced', async () => {
  const h = await start({ console: { enabled: true, cookieSecure: false, monthlyQuota: 2, authRateLimit: { windowMs: 900_000, max: 50 } } });
  try {
    const { cookie, body } = await signUp(h.base, 'lead@example.com');
    assert.equal(body['quota']['limit'], 2);
    // One of the two is the seeded sample, so exactly one more should fit.
    const first = await call(h.base, 'POST', '/v1/console/attestations',
      { cookie, body: { sha256: sha256hex('one') } });
    assert.equal(first.status, 201);
    const second = await call(h.base, 'POST', '/v1/console/attestations',
      { cookie, body: { sha256: sha256hex('two') } });
    assert.equal(second.status, 429);
    assert.equal(second.json['error'], 'quota_exhausted');
    // The message has to say when it recovers, or the only option is guessing.
    assert.match(second.json['message'] as string, /resets at \d{4}-/);
  } finally { h.close(); }
});

// ── retention: an organisation's records do not expire ───────────────────

test('an organisation\'s records carry no expiry and outlive the free tier\'s sweep', async () => {
  /*
   * A customer's records are kept until the customer asks for them to be
   * deleted, in the sandbox and in production alike; only the anonymous free
   * tier expires. The console used to stamp 30 days on what it made and to
   * announce it. Nothing honoured the stamp, and nothing should.
   */
  const h = await start();
  try {
    const { cookie, body } = await signUp(h.base, 'keeper@example.com');
    const orgId = body['org']['id'] as string;
    assert.equal(body['retention_days'], undefined, 'signup announces no retention period');
    const made = await call(h.base, 'POST', '/v1/console/attestations',
      { cookie, body: { sha256: sha256hex('kept until deleted') } });
    assert.equal(made.status, 201);

    const rows = (await h.db.prepare('SELECT id, expires_at FROM attestations WHERE org_id = ?')
      .all(orgId)) as unknown as { id: string; expires_at: string | null }[];
    assert.equal(rows.length, 2, 'the signup sample and the console anchor');
    for (const r of rows) assert.equal(r.expires_at, null, `${r.id} must not carry an expiry`);

    // A free-tier record, made as the public route makes it, does expire…
    const publicOrg = await h.svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
    await h.svc.issue(publicOrg, sha256hex('anonymous'), undefined, undefined,
      { source: 'public', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    // …and a sweep run ten years from now removes it and nothing of the org's.
    assert.equal(await h.svc.purgeExpiredPublic(new Date(Date.now() + 3650 * 86_400_000)), 1);
    const left = (await h.db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE org_id = ?')
      .get(orgId)) as unknown as { n: number };
    assert.equal(Number(left.n), 2);

    const me = await call(h.base, 'GET', '/v1/console/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json['retention_days'], undefined);
    const meta = await call(h.base, 'GET', '/v1/meta');
    assert.equal(meta.json['console']['retention_days'], undefined, 'no retention period to advertise');
    assert.ok(Number(meta.json['free_tier']['retention_days']) > 0, 'the free tier still states its window');

    const dash = (await call(h.base, 'GET', '/v1/console/dashboard', { cookie })).json;
    assert.equal(dash['attest']['expiring_7d'], undefined, 'nothing of an org\'s can be about to expire');
    assert.ok(!(dash['attention']['items'] as { kind: string }[]).some((x) => x.kind === 'expiring'));
  } finally { h.close(); }
});

test('only the free tier can be given an expiry', async () => {
  const h = await start();
  try {
    const org = await h.svc.ensureOrg('an-org', 'An org');
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await assert.rejects(h.svc.issue(org, sha256hex('keyed'), undefined, undefined, { expiresAt: in30 }),
      /only free-tier records expire/);
    await assert.rejects(h.svc.issue(org, sha256hex('keyed, said so'), undefined, undefined,
      { source: 'api', expiresAt: in30 }), /only free-tier records expire/);
    const none = (await h.db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE org_id = ?')
      .get(org)) as unknown as { n: number };
    assert.equal(Number(none.n), 0, 'a refused record is not half-written');
    const free = await h.svc.issue(org, sha256hex('free'), undefined, undefined, { source: 'public', expiresAt: in30 });
    assert.equal(free.expires_at, in30);
  } finally { h.close(); }
});

test('opening a database clears an expiry left on an organisation\'s record and keeps the free tier\'s', async () => {
  // Records made before the rule carry a stamp. The fix runs on open, so a
  // deployment picks it up on its next restart, whichever engine it uses.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-expiry-'));
  const file = path.join(dir, 'attest.db');
  try {
    const first = await openDb(file);
    const svc = new AttestService(first, new StubBackend(), 64);
    const org = await svc.ensureOrg('legacy', 'Legacy org');
    const pub = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
    const stamp = '2026-12-11T03:06:33.668Z';
    const keyed = await svc.issue(org, sha256hex('stamped by the old console'));
    await first.prepare('UPDATE attestations SET expires_at = ? WHERE id = ?').run(stamp, keyed.id);
    const free = await svc.issue(pub, sha256hex('free tier'), undefined, undefined, { source: 'public', expiresAt: stamp });
    await first.close();

    const second = await openDb(file);
    try {
      const read = async (id: string): Promise<string | null> => ((await second.prepare(
        'SELECT expires_at FROM attestations WHERE id = ?').get(id)) as unknown as { expires_at: string | null }).expires_at;
      assert.equal(await read(keyed.id), null, 'the org\'s record no longer carries a deadline');
      assert.equal(await read(free.id), stamp, 'the free tier keeps its window');
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── key rotation ───────────────────────────────────────────────────────────

test('rotation issues a new key and stops the old one immediately', async () => {
  const h = await start();
  try {
    const { cookie, key: old } = await signUp(h.base, 'lead@example.com');
    const rotated = await call(h.base, 'POST', '/v1/console/keys/rotate', { cookie });
    assert.equal(rotated.status, 201);
    const fresh = rotated.json['api_key_secret'] as string;
    assert.match(fresh, /^sk_test_/);
    assert.notEqual(fresh, old);

    const withOld = await fetch(`${h.base}/v1/attestations`, { headers: { authorization: `Bearer ${old}` } });
    assert.equal(withOld.status, 401, 'the revoked key must stop working at once');
    const withNew = await fetch(`${h.base}/v1/attestations`, { headers: { authorization: `Bearer ${fresh}` } });
    assert.equal(withNew.status, 200);
  } finally { h.close(); }
});

test('rotation requires a session', async () => {
  const h = await start();
  try {
    assert.equal((await call(h.base, 'POST', '/v1/console/keys/rotate')).status, 401);
  } finally { h.close(); }
});

// ── honesty about the chain ────────────────────────────────────────────────

test('the dashboard states the network and what it cannot support', async () => {
  const h = await start();
  try {
    const { body } = await signUp(h.base, 'lead@example.com');
    assert.equal(body['bitcoin_network'], 'regtest');
    // A sandbox that let someone believe they had produced a publicly
    // verifiable proof would have misled exactly the person it was courting.
    assert.match(body['public_verifiability'] as string, /cannot be confirmed by a third party/);
    assert.match(body['public_verifiability'] as string, /we mine|private test chain/);
  } finally { h.close(); }
});

test('meta advertises the console only when one is actually served', async () => {
  const served = await start();
  try {
    const meta = await call(served.base, 'GET', '/v1/meta');
    assert.equal(meta.json['console']['path'], '/console/');
    assert.equal(meta.json['console']['self_serve'], true);
    assert.equal(meta.json['console']['signup_required'], true);
  } finally { served.close(); }

  const unserved = await start({ consoleDir: '' });
  try {
    const meta = await call(unserved.base, 'GET', '/v1/meta');
    assert.equal(meta.json['console'], null,
      'advertising a console this deployment does not serve would send people to a 404');
  } finally { unserved.close(); }
});

// ── signing-key revocation reaches the rails that trusted the key ──────────

test('revoking a signing key withdraws it from the institution that signed with it', async () => {
  /*
   * Activation copies the key's public half onto the institution, and the
   * settlement rail verifies partner signatures against that copy. The
   * console promises "revocation is immediate"; this is the test that the
   * promise reaches the rail rather than stopping at the key table.
   */
  const h = await start();
  try {
    const orgId = await h.svc.ensureOrg('revoke-org', 'Revoke Org');
    const { generateKeyPairSync } = await import('node:crypto');
    const spki = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const key = await h.svc.registerIssuerKey(orgId, spki, 'bank hsm');

    // What `POST /v1/console/products` does for the settlement product.
    const registry = new Registry(h.db);
    await registry.subscribe(orgId, 'remit', { institution_id: 'VN-BANK-777' });
    await registry.upsert({ id: 'VN-BANK-777', role: 'COLLECTION_BANK', name: 'Demo Bank', country: 'VN',
      org_id: orgId, signing_spki: spki });
    await registry.requireRemit(orgId);

    assert.equal(await h.svc.revokeIssuerKey(orgId, key.id), true);
    await assert.rejects(registry.requireRemit(orgId),
      (e: unknown) => (e as { code?: string }).code === 'institution_unregistered',
      'the rail must refuse once the only trusted key is revoked');
    // Revoking again is a no-op the caller can tell apart.
    assert.equal(await h.svc.revokeIssuerKey(orgId, key.id), false);
  } finally { h.close(); }
});

// ── the queue names the items, not just their number ───────────────────────

test('the dashboard lists what needs a person by id, five per kind, with the count beside it', async () => {
  /*
   * A count is not something an operator can act on; an ID is. The queue
   * therefore carries the items themselves — exceptions with the error that
   * stopped them, payouts held on thin evidence — five per kind, and the
   * counts say when there are more.
   */
  const h = await start();
  try {
    const { cookie, body } = await signUp(h.base, 'ops@example.com');
    const orgId = body['org']['id'] as string;
    assert.equal(typeof orgId, 'string');
    const store = new RemitStore(h.db);
    await h.db.prepare(
      `INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at)
       VALUES ('Q1', ?, 'VN', 'SG', '{}', '{}', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(orgId);
    const seed = (id: string): Promise<unknown> => store.create({
      id, org_id: orgId, quote_id: 'Q1', corridor_origin: 'VN', corridor_destination: 'SG',
      trade_currency: 'USD', trade_amount: '10.00', collect_currency: 'VND', collect_amount: '1',
      usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35',
      beneficiary_institution: 'SG-BFI-001', request_body: '{}',
    });
    await seed('PAY-EXC');
    await store.appendEvent('PAY-EXC', 'EXCEPTION', 'STONEHASH',
      { payment_id: 'PAY-EXC', at_state: 'ONCHAIN_SETTLED', error: 'wallet transfer failed:  insufficient gas' });
    await store.transition('PAY-EXC', 'EXCEPTION');
    for (let i = 0; i < 6; i++) {
      await seed(`PAY-HELD-${i}`);
      await store.transition(`PAY-HELD-${i}`, 'PAYOUT_IN_PROGRESS');
      await store.patch(`PAY-HELD-${i}`, { evidence_level: 'L1' });
    }

    const dash = await call(h.base, 'GET', '/v1/console/dashboard', { cookie });
    assert.equal(dash.status, 200, JSON.stringify(dash.json));
    const attention = dash.json['attention'] as {
      exceptions: number; l1_held: number;
      items: { kind: string; id: string; state: string; reason: string | null; at: string }[];
    };
    assert.equal(attention.exceptions, 1);
    assert.equal(attention.l1_held, 6);
    assert.deepEqual(
      attention.items.filter((x) => x.kind === 'exception').map((x) => [x.id, x.state, x.reason]),
      [['PAY-EXC', 'EXCEPTION', 'wallet transfer failed: insufficient gas']],
      'an exception carries the error that stopped it, on one line');
    const held = attention.items.filter((x) => x.kind === 'held');
    assert.equal(held.length, 5, 'five per kind at most — the count says six');
    assert.deepEqual(held.map((x) => [x.id, x.state]),
      [5, 4, 3, 2, 1].map((n) => [`PAY-HELD-${n}`, 'PAYOUT_IN_PROGRESS']),
      'newest first — the five shown are the head of the list the count links to; the oldest is the one the count covers');
    assert.ok(
      attention.items.findIndex((x) => x.kind === 'exception') < attention.items.findIndex((x) => x.kind === 'held'),
      'exceptions come first: they are the items that stopped');
    // Exhausted webhook deliveries are counted and listed per payment: one
    // payment whose endpoint was down leaves a row per event it emitted.
    for (const [id, at] of [['d1', '2026-01-01T00:00:00.000Z'], ['d2', '2026-01-01T00:00:05.000Z']] as const) {
      await h.db.prepare(
        `INSERT INTO remit_webhook_deliveries (id, org_id, payment_id, event_id, url, body, attempts, status, last_error, next_attempt_at, created_at)
         VALUES (?, ?, 'PAY-HELD-0', ?, 'https://bank.example/hook', '{}', 5, 'exhausted', ?, ?, ?)`,
      ).run(id, orgId, `ev-${id}`, `fetch failed (${id})`, at, at);
    }
    const again = (await call(h.base, 'GET', '/v1/console/dashboard', { cookie })).json['attention'] as typeof attention & { webhook_exhausted: number };
    assert.equal(again.webhook_exhausted, 1, 'one payment, however many deliveries');
    assert.deepEqual(again.items.filter((x) => x.kind === 'webhook').map((x) => [x.id, x.reason]),
      [['PAY-HELD-0', 'fetch failed (d2)']], 'listed once, with the latest error');
    // Another tenant sees none of it.
    const other = await signUp(h.base, 'other@example.com');
    const theirs = await call(h.base, 'GET', '/v1/console/dashboard', { cookie: other.cookie });
    assert.deepEqual((theirs.json['attention'] as { items: unknown[] }).items, []);
  } finally { h.close(); }
});

// ── the price list is validated on boot ────────────────────────────────────

test('a price list with a misspelt key refuses to load rather than billing at zero', () => {
  const saved = process.env['CONSOLE_PRICING'];
  const load = (): ReturnType<typeof loadConfig> => loadConfig({ env: 'test' } as Parameters<typeof loadConfig>[0]);
  try {
    process.env['CONSOLE_PRICING'] = JSON.stringify({
      currency: 'KRW', attest: { monthly_fee: 1, per_anchor: 0 },
      por: { monthly_fee: 0, per_snapshot: 0 }, remit: { monthly_fee: 0, per_setlement: 5 },
    });
    assert.throws(load, /remit\.per_setlement/);
    process.env['CONSOLE_PRICING'] = JSON.stringify({
      currency: 'won', attest: { monthly_fee: 0, per_anchor: 0 },
      por: { monthly_fee: 0, per_snapshot: 0 }, remit: { monthly_fee: 0, per_settlement: 0 },
    });
    assert.throws(load, /ISO 4217/);
    process.env['CONSOLE_PRICING'] = JSON.stringify({
      currency: 'KRW', attest: { monthly_fee: -1, per_anchor: 0 },
      por: { monthly_fee: 0, per_snapshot: 0 }, remit: { monthly_fee: 0, per_settlement: 0 },
    });
    assert.throws(load, /attest\.monthly_fee/);
    process.env['CONSOLE_PRICING'] = '';
    assert.equal(load().pricing.currency, 'KRW');
    assert.equal(load().pricing.remit.per_settlement, 0);
  } finally {
    if (saved === undefined) delete process.env['CONSOLE_PRICING']; else process.env['CONSOLE_PRICING'] = saved;
  }
});

// ── the settlement chain's explorer link ───────────────────────────────────

test('the settlement explorer template reaches the console and the remit meta only when configured', async () => {
  const saved = process.env['REMIT_EXPLORER_TX_URL'];
  delete process.env['REMIT_EXPLORER_TX_URL'];
  try {
    const bare = await start({}, { remit: true });
    try {
      const { body, cookie } = await signUp(bare.base, 'lead@example.com');
      // null, not '': the sandbox's USDC rail is a local chain nothing
      // indexes, and the page draws no link rather than a dead one.
      assert.equal(body['settlement_explorer_tx_url'], null);
      assert.equal((await call(bare.base, 'GET', '/v1/console/me', { cookie })).json['settlement_explorer_tx_url'], null);
      assert.equal((await call(bare.base, 'GET', '/v1/remit/meta')).json['explorer_tx_url'], null);
    } finally { bare.close(); }

    const template = 'https://etherscan.io/tx/{tx}';
    // The harness spreads overrides over the loaded config, so the whole
    // remit block travels with the one field that changes.
    const linked = await start({
      remit: { ...loadConfig({ env: 'test' } as Parameters<typeof loadConfig>[0]).remit, explorerTxUrl: template },
    }, { remit: true });
    try {
      const { cookie } = await signUp(linked.base, 'lead@example.com');
      assert.equal((await call(linked.base, 'GET', '/v1/console/me', { cookie })).json['settlement_explorer_tx_url'], template);
      assert.equal((await call(linked.base, 'GET', '/v1/remit/meta')).json['explorer_tx_url'], template);
    } finally { linked.close(); }
  } finally {
    if (saved === undefined) delete process.env['REMIT_EXPLORER_TX_URL']; else process.env['REMIT_EXPLORER_TX_URL'] = saved;
  }
});

test('a settlement explorer template that cannot take a hash refuses to load', () => {
  const saved = process.env['REMIT_EXPLORER_TX_URL'];
  const load = (): ReturnType<typeof loadConfig> => loadConfig({ env: 'test' } as Parameters<typeof loadConfig>[0]);
  try {
    process.env['REMIT_EXPLORER_TX_URL'] = 'https://etherscan.io/tx/';
    assert.throws(load, /\{tx\}/, 'no placeholder, no link');
    process.env['REMIT_EXPLORER_TX_URL'] = 'etherscan.io/tx/{tx}';
    assert.throws(load, /http:\/\/ or https:\/\//, 'a bare host would render as a relative link');
    process.env['REMIT_EXPLORER_TX_URL'] = 'https://etherscan.io/tx/{tx}';
    assert.equal(load().remit.explorerTxUrl, 'https://etherscan.io/tx/{tx}');
    process.env['REMIT_EXPLORER_TX_URL'] = '';
    assert.equal(load().remit.explorerTxUrl, '', 'unset is the sandbox default');
  } finally {
    if (saved === undefined) delete process.env['REMIT_EXPLORER_TX_URL']; else process.env['REMIT_EXPLORER_TX_URL'] = saved;
  }
});

test('a chain RPC that carries credentials or is not an http(s) URL refuses to load, and is never quoted', () => {
  const names = ['REMIT_CHAIN_RPC', 'POR_CHAIN_RPC'] as const;
  const saved = names.map((n) => process.env[n]);
  const load = (): ReturnType<typeof loadConfig> => loadConfig({ env: 'test' } as Parameters<typeof loadConfig>[0]);
  /** The boot stops, names the variable and the reason, and repeats nothing it was given. */
  const refused = (name: string, value: string, why: RegExp, secrets: string[]): void => {
    process.env[name] = value;
    assert.throws(load, (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      assert.match(message, new RegExp(name), value);
      assert.match(message, why, value);
      for (const s of secrets) assert.ok(!message.includes(s), `${s} must not appear in: ${message}`);
      return true;
    });
    delete process.env[name];
  };
  try {
    for (const n of names) delete process.env[n];
    refused('REMIT_CHAIN_RPC', 'https://rpcuser:s3cret@rpc.example:8545', /credentials/, ['s3cret', 'rpcuser', 'rpc.example']);
    refused('REMIT_CHAIN_RPC', '10.0.0.5:8545', /does not parse/, ['10.0.0.5']);
    refused('REMIT_CHAIN_RPC', 'ws://rpc.example:8546', /http:\/\/ or https:\/\//, ['rpc.example']);
    // The reserve measurement fetches its RPC the same way, and its report is served publicly.
    refused('POR_CHAIN_RPC', 'http://operator:hunter22@127.0.0.1:8545', /credentials/, ['operator', 'hunter22']);
    process.env['REMIT_CHAIN_RPC'] = 'https://rpc.example/v3/project';
    assert.equal(load().remit.chainRpc, 'https://rpc.example/v3/project');
    delete process.env['REMIT_CHAIN_RPC'];
    assert.equal(load().remit.chainRpc, 'http://127.0.0.1:8545', 'unset is the sandbox default');
  } finally {
    names.forEach((n, i) => {
      const v = saved[i];
      if (v === undefined) delete process.env[n]; else process.env[n] = v;
    });
  }
});

// ── the audit record ───────────────────────────────────────────────────────

test('serviceOf files each path under the product that answers it', () => {
  const cases: [string, string][] = [
    ['/v1/settlements', 'remit'], ['/v1/settlements/PAY-1/evidence', 'remit'], ['/v1/settlements/reconcile', 'remit'],
    ['/v1/quotes', 'remit'], ['/v1/manifests/daily', 'remit'], ['/v1/remit/meta', 'remit'],
    ['/v1/por/snapshots', 'por'], ['/v1/por/snapshots/abc/challenge', 'por'],
    ['/v1/attestations', 'attest'], ['/v1/attestations/abc/bundle', 'attest'], ['/v1/attestations/inscribe', 'attest'],
    ['/v1/issuer-keys', 'attest'], ['/v1/public/anchors', 'attest'], ['/v1/public/anchors/abc/bundle', 'attest'],
    ['/v1/console/attestations', 'attest'], ['/v1/console/attestations/signed', 'attest'],
    ['/v1/console/attestations/abc/bundle', 'attest'], ['/v1/console/tx/ab'.padEnd(78, 'c'), 'attest'],
    ['/v1/console/keys', 'console'], ['/v1/console/keys/k1/revoke', 'console'], ['/v1/console/issuer-keys', 'console'],
    ['/v1/console/products', 'console'], ['/v1/console/products/remit/deactivate', 'console'],
    ['/v1/console/institutions/VN-BANK-001/signing-key', 'console'], ['/v1/console/sandbox/evidence', 'console'],
    ['/v1/console/sessions/revoke-others', 'console'],
  ];
  for (const [p, expected] of cases) assert.equal(serviceOf(p), expected, p);
});

test('screen loads are silent in the audit; actions on the same paths are not', () => {
  for (const p of ['/v1/console/me', '/v1/console/dashboard', '/v1/console/products', '/v1/console/sandbox',
    '/v1/console/audit', '/healthz', '/readyz', '/v1/meta']) {
    assert.equal(isAudited('GET', p), false, p);
  }
  assert.equal(isAudited('POST', '/v1/console/products'), true, 'activating a product is an action');
  assert.equal(isAudited('GET', '/v1/console/attestations'), true, 'a record list is a read of customer data');
  assert.equal(isAudited('GET', '/v1/console/keys'), true);
  assert.equal(isAudited('POST', '/v1/console/sandbox/evidence'), true);
});

interface AuditRow {
  id: string; at: string; actor_type: string; actor_id: string; actor_label: string;
  service: string; method: string; path: string; status: number; duration_ms: number;
}

test('the audit log names who called what, per service, and skips what a screen load produces', async () => {
  const h = await start();
  try {
    const { cookie, body } = await signUp(h.base, 'auditor@example.com');
    const accountId = body['account']['id'] as string;
    const minted = await call(h.base, 'POST', '/v1/console/keys', { cookie, body: { label: 'ci-runner' } });
    assert.equal(minted.status, 201, JSON.stringify(minted.json));
    const key = minted.json['api_key_secret'] as string;
    const made = await call(h.base, 'POST', '/v1/attestations',
      { token: key, body: { leaf_bytes: sha256hex('an audited document') } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    // A refused call is a call: recorded with the status it got.
    const refused = await call(h.base, 'POST', '/v1/attestations', { token: key, body: { leaf_bytes: 'not-a-digest' } });
    assert.equal(refused.status, 400);
    // Screen loads: in the request stream, out of the record.
    assert.equal((await call(h.base, 'GET', '/v1/console/me', { cookie })).status, 200);
    assert.equal((await call(h.base, 'GET', '/v1/console/dashboard', { cookie })).status, 200);
    // Anonymous: never reached a tenant, so there is nowhere to file it.
    assert.equal((await call(h.base, 'GET', '/v1/attestations')).status, 401);

    const all = await call(h.base, 'GET', '/v1/console/audit', { cookie });
    assert.equal(all.status, 200, JSON.stringify(all.json));
    const rows = all.json['data'] as AuditRow[];
    assert.equal(all.json['page']['returned'], rows.length);
    assert.equal(all.json['page']['next_cursor'], null);
    const entry = (p: string, status: number): AuditRow | undefined => rows.find((r) => r.path === p && r.status === status);

    const keyCall = entry('/v1/console/keys', 201);
    assert.ok(keyCall, 'minting the key is a console action by the session');
    assert.deepEqual(
      [keyCall.method, keyCall.service, keyCall.actor_type, keyCall.actor_id, keyCall.actor_label],
      ['POST', 'console', 'session', accountId, 'auditor@example.com']);
    const anchor = entry('/v1/attestations', 201);
    assert.ok(anchor, 'the keyed call is an attest action by the key');
    assert.deepEqual(
      [anchor.method, anchor.service, anchor.actor_type, anchor.actor_id, anchor.actor_label],
      ['POST', 'attest', 'api_key', minted.json['id'], 'ci-runner'],
      'the key is named by its label, not its secret or its hash');
    assert.ok(entry('/v1/attestations', 400), 'a refused call is recorded with its status');
    for (const r of rows) {
      assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof r.duration_ms, 'number');
      assert.ok(r.duration_ms >= 0);
      assert.ok(!('org_id' in r), 'the tenant is the request, not a column');
      assert.ok(!JSON.stringify(r).includes(key), 'the secret never reaches the record');
    }
    for (const quiet of ['/v1/console/me', '/v1/console/dashboard', '/v1/console/audit']) {
      assert.equal(rows.filter((r) => r.path === quiet).length, 0, `${quiet} is a screen load`);
    }
    assert.equal(rows.filter((r) => r.status === 401).length, 0, 'anonymous calls have no tenant to be filed under');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.at >= rows[i]!.at, 'newest first');

    // Filters narrow; an unknown value is refused rather than matching nothing.
    const attest = (await call(h.base, 'GET', '/v1/console/audit?service=attest', { cookie })).json['data'] as AuditRow[];
    assert.ok(attest.length >= 2 && attest.every((r) => r.service === 'attest'), JSON.stringify(attest));
    assert.ok(attest.every((r) => r.path === '/v1/attestations'));
    const sessions = (await call(h.base, 'GET', '/v1/console/audit?actor_type=session', { cookie })).json['data'] as AuditRow[];
    assert.ok(sessions.length >= 1 && sessions.every((r) => r.actor_type === 'session'));
    assert.ok(sessions.some((r) => r.path === '/v1/console/keys'));
    assert.ok(!sessions.some((r) => r.path === '/v1/attestations'));
    const byPath = (await call(h.base, 'GET', '/v1/console/audit?q=KEYS', { cookie })).json['data'] as AuditRow[];
    assert.deepEqual(byPath.map((r) => r.path), ['/v1/console/keys'], 'the path search is case-insensitive');
    const bad = await call(h.base, 'GET', '/v1/console/audit?service=billing', { cookie });
    assert.equal(bad.status, 400);
    assert.equal(bad.json['error'], 'invalid_filter');
    assert.equal((await call(h.base, 'GET', '/v1/console/audit?actor_type=robot', { cookie })).json['error'], 'invalid_filter');
    assert.equal((await call(h.base, 'GET', '/v1/console/audit?from=yesterday', { cookie })).json['error'], 'invalid_filter');
    assert.equal((await call(h.base, 'GET', '/v1/console/audit?cursor=nope', { cookie })).json['error'], 'invalid_cursor');
    // A fractional page size is a page size, not a server error.
    const fractional = await call(h.base, 'GET', '/v1/console/audit?limit=2.5', { cookie });
    assert.equal(fractional.status, 200, JSON.stringify(fractional.json));
    assert.equal(fractional.json['page']['returned'], 2);

    // One row per page walks the same list in the same order, nothing repeated,
    // and the last page says it is the last.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await call(h.base, 'GET',
        `/v1/console/audit?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie });
      assert.equal(page.status, 200, JSON.stringify(page.json));
      const data = page.json['data'] as AuditRow[];
      assert.equal(data.length, 1);
      seen.push(data[0]!.id);
      cursor = page.json['page']['next_cursor'] as string | null;
    } while (cursor);
    assert.deepEqual(seen, rows.map((r) => r.id));
    assert.equal(new Set(seen).size, seen.length);

    // Sign-up opened the trail; sign-in is in it too.
    const opened = entry('/v1/console/signup', 201);
    assert.ok(opened, 'the sign-up is the first thing on record');
    assert.deepEqual([opened.service, opened.actor_type, opened.actor_label], ['console', 'session', 'auditor@example.com']);
    assert.equal((await call(h.base, 'POST', '/v1/console/login', { body: { email: 'auditor@example.com', password: PASSWORD } })).status, 200);
    assert.equal((await call(h.base, 'POST', '/v1/console/login', { body: { email: 'auditor@example.com', password: 'wrong-password-1' } })).status, 401);
    const signins = ((await call(h.base, 'GET', '/v1/console/audit?q=login', { cookie })).json['data'] as AuditRow[]);
    assert.deepEqual(signins.map((r) => r.status), [200], 'a successful sign-in is recorded; a failed one is not filed anywhere');

    // Another tenant sees only its own sign-up.
    const other = await signUp(h.base, 'other@example.com');
    const theirs = await call(h.base, 'GET', '/v1/console/audit', { cookie: other.cookie });
    assert.equal(theirs.status, 200);
    assert.deepEqual((theirs.json['data'] as AuditRow[]).map((r) => [r.path, r.actor_label]),
      [['/v1/console/signup', 'other@example.com']]);
  } finally { h.close(); }
});

test('the audit reader bounds time half-open, normalises offsets, and takes wildcards literally', async () => {
  const db = await openDb(':memory:');
  try {
    await db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES ('o1', 'o1', 'Org', '2026-01-01T00:00:00Z')").run();
    const put = (id: string, at: string, p: string): Promise<unknown> => db.prepare(
      `INSERT INTO audit_log (id, org_id, at, actor_type, actor_id, actor_label, service, method, path, status, duration_ms)
       VALUES (?, 'o1', ?, 'session', 'acc', 'a@example.com', ?, 'POST', ?, 200, 3)`).run(id, at, serviceOf(p), p);
    await put('e1', '2026-03-01T00:00:00.000Z', '/v1/console/keys');
    await put('e2', '2026-03-02T00:00:00.000Z', '/v1/attestations');
    await put('e3', '2026-03-03T00:00:00.000Z', '/v1/console/keys/k_1/revoke');
    const ids = async (s: Parameters<typeof searchAudit>[2]): Promise<string[]> =>
      (await searchAudit(db, 'o1', s)).items.map((e) => e.id);
    assert.deepEqual(await ids({}), ['e3', 'e2', 'e1'], 'newest first');
    assert.deepEqual(await ids({ from: '2026-03-02T00:00:00Z', to: '2026-03-03T00:00:00Z' }), ['e2'],
      'from is inclusive and to exclusive, so day ranges chain without overlap');
    assert.deepEqual(await ids({ from: '2026-03-02T09:00:00+09:00' }), ['e3', 'e2'],
      'a bound with an offset is normalised before the text comparison');
    assert.deepEqual(await ids({ q: 'k_1' }), ['e3'], 'underscore is literal');
    assert.deepEqual(await ids({ q: '%' }), [], 'percent is literal');
    assert.deepEqual(await ids({ q: 'KEYS' }), ['e3', 'e1'], 'case-insensitive');
    assert.deepEqual(await ids({ service: 'attest' }), ['e2']);
    const code = (want: string) => (e: unknown): boolean => (e as { code?: string }).code === want;
    await assert.rejects(searchAudit(db, 'o1', { from: 'yesterday' }), code('invalid_filter'));
    await assert.rejects(searchAudit(db, 'o1', { service: 'billing' }), code('invalid_filter'));
    await assert.rejects(searchAudit(db, 'o1', { cursor: 'nope' }), code('invalid_cursor'));
    // The limit is clamped, never trusted.
    assert.equal((await searchAudit(db, 'o1', { limit: 0 })).items.length, 1);
    assert.equal((await searchAudit(db, 'o1', { limit: 10_000 })).items.length, 3);
    // And whole: it is interpolated into the SQL, where 2.5 was a 500.
    assert.equal((await searchAudit(db, 'o1', { limit: 2.5 })).items.length, 2);
    assert.equal((await searchAudit(db, 'o1', { limit: Number.NaN })).items.length, 3, 'not a number: the default page');
    // The writer classifies the path and rounds the duration on the way in.
    await recordAudit(db, { orgId: 'o1', actorType: 'api_key', actorId: 'k1', actorLabel: 'ci' },
      { method: 'POST', path: '/v1/por/snapshots', status: 201, durationMs: 12.6 });
    const [latest] = (await searchAudit(db, 'o1', { limit: 1 })).items;
    assert.deepEqual([latest!.service, latest!.actor_type, latest!.actor_label, latest!.status, latest!.duration_ms],
      ['por', 'api_key', 'ci', 201, 13]);
  } finally { await db.close(); }
});

test('a failing request hook is reported, never surfaced to the caller', async () => {
  // The hook is what the audit write rides on. A tenant whose audit table is
  // unreachable must still get their attestation back — the record is a
  // record of calls, not a precondition of them.
  const r = new Router();
  r.errorMapper(() => new HttpResult(418, { error: 'teapot' }));
  r.get('/ping', () => ({ ok: true }));
  r.get('/fail', () => { throw new Error('handler failed'); });
  const seen: [string, number][] = [];
  r.onDone((ctx, status) => { seen.push([ctx.path, status]); throw new Error('audit store is down'); });
  const server = r.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${addr.port}`;
  const reported: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => { reported.push(args.map(String).join(' ')); };
  try {
    const ok = await fetch(`${base}/ping`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const failed = await fetch(`${base}/fail`);
    assert.equal(failed.status, 418);
    assert.deepEqual(seen, [['/ping', 200], ['/fail', 418]], 'the hook sees the status that went out, mapped errors included');
    assert.equal(reported.length, 2);
    assert.match(reported[0]!, /audit store is down/);
  } finally {
    console.error = original;
    server.closeAllConnections();
    server.close();
  }
});

// ── an institution's signing key is one of the org's registered keys ───────

const freshSpki = (): string => generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

/** A key as bare base64 DER, the way a caller pastes it: no PEM armour to say what it is. */
const der = (key: KeyObject, type: 'spki' | 'pkcs8' | 'sec1' | 'pkcs1'): string =>
  key.export({ format: 'der', type }).toString('base64');

/**
 * An issuer key written straight into the table, the way a row from before
 * registration checked keys would sit there — so a refusal from activation
 * or the signing-key switch is that route's own check, not registration's.
 */
async function storedKey(db: Harness['db'], orgId: string, publicKey: string): Promise<string> {
  const id = randomUUID();
  await db.prepare(
    `INSERT INTO issuer_keys (id, org_id, label, public_key, algorithm, created_at)
     VALUES (?, ?, 'stored before the check', ?, 'ES256', ?)`,
  ).run(id, orgId, publicKey, new Date().toISOString());
  return id;
}

test('an institution can be pointed at another registered key — the org’s own, live, and decodable', async () => {
  const h = await start({}, { remit: true });
  try {
    const { cookie, body } = await signUp(h.base, 'bank@example.com');
    const orgId = body['org']['id'] as string;
    const spki1 = freshSpki();
    const spki2 = freshSpki();
    const key1 = await h.svc.registerIssuerKey(orgId, spki1, 'hsm slot 1');
    const key2 = await h.svc.registerIssuerKey(orgId, spki2, 'hsm slot 2');
    // Activation, as POST /v1/console/products does it for the settlement product.
    const registry = new Registry(h.db);
    await registry.subscribe(orgId, 'remit', { institution_id: 'VN-BANK-SWAP' });
    await registry.upsert({ id: 'VN-BANK-SWAP', role: 'COLLECTION_BANK', name: 'Swap Bank', country: 'VN',
      org_id: orgId, signing_spki: spki1 });

    const before = await call(h.base, 'GET', '/v1/console/products', { cookie });
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json['institutions'][0]['id'], 'VN-BANK-SWAP');
    assert.equal(before.json['institutions'][0]['signing_spki'], spki1, 'the products screen says which key verifies');

    const path = '/v1/console/institutions/VN-BANK-SWAP/signing-key';
    const swapped = await call(h.base, 'POST', path, { cookie, body: { issuer_key_id: key2.id } });
    assert.equal(swapped.status, 200, JSON.stringify(swapped.json));
    assert.equal(swapped.json['institution_id'], 'VN-BANK-SWAP');
    assert.equal(swapped.json['issuer_key_id'], key2.id);
    assert.match(swapped.json['applied_at'] as string, /^\d{4}-\d{2}-\d{2}T/);
    const after = await call(h.base, 'GET', '/v1/console/products', { cookie });
    assert.equal(after.json['institutions'][0]['signing_spki'], spki2);
    const gate = await registry.requireRemit(orgId);
    assert.equal(gate.bank.signing_spki, spki2, 'the rail verifies with the new key from now on');

    // The previous key can now be revoked without touching the rail.
    assert.equal(await h.svc.revokeIssuerKey(orgId, key1.id), true);
    assert.equal((await registry.requireRemit(orgId)).bank.signing_spki, spki2);
    const revoked = await call(h.base, 'POST', path, { cookie, body: { issuer_key_id: key1.id } });
    assert.equal(revoked.status, 409);
    assert.equal(revoked.json['error'], 'key_revoked');

    // The sandbox's seeded placeholder is not a decodable key: pointing the
    // rail at it would break keyring construction for every tenant.
    const demo = await call(h.base, 'POST', path, { cookie, body: { issuer_key_id: body['issuer_keys'][0]['id'] } });
    assert.equal(demo.status, 400, JSON.stringify(demo.json));
    assert.equal(demo.json['error'], 'invalid_public_key');
    // Decoding is not the bar. Keys that decode yet cannot verify ES256, or
    // are not public at all, go straight into the table, so each refusal
    // below is the switch's own check and not registration's.
    for (const [what, material, code] of [
      ['a P-384 key', der(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey, 'spki'), 'unsupported_algorithm'],
      ['an RSA key', der(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, 'spki'), 'unsupported_algorithm'],
      ['a private key', der(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, 'pkcs8'), 'private_key_refused'],
    ] as const) {
      const refused = await call(h.base, 'POST', path, { cookie, body: { issuer_key_id: await storedKey(h.db, orgId, material) } });
      assert.equal(refused.status, 400, `${what}: ${JSON.stringify(refused.json)}`);
      assert.equal(refused.json['error'], code, what);
      assert.ok(!(refused.json['message'] as string).includes(material), `${what}: the material is never quoted back`);
    }
    assert.equal((await call(h.base, 'POST', path, { cookie, body: {} })).json['error'], 'missing_field');

    // Someone else's institution, someone else's key: 404 both ways, and no
    // hint which of the two exists.
    await registry.upsert({ id: 'SG-BFI-001', role: 'BENEFICIARY_FI', name: 'Partner BFI', country: 'SG' });
    const foreign = await call(h.base, 'POST', '/v1/console/institutions/SG-BFI-001/signing-key',
      { cookie, body: { issuer_key_id: key2.id } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json['error'], 'institution_not_found');
    const other = await signUp(h.base, 'other@example.com');
    const theirKey = await h.svc.registerIssuerKey(other.body['org']['id'] as string, freshSpki(), 'theirs');
    const stolen = await call(h.base, 'POST', path, { cookie, body: { issuer_key_id: theirKey.id } });
    assert.equal(stolen.status, 404);
    assert.equal(stolen.json['error'], 'issuer_key_not_found');
    const theirs = await call(h.base, 'POST', path, { cookie: other.cookie, body: { issuer_key_id: theirKey.id } });
    assert.equal(theirs.status, 404);
    assert.equal(theirs.json['error'], 'institution_not_found');
    assert.equal((await call(h.base, 'POST', path, { body: { issuer_key_id: key2.id } })).status, 401);
    assert.equal((await registry.requireRemit(orgId)).bank.signing_spki, spki2, 'none of the refusals touched the key');

    // The switch is a console action in the audit record, with its outcome.
    const audit = (await call(h.base, 'GET', '/v1/console/audit?q=signing-key', { cookie })).json['data'] as AuditRow[];
    assert.ok(audit.some((e) => e.path === path && e.status === 200 && e.service === 'console' && e.actor_label === 'bank@example.com'));
    assert.ok(audit.some((e) => e.path === path && e.status === 409));
  } finally { h.close(); }
});

// ── the settlement chain, asked about one transfer ─────────────────────────

test('a settlement\'s on-chain transfer can be looked up, by its owner only', async () => {
  const { createServer } = await import('node:http');
  // A one-method node: the transfer is pending in its mempool.
  const rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const { method } = JSON.parse(body) as { method: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1,
        result: method === 'eth_getTransactionByHash' ? { blockNumber: null, from: '0x1', to: '0x2' } : null }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => rpc.once('listening', () => r()));
  const port = (rpc.address() as { port: number }).port;
  const base = loadConfig({ env: 'test' } as Parameters<typeof loadConfig>[0]).remit;
  const h = await start({ remit: { ...base, chainRpc: `http://127.0.0.1:${port}`, explorerTxUrl: 'https://explorer.example/tx/{tx}' } }, { remit: true });
  try {
    const { cookie, body } = await signUp(h.base, 'chain@example.com');
    const orgId = body['org']['id'] as string;
    await h.db.prepare(
      `INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at)
       VALUES ('QC', ?, 'VN', 'SG', '{}', '{}', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(orgId);
    const store = new RemitStore(h.db);
    for (const id of ['PAY-CHAIN', 'PAY-NOCHAIN']) {
      await store.create({
        id, org_id: orgId, quote_id: 'QC', corridor_origin: 'VN', corridor_destination: 'SG',
        trade_currency: 'USD', trade_amount: '10.00', collect_currency: 'VND', collect_amount: '1',
        usdc_amount: '10.00', payout_currency: 'SGD', payout_amount: '13.35',
        beneficiary_institution: 'SG-BFI-001', request_body: '{}',
      });
    }
    const hash = `0x${'cd'.repeat(32)}`;
    await store.patch('PAY-CHAIN', { chain_tx: hash });

    const r = await call(h.base, 'GET', '/v1/settlements/PAY-CHAIN/chain', { cookie });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json['state'], 'pending');
    assert.equal(r.json['tx_hash'], hash);
    assert.equal(r.json['chain'], base.chainLabel);
    assert.equal(r.json['explorer_url'], `https://explorer.example/tx/${hash}`);
    assert.ok(!JSON.stringify(r.json).includes(String(port)), 'the RPC address never reaches the caller');

    const none = await call(h.base, 'GET', '/v1/settlements/PAY-NOCHAIN/chain', { cookie });
    assert.equal(none.status, 404);
    assert.equal(none.json['error'], 'no_chain_tx');
    const other = await signUp(h.base, 'stranger@example.com');
    assert.equal((await call(h.base, 'GET', '/v1/settlements/PAY-CHAIN/chain', { cookie: other.cookie })).status, 404,
      'another tenant cannot ask about this transfer');
    assert.equal((await call(h.base, 'GET', '/v1/settlements/PAY-CHAIN/chain')).status, 401);
  } finally { h.close(); rpc.closeAllConnections(); rpc.close(); }
});

// ── key material is checked where it comes in and where it is applied ──────

test('issuer-key registration refuses a private key, a key that cannot be ES256, and junk — and stores none', async () => {
  const h = await start();
  try {
    const { cookie } = await signUp(h.base, 'keys@example.com');
    const listed = async (): Promise<unknown> =>
      (await call(h.base, 'GET', '/v1/console/issuer-keys', { cookie })).json['data'];
    const before = await listed();
    const register = (publicKey: string, algorithm?: string): Promise<Reply> => call(h.base, 'POST', '/v1/console/issuer-keys',
      { cookie, body: { public_key: publicKey, label: 'attempt', ...(algorithm ? { algorithm } : {}) } });

    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const refusals: [what: string, material: string, algorithm: string | undefined, code: string][] = [
      // Bare base64 carries no armour saying PRIVATE KEY; only the DER does.
      ['a PKCS#8 private key', der(p256.privateKey, 'pkcs8'), undefined, 'private_key_refused'],
      ['a SEC1 private key', der(p256.privateKey, 'sec1'), undefined, 'private_key_refused'],
      ['a PKCS#1 private key, as RS256', der(rsa.privateKey, 'pkcs1'), 'RS256', 'private_key_refused'],
      ['a PEM private key', p256.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), undefined, 'private_key_refused'],
      // Each decodes; none is P-256. The first throws in the keyring, the rest fail every signature.
      ['brainpoolP256r1', der(generateKeyPairSync('ec', { namedCurve: 'brainpoolP256r1' }).publicKey, 'spki'), undefined, 'unsupported_algorithm'],
      ['secp256k1', der(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey, 'spki'), undefined, 'unsupported_algorithm'],
      ['P-384', der(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey, 'spki'), 'ES256', 'unsupported_algorithm'],
      ['an RSA key, as ES256', der(rsa.publicKey, 'spki'), undefined, 'unsupported_algorithm'],
      ['junk', 'bm90LWEta2V5', undefined, 'invalid_public_key'],
      ['junk, as RS256', 'bm90LWEta2V5', 'RS256', 'invalid_public_key'],
    ];
    for (const [what, material, algorithm, code] of refusals) {
      const r = await register(material, algorithm);
      assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json['error'], code, what);
      assert.match(r.json['message'] as string, /Nothing was stored\.$/, what);
      assert.ok(!(r.json['message'] as string).includes(material), `${what}: the material is never quoted back`);
    }
    assert.deepEqual(await listed(), before, 'nothing was stored, so nothing is listed');

    // What the door is for still opens: a P-256 key, and an RSA key under the algorithm it is.
    const ok = await register(der(p256.publicKey, 'spki'));
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const rs = await register(der(rsa.publicKey, 'spki'), 'RS256');
    assert.equal(rs.status, 201, JSON.stringify(rs.json));
  } finally { h.close(); }
});

test('activation refuses the signup placeholder and any key that cannot verify, and registers nothing with it', async () => {
  const h = await start({}, { remit: true });
  try {
    const { cookie, body } = await signUp(h.base, 'activate@example.com');
    const orgId = body['org']['id'] as string;
    // Every org is seeded with it, labelled ES256 — the label is all the old check read.
    const placeholder = (body['issuer_keys'] as { id: string; label: string }[])
      .find((k) => k.label === 'demo issuer (sandbox)');
    assert.ok(placeholder, 'signup still seeds the placeholder');
    const activate = (product: string, issuerKeyId: string): Promise<Reply> => call(h.base, 'POST', '/v1/console/products',
      { cookie, body: { product, institution: { name: 'Activation Test', country: 'VN' }, issuer_key_id: issuerKeyId } });

    const refusals: [what: string, keyId: string, code: string][] = [
      ['the placeholder', placeholder.id, 'invalid_public_key'],
      ['a P-384 key', await storedKey(h.db, orgId, der(generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey, 'spki')), 'unsupported_algorithm'],
      ['a private key', await storedKey(h.db, orgId, der(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, 'pkcs8')), 'private_key_refused'],
    ];
    for (const product of ['remit', 'por']) {
      for (const [what, keyId, code] of refusals) {
        const r = await activate(product, keyId);
        assert.equal(r.status, 400, `${product}, ${what}: ${JSON.stringify(r.json)}`);
        assert.equal(r.json['error'], code, `${product}, ${what}`);
      }
    }
    assert.deepEqual(await h.db.prepare('SELECT id FROM institutions WHERE org_id = ?').all(orgId), [],
      'no institution was registered with any of them');
    assert.equal(Number(((await h.db.prepare(
      "SELECT COUNT(*) AS n FROM institutions WHERE signing_spki = 'DEMO-PUBLIC-KEY-PLACEHOLDER'").get()) as { n: number }).n), 0);
    const registry = new Registry(h.db);
    assert.deepEqual((await registry.subscriptions(orgId)).map((s) => s.product), ['attest'], 'and nothing was subscribed');
    // The keyring every tenant's reconciliation shares still builds.
    await registry.keyring();

    const real = await h.svc.registerIssuerKey(orgId, freshSpki(), 'hsm');
    const ok = await activate('remit', real.id);
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
  } finally { h.close(); }
});

test('a path with doubled slashes is filed under the product that answered it', async () => {
  const h = await start();
  try {
    const { cookie } = await signUp(h.base, 'slashes@example.com');
    assert.equal((await call(h.base, 'GET', '/v1//attestations', { cookie })).status, 200,
      'the router ignores the empty segment');
    const rows = (await call(h.base, 'GET', '/v1/console/audit?service=attest', { cookie })).json['data'] as AuditRow[];
    assert.deepEqual(rows.map((r) => [r.method, r.path, r.service]), [['GET', '/v1/attestations', 'attest']]);
  } finally { h.close(); }
});

test('signed console anchors require the selected active key of the current organisation', async () => {
  const h = await start();
  try {
    const { buildStatement, statementSigningInput } = await import('../../../packages/attest-verify/src/index.ts');
    const { sign } = await import('node:crypto');
    const { cookie, body } = await signUp(h.base, 'signed-console@example.com');
    const orgId = body['org']['id'] as string;
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const key = await h.svc.registerIssuerKey(orgId, pub, 'document issuer');
    const request = buildStatement({ documentSha256: sha256hex('registered document'), keyId: key.id,
      publicKeySpkiBase64: pub, issuedAt: '2026-11-19T00:00:00Z' });
    const statement = { ...request, signature: sign('sha256', statementSigningInput(request),
      { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    const post = (payload: unknown) => call(h.base, 'POST', '/v1/console/attestations/signed', { cookie, body: payload });
    assert.equal((await post({ statement })).json['error'], 'missing_issuer_key');
    const otherKey = await h.svc.registerIssuerKey(orgId, freshSpki(), 'other issuer');
    const mismatched = await post({ statement, issuer_key_id: otherKey.id });
    assert.equal(mismatched.status, 400); assert.equal(mismatched.json['error'], 'issuer_key_mismatch');
    const other = await signUp(h.base, 'other-signing-org@example.com');
    const foreign = await h.svc.registerIssuerKey(other.body['org']['id'], pub, 'foreign issuer');
    assert.equal((await post({ statement, issuer_key_id: foreign.id })).status, 404);
    const tampered = await post({ statement: { ...statement, issued_at: '2026-11-20T00:00:00Z' }, issuer_key_id: key.id });
    assert.equal(tampered.status, 400);
    const accepted = await post({ statement, issuer_key_id: key.id });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json['issuer_trust'], 'registered');
    const count = async () => Number(((await h.db.prepare('SELECT COUNT(*) AS n FROM attestations WHERE org_id = ?').get(orgId)) as { n: number }).n);
    const before = await count();
    await h.svc.revokeIssuerKey(orgId, key.id);
    assert.equal((await post({ statement, issuer_key_id: key.id })).status, 404);
    assert.equal(await count(), before, 'a revoked-key submission writes no anchor');
  } finally { h.close(); }
});
