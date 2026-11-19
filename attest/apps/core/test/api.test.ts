/**
 * API integration — the real server, the real SQLite database, the real router.
 *
 * Only the chain is substituted, because the point here is the HTTP and storage
 * behaviour, not Bitcoin. The stub records what it was asked to commit and
 * returns a genuine transaction built by `btc/tx.ts`, so the bundle this test
 * exports is byte-identical in shape to one from a real node and is checked by
 * the independent verifier at the end, exactly as `roundtrip.test.ts` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { verifyBundle } from '@stonehash/attest-verify';
import { openDb } from '../src/db.ts';
import { AttestService } from '../src/service.ts';
import { buildRouter } from '../src/http/routes.ts';
import { loadConfig } from '../src/config.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from '../src/anchor/backend.ts';
import type { Server } from 'node:http';

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Builds a real transaction; never contacts a node. Confirms on demand. */
class StubBackend implements AnchorBackend {
  readonly network = 'regtest' as const;
  readonly name = 'stub:regtest';
  readonly submitted: string[] = [];
  private confirmAt: number | null = null;

  async submit(payload: Uint8Array): Promise<AnchorHandle> {
    this.submitted.push(bytesToHex(payload));
    const legacy = serializeLegacy(
      [{ txid: '22'.repeat(32), vout: 0 }],
      [{ value: 0, scriptPubKey: opReturnScript(payload) }],
    );
    return { txid: txidOf(legacy), rawTxHex: bytesToHex(legacy), anchorPayloadHex: bytesToHex(payload) };
  }
  async poll(): Promise<AnchorState> {
    return this.confirmAt === null
      ? { status: 'pending', confirmations: 0 }
      : { status: 'confirmed', blockHeight: this.confirmAt, blockHash: 'ab'.repeat(32), confirmations: 6 };
  }
  async health(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'stub' };
  }
  mine(height = 101): void { this.confirmAt = height; }
}

interface Harness {
  base: string;
  svc: AttestService;
  backend: StubBackend;
  publicOrgId: string;
  close: () => void;
}

/** `listen()` binds asynchronously, so the port is only known once it fires. */
async function start(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const db = await openDb(':memory:');
  const backend = new StubBackend();
  const cfg = loadConfig({
    env: 'test', host: '127.0.0.1', port: 0, dbPath: ':memory:',
    anchorBackend: 'regtest', bitcoinNetwork: 'regtest', workerTickMs: 0,
    ...overrides,
  } as Parameters<typeof loadConfig>[0]);
  const svc = new AttestService(db, backend, cfg.batch.maxLeaves);
  const publicOrgId = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
  const server: Server = buildRouter({ cfg, db, svc, backend, version: 'test', publicOrgId })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server did not bind a port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    svc, backend, publicOrgId,
    close: () => {
      // `fetch` keeps connections alive, and `server.close()` alone waits for
      // them — which would hang the test run rather than fail it.
      server.closeAllConnections();
      server.close();
      void db.close();
    },
  };
}

async function call(
  base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

test('healthz and meta answer without a key; meta states what the network can prove', async () => {
  const h = await start();
  try {
    assert.equal((await call(h.base, 'GET', '/healthz')).status, 200);
    const meta = await call(h.base, 'GET', '/v1/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.json['bitcoin_network'], 'regtest');
    assert.equal(meta.json['key_prefix'], 'sk_test_');
    assert.match(String(meta.json['public_verifiability']), /cannot be confirmed by a third party/);
  } finally { h.close(); }
});

test('attestation endpoints reject an absent or wrong-environment key', async () => {
  const h = await start();
  try {
    assert.equal((await call(h.base, 'GET', '/v1/attestations')).status, 401);
    // A production key presented to the sandbox is a misconfiguration, not a miss.
    const live = await call(h.base, 'GET', '/v1/attestations', { token: 'sk_live_whatever' });
    assert.equal(live.status, 401);
  } finally { h.close(); }
});

test('self-serve sandbox sign-up returns a usable key immediately — no approval step', async () => {
  const h = await start();
  try {
    const signup = await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'acme', name: 'Acme' } });
    assert.equal(signup.status, 201);
    const key = String(signup.json['api_key']);
    assert.ok(key.startsWith('sk_test_'), 'sandbox keys must be visibly test keys');

    const list = await call(h.base, 'GET', '/v1/attestations', { token: key });
    assert.equal(list.status, 200, 'the key must work on the very next call');
    assert.deepEqual(list.json['data'], []);

    // The same slug again must not mint a second key into the same org:
    // anyone who knew the name would otherwise get its records.
    const again = await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'acme' } });
    assert.equal(again.status, 409);
    assert.equal(again.json['error'], 'slug_taken');
  } finally { h.close(); }
});

