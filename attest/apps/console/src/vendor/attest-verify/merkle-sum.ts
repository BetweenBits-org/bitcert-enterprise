/**
 * Merkle **sum** tree — the proof-of-reserves liability commitment.
 *
 * Every node carries a hash *and* a per-asset sum vector, and the hash covers
 * the child sums, so one 32-byte root commits simultaneously to the set of
 * leaves and to the arithmetic total of every asset. A user who verifies
 * their inclusion proof therefore checks two things at once: that their
 * balance is in the tree, and that the tree's declared totals actually
 * include it — understating liabilities breaks the root, not just a number
 * in a PDF.
 *
 * This file is the **specification**: the builder in `@stonehash/attest-por`
 * imports these functions rather than agreeing with them, and the browser
 * verification page compiles this exact source. Synchronous and
 * dependency-free for the same reason as the rest of this package.
 *
 * ## Shapes
 *
 * - Balances are **non-negative integer strings** in each asset's base unit
 *   (sats, wei, micro-USDT). Integers because sums must be exact; strings
 *   because JS numbers are not; non-negative because a negative leaf is the
 *   classic way to fake solvency and is rejected everywhere it could enter.
 * - leaf  = SHA256("STONEHASH-POR-LEAF-V1\n" ‖ salt ‖ user_ref_hash ‖ JCS(balances))
 * - node  = SHA256("STONEHASH-POR-NODE-V1\n" ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums))
 * - empty = SHA256("STONEHASH-POR-EMPTY-V1") with all-zero sums — the padding
 *   node for odd levels. Padding, not duplication: duplicating the last leaf
 *   (Bitcoin-style) would double-count its balance in the parent sum.
 * - user_ref_hash = SHA256("STONEHASH-POR-USER-V1\n" + exchange_id + "\n" + user_ref)
 *   — pseudonymous and deterministic per exchange, so the leaf never carries
 *   the raw account reference.
 */
import { sha256 } from './sha256.ts';
import { jcs } from './jcs.ts';
import { bytesToHex, hexToBytes, utf8, concat } from './bytes.ts';

export type PorBalances = Record<string, string>;

export interface PorSumNode {
  /** 64 lowercase hex. */
  hash: string;
  /** Per-asset non-negative integer strings. Same key set tree-wide. */
  sums: PorBalances;
}

export type PorDirection = 'left' | 'right';

export interface PorSibling extends PorSumNode {
  /** Which side the **sibling** sits on. */
  dir: PorDirection;
}

export interface PorLeafOpening {
  user_ref_hash: string;
  /** 64 hex chars (32 bytes). Held by the exchange, disclosed to its owner. */
  salt: string;
  balances: PorBalances;
}

export interface PorInclusionProof {
  leaf_index: number;
  leaf: PorLeafOpening;
  siblings: PorSibling[];
}

const LEAF_DOMAIN = 'STONEHASH-POR-LEAF-V1\n';
const NODE_DOMAIN = 'STONEHASH-POR-NODE-V1\n';
const EMPTY_DOMAIN = 'STONEHASH-POR-EMPTY-V1';
const USER_DOMAIN = 'STONEHASH-POR-USER-V1\n';

const INT = /^(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * `b[k]` — but only when `b` itself has it.
 *
 * An asset is whatever an exchange calls it, and a balances object is a plain
 * object: asked for `constructor` or `toString`, one that does not hold that
 * asset answers with the function every object inherits. While every object
 * carried every asset that could not happen; in a tree that writes only what
 * is held it is the ordinary case.
 */
const held = (b: PorBalances, k: string): string => (Object.hasOwn(b, k) ? b[k]! : '0');

export function assertBalances(b: PorBalances, where = 'balances'): void {
  for (const [asset, v] of Object.entries(b)) {
    // The one name a plain object cannot hold as an entry: a figure filed
    // under it would be hashed and then silently left out of every sum.
    if (asset === '__proto__') throw new Error(`${where}: "__proto__" is not an asset name`);
    if (!INT.test(v)) {
      throw new Error(`${where}.${asset}: "${v}" is not a non-negative integer string`);
    }
  }
}

/** a + b per asset, over the union of keys. Exact. */
export function addBalances(a: PorBalances, b: PorBalances): PorBalances {
  const out: PorBalances = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = (BigInt(held(a, k)) + BigInt(held(b, k))).toString();
  }
  return out;
}

export function zeroBalances(assets: readonly string[]): PorBalances {
  const out: PorBalances = {};
  for (const a of assets) out[a] = '0';
  return out;
}

