/**
 * FIN MT103 (single customer credit transfer) → `SwiftPayment`.
 *
 * Accepts the message as systems actually hand it over: the full five-block
 * form (`{1:…}{2:…}{3:…}{4:` … `-}{5:…}`), CRLF or LF, or the text block alone
 * (the lines from `:20:` on) when an exporter strips the headers. A file may
 * hold several messages one after another, as a batch export writes them
 * (optionally separated by `$`); each is read.
 *
 * What makes a text an MT103 is checked, not assumed. With the header blocks,
 * block 2 names the type. Without them nothing does, so the text itself has
 * to be one: only fields an MT103 carries, each as often as an MT103 allows,
 * and every mandatory one present. An MT102 or the cover of an MT103 (MT202
 * COV) shares most of its tags with an MT103; read as one, it would become a
 * payment of the wrong amount to the wrong party.
 *
 * A field that is read has to carry a value: present but empty, or with a
 * second line under a field the standard writes on one, it refuses the
 * message — it is not read as absent, nor cut to its first line.
 *
 * What is read, by field:
 *   block 1 / 2   sender and receiver BIC, and that the type is 103
 *   block 3       121 → UETR
 *   20            sender's reference
 *   23B           bank operation code, kept — `CRTS` marks a test message
 *   71F / 71G     sender's and receiver's charges, kept as given
 *   32A           value date, currency, interbank settled amount
 *   33B           instructed currency and amount
 *   36            exchange rate
 *   50A / 50F / 50K   ordering customer
 *   52A / 52D     ordering institution
 *   56A / 56D     intermediary institution
 *   57A / 57C / 57D   account with institution
 *   59 / 59A / 59F    beneficiary customer
 *   70            remittance information (`/INV/` invoice references, `/ROC/` the
 *                 ordering customer's reference)
 *   71A           details of charges → ISO charge bearer
 *   26T / 77B     transaction type and regulatory reporting, kept as given;
 *                 `/ORDERRES/CC` and `/BENEFRES/CC` in 77B give the parties'
 *                 countries of residence
 *
 * A free-format party (50K, 59) is "name and address" with no markers: the
 * first line is taken as the name and the rest as address lines. That is the
 * convention, not a guarantee — which is why the mapping layer accepts
 * corrections for it.
 */
import { invoiceTokens, REMITTANCE_CODES } from './iso20022.ts';
import { assertCurrency, normaliseAmount, uetrOf, SwiftMessageError } from './model.ts';
import type { SwiftAgent, SwiftParty, SwiftPayment } from './model.ts';

/** Does this text look like a FIN message (blocks, or a bare text block)? */
export function looksLikeMt(text: string): boolean {
  return /^﻿?\s*\{1:/.test(text) || /^﻿?\s*:20:/.test(text) || /^﻿?\s*\{4:\s*:20:/.test(text);
}

interface Blocks { b1?: string; b2?: string; b3?: string; b4: string }

const malformed = (message: string, field?: string): SwiftMessageError =>
  new SwiftMessageError('malformed_message', message, field);

/** A block whose content is balanced braces (1, 2, 3, 5, S): where it ends. */
function closeOf(text: string, open: number, id: string): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return j; }
  }
  throw malformed(`block ${id} is not closed`, `block ${id}`);
}

/** Trailer blocks that may follow the text block: `{5:…}`, `{S:…}`. */
const TRAILERS = /^(?:\s|\{[5S]:(?:[^{}]|\{[^{}]*\})*\})*/;

