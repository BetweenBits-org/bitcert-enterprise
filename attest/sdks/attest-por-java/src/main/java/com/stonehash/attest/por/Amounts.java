package com.stonehash.attest.por;

import java.math.BigInteger;

/**
 * Amounts: from what a ledger prints to the integers the tree commits to, and
 * back.
 *
 * <p>Every balance in the tree is a whole number of the asset's smallest
 * unit. Ledgers rarely store that; they store {@code 0.5} in a DECIMAL
 * column, and the conversion is where a liability figure can change without
 * anyone deciding it should. So the conversion is exact or it is refused:
 * nothing is rounded, nothing is truncated, nothing is guessed, and no
 * floating-point type is involved at any point. A value that cannot be placed
 * on the integer grid exactly is a {@link PorException} whose code says what
 * was wrong with it (specification §2).
 */
public final class Amounts {
    /** Most assets use 18 or fewer; the bound exists to catch {@code BTC:80}. */
    public static final int MAX_DECIMALS = 36;

    /** Far beyond any real supply; longer text is a formatting accident, not an amount. */
    private static final int MAX_LENGTH = 62;

    private Amounts() {
    }

    /**
     * Converts one exported value to the canonical base-unit integer string
     * ({@code "0"} for zero, no leading zeros).
     *
     * @param decimals the asset's decimal places: 8 for BTC, 18 for ETH, 0 for a currency with no minor unit
     * @throws PorException with one of the {@code amount_*} codes of the specification
     */
    public static String toBaseUnits(String text, int decimals, AmountUnit unit) {
        requireDecimals(decimals);
        Conversion c = convert(text, decimals, unit);
        if (c.code != null) {
            throw new PorException(c.code, c.message);
        }
        return c.base;
    }

    /** {@link #toBaseUnits} as a number, for arithmetic. */
    public static BigInteger toBaseUnitValue(String text, int decimals, AmountUnit unit) {
        return new BigInteger(toBaseUnits(text, decimals, unit));
    }

    /**
     * The reverse, for a report a person reads: base units back to the
     * decimal figure, without trailing zeros.
     */
    public static String fromBaseUnits(String base, int decimals) {
        requireDecimals(decimals);
        if (base == null || base.isEmpty() || !allDigits(base, 0, base.length())) {
            throw new PorException("invalid_base_units", Text.quote(String.valueOf(base)) + " is not a base-unit integer");
        }
        if (decimals == 0) {
            return stripLeadingZeros(base);
        }
        StringBuilder padded = new StringBuilder();
        for (int i = base.length(); i < decimals + 1; i++) {
            padded.append('0');
        }
        padded.append(base);
        String whole = stripLeadingZeros(padded.substring(0, padded.length() - decimals));
        int end = padded.length();
        while (end > padded.length() - decimals && padded.charAt(end - 1) == '0') {
            end--;
        }
        String fraction = padded.substring(padded.length() - decimals, end);
        return fraction.isEmpty() ? whole : whole + "." + fraction;
    }

    /** {@link #fromBaseUnits(String, int)} for a value held as a number. A negative value is refused. */
    public static String fromBaseUnits(BigInteger base, int decimals) {
        if (base == null || base.signum() < 0) {
            throw new PorException("invalid_base_units", "a base-unit amount is a non-negative integer");
        }
        return fromBaseUnits(base.toString(), decimals);
    }

    /** The outcome of a conversion: a value, or the code and message of the refusal. */
    static final class Conversion {
        final String base;
        final String code;
        final String message;

        private Conversion(String base, String code, String message) {
            this.base = base;
            this.code = code;
            this.message = message;
        }
    }

    private static Conversion refused(String code, String message) {
        return new Conversion(null, code, message);
    }