test('full lifecycle: issue → batch → anchor → confirm → bundle verifies independently', async () => {
  const h = await start();
  try {
    const signup = await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'lifecycle' } });
    const token = String(signup.json['api_key']);

    const doc = `trade finance invoice ${randomUUID()}`;
    const created = await call(h.base, 'POST', '/v1/attestations', {
      token,
      body: { leaf_bytes: sha256hex(doc), content_type: 'application/pdf', descriptor: { ref: 'INV-2026-001' } },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json['status'], 'accepted');
    assert.equal(created.json['bundle_available'], false);
    const id = String(created.json['id']);

    // No proof exists yet, and the API says so rather than inventing one.
    const tooEarly = await call(h.base, 'GET', `/v1/attestations/${id}/bundle`, { token });
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.json['error'], 'not_batched');

    const batchId = await h.svc.sealBatch();
    assert.ok(batchId);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}`, { token })).json['status'], 'batched');

    // Sealed but not submitted is still not a proof.
    const notAnchored = await call(h.base, 'GET', `/v1/attestations/${id}/bundle`, { token });
    assert.equal(notAnchored.status, 409);
    assert.equal(notAnchored.json['error'], 'not_anchored');

    await h.svc.anchorBatch(batchId!);
    assert.equal(h.backend.submitted.length, 1);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}`, { token })).json['status'], 'submitted');

    // Submitted is not confirmed: the bundle is exportable but carries no block.
    const pendingBundle = await call(h.base, 'GET', `/v1/attestations/${id}/bundle`, { token });
    assert.equal(pendingBundle.status, 200);
    assert.equal((pendingBundle.json['anchor'] as Record<string, unknown>)['confirmed'], undefined);

    h.backend.mine(142);
    assert.equal(await h.svc.refreshConfirmations(), 1);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}`, { token })).json['status'], 'confirmed');

    const final = await call(h.base, 'GET', `/v1/attestations/${id}/bundle`, { token });
    assert.equal(final.status, 200);
    const anchor = final.json['anchor'] as Record<string, unknown>;
    assert.equal((anchor['confirmed'] as Record<string, unknown>)['block_height'], 142);

    // The payoff: the service's own output, checked by code that shares nothing
    // with it, against the original document.
    const report = verifyBundle(final.json as never, { originalBytes: new TextEncoder().encode(doc) });
    assert.equal(report.verified, true, report.checks.map((c) => `${c.state} ${c.id}`).join(' | '));
    assert.equal(report.links.A, 'pass');
    assert.equal(report.links.B, 'pass');
    assert.equal(report.links.C1, 'pass');
    assert.equal(report.links.C2, 'skip', 'a private chain can never satisfy C2 for a third party');
    assert.equal(report.network, 'regtest');
  } finally { h.close(); }
});

test('a duplicate digest is refused with a reason, not silently deduplicated', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'dup' } })).json['api_key']);
    const digest = sha256hex('same document twice');
    assert.equal((await call(h.base, 'POST', '/v1/attestations', { token, body: { leaf_bytes: digest } })).status, 201);
    const second = await call(h.base, 'POST', '/v1/attestations', { token, body: { leaf_bytes: digest } });
    assert.equal(second.status, 409);
    assert.equal(second.json['error'], 'duplicate_digest');
    assert.match(String(second.json['message']), /ambiguous/);
  } finally { h.close(); }
});

test('a malformed digest is rejected before it reaches storage', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'bad' } })).json['api_key']);
    for (const bad of ['', 'not-hex', 'ab', 'z'.repeat(64), sha256hex('x') + '00']) {
      const res = await call(h.base, 'POST', '/v1/attestations', { token, body: { leaf_bytes: bad } });
      assert.ok(res.status === 400, `digest ${JSON.stringify(bad)} should be rejected, got ${res.status}`);
    }
    const none = await call(h.base, 'POST', '/v1/attestations', { token, body: {} });
    assert.equal(none.status, 400);
    assert.equal(none.json['error'], 'missing_digest');
    assert.match(String(none.json['message']), /Hash locally/);
  } finally { h.close(); }
});

test('one org cannot read another org\'s attestation', async () => {
  const h = await start();
  try {
    const a = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'org-a' } })).json['api_key']);
    const b = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'org-b' } })).json['api_key']);
    const made = await call(h.base, 'POST', '/v1/attestations',
      { token: a, body: { leaf_bytes: sha256hex('private to a') } });
    const id = String(made.json['id']);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}`, { token: a })).status, 200);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}`, { token: b })).status, 404);
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${id}/bundle`, { token: b })).status, 404);
  } finally { h.close(); }
});

