package com.stonehash.attest.core.por;

import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The Merkle sum tree of a reserve snapshot, as the platform reads it: one
 * opened leaf checked against a declared root and declared totals, and the
 * commitment of a snapshot statement.
 *
 * <p>Every node of the tree carries a hash and a sum per asset, and the hash
 * covers the sums of both children. One opening therefore shows two things:
 * that the balance is in the tree, and that the totals the exchange declared
 * include it.
 *
 * <pre>
 *   leaf  = SHA-256("STONEHASH-POR-LEAF-V1\n" ‖ salt ‖ user_ref_hash ‖ JCS(balances))
 *   node  = SHA-256("STONEHASH-POR-NODE-V1\n" ‖ L.hash ‖ R.hash ‖ JCS(L.sums) ‖ JCS(R.sums))
 *   commitment = SHA-256("STONEHASH-POR-V1\n" ‖ JCS(statement))
 * </pre>
 *
 * <p>The platform builds no tree — the exchange does, and its SDK is where
 * that lives. What is here is the reading side only, written out in this
 * service: an opening arrives in a request and is whatever the sender made
 * it, so every value is read as {@link JsValues} reads a document, and what
 * the answer is for a value of the wrong kind is the answer the service has
 * always given. Where it used to be the runtime's complaint about its own
 * code, it is a sentence about the opening (see
 * docs/JAVA-INTENDED-DIFFERENCES.md).
 */
public final class SumTree {
    private SumTree() {
    }

    private static final byte[] LEAF_DOMAIN = "STONEHASH-POR-LEAF-V1\n".getBytes(StandardCharsets.UTF_8);
    private static final byte[] NODE_DOMAIN = "STONEHASH-POR-NODE-V1\n".getBytes(StandardCharsets.UTF_8);
    private static final byte[] SNAPSHOT_DOMAIN = "STONEHASH-POR-V1\n".getBytes(StandardCharsets.UTF_8);

    private static final Pattern INT = Pattern.compile("(0|[1-9][0-9]*)");
    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");

    /** What one opening came to. */
    public static final class Result {
        public final boolean ok;
        /** Empty when the leaf itself could not be read. */
        public final String computedRoot;
        public final Map<String, Object> computedTotals;
        /** What does not hold, in the order found; empty when {@link #ok}. */
        public final List<String> problems;

        Result(String computedRoot, Map<String, Object> computedTotals, List<String> problems) {
            this.ok = problems.isEmpty();
            this.computedRoot = computedRoot;
            this.computedTotals = computedTotals;
            this.problems = problems;
        }
    }

    /** The commitment that reaches the chain: SHA-256 of the domain and the statement's canonical form, in hex. */
    public static String commitment(Object statement) {
        return Hex.encode(Hex.sha256(SNAPSHOT_DOMAIN, Canonical.bytes(statement)));
    }

    /**
     * Check one opening against a declared root and declared totals.
     *
     * <p>The sums that arrive at the root are recomputed from the leaf and
     * the siblings, so they equal the declared liabilities only if every
     * sibling's sums were honest inputs to every hash on the way. The index
     * is checked against the side each sibling is on, so an opening cannot
     * be passed off as one for another position.
     *
     * @param proof the opening as it arrived: {@code { leaf_index, leaf: { user_ref_hash, salt, balances }, siblings: [{ hash, sums, dir }] }}
     * @param root the statement's {@code tree.root}
     * @param totals the statement's {@code totals}
     * @throws PlainError where the service has always failed the request with a sentence of its own (a sibling hash that is not hex)
     * @throws JsValues.EngineError where it failed inside its runtime (no list of siblings, a sibling that is {@code null})
     */
    public static Result verify(Object proof, Object root, Object totals) {
        List<String> problems = new ArrayList<>();
        String hash;
        Map<String, Object> sums;
        try {
            Object leaf = JsValues.member(proof, "leaf");
            if (JsValues.nullish(leaf)) {
                return unreadable("leaf is required: { user_ref_hash, salt, balances }");
            }
            Object balances = JsValues.member(leaf, "balances");
            if (JsValues.nullish(balances)) {
                return unreadable("leaf.balances is required: an object of non-negative integer strings");
            }
            assertBalances(balances, "leaf.balances");
            hash = leafHash(JsValues.member(leaf, "salt"), JsValues.member(leaf, "user_ref_hash"), balances);
            sums = own(balances);
        } catch (PlainError e) {
            return unreadable(e.getMessage());
        } catch (JsValues.EngineError e) {
            return unreadable("the leaf cannot be read: user_ref_hash, salt and every balance must be text");
        }

        Object siblings = JsValues.member(proof, "siblings");
        if (!(siblings instanceof List)) {
            throw new JsValues.EngineError("the siblings of an opening are not a list");
        }
        int level = 0;
        for (Object sib : (List<?>) siblings) {
            Object sibHash = JsValues.member(sib, "hash");
            if (!HEX64.matcher(JsValues.string(sibHash)).matches()) {
                problems.add("sibling[" + level + "].hash is not 64 hex chars");
            }
            Object sibSums = JsValues.member(sib, "sums");
            try {
                if (JsValues.nullish(sibSums)) {
                    throw new PlainError("sibling[" + level + "].sums is required: an object of non-negative integer strings");
                }
                assertBalances(sibSums, "sibling[" + level + "].sums");
            } catch (PlainError e) {
                problems.add(e.getMessage());
                level++;
                continue;
            } catch (JsValues.EngineError e) {
                problems.add("sibling[" + level + "].sums cannot be read: every sum must be text");
                level++;
                continue;
            }
            Object index = JsValues.member(proof, "leaf_index");
            int expectedBit = (toInt32(index) >> level) & 1;
            Object dir = JsValues.member(sib, "dir");
            boolean left = "left".equals(dir);
            // A sibling on the left means the node on the path is the right child.
            if (expectedBit != (left ? 1 : 0)) {
                problems.add("sibling[" + level + "].dir contradicts leaf_index " + JsValues.string(index));
            }
            if (left) {
                hash = nodeHash(sibHash, hash, sibSums, sums);
                sums = add(sibSums, sums);
            } else {
                hash = nodeHash(hash, sibHash, sums, sibSums);
                sums = add(sums, sibSums);
            }
            level++;
        }

        if (!JsValues.strictEquals(hash, root)) {
            problems.add("computed root " + head(hash) + "… ≠ declared " + head(root) + "…");
        }
        Set<String> assets = new LinkedHashSet<>(sums.keySet());
        assets.addAll(own(totals).keySet());
        for (String k : assets) {
            Object computed = held(sums, k);
            Object declared = held(totals, k);
            if (!JsValues.strictEquals(computed, declared)) {
                problems.add("computed total " + k + "=" + JsValues.string(computed) + " ≠ declared " + JsValues.string(declared));
            }
        }
        return new Result(hash, sums, problems);
    }

