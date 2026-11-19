/**
 * A ledger, read into the tree's input — the part of intake that needs
 * nothing but the language itself.
 *
 * This used to be the platform's step: the exchange uploaded a file, or
 * opened its database, and the tree was built on our side. It runs where the
 * ledger is now. That is usually a server (`intake.ts` wraps this module
 * around a file on disk), but it is also a browser — the sandbox console
 * reads a balance file the visitor picks without the file leaving the page —
 * so nothing here touches the file system, the network or a platform crypto
 * API.
 *
 * Two layouts, because those are the two shapes a ledger exports in:
 *
 *   long   one row per account and asset        account_id,asset,balance
 *   wide   one row per account, a column each   account_id,BTC,ETH,USDT
 *
 * The rules lean one way throughout: nothing that could change a total is
 * decided silently.
 *   - An asset the caller did not declare is an error, not a dropped row or a
 *     skipped column — dropping it would understate liabilities without a
 *     trace. (In the long layout an unrelated extra column cannot hide a
 *     balance, so it is ignored and reported; in the wide layout an unknown
 *     column might be an asset, so it must be named as ignorable.)
 *   - A second row for the same account and asset is an error, not a sum.
 *     Whether two wallets of one customer add up is the exchange's decision,
 *     made in its own query where it can be reviewed.
 *   - An account identifier is used byte for byte. It is hashed into the
 *     leaf, and the customer later types the same identifier to find their
 *     proof, so an identifier with stray padding is refused rather than
 *     trimmed into a different one.
 *   - A ledger with any problem produces no rows. A tree built from the rows
 *     that happened to be accepted would commit to a total nobody chose.
 *
 * Problems carry a line number and a stable code. Reading continues past the
 * first one so a single run reports what is wrong with the export rather
 * than one item of it.
 *
 * `LedgerBuilder` takes rows one call at a time, from the exchange's own
 * database query. `CsvLedgerReader` puts a CSV header and dialect in front of
 * the same builder, so the two ways in cannot come to disagree about a row.
 */
import type { PorBalances } from '../attest-verify/index.ts';
import { AmountError, MAX_DECIMALS, toBaseUnits } from './amounts.ts';
import type { AmountUnit } from './amounts.ts';
import { CsvError, CsvParser } from './csv.ts';
import type { PorAssetSpec } from './snapshot.ts';

export interface LiabilityRow {
  user_ref: string;
  balances: PorBalances;
}

/**
 * `sheet` is the per-account balance sheet some exchanges already export for
 * a proof of reserves of their own: beside the account, each asset has an
 * equity column `e_<asset>` and a debt column `d_<asset>`, among others this
 * reader has no use for. The equity is the balance. A debt has to be zero.
 */
export type CsvLayout = 'long' | 'wide' | 'sheet';

/** Columns of a `sheet` export that carry no balance of their own. */
const SHEET_FIXED = new Set(['rn', 'total_net_balance_usdt']);
const SHEET_OTHER_PREFIXES = ['vl_', 'm_', 'pm_'];


export interface IntakeProblem {
  /** 1-based line of the file; 0 for a problem with the file as a whole. */
  line: number;
  code: string;
  message: string;
}

export const STANDARD_COLUMNS = { account: 'account_id', asset: 'asset', balance: 'balance' } as const;

/** ASCII only: a symbol becomes a JSON key inside every hash, and non-ASCII keys are where canonical forms diverge between languages. */
export const ASSET_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const MAX_ACCOUNT_BYTES = 256;

/**
 * Lower case for ASCII letters only. Header names and asset symbols are
 * compared "ignoring case" in several languages' SDKs, and full Unicode case
 * folding is not the same function in any two of them.
 */
const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** `BTC:8,ETH:18` → specs, or a list of what is wrong with it. */
export function parseAssetSpecs(text: string): { assets: PorAssetSpec[]; problems: string[] } {
  const assets: PorAssetSpec[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    const [symbol, decimals, ...rest] = part.split(':');
    if (!symbol || decimals === undefined || rest.length > 0 || !/^\d+$/.test(decimals)) {
      problems.push(`"${part}" should look like BTC:8 (symbol, colon, decimal places)`);
      continue;
    }
    if (!ASSET_SYMBOL.test(symbol)) {
      problems.push(`asset symbol "${symbol}" may contain only letters, digits, ".", "_" and "-" (up to 32 characters)`);
      continue;
    }
    if (Number(decimals) > MAX_DECIMALS) {
      problems.push(`${symbol}: ${decimals} decimal places is more than any asset uses (limit ${MAX_DECIMALS})`);
      continue;
    }
    if (seen.has(symbol)) { problems.push(`asset ${symbol} is listed twice`); continue; }
    seen.add(symbol);
    assets.push({ symbol, decimals: Number(decimals) });
  }
  if (assets.length === 0 && problems.length === 0) problems.push('no assets were listed');
  return { assets, problems };
}

