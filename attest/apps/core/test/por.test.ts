/**
 * Proof of reserves, both ways in — real router, real SQLite, real ES256.
 *
 * An exchange will not let account-level data leave its premises, so the
 * default path anchors the signed statement and opens nothing; the spot check
 * is there when the exchange asks for it. These tests hold the API to the two
 * sentences that decision came with: every snapshot says publicly which path
 * it took, and the platform never reports a sample it did not take.
 *
 * The exchange side is the SDK's own. The tree, the statement and the
 * openings are built with `@stonehash/attest-por` as a customer builds them,
 * and signed with the event convention the registry verifies. The tenant is
 * set up through the routes a customer uses: signup, key registration,
 * product activation.
 *
 * Only the chains are substituted: Bitcoin by a stub backend, and the reserve
 * chain by a one-method node a test starts itself. The configured default for
 * the latter is a real node on the machine, which a test must never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PorClient, buildPorTree, buildSnapshotStatement, leafFromRow, loadTreeDir, provePorLeaf, readLiabilitiesCsv, writeTreeDir,
} from '@stonehash/attest-por';
import type { PorLeafInput, PorSnapshotStatement, PorTree } from '@stonehash/attest-por';
import { porSnapshotCommitment, porUserRefHash, verifyBundle, verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import { openDb } from '../src/db.ts';
import { AttestService } from '../src/service.ts';
import { Registry } from '../src/remit/registry.ts';
import { RemitStore } from '../src/remit/store.ts';
import { RemitOrchestrator } from '../src/remit/orchestrator.ts';
import { WebhookOutbox } from '../src/remit/webhook.ts';
import { TripleAProfileSim } from '../src/remit/partners-client.ts';
import { loadOrCreatePlatformKey, signEvent, spkiFromPublicKey, verifyEvent } from '../src/remit/sign.ts';
import type { EventSig } from '../src/remit/sign.ts';
import type { RemitServices } from '../src/remit/routes.ts';
import { buildRouter } from '../src/http/routes.ts';
import { backfillSnapshotKeys } from '../src/por/routes.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { opReturnScript, serializeLegacy, txidOf, bytesToHex } from '../src/btc/tx.ts';
import type { AnchorBackend, AnchorHandle, AnchorState } from '../src/anchor/backend.ts';

// ── the harness: console.test.ts's, with the rail always on ────────────────

/** Builds a real transaction; never contacts a node. Confirms on demand. */
class StubBackend implements AnchorBackend {
  readonly network = 'regtest' as const;
  readonly name = 'stub:regtest';
  private confirmAt: number | null = null;

  async submit(payload: Uint8Array): Promise<AnchorHandle> {
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
  async health(): Promise<{ ok: boolean }> { return { ok: true }; }
  mine(height: number): void { this.confirmAt = height; }
}

interface Harness {
  base: string;
  svc: AttestService;
  db: Awaited<ReturnType<typeof openDb>>;
  backend: StubBackend;
  /** The label a declared reserve address must carry for the platform to measure it. */
  chainLabel: string;
  close: () => void;
}

/**
 * The rail as main.ts wires it, against the in-memory db: the PoR routes are
 * mounted only when the router receives it. The partner simulator is
 * constructed and never called; the platform key lives in a temp directory.
 */
function remitServices(db: Harness['db'], svc: AttestService, cfg: Config): { remit: RemitServices; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-remit-'));
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

/**
 * Where reserve measurement points when a test brings no node of its own.
 * Port 1 is one fetch refuses to connect to at all, so a statement that
 * reached the measurement by mistake reads UNREACHABLE instead of a chain.
 */
const NO_RESERVE_NODE = 'http://127.0.0.1:1';

async function start(opts: { reserveRpc?: string } = {}): Promise<Harness> {
  const db = await openDb(':memory:');
  const backend = new StubBackend();
  const loaded = loadConfig({
    env: 'test', host: '127.0.0.1', port: 0, dbPath: ':memory:',
    anchorBackend: 'regtest', bitcoinNetwork: 'regtest', workerTickMs: 0,
  } as Parameters<typeof loadConfig>[0]);
  const cfg: Config = { ...loaded, remit: { ...loaded.remit, porChainRpc: opts.reserveRpc ?? NO_RESERVE_NODE } };
  const svc = new AttestService(db, backend, cfg.batch.maxLeaves);
  const publicOrgId = await svc.ensureOrg('public-free-tier', 'Public free tier (no signup)');
  const rail = remitServices(db, svc, cfg);
  const server: Server = buildRouter({ cfg, db, svc, backend, version: 'test', publicOrgId, remit: rail.remit })
    .listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server did not bind a port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    svc, db, backend,
    chainLabel: cfg.remit.chainLabel,
    close: () => { server.closeAllConnections(); server.close(); void db.close(); rail.cleanup(); },
  };
}

interface ReserveNode { url: string; calls: () => number; close: () => void }

/**
 * A one-method reserve chain: every `balanceOf` reads `balance`, after
 * `delayMs`. It counts what it was asked, so a test can say the platform
 * measured once — or never asked at all.
 */
async function reserveNode(balance: bigint, delayMs = 0): Promise<ReserveNode> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: `0x${balance.toString(16).padStart(64, '0')}` }));
      }, delayMs);
    });
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('reserve node did not bind a port');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls: () => calls,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

interface Reply { status: number; json: Record<string, any> }

/** `cookie` is the console's credential, `token` the keyed API's. */
async function call(
  base: string, method: string, route: string,
  opts: { body?: unknown; cookie?: string; token?: string } = {},
): Promise<Reply & { cookie: string | undefined }> {
  const res = await fetch(`${base}${route}`, {
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
    cookie: setCookie ? setCookie.split(';')[0] : undefined,
  };
}

/** Rows as plain objects: node:sqlite returns them without a prototype, which deepEqual tells apart from a literal. */
const rows = async <T>(h: Harness, sql: string, ...params: string[]): Promise<T[]> =>
  (await h.db.prepare(sql).all(...params)).map((r) => ({ ...(r as object) }) as T);

const count = async (h: Harness, sql: string, ...params: string[]): Promise<number> =>
  Number((await rows<{ n: number }>(h, sql, ...params))[0]!.n);

// ── the exchange: a tenant, a registered key, a book of liabilities ────────

interface Tenant { cookie: string; token: string; orgId: string }

async function signUp(h: Harness, email: string): Promise<Tenant> {
  const r = await call(h.base, 'POST', '/v1/console/signup', { body: { email, password: 'correct-horse-battery' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.cookie, 'signup must set a session cookie');
  return { cookie: r.cookie, token: r.json['api_key_secret'] as string, orgId: r.json['org']['id'] as string };
}

interface Exchange extends Tenant { institutionId: string; name: string; key: KeyObject; issuerKeyId: string }

/**
 * An organisation ready to publish snapshots, set up the way a customer does
 * it: the public half of a locally generated key registered over the keyed
 * API, then Proof of Reserves activated in the console with that key.
 */
async function exchange(h: Harness, email: string, name: string): Promise<Exchange> {
  const tenant = await signUp(h, email);
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const registered = await call(h.base, 'POST', '/v1/issuer-keys',
    { token: tenant.token, body: { public_key: spkiFromPublicKey(pair.publicKey), label: 'exchange signing key' } });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));
  const activated = await call(h.base, 'POST', '/v1/console/products', {
    cookie: tenant.cookie,
    body: { product: 'por', institution: { name, country: 'KR' }, issuer_key_id: registered.json['id'] },
  });
  assert.equal(activated.status, 201, JSON.stringify(activated.json));
  return {
    ...tenant, institutionId: activated.json['institution_id'] as string, name,
    key: pair.privateKey, issuerKeyId: registered.json['id'] as string,
  };
}

/** The public half of a private key, as the registry holds it. */
const publicHalf = (key: KeyObject): KeyObject => createPublicKey(key);

const ASSETS = ['BTC', 'USDT'];
/** Every account holds this much USDT, so a test can state the total — and the coverage — exactly. */
const USDT_PER_ACCOUNT = 250_000n;

/** A liabilities book of `accounts` customers. It never leaves this file, as it never leaves the exchange. */
function book(institutionId: string, accounts: number): PorLeafInput[] {
  return Array.from({ length: accounts }, (_, i) => {
    const userRef = `acct-${String(i + 1).padStart(4, '0')}`;
    return {
      user_ref: userRef,
      user_ref_hash: porUserRefHash(institutionId, userRef),
      salt: createHash('sha256').update(`salt for ${userRef}`).digest('hex'),
      balances: { BTC: String(1_000 + i), USDT: USDT_PER_ACCOUNT.toString() },
    };
  });
}

type Reserves = NonNullable<PorSnapshotStatement['reserves']>;

interface Snapshot { leaves: PorLeafInput[]; tree: PorTree; statement: PorSnapshotStatement; sig: EventSig }

/** What the SDK produces on the exchange's machine: the tree stays, the signed statement travels. */
function snapshot(ex: Exchange, accounts: number, opts: { asof?: string; reserves?: Reserves['entries'] } = {}): Snapshot {
  const leaves = book(ex.institutionId, accounts);
  const tree = buildPorTree(leaves, ASSETS);
  const statement = buildSnapshotStatement({
    institutionId: ex.institutionId,
    name: ex.name,
    asof: opts.asof ?? '2026-11-16T00:00:00.000Z',
    assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'USDT', decimals: 6 }],
    ...(opts.reserves
      ? { reserves: { mode: 'DECLARED', entries: opts.reserves, note: 'declared by the exchange' } }
      : {}),
  }, tree);
  return { leaves, tree, statement, sig: signEvent(statement, ex.key, ex.institutionId, ex.name) };
}

