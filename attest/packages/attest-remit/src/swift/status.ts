/**
 * The way back: a settlement's state, said in the vocabulary the bank's
 * payment systems already consume.
 *
 * `swiftStatusOf` turns a settlement view into an ISO 20022 transaction
 * status code; `buildPacs002` writes it as a `pacs.002` status report
 * (FIToFIPaymentStatusReport) that points at the bank's original message by
 * its own identifiers — message id, instruction id, end-to-end id, UETR.
 *
 * The codes are the ISO 20022 ones. The reasons are this platform's own
 * event names, carried as proprietary reasons, because an invented mapping
 * onto standard reason codes would claim more than is known: `RFI` is not a
 * code the standard has, and saying so is more useful than a near miss.
 *
 * Everything is derived from the settlement view alone — the references sit
 * in the bank-signed instruction the platform stores — so a status report
 * can be produced by a process that never saw the original message.
 */
import { xmlEscape } from './xml.ts';
import type { SourceMessageRef } from './mapping.ts';

/**
 * The fields of a settlement view this module reads. The view is read as
 * any JSON may be: a value of another kind than the one named here is read
 * as absent, and a status is still given.
 */
export interface StatusView {
  payment_id: string;
  state: string;
  events: { seq: number; type: string; issuer: string; at: string; payload: unknown }[];
}

/**
 * The interbank status codes. `CANC` is deliberately not among them: the
 * standard's code list keeps it for API contexts, and a payment hub reads a
 * `pacs.002` by the interbank codes — a payment withdrawn at the bank's
 * request is reported `RJCT` with the reason `CANCELLED_BY_BANK`.
 */
export type SwiftStatusCode = 'ACTC' | 'ACSP' | 'ACCC' | 'PDNG' | 'RJCT';

export interface SwiftStatus {
  /** ISO 20022 transaction status. */
  code: SwiftStatusCode;
  /** What the code means, in the standard's words. */
  meaning: string;
  /** The platform state it was derived from. */
  state: string;
  /** The platform's reason word, when the status needs one. */
  reason?: string;
  /** Detail for a person: questions asked, the refusal, the return. */
  detail: string[];
  /** The outcome is settled: paid, cancelled, refused or returned. */
  final: boolean;
  /**
   * Who has to act before the payment moves again, when it will not move by
   * itself: `bank_answer` — the receiving institution asked a question;
   * `manual_resolution` — processing stopped, the platform will send no
   * further status on its own, and a person resolves it.
   */
  needs?: 'bank_answer' | 'manual_resolution';
  /** The beneficiary bank's own credit reference, once the payout is confirmed. */
  creditReference?: string;
  /**
   * Time of the event the status reflects — absent when that event is not
   * there or carries no time in the platform's form. Never another event's.
   */
  at?: string;
  /** When the platform accepted the instruction. */
  acceptedAt?: string;
}

const MEANING: Record<SwiftStatusCode, string> = {
  ACTC: 'AcceptedTechnicalValidation — the instruction was authenticated and validated',
  ACSP: 'AcceptedSettlementInProcess — accepted, settlement is under way',
  ACCC: 'AcceptedCreditSettlementCompleted — the creditor\'s account has been credited',
  PDNG: 'Pending — further checks or information are outstanding',
  RJCT: 'Rejected — the payment did not go through',
};

type JsonObject = Record<string, unknown>;
/** A JSON object: not null, not a list, not text. */
const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * A field the object carries itself. Anything else — a value that is not an
 * object, a name only inherited from Object.prototype — reads as absent:
 * nothing is called on a value from the view before its type is known.
 */
const field = (o: unknown, name: string): unknown => (isObject(o) && Object.hasOwn(o, name) ? o[name] : undefined);
/** What an event's payload says under `name`. */
const said = (e: unknown, name: string): unknown => field(field(e, 'payload'), name);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The view's events. A list that is not a list is no events; an entry that is not an object is an event of no type. */
const eventsOf = (view: unknown): unknown[] => { const e = field(view, 'events'); return Array.isArray(e) ? e : []; };
const typeOf = (e: unknown): string => text(field(e, 'type'));

