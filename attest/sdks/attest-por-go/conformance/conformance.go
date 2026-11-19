// Package conformance runs the published conformance vectors against this
// build of the SDK.
//
// The exchange-side SDK exists in several languages, and every one of them
// has to arrive at the same 32 bytes from the same ledger: a root that
// differs by language is two different statements about one set of
// liabilities. The vectors are what the reference implementation produces;
// this package is how a build of the Go SDK is held to them. It goes through
// the public API only, so what it proves is what a caller gets.
package conformance

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	por "stonehash.com/attest/por"
	"stonehash.com/attest/por/internal/cjson"
)

// Group is the outcome of one vector file.
type Group struct {
	Name   string
	Passed int
	Failed int
	// Failures names each vector that did not pass, and why.
	Failures []string
}

// record counts one vector: passed when problem is empty.
func (g *Group) record(vector, problem string) {
	if problem == "" {
		g.Passed++
		return
	}
	g.Failed++
	g.Failures = append(g.Failures, vector+": "+problem)
}

// Run runs every vector group of the directory that holds SPEC.md and its
// vector files, and returns the groups in a fixed order. The error is non-nil
// only when a vector file could not be read at all.
func Run(dir string) ([]Group, error) {
	type runner struct {
		name string
		file string
		run  func(g *Group, dir string, vectors any)
	}
	var groups []Group
	for _, r := range []runner{
		{"jcs", "jcs.json", runJCS},
		{"amounts", "amounts.json", runAmounts},
		{"leaves", "leaves.json", runLeaves},
		{"trees", "trees.json", runTrees},
		{"statement", "statement.json", runStatement},
		{"intake", "intake.json", runIntake},
		{"snapshot-dir", "snapshot-dir.expected.json", runSnapshotDir},
	} {
		vectors, err := load(filepath.Join(dir, r.file))
		if err != nil {
			return nil, err
		}
		g := Group{Name: r.name}
		r.run(&g, dir, vectors)
		groups = append(groups, g)
	}
	return groups, nil
}

func load(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("the vector file could not be read: %w", err)
	}
	v, err := cjson.Parse(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return v, nil
}

// Readers for the vector files. A member that is missing or of another type
// reads as the zero value, which then fails the comparison it was meant for.

func member(v any, key string) any {
	if obj, ok := v.(cjson.Object); ok {
		m, _ := obj.Get(key)
		return m
	}
	return nil
}

func text(v any, key string) string {
	s, _ := member(v, key).(string)
	return s
}

func integer(v any, key string) int {
	n, _ := member(v, key).(int64)
	return int(n)
}

func list(v any, key string) []any {
	l, _ := member(v, key).([]any)
	return l
}

func compact(v any) []byte {
	out, err := cjson.Compact(v)
	if err != nil {
		return nil
	}
	return out
}