/** Inclusion proofs for the given leaf positions, as the exchange cuts them: the account reference stays behind. */
function open(s: Snapshot, indices: number[]): PorInclusionProof[] {
  return indices.map((i) => {
    const leaf = s.leaves.find((l) => s.tree.index[l.user_ref] === i);
    assert.ok(leaf, `leaf ${i} is not in the tree`);
    const { user_ref: _staysWithTheExchange, ...opening } = leaf;
    return provePorLeaf(s.tree, i, opening);
  });
}

const submit = (
  h: Harness, ex: Exchange, s: Pick<Snapshot, 'statement' | 'sig'>, extra: Record<string, unknown> = {},
): Promise<Reply> => call(h.base, 'POST', '/v1/por/snapshots',
  { token: ex.token, body: { statement: s.statement, sig: s.sig, ...extra } });

const answer = (h: Harness, ex: Exchange, snapshotId: string, openings: PorInclusionProof[]): Promise<Reply> =>
  call(h.base, 'POST', `/v1/por/snapshots/${snapshotId}/openings`, { token: ex.token, body: { openings } });

const published = (h: Harness, snapshotId: string): Promise<Reply> =>
  call(h.base, 'GET', `/v1/public/por/snapshots/${snapshotId}`);

/** What the worker does on its ticks, run to the end: every pending record sealed and submitted. */
async function anchorPending(h: Harness): Promise<void> {
  for (let batchId = await h.svc.sealBatch(); batchId; batchId = await h.svc.sealBatch()) {
    await h.svc.anchorBatch(batchId);
  }
}

/** A reserve address the platform can measure: on the local chain, with the token to read. */
const measurable = (h: Harness): Reserves['entries'][number] => ({
  chain: h.chainLabel, asset: 'USDT', address: `0x${'11'.repeat(20)}`, token_contract: `0x${'22'.repeat(20)}`,
});

// ── root only: the default ─────────────────────────────────────────────────

test('a signed statement is anchored at once, and every reading says no account was opened', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);
    const commitment = porSnapshotCommitment(snap.statement);

    const r = await submit(h, ex, snap);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), ['attestation_id', 'note', 'snapshot_id', 'spot_check', 'status'],
      'no challenge comes back: nothing is asked of the exchange');
    assert.equal(r.json['status'], 'ACCEPTED');
    assert.equal(r.json['spot_check'], false);
    assert.match(r.json['note'] as string, /signature was verified/);
    assert.match(r.json['note'] as string, /no account was opened/);
    const id = r.json['snapshot_id'] as string;

    // The commitment is in the ordinary pipeline, under the exchange's own
    // org, and filed under the product that issued it.
    const issued = await rows<{ id: string; org_id: string; product: string; content_type: string; descriptor: string }>(h,
      'SELECT id, org_id, product, content_type, descriptor FROM attestations WHERE leaf_bytes = ?', commitment);
    assert.equal(issued.length, 1);
    assert.equal(issued[0]!.id, r.json['attestation_id']);
    assert.equal(issued[0]!.org_id, ex.orgId);
    assert.equal(issued[0]!.product, 'por');
    assert.equal(issued[0]!.content_type, 'application/json');
    assert.deepEqual(JSON.parse(issued[0]!.descriptor),
      { kind: 'por-snapshot', snapshot_id: id, root: snap.tree.root, asof: snap.statement.asof });

    const stored = await rows<{ status: string; challenge: string; attestation_id: string }>(h,
      'SELECT status, challenge, attestation_id FROM por_snapshots WHERE org_id = ?', ex.orgId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.status, 'ACCEPTED');
    assert.equal(stored[0]!.attestation_id, r.json['attestation_id']);
    assert.deepEqual(JSON.parse(stored[0]!.challenge), { spot_check: false, indices: [] },
      'the row itself records that there was no challenge');

    const mine = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token });
    assert.equal(mine.status, 200, JSON.stringify(mine.json));
    assert.equal(mine.json['status'], 'ACCEPTED');
    assert.equal(mine.json['spot_check'], false);
    assert.ok(!('challenge' in mine.json), 'a challenge object would read as a snapshot that was challenged');
    assert.deepEqual(mine.json['attestation'], { id: r.json['attestation_id'], status: 'accepted' });
    const list = await call(h.base, 'GET', '/v1/por/snapshots', { token: ex.token });
    assert.deepEqual(
      (list.json['data'] as Record<string, unknown>[]).map((s) => [s['snapshot_id'], s['status'], s['spot_check']]),
      [[id, 'ACCEPTED', false]]);

    // Public, and plain about what the platform did and did not do.
    const pub = await published(h, id);
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    assert.equal(pub.json['spot_check'], false);
    assert.deepEqual(pub.json['verified_sampling'], { sampled: 0, of: 11 });
    assert.deepEqual(pub.json['platform_checks'], ['exchange_signature', 'statement_shape']);
    assert.deepEqual(pub.json['statement'], snap.statement);
    assert.deepEqual(pub.json['exchange_signature'], snap.sig);
    assert.equal(pub.json['commitment'], commitment);
    assert.deepEqual(pub.json['attestation'], { id: r.json['attestation_id'], bundle: null },
      'issued, and not yet in a batch — so no bundle is claimed');
  } finally { h.close(); }
});

test('a user checks their own balance against a root-only snapshot from public material alone', async () => {
  /*
   * What root-only leaves to the exchange's users is the whole check of the
   * tree, one inclusion proof at a time. This is that check, made with
   * nothing but the public endpoint and the proof the exchange hands one
   * customer — after the anchor has gone through the ordinary pipeline.
   */
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);
    const id = (await submit(h, ex, snap)).json['snapshot_id'] as string;

    await anchorPending(h);
    h.backend.mine(321);
    await h.svc.refreshConfirmations();
    const mine = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token });
    assert.equal(mine.json['attestation']['status'], 'confirmed', 'polling the keyed GET is how the exchange sees the anchor land');

    const pub = (await published(h, id)).json;
    assert.ok(verifyEvent(pub['statement'], pub['exchange_signature'], pub['exchange_key']['spki']),
      'the exchange signed this statement with the key the registry publishes');
    const bundle = pub['attestation']['bundle'];
    assert.equal(bundle['record']['leaf_bytes'], porSnapshotCommitment(pub['statement']),
      'what was anchored is the commitment to exactly this statement');
    assert.equal(bundle['anchor']['confirmed']['block_height'], 321);
    const report = verifyBundle(bundle, {});
    assert.equal(report.verified, true, report.checks.map((c) => `${c.state} ${c.id}`).join(' | '));

    const [proof] = open(snap, [3]);
    const included = verifyPorInclusion(proof!, { root: pub['statement']['tree']['root'], totals: pub['statement']['totals'] });
    assert.equal(included.ok, true, included.problems.join('; '));
    assert.equal(pub['spot_check'], false, 'and none of it rests on the platform having looked inside the tree');
  } finally { h.close(); }
});

test('the same signed statement sent again is the same snapshot, not a second one', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 6);
    const first = await submit(h, ex, snap);
    assert.equal(first.status, 201, JSON.stringify(first.json));

    const replay = await submit(h, ex, snap);
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.deepEqual(replay.json, { ...first.json, already: true });

    // The snapshot is the statement, not the envelope: a fresh signature over
    // the same statement is still a replay. `spot_check: false` is the default
    // said aloud.
    const resigned = { statement: snap.statement, sig: signEvent(snap.statement, ex.key, ex.institutionId, ex.name) };
    assert.notEqual(resigned.sig.sig, snap.sig.sig, 'ECDSA signatures are randomised, so this is a different envelope');
    const again = await submit(h, ex, resigned, { spot_check: false });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json['already'], true);
    assert.equal(again.json['snapshot_id'], first.json['snapshot_id']);
    assert.equal(again.json['attestation_id'], first.json['attestation_id']);

    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ?', ex.orgId), 1);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId), 1);
    assert.deepEqual(JSON.parse((await rows<{ sig: string }>(h, 'SELECT sig FROM por_snapshots WHERE org_id = ?', ex.orgId))[0]!.sig),
      snap.sig, 'the published signature stays the one the snapshot was accepted with');

    // A different statement — a later as-of time — is a different snapshot.
    const next = await submit(h, ex, snapshot(ex, 6, { asof: '2026-11-17T00:00:00.000Z' }));
    assert.equal(next.status, 201, JSON.stringify(next.json));
    assert.notEqual(next.json['snapshot_id'], first.json['snapshot_id']);
    assert.notEqual(next.json['attestation_id'], first.json['attestation_id']);
  } finally { h.close(); }
});

