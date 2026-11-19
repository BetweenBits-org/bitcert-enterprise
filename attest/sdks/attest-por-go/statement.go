package por

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"time"

	"stonehash.com/attest/por/internal/cjson"
)

// Fixed text of the snapshot statement (specification §6).
const (
	statementSchema = "stonehash.por-snapshot.v1"
	treeAlgo        = "merkle-sum-sha256-v1"
	treePadding     = "empty-zero"
	// The two derivation rules are recorded as text; `\n` here is a backslash
	// followed by n, as it is in the statement.
	paramUserRefHash = `sha256(STONEHASH-POR-USER-V1\n + exchange_id + \n + user_ref)`
	paramSalt        = "hmac-sha256(master_seed, user_ref)"
	reservesMode     = "DECLARED"
	reservesNote     = "Addresses declared by the exchange; balances are measured on chain by verifiers. Address-control proof is out of sandbox scope."

	commitmentDomain = "STONEHASH-POR-V1\n"
	signingDomain    = "stonehash:remit:event:v1\n"
)

// timestampLayout is the form of generated_at and of the times this SDK
// writes: UTC, milliseconds, "Z".
const timestampLayout = "2006-01-02T15:04:05.000Z"

// ReserveEntry is one address the exchange declares it holds reserves at.
// The statement carries the declaration only; balances are measured on chain
// by whoever verifies.
type ReserveEntry struct {
	Chain   string
	Asset   string
	Address string
	// TokenContract is empty for a chain's native asset.
	TokenContract string
}

// StatementConfig is what a statement says beyond what the tree says.
type StatementConfig struct {
	// Name is the exchange's name as it should appear to readers.
	Name string
	// AsOf is the instant the ledger was read, written as an ISO 8601
	// date-time with a time zone: 2026-11-16T00:00:00Z. It is kept exactly as
	// given.
	AsOf string
	// Assets are the assets of the tree, in the same order, each with its
	// decimal places.
	Assets []Asset
	// Reserves is optional.
	Reserves []ReserveEntry
}

// Statement is the snapshot statement: the root, the totals, the number of
// accounts and the as-of time. It is the only thing about a snapshot that is
// sent to the platform by default, and it names no account.
//
// A Statement cannot be changed once it exists. It holds the document it was
// built or read from, members this version does not know included, so its
// canonical form — what is hashed and signed — is that of the whole document
// and not of the parts this version understands.
type Statement struct {
	doc       cjson.Object
	canonical []byte

	institutionID string
	name          string
	asOf          string
	assets        []Asset
	leafCount     int
	root          string
	totals        Balances
	reserves      []ReserveEntry
	generatedAt   string
}

