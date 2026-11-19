/**
 * Audit log — who called what, when, with what result, per organisation.
 *
 * One row per request that acted as someone. The row is written by the
 * router once the outcome is known and *before* the response goes out, so a
 * reader who asks right after a call already sees the call — the console's
 * audit screen does exactly that, and a record that lagged its own actions
 * would read as entries going missing.
 *
 * What a row names is the credential that acted: an API key by the label
 * its owner gave it ("ci-runner", "settlement-adapter"), a console session
 * by the account's email. The label is copied at write time on purpose — an
 * entry must keep saying who acted after the key is renamed or revoked.
 *
 * Anonymous requests are not here. There is no org to file them under, and a
 * per-tenant record that mixed in unauthenticated probes would be a server
 * log, not an audit trail.
 */
import { randomUUID } from 'node:crypto';
import { likeContains } from './db.ts';
import type { Db } from './db.ts';
import { ServiceError } from './service.ts';

export const AUDIT_SERVICES = ['attest', 'remit', 'por', 'console'] as const;
export type AuditService = typeof AUDIT_SERVICES[number];

export const AUDIT_ACTOR_TYPES = ['api_key', 'session'] as const;
export type AuditActorType = typeof AUDIT_ACTOR_TYPES[number];

/** Who a request acted as. Set on the request context by the auth helper that admitted it. */
export interface AuditActor {
  orgId: string;
  actorType: AuditActorType;
  /** `api_keys.id` or `accounts.id`. */
  actorId: string;
  /** The key's label, or the account's email. */
  actorLabel: string;
}

/** One row, as the console receives it. */
export interface AuditEntry {
  id: string;
  at: string;
  actor_type: AuditActorType;
  actor_id: string;
  actor_label: string;
  service: AuditService;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

/** The actor a console session acts as: the account, named by its email. */
export function sessionActor(account: { id: string; email: string; org_id: string }): AuditActor {
  return { orgId: account.org_id, actorType: 'session', actorId: account.id, actorLabel: account.email };
}

/** The actor an API key acts as: the key, named by the label its owner gave it. */
export function keyActor(p: { orgId: string; keyId: string; label: string }): AuditActor {
  return { orgId: p.orgId, actorType: 'api_key', actorId: p.keyId, actorLabel: p.label };
}

const startsWithAny = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path.startsWith(prefix));

/**
 * Which product a path belongs to, for the per-service view.
 *
 * Decided by path rather than by which file registered the route, because
 * the products straddle files: the stateless settlement evaluators live in
 * routes.ts, the console's anchor screens are the attest product, and
 * `/v1/console/tx` is the attest record list asking the chain. Prefixes, so
 * a new sub-route lands in the right bucket without an edit here. Anything
 * else is the console's own housekeeping: keys, sessions, subscriptions.
 */
export function serviceOf(path: string): AuditService {
  if (startsWithAny(path, ['/v1/settlements', '/v1/quotes', '/v1/manifests', '/v1/remit/'])) return 'remit';
  if (path.startsWith('/v1/por')) return 'por';
  if (startsWithAny(path, ['/v1/attestations', '/v1/issuer-keys', '/v1/public/anchors',
    '/v1/console/attestations', '/v1/console/tx/'])) return 'attest';
  return 'console';
}

/**
 * Reads the console makes on every page view. Recording them would bury the
 * calls an auditor is looking for under thousands of "the dashboard was
 * opened"; the audit endpoint itself is on the list for the same reason,
 * one level up. Only the GET is silent — activating a product is an action,
 * and `POST /v1/console/products` is recorded like any other.
 */
const SILENT_READS: ReadonlySet<string> = new Set([
  '/healthz', '/readyz', '/v1/meta',
  '/v1/console/audit', '/v1/console/me', '/v1/console/dashboard',
  '/v1/console/products', '/v1/console/sandbox',
]);

export function isAudited(method: string, path: string): boolean {
  return !(method === 'GET' && SILENT_READS.has(path));
}

/** MySQL's column is sized to this; a longer path is a client being odd, not something to keep. */
const PATH_MAX = 512;

export interface AuditedRequest {
  method: string;
  /** The request path with no query string: a query may carry a search term, never a credential. */
  path: string;
  status: number;
  durationMs: number;
}

