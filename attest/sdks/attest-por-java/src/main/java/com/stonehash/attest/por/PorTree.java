package com.stonehash.attest.por;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.DigestException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import javax.crypto.Mac;
import javax.crypto.ShortBufferException;

/**
 * The liability tree: a Merkle <em>sum</em> tree over an exchange's accounts
 * (specification §5), built and kept on the exchange's own machine.
 *
 * <p>Every node carries a hash and, per asset, the sum of everything below
 * it; the hash covers the sums. One 32-byte root therefore commits at once to
 * the set of accounts and to the total owed in every asset. Leaves are
 * ordered by their hashed reference, so the tree is a function of the ledger
 * alone: the same ledger and seed give the same root on any machine, in any
 * of the SDKs.
 *
 * <p>Nothing in this object is ever sent anywhere by this class. What leaves
 * the exchange is the statement built from {@link #root()} and
 * {@link #totals()}; a leaf leaves only inside a proof — the customer's own
 * ({@link #proveAccount}), or one the exchange opens to the platform when it
 * has asked for a spot check ({@link #prove}).
 *
 * <p>Immutable once built, and safe to share between threads.
 */
public final class PorTree {
    private static final int H = Leaves.SEED_BYTES;

    private final String exchangeId;
    private final AssetTable assets;
    /** The accounts in tree order: {@code leaves[i]} is the leaf at index {@code i}. */
    private final LedgerRow[] leaves;
    private final byte[] refHashes;
    private final byte[] salts;
    /** {@code hashes[d]} holds level {@code d} as stored — padded to an even count below the root. */
    private final byte[][] hashes;
    /** {@code sums[d]} holds one value per node and asset of level {@code d}, node by node. */
    private final BigInteger[][] sums;
    /**
     * True when this class hashed the references itself. A tree read back
     * from disk keeps the hashes it was stored with, whoever derived them.
     */
    private final boolean hashedHere;

    private PorTree(String exchangeId, AssetTable assets, LedgerRow[] leaves, byte[] refHashes, byte[] salts,
            byte[][] hashes, BigInteger[][] sums, boolean hashedHere) {
        this.exchangeId = exchangeId;
        this.assets = assets;
        this.leaves = leaves;
        this.refHashes = refHashes;
        this.salts = salts;
        this.hashes = hashes;
        this.sums = sums;
        this.hashedHere = hashedHere;
    }

    /**
     * Builds the tree for a ledger that read cleanly.
     *
     * @param exchangeId the exchange's institution id, as registered with the platform
     * @param seed       the snapshot's 32 secret bytes ({@link Leaves#newSeed()}); every salt derives from it
     * @throws PorException {@code ledger_has_problems} when the ledger's report is not ok — nothing is built from
     *                      the rows that happened to be accepted; {@code duplicate_leaf} when two accounts hash alike
     */
    public static PorTree build(String exchangeId, byte[] seed, Ledger ledger) {
        Objects.requireNonNull(ledger, "ledger");
        if (!ledger.ok()) {
            throw new PorException("ledger_has_problems", "the ledger has " + ledger.report().problemCount()
                    + " problem" + (ledger.report().problemCount() == 1 ? "" : "s") + "; nothing can be built from it");
        }
        byte[] domain = Leaves.userDomain(exchangeId);
        Mac mac = Leaves.saltMac(seed);
        List<LedgerRow> rows = ledger.rows();
        requireSize(rows.size(), ledger.assetTable().size());

        MessageDigest sha = Hex.sha256();
        byte[] unsorted = new byte[rows.size() * H];
        for (int i = 0; i < rows.size(); i++) {
            sha.update(domain);
            // A row exists only if its reference passed the account rules, so it is well-formed text.
            sha.update(rows.get(i).userRef().getBytes(StandardCharsets.UTF_8));
            digestInto(sha, unsorted, i * H);
        }
        int[] order = sortedOrder(unsorted, rows.size());
        LedgerRow[] leaves = new LedgerRow[order.length];
        byte[] refHashes = new byte[order.length * H];
        byte[] salts = new byte[order.length * H];
        for (int i = 0; i < order.length; i++) {
            leaves[i] = rows.get(order[i]);
            System.arraycopy(unsorted, order[i] * H, refHashes, i * H, H);
            mac.update(leaves[i].userRef().getBytes(StandardCharsets.UTF_8));
            try {
                mac.doFinal(salts, i * H);
            } catch (ShortBufferException e) {
                throw new IllegalStateException(e);
            }
        }
        return assemble(exchangeId, ledger.assetTable(), leaves, refHashes, salts, true);
    }

