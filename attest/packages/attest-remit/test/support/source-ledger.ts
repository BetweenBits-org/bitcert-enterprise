/**
 * The platform's ledger of settlements, for the stand-in platforms of the
 * tests — not a copy of its "one message, one settlement" rule but the rule
 * itself: the platform's own store (`apps/core/src/remit/store.ts`) on an
 * in-memory database. What a stand-in accepts, refuses and finds here is what
 * the platform accepts, refuses and finds.
 *
 * It exists because a stand-in that only resembles the platform makes a test
 * pass for a client that would pay twice — or call a payment made that never
 * was. An independent review found exactly that in a hand-written copy of the
 * rule: it answered lookups in another order, matched every twin to the
 * oldest settlement, and took references the platform refuses.
 *
 * Three stand-ins lean on it: the one in `client.test.ts`, the one the golden
 * scenarios of the Java port are generated against
 * (`sdks/attest-remit-java/tools/make-golden.mjs`), and — by way of those
 * scenarios — the Java port's own.
 *
 * Time is the ledger's own: every settlement is stamped one millisecond after
 * the one before, so "the oldest" and "the newest" are the order of arrival,
 * the same on every run.
 */
import { openDb } from '../../../../apps/core/src/db.ts';
import type { Db } from '../../../../apps/core/src/db.ts';
import { RemitStore, sourceRefOf } from '../../../../apps/core/src/remit/store.ts';
import type { SourceConflict } from '../../../../apps/core/src/remit/store.ts';

const ORG = 'o-stand-in';
const QUOTE = 'Q-stand-in';

/** How the platform answers an instruction it does not accept. */
export interface Refusal {
  status: 400 | 409;
  body: { error: string; message: string; existing_payment_id?: string; ground?: string };
}

/** What a lookup answers: the ids on this page, how many there are in all, and where the next page starts. */
export interface LedgerPage { ids: string[]; total: number; nextCursor: string | null }

/** A settlement as it stands on the platform: its id, its state, and the evidence elements the bank signed. */
interface Standing { payment_id: string; state?: string; events: { type: string; payload?: unknown }[] }

const sourceMessageIn = (elements: unknown): unknown =>
  (elements as { bankInstruction?: { sourceMessage?: unknown } } | null | undefined)?.bankInstruction?.sourceMessage;
const elementsOf = (v: Standing): unknown => v.events.find((e) => e.type === 'BANK_EVIDENCE_SUBMITTED')?.payload;

export class SourceLedger {
  private clock = Date.parse('2026-11-16T00:00:00.000Z');
  private readonly db: Db;
  private readonly store: RemitStore;

  private constructor(db: Db, store: RemitStore) {
    this.db = db;
    this.store = store;
  }

  static async open(): Promise<SourceLedger> {
    const db = await openDb(':memory:');
    await db.prepare('INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)').run(ORG, ORG, 'Stand-in bank', '2026-01-01T00:00:00.000Z');
    const store = new RemitStore(db);
    await store.saveQuote(ORG, QUOTE, 'VN', 'SG', {}, {}, '2099-01-01T00:00:00.000Z');
    return new SourceLedger(db, store);
  }

  private row(id: string) {
    return {
      id, org_id: ORG, quote_id: QUOTE, corridor_origin: 'VN', corridor_destination: 'SG',
      trade_currency: 'USD', trade_amount: '0.00', collect_currency: 'VND', collect_amount: '0',
      usdc_amount: '0.00', payout_currency: 'SGD', payout_amount: '0.00',
      beneficiary_institution: 'SG-BFI-001', request_body: '{}',
    };
  }