/**
 * The form the platform writes a time in: `2026-11-17T09:30:00.000Z`, or with
 * an offset instead of `Z`. A time in any other form — "yesterday", a number,
 * a date alone, a time without a zone, a day the calendar does not have — is
 * no time: the report's date-time elements are left out rather than written
 * with a value the schema refuses or a reader could take two ways.
 */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function isoTime(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = ISO_TIME.exec(v);
  if (!m) return undefined;
  const n = (i: number): number => Number(m[i] ?? 0);
  const leap = n(1) % 4 === 0 && (n(1) % 100 !== 0 || n(1) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][n(2) - 1] ?? 0;
  const fits = n(1) >= 1 && n(3) >= 1 && n(3) <= days && n(4) <= 23 && n(5) <= 59 && n(6) <= 59
    && n(8) <= 59 && n(7) * 60 + n(8) <= 14 * 60;
  return fits ? v : undefined;
}
const timeOf = (e: unknown): string | undefined => isoTime(field(e, 'at'));

/**
 * The events after which a question of the beneficiary institution is no
 * longer open: the bank's answer delivered (`TRAVEL_RULE_RFI_RESOLVED`), the
 * institution's acceptance (`TRAVEL_RULE_RECEIVED`) or its refusal
 * (`TRAVEL_RULE_REJECTED`). A question asked after the last of them is open.
 */
