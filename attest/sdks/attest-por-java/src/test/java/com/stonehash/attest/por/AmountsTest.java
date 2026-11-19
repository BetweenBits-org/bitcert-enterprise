package com.stonehash.attest.por;

import java.math.BigInteger;

/** Amount conversion beyond what the vectors already pin down. */
final class AmountsTest {
    private AmountsTest() {
    }

    private static String code(String text, int decimals, AmountUnit unit) {
        try {
            return "accepted:" + Amounts.toBaseUnits(text, decimals, unit);
        } catch (PorException e) {
            return e.code();
        }
    }

    static void testWhitespaceIsTheSpecificationsSetAndNoOther() {
        // Trimmed: no-break space, ideographic space, byte-order mark.
        Check.equal("accepted:150", code("\u00a0\u30001.5\ufeff", 2, AmountUnit.DECIMAL), "trimmed");
        // Not in the set, so not trimmed: next line (U+0085), zero-width space (U+200B). Java's own trim() and
        // isWhitespace() each disagree with this on at least one of the four.
        Check.equal("amount_format", code("\u00851.5", 2, AmountUnit.DECIMAL), "U+0085 is not whitespace here");
        Check.equal("amount_format", code("1.5\u200b", 2, AmountUnit.DECIMAL), "U+200B is not whitespace here");
        Check.equal("amount_grouping", code("1\u00a0000", 2, AmountUnit.DECIMAL), "whitespace inside is a grouping separator");
        Check.equal("amount_grouping", code("1'000", 2, AmountUnit.DECIMAL), "an apostrophe is one too");
    }

    static void testOnlyAsciiDigitsAreDigits() {
        Check.equal("amount_format", code("\uff11\uff12", 0, AmountUnit.DECIMAL), "full-width digits");
        Check.equal("amount_format", code("\u0661\u0662", 0, AmountUnit.BASE), "Arabic-Indic digits");
    }

    static void testTheChecksRunInTheSpecificationsOrder() {
        String sixtyTwo = "0." + "0".repeat(60);
        Check.equal("accepted:0", code(sixtyTwo, 8, AmountUnit.DECIMAL), "62 characters are allowed");
        Check.equal("amount_too_long", code(sixtyTwo + "0", 8, AmountUnit.DECIMAL), "63 are not");
        Check.equal("amount_too_long", code("-" + "9".repeat(70), 8, AmountUnit.DECIMAL), "too long is said before negative");
        Check.equal("amount_negative", code("-1e5", 8, AmountUnit.DECIMAL), "negative before exponent");
        Check.equal("amount_exponent", code("1,0e5", 8, AmountUnit.DECIMAL), "exponent before grouping");
        Check.equal("amount_grouping", code("1,0.5.5", 8, AmountUnit.BASE), "grouping before format");
        Check.equal("amount_fraction_in_base", code(".", 8, AmountUnit.BASE), "a lone point in base units");
        Check.equal("amount_format", code("1.2.3", 8, AmountUnit.BASE), "two points are not a fraction");
        Check.equal("amount_precision", code("0.10000001", 7, AmountUnit.DECIMAL), "a digit beyond the precision");
    }

    static void testEdgesOfTheDecimalForm() {
        Check.equal("accepted:0", code(".0", 0, AmountUnit.DECIMAL), "no digits before the point, none kept after");
        Check.equal("accepted:0", code("000.000", 3, AmountUnit.DECIMAL), "all zeros");
        Check.equal("accepted:5", code(".5", 1, AmountUnit.DECIMAL), ".5");
        Check.equal("accepted:" + "1" + "0".repeat(36), code("1", 36, AmountUnit.DECIMAL), "36 decimal places");
        Check.equal(new BigInteger("2112345678"), Amounts.toBaseUnitValue("21.12345678", 8, AmountUnit.DECIMAL), "as a number");
        Check.refuses("invalid_decimals", () -> Amounts.toBaseUnits("1", 37, AmountUnit.DECIMAL));
        Check.refuses("invalid_decimals", () -> Amounts.toBaseUnits("1", -1, AmountUnit.BASE));
    }

    static void testBaseUnitsPrintBackAsTheFigureAPersonReads() {
        Check.equal("0.5", Amounts.fromBaseUnits("50000000", 8), "half a coin");
        Check.equal("0.00000001", Amounts.fromBaseUnits("1", 8), "one satoshi");
        Check.equal("0", Amounts.fromBaseUnits("0", 8), "zero");
        Check.equal("1234", Amounts.fromBaseUnits("001234", 0), "no minor unit");
        Check.equal("114.050000000000000001", Amounts.fromBaseUnits(new BigInteger("114050000000000000001"), 18), "wei");
        for (String v : new String[] { "0.5", "21.12345678", "0.00000001", "3" }) {
            Check.equal(v, Amounts.fromBaseUnits(Amounts.toBaseUnits(v, 8, AmountUnit.DECIMAL), 8), "round trip of " + v);
        }
        Check.refuses("invalid_base_units", () -> Amounts.fromBaseUnits("-5", 8));
        Check.refuses("invalid_base_units", () -> Amounts.fromBaseUnits("1.5", 8));
        Check.refuses("invalid_base_units", () -> Amounts.fromBaseUnits(BigInteger.ONE.negate(), 8));
    }

    static void testAssetListsAreParsedAndMistakesNamed() {
        Check.equal("[BTC:8, ETH:18, KRW:0]", AssetSpec.parseList("BTC:8, ETH:18,KRW:0").toString(), "a list");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("BTC")).getMessage().contains("BTC:8"), "shape");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("BTC:8,BTC:8")).getMessage().contains("twice"), "twice");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("BTC:80")).getMessage().contains("decimal places"), "80");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("\ube44\ud2b8:8")).getMessage().contains("letters, digits"), "non-ASCII");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("")).getMessage().contains("no assets"), "empty");
        Check.isTrue(Check.refuses("invalid_asset", () -> AssetSpec.parseList("BTC:8,ETH:x,-A:1")).getMessage().contains(";"), "all at once");
        Check.refuses("invalid_asset", () -> new AssetSpec("A".repeat(33), 0));
        Check.equal("a.b_c-9", new AssetSpec("a.b_c-9", 0).symbol(), "the characters a symbol may hold");
    }
}
