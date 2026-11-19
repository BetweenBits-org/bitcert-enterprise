package com.stonehash.attest.por;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The assets of one snapshot, in declared order, with what is needed to look
 * a symbol up and to write a sum vector in canonical JSON.
 *
 * <p>A ledger and the tree built from it share one instance; a row stores its
 * balances by position in this table, so the table is also what says which
 * rows may go into which tree.
 */
final class AssetTable {
    /** Symbols in declared order. */
    final String[] symbols;
    /** Decimal places by position, or null for a tree read back from disk, whose header names symbols only. */
    final int[] decimals;

    private final Map<String, Integer> position = new HashMap<>();
    private final Map<String, String> byLowerCase = new HashMap<>();
    /** Positions in the order canonical JSON lists the keys. */
    private final int[] canonicalOrder;
    /** Per canonical position, the bytes before that asset's digits: <code>{"BTC":"</code> first, <code>","ETH":"</code> after. */
    private final byte[][] canonicalLead;

    private AssetTable(String[] symbols, int[] decimals) {
        if (symbols.length == 0) {
            throw new PorException("invalid_asset", "a snapshot needs at least one asset");
        }
        this.symbols = symbols;
        this.decimals = decimals;
        for (int i = 0; i < symbols.length; i++) {
            if (!AssetSpec.isSymbol(symbols[i])) {
                throw new PorException("invalid_asset", Text.quote(String.valueOf(symbols[i])) + " is not an asset symbol");
            }
            if (position.put(symbols[i], i) != null) {
                throw new PorException("invalid_asset", "asset " + symbols[i] + " is listed twice");
            }
            byLowerCase.put(Text.lowerAscii(symbols[i]), symbols[i]);
        }
        Integer[] order = new Integer[symbols.length];
        for (int i = 0; i < order.length; i++) {
            order[i] = i;
        }
        // Symbols are ASCII, so every ordering of them agrees with the UTF-16 one canonical JSON uses.
        Arrays.sort(order, (a, b) -> symbols[a].compareTo(symbols[b]));
        canonicalOrder = new int[order.length];
        canonicalLead = new byte[order.length][];
        for (int k = 0; k < order.length; k++) {
            canonicalOrder[k] = order[k];
            // A symbol holds no character JSON would escape.
            canonicalLead[k] = ((k == 0 ? "{\"" : "\",\"") + symbols[order[k]] + "\":\"").getBytes(StandardCharsets.US_ASCII);
        }
    }

    static AssetTable of(List<AssetSpec> specs) {
        String[] symbols = new String[specs.size()];
        int[] decimals = new int[specs.size()];
        for (int i = 0; i < symbols.length; i++) {
            symbols[i] = specs.get(i).symbol();
            decimals[i] = specs.get(i).decimals();
        }
        return new AssetTable(symbols, decimals);
    }

    static AssetTable ofSymbols(List<String> symbols) {
        return new AssetTable(symbols.toArray(new String[0]), null);
    }

    int size() {
        return symbols.length;
    }

    /** Position of an exactly matching symbol, or -1. */
    int indexOf(String symbol) {
        Integer i = position.get(symbol);
        return i == null ? -1 : i;
    }

    /** The declared symbol that equals {@code name} ignoring case, or null: for saying "differs only by letter case". */
    String nearMatch(String name) {
        return byLowerCase.get(Text.lowerAscii(name));
    }

    List<String> symbolList() {
        return Collections.unmodifiableList(Arrays.asList(symbols.clone()));
    }

    List<AssetSpec> specs() {
        List<AssetSpec> out = new ArrayList<>(symbols.length);
        for (int i = 0; i < symbols.length; i++) {
            out.add(new AssetSpec(symbols[i], decimals[i]));
        }
        return Collections.unmodifiableList(out);
    }

    /** Appends the canonical JSON of the sum vector at {@code sums[offset ..]}; a null entry is zero. */
    void appendCanonical(ByteSink out, BigInteger[] sums, int offset) {
        for (int k = 0; k < canonicalOrder.length; k++) {
            out.put(canonicalLead[k]);
            BigInteger v = sums[offset + canonicalOrder[k]];
            if (v == null) {
                out.put((byte) '0');
            } else {
                out.putAscii(v.toString());
            }
        }
        out.put((byte) '"');
        out.put((byte) '}');
    }

    /** A sum vector as a map: every asset, in declared order. */
    Map<String, BigInteger> toMap(BigInteger[] sums, int offset) {
        Map<String, BigInteger> out = new LinkedHashMap<>();
        for (int i = 0; i < symbols.length; i++) {
            BigInteger v = sums[offset + i];
            out.put(symbols[i], v == null ? BigInteger.ZERO : v);
        }
        return Collections.unmodifiableMap(out);
    }
}