  /** One millisecond after the settlement before: arrival order is age. */
  private async stamp(paymentId: string): Promise<void> {
    this.clock += 1;
    const at = new Date(this.clock).toISOString();
    await this.db.prepare('UPDATE remit_payments SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, paymentId);
    await this.db.prepare('UPDATE remit_source_refs SET created_at = ? WHERE payment_id = ?').run(at, paymentId);
  }

  private static refusal(conflict: SourceConflict, uetr: string | null): Refusal {
    const id = conflict.paymentId;
    const say = (error: string, ground: string, message: string): Refusal =>
      ({ status: 409, body: { existing_payment_id: id, ground, error, message } });
    if (conflict.reused) return say('reference_reused', 'uetr', `UETR ${uetr} is already on settlement ${id}, which is a different payment`);
    if (conflict.undated) {
      return say('duplicate_source_message', 'twin_undated', `this payment cannot be told from settlement ${id}: the message states no value date`);
    }
    const why = conflict.ground === 'message' ? 'the same transaction of the same message'
      : conflict.ground === 'uetr' ? 'the same UETR' : 'the same payment in another message';
    return say('duplicate_source_message', conflict.ground, `this message's payment is already settlement ${id} — ${why}`);
  }

  has(paymentId: string): Promise<boolean> {
    return this.store.get(paymentId).then((p) => !!p);
  }

  /**
   * `POST /v1/settlements`, as far as the ledger decides it: a payment id
   * that is taken, a reference that is not one, a message that already has a
   * settlement — or the settlement is taken and `null` is returned.
   */
  async accept(paymentId: string, evidenceElements: unknown): Promise<Refusal | null> {
    const taken: Refusal = { status: 409, body: { error: 'duplicate_payment', message: 'exists' } };
    if (await this.has(paymentId)) return taken;
    let ref;
    try {
      ref = sourceRefOf(sourceMessageIn(evidenceElements));
    } catch (e) {
      return { status: 400, body: { error: 'invalid_source_message', message: e instanceof Error ? e.message : String(e) } };
    }
    if (ref) {
      const made = await this.store.createFromMessage(this.row(paymentId), ref);
      if ('idTaken' in made) return taken;
      if ('conflict' in made) return SourceLedger.refusal(made.conflict, ref.uetr);
    } else {
      await this.store.create(this.row(paymentId));
    }
    await this.stamp(paymentId);
    return null;
  }

  /**
   * Settlements that were on the platform before it kept one settlement per
   * message, in the order given: they are stored as an earlier platform
   * stored them, and given their places the way a start gives them
   * (`backfillSourceRefs` — a reference written loosely is still read; of two
   * that stand for one message, the one that was not cancelled, then the
   * older, holds the place).
   */
  async addFromBefore(settlements: Standing[]): Promise<void> {
    for (const v of settlements) {
      await this.store.create(this.row(v.payment_id));
      const elements = elementsOf(v);
      if (elements !== undefined) {
        await this.store.appendEvent(v.payment_id, 'BANK_EVIDENCE_SUBMITTED', 'VN-BANK-T1', elements as Record<string, unknown>);
      }
      if (v.state === 'CANCELLED' || v.state === 'RETURNED' || v.state === 'EXCEPTION') await this.store.transition(v.payment_id, v.state);
      await this.stamp(v.payment_id);
    }
    await this.store.backfillSourceRefs();
  }

  /**
   * `GET /v1/settlements`: every settlement, or — with `source_uetr`, or
   * `source_content` (and `source_value_date`) — those that hold a matching
   * place. Newest first, paged by `limit` and `cursor`, as the platform
   * answers. A lookup value that could never match is refused, as there.
   */
  async list(query: URLSearchParams): Promise<LedgerPage | Refusal> {
    const uetr = query.get('source_uetr');
    const content = query.get('source_content');
    const day = query.get('source_value_date');
    const bad = (message: string): Refusal => ({ status: 400, body: { error: 'invalid_source_lookup', message } });
    if (uetr !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uetr)) return bad('source_uetr must be a UUID');
    if (content !== null && !/^[0-9a-f]{64}$/i.test(content)) return bad('source_content must be a SHA-256 digest in hex');
    if (day !== null && content === null) return bad('source_value_date narrows source_content and needs it');
    if (day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad('source_value_date must be YYYY-MM-DD');
    const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? '25') || 25));
    const page = await this.store.search(ORG, {
      ...(uetr !== null ? { sourceUetr: uetr } : {}),
      ...(content !== null ? { sourceContent: content } : {}),
      ...(day !== null ? { sourceValueDate: day } : {}),
      ...(query.get('cursor') ? { cursor: query.get('cursor')! } : {}),
      limit,
    });
    return { ids: page.items.map((p) => p.id), total: page.total, nextCursor: page.nextCursor };
  }
}
