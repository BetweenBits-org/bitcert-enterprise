// Command por-example is the integration example of the StoneHash Attest
// proof-of-reserves SDK for Go.
//
// It does two jobs. It is a small command line over the library, with the
// interface every language's SDK example shares, so that one test can drive
// them all and compare what they produce. And it is the example to read
// before putting the library inside your own system: every step of a
// snapshot is one short function below, in the order the steps happen.
//
//	readExport          a balance export file      → a checked ledger
//	ledgerFromDatabase  rows from your own query   → the same checked ledger
//	buildSnapshot       ledger → tree → statement  (nothing leaves the machine)
//	signSnapshot        statement → submission.json, the one file that is sent
//	submitSnapshot      submission.json → the platform; optionally a spot check
//	proveAccount        one customer's inclusion proof
//	verifyProofFile     what that customer, or their auditor, checks
//
// Inside your system you would call ledgerFromDatabase's body instead of
// readExport, and keep the rest.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	por "stonehash.com/attest/por"
	"stonehash.com/attest/por/conformance"
)

// Exit codes shared by every SDK's example.
const (
	exitOK = 0
	// exitFailed: a usage mistake, a file that could not be read or written,
	// or a refusal by the platform.
	exitFailed = 1
	// exitInvalid: the data did not pass a check — an export with problems, a
	// proof that does not hold, a vector that does not pass.
	exitInvalid = 2
)

const usage = `usage: por-example <command> [options]

  build         --csv FILE --amounts decimal|base --assets BTC:8,ETH:18 --exchange ID --name NAME --asof ISO --out DIR
                [--seed-hex HEX64] [--generated-at ISO] [--layout long|wide] [--delimiter C]
                [--col-account N] [--col-asset N] [--col-balance N] [--ignore-columns a,b]
  sign          --dir DIR --key PEMFILE
  submit        --dir DIR --core URL [--spot-check] [--wait] [--timeout-sec N]     (API key: STONEHASH_API_KEY)
  status        --core URL --snapshot ID                                         (API key: STONEHASH_API_KEY)
  prove         --dir DIR --user-ref REF --out FILE
  verify-proof  --proof FILE --snapshot FILE
  conformance   --vectors DIR
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv)
	stop()
	os.Exit(code)
}

// run is the whole program, with its surroundings passed in so that a test
// can call it.
func run(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return exitFailed
	}
	var err error
	switch command, rest := args[0], args[1:]; command {
	case "build":
		err = buildCommand(rest, stdout, stderr)
	case "sign":
		err = signCommand(rest)
	case "submit":
		err = submitCommand(ctx, rest, stdout, getenv)
	case "status":
		err = statusCommand(ctx, rest, stdout, getenv)
	case "prove":
		err = proveCommand(rest)
	case "verify-proof":
		err = verifyProofCommand(rest, stdout, stderr)
	case "conformance":
		err = conformanceCommand(rest, stdout, stderr)
	case "help", "--help", "-h":
		fmt.Fprint(stdout, usage)
	default:
		err = fmt.Errorf("unknown command %q\n\n%s", command, usage)
	}
	if err == nil {
		return exitOK
	}
	var invalid invalidError
	if errors.As(err, &invalid) {
		if invalid.reason != "" {
			fmt.Fprintf(stderr, "por-example: %s\n", invalid.reason)
		}
		return exitInvalid
	}
	fmt.Fprintf(stderr, "por-example: %v\n", err)
	return exitFailed
}

// invalidError ends the program with exitInvalid. Its reason may be empty
// when the command has already said what was wrong.
type invalidError struct{ reason string }

func (e invalidError) Error() string { return e.reason }

// ---------------------------------------------------------------------------
// Step 1, from a file: read and check a balance export.
// ---------------------------------------------------------------------------

// readExport reads a CSV export, streamed. The ledger is nil unless the
// report is OK: nothing is built from a file that did not read cleanly.
func readExport(file string, opts por.CSVOptions) (*por.Ledger, *por.Report, error) {
	return por.ReadCSVFile(file, opts)
}

// ---------------------------------------------------------------------------
// Step 1, THE DATABASE PATH: the same ledger straight from your own query.
//
// This is the function to take into your system. There is no file: each row
// of the result set goes to the ledger builder as it is read, and the builder
// applies exactly the rules a file is read by. With database/sql the loop is
//
//	rows, err := db.QueryContext(ctx, `
//	    SELECT account_id, asset, CAST(SUM(available + locked) AS CHAR)
//	      FROM balances GROUP BY account_id, asset`)
//	...
//	for rows.Next() {
//	    var r balanceRow
//	    if err := rows.Scan(&r.Account, &r.Asset, &r.Amount); err != nil { ... }
//	    ledger.Add(r.Account, r.Asset, r.Amount)
//	}
//
// Three things to keep from the query above: one row per account and asset
// (sum wallets that are meant to add up there, where the rule can be
// reviewed); everything owed is counted, locked balances included; and the
// amount leaves the database as text, never through a floating-point type.
// Read the whole ledger inside one consistent-read transaction and use its
// time as the statement's as-of time.
// ---------------------------------------------------------------------------