function accountProblem(id: string): { code: string; message: string } | null {
  if (id === '') return { code: 'account_empty', message: 'the account identifier is empty' };
  if (id !== id.trim()) {
    return { code: 'account_whitespace',
      message: `account identifier ${JSON.stringify(id)} has leading or trailing whitespace; trim it in the export so the identifier is the one your customer knows` };
  }
  // The identifier sits after a line break in the hashed text, so one that
  // contains a line break could be read as a different exchange's.
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    return { code: 'account_control_character', message: `account identifier ${JSON.stringify(id)} contains a control character` };
  }
  if (new TextEncoder().encode(id).length > MAX_ACCOUNT_BYTES) {
    return { code: 'account_too_long', message: `account identifier is longer than ${MAX_ACCOUNT_BYTES} bytes` };
  }
  return null;
}

/** What a ledger adds up to, and what was wrong with it. No account in it. */
export interface LedgerReport {
  ok: boolean;
  /** Rows offered: data rows of a file, or calls to the builder. */
  rows: number;
  accounts: number;
  /** Accounts every one of whose balances is zero. */
  zero_balance_accounts: number;
  /** Per asset, in smallest units. */
  totals: PorBalances;
  /** Per asset, accounts holding more than zero. */
  holders: Record<string, number>;
  /** Declared assets with no balance above zero anywhere. */
  assets_without_balance: string[];
  problem_count: number;
  problems: IntakeProblem[];
}

export interface LedgerOptions {
  /** Every asset the snapshot covers, with its decimal places. */
  assets: PorAssetSpec[];
  /** How amounts are written. Never inferred. */
  amounts: AmountUnit;
  /** Refuse above this many accounts (see `limits.ts`). */
  maxAccounts?: number;
  /** How many problems to keep in the report; all of them are counted. */
  maxProblems?: number;
}

/**
 * A ledger taken one row at a time, from wherever the exchange keeps it.
 *
 * ```ts
 * const ledger = new LedgerBuilder({ assets, amounts: 'decimal' });
 * for await (const r of db.query('SELECT user_id, currency, SUM(available + locked) …')) {
 *   ledger.add(String(r.user_id), r.currency, r.balance);   // amounts as text, never a float
 * }
 * const { rows, report } = ledger.finish();
 * if (!report.ok) throw new Error(`${report.problem_count} problems in the ledger`);
 * ```
 *
 * `add` is one row per account and asset; `addAccount` is one row per
 * account. Each returns whether the row was accepted, and a refused row is a
 * problem with the ordinal of the call as its `line` — but the decision is
 * taken at the end, on the whole ledger: `finish()` hands back rows only when
 * nothing at all was refused.
 */
export class LedgerBuilder {
  private readonly symbols: string[];
  private readonly decimalsOf: Map<string, number>;
  private readonly lowerSymbols: Map<string, string>;
  private readonly amounts: AmountUnit;
  private readonly maxAccounts: number | undefined;
  private readonly maxProblems: number;
  private readonly accounts = new Map<string, PorBalances>();
  private readonly kept: IntakeProblem[] = [];
  private problemCount = 0;
  private calls = 0;
  private tooMany = false;

