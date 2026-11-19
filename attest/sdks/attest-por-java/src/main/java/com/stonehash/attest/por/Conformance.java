package com.stonehash.attest.por;

import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * Runs the specification's conformance vectors against this build.
 *
 * <p>The exchange-side SDK exists in several languages, and every one of them
 * has to arrive at the same 32 bytes from the same ledger — a root that
 * differs by language is two different statements about one set of
 * liabilities. The vectors are how that is held. The runner ships inside the
 * library so the check can be repeated on the Java runtime an exchange
 * actually deploys on, where the character sets and the cryptographic
 * provider are that machine's and not the build machine's.
 */
public final class Conformance {
    private static final String CODE = "invalid_vectors";

    private Conformance() {
    }

    /** One vector file's worth of results. */
    public static final class Group {
        private final String name;
        private int passed;
        private final List<String> failures = new ArrayList<>();

        private Group(String name) {
            this.name = name;
        }

        public String name() {
            return name;
        }

        public int passed() {
            return passed;
        }

        public int failed() {
            return failures.size();
        }

        /** One line per failed vector, saying which and how. */
        public List<String> failures() {
            return Collections.unmodifiableList(failures);
        }

        private void check(String what, Check check) {
            try {
                String problem = check.run();
                if (problem == null) {
                    passed++;
                } else {
                    failures.add(what + ": " + problem);
                }
            } catch (RuntimeException | IOException e) {
                failures.add(what + ": " + e);
            }
        }
    }

    /** Returns null when the vector holds, otherwise what differed. */
    private interface Check {
        String run() throws IOException;
    }

    /**
     * Runs every vector under {@code vectors} (the directory holding
     * {@code SPEC.md}).
     *
     * @return one group per vector file, in a fixed order
     * @throws PorException {@code invalid_vectors} when a vector file is missing or is not what the runner expects
     */
    public static List<Group> run(Path vectors) {
        Objects.requireNonNull(vectors, "vectors");
        List<Group> groups = new ArrayList<>();
        groups.add(jcs(vectors));
        groups.add(amounts(vectors));
        groups.add(leaves(vectors));
        groups.add(trees(vectors));
        groups.add(statement(vectors));
        groups.add(intake(vectors));
        groups.add(snapshotDirectory(vectors));
        return groups;
    }

    private static Group jcs(Path vectors) {
        Group g = new Group("jcs");
        Map<String, Object> file = read(vectors, "jcs.json");
        for (Map<String, Object> c : cases(file, "cases")) {
            g.check(text(c, "name"), () -> same(c.get("canonical"), Json.canonical(c.get("value"))));
        }
        for (Map<String, Object> c : cases(file, "rejects")) {
            g.check(text(c, "name"), () -> {
                try {
                    return "accepted as " + Json.canonical(Json.parse(text(c, "json"), CODE));
                } catch (PorException refused) {
                    return null;
                }
            });
        }
        return g;
    }

    private static Group amounts(Path vectors) {
        Group g = new Group("amounts");
        Map<String, Object> file = read(vectors, "amounts.json");
        for (Map<String, Object> c : cases(file, "cases")) {
            g.check(text(c, "unit") + " " + Json.compact(c.get("text")), () -> same(c.get("base"),
                    Amounts.toBaseUnits(text(c, "text"), number(c, "decimals"), AmountUnit.parse(text(c, "unit")))));
        }
        for (Map<String, Object> c : cases(file, "errors")) {
            g.check(text(c, "unit") + " " + Json.compact(c.get("text")), () -> {
                try {
                    return "accepted as " + Amounts.toBaseUnits(text(c, "text"), number(c, "decimals"),
                            AmountUnit.parse(text(c, "unit")));
                } catch (PorException e) {
                    return same(c.get("code"), e.code());
                }
            });
        }
        return g;
    }