// balanceRow is one row of the query: an account, an asset, and the amount as
// the database prints it.
type balanceRow struct {
	Account, Asset, Amount string
}

func ledgerFromDatabase(resultSet []balanceRow, assets []por.Asset) (*por.Ledger, *por.Report, error) {
	ledger, err := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Decimal})
	if err != nil {
		return nil, nil, err
	}
	for _, r := range resultSet {
		// Add returns what was wrong with this row, if anything, which is
		// worth logging beside your own primary key. It does not need to be
		// acted on here: the decision is taken on the whole ledger, below.
		_ = ledger.Add(r.Account, r.Asset, r.Amount)
	}
	// The ledger is nil unless the report is OK. A problem's Line is the
	// ordinal of the row in the result set, and its Message may quote the
	// account or the amount it is about: log it where the ledger may be seen.
	checked, report := ledger.Finish()
	return checked, report, nil
}

// sampleResultSet stands in for the result set of your own query. It is the
// sample ledger of the conformance vectors (intake/long.csv), which is why
// the root it leads to is known in advance.
var sampleResultSet = []balanceRow{
	{"U-100001", "BTC", "0.50000000"}, {"U-100001", "ETH", "12.5"}, {"U-100001", "USDT", "1500.25"},
	{"U-100002", "BTC", "0.00012345"},
	{"U-100003", "ETH", "0.000000000000000001"}, {"U-100003", "USDT", "250000"},
	{"U-100004", "BTC", "3"}, {"U-100004", "USDT", "0"},
	{"U-100005", "ETH", "1.25"},
	{"U-100006", "BTC", "0.01"}, {"U-100006", "ETH", "0.3"}, {"U-100006", "USDT", "99.999999"},
	{"U-100007", "USDT", "10"},
	{"U-100008", "BTC", "21.12345678"},
	{"U-100009", "ETH", "100"}, {"U-100009", "USDT", "0.000001"},
	{"U-100010", "BTC", "0.00000001"},
	{"U-100011", "USDT", "4200.5"},
	{"U-100012", "BTC", "0"}, {"U-100012", "ETH", "0"},
}

var sampleAssets = []por.Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}, {Symbol: "USDT", Decimals: 6}}

// ---------------------------------------------------------------------------
// Step 2: the tree and the statement. Nothing here touches the network.
// ---------------------------------------------------------------------------

// buildSnapshot folds a checked ledger into the tree and writes the
// statement about it: root, totals, number of accounts, as-of time.
//
// The seed is the snapshot's one secret; por.NewSeed draws it. It is written
// to the snapshot directory with the leaves, and both have to be kept for as
// long as customers may ask for their proofs.
func buildSnapshot(ledger *por.Ledger, exchangeID, name, asOf string, seed []byte, builtAt time.Time) (*por.Tree, *por.Statement, error) {
	tree, err := por.BuildTree(exchangeID, seed, ledger)
	if err != nil {
		return nil, nil, err
	}
	statement, err := por.NewStatement(por.StatementConfig{Name: name, AsOf: asOf, Assets: ledger.Assets()}, tree, builtAt)
	if err != nil {
		return nil, nil, err
	}
	return tree, statement, nil
}

