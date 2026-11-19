/**
 * Reading a balance file, apart from any screen.
 *
 * Two screens read one: 준비금 증명 builds a snapshot from it, and 검증 rebuilds
 * the snapshot a proof file states. Both have to read it the same way — the
 * SDK's readers, the same limits — or a file that anchored would fail its own
 * check. So the reading lives here, with nothing of a page in it: no text for
 * a reader, no element, no request. It can be run where there is no browser,
 * which is how it is tested.
 */
import { CsvLedgerReader } from './vendor/attest-por/ledger.ts';
import type { IntakeOptions, LedgerReport, LiabilityRow } from './vendor/attest-por/ledger.ts';
import { readAccountsJson } from './vendor/attest-por/accounts-json.ts';

/**
 * A page builds the tree on the thread that draws it. The work is one hash
 * per node and one sum per asset that someone beneath the node holds — so
 * what an exchange lists but few accounts hold costs next to nothing, and
 * the limit is on the sums, not on accounts × listed assets. Measured in
 * the console: 100,000 accounts of three assets, all held, take about seven
 * seconds; 40,000 accounts over 500 listed assets, five held each, about
 * five. Beyond these the screen would sit frozen, and the SDK is the tool.
 */
export const MAX_ACCOUNTS = 100_000;
export const MAX_TREE_SUMS = 4_000_000;

/**
 * The most sums the tree can carry. A level carries no more than its nodes
 * times the assets, and no more than the balances there are to add up.
 */
export function treeSums(rows: LiabilityRow[], assets: number): number {
  let held = 0;
  for (const r of rows) for (const amount of Object.values(r.balances)) if (amount !== '0') held++;
  let width = 1;
  while (width < rows.length) width *= 2;
  let sums = 0;
  for (let nodes = width; nodes >= 1; nodes /= 2) sums += Math.min(nodes * assets, held);
  return sums;
}

/** Whether a file's text is JSON rather than CSV: an array of accounts opens with a bracket. */
export const looksLikeJson = (text: string): boolean => /^[\uFEFF\s]*[\[{]/.test(text);

/** Read a balance file with the SDK's own reader: the JSON one for an array of accounts, the CSV one otherwise. */
export function readLedger(bytes: Uint8Array, text: string, json: boolean, o: IntakeOptions): { rows: LiabilityRow[]; report: LedgerReport; shape: string } {
  if (json) {
    const read = readAccountsJson(text, { assets: o.assets, amounts: o.amounts, maxAccounts: MAX_ACCOUNTS });
    return { rows: read.rows, report: read.report, shape: read.report.layout };
  }
  const reader = new CsvLedgerReader({ ...o, maxAccounts: MAX_ACCOUNTS });
  // In pieces, so a large export is never held as one more decoded string.
  for (let at = 0; at < bytes.length; at += 1 << 20) reader.pushBytes(bytes.subarray(at, at + (1 << 20)));
  const read = reader.end();
  return { rows: read.rows, report: read.report, shape: read.report.layout ?? '' };
}