  constructor(o: LedgerOptions) {
    // The command line builds this list with `parseAssetSpecs`; a caller that
    // builds it in code gets the same rules, as an error rather than a report
    // — a list that is wrong is a mistake in the program, not in the ledger.
    const listed = new Set<string>();
    for (const a of o.assets) {
      if (typeof a.symbol !== 'string' || !ASSET_SYMBOL.test(a.symbol)) {
        throw new Error(`asset symbol ${JSON.stringify(a.symbol)} may contain only letters, digits, ".", "_" and "-" (up to 32 characters)`);
      }
      if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > MAX_DECIMALS) {
        throw new Error(`${a.symbol}: decimals must be a whole number from 0 to ${MAX_DECIMALS}`);
      }
      if (listed.has(a.symbol)) throw new Error(`asset ${a.symbol} is listed twice`);
      listed.add(a.symbol);
    }
    this.symbols = o.assets.map((a) => a.symbol);
    this.decimalsOf = new Map(o.assets.map((a) => [a.symbol, a.decimals]));
    this.lowerSymbols = new Map(this.symbols.map((sym) => [lower(sym), sym]));
    this.amounts = o.amounts;
    this.maxAccounts = o.maxAccounts;
    this.maxProblems = o.maxProblems ?? 50;
  }

  /** One row per account and asset. `amount` is text, exactly as the ledger prints it. */
  add(account: string, asset: string, amount: string): boolean {
    return this.rowAt(++this.calls, account, asset, amount);
  }

  /** One row per account. An asset left out, or given as an empty string, is "holds none". */
  addAccount(account: string, balances: Record<string, string> | Map<string, string>): boolean {
    const line = ++this.calls;
    const given = balances instanceof Map ? balances : new Map(Object.entries(balances));
    return this.accountAt(line, account, this.symbols.map((sym) => [sym, given.get(sym) ?? ''] as [string, string]),
      [...given.keys()].filter((k) => !this.decimalsOf.has(k)).sort());
  }

  /** Record a problem found outside the row rules (a header, a syntax error). */
  problem(line: number, code: string, message: string): void {
    this.problemCount++;
    if (this.kept.length < this.maxProblems) this.kept.push({ line, code, message });
  }

  get hasProblems(): boolean { return this.problemCount > 0; }
  get accountCount(): number { return this.accounts.size; }

  /** The long row, at a stated line. The checks run in a fixed order and the first failure ends the row. */
  rowAt(line: number, account: string, assetCell: string, amount: string): boolean {
    const bad = accountProblem(account);
    if (bad) { this.problem(line, bad.code, bad.message); return false; }
    const symbol = assetCell.trim();
    if (!this.decimalsOf.has(symbol)) {
      const near = this.lowerSymbols.get(lower(symbol));
      this.problem(line, 'unknown_asset', near
        ? `asset "${symbol}" differs from the declared ${near} only by letter case; asset symbols are matched exactly`
        : `asset "${symbol}" is not a declared asset; a balance in an undeclared asset would be left out of the totals`);
      return false;
    }
    const b = this.balancesFor(account);
    if (!b) return false;
    // One lookup in the map being built anyway; a separate index of every
    // (account, asset) pair would double the memory of a large ledger.
    // A frozen entry is an account that was given whole, on one row: nothing
    // may be added to it, whichever asset the new row names.
    if (Object.isFrozen(b) || Object.hasOwn(b, symbol)) {
      this.problem(line, 'duplicate_row',
        `account ${JSON.stringify(account)} has more than one ${symbol} row; one row per account and asset (sum them in the query if they are meant to add up)`);
      return false;
    }
    const value = this.amount(amount, symbol, line);
    // Held even when unreadable, so a later row for the same pair is still a duplicate.
    b[symbol] = value ?? '0';
    return value !== null;
  }

  /**
   * The wide row, at a stated line. `cells` are the declared assets' values in
   * order; `undeclared` are keys the caller supplied that are not assets (a
   * file's header has already refused those, so the file reader passes none).
   */
  accountAt(line: number, account: string, cells: [string, string][], undeclared: string[] = []): boolean {
    const bad = accountProblem(account);
    if (bad) { this.problem(line, bad.code, bad.message); return false; }
    if (this.accounts.has(account)) {
      this.problem(line, 'duplicate_account', `account ${JSON.stringify(account)} appears on more than one row`);
      return false;
    }
    if (undeclared.length > 0) {
      this.problem(line, 'unknown_asset',
        `${undeclared.map((k) => `"${k}"`).join(', ')} ${undeclared.length === 1 ? 'is not a declared asset' : 'are not declared assets'}; a balance in an undeclared asset would be left out of the totals`);
      return false;
    }
    const parsed: PorBalances = {};
    let ok = true;
    for (const [symbol, cell] of cells) {
      // An empty cell is "holds none" — what a NULL prints as.
      const value = cell.trim() === '' ? '0' : this.amount(cell, symbol, line);
      if (value === null) { ok = false; continue; }
      // Only what is held is kept. A row of this kind names every listed
      // asset, and an exchange lists hundreds: a zero stored for each would
      // make the ledger as large as accounts times assets before the tree
      // is even started.
      if (value !== '0') parsed[symbol] = value;
    }
    if (!ok) return false;
    const b = this.balancesFor(account);
    if (!b) return false;
    Object.assign(b, parsed);
    // Marks the account as complete without an index of its own: zeros are
    // not stored, so "this asset is already there" can no longer say it.
    Object.freeze(b);
    return true;
  }

  private balancesFor(id: string): PorBalances | null {
    let b = this.accounts.get(id);
    if (b) return b;
    if (this.maxAccounts !== undefined && this.accounts.size >= this.maxAccounts) { this.tooMany = true; return null; }
    b = {};
    this.accounts.set(id, b);
    return b;
  }

  private amount(text: string, symbol: string, line: number): string | null {
    try {
      return toBaseUnits(text, this.decimalsOf.get(symbol)!, this.amounts);
    } catch (e) {
      if (!(e instanceof AmountError)) throw e;
      this.problem(line, e.code, `${symbol}: ${e.message}`);
      return null;
    }
  }

  /**
   * Close the ledger. `rows` is empty unless `report.ok`: a tree built from
   * the rows that happened to be accepted would commit to a total nobody
   * chose. `rowsOffered` is for a caller that counted rows itself (the file
   * reader); by default it is the number of calls.
   */
  finish(rowsOffered = this.calls): { rows: LiabilityRow[]; report: LedgerReport } {
    if (this.tooMany) {
      this.problem(0, 'too_many_accounts',
        `more than ${this.maxAccounts} accounts, the size this version has been verified for with ${this.symbols.length} asset${this.symbols.length === 1 ? '' : 's'}`);
    }
    if (this.accounts.size === 0 && this.problemCount === 0) {
      this.problem(0, 'no_accounts', 'there are no accounts; a snapshot of nothing is not evidence');
    }
    const totals: Record<string, bigint> = Object.fromEntries(this.symbols.map((sym) => [sym, 0n]));
    const holders: Record<string, number> = Object.fromEntries(this.symbols.map((sym) => [sym, 0]));
    let zeroAccounts = 0;
    for (const b of this.accounts.values()) {
      let any = false;
      for (const [sym, v] of Object.entries(b)) {
        if (v === '0') continue;
        any = true;
        totals[sym] = totals[sym]! + BigInt(v);
        holders[sym] = holders[sym]! + 1;
      }
      if (!any) zeroAccounts++;
    }
    const ok = this.problemCount === 0;
    const report: LedgerReport = {
      ok,
      rows: rowsOffered,
      accounts: this.accounts.size,
      zero_balance_accounts: zeroAccounts,
      totals: Object.fromEntries(this.symbols.map((sym) => [sym, totals[sym]!.toString()])),
      holders,
      assets_without_balance: this.symbols.filter((sym) => holders[sym] === 0),
      problem_count: this.problemCount,
      problems: this.kept,
    };
    const rows: LiabilityRow[] = [];
    if (ok) for (const [user_ref, balances] of this.accounts) rows.push({ user_ref, balances });
    return { rows, report };
  }
}