/** The text block alone, as an exporter that strips the headers writes it. */
function bareText(text: string): Blocks {
  // The text block may come inside its own wrapper and nothing else: `{4:` … `-}`.
  const lines = text.trim().replace(/^\{4:[ \t]*\n/, '').split('\n');
  // The end-of-text marker, when the exporter kept it. Nothing but trailer
  // blocks may follow: more text there is a second message, or a field cut off
  // from the first — either way not something to read past.
  const end = lines.findIndex((l) => l.startsWith('-}') || l === '-');
  if (end === -1) return { b4: lines.join('\n') };
  const rest = [lines[end]!.replace(/^-\}?/, ''), ...lines.slice(end + 1)].join('\n');
  if (rest.replace(TRAILERS, '').replace(/[\s$]/g, '') !== '') {
    throw malformed('there is text after the end-of-text marker ("-}") — a file of several messages needs each one\'s '
      + 'header blocks ({1:…}{2:…}), so that it is clear where one ends and what each is', 'block 4');
  }
  return { b4: lines.slice(0, end).join('\n') };
}

/**
 * Split a file into its FIN messages, and each message into its blocks —
 * without tripping on braces inside block 3, and without reading past the
 * end of one message into the next.
 */
function splitMessages(raw: string): Blocks[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^\s*\{1:/.test(text)) return [bareText(text)];

  const out: Blocks[] = [];
  const skip = (i: number, chars: RegExp): number => {
    let k = i;
    while (k < text.length && chars.test(text[k]!)) k++;
    return k;
  };
  let i = skip(0, /\s/);
  while (i < text.length) {
    const n = out.length + 1;
    if (!text.startsWith('{1:', i)) {
      throw malformed(`after message ${n - 1} there is text that is not another message: `
        + `"${text.slice(i, i + 24).replace(/\s+/g, ' ')}" — a message starts with {1:`, 'block 4');
    }
    const cur: Partial<Blocks> = {};
    for (const id of ['1', '2', '3'] as const) {
      i = skip(i, /\s/);
      if (!text.startsWith(`{${id}:`, i)) continue;
      const close = closeOf(text, i, id);
      cur[`b${id}`] = text.slice(i + 3, close);
      i = close + 1;
    }
    i = skip(i, /\s/);
    if (!text.startsWith('{4:', i)) {
      const m = /^\{([1-3]):/.exec(text.slice(i, i + 3));
      throw malformed(m ? `block ${m[1]} appears twice or out of order` : 'the message has no text block (block 4)',
        m ? `block ${m[1]}` : 'block 4');
    }
    const end = text.indexOf('\n-}', i);
    if (end === -1) {
      throw malformed('block 4 has no end-of-text marker ("-}") — the message is truncated', 'block 4');
    }
    cur.b4 = text.slice(i + 3, end).replace(/^\n/, '');
    i = end + 3;
    i += TRAILERS.exec(text.slice(i))![0].length;
    // A batch export separates messages with "$".
    i = skip(i, /[\s$]/);
    out.push(cur as Blocks);
  }
  return out;
}

/** Logical-terminal address (12 chars) → BIC, 8 or 11 characters. */
function bicFromLt(lt: string | undefined): string | undefined {
  if (!lt || lt.length < 12) return undefined;
  const bic8 = lt.slice(0, 8);
  const branch = lt.slice(9, 12);
  if (!/^[A-Z0-9]{8}$/.test(bic8)) return undefined;
  return branch === 'XXX' || !/^[A-Z0-9]{3}$/.test(branch) ? bic8 : `${bic8}${branch}`;
}

interface Field { tag: string; lines: string[] }

/** Every field an MT103 may carry. */
const MT103_TAGS = new Set([
  '20', '13C', '23B', '23E', '26T', '32A', '33B', '36', '50A', '50F', '50K', '51A', '52A', '52D',
  '53A', '53B', '53D', '54A', '54B', '54D', '55A', '55B', '55D', '56A', '56C', '56D',
  '57A', '57B', '57C', '57D', '59', '59A', '59F', '70', '71A', '71F', '71G', '72', '77B', '77T',
]);
/** The ones that may occur more than once. */
const REPEATABLE = new Set(['13C', '23E', '71F']);
/** Fields written with one of several letter options — one option, once. */
const OPTION_FIELDS = new Set(['50', '52', '53', '54', '55', '56', '57', '59']);

function fieldsOf(b4: string): Field[] {
  const fields: Field[] = [];
  for (const line of b4.split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) { fields.push({ tag: m[1]!, lines: [m[2]!] }); continue; }
    // A line of text never starts with ":" in FIN. One that does is a tag
    // written wrongly — read as text, it would vanish into the field before it.
    if (line.startsWith(':')) {
      throw malformed(`"${line.slice(0, 12)}" starts like a field tag but is not one — `
        + 'a tag is two digits and an optional capital letter, as in ":57A:"', 'block 4');
    }
    if (/^\s+:\d{2}[A-Za-z]?:/.test(line)) {
      throw malformed(`"${line.trim().slice(0, 8)}" is indented — a field tag starts its line`, 'block 4');
    }
    if (fields.length > 0) fields[fields.length - 1]!.lines.push(line);
    else if (line.trim() !== '') {
      throw malformed(`text before the first field: "${line.slice(0, 40)}"`, 'block 4');
    }
  }
  for (const f of fields) {
    while (f.lines.length > 1 && f.lines[f.lines.length - 1]!.trim() === '') f.lines.pop();
  }
  return fields;
}