func buildCommand(args []string, stdout, stderr io.Writer) error {
	flags := newFlags("build")
	csv := flags.String("csv", "", "")
	amounts := flags.String("amounts", "", "")
	assetList := flags.String("assets", "", "")
	exchange := flags.String("exchange", "", "")
	name := flags.String("name", "", "")
	asOf := flags.String("asof", "", "")
	out := flags.String("out", "", "")
	seedHex := flags.String("seed-hex", "", "")
	generatedAt := flags.String("generated-at", "", "")
	layout := flags.String("layout", "", "")
	delimiter := flags.String("delimiter", "", "")
	colAccount := flags.String("col-account", "", "")
	colAsset := flags.String("col-asset", "", "")
	colBalance := flags.String("col-balance", "", "")
	ignoreColumns := flags.String("ignore-columns", "", "")
	if err := flags.parse(args, "csv", "amounts", "assets", "exchange", "name", "asof", "out"); err != nil {
		return err
	}

	assets, err := por.ParseAssets(*assetList)
	if err != nil {
		return err
	}
	// The unit is never defaulted: "1" is one coin or one smallest unit, and
	// only the exchange knows which its ledger holds.
	if *amounts != string(por.Decimal) && *amounts != string(por.Base) {
		return fmt.Errorf(`--amounts is "decimal" if the file says 0.5 for half a coin, "base" if it holds whole numbers of the smallest unit`)
	}
	if *layout != "" && *layout != string(por.Long) && *layout != string(por.Wide) {
		return fmt.Errorf(`--layout is "long" or "wide"`)
	}
	opts := por.CSVOptions{
		Assets:  assets,
		Amounts: por.AmountUnit(*amounts),
		Layout:  por.Layout(*layout),
		Columns: por.Columns{Account: *colAccount, Asset: *colAsset, Balance: *colBalance},
	}
	for _, column := range strings.Split(*ignoreColumns, ",") {
		if column = strings.TrimSpace(column); column != "" {
			opts.IgnoreColumns = append(opts.IgnoreColumns, column)
		}
	}
	if *delimiter != "" {
		if *delimiter == `\t` {
			*delimiter = "\t"
		}
		characters := []rune(*delimiter)
		if len(characters) != 1 {
			return fmt.Errorf(`--delimiter is a single character (write \t for a tab)`)
		}
		opts.Delimiter = characters[0]
	}
	if _, err := time.Parse(time.RFC3339Nano, *asOf); err != nil {
		return fmt.Errorf("--asof %q is not an instant; write it as 2026-11-16T00:00:00Z", *asOf)
	}
	builtAt := time.Now()
	if *generatedAt != "" {
		if builtAt, err = time.Parse(time.RFC3339Nano, *generatedAt); err != nil {
			return fmt.Errorf("--generated-at %q is not an instant; write it as 2026-11-16T01:02:03.456Z", *generatedAt)
		}
	}
	var seed []byte
	if *seedHex != "" {
		seed, err = por.ParseSeed(*seedHex)
	} else {
		seed, err = por.NewSeed()
	}
	if err != nil {
		return err
	}

	ledger, report, err := readExport(*csv, opts)
	if err != nil {
		return err
	}
	if !report.OK {
		for _, p := range report.Problems {
			fmt.Fprintf(stderr, "line %d %s %s\n", p.Line, p.Code, p.Message)
		}
		if more := report.ProblemCount - len(report.Problems); more > 0 {
			fmt.Fprintf(stderr, "... and %d more\n", more)
		}
		// Nothing was built and nothing was written.
		return invalidError{}
	}
	tree, statement, err := buildSnapshot(ledger, *exchange, *name, *asOf, seed, builtAt)
	if err != nil {
		return err
	}
	if err := por.WriteSnapshotDir(*out, statement, tree, seed); err != nil {
		return err
	}

	totals, err := tree.Totals().MarshalJSON()
	if err != nil {
		return err
	}
	if totals, err = por.CanonicalJSON(totals); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "root %s\ntotals %s\ncommitment %s\n", tree.Root(), totals, statement.Commitment())
	return nil
}

// ---------------------------------------------------------------------------
// Step 3: sign. Its own step, because the key often lives on another machine.
// ---------------------------------------------------------------------------

