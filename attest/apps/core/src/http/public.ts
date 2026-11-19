/**
 * The free tier: anchor a digest with no account.
 *
 * ## Why it is unauthenticated
 *
 * The product claim is that anyone can get an independently verifiable proof
 * without trusting us. Putting the first step behind a signup form would make
 * that claim something a visitor has to take on faith. So this endpoint takes a
 * digest and nothing else — no account, no key, no email.
 *
 * ## What keeps that from being an open write endpoint
 *
 * - **Only a 32-byte digest is accepted.** There is no field a caller could use
 *   to store content, so there is nothing abusive to host and nothing to
 *   moderate. We cannot disclose a document we were never sent.
 * - **Two rate limits.** Per address, and service-wide, so a botnet cannot
 *   accomplish what a single caller cannot.
 * - **The shared batch.** A free anchor joins the ordinary batch rather than
 *   triggering its own transaction. One caller therefore cannot make us spend a
 *   transaction fee on demand — which is the economic design of batching, not a
 *   restriction bolted on for this tier.
 * - **A retention window.** Records expire here; the bundle the visitor
 *   downloads does not.
 *
 * ## Honesty about the chain
 *
 * Every response states the network and, when it is not mainnet, says plainly
 * that a third party cannot confirm public-chain inclusion. On regtest we mine
 * the blocks, so links A, B and C1 verify offline and C2 cannot be established
 * by anyone but us. The bundle's own `bitcoin_network` field says so too, to
 * every conforming verifier.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, HttpResult } from './server.ts';
import type { Ctx } from './server.ts';
import { RateLimiter, clientKey } from './ratelimit.ts';
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import type { AnchorBackend } from '../anchor/backend.ts';
import type { Config } from '../config.ts';

const HEX64 = /^[0-9a-f]{64}$/i;

export interface PublicDeps {
  cfg: Config;
  svc: AttestService;
  backend: AnchorBackend;
  /** Org every free-tier record belongs to. Created once at boot. */
  publicOrgId: string;
}

/** What this deployment can and cannot evidence, in words, on every response. */
function verifiability(backend: AnchorBackend): string {
  return backend.network === 'mainnet'
    ? 'Anchored to public Bitcoin. Confirm inclusion through any Bitcoin source you choose — '
      + 'your own node or a public explorer, never ours.'
    : `Anchored to ${backend.network}, a private test chain. The original-to-digest, `
      + 'Merkle-inclusion and transaction-binding steps verify completely offline, but '
      + 'public-chain inclusion cannot be confirmed by a third party here, because we mine the '
      + 'blocks. This is a faithful run of the whole pipeline, not a publicly verifiable proof.';
}

