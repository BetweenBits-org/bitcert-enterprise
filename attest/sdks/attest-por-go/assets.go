package por

import (
	"math/big"
	"strconv"
	"strings"

	"stonehash.com/attest/por/internal/cjson"
)

// Asset is one asset a snapshot covers: its symbol and the number of decimal
// places of the unit its ledger amounts are read in.
type Asset struct {
	Symbol   string
	Decimals int
}

// maxSymbolLen bounds an asset symbol.
const maxSymbolLen = 32

// validSymbol reports whether s matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$.
//
// ASCII only: a symbol becomes a member name inside every hash, and non-ASCII
// names are where canonical forms diverge between languages.
func validSymbol(s string) bool {
	if len(s) == 0 || len(s) > maxSymbolLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		alnum := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if !alnum && (i == 0 || (c != '.' && c != '_' && c != '-')) {
			return false
		}
	}
	return true
}

// ParseAssets reads a declaration such as "BTC:8,ETH:18,USDT:6": each asset's
// symbol, a colon, and its number of decimal places. Every mistake in the
// text is named in the one error returned.
func ParseAssets(text string) ([]Asset, error) {
	var assets []Asset
	var problems []string
	seen := map[string]bool{}
	for _, part := range strings.Split(text, ",") {
		part = trim(part)
		if part == "" {
			continue
		}
		symbol, places, ok := strings.Cut(part, ":")
		if !ok || symbol == "" || places == "" || !allDigits(places) {
			problems = append(problems, quote(part)+" should look like BTC:8 (symbol, colon, decimal places)")
			continue
		}
		if !validSymbol(symbol) {
			problems = append(problems, symbolRule(symbol))
			continue
		}
		// More digits than this cannot be a number of decimal places at all.
		decimals, err := strconv.Atoi(places)
		if err != nil || decimals > MaxDecimals {
			problems = append(problems, symbol+": "+places+" decimal places is more than any asset uses (limit "+strconv.Itoa(MaxDecimals)+")")
			continue
		}
		if seen[symbol] {
			problems = append(problems, "asset "+symbol+" is listed twice")
			continue
		}
		seen[symbol] = true
		assets = append(assets, Asset{Symbol: symbol, Decimals: decimals})
	}
	if len(assets) == 0 && len(problems) == 0 {
		problems = append(problems, "no assets were listed")
	}
	if len(problems) > 0 {
		return nil, errorf(CodeInvalidOption, "assets: %s", strings.Join(problems, "; "))
	}
	return assets, nil
}

func symbolRule(symbol string) string {
	return "asset symbol " + quote(symbol) + ` may contain only letters, digits, ".", "_" and "-", starting with a letter or digit (up to 32 characters)`
}

// checkAssets is the declaration every entry point is given: at least one
// asset, valid symbols, decimal places in range, no symbol twice.
func checkAssets(assets []Asset) *Error {
	if len(assets) == 0 {
		return errorf(CodeInvalidOption, "no assets were declared")
	}
	seen := make(map[string]bool, len(assets))
	for _, a := range assets {
		if !validSymbol(a.Symbol) {
			return errorf(CodeInvalidOption, "%s", symbolRule(a.Symbol))
		}
		if err := checkDecimals(a.Decimals); err != nil {
			return errorf(CodeInvalidOption, "%s: %s", a.Symbol, err.Message)
		}
		if seen[a.Symbol] {
			return errorf(CodeInvalidOption, "asset %s is declared twice", a.Symbol)
		}
		seen[a.Symbol] = true
	}
	return nil
}

func symbolsOf(assets []Asset) []string {
	symbols := make([]string, len(assets))
	for i, a := range assets {
		symbols[i] = a.Symbol
	}
	return symbols
}

// Balance is an amount of one asset, in the asset's smallest unit.
type Balance struct {
	Asset  string
	Amount *big.Int
}

// Balances is an amount per asset, in a stated order: the snapshot's declared
// order wherever this package produces one, the order of the document
// wherever it read one. The order is how the files are laid out; it never
// reaches a hash, because canonical JSON sorts member names.
//
// On the wire a Balances is a JSON object whose values are decimal strings.
type Balances []Balance

