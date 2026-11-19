/**
 * The remit worker — webhook delivery and the anchored-evidence sweep, on a
 * timer in this process, mirroring `BatchWorker`'s shape. Errors log and the
 * loop continues: an unreachable bank webhook must not stop payouts, and an
 * unreachable chain must not stop webhooks.
 */
import type { RemitOrchestrator } from './orchestrator.ts';
import type { WebhookOutbox } from './webhook.ts';

export class RemitWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly orchestrator: RemitOrchestrator;
  private readonly outbox: WebhookOutbox;
  private readonly tickMs: number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(orchestrator: RemitOrchestrator, outbox: WebhookOutbox, tickMs: number,
    log: (msg: string, extra?: Record<string, unknown>) => void) {
    this.orchestrator = orchestrator;
    this.outbox = outbox;
    this.tickMs = tickMs;
    this.log = log;
  }

  start(): void {
    if (this.tickMs <= 0) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref();
    this.log('remit worker started', { tickMs: this.tickMs });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const promoted = await this.orchestrator.promoteAnchored();
      if (promoted > 0) this.log('remit evidence anchored', { count: promoted });
      await this.outbox.deliverDue();
    } catch (e) {
      this.log('remit worker tick failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
  }
}
