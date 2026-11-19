package por

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
	"math/rand"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"stonehash.com/attest/por/internal/cjson"
)

// An independent reading of specification §4 and §5, written for clarity and
// nothing else: maps, the general canonical writer, explicit padding. The
// tree under test has to arrive at the same root by its own, faster road.

type oracleNode struct {
	hash []byte
	sums map[string]*big.Int
}

func oracleJCS(t testing.TB, sums map[string]*big.Int) []byte {
	t.Helper()
	obj := cjson.Object{}
	for asset, v := range sums {
		obj = append(obj, cjson.Member{Key: asset, Value: v.String()})
	}
	out, err := cjson.Canonical(obj)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func oracleHash(parts ...[]byte) []byte {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

type oracleRow struct {
	ref      string
	balances map[string]*big.Int
}

func oracleRoot(t testing.TB, exchangeID string, seed []byte, assets []string, rows []oracleRow) (string, map[string]*big.Int) {
	t.Helper()
	type keyed struct {
		refHash []byte
		node    oracleNode
	}
	var leaves []keyed
	for _, row := range rows {
		refHash := oracleHash([]byte("STONEHASH-POR-USER-V1\n" + exchangeID + "\n" + row.ref))
		mac := hmac.New(sha256.New, seed)
		mac.Write([]byte(row.ref))
		normalised := map[string]*big.Int{}
		for _, a := range assets {
			normalised[a] = new(big.Int)
			if v, ok := row.balances[a]; ok {
				normalised[a].Set(v)
			}
		}
		leaf := oracleHash([]byte("STONEHASH-POR-LEAF-V1\n"), mac.Sum(nil), refHash, oracleJCS(t, normalised))
		leaves = append(leaves, keyed{refHash, oracleNode{leaf, normalised}})
	}
	sort.Slice(leaves, func(i, j int) bool {
		return hex.EncodeToString(leaves[i].refHash) < hex.EncodeToString(leaves[j].refHash)
	})
	level := []oracleNode{}
	for _, l := range leaves {
		level = append(level, l.node)
	}
	empty := oracleNode{oracleHash([]byte("STONEHASH-POR-EMPTY-V1")), map[string]*big.Int{}}
	for _, a := range assets {
		empty.sums[a] = new(big.Int)
	}
	for len(level) > 1 {
		if len(level)%2 == 1 {
			level = append(level, empty)
		}
		var next []oracleNode
		for i := 0; i < len(level); i += 2 {
			l, r := level[i], level[i+1]
			sums := map[string]*big.Int{}
			for _, a := range assets {
				sums[a] = new(big.Int).Add(l.sums[a], r.sums[a])
			}
			next = append(next, oracleNode{oracleHash([]byte("STONEHASH-POR-NODE-V1\n"), l.hash, r.hash, oracleJCS(t, l.sums), oracleJCS(t, r.sums)), sums})
		}
		level = next
	}
	return hex.EncodeToString(level[0].hash), level[0].sums
}

// randomRows makes n accounts with uneven holdings: none of an asset, small
// amounts, and amounts beyond one and two machine words.
func randomRows(rng *rand.Rand, n int, assets []string) []oracleRow {
	rows := make([]oracleRow, n)
	for i := range rows {
		rows[i] = oracleRow{ref: fmt.Sprintf("acct-%d-%d", i, rng.Intn(1000)), balances: map[string]*big.Int{}}
		for _, a := range assets {
			switch rng.Intn(5) {
			case 0:
			case 1:
				rows[i].balances[a] = new(big.Int)
			case 2:
				rows[i].balances[a] = new(big.Int).Rand(rng, new(big.Int).Lsh(big.NewInt(1), uint(1+rng.Intn(200))))
			default:
				rows[i].balances[a] = big.NewInt(rng.Int63n(1_000_000_000))
			}
		}
	}
	return rows
}

func ledgerFromRows(t testing.TB, assets []string, rows []oracleRow) *Ledger {
	t.Helper()
	declared := make([]Asset, len(assets))
	for i, a := range assets {
		declared[i] = Asset{Symbol: a}
	}
	b, err := NewLedgerBuilder(LedgerOptions{Assets: declared, Amounts: Base})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if len(row.balances) == 0 {
			if err := b.AddAccount(row.ref, nil); err != nil {
				t.Fatal(err)
			}
			continue
		}
		for _, a := range assets {
			if v, ok := row.balances[a]; ok {
				if err := b.Add(row.ref, a, v.String()); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	ledger, report := b.Finish()
	if !report.OK {
		t.Fatalf("%+v", report.Problems)
	}
	return ledger
}

func TestTreeAgreesWithAnIndependentReadingOfTheSpecification(t *testing.T) {
	rng := rand.New(rand.NewSource(104729))
	seed := testSeed(t)
	assetSets := [][]string{{"BTC"}, {"BTC", "ETH", "USDT"}, {"z9", "A.b", "m_n-o", "0x", "USDT", "a", "B"}}
	for n := 1; n <= 70; n++ {
		assets := assetSets[n%len(assetSets)]
		rows := randomRows(rng, n, assets)
		wantRoot, wantTotals := oracleRoot(t, testExchange, seed, assets, rows)
		tree, err := BuildTree(testExchange, seed, ledgerFromRows(t, assets, rows))
		if err != nil {
			t.Fatal(err)
		}
		if tree.Root() != wantRoot {
			t.Fatalf("%d accounts, assets %v: root %s, want %s", n, assets, tree.Root(), wantRoot)
		}
		if tree.LeafCount() != n {
			t.Fatalf("leaf count %d, want %d", tree.LeafCount(), n)
		}
		totals := tree.Totals()
		if len(totals) != len(assets) {
			t.Fatalf("totals %v", totals)
		}
		for i, b := range totals {
			if b.Asset != assets[i] || b.Amount.Cmp(wantTotals[b.Asset]) != 0 {
				t.Fatalf("total %d is %s=%s, want %s=%s (declared order)", i, b.Asset, b.Amount, assets[i], wantTotals[assets[i]])
			}
		}
		// Every leaf's proof holds, by index and by account, and names its position.
		for i := 0; i < n; i++ {
			p, err := tree.Proof(i)
			if err != nil {
				t.Fatal(err)
			}
			if err := VerifyProof(p, wantRoot, totals); err != nil {
				t.Fatalf("%d accounts, leaf %d: %v", n, i, err)
			}
			if p.Leaf.UserRef != "" || p.LeafIndex != i || len(p.Leaf.Balances) != len(assets) {
				t.Fatalf("opening %d: %+v", i, p.Leaf)
			}
			ref, _ := tree.UserRef(i)
			own, err := tree.ProofFor(ref)
			if err != nil || own.LeafIndex != i || own.Leaf.UserRef != ref || own.Leaf.UserRefHash != UserRefHash(testExchange, ref) {
				t.Fatalf("the proof for %q: %+v, %v", ref, own, err)
			}
			if i > 0 && p.Leaf.UserRefHash <= previousHash(t, tree, i) {
				t.Fatalf("leaves are not in order of hashed reference at %d", i)
			}
		}
	}
}

func previousHash(t testing.TB, tree *Tree, i int) string {
	t.Helper()
	p, err := tree.Proof(i - 1)
	if err != nil {
		t.Fatal(err)
	}
	return p.Leaf.UserRefHash
}

func TestTreeIsAFunctionOfTheLedgerAlone(t *testing.T) {
	rng := rand.New(rand.NewSource(15485863))
	assets := []string{"BTC", "ETH", "USDT"}
	rows := randomRows(rng, 37, assets)
	base, err := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, assets, rows))
	if err != nil {
		t.Fatal(err)
	}
	// The order the rows arrive in does not matter ...
	shuffled := slices.Clone(rows)
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	again, _ := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, assets, shuffled))
	if again.Root() != base.Root() {
		t.Error("the root depends on the order rows arrived in")
	}
	// ... nor does the order the assets were declared in, which only decides
	// how the totals are listed.
	reversed, _ := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, []string{"USDT", "ETH", "BTC"}, rows))
	if reversed.Root() != base.Root() || reversed.Totals()[0].Asset != "USDT" {
		t.Error("the root depends on the order assets were declared in")
	}
	// The exchange, the seed and any balance do.
	other, _ := BuildTree("KR-EX-other", testSeed(t), ledgerFromRows(t, assets, rows))
	seed2 := testSeed(t)
	seed2[31] ^= 1
	reseeded, _ := BuildTree(testExchange, seed2, ledgerFromRows(t, assets, rows))
	rows[5].balances["BTC"] = new(big.Int).Add(big.NewInt(1), orZero(rows[5].balances["BTC"]))
	changed, _ := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, assets, rows))
	for name, tree := range map[string]*Tree{"exchange": other, "seed": reseeded, "balance": changed} {
		if tree.Root() == base.Root() {
			t.Errorf("another %s gave the same root", name)
		}
	}
}

