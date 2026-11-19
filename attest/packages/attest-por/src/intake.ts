/**
 * Intake from a file on disk — an exchange's balance export, read into the
 * tree's input.
 *
 * Everything that decides what a row means lives in `ledger.ts`, which needs
 * nothing but the language. This module is the part that needs a file
 * system: it streams the export through that reader a chunk at a time,
 * because a ledger export does not fit comfortably in one string, and hashes
 * the bytes in the same pass so the report can say exactly which file its
 * totals came from.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readAccountsJson } from './accounts-json.ts';
import { CsvLedgerReader, parseAssetSpecs } from './ledger.ts';
import type { CsvLedgerReport, IntakeOptions, LedgerOptions, LiabilityRow } from './ledger.ts';
import type { PorAssetSpec } from './snapshot.ts';

export {
  ASSET_SYMBOL, CsvLedgerReader, LedgerBuilder, STANDARD_COLUMNS, parseAssetSpecs,
} from './ledger.ts';
export type {
  CsvLayout, CsvLedgerReport, IntakeOptions, IntakeProblem, LedgerOptions, LedgerReport, LiabilityRow,
} from './ledger.ts';

export interface IntakeReport extends Omit<CsvLedgerReport, 'layout'> {
  /** How the file was read: one of the CSV layouts, or `json` for an array of accounts. */
  layout: CsvLedgerReport['layout'] | 'json';
  /** Identity of the export the figures were computed from. */
  input: { file: string; bytes: number; sha256: string };
}

/**
 * The asset list from a file of `symbol,decimals` lines — for an exchange
 * that lists more assets than anyone would type. A first line reading
 * `symbol,decimals` is a heading; a colon is taken for the comma. It is still
 * the exchange that states the list: nothing is taken from the balances.
 */
export function readAssetList(file: string): PorAssetSpec[] {
  const name = path.basename(file);
  const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  const body = lines.length > 0 && /^symbol\s*[,:]\s*decimals$/i.test(lines[0]!) ? lines.slice(1) : lines;
  const bad = body.find((l) => !/^[^,:\s]+\s*[,:]\s*\d+$/.test(l));
  if (bad !== undefined) throw new Error(`${name}: "${bad}" is not "symbol,decimals"`);
  const { assets, problems } = parseAssetSpecs(body.map((l) => l.replace(/\s*[,:]\s*/, ':')).join(','));
  if (problems.length > 0) throw new Error(`${name}: ${problems.join('; ')}`);
  return assets;
}

/** A JSON file larger than this is not parsed in one piece; export it as CSV instead. */
const MAX_JSON_BYTES = 512 * 1024 * 1024;

/**
 * Read and check an export written as a JSON array of accounts. `rows` is
 * empty unless `report.ok`.
 */
export function readLiabilitiesJson(file: string, o: LedgerOptions): { rows: LiabilityRow[]; report: IntakeReport } {
  const bytes = statSync(file).size;
  if (bytes > MAX_JSON_BYTES) {
    throw new Error(`${path.basename(file)} is ${Math.round(bytes / 1048576)} MB; a JSON export is read in one piece, up to ${MAX_JSON_BYTES / 1048576} MB — export a ledger this size as CSV`);
  }
  const raw = readFileSync(file);
  const input = { file: path.basename(file), bytes, sha256: createHash('sha256').update(raw).digest('hex') };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    const { report } = readAccountsJson('[]', o);
    return {
      rows: [],
      report: {
        ...report, ok: false, accounts: 0, rows: 0, problem_count: 1, input,
        problems: [{ line: 0, code: 'file_encoding', message: 'the file is not valid UTF-8; export it as UTF-8' }],
      },
    };
  }
  const { rows, report } = readAccountsJson(text, o);
  return { rows, report: { ...report, input } };
}

/**
 * Read and check an export. `rows` is empty unless `report.ok`.
 */
export async function readLiabilitiesCsv(
  file: string, o: IntakeOptions,
): Promise<{ rows: LiabilityRow[]; report: IntakeReport }> {
  const reader = new CsvLedgerReader(o);
  const hash = createHash('sha256');
  // The whole file is hashed even when reading stops early at a syntax error:
  // the checksum names the file, not the part of it that parsed.
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    reader.pushBytes(chunk);
  }
  const { rows, report } = reader.end();
  return {
    rows,
    report: { ...report, input: { file: path.basename(file), bytes: statSync(file).size, sha256: hash.digest('hex') } },
  };
}