export function publicRoutes(d: PublicDeps): {
  anchor: (ctx: Ctx) => Promise<unknown>;
  status: (ctx: Ctx) => Promise<unknown>;
  bundle: (ctx: Ctx) => Promise<unknown>;
  cors: (req: IncomingMessage, res: ServerResponse) => void;
  preflight: (ctx: Ctx) => HttpResult;
} {
  const perAddress = new RateLimiter(d.cfg.publicAnchor.rateLimit);
  const global = new RateLimiter(d.cfg.publicAnchor.globalRateLimit);

  /**
   * CORS for this surface only.
   *
   * The Playground is served from a different host in production
   * (`playground.` against `api.`), so a browser needs permission. Scoped to
   * the free-tier paths: the keyed API is called from servers and has no reason
   * to be reachable from arbitrary pages.
   */
  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const allowed = d.cfg.publicAnchor.allowedOrigins;
    const origin = req.headers['origin'];
    if (allowed.includes('*')) res.setHeader('access-control-allow-origin', '*');
    else if (typeof origin === 'string' && allowed.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '600');
  };

  const requireEnabled = (): void => {
    if (!d.cfg.publicAnchor.enabled) {
      throw new HttpError(503, 'free_tier_disabled',
        'the no-signup anchoring tier is switched off in this deployment');
    }
  };

  return {
    cors,
    preflight: () => new HttpResult(204, null),

    /** `POST /v1/public/anchors` — body `{ "sha256": "<64 hex>" }`. */
    anchor: async (ctx) => {
      requireEnabled();
      const key = clientKey(ctx.req.headers, ctx.req.socket.remoteAddress, d.cfg.trustProxy);
      const wait = perAddress.check(key);
      if (wait !== null) {
        return new HttpResult(429, {
          error: 'rate_limited',
          message: `free anchoring is capped per address; retry in ${wait}s. `
            + 'A sandbox key raises the limit and is self-serve.',
        }, { 'retry-after': String(wait) });
      }
      // Service-wide cap, so many addresses cannot do what one cannot.
      const globalWait = global.check('all');
      if (globalWait !== null) {
        return new HttpResult(429, {
          error: 'capacity',
          message: `the free tier is at capacity for this window; retry in ${globalWait}s`,
        }, { 'retry-after': String(globalWait) });
      }

      const body = (await ctx.body()) as Record<string, unknown>;
      const raw = body['sha256'] ?? body['leaf_bytes'] ?? body['digest'];
      if (typeof raw !== 'string' || !HEX64.test(raw)) {
        throw new HttpError(400, 'invalid_digest',
          'provide "sha256": the SHA-256 of your file as 64 hex characters. Hash it locally — '
          + 'the file itself is never sent, so we cannot disclose what we never received.');
      }

      const expiresAt = new Date(Date.now() + d.cfg.publicAnchor.retentionDays * 86_400_000);
      let att;
      try {
        att = await d.svc.issue(d.publicOrgId, raw.toLowerCase(), undefined,
          { tier: 'free' }, { source: 'public', expiresAt: expiresAt.toISOString() });
      } catch (e) {
        // A digest already anchored is a useful answer, not a failure: the
        // caller gets the existing record rather than a duplicate.
        if (e instanceof ServiceError && e.code === 'duplicate_digest') {
          const existing = await d.svc.findPublicByDigest(raw.toLowerCase());
          if (existing) return new HttpResult(200, publicView(existing, d, 'already anchored'));
        }
        throw e;
      }

      return new HttpResult(202, publicView(att, d,
        'accepted; it joins the next shared batch rather than its own transaction'));
    },

    /** `GET /v1/public/anchors/:id` — the id is the capability. */
    status: async (ctx) => {
      requireEnabled();
      const att = await d.svc.getPublic(ctx.params['id']!);
      if (!att) {
        throw new HttpError(404, 'not_found',
          `no free anchor ${ctx.params['id']}. Free records are retrievable for `
          + `${d.cfg.publicAnchor.retentionDays} days; a downloaded bundle stays verifiable `
          + 'indefinitely without us.');
      }
      return publicView(att, d);
    },

    /** `GET /v1/public/anchors/:id/bundle` — the whole point of the tier. */
    bundle: async (ctx) => {
      requireEnabled();
      const id = ctx.params['id']!;
      const bundle = await d.svc.exportPublicBundle(id);
      return new HttpResult(200, bundle, {
        'content-disposition': `attachment; filename="proof-${id}.json"`,
      });
    },
  };
}

function publicView(
  att: { id: string; leaf_bytes: string; status: string; batch_id: string | null; created_at: string; expires_at: string | null },
  d: PublicDeps,
  note?: string,
): Record<string, unknown> {
  return {
    id: att.id,
    sha256: att.leaf_bytes,
    // accepted → batched → submitted → confirmed, never collapsed into a flag.
    status: att.status,
    bundle_available: att.batch_id !== null,
    bundle_url: att.batch_id !== null ? `/v1/public/anchors/${att.id}/bundle` : null,
    created_at: att.created_at,
    retrievable_until: att.expires_at,
    bitcoin_network: d.backend.network,
    public_verifiability: verifiability(d.backend),
    ...(note ? { note } : {}),
  };
}
