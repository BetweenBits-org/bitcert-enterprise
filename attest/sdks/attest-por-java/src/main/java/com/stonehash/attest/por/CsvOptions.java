package com.stonehash.attest.por;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * How to read one balance export. The assets and the amount unit are always
 * stated; everything else has the specification's default and a setter.
 *
 * <pre>{@code
 * CsvOptions options = new CsvOptions(assets, AmountUnit.DECIMAL)
 *         .delimiter(';')
 *         .accountColumn("user_id").assetColumn("currency").balanceColumn("amount");
 * }</pre>
 */
public final class CsvOptions {
    private final List<AssetSpec> assets;
    private final AmountUnit unit;
    private CsvLayout layout;
    private char delimiter = ',';
    private String accountColumn = "account_id";
    private String assetColumn = "asset";
    private String balanceColumn = "balance";
    private List<String> ignoreColumns = Collections.emptyList();
    private int maxProblems = 50;

    /**
     * @param assets every asset the snapshot covers, with its decimal places
     * @param unit   how amounts are written in the file; never inferred
     */
    public CsvOptions(List<AssetSpec> assets, AmountUnit unit) {
        this.assets = Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(assets, "assets")));
        this.unit = Objects.requireNonNull(unit, "unit");
    }

    /** States the layout instead of letting the header decide it. Null (the default) lets the header decide. */
    public CsvOptions layout(CsvLayout layout) {
        this.layout = layout;
        return this;
    }

    /** The field separator when it is not a comma: one character other than a quote or a line break. */
    public CsvOptions delimiter(char delimiter) {
        if (delimiter == '"' || delimiter == '\n' || delimiter == '\r' || Character.isSurrogate(delimiter)) {
            throw new PorException("invalid_option",
                    "the delimiter must be a single character other than a quote or a line break");
        }
        this.delimiter = delimiter;
        return this;
    }

    /** The header name of the account column when it is not {@code account_id}. Compared ignoring case. */
    public CsvOptions accountColumn(String name) {
        this.accountColumn = Objects.requireNonNull(name, "name");
        return this;
    }

    /** The header name of the asset column (long layout) when it is not {@code asset}. */
    public CsvOptions assetColumn(String name) {
        this.assetColumn = Objects.requireNonNull(name, "name");
        return this;
    }

    /** The header name of the amount column (long layout) when it is not {@code balance}. */
    public CsvOptions balanceColumn(String name) {
        this.balanceColumn = Objects.requireNonNull(name, "name");
        return this;
    }

    /**
     * Wide layout only: columns that are neither the account nor an asset.
     * They have to be named because an unknown column in a wide export might
     * be an asset, and reading past it would leave its balances out of the
     * totals without a trace.
     */
    public CsvOptions ignoreColumns(List<String> names) {
        this.ignoreColumns = Collections.unmodifiableList(new ArrayList<>(Objects.requireNonNull(names, "names")));
        return this;
    }

    /** How many problems to keep for the report (default 50); all of them are counted. */
    public CsvOptions maxProblems(int max) {
        if (max < 1) {
            throw new PorException("invalid_option", "maxProblems must be at least 1");
        }
        this.maxProblems = max;
        return this;
    }

    List<AssetSpec> assets() {
        return assets;
    }

    AmountUnit unit() {
        return unit;
    }

    CsvLayout layout() {
        return layout;
    }

    char delimiter() {
        return delimiter;
    }

    String accountColumn() {
        return accountColumn;
    }

    String assetColumn() {
        return assetColumn;
    }

    String balanceColumn() {
        return balanceColumn;
    }

    List<String> ignoreColumns() {
        return ignoreColumns;
    }

    int maxProblems() {
        return maxProblems;
    }
}
