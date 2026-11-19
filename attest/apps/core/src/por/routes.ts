/**
 * Proof-of-reserves API — the platform's half of mode C.
 *
 * The exchange built the tree; the platform never sees it. What arrives is
 * the signed snapshot statement — root, per-asset totals, leaf count, as-of
 * time — and its commitment is what reaches Bitcoin. There are two ways in,
 * and every snapshot says publicly which one it took:
 *
 *   root only (the default)
 *     submit       — the exchange's signature and the statement's shape are
 *                    checked, the commitment is issued into the ordinary
 *                    anchoring pipeline under the exchange's own org at once,
 *                    and the snapshot is ACCEPTED. No account-level data
 *                    leaves the exchange.
 *
 *   spot check (`spot_check: true`, when the exchange asks for it) — a
 *   protocol, not an upload:
 *     1. submit    — the same checks, answered with a random challenge;
 *                    nothing is anchored yet.
 *     2. openings  — the exchange opens exactly the challenged leaves; each is
 *                    verified against the declared root *and totals* with the
 *                    same `verifyPorInclusion` every user runs. Pass → VERIFIED,
 *                    and the commitment is issued exactly as on the other path.
 *
 * What each does and does not establish, stated because the UI must say it
 * too.
 *
 * Root only: the platform checked that the registered EXCHANGE key signed the
 * statement and that the statement is well formed — nothing about the tree's
 * contents. It never saw a leaf, so nothing it publishes may read as if it
 * had sampled one. What the anchor fixes is that the exchange published this
 * root and these totals at this time; the tree behind them is checked by the
 * exchange's users, one inclusion proof at a time, against that root.
 *
 * Spot check: it makes a malformed or internally inconsistent tree likely to
 * be caught (each opening also re-proves the declared totals), and it reveals
 * K pseudonymous balances to the platform. It does not prove every leaf is a
 * real customer — that is the user-side verification's job on either path,
 * and closing the gap without disclosure is the ZK upgrade (P2).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { HttpError, HttpResult } from '../http/server.ts';
import type { Ctx, Router } from '../http/server.ts';
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import { verifyPorInclusion, porSnapshotCommitment } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import { validateSnapshotStatement } from '@stonehash/attest-por';
import type { PorSnapshotStatement } from '@stonehash/attest-por';
import { measureReserves, solvency } from './reserves.ts';
import { verifyEvent } from '../remit/sign.ts';
import type { EventSig } from '../remit/sign.ts';
import type { Registry } from '../remit/registry.ts';
import type { Db } from '../db.ts';

export interface PorRouteDeps {
  db: Db;
  svc: AttestService;
  registry: Registry;
  requireAuth: (ctx: Ctx) => Promise<string>;
  /** Local chain params for reserve measurement. */
  chain: { label: string; rpc: string };
}

