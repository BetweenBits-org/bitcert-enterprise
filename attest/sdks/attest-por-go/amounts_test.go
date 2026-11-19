package por

import (
	"fmt"
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

func TestToBaseUnitsIsExact(t *testing.T) {
	cases := []struct {
		text     string
		decimals int
		unit     AmountUnit
		want     string
	}{
		{"0.5", 8, Decimal, "50000000"},
		{".5", 8, Decimal, "50000000"},
		{"007.10", 2, Decimal, "710"},
		{"1234.000", 0, Decimal, "1234"},
		{"0.500000000000000000", 8, Decimal, "50000000"},
		{"1", 36, Decimal, "1" + strings.Repeat("0", 36)},
		{"0." + strings.Repeat("0", 35) + "1", 36, Decimal, "1"},
		{strings.Repeat("9", 62), 36, Decimal, strings.Repeat("9", 62) + strings.Repeat("0", 36)},
		{"00050", 8, Base, "50"},
		{"0", 0, Base, "0"},
		{"000", 18, Base, "0"},
		{strings.Repeat("9", 62), 0, Base, strings.Repeat("9", 62)},
	}
	for _, c := range cases {
		got, err := ToBaseUnits(c.text, c.decimals, c.unit)
		if err != nil {
			t.Errorf("ToBaseUnits(%q, %d, %s): %v", c.text, c.decimals, c.unit, err)
			continue
		}
		if got.String() != c.want {
			t.Errorf("ToBaseUnits(%q, %d, %s) = %s, want %s", c.text, c.decimals, c.unit, got, c.want)
		}
	}
}

// A value that is wrong in two ways is reported under the code the
// specification's order of checks reaches first.
func TestToBaseUnitsChecksInTheSpecifiedOrder(t *testing.T) {
	long := strings.Repeat("9", 63)
	cases := []struct {
		text string
		unit AmountUnit
		want string
	}{
		{" \t ", Decimal, CodeAmountEmpty},
		{"-" + long, Decimal, CodeAmountTooLong},
		{long + "e5", Decimal, CodeAmountTooLong},
		{"-1e5", Decimal, CodeAmountNegative},
		{"-1,000", Decimal, CodeAmountNegative},
		{"1e5,0", Decimal, CodeAmountExponent},
		{"1,0x", Decimal, CodeAmountGrouping},
		{"1'000", Decimal, CodeAmountGrouping},
		{"1\U000000A0000", Decimal, CodeAmountGrouping},
		{"1.5", Base, CodeAmountFractionInBase},
		{".", Base, CodeAmountFractionInBase},
		{"5.", Base, CodeAmountFractionInBase},
		{"1.2.3", Base, CodeAmountFormat},
		{"+5", Base, CodeAmountFormat},
		{"٣", Decimal, CodeAmountFormat},
		{"１２", Base, CodeAmountFormat},
		{"1.2.3", Decimal, CodeAmountFormat},
		{"\xff", Decimal, CodeAmountFormat},
	}
	for _, c := range cases {
		got, err := ToBaseUnits(c.text, 8, c.unit)
		if err == nil {
			t.Errorf("ToBaseUnits(%q, %s) = %s, want %s", c.text, c.unit, got, c.want)
			continue
		}
		if code := codeOf(t, err); code != c.want {
			t.Errorf("ToBaseUnits(%q, %s): code %s, want %s", c.text, c.unit, code, c.want)
		}
	}
}

func TestAmountsAreTrimmedOfTheSpecifiedWhitespaceOnly(t *testing.T) {
	spaces := []rune{0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2005, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF}
	for _, r := range spaces {
		got, err := ToBaseUnits(string(r)+"7"+string(r), 0, Base)
		if err != nil || got.String() != "7" {
			t.Errorf("U+%04X around an amount: got %v, %v; want it trimmed", r, got, err)
		}
		if _, err := ToBaseUnits("1"+string(r)+"0", 0, Base); codeOf(t, err) != CodeAmountGrouping {
			t.Errorf("U+%04X inside an amount: %v; want %s", r, err, CodeAmountGrouping)
		}
	}
	// Whitespace to Go's unicode package or to other languages, not to the specification.
	for _, r := range []rune{0x85, 0x180E, 0x200B, 0x2060, 0x1C} {
		if _, err := ToBaseUnits(string(r)+"7", 0, Base); codeOf(t, err) != CodeAmountFormat {
			t.Errorf("U+%04X before an amount: %v; want %s (it is not whitespace here)", r, err, CodeAmountFormat)
		}
	}
}

// The limit is 62 UTF-16 code units, as the reference measures it.
func TestAmountLengthIsMeasuredInUTF16Units(t *testing.T) {
	if _, err := ToBaseUnits(strings.Repeat("9", 62), 0, Base); err != nil {
		t.Errorf("62 digits: %v", err)
	}
	if _, err := ToBaseUnits(strings.Repeat("9", 63), 0, Base); codeOf(t, err) != CodeAmountTooLong {
		t.Errorf("63 digits: %v", err)
	}
	// 31 characters outside the Basic Multilingual Plane are 62 units; 32 are 64.
	if _, err := ToBaseUnits(strings.Repeat("😀", 31), 0, Base); codeOf(t, err) != CodeAmountFormat {
		t.Errorf("31 astral characters: %v, want %s", err, CodeAmountFormat)
	}
	if _, err := ToBaseUnits(strings.Repeat("😀", 32), 0, Base); codeOf(t, err) != CodeAmountTooLong {
		t.Errorf("32 astral characters: %v, want %s", err, CodeAmountTooLong)
	}
}

func TestAmountOptionsAreChecked(t *testing.T) {
	for _, decimals := range []int{-1, 37, 1000} {
		if _, err := ToBaseUnits("1", decimals, Decimal); codeOf(t, err) != CodeInvalidOption {
			t.Errorf("%d decimals: %v", decimals, err)
		}
		if _, err := FromBaseUnits(big.NewInt(1), decimals); codeOf(t, err) != CodeInvalidOption {
			t.Errorf("FromBaseUnits with %d decimals: %v", decimals, err)
		}
	}
	for _, unit := range []AmountUnit{"", "DECIMAL", "wei"} {
		if _, err := ToBaseUnits("1", 8, unit); codeOf(t, err) != CodeInvalidOption {
			t.Errorf("unit %q: %v", unit, err)
		}
	}
}

func TestFromBaseUnits(t *testing.T) {
	cases := []struct {
		base     string
		decimals int
		want     string
	}{
		{"50000000", 8, "0.5"}, {"1", 8, "0.00000001"}, {"0", 8, "0"}, {"1234", 0, "1234"},
		{"114050000000000000001", 18, "114.050000000000000001"}, {"100000000", 8, "1"}, {"1", 36, "0." + strings.Repeat("0", 35) + "1"},
	}
	for _, c := range cases {
		amount, _ := new(big.Int).SetString(c.base, 10)
		got, err := FromBaseUnits(amount, c.decimals)
		if err != nil || got != c.want {
			t.Errorf("FromBaseUnits(%s, %d) = %q, %v; want %q", c.base, c.decimals, got, err, c.want)
		}
	}
	if _, err := FromBaseUnits(big.NewInt(-1), 8); codeOf(t, err) != CodeInvalidBalance {
		t.Errorf("a negative amount: %v", err)
	}
	if _, err := FromBaseUnits(nil, 8); codeOf(t, err) != CodeInvalidBalance {
		t.Errorf("no amount: %v", err)
	}
}

// The conversion against exact rational arithmetic, over amounts the vectors
// do not happen to contain.
func TestToBaseUnitsAgreesWithRationalArithmetic(t *testing.T) {
	rng := rand.New(rand.NewSource(20261116))
	digits := func(n int) string {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte('0' + rng.Intn(10))
		}
		return string(b)
	}
	for i := 0; i < 5000; i++ {
		decimals := rng.Intn(MaxDecimals + 1)
		// At most 20 + 1 + 38 characters: within the 62 an amount may have.
		whole, fraction := digits(rng.Intn(21)), digits(rng.Intn(39))
		text := whole
		if fraction != "" || whole == "" {
			if fraction == "" {
				fraction = "0"
			}
			text = whole + "." + fraction
		}
		exact, _ := new(big.Rat).SetString(text)
		scaled := new(big.Rat).Mul(exact, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)))

		got, err := ToBaseUnits(text, decimals, Decimal)
		if !scaled.IsInt() {
			if codeOf(t, err) != CodeAmountPrecision {
				t.Fatalf("ToBaseUnits(%q, %d) = %v, %v; the value is not on the grid, want %s", text, decimals, got, err, CodeAmountPrecision)
			}
			continue
		}
		if err != nil || got.Cmp(scaled.Num()) != 0 {
			t.Fatalf("ToBaseUnits(%q, %d) = %v, %v; want %s", text, decimals, got, err, scaled.Num())
		}
		back, err := FromBaseUnits(got, decimals)
		if err != nil {
			t.Fatal(err)
		}
		if again, err := ToBaseUnits(back, decimals, Decimal); err != nil || again.Cmp(got) != 0 {
			t.Fatalf("%s printed as %q reads back as %v, %v", got, back, again, err)
		}
	}
}

