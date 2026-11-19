package com.stonehash.attest.por;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The example program, driven the way a cross-language test drives it: by its
 * command line, judged by its exit code, its output and the files it leaves.
 */
final class ExampleTest {
    private static final String API_KEY = "sk_test_9d2b7e41aa";

    private ExampleTest() {
    }

    private static final class Run {
        int code;
        String out;
        String err;

        List<String> outLines() {
            return out.isEmpty() ? Collections.emptyList() : Arrays.asList(out.split("\n"));
        }
    }

    /** The example lives in the default package, as an example should; reflection is how a packaged class reaches it. */
    private static Run run(Map<String, String> env, String... args) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        Run r = new Run();
        r.code = (Integer) Class.forName("PorExample").getMethod("run", String[].class, PrintStream.class, PrintStream.class, Map.class)
                .invoke(null, args, new PrintStream(out, true, "UTF-8"), new PrintStream(err, true, "UTF-8"), env);
        r.out = out.toString("UTF-8");
        r.err = err.toString("UTF-8");
        return r;
    }

    private static Run run(String... args) throws Exception {
        return run(Collections.emptyMap(), args);
    }

    private static Map<String, String> key() {
        Map<String, String> env = new HashMap<>();
        env.put("STONEHASH_API_KEY", API_KEY);
        return env;
    }

    private static String[] buildArgs(Path csv, Path out, String... more) {
        List<String> args = new ArrayList<>(Arrays.asList("build", "--csv", csv.toString(), "--amounts", "decimal",
                "--assets", "BTC:8,ETH:18,USDT:6", "--exchange", Sample.EXCHANGE, "--name", "Sample Exchange",
                "--asof", "2026-11-16T00:00:00Z", "--seed-hex", Sample.SEED_HEX, "--generated-at", "2026-11-16T01:02:03.456Z",
                "--out", out.toString()));
        args.addAll(Arrays.asList(more));
        return args.toArray(new String[0]);
    }

    private static Path built(String name) throws Exception {
        Path dir = TestMain.newDirectory(name).resolve("snapshot");
        Run r = run(buildArgs(TestMain.vectors().resolve("intake/long.csv"), dir));
        Check.equal(0, r.code, "build: " + r.err);
        return dir;
    }

    private static Path keyFile(Path dir) throws Exception {
        Path file = dir.resolveSibling("exchange-signing.key");
        Files.write(file, ((String) Json.object(Sample.vector("statement.json").get("test_key"), "test", "test_key")
                .get("private_pkcs8_pem")).getBytes(StandardCharsets.UTF_8));
        return file;
    }

    private static Path signed(String name) throws Exception {
        Path dir = built(name);
        Check.equal(0, run("sign", "--dir", dir.toString(), "--key", keyFile(dir).toString()).code, "sign");
        return dir;
    }

    private static Map<String, Object> json(Path file) throws Exception {
        return Json.object(Json.parse(Files.readAllBytes(file), "test", file.toString()), "test", file.toString());
    }

    // ── build ───────────────────────────────────────────────────────────────

    static void testBuildPrintsRootTotalsAndCommitmentAndWritesTheReferencesDirectory() throws Exception {
        Path dir = TestMain.newDirectory("build").resolve("snapshot");
        Run r = run(buildArgs(TestMain.vectors().resolve("intake/long.csv"), dir));
        Check.equal(0, r.code, r.err);
        Check.equal(Arrays.asList(
                "root " + Sample.ROOT,
                "totals {\"BTC\":\"2463358024\",\"ETH\":\"114050000000000000001\",\"USDT\":\"255810750000\"}",
                "commitment 4245836fda6114c01d9fd50a9b9e5f84f41cb62f6d727abcb8c97bb6f41a6712"), r.outLines(), "the three lines");
        Check.equal("", r.err, "nothing on stderr");
        for (String name : Arrays.asList("snapshot.json", "leaves.jsonl", "seed.hex", "tree.json")) {
            Check.isTrue(Arrays.equals(Files.readAllBytes(TestMain.vectors().resolve("snapshot-dir").resolve(name)), Files.readAllBytes(dir.resolve(name))),
                    name + " is byte for byte the reference's");
        }
        Check.equal("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("seed.hex"))), "seed.hex is private");

        Path wide = TestMain.newDirectory("build-wide").resolve("snapshot");
        Run w = run(buildArgs(TestMain.vectors().resolve("intake/wide.csv"), wide, "--layout", "wide"));
        Check.equal("root " + Sample.ROOT, w.outLines().get(0), "the wide layout of the same ledger reaches the same root");
    }

    static void testBuildWithoutAStatedSeedMakesAFreshOneEachTime() throws Exception {
        Path a = TestMain.newDirectory("seed-a").resolve("snapshot");
        Path b = TestMain.newDirectory("seed-b").resolve("snapshot");
        String[] args = { "build", "--csv", TestMain.vectors().resolve("intake/long.csv").toString(), "--amounts", "decimal",
                "--assets", "BTC:8,ETH:18,USDT:6", "--exchange", Sample.EXCHANGE, "--name", "Sample Exchange", "--asof", "2026-11-16T00:00:00Z", "--out" };
        List<String> first = new ArrayList<>(Arrays.asList(args));
        first.add(a.toString());
        List<String> second = new ArrayList<>(Arrays.asList(args));
        second.add(b.toString());
        Run ra = run(first.toArray(new String[0]));
        Run rb = run(second.toArray(new String[0]));
        Check.equal(0, ra.code + rb.code, ra.err + rb.err);
        Check.isTrue(!ra.outLines().get(0).equals(rb.outLines().get(0)), "another seed, another root");
        Check.equal(ra.outLines().get(1), rb.outLines().get(1), "the same totals");
        Check.isTrue(new String(Files.readAllBytes(a.resolve("seed.hex")), StandardCharsets.UTF_8).matches("[0-9a-f]{64}\n"), "seed.hex");
        Run again = run(first.toArray(new String[0]));
        Check.equal(0, again.code, "a snapshot that was never handed over may be built again: " + again.err);
        Check.isTrue(!again.outLines().get(0).equals(ra.outLines().get(0)), "with a seed of its own");
    }

    static void testABadExportPrintsEveryProblemWritesNothingAndExitsTwo() throws Exception {
        Path dir = TestMain.newDirectory("bad").resolve("snapshot");
        Run r = run(buildArgs(TestMain.vectors().resolve("intake/bad-rows.csv"), dir));
        Check.equal(2, r.code, "exit code");
        Check.equal("", r.out, "nothing on stdout");
        Check.isTrue(!Files.exists(dir), "nothing was written");
        List<Object> printed = new ArrayList<>();
        for (String line : r.err.split("\n")) {
            String[] words = line.split(" ", 4);
            Check.equal("line", words[0], "every stderr line is a problem: " + line);
            Check.isTrue(words.length == 4 && !words[3].isEmpty(), "with a message: " + line);
            Map<String, Object> one = new java.util.LinkedHashMap<>();
            one.put("line", Long.parseLong(words[1]));
            one.put("code", words[2]);
            printed.add(one);
        }
        for (Object c : Json.array(Sample.vector("intake.json").get("cases"), "test", "cases")) {
            Map<String, Object> vector = Json.object(c, "test", "case");
            if (vector.get("file").equals("intake/bad-rows.csv")) {
                Check.equal(vector.get("problems"), printed, "exactly the vector's problems, in order");
            }
        }
        Run empty = run(buildArgs(TestMain.vectors().resolve("intake/bad-empty.csv"), dir));
        Check.equal(2, empty.code, "a header and nothing else");
        Check.isTrue(empty.err.startsWith("line 0 no_accounts "), empty.err);
    }

    static void testMistakesOnTheCommandLineGetASentenceAndExitOne() throws Exception {
        Path csv = TestMain.vectors().resolve("intake/long.csv");
        Path dir = TestMain.newDirectory("usage").resolve("snapshot");
        Map<String, String[]> mistakes = new java.util.LinkedHashMap<>();
        mistakes.put("unknown command", new String[] { "bulid" });
        mistakes.put("--cvs", new String[] { "build", "--cvs", "x" });
        mistakes.put("--out is required", Arrays.copyOf(buildArgs(csv, dir), buildArgs(csv, dir).length - 2));
        mistakes.put("--out needs a value", Arrays.copyOf(buildArgs(csv, dir), buildArgs(csv, dir).length - 1));
        mistakes.put("not found", buildArgs(csv.resolveSibling("nowhere.csv"), dir));
        mistakes.put("--asof", buildArgs(csv, dir, "--asof", "2026-11-16"));
        mistakes.put("decimal", buildArgs(csv, dir, "--amounts", "float"));
        mistakes.put("BTC:8", buildArgs(csv, dir, "--assets", "BTC"));
        mistakes.put("--seed-hex", buildArgs(csv, dir, "--seed-hex", "abc"));
        mistakes.put("--generated-at", buildArgs(csv, dir, "--generated-at", "now"));
        mistakes.put("--delimiter", buildArgs(csv, dir, "--delimiter", "ab"));
        mistakes.put("long", buildArgs(csv, dir, "--layout", "tall"));
        for (Map.Entry<String, String[]> m : mistakes.entrySet()) {
            Run r = run(m.getValue());
            Check.equal(1, r.code, m.getKey());
            Check.isTrue(r.err.contains(m.getKey()), m.getKey() + " is named in: " + r.err);
            Check.isTrue(!r.err.contains("\tat ") && !r.err.contains("Exception"), "a sentence, not a stack trace: " + r.err);
            Check.equal("", r.out, "nothing on stdout");
        }
        Check.isTrue(!Files.exists(dir), "and nothing was written");
        Check.equal(0, run("--help").code, "help");
        Check.isTrue(run().out.contains("usage: por-example"), "no arguments shows the usage");
    }

    static void testOptionsOfTheCsvReaderReachIt() throws Exception {
        Path dir = TestMain.newDirectory("mapped").resolve("snapshot");
        Run r = run("build", "--csv", TestMain.vectors().resolve("intake/mapped.csv").toString(), "--amounts=base", "--assets", "BTC:8,ETH:18,USDT:6",
                "--exchange", Sample.EXCHANGE, "--name", "Sample Exchange", "--asof", "2026-11-16T00:00:00Z", "--out", dir.toString(),
                "--delimiter", ";", "--col-account", "user_id", "--col-asset", "currency", "--col-balance", "amount");
        Check.equal(0, r.code, r.err);
        Check.equal("totals {\"BTC\":\"50000000\",\"ETH\":\"0\",\"USDT\":\"7\"}", r.outLines().get(1), "totals");
        Path ignoring = TestMain.newDirectory("ignore").resolve("snapshot");
        Run w = run(buildArgs(TestMain.vectors().resolve("intake/wide-ignore.csv"), ignoring, "--ignore-columns", "memo, other"));
        Check.equal(0, w.code, w.err);
        Check.equal("totals {\"BTC\":\"100000000\",\"ETH\":\"2000000000000000000\",\"USDT\":\"500000\"}", w.outLines().get(1), "totals");
    }

    // ── sign, submit, status ────────────────────────────────────────────────

    static void testSignWritesTheOneFileThatIsSent() throws Exception {
        Path dir = built("sign");
        Run early = run(key(), "submit", "--dir", dir.toString(), "--core", "http://127.0.0.1:1");
        Check.equal(1, early.code, "not signed yet");
        Check.isTrue(early.err.contains("run \"sign\" first"), early.err);

        Run r = run("sign", "--dir", dir.toString(), "--key", keyFile(dir).toString());
        Check.equal(0, r.code, r.err);
        Submission submission = SnapshotDirectory.readSubmission(dir);
        Check.equal("[]", submission.validate().toString(), "usable");
        Check.isTrue(submission.verifies(Sample.spki()), "signed with the key it was given");
        Check.equal(Sample.EXCHANGE, submission.signature().keyId(), "key_id");
        Check.equal(SnapshotDirectory.readStatement(dir), submission.statement(), "over the statement in snapshot.json");

        Path junk = dir.resolveSibling("junk.pem");
        Files.write(junk, "not a key".getBytes(StandardCharsets.UTF_8));
        Run bad = run("sign", "--dir", dir.toString(), "--key", junk.toString());
        Check.equal(1, bad.code, "a file that is not a key");
        Check.isTrue(bad.err.contains("PKCS#8"), bad.err);
        Check.equal(1, run("sign", "--dir", dir.resolveSibling("nowhere").toString(), "--key", junk.toString()).code, "no snapshot to sign");
    }

    static void testSubmitSendsTheFileAndRecordsTheAnswer() throws Exception {
        Path dir = signed("submit");
        try (StubPlatform p = new StubPlatform(Sample.EXCHANGE, Sample.spki())) {
            Run noKey = run("submit", "--dir", dir.toString(), "--core", p.base());
            Check.equal(1, noKey.code, "no API key");
            Check.isTrue(noKey.err.contains("STONEHASH_API_KEY"), noKey.err);
            Check.equal(0, p.requests.size(), "and nothing was asked or sent");

            p.confirmAfterPolls = 2;
            Run r = run(key(), "submit", "--dir", dir.toString(), "--core", p.base() + "/", "--wait", "--timeout-sec", "30");
            Check.equal(0, r.code, r.err);
            Check.equal(Arrays.asList("snapshot snap-1 ACCEPTED"), r.outLines(), "the one line");

            Check.equal("GET /v1/remit/meta", p.requests.get(0).method + " " + p.requests.get(0).path, "the registered key is asked for first");
            Check.equal(1, p.posts().size(), "exactly one request with a body");
            Submission submission = SnapshotDirectory.readSubmission(dir);
            Map<String, Object> sent = p.posts().get(0).json();
            Check.equal(submission.statement().toMap(), sent.get("statement"), "the body's statement is the file's");
            Check.equal(submission.signature().toMap(), sent.get("sig"), "and so is its signature");
            Check.equal("[statement, sig]", sent.keySet().toString(), "and there is nothing else in it");
            Check.equal("Bearer " + API_KEY, p.posts().get(0).headers.get("authorization"), "the key from the environment");

            Map<String, Object> receipt = json(dir.resolve("receipt.json"));
            Check.equal("[schema, snapshot_id, status, spot_check, sampled_accounts, attestation_id, commitment, root, platform, public_url, "
                    + "received_at, anchor]", receipt.keySet().toString(), "the receipt's members");
            Check.equal("stonehash.por-receipt.v1", receipt.get("schema"), "schema");
            Check.equal("snap-1", receipt.get("snapshot_id"), "snapshot_id");
            Check.equal("ACCEPTED", receipt.get("status"), "status");
            Check.equal(false, receipt.get("spot_check"), "spot_check");
            Check.equal(0L, receipt.get("sampled_accounts"), "sampled_accounts");
            Check.equal("att-snap-1", receipt.get("attestation_id"), "attestation_id");
            Check.equal(submission.statement().commitment(), receipt.get("commitment"), "commitment");
            Check.equal(Sample.ROOT, receipt.get("root"), "root");
            Check.equal(p.base(), receipt.get("platform"), "platform, without the trailing slash");
            Check.equal(p.base() + "/v1/public/por/snapshots/snap-1", receipt.get("public_url"), "public_url");
            Check.isTrue(((String) receipt.get("received_at")).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"), "received_at");
            Check.equal("confirmed", receipt.get("anchor"), "--wait saw the anchor confirmed");
            Check.isTrue(!Files.exists(dir.resolve("openings.json")), "no openings without a spot check");

            Run status = run(key(), "status", "--core", p.base(), "--snapshot", "snap-1");
            Check.equal(0, status.code, status.err);
            Check.equal(Sample.ROOT, Json.object(Json.parse(status.out, "test"), "test", "status").get("root"), "status prints the platform's answer as JSON");
            Run unknown = run(key(), "status", "--core", p.base(), "--snapshot", "snap-404");
            Check.equal(1, unknown.code, "a refusal");
            Check.isTrue(unknown.err.contains("not_found") && unknown.err.contains("HTTP 404"), unknown.err);
        }
    }

    static void testSubmitWithoutWaitLeavesTheAnchorPending() throws Exception {
        Path dir = signed("pending");
        try (StubPlatform p = new StubPlatform(Sample.EXCHANGE, Sample.spki())) {
            p.confirmAfterPolls = Integer.MAX_VALUE;
            Check.equal(0, run(key(), "submit", "--dir", dir.toString(), "--core", p.base()).code, "submit");
            Check.equal("pending", json(dir.resolve("receipt.json")).get("anchor"), "anchor");
            Run timedOut = run(key(), "submit", "--dir", dir.toString(), "--core", p.base(), "--wait", "--timeout-sec", "1");
            Check.equal(1, timedOut.code, "an anchor that does not confirm in time");
            Check.isTrue(timedOut.err.contains("anchor_timeout"), timedOut.err);
            Check.isTrue(timedOut.out.startsWith("snapshot snap-2 ACCEPTED"), "the snapshot id was printed before the wait: " + timedOut.out);

            // The platform now holds this snapshot. Building another over it would destroy the means of proving it.
            Run over = run("build", "--csv", TestMain.vectors().resolve("intake/long.csv").toString(), "--amounts", "decimal",
                    "--assets", "BTC:8,ETH:18,USDT:6", "--exchange", Sample.EXCHANGE, "--name", "Sample Exchange",
                    "--asof", "2026-11-17T00:00:00Z", "--out", dir.toString());
            Check.equal(1, over.code, "another snapshot is not written over one that was submitted");
            Check.isTrue(over.err.contains("snapshot_exists"), over.err);
            Check.equal(Sample.ROOT, SnapshotDirectory.load(dir).root(), "and the submitted one is intact");
        }
    }

    static void testASpotCheckIsAskedForAnsweredAndRecorded() throws Exception {
        Path dir = signed("spot");
        try (StubPlatform p = new StubPlatform(Sample.EXCHANGE, Sample.spki())) {
            Run r = run(key(), "submit", "--dir", dir.toString(), "--core", p.base(), "--spot-check");
            Check.equal(0, r.code, r.err);
            Check.equal(Arrays.asList("snapshot snap-1 VERIFIED"), r.outLines(), "the one line");
            Check.equal(Boolean.TRUE, p.posts().get(0).json().get("spot_check"), "asked for");
            Object sent = p.posts().get(1).json().get("openings");
            Check.equal(sent, json(dir.resolve("openings.json")).get("openings"), "what left the building is kept beside the snapshot");
            Check.equal("stonehash.por-openings.v1", json(dir.resolve("openings.json")).get("schema"), "openings schema");
            Check.isTrue(!p.posts().get(1).body.contains("U-1000"), "no account reference left");
            Map<String, Object> receipt = json(dir.resolve("receipt.json"));
            Check.equal("VERIFIED", receipt.get("status"), "status");
            Check.equal(true, receipt.get("spot_check"), "spot_check");
            Check.equal(3L, receipt.get("sampled_accounts"), "sampled_accounts");
            Check.equal("pending", receipt.get("anchor"), "anchor");

            // The same openings as the reference writes for the same challenge.
            Check.equal(Sample.vector("snapshot-dir.openings-0-3-7.json").get("openings"), sent, "the vector's openings");
        }
    }

    static void testAFileSignedWithAnUnregisteredKeyIsStoppedBeforeAnythingIsSent() throws Exception {
        Path dir = signed("unregistered");
        java.security.KeyPairGenerator generator = java.security.KeyPairGenerator.getInstance("EC");
        generator.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
        String otherKey = java.util.Base64.getEncoder().encodeToString(generator.generateKeyPair().getPublic().getEncoded());
        try (StubPlatform p = new StubPlatform(Sample.EXCHANGE, otherKey)) {
            Run r = run(key(), "submit", "--dir", dir.toString(), "--core", p.base(), "--spot-check");
            Check.equal(1, r.code, "exit code");
            Check.isTrue(r.err.contains("not signed with the key registered"), r.err);
            Check.equal(0, p.posts().size(), "nothing was sent");
            Check.isTrue(!Files.exists(dir.resolve("receipt.json")), "and there is no receipt");
        }
        try (StubPlatform p = new StubPlatform(Sample.EXCHANGE, Sample.spki())) {
            // An edited statement no longer carries a valid signature either.
            Path file = dir.resolve("submission.json");
            String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            Files.write(file, text.replace("\"BTC\": \"2463358024\"", "\"BTC\": \"1\"").getBytes(StandardCharsets.UTF_8));
            Check.equal(1, run(key(), "submit", "--dir", dir.toString(), "--core", p.base()).code, "edited");
            Check.equal(0, p.posts().size(), "nothing was sent");

            p.override = request -> request.method.equals("POST") ? StubPlatform.refusal(403, "institution_mismatch", "another exchange's key") : null;
            Files.write(file, text.getBytes(StandardCharsets.UTF_8));
            Run refused = run(key(), "submit", "--dir", dir.toString(), "--core", p.base());
            Check.equal(1, refused.code, "a platform refusal");
            Check.isTrue(refused.err.contains("institution_mismatch") && refused.err.contains("HTTP 403"), refused.err);
            Check.isTrue(!refused.err.contains(API_KEY) && !refused.out.contains(API_KEY), "the API key is printed nowhere");
        }
    }

    // ── proofs ──────────────────────────────────────────────────────────────

    static void testProveFromADirectoryTheReferenceWroteAndVerifyOffline() throws Exception {
        // snapshot-dir/ in the vectors was written by the TypeScript SDK; the proof issued from it here is its proof.
        Path referenceDir = TestMain.vectors().resolve("snapshot-dir");
        Path proof = TestMain.newDirectory("prove").resolve("proof.json");
        Run r = run("prove", "--dir", referenceDir.toString(), "--user-ref", "U-100008", "--out", proof.toString());
        Check.equal(0, r.code, r.err);
        Check.isTrue(Arrays.equals(Files.readAllBytes(TestMain.vectors().resolve("snapshot-dir.proof-U-100008.json")), Files.readAllBytes(proof)),
                "byte for byte the reference's proof file");

        String statement = referenceDir.resolve("snapshot.json").toString();
        Run ok = run("verify-proof", "--proof", proof.toString(), "--snapshot", statement);
        Check.equal(0, ok.code, ok.err);
        Check.equal(Arrays.asList("root+totals MATCH"), ok.outLines(), "the one line");

        String text = new String(Files.readAllBytes(proof), StandardCharsets.UTF_8);
        Path tampered = proof.resolveSibling("tampered.json");
        Files.write(tampered, text.replace("\"2112345678\"", "\"9112345678\"").getBytes(StandardCharsets.UTF_8));
        Run fail = run("verify-proof", "--proof", tampered.toString(), "--snapshot", statement);
        Check.equal(2, fail.code, "a tampered proof");
        Check.equal(Arrays.asList("root+totals FAIL"), fail.outLines(), "the one line");
        Check.isTrue(fail.err.contains("computed root"), "and why, on stderr: " + fail.err);

        Path renamed = proof.resolveSibling("renamed.json");
        Files.write(renamed, text.replace("\"user_ref\": \"U-100008\"", "\"user_ref\": \"U-100009\"").getBytes(StandardCharsets.UTF_8));
        Run other = run("verify-proof", "--proof", renamed.toString(), "--snapshot", statement);
        Check.equal(2, other.code, "another customer's name on a valid proof");
        Check.isTrue(other.err.contains("user_ref does not match"), other.err);

        Path notAProof = proof.resolveSibling("not-a-proof.json");
        Files.write(notAProof, "{\"hello\": \"world\"}".getBytes(StandardCharsets.UTF_8));
        Run shapeless = run("verify-proof", "--proof", notAProof.toString(), "--snapshot", statement);
        Check.equal(2, shapeless.code, "a file that is not a proof is a proof that fails");
        Check.equal(Arrays.asList("root+totals FAIL"), shapeless.outLines(), "the one line");

        Run nobody = run("prove", "--dir", referenceDir.toString(), "--user-ref", "nobody", "--out", proof.resolveSibling("x.json").toString());
        Check.equal(1, nobody.code, "an account the ledger did not have");
        Check.isTrue(nobody.err.contains("no leaf for user_ref nobody"), nobody.err);
        Check.equal(1, run("verify-proof", "--proof", proof.toString(), "--snapshot", proof.toString()).code, "a statement that is not one");
    }

    static void testProveRefusesADamagedDirectory() throws Exception {
        Path dir = built("damaged");
        Path leaves = dir.resolve("leaves.jsonl");
        String text = new String(Files.readAllBytes(leaves), StandardCharsets.UTF_8);
        Files.write(leaves, text.replace("\"2112345678\"", "\"2112345679\"").getBytes(StandardCharsets.UTF_8));
        Run r = run("prove", "--dir", dir.toString(), "--user-ref", "U-100008", "--out", dir.resolveSibling("p.json").toString());
        Check.equal(1, r.code, "exit code");
        Check.isTrue(r.err.contains("not the file this snapshot was built from"), r.err);
        Check.isTrue(!Files.exists(dir.resolveSibling("p.json")), "no proof was issued");
    }

    static void testConformanceRunsEveryVectorGroup() throws Exception {
        Run r = run("conformance", "--vectors", TestMain.vectors().toString());
        Check.equal(0, r.code, r.out + r.err);
        List<String> groups = new ArrayList<>();
        for (String line : r.outLines()) {
            Check.isTrue(line.matches("[a-z-]+: [1-9][0-9]* passed, 0 failed"), line);
            groups.add(line.substring(0, line.indexOf(':')));
        }
        Check.equal("[jcs, amounts, leaves, trees, statement, intake, snapshot-dir, database-path]", groups.toString(), "one line per group");
        Check.equal(1, run("conformance", "--vectors", TestMain.vectors().resolve("intake").toString()).code, "a directory without the vectors");
    }
}
