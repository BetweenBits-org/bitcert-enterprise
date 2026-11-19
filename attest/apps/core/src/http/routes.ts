/**
 * The public API surface. Nine routes, and the shapes are the contract the
 * Developer Hub documents.
 *
 * Sandbox and production run **this same file**. Nothing branches on the
 * environment: `test` and `live` differ only in which database file is opened,
 * which anchor backend is constructed, and which key prefix authenticates. A
 * sandbox that ran different code would not be a sandbox, it would be a
 * simulator — and passing against a simulator tells a customer nothing about
 * production.
 */
import { HttpError, HttpResult, Router, pageLimit } from './server.ts';
import type { Ctx } from './server.ts';
import { redirectRoot, serveStatic } from './static.ts';
import { HARD_CEILING_BYTES, STANDARD_RELAY_MAX_BODY_BYTES } from '../btc/inscription.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';
import { bundle as settlementBundle, reconcile as settlementReconcile } from './evidence.ts';
import { publicRoutes } from './public.ts';
import { consoleRoutes } from './console.ts';
import { sandboxRoutes } from './sandbox.ts';
import { authenticate, mintKey, keyPrefix } from '../auth.ts';
import { accountForSession, cookieToken } from '../account.ts';
import { isAudited, keyActor, recordAudit, sessionActor } from '../audit.ts';
import { registerRemitRoutes } from '../remit/routes.ts';
import { es256PublicKeyProblem, publicKeyProblem } from '../remit/sign.ts';
import type { RemitServices } from '../remit/routes.ts';
import { registerPorRoutes } from '../por/routes.ts';
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import type { AnchorBackend } from '../anchor/backend.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { createPublicKey, randomUUID } from 'node:crypto';

export interface Deps {
  cfg: Config;
  db: Db;
  svc: AttestService;
  backend: AnchorBackend;
  /** Set once at boot so `/healthz` can report it without another call. */
  version: string;
  /** Org that owns every free-tier record. Created once at boot. */
  publicOrgId: string;
  /** The remit rail's services, present only when the rail is enabled. */
  remit?: RemitServices;
}

/**
 * An API key, or — in the sandbox — the console session.
 *
 * The console has to reach the real reconciliation endpoint, because a sandbox
 * whose verdicts came from a sandbox-only evaluator would prove nothing about
 * the one a customer integrates against. The alternative was handing the raw
 * API key to the page, and the console deliberately keeps no credential in the
 * browser.
 *
 * So the credential differs and nothing else does: same route, same body, same
 * code. The sandbox says as much on screen next to the cURL it shows, because
 * a reader who copies that command needs to know it carries a Bearer key where
 * their browser carried a cookie.
 */
async function requireAuth(d: Deps, ctx: Ctx): Promise<string> {
  const p = await authenticate(d.db, d.cfg.env, ctx.token);
  if (p) {
    ctx.audit = keyActor(p);
    return p.orgId;
  }

  if (d.cfg.env === 'test' && d.cfg.console.enabled) {
    const account = await accountForSession(d.db, cookieToken(ctx.req.headers['cookie']));
    if (account) {
      ctx.audit = sessionActor(account);
      return account.org_id;
    }
  }
  throw new HttpError(401, 'unauthorized',
    `supply a valid ${keyPrefix(d.cfg.env)}… key as "Authorization: Bearer <key>"`);
}

