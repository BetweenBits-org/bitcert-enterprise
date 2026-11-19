package com.stonehash.attest.por;

import java.util.Collections;
import java.util.List;

/**
 * A ledger that has been read, from a file or from code: its rows and the
 * report on it. When the report is not {@linkplain LedgerReport#ok() ok}
 * there are no rows — a tree built from the rows that happened to be accepted
 * would commit to a total nobody chose.
 */
public final class Ledger {
    private final AssetTable assets;
    private final List<LedgerRow> rows;
    private final LedgerReport report;

    Ledger(AssetTable assets, List<LedgerRow> rows, LedgerReport report) {
        this.assets = assets;
        this.rows = Collections.unmodifiableList(rows);
        this.report = report;
    }

    /** The assets the ledger was read against, in declared order. */
    public List<AssetSpec> assets() {
        return assets.specs();
    }

    /** One row per account, in order of first appearance. Empty unless {@link #ok()}. */
    public List<LedgerRow> rows() {
        return rows;
    }

    public LedgerReport report() {
        return report;
    }

    public boolean ok() {
        return report.ok();
    }

    AssetTable assetTable() {
        return assets;
    }
}
