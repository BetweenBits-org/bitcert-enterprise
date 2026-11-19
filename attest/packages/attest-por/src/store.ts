/**
 * The exchange's private record of a snapshot: what it keeps, and how it is
 * read back.
 *
 * A snapshot is only useful to a customer for as long as the exchange can
 * still issue that customer's proof, and a proof needs the leaf's salt and
 * its neighbours all the way up. So a build leaves behind, in a directory the
 * exchange keeps:
 *
 *   snapshot.json   the statement — root and totals. The only part that is
 *                   ever sent anywhere.
 *   leaves.jsonl    one line per account, in tree order: its identifier, its
 *                   hash, its salt, its balances. Private; mode 0600.
 *   seed.hex        the secret every salt was derived from. Private; 0600.
 *   tree.json       a small header naming the root and the leaves file.
 *
 * The tree itself is not stored. It is a function of the leaves, so it is
 * rebuilt when a proof is needed — and the rebuilt root is compared with the
 * one in the header before anything is issued from it. A leaves file that was
 * edited, truncated or mixed up with another day's fails that comparison
 * instead of producing proofs that do not verify.
 *
 * Storing only the leaves is also what lets a large ledger through: the
 * stored tree was several times the size of the leaves and had to pass
 * through a single string, which caps a file well below what memory allows.
 * Lines are written and read one at a time.
 *
 * Directories written by the first version of the tool (one `tree.json`
 * holding everything) are still read.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { PorBalances } from '@stonehash/attest-verify';
import { buildPorTree } from './sumtree.ts';
import type { PorLeafInput, PorTree, PorTreeAlgo } from './sumtree.ts';

export interface TreeHeader {
  schema: 'stonehash.por-tree.v2';
  /** The tree format the root was built in. Absent on directories written before there were two: those are v1. */
  algo?: PorTreeAlgo;
  exchange_id: string;
  assets: string[];
  leaf_count: number;
  root: string;
  totals: PorBalances;
  leaves_file: 'leaves.jsonl';
  /** SHA-256 of the leaves file as written. */
  leaves_sha256: string;
}

interface LegacyTreeFile {
  schema: 'stonehash.por-tree.v1';
  exchange_id: string;
  tree: PorTree;
  leaves: PorLeafInput[];
}

export interface LoadedTree {
  exchangeId: string;
  tree: PorTree;
  /** In tree order: `leaves[i]` is the leaf at index `i`. */
  leaves: PorLeafInput[];
}

const byHash = (a: PorLeafInput, b: PorLeafInput): number => (a.user_ref_hash < b.user_ref_hash ? -1 : 1);

/** A leaf as stored: zero balances are implied, so they are not written. */
function storedLeaf(leaf: PorLeafInput): string {
  const balances: PorBalances = {};
  for (const [asset, v] of Object.entries(leaf.balances)) if (v !== '0') balances[asset] = v;
  return JSON.stringify({ user_ref: leaf.user_ref, user_ref_hash: leaf.user_ref_hash, salt: leaf.salt, balances });
}

/**
 * Write the private files for a tree that has just been built. Returns the
 * leaves in tree order.
 */
export async function writeTreeDir(dir: string, exchangeId: string, tree: PorTree, leaves: PorLeafInput[]): Promise<PorLeafInput[]> {
  const sorted = [...leaves].sort(byHash);
  const leavesPath = path.join(dir, 'leaves.jsonl');
  const hash = createHash('sha256');
  const out = createWriteStream(leavesPath, { mode: 0o600 });
  // A full disk surfaces as an 'error' event, after which 'drain' never comes;
  // racing each wait against it turns a hang into the error it is.
  const failed = new Promise<never>((_, reject) => { out.once('error', reject); });
  failed.catch(() => { /* reported through the race below */ });
  for (const leaf of sorted) {
    const line = storedLeaf(leaf) + '\n';
    hash.update(line);
    // Respect back-pressure: a million lines written without waiting would
    // queue the whole file in memory first.
    if (!out.write(line)) await Promise.race([once(out, 'drain'), failed]);
  }
  out.end();
  await Promise.race([once(out, 'finish'), failed]);
  // The mode at creation is subject to the umask; state it outright.
  chmodSync(leavesPath, 0o600);

  const header: TreeHeader = {
    schema: 'stonehash.por-tree.v2',
    // A v1 directory is written exactly as it always was; v2 names itself.
    ...(tree.algo === 'merkle-sum-sha256-v1' ? {} : { algo: tree.algo }),
    exchange_id: exchangeId,
    assets: tree.assets,
    leaf_count: tree.leaf_count,
    root: tree.root,
    totals: tree.totals,
    leaves_file: 'leaves.jsonl',
    leaves_sha256: hash.digest('hex'),
  };
  writeFileSync(path.join(dir, 'tree.json'), JSON.stringify(header, null, 2) + '\n');
  chmodSync(path.join(dir, 'tree.json'), 0o600);
  return sorted;
}

async function readLeaves(file: string): Promise<{ leaves: PorLeafInput[]; sha256: string }> {
  const hash = createHash('sha256');
  const leaves: PorLeafInput[] = [];
  const stream = createReadStream(file);
  stream.on('data', (chunk) => { hash.update(chunk); });
  let n = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    n++;
    if (line === '') continue;
    let leaf: PorLeafInput;
    try {
      leaf = JSON.parse(line) as PorLeafInput;
    } catch {
      throw new Error(`${path.basename(file)} line ${n} is not JSON; the file is damaged`);
    }
    leaves.push(leaf);
  }
  return { leaves, sha256: hash.digest('hex') };
}

/**
 * Read a snapshot directory back and rebuild its tree.
 *
 * Refuses when the leaves do not reproduce the recorded root: issuing a proof
 * from a tree that is not the anchored one would hand a customer a file that
 * fails, and leave them to conclude the exchange left them out.
 */
export async function loadTreeDir(dir: string): Promise<LoadedTree> {
  const headerPath = path.join(dir, 'tree.json');
  if (!existsSync(headerPath)) throw new Error(`${dir} has no tree.json; point --tree at the directory "build" wrote`);
  const header = JSON.parse(readFileSync(headerPath, 'utf8')) as TreeHeader | LegacyTreeFile;

  if (header.schema === 'stonehash.por-tree.v1') {
    return { exchangeId: header.exchange_id, tree: { ...header.tree, algo: 'merkle-sum-sha256-v1' }, leaves: header.leaves };
  }
  if (header.schema !== 'stonehash.por-tree.v2') {
    throw new Error(`${headerPath} is not a tree header this version reads`);
  }
  const { leaves, sha256 } = await readLeaves(path.join(dir, header.leaves_file));
  if (sha256 !== header.leaves_sha256) {
    throw new Error('leaves.jsonl is not the file this snapshot was built from (its checksum differs from the one recorded in tree.json)');
  }
  // Rebuilt in the format it was built in: the same leaves under the other
  // format are a different root, and would be refused as damaged.
  const tree = buildPorTree(leaves, header.assets, { algo: header.algo ?? 'merkle-sum-sha256-v1' });
  if (tree.root !== header.root || tree.leaf_count !== header.leaf_count) {
    throw new Error('the leaves do not reproduce the recorded root; refusing to issue anything from them');
  }
  return { exchangeId: header.exchange_id, tree, leaves: [...leaves].sort(byHash) };
}
