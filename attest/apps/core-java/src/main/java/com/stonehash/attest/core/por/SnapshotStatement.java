package com.stonehash.attest.core.por;

import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The snapshot statement — the only thing of a reserve snapshot that travels
 * to the platform: the root, the totals per asset, the leaf count, the as-of
 * time. No account, no balance, no leaf.
 *
 * <p>Two checks, both of shape: {@link #problems} is what the exchange's SDK
 * calls a well-formed statement, and {@link #unanchorable} is what would let
 * a commitment be issued and then fail before its snapshot is stored. Neither
 * says anything about the tree behind the root.
 *
 * <p>A statement arrives in a request and can hold anything. Each value is
 * read as {@link JsValues} reads a document; the sentences and their order
 * are the ones an exchange's integration has always been answered with.
 */
public final class SnapshotStatement {
    private SnapshotStatement() {
    }

    public static final String SCHEMA = "stonehash.por-snapshot.v1";
    private static final String V1 = "merkle-sum-sha256-v1";
    private static final String V2 = "merkle-sum-sha256-v2";

    private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern INT = Pattern.compile("(0|[1-9][0-9]*)");

    /** What is wrong with a statement's shape, in a fixed order; empty when nothing is. */
    public static List<String> problems(Object s) {
        List<String> p = new ArrayList<>();
        if (!JsValues.truthy(s) || !JsValues.isObject(s)) {
            p.add("statement must be an object");
            return p;
        }
        if (!SCHEMA.equals(JsValues.member(s, "schema"))) {
            p.add("schema must be " + SCHEMA);
        }
        if (!JsValues.truthy(JsValues.memberIfAny(JsValues.member(s, "exchange"), "institution_id"))) {
            p.add("exchange.institution_id is required");
        }
        // An instant written the ISO 8601 way. Text only: the as-of time is kept and published as it was signed.
        Object asof = JsValues.member(s, "asof");
        if (!(asof instanceof String) || !IsoDate.parses((String) asof)) {
            p.add("asof must be an ISO instant");
        }
        Object assets = JsValues.member(s, "assets");
        if (!(assets instanceof List) || ((List<?>) assets).isEmpty()) {
            p.add("assets must be non-empty");
        }
        Object tree = JsValues.member(s, "tree");
        Object algo = JsValues.memberIfAny(tree, "algo");
        if (!V1.equals(algo) && !V2.equals(algo)) {
            p.add("tree.algo must be " + V1 + " or " + V2);
        } else {
            // The padding each tree format declares; a statement naming one with the other's is not one the SDK wrote.
            String padding = V1.equals(algo) ? "empty-zero" : "empty";
            Object declared = JsValues.memberIfAny(tree, "padding");
            if (declared != Js.UNDEFINED && !padding.equals(declared)) {
                p.add("tree.padding must be " + padding + " for " + algo);
            }
        }
        Object root = JsValues.memberIfAny(tree, "root");
        if (!HEX64.matcher(JsValues.string(JsValues.nullish(root) ? "" : root)).matches()) {
            p.add("tree.root must be 64 lowercase hex");
        }
        Object leafCount = JsValues.memberIfAny(tree, "leaf_count");
        if (!isInteger(leafCount) || (Double) leafCount < 1) {
            p.add("tree.leaf_count must be ≥ 1");
        }
        Object totals = JsValues.member(s, "totals");
        if (!JsValues.truthy(totals) || !JsValues.isObject(totals)) {
            p.add("totals is required");
        } else {
            for (Map.Entry<String, Object> e : SumTree.own(totals).entrySet()) {
                if (!INT.matcher(JsValues.string(e.getValue())).matches()) {
                    p.add("totals." + e.getKey() + " must be a non-negative integer string");
                }
            }
        }
        return p;
    }

    /**
     * What would let a commitment be issued and then fail before its
     * snapshot row is written: reserve entries the measurement cannot read,
     * and a leaf count the row cannot hold (a signed 32-bit column). Checked
     * last and before anything is issued — on the root-only path nothing
     * else stands between a signed statement and the chain.
     *
     * @param statement one that {@link #problems} found nothing wrong with
     */
    public static List<String> unanchorable(Object statement) {
        List<String> p = new ArrayList<>();
        Object leafCount = JsValues.member(JsValues.member(statement, "tree"), "leaf_count");
        if (SumTree.number(leafCount) > 2_147_483_647d) {
            p.add("tree.leaf_count must be at most 2147483647");
        }
        Object reserves = JsValues.member(statement, "reserves");
        if (JsValues.nullish(reserves)) {
            return p;
        }
        // What a list calls its entries is not a member of the document, and it is not a list of entries either.
        if (reserves instanceof List) {
            p.add("reserves.entries must be an array");
            return p;
        }
        Object entries = JsValues.member(reserves, "entries");
        if (entries == Js.UNDEFINED) {
            return p;
        }
        if (!(entries instanceof List)) {
            p.add("reserves.entries must be an array");
            return p;
        }
        int i = 0;
        for (Object e : (List<?>) entries) {
            boolean ok = e instanceof Map || e instanceof List;
            if (ok) {
                for (String k : new String[] { "chain", "asset", "address" }) {
                    Object v = JsValues.member(e, k);
                    ok = ok && v instanceof String && !((String) v).isEmpty();
                }
                Object token = JsValues.member(e, "token_contract");
                ok = ok && (token == Js.UNDEFINED || token instanceof String);
            }
            if (!ok) {
                p.add("reserves.entries[" + i + "] must be { chain, asset, address, token_contract? } with string values");
            }
            i++;
        }
        return p;
    }

    /** The reserve entries a statement declares, or an empty list where it declares none. Only of a statement {@link #unanchorable} passed. */
    public static List<?> reserveEntries(Object statement) {
        Object reserves = JsValues.member(statement, "reserves");
        if (JsValues.nullish(reserves) || reserves instanceof List) {
            return List.of();
        }
        Object entries = JsValues.member(reserves, "entries");
        return entries instanceof List ? (List<?>) entries : List.of();
    }

    /** A number with no fraction ({@code Number.isInteger}). */
    private static boolean isInteger(Object v) {
        if (!(v instanceof Double)) {
            return false;
        }
        double d = (Double) v;
        return !Double.isNaN(d) && !Double.isInfinite(d) && d == Math.rint(d);
    }
}