test('the same statement sent twice at once is still one snapshot', async () => {
  /*
   * A retry usually overlaps the attempt it retries: the first is still
   * reading reserve balances when the second arrives, so no row exists yet
   * for the second to find. The node answers slowly here so the two really
   * do overlap.
   */
  const node = await reserveNode(5n, 60);
  try {
    const h = await start({ reserveRpc: node.url });
    try {
      const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
      const snap = snapshot(ex, 3, { reserves: [measurable(h)] });
      const [a, b] = await Promise.all([submit(h, ex, snap), submit(h, ex, snap)]);
      assert.deepEqual([a.status, b.status].sort(), [200, 201], `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);
      assert.equal(a.json['snapshot_id'], b.json['snapshot_id']);
      assert.equal(a.json['attestation_id'], b.json['attestation_id']);
      assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ?', ex.orgId), 1);
      assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId), 1);
      assert.equal(node.calls(), 1, 'the second answer came from the stored row, not from a second measurement');
    } finally { h.close(); }
  } finally { node.close(); }
});

test('an attempt that fails does not take the retry waiting behind it down with it', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 3);
    // The store fails once, and slowly enough for the retry to arrive meanwhile.
    const issue = h.svc.issue.bind(h.svc);
    let attempts = 0;
    h.svc.issue = async (...args: Parameters<AttestService['issue']>) => {
      if (attempts++ === 0) {
        await new Promise((resolve) => { setTimeout(resolve, 60); });
        throw new Error('the store went away');
      }
      return issue(...args);
    };

    const [a, b] = await Promise.all([submit(h, ex, snap), submit(h, ex, snap)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 500], `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`);
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ?', ex.orgId), 1);
    const settled = await submit(h, ex, snap);
    assert.equal(settled.status, 200, JSON.stringify(settled.json));
    assert.equal(settled.json['already'], true);
  } finally { h.close(); }
});

// ── the spot check: the exchange's option ──────────────────────────────────

test('a spot check anchors nothing until the openings pass, then says it sampled', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    // Below and above the sample size: five accounts are all opened, eleven are sampled at eight.
    for (const [accounts, sampled, asof] of [[5, 5, '2026-11-15T00:00:00.000Z'], [11, 8, '2026-11-16T00:00:00.000Z']] as const) {
      const snap = snapshot(ex, accounts, { asof });
      const commitment = porSnapshotCommitment(snap.statement);

      const r = await submit(h, ex, snap, { spot_check: true });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.deepEqual(Object.keys(r.json).sort(), ['challenge', 'next', 'snapshot_id', 'spot_check', 'status']);
      assert.equal(r.json['status'], 'CHALLENGED');
      assert.equal(r.json['spot_check'], true);
      const id = r.json['snapshot_id'] as string;
      const indices = r.json['challenge']['indices'] as number[];
      assert.equal(indices.length, sampled);
      assert.deepEqual(indices, [...new Set(indices)].sort((x, y) => x - y), 'distinct positions, in order');
      assert.ok(indices.every((i) => Number.isInteger(i) && i >= 0 && i < accounts));
      assert.match(r.json['next'] as string, new RegExp(`/v1/por/snapshots/${id}/openings`));

      // Challenged is not published, and not anchored.
      const early = await published(h, id);
      assert.equal(early.status, 404);
      assert.equal(early.json['message'], 'no published snapshot with this id');
      assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM attestations WHERE leaf_bytes = ?', commitment), 0);
      const waiting = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token });
      assert.equal(waiting.json['status'], 'CHALLENGED');
      assert.equal(waiting.json['spot_check'], true);
      assert.deepEqual(waiting.json['challenge']['indices'], indices, 'the exchange can read back what it was asked to open');
      assert.equal(waiting.json['attestation'], null);

      const v = await answer(h, ex, id, open(snap, indices));
      assert.equal(v.status, 200, JSON.stringify(v.json));
      assert.equal(v.json['status'], 'VERIFIED');
      assert.equal(v.json['sampled_leaves'], sampled);
      const issued = await rows<{ id: string; product: string }>(h,
        'SELECT id, product FROM attestations WHERE leaf_bytes = ?', commitment);
      assert.deepEqual(issued, [{ id: v.json['attestation_id'], product: 'por' }]);

      const pub = await published(h, id);
      assert.equal(pub.status, 200, JSON.stringify(pub.json));
      assert.equal(pub.json['spot_check'], true);
      assert.deepEqual(pub.json['verified_sampling'], { sampled, of: accounts });
      assert.deepEqual(pub.json['platform_checks'], ['exchange_signature', 'statement_shape', 'spot_check']);
      const done = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token });
      assert.equal(done.json['status'], 'VERIFIED');
      assert.equal(done.json['spot_check'], true);

      // The openings are a one-time answer.
      const twice = await answer(h, ex, id, open(snap, indices));
      assert.equal(twice.status, 409);
      assert.equal(twice.json['error'], 'wrong_state');
    }
  } finally { h.close(); }
});

test('a tampered opening rejects the snapshot and nothing is anchored for it', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);
    const r = await submit(h, ex, snap, { spot_check: true });
    const id = r.json['snapshot_id'] as string;
    const openings = open(snap, r.json['challenge']['indices'] as number[]);
    // One customer's balance, understated by the exchange after the root was signed.
    openings[0]!.leaf.balances['USDT'] = (USDT_PER_ACCOUNT - 1n).toString();

    const v = await answer(h, ex, id, openings);
    assert.equal(v.status, 422, JSON.stringify(v.json));
    assert.equal(v.json['status'], 'REJECTED');
    assert.ok((v.json['problems'] as string[]).some((p) => p.startsWith(`leaf ${openings[0]!.leaf_index}:`)),
      JSON.stringify(v.json['problems']));

    assert.deepEqual(await rows(h, 'SELECT status, attestation_id FROM por_snapshots WHERE id = ?', id),
      [{ status: 'REJECTED', attestation_id: null }]);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId), 0);
    assert.equal((await published(h, id)).status, 404, 'a rejected snapshot is not published');
    const mine = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token });
    assert.equal(mine.json['status'], 'REJECTED');
    assert.equal(mine.json['spot_check'], true, 'it failed a spot check; it did not skip one');
    assert.equal(mine.json['attestation'], null);

    // Rejection is final for this snapshot: the honest openings do not revive it.
    const retry = await answer(h, ex, id, open(snap, r.json['challenge']['indices'] as number[]));
    assert.equal(retry.status, 409);
    assert.equal(retry.json['error'], 'wrong_state');
  } finally { h.close(); }
});

test('openings sent to a snapshot accepted without a spot check are refused and change nothing', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);
    const id = (await submit(h, ex, snap)).json['snapshot_id'] as string;

    // Sound openings, and still nothing to check them against: no leaf was
    // challenged, and accepting them would let the record claim a sample.
    const r = await answer(h, ex, id, open(snap, [0, 1, 2]));
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json['error'], 'wrong_state');
    assert.match(r.json['message'] as string, /without a spot check/);
    assert.match(r.json['message'] as string, /nothing to open/);

    const pub = await published(h, id);
    assert.equal(pub.status, 200);
    assert.equal(pub.json['spot_check'], false);
    assert.deepEqual(pub.json['verified_sampling'], { sampled: 0, of: 11 });
    assert.deepEqual(await rows(h, 'SELECT status, problems FROM por_snapshots WHERE id = ?', id),
      [{ status: 'ACCEPTED', problems: null }]);
  } finally { h.close(); }
});

test('one statement taken down both paths shares one anchor, and each record keeps its own account of it', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const leaves = async (leaf: string): Promise<number> =>
      count(h, 'SELECT COUNT(*) AS n FROM attestations WHERE leaf_bytes = ?', leaf);

    // Root only first, the spot check asked for afterwards.
    const first = snapshot(ex, 9, { asof: '2026-11-15T00:00:00.000Z' });
    const accepted = await submit(h, ex, first);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    const challenged = await submit(h, ex, first, { spot_check: true });
    assert.equal(challenged.status, 201, 'asking for the spot check is a new submission, not a replay');
    assert.notEqual(challenged.json['snapshot_id'], accepted.json['snapshot_id']);
    const verified = await answer(h, ex, challenged.json['snapshot_id'] as string,
      open(first, challenged.json['challenge']['indices'] as number[]));
    assert.equal(verified.json['status'], 'VERIFIED', JSON.stringify(verified.json));
    assert.equal(verified.json['attestation_id'], accepted.json['attestation_id'], 'the same bytes are not anchored twice');
    assert.equal(await leaves(porSnapshotCommitment(first.statement)), 1);
    assert.equal((await published(h, accepted.json['snapshot_id'] as string)).json['spot_check'], false);
    assert.equal((await published(h, challenged.json['snapshot_id'] as string)).json['spot_check'], true);
    // The root-only record is still the one a root-only resend finds.
    const replay = await submit(h, ex, first);
    assert.equal(replay.status, 200);
    assert.equal(replay.json['snapshot_id'], accepted.json['snapshot_id']);

    // The other order: spot-checked first, then sent root only.
    const second = snapshot(ex, 9, { asof: '2026-11-16T00:00:00.000Z' });
    const c2 = await submit(h, ex, second, { spot_check: true });
    const v2 = await answer(h, ex, c2.json['snapshot_id'] as string, open(second, c2.json['challenge']['indices'] as number[]));
    assert.equal(v2.json['status'], 'VERIFIED', JSON.stringify(v2.json));
    const a2 = await submit(h, ex, second);
    assert.equal(a2.status, 201, JSON.stringify(a2.json));
    assert.equal(a2.json['status'], 'ACCEPTED');
    assert.equal(a2.json['attestation_id'], v2.json['attestation_id']);
    assert.equal(await leaves(porSnapshotCommitment(second.statement)), 1);
    assert.deepEqual((await published(h, a2.json['snapshot_id'] as string)).json['platform_checks'],
      ['exchange_signature', 'statement_shape'],
      'a sample taken for another record of the same statement is not this record\'s to claim');
  } finally { h.close(); }
});

// ── what is refused, and what a refusal leaves behind ──────────────────────

test('a submission the checks refuse stores nothing and anchors nothing', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);

    for (const spotCheck of ['yes', 'true', 1, 0, null, {}]) {
      const r = await submit(h, ex, snap, { spot_check: spotCheck });
      assert.equal(r.status, 400, `${JSON.stringify(spotCheck)}: ${JSON.stringify(r.json)}`);
      assert.deepEqual(r.json, { error: 'invalid_field', message: 'spot_check must be true or false' });
    }
    // Where it sits among the existing checks: after the required fields,
    // before the statement is read.
    const missing = await call(h.base, 'POST', '/v1/por/snapshots', { token: ex.token, body: { sig: snap.sig, spot_check: 'yes' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.json['error'], 'missing_field');
    const shapeless = await call(h.base, 'POST', '/v1/por/snapshots',
      { token: ex.token, body: { statement: { schema: 'nonsense' }, sig: snap.sig } });
    assert.equal(shapeless.status, 400);
    assert.equal(shapeless.json['error'], 'invalid_statement');

    // A signature by a key the registry does not hold for this exchange, and
    // a real signature over a statement edited afterwards.
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const forged = await submit(h, ex, { statement: snap.statement, sig: signEvent(snap.statement, stranger, ex.institutionId, ex.name) });
    assert.equal(forged.status, 400, JSON.stringify(forged.json));
    assert.equal(forged.json['error'], 'invalid_signature');
    const edited = { ...snap.statement, totals: { ...snap.statement.totals, USDT: '1' } };
    for (const extra of [{}, { spot_check: true }]) {
      const r = await submit(h, ex, { statement: edited, sig: snap.sig }, extra);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(r.json['error'], 'invalid_signature');
    }

    // A statement that names an exchange this organisation is not.
    const elsewhere = snapshot({ ...ex, institutionId: 'KR-EX-ELSEWHERE' }, 11);
    const misnamed = await submit(h, ex, elsewhere);
    assert.equal(misnamed.status, 403, JSON.stringify(misnamed.json));
    assert.equal(misnamed.json['error'], 'institution_mismatch');

    assert.equal((await call(h.base, 'POST', '/v1/por/snapshots', { body: { statement: snap.statement, sig: snap.sig } })).status, 401);

    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots'), 0);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE product = 'por'"), 0);
    const unknown = await published(h, '00000000-0000-4000-8000-000000000000');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json['message'], 'no published snapshot with this id');
  } finally { h.close(); }
});

test('another organisation can neither read a snapshot through its key nor publish the statement as its own', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 11);
    const id = (await submit(h, ex, snap)).json['snapshot_id'] as string;
    const pending = await submit(h, ex, snapshot(ex, 11, { asof: '2026-11-17T00:00:00.000Z' }), { spot_check: true });

    // A rival exchange with its own registered key, and a tenant with no
    // Proof of Reserves subscription at all.
    const rival = await exchange(h, 'ops@rival.example', 'Rival Exchange');
    const bystander = await signUp(h, 'dev@bystander.example');

    for (const other of [rival, bystander]) {
      const read = await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: other.token });
      assert.equal(read.status, 404, 'whether the id exists is not another tenant\'s to learn');
      assert.deepEqual((await call(h.base, 'GET', '/v1/por/snapshots', { token: other.token })).json['data'], []);
    }
    // The public endpoint is the one door for everyone else, by design.
    assert.equal((await published(h, id)).status, 200);

    // The statement names Hanbit's institution, and that is not theirs to sign for.
    const replayed = await submit(h, rival, snap);
    assert.equal(replayed.status, 403, JSON.stringify(replayed.json));
    assert.equal(replayed.json['error'], 'institution_mismatch');
    const unsubscribed = await call(h.base, 'POST', '/v1/por/snapshots',
      { token: bystander.token, body: { statement: snap.statement, sig: snap.sig } });
    assert.equal(unsubscribed.status, 403, JSON.stringify(unsubscribed.json));
    assert.equal(unsubscribed.json['error'], 'subscription_required');
    // Nor can the rival take the institution id for itself and sign as Hanbit.
    const squat = await call(h.base, 'POST', '/v1/console/products', {
      cookie: rival.cookie,
      body: { product: 'por', institution: { id: ex.institutionId, name: 'Rival Exchange' }, issuer_key_id: rival.issuerKeyId },
    });
    assert.equal(squat.status, 409, JSON.stringify(squat.json));
    assert.equal(squat.json['error'], 'institution_id_taken');
    // And another tenant's open challenge is not theirs to answer.
    const meddled = await answer(h, rival, pending.json['snapshot_id'] as string, []);
    assert.equal(meddled.status, 404, JSON.stringify(meddled.json));

    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id != ?', ex.orgId), 0);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id != ? AND product = 'por'", ex.orgId), 0);
    assert.deepEqual(await rows(h, 'SELECT status FROM por_snapshots WHERE id = ?', pending.json['snapshot_id'] as string),
      [{ status: 'CHALLENGED' }], 'the refused answer did not spend the owner\'s challenge');
  } finally { h.close(); }
});

// ── declared reserves ──────────────────────────────────────────────────────

test('reserves the platform cannot measure are reported as declared only, and no chain is read for them', async () => {
  const node = await reserveNode(0n);
  try {
    const h = await start({ reserveRpc: node.url });
    try {
      const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
      // Neither can be measured, for the two reasons there are: a chain this
      // deployment has no node for, and a local-chain address with no token
      // contract to ask.
      const declared: Reserves['entries'] = [
        { chain: 'bip122:000000000019d6689c085ae165831e93', asset: 'BTC', address: 'bc1qexamplecoldwallet0000000000000000000000' },
        { chain: h.chainLabel, asset: 'USDT', address: `0x${'11'.repeat(20)}` },
      ];
      const snap = snapshot(ex, 4, { reserves: declared });

      const r = await submit(h, ex, snap);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json['status'], 'ACCEPTED');
      const report = r.json['reserves'] as {
        declared: number; note: string;
        measurements: { chain: string; asset: string; address: string; status: string }[];
        solvency: { asset: string; liabilities: string; reserves_measured: string; coverage: string | null; status: string }[];
      };
      assert.equal(report.declared, 2);
      assert.deepEqual(report.measurements.map((m) => [m.chain, m.asset, m.address, m.status]),
        declared.map((e) => [e.chain, e.asset, e.address, 'DECLARED_ONLY']));
      assert.deepEqual(report.solvency.find((l) => l.asset === 'USDT'), {
        asset: 'USDT', liabilities: (4n * USDT_PER_ACCOUNT).toString(), reserves_measured: '0', coverage: null, status: 'NOT_MEASURED',
      }, 'a declared address is never counted as a measured reserve');
      assert.equal(node.calls(), 0, 'nothing here was the platform\'s to read, and it read nothing');

      const id = r.json['snapshot_id'] as string;
      assert.deepEqual(JSON.parse((await rows<{ reserves: string }>(h, 'SELECT reserves FROM por_snapshots WHERE id = ?', id))[0]!.reserves),
        report, 'the report is stored with the snapshot');
      assert.deepEqual((await call(h.base, 'GET', `/v1/por/snapshots/${id}`, { token: ex.token })).json['reserves'], report);
      assert.deepEqual((await published(h, id)).json['reserves'], report, 'and travels with the public record');
      assert.deepEqual((await submit(h, ex, snap)).json, { ...r.json, already: true }, 'a replay answers with the stored report');
    } finally { h.close(); }
  } finally { node.close(); }
});

test('a reserve chain that cannot be reached is reported as unreachable and does not hold up the anchor', async () => {
  // No node at all behind the configured address: what a deployment looks
  // like while its reserve chain is down.
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const r = await submit(h, ex, snapshot(ex, 4, { reserves: [measurable(h)] }));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json['status'], 'ACCEPTED');
    assert.deepEqual((r.json['reserves']['measurements'] as { status: string }[]).map((m) => m.status), ['UNREACHABLE']);
    const usdt = (r.json['reserves']['solvency'] as { asset: string; coverage: string | null; status: string }[])
      .find((l) => l.asset === 'USDT');
    assert.equal(usdt?.status, 'NOT_MEASURED', 'a balance that could not be read is not a balance of zero');
    assert.equal(usdt?.coverage, null);
    assert.equal((await published(h, r.json['snapshot_id'] as string)).status, 200);
  } finally { h.close(); }
});

// ── the console: a root-only snapshot is a published one ───────────────────

test('the console shows a root-only snapshot as published — latest, anchored, covered and billed', async () => {
  const node = await reserveNode(1_100_000n);
  try {
    const h = await start({ reserveRpc: node.url });
    try {
      const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
      const dashboard = async (): Promise<Record<string, any>> => {
        const r = await call(h.base, 'GET', '/v1/console/dashboard', { cookie: ex.cookie });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        return r.json['por'] as Record<string, any>;
      };
      assert.equal((await dashboard())['latest'], null);

      const snap = snapshot(ex, 4, { asof: '2026-11-15T00:00:00.000Z', reserves: [measurable(h)] });
      const r = await submit(h, ex, snap);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      const id = r.json['snapshot_id'] as string;
      assert.equal(node.calls(), 1);
      // 1,100,000 measured against 4 × 250,000 owed.
      const coverage = [{ asset: 'BTC', coverage: null }, { asset: 'USDT', coverage: '110.00%' }];

      const fresh = await dashboard();
      assert.equal(fresh['latest']['id'], id);
      assert.equal(fresh['latest']['status'], 'ACCEPTED');
      assert.equal(fresh['latest']['spot_check'], false);
      assert.equal(fresh['latest']['anchor_status'], 'accepted');
      assert.equal(fresh['latest']['leaf_count'], 4);
      assert.deepEqual(new Map((fresh['latest']['coverage'] as { asset: string; coverage: string | null }[]).map((c) => [c.asset, c.coverage])),
        new Map(coverage.map((c) => [c.asset, c.coverage])));
      assert.deepEqual((fresh['trend'] as Record<string, unknown>[]).map((x) => [x['id'], x['status'], x['spot_check']]),
        [[id, 'ACCEPTED', false]]);

      await anchorPending(h);
      h.backend.mine(500);
      await h.svc.refreshConfirmations();
      assert.equal((await dashboard())['latest']['anchor_status'], 'confirmed');

      // A spot-checked snapshot beside it: each row says which path it took.
      const later = snapshot(ex, 4, { asof: '2026-11-16T00:00:00.000Z' });
      const c = await submit(h, ex, later, { spot_check: true });
      const v = await answer(h, ex, c.json['snapshot_id'] as string, open(later, c.json['challenge']['indices'] as number[]));
      assert.equal(v.json['status'], 'VERIFIED', JSON.stringify(v.json));
      const both = await dashboard();
      assert.equal(both['latest']['id'], c.json['snapshot_id']);
      assert.equal(both['latest']['spot_check'], true);
      assert.deepEqual(
        new Map((both['trend'] as Record<string, unknown>[]).map((x) => [x['id'], [x['status'], x['spot_check']]])),
        new Map([[c.json['snapshot_id'], ['VERIFIED', true]], [id, ['ACCEPTED', false]]]));

      // Billed as snapshots, with their anchors included — not drawn from the
      // Attest quota, whose one record is the sample every signup is seeded with.
      const billing = (await call(h.base, 'GET', '/v1/console/products', { cookie: ex.cookie })).json['billing'];
      assert.equal(billing['por']['snapshots'], 2);
      assert.equal(billing['por']['included_anchors'], 2);
      assert.equal(billing['attest']['used'], 1);
      assert.equal((billing['charges']['lines'] as { product: string; quantity: number }[]).find((l) => l.product === 'por')?.quantity, 2);
    } finally { h.close(); }
  } finally { node.close(); }
});

test('a resend is answered from the stored snapshot only after its signature is verified', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 6);
    const first = await submit(h, ex, snap);
    assert.equal(first.status, 201, JSON.stringify(first.json));

    // Once accepted the statement is public. What makes a resend the
    // exchange's is the signature, so it is checked before the stored
    // snapshot is looked up — every time.
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const flipped = { ...snap.sig, sig: (snap.sig.sig.startsWith('A') ? 'B' : 'A') + snap.sig.sig.slice(1) };
    for (const sig of [signEvent(snap.statement, stranger, ex.institutionId, ex.name), flipped]) {
      for (const extra of [{}, { spot_check: false }]) {
        const r = await submit(h, ex, { statement: snap.statement, sig }, extra);
        assert.equal(r.status, 400, JSON.stringify(r.json));
        assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message'], 'a refused resend learns nothing about the stored snapshot');
        assert.equal(r.json['error'], 'invalid_signature');
      }
    }
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ?', ex.orgId), 1);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId), 1);
  } finally { h.close(); }
});

test('the replay lookup never answers with a snapshot of another organisation', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const rival = await exchange(h, 'ops@rival.example', 'Rival Exchange');
    const snap = snapshot(ex, 6);
    // No route lets two organisations hold one commitment — it covers the
    // institution id — so the row is planted. What is under test is the
    // lookup's own scoping, not the checks that happen to stand in front of it.
    await h.db.prepare(
      `INSERT INTO por_snapshots
         (id, org_id, institution_id, status, statement, sig, commitment, root, asof,
          leaf_count, totals, challenge, attestation_id, created_at, updated_at)
       VALUES (?, ?, ?, 'ACCEPTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('planted-under-rival', rival.orgId, rival.institutionId,
      JSON.stringify(snap.statement), JSON.stringify(snap.sig), porSnapshotCommitment(snap.statement),
      snap.tree.root, snap.statement.asof, 6, JSON.stringify(snap.statement.totals),
      JSON.stringify({ spot_check: false, indices: [] }), 'planted-attestation',
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');

    const r = await submit(h, ex, snap);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(!('already' in r.json));
    assert.notEqual(r.json['snapshot_id'], 'planted-under-rival');
    assert.notEqual(r.json['attestation_id'], 'planted-attestation');
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ?', ex.orgId), 1);
  } finally { h.close(); }
});

test('a snapshot that reuses an anchor reuses the one in its own organisation, whoever else attested the same digest', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const rival = await signUp(h, 'dev@rival.example');
    const snap = snapshot(ex, 6);
    const commitment = porSnapshotCommitment(snap.statement);
    // The commitment is public arithmetic over a public statement: anyone can
    // attest the same 32 bytes under their own organisation, and first.
    const theirs = await call(h.base, 'POST', '/v1/attestations', { token: rival.token, body: { leaf_bytes: commitment } });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.json));

    const accepted = await submit(h, ex, snap);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.notEqual(accepted.json['attestation_id'], theirs.json['id']);
    // The second record of the same statement takes the duplicate path.
    const c = await submit(h, ex, snap, { spot_check: true });
    const v = await answer(h, ex, c.json['snapshot_id'] as string, open(snap, c.json['challenge']['indices'] as number[]));
    assert.equal(v.json['status'], 'VERIFIED', JSON.stringify(v.json));
    assert.equal(v.json['attestation_id'], accepted.json['attestation_id']);
    assert.equal((await published(h, c.json['snapshot_id'] as string)).status, 200);
  } finally { h.close(); }
});