func TestParseAssets(t *testing.T) {
	got, err := ParseAssets("BTC:8, ETH:18,KRW:0,")
	want := []Asset{{"BTC", 8}, {"ETH", 18}, {"KRW", 0}}
	if err != nil || fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, %v; want %v", got, err, want)
	}
	for text, fragment := range map[string]string{
		"BTC":                          "BTC:8",
		"BTC:8:9":                      "BTC:8",
		"BTC:":                         "BTC:8",
		":8":                           "BTC:8",
		"BTC:8,BTC:8":                  "twice",
		"BTC:80":                       "decimal places",
		"BTC:99999999999999999999":     "decimal places",
		"비트:8":                         "letters, digits",
		"-BTC:8":                       "letters, digits",
		strings.Repeat("A", 33) + ":8": "letters, digits",
		"":                             "no assets",
		" , ":                          "no assets",
	} {
		_, err := ParseAssets(text)
		if codeOf(t, err) != CodeInvalidOption || !strings.Contains(err.Error(), fragment) {
			t.Errorf("ParseAssets(%q): %v; want %s mentioning %q", text, err, CodeInvalidOption, fragment)
		}
	}
	// Every mistake is named at once.
	_, err = ParseAssets("BTC,ETH:99,OK:1")
	if !strings.Contains(err.Error(), `"BTC"`) || !strings.Contains(err.Error(), "ETH: 99") {
		t.Errorf("one error should name both mistakes: %v", err)
	}
	for _, symbol := range []string{"a", "0x", "A.b_c-d", strings.Repeat("Z", 32)} {
		if _, err := ParseAssets(symbol + ":0"); err != nil {
			t.Errorf("symbol %q: %v", symbol, err)
		}
	}
}
