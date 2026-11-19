/**
 * How large a ledger this version takes, said before the work starts rather
 * than found out an hour into it.
 *
 * The tree is built in memory. Every node carries a running total for each
 * asset with something beneath it — that is what lets one inclusion proof
 * also prove the totals — so what a build costs is the number of nodes plus
 * the number of such figures. In the v2 tree a figure exists only where an
 * asset is actually held, so the cost follows the holdings: how many assets
 * an exchange lists matters only near the root, where every subtree holds
 * a little of everything. In the v1 tree every node had a figure for every
 * listed asset, and the cost was accounts × assets.
 *
 * The estimate is measured, not derived. Peak memory of a build, from
 * 20,000 to 300,000 accounts and 3 to 500 listed assets, fits
 *
 *     150 MB + nodes × 1.3 kB + figures × 80 B          (nodes = 2 × accounts)
 *
 * and errs on the high side: 100,000 accounts holding five of 500 listed
 * assets each peaked at 0.7 GB in eight seconds; 300,000 at 1.6 GB in half a
 * minute; the same 20,000 accounts took 0.2 GB in v2 and 1.1 GB in v1. The
 * estimate is compared with the heap this process may actually use, so
 * raising Node's limit (`--max-old-space-size`) raises what is accepted —
 * up to what the machine has.
 */
import v8 from 'node:v8';

const KB = 1024;
const FIXED_BYTES = 150 * KB * KB;
const NODE_BYTES = 1.3 * KB;
const FIGURE_BYTES = 80;

/**
 * How many per-asset figures a tree of this shape holds. A node spanning
 * `span` accounts has a figure for each asset one of them holds: at most
 * `held × span` of them, and never more than are listed.
 */
export function estimateTreeFigures(accounts: number, assets: number, heldPerAccount = assets): number {
  const held = Math.min(assets, Math.max(0, heldPerAccount));
  let figures = 0;
  for (let nodes = accounts, span = 1; nodes >= 1; nodes = Math.ceil(nodes / 2), span *= 2) {
    figures += nodes * Math.min(assets, held * span);
    if (nodes === 1) break;
  }
  return figures;
}

/**
 * Estimated peak bytes of memory a build of this shape needs.
 * `heldPerAccount` is the average number of assets an account holds; left
 * out, every account is taken to hold every listed asset — the worst case,
 * and exactly the v1 tree.
 */
export function estimateBuildBytes(accounts: number, assets: number, heldPerAccount = assets): number {
  return Math.ceil(FIXED_BYTES + 2 * accounts * NODE_BYTES + estimateTreeFigures(accounts, assets, heldPerAccount) * FIGURE_BYTES);
}

export interface CapacityCheck {
  ok: boolean;
  estimate_mb: number;
  available_mb: number;
  /** Accounts that fit, holding what these do, under the current heap limit. */
  max_accounts: number;
  message?: string;
}

/**
 * Whether a build of this shape fits. `heapLimitBytes` is for tests; by
 * default it is this process's own limit.
 */
export function checkCapacity(
  accounts: number, assets: number,
  heapLimitBytes = v8.getHeapStatistics().heap_size_limit, heldPerAccount = assets,
): CapacityCheck {
  // Not everything the process allocates is ours to use.
  const usable = heapLimitBytes * 0.8;
  const estimate = estimateBuildBytes(accounts, assets, heldPerAccount);
  // The estimate only grows with the number of accounts, so the largest that fits can be bisected.
  let low = 0;
  let high = 1;
  while (high < 2 ** 40 && estimateBuildBytes(high, assets, heldPerAccount) <= usable) high *= 2;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (estimateBuildBytes(mid, assets, heldPerAccount) <= usable) low = mid; else high = mid;
  }
  const mb = (n: number): number => Math.round(n / (KB * KB));
  const base = { estimate_mb: mb(estimate), available_mb: mb(usable), max_accounts: low };
  if (estimate <= usable) return { ok: true, ...base };
  const held = Math.min(assets, heldPerAccount);
  return {
    ok: false,
    ...base,
    message: `${accounts.toLocaleString('en-US')} accounts holding about ${Math.round(held * 10) / 10} of ${assets} listed asset${assets === 1 ? '' : 's'} each needs about ${mb(estimate).toLocaleString('en-US')} MB; `
      + `this process may use about ${mb(usable).toLocaleString('en-US')} MB (room for about ${low.toLocaleString('en-US')} such accounts). `
      + `Run it with more memory — NODE_OPTIONS=--max-old-space-size=${Math.ceil(mb(estimate) * 1.3 / 1024) * 1024} — on a machine that has it.`,
  };
}