    private static Result unreadable(String problem) {
        List<String> problems = new ArrayList<>();
        problems.add(problem);
        return new Result("", new LinkedHashMap<>(), problems);
    }

    /**
     * Balances are non-negative integers written as text: integers because
     * sums have to be exact, text because a number of the wire is not, and
     * non-negative because a negative leaf is the classic way to fake
     * solvency.
     */
    static void assertBalances(Object b, String where) {
        for (Map.Entry<String, Object> e : own(b).entrySet()) {
            // The one name a figure must not be filed under: it would be hashed and then left out of every sum.
            if (e.getKey().equals("__proto__")) {
                throw new PlainError(where + ": \"__proto__\" is not an asset name");
            }
            String text = JsValues.string(e.getValue());
            if (!INT.matcher(text).matches()) {
                throw new PlainError(where + "." + e.getKey() + ": \"" + text + "\" is not a non-negative integer string");
            }
        }
    }

    static String leafHash(Object salt, Object userRefHash, Object balances) {
        if (!HEX64.matcher(JsValues.string(salt)).matches()) {
            throw new PlainError("salt must be 64 lowercase hex chars");
        }
        if (!HEX64.matcher(JsValues.string(userRefHash)).matches()) {
            throw new PlainError("user_ref_hash must be 64 lowercase hex chars");
        }
        assertBalances(balances, "balances");
        return Hex.encode(Hex.sha256(LEAF_DOMAIN, hexToBytes(salt), hexToBytes(userRefHash), Canonical.bytes(balances)));
    }

    private static String nodeHash(Object leftHash, Object rightHash, Object leftSums, Object rightSums) {
        return Hex.encode(Hex.sha256(NODE_DOMAIN, hexToBytes(leftHash), hexToBytes(rightHash), Canonical.bytes(leftSums), Canonical.bytes(rightSums)));
    }

    /** a + b per asset, over the assets either holds. Exact. */
    private static Map<String, Object> add(Object a, Object b) {
        Set<String> assets = new LinkedHashSet<>(own(a).keySet());
        assets.addAll(own(b).keySet());
        Map<String, Object> out = new LinkedHashMap<>();
        for (String k : assets) {
            out.put(k, integer(held(a, k)).add(integer(held(b, k))).toString());
        }
        return Js.inPropertyOrder(out);
    }

    /** The figure filed under an asset — where the balances hold that asset, and zero where they do not. */
    private static Object held(Object balances, String asset) {
        Map<String, Object> members = own(balances);
        return members.containsKey(asset) ? members.get(asset) : "0";
    }

    /** A figure that passed {@link #assertBalances}, as the integer it is. */
    static BigInteger integer(Object v) {
        if (v instanceof Double) {
            return new BigDecimal((Double) v).toBigIntegerExact();
        }
        return new BigInteger(JsValues.string(v));
    }

