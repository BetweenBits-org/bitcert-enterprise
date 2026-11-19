package por

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

var sampleBuiltAt = time.Date(2026, 11, 16, 1, 2, 3, 456_000_000, time.UTC)

// sampleCommitment is the commitment of the sample statement, as the vectors
// publish it.
const sampleCommitment = "4245836fda6114c01d9fd50a9b9e5f84f41cb62f6d727abcb8c97bb6f41a6712"

func sampleStatement(t testing.TB, tree *Tree) *Statement {
	t.Helper()
	st, err := NewStatement(StatementConfig{Name: "Sample Exchange", AsOf: "2026-11-16T00:00:00Z", Assets: btcEthUsdt}, tree, sampleBuiltAt)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestNewStatementSaysWhatTheTreeSays(t *testing.T) {
	tree := sampleTree(t)
	st := sampleStatement(t, tree)
	if st.Commitment() != sampleCommitment {
		t.Errorf("commitment %s, want %s", st.Commitment(), sampleCommitment)
	}
	if st.InstitutionID() != testExchange || st.ExchangeName() != "Sample Exchange" || st.AsOf() != "2026-11-16T00:00:00Z" ||
		st.Root() != sampleRoot || st.LeafCount() != 12 || st.GeneratedAt() != "2026-11-16T01:02:03.456Z" ||
		totalsOf(st.Totals()) != totalsOf(tree.Totals()) || len(st.Assets()) != 3 || st.Reserves() != nil {
		t.Errorf("the statement reads %s", st.Canonical())
	}
	want := `{"asof":"2026-11-16T00:00:00Z","assets":[{"decimals":8,"symbol":"BTC"},{"decimals":18,"symbol":"ETH"},{"decimals":6,"symbol":"USDT"}],` +
		`"exchange":{"institution_id":"KR-EX-0a1b2c","name":"Sample Exchange"},"generated_at":"2026-11-16T01:02:03.456Z",` +
		`"params":{"salt":"hmac-sha256(master_seed, user_ref)","user_ref_hash":"sha256(STONEHASH-POR-USER-V1\\n + exchange_id + \\n + user_ref)"},` +
		`"schema":"stonehash.por-snapshot.v1","totals":{"BTC":"2463358024","ETH":"114050000000000000001","USDT":"255810750000"},` +
		`"tree":{"algo":"merkle-sum-sha256-v1","leaf_count":12,"padding":"empty-zero","root":"` + sampleRoot + `"}}`
	if string(st.Canonical()) != want {
		t.Errorf("canonical form:\n got  %s\n want %s", st.Canonical(), want)
	}
	// It names no account.
	for i := 0; i < tree.LeafCount(); i++ {
		ref, _ := tree.UserRef(i)
		p, _ := tree.Proof(i)
		for _, private := range []string{ref, p.Leaf.Salt, p.Leaf.UserRefHash} {
			if strings.Contains(string(st.Canonical()), private) {
				t.Fatalf("the statement contains %q", private)
			}
		}
	}
	// What it hands out is the caller's to change.
	st.Totals()[0].Amount.SetInt64(0)
	st.Assets()[0].Symbol = "XXX"
	st.Canonical()[0] = '!'
	if st.Commitment() != sampleCommitment || st.Totals()[0].Amount.Sign() == 0 || st.Assets()[0].Symbol != "BTC" {
		t.Error("changing what the statement returned changed the statement")
	}
}

func TestStatementTimesAreWrittenInUTCWithMilliseconds(t *testing.T) {
	tree := sampleTree(t)
	seoul := time.FixedZone("KST", 9*3600)
	for at, want := range map[time.Time]string{
		time.Date(2026, 11, 16, 10, 2, 3, 456_999_999, seoul):   "2026-11-16T01:02:03.456Z",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC):             "2026-01-01T00:00:00.000Z",
		time.Date(999, 12, 31, 23, 59, 59, 1_000_000, time.UTC): "0999-12-31T23:59:59.001Z",
	} {
		st, err := NewStatement(StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: btcEthUsdt}, tree, at)
		if err != nil || st.GeneratedAt() != want {
			t.Errorf("%s: generated_at %v, %v; want %s", at, st, err, want)
		}
	}
	_, err := NewStatement(StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: btcEthUsdt}, tree, time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC))
	wantCode(t, err, CodeInvalidOption)
	// asof is kept exactly as the exchange wrote it.
	for _, asOf := range []string{"2026-11-16T09:00:00+09:00", "2026-11-16T00:00:00.123456Z", "2026-11-16T00:00:00-00:00",
		"2026-11-16T00:00:00.1Z", "2026-11-16T00:00:00.123456789Z", "0000-01-01T00:00:00Z", "9999-12-31T23:59:59+14:00", "2028-02-29T12:00:00-23:59"} {
		st, err := NewStatement(StatementConfig{Name: "x", AsOf: asOf, Assets: btcEthUsdt}, tree, sampleBuiltAt)
		if err != nil || st.AsOf() != asOf {
			t.Errorf("asof %q: %v, %v", asOf, st, err)
		}
	}
	for _, asOf := range []string{"", "2026-11-16", "2026-11-16T00:00:00", "16 Nov 2026", "2026-11-16 00:00:00Z", "2026-13-01T00:00:00Z", "now",
		// Forms Go's own parser reads and the platform's does not.
		"2026-11-16T00:00:00,5Z", "2026-11-16T00:00:00+24:00", "2026-11-16T00:00:00+09:60",
		"2026-11-16t00:00:00z", "2026-02-29T00:00:00Z", "2026-11-16T24:00:00Z", "2026-11-16T23:59:60Z", "2026-11-16T00:00:00+0900",
		"2026-11-16T00:00:00+09", "2026-11-16T00:00:00.Z", "2026-11-16T00:00:00.1234567890Z", "2026-11-16T00:00:00", "2026-11-16T00:00:00Zjunk", " 2026-11-16T00:00:00Z"} {
		_, err := NewStatement(StatementConfig{Name: "x", AsOf: asOf, Assets: btcEthUsdt}, tree, sampleBuiltAt)
		if codeOf(t, err) != CodeInvalidStatement {
			t.Errorf("asof %q: %v", asOf, err)
		}
	}
}