interface SnapshotRow {
  id: string;
  org_id: string;
  institution_id: string;
  status: 'ACCEPTED' | 'CHALLENGED' | 'VERIFIED' | 'REJECTED';
  statement: string;
  sig: string;
  commitment: string;
  root: string;
  asof: string;
  leaf_count: number;
  totals: string;
  challenge: string;
  problems: string | null;
  reserves: string | null;
  attestation_id: string | null;
  /** The key the signature was verified against at acceptance; null on rows older than the column. */
  signing_spki: string | null;
  created_at: string;
  updated_at: string;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Which path a stored snapshot took. Root-only snapshots are exactly the
 * ACCEPTED ones — a spot-checked snapshot is CHALLENGED, then VERIFIED or
 * REJECTED — so the status is the record of the path, and the keyed API and
 * the console dashboard both read `spot_check` off it here.
 */
export function spotChecked(status: string): boolean {
  return status !== 'ACCEPTED';
}

/** How many leaves the platform opens. Soft confidence, hard honesty. */
function challengeSize(leafCount: number): number {
  return Math.min(8, leafCount);
}

function drawChallenge(leafCount: number): number[] {
  const k = challengeSize(leafCount);
  const picked = new Set<number>();
  while (picked.size < k) picked.add(randomInt(leafCount));
  return [...picked].sort((a, b) => a - b);
}

/**
 * What would let a commitment be issued and then fail before its snapshot row
 * is written — reserve entries the measurement cannot read, a leaf count the
 * row cannot hold (por_snapshots.leaf_count is a signed 32-bit INT on MySQL).
 * The SDK's shape check does not look at either, and on the root-only path
 * nothing else stands between a signed statement and the chain.
 */
function unanchorable(statement: PorSnapshotStatement): string[] {
  const p: string[] = [];
  if (statement.tree.leaf_count > 2_147_483_647) p.push('tree.leaf_count must be at most 2147483647');
  const reserves = statement.reserves as unknown as { entries?: unknown } | null | undefined;
  if (reserves !== undefined && reserves !== null && reserves.entries !== undefined) {
    if (!Array.isArray(reserves.entries)) p.push('reserves.entries must be an array');
    else {
      for (const [i, e] of (reserves.entries as unknown[]).entries()) {
        const x = e as Record<string, unknown> | null;
        const ok = x !== null && typeof x === 'object'
          && ['chain', 'asset', 'address'].every((k) => typeof x[k] === 'string' && x[k] !== '')
          && (x['token_contract'] === undefined || typeof x['token_contract'] === 'string');
        if (!ok) p.push(`reserves.entries[${i}] must be { chain, asset, address, token_contract? } with string values`);
      }
    }
  }
  return p;
}

/**
 * Give every snapshot stored before `signing_spki` existed the key it was
 * signed with, while the institution still holds that key.
 *
 * Run once at boot. A key is written only if it verifies the signature that
 * is stored beside it, so a row whose institution has already rotated stays
 * empty rather than being stamped with a key that never signed it — the
 * public material then falls back to the institution's current key, exactly
 * as it did before, and nothing is made worse. Returns how many rows it
 * filled; zero on every boot after the first.
 */
export async function backfillSnapshotKeys(d: Pick<PorRouteDeps, 'db' | 'registry'>): Promise<number> {
  const pending = (await d.db.prepare(
    'SELECT id, institution_id, statement, sig FROM por_snapshots WHERE signing_spki IS NULL',
  ).all()) as unknown as Pick<SnapshotRow, 'id' | 'institution_id' | 'statement' | 'sig'>[];
  let filled = 0;
  for (const s of pending) {
    const inst = await d.registry.institution(s.institution_id);
    if (!inst?.signing_spki) continue;
    let signedWithIt = false;
    try {
      signedWithIt = verifyEvent(JSON.parse(s.statement) as unknown, JSON.parse(s.sig) as EventSig, inst.signing_spki);
    } catch {
      signedWithIt = false;
    }
    if (!signedWithIt) continue;
    await d.db.prepare('UPDATE por_snapshots SET signing_spki = ? WHERE id = ? AND signing_spki IS NULL')
      .run(inst.signing_spki, s.id);
    filled++;
  }
  return filled;
}

export function registerPorRoutes(r: Router, d: PorRouteDeps): void {
  const row = async (id: string): Promise<SnapshotRow | null> =>
    ((await d.db.prepare('SELECT * FROM por_snapshots WHERE id = ?').get(id)) as unknown as SnapshotRow) ?? null;

  /** The org's root-only snapshot of this exact statement, if it already has one. */
  const acceptedRow = async (orgId: string, commitment: string): Promise<SnapshotRow | null> =>
    ((await d.db.prepare(
      `SELECT * FROM por_snapshots
        WHERE org_id = ? AND commitment = ? AND status = 'ACCEPTED' ORDER BY created_at LIMIT 1`,
    ).get(orgId, commitment)) as unknown as SnapshotRow) ?? null;

  const wire = async (s: SnapshotRow, opts: { includeChallenge: boolean }): Promise<Record<string, unknown>> => {
    const att = s.attestation_id
      ? ((await d.db.prepare('SELECT id, status FROM attestations WHERE id = ?').get(s.attestation_id)) as
          unknown as { id: string; status: string } | undefined)
      : undefined;
    return {
      snapshot_id: s.id,
      status: s.status,
      spot_check: spotChecked(s.status),
      exchange: s.institution_id,
      asof: s.asof,
      root: s.root,
      leaf_count: s.leaf_count,
      totals: JSON.parse(s.totals) as unknown,
      commitment: s.commitment,
      // A root-only snapshot was never challenged; an empty challenge object
      // would read as one that was.
      ...(opts.includeChallenge && spotChecked(s.status) ? { challenge: JSON.parse(s.challenge) as unknown } : {}),
      ...(s.problems ? { problems: JSON.parse(s.problems) as unknown } : {}),
      ...(s.reserves ? { reserves: JSON.parse(s.reserves) as unknown } : {}),
      attestation: att ? { id: att.id, status: att.status } : null,
      created_at: s.created_at,
    };
  };

  const insert = async (s: {
    id: string; orgId: string; institutionId: string; status: 'ACCEPTED' | 'CHALLENGED';
    statement: PorSnapshotStatement; sig: EventSig; commitment: string; challenge: unknown;
    /** The key the signature above was just verified against. */
    signingSpki: string;
    attestationId?: string; reserves?: unknown;
  }): Promise<void> => {
    const at = nowIso();
    await d.db.prepare(
      `INSERT INTO por_snapshots
         (id, org_id, institution_id, status, statement, sig, commitment, root, asof,
          leaf_count, totals, challenge, reserves, attestation_id, signing_spki, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.orgId, s.institutionId, s.status,
      JSON.stringify(s.statement), JSON.stringify(s.sig),
      s.commitment, s.statement.tree.root, s.statement.asof,
      s.statement.tree.leaf_count, JSON.stringify(s.statement.totals),
      JSON.stringify(s.challenge),
      s.reserves ? JSON.stringify(s.reserves) : null, s.attestationId ?? null, s.signingSpki, at, at);
  };

  /**
   * The step both paths end in: the commitment goes down the same
   * batching/anchoring path as every other attestation, owned by the
   * exchange's org, and the reserves the statement declares are measured.
   * One helper, so a root-only snapshot is anchored and measured exactly as a
   * spot-checked one is — the paths differ in what was checked first, never
   * in what reaches the chain or the reserve report.
   */
  const anchorAndMeasure = async (
    orgId: string, s: Pick<SnapshotRow, 'id' | 'commitment' | 'root' | 'asof'>, statement: PorSnapshotStatement,
    readAt: 'acceptance' | 'verification',
  ): Promise<{ attestationId: string; reserves: unknown }> => {
    /*
     * Measured before the commitment is issued: a measurement that throws
     * after the issue would leave an anchor with no snapshot behind it.
     *
     * Reserve side, measured not trusted: declared addresses on the local
     * chain are read via eth_call right now; everything else stays
     * DECLARED_ONLY. The report is stored with the snapshot and travels on
     * the public endpoint next to the liability commitment it answers.
     */
    let reserves: unknown = null;
    if (statement.reserves?.entries?.length) {
      const measurements = await measureReserves(statement.reserves.entries, d.chain.label, d.chain.rpc);
      reserves = {
        declared: statement.reserves.entries.length,
        measurements,
        solvency: solvency(statement.totals, measurements),
        // Worded by path: a root-only snapshot was accepted, not verified.
        note: `balances read on chain at ${readAt} time; address control is a declared claim in the sandbox`,
      };
    }
    // Re-submitting an identical statement reuses its existing anchor rather
    // than minting a second leaf for the same bytes.
    let attestationId: string;
    try {
      attestationId = (await d.svc.issue(orgId, s.commitment, 'application/json', {
        kind: 'por-snapshot', snapshot_id: s.id, root: s.root, asof: s.asof,
      }, { product: 'por' })).id;
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'duplicate_digest') {
        const existing = (await d.db.prepare(
          'SELECT id FROM attestations WHERE org_id = ? AND leaf_bytes = ?',
        ).get(orgId, s.commitment)) as unknown as { id: string };
        attestationId = existing.id;
      } else {
        throw e;
      }
    }
    return { attestationId, reserves };
  };

  /** What a root-only submission is answered with — first time, or replayed from the stored row. */
  const acceptedAnswer = (id: string, attestationId: string | null, reserves: unknown): Record<string, unknown> => ({
    snapshot_id: id,
    status: 'ACCEPTED',
    spot_check: false,
    attestation_id: attestationId,
    ...(reserves ? { reserves } : {}),
    note: 'the exchange signature was verified and the snapshot commitment is in the anchoring pipeline; '
      + 'no account was opened to the platform — poll GET for anchor status',
  });

  /*
   * Root-only submissions of one statement run one at a time. The replay
   * check and the insert sit either side of reserve measurement, which is a
   * network call per declared address — seconds each when the RPC hangs — so
   * a retry sent while the first attempt is still measuring would pass the
   * check and store a second snapshot of the same statement. One process
   * serves this API (see service.ts), so a queue in memory is enough to
   * close that.
   */
  const queued = new Map<string, Promise<unknown>>();
  const oneAtATime = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    // Once the attempt ahead has settled, whichever way: its failure is its
    // own caller's answer, not this one's.
    const run = (queued.get(key) ?? Promise.resolve()).then(fn, fn);
    queued.set(key, run);
    try {
      return await run;
    } finally {
      if (queued.get(key) === run) queued.delete(key);
    }
  };

  // ── Submit: anchor at once, or — when asked — receive the challenge ─────
  r.post('/v1/por/snapshots', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const { exchange } = await d.registry.requirePor(orgId);
    // `?? {}`: a body of JSON null is a missing field, not a server fault.
    const body = ((await ctx.body()) ?? {}) as { statement?: PorSnapshotStatement; sig?: EventSig; spot_check?: unknown };
    const statement = body.statement;
    if (!statement || !body.sig) {
      throw new HttpError(400, 'missing_field', 'statement and sig are required');
    }
    // Refused, not coerced: the path is what the public record states, and
    // "yes" or 1 read either way would put the snapshot on one its sender
    // may not have meant.
    if (body.spot_check !== undefined && typeof body.spot_check !== 'boolean') {
      throw new HttpError(400, 'invalid_field', 'spot_check must be true or false');
    }
    const problems = validateSnapshotStatement(statement);
    if (problems.length > 0) {
      throw new HttpError(400, 'invalid_statement', problems.join('; '));
    }
    if (statement.exchange.institution_id !== exchange.id) {
      throw new HttpError(403, 'institution_mismatch',
        `statement names ${statement.exchange.institution_id}; this organisation's registered exchange is ${exchange.id}`);
    }
    // Under the exchange's signing key, or under the key its console session
    // registered for the reserve screen. Which of the two is kept with the
    // snapshot, so the public material names the key that actually signed.
    const sig = body.sig;
    const signedWith = [exchange.signing_spki!, ...(exchange.console_spki ? [exchange.console_spki] : [])]
      .find((spki) => verifyEvent(statement, sig, spki));
    if (!signedWith) {
      throw new HttpError(400, 'invalid_signature',
        'sig does not verify over the statement with the registered EXCHANGE key');
    }
    // Last, because it is new: refused before anything is issued, so a
    // statement that cannot be measured or stored never reaches the chain.
    const unstorable = unanchorable(statement);
    if (unstorable.length > 0) {
      throw new HttpError(400, 'invalid_statement', unstorable.join('; '));
    }

    const submitted = {
      orgId, institutionId: exchange.id, statement, sig: body.sig,
      commitment: porSnapshotCommitment(statement),
      signingSpki: signedWith,
    };

    if (body.spot_check === true) {
      const id = randomUUID();
      const challenge = {
        indices: drawChallenge(statement.tree.leaf_count),
        issued_at: nowIso(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      };
      await insert({ ...submitted, id, status: 'CHALLENGED', challenge });
      return new HttpResult(201, {
        snapshot_id: id,
        status: 'CHALLENGED',
        spot_check: true,
        challenge,
        next: `open the challenged leaves with the SDK and POST them to /v1/por/snapshots/${id}/openings`,
      });
    }

    // Root only: nothing to wait for, so the statement is anchored now. The
    // same statement sent again is the same snapshot, not a second one.
    return oneAtATime(`${orgId}:${submitted.commitment}`, async () => {
      const stored = await acceptedRow(orgId, submitted.commitment);
      if (stored) {
        return new HttpResult(200, {
          ...acceptedAnswer(stored.id, stored.attestation_id,
            stored.reserves ? JSON.parse(stored.reserves) as unknown : null),
          already: true,
        });
      }
      const id = randomUUID();
      const anchored = await anchorAndMeasure(orgId,
        { id, commitment: submitted.commitment, root: statement.tree.root, asof: statement.asof }, statement, 'acceptance');
      // The challenge column is NOT NULL and older than this path; what it
      // holds for a root-only row says outright that there was no challenge.
      await insert({ ...submitted, id, status: 'ACCEPTED', challenge: { spot_check: false, indices: [] }, ...anchored });
      return new HttpResult(201, acceptedAnswer(id, anchored.attestationId, anchored.reserves));
    });
  });

  // ── Openings (spot check only): verify the sample, then anchor ──────────
  r.post('/v1/por/snapshots/:id/openings', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    await d.registry.requirePor(orgId);
    const s = await row(ctx.params.id!);
    if (!s || s.org_id !== orgId) throw new HttpError(404, 'not_found', `no snapshot ${ctx.params.id}`);
    if (s.status === 'ACCEPTED') {
      throw new HttpError(409, 'wrong_state',
        'snapshot was accepted without a spot check; no leaves were challenged, so there is nothing to open');
    }
    if (s.status !== 'CHALLENGED') {
      throw new HttpError(409, 'wrong_state', `snapshot is ${s.status}; openings are accepted once, while CHALLENGED`);
    }
    const challenge = JSON.parse(s.challenge) as { indices: number[]; expires_at: string };
    if (Date.parse(challenge.expires_at) < Date.now()) {
      throw new HttpError(409, 'challenge_expired', 'the challenge window has passed; submit a fresh snapshot');
    }
    const body = ((await ctx.body()) ?? {}) as { openings?: PorInclusionProof[] };
    const openings = body.openings;
    if (!Array.isArray(openings)) throw new HttpError(400, 'missing_field', 'openings[] is required');

    const statement = JSON.parse(s.statement) as PorSnapshotStatement;
    const problems: string[] = [];

    const provided = openings.map((o) => o.leaf_index).sort((a, b) => a - b);
    if (JSON.stringify(provided) !== JSON.stringify(challenge.indices)) {
      problems.push(`openings must cover exactly the challenged indices ${challenge.indices.join(',')} (got ${provided.join(',')})`);
    }
    for (const o of openings) {
      const r2 = verifyPorInclusion(o, { root: statement.tree.root, totals: statement.totals });
      if (!r2.ok) problems.push(`leaf ${o.leaf_index}: ${r2.problems.join('; ')}`);
    }

    if (problems.length > 0) {
      await d.db.prepare("UPDATE por_snapshots SET status = 'REJECTED', problems = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(problems), nowIso(), s.id);
      return new HttpResult(422, { snapshot_id: s.id, status: 'REJECTED', problems });
    }

    const { attestationId, reserves } = await anchorAndMeasure(orgId, s, statement, 'verification');
    await d.db.prepare(
      "UPDATE por_snapshots SET status = 'VERIFIED', attestation_id = ?, reserves = ?, updated_at = ? WHERE id = ?",
    ).run(attestationId, reserves ? JSON.stringify(reserves) : null, nowIso(), s.id);

    return {
      snapshot_id: s.id,
      status: 'VERIFIED',
      sampled_leaves: challenge.indices.length,
      attestation_id: attestationId,
      ...(reserves ? { reserves } : {}),
      note: 'the snapshot commitment is now in the anchoring pipeline; poll GET for anchor status',
    };
  });

  // ── Status ──────────────────────────────────────────────────────────────
  r.get('/v1/por/snapshots', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const rows = (await d.db.prepare(
      'SELECT * FROM por_snapshots WHERE org_id = ? ORDER BY created_at DESC LIMIT 100',
    ).all(orgId)) as unknown as SnapshotRow[];
    return { data: await Promise.all(rows.map((s) => wire(s, { includeChallenge: false }))) };
  });