// signSnapshot signs the statement of a snapshot directory and writes
// submission.json: the statement and its signature, and all that is sent.
// It needs snapshot.json and the key, not the leaves.
//
// With the key in an HSM or a KMS, replace LoadPrivateKeyFile by your own
// por.Signer — one method, bytes in, the 64 bytes r‖s out — or wrap the
// device's crypto.Signer with por.CryptoSigner.
func signSnapshot(dir, keyFile string) error {
	statement, err := por.ReadStatementFile(filepath.Join(dir, por.StatementFile))
	if err != nil {
		return err
	}
	signer, err := por.LoadPrivateKeyFile(keyFile)
	if err != nil {
		return err
	}
	submission, err := por.NewSubmission(statement, signer)
	if err != nil {
		return err
	}
	// Checked before anything is written: a signature that does not verify
	// against its own key should not be carried to the next machine.
	if err := por.VerifyStatementSignature(statement, submission.Sig, signer.PublicSPKI()); err != nil {
		return fmt.Errorf("the signature did not verify against its own key; nothing was written: %w", err)
	}
	return por.WriteSubmission(dir, submission)
}

func signCommand(args []string) error {
	flags := newFlags("sign")
	dir := flags.String("dir", "", "")
	key := flags.String("key", "", "")
	if err := flags.parse(args, "dir", "key"); err != nil {
		return err
	}
	return signSnapshot(*dir, *key)
}

// ---------------------------------------------------------------------------
// Step 4: hand the signed statement to the platform.
// ---------------------------------------------------------------------------

// submitSnapshot sends submission.json and records the answer in
// receipt.json.
//
// By default the statement and its signature are all that leaves the
// machine. With spotCheck the platform is also asked to sample the tree: it
// names up to eight leaves, and those leaves — hashed reference, salt,
// balances, never the account reference — are opened to it from the local
// tree. What was opened is written to openings.json.
func submitSnapshot(ctx context.Context, dir string, client *por.Client, spotCheck bool) (por.Receipt, error) {
	submission, err := por.ReadSubmission(dir)
	if err != nil {
		return por.Receipt{}, err
	}
	// Checked here so that "signed with a key the platform does not hold" is
	// a message on this machine, before anything has been sent.
	registered, err := client.RegisteredKey(ctx, submission.Statement.InstitutionID())
	if err != nil {
		return por.Receipt{}, err
	}
	if err := por.VerifyStatementSignature(submission.Statement, submission.Sig, registered); err != nil {
		return por.Receipt{}, fmt.Errorf("%s was not signed with the key registered for this exchange; sign it with the registered key, or register this one: %w", por.SubmissionFile, err)
	}

	var result *por.SubmitResult
	if spotCheck {
		// The directory is checked first — checksum, rebuilt root — so that a
		// challenge is never answered from leaves that are not the snapshot's.
		snapshot, err := por.LoadSnapshotDir(dir)
		if err != nil {
			return por.Receipt{}, err
		}
		result, err = client.SubmitWithSpotCheck(ctx, submission, snapshot.Tree)
		if result != nil {
			// Kept whether or not the platform went on to confirm: this is
			// the record of the account-level data that left the building.
			if writeErr := por.WriteOpenings(dir, result.Openings); writeErr != nil {
				return por.Receipt{}, errors.Join(err, writeErr)
			}
		}
		if err != nil {
			return por.Receipt{}, err
		}
	} else if result, err = client.Submit(ctx, submission); err != nil {
		return por.Receipt{}, err
	}

	receipt := por.Receipt{
		SnapshotID:      result.SnapshotID,
		Status:          result.Status,
		SpotCheck:       result.SpotCheck,
		SampledAccounts: result.SampledAccounts,
		AttestationID:   result.AttestationID,
		Commitment:      submission.Statement.Commitment(),
		Root:            submission.Statement.Root(),
		Platform:        client.BaseURL(),
		PublicURL:       client.PublicURL(result.SnapshotID),
		ReceivedAt:      time.Now(),
		Anchor:          por.AnchorPending,
	}
	return receipt, por.WriteReceipt(dir, receipt)
}

// awaitAnchor waits for the platform to confirm the anchor and marks the
// receipt. Anchoring is the platform's work and takes as long as its chain
// takes; a wait that times out has lost nothing, and can be repeated.
func awaitAnchor(ctx context.Context, dir string, client *por.Client, receipt por.Receipt, timeout time.Duration) error {
	if _, err := client.WaitAnchored(ctx, receipt.SnapshotID, timeout); err != nil {
		return err
	}
	receipt.Anchor = por.AnchorConfirmed
	return por.WriteReceipt(dir, receipt)
}

