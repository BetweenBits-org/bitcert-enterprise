package com.stonehash.attest.por;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * One asset of a snapshot: its symbol and how many decimal places its
 * smallest unit has (BTC 8, ETH 18, a currency with no minor unit 0).
 *
 * <p>A symbol is ASCII — it becomes a key inside every hash, and non-ASCII
 * keys are where canonical forms diverge between languages — and is matched
 * exactly, letter case included: {@code btc} is not {@code BTC}.
 */
public final class AssetSpec {
    private final String symbol;
    private final int decimals;

    /** @throws PorException {@code invalid_asset} when the symbol or the decimal places are outside what the specification allows */
    public AssetSpec(String symbol, int decimals) {
        if (!isSymbol(symbol)) {
            throw new PorException("invalid_asset", "asset symbol " + Text.quote(String.valueOf(symbol))
                    + " may contain only letters, digits, \".\", \"_\" and \"-\", start with a letter or digit, and be at most 32 characters");
        }
        if (decimals < 0 || decimals > Amounts.MAX_DECIMALS) {
            throw new PorException("invalid_asset", symbol + ": " + decimals
                    + " decimal places is outside 0.." + Amounts.MAX_DECIMALS);
        }
        this.symbol = symbol;
        this.decimals = decimals;
    }

    public String symbol() {
        return symbol;
    }

    public int decimals() {
        return decimals;
    }

    /**
     * Reads {@code BTC:8,ETH:18,USDT:6}. Every mistake in the text is named
     * in one exception, so a typing error costs one run, not one per asset.
     *
     * @throws PorException {@code invalid_asset}
     */
    public static List<AssetSpec> parseList(String text) {
        List<AssetSpec> assets = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String raw : text.split(",", -1)) {
            String part = Text.trim(raw);
            if (part.isEmpty()) {
                continue;
            }
            String[] pieces = part.split(":", -1);
            if (pieces.length != 2 || pieces[0].isEmpty() || !isDecimalCount(pieces[1])) {
                problems.add(Text.quote(part) + " should look like BTC:8 (symbol, colon, decimal places)");
                continue;
            }
            // Three digits cannot overflow an int and are already far past the limit.
            int decimals = pieces[1].length() > 3 ? Integer.MAX_VALUE : Integer.parseInt(pieces[1]);
            if (!isSymbol(pieces[0])) {
                problems.add("asset symbol " + Text.quote(pieces[0])
                        + " may contain only letters, digits, \".\", \"_\" and \"-\" (up to 32 characters)");
            } else if (decimals > Amounts.MAX_DECIMALS) {
                problems.add(pieces[0] + ": " + pieces[1] + " decimal places is more than any asset uses (limit "
                        + Amounts.MAX_DECIMALS + ")");
            } else if (!seen.add(pieces[0])) {
                problems.add("asset " + pieces[0] + " is listed twice");
            } else {
                assets.add(new AssetSpec(pieces[0], decimals));
            }
        }
        if (assets.isEmpty() && problems.isEmpty()) {
            problems.add("no assets were listed");
        }
        if (!problems.isEmpty()) {
            throw new PorException("invalid_asset", String.join("; ", problems));
        }
        return Collections.unmodifiableList(assets);
    }

    /** {@code ^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$}, spelled out so no regex engine's idea of a letter is involved. */
    static boolean isSymbol(String s) {
        if (s == null || s.isEmpty() || s.length() > 32) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean alphanumeric = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
            if (!alphanumeric && (i == 0 || (c != '.' && c != '_' && c != '-'))) {
                return false;
            }
        }
        return true;
    }

    private static boolean isDecimalCount(String s) {
        if (s.isEmpty()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (!Text.isAsciiDigit(s.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof AssetSpec && ((AssetSpec) o).symbol.equals(symbol) && ((AssetSpec) o).decimals == decimals;
    }

    @Override
    public int hashCode() {
        return symbol.hashCode() * 31 + decimals;
    }

    @Override
    public String toString() {
        return symbol + ":" + decimals;
    }
}