test('unknown routes 404 and bad JSON 400', async () => {
  const h = await start();
  try {
    assert.equal((await call(h.base, 'GET', '/v1/nope')).status, 404);
    const res = await fetch(`${h.base}/v1/sandbox/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Record<string, unknown>)['error'], 'invalid_json');
  } finally { h.close(); }
});

// ── settlement evidence ─────────────────────────────────────────────────────

/** The fixture and policy the Bank Review scenarios use. */
async function settlementInputs(): Promise<{ evidence: unknown; policy: unknown }> {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const p = await import('node:path');
  const here = p.dirname(fileURLToPath(import.meta.url));
  const rules = p.resolve(here, '../../../packages/attest-rules');
  return {
    evidence: JSON.parse(readFileSync(p.join(rules, 'fixtures/a-normal-trade-payment.json'), 'utf8')),
    policy: JSON.parse(readFileSync(p.join(rules, 'policies/settlement-match-v1.json'), 'utf8')),
  };
}

test('reconcile returns the six axis states and the policy digest', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'recon' } })).json['api_key']);
    const res = await call(h.base, 'POST', '/v1/settlements/reconcile', { token, body: await settlementInputs() });
    assert.equal(res.status, 200);
    const axes = res.json['axes'] as Record<string, { state: string }>;
    assert.equal(axes['matching']?.state, 'MATCH');
    assert.equal(axes['businessFinality']?.state, 'DEMO_ONLY');
    assert.equal(res.json['policyVersion'], 'settlement-match-v1');
    assert.match(String(res.json['policyDigest']), /^[0-9a-f]{64}$/);
    // The service must be unable to express a compliance determination either.
    assert.equal(res.json['regulatoryDecision'], 'NOT_EVALUATED');
  } finally { h.close(); }
});

test('reconcile refuses a request with no policy rather than applying a default', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'nopol' } })).json['api_key']);
    const { evidence } = await settlementInputs();
    const res = await call(h.base, 'POST', '/v1/settlements/reconcile', { token, body: { evidence } });
    assert.equal(res.status, 400);
    assert.equal(res.json['error'], 'missing_policy');
    // A default policy would produce verdicts nobody could reproduce.
    assert.match(String(res.json['message']), /would not be reproducible/);
  } finally { h.close(); }
});

test('reconcile rejects a policy it cannot evaluate deterministically', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'badpol' } })).json['api_key']);
    const { evidence, policy } = await settlementInputs();
    const res = await call(h.base, 'POST', '/v1/settlements/reconcile', {
      token, body: { evidence, policy: { ...(policy as object), settlementWindow: 'P1M' } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json['error'], 'invalid_policy');
  } finally { h.close(); }
});

test('the bundle endpoint returns a ZIP, its digest and a filename', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'bundle' } })).json['api_key']);
    const inputs = await settlementInputs();
    const res = await fetch(`${h.base}/v1/settlements/bundle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...inputs, bundleId: 'EV-TEST-0001', generatedAt: '2026-03-04T09:02:00Z' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') ?? '', /stonehash-evidence-EV-TEST-0001\.zip/);
    const digest = res.headers.get('x-evidence-sha256');
    assert.match(digest ?? '', /^[0-9a-f]{64}$/);

    const zip = new Uint8Array(await res.arrayBuffer());
    // Local file header magic — the response really is an archive.
    assert.deepEqual([...zip.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(zip).digest('hex'), digest,
      'the advertised digest must match the bytes delivered');

    // Extract with the system unzip: the archive has to open in whatever the
    // reviewer already has, not only in our own reader.
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const p = await import('node:path');
    const dir = mkdtempSync(p.join(tmpdir(), 'api-ev-'));
    try {
      const file = p.join(dir, 'b.zip');
      writeFileSync(file, zip);
      assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
      execFileSync('unzip', ['-q', file, '-d', dir]);
      const manifest = JSON.parse(readFileSync(p.join(dir, 'manifest.json'), 'utf8')) as {
        bundleId: string; dataMode: string; limitations: string[];
      };
      assert.equal(manifest.bundleId, 'EV-TEST-0001');
      assert.equal(manifest.dataMode, 'SYNTHETIC');
      assert.ok(manifest.limitations.some((l) => /synthetic/i.test(l)));
      assert.match(readFileSync(p.join(dir, 'verification-report.pdf')).subarray(0, 8).toString('latin1'),
        /^%PDF-1\.4$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally { h.close(); }
});

test('two bundle requests for the same evidence return identical archives', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'repro' } })).json['api_key']);
    const body = JSON.stringify({
      ...(await settlementInputs()), bundleId: 'EV-SAME', generatedAt: '2026-03-04T09:02:00Z',
    });
    const req = (): Promise<Response> => fetch(`${h.base}/v1/settlements/bundle`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    const [a, b] = await Promise.all([req(), req()]);
    assert.equal(a.headers.get('x-evidence-sha256'), b.headers.get('x-evidence-sha256'));
    assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
  } finally { h.close(); }
});

