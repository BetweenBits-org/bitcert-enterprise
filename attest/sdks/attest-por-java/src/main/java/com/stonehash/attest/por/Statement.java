package com.stonehash.attest.por;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The snapshot statement — the only thing about a ledger that travels to the
 * platform (specification §6).
 *
 * <p>Root, totals, the number of accounts, the as-of time, nothing else: no
 * account reference, no balance, no leaf. Its commitment is what the platform
 * anchors, and its signature is what makes it the exchange's statement rather
 * than anyone's.
 *
 * <p>An instance holds the statement as the JSON value it is, including any
 * member this version does not know, because the commitment and the signature
 * are taken over the canonical form of <em>that value</em>. A statement read
 * from a file is therefore signed as it stands, never as re-modelled; and
 * re-indenting or re-ordering the file changes neither result.
 */
public final class Statement {
    public static final String SCHEMA = "stonehash.por-snapshot.v1";

    private static final String CODE = "invalid_statement";
    private static final String TREE_ALGORITHM = "merkle-sum-sha256-v1";
    private static final String PADDING = "empty-zero";
    /** Fixed text. In the string, each {@code \n} is a backslash followed by the letter n, not a line break. */
    private static final String PARAM_USER_REF_HASH = "sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)";
    private static final String PARAM_SALT = "hmac-sha256(master_seed, user_ref)";
    private static final String RESERVES_NOTE = "Addresses declared by the exchange; balances are measured on chain by verifiers. "
            + "Address-control proof is out of sandbox scope.";
    private static final long MAX_LEAF_COUNT = 2147483647L;
    private static final byte[] COMMITMENT_DOMAIN = "STONEHASH-POR-V1\n".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] SIGNING_DOMAIN = "stonehash:remit:event:v1\n".getBytes(StandardCharsets.US_ASCII);
    private static final DateTimeFormatter GENERATED_AT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);

    private final Map<String, Object> json;

    @SuppressWarnings("unchecked")
    private Statement(Object json) {
        this.json = (Map<String, Object>) Json.freeze(Json.object(json, CODE, "the statement"));
    }

    public static Builder builder() {
        return new Builder();
    }

    /**
     * Reads a statement from JSON text, for example the contents of
     * {@code snapshot.json}. Only "is this a JSON object" is checked here;
     * {@link #validate()} says whether it is a usable statement.
     *
     * @throws PorException {@code invalid_statement}
     */
    public static Statement parse(String json) {
        return new Statement(Json.parse(Objects.requireNonNull(json, "json"), CODE));
    }

    /** A statement from an already parsed JSON value (maps, lists, strings, integers and booleans). */
    public static Statement fromMap(Map<String, ?> json) {
        return new Statement(Objects.requireNonNull(json, "json"));
    }

    /** Collects what a statement is made of; {@link #build()} refuses anything that would not be a valid one. */
    public static final class Builder {
        private String institutionId;
        private String name;
        private String asof;
        private List<AssetSpec> assets;
        private PorTree tree;
        private List<ReserveEntry> reserves;
        private Clock clock = Clock.systemUTC();

        private Builder() {
        }

        /** The exchange's institution id as registered with the platform, and the name it is known by. */
        public Builder exchange(String institutionId, String name) {
            this.institutionId = institutionId;
            this.name = name;
            return this;
        }

        /** The instant the ledger was read, as ISO 8601 with an offset, for example {@code 2026-11-16T00:00:00Z}. */
        public Builder asof(String isoInstant) {
            this.asof = isoInstant;
            return this;
        }

        /** The snapshot's assets with their decimal places, in the order the tree was built with. */
        public Builder assets(List<AssetSpec> assets) {
            this.assets = new ArrayList<>(Objects.requireNonNull(assets, "assets"));
            return this;
        }

        /** The tree whose root, totals and account count the statement declares. */
        public Builder tree(PorTree tree) {
            this.tree = tree;
            return this;
        }

        /** Reserve addresses the exchange declares. Optional; leave unset to declare none. */
        public Builder reserves(List<ReserveEntry> entries) {
            this.reserves = new ArrayList<>(Objects.requireNonNull(entries, "entries"));
            return this;
        }

        /** Where {@code generated_at} comes from. The system clock unless a test pins it. */
        public Builder clock(Clock clock) {
            this.clock = Objects.requireNonNull(clock, "clock");
            return this;
        }

        /** @throws PorException {@code invalid_statement}, naming everything that is missing or wrong */
        public Statement build() {
            if (institutionId == null || name == null || asof == null || assets == null || tree == null) {
                throw new PorException(CODE, "a statement needs the exchange, the as-of time, the assets and the tree");
            }
            List<String> symbols = new ArrayList<>();
            List<Object> assetsJson = new ArrayList<>();
            for (AssetSpec a : assets) {
                symbols.add(a.symbol());
                Map<String, Object> one = new LinkedHashMap<>();
                one.put("symbol", a.symbol());
                one.put("decimals", (long) a.decimals());
                assetsJson.add(one);
            }
            // The decimal places are a claim about the tree's integers; they must be the ones it was built with.
            if (!symbols.equals(tree.assets())) {
                throw new PorException(CODE, "the assets " + symbols + " are not the tree's " + tree.assets());
            }
            Instant now = clock.instant();
            int year = now.atOffset(ZoneOffset.UTC).getYear();
            if (year < 0 || year > 9999) {
                throw new PorException(CODE, "the clock reads year " + year + ", which generated_at cannot express");
            }

            Map<String, Object> exchange = new LinkedHashMap<>();
            exchange.put("institution_id", institutionId);
            exchange.put("name", name);
            Map<String, Object> treeJson = new LinkedHashMap<>();
            treeJson.put("algo", TREE_ALGORITHM);
            treeJson.put("leaf_count", (long) tree.leafCount());
            treeJson.put("root", tree.root());
            treeJson.put("padding", PADDING);
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("user_ref_hash", PARAM_USER_REF_HASH);
            params.put("salt", PARAM_SALT);

            Map<String, Object> st = new LinkedHashMap<>();
            st.put("schema", SCHEMA);
            st.put("exchange", exchange);
            st.put("asof", asof);
            st.put("assets", assetsJson);
            st.put("tree", treeJson);
            st.put("totals", InclusionProof.amounts(tree.totals()));
            st.put("params", params);
            if (reserves != null) {
                List<Object> entries = new ArrayList<>();
                for (ReserveEntry e : reserves) {
                    entries.add(e.toJson());
                }
                Map<String, Object> reservesJson = new LinkedHashMap<>();
                reservesJson.put("mode", "DECLARED");
                reservesJson.put("entries", entries);
                reservesJson.put("note", RESERVES_NOTE);
                st.put("reserves", reservesJson);
            }
            st.put("generated_at", GENERATED_AT.format(now));

            Statement statement = new Statement(st);
            statement.requireValid();
            return statement;
        }
    }

    // ── what it commits to ──────────────────────────────────────────────────

    /** The canonical JSON text: what is hashed for the commitment and signed. */
    public String canonicalJson() {
        return Json.canonical(json);
    }

    /** The value the platform anchors: SHA-256 over a fixed tag and the canonical JSON, as 64 hex characters. */
    public String commitment() {
        MessageDigest sha = Hex.sha256();
        sha.update(COMMITMENT_DOMAIN);
        return Hex.encode(sha.digest(Json.canonicalBytes(json)));
    }

    /** The exact bytes a signature is taken over: the platform's event tag, then the canonical JSON. */
    byte[] signingInput() {
        byte[] canonical = Json.canonicalBytes(json);
        byte[] out = new byte[SIGNING_DOMAIN.length + canonical.length];
        System.arraycopy(SIGNING_DOMAIN, 0, out, 0, SIGNING_DOMAIN.length);
        System.arraycopy(canonical, 0, out, SIGNING_DOMAIN.length, canonical.length);
        return out;
    }

    /** The statement as indented JSON text, the form in which {@code snapshot.json} holds it. */
    public String toJson() {
        return Json.pretty(json);
    }

    /** The statement as an unmodifiable JSON value: maps, lists, strings, {@code Long}s. */
    public Map<String, Object> toMap() {
        return json;
    }

    // ── its shape ───────────────────────────────────────────────────────────

    /**
     * Everything about this statement that is not as the specification
     * describes; empty when it is a valid statement. Members the
     * specification does not name are left alone.
     */
    public List<String> validate() {
        List<String> p = new ArrayList<>();
        if (!SCHEMA.equals(json.get("schema"))) {
            p.add("schema must be " + SCHEMA);
        }

        Object exchange = json.get("exchange");
        if (!(exchange instanceof Map)) {
            p.add("exchange must be an object");
        } else {
            Object id = ((Map<?, ?>) exchange).get("institution_id");
            if (!(id instanceof String) || ((String) id).isEmpty()) {
                p.add("exchange.institution_id is required");
            }
            if (!(((Map<?, ?>) exchange).get("name") instanceof String)) {
                p.add("exchange.name must be a string");
            }
        }

        if (!(json.get("asof") instanceof String) || !isInstant((String) json.get("asof"))) {
            p.add("asof must be an ISO 8601 instant with an offset, for example 2026-11-16T00:00:00Z");
        }

        Set<String> symbols = new HashSet<>();
        Object assets = json.get("assets");
        if (!(assets instanceof List) || ((List<?>) assets).isEmpty()) {
            p.add("assets must be a non-empty array");
        } else {
            int i = 0;
            for (Object a : (List<?>) assets) {
                Object symbol = a instanceof Map ? ((Map<?, ?>) a).get("symbol") : null;
                Object decimals = a instanceof Map ? ((Map<?, ?>) a).get("decimals") : null;
                if (!(symbol instanceof String) || !AssetSpec.isSymbol((String) symbol)) {
                    p.add("assets[" + i + "].symbol is not an asset symbol");
                } else if (!symbols.add((String) symbol)) {
                    p.add("assets lists " + symbol + " twice");
                }
                if (!(decimals instanceof Long) || (Long) decimals < 0 || (Long) decimals > Amounts.MAX_DECIMALS) {
                    p.add("assets[" + i + "].decimals must be an integer from 0 to " + Amounts.MAX_DECIMALS);
                }
                i++;
            }
        }

        Object tree = json.get("tree");
        if (!(tree instanceof Map)) {
            p.add("tree must be an object");
        } else {
            Map<?, ?> t = (Map<?, ?>) tree;
            if (!TREE_ALGORITHM.equals(t.get("algo"))) {
                p.add("tree.algo must be " + TREE_ALGORITHM);
            }
            if (!(t.get("root") instanceof String) || !Hex.isHash((String) t.get("root"))) {
                p.add("tree.root must be 64 lowercase hex characters");
            }
            Object count = t.get("leaf_count");
            if (!(count instanceof Long) || (Long) count < 1 || (Long) count > MAX_LEAF_COUNT) {
                p.add("tree.leaf_count must be an integer from 1 to " + MAX_LEAF_COUNT);
            }
            if (!PADDING.equals(t.get("padding"))) {
                p.add("tree.padding must be " + PADDING);
            }
        }

        Object totals = json.get("totals");
        if (!(totals instanceof Map)) {
            p.add("totals must be an object");
        } else {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) totals).entrySet()) {
                try {
                    InclusionProof.amount(e.getValue(), CODE, "totals." + e.getKey());
                } catch (PorException bad) {
                    p.add(bad.getMessage());
                }
            }
            // A total for an asset the statement does not list, or none for one it does, says nothing checkable.
            if (assets instanceof List && !symbols.isEmpty() && !((Map<?, ?>) totals).keySet().equals(symbols)) {
                p.add("totals must have exactly one entry for each asset in assets");
            }
        }

        Object params = json.get("params");
        if (!(params instanceof Map) || !PARAM_USER_REF_HASH.equals(((Map<?, ?>) params).get("user_ref_hash"))
                || !PARAM_SALT.equals(((Map<?, ?>) params).get("salt"))) {
            p.add("params must hold the two fixed strings of the specification");
        }

        Object reserves = json.get("reserves");
        if (json.containsKey("reserves")) {
            if (!(reserves instanceof Map)) {
                p.add("reserves must be an object");
            } else {
                Map<?, ?> r = (Map<?, ?>) reserves;
                if (!"DECLARED".equals(r.get("mode"))) {
                    p.add("reserves.mode must be DECLARED");
                }
                if (!RESERVES_NOTE.equals(r.get("note"))) {
                    p.add("reserves.note must be the fixed sentence of the specification");
                }
                if (!(r.get("entries") instanceof List)) {
                    p.add("reserves.entries must be an array");
                } else {
                    int i = 0;
                    for (Object e : (List<?>) r.get("entries")) {
                        if (!isReserveEntry(e)) {
                            p.add("reserves.entries[" + i + "] must be { chain, asset, address, token_contract? } with string values");
                        }
                        i++;
                    }
                }
            }
        }

        if (!(json.get("generated_at") instanceof String) || !isGeneratedAt((String) json.get("generated_at"))) {
            p.add("generated_at must be UTC with milliseconds, for example 2026-11-16T01:02:03.456Z");
        }
        return p;
    }

    /** @throws PorException {@code invalid_statement}, with every problem {@link #validate()} found */
    public void requireValid() {
        List<String> problems = validate();
        if (!problems.isEmpty()) {
            throw new PorException(CODE, "the statement is not valid: " + String.join("; ", problems));
        }
    }

    private static boolean isReserveEntry(Object e) {
        if (!(e instanceof Map)) {
            return false;
        }
        Map<?, ?> m = (Map<?, ?>) e;
        for (String key : new String[] { "chain", "asset", "address" }) {
            if (!(m.get(key) instanceof String) || ((String) m.get(key)).isEmpty()) {
                return false;
            }
        }
        return !m.containsKey("token_contract") || m.get("token_contract") instanceof String;
    }

    /**
     * Whether text is acceptable as {@code asof}: an ISO 8601 date and time
     * with an offset. A date alone, or a time without an offset, is not an
     * instant: read in two time zones it names two different moments.
     */
    public static boolean isInstant(String s) {
        if (s == null) {
            return false;
        }
        try {
            OffsetDateTime.parse(s);
            return true;
        } catch (DateTimeException e) {
            return false;
        }
    }

    private static boolean isGeneratedAt(String s) {
        if (s.length() != 24 || s.charAt(19) != '.' || s.charAt(23) != 'Z') {
            return false;
        }
        try {
            Instant.parse(s);
            return true;
        } catch (DateTimeException e) {
            return false;
        }
    }

    // ── reading its members ─────────────────────────────────────────────────

    public String institutionId() {
        return Json.string(member("exchange").get("institution_id"), CODE, "exchange.institution_id");
    }

    /** The exchange's name as the statement gives it. */
    public String name() {
        return Json.string(member("exchange").get("name"), CODE, "exchange.name");
    }

    public String asof() {
        return Json.string(json.get("asof"), CODE, "asof");
    }

    public String generatedAt() {
        return Json.string(json.get("generated_at"), CODE, "generated_at");
    }

    public String root() {
        return Json.string(member("tree").get("root"), CODE, "tree.root");
    }

    public int leafCount() {
        long n = Json.integer(member("tree").get("leaf_count"), CODE, "tree.leaf_count");
        if (n < 1 || n > MAX_LEAF_COUNT) {
            throw new PorException(CODE, "tree.leaf_count must be an integer from 1 to " + MAX_LEAF_COUNT);
        }
        return (int) n;
    }

    /** The declared total per asset, in smallest units. */
    public Map<String, BigInteger> totals() {
        Map<String, BigInteger> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : member("totals").entrySet()) {
            out.put(e.getKey(), InclusionProof.amount(e.getValue(), CODE, "totals." + e.getKey()));
        }
        return Collections.unmodifiableMap(out);
    }

    public List<AssetSpec> assets() {
        List<AssetSpec> out = new ArrayList<>();
        for (Object a : Json.array(json.get("assets"), CODE, "assets")) {
            Map<String, Object> one = Json.object(a, CODE, "an entry of assets");
            String symbol = Json.string(one.get("symbol"), CODE, "symbol");
            long decimals = Json.integer(one.get("decimals"), CODE, "decimals");
            if (!AssetSpec.isSymbol(symbol) || decimals < 0 || decimals > Amounts.MAX_DECIMALS) {
                throw new PorException(CODE, "assets holds an entry that is not a symbol with 0 to "
                        + Amounts.MAX_DECIMALS + " decimal places");
            }
            out.add(new AssetSpec(symbol, (int) decimals));
        }
        return Collections.unmodifiableList(out);
    }

    private Map<String, Object> member(String key) {
        return Json.object(json.get(key), CODE, key);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Statement && ((Statement) o).json.equals(json);
    }

    @Override
    public int hashCode() {
        return json.hashCode();
    }

    @Override
    public String toString() {
        return "Statement(" + json.get("asof") + ")";
    }
}
