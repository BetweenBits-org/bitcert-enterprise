package por

import (
	"math/big"
	"strings"
)

// AmountUnit says how a ledger writes its amounts. It is always stated by the
// caller and never inferred: "1" is one bitcoin or one satoshi depending on a
// fact only the exchange knows, and a wrong guess is a liability total off by
// a factor of a hundred million that still looks like a number.
type AmountUnit string

const (
	// Decimal: the ledger holds the unit people read; 0.5 is half a coin.
	Decimal AmountUnit = "decimal"
	// Base: the ledger holds whole numbers of the asset's smallest unit.
	Base AmountUnit = "base"
)

// MaxDecimals is the most decimal places an asset may be declared with. Most
// assets use 18 or fewer; the bound exists to catch "BTC:80".
const MaxDecimals = 36

// typographicMinus is U+2212, the minus sign a spreadsheet or a report
// formatter writes. It marks a negative amount as surely as "-" does.
const typographicMinus = 0x2212

// maxAmountChars is the longest amount text that is still read. Anything
// longer is a formatting accident, far beyond any real supply.
const maxAmountChars = 62

// ToBaseUnits converts one amount, exactly as a ledger prints it, to a whole
// number of the asset's smallest unit.
//
// The conversion is exact or it is refused. Nothing is rounded, truncated or
// guessed: a ninth decimal place on an eight-place asset, an exponent, a
// thousands separator and a minus sign are each an *Error whose Code names
// what was wrong, for the exchange to resolve in its own ledger. decimals is
// the asset's number of decimal places (8 for BTC, 18 for ETH, 0 for a
// currency with no minor unit).
func ToBaseUnits(text string, decimals int, unit AmountUnit) (*big.Int, error) {
	if err := checkDecimals(decimals); err != nil {
		return nil, err
	}
	if err := checkUnit(unit); err != nil {
		return nil, err
	}
	digits, refusal := baseUnitDigits(text, decimals, unit)
	if refusal != nil {
		return nil, refusal
	}
	amount, _ := new(big.Int).SetString(digits, 10)
	return amount, nil
}

// FromBaseUnits is the reverse, for figures a person reads: a whole number of
// smallest units back to the decimal amount, with no trailing zeros.
func FromBaseUnits(amount *big.Int, decimals int) (string, error) {
	if err := checkDecimals(decimals); err != nil {
		return "", err
	}
	if amount == nil || amount.Sign() < 0 {
		return "", errorf(CodeInvalidBalance, "an amount in smallest units is a non-negative integer")
	}
	digits := amount.String()
	if decimals == 0 {
		return digits, nil
	}
	if len(digits) <= decimals {
		digits = strings.Repeat("0", decimals+1-len(digits)) + digits
	}
	whole, fraction := digits[:len(digits)-decimals], strings.TrimRight(digits[len(digits)-decimals:], "0")
	if fraction == "" {
		return whole, nil
	}
	return whole + "." + fraction, nil
}

func checkDecimals(decimals int) *Error {
	if decimals < 0 || decimals > MaxDecimals {
		return errorf(CodeInvalidOption, "%d decimal places is outside 0 to %d", decimals, MaxDecimals)
	}
	return nil
}

func checkUnit(unit AmountUnit) *Error {
	if unit != Decimal && unit != Base {
		return errorf(CodeInvalidOption,
			"the amount unit must be stated: %q if the ledger says 0.5 for half a coin, %q if it holds whole numbers of the smallest unit", Decimal, Base)
	}
	return nil
}

// baseUnitDigits is the conversion of specification §2: the decimal digits of
// the amount in smallest units, without leading zeros. The checks run in the
// specification's order, because the order decides which code a value that is
// wrong in two ways is reported under.
func baseUnitDigits(text string, decimals int, unit AmountUnit) (string, *Error) {
	// Padding from a fixed-width export is not part of the number. Unlike an
	// account identifier, trimming it cannot merge two different values.
	v := trim(text)
	if v == "" {
		return "", errorf(CodeAmountEmpty, "the amount is empty")
	}
	if utf16Len(v) > maxAmountChars {
		return "", errorf(CodeAmountTooLong, "%s... is too long to be an amount", quote(leadingRunes(v, 24)))
	}
	if r := firstRune(v); r == '-' || r == typographicMinus {
		return "", errorf(CodeAmountNegative,
			"%s is negative; a liability cannot be below zero; settle or exclude it where the ledger is read", quote(v))
	}
	if strings.ContainsAny(v, "eE") {
		return "", errorf(CodeAmountExponent, "%s is in exponent notation; read the column as plain decimal text", quote(v))
	}
	if strings.ContainsAny(v, ",_'") || strings.IndexFunc(v, isSpace) >= 0 {
		return "", errorf(CodeAmountGrouping,
			"%s contains a grouping separator or a decimal comma; amounts are digits and \".\" only", quote(v))
	}

	whole, fraction, hasPoint := strings.Cut(v, ".")
	if unit == Base {
		if !hasPoint && allDigits(v) {
			return stripLeadingZeros(v), nil
		}
		if hasPoint && allDigits(whole) && allDigits(fraction) {
			return "", errorf(CodeAmountFractionInBase,
				"%s has a decimal point, but amounts were declared as smallest units; declare them as %q if the ledger holds 0.5 for half a coin", quote(v), Decimal)
		}
		return "", errorf(CodeAmountFormat, "%s is not a whole number", quote(v))
	}

	// ".5" is what some databases print for one half; "5." is not what any prints.
	if !allDigits(whole) || !allDigits(fraction) || (hasPoint && fraction == "") {
		return "", errorf(CodeAmountFormat, "%s is not a decimal number", quote(v))
	}
	// A DECIMAL(36,18) column prints eighteen places for an asset that has
	// eight. Trailing zeros beyond the asset's precision carry no value; any
	// other digit there is value the tree could not represent.
	kept := fraction
	if len(fraction) > decimals {
		kept = fraction[:decimals]
		if strings.Trim(fraction[decimals:], "0") != "" {
			return "", errorf(CodeAmountPrecision, "%s has more than %d decimal %s; the asset was declared with %d",
				quote(v), decimals, plural(decimals, "place", "places"), decimals)
		}
	}
	return stripLeadingZeros(whole + kept + strings.Repeat("0", decimals-len(kept))), nil
}

// stripLeadingZeros keeps the last digit, so that zero stays "0".
func stripLeadingZeros(digits string) string {
	trimmed := strings.TrimLeft(digits, "0")
	if trimmed == "" {
		return "0"
	}
	return trimmed
}

// leadingRunes returns at most n characters from the start of s.
func leadingRunes(s string, n int) string {
	for i := range s {
		if n == 0 {
			return s[:i]
		}
		n--
	}
	return s
}
