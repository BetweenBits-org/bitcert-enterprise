/**
 * Merkle tree builder — the producer half of bundle-schema.md §3.
 *
 * Written independently of `@stonehash/attest-verify`. The verifier must never
 * share code with the producer: if one implementation both built and checked the
 * tree, a bug would cancel itself out and "independently verifiable" would be a
 * slogan. `test/roundtrip.test.ts` asserts the two agree on real bundles.
 *
 * ## Hashing — RFC 6962 §2.1
 *
 *   H_leaf(d)    = SHA-256(0x00 || d)
 *   H_node(l, r) = SHA-256(0x01 || l || r)
 *
 * ## Two deliberate deviations from strict RFC 6962
 *
 * 1. **Duplicate-last-leaf.** On an odd level the last node pairs with itself
 *    rather than being promoted. This is the Bitcoin Core convention for block
 *    Merkle roots and it makes every level a power of two, which keeps proof
 *    construction uniform.
 * 2. **Duplicate-leaf rejection.** Two byte-equal leaves would make
 *    `proof(index)` ambiguous — two indices with the same path — and stateless
 *    verification would become undecidable. Building such a tree is refused
 *    outright rather than producing proofs that cannot be trusted.
 *
 * A single-leaf tree is `root = H_leaf(leaf)` with no self-pairing, per
 * RFC 6962 §2.1.
 */
import { createHash } from 'node:crypto';

export type Direction = 'left' | 'right';

export interface InclusionProof {
  leafIndex: number;
  root: string;
  siblings: string[];
  directions: Direction[];
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

const LEAF_TAG = new Uint8Array([0x00]);
const NODE_TAG = new Uint8Array([0x01]);

export function leafHash(d: Uint8Array): Uint8Array {
  return sha256(LEAF_TAG, d);
}
export function nodeHash(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(NODE_TAG, l, r);
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export class MerkleTree {
  /** Level 0 is the leaf-hash row; the last level holds the single root. */
  private readonly levels: Uint8Array[][];
  readonly leafCount: number;

  private constructor(levels: Uint8Array[][], leafCount: number) {
    this.levels = levels;
    this.leafCount = leafCount;
  }

  /**
   * Build from 32-byte leaf pre-images (`leaf_bytes`, not leaf hashes).
   * Throws on an empty set, a wrong-length leaf, or any duplicate.
   */
  static fromLeaves(leaves: Uint8Array[]): MerkleTree {
    if (leaves.length === 0) throw new Error('cannot build a Merkle tree with no leaves');
    const seen = new Set<string>();
    for (const [i, l] of leaves.entries()) {
      if (l.length !== 32) throw new Error(`leaf ${i} must be 32 bytes, got ${l.length}`);
      const k = hex(l);
      if (seen.has(k)) throw new Error(`duplicate leaf at index ${i} makes inclusion proofs ambiguous`);
      seen.add(k);
    }

    const levels: Uint8Array[][] = [leaves.map(leafHash)];
    while (levels[levels.length - 1]!.length > 1) {
      const prev = levels[levels.length - 1]!;
      const next: Uint8Array[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        const l = prev[i]!;
        // Duplicate-last-leaf: an unpaired node pairs with itself.
        const r = i + 1 < prev.length ? prev[i + 1]! : l;
        next.push(nodeHash(l, r));
      }
      levels.push(next);
    }
    return new MerkleTree(levels, leaves.length);
  }

  root(): Uint8Array {
    return this.levels[this.levels.length - 1]![0]!;
  }
  rootHex(): string {
    return hex(this.root());
  }

  /**
   * Inclusion proof for `index`, shaped exactly as the bundle schema expects:
   * `directions[i]` is the position of `siblings[i]`, not of the current node.
   */
  proof(index: number): InclusionProof {
    if (!Number.isInteger(index) || index < 0 || index >= this.leafCount) {
      throw new Error(`leaf index ${index} out of range (0..${this.leafCount - 1})`);
    }
    const siblings: string[] = [];
    const directions: Direction[] = [];
    let i = index;
    for (let lv = 0; lv < this.levels.length - 1; lv++) {
      const level = this.levels[lv]!;
      const isRight = i % 2 === 1;
      const sibIdx = isRight ? i - 1 : i + 1;
      // On an odd level the last node was paired with itself, so its sibling is
      // itself — emitting the node again is what lets the verifier reproduce the
      // same fold without knowing the tree width.
      const sib = sibIdx < level.length ? level[sibIdx]! : level[i]!;
      siblings.push(hex(sib));
      directions.push(isRight ? 'left' : 'right');
      i = Math.floor(i / 2);
    }
    return { leafIndex: index, root: this.rootHex(), siblings, directions };
  }
}