// sameJSON compares two documents as JSON values: the order of an object's
// members does not matter, everything else does.
func sameJSON(a, b any) bool {
	switch a := a.(type) {
	case cjson.Object:
		b, ok := b.(cjson.Object)
		if !ok || len(a) != len(b) {
			return false
		}
		for _, m := range a {
			other, ok := b.Get(m.Key)
			if !ok || !sameJSON(m.Value, other) {
				return false
			}
		}
		return true
	case []any:
		b, ok := b.([]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for i := range a {
			if !sameJSON(a[i], b[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

// sameDocument compares JSON text produced by the SDK with a vector.
func sameDocument(produced []byte, err error, want any) string {
	if err != nil {
		return err.Error()
	}
	got, err := cjson.Parse(produced)
	if err != nil {
		return "the SDK wrote something that is not JSON: " + err.Error()
	}
	if !sameJSON(got, want) {
		return fmt.Sprintf("got %s, want %s", compact(got), compact(want))
	}
	return ""
}

func differs(what string, got, want any) string {
	if got == want {
		return ""
	}
	return fmt.Sprintf("%s is %v, want %v", what, got, want)
}

// first returns the first problem found, so one vector reports one reason.
func first(problems ...string) string {
	for _, p := range problems {
		if p != "" {
			return p
		}
	}
	return ""
}

func balancesOf(v any) (por.Balances, error) {
	var b por.Balances
	err := b.UnmarshalJSON(compact(v))
	return b, err
}

func assetsOf(items []any) []por.Asset {
	assets := make([]por.Asset, len(items))
	for i, item := range items {
		if symbol, ok := item.(string); ok {
			assets[i] = por.Asset{Symbol: symbol}
			continue
		}
		assets[i] = por.Asset{Symbol: text(item, "symbol"), Decimals: integer(item, "decimals")}
	}
	return assets
}

// ledgerOf feeds the rows of a vector — account, then amounts in smallest
// units — through the ledger builder, as a caller's own query would. A row
// with every asset is offered as one wide row; any other, as long rows.
func ledgerOf(assets []por.Asset, rows []any) (*por.Ledger, error) {
	builder, err := por.NewLedgerBuilder(por.LedgerOptions{Assets: assets, Amounts: por.Base})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		balances, _ := member(row, "balances").(cjson.Object)
		if len(balances) == 0 || len(balances) == len(assets) {
			amounts := make(map[string]string, len(balances))
			for _, m := range balances {
				amounts[m.Key], _ = m.Value.(string)
			}
			if err := builder.AddAccount(text(row, "user_ref"), amounts); err != nil {
				return nil, err
			}
			continue
		}
		for _, m := range balances {
			amount, _ := m.Value.(string)
			if err := builder.Add(text(row, "user_ref"), m.Key, amount); err != nil {
				return nil, err
			}
		}
	}
	ledger, report := builder.Finish()
	if !report.OK {
		return nil, fmt.Errorf("the ledger was refused: %v", report.Problems)
	}
	return ledger, nil
}

func treeOf(c any) (*por.Tree, error) {
	ledger, err := ledgerOf(assetsOf(list(c, "assets")), list(c, "rows"))
	if err != nil {
		return nil, err
	}
	seed, err := por.ParseSeed(text(c, "seed_hex"))
	if err != nil {
		return nil, err
	}
	return por.BuildTree(text(c, "exchange_id"), seed, ledger)
}

func runJCS(g *Group, _ string, v any) {
	for _, c := range list(v, "cases") {
		got, err := por.CanonicalJSON(compact(member(c, "value")))
		g.record(text(c, "name"), first(errText(err), differs("the canonical form", string(got), text(c, "canonical"))))
	}
	for _, c := range list(v, "rejects") {
		problem := ""
		if got, err := por.CanonicalJSON([]byte(text(c, "json"))); err == nil {
			problem = fmt.Sprintf("accepted, as %s", got)
		}
		g.record("refuses "+text(c, "name"), problem)
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func runAmounts(g *Group, _ string, v any) {
	describe := func(c any) string {
		return fmt.Sprintf("%q, %d decimals, %s", text(c, "text"), integer(c, "decimals"), text(c, "unit"))
	}
	for _, c := range list(v, "cases") {
		got, err := por.ToBaseUnits(text(c, "text"), integer(c, "decimals"), por.AmountUnit(text(c, "unit")))
		problem := errText(err)
		if err == nil {
			problem = differs("the amount", got.String(), text(c, "base"))
		}
		g.record(describe(c), problem)
	}
	for _, c := range list(v, "errors") {
		got, err := por.ToBaseUnits(text(c, "text"), integer(c, "decimals"), por.AmountUnit(text(c, "unit")))
		var refusal *por.Error
		problem := ""
		switch {
		case err == nil:
			problem = fmt.Sprintf("accepted, as %s; want %s", got, text(c, "code"))
		case !errors.As(err, &refusal):
			problem = "refused with an error that carries no code: " + err.Error()
		default:
			problem = differs("the code", refusal.Code, text(c, "code"))
		}
		g.record(describe(c), problem)
	}
}

func runLeaves(g *Group, _ string, v any) {
	exchange := text(v, "exchange_id")
	assets := assetsOf(list(v, "assets"))
	seed, seedErr := por.ParseSeed(text(v, "seed_hex"))
	for _, c := range list(v, "cases") {
		ref := text(c, "user_ref")
		g.record(fmt.Sprintf("leaf of %q", ref), func() string {
			if seedErr != nil {
				return seedErr.Error()
			}
			salt, err := por.DeriveSalt(seed, ref)
			if err != nil {
				return err.Error()
			}
			normalised, err := balancesOf(member(c, "normalised_balances"))
			if err != nil {
				return err.Error()
			}
			leafHash, err := por.LeafHash(text(c, "salt"), text(c, "user_ref_hash"), normalised)
			if err != nil {
				return err.Error()
			}
			// The same leaf through the whole pipeline: a tree of one account
			// is its leaf, so its root is the leaf hash, and its opening
			// shows the balances as they were normalised.
			ledger, err := ledgerOf(assets, []any{c})
			if err != nil {
				return err.Error()
			}
			tree, err := por.BuildTree(exchange, seed, ledger)
			if err != nil {
				return err.Error()
			}
			opening, err := tree.Proof(0)
			if err != nil {
				return err.Error()
			}
			opened, err := opening.Leaf.Balances.MarshalJSON()
			return first(
				differs("user_ref_hash", por.UserRefHash(exchange, ref), text(c, "user_ref_hash")),
				differs("salt", salt, text(c, "salt")),
				differs("leaf_hash", leafHash, text(c, "leaf_hash")),
				differs("the root of a one-account tree", tree.Root(), text(c, "leaf_hash")),
				sameDocument(opened, err, member(c, "normalised_balances")),
			)
		}())
	}
}

func runTrees(g *Group, _ string, v any) {
	g.record("the empty node", differs("its hash", por.EmptyNodeHash(), text(v, "empty_node_hash")))
	for _, c := range list(v, "cases") {
		name := text(c, "name")
		tree, err := treeOf(c)
		if err != nil {
			g.record(name, err.Error())
			continue
		}
		totals, totalsErr := tree.Totals().MarshalJSON()
		var order []any
		for i := 0; i < tree.LeafCount(); i++ {
			ref, _ := tree.UserRef(i)
			order = append(order, ref)
		}
		var levels []any
		for _, level := range tree.LevelHashes() {
			var hashes []any
			for _, h := range level {
				hashes = append(hashes, h)
			}
			levels = append(levels, hashes)
		}
		problem := first(
			differs("root", tree.Root(), text(c, "root")),
			differs("leaf_count", tree.LeafCount(), integer(c, "leaf_count")),
			sameDocument(totals, totalsErr, member(c, "totals")),
			orderProblem("order", order, list(c, "order")),
			orderProblem("level_hashes", levels, list(c, "level_hashes")),
		)
		for _, p := range list(c, "proofs") {
			if problem != "" {
				break
			}
			problem = proofProblem(tree, p, text(c, "root"), member(c, "totals"))
		}
		g.record(name, problem)
	}

	against := member(v, "invalid_proofs")
	root := text(member(against, "against"), "root")
	totals, totalsErr := balancesOf(member(member(against, "against"), "totals"))
	for _, c := range list(against, "proofs") {
		problem := errText(totalsErr)
		// A proof this SDK cannot even read is a proof it does not accept.
		if proof, err := por.ParseProof(compact(member(c, "proof"))); err == nil && totalsErr == nil {
			if por.VerifyProof(proof, root, totals) == nil {
				problem = "verifies"
			}
		}
		g.record("must fail: "+text(c, "why"), problem)
	}
}

func orderProblem(what string, got, want []any) string {
	if sameJSON(got, want) {
		return ""
	}
	return fmt.Sprintf("%s is %s, want %s", what, compact(got), compact(want))
}

// proofProblem checks one proof of a tree vector three ways: the tree issues
// it by index, finds it by account reference, and the vector's own verifies.
func proofProblem(tree *por.Tree, p any, root string, totals any) string {
	index, ref := integer(p, "leaf_index"), text(p, "user_ref")
	issued, err := tree.Proof(index)
	if err != nil {
		return err.Error()
	}
	text, err := issued.MarshalJSON()
	if problem := sameDocument(text, err, member(p, "proof")); problem != "" {
		return fmt.Sprintf("proof %d: %s", index, problem)
	}
	if at, ok := tree.IndexOf(ref); !ok || at != index {
		return fmt.Sprintf("account %q is found at %d (%v), want %d", ref, at, ok, index)
	}
	own, err := tree.ProofFor(ref)
	if err != nil {
		return err.Error()
	}
	if own.Leaf.UserRef != ref || own.Leaf.UserRefHash != issued.Leaf.UserRefHash {
		return fmt.Sprintf("the proof for account %q is not that account's", ref)
	}
	declared, err := balancesOf(totals)
	if err != nil {
		return err.Error()
	}
	read, err := por.ParseProof(compact(member(p, "proof")))
	if err != nil {
		return err.Error()
	}
	if err := por.VerifyProof(read, root, declared); err != nil {
		return fmt.Sprintf("proof %d does not verify: %v", index, err)
	}
	return ""
}

func runStatement(g *Group, dir string, v any) {
	spki := text(member(v, "test_key"), "public_spki_base64")
	st, err := por.ParseStatement(compact(member(v, "statement")))
	if err != nil {
		g.record("the statement is read", err.Error())
		return
	}
	g.record("canonical form", differs("it", string(st.Canonical()), text(v, "canonical")))
	g.record("commitment", differs("it", st.Commitment(), text(v, "commitment")))

	var sig por.Signature
	sigErr := sig.UnmarshalJSON(compact(member(v, "signature")))
	g.record("the signature verifies", first(errText(sigErr), errText(por.VerifyStatementSignature(st, &sig, spki))))

	g.record("a signature made here verifies", func() string {
		signer, err := por.ParsePrivateKeyPEM([]byte(text(member(v, "test_key"), "private_pkcs8_pem")))
		if err != nil {
			return err.Error()
		}
		made, err := por.SignStatement(st, signer)
		if err != nil {
			return err.Error()
		}
		return first(
			differs("the key's public half", signer.PublicSPKI(), spki),
			differs("alg", made.Alg, sig.Alg),
			differs("key_id", made.KeyID, sig.KeyID),
			differs("issuer", made.Issuer, sig.Issuer),
			errText(por.VerifyStatementSignature(st, made, spki)),
		)
	}())

	g.record("the submission is read and verifies", func() string {
		sub, err := por.ParseSubmission(compact(member(v, "submission")))
		if err != nil {
			return err.Error()
		}
		written, err := sub.MarshalJSON()
		return first(
			differs("its statement's canonical form", string(sub.Statement.Canonical()), text(v, "canonical")),
			errText(por.VerifyStatementSignature(sub.Statement, sub.Sig, spki)),
			sameDocument(written, err, member(v, "submission")),
		)
	}())

	for _, c := range list(v, "must_not_verify") {
		problem := ""
		altered, err := por.ParseStatement(compact(member(c, "statement")))
		var alteredSig por.Signature
		if err == nil && alteredSig.UnmarshalJSON(compact(member(c, "signature"))) == nil {
			if por.VerifyStatementSignature(altered, &alteredSig, spki) == nil {
				problem = "verifies"
			}
		}
		g.record("must not verify: "+text(c, "why"), problem)
	}

	// The statement vector describes one of the tree vectors. Where that tree
	// is found, the statement is also built from it, which is the path a
	// caller takes.
	trees, err := load(filepath.Join(dir, "trees.json"))
	if err != nil {
		return
	}
	for _, c := range list(trees, "cases") {
		if text(c, "root") != st.Root() {
			continue
		}
		g.record("built from its tree", func() string {
			tree, err := treeOf(c)
			if err != nil {
				return err.Error()
			}
			return rebuilt(st, tree)
		}())
		return
	}
}

// rebuilt builds a statement from a tree with what another statement says
// beyond its tree, and compares the two canonical forms.
func rebuilt(st *por.Statement, tree *por.Tree) string {
	at, err := time.Parse(time.RFC3339Nano, st.GeneratedAt())
	if err != nil {
		return err.Error()
	}
	built, err := por.NewStatement(por.StatementConfig{
		Name: st.ExchangeName(), AsOf: st.AsOf(), Assets: st.Assets(), Reserves: st.Reserves(),
	}, tree, at)
	if err != nil {
		return err.Error()
	}
	return differs("the statement built here", string(built.Canonical()), string(st.Canonical()))
}

func runIntake(g *Group, dir string, v any) {
	for _, c := range list(v, "cases") {
		options := member(c, "options")
		opts := por.CSVOptions{
			Assets:  assetsOf(list(options, "assets")),
			Amounts: por.AmountUnit(text(options, "amounts")),
			Layout:  por.Layout(text(options, "layout")),
			Columns: por.Columns{
				Account: text(member(options, "columns"), "account"),
				Asset:   text(member(options, "columns"), "asset"),
				Balance: text(member(options, "columns"), "balance"),
			},
		}
		for _, name := range list(options, "ignore_columns") {
			column, _ := name.(string)
			opts.IgnoreColumns = append(opts.IgnoreColumns, column)
		}
		if delimiter := []rune(text(options, "delimiter")); len(delimiter) == 1 {
			opts.Delimiter = delimiter[0]
		}
		ledger, report, err := por.ReadCSVFile(filepath.Join(dir, filepath.FromSlash(text(c, "file"))), opts)
		problem := errText(err)
		if err == nil {
			if member(c, "ok") == true {
				problem = acceptedProblem(c, opts, ledger, report)
			} else {
				problem = refusedProblem(c, ledger, report)
			}
		}
		g.record(text(c, "name"), problem)
	}
}

func refusedProblem(c any, ledger *por.Ledger, report *por.Report) string {
	if report.OK || ledger != nil {
		return "the file was accepted"
	}
	var got, want []string
	for _, p := range report.Problems {
		got = append(got, fmt.Sprintf("%d:%s", p.Line, p.Code))
	}
	for _, p := range list(c, "problems") {
		want = append(want, fmt.Sprintf("%d:%s", integer(p, "line"), text(p, "code")))
	}
	if !slices.Equal(got, want) {
		return fmt.Sprintf("problems are [%s], want [%s]", strings.Join(got, " "), strings.Join(want, " "))
	}
	return ""
}

func acceptedProblem(c any, opts por.CSVOptions, ledger *por.Ledger, report *por.Report) string {
	if !report.OK || ledger == nil {
		return fmt.Sprintf("the file was refused: %v", report.Problems)
	}
	totals, totalsErr := report.Totals.MarshalJSON()
	holders := cjson.Object{}
	for _, a := range opts.Assets {
		holders = append(holders, cjson.Member{Key: a.Symbol, Value: int64(report.Holders[a.Symbol])})
	}
	ignored := []any{}
	for _, column := range report.IgnoredColumns {
		ignored = append(ignored, column)
	}
	rows, rowsErr := rowsOf(ledger)
	problem := first(
		differs("layout", string(report.Layout), text(c, "layout")),
		differs("data_rows", report.DataRows, integer(c, "data_rows")),
		differs("accounts", report.Accounts, integer(c, "accounts")),
		differs("zero_balance_accounts", report.ZeroBalanceAccounts, integer(c, "zero_balance_accounts")),
		sameDocument(totals, totalsErr, member(c, "totals")),
		orderProblem("holders", []any{holders}, []any{member(c, "holders")}),
		orderProblem("ignored_columns", ignored, list(c, "ignored_columns")),
		differs("file_sha256", report.FileSHA256, text(c, "file_sha256")),
		errText(rowsErr),
		orderProblem("rows", rows, list(c, "rows")),
	)
	if problem != "" {
		return problem
	}
	// The same ledger offered row by row, with no file, is the same ledger.
	replayed, err := ledgerOf(opts.Assets, list(c, "rows"))
	if err != nil {
		return "offered to the ledger builder: " + err.Error()
	}
	again, err := rowsOf(replayed)
	return first(errText(err), orderProblem("the rows from the ledger builder", again, list(c, "rows")))
}

// rowsOf writes a ledger's rows as the vectors write them.
func rowsOf(ledger *por.Ledger) ([]any, error) {
	rows := []any{}
	for i := 0; i < ledger.Len(); i++ {
		row, err := ledger.Row(i)
		if err != nil {
			return nil, err
		}
		balances, err := row.Balances.MarshalJSON()
		if err != nil {
			return nil, err
		}
		parsed, err := cjson.Parse(balances)
		if err != nil {
			return nil, err
		}
		rows = append(rows, cjson.Object{{Key: "user_ref", Value: row.UserRef}, {Key: "balances", Value: parsed}})
	}
	return rows, nil
}

func runSnapshotDir(g *Group, dir string, v any) {
	snapshot, err := por.LoadSnapshotDir(filepath.Join(dir, "snapshot-dir"))
	if err != nil {
		g.record("the directory loads", err.Error())
		return
	}
	tree, st := snapshot.Tree, snapshot.Statement
	totals, totalsErr := tree.Totals().MarshalJSON()
	g.record("the directory loads and rebuilds its root", first(
		differs("exchange_id", tree.ExchangeID(), text(v, "exchange_id")),
		differs("root", tree.Root(), text(v, "root")),
		differs("leaf_count", tree.LeafCount(), integer(v, "leaf_count")),
		sameDocument(totals, totalsErr, member(v, "totals")),
	))
	g.record("commitment", differs("it", st.Commitment(), text(v, "commitment")))
	g.record("the statement built from the loaded tree", rebuilt(st, tree))

	g.record("the customer's proof file", func() string {
		want, err := load(filepath.Join(dir, text(v, "proof_file")))
		if err != nil {
			return err.Error()
		}
		ref := text(want, "user_ref")
		proof, err := tree.ProofFor(ref)
		if err != nil {
			return err.Error()
		}
		// The salt in the directory is the one the published seed derives.
		seed, err := por.ParseSeed(text(v, "seed_hex"))
		if err != nil {
			return err.Error()
		}
		salt, err := por.DeriveSalt(seed, ref)
		if err != nil {
			return err.Error()
		}
		file, err := por.MarshalProofFile(st, proof)
		return first(differs("the salt", proof.Leaf.Salt, salt), sameDocument(file, err, want))
	}())

	g.record("the openings for a challenge", func() string {
		want, err := load(filepath.Join(dir, text(v, "openings_file")))
		if err != nil {
			return err.Error()
		}
		var openings []*por.Proof
		for _, o := range list(want, "openings") {
			proof, err := tree.Proof(integer(o, "leaf_index"))
			if err != nil {
				return err.Error()
			}
			openings = append(openings, proof)
		}
		file, err := por.MarshalOpenings(openings)
		return sameDocument(file, err, want)
	}())
}

// Describe returns a group's line for a report: its name and its counts.
func (g Group) Describe() string {
	return fmt.Sprintf("%s pass %d fail %d", g.Name, g.Passed, g.Failed)
}