func orZero(v *big.Int) *big.Int {
	if v == nil {
		return new(big.Int)
	}
	return v
}

func TestTreeLevelsArePaddedAsTheReferenceStoresThem(t *testing.T) {
	for n, want := range map[int][]int{1: {1}, 2: {2, 1}, 3: {4, 2, 1}, 5: {6, 4, 2, 1}, 8: {8, 4, 2, 1}, 9: {10, 6, 4, 2, 1}, 33: {34, 18, 10, 6, 4, 2, 1}} {
		rows := randomRows(rand.New(rand.NewSource(int64(n))), n, []string{"BTC"})
		tree, err := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, []string{"BTC"}, rows))
		if err != nil {
			t.Fatal(err)
		}
		var got []int
		for _, level := range tree.LevelHashes() {
			got = append(got, len(level))
		}
		if !slices.Equal(got, want) {
			t.Errorf("%d accounts: level sizes %v, want %v", n, got, want)
		}
		levels := tree.LevelHashes()
		if levels[len(levels)-1][0] != tree.Root() {
			t.Errorf("%d accounts: the last level is not the root", n)
		}
		if n%2 == 1 && n > 1 && levels[0][n] != EmptyNodeHash() {
			t.Errorf("%d accounts: the odd leaf level does not end in the empty node", n)
		}
	}
	if want := "13fc76d427344e4891117f54a18b42256f08fcf2b706cd7ea4951bf2a384d2ab"; EmptyNodeHash() != want {
		t.Errorf("empty node hash %s, want %s", EmptyNodeHash(), want)
	}
}