    private static Group leaves(Path vectors) {
        Group g = new Group("leaves");
        Map<String, Object> file = read(vectors, "leaves.json");
        String exchange = text(file, "exchange_id");
        byte[] seed = seed(text(file, "seed_hex"));
        for (Map<String, Object> c : cases(file, "cases")) {
            String ref = text(c, "user_ref");
            g.check(Json.compact(ref), () -> {
                String problem = same(c.get("user_ref_hash"), Leaves.userRefHash(exchange, ref));
                if (problem == null) {
                    problem = same(c.get("salt"), Leaves.salt(seed, ref));
                }
                if (problem == null) {
                    problem = same(c.get("leaf_hash"), Leaves.leafHash(text(c, "salt"), text(c, "user_ref_hash"),
                            amounts(c.get("normalised_balances"))));
                }
                return problem;
            });
        }
        return g;
    }

    private static Group trees(Path vectors) {
        Group g = new Group("trees");
        Map<String, Object> file = read(vectors, "trees.json");
        g.check("empty node", () -> same(file.get("empty_node_hash"), Hex.encode(Leaves.emptyNodeHash())));
        for (Map<String, Object> c : cases(file, "cases")) {
            g.check(text(c, "name"), () -> {
                List<AssetSpec> assets = new ArrayList<>();
                for (Object symbol : Json.array(c.get("assets"), CODE, "assets")) {
                    // The vector's balances are already in smallest units, so the decimal places play no part.
                    assets.add(new AssetSpec((String) symbol, 0));
                }
                LedgerBuilder ledger = new LedgerBuilder(assets, AmountUnit.BASE);
                for (Map<String, Object> row : cases(c, "rows")) {
                    Map<String, String> balances = new LinkedHashMap<>();
                    for (Map.Entry<String, Object> e : Json.object(row.get("balances"), CODE, "balances").entrySet()) {
                        balances.put(e.getKey(), (String) e.getValue());
                    }
                    ledger.addAccount(text(row, "user_ref"), balances);
                }
                PorTree tree = PorTree.build(text(c, "exchange_id"), seed(text(c, "seed_hex")), ledger.finish());
                String problem = same(c.get("root"), tree.root());
                problem = problem != null ? problem : same(c.get("leaf_count"), (long) tree.leafCount());
                problem = problem != null ? problem : same(c.get("totals"), InclusionProof.amounts(tree.totals()));
                List<Object> order = new ArrayList<>();
                for (int i = 0; i < tree.leafCount(); i++) {
                    order.add(tree.userRef(i));
                }
                problem = problem != null ? problem : same(c.get("order"), order);
                List<Object> levels = new ArrayList<>();
                for (int d = 0; d < tree.levels(); d++) {
                    levels.add(tree.levelHashes(d));
                }
                problem = problem != null ? problem : same(c.get("level_hashes"), levels);
                for (Map<String, Object> p : cases(c, "proofs")) {
                    int index = number(p, "leaf_index");
                    InclusionProof proof = tree.prove(index);
                    problem = problem != null ? problem : same(p.get("proof"), proof.toMap());
                    problem = problem != null ? problem : same((long) index, (long) tree.indexOf(text(p, "user_ref")));
                    if (problem == null && !InclusionProof.fromJson(p.get("proof")).verify(tree.root(), tree.totals()).ok()) {
                        problem = "the vector's proof for leaf " + index + " does not verify";
                    }
                }
                return problem;
            });
        }
        Map<String, Object> invalid = Json.object(file.get("invalid_proofs"), CODE, "invalid_proofs");
        Map<String, Object> against = Json.object(invalid.get("against"), CODE, "against");
        for (Map<String, Object> p : cases(invalid, "proofs")) {
            g.check("must fail: " + text(p, "why"), () -> {
                try {
                    boolean ok = InclusionProof.fromJson(p.get("proof")).verify(text(against, "root"), amounts(against.get("totals"))).ok();
                    return ok ? "verified" : null;
                } catch (PorException refused) {
                    return null;
                }
            });
        }
        return g;
    }

