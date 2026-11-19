/**
 * Payment store and state machine.
 *
 * Nine states, strictly forward (arch doc §8-1). A state is a *summary* of
 * the signed events beneath it, never a fact of its own: every transition is
 * caused by an appended event, the event is what carries a signature, and a
 * replay of the event log must land on the same state. Corrections are new
 * events (`RETURNED`, `CORRECTION`), never edits — which is also why the
 * events table has no UPDATE path in this module.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from '../service.ts';
import { likeContains } from '../db.ts';
import type { EventSig } from './sign.ts';
import type { Db } from '../db.ts';

export const REMIT_STATES = [
  'REQUEST_ACCEPTED',          // 1 — accepted, idempotency passed
  'BANK_AUTHORIZED',           // 2 — bank signature + quote + registry verified
  'TRAVEL_RULE_PENDING',       // 3 — IVMS101 sent, awaiting BFI
  'PAYOUT_PRE_APPROVED',       // 4 — BFI PAYOUT_ACCEPTED signature held
  'ONCHAIN_SETTLED',           // 5 — USDC transfer block-confirmed
  'PAYOUT_IN_PROGRESS',        // 6 — BFI confirmed receipt, local payout running
  'BENEFICIARY_CREDIT_CONFIRMED', // 7 — L2+ signed payout + reconciliation passed
  'EVIDENCE_ANCHORED',         // 8 — package commitment confirmed on-chain
] as const;
export type RemitState = typeof REMIT_STATES[number]
  | 'CANCELLED' | 'RETURNED' | 'EXCEPTION';

const ORDER = new Map<string, number>(REMIT_STATES.map((s, i) => [s, i]));

/** Every value `state=` may legally carry in a search filter. */
export const REMIT_FILTER_STATES: readonly string[] =
  [...REMIT_STATES, 'CANCELLED', 'RETURNED', 'EXCEPTION'];