// newClient makes the platform client. The API key comes from the
// environment, so that it is in no command line and no shell history.
func newClient(core string, getenv func(string) string) (*por.Client, error) {
	apiKey := getenv("STONEHASH_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("no API key: set STONEHASH_API_KEY")
	}
	return por.NewClient(por.ClientConfig{BaseURL: core, APIKey: apiKey})
}

func submitCommand(ctx context.Context, args []string, stdout io.Writer, getenv func(string) string) error {
	flags := newFlags("submit")
	dir := flags.String("dir", "", "")
	core := flags.String("core", "", "")
	spotCheck := flags.Bool("spot-check", false, "")
	wait := flags.Bool("wait", false, "")
	timeoutSec := flags.String("timeout-sec", "600", "")
	if err := flags.parse(args, "dir", "core"); err != nil {
		return err
	}
	// A plain number of seconds, fractions allowed: "600", "0.5". Checked
	// before parsing so that "1m" is not read as a millisecond.
	timeout, err := time.ParseDuration(*timeoutSec + "s")
	if err != nil || timeout <= 0 || strings.Trim(*timeoutSec, "0123456789.") != "" {
		return fmt.Errorf("--timeout-sec is a number of seconds")
	}
	client, err := newClient(*core, getenv)
	if err != nil {
		return err
	}
	receipt, err := submitSnapshot(ctx, *dir, client, *spotCheck)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "snapshot %s %s\n", receipt.SnapshotID, receipt.Status)
	if *wait {
		return awaitAnchor(ctx, *dir, client, receipt, timeout)
	}
	return nil
}

func statusCommand(ctx context.Context, args []string, stdout io.Writer, getenv func(string) string) error {
	flags := newFlags("status")
	core := flags.String("core", "", "")
	snapshot := flags.String("snapshot", "", "")
	if err := flags.parse(args, "core", "snapshot"); err != nil {
		return err
	}
	client, err := newClient(*core, getenv)
	if err != nil {
		return err
	}
	status, err := client.Status(ctx, *snapshot)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "%s\n", status.Raw)
	return nil
}

// ---------------------------------------------------------------------------
// Step 5: a customer's proof, and how it is checked.
// ---------------------------------------------------------------------------

// proveAccount writes one customer's proof file. The directory is verified
// on the way in — checksum, rebuilt root — so a proof is only ever issued
// from the leaves the anchored root was built from.
func proveAccount(dir, userRef, outFile string) error {
	snapshot, err := por.LoadSnapshotDir(dir)
	if err != nil {
		return err
	}
	proof, err := snapshot.Tree.ProofFor(userRef)
	if err != nil {
		return err
	}
	return por.WriteProofFile(outFile, snapshot.Statement, proof)
}

func proveCommand(args []string) error {
	flags := newFlags("prove")
	dir := flags.String("dir", "", "")
	userRef := flags.String("user-ref", "", "")
	out := flags.String("out", "", "")
	if err := flags.parse(args, "dir", "user-ref", "out"); err != nil {
		return err
	}
	return proveAccount(*dir, *userRef, *out)
}