export function porUserRefHash(exchangeId: string, userRef: string): string {
  return bytesToHex(sha256(utf8(`${USER_DOMAIN}${exchangeId}\n${userRef}`)));
}

export function porLeafHash(saltHex: string, userRefHashHex: string, balances: PorBalances): string {
  if (!HEX64.test(saltHex)) throw new Error('salt must be 64 lowercase hex chars');
  if (!HEX64.test(userRefHashHex)) throw new Error('user_ref_hash must be 64 lowercase hex chars');
  assertBalances(balances);
  return bytesToHex(sha256(concat(
    utf8(LEAF_DOMAIN), hexToBytes(saltHex), hexToBytes(userRefHashHex), jcs(balances),
  )));
}

export function porNodeHash(left: PorSumNode, right: PorSumNode): string {
  return bytesToHex(sha256(concat(
    utf8(NODE_DOMAIN),
    hexToBytes(left.hash), hexToBytes(right.hash),
    jcs(left.sums), jcs(right.sums),
  )));
}

export function porEmptyNode(assets: readonly string[]): PorSumNode {
  return { hash: bytesToHex(sha256(utf8(EMPTY_DOMAIN))), sums: zeroBalances(assets) };
}

export interface PorVerifyExpectation {
  root: string;
  totals: PorBalances;
}

export interface PorVerifyResult {
  ok: boolean;
  computedRoot: string;
  computedTotals: PorBalances;
  /** Human-readable failures; empty when ok. */
  problems: string[];
}

/**
 * Verify one inclusion proof against a declared root **and totals**.
 *
 * The totals comparison is not a nicety: the sum vector that arrives at the
 * root is recomputed from the leaf and the siblings, so it equals the
 * declared liabilities only if every sibling's sums were honest inputs to
 * every hash on the path. A root that matches with different totals means
 * the statement lied about one or the other.
 *
 * The index is cross-checked against the sibling directions (bit i of the
 * index says which child the path node was at level i), so a valid proof
 * cannot be replayed as evidence for a different position.
 */
export function verifyPorInclusion(
  proof: PorInclusionProof, expected: PorVerifyExpectation,
): PorVerifyResult {
  const problems: string[] = [];
  let node: PorSumNode;
  try {
    assertBalances(proof.leaf.balances, 'leaf.balances');
    node = {
      hash: porLeafHash(proof.leaf.salt, proof.leaf.user_ref_hash, proof.leaf.balances),
      sums: { ...proof.leaf.balances },
    };
  } catch (e) {
    return {
      ok: false, computedRoot: '', computedTotals: {},
      problems: [e instanceof Error ? e.message : String(e)],
    };
  }

  for (const [level, sib] of proof.siblings.entries()) {
    if (!HEX64.test(sib.hash)) problems.push(`sibling[${level}].hash is not 64 hex chars`);
    try {
      assertBalances(sib.sums, `sibling[${level}].sums`);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    const expectedBit = (proof.leaf_index >> level) & 1;
    const impliedBit = sib.dir === 'left' ? 1 : 0; // sibling on the left ⇒ we are the right child
    if (expectedBit !== impliedBit) {
      problems.push(`sibling[${level}].dir contradicts leaf_index ${proof.leaf_index}`);
    }
    node = sib.dir === 'left'
      ? { hash: porNodeHash(sib, node), sums: addBalances(sib.sums, node.sums) }
      : { hash: porNodeHash(node, sib), sums: addBalances(node.sums, sib.sums) };
  }

  if (node.hash !== expected.root) {
    problems.push(`computed root ${node.hash.slice(0, 16)}… ≠ declared ${expected.root.slice(0, 16)}…`);
  }
  for (const k of new Set([...Object.keys(node.sums), ...Object.keys(expected.totals)])) {
    if (held(node.sums, k) !== held(expected.totals, k)) {
      problems.push(`computed total ${k}=${held(node.sums, k)} ≠ declared ${held(expected.totals, k)}`);
    }
  }
  return { ok: problems.length === 0, computedRoot: node.hash, computedTotals: node.sums, problems };
}

export const POR_SNAPSHOT_DOMAIN = 'STONEHASH-POR-V1\n';

/** Commitment that reaches the chain: SHA256(domain ‖ JCS(statement)). */
export function porSnapshotCommitment(statement: unknown): string {
  return bytesToHex(sha256(concat(utf8(POR_SNAPSHOT_DOMAIN), jcs(statement as never))));
}
