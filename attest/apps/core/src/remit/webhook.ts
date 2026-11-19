/**
 * Webhook outbox — at-least-once, platform-signed, backed by a table.
 *
 * The industry pattern the last-mile analysis documents: push with retries,
 * and when the push budget is exhausted the bank's poll of
 * `GET /v1/settlements/{id}` is the backstop — so exhaustion is a recorded
 * condition, not a lost message. The bank dedupes on `event_id` and orders on
 * `sequence`; HTTP 200 from the bank acknowledges receipt of the
 * notification and asserts nothing about the payment itself.
 */
import { randomUUID } from 'node:crypto';
import { signEvent } from './sign.ts';
import type { EventSig, PlatformKey } from './sign.ts';
import type { Db } from '../db.ts';

export interface WebhookEnvelope {
  event_id: string;
  payment_id: string;
  sequence: number;
  type: string;
  state: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

export interface SignedWebhook {
  envelope: WebhookEnvelope;
  signature: EventSig;
}

const nowIso = (): string => new Date().toISOString();

/** Delay ladder: 2s, 10s, 30s, 2m, 10m — then exhausted (poll covers it). */
const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000];

export class WebhookOutbox {
  private readonly db: Db;
  private readonly platform: PlatformKey;
  private readonly maxAttempts: number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(db: Db, platform: PlatformKey, maxAttempts: number,
    log: (msg: string, extra?: Record<string, unknown>) => void) {
    this.db = db;
    this.platform = platform;
    this.maxAttempts = maxAttempts;
    this.log = log;
  }

  /** Queue one event for an org's webhook URL. No URL registered → no-op. */
  async enqueue(orgId: string, url: string | undefined, paymentId: string, sequence: number,
    type: string, state: string, data: Record<string, unknown>): Promise<void> {
    if (!url) return;
    const envelope: WebhookEnvelope = {
      event_id: randomUUID(),
      payment_id: paymentId,
      sequence,
      type,
      state,
      occurred_at: nowIso(),
      data,
    };
    const body: SignedWebhook = {
      envelope,
      signature: signEvent(envelope, this.platform.key, this.platform.keyId, 'STONEHASH'),
    };
    await this.db.prepare(
      `INSERT INTO remit_webhook_deliveries
         (id, org_id, payment_id, event_id, url, body, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), orgId, paymentId, envelope.event_id, url,
      JSON.stringify(body), nowIso(), nowIso());
  }

  /** Deliver everything due. Called from the remit worker tick. */
  async deliverDue(): Promise<number> {
    const due = (await this.db.prepare(
      `SELECT id, url, body, attempts FROM remit_webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 20`,
    ).all(nowIso())) as unknown as { id: string; url: string; body: string; attempts: number }[];

    let delivered = 0;
    for (const d of due) {
      try {
        const res = await fetch(d.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: d.body,
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status >= 200 && res.status < 300) {
          await this.db.prepare("UPDATE remit_webhook_deliveries SET status = 'delivered', attempts = ? WHERE id = ?")
            .run(d.attempts + 1, d.id);
          delivered++;
          continue;
        }
        await this.reschedule(d.id, d.attempts, `HTTP ${res.status}`);
      } catch (e) {
        await this.reschedule(d.id, d.attempts, e instanceof Error ? e.message : String(e));
      }
    }
    return delivered;
  }

  private async reschedule(id: string, attempts: number, error: string): Promise<void> {
    const next = attempts + 1;
    if (next >= this.maxAttempts) {
      await this.db.prepare(
        "UPDATE remit_webhook_deliveries SET status = 'exhausted', attempts = ?, last_error = ? WHERE id = ?",
      ).run(next, error, id);
      this.log('webhook exhausted — bank-side polling covers it', { delivery: id, error });
      return;
    }
    const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)]!;
    await this.db.prepare(
      "UPDATE remit_webhook_deliveries SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
    ).run(next, error, new Date(Date.now() + delay).toISOString(), id);
  }
}
