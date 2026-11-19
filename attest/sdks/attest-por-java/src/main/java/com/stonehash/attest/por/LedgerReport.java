package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * What a ledger adds up to, and everything that was wrong with it.
 *
 * <p>The figures are for a person to compare with the exchange's own books
 * before anything is built: accounts, totals per asset, how many accounts hold
 * each asset. When {@link #ok()} is false they describe what was read before
 * and around the problems, and nothing may be built from them.
 */
public final class LedgerReport {
    private final long rows;
    private final int accounts;
    private final int zeroBalanceAccounts;
    private final Map<String, BigInteger> totals;
    private final Map<String, Integer> holders;
    private final List<String> assetsWithoutBalance;
    private final long problemCount;
    private final List<Problem> problems;
    private final CsvLayout layout;
    private final List<String> ignoredColumns;
    private final String fileSha256;
    private final long fileBytes;

    LedgerReport(long rows, int accounts, int zeroBalanceAccounts, Map<String, BigInteger> totals,
            Map<String, Integer> holders, List<String> assetsWithoutBalance, long problemCount,
            List<Problem> problems, CsvLayout layout, List<String> ignoredColumns, String fileSha256, long fileBytes) {
        this.rows = rows;
        this.accounts = accounts;
        this.zeroBalanceAccounts = zeroBalanceAccounts;
        this.totals = Collections.unmodifiableMap(totals);
        this.holders = Collections.unmodifiableMap(holders);
        this.assetsWithoutBalance = Collections.unmodifiableList(assetsWithoutBalance);
        this.problemCount = problemCount;
        this.problems = Collections.unmodifiableList(problems);
        this.layout = layout;
        this.ignoredColumns = Collections.unmodifiableList(ignoredColumns);
        this.fileSha256 = fileSha256;
        this.fileBytes = fileBytes;
    }

    /** True when nothing at all was refused. Only then does the ledger have rows. */
    public boolean ok() {
        return problemCount == 0;
    }

    /** Rows offered: data rows of a file (the header is not one), or calls to the builder. */
    public long rows() {
        return rows;
    }

    public int accounts() {
        return accounts;
    }

    /** Accounts every one of whose balances is zero. They are accounts all the same, and get a leaf. */
    public int zeroBalanceAccounts() {
        return zeroBalanceAccounts;
    }

    /** Per asset, in smallest units, in declared order. */
    public Map<String, BigInteger> totals() {
        return totals;
    }

    /** Per asset, the number of accounts holding more than zero. */
    public Map<String, Integer> holders() {
        return holders;
    }

    /** Declared assets nobody holds: worth a look, since a mistyped symbol in the declaration shows up here. */
    public List<String> assetsWithoutBalance() {
        return assetsWithoutBalance;
    }

    /** Every problem found, including those beyond the number kept in {@link #problems()}. */
    public long problemCount() {
        return problemCount;
    }

    /** The first problems found, in the order they were found, up to the limit the reader was given. */
    public List<Problem> problems() {
        return problems;
    }

    /** The layout of the file that was read; null for rows given in code, or when the header decided nothing. */
    public CsvLayout layout() {
        return layout;
    }

    /** Columns of a file that were read past: extra columns of a long export, named columns of a wide one. */
    public List<String> ignoredColumns() {
        return ignoredColumns;
    }

    /** SHA-256 of the file's bytes, so the figures can be tied to the export they came from; null for rows given in code. */
    public String fileSha256() {
        return fileSha256;
    }

    /** Size of the file in bytes; -1 for rows given in code. */
    public long fileBytes() {
        return fileBytes;
    }
}
