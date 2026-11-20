/**
 * The Sandbox Console API.
 *
 * Session-authenticated, and kept separate from the keyed API on purpose. The
 * two have different callers and different threat models: `/v1/attestations` is
 * called by a server holding a secret key, while these are called by a browser
 * holding a cookie. Sharing one surface would mean either the key API accepted
 * cookies — giving every page on the origin the ability to act as the customer —
 * or the console sent a long-lived secret to the browser. Neither is worth the
 * saved file.
 *
 * ## What the console is for
 *
 * Someone evaluating the product signs up, gets a key immediately, and finds a
 * worked example already in their account. The design is explicit that there is
 * no approval queue, because a sales call standing between a developer and
 * their first API response is what loses the evaluation.
 *
 * ## What it does not do
 *
 * It does not wrap the API. Every console read is also available through the
 * keyed API, and the console never does anything a customer could not do with
 * curl — if it did, the demo would be showing a product that does not exist.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, HttpResult, pageLimit } from './server.ts';
import type { Ctx } from './server.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';
import { mintKey, keyPrefix } from '../auth.ts';
import {
  accountForSession, clearedCookie, cookieToken, createAccount, createSession,
  destroyOtherSessions, destroySession, findAccountByEmail, normaliseEmail,
  passwordProblem, recordLogin, sessionCookie, verifyPassword,
} from '../account.ts';
import type { Account } from '../account.ts';
import { searchAudit, sessionActor } from '../audit.ts';
import { es256PublicKeyProblem, publicKeyProblem } from '../remit/sign.ts';
import { spotChecked } from '../por/routes.ts';
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import type { AnchorBackend } from '../anchor/backend.ts';
import type { Config } from '../config.ts';
import { rpc, RpcError } from '../anchor/rpc.ts';
import { HARD_CEILING_BYTES, STANDARD_RELAY_MAX_BODY_BYTES } from '../btc/inscription.ts';
import type { Db } from '../db.ts';

export interface ConsoleDeps {
  cfg: Config;
  db: Db;
  svc: AttestService;
  backend: AnchorBackend;
}

const nowIso = (): string => new Date().toISOString();

/** First day of the current UTC month, which is what the quota resets on. */
function monthStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function str(body: unknown, key: string): unknown {
  return (body as Record<string, unknown> | null | undefined)?.[key];
}

interface MempoolEntry { vsize: number; weight: number; fees: { base: number }; time: number }
interface WalletTx {
  confirmations: number; blockhash?: string; blockheight?: number; blocktime?: number; hex: string;
}

/**
 * What the node currently knows about one of our transactions.
 *
 * Two questions a record list cannot answer from its own database: is it still
 * waiting in the mempool, and if it confirmed, where. Both are properties of
 * the chain at this instant, and a row that reported them from our own
 * `status` column would be repeating what we believed when we last looked.
 *
 * `getmempoolentry` throws once the transaction confirms and `gettransaction`
 * only answers for wallet transactions — so both are tried, and neither being
 * available is itself a reportable state rather than an error.
 */
async function lookupTx(d: ConsoleDeps, txid: string): Promise<Record<string, unknown>> {
  const opts = {
    url: d.cfg.bitcoind.url, user: d.cfg.bitcoind.user, password: d.cfg.bitcoind.password,
    timeoutMs: 5000,
  };
  const out: Record<string, unknown> = { txid, network: d.backend.network, backend: d.backend.name };
  if (d.cfg.explorerBaseUrl) out['explorer_url'] = `${d.cfg.explorerBaseUrl}/tx/${txid}`;

  try {
    const entry = await rpc<MempoolEntry>(opts, 'getmempoolentry', [txid]);
    out['state'] = 'mempool';
    out['vsize'] = entry.vsize;
    out['weight'] = entry.weight;
    out['fee_sats'] = Math.round(entry.fees.base * 1e8);
    out['seen_at'] = new Date(entry.time * 1000).toISOString();
    return out;
  } catch (e) {
    // -5 is "not in the mempool", which for a confirmed transaction is the
    // expected answer, not a failure.
    if (!(e instanceof RpcError)) {
      out['state'] = 'unavailable';
      // A transport error can quote the node's address; that stays here.
      console.error('[console] tx lookup: node unavailable:', e instanceof Error ? e.name : typeof e);
      out['detail'] = 'the node did not answer';
      return out;
    }
  }

  try {
    const tx = await rpc<WalletTx>(opts, 'gettransaction', [txid, true, true], d.cfg.bitcoind.wallet);
    out['state'] = tx.confirmations > 0 ? 'confirmed' : 'pending';
    out['confirmations'] = tx.confirmations;
    if (tx.blockhash) out['block_hash'] = tx.blockhash;
    if (typeof tx.blockheight === 'number') out['block_height'] = tx.blockheight;
    if (typeof tx.blocktime === 'number') out['block_time'] = new Date(tx.blocktime * 1000).toISOString();
    out['size_bytes'] = tx.hex.length / 2;
  } catch (e) {
    out['state'] = 'unknown';
    out['detail'] = e instanceof RpcError
      ? 'the node has no record of this transaction'
      : 'the node did not answer';
  }
  return out;
}

/**
 * A ceiling on live keys, so a loop in someone's script cannot fill the table.
 * High enough that no honest use hits it: one per environment, plus spares.
 */
const MAX_ACTIVE_KEYS = 10;

/** Labels are for humans; keep them short and free of control characters. */
function cleanLabel(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return t.slice(0, 60) || 'default';
}

