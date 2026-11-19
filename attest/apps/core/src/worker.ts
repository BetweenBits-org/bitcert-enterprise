/**
 * The batcher — a timer in this process, not a separate deployment.
 *
 * Each tick: seal waiting attestations if the batch is full or the window has
 * elapsed, anchor whatever is sealed, then refresh confirmations. One timer, no
 * queue, no broker. If the process restarts mid-cycle the next tick picks up
 * from the database, because every transition is committed before it is acted
 * on — there is no in-memory state to lose.
 *
 * Errors are logged and the loop continues. An unreachable node must not take
 * the API down with it: issuing attestations still works, they simply stay
 * `accepted` until the chain is reachable again.
 */
import type { AttestService } from './service.ts';

export interface WorkerOptions {
  tickMs: number;
  flushIntervalMs: number;
  maxLeaves: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Run after a batch is submitted.
   *
   * Exists for regtest, where nothing mines on its own: without it an anchor
   * would stay unconfirmed indefinitely and the free tier would never complete.
   * Left unset on mainnet, where blocks arrive without our help.
   */
  afterAnchor?: () => Promise<void>;
  /** Free-tier retention. `0` disables the sweep. */
  retentionDays?: number;
}

export class BatchWorker {
  private readonly svc: AttestService;
  private readonly opts: WorkerOptions;
  private timer: NodeJS.Timeout | null = null;
  private lastFlush = Date.now();
  private lastSweep = 0;
  private running = false;

  constructor(svc: AttestService, opts: WorkerOptions) {
    this.svc = svc;
    this.opts = opts;
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    (this.opts.log ?? (() => {}))(msg, extra);
  }

  start(): void {
    if (this.opts.tickMs <= 0) {
      this.log('worker disabled (WORKER_TICK_MS=0)');
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickMs);
    // Do not hold the event loop open on its own account — a shutdown should not
    // have to wait for a tick.
    this.timer.unref();
    this.log('worker started', { tickMs: this.opts.tickMs, flushIntervalMs: this.opts.flushIntervalMs });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One cycle. Exposed so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.running) return; // a slow chain must not overlap ticks
    this.running = true;
    try {
      const pending = await this.svc.pendingCount();
      const due = Date.now() - this.lastFlush >= this.opts.flushIntervalMs;
      if (pending > 0 && (pending >= this.opts.maxLeaves || due)) {
        // One batch per tick, and a batch is now one organisation's records —
        // so with several tenants waiting, the rest are picked up on the
        // following ticks rather than all being flushed into one tree.
        const batchId = await this.svc.sealBatch();
        this.lastFlush = Date.now();
        if (batchId) {
          this.log('batch sealed', { batchId, leaves: pending });
          try {
            const txid = await this.svc.anchorBatch(batchId);
            this.log('batch anchored', { batchId, txid });
            if (this.opts.afterAnchor) {
              try {
                await this.opts.afterAnchor();
              } catch (e) {
                // The anchor is already broadcast; failing to confirm it is a
                // separate, recoverable problem.
                this.log('post-anchor step failed', { batchId, error: errMsg(e) });
              }
            }
          } catch (e) {
            // The batch stays `sealed` and the next tick retries it.
            this.log('anchor failed, will retry', { batchId, error: errMsg(e) });
          }
        }
      }
      const promoted = await this.svc.refreshConfirmations();
      if (promoted > 0) this.log('anchors confirmed', { count: promoted });

      // Retention sweep. Runs at most hourly rather than every tick — it is a
      // delete over an indexed column, not something to do every two seconds.
      if ((this.opts.retentionDays ?? 0) > 0 && Date.now() - this.lastSweep >= 3_600_000) {
        this.lastSweep = Date.now();
        const purged = await this.svc.purgeExpiredPublic();
        if (purged > 0) this.log('expired free-tier records purged', { count: purged });
      }
    } catch (e) {
      this.log('worker tick failed', { error: errMsg(e) });
    } finally {
      this.running = false;
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