const TRAVEL_RULE_ANSWERED = ['TRAVEL_RULE_RFI_RESOLVED', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_REJECTED'];

/** The table a bank maps onto its own status codes. One row per situation. */
export const SWIFT_STATUS_TABLE: { state: string; when: string; code: SwiftStatusCode; reason: string }[] = [
  { state: 'BANK_AUTHORIZED', when: 'instruction accepted, signatures verified', code: 'ACTC', reason: '' },
  { state: 'TRAVEL_RULE_PENDING', when: 'waiting for the beneficiary institution', code: 'PDNG', reason: 'TRAVEL_RULE_PENDING' },
  { state: 'TRAVEL_RULE_PENDING', when: 'the beneficiary institution asked a question', code: 'PDNG', reason: 'RFI' },
  { state: 'PAYOUT_PRE_APPROVED', when: 'the beneficiary institution approved the payout', code: 'ACSP', reason: 'PAYOUT_PRE_APPROVED' },
  { state: 'ONCHAIN_SETTLED', when: 'the settlement transfer is confirmed', code: 'ACSP', reason: 'ONCHAIN_SETTLED' },
  { state: 'PAYOUT_IN_PROGRESS', when: 'local payout under way', code: 'ACSP', reason: 'PAYOUT_IN_PROGRESS' },
  { state: 'PAYOUT_IN_PROGRESS', when: 'payout reported without signed proof', code: 'PDNG', reason: 'EVIDENCE_INSUFFICIENT' },
  { state: 'PAYOUT_IN_PROGRESS', when: 'local payout failed, the funds are on their way back', code: 'PDNG', reason: 'PAYOUT_FAILED' },
  { state: 'BENEFICIARY_CREDIT_CONFIRMED', when: 'credit confirmed by signed evidence', code: 'ACCC', reason: '' },
  { state: 'EVIDENCE_ANCHORED', when: 'credit confirmed and the evidence anchored', code: 'ACCC', reason: '' },
  { state: 'CANCELLED', when: 'cancelled at the bank\'s request', code: 'RJCT', reason: 'CANCELLED_BY_BANK' },
  { state: 'CANCELLED', when: 'refused by the beneficiary institution', code: 'RJCT', reason: 'TRAVEL_RULE_REJECTED' },
  { state: 'RETURNED', when: 'local payout failed and the funds came back', code: 'RJCT', reason: 'RETURNED' },
  { state: 'EXCEPTION', when: 'stopped for manual follow-up', code: 'PDNG', reason: 'EXCEPTION' },
];

/** The ISO 20022 status of a settlement, from its view. */
export function swiftStatusOf(view: StatusView): SwiftStatus {
  const events = eventsOf(view);
  const given = field(view, 'state');
  // A state that is not text is a state the table does not know.
  const state = typeof given === 'string' ? given : 'UNKNOWN';
  const lastAt = (type: string): number => {
    for (let i = events.length - 1; i >= 0; i--) if (typeOf(events[i]) === type) return i;
    return -1;
  };
  const last = (type: string): unknown => { const i = lastAt(type); return i === -1 ? undefined : events[i]; };
  const accepted = timeOf(events.find((e) => typeOf(e) === 'REQUEST_ACCEPTED') ?? events[0]);
  // A status that no single event explains takes the time of the latest one.
  const latest = timeOf(events[events.length - 1]);
  // Every status names the time it reflects: an event's own, or none — a
  // missing time is never filled in with another event's.
  const make = (code: SwiftStatusCode, reason: string, detail: string[], final: boolean, at: string | undefined): SwiftStatus => ({
    code, meaning: MEANING[code], state,
    ...(reason ? { reason } : {}), detail, final,
    ...(at ? { at } : {}),
    ...(accepted ? { acceptedAt: accepted } : {}),
  });

  switch (state) {
    case 'REQUEST_ACCEPTED':
    case 'BANK_AUTHORIZED':
      return make('ACTC', '', [], false, latest);
    case 'TRAVEL_RULE_PENDING': {
      // A question is open when it was asked after the last answer, acceptance
      // or refusal — a second question after an answered first one is open too.
      const asked = lastAt('TRAVEL_RULE_RFI');
      if (asked > Math.max(...TRAVEL_RULE_ANSWERED.map(lastAt))) {
        const rfi = events[asked];
        const questions = said(rfi, 'questions');
        // A question is given in words when it is text, a number or true/false; anything else is not guessed at.
        const words = Array.isArray(questions)
          ? questions.filter((q) => typeof q === 'string' || typeof q === 'number' || typeof q === 'boolean').map(String)
          : [];
        return { ...make('PDNG', 'RFI', words, false, timeOf(rfi)), needs: 'bank_answer' };
      }
      return make('PDNG', 'TRAVEL_RULE_PENDING', [], false, latest);
    }
    case 'PAYOUT_PRE_APPROVED':
      return make('ACSP', 'PAYOUT_PRE_APPROVED', [], false, latest);
    case 'ONCHAIN_SETTLED':
      return make('ACSP', 'ONCHAIN_SETTLED', [], false, latest);
    case 'PAYOUT_IN_PROGRESS': {
      // The payout failed and the return has not arrived yet: no longer "in process".
      const failed = last('PAYOUT_FAILED');
      if (failed) {
        return make('PDNG', 'PAYOUT_FAILED',
          ['The local payout failed; the settlement funds are being returned.', text(said(failed, 'reason'))].filter(Boolean), false, timeOf(failed));
      }
      const held = last('EVIDENCE_INSUFFICIENT');
      if (held) {
        return make('PDNG', 'EVIDENCE_INSUFFICIENT',
          ['The payout was reported without signed proof of credit; confirmation is withheld until it arrives.'], false, timeOf(held));
      }
      return make('ACSP', 'PAYOUT_IN_PROGRESS', [], false, latest);
    }
    case 'BENEFICIARY_CREDIT_CONFIRMED':
    case 'EVIDENCE_ANCHORED': {
      // The time of the credit is the payout's own: without a payout event, no time.
      const done = last('PAYOUT_COMPLETED');
      const ref = text(said(done, 'bank_reference'));
      const s = make('ACCC', '', [], true, timeOf(done));
      if (ref) s.creditReference = ref;
      return s;
    }
    case 'CANCELLED': {
      const refused = last('TRAVEL_RULE_REJECTED');
      if (refused) return make('RJCT', 'TRAVEL_RULE_REJECTED', [text(said(refused, 'reason'))].filter(Boolean), true, timeOf(refused));
      const asked = last('CANCEL_REQUESTED');
      return make('RJCT', 'CANCELLED_BY_BANK', [text(said(asked, 'reason'))].filter(Boolean), true, timeOf(asked));
    }
    case 'RETURNED': {
      const failed = last('PAYOUT_FAILED');
      const back = last('USDC_RETURNED');
      const detail = [text(said(failed, 'reason'))];
      const tx = text(said(back, 'tx_hash'));
      if (tx) detail.push(`Settlement funds returned in transaction ${tx}.`);
      return make('RJCT', 'RETURNED', detail.filter(Boolean), true, timeOf(back ?? failed));
    }
    case 'EXCEPTION': {
      const ex = last('EXCEPTION');
      // Its outcome is not settled, and nothing moves it on by itself: the
      // platform sends no further status of its own. The report says so in
      // words, because `PDNG` alone reads as "an update will follow".
      return { ...make('PDNG', 'EXCEPTION',
        ['Processing stopped. No further status follows automatically; the payment is resolved by a person.',
          text(said(ex, 'error'))].filter(Boolean), false, timeOf(ex)), needs: 'manual_resolution' };
    }
    default:
      // One value, here and in the report's `Prtry` (Max35Text): the state's name, tidied once.
      return make('PDNG', max(state, 35), [], false, latest);
  }
}

/** The reference to the bank's message that the bank signed into its instruction, if any. */
export function sourceMessageOf(view: StatusView): SourceMessageRef | undefined {
  const submitted = eventsOf(view).find((e) => typeOf(e) === 'BANK_EVIDENCE_SUBMITTED');
  const ref = field(said(submitted, 'bankInstruction'), 'sourceMessage');
  const type = field(ref, 'type');
  const sha256 = field(ref, 'sha256');
  if (typeof type !== 'string' || typeof sha256 !== 'string') return undefined;
  const out: SourceMessageRef = { type, sha256 };
  const index = field(ref, 'index');
  if (typeof index === 'number') out.index = index;
  for (const k of ['messageId', 'instructionId', 'paymentInfoId', 'endToEndId', 'uetr', 'valueDate', 'content'] as const) {
    const val = field(ref, k);
    if (typeof val === 'string' && val) out[k] = val;
  }
  return out;
}

/**
 * Text from another system, made fit for the report before anything is
 * measured: characters XML does not allow are removed first, so that a value
 * made only of them is seen to be empty — and left out — instead of being
 * written as an element the schema refuses. Half of a surrogate pair is one
 * of them, and goes before the rest: two halves that stood apart are never
 * joined into a character the text did not have.
 */
// eslint-disable-next-line no-control-regex
const tidy = (s: string): string => s.replace(/\p{Cs}/gu, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/\s+/g, ' ').trim();
/**
 * The first `n` characters of `s`, counted by code point as the schema counts
 * a length: a surrogate pair is never cut in two. `s` itself when it fits.
 */
function firstCodePoints(s: string, n: number): string {
  let units = 0;
  let count = 0;
  for (const ch of s) {
    if (count++ === n) return s.slice(0, units);
    units += ch.length;
  }
  return s;
}
/** Tidy, cut to `n` characters, and tidy still: a cut that ends on a space does not keep it. */
const max = (s: string, n: number): string => firstCodePoints(tidy(s), n).trimEnd();

/**
 * Split text into chunks that fit `AddtlInf` (Max105Text), breaking at spaces
 * where it can. Counted by code point, like every length in the report.
 */
function chunks105(s: string): string[] {
  const out: string[] = [];
  let rest = tidy(s);
  for (;;) {
    // Look at the first 106 characters: where the 106th starts, and the last
    // space among the 61st to the 106th — a break earlier than that wastes the line.
    let units = 0;
    let count = 0;
    let space = -1;
    for (const ch of rest) {
      if (ch === ' ' && count >= 60) space = units;
      if (count === 105) break;
      units += ch.length;
      count++;
    }
    if (units === rest.length) break;
    const cut = space === -1 ? units : space;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface Pacs002Options {
  /** Override the report's own message id (Max35Text). */
  messageId?: string;
  /** Override the creation time — for reproducible output. */
  createdAt?: string;
}

/**
 * A `pacs.002.001.10` status report for one settlement.
 *
 * `OrgnlGrpInf`, `OrgnlInstrId`, `OrgnlEndToEndId` and `OrgnlUETR` are filled
 * from the reference the bank signed into its instruction; a settlement that
 * did not come from a SWIFT message gets a report without them. A UETR the
 * schema's pattern does not take is given in words, under `AddtlInf`.
 *
 * Any view gives a report. A value of the wrong kind is read as absent, and
 * an element whose value is empty once cleaned, or not in the form the schema
 * asks for, is left out: never written empty, never written wrong.
 */
export function buildPacs002(view: StatusView, opts: Pacs002Options = {}): string {
  const status = swiftStatusOf(view);
  const src = sourceMessageOf(view);
  const events = eventsOf(view);
  // The report is named after the payment and its latest event. A number that
  // is not a whole number from 0 counts as 0: an id never reads "undefined".
  const lastSeq = field(events[events.length - 1], 'seq');
  const seq = typeof lastSeq === 'number' && Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0;
  const paymentId = tidy(text(field(view, 'payment_id')));
  const idBase = `${paymentId}-${seq}`;
  // Where the two do not fit in 35 characters, the payment id is cut and the number kept whole.
  const derived = !paymentId ? '' : firstCodePoints(idBase, 35) === idBase ? idBase
    : `${max(paymentId, Math.min(28, 34 - String(seq).length))}-${seq}`;
  const messageId = max(typeof opts?.messageId === 'string' ? opts.messageId : derived, 35) || `STATUS-${seq}`;
  // CreDtTm cannot be left out: a given time not in the ISO 8601 form is not
  // used, and the report states when it was made.
  const createdAt = isoTime(opts?.createdAt) ?? new Date().toISOString();
  const e = xmlEscape;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">',
    '  <FIToFIPmtStsRpt>',
    '    <GrpHdr>',
    `      <MsgId>${e(messageId)}</MsgId>`,
    `      <CreDtTm>${e(createdAt)}</CreDtTm>`,
    '    </GrpHdr>',
    '    <TxInfAndSts>',
  ];
  // An identifier that is empty once cleaned is left out, never written empty.
  const identifier = (name: string, value: string | undefined, indent = '      '): void => {
    const v = value ? max(value, 35) : '';
    if (v) lines.push(`${indent}<${name}>${e(v)}</${name}>`);
  };
  identifier('StsId', paymentId);
  // The group is written with both of its elements or not at all: the schema
  // requires the message's name beside its id.
  const groupId = src?.messageId ? max(src.messageId, 35) : '';
  const groupName = src ? max(src.type, 35) : '';
  if (groupId && groupName) {
    lines.push('      <OrgnlGrpInf>');
    identifier('OrgnlMsgId', groupId, '        ');
    identifier('OrgnlMsgNmId', groupName, '        ');
    lines.push('      </OrgnlGrpInf>');
  }
  identifier('OrgnlInstrId', src?.instructionId);
  identifier('OrgnlEndToEndId', src?.endToEndId);
  // The schema takes a UETR only as a lower-case version-4 UUID. One it does
  // not take — another version, capitals — is given in words, never dropped.
  const uetr = src?.uetr ? tidy(src.uetr) : '';
  const uetrFits = UUID_V4.test(uetr);
  if (uetrFits) lines.push(`      <OrgnlUETR>${e(uetr)}</OrgnlUETR>`);
  lines.push(`      <TxSts>${status.code}</TxSts>`);
  // A credit reference too long for its own element is given in words rather than cut short.
  const reference = status.creditReference ? tidy(status.creditReference) : '';
  const referenceFits = firstCodePoints(reference, 35) === reference;
  const detail = [
    ...status.detail,
    ...(uetr && !uetrFits ? [`UETR ${uetr}`] : []),
    ...(reference && !referenceFits ? [`Credit reference ${reference}`] : []),
  ].flatMap(chunks105);
  // The status's own reason, tidied once where it was made: the report and the status say the same word.
  const reason = status.reason ?? '';
  if (reason || detail.length > 0) {
    lines.push('      <StsRsnInf>');
    if (reason) lines.push(`        <Rsn><Prtry>${e(reason)}</Prtry></Rsn>`);
    for (const d of detail) lines.push(`        <AddtlInf>${e(d)}</AddtlInf>`);
    lines.push('      </StsRsnInf>');
  }
  // The acceptance time is when the instruction was accepted — whatever the
  // status now is. The time of the credit goes where the schema puts it.
  if (status.acceptedAt) lines.push(`      <AccptncDtTm>${e(status.acceptedAt)}</AccptncDtTm>`);
  if (status.code === 'ACCC' && status.at) {
    lines.push('      <FctvIntrBkSttlmDt>', `        <DtTm>${e(status.at)}</DtTm>`, '      </FctvIntrBkSttlmDt>');
  }
  if (reference && referenceFits) lines.push(`      <AcctSvcrRef>${e(reference)}</AcctSvcrRef>`);
  lines.push('    </TxInfAndSts>', '  </FIToFIPmtStsRpt>', '</Document>', '');
  return lines.join('\n');
}
