/**
 * Fixed-window rate limiter, in memory.
 *
 * Exists for one specific reason: sandbox key minting is unauthenticated by
 * design — self-serve sign-up with no approval queue is the point — and on a
 * publicly reachable test server that is an open write endpoint. A cap per
 * address keeps it usable for a visitor and uninteresting to a script.
 *
 * In-memory and per-process, which is exactly right for a single-process
 * service and would need replacing if that ever changed. Not a security
 * boundary; a cost control.
 */
export interface RateLimitOptions {
  /** Window length. */
  windowMs: number;
  /** Requests permitted per key per window. */
  max: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly opts: RateLimitOptions;

  constructor(opts: RateLimitOptions) {
    this.opts = opts;
  }

  /** `null` when allowed; seconds to wait when not. */
  check(key: string, now = Date.now()): number | null {
    const e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return null;
    }
    if (e.count >= this.opts.max) return Math.ceil((e.resetAt - now) / 1000);
    e.count += 1;
    return null;
  }

  /** Drop expired entries so a long uptime cannot grow the map without bound. */
  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}

/**
 * Caller address for limiting.
 *
 * `x-forwarded-for` is honoured only when the deployment says it is behind a
 * proxy. Trusting it unconditionally would let any caller forge the header and
 * sidestep the limit entirely.
 */
export function clientKey(
  headers: Record<string, string | string[] | undefined>,
  socketAddr: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return socketAddr ?? 'unknown';
}