test('a spot check is answered in full and in time, or the snapshot is not verified', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const anchored = (): Promise<number> =>
      count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId);

    // Sound openings for fewer leaves than were asked for — or for none — are
    // not a passed sample: VERIFIED would then claim leaves nobody opened.
    for (const [asof, keep] of [['2026-11-13T00:00:00.000Z', 7], ['2026-11-14T00:00:00.000Z', 0]] as const) {
      const snap = snapshot(ex, 11, { asof });
      const c = await submit(h, ex, snap, { spot_check: true });
      const asked = c.json['challenge']['indices'] as number[];
      const r = await answer(h, ex, c.json['snapshot_id'] as string, open(snap, asked.slice(0, keep)));
      assert.equal(r.status, 422, JSON.stringify(r.json));
      assert.equal(r.json['status'], 'REJECTED');
      assert.match((r.json['problems'] as string[])[0]!, /must cover exactly the challenged indices/);
      assert.equal((await published(h, c.json['snapshot_id'] as string)).status, 404);
    }
    assert.equal(await anchored(), 0);

    // The window is an hour, and shut after it: the row stays CHALLENGED,
    // nothing is anchored, and the same openings would have passed in time.
    const late = snapshot(ex, 11, { asof: '2026-11-15T00:00:00.000Z' });
    const c = await submit(h, ex, late, { spot_check: true });
    const id = c.json['snapshot_id'] as string;
    const challenge = c.json['challenge'] as { indices: number[]; issued_at: string; expires_at: string };
    assert.ok(Math.abs(Date.parse(challenge.expires_at) - Date.parse(challenge.issued_at) - 3_600_000) < 5_000);
    await h.db.prepare('UPDATE por_snapshots SET challenge = ? WHERE id = ?')
      .run(JSON.stringify({ ...challenge, expires_at: new Date(Date.now() - 1_000).toISOString() }), id);
    const expired = await answer(h, ex, id, open(late, challenge.indices));
    assert.equal(expired.status, 409, JSON.stringify(expired.json));
    assert.equal(expired.json['error'], 'challenge_expired');
    assert.deepEqual(await rows(h, 'SELECT status, attestation_id FROM por_snapshots WHERE id = ?', id),
      [{ status: 'CHALLENGED', attestation_id: null }]);
    assert.equal(await anchored(), 0);
  } finally { h.close(); }
});