  r.get('/v1/por/snapshots/:id', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const s = await row(ctx.params.id!);
    if (!s || s.org_id !== orgId) throw new HttpError(404, 'not_found', `no snapshot ${ctx.params.id}`);
    return wire(s, { includeChallenge: true });
  });

  /**
   * Public verification material — what an exchange's user (or anyone) needs
   * to check a proof: the statement, the exchange's signature over it, and
   * the anchor bundle once confirmed. Public by design: a reserve statement
   * that only its subject can read proves little.
   *
   * Published means anchored by either path, and the answer says which: the
   * flag, the sampling figure existing readers already show, and the list of
   * what the platform itself checked before anchoring. A root-only snapshot
   * reports no sampled leaves and no `spot_check` among the checks — the
   * platform does not claim a sample it did not take.
   */
  r.get('/v1/public/por/snapshots/:id', async (ctx) => {
    const s = await row(ctx.params.id!);
    if (!s || (s.status !== 'VERIFIED' && s.status !== 'ACCEPTED')) {
      throw new HttpError(404, 'not_found', 'no published snapshot with this id');
    }
    let bundle: unknown = null;
    if (s.attestation_id) {
      try {
        bundle = await d.svc.exportBundle(s.org_id, s.attestation_id);
      } catch (e) {
        if (!(e instanceof ServiceError) || (e.code !== 'not_batched' && e.code !== 'not_anchored')) throw e;
      }
    }
    const inst = await d.registry.institution(s.institution_id);
    // The key is the snapshot's own: the one its signature was verified
    // against when it was accepted. An exchange can replace or revoke its key
    // afterwards, and what it published under the old one must go on
    // verifying — a reader checking last quarter's snapshot should not be
    // told the signature is bad because the exchange rotated since. Rows
    // older than the column fall back to the institution's key as it stands.
    const spki = s.signing_spki ?? inst?.signing_spki ?? null;
    // Only a VERIFIED snapshot had leaves opened and checked.
    const sampled = s.status === 'VERIFIED';
    return {
      snapshot_id: s.id,
      statement: JSON.parse(s.statement) as unknown,
      exchange_signature: JSON.parse(s.sig) as unknown,
      exchange_key: spki ? { key_id: s.institution_id, algorithm: 'ES256', spki } : null,
      signature_scheme: 'ECDSA P-256/SHA-256 raw r||s over "stonehash:remit:event:v1\n" + JCS(statement)',
      commitment: s.commitment,
      commitment_scheme: 'SHA256("STONEHASH-POR-V1\\n" || JCS(statement))',
      attestation: s.attestation_id
        ? { id: s.attestation_id, bundle }
        : null,
      ...(s.reserves ? { reserves: JSON.parse(s.reserves) as unknown } : {}),
      spot_check: sampled,
      verified_sampling: { sampled: sampled ? challengeSize(s.leaf_count) : 0, of: s.leaf_count },
      platform_checks: ['exchange_signature', 'statement_shape', ...(sampled ? ['spot_check'] : [])],
    };
  });
}