export async function recordAudit(db: Db, actor: AuditActor, req: AuditedRequest): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log
       (id, org_id, at, actor_type, actor_id, actor_label, service, method, path, status, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), actor.orgId, new Date().toISOString(), actor.actorType, actor.actorId, actor.actorLabel,
    serviceOf(req.path), req.method, req.path.slice(0, PATH_MAX), req.status,
    Math.max(0, Math.round(req.durationMs)));
}

export interface AuditSearch {
  service?: string;
  actor_type?: string;
  /** ISO instant; entries at or after it. */
  from?: string;
  /** ISO instant; entries strictly before it, so day ranges chain without overlap. */
  to?: string;
  /** Case-insensitive substring of the path. */
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Opaque; feed back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}

/*
 * Keyset cursor over (at, id), the same scheme as the settlement ledger: an
 * OFFSET re-scans every earlier page and shifts under concurrent inserts,
 * and an audit log is nothing but concurrent inserts.
 */
function encodeCursor(e: AuditEntry): string {
  return Buffer.from(JSON.stringify({ c: e.at, i: e.id }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { c: string; i: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof v.c !== 'string' || typeof v.i !== 'string') throw new Error('shape');
    return { c: v.c, i: v.i };
  } catch {
    throw new ServiceError(400, 'invalid_cursor', 'the cursor is not one this API issued');
  }
}

/**
 * An ISO instant in the canonical form the `at` column is written in, so a
 * bound given with an offset (`+09:00`) compares correctly as text.
 */
function instant(name: string, raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ServiceError(400, 'invalid_filter', `${name} must be an ISO 8601 instant, got ${JSON.stringify(raw)}`);
  }
  return new Date(ms).toISOString();
}

function oneOf(name: string, raw: string, allowed: readonly string[]): string {
  if (!allowed.includes(raw)) {
    throw new ServiceError(400, 'invalid_filter', `${name} must be one of ${allowed.join(', ')}`);
  }
  return raw;
}

/**
 * The page size, as a whole number from 1 to 200.
 *
 * It is interpolated into the SQL rather than bound, so it must be an integer
 * by construction: `?limit=2.5` once reached the engine as `LIMIT 3.5` and
 * came back as a 500. A value that is not a finite number gets the default.
 */
function pageSize(raw: number | undefined): number {
  const n = raw === undefined || !Number.isFinite(raw) ? 50 : Math.floor(raw);
  return Math.max(1, Math.min(n, 200));
}

/** Newest first, filtered in SQL, keyset-paged. */
export async function searchAudit(db: Db, orgId: string, s: AuditSearch): Promise<AuditPage> {
  const limit = pageSize(s.limit);
  const where: string[] = ['org_id = ?'];
  const params: unknown[] = [orgId];
  if (s.service !== undefined) { where.push('service = ?'); params.push(oneOf('service', s.service, AUDIT_SERVICES)); }
  if (s.actor_type !== undefined) { where.push('actor_type = ?'); params.push(oneOf('actor_type', s.actor_type, AUDIT_ACTOR_TYPES)); }
  if (s.from !== undefined) { where.push('at >= ?'); params.push(instant('from', s.from)); }
  if (s.to !== undefined) { where.push('at < ?'); params.push(instant('to', s.to)); }
  if (s.q) { where.push("UPPER(path) LIKE ? ESCAPE '!'"); params.push(likeContains(s.q)); }
  if (s.cursor) {
    const cur = decodeCursor(s.cursor);
    where.push('(at < ? OR (at = ? AND id < ?))');
    params.push(cur.c, cur.c, cur.i);
  }
  // One row beyond the page answers "is there a next page" without a second
  // query and without a phantom empty page at an exact multiple.
  const rows = (await db.prepare(
    `SELECT id, at, actor_type, actor_id, actor_label, service, method, path, status, duration_ms
       FROM audit_log WHERE ${where.join(' AND ')}
      ORDER BY at DESC, id DESC LIMIT ${limit + 1}`,
  ).all(...(params as never[]))) as unknown as AuditEntry[];
  const items = rows.slice(0, limit).map((r) => ({
    ...r, status: Number(r.status), duration_ms: Number(r.duration_ms),
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