    private static Group statement(Path vectors) {
        Group g = new Group("statement");
        Map<String, Object> file = read(vectors, "statement.json");
        Statement statement = Statement.fromMap(Json.object(file.get("statement"), CODE, "statement"));
        Map<String, Object> key = Json.object(file.get("test_key"), CODE, "test_key");
        String spki = text(key, "public_spki_base64");
        SignatureEnvelope signature = SignatureEnvelope.fromJson(file.get("signature"));

        g.check("the statement is valid", () -> statement.validate().isEmpty() ? null : String.join("; ", statement.validate()));
        g.check("canonical JSON", () -> same(file.get("canonical"), statement.canonicalJson()));
        g.check("commitment", () -> same(file.get("commitment"), statement.commitment()));
        g.check("the signature verifies", () -> signature.verifies(statement, spki) ? null : "did not verify");
        for (Map<String, Object> bad : cases(file, "must_not_verify")) {
            g.check("must not verify: " + text(bad, "why"), () -> SignatureEnvelope.fromJson(bad.get("signature"))
                    .verifies(Statement.fromMap(Json.object(bad.get("statement"), CODE, "statement")), spki) ? "verified" : null);
        }
        g.check("the submission file", () -> {
            Submission submission = Submission.parse(Json.compact(file.get("submission")));
            if (!submission.validate().isEmpty()) {
                return String.join("; ", submission.validate());
            }
            return submission.verifies(spki) ? null : "did not verify";
        });
        g.check("signing with the test key", () -> {
            // An ECDSA signature uses a fresh nonce, so the vector's bytes cannot be reproduced; a new one must verify.
            KeySigner signer = Signers.fromPkcs8Pem(text(key, "private_pkcs8_pem"));
            String problem = same(spki, signer.publicKeySpkiBase64());
            Submission signed = Submission.sign(statement, signer);
            problem = problem != null ? problem : same(text(Json.object(file.get("signature"), CODE, "signature"), "key_id"),
                    signed.signature().keyId());
            return problem != null ? problem : signed.verifies(spki) ? null : "a fresh signature did not verify";
        });
        return g;
    }

    private static Group intake(Path vectors) {
        Group g = new Group("intake");
        for (Map<String, Object> c : cases(read(vectors, "intake.json"), "cases")) {
            g.check(text(c, "name"), () -> {
                Ledger ledger = CsvLedger.read(vectors.resolve(text(c, "file")), csvOptions(c));
                LedgerReport report = ledger.report();
                if (!Boolean.TRUE.equals(c.get("ok"))) {
                    List<Object> problems = new ArrayList<>();
                    for (Problem p : report.problems()) {
                        Map<String, Object> one = new LinkedHashMap<>();
                        one.put("line", p.line());
                        one.put("code", p.code());
                        problems.add(one);
                    }
                    String problem = same(c.get("problems"), problems);
                    return problem != null ? problem : ledger.rows().isEmpty() ? null : "a refused file yielded rows";
                }
                if (!report.ok()) {
                    return "refused: " + report.problems();
                }
                Map<String, Object> holders = new LinkedHashMap<>();
                for (Map.Entry<String, Integer> e : report.holders().entrySet()) {
                    holders.put(e.getKey(), (long) e.getValue());
                }
                List<Object> rows = new ArrayList<>();
                for (LedgerRow row : ledger.rows()) {
                    Map<String, Object> one = new LinkedHashMap<>();
                    one.put("user_ref", row.userRef());
                    one.put("balances", InclusionProof.amounts(row.balances()));
                    rows.add(one);
                }
                String problem = same(c.get("layout"), report.layout() == null ? null : report.layout().wireName());
                problem = problem != null ? problem : same(c.get("data_rows"), report.rows());
                problem = problem != null ? problem : same(c.get("accounts"), (long) report.accounts());
                problem = problem != null ? problem : same(c.get("zero_balance_accounts"), (long) report.zeroBalanceAccounts());
                problem = problem != null ? problem : same(c.get("totals"), InclusionProof.amounts(report.totals()));
                problem = problem != null ? problem : same(c.get("holders"), holders);
                problem = problem != null ? problem : same(c.get("ignored_columns"), report.ignoredColumns());
                problem = problem != null ? problem : same(c.get("file_sha256"), report.fileSha256());
                return problem != null ? problem : same(c.get("rows"), rows);
            });
        }
        return g;
    }

