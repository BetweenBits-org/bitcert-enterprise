/**
 * The liability tree builder — the half of the sum-tree that runs **inside
 * the exchange**. The hash spec itself lives in `@stonehash/attest-verify`
 * (`merkle-sum.ts`): the builder imports the verifier's functions, so the
 * two sides cannot drift, and everything a third party needs to check the
 * output ships in the verification package alone.
 *
 * Mode C by construction: nothing this module produces for the platform
 * contains an account reference or a balance — the snapshot statement
 * carries the root and the totals, and individual leaves leave the machine
 * only as (a) the proof the exchange hands its own user, and (b) openings
 * for the platform's spot-check challenge, disclosed pseudonymously.
 */
import {
  addBalances, assertBalances, porEmptyNode, porLeafHash, porNodeHash,
  zeroBalances,
} from '@stonehash/attest-verify';
import type {
  PorBalances, PorInclusionProof, PorSibling, PorSumNode,
} from '@stonehash/attest-verify';

/**
 * How the tree writes what an account does not hold.
 *
 * v1 gives every leaf and every node a figure for every asset the exchange
 * lists, zeros included. That is simple and it is what the first snapshots
 * were built with — but its cost is the number of accounts times the number
 * of listed assets, whoever holds what. An exchange listing three assets
 * never notices; one listing five hundred cannot build the tree at all, and
 * exchanges do list five hundred.
 *
 * v2 writes only what is held: a leaf carries the account's non-zero
 * balances, a node the non-zero sums beneath it, the padding node nothing.
 * The hashes are computed exactly as before, over exactly what is written,
 * so the cost follows the holdings instead of the listing and the tree no
 * longer cares how many assets an exchange has or which ones they are. The
 * totals are the same totals; only the root differs, because it commits to
 * a different spelling of the same ledger.
 */
export type PorTreeAlgo = 'merkle-sum-sha256-v1' | 'merkle-sum-sha256-v2';

/** What a new snapshot is built with. A stored snapshot names its own. */
export const POR_TREE_ALGO: PorTreeAlgo = 'merkle-sum-sha256-v2';

/** The entries of `b` that are not zero. */
function held(b: PorBalances): PorBalances {
  const out: PorBalances = {};
  for (const [k, v] of Object.entries(b)) if (v !== '0') out[k] = v;
  return out;
}

export interface PorLeafInput {
  /** The exchange's internal account reference. Never leaves the machine. */
  user_ref: string;
  user_ref_hash: string;
  /** 32-byte hex, unique per user (HMAC of the master seed in the CLI). */
  salt: string;
  balances: PorBalances;
}

export interface PorTree {
  algo: PorTreeAlgo;
  assets: string[];
  leaf_count: number;
  root: string;
  /** One figure per listed asset, zero included, whichever format the tree is in. */
  totals: PorBalances;
  /** levels[0] = leaves (padded), last = [root node]. */
  levels: PorSumNode[][];
  /** user_ref → leaf index, for proof lookup. Exchange-internal. */
  index: Record<string, number>;
}

/**
 * Build the tree. Leaves are sorted by `user_ref_hash` so the structure is
 * a function of the data alone — rebuilding from the same liabilities file
 * reproduces the same root, which is what makes "we can re-derive it for
 * the auditor" a property rather than a promise.
 */