test('settlement endpoints require a key like everything else', async () => {
  const h = await start();
  try {
    assert.equal((await call(h.base, 'POST', '/v1/settlements/reconcile', { body: {} })).status, 401);
    assert.equal((await call(h.base, 'POST', '/v1/settlements/bundle', { body: {} })).status, 401);
  } finally { h.close(); }
});

// ── free tier (no signup) ───────────────────────────────────────────────────

test('a digest can be anchored with no account and no key', async () => {
  const h = await start();
  try {
    const digest = sha256hex('a document I hashed myself');
    const res = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: digest } });
    assert.equal(res.status, 202, 'accepted, not completed — it joins the next shared batch');
    assert.equal(res.json['sha256'], digest);
    assert.equal(res.json['status'], 'accepted');
    assert.equal(res.json['bundle_available'], false);
    assert.equal(res.json['bundle_url'], null);
    assert.ok(res.json['retrievable_until'], 'the retention window must be stated up front');
    // The network and its limits travel with every response, not only the UI.
    assert.equal(res.json['bitcoin_network'], 'regtest');
    assert.match(String(res.json['public_verifiability']), /cannot be confirmed by a third party/);
  } finally { h.close(); }
});

test('the free tier refuses anything that is not a 32-byte digest', async () => {
  const h = await start();
  try {
    for (const bad of [{}, { sha256: '' }, { sha256: 'nope' }, { sha256: 'ab' },
      { sha256: sha256hex('x') + '00' }, { sha256: 123 }]) {
      const res = await call(h.base, 'POST', '/v1/public/anchors', { body: bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} should be refused`);
      assert.equal(res.json['error'], 'invalid_digest');
    }
    // There is no field a caller could use to store content, which is why
    // there is nothing abusive to host and nothing to moderate.
    const res = await call(h.base, 'POST', '/v1/public/anchors',
      { body: { sha256: sha256hex('ok'), content: 'please host this for me' } });
    assert.equal(res.status, 202);
    assert.equal(res.json['content'], undefined);
  } finally { h.close(); }
});

test('the per-address rate limit holds and says when to retry', async () => {
  const h = await start();
  try {
    const max = 10; // PUBLIC_ANCHOR_MAX default
    for (let i = 0; i < max; i++) {
      const r = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex(`doc-${i}`) } });
      assert.equal(r.status, 202, `request ${i + 1} should be accepted`);
    }
    const blocked = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex('one too many') } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json['error'], 'rate_limited');
    // A dead end is unhelpful: point at the self-serve way to raise the limit.
    assert.match(String(blocked.json['message']), /sandbox key/i);
  } finally { h.close(); }
});

test('anchoring the same digest twice returns the existing record, not a duplicate', async () => {
  const h = await start();
  try {
    const digest = sha256hex('the very same bytes');
    const first = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: digest } });
    assert.equal(first.status, 202);
    const second = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: digest } });
    assert.equal(second.status, 200, 'already anchored is a useful answer, not an error');
    assert.equal(second.json['id'], first.json['id']);
    assert.match(String(second.json['note']), /already anchored/);
  } finally { h.close(); }
});

test('status and bundle are reachable by id alone, and the bundle verifies', async () => {
  const h = await start();
  try {
    const doc = 'free tier end to end';
    const res = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex(doc) } });
    const id = String(res.json['id']);

    // No proof exists before the batch is anchored, and the API says so.
    assert.equal((await call(h.base, 'GET', `/v1/public/anchors/${id}/bundle`)).status, 409);

    const batchId = await h.svc.sealBatch();
    await h.svc.anchorBatch(batchId!);
    h.backend.mine(207);
    await h.svc.refreshConfirmations();

    const status = await call(h.base, 'GET', `/v1/public/anchors/${id}`);
    assert.equal(status.status, 200);
    assert.equal(status.json['status'], 'confirmed');
    assert.equal(status.json['bundle_available'], true);

    const bundle = await call(h.base, 'GET', `/v1/public/anchors/${id}/bundle`);
    assert.equal(bundle.status, 200);
    // The payoff: a visitor with no account gets something the independent
    // verifier accepts, checked against their own file.
    const report = verifyBundle(bundle.json as never, { originalBytes: new TextEncoder().encode(doc) });
    assert.equal(report.verified, true, report.checks.map((c) => `${c.state} ${c.id}`).join(' | '));
    assert.equal(report.links.A, 'pass');
    assert.equal(report.links.C2, 'skip', 'a private chain cannot satisfy C2 for a third party');
  } finally { h.close(); }
});

test('a free-tier id cannot reach a keyed customer\'s record, or the reverse', async () => {
  const h = await start();
  try {
    const token = String((await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'iso' } })).json['api_key']);
    const keyed = await call(h.base, 'POST', '/v1/attestations',
      { token, body: { leaf_bytes: sha256hex('customer document') } });
    const keyedId = String(keyed.json['id']);
    // The free-tier lookup is scoped to source='public', so a guessed id cannot
    // reach a customer record even though neither path is authenticated by org.
    assert.equal((await call(h.base, 'GET', `/v1/public/anchors/${keyedId}`)).status, 404);
    assert.equal((await call(h.base, 'GET', `/v1/public/anchors/${keyedId}/bundle`)).status, 404);

    const free = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex('free document') } });
    const freeId = String(free.json['id']);
    // And a customer key cannot read the free-tier record either: it belongs to
    // a different org.
    assert.equal((await call(h.base, 'GET', `/v1/attestations/${freeId}`, { token })).status, 404);
  } finally { h.close(); }
});

test('CORS is granted on the free tier and preflight is answered', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/v1/public/anchors`, {
      method: 'OPTIONS', headers: { origin: 'https://playground.example' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);

    const post = await fetch(`${h.base}/v1/public/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://playground.example' },
      body: JSON.stringify({ sha256: sha256hex('cors') }),
    });
    assert.equal(post.headers.get('access-control-allow-origin'), '*');
  } finally { h.close(); }
});

test('the keyed API is not opened up by the free tier\'s CORS', async () => {
  const h = await start();
  try {
    const res = await fetch(`${h.base}/v1/attestations`, {
      method: 'GET', headers: { origin: 'https://evil.example' },
    });
    // Scoped deliberately: the keyed API is called from servers and has no
    // reason to be reachable from an arbitrary page.
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally { h.close(); }
});

test('expired free-tier records are purged; the bundle outlives them', async () => {
  const h = await start();
  try {
    const res = await call(h.base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex('ephemeral') } });
    const id = String(res.json['id']);
    const batchId = await h.svc.sealBatch();
    await h.svc.anchorBatch(batchId!);

    // Nothing expires yet.
    assert.equal(await h.svc.purgeExpiredPublic(new Date()), 0);
    assert.ok(await h.svc.getPublic(id));

    // Far enough in the future that the retention window has elapsed.
    const later = new Date(Date.now() + 400 * 86_400_000);
    assert.equal(await h.svc.purgeExpiredPublic(later), 1);
    assert.equal(await h.svc.getPublic(id), null);
    const gone = await call(h.base, 'GET', `/v1/public/anchors/${id}`);
    assert.equal(gone.status, 404);
    assert.match(String(gone.json['message']), /verifiable indefinitely without us/);
  } finally { h.close(); }
});

test('meta advertises the free tier and its limits', async () => {
  const h = await start();
  try {
    const meta = (await call(h.base, 'GET', '/v1/meta')).json;
    const free = meta['free_tier'] as Record<string, unknown>;
    assert.equal(free['signup_required'], false);
    assert.equal(free['endpoint'], '/v1/public/anchors');
    assert.ok(Number(free['per_address_per_hour']) > 0);
    assert.ok(Number(free['retention_days']) > 0);
  } finally { h.close(); }
});

test('the free tier can be switched off without affecting the keyed API', async () => {
  const db = await openDb(':memory:');
  const backend = new StubBackend();
  const cfg = loadConfig({
    env: 'test', host: '127.0.0.1', port: 0, dbPath: ':memory:', workerTickMs: 0,
    publicAnchor: { ...loadConfig().publicAnchor, enabled: false },
  });
  const svc = new AttestService(db, backend, cfg.batch.maxLeaves);
  const publicOrgId = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
  const server = buildRouter({ cfg, db, svc, backend, version: 'test', publicOrgId }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => { server.once('listening', resolve); });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const res = await call(base, 'POST', '/v1/public/anchors', { body: { sha256: sha256hex('off') } });
    assert.equal(res.status, 503);
    assert.equal(res.json['error'], 'free_tier_disabled');
    assert.equal((await call(base, 'GET', '/v1/meta')).json['free_tier'], null);
    // The keyed path is untouched.
    assert.equal((await call(base, 'POST', '/v1/sandbox/keys', { body: { slug: 'still-works' } })).status, 201);
  } finally {
    server.closeAllConnections(); server.close(); void db.close();
  }
});

test('a mount without its trailing slash redirects rather than serving a broken page', async () => {
  /*
   * `/playground` used to return the index with a 200, which looks correct
   * until you notice every relative reference in it resolved one level too
   * high: `./app.css` became `/app.css` and 404d. The visitor got unstyled
   * markup with no script and nothing to explain why — served and broken at
   * the same time.
   */
  const h = await start({ playgroundDir: '/tmp' });
  try {
    const res = await fetch(`${h.base}/playground`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/playground/');

    // The query has to survive, or a redirect silently drops parameters.
    const withQuery = await fetch(`${h.base}/playground?lang=ko`, { redirect: 'manual' });
    assert.equal(withQuery.headers.get('location'), '/playground/?lang=ko');
  } finally { h.close(); }
});

test('the bare address goes to the console instead of the JSON 404', async () => {
  /*
   * Nothing lives at `/`, so a browser pointed at the host alone used to get
   * `{"error":"not_found","message":"no route for GET /"}` — which reads as an
   * outage to anyone who is not looking for an endpoint.
   *
   * The console is the landing because it settles the session itself: it
   * shows the dashboard to someone signed in and the sign-in screen to anyone
   * else, so the redirect needs no knowledge of who is asking.
   */
  const h = await start({ playgroundDir: '/tmp', docsDir: '/tmp', consoleDir: '/tmp' });
  try {
    const res = await fetch(`${h.base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302, 'temporary, so the landing can change later');
    assert.equal(res.headers.get('location'), '/console/', 'dashboard when signed in, sign-in screen otherwise');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    // The query is how the language is chosen, so it has to survive.
    const withQuery = await fetch(`${h.base}/?lang=ko`, { redirect: 'manual' });
    assert.equal(withQuery.headers.get('location'), '/console/?lang=ko');

    // The same answer with or without a session cookie: the console decides.
    const anonymous = await call(h.base, 'GET', '/v1/console/me');
    assert.equal(anonymous.status, 401, 'no session, so the console shows its sign-in screen');

    // Only the bare address is claimed: an unknown path is still the API's own
    // 404, and a write to `/` is not turned into a redirect.
    const miss = await call(h.base, 'GET', '/nope');
    assert.equal(miss.status, 404);
    assert.equal(miss.json['error'], 'not_found');
    assert.equal((await call(h.base, 'POST', '/', { body: {} })).status, 404);

    // A target that names another host still lands on the local screen.
    const odd = await fetch(`${h.base}//example.com/`, { redirect: 'manual' });
    assert.ok([302, 404].includes(odd.status));
    if (odd.status === 302) assert.equal(odd.headers.get('location'), '/console/');
  } finally { h.close(); }

  // Without a console the hub stands in, then whichever screen is mounted;
  // with nothing mounted — the production API host — `/` stays a 404 rather
  // than pointing at a screen that is not there.
  const noConsole = await start({ playgroundDir: '/tmp', docsDir: '/tmp' });
  try {
    const res = await fetch(`${noConsole.base}/`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/docs/');
  } finally { noConsole.close(); }
  const playgroundOnly = await start({ playgroundDir: '/tmp' });
  try {
    const res = await fetch(`${playgroundOnly.base}/`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/playground/');
  } finally { playgroundOnly.close(); }
  const apiOnly = await start();
  try {
    const res = await call(apiOnly.base, 'GET', '/');
    assert.equal(res.status, 404);
    assert.equal(res.json['message'], 'no route for GET /');
  } finally { apiOnly.close(); }
});

test('a malformed escape is a 400 on an API route and on a static mount, and the server keeps answering', async () => {
  // Both used to throw outside the router's error mapping: unauthenticated,
  // one request was enough to end the process under plain node, or to leave
  // the request hanging under pm2.
  const h = await start({ consoleDir: '/tmp' });
  try {
    const api = await fetch(`${h.base}/v1/public/anchors/%E0`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(api.status, 400);
    assert.equal(((await api.json()) as { error: string }).error, 'invalid_path');
    const file = await fetch(`${h.base}/console/%E0`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(file.status, 400, 'the console mount answers it, rather than the router 404ing it');
    assert.equal((await call(h.base, 'GET', '/healthz')).status, 200);
  } finally { h.close(); }
});

test('issuer keys register over the keyed API, idempotently, and reject junk', async () => {
  const h = await start();
  try {
    const minted = await call(h.base, 'POST', '/v1/sandbox/keys', { body: { slug: 'issuer-sdk' } });
    const token = String(minted.json['api_key']);

    const { generateKeyPairSync } = await import('node:crypto');
    const spki = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

    const first = await call(h.base, 'POST', '/v1/issuer-keys',
      { token, body: { public_key: spki, label: 'hsm #1' } });
    assert.equal(first.status, 201);
    assert.equal(first.json['already'], false);

    // Same material again: the existing id, not a duplicate row.
    const again = await call(h.base, 'POST', '/v1/issuer-keys',
      { token, body: { public_key: spki, label: 'renamed attempt' } });
    assert.equal(again.status, 200);
    assert.equal(again.json['already'], true);
    assert.equal(again.json['id'], first.json['id']);

    const list = await call(h.base, 'GET', '/v1/issuer-keys', { token });
    assert.equal(list.status, 200);
    const rows = list.json['data'] as { id: string; public_key: string }[];
    assert.ok(rows.some((r) => r.id === first.json['id'] && r.public_key === spki),
      'the registered key must appear in the list the console activation reads');

    // Junk is refused at the door, not at the first failed signature.
    const bad = await call(h.base, 'POST', '/v1/issuer-keys',
      { token, body: { public_key: 'bm90LWEta2V5' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json['error'], 'invalid_public_key');

    // The same door the console uses: a private key is refused by name, and an
    // ES256 key must be P-256 — neither is stored.
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pkcs8 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const priv = await call(h.base, 'POST', '/v1/issuer-keys', { token, body: { public_key: pkcs8 } });
    assert.equal(priv.status, 400);
    assert.equal(priv.json['error'], 'private_key_refused');
    assert.ok(!JSON.stringify(priv.json).includes(pkcs8.slice(0, 40)), 'the refusal never echoes the key');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
      .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const curve = await call(h.base, 'POST', '/v1/issuer-keys', { token, body: { public_key: p384 } });
    assert.equal(curve.status, 400);
    assert.equal(curve.json['error'], 'unsupported_algorithm');
    const after = await call(h.base, 'GET', '/v1/issuer-keys', { token });
    assert.equal((after.json['data'] as unknown[]).length, (list.json['data'] as unknown[]).length, 'nothing refused was stored');

    // No key, no registration.
    assert.equal((await call(h.base, 'POST', '/v1/issuer-keys',
      { body: { public_key: spki } })).status, 401);
  } finally { h.close(); }
});

test('a list\'s ?limit= is a whole page size, whatever is sent', async () => {
  const { pageLimit } = await import('../src/http/server.ts');
  assert.equal(pageLimit('2.5', 50, 500), 2);
  assert.equal(pageLimit('-1', 50, 500), 50);
  assert.equal(pageLimit('0', 50, 500), 50);
  assert.equal(pageLimit('abc', 50, 500), 50);
  assert.equal(pageLimit(null, 50, 500), 50);
  assert.equal(pageLimit('9999', 50, 500), 500);
});
