/**
 * API keys.
 *
 * A key is shown once, at creation, and only its SHA-256 is stored — so a
 * database copy cannot be replayed as a client. Lookup is by hash, which is also
 * why the hash column is UNIQUE.
 *
 * The prefix is deliberately visible and deliberately different per environment:
 * `sk_test_` on sandbox, `sk_live_` on production. Mixing the two is the single
 * most common production accident with keyed APIs, and a key you can identify at
 * a glance in a log or a config file prevents most of it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from './config.ts';
import type { Db } from './db.ts';

export interface KeyMaterial {
  /** Full secret. Returned once and never recoverable afterwards. */
  secret: string;
  hash: string;
  prefix: string;
}

export function keyPrefix(env: Env): string {
  return env === 'live' ? 'sk_live_' : 'sk_test_';
}

export function hashKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function mintKey(env: Env): KeyMaterial {
  const prefix = keyPrefix(env);
  const secret = prefix + randomBytes(24).toString('base64url');
  return { secret, hash: hashKey(secret), prefix };
}

export interface Principal {
  orgId: string;
  keyId: string;
  /** The label the key's owner gave it — what an audit entry names the caller by. */
  label: string;
}

/**
 * Resolve a bearer token to an org, or `null`.
 *
 * Rejects a key whose prefix belongs to the other environment before touching
 * the database: a `sk_live_` token presented to the sandbox is a configuration
 * mistake worth failing loudly, not a lookup miss.
 */
export async function authenticate(db: Db, env: Env, token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const expected = keyPrefix(env);
  if (!token.startsWith(expected)) return null;

  const found = (await db
    .prepare('SELECT id, org_id, key_hash, label FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .get(hashKey(token))) as unknown as { id: string; org_id: string; key_hash: string; label: string } | undefined;
  if (!found) return null;

  // The lookup already matched on a hash, so this is belt-and-braces against a
  // future refactor that widens the query.
  const a = Buffer.from(found.key_hash, 'hex');
  const b = Buffer.from(hashKey(token), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { orgId: found.org_id, keyId: found.id, label: found.label };
}
