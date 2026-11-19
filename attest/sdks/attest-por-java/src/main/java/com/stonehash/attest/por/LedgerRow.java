package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One account of a ledger that read cleanly: its reference, exactly as the
 * exchange gave it, and the balances it was given, in smallest units.
 *
 * <p>Rows come only from {@link LedgerBuilder} and {@link CsvLedger}, so a row
 * that exists has passed every check of the specification.
 */
public final class LedgerRow {
    private final String userRef;
    private final AssetTable assets;
    /** By position in the asset table; null where the ledger gave no value for that asset. */
    private final BigInteger[] byAsset;
    /**
     * Positions in the order the values arrived, or null while that order is
     * the declared one — which it nearly always is, and then costs nothing.
     * Kept because the reference writes an account's balances in the order
     * its ledger gave them, and a stored snapshot should not depend on which
     * SDK wrote it.
     */
    private int[] arrival;
    private int highest = -1;

    LedgerRow(String userRef, AssetTable assets) {
        this.userRef = userRef;
        this.assets = assets;
        this.byAsset = new BigInteger[assets.size()];
    }

    /** A row given whole: every value at once, in {@code arrival} order (null for declared order). */
    LedgerRow(String userRef, AssetTable assets, BigInteger[] byAsset, int[] arrival) {
        this.userRef = userRef;
        this.assets = assets;
        this.byAsset = byAsset;
        this.arrival = arrival;
        this.highest = byAsset.length - 1;
    }

    /** The account reference, byte for byte as the ledger had it. */
    public String userRef() {
        return userRef;
    }

    /**
     * The balances this account was given, in the order they were given: for
     * rows per account and asset, the assets that had a row; for a row per
     * account, every asset. An asset missing here counts as zero in the tree.
     */
    public Map<String, BigInteger> balances() {
        Map<String, BigInteger> out = new LinkedHashMap<>();
        if (arrival == null) {
            for (int i = 0; i < byAsset.length; i++) {
                if (byAsset[i] != null) {
                    out.put(assets.symbols[i], byAsset[i]);
                }
            }
        } else {
            for (int i : arrival) {
                out.put(assets.symbols[i], byAsset[i]);
            }
        }
        return Collections.unmodifiableMap(out);
    }

    /** The value at an asset position, or null when none was given. */
    BigInteger at(int position) {
        return byAsset[position];
    }

    void put(int position, BigInteger value) {
        if (arrival == null && position < highest) {
            // The first value to arrive out of declared order: from here the order has to be written down.
            int given = 0;
            for (BigInteger v : byAsset) {
                if (v != null) {
                    given++;
                }
            }
            arrival = new int[given];
            int k = 0;
            for (int i = 0; i < byAsset.length; i++) {
                if (byAsset[i] != null) {
                    arrival[k++] = i;
                }
            }
        }
        if (arrival != null) {
            int[] longer = Arrays.copyOf(arrival, arrival.length + 1);
            longer[arrival.length] = position;
            arrival = longer;
        }
        byAsset[position] = value;
        highest = Math.max(highest, position);
    }
}