export function consoleRoutes(d: ConsoleDeps): Record<string, (ctx: Ctx) => Promise<unknown> | unknown> {
  const authLimiter = new RateLimiter(d.cfg.console.authRateLimit);
  const secure = d.cfg.console.cookieSecure;

  const requireEnabled = (): void => {
    if (!d.cfg.console.enabled) {
      throw new HttpError(503, 'console_disabled', 'the sandbox console is switched off in this deployment');
    }
    if (d.cfg.env !== 'test') {
      // Production accounts are provisioned against a contract. Leaving
      // self-serve signup reachable on `live` would be the kind of default
      // nobody notices until it is used.
      throw new HttpError(403, 'not_available',
        'self-serve console accounts are sandbox-only; production access is provisioned per contract');
    }
  };

  /** The signed-in account, or 401. */
  const requireAccount = async (ctx: Ctx): Promise<Account> => {
    requireEnabled();
    const account = await accountForSession(d.db, cookieToken(ctx.req.headers['cookie']));
    if (!account) throw new HttpError(401, 'not_signed_in', 'sign in to continue');
    ctx.audit = sessionActor(account);
    return account;
  };

  const limitAuth = (ctx: Ctx): void => {
    const wait = authLimiter.check(
      clientKey(ctx.req.headers, ctx.req.socket.remoteAddress, d.cfg.trustProxy));
    if (wait !== null) {
      throw new HttpError(429, 'rate_limited',
        `too many attempts from this address; retry in ${wait}s`);
    }
  };

  /** The org's live key row, if it has one. Only the prefix is ever shown. */
  const activeKey = async (orgId: string) =>
    (await d.db.prepare(
      `SELECT id, label, created_at FROM api_keys
       WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    ).get(orgId)) as unknown as { id: string; label: string; created_at: string } | undefined;

  async function quota(orgId: string): Promise<{ used: number; limit: number; remaining: number; resets: string }> {
    const r = await d.db.prepare(
      // Customer anchoring only: solution-issued records (remit evidence,
      // manifests, PoR snapshots) are included in those products' pricing
      // and must not eat the Attest quota.
      "SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND created_at >= ? AND product = 'attest'",
    ).get(orgId, monthStart()) as unknown as { n: number };
    const used = Number(r?.n ?? 0);
    const limit = d.cfg.console.monthlyQuota;
    const next = new Date();
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resets: new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1)).toISOString(),
    };
  }

  /**
   * Everything the dashboard needs, in one response.
   *
   * Including the chain's honest description: the console must state which
   * network it anchors to and what that network cannot support, because a
   * sandbox that lets someone believe they produced a publicly verifiable proof
   * has misled exactly the person it was trying to convince.
   */
  async function overview(account: Account): Promise<Record<string, unknown>> {
    const org = (await d.db.prepare('SELECT id, slug, name, created_at FROM orgs WHERE id = ?')
      .get(account.org_id)) as unknown as { id: string; slug: string; name: string; created_at: string };
    const key = await activeKey(account.org_id);
    const issuer = (await d.db.prepare(
      'SELECT id, label, algorithm, created_at FROM issuer_keys WHERE org_id = ? AND revoked_at IS NULL',
    ).all(account.org_id)) as unknown as { id: string; label: string; algorithm: string }[];

    return {
      account: {
        id: account.id, email: account.email,
        created_at: account.created_at, last_login_at: account.last_login_at,
      },
      org,
      api_key: key
        // Never the secret. It was shown once, at the moment it was minted.
        ? { id: key.id, label: key.label, prefix: keyPrefix(d.cfg.env), created_at: key.created_at }
        : null,
      issuer_keys: issuer,
      quota: await quota(account.org_id),
      bitcoin_network: d.backend.network,
      anchor_backend: d.backend.name,
      /*
       * The inscription limits, so the console can state them instead of
       * hardcoding a number that drifts from the server's.
       *
       * Three, because they answer different questions: what this deployment
       * accepts, what an ordinary Bitcoin node will relay, and the last-line
       * standardness guard. A console showing only the first cannot explain
       * why raising it would stop working on mainnet.
       */
      /** Empty when no explorer indexes this chain; the console omits the link. */
      explorer_base_url: d.cfg.explorerBaseUrl,
      /**
       * The settlement chain's counterpart: a per-transaction template with
       * `{tx}` where the hash goes, or null — the sandbox's USDC rail is a
       * local chain nothing indexes, and the console shows no link then.
       */
      settlement_explorer_tx_url: d.cfg.remit.explorerTxUrl || null,
      inscription: {
        enabled: d.svc.canInscribe,
        max_bytes: d.cfg.inscriptionMaxBytes,
        standard_relay_max_bytes: STANDARD_RELAY_MAX_BODY_BYTES,
        hard_ceiling_bytes: HARD_CEILING_BYTES,
      },
      /*
       * Written here rather than in the page, so a deployment that moved to
       * mainnet stops saying it without anyone remembering to edit the
       * console. Korean because this endpoint has exactly one consumer and
       * that screen is Korean; `/v1/meta` keeps the English wording for API
       * clients, which are a different audience.
       */
      public_verifiability: d.backend.network === 'mainnet'
        ? '앵커는 공개 비트코인에 기록되며 누구든 제3자가 확인할 수 있습니다 '
          + '(anchors are on public Bitcoin and can be confirmed by any third party).'
        : `앵커는 ${d.backend.network}, 즉 비공개 테스트 체인(private test chain)에 기록됩니다. `
          + '문서에서 해시로, Merkle 포함, 트랜잭션 결합까지는 네트워크 없이 완전히 검증됩니다. '
          + '그러나 블록을 저희가 직접 생성하므로 공개 체인 포함은 여기서 제3자가 확인할 수 '
          + '없습니다 (cannot be confirmed by a third party). 파이프라인 전 구간을 그대로 '
          + '재현하지만, 공개적으로 검증 가능한 증명은 아닙니다.',
    };
  }

  /**
   * Provision a new sandbox tenant.
   *
   * Everything a first call needs exists before the response is sent: the org,
   * a key, a registered demo issuer key, and one worked attestation. The design
   * calls for a first successful call inside a minute, and an empty dashboard
   * with a "create your first attestation" button does not achieve that — it
   * just moves the blank page.
   */
  async function provision(email: string): Promise<{ orgId: string; secret: string }> {
    const slug = `sandbox-${randomUUID().slice(0, 8)}`;
    const orgId = await d.svc.ensureOrg(slug, email.split('@')[0] ?? slug);

    const km = mintKey(d.cfg.env);
    await d.db.prepare(
      `INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), orgId, km.hash, km.prefix, 'default', nowIso());

    // A placeholder public key so the issuer-key surface is not empty. Public
    // material only — this service never holds a private key, which is why the
    // column is `public_key` and there is nothing to leak here.
    await d.db.prepare(
      `INSERT INTO issuer_keys (id, org_id, label, public_key, algorithm, created_at)
       VALUES (?, ?, ?, ?, 'ES256', ?)`,
    ).run(randomUUID(), orgId, 'demo issuer (sandbox)', 'DEMO-PUBLIC-KEY-PLACEHOLDER', nowIso());

    // One worked example, anchored by the ordinary worker like any other.
    // Derived from the org id so two tenants never collide on a digest.
    const sample = createHash('sha256')
      .update(`stonehash:sandbox:sample\n${orgId}`, 'utf8').digest('hex');
    try {
      await d.svc.issue(orgId, sample, 'text/plain',
        { sample: true, note: 'Seeded at signup so your first bundle export has something to export.' });
    } catch (e) {
      // A seeding failure must not fail the signup — the account is still
      // usable, and the dashboard will simply show no attestations.
      if (!(e instanceof ServiceError)) throw e;
    }
    return { orgId, secret: km.secret };
  }

  return {
    /** `POST /v1/console/signup` — instant, no approval queue. */
    signup: async (ctx) => {
      requireEnabled();
      limitAuth(ctx);
      const body = await ctx.body();

      const email = normaliseEmail(str(body, 'email'));
      if (!email) throw new HttpError(400, 'invalid_email', 'provide a valid "email"');
      const pwProblem = passwordProblem(str(body, 'password'));
      if (pwProblem) throw new HttpError(400, 'invalid_password', pwProblem);
      const password = str(body, 'password') as string;

      if (await findAccountByEmail(d.db, email)) {
        // Deliberately explicit. Hiding whether an address is registered is
        // worth it where disclosure is sensitive; on a developer sandbox it
        // only produces people who cannot tell why signup silently failed.
        throw new HttpError(409, 'email_taken',
          'an account already exists for that address — sign in instead');
      }

      const { orgId, secret } = await provision(email);
      const account = await createAccount(d.db, email, password, orgId);
      /*
       * Attest Core is the base product every org has from the first minute
       * — recorded as a real subscription (sandbox plan) so the Products
       * screen and billing speak one language: three products, each with a
       * subscription state, of which this one starts active.
       */
      // Same row, two spellings: MySQL has no ON CONFLICT clause.
      const seed = d.db.dialect === 'mysql'
        ? `INSERT IGNORE INTO subscriptions (id, org_id, product, plan, status, config, created_at)
           VALUES (?, ?, 'attest', 'sandbox', 'active', '{}', ?)`
        : `INSERT INTO subscriptions (id, org_id, product, plan, status, config, created_at)
           VALUES (?, ?, 'attest', 'sandbox', 'active', '{}', ?)
           ON CONFLICT(org_id, product) DO NOTHING`;
      await d.db.prepare(seed).run(randomUUID(), orgId, nowIso());
      const session = await createSession(d.db, account.id, ctx.req.headers['user-agent']);
      await recordLogin(d.db, account.id);
      // The organisation's first audit entry: who opened it.
      ctx.audit = sessionActor(account);

      return new HttpResult(201, {
        ...(await overview({ ...account, last_login_at: nowIso() })),
        // Shown once. Only the hash is stored, so it cannot be recovered later.
        api_key_secret: secret,
        note: 'Store this key now — it is not recoverable. A sample attestation is already in your account.',
      }, { 'set-cookie': sessionCookie(session.token, session.expiresAt, secure) });
    },

    /** `POST /v1/console/login` */
    login: async (ctx) => {
      requireEnabled();
      limitAuth(ctx);
      const body = await ctx.body();
      const email = normaliseEmail(str(body, 'email'));
      const password = str(body, 'password');

      const found = email ? await findAccountByEmail(d.db, email) : null;
      // One message and one code for both "no such account" and "wrong
      // password": the distinction is useful only to someone enumerating
      // addresses. The rate limit above is what makes guessing expensive.
      const ok = found && typeof password === 'string'
        && !found.disabled_at && verifyPassword(password, found.password_hash);
      if (!ok || !found) {
        throw new HttpError(401, 'invalid_credentials', 'that email and password do not match an account');
      }

      const session = await createSession(d.db, found.id, ctx.req.headers['user-agent']);
      await recordLogin(d.db, found.id);
      // A successful sign-in is an audited event; a failed one has no tenant
      // it could be filed under without confirming the address exists.
      ctx.audit = sessionActor(found);
      return new HttpResult(200, await overview({ ...found, last_login_at: nowIso() }),
        { 'set-cookie': sessionCookie(session.token, session.expiresAt, secure) });
    },

    /** `POST /v1/console/logout` — the row is deleted, not just the cookie. */
    logout: async (ctx) => {
      await destroySession(d.db, cookieToken(ctx.req.headers['cookie']));
      return new HttpResult(200, { signed_out: true }, { 'set-cookie': clearedCookie(secure) });
    },

    /** `GET /v1/console/me` — everything the dashboard renders. */
    me: async (ctx) => overview(await requireAccount(ctx)),

    /** `GET /v1/console/attestations` */
    /**
     * `GET /v1/console/attestations[?product=attest|remit|por]`
     *
     * Every product's anchors are in this list — a settlement's evidence and
     * a reserve snapshot are records like a document's — and `product`
     * narrows it to one product's. A value that names no product is refused
     * rather than ignored: a list returned under a filter that was not
     * applied would be a wrong answer that looks like a right one.
     */
    list: async (ctx) => {
      const account = await requireAccount(ctx);
      const product = ctx.query.get('product') || undefined;
      if (product !== undefined && product !== 'attest' && product !== 'remit' && product !== 'por') {
        throw new HttpError(400, 'unknown_product', 'product must be one of: attest, remit, por');
      }
      return {
        data: await d.svc.list(account.org_id, pageLimit(ctx.query.get('limit'), 50, 500), product),
        quota: await quota(account.org_id),
      };
    },

    /**
     * `POST /v1/console/attestations`
     *
     * The same operation as the keyed endpoint, reached with a cookie so the
     * dashboard can offer it without putting the customer's secret key into a
     * page. The quota is enforced here because this is where a browser can
     * reach it in a loop.
     */
    create: async (ctx) => {
      const account = await requireAccount(ctx);
      const q = await quota(account.org_id);
      if (q.remaining <= 0) {
        throw new HttpError(429, 'quota_exhausted',
          `the sandbox allows ${q.limit} attestations per month; this month's allowance resets at ${q.resets}`);
      }
      const body = await ctx.body();
      const raw = str(body, 'sha256') ?? str(body, 'leaf_bytes');
      if (typeof raw !== 'string') {
        throw new HttpError(400, 'missing_digest',
          'provide "sha256": the SHA-256 of your file as 64 hex characters. Hash it locally — the file is never uploaded.');
      }
      const att = await d.svc.issue(account.org_id, raw, str(body, 'content_type') as string | undefined,
        str(body, 'descriptor'));
      return new HttpResult(201, { ...att, quota: await quota(account.org_id) });
    },

    /**
     * `POST /v1/console/attestations/inscribe`
     *
     * The original itself, from the browser. Where `create` takes a digest the
     * page computed locally, this takes the file — because the customer chose
     * the path where the document goes onto the chain, and that is not
     * something the browser can do on its behalf.
     *
     * The distinction is the customer's to make and the console states it
     * plainly on both buttons. What this handler guarantees is the half it
     * controls: the bytes are hashed, inscribed and released, and the only
     * durable record of them is the Bitcoin transaction itself.
     */
    inscribe: async (ctx) => {
      const account = await requireAccount(ctx);
      const q = await quota(account.org_id);
      if (q.remaining <= 0) {
        throw new HttpError(429, 'quota_exhausted',
          `the sandbox allows ${q.limit} attestations per month; this month's allowance resets at ${q.resets}`);
      }
      const contentType = typeof ctx.req.headers['content-type'] === 'string'
        ? ctx.req.headers['content-type'] : 'application/octet-stream';
      const body = await ctx.raw(d.cfg.inscriptionMaxBytes + 64 * 1024);
      if (body.length === 0) {
        throw new HttpError(400, 'empty_body', 'send the document as the raw request body');
      }
      const att = await d.svc.inscribe(account.org_id, new Uint8Array(body), contentType);
      return new HttpResult(201, { ...att, quota: await quota(account.org_id) });
    },

    /**
     * `GET /v1/console/tx/:txid`
     *
     * Look a transaction up on the chain this deployment anchors to, so the
     * record list can show what the node says rather than what our database
     * remembers. Read-only, and scoped to transactions we produced: an open
     * proxy to bitcoind's RPC would let any signed-in account query the
     * node's wallet, which is not theirs to see.
     */
    tx: async (ctx) => {
      const account = await requireAccount(ctx);
      const txid = ctx.params['txid'] ?? '';
      if (!/^[0-9a-f]{64}$/i.test(txid)) {
        throw new HttpError(400, 'invalid_txid', 'a txid is 64 hex characters');
      }
      const mine = await d.db.prepare(
        `SELECT id FROM attestations
          WHERE org_id = ? AND (reveal_txid = ? OR commit_txid = ?
                OR batch_id IN (SELECT batch_id FROM anchor_txs WHERE txid = ?))`,
      ).get(account.org_id, txid.toLowerCase(), txid.toLowerCase(), txid.toLowerCase());
      if (!mine) {
        throw new HttpError(404, 'not_found',
          'no anchor of yours used this transaction. This view reports on your own anchors, '
          + 'not on the chain at large.');
      }
      return lookupTx(d, txid.toLowerCase());
    },

    /**
     * `POST /v1/console/attestations/signed`
     *
     * Anchor a statement the customer signed on their own machine. The
     * console never sees a private key: it hashes the document locally,
     * shows what to sign, and takes back only the signed statement.
     */
    createSigned: async (ctx) => {
      const account = await requireAccount(ctx);
      const q = await quota(account.org_id);
      if (q.remaining <= 0) {
        throw new HttpError(429, 'quota_exhausted',
          `the sandbox allows ${q.limit} attestations per month; this month's allowance resets at ${q.resets}`);
      }
      const body = await ctx.body() as Record<string, unknown>;
      const statement = body['statement'];
      if (!statement || typeof statement !== 'object') {
        throw new HttpError(400, 'missing_statement', 'provide a signed statement');
      }
      const keyId = str(body, 'issuer_key_id');
      if (!keyId) throw new HttpError(400, 'missing_issuer_key', 'select a registered issuer key');
      const key = (await d.svc.listIssuerKeys(account.org_id)).find((k) => k.id === keyId);
      if (!key) throw new HttpError(404, 'issuer_key_not_found', 'the selected key is not active in your organisation; refresh the key list');
      const issuer = (statement as Record<string, unknown>)['issuer'] as Record<string, unknown> | undefined;
      if (!issuer || issuer['public_key'] !== key.public_key || issuer['algorithm'] !== key.algorithm) {
        throw new HttpError(400, 'issuer_key_mismatch', 'the statement must be signed with the private key matching the selected registered public key');
      }
      const att = await d.svc.issueSigned(account.org_id, statement as never);
      return new HttpResult(201, { ...att, quota: await quota(account.org_id) });
    },

    /** `GET /v1/console/issuer-keys` — public material only, always. */
    listIssuerKeys: async (ctx) => ({ data: await d.svc.listIssuerKeys((await requireAccount(ctx)).org_id) }),

    /**
     * `POST /v1/console/issuer-keys`
     *
     * Registering is what turns "some key signed this" into "our key signed
     * this". The public half is all that is ever sent — there is no field
     * here for a private key, and one sent in its place is recognised and
     * refused rather than stored.
     */
    registerIssuerKey: async (ctx) => {
      const account = await requireAccount(ctx);
      const body = await ctx.body() as Record<string, unknown>;
      const raw = str(body, 'public_key');
      const publicKey = typeof raw === 'string' ? raw.trim() : '';
      if (!publicKey) {
        throw new HttpError(400, 'missing_public_key', 'provide "public_key" (SPKI, base64)');
      }
      const algorithm = str(body, 'algorithm') === 'RS256' ? 'RS256' : 'ES256';
      /*
       * Checked before anything is written, and at least as strictly as the
       * keyed route. An ES256 key is one product activation can copy onto an
       * institution, so it must be P-256, the only curve institution keys are
       * verified on; an RS256 key only ever verifies signed anchors and is
       * held to being a decodable SPKI, as before. A private key is refused
       * by name under either algorithm, and never quoted back.
       */
      const problem = algorithm === 'ES256' ? es256PublicKeyProblem(publicKey) : publicKeyProblem(publicKey);
      if (problem) throw new HttpError(400, problem.code, `public_key is ${problem.message}. Nothing was stored.`);
      const r = await d.svc.registerIssuerKey(account.org_id, publicKey, cleanLabel(str(body, 'label')), algorithm);
      return new HttpResult(r.already ? 200 : 201, r);
    },

    /** `POST /v1/console/issuer-keys/:id/revoke` */
    revokeIssuerKey: async (ctx) => {
      const account = await requireAccount(ctx);
      if (!(await d.svc.revokeIssuerKey(account.org_id, ctx.params['id'] ?? ''))) {
        throw new HttpError(404, 'not_found', 'no active issuer key with that id');
      }
      return { ok: true };
    },

    /** `GET /v1/console/attestations/:id/bundle` */
    bundle: async (ctx) => {
      const account = await requireAccount(ctx);
      const id = ctx.params['id']!;
      const bundle = await d.svc.exportBundle(account.org_id, id);
      return new HttpResult(200, bundle, {
        'content-disposition': `attachment; filename="proof-${id}.json"`,
      });
    },

    /**
     * `POST /v1/console/keys/rotate`
     *
     * Mints the new key before revoking the old one, and returns both states,
     * so a caller who loses the response has not been locked out — the old key
     * is already gone either way, which is the point of a rotation, but the
     * ordering means a crash mid-way leaves two working keys rather than none.
     */
    /**
     * `GET /v1/console/keys`
     *
     * Every active key, newest first. The secret is not here and cannot be —
     * only its hash was ever stored — so what a key is identified by in this
     * list is its prefix and whatever label its owner gave it.
     */
    listKeys: async (ctx) => {
      const account = await requireAccount(ctx);
      return {
        data: await d.db.prepare(
          `SELECT id, prefix, label, created_at FROM api_keys
            WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
        ).all(account.org_id),
        max_active: MAX_ACTIVE_KEYS,
      };
    },

    /**
     * `POST /v1/console/keys`
     *
     * Mints an additional key rather than replacing one. Rotation without
     * downtime needs two keys live at once — issue the new one, move the
     * callers over, then revoke the old — and a console that only ever
     * rotated in place forced every integration to break at the moment of
     * the swap.
     */
    createKey: async (ctx) => {
      const account = await requireAccount(ctx);
      const active = (await d.db.prepare(
        'SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL',
      ).get(account.org_id)) as { n: number };
      if (Number(active.n) >= MAX_ACTIVE_KEYS) {
        throw new HttpError(409, 'too_many_keys',
          `this org already has ${MAX_ACTIVE_KEYS} active keys; revoke one before issuing another`);
      }
      const body = await ctx.body();
      const km = mintKey(d.cfg.env);
      const id = randomUUID();
      await d.db.prepare(
        `INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, account.org_id, km.hash, km.prefix, cleanLabel(str(body, 'label')), nowIso());
      return new HttpResult(201, {
        id, prefix: km.prefix, api_key_secret: km.secret,
        note: 'Store this key now — only its hash is kept, so it cannot be shown again.',
      });
    },

    /** `POST /v1/console/keys/:id/label` — rename, so a key says what it is for. */
    renameKey: async (ctx) => {
      const account = await requireAccount(ctx);
      const body = await ctx.body();
      const changed = await d.db.prepare(
        'UPDATE api_keys SET label = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
      ).run(cleanLabel(str(body, 'label')), ctx.params['id'] ?? '', account.org_id);
      if (!changed.changes) throw new HttpError(404, 'not_found', 'no active key with that id');
      return { ok: true };
    },

    /**
     * `POST /v1/console/keys/:id/revoke`
     *
     * Takes effect immediately — `auth.ts` looks keys up with
     * `revoked_at IS NULL`, so the next request with it fails. Revoking the
     * last one is allowed: locking someone out of their own account's keys to
     * protect them from themselves would be the console making a decision
     * that is theirs.
     */
    revokeKey: async (ctx) => {
      const account = await requireAccount(ctx);
      const changed = await d.db.prepare(
        'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
      ).run(nowIso(), ctx.params['id'] ?? '', account.org_id);
      if (!changed.changes) throw new HttpError(404, 'not_found', 'no active key with that id');
      const left = (await d.db.prepare(
        'SELECT COUNT(*) AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL',
      ).get(account.org_id)) as { n: number };
      return { ok: true, active_remaining: Number(left.n) };
    },

    rotateKey: async (ctx) => {
      const account = await requireAccount(ctx);
      const previous = await activeKey(account.org_id);
      const km = mintKey(d.cfg.env);
      await d.db.prepare(
        `INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), account.org_id, km.hash, km.prefix, 'rotated', nowIso());
      if (previous) {
        await d.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(nowIso(), previous.id);
      }
      return new HttpResult(201, {
        api_key_secret: km.secret,
        revoked: previous ? { id: previous.id, at: nowIso() } : null,
        note: 'Store this key now — it is not recoverable. The previous key stopped working immediately.',
      });
    },

    /**
     * `GET /v1/console/dashboard` — the landing screen's one call.
     *
     * Everything a subscriber checks in the morning, aggregated server-side:
     * what needs a human (RFI answers, L1 holds, exceptions, exhausted
     * webhooks, unconfirmed anchors) — as counts and as the items themselves,
     * since an operator acts on an ID — then per-product operational numbers.
     * Products the org has no rows for simply come back as zeros; the page
     * decides which cards to draw from the subscription list it already has.
     */
    dashboard: async (ctx) => {
      const account = await requireAccount(ctx);
      const org = account.org_id;
      const num = async (sql: string, ...args: unknown[]): Promise<number> =>
        Number((((await d.db.prepare(sql).get(...(args as never[]))) as { n: number } | undefined)?.n) ?? 0);
      const today = nowIso().slice(0, 10);
      const since = monthStart();

      // ── needs a human ──────────────────────────────────────────────────
      const [rfiWaiting, l1Held, exceptions, webhookExhausted, unconfirmedAnchors] = await Promise.all([
        num(`SELECT COUNT(*) AS n FROM remit_payments p
              WHERE p.org_id = ? AND p.state = 'TRAVEL_RULE_PENDING'
                AND EXISTS (SELECT 1 FROM remit_events e WHERE e.payment_id = p.id AND e.type = 'TRAVEL_RULE_RFI')
                AND NOT EXISTS (SELECT 1 FROM remit_events e2 WHERE e2.payment_id = p.id AND e2.type = 'TRAVEL_RULE_RECEIVED')`, org),
        num(`SELECT COUNT(*) AS n FROM remit_payments
              WHERE org_id = ? AND state = 'PAYOUT_IN_PROGRESS' AND evidence_level = 'L1'`, org),
        num(`SELECT COUNT(*) AS n FROM remit_payments WHERE org_id = ? AND state = 'EXCEPTION'`, org),
        // Payments, not deliveries: one payment leaves a row per event it emitted.
        num(`SELECT COUNT(DISTINCT payment_id) AS n FROM remit_webhook_deliveries WHERE org_id = ? AND status = 'exhausted'`, org),
        num(`SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND status != 'confirmed'`, org),
      ]);

      // ── attest: customer anchoring only (product = 'attest') ───────────
      const funnelRows = (await d.db.prepare(
        `SELECT status, COUNT(*) AS n FROM attestations
          WHERE org_id = ? AND product = 'attest' GROUP BY status`,
      ).all(org)) as unknown as { status: string; n: number }[];
      const funnel: Record<string, number> = { accepted: 0, batched: 0, submitted: 0, confirmed: 0 };
      for (const r of funnelRows) funnel[r.status] = Number(r.n);
      const attestTotal = Object.values(funnel).reduce((a, b) => a + b, 0);
      const [signedCount, registeredCount] = await Promise.all([
        num(`SELECT COUNT(*) AS n FROM attestations
              WHERE org_id = ? AND product = 'attest' AND statement IS NOT NULL`, org),
        num(`SELECT COUNT(*) AS n FROM attestations
              WHERE org_id = ? AND product = 'attest' AND issuer_trust = 'registered'`, org),
      ]);
      // Confirmation latency, batched records: created → the batch anchor's
      // confirmed_at. Computed here rather than in SQL because the two
      // engines spell date arithmetic differently and 100 rows is nothing.
      // This product's records only, like every other figure in its row: a
      // bank's newest hundred confirmed records are nearly all settlement
      // evidence, and their latency is not document anchoring's.
      const confirmPairs = (await d.db.prepare(
        `SELECT a.created_at AS c, x.confirmed_at AS f
           FROM attestations a JOIN anchor_txs x ON x.batch_id = a.batch_id
          WHERE a.org_id = ? AND a.product = 'attest' AND a.status = 'confirmed' AND x.confirmed_at IS NOT NULL
          ORDER BY a.created_at DESC LIMIT 100`,
      ).all(org)) as unknown as { c: string; f: string }[];
      const avgSeconds = (pairs: { c: string; f: string }[]): number | null => {
        const ds = pairs
          .map((r) => (Date.parse(r.f) - Date.parse(r.c)) / 1000)
          .filter((v) => Number.isFinite(v) && v >= 0);
        return ds.length === 0 ? null : Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
      };
      // No "expiring soon" figure: an organisation's records do not expire —
      // only the anonymous free tier's do, and those belong to no tenant.
      const recentAttest = (await d.db.prepare(
        `SELECT id, leaf_bytes, kind, status, created_at FROM attestations
          WHERE org_id = ? AND product = 'attest' ORDER BY created_at DESC LIMIT 5`,
      ).all(org)) as unknown as Record<string, unknown>[];

      // ── remit ───────────────────────────────────────────────────────────
      const sumRow = async (where: string, ...args: unknown[]): Promise<{ count: number; trade_usd: number }> => {
        const r = (await d.db.prepare(
          `SELECT COUNT(*) AS n, SUM(CAST(trade_amount AS DECIMAL(18,2))) AS s
             FROM remit_payments WHERE org_id = ? AND ${where}`,
        ).get(org, ...(args as never[]))) as unknown as { n: number; s: number | string | null };
        return { count: Number(r.n), trade_usd: Number(r.s ?? 0) };
      };
      const [remitToday, remitMonth] = await Promise.all([
        sumRow('substr(created_at, 1, 10) = ?', today),
        sumRow('created_at >= ?', since),
      ]);
      const stateRows = (await d.db.prepare(
        `SELECT state, COUNT(*) AS n FROM remit_payments WHERE org_id = ? GROUP BY state`,
      ).all(org)) as unknown as { state: string; n: number }[];
      const states: Record<string, number> = {};
      for (const r of stateRows) states[r.state] = Number(r.n);
      const bucket = (keys: string[]): number => keys.reduce((a, k) => a + (states[k] ?? 0), 0);
      const buckets = {
        in_flight: bucket(['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING',
          'PAYOUT_PRE_APPROVED', 'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS']),
        completed: bucket(['BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED']),
        returned_cancelled: bucket(['RETURNED', 'CANCELLED']),
        exceptions: bucket(['EXCEPTION']),
      };
      const manifestRow = (await d.db.prepare(
        'SELECT verdict FROM remit_manifests WHERE org_id = ? AND date = ?',
      ).get(org, today)) as unknown as { verdict: string } | undefined;
      // The most recent manifest, whatever its date: a discrepancy found
      // yesterday is still the thing to act on this morning, and keying the
      // queue to the UTC calendar day hid exactly that.
      const latestManifest = (await d.db.prepare(
        'SELECT date, verdict FROM remit_manifests WHERE org_id = ? ORDER BY date DESC LIMIT 1',
      ).get(org)) as unknown as { date: string; verdict: string } | undefined;
      const webhookRows = (await d.db.prepare(
        `SELECT status, COUNT(*) AS n FROM remit_webhook_deliveries WHERE org_id = ? GROUP BY status`,
      ).all(org)) as unknown as { status: string; n: number }[];
      const webhooks: Record<string, number> = { pending: 0, delivered: 0, exhausted: 0 };
      for (const r of webhookRows) webhooks[r.status] = Number(r.n);
      const creditPairs = (await d.db.prepare(
        `SELECT p.created_at AS c, e.created_at AS f
           FROM remit_payments p JOIN remit_events e
             ON e.payment_id = p.id AND e.type = 'SETTLEMENT_RECONCILED'
          WHERE p.org_id = ? ORDER BY p.created_at DESC LIMIT 100`,
      ).all(org)) as unknown as { c: string; f: string }[];
      const monthTerminalBad = await num(
        `SELECT COUNT(*) AS n FROM remit_payments
          WHERE org_id = ? AND created_at >= ? AND state IN ('RETURNED', 'CANCELLED', 'EXCEPTION')`,
        org, since);
      const recentRemit = (await d.db.prepare(
        `SELECT id, state, trade_amount, trade_currency, evidence_level, created_at
           FROM remit_payments WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`,
      ).all(org)) as unknown as Record<string, unknown>[];

      // ── por ─────────────────────────────────────────────────────────────
      // Nothing here selects on status: a snapshot anchored without a spot
      // check (ACCEPTED) is as published as one that passed it (VERIFIED), so
      // either can be the latest, with its anchor and its coverage. Each row
      // carries the path it took and the page words it.
      const snaps = (await d.db.prepare(
        `SELECT id, status, asof, root, leaf_count, totals, reserves, attestation_id, created_at
           FROM por_snapshots WHERE org_id = ? ORDER BY created_at DESC LIMIT 10`,
      ).all(org)) as unknown as {
        id: string; status: string; asof: string; root: string; leaf_count: number;
        totals: string; reserves: string | null; attestation_id: string | null; created_at: string;
      }[];
      const coverageOf = (reserves: string | null): { asset: string; coverage: string | null }[] => {
        if (!reserves) return [];
        try {
          const r = JSON.parse(reserves) as { solvency?: { asset: string; coverage: string | null }[] };
          return (r.solvency ?? []).map((l2) => ({ asset: l2.asset, coverage: l2.coverage }));
        } catch { return []; }
      };
      const latestSnap = snaps[0] ?? null;
      let latestAnchor: string | null = null;
      if (latestSnap?.attestation_id) {
        latestAnchor = ((await d.db.prepare('SELECT status FROM attestations WHERE id = ?')
          .get(latestSnap.attestation_id)) as unknown as { status: string } | undefined)?.status ?? null;
      }

      // ── needs a human: the items behind the counts ─────────────────────
      // Five per kind; the counts above say when there are more, and the
      // screen links to the full list for those. Exceptions carry the error
      // that stopped them, exhausted deliveries the last error seen.
      const ATTN_CAP = 5;
      const oneLine = (v: unknown): string | null => {
        if (typeof v !== 'string' || v.trim() === '') return null;
        const line = v.replace(/\s+/g, ' ').trim();
        return line.length > 120 ? `${line.slice(0, 119)}…` : line;
      };
      const exceptionReason = (payload: string | null): string | null => {
        if (!payload) return null;
        try { return oneLine((JSON.parse(payload) as { error?: unknown }).error); } catch { return null; }
      };
      const [exceptionRows, rfiRows, heldRows, exhaustedRows] = (await Promise.all([
        d.db.prepare(
          `SELECT p.id, p.state, p.created_at,
                  (SELECT e.payload FROM remit_events e
                    WHERE e.payment_id = p.id AND e.type = 'EXCEPTION'
                    ORDER BY e.seq DESC LIMIT 1) AS payload
             FROM remit_payments p
            WHERE p.org_id = ? AND p.state = 'EXCEPTION'
            ORDER BY p.created_at DESC, p.id DESC LIMIT ${ATTN_CAP}`).all(org),
        d.db.prepare(
          `SELECT p.id, p.state, p.created_at FROM remit_payments p
            WHERE p.org_id = ? AND p.state = 'TRAVEL_RULE_PENDING'
              AND EXISTS (SELECT 1 FROM remit_events e WHERE e.payment_id = p.id AND e.type = 'TRAVEL_RULE_RFI')
              AND NOT EXISTS (SELECT 1 FROM remit_events e2 WHERE e2.payment_id = p.id AND e2.type = 'TRAVEL_RULE_RECEIVED')
            ORDER BY p.created_at DESC, p.id DESC LIMIT ${ATTN_CAP}`).all(org),
        d.db.prepare(
          `SELECT id, state, created_at FROM remit_payments
            WHERE org_id = ? AND state = 'PAYOUT_IN_PROGRESS' AND evidence_level = 'L1'
            ORDER BY created_at DESC, id DESC LIMIT ${ATTN_CAP}`).all(org),
        // One row per payment — its latest exhausted delivery — since every
        // event a payment emitted is its own delivery row.
        d.db.prepare(
          `SELECT d.payment_id, d.last_error, d.created_at FROM remit_webhook_deliveries d
            WHERE d.org_id = ? AND d.status = 'exhausted'
              AND d.id = (SELECT d2.id FROM remit_webhook_deliveries d2
                           WHERE d2.org_id = d.org_id AND d2.payment_id = d.payment_id AND d2.status = 'exhausted'
                           ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1)
            ORDER BY d.created_at DESC, d.id DESC LIMIT ${ATTN_CAP}`).all(org),
      ])) as unknown as [
        { id: string; state: string; created_at: string; payload: string | null }[],
        { id: string; state: string; created_at: string }[],
        { id: string; state: string; created_at: string }[],
        { payment_id: string; last_error: string | null; created_at: string }[],
      ];
      const attentionItems = [
        ...exceptionRows.map((r) => ({ kind: 'exception', id: r.id, state: r.state, reason: exceptionReason(r.payload), at: r.created_at })),
        ...rfiRows.map((r) => ({ kind: 'rfi', id: r.id, state: r.state, reason: null, at: r.created_at })),
        ...heldRows.map((r) => ({ kind: 'held', id: r.id, state: r.state, reason: null, at: r.created_at })),
        ...exhaustedRows.map((r) => ({ kind: 'webhook', id: r.payment_id, state: 'exhausted', reason: oneLine(r.last_error), at: r.created_at })),
      ];

      return {
        generated_at: nowIso(),
        attention: {
          rfi_waiting: rfiWaiting,
          l1_held: l1Held,
          exceptions,
          webhook_exhausted: webhookExhausted,
          unconfirmed_anchors: unconfirmedAnchors,
          items: attentionItems,
        },
        attest: {
          total: attestTotal,
          funnel,
          signed: { signed: signedCount, registered: registeredCount },
          avg_confirm_seconds: avgSeconds(confirmPairs),
          recent: recentAttest,
        },
        remit: {
          today: remitToday,
          month: { ...remitMonth, terminal_bad: monthTerminalBad },
          buckets,
          manifest_today: manifestRow
            ? (JSON.parse(manifestRow.verdict) as { status: string }).status
            : null,
          manifest_latest: latestManifest
            ? { date: latestManifest.date, status: (JSON.parse(latestManifest.verdict) as { status: string }).status }
            : null,
          webhooks,
          avg_credit_seconds: avgSeconds(creditPairs),
          recent: recentRemit,
        },
        por: {
          latest: latestSnap ? {
            id: latestSnap.id,
            status: latestSnap.status,
            spot_check: spotChecked(latestSnap.status),
            asof: latestSnap.asof,
            root: latestSnap.root,
            leaf_count: Number(latestSnap.leaf_count),
            totals: JSON.parse(latestSnap.totals) as Record<string, string>,
            coverage: coverageOf(latestSnap.reserves),
            anchor_status: latestAnchor,
            created_at: latestSnap.created_at,
          } : null,
          trend: snaps.map((x) => ({
            id: x.id, asof: x.asof, status: x.status, spot_check: spotChecked(x.status),
            coverage: coverageOf(x.reserves),
          })),
        },
      };
    },

    /**
     * `GET /v1/console/audit` — who called what, when, with what result.
     *
     * Per organisation, newest first, filtered in SQL and keyset-paged like
     * the settlement ledger, because an audit screen is opened to find one
     * call among months of them. Entries name the credential that acted —
     * a key by its label, a session by its email — which is the question an
     * auditor actually asks: not "was the API called" but "by which of our
     * integrations". The screen loads that would drown that answer are not
     * recorded; see audit.ts.
     */
    audit: async (ctx) => {
      const account = await requireAccount(ctx);
      // An empty parameter is no filter, as the settlement search reads it.
      const param = (k: string): string | undefined => ctx.query.get(k) || undefined;
      const limitRaw = Number(ctx.query.get('limit') ?? '50');
      const page = await searchAudit(d.db, account.org_id, {
        service: param('service'),
        actor_type: param('actor_type'),
        from: param('from'),
        to: param('to'),
        q: param('q'),
        cursor: param('cursor'),
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      });
      return { data: page.items, page: { returned: page.items.length, next_cursor: page.nextCursor } };
    },

    /** `POST /v1/console/sessions/revoke-others` */
    revokeOtherSessions: async (ctx) => {
      const account = await requireAccount(ctx);
      const token = cookieToken(ctx.req.headers['cookie'])!;
      await destroyOtherSessions(d.db, account.id, token);
      return { revoked: true };
    },
  };
}
