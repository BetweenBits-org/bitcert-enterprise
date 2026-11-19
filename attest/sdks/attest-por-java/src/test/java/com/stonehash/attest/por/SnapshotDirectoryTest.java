package com.stonehash.attest.por;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The exchange's private files: what is written, who may read it, and what is refused on the way back in. */
final class SnapshotDirectoryTest {
    private SnapshotDirectoryTest() {
    }

    private static Path written(String name) throws Exception {
        Path dir = TestMain.newDirectory(name).resolve("2026-11-16");
        PorTree tree = Sample.tree();
        SnapshotDirectory.write(dir, tree, Sample.seed(), Sample.statement(tree));
        return dir;
    }

    private static String mode(Path file) throws Exception {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(file));
    }

    private static void replaceInFile(Path file, String from, String to) throws Exception {
        String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        Check.isTrue(text.contains(from), file.getFileName() + " holds " + from);
        Files.write(file, text.replace(from, to).getBytes(StandardCharsets.UTF_8));
    }

    static void testWhatIsWrittenAndWhoMayReadIt() throws Exception {
        Path dir = written("write");
        List<String> names = new java.util.ArrayList<>();
        try (java.util.stream.Stream<Path> files = Files.list(dir)) {
            files.forEach(f -> names.add(f.getFileName().toString()));
        }
        Collections.sort(names);
        Check.equal("[leaves.jsonl, seed.hex, snapshot.json, tree.json]", names.toString(), "the four files");
        Check.equal("rw-------", mode(dir.resolve("leaves.jsonl")), "every account is in leaves.jsonl");
        Check.equal("rw-------", mode(dir.resolve("seed.hex")), "every salt derives from seed.hex");
        Check.equal("rw-------", mode(dir.resolve("tree.json")), "tree.json, as the reference writes it");
        Check.equal(Sample.SEED_HEX + "\n", new String(Files.readAllBytes(dir.resolve("seed.hex")), StandardCharsets.UTF_8), "seed.hex");
        String statement = new String(Files.readAllBytes(dir.resolve("snapshot.json")), StandardCharsets.UTF_8);
        Check.isTrue(!statement.contains("U-1000"), "the statement names no account");
        Check.equal(12, Files.readAllLines(dir.resolve("leaves.jsonl")).size(), "one line per account");
        Check.isTrue(!Files.readAllLines(dir.resolve("leaves.jsonl")).get(9).contains("\"0\""), "zero balances are implied, not written");
    }

    static void testAFileThatAlreadyExistsWithWiderPermissionsIsNarrowedBeforeItIsFilled() throws Exception {
        Path dir = TestMain.newDirectory("modes").resolve("snapshot");
        Files.createDirectories(dir);
        Files.write(dir.resolve("leaves.jsonl"), new byte[0]);
        Files.setPosixFilePermissions(dir.resolve("leaves.jsonl"), PosixFilePermissions.fromString("rw-r--r--"));
        PorTree tree = Sample.tree();
        SnapshotDirectory.write(dir, tree, Sample.seed(), Sample.statement(tree));
        Check.equal("rw-------", mode(dir.resolve("leaves.jsonl")), "leaves.jsonl");
    }

    static void testADirectoryReadBackReproducesItsTreeAndIssuesTheSameProofs() throws Exception {
        Path dir = written("load");
        PorTree original = Sample.tree();
        PorTree loaded = SnapshotDirectory.load(dir);
        Check.equal(original.root(), loaded.root(), "root");
        Check.equal(original.totals(), loaded.totals(), "totals");
        Check.equal(Sample.EXCHANGE, loaded.exchangeId(), "exchange id");
        for (int i = 0; i < 12; i++) {
            Check.equal(original.prove(i).toMap(), loaded.prove(i).toMap(), "opening " + i);
            Check.equal(original.userRef(i), loaded.userRef(i), "reference " + i);
        }
        Check.equal(Sample.statement(original), SnapshotDirectory.readStatement(dir), "the statement");
        // Written again from what was read, the files are the same files.
        Path again = TestMain.newDirectory("rewrite").resolve("copy");
        SnapshotDirectory.write(again, loaded, Sample.seed(), SnapshotDirectory.readStatement(dir));
        for (String name : Arrays.asList("leaves.jsonl", "tree.json", "seed.hex", "snapshot.json")) {
            Check.isTrue(Arrays.equals(Files.readAllBytes(dir.resolve(name)), Files.readAllBytes(again.resolve(name))), name + " is byte for byte the same");
        }
    }

    static void testADirectoryWrittenByAnotherSdkInItsOwnJsonStyleIsRead() throws Exception {
        Path dir = written("foreign");
        // Another language's JSON writer: spaces after separators, non-ASCII escaped, members in another order, CRLF.
        StringBuilder leaves = new StringBuilder();
        for (String line : Files.readAllLines(dir.resolve("leaves.jsonl"))) {
            java.util.Map<String, Object> leaf = Json.object(Json.parse(line, "test"), "test", "leaf");
            leaves.append("{\"balances\": ").append(Json.compact(leaf.get("balances")).replace(":", ": ").replace(",", ", "))
                    .append(", \"salt\": \"").append(leaf.get("salt")).append("\", \"user_ref_hash\": \"").append(leaf.get("user_ref_hash"))
                    .append("\", \"user_ref\": \"").append(((String) leaf.get("user_ref")).replace("U", "\\u0055")).append("\"}\r\n");
        }
        Files.write(dir.resolve("leaves.jsonl"), leaves.toString().getBytes(StandardCharsets.UTF_8));
        String checksum = Hex.encode(Hex.sha256().digest(leaves.toString().getBytes(StandardCharsets.UTF_8)));
        java.util.Map<String, Object> header = Json.object(Json.parse(new String(Files.readAllBytes(dir.resolve("tree.json")), StandardCharsets.UTF_8), "test"), "test", "header");
        java.util.Map<String, Object> rewritten = new java.util.TreeMap<>(header);
        rewritten.put("leaves_sha256", checksum);
        Files.write(dir.resolve("tree.json"), Json.compact(rewritten).getBytes(StandardCharsets.UTF_8));

        PorTree loaded = SnapshotDirectory.load(dir);
        Check.equal(Sample.ROOT, loaded.root(), "the same tree");
        Check.equal(3, loaded.indexOf("U-100008"), "the same accounts");
    }

    static void testDamagedOrMixedUpFilesAreRefusedBeforeAnythingIsIssued() throws Exception {
        Path edited = written("edited");
        replaceInFile(edited.resolve("leaves.jsonl"), "\"2112345678\"", "\"2112345679\"");
        PorException checksum = Check.refuses("leaves_checksum", () -> SnapshotDirectory.load(edited));
        Check.isTrue(checksum.getMessage().contains("not the file this snapshot was built from"), checksum.getMessage());

        Path truncated = written("truncated");
        List<String> lines = Files.readAllLines(truncated.resolve("leaves.jsonl"));
        Files.write(truncated.resolve("leaves.jsonl"), (String.join("\n", lines.subList(0, 11)) + "\n").getBytes(StandardCharsets.UTF_8));
        Check.refuses("leaves_checksum", () -> SnapshotDirectory.load(truncated));

        // The header edited to match the edited leaves: the checksum agrees, the root does not.
        Path forged = written("forged");
        replaceInFile(forged.resolve("leaves.jsonl"), "\"2112345678\"", "\"2112345679\"");
        String forgedChecksum = Hex.encode(Hex.sha256().digest(Files.readAllBytes(forged.resolve("leaves.jsonl"))));
        String header = new String(Files.readAllBytes(forged.resolve("tree.json")), StandardCharsets.UTF_8);
        Files.write(forged.resolve("tree.json"), header.replaceAll("\"leaves_sha256\": \"[0-9a-f]{64}\"", "\"leaves_sha256\": \"" + forgedChecksum + "\"")
                .getBytes(StandardCharsets.UTF_8));
        PorException root = Check.refuses("root_mismatch", () -> SnapshotDirectory.load(forged));
        Check.isTrue(root.getMessage().contains("refusing to issue anything"), root.getMessage());

        // A balance written as a JSON number: the same figure, other bytes, another root. Refused as a leaf.
        Path number = written("number");
        replaceInFile(number.resolve("leaves.jsonl"), "\"2112345678\"", "2112345678");
        String numberChecksum = Hex.encode(Hex.sha256().digest(Files.readAllBytes(number.resolve("leaves.jsonl"))));
        header = new String(Files.readAllBytes(number.resolve("tree.json")), StandardCharsets.UTF_8);
        Files.write(number.resolve("tree.json"), header.replaceAll("\"leaves_sha256\": \"[0-9a-f]{64}\"", "\"leaves_sha256\": \"" + numberChecksum + "\"")
                .getBytes(StandardCharsets.UTF_8));
        PorException notAString = Check.refuses("damaged_leaves", () -> SnapshotDirectory.load(number));
        Check.isTrue(notAString.getMessage().contains("decimal string") && notAString.getMessage().contains("line 4"), notAString.getMessage());

        Path noHeader = written("noheader");
        Files.delete(noHeader.resolve("tree.json"));
        Check.refuses("not_a_snapshot", () -> SnapshotDirectory.load(noHeader));
        Path noLeaves = written("noleaves");
        Files.delete(noLeaves.resolve("leaves.jsonl"));
        Check.refuses("not_a_snapshot", () -> SnapshotDirectory.load(noLeaves));
        Path oldVersion = written("version");
        replaceInFile(oldVersion.resolve("tree.json"), "stonehash.por-tree.v2", "stonehash.por-tree.v1");
        Check.refuses("unsupported_snapshot", () -> SnapshotDirectory.load(oldVersion));
        Path otherFile = written("otherfile");
        replaceInFile(otherFile.resolve("tree.json"), "\"leaves.jsonl\"", "\"../elsewhere/leaves.jsonl\"");
        Check.refuses("unsupported_snapshot", () -> SnapshotDirectory.load(otherFile));
    }

    static void testASnapshotThePlatformHasTakenIsNeverOverwrittenWithAnother() throws Exception {
        byte[] otherSeed = Leaves.newSeed();
        PorTree reseeded = PorTree.build(Sample.EXCHANGE, otherSeed, Sample.ledger());
        // Not yet handed over: nothing outside the directory depends on it, and it may be built again.
        Path fresh = written("rebuild");
        SnapshotDirectory.write(fresh, reseeded, otherSeed, Sample.statement(reseeded));
        Check.equal(reseeded.root(), SnapshotDirectory.load(fresh).root(), "the later build is what the directory holds");

        Path dir = written("overwrite");
        PorTree tree = Sample.tree();
        Statement statement = Sample.statement(tree);
        Files.write(dir.resolve("receipt.json"), "{}".getBytes(StandardCharsets.UTF_8));
        // The same snapshot again is the same files.
        SnapshotDirectory.write(dir, tree, Sample.seed(), statement);

        PorException e = Check.refuses("snapshot_exists", () -> SnapshotDirectory.write(dir, reseeded, otherSeed, Sample.statement(reseeded)));
        Check.isTrue(e.getMessage().contains("new directory"), e.getMessage());
        LedgerBuilder nextDay = new LedgerBuilder(Sample.assets(), AmountUnit.DECIMAL);
        nextDay.add("U-100001", "BTC", "0.75");
        PorTree changed = PorTree.build(Sample.EXCHANGE, Sample.seed(), nextDay.finish());
        Check.refuses("snapshot_exists", () -> SnapshotDirectory.write(dir, changed, Sample.seed(), Sample.statement(changed)));
        Check.equal(Sample.ROOT, SnapshotDirectory.load(dir).root(), "the snapshot that was there is intact");
    }

    static void testWhatDoesNotBelongTogetherIsNotWrittenTogether() throws Exception {
        PorTree tree = Sample.tree();
        Path dir = TestMain.newDirectory("mismatch").resolve("snapshot");
        byte[] wrongSeed = Leaves.newSeed();
        Check.refuses("seed_mismatch", () -> SnapshotDirectory.write(dir, tree, wrongSeed, Sample.statement(tree)));
        LedgerBuilder other = new LedgerBuilder(Sample.assets(), AmountUnit.DECIMAL);
        other.add("someone-else", "BTC", "1");
        PorTree otherTree = PorTree.build(Sample.EXCHANGE, Sample.seed(), other.finish());
        Check.refuses("statement_mismatch", () -> SnapshotDirectory.write(dir, tree, Sample.seed(), Sample.statement(otherTree)));
        Check.isTrue(!Files.exists(dir), "nothing was written");
    }

    static void testAFileSystemThatCannotKeepAFilePrivateIsRefused() throws Exception {
        // A zip file system has no owner-only permission; it stands in for any that has none.
        Path zip = TestMain.newDirectory("zip").resolve("archive.zip");
        try (FileSystem fs = FileSystems.newFileSystem(URI.create("jar:" + zip.toUri()), Collections.singletonMap("create", "true"))) {
            PorTree tree = Sample.tree();
            PorException e = Check.refuses("permissions_unsupported",
                    () -> SnapshotDirectory.write(fs.getPath("/snapshot"), tree, Sample.seed(), Sample.statement(tree)));
            Check.isTrue(e.getMessage().contains("cannot restrict a file to its owner"), e.getMessage());
            Check.isTrue(!Files.exists(fs.getPath("/snapshot/seed.hex")), "the seed was not written where it could not be protected");
        }
    }

    static void testACustomersProofFile() throws Exception {
        Path dir = written("proof");
        Statement statement = SnapshotDirectory.readStatement(dir);
        ProofFile issued = ProofFile.issue(statement, SnapshotDirectory.load(dir), "U-100008");
        Path file = dir.resolve("proof-U-100008.json");
        SnapshotDirectory.writeProofFile(file, issued);
        Check.isTrue(Arrays.equals(Files.readAllBytes(TestMain.vectors().resolve("snapshot-dir.proof-U-100008.json")), Files.readAllBytes(file)),
                "byte for byte the proof file the reference writes");

        ProofFile read = SnapshotDirectory.readProofFile(file);
        Check.equal("U-100008", read.userRef(), "it names its owner");
        Check.isTrue(read.verify(statement).ok(), "it verifies against the statement");
        Check.isTrue(read.referenceMatches(Sample.EXCHANGE), "the reference is the one the leaf was hashed from");
        Check.isTrue(!read.referenceMatches("KR-EX-other"), "under this exchange and no other");
        Check.equal("{BTC=2112345678, ETH=0, USDT=0}", read.proof().leaf().balances().toString(), "the balances it proves");

        String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        ProofFile renamed = ProofFile.parse(text.replace("\"user_ref\": \"U-100008\"", "\"user_ref\": \"U-100009\""));
        Check.isTrue(renamed.verify(statement).ok() && !renamed.referenceMatches(Sample.EXCHANGE),
                "another customer's name on it: root and totals hold, the reference does not");
        Check.isTrue(!ProofFile.parse(text.replace("\"2112345678\"", "\"9112345678\"")).verify(statement).ok(), "a changed balance");
        Check.refuses("invalid_proof", () -> ProofFile.parse("{\"schema\":\"stonehash.por-proof.v1\"}"));
        Check.refuses("unknown_account", () -> ProofFile.issue(statement, SnapshotDirectory.load(dir), "nobody"));
        LedgerBuilder other = new LedgerBuilder(Sample.assets(), AmountUnit.DECIMAL);
        other.add("U-100008", "BTC", "1");
        Check.refuses("statement_mismatch", () -> ProofFile.issue(statement, PorTree.build(Sample.EXCHANGE, Sample.seed(), other.finish()), "U-100008"));
    }
}