/**
 * Is this set of fields an MT103's? Every tag one an MT103 carries, none
 * more often than it may, every mandatory one there.
 *
 * `declared` says block 2 named the type. When it did not, a tag from
 * another message type is the sign that this is not an MT103 at all.
 */
function assertMt103Fields(fields: Field[], declared: boolean): void {
  const seen = new Map<string, string>();
  for (const f of fields) {
    if (!MT103_TAGS.has(f.tag)) {
      throw declared
        ? malformed(`field ${f.tag} is not an MT103 field`, f.tag)
        : new SwiftMessageError('unsupported_message',
          `field ${f.tag} is not an MT103 field — this text is another message type, or not one message. `
          + 'Without the header blocks nothing states the type; send the message with them ({1:…}{2:I103…})', f.tag);
    }
    if (REPEATABLE.has(f.tag)) continue;
    const number = f.tag.slice(0, 2);
    const key = OPTION_FIELDS.has(number) ? number : f.tag;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw malformed(earlier === f.tag
        ? `field ${f.tag} occurs twice — it may occur once, and the two could not both be meant`
        : `fields ${earlier} and ${f.tag} are both present — they are two forms of one field, and only one may be used`, f.tag);
    }
    seen.set(key, f.tag);
  }
  const has = (key: string): boolean => seen.has(key);
  const mandatory: [string, string][] = [
    ['20', 'field 20 (sender\'s reference)'], ['23B', 'field 23B (bank operation code)'],
    ['32A', 'field 32A (value date, currency, amount)'], ['50', 'field 50a (ordering customer)'],
    ['59', 'field 59a (beneficiary customer)'], ['71A', 'field 71A (details of charges)'],
  ];
  for (const [key, label] of mandatory) {
    if (has(key)) continue;
    const tag = key.length === 2 && OPTION_FIELDS.has(key) ? `${key}a` : key;
    throw new SwiftMessageError(declared || has('32A') ? 'missing_field' : 'not_a_swift_message',
      `${label} is missing — an MT103 always carries it${declared ? '' : '; the text may be cut short, or is not an MT103'}`, tag);
  }
}

/** The fields this reader takes a value from. */
const READ_TAGS = new Set([
  '20', '23B', '26T', '32A', '33B', '36', '50A', '50F', '50K', '52A', '52D', '56A', '56C', '56D',
  '57A', '57C', '57D', '59', '59A', '59F', '70', '71A', '71F', '71G', '77B',
]);
/** The ones the standard writes on a single line. */
const ONE_LINE = new Set(['20', '23B', '26T', '32A', '33B', '36', '56C', '57C', '71A', '71F', '71G']);