func TestNewStatementRefusesWhatDoesNotBelongToTheTree(t *testing.T) {
	tree := sampleTree(t)
	cfg := StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: btcEthUsdt}
	_, err := NewStatement(cfg, nil, sampleBuiltAt)
	wantCode(t, err, CodeInvalidOption)
	for name, assets := range map[string][]Asset{
		"another order":  {btcEthUsdt[1], btcEthUsdt[0], btcEthUsdt[2]},
		"one fewer":      btcEthUsdt[:2],
		"one more":       append(append([]Asset{}, btcEthUsdt...), Asset{"DOGE", 8}),
		"another symbol": {btcEthUsdt[0], btcEthUsdt[1], {"USDC", 6}},
	} {
		cfg.Assets = assets
		if _, err := NewStatement(cfg, tree, sampleBuiltAt); codeOf(t, err) != CodeTreeMismatch {
			t.Errorf("%s: %v", name, err)
		}
	}
	cfg.Assets = nil
	_, err = NewStatement(cfg, tree, sampleBuiltAt)
	wantCode(t, err, CodeInvalidOption)
}

func TestStatementReserves(t *testing.T) {
	tree := sampleTree(t)
	cfg := StatementConfig{Name: "x", AsOf: "2026-11-16T00:00:00Z", Assets: btcEthUsdt, Reserves: []ReserveEntry{
		{Chain: "eip155:1", Asset: "USDT", Address: "0x00000000000000000000000000000000000000aa", TokenContract: "0x00000000000000000000000000000000000000bb"},
		{Chain: "bip122:000000000019d6689c085ae165831e93", Asset: "BTC", Address: "bc1qexample"},
	}}
	st, err := NewStatement(cfg, tree, sampleBuiltAt)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := st.MarshalJSON()
	want := `"reserves":{"mode":"DECLARED","entries":[{"chain":"eip155:1","asset":"USDT","address":"0x00000000000000000000000000000000000000aa","token_contract":"0x00000000000000000000000000000000000000bb"},` +
		`{"chain":"bip122:000000000019d6689c085ae165831e93","asset":"BTC","address":"bc1qexample"}],` +
		`"note":"Addresses declared by the exchange; balances are measured on chain by verifiers. Address-control proof is out of sandbox scope."},"generated_at"`
	if !strings.Contains(string(text), want) {
		t.Errorf("reserves are written as\n %s\nwant it to contain\n %s", text, want)
	}
	back, err := ParseStatement(text)
	if err != nil || len(back.Reserves()) != 2 || back.Reserves()[0] != cfg.Reserves[0] || back.Reserves()[1] != cfg.Reserves[1] {
		t.Errorf("read back: %+v, %v", back, err)
	}
	for name, entry := range map[string]ReserveEntry{
		"no chain":   {Asset: "BTC", Address: "x"},
		"no asset":   {Chain: "c", Address: "x"},
		"no address": {Chain: "c", Asset: "BTC"},
	} {
		cfg.Reserves = []ReserveEntry{entry}
		if _, err := NewStatement(cfg, tree, sampleBuiltAt); codeOf(t, err) != CodeInvalidStatement {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// The canonical form — and so the commitment and the signature — is that of
// the parsed document: re-indenting or re-ordering the file changes nothing,
// and a member this version does not know is covered like any other.
func TestStatementCanonicalFormIsOfTheWholeDocument(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	compact, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(compact), `{"schema":"stonehash.por-snapshot.v1","exchange":{"institution_id":"KR-EX-0a1b2c","name":"Sample Exchange"},"asof":`) {
		t.Errorf("the file form does not keep the reference's member order: %s", compact)
	}
	var generic map[string]any
	if err := json.Unmarshal(compact, &generic); err != nil {
		t.Fatal(err)
	}
	// encoding/json writes members sorted and indented: another file, the same statement.
	reordered, _ := json.MarshalIndent(generic, "", "\t")
	back, err := ParseStatement(reordered)
	if err != nil || back.Commitment() != sampleCommitment || string(back.Canonical()) != string(st.Canonical()) {
		t.Fatalf("re-ordered and re-indented: %v", err)
	}

	withExtra := strings.Replace(string(compact), `"generated_at"`, `"future":{"b":[1,null,true],"a":"한글"},"generated_at"`, 1)
	extended, err := ParseStatement([]byte(withExtra))
	if err != nil {
		t.Fatalf("a member this version does not know: %v", err)
	}
	if !strings.Contains(string(extended.Canonical()), `"future":{"a":"한글","b":[1,null,true]}`) || extended.Commitment() == sampleCommitment {
		t.Errorf("the unknown member is not part of the canonical form: %s", extended.Canonical())
	}
	if written, _ := extended.MarshalJSON(); string(written) != withExtra {
		t.Errorf("the unknown member is not written back:\n got  %s\n want %s", written, withExtra)
	}
	// "reserves": null declares no reserves, and is still part of what is signed.
	withNull, err := ParseStatement([]byte(strings.Replace(string(compact), `"generated_at"`, `"reserves":null,"generated_at"`, 1)))
	if err != nil || withNull.Reserves() != nil || !strings.Contains(string(withNull.Canonical()), `"reserves":null`) {
		t.Errorf("reserves given as null: %v", err)
	}
	// What has no canonical form cannot be committed to.
	for _, extra := range []string{`"ratio":1.5`, `"big":9007199254740992`, `"n":1e2`} {
		_, err := ParseStatement([]byte(strings.Replace(string(compact), `"generated_at"`, extra+`,"generated_at"`, 1)))
		wantCode(t, err, CodeInvalidStatement)
	}
}

func TestParseStatementNamesEverythingWrong(t *testing.T) {
	st := sampleStatement(t, sampleTree(t))
	good, _ := st.MarshalJSON()
	alter := func(old, new string) string {
		if !strings.Contains(string(good), old) {
			t.Fatalf("the sample statement has no %q", old)
		}
		return strings.Replace(string(good), old, new, 1)
	}
	for name, c := range map[string]struct{ text, mention string }{
		"not JSON":                   {`{"schema":`, "JSON"},
		"an array":                   {`[]`, "object"},
		"another schema":             {alter(`por-snapshot.v1`, `por-snapshot.v2`), "schema"},
		"no exchange id":             {alter(`"institution_id":"KR-EX-0a1b2c"`, `"institution_id":""`), "exchange.institution_id"},
		"no exchange name":           {alter(`,"name":"Sample Exchange"`, ``), "exchange.name"},
		"asof without a zone":        {alter(`"asof":"2026-11-16T00:00:00Z"`, `"asof":"2026-11-16T00:00:00"`), "asof"},
		"asof that is a number":      {alter(`"asof":"2026-11-16T00:00:00Z"`, `"asof":1794787200`), "asof"},
		"no assets":                  {alter(`[{"symbol":"BTC","decimals":8},{"symbol":"ETH","decimals":18},{"symbol":"USDT","decimals":6}]`, `[]`), "assets"},
		"an asset twice":             {alter(`{"symbol":"ETH","decimals":18}`, `{"symbol":"BTC","decimals":18}`), "assets"},
		"decimals out of range":      {alter(`"decimals":18`, `"decimals":37`), "ETH"},
		"decimals as a string":       {alter(`"decimals":18`, `"decimals":"18"`), "assets[1].decimals"},
		"a symbol with a space":      {alter(`"symbol":"ETH"`, `"symbol":"E TH"`), "assets"},
		"another algorithm":          {alter(`merkle-sum-sha256-v1`, `merkle-sha256`), "tree.algo"},
		"another padding":            {alter(`empty-zero`, `duplicate-last`), "tree.padding"},
		"a root in upper case":       {alter(sampleRoot, strings.ToUpper(sampleRoot)), "tree.root"},
		"no leaves":                  {alter(`"leaf_count":12`, `"leaf_count":0`), "tree.leaf_count"},
		"too many leaves":            {alter(`"leaf_count":12`, `"leaf_count":2147483648`), "tree.leaf_count"},
		"a leaf count as text":       {alter(`"leaf_count":12`, `"leaf_count":"12"`), "tree.leaf_count"},
		"a total that is a number":   {alter(`"BTC":"2463358024"`, `"BTC":2463358024`), "totals.BTC"},
		"a negative total":           {alter(`"BTC":"2463358024"`, `"BTC":"-1"`), "totals.BTC"},
		"a total with leading zeros": {alter(`"BTC":"2463358024"`, `"BTC":"02463358024"`), "totals.BTC"},
		"a total missing":            {alter(`"BTC":"2463358024",`, ``), "totals has no entry for the listed asset BTC"},
		"a total for no asset":       {alter(`"BTC":"2463358024",`, `"BTC":"2463358024","DOGE":"1",`), "not listed"},
		"another derivation":         {alter(`hmac-sha256(master_seed, user_ref)`, `random`), "params.salt"},
		"no params":                  {alter(`"params":{`, `"parameters":{`), "params"},
		"reserves in another mode":   {alter(`"generated_at"`, `"reserves":{"mode":"PROVEN","entries":[],"note":"x"},"generated_at"`), "reserves.mode"},
		"a reserve entry incomplete": {alter(`"generated_at"`, `"reserves":{"mode":"DECLARED","entries":[{"chain":"c","asset":"BTC"}],"note":"x"},"generated_at"`), "reserves.entries[0].address"},
		"reserve entries not a list": {alter(`"generated_at"`, `"reserves":{"mode":"DECLARED","entries":{},"note":"x"},"generated_at"`), "reserves.entries"},
		"no time of building":        {alter(`"generated_at":"2026-11-16T01:02:03.456Z"`, `"generated_at":"yesterday"`), "generated_at"},
		"a member twice":             {alter(`"asof":`, `"asof":"2026-11-16T00:00:00Z","asof":`), "twice"},
	} {
		got, err := ParseStatement([]byte(c.text))
		if codeOf(t, err) != CodeInvalidStatement {
			t.Errorf("%s: read as %v, %v", name, got, err)
			continue
		}
		if !strings.Contains(err.Error(), c.mention) {
			t.Errorf("%s: the message does not mention %q: %v", name, c.mention, err)
		}
	}
	// Several things wrong are all named at once.
	_, err := ParseStatement([]byte(strings.NewReplacer(`"leaf_count":12`, `"leaf_count":0`, `por-snapshot.v1`, `x`, sampleRoot, "abc").Replace(string(good))))
	for _, mention := range []string{"schema", "tree.root", "tree.leaf_count"} {
		if !strings.Contains(err.Error(), mention) {
			t.Errorf("one error should name %s too: %v", mention, err)
		}
	}
	var viaJSON Statement
	if err := json.Unmarshal(good, &viaJSON); err != nil || viaJSON.Commitment() != sampleCommitment {
		t.Errorf("through encoding/json: %v", err)
	}
}
