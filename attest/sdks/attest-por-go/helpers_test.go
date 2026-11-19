package por

import (
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Shared by the tests of this package.

var btcEthUsdt = []Asset{{Symbol: "BTC", Decimals: 8}, {Symbol: "ETH", Decimals: 18}, {Symbol: "USDT", Decimals: 6}}

const testExchange = "KR-EX-0a1b2c"

func testSeed(t testing.TB) []byte {
	t.Helper()
	seed, err := hex.DecodeString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	if err != nil {
		t.Fatal(err)
	}
	return seed
}

// codeOf returns the Code of an *Error, "" for nil, and fails the test for
// any other kind of error: this package promises typed refusals.
func codeOf(t testing.TB, err error) string {
	t.Helper()
	if err == nil {
		return ""
	}
	var refusal *Error
	if !errors.As(err, &refusal) {
		t.Fatalf("error %q (%T) is not a *por.Error", err, err)
	}
	return refusal.Code
}

func wantCode(t testing.TB, err error, code string) {
	t.Helper()
	if got := codeOf(t, err); got != code {
		t.Fatalf("got code %q (%v), want %q", got, err, code)
	}
}

// vectorsDir is where the published vectors are: POR_VECTORS when set,
// otherwise the fixtures of the repository this SDK is developed in.
func vectorsDir(t testing.TB) string {
	t.Helper()
	dir := os.Getenv("POR_VECTORS")
	if dir == "" {
		dir = filepath.Join("..", "..", "fixtures", "por")
	}
	if _, err := os.Stat(filepath.Join(dir, "snapshot-dir", TreeFile)); err != nil {
		t.Fatalf("the conformance vectors were not found in %s; set POR_VECTORS to the directory that holds SPEC.md and its vector files", dir)
	}
	return dir
}

// sampleLedger is the sample ledger of the vectors, offered row by row.
func sampleLedger(t testing.TB) *Ledger {
	t.Helper()
	b, err := NewLedgerBuilder(LedgerOptions{Assets: btcEthUsdt, Amounts: Decimal})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range [][3]string{
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
	} {
		if err := b.Add(r[0], r[1], r[2]); err != nil {
			t.Fatal(err)
		}
	}
	ledger, report := b.Finish()
	if !report.OK {
		t.Fatalf("the sample ledger was refused: %+v", report.Problems)
	}
	return ledger
}

// sampleRoot is the root of the sample ledger under testExchange and
// testSeed, as the vectors publish it.
const sampleRoot = "0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa"

func sampleTree(t testing.TB) *Tree {
	t.Helper()
	tree, err := BuildTree(testExchange, testSeed(t), sampleLedger(t))
	if err != nil {
		t.Fatal(err)
	}
	return tree
}
