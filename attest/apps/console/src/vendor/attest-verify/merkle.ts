/**
 * RFC 6962 Merkle inclusion — bundle-schema.md §3 (link B).
 *
 *   H_leaf(d)    = SHA-256(0x00 || d)
 *   H_node(l, r) = SHA-256(0x01 || l || r)
 *
 * The domain tags make leaf and inner-node preimages disjoint, which is what
 * blocks second-preimage attacks on the tree.
 *
 * Note this module only *verifies* an inclusion proof. Building a tree is the
 * producer's job (duplicate-last-leaf rule, single-leaf exception, duplicate-leaf
 * rejection) and lives in the Attest Core, not in the independent verifier —
 * a verifier that rebuilt the tree the producer's way could agree with a
 * producer bug.
 */
import { sha256 } from './sha256.ts';
import { bytesToHex, concat, hexToBytes } from './bytes.ts';

const LEAF_TAG = /* @__PURE__ */ new Uint8Array([0x00]);
const NODE_TAG = /* @__PURE__ */ new Uint8Array([0x01]);

/** `H_leaf(d) = SHA-256(0x00 || d)`. */
export function leafHash(d: Uint8Array): Uint8Array {
  return sha256(concat(LEAF_TAG, d));
}

/** `H_node(l, r) = SHA-256(0x01 || l || r)`. Order is load-bearing. */
export function nodeHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(concat(NODE_TAG, l, r));
}

export type Direction = 'left' | 'right';

export interface MerkleSection {
  root: string;
  siblings: string[];
  /** Position of each sibling, not of the current node. */
  directions: Direction[];
  leaf_index?: number;
}

export interface MerkleResult {
  /** Root recomputed from `leafBytes` and the proof path. */
  computedRoot: string;
  /** `true` iff the recomputed root equals the claimed `merkle.root`. */
  ok: boolean;
}

/**
 * Fold `leafBytesHex` up through the proof path and compare with `m.root`.
 * Throws on a malformed proof (wrong digest length, length mismatch, bad
 * direction) — a malformed proof is a different failure from a wrong one and
 * the caller reports it differently.
 */
export function verifyInclusion(leafBytesHex: string, m: MerkleSection): MerkleResult {
  const leaf = hexToBytes(leafBytesHex);
  if (leaf.length !== 32) throw new Error(`leaf_bytes must be 32 bytes, got ${leaf.length}`);
  if (!Array.isArray(m.siblings) || !Array.isArray(m.directions)) {
    throw new Error('merkle.siblings and merkle.directions must be arrays');
  }
  if (m.siblings.length !== m.directions.length) {
    throw new Error(`siblings/directions length mismatch: ${m.siblings.length} vs ${m.directions.length}`);
  }
  let cur = leafHash(leaf);
  for (let i = 0; i < m.siblings.length; i++) {
    const sib = hexToBytes(m.siblings[i]!);
    if (sib.length !== 32) throw new Error(`sibling ${i} is not 32 bytes`);
    const dir = m.directions[i];
    if (dir === 'left') cur = nodeHash(sib, cur);
    else if (dir === 'right') cur = nodeHash(cur, sib);
    else throw new Error(`direction ${i} must be "left" or "right", got ${JSON.stringify(dir)}`);
  }
  const computedRoot = bytesToHex(cur);
  return { computedRoot, ok: computedRoot === String(m.root ?? '').toLowerCase() };
}