// verifyProofFile is the customer's side. It needs two files and nothing
// else — no account at the platform, no network: the proof the exchange gave
// them, and the statement the exchange published.
//
// It answers two questions. Does the proof lead to the statement's root, with
// sums that add up to the statement's totals? And is the proof about the
// account it names? pathErr and accountErr are nil when the answer is yes.
func verifyProofFile(proofFile, statementFile string) (pathErr, accountErr, err error) {
	statement, err := por.ReadStatementFile(statementFile)
	if err != nil {
		return nil, nil, err
	}
	file, err := por.ReadProofFile(proofFile)
	var refusal *por.Error
	if errors.As(err, &refusal) && refusal.Code == por.CodeInvalidProof {
		// A file that is not a proof is a proof that does not hold.
		return err, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	pathErr = por.VerifyProof(file.Proof, statement.Root(), statement.Totals())
	if file.UserRef != "" && por.UserRefHash(statement.InstitutionID(), file.UserRef) != file.Proof.Leaf.UserRefHash {
		accountErr = fmt.Errorf("user_ref %q does not hash to the leaf's user_ref_hash: the proof is for another account", file.UserRef)
	}
	return pathErr, accountErr, nil
}

func verifyProofCommand(args []string, stdout, stderr io.Writer) error {
	flags := newFlags("verify-proof")
	proof := flags.String("proof", "", "")
	snapshot := flags.String("snapshot", "", "")
	if err := flags.parse(args, "proof", "snapshot"); err != nil {
		return err
	}
	pathErr, accountErr, err := verifyProofFile(*proof, *snapshot)
	if err != nil {
		return err
	}
	if pathErr != nil {
		fmt.Fprintln(stdout, "root+totals FAIL")
		fmt.Fprintf(stderr, "por-example: %v\n", pathErr)
	} else {
		fmt.Fprintln(stdout, "root+totals MATCH")
	}
	if accountErr != nil {
		fmt.Fprintf(stderr, "por-example: %v\n", accountErr)
	}
	if pathErr != nil || accountErr != nil {
		return invalidError{}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Conformance: this build against the published vectors.
// ---------------------------------------------------------------------------

func conformanceCommand(args []string, stdout, stderr io.Writer) error {
	flags := newFlags("conformance")
	vectors := flags.String("vectors", "", "")
	if err := flags.parse(args, "vectors"); err != nil {
		return err
	}
	groups, err := conformance.Run(*vectors)
	if err != nil {
		return err
	}
	failed := 0
	for _, g := range groups {
		fmt.Fprintln(stdout, g.Describe())
		for _, failure := range g.Failures {
			fmt.Fprintf(stderr, "%s: %s\n", g.Name, failure)
		}
		failed += g.Failed
	}
	// The database path above is held to the vectors as well: the same
	// sample ledger, offered row by row, has to reach the published root.
	if err := databasePathAgrees(*vectors); err != nil {
		fmt.Fprintf(stderr, "database path: %v\n", err)
		failed++
	}
	if failed > 0 {
		return invalidError{fmt.Sprintf("%d checks did not pass", failed)}
	}
	return nil
}

func databasePathAgrees(vectors string) error {
	data, err := os.ReadFile(filepath.Join(vectors, "snapshot-dir.expected.json"))
	if err != nil {
		return err
	}
	var expected struct {
		ExchangeID string `json:"exchange_id"`
		SeedHex    string `json:"seed_hex"`
		Root       string `json:"root"`
	}
	if err := json.Unmarshal(data, &expected); err != nil {
		return err
	}
	seed, err := por.ParseSeed(expected.SeedHex)
	if err != nil {
		return err
	}
	ledger, report, err := ledgerFromDatabase(sampleResultSet, sampleAssets)
	if err != nil {
		return err
	}
	if !report.OK {
		return fmt.Errorf("the sample result set was refused: %v", report.Problems)
	}
	tree, err := por.BuildTree(expected.ExchangeID, seed, ledger)
	if err != nil {
		return err
	}
	if tree.Root() != expected.Root {
		return fmt.Errorf("the sample result set leads to root %s, the vectors say %s", tree.Root(), expected.Root)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Command-line plumbing.
// ---------------------------------------------------------------------------

type flagSet struct{ *flag.FlagSet }

func newFlags(command string) flagSet {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	// Mistakes are reported by run, in one place and one form.
	flags.SetOutput(io.Discard)
	return flagSet{flags}
}

// parse reads the options and insists on the required ones.
func (f flagSet) parse(args []string, required ...string) error {
	if err := f.Parse(args); errors.Is(err, flag.ErrHelp) {
		return errors.New(usage)
	} else if err != nil {
		return fmt.Errorf("%s: %v\n\n%s", f.Name(), err, usage)
	}
	if f.NArg() > 0 {
		return fmt.Errorf("%s: unexpected argument %q\n\n%s", f.Name(), f.Arg(0), usage)
	}
	given := map[string]bool{}
	f.Visit(func(option *flag.Flag) { given[option.Name] = true })
	for _, name := range required {
		if !given[name] {
			return fmt.Errorf("%s: --%s is required", f.Name(), name)
		}
	}
	return nil
}