/**
 * A field the reader takes a value from carries one, and a field written on a
 * single line has no second. Read as it stands, an empty 71A was "no charges
 * code" and an empty 33B "no instructed amount"; a second line under 32A or
 * 71A was dropped, and with it a second amount or another charges code.
 */
function assertFieldShapes(fields: Field[]): void {
  for (const f of fields) {
    if (!READ_TAGS.has(f.tag)) continue;
    if (f.lines.every((l) => l.trim() === '')) {
      throw new SwiftMessageError('invalid_field',
        `field ${f.tag} is present but empty — write its value; an empty field is not read as one left out`, f.tag);
    }
    const second = f.lines.slice(1).find((l) => l.trim() !== '');
    if (ONE_LINE.has(f.tag) && second !== undefined) {
      throw malformed(`field ${f.tag} takes one line, but "${second.trim().slice(0, 35)}" follows it — `
        + 'a value cut in two, or a field whose tag was lost; correct the message', f.tag);
    }
  }
}

/** Field 23B: what the standard allows, exactly as written. */
const BANK_OPERATION_CODES = new Set(['CRED', 'CRTS', 'SPAY', 'SPRI', 'SSTD']);

/**
 * `/account` on the first line of a customer field (50a, 59a), when the option
 * allows one: everything after the slash. The `/C/` and `/D/` marks belong to
 * the institution fields; here `/S/123` is the account `S/123`.
 */
function takeAccount(lines: string[]): { account?: string; rest: string[] } {
  // Trimmed, as the structured and the institution fields read their first line: with a space
  // before the slash the account was taken for the name, and the name for an address line.
  const first = (lines[0] ?? '').trim();
  if (first.startsWith('/')) {
    const account = first.slice(1).trim();
    return { ...(account ? { account } : {}), rest: lines.slice(1) };
  }
  return { rest: lines };
}

const clean = (lines: string[]): string[] => lines.map((l) => l.trim()).filter((l) => l !== '');

/** Options K (ordering customer) and no-letter 59: account, then name and address. */
function freeParty(lines: string[]): SwiftParty {
  const { account, rest } = takeAccount(lines);
  const body = clean(rest);
  const out: SwiftParty = { addressLines: body.slice(1) };
  if (body[0]) out.name = body[0];
  if (account) out.account = account;
  return out;
}

/** Option A: account, then a BIC. */
function bicParty(lines: string[]): SwiftParty {
  const { account, rest } = takeAccount(lines);
  const out: SwiftParty = { addressLines: [] };
  const bic = clean(rest)[0];
  if (bic) out.bic = bic;
  if (account) out.account = account;
  return out;
}

/** Party-identifier codes that name a person's document, not a company's number. */
const PERSONAL_CODES = new Set(['ARNU', 'CCPT', 'DRLC', 'NIDN', 'SOSE']);

/**
 * Option F: a party identifier line, then numbered lines —
 * 1/ name · 2/ address · 3/ country[/town] · 4/ birth date · 5/ birth place ·
 * 6/ customer id · 7/ national id · 8/ continuation of an identifier.
 * In 50F the first line is either `/account` or `code/country/identifier`.
 *
 * Numbers 1, 2 and 3 may repeat. The first 3/ carries the country; a later
 * one continues the address (a postcode, a region) and must not be read as
 * another country. 8/ continues whichever identifier came before it — the
 * one of the first line included.
 *
 * 59F has only 1/, 2/ and 3/, and its first line is only ever `/account`: a
 * birth date, a place of birth and an identity number describe the ordering
 * customer, and read from 59F they would describe a beneficiary the message
 * does not.
 */