test('an open challenge cannot be answered once the subscription is deactivated', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 6);
    const c = await submit(h, ex, snap, { spot_check: true });
    const off = await call(h.base, 'POST', '/v1/console/products/por/deactivate', { cookie: ex.cookie, body: {} });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    const r = await answer(h, ex, c.json['snapshot_id'] as string, open(snap, c.json['challenge']['indices'] as number[]));
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(r.json['error'], 'subscription_required');
    assert.equal((await submit(h, ex, snap)).status, 403);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND product = 'por'", ex.orgId), 0);
  } finally { h.close(); }
});

test('the root-only answer says nothing that could be read as a sample', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const snap = snapshot(ex, 6);
    for (const r of [await submit(h, ex, snap), await submit(h, ex, snap)]) {
      assert.doesNotMatch(r.json['note'] as string, /sampl|challeng|spot.?check|leaf|leaves|opening/i);
    }
  } finally { h.close(); }
});

test('a statement that cannot be measured or stored is refused before anything is issued', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const base = snapshot(ex, 4).statement;
    const unusable: [string, unknown][] = [
      ['a reserve entry that is not an object', { ...base, reserves: { mode: 'DECLARED', entries: [null], note: 'x' } }],
      ['reserve entries that are not a list', { ...base, reserves: { mode: 'DECLARED', entries: { length: 1 }, note: 'x' } }],
      ['a reserve address that is not a string', { ...base, reserves: { mode: 'DECLARED', entries: [{ chain: h.chainLabel, asset: 'USDT', address: 5 }], note: 'x' } }],
      ['more leaves than the row can count', { ...base, tree: { ...base.tree, leaf_count: 3_000_000_000 } }],
    ];
    for (const [what, statement] of unusable) {
      // Signed by the exchange: the signature is good, the statement is not.
      const sig = signEvent(statement, ex.key, ex.institutionId, ex.name);
      for (const extra of [{}, { spot_check: true }]) {
        const r = await call(h.base, 'POST', '/v1/por/snapshots', { token: ex.token, body: { statement, sig, ...extra } });
        assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.json)}`);
        assert.equal(r.json['error'], 'invalid_statement', what);
      }
    }
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots'), 0);
    assert.equal(await count(h, "SELECT COUNT(*) AS n FROM attestations WHERE product = 'por'"), 0, 'no anchor without a snapshot behind it');

    // What was accepted before still is: no reserves, or none declared.
    const none = { ...base, reserves: { mode: 'DECLARED', entries: [], note: 'x' } } as PorSnapshotStatement;
    assert.equal((await submit(h, ex, { statement: none, sig: signEvent(none, ex.key, ex.institutionId, ex.name) })).status, 201);
  } finally { h.close(); }
});

test('a body that is JSON null is a missing field, not a server fault', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const res = await fetch(`${h.base}/v1/por/snapshots`, {
      method: 'POST', headers: { authorization: `Bearer ${ex.token}`, 'content-type': 'application/json' }, body: 'null',
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'missing_field');
  } finally { h.close(); }
});

test('a published snapshot goes on verifying after the exchange replaces its key, and after it revokes the old one', async () => {
  /*
   * The public material used to hand out the institution's key as it stood
   * at the moment of reading. An exchange that rotated — or revoked a key —
   * thereby turned every snapshot it had ever published into one whose
   * signature no longer verified, for any reader, with nothing wrong in the
   * snapshot. The key is now the snapshot's own.
   */
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@rotating.example', 'Rotating Exchange');
    const first = snapshot(ex, 9);
    const id = (await submit(h, ex, first)).json['snapshot_id'] as string;
    const original = (await published(h, id)).json['exchange_key']['spki'] as string;
    assert.equal(original, spkiFromPublicKey(publicHalf(ex.key)));

    // The exchange rotates: a new key registered, then made the institution's.
    const next = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const registered = await call(h.base, 'POST', '/v1/issuer-keys',
      { token: ex.token, body: { public_key: spkiFromPublicKey(next.publicKey), label: 'rotated signing key' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.json));
    const applied = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/signing-key`,
      { cookie: ex.cookie, body: { issuer_key_id: registered.json['id'] } });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));

    const afterRotation = (await published(h, id)).json;
    assert.equal(afterRotation['exchange_key']['spki'], original, 'the snapshot keeps the key it was signed with');
    assert.equal(afterRotation['exchange_key']['key_id'], ex.institutionId);
    assert.ok(verifyEvent(afterRotation['statement'], afterRotation['exchange_signature'], afterRotation['exchange_key']['spki']),
      'and so its signature still verifies from public material alone');

    // What is signed from now on is checked against, and published with, the new key.
    const rotated: Exchange = { ...ex, key: next.privateKey };
    const stale = await submit(h, ex, snapshot(ex, 9, { asof: '2026-11-17T00:00:00.000Z' }));
    assert.equal(stale.status, 400, 'the old key no longer signs for this institution');
    assert.equal(stale.json['error'], 'invalid_signature');
    const second = await submit(h, rotated, snapshot(rotated, 9, { asof: '2026-11-17T00:00:00.000Z' }));
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const secondPublic = (await published(h, second.json['snapshot_id'] as string)).json;
    assert.equal(secondPublic['exchange_key']['spki'], spkiFromPublicKey(next.publicKey));
    assert.ok(verifyEvent(secondPublic['statement'], secondPublic['exchange_signature'], secondPublic['exchange_key']['spki']));

    // Revoking the old key refuses it from now on; it does not unpublish the past.
    const revoked = await call(h.base, 'POST', `/v1/console/issuer-keys/${ex.issuerKeyId}/revoke`, { cookie: ex.cookie });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    const afterRevocation = (await published(h, id)).json;
    assert.equal(afterRevocation['exchange_key']['spki'], original);
    assert.ok(verifyEvent(afterRevocation['statement'], afterRevocation['exchange_signature'], afterRevocation['exchange_key']['spki']));

    // Even revoking the key in use, which leaves the institution with none,
    // leaves what was published under it readable and verifiable.
    const revokedCurrent = await call(h.base, 'POST', `/v1/console/issuer-keys/${registered.json['id']}/revoke`, { cookie: ex.cookie });
    assert.equal(revokedCurrent.status, 200, JSON.stringify(revokedCurrent.json));
    const orphaned = (await published(h, second.json['snapshot_id'] as string)).json;
    assert.ok(orphaned['exchange_key'], 'a snapshot must not lose its key because the institution has none now');
    assert.ok(verifyEvent(orphaned['statement'], orphaned['exchange_signature'], orphaned['exchange_key']['spki']));
  } finally { h.close(); }
});