// Amount returns the amount held of an asset, or nil when the asset is not
// listed.
func (b Balances) Amount(asset string) *big.Int {
	for _, e := range b {
		if e.Asset == asset {
			return e.Amount
		}
	}
	return nil
}

// equalAmounts reports whether a and b state the same amounts, an asset
// missing on either side counting as zero — the comparison specification §5
// prescribes between a proof's sums and a statement's totals.
func equalAmounts(a, b Balances) bool {
	covered := func(x, y Balances) bool {
		for _, e := range x {
			other := y.Amount(e.Asset)
			if other == nil {
				other = zero
			}
			if e.Amount.Cmp(other) != 0 {
				return false
			}
		}
		return true
	}
	return covered(a, b) && covered(b, a)
}

var zero = new(big.Int)

// check refuses what must never enter a tree: an asset listed twice, a
// missing amount, a negative amount. A negative leaf is the classic way to
// make liabilities look smaller than they are.
func (b Balances) check(where string) *Error {
	for i, e := range b {
		if e.Amount == nil {
			return errorf(CodeInvalidBalance, "%s.%s has no amount", where, e.Asset)
		}
		if e.Amount.Sign() < 0 {
			return errorf(CodeInvalidBalance, "%s.%s: %s is negative; a balance is a non-negative integer", where, e.Asset, e.Amount)
		}
		for _, earlier := range b[:i] {
			if earlier.Asset == e.Asset {
				return errorf(CodeInvalidBalance, "%s lists %s twice", where, quote(e.Asset))
			}
		}
	}
	return nil
}

// value is the JSON object: each amount a decimal string, in the order held.
func (b Balances) value() cjson.Object {
	obj := make(cjson.Object, len(b))
	for i, e := range b {
		obj[i] = cjson.Member{Key: e.Asset, Value: e.Amount.String()}
	}
	return obj
}

// canonical is the canonical JSON of the balances, the form hashed into
// leaves and nodes.
func (b Balances) canonical() ([]byte, *Error) {
	out, err := cjson.Canonical(b.value())
	if err != nil {
		return nil, wrap(CodeNotCanonical, err, "balances")
	}
	return out, nil
}

// balancesFrom reads a JSON object of decimal strings.
//
// A JSON number is refused even when it is a whole one: `12` and "12" are
// different bytes in the canonical form, so they would add up to the same
// totals under two different roots. So is "007": it is the number seven, but
// hashed as written it is not the leaf the exchange committed to.
func balancesFrom(v any, where string) (Balances, *Error) {
	obj, ok := v.(cjson.Object)
	if !ok {
		return nil, errorf(CodeInvalidBalance, "%s must be an object giving each asset its amount", where)
	}
	out := make(Balances, len(obj))
	for i, m := range obj {
		text, ok := m.Value.(string)
		if !ok || !isCanonicalInteger(text) {
			return nil, errorf(CodeInvalidBalance, "%s.%s must be a non-negative integer written as a decimal string", where, m.Key)
		}
		amount, _ := new(big.Int).SetString(text, 10)
		out[i] = Balance{Asset: m.Key, Amount: amount}
	}
	return out, nil
}

// isCanonicalInteger reports whether s matches ^(0|[1-9][0-9]*)$.
func isCanonicalInteger(s string) bool {
	return s != "" && allDigits(s) && (s == "0" || s[0] != '0')
}

// MarshalJSON writes the balances as a JSON object of decimal strings.
func (b Balances) MarshalJSON() ([]byte, error) {
	if err := b.check("balances"); err != nil {
		return nil, err
	}
	out, err := cjson.Compact(b.value())
	if err != nil {
		return nil, wrap(CodeInvalidJSON, err, "balances")
	}
	return out, nil
}

// UnmarshalJSON reads a JSON object of decimal strings, keeping its order.
func (b *Balances) UnmarshalJSON(data []byte) error {
	v, err := cjson.Parse(data)
	if err != nil {
		return wrap(CodeInvalidJSON, err, "balances")
	}
	read, refusal := balancesFrom(v, "balances")
	if refusal != nil {
		return refusal
	}
	*b = read
	return nil
}