export function buildPorTree(inputs: PorLeafInput[], assets: string[], opts: { algo?: PorTreeAlgo } = {}): PorTree {
  const algo = opts.algo ?? POR_TREE_ALGO;
  if (algo !== 'merkle-sum-sha256-v1' && algo !== 'merkle-sum-sha256-v2') {
    throw new Error(`unknown tree format ${String(algo)}`);
  }
  const dense = algo === 'merkle-sum-sha256-v1';
  if (inputs.length === 0) throw new Error('no liabilities: a snapshot of nothing is not evidence');
  const seen = new Set<string>();
  const listed = new Set(assets);
  for (const i of inputs) {
    if (seen.has(i.user_ref_hash)) throw new Error(`duplicate user_ref_hash ${i.user_ref_hash.slice(0, 16)}…`);
    seen.add(i.user_ref_hash);
    for (const [a, v] of Object.entries(i.balances)) {
      // The leaf hashes the canonical JSON of the balances, and a JSON number
      // is not the same bytes as the same figure in a string: `12` and "12"
      // would add up to the same totals under two different roots.
      if (typeof v !== 'string') {
        throw new Error(`user ${i.user_ref}.${a}: a balance must be a decimal string, not a ${typeof v}`);
      }
      if (!listed.has(a)) throw new Error(`user ${i.user_ref} holds unlisted asset ${a}`);
    }
    assertBalances(i.balances, `user ${i.user_ref}`);
  }
  const sorted = [...inputs].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));

  const normalise = (b: PorBalances): PorBalances => {
    const out = zeroBalances(assets);
    for (const [k, v] of Object.entries(b)) out[k] = v;
    return out;
  };

  const leaves: PorSumNode[] = sorted.map((i) => {
    const written = dense ? normalise(i.balances) : held(i.balances);
    return { hash: porLeafHash(i.salt, i.user_ref_hash, written), sums: written };
  });
  // No prototype: an account may be called `__proto__` or `constructor`, and
  // on a plain object the first could not be stored and the second would be
  // "found" for an account that does not exist.
  const index = Object.create(null) as Record<string, number>;
  sorted.forEach((i, at) => { index[i.user_ref] = at; });

  // The padding node: a zero for every listed asset in v1, nothing in v2.
  const empty = porEmptyNode(dense ? assets : []);
  const levels: PorSumNode[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const padded = prev.length % 2 === 1 ? [...prev, empty] : prev;
    const next: PorSumNode[] = [];
    for (let i = 0; i < padded.length; i += 2) {
      const l = padded[i]!;
      const r = padded[i + 1]!;
      next.push({ hash: porNodeHash(l, r), sums: addBalances(l.sums, r.sums) });
    }
    levels.push(next);
  }
  // If the top level got padded, the stored level is the padded one so proofs
  // can read siblings positionally.
  for (let d = 0; d < levels.length - 1; d++) {
    if (levels[d]!.length % 2 === 1) levels[d] = [...levels[d]!, empty];
  }

  const rootNode = levels[levels.length - 1]![0]!;
  return {
    algo,
    assets: [...assets],
    leaf_count: inputs.length,     // real leaves, excluding padding
    root: rootNode.hash,
    // The statement names every listed asset, so an asset nobody holds reads
    // as a declared zero rather than as an omission.
    totals: { ...zeroBalances(assets), ...rootNode.sums },
    levels,
    index,
  };
}

/** Inclusion proof for one (padded) leaf position. */
export function provePorLeaf(tree: PorTree, leafIndex: number, opening: {
  user_ref_hash: string; salt: string; balances: PorBalances;
}): PorInclusionProof {
  if (leafIndex < 0 || leafIndex >= tree.leaf_count) {
    throw new Error(`leaf index ${leafIndex} out of range (0..${tree.leaf_count - 1})`);
  }
  const siblings: PorSibling[] = [];
  let at = leafIndex;
  for (let d = 0; d < tree.levels.length - 1; d++) {
    const level = tree.levels[d]!;
    const sibAt = at % 2 === 0 ? at + 1 : at - 1;
    const sib = level[sibAt]!;
    siblings.push({ hash: sib.hash, sums: sib.sums, dir: sibAt < at ? 'left' : 'right' });
    at = Math.floor(at / 2);
  }
  // The leaf as the tree wrote it, or its hash would not be the one in the tree.
  const written: PorBalances = tree.algo === 'merkle-sum-sha256-v1'
    ? { ...zeroBalances(tree.assets), ...opening.balances }
    : held(opening.balances);
  return { leaf_index: leafIndex, leaf: { ...opening, balances: written }, siblings };
}