test('the console signs with a key of its own, and the exchange\'s signing key is left exactly as it was', async () => {
  /*
   * The reserve screen takes a balance file and nothing else, so it signs
   * with a key made for the session. That key is a second one: registering
   * it must not disturb the key the exchange's own server signs with.
   */
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@console-key.example', 'Console Key Exchange');
    const session = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const sessionSpki = spkiFromPublicKey(session.publicKey);
    const viaConsole: Exchange = { ...ex, key: session.privateKey };

    const early = await submit(h, viaConsole, snapshot(viaConsole, 5));
    assert.equal(early.status, 400, 'a key nobody registered signs for nobody');
    assert.equal(early.json['error'], 'invalid_signature');

    const set = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/console-key`,
      { cookie: ex.cookie, body: { public_key: sessionSpki } });
    assert.equal(set.status, 200, JSON.stringify(set.json));

    const fromConsole = await submit(h, viaConsole, snapshot(viaConsole, 5));
    assert.equal(fromConsole.status, 201, JSON.stringify(fromConsole.json));
    const pub = (await published(h, fromConsole.json['snapshot_id'] as string)).json;
    assert.equal(pub['exchange_key']['spki'], sessionSpki, 'the snapshot names the key that signed it');
    assert.ok(verifyEvent(pub['statement'], pub['exchange_signature'], pub['exchange_key']['spki']));

    // The exchange's server goes on signing with its own key, untouched.
    const fromServer = await submit(h, ex, snapshot(ex, 5, { asof: '2026-11-18T00:00:00.000Z' }));
    assert.equal(fromServer.status, 201, JSON.stringify(fromServer.json));
    assert.equal((await published(h, fromServer.json['snapshot_id'] as string)).json['exchange_key']['spki'],
      spkiFromPublicKey(publicHalf(ex.key)));
    const [inst] = await rows<{ signing_spki: string; console_spki: string }>(h,
      'SELECT signing_spki, console_spki FROM institutions WHERE id = ?', ex.institutionId);
    assert.equal(inst!.signing_spki, spkiFromPublicKey(publicHalf(ex.key)));
    assert.equal(inst!.console_spki, sessionSpki);

    // Not anyone else's to set, and not a place for junk or a private key.
    const other = await exchange(h, 'ops@other-console.example', 'Other Exchange');
    const foreign = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/console-key`,
      { cookie: other.cookie, body: { public_key: sessionSpki } });
    assert.equal(foreign.status, 404);
    const junk = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/console-key`,
      { cookie: ex.cookie, body: { public_key: 'not a key' } });
    assert.equal(junk.status, 400);
    const secret = session.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const leaked = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/console-key`,
      { cookie: ex.cookie, body: { public_key: secret } });
    assert.equal(leaked.status, 400, 'a private key must be refused, not stored');
    const missing = await call(h.base, 'POST', `/v1/console/institutions/${ex.institutionId}/console-key`,
      { cookie: ex.cookie, body: {} });
    assert.equal(missing.status, 400);
    const [after] = await rows<{ console_spki: string }>(h, 'SELECT console_spki FROM institutions WHERE id = ?', ex.institutionId);
    assert.equal(after!.console_spki, sessionSpki, 'a refused request changes nothing');
  } finally { h.close(); }
});

test('snapshots stored before they kept their own key are given it at boot — only when it is provably theirs', async () => {
  const h = await start();
  try {
    const registry = new Registry(h.db);
    const kept = await exchange(h, 'ops@kept.example', 'Kept Exchange');
    const moved = await exchange(h, 'ops@moved.example', 'Moved Exchange');
    const keptId = (await submit(h, kept, snapshot(kept, 7))).json['snapshot_id'] as string;
    const movedId = (await submit(h, moved, snapshot(moved, 7))).json['snapshot_id'] as string;
    const keptKey = (await published(h, keptId)).json['exchange_key']['spki'] as string;
    const movedKey = (await published(h, movedId)).json['exchange_key']['spki'] as string;

    // Both rows as an older deployment stored them: no key of their own.
    await h.db.prepare('UPDATE por_snapshots SET signing_spki = NULL').run();
    // One exchange had already rotated before the column existed.
    const next = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await registry.setSigningKey(moved.institutionId, spkiFromPublicKey(next.publicKey));

    assert.equal(await backfillSnapshotKeys({ db: h.db, registry }), 1, 'only the row whose signature the current key verifies');
    const stored = await rows<{ id: string; signing_spki: string | null }>(h, 'SELECT id, signing_spki FROM por_snapshots');
    assert.equal(stored.find((r) => r.id === keptId)!.signing_spki, keptKey);
    assert.equal(stored.find((r) => r.id === movedId)!.signing_spki, null,
      'a key that never signed the statement must not be written beside it');
    assert.equal(await backfillSnapshotKeys({ db: h.db, registry }), 0, 'and a second boot has nothing left to do');

    // From here a rotation cannot touch the row that was filled.
    await registry.setSigningKey(kept.institutionId, spkiFromPublicKey(next.publicKey));
    const pub = (await published(h, keptId)).json;
    assert.equal(pub['exchange_key']['spki'], keptKey);
    assert.ok(verifyEvent(pub['statement'], pub['exchange_signature'], pub['exchange_key']['spki']));
    // The row that could not be filled reads as it always did: the institution's key as it stands.
    assert.equal((await published(h, movedId)).json['exchange_key']['spki'], spkiFromPublicKey(next.publicKey));
    assert.notEqual(movedKey, spkiFromPublicKey(next.publicKey));
  } finally { h.close(); }
});