    /**
     * The conversion without the exception, for the ledger builder: a ledger
     * with a systematic fault refuses every row, and millions of stack traces
     * would turn a report into an outage.
     *
     * <p>The checks run in the order the specification lists them; the order
     * decides which code a value with two faults is reported under.
     */
    static Conversion convert(String text, int decimals, AmountUnit unit) {
        // Padding from a fixed-width export is not part of the number. Unlike an
        // account identifier, trimming it cannot merge two different values.
        String v = Text.trim(text);
        if (v.isEmpty()) {
            return refused("amount_empty", "the amount is empty");
        }
        if (v.length() > MAX_LENGTH) {
            return refused("amount_too_long", Text.quote(v.substring(0, 24) + "…") + " is too long to be an amount");
        }
        char first = v.charAt(0);
        if (first == '-' || first == '\u2212') {
            return refused("amount_negative",
                    Text.quote(v) + " is negative; a liability cannot be below zero — settle or exclude it in the export");
        }
        if (v.indexOf('e') >= 0 || v.indexOf('E') >= 0) {
            return refused("amount_exponent",
                    Text.quote(v) + " is in exponent notation; export the column as plain decimal text");
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == ',' || c == '_' || c == '\'' || Text.isWhitespace(c)) {
                return refused("amount_grouping",
                        Text.quote(v) + " contains a grouping separator or a decimal comma; export digits and \".\" only");
            }
        }

        int dot = v.indexOf('.');
        if (unit == AmountUnit.BASE) {
            if (dot < 0 && allDigits(v, 0, v.length())) {
                return new Conversion(stripLeadingZeros(v), null, null);
            }
            if (dot >= 0 && allDigits(v, 0, dot) && allDigits(v, dot + 1, v.length())) {
                return refused("amount_fraction_in_base",
                        Text.quote(v) + " has a decimal point, but amounts were declared as smallest units");
            }
            return refused("amount_format", Text.quote(v) + " is not a whole number");
        }

        // ".5" is what some databases print for one half; "5." is not what any prints.
        String whole;
        String fraction;
        if (dot < 0) {
            whole = v;
            fraction = "";
            if (!allDigits(v, 0, v.length())) {
                return refused("amount_format", Text.quote(v) + " is not a decimal number");
            }
        } else {
            whole = dot == 0 ? "0" : v.substring(0, dot);
            fraction = v.substring(dot + 1);
            if (fraction.isEmpty() || !allDigits(whole, 0, whole.length()) || !allDigits(fraction, 0, fraction.length())) {
                return refused("amount_format", Text.quote(v) + " is not a decimal number");
            }
        }
        // A DECIMAL(36,18) column prints eighteen places for an asset that has
        // eight. Trailing zeros beyond the asset's precision carry no value; any
        // other digit there is value the tree could not represent.
        for (int i = decimals; i < fraction.length(); i++) {
            if (fraction.charAt(i) != '0') {
                return refused("amount_precision", Text.quote(v) + " has more than " + decimals + " decimal place"
                        + (decimals == 1 ? "" : "s") + "; the asset was declared with " + decimals);
            }
        }
        StringBuilder digits = new StringBuilder(whole.length() + decimals);
        digits.append(whole);
        digits.append(fraction, 0, Math.min(decimals, fraction.length()));
        for (int i = fraction.length(); i < decimals; i++) {
            digits.append('0');
        }
        return new Conversion(stripLeadingZeros(digits.toString()), null, null);
    }

    private static void requireDecimals(int decimals) {
        if (decimals < 0 || decimals > MAX_DECIMALS) {
            throw new PorException("invalid_decimals",
                    decimals + " decimal places is outside 0.." + MAX_DECIMALS);
        }
    }

    /** ASCII digits only, and vacuously true of an empty range. */
    private static boolean allDigits(String s, int from, int to) {
        for (int i = from; i < to; i++) {
            if (!Text.isAsciiDigit(s.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    private static String stripLeadingZeros(String digits) {
        int i = 0;
        while (i < digits.length() - 1 && digits.charAt(i) == '0') {
            i++;
        }
        return i == 0 ? digits : digits.substring(i);
    }
}