func TestBuildTreeRefusesWhatItCannotCommitTo(t *testing.T) {
	ledger := sampleLedger(t)
	_, err := BuildTree(testExchange, testSeed(t), nil)
	wantCode(t, err, CodeEmptyLedger)
	for _, seed := range [][]byte{nil, {}, make([]byte, 31), make([]byte, 33)} {
		_, err := BuildTree(testExchange, seed, ledger)
		wantCode(t, err, CodeInvalidOption)
	}
	for _, id := range []string{"", "two\nlines", "tab\there", "bad\xffbytes", "del\x7f"} {
		_, err := BuildTree(id, testSeed(t), ledger)
		wantCode(t, err, CodeInvalidOption)
	}
	// Two leaves under one hashed reference cannot come from a ledger, which
	// has each account once; they can come from a damaged leaves file.
	twice := []leaf{{refHash: hash{1}}, {refHash: hash{2}}, {refHash: hash{1}}}
	_, refusal := newTree(testExchange, []string{"BTC"}, twice)
	if refusal == nil || refusal.Code != CodeDuplicateLeaf {
		t.Errorf("duplicate leaves: %v", refusal)
	}
	if _, refusal := newTree(testExchange, []string{"BTC"}, nil); refusal == nil || refusal.Code != CodeEmptyLedger {
		t.Errorf("no leaves: %v", refusal)
	}
}

func TestTreeLookupsAndBounds(t *testing.T) {
	tree := sampleTree(t)
	if tree.Root() != sampleRoot || tree.LeafCount() != 12 || tree.ExchangeID() != testExchange {
		t.Fatalf("the sample tree: %s, %d leaves", tree.Root(), tree.LeafCount())
	}
	if at, ok := tree.IndexOf("U-100008"); !ok || at != 3 {
		t.Errorf("U-100008 is at %d (%v), want 3", at, ok)
	}
	for _, ref := range []string{"", "nobody", "u-100008", "U-100008 "} {
		if at, ok := tree.IndexOf(ref); ok {
			t.Errorf("%q was found at %d", ref, at)
		}
		_, err := tree.ProofFor(ref)
		wantCode(t, err, CodeUnknownAccount)
	}
	for _, i := range []int{-1, 12, 1 << 40} {
		_, err := tree.Proof(i)
		wantCode(t, err, CodeIndexOutOfRange)
		_, err = tree.UserRef(i)
		wantCode(t, err, CodeIndexOutOfRange)
	}
	// What the tree hands out is the caller's to change.
	tree.Totals()[0].Amount.SetInt64(0)
	tree.Assets()[0] = "XXX"
	p, _ := tree.Proof(0)
	p.Leaf.Balances[0].Amount.SetInt64(7)
	p.Siblings[0].Sums[0].Amount.SetInt64(7)
	if tree.Totals()[0].Amount.String() != "2463358024" || tree.Assets()[0] != "BTC" {
		t.Error("changing what the tree returned changed the tree")
	}
	if again, _ := tree.Proof(0); VerifyProof(again, sampleRoot, tree.Totals()) != nil {
		t.Error("changing a proof changed the tree")
	}
}