// NewStatement builds the statement of a tree. generatedAt is the time of
// building — time.Now() outside tests.
func NewStatement(cfg StatementConfig, tree *Tree, generatedAt time.Time) (*Statement, error) {
	if tree == nil {
		return nil, errorf(CodeInvalidOption, "a statement is built from a tree")
	}
	if err := checkAssets(cfg.Assets); err != nil {
		return nil, err
	}
	if !slices.Equal(symbolsOf(cfg.Assets), tree.assets) {
		return nil, errorf(CodeTreeMismatch, "the statement's assets (%s) are not the tree's (%s)",
			strings.Join(symbolsOf(cfg.Assets), ", "), strings.Join(tree.assets, ", "))
	}
	generatedAt = generatedAt.UTC()
	if year := generatedAt.Year(); year < 0 || year > 9999 {
		return nil, errorf(CodeInvalidOption, "the time of building, %s, cannot be written as a four-digit year", generatedAt)
	}

	assets := make([]any, len(cfg.Assets))
	for i, a := range cfg.Assets {
		assets[i] = cjson.Object{{Key: "symbol", Value: a.Symbol}, {Key: "decimals", Value: int64(a.Decimals)}}
	}
	doc := cjson.Object{
		{Key: "schema", Value: statementSchema},
		{Key: "exchange", Value: cjson.Object{
			{Key: "institution_id", Value: tree.exchangeID},
			{Key: "name", Value: cfg.Name},
		}},
		{Key: "asof", Value: cfg.AsOf},
		{Key: "assets", Value: assets},
		{Key: "tree", Value: cjson.Object{
			{Key: "algo", Value: treeAlgo},
			{Key: "leaf_count", Value: int64(tree.LeafCount())},
			{Key: "root", Value: tree.Root()},
			{Key: "padding", Value: treePadding},
		}},
		{Key: "totals", Value: tree.Totals().value()},
		{Key: "params", Value: cjson.Object{
			{Key: "user_ref_hash", Value: paramUserRefHash},
			{Key: "salt", Value: paramSalt},
		}},
	}
	if len(cfg.Reserves) > 0 {
		entries := make([]any, len(cfg.Reserves))
		for i, e := range cfg.Reserves {
			entry := cjson.Object{
				{Key: "chain", Value: e.Chain},
				{Key: "asset", Value: e.Asset},
				{Key: "address", Value: e.Address},
			}
			if e.TokenContract != "" {
				entry = append(entry, cjson.Member{Key: "token_contract", Value: e.TokenContract})
			}
			entries[i] = entry
		}
		doc = append(doc, cjson.Member{Key: "reserves", Value: cjson.Object{
			{Key: "mode", Value: reservesMode},
			{Key: "entries", Value: entries},
			{Key: "note", Value: reservesNote},
		}})
	}
	doc = append(doc, cjson.Member{Key: "generated_at", Value: generatedAt.Format(timestampLayout)})

	// Built and read statements pass the same check, so this package never
	// writes one it would refuse to read back.
	st, err := statementFrom(doc)
	if err != nil {
		return nil, err
	}
	return st, nil
}

// ParseStatement reads a snapshot statement from JSON and checks its shape.
// Indentation and the order of members do not matter: neither changes the
// canonical form.
func ParseStatement(data []byte) (*Statement, error) {
	v, err := cjson.Parse(data)
	if err != nil {
		return nil, wrap(CodeInvalidStatement, err, "the statement")
	}
	st, refusal := statementFrom(v)
	if refusal != nil {
		return nil, refusal
	}
	return st, nil
}

