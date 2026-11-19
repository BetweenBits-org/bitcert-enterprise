package com.stonehash.attest.por;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * An inclusion proof: one leaf, and the node beside the path at every level
 * up to the root (specification §5).
 *
 * <p>Every node carries a hash <em>and</em> a sum per asset, and each hash
 * covers the sums below it. Checking a proof therefore checks two things at
 * once: that the leaf is in the tree, and that the tree's declared totals
 * include it. Understating liabilities breaks the root, not just a figure in
 * a report.
 *
 * <p>The same object serves two readers. Handed to the customer it carries
 * their account reference; opened to the platform for a spot check it never
 * does — see {@link #withoutUserRef()}.
 */
public final class InclusionProof {
    /**
     * A snapshot holds at most 2^31 - 1 leaves, so no proof has more than 31
     * levels below the root.
     */
    private static final int MAX_SIBLINGS = 31;
    private static final String CODE = "invalid_proof";

    private final int leafIndex;
    private final Leaf leaf;
    private final List<Sibling> siblings;

    InclusionProof(int leafIndex, Leaf leaf, List<Sibling> siblings) {
        this.leafIndex = leafIndex;
        this.leaf = leaf;
        this.siblings = Collections.unmodifiableList(siblings);
    }

    /** The opened leaf: who (pseudonymously), the salt, and every asset's balance. */
    public static final class Leaf {
        private final String userRef;
        private final String userRefHash;
        private final String salt;
        private final Map<String, BigInteger> balances;

        Leaf(String userRef, String userRefHash, String salt, Map<String, BigInteger> balances) {
            this.userRef = userRef;
            this.userRefHash = userRefHash;
            this.salt = salt;
            this.balances = Collections.unmodifiableMap(balances);
        }

        /** The account reference, present only in a proof issued to the account's owner; otherwise null. */
        public String userRef() {
            return userRef;
        }

        public String userRefHash() {
            return userRefHash;
        }

        public String salt() {
            return salt;
        }

        /** One entry per asset of the snapshot, zero where the account holds none. */
        public Map<String, BigInteger> balances() {
            return balances;
        }
    }

    /** The node beside the path at one level: its hash, its sums, and which side it is on. */
    public static final class Sibling {
        private final String hash;
        private final Map<String, BigInteger> sums;
        private final boolean left;

        Sibling(String hash, Map<String, BigInteger> sums, boolean left) {
            this.hash = hash;
            this.sums = Collections.unmodifiableMap(sums);
            this.left = left;
        }

        public String hash() {
            return hash;
        }

        public Map<String, BigInteger> sums() {
            return sums;
        }

        /** {@code "left"} or {@code "right"}: the side the <em>sibling</em> is on. */
        public String dir() {
            return left ? "left" : "right";
        }
    }

    /** The leaf's position in the tree's order (ascending {@code user_ref_hash}). */
    public int leafIndex() {
        return leafIndex;
    }

    public Leaf leaf() {
        return leaf;
    }

    /** From the leaf level upward, one per level below the root. */
    public List<Sibling> siblings() {
        return siblings;
    }

    /** The same proof with the account reference removed: the only form that may leave the exchange. */
    public InclusionProof withoutUserRef() {
        return leaf.userRef == null ? this
                : new InclusionProof(leafIndex, new Leaf(null, leaf.userRefHash, leaf.salt, leaf.balances), siblings);
    }

    /**
     * Checks this proof against a declared root <em>and totals</em>.
     *
     * <p>The totals comparison is not a nicety: the sums that arrive at the
     * root are recomputed from the leaf and the siblings, so they equal the
     * declared liabilities only if every sibling's sums were honest inputs to
     * every hash on the path. The index is checked against the sibling sides,
     * so a proof cannot be replayed as evidence for another position.
     */
    public ProofVerification verify(String root, Map<String, BigInteger> totals) {
        Objects.requireNonNull(root, "root");
        Objects.requireNonNull(totals, "totals");
        List<String> problems = new ArrayList<>();
        byte[] hash = new byte[Leaves.SEED_BYTES];
        Map<String, BigInteger> sums = new LinkedHashMap<>(leaf.balances);
        try {
            Hex.decodeInto(Leaves.leafHash(leaf.salt, leaf.userRefHash, leaf.balances), hash, 0, hash.length);
            MessageDigest sha = Hex.sha256();
            byte[] other = new byte[Leaves.SEED_BYTES];
            for (int level = 0; level < siblings.size(); level++) {
                Sibling s = siblings.get(level);
                // A sibling on the left means the path node is the right child, which is what a set bit says.
                if (((leafIndex >>> level) & 1) != (s.left ? 1 : 0)) {
                    problems.add("sibling[" + level + "].dir contradicts leaf_index " + leafIndex);
                }
                Hex.decodeInto(s.hash, other, 0, other.length);
                sha.update(Leaves.NODE_DOMAIN);
                sha.update(s.left ? other : hash);
                sha.update(s.left ? hash : other);
                sha.update(Leaves.canonicalSums(s.left ? s.sums : sums));
                sha.update(Leaves.canonicalSums(s.left ? sums : s.sums));
                hash = sha.digest();
                sums = add(sums, s.sums);
            }
        } catch (PorException e) {
            // A key that cannot be hashed (an unpaired surrogate): not a proof of anything.
            problems.add(e.getMessage());
            return new ProofVerification("", Collections.emptyMap(), problems);
        }

        String computedRoot = Hex.encode(hash);
        if (!computedRoot.equals(root)) {
            problems.add("computed root " + computedRoot.substring(0, 16) + "… ≠ declared "
                    + (root.length() > 16 ? root.substring(0, 16) + "…" : root));
        }
        Set<String> assets = new LinkedHashSet<>(sums.keySet());
        assets.addAll(totals.keySet());
        for (String asset : assets) {
            BigInteger computed = sums.getOrDefault(asset, BigInteger.ZERO);
            BigInteger declared = totals.get(asset) == null ? BigInteger.ZERO : totals.get(asset);
            if (!computed.equals(declared)) {
                problems.add("computed total " + asset + "=" + computed + " ≠ declared " + declared);
            }
        }
        return new ProofVerification(computedRoot, sums, problems);
    }

    /** a + b per asset, over the union of their assets. */
    private static Map<String, BigInteger> add(Map<String, BigInteger> a, Map<String, BigInteger> b) {
        Map<String, BigInteger> out = new LinkedHashMap<>(a);
        for (Map.Entry<String, BigInteger> e : b.entrySet()) {
            out.merge(e.getKey(), e.getValue(), BigInteger::add);
        }
        return out;
    }

    // ── JSON ────────────────────────────────────────────────────────────────

    /** The proof as the JSON value of the specification: amounts as decimal strings. */
    public Map<String, Object> toMap() {
        Map<String, Object> leafJson = new LinkedHashMap<>();
        if (leaf.userRef != null) {
            leafJson.put("user_ref", leaf.userRef);
        }
        leafJson.put("user_ref_hash", leaf.userRefHash);
        leafJson.put("salt", leaf.salt);
        leafJson.put("balances", amounts(leaf.balances));
        List<Object> siblingsJson = new ArrayList<>();
        for (Sibling s : siblings) {
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("hash", s.hash);
            one.put("sums", amounts(s.sums));
            one.put("dir", s.dir());
            siblingsJson.add(one);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("leaf_index", (long) leafIndex);
        out.put("leaf", leafJson);
        out.put("siblings", siblingsJson);
        return out;
    }

    /** The proof as indented JSON text. */
    public String toJson() {
        return Json.pretty(toMap());
    }

    /**
     * Reads a proof from JSON text. A document that is not of the shape the
     * specification gives is refused here, before any hashing.
     *
     * @throws PorException {@code invalid_proof}
     */
    public static InclusionProof parse(String json) {
        return fromJson(Json.parse(json, CODE));
    }

    /** Reads a proof from an already parsed JSON value (maps, lists, strings and integers). */
    public static InclusionProof fromMap(Map<String, ?> json) {
        return fromJson(json);
    }

    static InclusionProof fromJson(Object value) {
        Map<String, Object> p = Json.object(value, CODE, "the proof");
        long index = Json.integer(p.get("leaf_index"), CODE, "leaf_index");
        if (index < 0 || index >= Integer.MAX_VALUE) {
            throw new PorException(CODE, "leaf_index " + index + " is not a position in any snapshot");
        }
        Map<String, Object> leafJson = Json.object(p.get("leaf"), CODE, "leaf");
        Object userRef = leafJson.get("user_ref");
        if (userRef != null && !(userRef instanceof String)) {
            throw new PorException(CODE, "leaf.user_ref must be a string");
        }
        Leaf leaf = new Leaf((String) userRef,
                hash(leafJson.get("user_ref_hash"), "leaf.user_ref_hash"),
                hash(leafJson.get("salt"), "leaf.salt"),
                amounts(leafJson.get("balances"), "leaf.balances"));
        List<Object> list = Json.array(p.get("siblings"), CODE, "siblings");
        if (list.size() > MAX_SIBLINGS) {
            throw new PorException(CODE, list.size() + " siblings is more levels than a snapshot can have");
        }
        List<Sibling> siblings = new ArrayList<>(list.size());
        for (int i = 0; i < list.size(); i++) {
            String where = "siblings[" + i + "]";
            Map<String, Object> s = Json.object(list.get(i), CODE, where);
            Object dir = s.get("dir");
            if (!"left".equals(dir) && !"right".equals(dir)) {
                throw new PorException(CODE, where + ".dir must be \"left\" or \"right\"");
            }
            siblings.add(new Sibling(hash(s.get("hash"), where + ".hash"), amounts(s.get("sums"), where + ".sums"),
                    "left".equals(dir)));
        }
        return new InclusionProof((int) index, leaf, siblings);
    }

    private static String hash(Object v, String what) {
        if (!(v instanceof String) || !Hex.isHash((String) v)) {
            throw new PorException(CODE, what + " must be 64 lowercase hex characters");
        }
        return (String) v;
    }

    /**
     * Amounts as they must appear in a proof: decimal strings, canonical. A
     * JSON number is refused — {@code 12} and {@code "12"} add up to the same
     * total under two different hashes — and so is {@code "012"}, which a
     * lenient reader would quietly turn into the value that happens to verify.
     */
    private static Map<String, BigInteger> amounts(Object v, String what) {
        Map<String, Object> json = Json.object(v, CODE, what);
        Map<String, BigInteger> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : json.entrySet()) {
            out.put(e.getKey(), amount(e.getValue(), CODE, what + "." + e.getKey()));
        }
        return out;
    }

    /** One amount from JSON: a string of digits with no sign and no leading zero. */
    static BigInteger amount(Object v, String code, String what) {
        if (!(v instanceof String)) {
            throw new PorException(code, what + ": a balance must be a decimal string, not a JSON "
                    + (v instanceof Number ? "number" : "value of another kind"));
        }
        String s = (String) v;
        boolean canonical = !s.isEmpty() && (s.length() == 1 || s.charAt(0) != '0');
        for (int i = 0; canonical && i < s.length(); i++) {
            canonical = Text.isAsciiDigit(s.charAt(i));
        }
        if (!canonical) {
            throw new PorException(code, what + ": " + Text.quote(s) + " is not a non-negative integer string");
        }
        return s.equals("0") ? BigInteger.ZERO : new BigInteger(s);
    }

    static Map<String, Object> amounts(Map<String, BigInteger> sums) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, BigInteger> e : sums.entrySet()) {
            out.put(e.getKey(), e.getValue().toString());
        }
        return out;
    }
}