func TestTreeIsSafeToReadFromManyGoroutines(t *testing.T) {
	tree := sampleTree(t)
	totals := tree.Totals()
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				p, err := tree.Proof((g + i) % tree.LeafCount())
				if err != nil || VerifyProof(p, tree.Root(), totals) != nil {
					t.Errorf("proof %d: %v", i, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}

// The tree writes the canonical JSON of sums itself, a node at a time. It
// has to be byte for byte what the general writer produces.
func TestTreeSumsAreWrittenCanonically(t *testing.T) {
	rng := rand.New(rand.NewSource(982451653))
	for round := 0; round < 300; round++ {
		var assets []string
		for len(assets) < 1+rng.Intn(9) {
			symbol := strings.Repeat(string(rune('A'+rng.Intn(26))), 1+rng.Intn(3)) + []string{"", ".x", "_1", "-b", "9"}[rng.Intn(5)]
			if !slices.Contains(assets, symbol) {
				assets = append(assets, symbol)
			}
		}
		tree, err := BuildTree(testExchange, testSeed(t), ledgerFromRows(t, assets, randomRows(rng, 1, assets)))
		if err != nil {
			t.Fatal(err)
		}
		sums, want := make([]*big.Int, len(assets)), map[string]*big.Int{}
		for i, a := range assets {
			sums[i] = new(big.Int).Rand(rng, new(big.Int).Lsh(big.NewInt(1), uint(rng.Intn(260))))
			want[a] = sums[i]
		}
		if got := tree.appendSums(nil, sums); string(got) != string(oracleJCS(t, want)) {
			t.Fatalf("assets %v:\n got  %s\n want %s", assets, got, oracleJCS(t, want))
		}
	}
}

func TestLeafFunctionsMatchTheTree(t *testing.T) {
	tree := sampleTree(t)
	seed := testSeed(t)
	for i := 0; i < tree.LeafCount(); i++ {
		ref, _ := tree.UserRef(i)
		p, _ := tree.Proof(i)
		salt, err := DeriveSalt(seed, ref)
		if err != nil || salt != p.Leaf.Salt || UserRefHash(testExchange, ref) != p.Leaf.UserRefHash {
			t.Fatalf("leaf %d: the derivations disagree with the tree", i)
		}
		leafHash, err := LeafHash(p.Leaf.Salt, p.Leaf.UserRefHash, p.Leaf.Balances)
		if err != nil || leafHash != tree.LevelHashes()[0][i] {
			t.Fatalf("leaf %d: LeafHash %s (%v), the tree has %s", i, leafHash, err, tree.LevelHashes()[0][i])
		}
	}
	if _, err := DeriveSalt(seed[:31], "u"); codeOf(t, err) != CodeInvalidOption {
		t.Errorf("a short seed: %v", err)
	}
	good := strings.Repeat("ab", 32)
	for name, call := range map[string]func() (string, error){
		"an upper-case salt": func() (string, error) { return LeafHash(strings.ToUpper(good), good, nil) },
		"a short hash":       func() (string, error) { return LeafHash(good, good[:62], nil) },
		"a negative balance": func() (string, error) { return LeafHash(good, good, Balances{{"BTC", big.NewInt(-1)}}) },
		"a missing amount":   func() (string, error) { return LeafHash(good, good, Balances{{"BTC", nil}}) },
		"an asset twice": func() (string, error) {
			return LeafHash(good, good, Balances{{"BTC", big.NewInt(1)}, {"BTC", big.NewInt(1)}})
		},
		"a name not in UTF-8": func() (string, error) { return LeafHash(good, good, Balances{{"\xff", big.NewInt(1)}}) },
	} {
		if got, err := call(); err == nil {
			t.Errorf("%s: hashed to %s", name, got)
		}
	}
	seedA, errA := NewSeed()
	seedB, errB := NewSeed()
	if errA != nil || errB != nil || len(seedA) != SeedSize || string(seedA) == string(seedB) {
		t.Errorf("NewSeed: %x %x %v %v", seedA, seedB, errA, errB)
	}
}