    /**
     * For leaves whose hashed reference and salt are already known — a
     * snapshot being read back from where the exchange stored it.
     *
     * @param exchangeId the exchange's institution id
     * @param assets     the snapshot's asset symbols, in declared order
     */
    public static Builder builder(String exchangeId, List<String> assets) {
        return new Builder(exchangeId, assets);
    }

    /** Collects leaves in any order; {@link #build()} sorts them and builds the tree. */
    public static final class Builder {
        private final String exchangeId;
        private final AssetTable assets;
        private final List<LedgerRow> rows = new ArrayList<>();
        private byte[] refHashes = new byte[64 * H];
        private byte[] salts = new byte[64 * H];

        private Builder(String exchangeId, List<String> assets) {
            Leaves.requireExchangeId(exchangeId);
            this.exchangeId = exchangeId;
            this.assets = AssetTable.ofSymbols(Objects.requireNonNull(assets, "assets"));
        }

        /**
         * @param balances the account's balances in smallest units; an asset left out counts as zero
         * @throws PorException {@code invalid_leaf} for a hash or salt that is not 64 lowercase hex characters,
         *                      an asset the snapshot does not list, or a negative balance
         */
        public Builder addLeaf(String userRef, String userRefHash, String salt, Map<String, BigInteger> balances) {
            Objects.requireNonNull(userRef, "userRef");
            Objects.requireNonNull(balances, "balances");
            int n = rows.size();
            if ((long) (n + 1) * H > refHashes.length) {
                requireSize(n + 1, assets.size());
                int grown = (int) Math.min((long) refHashes.length * 2, Integer.MAX_VALUE - 16);
                refHashes = Arrays.copyOf(refHashes, grown);
                salts = Arrays.copyOf(salts, grown);
            }
            if (!Hex.isHash(userRefHash) || !Hex.decodeInto(userRefHash, refHashes, n * H, H)) {
                throw new PorException("invalid_leaf", "user_ref_hash must be 64 lowercase hex characters");
            }
            if (!Hex.isHash(salt) || !Hex.decodeInto(salt, salts, n * H, H)) {
                throw new PorException("invalid_leaf", "salt must be 64 lowercase hex characters");
            }
            LedgerRow row = new LedgerRow(userRef, assets);
            for (Map.Entry<String, BigInteger> e : balances.entrySet()) {
                int position = assets.indexOf(e.getKey());
                if (position < 0) {
                    throw new PorException("invalid_leaf",
                            "account " + Text.quote(userRef) + " holds unlisted asset " + e.getKey());
                }
                if (e.getValue() == null || e.getValue().signum() < 0) {
                    throw new PorException("invalid_leaf", "account " + Text.quote(userRef) + "." + e.getKey()
                            + ": a balance is a non-negative integer");
                }
                row.put(position, e.getValue());
            }
            rows.add(row);
            return this;
        }

        /** @throws PorException {@code empty_ledger}, {@code duplicate_leaf} */
        public PorTree build() {
            int[] order = sortedOrder(refHashes, rows.size());
            LedgerRow[] leaves = new LedgerRow[order.length];
            byte[] sortedHashes = new byte[order.length * H];
            byte[] sortedSalts = new byte[order.length * H];
            for (int i = 0; i < order.length; i++) {
                leaves[i] = rows.get(order[i]);
                System.arraycopy(refHashes, order[i] * H, sortedHashes, i * H, H);
                System.arraycopy(salts, order[i] * H, sortedSalts, i * H, H);
            }
            return assemble(exchangeId, assets, leaves, sortedHashes, sortedSalts, false);
        }
    }

    // ── what the tree says ──────────────────────────────────────────────────

    /** The institution id the references were hashed under. */
    public String exchangeId() {
        return exchangeId;
    }

    /** Asset symbols in declared order. */
    public List<String> assets() {
        return assets.symbolList();
    }

    /** Accounts in the tree. Padding is not counted. */
    public int leafCount() {
        return leaves.length;
    }

    /** The root hash: 64 lowercase hex characters. */
    public String root() {
        return Hex.encode(hashes[hashes.length - 1], 0, H);
    }

    /** Per asset, the sum of every account's balance, in smallest units and declared order. */
    public Map<String, BigInteger> totals() {
        return assets.toMap(sums[sums.length - 1], 0);
    }

    /** Levels in the tree, the leaf level and the root included: 1 for a single account. */
    public int levels() {
        return hashes.length;
    }

    /** The hashes of one level as stored, level 0 being the leaves; an odd level ends in the padding node. */
    public List<String> levelHashes(int level) {
        if (level < 0 || level >= hashes.length) {
            throw new PorException("out_of_range", "level " + level + " is outside 0.." + (hashes.length - 1));
        }
        List<String> out = new ArrayList<>(hashes[level].length / H);
        for (int at = 0; at < hashes[level].length; at += H) {
            out.add(Hex.encode(hashes[level], at, H));
        }
        return out;
    }

