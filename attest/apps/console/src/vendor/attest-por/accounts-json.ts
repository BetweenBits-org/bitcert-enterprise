/**
 * Balances as a JSON array of accounts — the other shape an exchange may
 * already have on hand:
 *
 *   [ { "id": "…", "assets": { "BTC": "0.5", "ETH": "12" } }, … ]
 *
 * It says the same thing as the one-row-per-account CSV, so it is read into
 * the same builder and every rule is the builder's: the account rules, an
 * undeclared asset, a negative or malformed amount, an account that appears
 * twice. What is particular to JSON is settled here, and each point is one
 * where a looser reader would lose a balance without saying so:
 *
 *   - an amount is a string. A JSON number is refused, because it cannot
 *     carry every digit of a ledger figure and nothing would say which
 *     digits were lost;
 *   - the account is named by `id` or by `account_id`, its balances by
 *     `assets` or by `balances` — one of each. An account that gives both
 *     spellings is refused rather than one of them being picked;
 *   - a key written twice in one object is refused. A JSON parser keeps the
 *     last and drops the first, so `{"BTC": "1", "BTC": "2"}` would count
 *     as two when the export said three;
 *   - any other field of an account is skipped and listed in the report, as
 *     an unrelated column of a long CSV is;
 *   - a problem is reported against the account's position in the array,
 *     counted from one, since a JSON file has no lines worth naming.
 *
 * The whole text is parsed at once. That is right for a file a person hands
 * over; a ledger in the millions is better exported as CSV, or fed to the
 * builder from the query that produces it.
 */
import { LedgerBuilder } from './ledger.ts';
import type { LedgerOptions, LedgerReport, LiabilityRow } from './ledger.ts';

export interface JsonLedgerReport extends LedgerReport {
  layout: 'json';
  /** Fields of an account object that are neither its name nor its balances; skipped. */
  ignored_columns: string[];
}

const SHAPE = '[{"id": "…", "assets": {"BTC": "0.5"}}, …]';
const NAME_KEYS = ['id', 'account_id'] as const;
const BALANCE_KEYS = ['assets', 'balances'] as const;

/**
 * Keys written twice in one object, with the position (from one) of the
 * top-level array element they are in — 0 when they are not inside one.
 *
 * `JSON.parse` cannot report these: by the time it returns, the earlier
 * value is gone. So the text is walked once more, following only strings and
 * brackets. It is not a second parser and is run only on text the real one
 * has already accepted.
 */
function repeatedKeys(text: string): { at: number; key: string }[] {
  const found: { at: number; key: string }[] = [];
  /** One entry per open container: the keys seen so far for an object, null for an array. */
  const open: (Set<string> | null)[] = [];
  let element = 0;
  let keyNext = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // A bare string is an element of the array too (a refused one), and is counted like any other.
      if (open.length === 1 && open[0] === null && element === 0) element = 1;
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = open[open.length - 1];
      if (top && keyNext) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) found.push({ at: open[0] === null ? element : 0, key });
        top.add(key);
        keyNext = false;
      }
      i = j;
    } else if (c === '{') {
      if (open.length === 1 && open[0] === null && element === 0) element = 1;
      open.push(new Set());
      keyNext = true;
    } else if (c === '[') {
      if (open.length === 1 && open[0] === null && element === 0) element = 1;
      open.push(null);
      keyNext = false;
    } else if (c === '}' || c === ']') {
      open.pop();
      keyNext = false;
    } else if (c === ',') {
      if (open.length === 1 && open[0] === null) element++;
      keyNext = open[open.length - 1] instanceof Set;
    } else if (open.length === 1 && open[0] === null && element === 0 && c !== undefined && !/\s/.test(c)) {
      // The first element of the array is a bare value (a string is caught above).
      element = 1;
    }
  }
  return found;
}

export function readAccountsJson(text: string, o: LedgerOptions): { rows: LiabilityRow[]; report: JsonLedgerReport } {
  const ledger = new LedgerBuilder(o);
  const declared = new Set(o.assets.map((a) => a.symbol));
  const skipped = new Set<string>();
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let offered = 0;
  let data: unknown;
  let parsed = true;
  try {
    data = JSON.parse(body);
  } catch (e) {
    parsed = false;
    ledger.problem(0, 'json_syntax', `the file is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (parsed && !Array.isArray(data)) {
    ledger.problem(0, 'json_shape', `the file must be an array of accounts: ${SHAPE}`);
  } else if (Array.isArray(data)) {
    // An account with a repeated key is not read at all: which of the two
    // values the export meant is not this reader's to decide.
    const repeated = new Map<number, string[]>();
    for (const r of repeatedKeys(body)) repeated.set(r.at, [...(repeated.get(r.at) ?? []), r.key]);
    for (const [i, entry] of data.entries()) {
      const at = i + 1;
      offered++;
      const twice = repeated.get(at);
      if (twice) {
        ledger.problem(at, 'json_duplicate_key',
          `account ${at} writes ${twice.map((k) => JSON.stringify(k)).join(', ')} more than once; a JSON reader keeps only the last, so the earlier value would be lost`);
        continue;
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        ledger.problem(at, 'json_shape', `account ${at} is not an object; expected ${SHAPE}`);
        continue;
      }
      const e = entry as Record<string, unknown>;
      const names = NAME_KEYS.filter((k) => Object.hasOwn(e, k));
      const holders = BALANCE_KEYS.filter((k) => Object.hasOwn(e, k));
      if (names.length > 1 || holders.length > 1) {
        const both = names.length > 1 ? names : holders;
        ledger.problem(at, 'json_shape', `account ${at} has both "${both[0]}" and "${both[1]}"; give it once`);
        continue;
      }
      const id = names.length === 1 ? e[names[0]!] : undefined;
      const assets = holders.length === 1 ? e[holders[0]!] : undefined;
      if (typeof id !== 'string') {
        ledger.problem(at, 'json_shape', `account ${at} has no "id" given as a string`);
        continue;
      }
      if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) {
        ledger.problem(at, 'json_shape', `account ${at} has no "assets" object`);
        continue;
      }
      for (const k of Object.keys(e)) {
        if (!(NAME_KEYS as readonly string[]).includes(k) && !(BALANCE_KEYS as readonly string[]).includes(k)) skipped.add(k);
      }
      const cells: [string, string][] = [];
      const undeclared: string[] = [];
      let textual = true;
      for (const [symbol, amount] of Object.entries(assets as Record<string, unknown>)) {
        if (typeof amount !== 'string') {
          textual = false;
          ledger.problem(at, 'amount_not_text',
            `${symbol}: ${JSON.stringify(amount)} is not a string; write every amount as a string — a JSON number cannot carry every digit of a balance`);
        } else if (declared.has(symbol)) cells.push([symbol, amount]);
        else undeclared.push(symbol);
      }
      if (textual) ledger.accountAt(at, id, cells, undeclared);
    }
  }
  const { rows, report } = ledger.finish(offered);
  return { rows, report: { ...report, layout: 'json', ignored_columns: [...skipped] } };
}