// statementFrom checks a document against specification §6 and reads it.
// Everything wrong with it is named in the one error.
func statementFrom(v any) (*Statement, *Error) {
	r, err := readObject(v, CodeInvalidStatement, "")
	if err != nil {
		return nil, errorf(CodeInvalidStatement, "the statement must be a JSON object")
	}
	s := &Statement{doc: r.obj}
	var problems []string
	note := func(err *Error) bool {
		if err != nil {
			problems = append(problems, err.Message)
		}
		return err == nil
	}
	fixed := func(r reader, key, want string) {
		if got, err := r.str(key); !note(err) || got == want {
			return
		}
		problems = append(problems, r.prefix+key+" must be "+quote(want))
	}

	fixed(r, "schema", statementSchema)

	if exchange, err := r.object("exchange"); note(err) {
		s.institutionID, err = exchange.str("institution_id")
		if note(err) && s.institutionID == "" {
			problems = append(problems, "exchange.institution_id is empty")
		}
		s.name, err = exchange.str("name")
		note(err)
	}

	s.asOf, err = r.str("asof")
	if note(err) && !isInstant(s.asOf) {
		problems = append(problems, "asof must be an ISO 8601 instant with a time zone, such as 2026-11-16T00:00:00Z")
	}

	assetsRead := false
	if assets, err := r.array("assets"); note(err) {
		before := len(problems)
		for i, item := range assets {
			a, err := r.item("assets", i, item)
			if !note(err) {
				continue
			}
			symbol, err := a.str("symbol")
			if !note(err) {
				continue
			}
			decimals, err := a.integer("decimals")
			if !note(err) {
				continue
			}
			// Clamped only so that it fits an int; out of range either way.
			s.assets = append(s.assets, Asset{Symbol: symbol, Decimals: int(max(-1, min(decimals, MaxDecimals+1)))})
		}
		if len(problems) == before {
			if err := checkAssets(s.assets); err != nil {
				problems = append(problems, "assets: "+err.Message)
			}
		}
		assetsRead = len(problems) == before
	}

	if tree, err := r.object("tree"); note(err) {
		fixed(tree, "algo", treeAlgo)
		fixed(tree, "padding", treePadding)
		s.root, err = tree.hash("root")
		note(err)
		count, err := tree.integer("leaf_count")
		if note(err) && (count < 1 || count > maxLeafCount) {
			problems = append(problems, fmt.Sprintf("tree.leaf_count must be between 1 and %d", maxLeafCount))
		}
		s.leafCount = int(count)
	}

	s.totals, err = r.balances("totals")
	if note(err) && assetsRead {
		// Every listed asset has a total and nothing else does: a total with
		// no asset, or an asset with no total, is a statement about a
		// different set of liabilities than the one it lists.
		for _, a := range s.assets {
			if s.totals.Amount(a.Symbol) == nil {
				problems = append(problems, "totals has no entry for the listed asset "+a.Symbol)
			}
		}
		if len(s.totals) > len(s.assets) {
			problems = append(problems, "totals has an entry for an asset that is not listed")
		}
	}

	if params, err := r.object("params"); note(err) {
		fixed(params, "user_ref_hash", paramUserRefHash)
		fixed(params, "salt", paramSalt)
	}

	// A null is how some writers spell "none"; it is part of the canonical
	// form like any other member, and declares nothing.
	if reserves, present := r.obj.Get("reserves"); present && reserves != nil {
		s.reserves = readReserves(r, note, fixed)
	}

	s.generatedAt, err = r.str("generated_at")
	if note(err) && !isInstant(s.generatedAt) {
		problems = append(problems, "generated_at must be an ISO 8601 instant with a time zone")
	}

	if len(problems) > 0 {
		return nil, errorf(CodeInvalidStatement, "the statement is not valid: %s", strings.Join(problems, "; "))
	}
	canonical, cerr := cjson.Canonical(s.doc)
	if cerr != nil {
		return nil, wrap(CodeInvalidStatement, cerr, "the statement has no canonical form")
	}
	s.canonical = canonical
	return s, nil
}

func readReserves(r reader, note func(*Error) bool, fixed func(reader, string, string)) []ReserveEntry {
	reserves, err := r.object("reserves")
	if !note(err) {
		return nil
	}
	fixed(reserves, "mode", reservesMode)
	_, err = reserves.str("note")
	note(err)
	entries, err := reserves.array("entries")
	if !note(err) {
		return nil
	}
	out := make([]ReserveEntry, 0, len(entries))
	for i, item := range entries {
		e, err := reserves.item("entries", i, item)
		if !note(err) {
			continue
		}
		var entry ReserveEntry
		for _, f := range []struct {
			key  string
			into *string
		}{{"chain", &entry.Chain}, {"asset", &entry.Asset}, {"address", &entry.Address}} {
			*f.into, err = e.str(f.key)
			if note(err) && *f.into == "" {
				note(errorf(CodeInvalidStatement, "%s%s is empty", e.prefix, f.key))
			}
		}
		entry.TokenContract, err = e.optStr("token_contract")
		note(err)
		out = append(out, entry)
	}
	return out
}

