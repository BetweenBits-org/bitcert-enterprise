import com.stonehash.attest.por.AmountUnit;
import com.stonehash.attest.por.AssetSpec;
import com.stonehash.attest.por.CanonicalJson;
import com.stonehash.attest.por.Conformance;
import com.stonehash.attest.por.CsvLayout;
import com.stonehash.attest.por.CsvLedger;
import com.stonehash.attest.por.CsvOptions;
import com.stonehash.attest.por.KeySigner;
import com.stonehash.attest.por.Leaves;
import com.stonehash.attest.por.Ledger;
import com.stonehash.attest.por.LedgerBuilder;
import com.stonehash.attest.por.PorApiException;
import com.stonehash.attest.por.PorClient;
import com.stonehash.attest.por.PorException;
import com.stonehash.attest.por.PorTree;
import com.stonehash.attest.por.Problem;
import com.stonehash.attest.por.ProofFile;
import com.stonehash.attest.por.ProofVerification;
import com.stonehash.attest.por.Receipt;
import com.stonehash.attest.por.Signer;
import com.stonehash.attest.por.Signers;
import com.stonehash.attest.por.SnapshotDirectory;
import com.stonehash.attest.por.SnapshotStatus;
import com.stonehash.attest.por.Statement;
import com.stonehash.attest.por.Submission;
import com.stonehash.attest.por.SubmitResult;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Clock;
import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Proof of reserves from inside an exchange's own system — the integration
 * example for the Java SDK, and a small command line over the same calls.
 *
 * <p>Read the first half as the example. Each step of a snapshot is one short
 * function that calls the library and nothing else:
 *
 * <pre>
 *   1. the ledger      {@link #ledgerFromYourDatabase}  (or {@link #ledgerFromCsvExport})
 *   2. tree, statement {@link #buildTree}, {@link #buildStatement}, {@link #keepPrivateFiles}
 *   3. sign            {@link #signStatement}
 *   4. submit          {@link #checkRegisteredKey}, {@link #submit}
 *   5. proofs          {@link #issueProof}, {@link #checkProof}
 * </pre>
 *
 * <p>The second half is plumbing: the command line that drives those
 * functions, so that this SDK can be run side by side with the ones in other
 * languages.
 */
public final class PorExample {
    private PorExample() {
    }

    // ══════════════════════════════════════════════════════════════════════
    //  1. THE LEDGER
    // ══════════════════════════════════════════════════════════════════════

    /**
     * ┌────────────────────────────────────────────────────────────────────┐
     * │ THE DATABASE PATH — the ledger straight from your own query.       │
     * │ No export file is written on the way.                              │
     * └────────────────────────────────────────────────────────────────────┘
     *
     * <p>In your system the loop below runs over a JDBC {@code ResultSet}:
     *
     * <pre>{@code
     * try (ResultSet rs = statement.executeQuery(
     *         "SELECT user_id, currency, SUM(available + locked) AS balance "
     *       + "FROM balances GROUP BY user_id, currency")) {
     *     while (rs.next()) {
     *         ledger.add(rs.getString("user_id"), rs.getString("currency"), rs.getString("balance"));
     *     }
     * }
     * }</pre>
     *
     * Three things to keep as they are here. Read the amount as <b>text</b>
     * ({@code getString}, or {@code getBigDecimal(...).toPlainString()}),
     * never as a {@code double}. Sum in the query, where the decision can be
     * reviewed: a second row for the same account and asset is refused, not
     * added up. And act on the report: a ledger with any refused row yields
     * no rows at all.
     *
     * @param yourQuery stands in for the result set: one record per account and asset
     */
    static Ledger ledgerFromYourDatabase(List<AssetSpec> assets, AmountUnit unit, Iterable<BalanceRecord> yourQuery) {
        LedgerBuilder ledger = new LedgerBuilder(assets, unit);
        for (BalanceRecord row : yourQuery) {
            ledger.add(row.userId, row.currency, row.balance);
        }
        return ledger.finish();
    }

    /**
     * The database path again, for a query that returns one row per account
     * with a column per asset. A missing or empty value is "holds none".
     *
     * @param yourQuery stands in for the result set: account reference to (asset to amount text)
     */
    static Ledger ledgerFromAccountRows(List<AssetSpec> assets, AmountUnit unit, Map<String, Map<String, String>> yourQuery) {
        LedgerBuilder ledger = new LedgerBuilder(assets, unit);
        for (Map.Entry<String, Map<String, String>> account : yourQuery.entrySet()) {
            ledger.addAccount(account.getKey(), account.getValue());
        }
        return ledger.finish();
    }

    /** One row of "your own query": an account, an asset, and the amount as the database prints it. */
    static final class BalanceRecord {
        final String userId;
        final String currency;
        final String balance;

        BalanceRecord(String userId, String currency, String balance) {
            this.userId = userId;
            this.currency = currency;
            this.balance = balance;
        }
    }

    /** The other way in: a CSV file the ledger exported. Streamed; the report says what it added up to. */
    static Ledger ledgerFromCsvExport(Path csv, CsvOptions options) {
        return CsvLedger.read(csv, options);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  2. THE TREE AND THE STATEMENT
    // ══════════════════════════════════════════════════════════════════════

    /** Builds the liability tree. The seed is this snapshot's secret: every account's salt derives from it. */
    static PorTree buildTree(String exchangeId, byte[] seed, Ledger ledger) {
        return PorTree.build(exchangeId, seed, ledger);
    }

    /** The statement: root, totals, number of accounts, as-of time. The only thing that will be sent. */
    static Statement buildStatement(String exchangeId, String exchangeName, String asof, Ledger ledger, PorTree tree, Clock clock) {
        return Statement.builder()
                .exchange(exchangeId, exchangeName)
                .asof(asof)
                .assets(ledger.assets())
                .tree(tree)
                .clock(clock)
                .build();
    }

    /**
     * Writes what the exchange keeps: leaves.jsonl and seed.hex (mode 0600),
     * tree.json and snapshot.json. Lose the first two and no customer's proof
     * can be issued for this snapshot again.
     */
    static void keepPrivateFiles(Path dir, PorTree tree, byte[] seed, Statement statement) {
        SnapshotDirectory.write(dir, tree, seed, statement);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  3. SIGN
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Signs the statement. {@code signer} is whatever holds the exchange's
     * key: {@link Signers#fromPkcs8Pem} for a key file, or your own
     * implementation of {@link Signer} over an HSM or a KMS.
     */
    static Submission signStatement(Statement statement, Signer signer) {
        return Submission.sign(statement, signer);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  4. SUBMIT
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Whether the submission was signed with the key the platform holds for
     * this exchange. Asked before sending, so that "the wrong key was used"
     * is found on this machine and not in a refused request.
     */
    static boolean checkRegisteredKey(PorClient client, Submission submission) {
        String registered = client.registeredKey(submission.statement().institutionId());
        return submission.verifies(registered);
    }

    /**
     * Hands the signed statement to the platform.
     *
     * @param treeForSpotCheck null to send the statement and signature only (the default: nothing about any
     *                         account leaves). The local tree to ask for a spot check: the platform then
     *                         names a few leaf positions and the SDK opens exactly those, pseudonymously.
     */
    static SubmitResult submit(PorClient client, Submission submission, PorTree treeForSpotCheck) {
        return treeForSpotCheck == null
                ? client.submit(submission)
                : client.submitWithSpotCheck(submission, treeForSpotCheck);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  5. PROOFS FOR CUSTOMERS
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Issues one customer's proof from the kept files. Loading checks the
     * leaves against their recorded checksum and root first, so a proof is
     * never issued from a damaged or mixed-up snapshot.
     */
    static ProofFile issueProof(Path dir, String userRef) {
        Statement statement = SnapshotDirectory.readStatement(dir);
        PorTree tree = SnapshotDirectory.load(dir);
        return ProofFile.issue(statement, tree, userRef);
    }

    /** What a customer (or their auditor) runs: the proof against the published statement, offline. */
    static ProofVerification checkProof(ProofFile proof, Statement publishedStatement) {
        return proof.verify(publishedStatement);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  THE COMMAND LINE — plumbing from here on
    // ══════════════════════════════════════════════════════════════════════

    private static final String USAGE = String.join("\n",
            "usage: por-example <command> [options]",
            "",
            "  build         --csv FILE --amounts decimal|base --assets BTC:8,ETH:18 --exchange ID --name NAME",
            "                --asof ISO --out DIR [--seed-hex HEX64] [--generated-at ISO] [--layout long|wide]",
            "                [--delimiter C] [--col-account N] [--col-asset N] [--col-balance N] [--ignore-columns a,b]",
            "  sign          --dir DIR --key PEMFILE",
            "  submit        --dir DIR --core URL [--spot-check] [--wait] [--timeout-sec N]   (API key: STONEHASH_API_KEY)",
            "  status        --core URL --snapshot ID                                         (API key: STONEHASH_API_KEY)",
            "  prove         --dir DIR --user-ref REF --out FILE",
            "  verify-proof  --proof FILE --snapshot FILE",
            "  conformance   --vectors DIR",
            "",
            "exit codes: 0 done; 1 usage, file or platform trouble; 2 an export with problems, a proof that fails,",
            "            a failed conformance vector");

    private static final int OK = 0;
    private static final int TROUBLE = 1;
    private static final int INVALID = 2;

    public static void main(String[] args) {
        // Fixed, so that what is printed does not depend on the machine's locale.
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        PrintStream err = new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8);
        // Java decodes the command line in the locale's character set. Under any
        // other than UTF-8 an exchange name in Korean arrives as different text,
        // and would be signed as such.
        String decodedAs = System.getProperty("sun.jnu.encoding", "");
        if (!decodedAs.equalsIgnoreCase("UTF-8") && !String.join("", args).chars().allMatch(c -> c < 0x80)) {
            err.println("por-example: the command line holds non-ASCII text, but this locale's character set is " + decodedAs
                    + "; run under a UTF-8 locale (for example LC_ALL=C.UTF-8)");
            System.exit(TROUBLE);
        }
        System.exit(run(args, out, err, System.getenv()));
    }

    /** Runs one command and returns its exit code. */
    public static int run(String[] args, PrintStream out, PrintStream err, Map<String, String> env) {
        try {
            String command = args.length == 0 ? "help" : args[0];
            String[] rest = args.length == 0 ? args : Arrays.copyOfRange(args, 1, args.length);
            switch (command) {
                case "build":
                    return runBuild(rest, out, err);
                case "sign":
                    return runSign(rest, out);
                case "submit":
                    return runSubmit(rest, out, env);
                case "status":
                    return runStatus(rest, out, env);
                case "prove":
                    return runProve(rest, out);
                case "verify-proof":
                    return runVerifyProof(rest, out, err);
                case "conformance":
                    return runConformance(rest, out, err);
                case "help":
                case "--help":
                case "-h":
                    out.println(USAGE);
                    return OK;
                default:
                    throw new Trouble("unknown command \"" + command + "\"\n\n" + USAGE);
            }
        } catch (Trouble e) {
            err.println("por-example: " + e.getMessage());
            return TROUBLE;
        } catch (PorApiException e) {
            err.println("por-example: the platform refused (" + e.code() + (e.status() > 0 ? ", HTTP " + e.status() : "")
                    + "): " + e.getMessage());
            return TROUBLE;
        } catch (PorException e) {
            err.println("por-example: " + e.getMessage() + " [" + e.code() + "]");
            return TROUBLE;
        } catch (IOException e) {
            err.println("por-example: " + e);
            return TROUBLE;
        }
    }

    /** A mistake in the command line, or something missing on disk: reported in a sentence, exit code 1. */
    private static final class Trouble extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Trouble(String message) {
            super(message);
        }
    }

    private static int runBuild(String[] args, PrintStream out, PrintStream err) {
        Options o = Options.parse(args, new String[] { "csv", "amounts", "assets", "exchange", "name", "asof", "out",
                "seed-hex", "generated-at", "layout", "delimiter", "col-account", "col-asset", "col-balance", "ignore-columns" });
        List<AssetSpec> assets = AssetSpec.parseList(o.required("assets"));
        // Never defaulted: "1" is one coin or one smallest unit, and only the exchange knows which its ledger prints.
        AmountUnit unit = AmountUnit.parse(o.required("amounts"));
        String asof = o.required("asof");
        if (!Statement.isInstant(asof)) {
            throw new Trouble("--asof \"" + asof + "\" is not an instant; write it as 2026-11-16T00:00:00Z");
        }
        Path csv = existing(Paths.get(o.required("csv")), "the export");
        Path dir = Paths.get(o.required("out"));
        String exchangeId = o.required("exchange");
        String exchangeName = o.required("name");
        byte[] seed = o.has("seed-hex") ? seedFromHex(o.get("seed-hex")) : Leaves.newSeed();
        Clock clock = o.has("generated-at") ? Clock.fixed(instant(o.get("generated-at")), ZoneOffset.UTC) : Clock.systemUTC();

        Ledger ledger = ledgerFromCsvExport(csv, csvOptions(o, assets, unit));
        if (!ledger.ok()) {
            for (Problem p : ledger.report().problems()) {
                err.println("line " + p.line() + " " + p.code() + " " + p.message());
            }
            long unlisted = ledger.report().problemCount() - ledger.report().problems().size();
            if (unlisted > 0) {
                err.println("… and " + unlisted + " more problems");
            }
            return INVALID;
        }
        PorTree tree = buildTree(exchangeId, seed, ledger);
        Statement statement = buildStatement(exchangeId, exchangeName, asof, ledger, tree, clock);
        keepPrivateFiles(dir, tree, seed, statement);

        out.println("root " + tree.root());
        out.println("totals " + CanonicalJson.of(statement.toMap().get("totals")));
        out.println("commitment " + statement.commitment());
        return OK;
    }

    private static CsvOptions csvOptions(Options o, List<AssetSpec> assets, AmountUnit unit) {
        CsvOptions options = new CsvOptions(assets, unit);
        if (o.has("layout")) {
            options.layout(CsvLayout.parse(o.get("layout")));
        }
        if (o.has("delimiter")) {
            String d = o.get("delimiter").equals("\\t") ? "\t" : o.get("delimiter");
            if (d.length() != 1) {
                throw new Trouble("--delimiter is a single character (write \\t for a tab)");
            }
            options.delimiter(d.charAt(0));
        }
        if (o.has("col-account")) {
            options.accountColumn(o.get("col-account"));
        }
        if (o.has("col-asset")) {
            options.assetColumn(o.get("col-asset"));
        }
        if (o.has("col-balance")) {
            options.balanceColumn(o.get("col-balance"));
        }
        if (o.has("ignore-columns")) {
            List<String> names = new ArrayList<>();
            for (String name : o.get("ignore-columns").split(",")) {
                if (!name.trim().isEmpty()) {
                    names.add(name.trim());
                }
            }
            options.ignoreColumns(names);
        }
        return options;
    }

    private static int runSign(String[] args, PrintStream out) throws IOException {
        Options o = Options.parse(args, new String[] { "dir", "key" });
        Path dir = Paths.get(o.required("dir"));
        existing(dir.resolve(SnapshotDirectory.SNAPSHOT_FILE), "run \"build\" first");
        Statement statement = SnapshotDirectory.readStatement(dir);
        Path keyFile = existing(Paths.get(o.required("key")), "the signing key");
        KeySigner signer = Signers.fromPkcs8Pem(new String(Files.readAllBytes(keyFile), StandardCharsets.UTF_8));

        Submission submission = signStatement(statement, signer);
        if (!submission.verifies(signer.publicKeySpkiBase64())) {
            throw new Trouble("the signature did not verify against its own key; nothing was written");
        }
        SnapshotDirectory.writeSubmission(dir, submission);
        out.println("signed " + dir.resolve(SnapshotDirectory.SUBMISSION_FILE));
        return OK;
    }

    private static int runSubmit(String[] args, PrintStream out, Map<String, String> env) {
        Options o = Options.parse(args, new String[] { "dir", "core", "timeout-sec" }, "spot-check", "wait");
        Path dir = Paths.get(o.required("dir"));
        existing(dir.resolve(SnapshotDirectory.SUBMISSION_FILE), "run \"sign\" first");
        Submission submission = SnapshotDirectory.readSubmission(dir);
        List<String> unusable = submission.validate();
        if (!unusable.isEmpty()) {
            throw new Trouble(SnapshotDirectory.SUBMISSION_FILE + " is not usable: " + String.join("; ", unusable));
        }
        long timeoutSeconds = o.has("timeout-sec") ? positiveSeconds(o.get("timeout-sec")) : 600;
        PorClient client = client(o.required("core"), env);

        if (!checkRegisteredKey(client, submission)) {
            throw new Trouble(SnapshotDirectory.SUBMISSION_FILE + " was not signed with the key registered for this exchange; "
                    + "nothing was sent. Sign it with the registered key, or register this one in the console");
        }
        // Loaded before anything is sent: a snapshot whose private files are damaged cannot answer a challenge.
        PorTree tree = o.has("spot-check") ? SnapshotDirectory.load(dir) : null;
        SubmitResult result = submit(client, submission, tree);
        if (result.spotCheck()) {
            // Kept beside the snapshot: an exact record of the account-level data that left.
            SnapshotDirectory.writeOpenings(dir, result.openings());
        }
        Receipt receipt = Receipt.of(result, submission.statement(), client, Instant.now());
        SnapshotDirectory.writeReceipt(dir, receipt);
        out.println("snapshot " + result.snapshotId() + " " + result.status());

        if (o.has("wait")) {
            client.waitAnchored(result.snapshotId(), Duration.ofSeconds(timeoutSeconds));
            SnapshotDirectory.writeReceipt(dir, receipt.anchorConfirmed());
        }
        return OK;
    }

    private static int runStatus(String[] args, PrintStream out, Map<String, String> env) {
        Options o = Options.parse(args, new String[] { "core", "snapshot" });
        SnapshotStatus status = client(o.required("core"), env).status(o.required("snapshot"));
        out.println(status.toJson());
        return OK;
    }

    private static int runProve(String[] args, PrintStream out) {
        Options o = Options.parse(args, new String[] { "dir", "user-ref", "out" });
        Path dir = Paths.get(o.required("dir"));
        existing(dir.resolve(SnapshotDirectory.SNAPSHOT_FILE), "run \"build\" first");
        String userRef = o.required("user-ref");
        Path file = Paths.get(o.required("out"));
        ProofFile proof;
        try {
            proof = issueProof(dir, userRef);
        } catch (PorException e) {
            if (e.code().equals("unknown_account")) {
                throw new Trouble("no leaf for user_ref " + userRef);
            }
            throw e;
        }
        SnapshotDirectory.writeProofFile(file, proof);
        out.println("proof for leaf " + proof.proof().leafIndex() + " written to " + file);
        return OK;
    }

    private static int runVerifyProof(String[] args, PrintStream out, PrintStream err) throws IOException {
        Options o = Options.parse(args, new String[] { "proof", "snapshot" });
        Path proofPath = existing(Paths.get(o.required("proof")), "the proof file your exchange gave you");
        Path statementPath = existing(Paths.get(o.required("snapshot")), "the snapshot statement");
        Statement statement = Statement.parse(new String(Files.readAllBytes(statementPath), StandardCharsets.UTF_8));
        List<String> invalid = statement.validate();
        if (!invalid.isEmpty()) {
            throw new Trouble("the snapshot statement is not valid: " + String.join("; ", invalid));
        }

        ProofFile proof;
        try {
            proof = SnapshotDirectory.readProofFile(proofPath);
        } catch (PorException e) {
            if (!e.code().equals("invalid_proof")) {
                throw e;
            }
            // A file that is not a proof is a proof that fails.
            out.println("root+totals FAIL");
            err.println("  ! " + e.getMessage());
            return INVALID;
        }
        ProofVerification verification = checkProof(proof, statement);
        boolean referenceMatches = proof.referenceMatches(statement.institutionId());
        out.println("root+totals " + (verification.ok() ? "MATCH" : "FAIL"));
        for (String problem : verification.problems()) {
            err.println("  ! " + problem);
        }
        if (!referenceMatches) {
            err.println("  ! user_ref does not match user_ref_hash");
        }
        return verification.ok() && referenceMatches ? OK : INVALID;
    }

    private static int runConformance(String[] args, PrintStream out, PrintStream err) {
        Options o = Options.parse(args, new String[] { "vectors" });
        Path vectors = Paths.get(o.required("vectors"));
        if (!Files.isDirectory(vectors)) {
            throw new Trouble(vectors + " is not a directory");
        }
        boolean allPassed = true;
        for (Conformance.Group group : Conformance.run(vectors)) {
            out.println(group.name() + ": " + group.passed() + " passed, " + group.failed() + " failed");
            for (String failure : group.failures()) {
                err.println("  ! " + group.name() + " — " + failure);
            }
            allPassed &= group.failed() == 0;
        }
        List<String> failures = databasePathFailures(vectors);
        out.println("database-path: " + (2 - failures.size()) + " passed, " + failures.size() + " failed");
        for (String failure : failures) {
            err.println("  ! database-path — " + failure);
        }
        return allPassed && failures.isEmpty() ? OK : INVALID;
    }

    // ── the database path, checked against the file path ────────────────────

    /**
     * The sample ledger of the vectors ({@code intake/long.csv}) as "your own
     * query" would return it: an in-memory list standing in for a result set.
     */
    private static final List<BalanceRecord> SAMPLE_QUERY_RESULT = Arrays.asList(
            new BalanceRecord("U-100001", "BTC", "0.50000000"), new BalanceRecord("U-100001", "ETH", "12.5"),
            new BalanceRecord("U-100001", "USDT", "1500.25"), new BalanceRecord("U-100002", "BTC", "0.00012345"),
            new BalanceRecord("U-100003", "ETH", "0.000000000000000001"), new BalanceRecord("U-100003", "USDT", "250000"),
            new BalanceRecord("U-100004", "BTC", "3"), new BalanceRecord("U-100004", "USDT", "0"),
            new BalanceRecord("U-100005", "ETH", "1.25"), new BalanceRecord("U-100006", "BTC", "0.01"),
            new BalanceRecord("U-100006", "ETH", "0.3"), new BalanceRecord("U-100006", "USDT", "99.999999"),
            new BalanceRecord("U-100007", "USDT", "10"), new BalanceRecord("U-100008", "BTC", "21.12345678"),
            new BalanceRecord("U-100009", "ETH", "100"), new BalanceRecord("U-100009", "USDT", "0.000001"),
            new BalanceRecord("U-100010", "BTC", "0.00000001"), new BalanceRecord("U-100011", "USDT", "4200.5"),
            new BalanceRecord("U-100012", "BTC", "0"), new BalanceRecord("U-100012", "ETH", "0"));

    /**
     * Feeds the sample ledger through both forms of the database path and
     * compares the root with the one the file path reaches for the same
     * ledger. Empty when both agree.
     */
    private static List<String> databasePathFailures(Path vectors) {
        List<AssetSpec> assets = AssetSpec.parseList("BTC:8,ETH:18,USDT:6");
        String exchangeId = "KR-EX-0a1b2c";
        byte[] seed = seedFromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
        Ledger fromFile = ledgerFromCsvExport(vectors.resolve("intake").resolve("long.csv"),
                new CsvOptions(assets, AmountUnit.DECIMAL));
        String wanted = buildTree(exchangeId, seed, fromFile).root();

        Map<String, Map<String, String>> byAccount = new LinkedHashMap<>();
        for (BalanceRecord row : SAMPLE_QUERY_RESULT) {
            byAccount.computeIfAbsent(row.userId, account -> new HashMap<>()).put(row.currency, row.balance);
        }
        Ledger rowPerBalance = ledgerFromYourDatabase(assets, AmountUnit.DECIMAL, SAMPLE_QUERY_RESULT);
        Ledger rowPerAccount = ledgerFromAccountRows(assets, AmountUnit.DECIMAL, byAccount);

        List<String> failures = new ArrayList<>();
        if (!rowPerBalance.ok() || !buildTree(exchangeId, seed, rowPerBalance).root().equals(wanted)) {
            failures.add("rows per account and asset do not reach the root of the same ledger read from a file");
        }
        if (!rowPerAccount.ok() || !buildTree(exchangeId, seed, rowPerAccount).root().equals(wanted)) {
            failures.add("rows per account do not reach the root of the same ledger read from a file");
        }
        return failures;
    }

    // ── small helpers ───────────────────────────────────────────────────────

    private static PorClient client(String core, Map<String, String> env) {
        String apiKey = env.get("STONEHASH_API_KEY");
        if (apiKey == null || apiKey.isEmpty()) {
            throw new Trouble("no API key: set the environment variable STONEHASH_API_KEY");
        }
        return PorClient.builder(core).apiKey(apiKey).build();
    }

    private static Path existing(Path file, String what) {
        if (!Files.exists(file)) {
            throw new Trouble(file + " not found — " + what);
        }
        return file;
    }

    private static byte[] seedFromHex(String hex) {
        if (!hex.matches("[0-9a-fA-F]{64}")) {
            throw new Trouble("--seed-hex must be 32 bytes of hex (64 characters)");
        }
        byte[] seed = new byte[Leaves.SEED_BYTES];
        for (int i = 0; i < seed.length; i++) {
            seed[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        }
        return seed;
    }

    private static Instant instant(String iso) {
        try {
            return Instant.parse(iso);
        } catch (DateTimeException e) {
            throw new Trouble("--generated-at \"" + iso + "\" is not a UTC instant; write it as 2026-11-16T01:02:03.456Z");
        }
    }

    private static long positiveSeconds(String text) {
        if (!text.matches("[0-9]{1,9}") || Long.parseLong(text) == 0) {
            throw new Trouble("--timeout-sec is a number of seconds");
        }
        return Long.parseLong(text);
    }

    /** {@code --name value} (or {@code --name=value}) and {@code --flag}, with a sentence instead of a stack trace for a typing mistake. */
    private static final class Options {
        private final Map<String, String> values = new HashMap<>();

        /**
         * @param valued options that take a value
         * @param flags  options that are either present or not
         */
        static Options parse(String[] args, String[] valued, String... flags) {
            Options o = new Options();
            for (int i = 0; i < args.length; i++) {
                if (!args[i].startsWith("--")) {
                    throw new Trouble("unexpected argument \"" + args[i] + "\"\n\n" + USAGE);
                }
                int equals = args[i].indexOf('=');
                String name = args[i].substring(2, equals < 0 ? args[i].length() : equals);
                if (Arrays.asList(flags).contains(name) && equals < 0) {
                    o.values.put(name, "");
                } else if (Arrays.asList(valued).contains(name)) {
                    if (equals < 0 && i + 1 == args.length) {
                        throw new Trouble("--" + name + " needs a value");
                    }
                    o.values.put(name, equals < 0 ? args[++i] : args[i].substring(equals + 1));
                } else {
                    throw new Trouble("unknown option --" + name + "\n\n" + USAGE);
                }
            }
            return o;
        }

        boolean has(String name) {
            return values.containsKey(name);
        }

        String get(String name) {
            return values.get(name);
        }

        String required(String name) {
            if (!values.containsKey(name)) {
                throw new Trouble("--" + name + " is required");
            }
            return values.get(name);
        }
    }
}