// ── two ways of writing the same tree ──────────────────────────────────────

test('both tree formats are accepted, sampled and proven from public material; a statement that mixes or misnames them is refused', async () => {
  const h = await start();
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    // Thirteen accounts in a tree of sixteen, most of them holding one of the
    // two assets and one holding neither: everything the two formats write
    // differently — an asset an account does not hold, and the padding.
    const leaves: PorLeafInput[] = book(ex.institutionId, 13).map((l, i) => ({
      ...l,
      balances: i === 4 ? {} : i % 3 === 0 ? l.balances : i % 3 === 1 ? { BTC: l.balances['BTC']! } : { USDT: l.balances['USDT']! },
    }));
    const owed = (asset: string): string => leaves.reduce((n, l) => n + BigInt(l.balances[asset] ?? '0'), 0n).toString();
    const FORMATS = [
      { algo: 'merkle-sum-sha256-v1', padding: 'empty-zero' },
      { algo: 'merkle-sum-sha256-v2', padding: 'empty' },
    ] as const;
    const built = (algo: (typeof FORMATS)[number]['algo'], asof: string): Snapshot => {
      const tree = buildPorTree(leaves, ASSETS, { algo });
      const statement = buildSnapshotStatement({
        institutionId: ex.institutionId, name: ex.name, asof,
        assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'USDT', decimals: 6 }],
      }, tree);
      return { leaves, tree, statement, sig: signEvent(statement, ex.key, ex.institutionId, ex.name) };
    };

    const roots = new Set<string>();
    let day = 1;
    const nextDay = (): string => `2026-11-${String(day++).padStart(2, '0')}T00:00:00.000Z`;
    for (const f of FORMATS) {
      // Root only: accepted as stated, and published as stated.
      const snap = built(f.algo, nextDay());
      assert.deepEqual([snap.statement.tree.algo, snap.statement.tree.padding], [f.algo, f.padding]);
      assert.deepEqual(snap.statement.totals, { BTC: owed('BTC'), USDT: owed('USDT') }, 'what is owed does not depend on the format');
      roots.add(snap.tree.root);
      const r = await submit(h, ex, snap);
      assert.equal(r.status, 201, `${f.algo}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json['status'], 'ACCEPTED');
      const pub = await published(h, r.json['snapshot_id'] as string);
      assert.equal(pub.status, 200);
      assert.deepEqual(pub.json['statement'], snap.statement);
      // Every account — the one that holds nothing included — proves itself from what is published.
      for (const leaf of leaves) {
        const { user_ref: _staysWithTheExchange, ...opening } = leaf;
        const proof = provePorLeaf(snap.tree, snap.tree.index[leaf.user_ref]!, opening);
        const read = verifyPorInclusion(proof, { root: pub.json['statement']['tree']['root'], totals: pub.json['statement']['totals'] });
        assert.equal(read.ok, true, `${f.algo} ${leaf.user_ref}: ${JSON.stringify(read)}`);
      }

      // Sampled: the platform checks the openings of either format.
      const sampled = built(f.algo, nextDay());
      const c = await submit(h, ex, sampled, { spot_check: true });
      assert.equal(c.json['status'], 'CHALLENGED', `${f.algo}: ${JSON.stringify(c.json)}`);
      const v = await answer(h, ex, c.json['snapshot_id'] as string, open(sampled, c.json['challenge']['indices'] as number[]));
      assert.equal(v.status, 200, `${f.algo}: ${JSON.stringify(v.json)}`);
      assert.equal(v.json['status'], 'VERIFIED');
    }
    assert.equal(roots.size, 2, 'the two formats are two trees: a root belongs to the one its statement names');

    // The openings of one format do not answer a challenge to the other.
    const asof = nextDay();
    const asked = built('merkle-sum-sha256-v2', asof);
    const other = built('merkle-sum-sha256-v1', asof);
    const challenge = await submit(h, ex, asked, { spot_check: true });
    const crossed = await answer(h, ex, challenge.json['snapshot_id'] as string, open(other, challenge.json['challenge']['indices'] as number[]));
    assert.equal(crossed.status, 422, JSON.stringify(crossed.json));
    assert.equal(crossed.json['status'], 'REJECTED');

    // A format this platform does not know, and one format written with the other's padding.
    const good = built('merkle-sum-sha256-v2', nextDay());
    const stored = await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots');
    for (const tree of [
      { ...good.statement.tree, algo: 'merkle-sum-sha256-v3' },
      { ...good.statement.tree, padding: 'empty-zero' },
      { ...good.statement.tree, algo: 'merkle-sum-sha256-v1' },
    ]) {
      const statement = { ...good.statement, tree } as unknown as PorSnapshotStatement;
      const r = await submit(h, ex, { statement, sig: signEvent(statement, ex.key, ex.institutionId, ex.name) });
      assert.equal(r.status, 400, `${JSON.stringify(tree)}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json['error'], 'invalid_statement');
    }
    assert.equal(await count(h, 'SELECT COUNT(*) AS n FROM por_snapshots'), stored, 'a refused statement stores nothing');
  } finally { h.close(); }
});

test('the SDK an exchange is given speaks this protocol — its client and its command line, against the real routes', async () => {
  const h = await start();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-sdk-'));
  try {
    const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
    const client = new PorClient({
      core: h.base, apiKey: ex.token, institutionId: ex.institutionId, institutionName: ex.name, key: ex.key,
    });
    await client.assertRegistered();

    // The library, default path: the statement and its signature, nothing else.
    const s = snapshot(ex, 20);
    const first = await client.publish({ statement: s.statement });
    assert.equal(first.status, 'ACCEPTED');
    assert.equal(first.sampled, 0);
    assert.equal(first.already, false);
    const again = await client.publish({ statement: s.statement });
    assert.deepEqual([again.snapshotId, again.attestationId, again.already], [first.snapshotId, first.attestationId, true]);
    const held = await client.status(first.snapshotId);
    assert.equal(held.root, s.tree.root);
    assert.equal(held.spot_check, false);
    assert.deepEqual(held.totals, s.tree.totals);

    // The library, with the spot check the exchange asks for.
    const s2 = snapshot(ex, 20, { asof: '2026-11-17T00:00:00.000Z' });
    const sampled = await client.publish({ statement: s2.statement, tree: s2.tree, leaves: s2.leaves, spotCheck: true });
    assert.equal(sampled.status, 'VERIFIED');
    assert.equal(sampled.sampled, 8);
    assert.ok(sampled.openings!.every((o) => (o.leaf as unknown as Record<string, unknown>)['user_ref'] === undefined));

    // The command line, from a balance file: check → build → sign → submit.
    const cli = path.resolve(import.meta.dirname, '../../../packages/attest-por/src/cli.ts');
    const run = async (...args: string[]): Promise<string> =>
      (await promisify(execFile)('node', [cli, ...args], { env: { ...process.env, STONEHASH_API_KEY: ex.token } })).stdout;
    const csv = path.join(dir, 'balances.csv');
    writeFileSync(csv, 'account_id,asset,balance\n'
      + Array.from({ length: 30 }, (_, i) => `acct-${i + 1},BTC,0.${String(i + 1).padStart(8, '0')}\nacct-${i + 1},USDT,${i + 1}.5`).join('\n') + '\n');
    const keyFile = path.join(dir, 'signing-key.pem');
    writeFileSync(keyFile, ex.key.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });
    const out = path.join(dir, 'snap');
    assert.match(await run('check', '--csv', csv, '--assets', 'BTC:8,USDT:6', '--amounts', 'decimal'), /OK — this file can be built/);
    await run('build', '--csv', csv, '--amounts', 'decimal', '--assets', 'BTC:8,USDT:6', '--exchange', ex.institutionId,
      '--name', ex.name, '--asof', '2026-11-18T00:00:00Z', '--out', out);
    await run('sign', '--tree', out, '--key', keyFile);
    assert.match(await run('submit', '--tree', out, '--core', h.base), /no account was opened to the platform/);
    const receipt = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8')) as Record<string, string>;
    assert.equal(receipt['status'], 'ACCEPTED');

    // What the platform now publishes is the statement the exchange built, and nothing of the file.
    const pub = await published(h, receipt['snapshot_id']!);
    assert.equal(pub.status, 200);
    const statement = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8')) as PorSnapshotStatement;
    assert.equal(pub.json['commitment'], porSnapshotCommitment(statement));
    assert.equal(pub.json['commitment'], receipt['commitment']);
    assert.deepEqual(pub.json['statement'], statement);
    assert.equal(pub.json['spot_check'], false);
    assert.deepEqual(statement.totals, { BTC: '465', USDT: '480000000' });
    assert.ok(!JSON.stringify(pub.json).includes('acct-'), 'no account reference reached the platform');
    assert.match(await run('status', '--core', h.base, '--snapshot', receipt['snapshot_id']!), new RegExp(statement.tree.root));

    // The same directory, with a spot check: answered from the leaves kept on disk.
    assert.match(await run('submit', '--tree', out, '--core', h.base, '--spot-check'), /spot check {3}passed — 8 accounts opened/);
    const spot = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8')) as Record<string, string>;
    assert.equal(spot['status'], 'VERIFIED');
    assert.equal((await published(h, spot['snapshot_id']!)).json['spot_check'], true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    h.close();
  }
});