// isInstant reports whether s is an ISO 8601 date-time that names one
// instant, in the form RFC 3339 gives it:
//
//	YYYY-MM-DDThh:mm:ss[.fraction](Z|+hh:mm|-hh:mm)
//
// The shape is checked here and the calendar by the time package. The time
// package alone would not do: it also reads a comma before the fraction and
// offsets such as +24:00, which the platform's reader refuses, and a
// statement this SDK builds has to be one the platform accepts.
func isInstant(s string) bool {
	const shape = "dddd-dd-ddTdd:dd:dd"
	if len(s) <= len(shape) {
		return false
	}
	for i := 0; i < len(shape); i++ {
		if isDigit := s[i] >= '0' && s[i] <= '9'; shape[i] == 'd' && !isDigit || shape[i] != 'd' && s[i] != shape[i] {
			return false
		}
	}
	zone := s[len(shape):]
	if zone[0] == '.' {
		digits := 0
		for 1+digits < len(zone) && zone[1+digits] >= '0' && zone[1+digits] <= '9' {
			digits++
		}
		if digits == 0 || digits > 9 {
			return false
		}
		zone = zone[1+digits:]
	}
	if zone != "Z" {
		if len(zone) != 6 || (zone[0] != '+' && zone[0] != '-') || zone[3] != ':' || !allDigits(zone[1:3]+zone[4:]) || zone[1:3] > "23" || zone[4:] > "59" {
			return false
		}
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// InstitutionID returns the exchange's institution id.
func (s *Statement) InstitutionID() string { return s.institutionID }

// ExchangeName returns the exchange's name.
func (s *Statement) ExchangeName() string { return s.name }

// AsOf returns the instant the ledger was read, as the exchange wrote it.
func (s *Statement) AsOf() string { return s.asOf }

// Assets returns the listed assets, in order.
func (s *Statement) Assets() []Asset { return slices.Clone(s.assets) }

// LeafCount returns the number of accounts in the tree.
func (s *Statement) LeafCount() int { return s.leafCount }

// Root returns the root of the tree.
func (s *Statement) Root() string { return s.root }

// Totals returns the declared total of every asset.
func (s *Statement) Totals() Balances {
	out := make(Balances, len(s.totals))
	for i, e := range s.totals {
		out[i] = Balance{Asset: e.Asset, Amount: new(big.Int).Set(e.Amount)}
	}
	return out
}

// Reserves returns the declared reserve addresses, if any.
func (s *Statement) Reserves() []ReserveEntry { return slices.Clone(s.reserves) }

// GeneratedAt returns the time the statement was built, as written.
func (s *Statement) GeneratedAt() string { return s.generatedAt }

// Canonical returns the canonical JSON of the statement: the bytes its
// commitment and its signature are taken over.
func (s *Statement) Canonical() []byte { return slices.Clone(s.canonical) }

// Commitment returns SHA256("STONEHASH-POR-V1\n" ‖ canonical statement), the
// value the platform anchors.
func (s *Statement) Commitment() string {
	h := sha256.New()
	h.Write([]byte(commitmentDomain))
	h.Write(s.canonical)
	return hex.EncodeToString(h.Sum(nil))
}

// signingInput is what the exchange signs: the platform's event domain
// followed by the canonical statement.
func (s *Statement) signingInput() []byte {
	return append([]byte(signingDomain), s.canonical...)
}

// MarshalJSON writes the statement on one line, members in their own order.
func (s *Statement) MarshalJSON() ([]byte, error) {
	out, err := cjson.Compact(s.doc)
	if err != nil {
		return nil, wrap(CodeInvalidStatement, err, "the statement cannot be written")
	}
	return out, nil
}

// UnmarshalJSON reads and checks a statement.
func (s *Statement) UnmarshalJSON(data []byte) error {
	read, err := ParseStatement(data)
	if err != nil {
		return err
	}
	*s = *read
	return nil
}

// matches reports why a tree is not the one this statement commits to, or nil.
func (s *Statement) matches(tree *Tree) *Error {
	switch {
	case tree.exchangeID != s.institutionID:
		return errorf(CodeTreeMismatch, "the tree was built for exchange %s, the statement is %s's", quote(tree.exchangeID), quote(s.institutionID))
	case tree.Root() != s.root:
		return errorf(CodeTreeMismatch, "the tree's root %s... is not the statement's %s...", tree.Root()[:16], s.root[:16])
	case tree.LeafCount() != s.leafCount:
		return errorf(CodeTreeMismatch, "the tree has %d leaves, the statement declares %d", tree.LeafCount(), s.leafCount)
	case !equalAmounts(tree.Totals(), s.totals):
		return errorf(CodeTreeMismatch, "the tree's totals are not the statement's")
	}
	return nil
}