function structuredParty(lines: string[], tag: string): SwiftParty {
  const out: SwiftParty = { addressLines: [] };
  let body = lines;
  const first = (lines[0] ?? '').trim();
  if (first.startsWith('/')) {
    const account = first.slice(1).trim();
    if (account) out.account = account;
    body = lines.slice(1);
  } else if (tag === '50F' && /^[A-Z]{4}\/[A-Z]{2}\/.+/.test(first)) {
    const [scheme, , ...id] = first.split('/');
    out.identificationScheme = scheme!;
    out.identification = id.join('/');
    out.identificationFrom = `field ${tag} party identifier`;
    if (PERSONAL_CODES.has(scheme!)) out.person = true;
    body = lines.slice(1);
  }
  const last = tag === '59F' ? 3 : 8;
  const names: string[] = [];
  let countryLine = false;
  // Which identifier an 8/ line would continue: the one read last.
  let continues = out.identification !== undefined;
  for (const raw of clean(body)) {
    const m = /^([1-8])\/(.*)$/.exec(raw);
    if (!m) {
      throw new SwiftMessageError('invalid_field',
        `field ${tag}: "${raw.slice(0, 35)}" is not a numbered line (expected 1/ … ${last}/)`, tag);
    }
    const [, n, value] = m as unknown as [string, string, string];
    if (Number(n) > last) {
      throw malformed(`field ${tag}: "${raw.slice(0, 35)}" is line ${n}/, which ${tag} does not have — `
        + 'its lines are 1/ (name), 2/ (address) and 3/ (country and town)', tag);
    }
    const v = value.trim();
    // An empty line adds nothing: no blank part of the name, no blank address line.
    if (n === '1') { if (v) names.push(v); }
    else if (n === '2') { if (v) out.addressLines.push(v); }
    else if (n === '3') {
      if (countryLine) {
        if (v) out.addressLines.push(v);
      } else {
        // The first 3/ states the country: its two-letter code, then "/" and the town.
        if (!/^[A-Z]{2}(?:\/|$)/.test(v)) {
          throw new SwiftMessageError('invalid_field',
            `field ${tag}: line "${raw.slice(0, 35)}" does not start with a country code — the first 3/ line is `
            + 'the two-letter ISO country code, then "/" and the town, as 3/SG/SINGAPORE', tag);
        }
        countryLine = true;
        const [cc, ...town] = v.split('/');
        out.country = cc!;
        const t = town.join('/').trim();
        if (t) out.addressLines.push(t);
      }
    } else if (n === '4' || n === '5') {
      // A date or a place of birth: the party is a person.
      out.person = true;
    } else if (n === '6' || n === '7') {
      if (n === '7') out.person = true;
      if (!out.identification) {
        // 6/CC/issuer/number · 7/CC/number
        const parts = v.split('/');
        out.identification = parts.slice(n === '6' ? 2 : 1).join('/') || v;
        out.identificationScheme = n === '6' ? 'CUST' : 'NIDN';
        out.identificationFrom = `field ${tag} line ${n}/`;
        continues = true;
      } else {
        continues = false;
      }
    } else if (n === '8' && continues && out.identification) {
      out.identification += v;
    }
  }
  if (names.length > 0) out.name = names.join(' ');
  return out;
}