function str(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

export function buildRouter(d: Deps): Router {
  const r = new Router();

  // The Playground and the Developer Hub are static and client-only. Mounted
  // before the API routes are consulted but after they are matched, so a file
  // can never shadow an endpoint.
  //
  // Both are optional and independent: in production each gets its own
  // hostname and this process serves neither, which is why the directories are
  // configuration rather than constants. On a test box one port is one less
  // thing to run.
  const mounts: { root: string; mount: string }[] = [];
  if (d.cfg.playgroundDir) mounts.push({ root: d.cfg.playgroundDir, mount: '/playground' });
  if (d.cfg.docsDir) mounts.push({ root: d.cfg.docsDir, mount: '/docs' });
  if (d.cfg.consoleDir) mounts.push({ root: d.cfg.consoleDir, mount: '/console' });
  if (mounts.length > 0) {
    // The bare address is the console. The console asks for the session
    // before it draws anything, so one target covers both cases: signed in,
    // the visitor lands on the dashboard; without a session, on the sign-in
    // screen. Where no console is mounted the Developer Hub stands in, then
    // whichever screen there is. With nothing mounted — the production API
    // host — `/` stays the router's 404, rather than pointing at a screen
    // that is not there.
    const landing = `${(mounts.find((m) => m.mount === '/console')
      ?? mounts.find((m) => m.mount === '/docs') ?? mounts[0]!).mount}/`;
    // One fallback, consulted in order — `serveStatic` returns false when the
    // path is outside its mount, so the next one gets a look.
    r.fallback((req, res) => redirectRoot(landing, req, res) || mounts.some((m) => serveStatic(m, req, res)));
  }

  const signupLimiter = new RateLimiter(d.cfg.signupRateLimit);

  r.errorMapper((e) => {
    if (e instanceof ServiceError) return new HttpResult(e.status, { ...(e.detail ?? {}), error: e.code, message: e.message });
    if (e instanceof HttpError) return new HttpResult(e.status, { error: e.code, message: e.message });
    return new HttpResult(500, { error: 'internal', message: e instanceof Error ? e.message : String(e) });
  });

  /*
   * The audit trail: one row per request that acted as someone. The auth
   * helpers — `requireAuth` above, `requireSession` below, `requireAccount`
   * in console.ts — mark the context; this writes the row once the status is
   * known, before the response goes out. Screen loads are skipped (see
   * `isAudited`), and anonymous requests never get here at all.
   */
  r.onDone(async (ctx, status, durationMs) => {
    const method = ctx.req.method ?? 'GET';
    if (!ctx.audit || !isAudited(method, ctx.path)) return;
    await recordAudit(d.db, ctx.audit, { method, path: ctx.path, status, durationMs });
  });

  // ── Operations ───────────────────────────────────────────────────────────
  r.get('/healthz', () => ({ status: 'ok' }));

  // ── Remit rail (optional) ────────────────────────────────────────────────
  if (d.remit) {
    registerRemitRoutes(r, {
      cfg: d.cfg,
      db: d.db,
      svc: d.svc,
      remit: d.remit,
      requireAuth: (ctx) => requireAuth(d, ctx),
      requireSession: async (ctx) => {
        if (!(d.cfg.env === 'test' && d.cfg.console.enabled)) {
          throw new HttpError(403, 'console_disabled', 'the console is not enabled on this deployment');
        }
        const account = await accountForSession(d.db, cookieToken(ctx.req.headers['cookie']));
        if (!account) throw new HttpError(401, 'unauthorized', 'a console session is required');
        ctx.audit = sessionActor(account);
        return account;
      },
    });
    registerPorRoutes(r, {
      db: d.db,
      svc: d.svc,
      registry: d.remit.registry,
      requireAuth: (ctx) => requireAuth(d, ctx),
      chain: { label: d.cfg.remit.chainLabel, rpc: d.cfg.remit.porChainRpc },
    });
  }

  r.get('/readyz', async () => {
    const chain = await d.backend.health();
    // Not ready is a 503, not a 200 with a sad field: an orchestrator reads the
    // status code, and a "ready" response that admits it is not ready is worse
    // than useless.
    const body = {
      status: chain.ok ? 'ready' : 'degraded',
      env: d.cfg.env,
      network: d.backend.network,
      anchorBackend: d.backend.name,
      chain,
    };
    return new HttpResult(chain.ok ? 200 : 503, body);
  });

  r.get('/v1/meta', () => ({
    inscription: {
      enabled: d.svc.canInscribe,
      max_bytes: d.cfg.inscriptionMaxBytes,
      standard_relay_max_bytes: STANDARD_RELAY_MAX_BODY_BYTES,
      hard_ceiling_bytes: HARD_CEILING_BYTES,
      note: 'max_bytes is this deployment\'s policy. standard_relay_max_bytes is what an '
        + 'ordinary Bitcoin node will relay; above it a reveal needs a node run with '
        + '-acceptnonstdtxn. hard_ceiling_bytes is the last-line guard.',
    },
    service: 'stonehash-attest-core',
    version: d.version,
    env: d.cfg.env,
    /** Reproduced verbatim into every bundle; a client should surface it. */
    bitcoin_network: d.backend.network,
    anchor_backend: d.backend.name,
    bundle_schema: 'bitcert-proof-bundle/v1',
    playground: d.cfg.playgroundDir ? '/playground/' : null,
    docs: d.cfg.docsDir ? '/docs/' : null,
    console: d.cfg.consoleDir && d.cfg.console.enabled && d.cfg.env === 'test'
      ? { path: '/console/', signup_required: true, self_serve: true,
          monthly_quota: d.cfg.console.monthlyQuota }
      : null,
    free_tier: d.cfg.publicAnchor.enabled
      ? {
          endpoint: '/v1/public/anchors',
          signup_required: false,
          per_address_per_hour: d.cfg.publicAnchor.rateLimit.max,
          retention_days: d.cfg.publicAnchor.retentionDays,
        }
      : null,
    key_prefix: keyPrefix(d.cfg.env),
    /** Honest statement of what this network can and cannot support. */
    public_verifiability: d.backend.network === 'mainnet'
      ? 'anchors are on public Bitcoin and can be confirmed by any third party'
      : 'anchors are on a private regtest chain: links A, B and C1 verify offline, '
        + 'but public-chain inclusion (C2) cannot be confirmed by a third party',
  }));

  // Read a little past the configured limit so an oversized document is
  // refused by the inscription check — which can say what the limit is and
  // why — rather than by a bare 413 that tells the sender nothing. Past this
  // margin the connection is cut, because at that point the sender is not
  // going to get an answer worth the bandwidth either way.
  const MAX_INSCRIPTION_UPLOAD = d.cfg.inscriptionMaxBytes + 64 * 1024;

  // ── Attestations ─────────────────────────────────────────────────────────
  r.post('/v1/attestations', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const body = await ctx.body();
    const leaf = str(body, 'leaf_bytes') ?? str(body, 'sha256');
    if (!leaf) {
      throw new HttpError(400, 'missing_digest',
        'provide "leaf_bytes": the SHA-256 of your document as 64 hex characters. Hash locally; do not upload the file.');
    }
    const att = await d.svc.issue(orgId, leaf, str(body, 'content_type'),
      (body as Record<string, unknown>)['descriptor']);
    return new HttpResult(201, publicAttestation(att));
  });

  /**
   * The same anchor, with the issuer's signature over it.
   *
   * Optional throughout: `POST /v1/attestations` above is unchanged and
   * remains the cheap default. What this adds is authorship — the leaf
   * becomes the hash of a statement carrying both the document digest and
   * the signature, so one block height timestamps who published it as well
   * as when.
   *
   * It costs nothing extra on the chain. The leaf joins the same Merkle tree
   * as every other record; no witness, no separate transaction.
   */
  r.post('/v1/attestations/signed', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const body = await ctx.body() as Record<string, unknown>;
    const statement = body['statement'];
    if (!statement || typeof statement !== 'object') {
      throw new HttpError(400, 'missing_statement',
        'provide "statement": a signed attestation statement from the attest-sign SDK. '
        + 'Sign locally — the private key must never reach this service.');
    }
    const att = await d.svc.issueSigned(orgId, statement as never,
      { descriptor: body['descriptor'] });
    return new HttpResult(201, publicAttestation(att));
  });

  /**
   * The other path: send the document, not its digest.
   *
   * This is the one route in the service that receives a file, and it exists
   * because the customer asked for the original itself to go on the chain —
   * which it cannot do without passing through here. The bytes are hashed,
   * inscribed into a reveal transaction's witness and dropped. Nothing is
   * written to disk and no row holds the document; what the record keeps is
   * the transaction, which is public the moment it is broadcast.
   *
   * The body is the raw file. No multipart, because a form encoding would
   * mean parsing a document we have no reason to interpret — the content type
   * comes from a header and the filename is not ours to know.
   */
  r.post('/v1/attestations/inscribe', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const contentType = typeof ctx.req.headers['content-type'] === 'string'
      ? ctx.req.headers['content-type'] : 'application/octet-stream';
    const body = await ctx.raw(MAX_INSCRIPTION_UPLOAD);
    if (body.length === 0) {
      throw new HttpError(400, 'empty_body',
        'send the document as the raw request body; this endpoint inscribes the bytes themselves');
    }
    const att = await d.svc.inscribe(orgId, new Uint8Array(body), contentType);
    return new HttpResult(201, publicAttestation(att));
  });

  r.get('/v1/attestations', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    return { data: (await d.svc.list(orgId, pageLimit(ctx.query.get('limit'), 50, 500))).map(publicAttestation) };
  });

  r.get('/v1/attestations/:id', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const att = await d.svc.get(orgId, ctx.params['id']!);
    if (!att) throw new HttpError(404, 'not_found', `no attestation ${ctx.params['id']}`);
    return publicAttestation(att);
  });

  /**
   * The bundle — the only endpoint that matters to a customer long term, because
   * after this call they never need us again.
   */
  r.get('/v1/attestations/:id/bundle', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const bundle = await d.svc.exportBundle(orgId, ctx.params['id']!);
    return new HttpResult(200, bundle, {
      'content-disposition': `attachment; filename="proof-${ctx.params['id']}.json"`,
    });
  });

  // ── Issuer keys, over the keyed API ──────────────────────────────────────
  /*
   * The console can mint a key in a browser; a bank does not run its signing
   * key through a browser. These two routes are the server-to-server half:
   * generate the pair wherever the private key will live (HSM, KMS, a
   * locked-down host — the SDK's generateSigningKey is the reference), then
   * register only the public half here. Activation in the console lists
   * whatever is registered, so the key set up by an engineer over this API
   * is the one the operator picks when switching the product on.
   */
  r.get('/v1/issuer-keys', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    return { data: await d.svc.listIssuerKeys(orgId) };
  });

  r.post('/v1/issuer-keys', async (ctx) => {
    const orgId = await requireAuth(d, ctx);
    const body = await ctx.body() as Record<string, unknown>;
    const publicKey = typeof body['public_key'] === 'string' ? body['public_key'].trim() : '';
    if (!publicKey) {
      throw new HttpError(400, 'missing_public_key',
        'provide "public_key": the SPKI public key, base64. The private key stays with you — there is no field for it.');
    }
    const label = typeof body['label'] === 'string' && body['label'].trim()
      ? body['label'].trim().slice(0, 60) : 'sdk';
    const algorithm = body['algorithm'] === 'RS256' ? 'RS256' : 'ES256';
    // The same check as the console's door, before anything is stored: a
    // private key is refused by name, and an ES256 key must be P-256 — a key
    // that does not decode, or decodes as another curve, would sit in the
    // registry and fail every signature with no hint why.
    const problem = algorithm === 'ES256' ? es256PublicKeyProblem(publicKey) : publicKeyProblem(publicKey);
    if (problem) throw new HttpError(400, problem.code, problem.message);
    const reg = await d.svc.registerIssuerKey(orgId, publicKey, label, algorithm);
    return new HttpResult(reg.already ? 200 : 201, {
      ...reg,
      next: 'activate the product in the console (구독) and pick this key, or reference it as issuer_key_id',
    });
  });

  // ── Free tier: no account, no key ────────────────────────────────────────
  // Deliberately unauthenticated. See `public.ts` for what keeps that from
  // being an open write endpoint: digest-only input, two rate limits, the
  // shared batch, and a retention window.
  const pub = publicRoutes({ cfg: d.cfg, svc: d.svc, backend: d.backend, publicOrgId: d.publicOrgId });
  const withCors = <T>(fn: (ctx: Ctx) => T) => (ctx: Ctx): T => {
    pub.cors(ctx.req, ctx.res);
    return fn(ctx);
  };
  r.add('OPTIONS', '/v1/public/anchors', withCors(pub.preflight));
  r.add('OPTIONS', '/v1/public/anchors/:id', withCors(pub.preflight));
  r.add('OPTIONS', '/v1/public/anchors/:id/bundle', withCors(pub.preflight));
  r.post('/v1/public/anchors', withCors(pub.anchor));
  r.get('/v1/public/anchors/:id', withCors(pub.status));
  r.get('/v1/public/anchors/:id/bundle', withCors(pub.bundle));

  // ── Settlement evidence ──────────────────────────────────────────────────
  // Stateless: evidence and policy arrive in the request, the verdict and the
  // archive are computed and returned, nothing is stored. The reviewer's case
  // data never rests on our disk.
  r.post('/v1/settlements/reconcile', async (ctx) => {
    await requireAuth(d, ctx);
    return settlementReconcile(ctx);
  });

  r.post('/v1/settlements/bundle', async (ctx) => {
    await requireAuth(d, ctx);
    return settlementBundle(ctx);
  });

  // ── Sandbox console ──────────────────────────────────────────────────────
  // Session-authenticated and separate from the keyed API above. See
  // `console.ts` for why the two surfaces do not share an auth mechanism.
  const con = consoleRoutes({ cfg: d.cfg, db: d.db, svc: d.svc, backend: d.backend });
  r.post('/v1/console/signup', con.signup!);
  r.post('/v1/console/login', con.login!);
  r.post('/v1/console/logout', con.logout!);
  r.get('/v1/console/me', con.me!);
  r.get('/v1/console/dashboard', con.dashboard!);
  r.get('/v1/console/audit', con.audit!);
  r.get('/v1/console/attestations', con.list!);
  r.post('/v1/console/attestations', con.create!);
  r.post('/v1/console/attestations/inscribe', con.inscribe!);
  r.post('/v1/console/attestations/signed', con.createSigned!);
  r.get('/v1/console/issuer-keys', con.listIssuerKeys!);
  r.post('/v1/console/issuer-keys', con.registerIssuerKey!);
  r.post('/v1/console/issuer-keys/:id/revoke', con.revokeIssuerKey!);
  r.get('/v1/console/tx/:txid', con.tx!);
  r.get('/v1/console/attestations/:id/bundle', con.bundle!);
  r.get('/v1/console/keys', con.listKeys!);
  r.post('/v1/console/keys', con.createKey!);
  r.post('/v1/console/keys/:id/label', con.renameKey!);
  r.post('/v1/console/keys/:id/revoke', con.revokeKey!);
  r.post('/v1/console/keys/rotate', con.rotateKey!);
  r.post('/v1/console/sessions/revoke-others', con.revokeOtherSessions!);

  // Material for the evaluation sandbox. These produce documents and packages;
  // the verdict itself always comes from /v1/settlements/reconcile above.
  const sbx = sandboxRoutes(async (ctx) => { await requireAuth(d, ctx); });
  r.get('/v1/console/sandbox', sbx.catalogue);
  r.post('/v1/console/sandbox/evidence', sbx.evidence);
  r.post('/v1/console/sandbox/package', sbx.pack);
  r.post('/v1/console/sandbox/package/verify', sbx.verifyPackage);

  // ── Provisioning ─────────────────────────────────────────────────────────
  /**
   * Self-serve sandbox sign-up: one call, a key back immediately, no approval
   * queue. Disabled on `live`, where keys are issued against a contract.
   */
  r.post('/v1/sandbox/keys', async (ctx) => {
    if (d.cfg.env !== 'test') {
      throw new HttpError(403, 'not_available',
        'self-serve key minting is sandbox-only; production keys are issued per contract');
    }
    const wait = signupLimiter.check(
      clientKey(ctx.req.headers, ctx.req.socket.remoteAddress, d.cfg.trustProxy));
    if (wait !== null) {
      return new HttpResult(429, {
        error: 'rate_limited',
        message: `sandbox sign-up is capped per address; retry in ${wait}s`,
      }, { 'retry-after': String(wait) });
    }
    const body = await ctx.body();
    const slug = (str(body, 'slug') ?? `sandbox-${randomUUID().slice(0, 8)}`).toLowerCase();
    // A new org every time. Minting into an existing slug would hand anyone
    // who knew the name a key to that org's records — the isolation the
    // keyed API promises would then be one guessable word thick.
    if (await d.svc.orgBySlug(slug)) {
      throw new HttpError(409, 'slug_taken',
        'that slug already names a sandbox organisation; pick another, or omit it for a generated one');
    }
    const orgId = await d.svc.ensureOrg(slug, str(body, 'name') ?? slug);
    const km = mintKey(d.cfg.env);
    await d.db.prepare(
      `INSERT INTO api_keys (id, org_id, key_hash, prefix, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), orgId, km.hash, km.prefix, str(body, 'label') ?? 'sandbox', new Date().toISOString());
    return new HttpResult(201, {
      org: { id: orgId, slug },
      // Shown once. Only its hash is stored, so it cannot be recovered later.
      api_key: km.secret,
      note: 'Store this now — it is not recoverable. Sandbox anchors land on a private regtest chain.',
    });
  });

  return r;
}

/** Row → wire shape. Keeps column names out of the public contract. */
function publicAttestation(a: {
  id: string; leaf_bytes: string; content_type: string | null; status: string;
  batch_id: string | null; leaf_index: number | null; created_at: string;
  issuer_trust?: string | null;
}): Record<string, unknown> {
  return {
    id: a.id,
    leaf_bytes: a.leaf_bytes,
    content_type: a.content_type,
    // accepted → batched → submitted → confirmed, never collapsed into a boolean.
    status: a.status,
    batch_id: a.batch_id,
    leaf_index: a.leaf_index,
    created_at: a.created_at,
    bundle_available: a.batch_id !== null,
    /*
     * Absent for an unsigned anchor. `unregistered` is not a softer
     * `registered` — it means the signature is sound and establishes nothing
     * about whose key it is, which a caller deciding how much weight to give
     * the record needs to be told rather than left to infer.
     */
    ...(a.issuer_trust ? { issuer_trust: a.issuer_trust } : {}),
  };
}