/*
 * The SDKs in other languages, driven through the one interface they share
 * (`bin/por-example`), against the real routes.
 *
 * Their own suites prove each agrees with the vectors. What only this file
 * can show is the whole loop with the platform in it: a directory built in
 * Java, Go or Python, signed there, accepted here, published, and readable
 * back by the reference — and the reverse. A language whose toolchain or SDK
 * is absent is skipped by name rather than passed in silence.
 */
const SDKS = path.resolve(import.meta.dirname, '../../../sdks');
const SAMPLE_CSV = path.resolve(import.meta.dirname, '../../../packages/attest-por/samples/balances.long.csv');
const SAMPLE_ASSETS = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
const FIXED_SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

for (const lang of ['java', 'go', 'python']) {
  const example = path.join(SDKS, `attest-por-${lang}`, 'bin', 'por-example');
  test(`the ${lang} SDK speaks this protocol end to end, and its files and the reference's are interchangeable`,
    { skip: existsSync(example) ? false : `sdks/attest-por-${lang}/bin/por-example is not present` }, async () => {
      const h = await start();
      const dir = mkdtempSync(path.join(os.tmpdir(), `attest-por-${lang}-`));
      try {
        const ex = await exchange(h, 'ops@hanbit.example', 'Hanbit Exchange');
        const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
          try {
            const r = await promisify(execFile)(example, args, { env: { ...process.env, STONEHASH_API_KEY: ex.token }, maxBuffer: 16 << 20 });
            return { code: 0, stdout: r.stdout, stderr: r.stderr };
          } catch (e) {
            const x = e as { code?: number; stdout?: string; stderr?: string };
            return { code: typeof x.code === 'number' ? x.code : 1, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
          }
        };
        const keyFile = path.join(dir, 'signing-key.pem');
        writeFileSync(keyFile, ex.key.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });

        // What the reference makes of the same file, for this exchange and seed.
        const intake = await readLiabilitiesCsv(SAMPLE_CSV, { assets: SAMPLE_ASSETS, amounts: 'decimal' });
        const refLeaves = intake.rows.map((r) => leafFromRow(ex.institutionId, Buffer.from(FIXED_SEED, 'hex'), r));
        // These SDKs build the first tree format, which the platform goes on
        // accepting; the reference is asked for the same one.
        const refTree = buildPorTree(refLeaves, SAMPLE_ASSETS.map((a) => a.symbol), { algo: 'merkle-sum-sha256-v1' });

        // Built in the other language…
        const out = path.join(dir, 'snap');
        const built = await run('build', '--csv', SAMPLE_CSV, '--amounts', 'decimal', '--assets', 'BTC:8,ETH:18,USDT:6',
          '--exchange', ex.institutionId, '--name', ex.name, '--asof', '2026-11-18T00:00:00Z', '--out', out,
          '--seed-hex', FIXED_SEED, '--generated-at', '2026-11-18T01:02:03.456Z');
        assert.equal(built.code, 0, built.stderr);
        assert.match(built.stdout, new RegExp(`root ${refTree.root}`), 'the same root as the reference');
        const statement = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8')) as PorSnapshotStatement;
        assert.equal(statement.tree.root, refTree.root);
        assert.deepEqual(statement.totals, refTree.totals);
        assert.equal(statement.generated_at, '2026-11-18T01:02:03.456Z');

        // …signed there, accepted here.
        assert.equal((await run('sign', '--dir', out, '--key', keyFile)).code, 0);
        const sent = await run('submit', '--dir', out, '--core', h.base);
        assert.equal(sent.code, 0, sent.stderr);
        const receipt = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(receipt['status'], 'ACCEPTED');
        assert.equal(receipt['spot_check'], false);
        assert.match(sent.stdout, new RegExp(`snapshot ${String(receipt['snapshot_id'])} ACCEPTED`));
        const pub = await published(h, String(receipt['snapshot_id']));
        assert.equal(pub.status, 200);
        assert.equal(pub.json['commitment'], porSnapshotCommitment(statement), 'the platform holds the statement that was built');
        assert.deepEqual(pub.json['statement'], statement);
        assert.equal(pub.json['spot_check'], false);
        assert.ok(!JSON.stringify(pub.json).includes('U-1000'), 'no account reference reached the platform');
        const held = await run('status', '--core', h.base, '--snapshot', String(receipt['snapshot_id']));
        assert.match(held.stdout, new RegExp(refTree.root));

        // The spot check, answered from that language's own tree.
        const spot = await run('submit', '--dir', out, '--core', h.base, '--spot-check');
        assert.equal(spot.code, 0, spot.stderr);
        const spotReceipt = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8')) as Record<string, unknown>;
        assert.equal(spotReceipt['status'], 'VERIFIED');
        assert.equal(spotReceipt['sampled_accounts'], 8);
        const openings = (JSON.parse(readFileSync(path.join(out, 'openings.json'), 'utf8')) as { openings: PorInclusionProof[] }).openings;
        assert.equal(openings.length, 8);
        assert.ok(!JSON.stringify(openings).includes('U-1000') && !JSON.stringify(openings).includes('user_ref"'), 'openings are pseudonymous');
        assert.equal((await published(h, String(spotReceipt['snapshot_id']))).json['spot_check'], true);

        // A proof issued there holds under the reference's verifier, and a tampered one fails in both.
        const proofPath = path.join(dir, 'proof.json');
        assert.equal((await run('prove', '--dir', out, '--user-ref', 'U-100008', '--out', proofPath)).code, 0);
        const proofFile = JSON.parse(readFileSync(proofPath, 'utf8')) as { user_ref: string; proof: PorInclusionProof };
        assert.equal(proofFile.user_ref, 'U-100008');
        assert.equal(verifyPorInclusion(proofFile.proof, { root: refTree.root, totals: refTree.totals }).ok, true);
        assert.equal(proofFile.proof.leaf.balances['BTC'], '2112345678');
        const own = await run('verify-proof', '--proof', proofPath, '--snapshot', path.join(out, 'snapshot.json'));
        assert.equal(own.code, 0, own.stderr);
        assert.match(own.stdout, /root\+totals MATCH/);
        proofFile.proof.leaf.balances['BTC'] = '2112345679';
        const badPath = path.join(dir, 'bad.json');
        writeFileSync(badPath, JSON.stringify(proofFile));
        const refused = await run('verify-proof', '--proof', badPath, '--snapshot', path.join(out, 'snapshot.json'));
        assert.equal(refused.code, 2);
        assert.match(refused.stdout, /root\+totals FAIL/);

        // Its directory loads in the reference…
        const loaded = await loadTreeDir(out);
        assert.equal(loaded.tree.root, refTree.root);
        // …and the reference's directory loads there.
        const refDir = path.join(dir, 'ref');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(refDir);
        await writeTreeDir(refDir, ex.institutionId, refTree, refLeaves);
        writeFileSync(path.join(refDir, 'seed.hex'), FIXED_SEED + '\n', { mode: 0o600 });
        writeFileSync(path.join(refDir, 'snapshot.json'), JSON.stringify(statement, null, 2) + '\n');
        const fromRef = path.join(dir, 'from-ref.json');
        const crossed = await run('prove', '--dir', refDir, '--user-ref', 'U-100001', '--out', fromRef);
        assert.equal(crossed.code, 0, crossed.stderr);
        const crossedProof = JSON.parse(readFileSync(fromRef, 'utf8')) as { proof: PorInclusionProof };
        assert.equal(verifyPorInclusion(crossedProof.proof, { root: refTree.root, totals: refTree.totals }).ok, true);

        // A bad export builds nothing, and says why with the reference's own codes.
        const badCsv = path.join(dir, 'bad.csv');
        writeFileSync(badCsv, 'account_id,asset,balance\nu1,BTC,0.123456789\nu2,BTC,-3\n');
        const nothing = await run('build', '--csv', badCsv, '--amounts', 'decimal', '--assets', 'BTC:8', '--exchange', ex.institutionId,
          '--name', ex.name, '--asof', '2026-11-18T00:00:00Z', '--out', path.join(dir, 'never'));
        assert.equal(nothing.code, 2);
        assert.match(nothing.stderr, /line 2 amount_precision/);
        assert.match(nothing.stderr, /line 3 amount_negative/);
        assert.equal(existsSync(path.join(dir, 'never', 'snapshot.json')), false);

        // Every shared vector, as that SDK itself runs them.
        const conformance = await run('conformance', '--vectors', path.resolve(import.meta.dirname, '../../../fixtures/por'));
        assert.equal(conformance.code, 0, conformance.stdout + conformance.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        h.close();
      }
    });
}