    private static CsvOptions csvOptions(Map<String, Object> vector) {
        Map<String, Object> o = Json.object(vector.get("options"), CODE, "options");
        List<AssetSpec> assets = new ArrayList<>();
        for (Map<String, Object> a : cases(o, "assets")) {
            assets.add(new AssetSpec(text(a, "symbol"), number(a, "decimals")));
        }
        CsvOptions options = new CsvOptions(assets, AmountUnit.parse(text(o, "amounts")));
        if (o.get("layout") != null) {
            options.layout(CsvLayout.parse(text(o, "layout")));
        }
        if (o.get("delimiter") != null) {
            options.delimiter(text(o, "delimiter").charAt(0));
        }
        if (o.get("columns") != null) {
            Map<String, Object> columns = Json.object(o.get("columns"), CODE, "columns");
            if (columns.get("account") != null) {
                options.accountColumn(text(columns, "account"));
            }
            if (columns.get("asset") != null) {
                options.assetColumn(text(columns, "asset"));
            }
            if (columns.get("balance") != null) {
                options.balanceColumn(text(columns, "balance"));
            }
        }
        if (o.get("ignore_columns") != null) {
            List<String> names = new ArrayList<>();
            for (Object name : Json.array(o.get("ignore_columns"), CODE, "ignore_columns")) {
                names.add((String) name);
            }
            options.ignoreColumns(names);
        }
        return options;
    }

    private static Group snapshotDirectory(Path vectors) {
        Group g = new Group("snapshot-dir");
        Map<String, Object> expected = read(vectors, "snapshot-dir.expected.json");
        Path dir = vectors.resolve("snapshot-dir");
        g.check("load: root, totals and leaf count", () -> {
            PorTree tree = SnapshotDirectory.load(dir);
            String problem = same(expected.get("root"), tree.root());
            problem = problem != null ? problem : same(expected.get("totals"), InclusionProof.amounts(tree.totals()));
            problem = problem != null ? problem : same(expected.get("leaf_count"), (long) tree.leafCount());
            return problem != null ? problem : same(expected.get("exchange_id"), tree.exchangeId());
        });
        g.check("the statement's commitment", () -> same(expected.get("commitment"), SnapshotDirectory.readStatement(dir).commitment()));
        g.check("the customer's proof file", () -> {
            Path file = vectors.resolve(text(expected, "proof_file"));
            Map<String, Object> wanted = Json.object(Json.parse(Files.readAllBytes(file), CODE, file.toString()), CODE, "the proof file");
            ProofFile issued = ProofFile.issue(SnapshotDirectory.readStatement(dir), SnapshotDirectory.load(dir), text(wanted, "user_ref"));
            String problem = same(wanted, issued.toMap());
            problem = problem != null ? problem : sameBytes(file, issued.toJson() + "\n");
            return problem != null ? problem : issued.verify(SnapshotDirectory.readStatement(dir)).ok() ? null : "does not verify";
        });
        g.check("openings for a challenge", () -> {
            Path file = vectors.resolve(text(expected, "openings_file"));
            Map<String, Object> wanted = Json.object(Json.parse(Files.readAllBytes(file), CODE, file.toString()), CODE, "the openings file");
            PorTree tree = SnapshotDirectory.load(dir);
            List<Object> openings = new ArrayList<>();
            for (Map<String, Object> opening : cases(wanted, "openings")) {
                openings.add(tree.prove(number(opening, "leaf_index")).toMap());
            }
            return same(wanted.get("openings"), openings);
        });
        g.check("write: the same four files, byte for byte", () -> {
            Statement recorded = SnapshotDirectory.readStatement(dir);
            byte[] seed = seed(text(expected, "seed_hex"));
            Ledger ledger = CsvLedger.read(vectors.resolve("intake").resolve("long.csv"),
                    new CsvOptions(recorded.assets(), AmountUnit.DECIMAL));
            PorTree tree = PorTree.build(recorded.institutionId(), seed, ledger);
            Statement statement = Statement.builder().exchange(recorded.institutionId(), recorded.name())
                    .asof(recorded.asof()).assets(recorded.assets()).tree(tree)
                    .clock(Clock.fixed(Instant.parse(recorded.generatedAt()), ZoneOffset.UTC)).build();
            Path scratch = Files.createTempDirectory("por-conformance-");
            try {
                Path out = scratch.resolve("snapshot");
                SnapshotDirectory.write(out, tree, seed, statement);
                for (String name : Arrays.asList(SnapshotDirectory.SNAPSHOT_FILE, SnapshotDirectory.LEAVES_FILE,
                        SnapshotDirectory.SEED_FILE, SnapshotDirectory.TREE_FILE)) {
                    if (!Arrays.equals(Files.readAllBytes(dir.resolve(name)), Files.readAllBytes(out.resolve(name)))) {
                        return name + " differs from the vector's";
                    }
                }
                return null;
            } finally {
                try (Stream<Path> files = Files.walk(scratch)) {
                    for (Path p : (Iterable<Path>) files.sorted(Comparator.reverseOrder())::iterator) {
                        Files.delete(p);
                    }
                }
            }
        });
        return g;
    }

