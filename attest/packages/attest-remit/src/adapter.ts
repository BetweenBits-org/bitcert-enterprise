/**
 * The folder adapter — a bank integration with no code on the bank's side.
 *
 * The bank's payment system keeps doing what it does today: it writes the
 * SWIFT message for each outgoing payment. Point that output at a folder and
 * this adapter does the rest:
 *
 *   inbox/                     the bank drops MT103 / pacs.008 / pain.001 files
 *   inbox/processed/           each message, once it has become a settlement
 *   inbox/failed/              each message that could not, beside the reason
 *   outbox/<ref>.<payment id>.accepted.json     the settlement it became, and the mapping
 *   outbox/<ref>.<payment id>.status-NN-CODE.xml   a pacs.002 status report per change
 *   outbox/<ref>.<payment id>.status.json       the latest status, for systems that read JSON
 *   outbox/<ref>.<payment id>.evidence.json     the signed evidence package, at the end
 *   outbox/<ref>.<payment id>.verification.json the four re-checks of that package
 *
 * `<ref>` is the bank's own reference for the payment (the instruction id of
 * the message), so the files sort with the bank's records. The payment id
 * follows it because a reference alone does not name one payment: a system
 * may use the same reference again on another day, and two payments must not
 * write over each other's reports.
 *
 * Two more files may be dropped into the inbox, for the two things only the
 * bank can decide:
 *   <anything>.rfi.json     { "payment_id": "…", "answers": { … } }
 *   <anything>.cancel.json  { "payment_id": "…", "reason": "…" }
 *
 * Handing over the same message twice is safe: the payment id is derived
 * from the message's own references, so a re-drop finds the settlement it
 * already made. The adapter can be stopped and restarted at any point; what
 * it is following is written to `outbox/.adapter-state.json`.
 *
 * A file is taken once it has stopped changing. The writer should still
 * put it there in one step — write under a temporary name (`.tmp`, `.part`,
 * or a leading dot, all of which are ignored) and rename it into the inbox —
 * because a file that pauses half-written looks finished to anyone watching.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { RemitApiError, travelRuleQuestionOpen } from './client.ts';
import type { RemitClient, ReviewAssertions, SettlementView } from './client.ts';
import { SwiftMappingError } from './swift/mapping.ts';
import type { PartySupplement, SwiftMapping } from './swift/mapping.ts';
import { SwiftMessageError } from './swift/model.ts';
import type { SwiftPayment } from './swift/model.ts';
import { parseSwiftMessages } from './swift/parse.ts';
import { buildPacs002, swiftStatusOf } from './swift/status.ts';
import { verifyEvidencePackage } from './verify.ts';

export interface AdapterOptions {
  client: RemitClient;
  inbox: string;
  outbox: string;
  /** Customer-master extract keyed by the debtor's account — see samples/parties.sample.json. */
  parties?: Record<string, PartySupplement>;
  review?: ReviewAssertions;
  travelRule?: 'A' | 'B';
  /** One line per thing that happened. Default: console.log. */
  log?: (line: string) => void;
  /** How long a file must have been left alone before it is read, in ms. Default 2000. */
  settleMs?: number;
}

interface Open {
  ref: string; file: string; code: string; seq: number; evidence: boolean;
  /** When the status last changed — for a payment that waits on a person. */
  since?: string;
}
interface AdapterState { open: Record<string, Open> }

/**
 * States after which there is nothing more to report. A payment stopped in
 * EXCEPTION is not among them: its outcome is not settled, so it stays on
 * the list — looked at less often, and for a bounded time.
 */
