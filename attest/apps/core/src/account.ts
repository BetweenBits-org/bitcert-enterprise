/**
 * Sandbox console accounts and sessions.
 *
 * ## Why accounts exist at all
 *
 * The keyed API deliberately has none: a bearer key is the entire credential,
 * and the free tier does not even need that. What a key cannot do is let a
 * person close the tab and come back, so the console needs sign-in — and the
 * tier's design requires signup to be *instant and ungated*, because a sales
 * call standing between a developer and their first API response is the thing
 * that loses the evaluation.
 *
 * The reason it requires an account rather than nothing is narrow and worth
 * stating: quota attribution, key rotation and abuse control each need a
 * durable identity. Not marketing consent.
 *
 * ## Passwords
 *
 * scrypt from `node:crypto`, per-account salt, parameters stored alongside the
 * digest so they can be raised later without invalidating existing accounts.
 * No dependency — the service has none at runtime and an auth library would be
 * the first, in the one place where "code I have not read" is least welcome.
 *
 * OAuth (GitHub, Google) is the design's other listed option and is not here:
 * it needs registered client credentials, which are deployment configuration
 * rather than code. The schema does not block it — an `accounts` row simply
 * would not carry a `password_hash`.
 *
 * ## Sessions
 *
 * Stored, not stateless. A signed self-contained cookie cannot be revoked
 * before it expires, which would make "log out" a word the product used without
 * meaning. The cookie carries a random token; the database holds its hash, so a
 * copy of the database cannot be replayed as a logged-in browser.
 */
import {
  createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual,
} from 'node:crypto';
import type { Db } from './db.ts';

/**
 * scrypt cost. N=2^15 with r=8 is a few hundred milliseconds here, which is the
 * right order for a login: slow enough to make an offline guess expensive,
 * fast enough that a person does not notice.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1, keylen: 32 } as const;

/**
 * scrypt needs roughly `128 * N * r` bytes, and Node caps it at 32 MiB unless
 * told otherwise. These parameters need exactly 32 MiB, so the default limit
 * rejected them and the first signup failed with `memory limit exceeded` —
 * a message that points nowhere near the cost settings that caused it.
 *
 * Derived from the parameters rather than hardcoded, with headroom, so raising
 * N later cannot quietly reintroduce the same failure.
 */
const maxmem = (N: number, r: number): number => 256 * N * r;

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Cookie name. `__Host-` is omitted deliberately: it demands HTTPS, and the
 * test box is plain HTTP behind no proxy. Production sets `COOKIE_SECURE=1`. */
export const SESSION_COOKIE = 'stonehash_session';

const nowIso = (): string => new Date().toISOString();

export interface Account {
  id: string;
  email: string;
  org_id: string;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

// ── passwords ──────────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: maxmem(SCRYPT.N, SCRYPT.r) });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Constant-time verification against a stored digest.
 *
 * Parameters come from the stored string rather than from `SCRYPT`, so raising
 * the cost does not lock out accounts created under the old one.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr); const r = Number(rStr); const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(hashB64!, 'base64');
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltB64!, 'base64'), expected.length,
      { N, r, p, maxmem: maxmem(N, r) });
  } catch {
    // Absurd stored parameters would otherwise throw and 500 a login attempt.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Minimum password rules, kept short on purpose.
 *
 * Length is the only requirement that reliably helps. Composition rules
 * ("one digit, one symbol") push people towards `Password1!` and are not worth
 * the friction on a sandbox signup.
 */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'a password is required';
  if (password.length < 10) return 'the password must be at least 10 characters';
  if (password.length > 200) return 'the password must be at most 200 characters';
  return null;
}

/** Accepts what can actually be delivered to, and rejects the obvious rest. */
export function normaliseEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  // One `@`, something either side, a dot in the domain. Deliberately not a
  // full RFC 5322 attempt — that regex is famous for rejecting valid addresses.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

// ── accounts ───────────────────────────────────────────────────────────────

export async function findAccountByEmail(db: Db, email: string): Promise<(Account & { password_hash: string }) | null> {
  return ((await db.prepare('SELECT * FROM accounts WHERE email = ?').get(email)) as unknown as
    (Account & { password_hash: string }) | undefined) ?? null;
}

export async function findAccount(db: Db, id: string): Promise<Account | null> {
  return ((await db.prepare(
    'SELECT id, email, org_id, created_at, last_login_at, disabled_at FROM accounts WHERE id = ?',
  ).get(id)) as unknown as Account | undefined) ?? null;
}

export async function createAccount(db: Db, email: string, password: string, orgId: string): Promise<Account> {
  const id = randomUUID();
  await db.prepare(
    'INSERT INTO accounts (id, email, password_hash, org_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, email, hashPassword(password), orgId, nowIso());
  return (await findAccount(db, id))!;
}

export async function recordLogin(db: Db, accountId: string): Promise<void> {
  await db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(nowIso(), accountId);
}

// ── sessions ───────────────────────────────────────────────────────────────

const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export interface NewSession { token: string; expiresAt: Date }

export async function createSession(db: Db, accountId: string, userAgent?: string): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.prepare(
    'INSERT INTO sessions (token_hash, account_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), accountId, nowIso(), expiresAt.toISOString(), (userAgent ?? '').slice(0, 200));
  return { token, expiresAt };
}

/**
 * Resolve a session cookie to an account, or `null`.
 *
 * An expired row is deleted on the way past rather than left to a sweeper: the
 * request already found it, and a session table that only grows is how a
 * "temporary" row becomes permanent.
 */
export async function accountForSession(db: Db, token: string | undefined): Promise<Account | null> {
  if (!token) return null;
  const found = (await db.prepare('SELECT account_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token))) as unknown as { account_id: string; expires_at: string } | undefined;
  if (!found) return null;
  if (new Date(found.expires_at).getTime() <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  const account = await findAccount(db, found.account_id);
  if (!account || account.disabled_at) return null;
  return account;
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Every other session for this account — what "sign out everywhere" needs. */
export async function destroyOtherSessions(db: Db, accountId: string, keepToken: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE account_id = ? AND token_hash != ?')
    .run(accountId, hashToken(keepToken));
}

export async function purgeExpiredSessions(db: Db): Promise<number> {
  const r = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  return Number(r.changes ?? 0);
}

// ── cookies ────────────────────────────────────────────────────────────────

/**
 * `Set-Cookie` for a session.
 *
 * `HttpOnly` so a script cannot read it, and `SameSite=Lax` so it does not ride
 * along on a cross-site POST — the console has no CSRF token, and `Lax` is what
 * makes that safe rather than an oversight. `Secure` is configuration because
 * the test box serves plain HTTP and a `Secure` cookie would simply never be
 * stored, making the console appear broken for a reason nobody would guess.
 */
export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The session token from a `Cookie` header, if present. */
export function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}