export interface IntakeOptions extends LedgerOptions {
  /** Decided from the header when omitted. */
  layout?: CsvLayout;
  /** Header names, when the export does not use the standard ones. */
  columns?: { account?: string; asset?: string; balance?: string };
  /** Wide layout only: columns that are neither the account nor an asset. */
  ignoreColumns?: string[];
  delimiter?: string;
}

/** What a CSV adds to the ledger report: which layout it was read as, and what was skipped. */
export interface CsvLedgerReport extends LedgerReport {
  layout: CsvLayout | null;
  ignored_columns: string[];
}

/**
 * A CSV export, fed in pieces.
 *
 * ```ts
 * const reader = new CsvLedgerReader({ assets, amounts: 'decimal' });
 * for await (const chunk of stream) reader.pushBytes(chunk);   // or pushText(text)
 * const { rows, report } = reader.end();
 * ```
 *
 * Bytes are decoded as UTF-8 strictly: a file in another encoding must stop
 * here. Decoded leniently, every account identifier with a non-ASCII
 * character would silently become a different identifier, and the people it
 * belongs to could never match their proof.
 */
export class CsvLedgerReader {
  private readonly ledger: LedgerBuilder;
  private readonly parser: CsvParser;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private readonly symbols: string[];
  private readonly lowerSymbols: Map<string, string>;
  private readonly want: { account: string; asset: string; balance: string };
  private readonly ignoreColumns: string[] | undefined;
  private readonly ignored: string[] = [];
  /** Wide and sheet layouts: column index → asset symbol. */
  private readonly assetColumns = new Map<number, string>();
  /** Sheet layout: column index → the asset whose debt it holds. */
  private readonly debtColumns = new Map<number, string>();
  private readonly accountNamed: boolean;
  private readonly decimals: Map<string, number>;
  private readonly amounts: AmountUnit;
  private layout: CsvLayout | null;
  private header: string[] | null = null;
  private headerOk = false;
  private col = { account: -1, asset: -1, balance: -1 };
  private rows = 0;
  private bytes = 0;
  /** A syntax or encoding error ends interpretation; later input is ignored. */
  private stopped = false;