    /** The account reference of the leaf at an index. Exchange-internal: it is in no hash and no opening. */
    public String userRef(int leafIndex) {
        return leaf(leafIndex).userRef();
    }

    /**
     * The leaf index of an account, or -1 when the ledger had no such
     * account. The reference is matched byte for byte.
     */
    public int indexOf(String userRef) {
        Objects.requireNonNull(userRef, "userRef");
        if (Text.isWellFormed(userRef)) {
            MessageDigest sha = Hex.sha256();
            sha.update(Leaves.userDomain(exchangeId));
            byte[] wanted = sha.digest(userRef.getBytes(StandardCharsets.UTF_8));
            int lo = 0;
            int hi = leaves.length - 1;
            while (lo <= hi) {
                int mid = (lo + hi) >>> 1;
                int cmp = Arrays.compareUnsigned(refHashes, mid * H, mid * H + H, wanted, 0, H);
                if (cmp == 0) {
                    if (leaves[mid].userRef().equals(userRef)) {
                        return mid;
                    }
                    break;
                }
                if (cmp < 0) {
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
        }
        if (hashedHere) {
            return -1;
        }
        // For hashes that were stored rather than derived here, the stored reference is the authority.
        for (int i = 0; i < leaves.length; i++) {
            if (leaves[i].userRef().equals(userRef)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * The inclusion proof for the leaf at an index, <em>without</em> the
     * account reference: the form in which a leaf may be opened to the
     * platform for a spot check.
     *
     * @throws PorException {@code out_of_range}
     */
    public InclusionProof prove(int leafIndex) {
        return proof(leafIndex, null);
    }

    /**
     * The inclusion proof for an account, carrying its reference: what the
     * exchange hands that customer, and nobody else.
     *
     * @throws PorException {@code unknown_account} when the ledger had no such account
     */
    public InclusionProof proveAccount(String userRef) {
        int at = indexOf(userRef);
        if (at < 0) {
            throw new PorException("unknown_account", "no leaf for account " + Text.quote(userRef));
        }
        return proof(at, leaves[at].userRef());
    }

    private InclusionProof proof(int leafIndex, String userRef) {
        leaf(leafIndex);
        int width = assets.size();
        List<InclusionProof.Sibling> siblings = new ArrayList<>(hashes.length - 1);
        int at = leafIndex;
        for (int d = 0; d < hashes.length - 1; d++) {
            int sibling = at ^ 1;
            siblings.add(new InclusionProof.Sibling(Hex.encode(hashes[d], sibling * H, H),
                    assets.toMap(sums[d], sibling * width), sibling < at));
            at >>>= 1;
        }
        InclusionProof.Leaf leaf = new InclusionProof.Leaf(userRef, Hex.encode(refHashes, leafIndex * H, H),
                Hex.encode(salts, leafIndex * H, H), assets.toMap(sums[0], leafIndex * width));
        return new InclusionProof(leafIndex, leaf, siblings);
    }

    // ── for the code that stores a snapshot ─────────────────────────────────

    LedgerRow leaf(int leafIndex) {
        if (leafIndex < 0 || leafIndex >= leaves.length) {
            throw new PorException("out_of_range",
                    "leaf index " + leafIndex + " is outside 0.." + (leaves.length - 1));
        }
        return leaves[leafIndex];
    }

    String userRefHash(int leafIndex) {
        return Hex.encode(refHashes, leafIndex * H, H);
    }

    String salt(int leafIndex) {
        return Hex.encode(salts, leafIndex * H, H);
    }

    AssetTable assetTable() {
        return assets;
    }

    // ── building ────────────────────────────────────────────────────────────

    /**
     * How many accounts fit: each level's hashes sit in one array, and so do
     * its sums, and a Java array holds fewer than 2^31 elements.
     */
    private static void requireSize(int accounts, int assetCount) {
        long limit = (Integer.MAX_VALUE - 16) / Math.max(H, assetCount) - 1;
        if (accounts > limit) {
            throw new PorException("too_large", accounts + " accounts with " + assetCount
                    + " assets is more than this SDK holds in one tree (" + limit + ")");
        }
    }

    /** The positions of the hashes in ascending order; refuses an empty set and two equal hashes. */
    private static int[] sortedOrder(byte[] refHashes, int count) {
        if (count == 0) {
            throw new PorException("empty_ledger", "there are no accounts: a snapshot of nothing is not evidence");
        }
        int[] order = new int[count];
        for (int i = 0; i < count; i++) {
            order[i] = i;
        }
        // Bottom-up merge sort on positions: the hashes themselves stay where they are.
        int[] spare = new int[count];
        for (int run = 1; run < count; run *= 2) {
            for (int lo = 0; lo < count; lo += 2 * run) {
                int mid = Math.min(lo + run, count);
                int hi = Math.min(lo + 2 * run, count);
                int a = lo;
                int b = mid;
                for (int k = lo; k < hi; k++) {
                    if (a < mid && (b >= hi || compare(refHashes, order[a], order[b]) <= 0)) {
                        spare[k] = order[a++];
                    } else {
                        spare[k] = order[b++];
                    }
                }
            }
            int[] swap = order;
            order = spare;
            spare = swap;
        }
        for (int i = 1; i < count; i++) {
            if (compare(refHashes, order[i - 1], order[i]) == 0) {
                // Two leaves with one hashed reference would let one customer's proof stand in for another's.
                throw new PorException("duplicate_leaf", "two accounts have the same user_ref_hash "
                        + Hex.encode(refHashes, order[i] * H, 8) + "…");
            }
        }
        return order;
    }

    private static int compare(byte[] hashes, int a, int b) {
        return Arrays.compareUnsigned(hashes, a * H, a * H + H, hashes, b * H, b * H + H);
    }

    /** Hashes the leaves and folds the levels. Everything is already in tree order. */
    private static PorTree assemble(String exchangeId, AssetTable assets, LedgerRow[] leaves, byte[] refHashes,
            byte[] salts, boolean hashedHere) {
        int width = assets.size();
        requireSize(leaves.length, width);
        List<byte[]> levelHashes = new ArrayList<>();
        List<BigInteger[]> levelSums = new ArrayList<>();
        byte[] emptyHash = Leaves.emptyNodeHash();
        MessageDigest sha = Hex.sha256();
        ByteSink message = new ByteSink();

        int count = leaves.length;
        int stored = storedCount(count);
        byte[] hashes = new byte[stored * H];
        BigInteger[] sums = new BigInteger[stored * width];
        for (int i = 0; i < count; i++) {
            for (int a = 0; a < width; a++) {
                BigInteger v = leaves[i].at(a);
                sums[i * width + a] = v == null ? BigInteger.ZERO : v;
            }
            message.reset();
            message.put(Leaves.LEAF_DOMAIN);
            message.put(salts, i * H, H);
            message.put(refHashes, i * H, H);
            assets.appendCanonical(message, sums, i * width);
            sha.update(message.array(), 0, message.length());
            digestInto(sha, hashes, i * H);
        }
        pad(hashes, sums, count, stored, width, emptyHash);
        levelHashes.add(hashes);
        levelSums.add(sums);

        while (count > 1) {
            byte[] below = hashes;
            BigInteger[] belowSums = sums;
            count = stored / 2;
            stored = storedCount(count);
            hashes = new byte[stored * H];
            sums = new BigInteger[stored * width];
            for (int i = 0; i < count; i++) {
                message.reset();
                message.put(Leaves.NODE_DOMAIN);
                message.put(below, 2 * i * H, 2 * H);
                assets.appendCanonical(message, belowSums, 2 * i * width);
                assets.appendCanonical(message, belowSums, (2 * i + 1) * width);
                sha.update(message.array(), 0, message.length());
                digestInto(sha, hashes, i * H);
                for (int a = 0; a < width; a++) {
                    sums[i * width + a] = belowSums[2 * i * width + a].add(belowSums[(2 * i + 1) * width + a]);
                }
            }
            pad(hashes, sums, count, stored, width, emptyHash);
            levelHashes.add(hashes);
            levelSums.add(sums);
        }
        return new PorTree(exchangeId, assets, leaves, refHashes, salts,
                levelHashes.toArray(new byte[0][]), levelSums.toArray(new BigInteger[0][]), hashedHere);
    }

    /**
     * A level with an odd number of nodes is stored with one empty node
     * after them — padding, not duplication: repeating the last node, as
     * Bitcoin does, would count its balance twice in the parent's sum.
     */
    private static int storedCount(int count) {
        return count == 1 ? 1 : count + (count & 1);
    }

    private static void pad(byte[] hashes, BigInteger[] sums, int count, int stored, int width, byte[] emptyHash) {
        if (stored > count) {
            System.arraycopy(emptyHash, 0, hashes, count * H, H);
            Arrays.fill(sums, count * width, stored * width, BigInteger.ZERO);
        }
    }

    private static void digestInto(MessageDigest sha, byte[] out, int offset) {
        try {
            sha.digest(out, offset, H);
        } catch (DigestException e) {
            throw new IllegalStateException(e);
        }
    }
}