const CLOSED = new Set(['EVIDENCE_ANCHORED', 'CANCELLED', 'RETURNED']);
/** A payment that waits on a person is looked at this often… */
const PARKED_POLL_MS = 60_000;
/** …and one stopped for manual resolution is followed for this long, then left to `status`. */
const STOPPED_FOLLOW_MS = 24 * 60 * 60 * 1000;
/** No payment message is anywhere near this; a larger file is not read at all. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'payment';

/** Written under another name and renamed into place: a reader never sees half a file. */
function writeText(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The customer-master lookup: by debtor account, as the message carries it. */
export function supplementFrom(parties: Record<string, PartySupplement> | undefined):
((payment: SwiftPayment) => PartySupplement | undefined) | undefined {
  if (!parties) return undefined;
  return (payment) => {
    const account = payment.debtor.account;
    return account ? parties[account] : undefined;
  };
}

/** What the mapping table looks like to a person reading a terminal or a log. */
export function describeMapping(mapping: SwiftMapping): string[] {
  const p = mapping.payment;
  const lines = [
    `message   ${p.messageType}  sha256 ${p.digest}${p.transactionCount > 1 ? `  (transaction ${p.index + 1} of ${p.transactionCount})` : ''}`,
  ];
  const width = Math.max(...mapping.fields.map((f) => f.target.length), 10);
  for (const f of mapping.fields) {
    lines.push(`  ${f.target.padEnd(width)}  ${f.basis.padEnd(8)}  ${f.value}   ← ${f.source}`);
  }
  if (mapping.unmapped.length > 0) {
    lines.push('not carried into the instruction:');
    for (const u of mapping.unmapped) lines.push(`  ${u.source} = ${u.value} — ${u.why}`);
  }
  if (mapping.issues.length > 0) {
    lines.push(`cannot be sent yet — ${mapping.issues.length} thing(s) missing:`);
    for (const i of mapping.issues) lines.push(`  ${i.target}: ${i.problem}\n    where: ${i.source}\n    fix:   ${i.fix}`);
  } else {
    lines.push('ready to send.');
  }
  return lines;
}

export class FolderAdapter {
  private readonly o: AdapterOptions;
  private readonly stateFile: string;
  private state: AdapterState;
  private readonly log: (line: string) => void;
  /** Size and time of each inbox file at the previous look. */
  private seen = new Map<string, string>();
  /** What was last said about a file that could not be handled, so it is said once. */
  private readonly complaints = new Map<string, string>();
  /** When each payment that waits on a person was last looked at. */
  private readonly looked = new Map<string, number>();
  private lockFile: string | null = null;

  constructor(o: AdapterOptions) {
    this.o = o;
    this.log = o.log ?? ((line) => console.log(line));
    for (const dir of [o.inbox, path.join(o.inbox, 'processed'), path.join(o.inbox, 'failed'), o.outbox]) {
      mkdirSync(dir, { recursive: true });
    }
    this.stateFile = path.join(o.outbox, '.adapter-state.json');
    this.takeLock();
    this.state = this.loadState();
  }

  private save(): void { writeJson(this.stateFile, this.state); }

  /**
   * One adapter per outbox. Two would race for the same inbox files and
   * write over each other's state; the second one is refused while the
   * first is alive, and takes over when it is not.
   */
  private takeLock(): void {
    const file = path.join(this.o.outbox, '.adapter.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
        this.lockFile = file;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(readFileSync(file, 'utf8').trim());
        if (pid === process.pid) { this.lockFile = file; return; }
        let alive = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === 'EPERM'; }
        }
        if (alive) {
          throw new Error(`another adapter (process ${pid}) is already working on ${this.o.outbox} — `
            + 'two would race for the same files. Stop it first, or give this one its own inbox and outbox');
        }
        unlinkSync(file); // left behind by a process that is gone
      }
    }
    throw new Error(`could not take the lock ${file}`);
  }

  /** Release the outbox. The adapter can be constructed again afterwards. */
  close(): void {
    if (!this.lockFile) return;
    try { unlinkSync(this.lockFile); } catch { /* already gone */ }
    this.lockFile = null;
  }

  /**
   * What is being followed. A state file that cannot be read is set aside,
   * not fatal: every payment this outbox has an accepted file for is
   * followed again, which rewrites the reports it already has and misses
   * nothing.
   */
  private loadState(): AdapterState {
    if (!existsSync(this.stateFile)) return { open: {} };
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as AdapterState | null;
      if (raw && typeof raw === 'object' && raw.open && typeof raw.open === 'object' && !Array.isArray(raw.open)) return raw;
    } catch { /* unreadable — rebuilt below */ }
    const aside = `${this.stateFile}.damaged-${Date.now()}`;
    renameSync(this.stateFile, aside);
    const open: Record<string, Open> = {};
    for (const name of readdirSync(this.o.outbox)) {
      if (!name.endsWith('.accepted.json')) continue;
      try {
        const a = JSON.parse(readFileSync(path.join(this.o.outbox, name), 'utf8')) as { payment_id?: unknown; file?: unknown } | null;
        if (a && typeof a.payment_id === 'string') {
          open[a.payment_id] = { ref: name.slice(0, -'.accepted.json'.length), file: typeof a.file === 'string' ? a.file : name, code: '', seq: -1, evidence: false };
        }
      } catch { /* not one of ours */ }
    }
    this.log(`! ${path.basename(this.stateFile)} could not be read and was set aside as ${path.basename(aside)} — `
      + `following ${Object.keys(open).length} payment(s) again from the accepted files in the outbox`);
    return { open };
  }

  /** Every message or decision file in the inbox, finished or not. */
  private pending(): string[] {
    return readdirSync(this.o.inbox, { withFileTypes: true })
      // A link to a message is a message too; whether it points at a file is seen when it is read.
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.')
        && !/(\.tmp|\.part|\.partial|\.filepart|\.crdownload|~)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  /**
   * The files that have stopped changing: left alone for `settleMs`, and —
   * if seen before — the same size and time as at the previous look.
   */
  private waiting(): string[] {
    const now = Date.now();
    const settle = this.o.settleMs ?? 2_000;
    const next = new Map<string, string>();
    const ready: string[] = [];
    for (const name of this.pending()) {
      let st;
      try { st = statSync(path.join(this.o.inbox, name)); } catch { continue; } // renamed away meanwhile, or a link to nothing
      if (!st.isFile()) continue;
      const mark = `${st.size}/${st.mtimeMs}`;
      next.set(name, mark);
      const before = this.seen.get(name);
      if (now - st.mtimeMs > settle && (before === undefined || before === mark)) ready.push(name);
    }
    this.seen = next;
    return ready;
  }

  private move(name: string, to: 'processed' | 'failed'): void {
    const target = path.join(this.o.inbox, to, name);
    renameSync(path.join(this.o.inbox, name),
      existsSync(target) ? path.join(this.o.inbox, to, `${Date.now()}-${name}`) : target);
  }

  private fail(name: string, error: Record<string, unknown>): void {
    writeJson(path.join(this.o.outbox, `${safeName(name)}.error.json`), { file: name, at: new Date().toISOString(), ...error });
    this.move(name, 'failed');
    this.log(`✗ ${name}: ${String(error.message ?? error.error)}`);
  }

  /** One SWIFT message file → one settlement per transaction in it. */
  private async takeMessage(name: string): Promise<void> {
    const size = statSync(path.join(this.o.inbox, name)).size;
    if (size > MAX_FILE_BYTES) {
      this.fail(name, { error: 'malformed_message', message: `the file is ${size} bytes — larger than ${MAX_FILE_BYTES}, and no payment message is that large; split it` });
      return;
    }
    const bytes = readFileSync(path.join(this.o.inbox, name));
    // Parsed once: each payment is then handed over as parsed, however many the file holds.
    let payments: SwiftPayment[];
    try {
      payments = parseSwiftMessages(bytes);
    } catch (e) {
      if (e instanceof SwiftMessageError) {
        this.fail(name, { error: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) });
        return;
      }
      throw e;
    }
    const count = payments.length;
    const supplement = supplementFrom(this.o.parties);
    // Every transaction is attempted. One that cannot be sent does not keep
    // the ones after it from going out, and the report names each of them.
    const failures: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const which = count > 1 ? { transaction: index + 1 } : {};
      try {
        const done = await this.o.client.submitSwift(payments[index]!, {
          ...(supplement ? { supplement } : {}),
          ...(this.o.review ? { review: this.o.review } : {}),
          ...(this.o.travelRule ? { travelRule: this.o.travelRule } : {}),
        });
        const src = done.mapping.input!.source;
        const open = this.state.open[done.paymentId];
        // The bank's reference first, then the payment id: the reference alone may name two payments.
        const ref = open?.ref ?? `${safeName(src.instructionId ?? src.messageId ?? 'payment')}.${safeName(done.paymentId)}`;
        writeJson(path.join(this.o.outbox, `${ref}.accepted.json`), {
          payment_id: done.paymentId,
          state: done.state,
          already_submitted: done.already,
          file: name,
          ...which,
          source: src,
          mapping: { fields: done.mapping.fields, not_carried: done.mapping.unmapped },
          accepted_at: new Date().toISOString(),
        });
        if (!open) this.state.open[done.paymentId] = { ref, file: name, code: '', seq: -1, evidence: false };
        this.save();
        this.log(`✓ ${name}${count > 1 ? ` [${index + 1}/${count}]` : ''} → ${done.paymentId} (${done.already ? 'already submitted, ' : ''}${done.state})`);
      } catch (e) {
        if (e instanceof SwiftMappingError) {
          failures.push({ ...which, error: 'message_incomplete', message: e.message, missing: e.issues });
          continue;
        }
        if (e instanceof RemitApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
          failures.push({ ...which, error: e.code, message: e.message, status: e.status });
          continue;
        }
        // The platform could not be reached, or said "later": leave the file where it is.
        // What was sent already is recognised when the file is taken again.
        this.log(`… ${name}: ${e instanceof Error ? e.message : String(e)} — will retry`);
        return;
      }
    }
    if (failures.length > 0) {
      this.fail(name, count === 1 ? failures[0]! : {
        error: 'transactions_failed',
        message: `${failures.length} of the ${count} transactions in this file could not be sent; the other ${count - failures.length} were`,
        transactions: count, sent: count - failures.length, failures,
      });
      return;
    }
    this.move(name, 'processed');
  }

  /** `<x>.rfi.json` and `<x>.cancel.json`: the two decisions that are the bank's. */
  private async takeDecision(name: string): Promise<void> {
    let body: { payment_id?: string; answers?: Record<string, string>; reason?: string };
    try {
      const parsed = JSON.parse(readFileSync(path.join(this.o.inbox, name), 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('not an object');
      body = parsed as typeof body;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e; // could not be read at all: left where it is
      this.fail(name, { error: 'invalid_json', message: 'the file is not a JSON object' });
      return;
    }
    if (typeof body.payment_id !== 'string' || !body.payment_id) {
      this.fail(name, { error: 'missing_field', message: 'payment_id is required' });
      return;
    }
    try {
      if (name.endsWith('.rfi.json')) {
        if (!body.answers || Object.keys(body.answers).length === 0) {
          this.fail(name, { error: 'missing_field', message: 'answers is required: { "answers": { "<question key>": "<answer>" } }' });
          return;
        }
        await this.o.client.answerRfi(body.payment_id, body.answers);
        this.looked.delete(body.payment_id); // it moves again: look at it on the next pass
        this.log(`✓ ${name}: answer sent for ${body.payment_id}`);
      } else {
        await this.o.client.cancel(body.payment_id, body.reason ?? 'cancelled by the bank');
        this.log(`✓ ${name}: cancellation sent for ${body.payment_id}`);
      }
      this.move(name, 'processed');
    } catch (e) {
      if (e instanceof RemitApiError && e.status === 409) {
        // The platform may have taken an earlier attempt whose answer was lost
        // on the way back. Look before calling it a failure.
        const view = await this.o.client.find(body.payment_id).catch(() => null);
        const settled = name.endsWith('.rfi.json')
          ? !!view && (view.state !== 'TRAVEL_RULE_PENDING' || !travelRuleQuestionOpen(view.events))
          : view?.state === 'CANCELLED';
        if (settled) {
          this.log(`✓ ${name}: ${name.endsWith('.rfi.json') ? 'no answer is waited for any more' : 'already cancelled'} — ${body.payment_id}`);
          this.move(name, 'processed');
          return;
        }
      }
      if (e instanceof RemitApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        this.fail(name, { error: e.code, message: e.message, status: e.status });
        return;
      }
      this.log(`… ${name}: ${e instanceof Error ? e.message : String(e)} — will retry`);
    }
  }

  /** Follow one open settlement: report a change, and close it when it is over. */
  private async follow(paymentId: string, open: Open): Promise<void> {
    // A payment that waits on a person does not change from one pass to the next.
    const parked = open.code.startsWith('PDNG/RFI') || open.code.startsWith('PDNG/EXCEPTION');
    const now = Date.now();
    if (parked && now - (this.looked.get(paymentId) ?? 0) < PARKED_POLL_MS) return;
    this.looked.set(paymentId, now);

    let view: SettlementView;
    try {
      view = await this.o.client.status(paymentId);
    } catch (e) {
      this.log(`… ${paymentId}: ${e instanceof Error ? e.message : String(e)} — will retry`);
      return;
    }
    const status = swiftStatusOf(view);
    const seq = view.events.length > 0 ? view.events[view.events.length - 1]!.seq : 0;
    const signature = `${status.code}/${status.reason ?? ''}`;
    if (signature !== open.code) {
      const stamp = String(seq).padStart(2, '0');
      writeText(path.join(this.o.outbox, `${open.ref}.status-${stamp}-${status.code}.xml`), buildPacs002(view));
      writeJson(path.join(this.o.outbox, `${open.ref}.status.json`), {
        payment_id: paymentId, state: view.state,
        swift_status: status.code, meaning: status.meaning,
        ...(status.reason ? { reason: status.reason } : {}),
        detail: status.detail, final: status.final,
        ...(status.needs ? { needs: status.needs } : {}),
        ...(status.creditReference ? { credit_reference: status.creditReference } : {}),
        updated_at: new Date().toISOString(),
      });
      open.code = signature;
      open.seq = seq;
      open.since = new Date().toISOString();
      this.save();
      this.log(`  ${paymentId} → ${status.code}${status.reason ? ` (${status.reason})` : ''}${status.creditReference ? ` · ${status.creditReference}` : ''}`);
    }
    if (view.state === 'EVIDENCE_ANCHORED' && !open.evidence) {
      try {
        const evidence = await this.o.client.evidence(paymentId);
        const report = await verifyEvidencePackage(evidence);
        writeJson(path.join(this.o.outbox, `${open.ref}.evidence.json`), evidence);
        writeJson(path.join(this.o.outbox, `${open.ref}.verification.json`), report);
        open.evidence = true;
        this.log(`  ${paymentId} evidence saved — re-verified ${report.checks.filter((c) => c.ok).length}/${report.checks.length}`);
      } catch (e) {
        this.log(`… ${paymentId}: evidence not ready (${e instanceof Error ? e.message : String(e)}) — will retry`);
        return;
      }
    }
    const over = CLOSED.has(view.state) && (view.state !== 'EVIDENCE_ANCHORED' || open.evidence);
    // Stopped for manual resolution, and nothing has changed for a day: the
    // report already says no status follows by itself. It is left to `status`.
    const abandoned = view.state === 'EXCEPTION' && !!open.since && now - Date.parse(open.since) > STOPPED_FOLLOW_MS;
    if (over || abandoned) {
      if (abandoned) this.log(`  ${paymentId} is still stopped after a day — no longer followed here; \`status ${paymentId}\` reads it at any time`);
      delete this.state.open[paymentId];
      this.looked.delete(paymentId);
      this.save();
    }
  }

  /** One pass: take what is in the inbox, then follow what is open. Returns how many are still open. */
  async tick(): Promise<number> {
    const waiting = this.waiting();
    for (const name of waiting) {
      try {
        if (name.endsWith('.rfi.json') || name.endsWith('.cancel.json')) await this.takeDecision(name);
        else await this.takeMessage(name);
        this.complaints.delete(name);
      } catch (e) {
        // A file that cannot be handled — unreadable, moved away by someone
        // else — must not stop the files behind it. It stays where it is and
        // is tried again; what is wrong with it is said once.
        const why = e instanceof Error ? e.message : String(e);
        if (this.complaints.get(name) !== why) {
          this.complaints.set(name, why);
          this.log(`✗ ${name}: ${why} — left in the inbox and tried again on every pass`);
        }
      }
    }
    for (const name of [...this.complaints.keys()]) if (!waiting.includes(name)) this.complaints.delete(name);
    for (const [paymentId, open] of Object.entries(this.state.open)) {
      try {
        await this.follow(paymentId, open);
      } catch (e) {
        this.log(`… ${paymentId}: ${e instanceof Error ? e.message : String(e)} — will retry`);
      }
    }
    return Object.keys(this.state.open).length;
  }

  /**
   * Run until stopped. With `once`, run until the inbox is empty and every
   * settlement has either finished or paused for the bank (an open question,
   * a withheld confirmation) — or `timeoutMs` passes.
   */
  async run(opts: { pollMs?: number; once?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const pollMs = opts.pollMs ?? 3_000;
    const t0 = Date.now();
    let quiet = 0;
    try {
      while (!opts.signal?.aborted) {
        const before = JSON.stringify(this.state.open);
        const open = await this.tick();
        if (opts.once) {
          const changed = JSON.stringify(this.state.open) !== before;
          quiet = changed ? 0 : quiet + 1;
          // Done when nothing is open, or nothing has moved for a while (paused for the bank).
          if (this.pending().length === 0 && (open === 0 || quiet >= 10)) return;
          if (Date.now() - t0 > (opts.timeoutMs ?? 300_000)) return;
        }
        await new Promise((ok) => setTimeout(ok, pollMs));
      }
    } finally {
      this.close();
    }
  }
}