  constructor(o: IntakeOptions) {
    this.ledger = new LedgerBuilder(o);
    this.parser = new CsvParser(o.delimiter ?? ',');
    this.symbols = o.assets.map((a) => a.symbol);
    this.lowerSymbols = new Map(this.symbols.map((sym) => [lower(sym), sym]));
    this.want = {
      account: o.columns?.account ?? STANDARD_COLUMNS.account,
      asset: o.columns?.asset ?? STANDARD_COLUMNS.asset,
      balance: o.columns?.balance ?? STANDARD_COLUMNS.balance,
    };
    this.ignoreColumns = o.ignoreColumns;
    this.layout = o.layout ?? null;
    this.accountNamed = o.columns?.account !== undefined;
    this.decimals = new Map(o.assets.map((a) => [a.symbol, a.decimals]));
    this.amounts = o.amounts;
  }

  /** The next bytes of the file. */
  pushBytes(bytes: Uint8Array): void {
    if (this.stopped) return;
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      // The decoder knows the byte, not the line: this is a problem with the file, not with a row.
      this.ledger.problem(0, 'file_encoding', `the file is not valid UTF-8 (near byte ${this.bytes}); export it as UTF-8`);
      this.stopped = true;
      return;
    }
    this.bytes += bytes.length;
    this.pushText(text);
  }

  /** The next piece of the file, already text. */
  pushText(text: string): void {
    if (this.stopped) return;
    try {
      for (const rec of this.parser.push(text)) this.record(rec.line, rec.fields);
    } catch (e) {
      this.syntax(e);
    }
  }

  /** The end of the file. `rows` is empty unless `report.ok`. */
  end(): { rows: LiabilityRow[]; report: CsvLedgerReport } {
    if (!this.stopped) {
      try {
        const tail = this.decoder.decode();
        for (const rec of [...this.parser.push(tail), ...this.parser.end()]) this.record(rec.line, rec.fields);
      } catch (e) {
        if (e instanceof CsvError) this.syntax(e);
        else {
          this.ledger.problem(0, 'file_encoding', `the file is not valid UTF-8 (near byte ${this.bytes}); export it as UTF-8`);
          this.stopped = true;
        }
      }
    }
    if (this.header === null && !this.ledger.hasProblems) this.ledger.problem(0, 'empty_file', 'the file has no header row');
    const { rows, report } = this.ledger.finish(this.rows);
    return { rows, report: { ...report, layout: this.layout, ignored_columns: this.ignored } };
  }

  private syntax(e: unknown): void {
    if (!(e instanceof CsvError)) throw e;
    this.ledger.problem(e.line, e.code, e.message.replace(/^line \d+: /, ''));
    this.stopped = true;
  }

  private record(line: number, fields: string[]): void {
    if (this.header === null) {
      this.headerOk = this.readHeader(fields, line);
      return;
    }
    // Without a usable header the rows cannot be interpreted.
    if (!this.headerOk) return;
    this.rows++;
    const header = this.header;
    if (fields.length !== header.length) {
      this.ledger.problem(line, 'field_count', `${fields.length} field${fields.length === 1 ? '' : 's'}, but the header has ${header.length}`);
      return;
    }
    const id = fields[this.col.account]!;
    if (this.layout === 'long') { this.ledger.rowAt(line, id, fields[this.col.asset]!, fields[this.col.balance]!); return; }
    for (const [i, symbol] of this.debtColumns) {
      const cell = fields[i]!;
      if (cell.trim() === '') continue;
      // Read by the rules every amount is read by, so "none" is whatever
      // those rules call zero and a cell they cannot read is said to be so.
      let owed: string;
      try {
        owed = toBaseUnits(cell, this.decimals.get(symbol)!, this.amounts);
      } catch (e) {
        if (!(e instanceof AmountError)) throw e;
        this.ledger.problem(line, e.code, `${symbol} debt: ${e.message}`);
        continue;
      }
      if (owed !== '0') {
        // Netting a debt against what is owed is where a proof of reserves
        // can be made to understate: it needs every account's collateral
        // proven, which a hash tree alone cannot do. So it is not netted and
        // not ignored — the account is refused, by name.
        this.ledger.problem(line, 'debt_not_supported',
          `${symbol}: debt "${cell.trim()}" — a snapshot states what each account is owed and does not net borrowings against it; an account with a debt cannot be stated from this export`);
      }
    }
    this.ledger.accountAt(line, id, [...this.assetColumns].map(([i, symbol]) => [symbol, fields[i]!] as [string, string]));
  }

  private readHeader(fields: string[], line: number): boolean {
    const { want, symbols, lowerSymbols } = this;
    const problem = (l: number, code: string, message: string): void => { this.ledger.problem(l, code, message); };
    const header = fields.map((f) => f.trim());
    this.header = header;
    const seen = new Set<string>();
    for (const name of header) {
      if (name === '') { problem(line, 'header_empty_name', 'the header has a column with no name'); return false; }
      if (seen.has(lower(name))) { problem(line, 'header_duplicate', `the header names "${name}" twice`); return false; }
      seen.add(lower(name));
    }
    const find = (name: string): number => header.findIndex((h) => lower(h) === lower(name));
    const col = { account: find(want.account), asset: find(want.asset), balance: find(want.balance) };
    this.col = col;
    const found = `found: ${header.join(', ')}`;

    // A sheet is known by a pair: an equity and a debt column for one asset.
    const after = (h: string, prefix: string): string | null =>
      (h.length > prefix.length && lower(h.slice(0, prefix.length)) === prefix ? h.slice(prefix.length) : null);
    const debtColumnOf = new Map<string, string>();
    for (const h of header) {
      const x = after(h, 'd_');
      if (x !== null && !debtColumnOf.has(x)) debtColumnOf.set(x, h);
    }
    // …where neither column is itself a declared asset: a wide file whose
    // assets happen to be called e_x and d_x is still a wide file.
    const looksLikeSheet = header.some((h) => {
      const x = after(h, 'e_');
      return x !== null && debtColumnOf.has(x) && !lowerSymbols.has(lower(h)) && !lowerSymbols.has(lower(debtColumnOf.get(x)!));
    });
    const asSheet = this.layout === 'sheet' || (this.layout === null && looksLikeSheet && !(col.asset >= 0 && col.balance >= 0));
    // Such exports call the account column `id`. Taken only when the caller named no column of their own.
    if (asSheet && col.account < 0 && !this.accountNamed) col.account = find('id');

    if (col.account < 0) {
      const hint = header.length === 1 && /[;\t|]/.test(header[0]!)
        ? ' — the file may use another delimiter; pass --delimiter'
        : '; name the account column with --col-account if it is called something else';
      problem(line, 'header_no_account', `no "${want.account}" column in the header (${found})${hint}`);
      return false;
    }

    const assetLike = header.filter((h, i) => i !== col.account && lowerSymbols.has(lower(h)));
    let layout = this.layout;
    if (layout === null) {
      if (col.asset >= 0 && col.balance >= 0) layout = 'long';
      else if (asSheet) layout = 'sheet';
      else if (assetLike.length > 0) layout = 'wide';
      else if (col.asset >= 0 || col.balance >= 0) layout = 'long';
      else {
        // Naming one layout here would send the reader after the wrong fix.
        problem(line, 'header_unrecognised',
          `the header matches neither layout (${found}). Long: ${want.account},${want.asset},${want.balance} — one row per account and asset. `
          + `Wide: ${want.account} and one column per declared asset (${symbols.join(', ')}). `
          + 'Columns with other names can be mapped with --col-asset and --col-balance.');
        return false;
      }
    }
    this.layout = layout;

    if (layout === 'long') {
      if (col.asset < 0 || col.balance < 0) {
        const missing = [col.asset < 0 ? want.asset : '', col.balance < 0 ? want.balance : ''].filter(Boolean);
        problem(line, 'header_missing_column',
          `the long layout needs the column${missing.length > 1 ? 's' : ''} "${missing.join('" and "')}" (${found}); `
          + 'map a differently named column with --col-asset or --col-balance');
        return false;
      }
      header.forEach((h, i) => { if (i !== col.account && i !== col.asset && i !== col.balance) this.ignored.push(h); });
      return true;
    }

    const ignorable = new Set((this.ignoreColumns ?? []).map((c) => lower(c)));
    let ok = true;

    if (layout === 'sheet') {
      const declared = new Set(symbols);
      // The equity columns say which assets the sheet covers. One that was
      // not declared is reported once, there; the columns that go with it
      // are that asset's too, and saying so six times would bury the point.
      const undeclared = new Set<string>();
      // …unless the caller named that column as one to leave out: then the
      // asset is left out on purpose, and its other columns go with it.
      const leftOut = new Set<string>();
      header.forEach((h, i) => {
        const equityOf = i === col.account ? null : after(h, 'e_');
        if (equityOf !== null && !declared.has(equityOf)) (ignorable.has(lower(h)) ? leftOut : undeclared).add(equityOf);
      });
      const ofAsset = (h: string, among: Set<string>): boolean =>
        among.has(h) || ['d_', ...SHEET_OTHER_PREFIXES].some((p) => { const x = after(h, p); return x !== null && among.has(x); });
      header.forEach((h, i) => {
        if (i === col.account) return;
        if (ignorable.has(lower(h)) || ofAsset(h, leftOut)) { this.ignored.push(h); return; }
        const equityOf = after(h, 'e_');
        if (equityOf !== null) {
          if (declared.has(equityOf)) { this.assetColumns.set(i, equityOf); return; }
          ok = false;
          const near = lowerSymbols.get(lower(equityOf));
          problem(line, 'header_unknown_column', near
            ? `column "${h}" is the balance of ${equityOf}, which differs from the declared asset ${near} only by letter case; asset symbols are matched exactly`
            : `column "${h}" is the balance of ${equityOf}, which is not a declared asset; add it to --assets — a balance in an undeclared asset would be left out of the totals`);
          return;
        }
        const debtOf = after(h, 'd_');
        if (debtOf !== null && declared.has(debtOf)) { this.debtColumns.set(i, debtOf); return; }
        if (ofAsset(h, undeclared)) return;
        // The net figure and the collateral figures repeat or qualify the
        // equity; the row number and the valued total are not balances.
        if (ofAsset(h, declared) || SHEET_FIXED.has(lower(h))) { this.ignored.push(h); return; }
        ok = false;
        problem(line, 'header_unknown_column',
          `column "${h}" is not one this layout knows (e_<asset>, d_<asset>, and the net and collateral columns of a declared asset); list it in --ignore-columns if it carries no balance`);
      });
      const present = new Set(this.assetColumns.values());
      for (const sym of symbols) {
        if (!present.has(sym)) {
          ok = false;
          problem(line, 'header_missing_asset', `declared asset ${sym} has no e_${sym} column; remove it from --assets if the exchange holds none`);
        }
      }
      return ok;
    }

    // Wide: every other column is an asset, or has been named as ignorable.
    header.forEach((h, i) => {
      if (i === col.account) return;
      if (symbols.includes(h)) { this.assetColumns.set(i, h); return; }
      if (ignorable.has(lower(h))) { this.ignored.push(h); return; }
      ok = false;
      const near = lowerSymbols.get(lower(h));
      problem(line, 'header_unknown_column', near
        ? `column "${h}" differs from the declared asset ${near} only by letter case; asset symbols are matched exactly`
        : `column "${h}" is not a declared asset; add it to --assets if it is a balance, or to --ignore-columns if it is not`);
    });
    const present = new Set(this.assetColumns.values());
    for (const sym of symbols) {
      if (!present.has(sym) && !header.some((h) => h !== sym && lower(h) === lower(sym))) {
        ok = false;
        problem(line, 'header_missing_asset', `declared asset ${sym} has no column; remove it from --assets if the exchange holds none`);
      }
    }
    return ok;
  }
}