export interface RemitPayment {
  id: string;
  org_id: string;
  quote_id: string;
  state: RemitState;
  corridor_origin: string;
  corridor_destination: string;
  trade_currency: string;
  trade_amount: string;
  collect_currency: string;
  collect_amount: string;
  usdc_amount: string;
  payout_currency: string;
  payout_amount: string;
  beneficiary_institution: string;
  deposit_address: string | null;
  chain_tx: string | null;
  evidence_level: string | null;
  request_body: string;
  verdict: string | null;
  package_json: string | null;
  commitment: string | null;
  nonce: string | null;
  attestation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemitEvent {
  id: string;
  payment_id: string;
  seq: number;
  type: string;
  issuer: string;
  payload: string;
  sig: string | null;
  created_at: string;
}

export interface SettlementSearch {
  /** Case-insensitive substring of the payment id. */
  q?: string;
  /**
   * Exact lookups on the message a settlement was made from — the question a
   * bank's system asks before it sends: "is this payment here already?".
   * Unlike `q` they match the whole value, through an index: a reference of
   * two characters finds its payment and no other.
   */
  sourceUetr?: string;
  sourceContent?: string;
  /** With `sourceContent`: only settlements whose message stated this value date. */
  sourceValueDate?: string;
  state?: string;
  /** Inclusive ISO bounds on created_at. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface SettlementPage {
  items: RemitPayment[];
  /** Row count under the same filters, ignoring the cursor. */
  total: number;
  /** Opaque; feed back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null;
}

const nowIso = (): string => new Date().toISOString();

/**
 * What tells one payment from another, out of the reference to its SWIFT
 * message that the bank signed into the instruction (`bankInstruction.
 * sourceMessage`).
 *
 * `sha256` and `index` name one transaction of one file. `uetr` names a
 * payment by itself. `content` is the bank's own digest of what makes the
 * payment this payment (amounts, parties, accounts, identifiers, remittance
 * text).
 *
 * `twinKey` stands for the same payment written out again in other bytes:
 *   - where the payment carries an instruction or an end-to-end identifier:
 *     those two, the value date and the content — whatever message it stands
 *     in. An MT103 once with and once without its header blocks; a payment
 *     retried alone after it went out in a batch.
 *   - where it carries neither (a pain.001 whose only number is the file's
 *     message id): the message type, the message id, the position in the
 *     message, the value date and the content. The same file exported again
 *     with a new creation time. Under another message id nothing tells such
 *     a payment from a new one, and none is claimed.
 */
export interface SourceRef {
  messageType: string;
  sha256: string;
  index: number;
  uetr: string | null;
  /** The value date the message states, `YYYY-MM-DD` — or null when it states none. */
  valueDate: string | null;
  content: string | null;
  twinKey: string | null;
  /** The message states no value date: its twin key cannot tell one day's payment from another's. */
  undated: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
/** The words the standards write where there is no reference. */
const NO_REFERENCE = /^(NOTPROVIDED|NONREF|NOREF)$/i;

/** `YYYY-MM-DD`, and a day the calendar has. */
function isCalendarDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The twin key of a reference whose parts have been read and normalised. */
function twinKeyOf(r: {
  messageType: string; index: number; content: string | null;
  instructionId: string; endToEndId: string; messageId: string; valueDate: string;
}): string | null {
  if (r.content === null) return null;
  if (r.instructionId !== '' || r.endToEndId !== '') {
    return sha256Of(JSON.stringify(['stonehash:remit:twin:v1', r.instructionId, r.endToEndId, r.valueDate, r.content]));
  }
  if (r.messageId !== '') {
    return sha256Of(JSON.stringify(['stonehash:remit:twin-by-message:v1', r.messageType, r.messageId, r.index, r.valueDate, r.content]));
  }
  return null;
}

/**
 * Read the signed source-message reference. `null` when the instruction was
 * not made from a message.
 *
 * A reference that is there but cannot be what it claims to be is refused: a
 * UETR that is not a UUID, a digest that is not a digest, a value date that
 * is not a day. Taken as written, it would never equal the same reference
 * written properly, and the payment would walk past the duplicate check it
 * is signed for. What never tells two references apart is normalised
 * instead: letter case in a UETR or a digest, white space around an
 * identifier, and the words that stand for "no end-to-end id".
 */
export function sourceRefOf(sourceMessage: unknown): SourceRef | null {
  if (sourceMessage === undefined || sourceMessage === null) return null;
  const bad = (what: string): ServiceError => new ServiceError(400, 'invalid_source_message',
    `evidence_elements.bankInstruction.sourceMessage: ${what}`);
  if (typeof sourceMessage !== 'object' || Array.isArray(sourceMessage)) throw bad('must be an object');
  const m = sourceMessage as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const v = m[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.length > max) throw bad(`${key} must be text of at most ${max} characters`);
    return v;
  };
  const messageType = text('type', 40);
  if (!messageType) throw bad('type is required (the message type, e.g. pacs.008.001.08 or MT103)');
  const sha256 = text('sha256', 64);
  if (sha256 === null || !DIGEST.test(sha256)) throw bad('sha256 is required: the SHA-256 of the message as the bank\'s system wrote it, in hex');
  const index = m.index === undefined || m.index === null ? 0 : m.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 1_000_000) {
    throw bad('index must be the position of the transaction in its message, counted from 0');
  }
  const uetr = text('uetr', 36);
  if (uetr !== null && !UUID.test(uetr)) throw bad('uetr must be a UUID');
  const content = text('content', 64);
  if (content !== null && !DIGEST.test(content)) throw bad('content must be a SHA-256 digest in hex');
  const valueDate = text('valueDate', 32);
  if (valueDate !== null && !isCalendarDay(valueDate)) throw bad('valueDate must be a calendar day written YYYY-MM-DD');
  const instructionId = (text('instructionId', 256) ?? '').trim();
  const endToEnd = (text('endToEndId', 256) ?? '').trim();
  const messageId = (text('messageId', 256) ?? '').trim();
  const normalContent = content === null ? null : content.toLowerCase();
  return {
    messageType, sha256: sha256.toLowerCase(), index: index === 0 ? 0 : index,
    uetr: uetr === null ? null : uetr.toLowerCase(),
    valueDate, content: normalContent,
    twinKey: twinKeyOf({
      messageType, index, content: normalContent, instructionId, messageId,
      endToEndId: NO_REFERENCE.test(endToEnd) ? '' : endToEnd, valueDate: valueDate ?? '',
    }),
    undated: valueDate === null,
  };
}

/**
 * The same reference, read out of a settlement that was accepted before the
 * platform checked any of it. Nothing is refused here — an old settlement
 * cannot be sent back — and whatever identifies it is kept: a UETR that is
 * one, a digest that is one, a date that is one. A file digest that cannot be
 * read is replaced by one of the settlement itself, so that the row stands
 * for this settlement and no other. `null` only when there is no reference.
 */
export function legacySourceRefOf(sourceMessage: unknown, paymentId: string): SourceRef | null {
  if (sourceMessage === undefined || sourceMessage === null || typeof sourceMessage !== 'object' || Array.isArray(sourceMessage)) return null;
  const m = sourceMessage as Record<string, unknown>;
  const text = (key: string, max: number): string => (typeof m[key] === 'string' && (m[key] as string).length <= max ? m[key] as string : '');
  const messageType = text('type', 40) || 'unknown';
  const sha256 = DIGEST.test(text('sha256', 64)) ? text('sha256', 64).toLowerCase() : sha256Of(`stonehash:remit:legacy-source:${paymentId}`);
  const rawIndex = typeof m.index === 'string' && /^\d{1,7}$/.test(m.index) ? Number(m.index) : m.index;
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex > 0 && rawIndex <= 1_000_000 ? rawIndex : 0;
  const uetr = UUID.test(text('uetr', 36).trim()) ? text('uetr', 36).trim().toLowerCase() : null;
  const content = DIGEST.test(text('content', 64)) ? text('content', 64).toLowerCase() : null;
  const day = text('valueDate', 32).trim();
  const valueDate = isCalendarDay(day) ? day : null;
  const endToEnd = text('endToEndId', 256).trim();
  return {
    messageType, sha256, index, uetr, valueDate, content,
    twinKey: twinKeyOf({
      messageType, index, content, instructionId: text('instructionId', 256).trim(), messageId: text('messageId', 256).trim(),
      endToEndId: NO_REFERENCE.test(endToEnd) ? '' : endToEnd, valueDate: valueDate ?? '',
    }),
    undated: valueDate === null,
  };
}

/** The settlement that already stands for a message, and on what ground. */
export interface SourceConflict {
  paymentId: string;
  /**
   * `message` the same transaction of the same file (its SHA-256 and position);
   * `uetr`    the two carry the same UETR;
   * `twin`    another file that states the same payment — the same
   *           instruction and end-to-end identifiers, value date and content;
   *           or, where the payment has neither identifier, the same message
   *           id, position, value date and content — and at least one of the
   *           two has no UETR to settle it.
   */
  ground: 'message' | 'uetr' | 'twin';
  /**
   * `uetr` only: the UETR stands on a different payment — the two state
   * different content, or are two transactions of one file.
   */
  reused: boolean;
  /**
   * `twin` only: neither states a value date, so nothing says whether this is
   * that payment again or the next one like it. A refusal, not a recognition.
   */
  undated: boolean;
}

/** What a settlement row is created from. */
export type NewRemitPayment = Omit<RemitPayment, 'state' | 'deposit_address' | 'chain_tx' | 'evidence_level'
  | 'verdict' | 'package_json' | 'commitment' | 'nonce' | 'attestation_id' | 'created_at' | 'updated_at'>;

/**
 * Keyset cursor: where the previous page stopped, not an offset. An OFFSET
 * walks and discards every earlier row on every page — on a ledger that only
 * grows, page 40 would re-scan pages 1–39 and shift under concurrent
 * inserts. The (created_at, id) pair does neither.
 */
function encodeCursor(p: RemitPayment): string {
  return Buffer.from(JSON.stringify({ c: p.created_at, i: p.id }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { c: string; i: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof v.c !== 'string' || typeof v.i !== 'string') throw new Error('shape');
    return { c: v.c, i: v.i };
  } catch {
    throw new ServiceError(400, 'invalid_cursor', 'the cursor is not one this API issued');
  }
}

export class RemitStore {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async get(paymentId: string): Promise<RemitPayment | null> {
    return ((await this.db.prepare('SELECT * FROM remit_payments WHERE id = ?')
      .get(paymentId)) as unknown as RemitPayment) ?? null;
  }

  async getForOrg(orgId: string, paymentId: string): Promise<RemitPayment | null> {
    const p = await this.get(paymentId);
    return p && p.org_id === orgId ? p : null;
  }

  async list(orgId: string, limit = 100): Promise<RemitPayment[]> {
    return (await this.db.prepare(
      'SELECT * FROM remit_payments WHERE org_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(orgId, Math.min(limit, 500))) as unknown as RemitPayment[];
  }

  /**
   * Filtered, keyset-paged ledger view — the shape a bank with thousands of
   * settlements needs. Ordered newest-first on (created_at, id), both halves
   * carried in the cursor so rows created in the same millisecond cannot be
   * skipped or repeated across a page boundary.
   */
  async search(orgId: string, s: SettlementSearch): Promise<SettlementPage> {
    const limit = Math.max(1, Math.min(s.limit ?? 25, 100));
    const where: string[] = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (s.q) {
      // One box, every identifier an operator gets handed: the platform's
      // payment id, the quote it came from, the USDC transaction hash, or
      // the bank's own reference on the payout completion — the way a
      // messaging network's search takes a UETR or a reference alike.
      // `likeContains` does the case-folding and wildcard escaping that keep
      // the two engines answering alike. Only the bank_reference field of the
      // completion payload is searched, not the JSON around it — otherwise a
      // search for "payment_id" matched every completed settlement.
      //
      // The bank's own references are searched the same way, field by field:
      // the identifiers of the SWIFT message the instruction was made from
      // (UETR, instruction id, end-to-end id, message id — signed into the
      // bank instruction by the bank), its approval reference, and the
      // instruction reference of its authorisation. An operator looks a
      // payment up by the number their own system printed.
      const like = likeContains(s.q);
      const field = (path: string): string =>
        `UPPER(COALESCE(JSON_EXTRACT(e.payload, '${path}'), '')) LIKE ? ESCAPE '!'`;
      const bankRefs = [
        '$.bankInstruction.sourceMessage.uetr', '$.bankInstruction.sourceMessage.instructionId',
        '$.bankInstruction.sourceMessage.endToEndId', '$.bankInstruction.sourceMessage.messageId',
        '$.bankApproval.approvalRef',
      ];
      where.push(`(UPPER(id) LIKE ? ESCAPE '!' OR UPPER(quote_id) LIKE ? ESCAPE '!'
        OR UPPER(COALESCE(chain_tx, '')) LIKE ? ESCAPE '!'
        OR EXISTS (SELECT 1 FROM remit_events e WHERE e.payment_id = remit_payments.id
                   AND e.type = 'PAYOUT_COMPLETED' AND ${field('$.bank_reference')})
        OR EXISTS (SELECT 1 FROM remit_events e WHERE e.payment_id = remit_payments.id
                   AND e.type = 'BANK_EVIDENCE_SUBMITTED' AND (${bankRefs.map(field).join(' OR ')}))
        OR EXISTS (SELECT 1 FROM remit_events e WHERE e.payment_id = remit_payments.id
                   AND e.type = 'BANK_AUTHORIZATION_VERIFIED' AND ${field('$.bank_authorization.instruction_ref')}))`);
      params.push(like, like, like, like, ...bankRefs.map(() => like), like);
    }
    if (s.sourceUetr !== undefined || s.sourceContent !== undefined) {
      const conds: string[] = ['r.payment_id = remit_payments.id', 'r.org_id = ?'];
      const args: unknown[] = [orgId];
      if (s.sourceUetr !== undefined) { conds.push('r.uetr = ?'); args.push(s.sourceUetr.toLowerCase()); }
      if (s.sourceContent !== undefined) { conds.push('r.content = ?'); args.push(s.sourceContent.toLowerCase()); }
      if (s.sourceValueDate !== undefined) { conds.push('r.value_date = ?'); args.push(s.sourceValueDate); }
      where.push(`EXISTS (SELECT 1 FROM remit_source_refs r WHERE ${conds.join(' AND ')})`);
      params.push(...args);
    }
    if (s.state) {
      // One state, or several separated by commas: a bank reads "paid out"
      // as one thing although the platform records two states for it.
      const states = s.state.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
      for (const st of states) {
        if (!REMIT_FILTER_STATES.includes(st)) {
          throw new ServiceError(400, 'invalid_state', `state must be one of ${REMIT_FILTER_STATES.join(', ')}`);
        }
      }
      where.push(`state IN (${states.map(() => '?').join(', ')})`);
      params.push(...states);
    }
    if (s.from) { where.push('created_at >= ?'); params.push(s.from); }
    if (s.to) { where.push('created_at <= ?'); params.push(s.to); }

    const total = ((await this.db.prepare(
      `SELECT COUNT(*) AS n FROM remit_payments WHERE ${where.join(' AND ')}`,
    ).get(...(params as never[]))) as unknown as { n: number }).n;

    if (s.cursor) {
      const cur = decodeCursor(s.cursor);
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cur.c, cur.c, cur.i);
    }

    // One row beyond the page answers "is there a next page" without a
    // second query and without a phantom empty page at an exact multiple.
    const rows = (await this.db.prepare(
      `SELECT * FROM remit_payments WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    ).all(...(params as never[]))) as unknown as RemitPayment[];

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      total: Number(total),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  /**
   * The settlement that already stands for this message, if one does — and,
   * where the message is recognised as another rendering of it, the note of
   * that recognition. Runs inside `asSourceWriter`.
   *
   * One settlement per payment, within an organisation — in this order:
   *   - the same transaction of the same file is the same payment;
   *   - a transaction that was recognised as a settlement before is still it;
   *   - the same UETR is the same payment, whatever the message looks like
   *     (or, with other content or on another transaction of the same file,
   *     a UETR used twice);
   *   - where at least one of the two has no UETR, another file that states
   *     the same payment (see `SourceRef.twinKey`) is that payment sent again.
   * Two different UETRs are two payments, whatever else they share, and so
   * are two transactions of one file.
   *
   * A twin is matched one to one. A file with two transactions that read
   * alike is two payments; written out again, each of its transactions is
   * the twin of ONE of the two settlements, not both of the oldest — so the
   * recognition is recorded (`remit_source_matches`), and a settlement that a
   * sibling of the incoming transaction was recognised as is not offered to
   * it again. Without that, the second of two instalments would be called
   * paid because the first was. And a settlement without a UETR takes the
   * UETR of the rendering it is recognised in: from then on it is that
   * UETR's payment, and a payment with another UETR is not its twin.
   */
  private async sourceConflict(db: Db, orgId: string, ref: SourceRef): Promise<SourceConflict | null> {
    type Row = { payment_id: string; uetr: string | null; content: string | null; sha256: string; idx: number };
    const cols = 'r.payment_id, r.uetr, r.content, r.sha256, r.idx';
    const recognise = async (paymentId: string): Promise<void> => {
      await db.prepare(
        'INSERT INTO remit_source_matches (org_id, sha256, idx, payment_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(orgId, ref.sha256, ref.index, paymentId, nowIso());
    };

    // The same transaction of the same file first: it is the same payment whatever else is
    // said about it — also when two versions of a reader came to different content digests
    // for the same bytes, which must never read as "its UETR is on another payment".
    const same = (await db.prepare(
      `SELECT ${cols} FROM remit_source_refs r WHERE r.org_id = ? AND r.sha256 = ? AND r.idx = ?`,
    ).get(orgId, ref.sha256, ref.index)) as unknown as Row | undefined;
    if (same) return { paymentId: same.payment_id, ground: 'message', reused: false, undated: false };

    const known = (await db.prepare(
      'SELECT payment_id FROM remit_source_matches WHERE org_id = ? AND sha256 = ? AND idx = ?',
    ).get(orgId, ref.sha256, ref.index)) as unknown as { payment_id: string } | undefined;
    if (known) return { paymentId: known.payment_id, ground: 'twin', reused: false, undated: false };

    if (ref.uetr !== null) {
      const row = (await db.prepare(
        `SELECT ${cols} FROM remit_source_refs r WHERE r.org_id = ? AND r.uetr = ?`,
      ).get(orgId, ref.uetr)) as unknown as Row | undefined;
      if (row) {
        const otherTransaction = row.sha256 === ref.sha256 && Number(row.idx) !== ref.index;
        const otherContent = ref.content !== null && row.content !== null && row.content !== ref.content;
        const reused = otherTransaction || otherContent;
        if (!reused) await recognise(row.payment_id);
        return { paymentId: row.payment_id, ground: 'uetr', reused, undated: false };
      }
    }

    if (ref.twinKey !== null) {
      // With a UETR in hand, only a settlement without one can be its twin. And a
      // settlement that another transaction of this same file was recognised as is taken.
      const twin = (await db.prepare(
        `SELECT ${cols} FROM remit_source_refs r
          WHERE r.org_id = ? AND r.twin_key = ? AND r.sha256 <> ?${ref.uetr !== null ? ' AND r.uetr IS NULL' : ''}
            AND NOT EXISTS (SELECT 1 FROM remit_source_matches m
                             WHERE m.org_id = r.org_id AND m.payment_id = r.payment_id AND m.sha256 = ?)
          ORDER BY r.created_at, r.payment_id LIMIT 1`,
      ).get(orgId, ref.twinKey, ref.sha256, ref.sha256)) as unknown as Row | undefined;
      if (twin) {
        if (ref.undated) return { paymentId: twin.payment_id, ground: 'twin', reused: false, undated: true };
        await recognise(twin.payment_id);
        if (ref.uetr !== null) {
          await db.prepare('UPDATE remit_source_refs SET uetr = ? WHERE payment_id = ? AND uetr IS NULL').run(ref.uetr, twin.payment_id);
        }
        return { paymentId: twin.payment_id, ground: 'twin', reused: false, undated: false };
      }
    }
    return null;
  }

  /**
   * Run `fn` as the only writer of this organisation's source references.
   *
   * The duplicate check and the insert that follows it have to be one step:
   * two requests for the same message arriving together must not both find
   * the place free. SQLite runs a transaction body alone on its queue; on
   * MySQL the organisation's row is locked for the length of the block, so
   * the answer does not depend on the isolation level the server runs at.
   * The lock is the first statement on purpose: under REPEATABLE READ a plain
   * SELECT before it would fix the transaction's view of the table at a
   * moment before the other request committed.
   */
  private async asSourceWriter<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.tx(async (tx) => {
      if (tx.dialect === 'mysql') await tx.prepare('SELECT id FROM orgs WHERE id = ? FOR UPDATE').get(orgId);
      return fn(tx);
    });
  }

  private async insertSourceRef(db: Db, orgId: string, paymentId: string, ref: SourceRef, createdAt: string): Promise<void> {
    await db.prepare(
      `INSERT INTO remit_source_refs
         (payment_id, org_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(paymentId, orgId, ref.messageType, ref.sha256, ref.index, ref.uetr, ref.valueDate, ref.content, ref.twinKey, createdAt);
  }

  /**
   * Create a settlement made from a message — unless one already stands for
   * that message, in which case nothing is created and the conflict is
   * returned. The check, the settlement row and its reference are one
   * transaction: a reference exists exactly when its settlement does.
   *
   * `born` runs inside that transaction, on a store bound to it: what a
   * settlement must have from its first moment — the events it was accepted
   * on, its first state — is written there. Nobody ever reads a settlement
   * that exists without the evidence it was accepted on; a request that lost
   * a race to this one finds it whole, and can tell that it is the same payment.
   */
  async createFromMessage(p: NewRemitPayment, ref: SourceRef, born?: (store: RemitStore) => Promise<void>): Promise<
    { payment: RemitPayment } | { conflict: SourceConflict } | { idTaken: true }> {
    const ts = nowIso();
    const refused = await this.asSourceWriter(p.org_id, async (tx) => {
      // The id first: two requests under one payment id are one payment handed over twice,
      // whatever message each was made from — and the second must hear "exists", not fail.
      if (await tx.prepare('SELECT 1 AS x FROM remit_payments WHERE id = ?').get(p.id)) return { idTaken: true as const };
      const found = await this.sourceConflict(tx, p.org_id, ref);
      if (found) return { conflict: found };
      await this.insertPayment(tx, p, ts);
      await this.insertSourceRef(tx, p.org_id, p.id, ref, ts);
      if (born) await born(new RemitStore(tx));
      return null;
    });
    if (refused) return refused;
    return { payment: (await this.get(p.id))! };
  }

  /**
   * Give an existing settlement its place — for settlements accepted before
   * the platform kept this table. Returns the conflict when another
   * settlement already stands for the message.
   */
  async claimSource(orgId: string, paymentId: string, ref: SourceRef, createdAt = nowIso()): Promise<SourceConflict | null> {
    return this.asSourceWriter(orgId, async (tx) => {
      const found = await this.sourceConflict(tx, orgId, ref);
      if (found) return found;
      await this.insertSourceRef(tx, orgId, paymentId, ref, createdAt);
      return null;
    });
  }

  /**
   * Settlements accepted before the platform kept this table: read the signed
   * reference out of each one's evidence and give it its place. Where two old
   * settlements stand for the same message, the one that got further keeps
   * the place (one that was cancelled, returned or stopped comes last), then
   * the older; the other is counted — it stays in the ledger, it is simply
   * not the one a new submission is compared with. Safe to run at every start.
   *
   * Old references are read leniently (`legacySourceRefOf`): whatever
   * identifies the settlement is kept, so that its message is not accepted a
   * second time because its reference was written loosely.
   *
   * One settlement that cannot be given its place must not keep the others
   * from theirs, nor the platform from starting: it is counted in `failed`,
   * named in `failures`, and tried again at the next start.
   */
  async backfillSourceRefs(): Promise<{
    claimed: number; duplicates: number; unreadable: number; failed: number; failures: string[]; rekeyed: number;
  }> {
    const out = { claimed: 0, duplicates: 0, unreadable: 0, failed: 0, failures: [] as string[], rekeyed: 0 };
    const referenceIn = (payload: string, paymentId: string): SourceRef | null => {
      try {
        return legacySourceRefOf((JSON.parse(payload) as { bankInstruction?: { sourceMessage?: unknown } }).bankInstruction?.sourceMessage, paymentId);
      } catch { return null; }
    };

    // Rows that hold a place without a twin key: the rule that makes keys may have learnt to
    // make one for them since (a payment known only by its message id). Read the signed
    // reference again and write the key it gives now.
    const keyless = (await this.db.prepare(
      `SELECT r.payment_id AS id, e.payload AS payload
         FROM remit_source_refs r JOIN remit_events e ON e.payment_id = r.payment_id AND e.type = 'BANK_EVIDENCE_SUBMITTED'
        WHERE r.twin_key IS NULL AND r.content IS NOT NULL`,
    ).all()) as unknown as { id: string; payload: string }[];
    for (const row of keyless) {
      const ref = referenceIn(row.payload, row.id);
      if (!ref?.twinKey) continue;
      try {
        await this.db.prepare('UPDATE remit_source_refs SET twin_key = ? WHERE payment_id = ? AND twin_key IS NULL').run(ref.twinKey, row.id);
        out.rekeyed++;
      } catch (e) {
        out.failed++;
        if (out.failures.length < 20) out.failures.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const rows = (await this.db.prepare(
      `SELECT p.id AS id, p.org_id AS org_id, p.created_at AS created_at, e.payload AS payload
         FROM remit_payments p JOIN remit_events e ON e.payment_id = p.id AND e.type = 'BANK_EVIDENCE_SUBMITTED'
        WHERE e.payload LIKE ? AND NOT EXISTS (SELECT 1 FROM remit_source_refs r WHERE r.payment_id = p.id)
        ORDER BY CASE WHEN p.state IN ('CANCELLED', 'RETURNED', 'EXCEPTION') THEN 1 ELSE 0 END, p.created_at, p.id`,
    ).all('%"sourceMessage"%')) as unknown as { id: string; org_id: string; created_at: string; payload: string }[];
    for (const row of rows) {
      const ref = referenceIn(row.payload, row.id);
      if (!ref) { out.unreadable++; continue; }
      try {
        if (await this.claimSource(row.org_id, row.id, ref, row.created_at)) out.duplicates++; else out.claimed++;
      } catch (e) {
        out.failed++;
        if (out.failures.length < 20) out.failures.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async events(paymentId: string): Promise<RemitEvent[]> {
    return (await this.db.prepare('SELECT * FROM remit_events WHERE payment_id = ? ORDER BY seq')
      .all(paymentId)) as unknown as RemitEvent[];
  }

  async eventOfType(paymentId: string, type: string): Promise<RemitEvent | null> {
    return ((await this.db.prepare(
      'SELECT * FROM remit_events WHERE payment_id = ? AND type = ? ORDER BY seq LIMIT 1',
    ).get(paymentId, type)) as unknown as RemitEvent) ?? null;
  }

  private async insertPayment(db: Db, p: NewRemitPayment, ts: string): Promise<void> {
    await db.prepare(
      `INSERT INTO remit_payments
         (id, org_id, quote_id, state, corridor_origin, corridor_destination,
          trade_currency, trade_amount, collect_currency, collect_amount, usdc_amount,
          payout_currency, payout_amount, beneficiary_institution, request_body,
          created_at, updated_at)
       VALUES (?, ?, ?, 'REQUEST_ACCEPTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.org_id, p.quote_id, p.corridor_origin, p.corridor_destination,
      p.trade_currency, p.trade_amount, p.collect_currency, p.collect_amount, p.usdc_amount,
      p.payout_currency, p.payout_amount, p.beneficiary_institution, p.request_body, ts, ts);
  }

  /** A settlement not made from a message. `born` as in `createFromMessage`: one transaction with the row. */
  async create(p: NewRemitPayment, born?: (store: RemitStore) => Promise<void>): Promise<RemitPayment> {
    if (born) {
      await this.db.tx(async (tx) => {
        await this.insertPayment(tx, p, nowIso());
        await born(new RemitStore(tx));
      });
    } else {
      await this.insertPayment(this.db, p, nowIso());
    }
    return (await this.get(p.id))!;
  }

  /**
   * Append one signed event. The caller states who asserted what; this module
   * only guarantees ordering and immutability.
   */
  async appendEvent(paymentId: string, type: string, issuer: string,
    payload: Record<string, unknown>, sig: EventSig | null = null): Promise<RemitEvent> {
    const next = ((await this.db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM remit_events WHERE payment_id = ?',
    ).get(paymentId)) as unknown as { n: number }).n;
    const id = randomUUID();
    await this.db.prepare(
      `INSERT INTO remit_events (id, payment_id, seq, type, issuer, payload, sig, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, paymentId, Number(next), type, issuer, JSON.stringify(payload),
      sig ? JSON.stringify(sig) : null, nowIso());
    return (await this.db.prepare('SELECT * FROM remit_events WHERE id = ?').get(id)) as unknown as RemitEvent;
  }

  /**
   * Move the state forward. A backward or sideways move is a programming
   * error, surfaced loudly: silently reordering states is how a payment rail
   * ends up claiming an outcome its events do not support.
   */
  async transition(paymentId: string, to: RemitState): Promise<RemitPayment> {
    const p = await this.get(paymentId);
    if (!p) throw new ServiceError(404, 'payment_not_found', `no payment ${paymentId}`);
    const TERMINAL = ['CANCELLED', 'RETURNED', 'EXCEPTION'];
    if (TERMINAL.includes(p.state)) {
      if (p.state === to) return p;
      throw new ServiceError(500, 'invalid_transition',
        `payment ${paymentId} is terminal (${p.state}); corrections are new events, not transitions`);
    }
    if (to === 'CANCELLED' || to === 'RETURNED' || to === 'EXCEPTION') {
      // Terminal exception states are reachable from any live state.
    } else {
      const from = ORDER.get(p.state);
      const target = ORDER.get(to);
      if (from === undefined || target === undefined || target < from) {
        throw new ServiceError(500, 'invalid_transition',
          `cannot move payment ${paymentId} from ${p.state} to ${to}: states only advance`);
      }
      if (target === from) return p; // idempotent re-apply
    }
    await this.db.prepare('UPDATE remit_payments SET state = ?, updated_at = ? WHERE id = ?')
      .run(to, nowIso(), paymentId);
    return (await this.get(paymentId))!;
  }

  async patch(paymentId: string, fields: Partial<Pick<RemitPayment,
    'deposit_address' | 'chain_tx' | 'evidence_level' | 'verdict' | 'package_json'
    | 'commitment' | 'nonce' | 'attestation_id'>>): Promise<void> {
    const cols = Object.keys(fields);
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    await this.db.prepare(`UPDATE remit_payments SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => (fields as Record<string, unknown>)[c] as never), nowIso(), paymentId);
  }

  /** Confirmed-anchor sweep input: payments whose evidence just landed. */
  async anchoredPending(): Promise<{ id: string; attestation_id: string }[]> {
    return (await this.db.prepare(
      `SELECT p.id, p.attestation_id FROM remit_payments p
         JOIN attestations a ON a.id = p.attestation_id
        WHERE p.state = 'BENEFICIARY_CREDIT_CONFIRMED' AND a.status = 'confirmed'`,
    ).all()) as unknown as { id: string; attestation_id: string }[];
  }

  /** The one sanctioned mutation of request_body: PII scrubbing after relay. */
  async patchRequestBody(paymentId: string, body: string): Promise<void> {
    await this.db.prepare('UPDATE remit_payments SET request_body = ?, updated_at = ? WHERE id = ?')
      .run(body, nowIso(), paymentId);
  }

  // ── Quotes ───────────────────────────────────────────────────────────────

  async saveQuote(orgId: string, id: string, origin: string, destination: string,
    request: unknown, response: unknown, expiresAt: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination,
         request, response, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, origin, destination, JSON.stringify(request), JSON.stringify(response),
      expiresAt, nowIso());
  }

  async quote(orgId: string, quoteId: string): Promise<{ id: string; response: string; expires_at: string } | null> {
    const q = (await this.db.prepare('SELECT * FROM remit_quotes WHERE id = ? AND org_id = ?')
      .get(quoteId, orgId)) as unknown as { id: string; response: string; expires_at: string } | undefined;
    return q ?? null;
  }

  // ── Idempotency (request half) ───────────────────────────────────────────

  async idempotencyHit(orgId: string, key: string): Promise<{ request_hash: string; response_status: number; response_body: string } | null> {
    return ((await this.db.prepare(
      'SELECT request_hash, response_status, response_body FROM remit_idempotency WHERE org_id = ? AND idem_key = ?',
    ).get(orgId, key)) as unknown as { request_hash: string; response_status: number; response_body: string }) ?? null;
  }

  async idempotencyStore(orgId: string, key: string, requestHash: string, status: number, body: unknown): Promise<void> {
    // REPLACE INTO is the spelling both engines accept (SQLite treats it as
    // INSERT OR REPLACE; MySQL as delete-then-insert on the duplicate key).
    await this.db.prepare(
      `REPLACE INTO remit_idempotency
         (org_id, idem_key, request_hash, response_status, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(orgId, key, requestHash, status, JSON.stringify(body), nowIso());
  }

  // ── Travel rule ──────────────────────────────────────────────────────────

  async saveTravelRule(paymentId: string, recipient: string, ciphertext: string,
    digest: string, status: string, response: unknown): Promise<void> {
    await this.db.prepare(
      `INSERT INTO remit_travel_rule (id, payment_id, protocol, recipient, ciphertext,
         ivms101_digest, status, response, created_at)
       VALUES (?, ?, 'IVMS101/JWE', ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), paymentId, recipient, ciphertext, digest, status,
      response === undefined ? null : JSON.stringify(response), nowIso());
  }

  async travelRule(paymentId: string): Promise<{ ivms101_digest: string; ciphertext: string; status: string } | null> {
    return ((await this.db.prepare(
      'SELECT ivms101_digest, ciphertext, status FROM remit_travel_rule WHERE payment_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(paymentId)) as unknown as { ivms101_digest: string; ciphertext: string; status: string }) ?? null;
  }
}