    /**
     * What a value holds under names of its own, in the order a document
     * keeps them: an object's members; of a list or of text, each position;
     * of anything else, nothing.
     */
    static Map<String, Object> own(Object v) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (v instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (e.getValue() != Js.UNDEFINED) {
                    out.put((String) e.getKey(), e.getValue());
                }
            }
            return Js.inPropertyOrder(out);
        }
        if (v instanceof List) {
            List<?> list = (List<?>) v;
            for (int i = 0; i < list.size(); i++) {
                out.put(Integer.toString(i), list.get(i));
            }
        } else if (v instanceof String) {
            String text = (String) v;
            for (int i = 0; i < text.length(); i++) {
                out.put(Integer.toString(i), String.valueOf(text.charAt(i)));
            }
        } else if (JsValues.nullish(v)) {
            throw new JsValues.EngineError("the members of nothing were listed");
        }
        return out;
    }

    /** The first sixteen characters of a hash, for a sentence. */
    private static String head(Object hash) {
        if (hash instanceof String) {
            String text = (String) hash;
            return text.substring(0, Math.min(16, text.length()));
        }
        if (hash instanceof List) {
            List<?> list = (List<?>) hash;
            return JsValues.string(new ArrayList<>(list.subList(0, Math.min(16, list.size()))));
        }
        throw new JsValues.EngineError("a hash that is neither text nor a list was put into a sentence");
    }

    /** A value as the 32-bit integer the index arithmetic uses: not a number is 0, a fraction is cut off, and it wraps. */
    static int toInt32(Object v) {
        double d = number(v);
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            return 0;
        }
        BigInteger whole = new BigDecimal(d).toBigInteger();
        return whole.intValue();
    }

    /** A value as the number arithmetic makes of it. */
    static double number(Object v) {
        if (v == null) {
            return 0;
        }
        if (v == Js.UNDEFINED) {
            return Double.NaN;
        }
        if (v instanceof Double) {
            return (Double) v;
        }
        if (v instanceof Boolean) {
            return (Boolean) v ? 1 : 0;
        }
        if (v instanceof String) {
            return Js.toNumber((String) v);
        }
        if (v instanceof List) {
            return Js.toNumber(JsValues.string(v));
        }
        if (v instanceof Map) {
            // Turned into text first; an object's text is not a number.
            JsValues.string(v);
            return Double.NaN;
        }
        throw new IllegalArgumentException(v.getClass().getName() + " is not a JSON value");
    }

    /**
     * Hex text as bytes — read two characters at a time the way the service
     * always read them, which is kinder than a hex decoder: a pair is taken
     * as far as it is hex. A hash that is not 64 hex characters has already
     * been reported by then; this only has to come to the same bytes, and to
     * the same refusal where there are none.
     */
    static byte[] hexToBytes(Object hex) {
        Object length = JsValues.member(hex, "length");
        double n = number(length);
        if (n % 2 != 0 || Double.isNaN(n)) {
            throw new PlainError("hex length must be even, got " + JsValues.string(length));
        }
        if (n == 0) {
            return new byte[0];
        }
        if (!(hex instanceof String) && !(hex instanceof List)) {
            throw new JsValues.EngineError("something that is neither text nor a list was read as hex");
        }
        int count = (int) (n / 2);
        byte[] out = new byte[count];
        for (int i = 0; i < count; i++) {
            String pair = hex instanceof String ? ((String) hex).substring(i * 2, i * 2 + 2)
                    : JsValues.string(new ArrayList<>(((List<?>) hex).subList(i * 2, i * 2 + 2)));
            BigInteger value = parseHexPrefix(pair);
            if (value == null) {
                throw new PlainError("invalid hex at offset " + (i * 2));
            }
            // Stored into a byte: the number the engine made of the digits, modulo 256.
            out[i] = new BigDecimal(value.doubleValue()).toBigInteger().mod(BigInteger.valueOf(256)).byteValue();
        }
        return out;
    }

    /** The hex integer a text begins with — after white space, a sign and an optional 0x — or {@code null} where it begins with none. */
    private static BigInteger parseHexPrefix(String text) {
        int i = 0;
        while (i < text.length() && Js.isSpace(text.charAt(i))) {
            i++;
        }
        boolean negative = false;
        if (i < text.length() && (text.charAt(i) == '+' || text.charAt(i) == '-')) {
            negative = text.charAt(i) == '-';
            i++;
        }
        if (i + 1 < text.length() && text.charAt(i) == '0' && (text.charAt(i + 1) == 'x' || text.charAt(i + 1) == 'X')) {
            i += 2;
        }
        int start = i;
        while (i < text.length() && Character.digit(text.charAt(i), 16) >= 0 && text.charAt(i) < 128) {
            i++;
        }
        if (i == start) {
            return null;
        }
        BigInteger value = new BigInteger(text.substring(start, i), 16);
        return negative ? value.negate() : value;
    }
}
