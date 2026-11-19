package com.stonehash.attest.core.format;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Merkle tree builder — the producer half of bundle-schema.md §3.
 *
 * <p>Written independently of every verifier ({@code attest-verify}, the
 * SDK's {@code AnchorProof}). The verifier must never share code with the
 * producer: if one implementation both built and checked the tree, a bug
 * would cancel itself out and "independently verifiable" would be a slogan.
 *
 * <h2>Hashing — RFC 6962 §2.1</h2>
 *
 * <pre>
 *   H_leaf(d)    = SHA-256(0x00 || d)
 *   H_node(l, r) = SHA-256(0x01 || l || r)
 * </pre>
 *
 * <h2>Two deliberate deviations from strict RFC 6962</h2>
 * <ol>
 * <li><b>Duplicate-last-leaf.</b> On an odd level the last node pairs with
 *     itself rather than being promoted — the Bitcoin Core convention for
 *     block Merkle roots — which keeps proof construction uniform.
 * <li><b>Duplicate-leaf rejection.</b> Two byte-equal leaves would make a
 *     proof ambiguous — two indices with the same path. Building such a tree
 *     is refused outright rather than producing proofs that cannot be trusted.
 * </ol>
 *
 * A single-leaf tree is {@code root = H_leaf(leaf)} with no self-pairing.
 */
public final class Merkle {
    private static final byte[] LEAF_TAG = { 0x00 };
    private static final byte[] NODE_TAG = { 0x01 };

    /** An inclusion proof, shaped as the bundle schema expects it. */
    public static final class Proof {
        public final int leafIndex;
        public final String root;
        public final List<String> siblings;
        /** {@code directions[i]} is where {@code siblings[i]} stands — {@code left} or {@code right} — not where the current node does. */
        public final List<String> directions;

        /** A proof as it was stored when its batch was sealed. */
        public Proof(int leafIndex, String root, List<String> siblings, List<String> directions) {
            this.leafIndex = leafIndex;
            this.root = root;
            this.siblings = siblings;
            this.directions = directions;
        }
    }

    /** Level 0 is the row of leaf hashes; the last level holds the single root. */
    private final List<byte[][]> levels;
    public final int leafCount;

    private Merkle(List<byte[][]> levels, int leafCount) {
        this.levels = levels;
        this.leafCount = leafCount;
    }

    public static byte[] leafHash(byte[] d) {
        return Hex.sha256(LEAF_TAG, d);
    }

    public static byte[] nodeHash(byte[] l, byte[] r) {
        return Hex.sha256(NODE_TAG, l, r);
    }

    /**
     * Build from 32-byte leaf pre-images ({@code leaf_bytes}, not leaf hashes).
     *
     * @throws IllegalArgumentException on an empty set, a leaf of the wrong length, or any duplicate
     */
    public static Merkle fromLeaves(List<byte[]> leaves) {
        if (leaves.isEmpty()) {
            throw new IllegalArgumentException("cannot build a Merkle tree with no leaves");
        }
        Set<String> seen = new HashSet<>();
        byte[][] row = new byte[leaves.size()][];
        for (int i = 0; i < leaves.size(); i++) {
            byte[] l = leaves.get(i);
            if (l.length != 32) {
                throw new IllegalArgumentException("leaf " + i + " must be 32 bytes, got " + l.length);
            }
            if (!seen.add(Hex.encode(l))) {
                throw new IllegalArgumentException("duplicate leaf at index " + i + " makes inclusion proofs ambiguous");
            }
            row[i] = leafHash(l);
        }
        List<byte[][]> levels = new ArrayList<>();
        levels.add(row);
        while (levels.get(levels.size() - 1).length > 1) {
            byte[][] prev = levels.get(levels.size() - 1);
            byte[][] next = new byte[(prev.length + 1) / 2][];
            for (int i = 0; i < prev.length; i += 2) {
                // Duplicate-last-leaf: an unpaired node pairs with itself.
                next[i / 2] = nodeHash(prev[i], i + 1 < prev.length ? prev[i + 1] : prev[i]);
            }
            levels.add(next);
        }
        return new Merkle(levels, leaves.size());
    }

    public byte[] root() {
        return levels.get(levels.size() - 1)[0];
    }

    public String rootHex() {
        return Hex.encode(root());
    }

    /** The inclusion proof for the leaf at {@code index}. */
    public Proof proof(int index) {
        if (index < 0 || index >= leafCount) {
            throw new IllegalArgumentException("leaf index " + index + " out of range (0.." + (leafCount - 1) + ")");
        }
        List<String> siblings = new ArrayList<>();
        List<String> directions = new ArrayList<>();
        int i = index;
        for (int lv = 0; lv < levels.size() - 1; lv++) {
            byte[][] level = levels.get(lv);
            boolean isRight = i % 2 == 1;
            int sibling = isRight ? i - 1 : i + 1;
            // On an odd level the last node was paired with itself, so its sibling is itself:
            // emitting the node again lets the verifier fold without knowing the tree's width.
            siblings.add(Hex.encode(sibling < level.length ? level[sibling] : level[i]));
            directions.add(isRight ? "left" : "right");
            i /= 2;
        }
        return new Proof(index, rootHex(), siblings, directions);
    }
}