/** Options A / C / D of an institution field. */
function institution(tag: string, lines: string[]): SwiftAgent | undefined {
  const out: SwiftAgent = {};
  let body = lines;
  // One reading of the first line: the branch and the value both come from it.
  const first = (lines[0] ?? '').trim();
  if (first.startsWith('//')) {
    // A national clearing code leads the field: `//XXnnnn…`. `//` alone names none.
    const code = first.slice(2).trim();
    if (code) out.memberId = code;
    body = lines.slice(1);
  } else if (first.startsWith('/')) {
    // `/account`, or `/C/account` / `/D/account` with the credit or debit mark
    // the institution fields allow; option C is a clearing code written this way.
    const account = first.slice(1).replace(/^[CD]\//, '').trim();
    if (tag.endsWith('C') && account) out.memberId = account;
    body = lines.slice(1);
  }
  const text = clean(body);
  if (tag.endsWith('A')) {
    if (text[0]) out.bic = text[0];
  } else if (tag.endsWith('D')) {
    if (text[0]) out.name = text[0];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A coded reference inside field 70: `/ROC/…`, `/RFB/…`. A code word with
 * nothing after it has no value, and does not take the code word that follows
 * for its own: the first occurrence that says something is the reference.
 */
function codedReference(text: string, code: string): string | undefined {
  const re = new RegExp(`/${code}/(.*?)(?=/(?:${REMITTANCE_CODES})/|\\n|$)`, 'gs');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // Several references under one code word are separated by "//": the first is the reference.
    const v = m[1]!.split('//')[0]!.trim().replace(/\/$/, '').trim();
    if (v) return v;
  }
  return undefined;
}

/** A day of the calendar: month 1 to 12, day 1 to the month's last. */
function isCalendarDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Every MT103 in the text, in order. `index` counts across the whole text. */
export function parseMt103(raw: string, digest: string): SwiftPayment[] {
  const messages = splitMessages(raw);
  return messages.map((blocks, index) => {
    try {
      const p = parseOne(blocks, digest);
      p.index = index;
      p.transactionCount = messages.length;
      return p;
    } catch (e) {
      if (e instanceof SwiftMessageError && messages.length > 1) {
        throw new SwiftMessageError(e.code, `message ${index + 1} of ${messages.length}: ${e.message}`, e.field);
      }
      throw e;
    }
  });
}

function parseOne(blocks: Blocks, digest: string): SwiftPayment {
  // Block 2 names the message type: I103… (input) or O103… (output).
  if (blocks.b2 !== undefined) {
    const m = /^[IO](\d{3})/.exec(blocks.b2);
    if (!m) throw new SwiftMessageError('malformed_message', 'block 2 does not name a message type', 'block 2');
    if (m[1] !== '103') {
      throw new SwiftMessageError('unsupported_message',
        `MT${m[1]} is not a customer credit transfer — this SDK reads MT103 (and pacs.008, pain.001)`);
    }
  }

  const fields = fieldsOf(blocks.b4);
  assertMt103Fields(fields, blocks.b2 !== undefined);
  assertFieldShapes(fields);
  const all = (tag: string): Field[] => fields.filter((f) => f.tag === tag);
  const one = (tag: string): Field | undefined => all(tag)[0];
  const need = (tag: string): Field => {
    const f = one(tag);
    if (!f) throw new SwiftMessageError('missing_field', `field ${tag} is missing`, tag);
    return f;
  };

  // 32A — 6!n3!a15d
  const f32 = need('32A').lines[0]!.trim();
  const m32 = /^(\d{2})(\d{2})(\d{2})([A-Z]{3})([\d,]+)$/.exec(f32);
  if (!m32) throw new SwiftMessageError('invalid_field', `field 32A: "${f32}" is not date, currency and amount`, '32A');
  const yy = Number(m32[1]);
  const year = yy < 80 ? 2000 + yy : 1900 + yy;
  // The value date is part of the payment's identity: 30 February is not a day it can name.
  if (!isCalendarDate(year, Number(m32[2]), Number(m32[3]))) {
    throw new SwiftMessageError('invalid_field', `field 32A: the value date "${f32.slice(0, 6)}" is not a calendar date — `
      + 'it is written YYMMDD, as 261117 for 17 November 2026', '32A');
  }
  const valueDate = `${year}-${m32[2]}-${m32[3]}`;
  const settlementAmount = { currency: assertCurrency(m32[4], '32A'), value: normaliseAmount(m32[5]!, '32A', { decimalComma: true }) };

  // 33B — 3!a15d
  const f33 = one('33B')?.lines[0]?.trim();
  let instructedAmount: { currency: string; value: string } | undefined;
  if (f33) {
    const m33 = /^([A-Z]{3})([\d,]+)$/.exec(f33);
    if (!m33) throw new SwiftMessageError('invalid_field', `field 33B: "${f33}" is not currency and amount`, '33B');
    instructedAmount = { currency: assertCurrency(m33[1], '33B'), value: normaliseAmount(m33[2]!, '33B', { decimalComma: true }) };
  }

  // Ordering customer — exactly one of 50A, 50F, 50K.
  const f50 = fields.find((f) => /^50[AFK]$/.test(f.tag));
  if (!f50) throw new SwiftMessageError('missing_field', 'field 50a (ordering customer) is missing', '50a');
  const debtor = f50.tag === '50A' ? bicParty(f50.lines)
    : f50.tag === '50F' ? structuredParty(f50.lines, '50F')
      : freeParty(f50.lines);

  // Beneficiary customer — 59, 59A or 59F.
  const f59 = fields.find((f) => /^59[AF]?$/.test(f.tag));
  if (!f59) throw new SwiftMessageError('missing_field', 'field 59a (beneficiary customer) is missing', '59a');
  const creditor = f59.tag === '59A' ? bicParty(f59.lines)
    : f59.tag === '59F' ? structuredParty(f59.lines, '59F')
      : freeParty(f59.lines);

  // 77B — residence codes are the one structured statement of country in a free-format MT.
  const regulatoryReporting = all('77B').map((f) => clean(f.lines).join(' '));
  const reg = regulatoryReporting.join(' ');
  const orderRes = /\/ORDERRES\/([A-Z]{2})\b/.exec(reg)?.[1];
  const benefRes = /\/BENEFRES\/([A-Z]{2})\b/.exec(reg)?.[1];
  if (!debtor.country && orderRes) { debtor.country = orderRes; debtor.countryFrom = 'field 77B /ORDERRES/'; }
  if (!creditor.country && benefRes) { creditor.country = benefRes; creditor.countryFrom = 'field 77B /BENEFRES/'; }

  // Input form (as sent): block 1 is the sender, block 2 names the receiver.
  // Output form (as delivered): block 1 is the receiver and the sender sits
  // in the message input reference inside block 2.
  const ownLt = bicFromLt(blocks.b1 ? blocks.b1.slice(3, 15) : undefined);
  const output = blocks.b2?.startsWith('O') === true;
  const senderBic = output ? bicFromLt(blocks.b2!.slice(14, 26)) : ownLt;
  const receiverBic = output ? ownLt : (blocks.b2 ? bicFromLt(blocks.b2.slice(4, 16)) : undefined);

  const f52 = fields.find((f) => /^52[AD]$/.test(f.tag));
  const debtorAgent = (f52 ? institution(f52.tag, f52.lines) : undefined)
    ?? (senderBic ? { bic: senderBic } : undefined);
  const f57 = fields.find((f) => /^57[ACD]$/.test(f.tag));
  const creditorAgent = (f57 ? institution(f57.tag, f57.lines) : undefined)
    ?? (receiverBic ? { bic: receiverBic } : undefined);
  const intermediaries = fields.filter((f) => /^56[ACD]$/.test(f.tag))
    .map((f) => institution(f.tag, f.lines)).filter((a): a is SwiftAgent => a !== undefined);

  const f70 = one('70');
  const remittanceText = f70 ? clean(f70.lines) : [];
  // A coded line may continue on the next with a leading "//".
  const joined = remittanceText.map((l) => (l.startsWith('//') ? l.slice(2) : `\n${l}`)).join('').trim();
  const invoices = invoiceTokens(joined);
  // The ordering customer's own reference travels as /ROC/ — the field the
  // ISO 20022 translation carries as the end-to-end identification.
  const roc = codedReference(joined, 'ROC');

  const charge = one('71A')?.lines[0]?.trim();
  const chargeBearer = charge === 'OUR' ? 'DEBT' : charge === 'BEN' ? 'CRED' : charge === 'SHA' ? 'SHAR' : undefined;
  if (charge && !chargeBearer) {
    throw new SwiftMessageError('invalid_field', `field 71A: "${charge}" is not OUR, SHA or BEN`, '71A');
  }

  const reference = need('20').lines[0]!.trim();
  // Block 3 field 121: one UETR, or none. Two would be two identities for one payment.
  const f121 = blocks.b3 === undefined ? [] : [...blocks.b3.matchAll(/\{121:([^}]*)\}/g)].map((m) => m[1]!);
  if (f121.length > 1) {
    throw malformed('block 3 carries field 121 (the UETR) more than once — a payment has one UETR, '
      + 'and the two could not both be meant', 'block 3 field 121');
  }
  if (f121[0] !== undefined && f121[0].trim() === '') {
    throw new SwiftMessageError('invalid_field', 'block 3 field 121 (the UETR) is present but empty — write the UETR, '
      + 'or leave the field out; an empty field is not read as one left out', 'block 3 field 121');
  }
  const uetr = uetrOf(f121[0], 'block 3 field 121');

  const p: SwiftPayment = {
    format: 'MT103', messageType: 'MT103', digest, index: 0, transactionCount: 1,
    messageId: reference,
    instructionId: reference,
    valueDate,
    amount: instructedAmount ?? settlementAmount,
    settlementAmount,
    debtor, creditor,
    intermediaryAgents: intermediaries,
    remittanceInformation: remittanceText,
    invoiceReferences: invoices,
    otherDocuments: [],
    charges: [
      ...all('71F').map((f) => `sender's charges ${(f.lines[0] ?? '').trim()}`),
      ...all('71G').map((f) => `receiver's charges ${(f.lines[0] ?? '').trim()}`),
    ],
    regulatoryReporting,
    present: [...new Set(fields.map((f) => f.tag))],
  };
  const operation = one('23B')?.lines[0]?.trim();
  // Written any other way, CRTS would not mark a test, and a test would go out as a payment.
  if (operation !== undefined && !BANK_OPERATION_CODES.has(operation)) {
    throw new SwiftMessageError('invalid_field', `field 23B: "${operation.slice(0, 35)}" is not a bank operation code — `
      + 'it is CRED, CRTS (a test message), SPAY, SPRI or SSTD, in capitals', '23B');
  }
  if (operation) p.bankOperationCode = operation;
  // A message that says of itself that it is a test: the bank operation code,
  // or a test and training BIC — "0" in the eighth position — in the header.
  const trainingLt = [blocks.b1?.slice(3, 15), output ? blocks.b2?.slice(14, 26) : blocks.b2?.slice(4, 16)]
    .find((lt) => lt !== undefined && /^[A-Z0-9]{7}0/.test(lt));
  if (operation === 'CRTS') p.test = { where: 'field 23B', what: 'CRTS' };
  else if (trainingLt) p.test = { where: 'header blocks 1 and 2', what: `test and training BIC ${trainingLt.slice(0, 8)}` };
  if (instructedAmount) p.instructedAmount = instructedAmount;
  if (uetr) { p.uetr = uetr; p.present.push('121'); }
  if (roc) p.endToEndId = roc;
  const rate = one('36')?.lines[0]?.trim();
  if (rate !== undefined) {
    // 12d: digits with one decimal comma, the comma counted in the twelve.
    if (!/^\d+,\d*$/.test(rate) || rate.length > 12) {
      throw new SwiftMessageError('invalid_field', `field 36: "${rate.slice(0, 35)}" is not an exchange rate — `
        + 'a rate is digits with one decimal comma, at most 12 characters, as 0,9125', '36');
    }
    p.exchangeRate = rate.replace(',', '.').replace(/\.$/, '');
  }
  if (chargeBearer) p.chargeBearer = chargeBearer;
  if (debtorAgent) p.debtorAgent = debtorAgent;
  if (creditorAgent) p.creditorAgent = creditorAgent;
  const type = one('26T')?.lines[0]?.trim();
  if (type) p.purpose = type;
  return p;
}