    // ── reading the vector files ────────────────────────────────────────────

    private static Map<String, Object> read(Path vectors, String name) {
        Path file = vectors.resolve(name);
        try {
            return Json.object(Json.parse(Files.readAllBytes(file), CODE, name), CODE, name);
        } catch (IOException e) {
            throw new PorException(CODE, "could not read " + file + ": " + e.getMessage(), e);
        }
    }

    private static List<Map<String, Object>> cases(Map<String, Object> from, String key) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object c : Json.array(from.get(key), CODE, key)) {
            out.add(Json.object(c, CODE, "an entry of " + key));
        }
        return out;
    }

    private static String text(Map<String, Object> from, String key) {
        return Json.string(from.get(key), CODE, key);
    }

    private static int number(Map<String, Object> from, String key) {
        return (int) Json.integer(from.get(key), CODE, key);
    }

    private static Map<String, BigInteger> amounts(Object json) {
        Map<String, BigInteger> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : Json.object(json, CODE, "amounts").entrySet()) {
            out.put(e.getKey(), InclusionProof.amount(e.getValue(), CODE, e.getKey()));
        }
        return out;
    }

    private static byte[] seed(String hex) {
        byte[] seed = new byte[Leaves.SEED_BYTES];
        if (!Hex.decodeInto(hex, seed, 0, seed.length)) {
            throw new PorException(CODE, "seed_hex is not 32 bytes of hex");
        }
        return seed;
    }

    private static String same(Object expected, Object actual) {
        return Objects.equals(expected, actual) ? null
                : "expected " + shorten(String.valueOf(expected)) + ", got " + shorten(String.valueOf(actual));
    }

    private static String sameBytes(Path file, String text) throws IOException {
        return Arrays.equals(Files.readAllBytes(file), text.getBytes(StandardCharsets.UTF_8)) ? null
                : "the JSON value is the vector's, but the file's bytes differ from " + file.getFileName();
    }

    private static String shorten(String s) {
        return s.length() <= 160 ? s : s.substring(0, 160) + "…";
    }
}
