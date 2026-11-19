package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * A ledger taken one row at a time, straight from the exchange's own query —
 * no file in between.
 *
 * <pre>{@code
 * LedgerBuilder ledger = new LedgerBuilder(assets, AmountUnit.DECIMAL);
 * try (ResultSet rs = statement.executeQuery(
 *         "SELECT user_id, currency, SUM(available + locked) FROM balances GROUP BY user_id, currency")) {
 *     while (rs.next()) {
 *         ledger.add(rs.getString(1), rs.getString(2), rs.getString(3));   // amounts as text, never a double
 *     }
 * }
 * Ledger result = ledger.finish();
 * if (!result.ok()) { ... result.report().problems() ... }
 * }</pre>
 *
 * <p>{@link #add} is one row per account and asset; {@link #addAccount} is one
 * row per account. They apply the rules of the specification's CSV intake,
 * unchanged — this class is what the file reader itself is built on — and
 * report a refused row the same way, with the 1-based ordinal of the call
 * where a file has a line number. Rows may come in any order.
 *
 * <p>The rules lean one way: nothing that could change a total is decided
 * silently. An asset that was not declared is an error, not a dropped row. A
 * second row for the same account and asset is an error, not a sum — whether
 * two wallets of one customer add up is the exchange's decision, made in its
 * own query where it can be reviewed. An account reference is used byte for
 * byte, so one with stray padding is refused rather than trimmed into a
 * different one. And the decision is taken on the whole ledger:
 * {@link #finish()} hands back rows only when nothing at all was refused.
 *
 * <p>Memory: one entry per account, holding the reference and one number per
 * asset the account was given. Nothing is kept per call. Not thread-safe;
 * feed it from one thread.
 */
public final class LedgerBuilder {
    private static final int DEFAULT_MAX_PROBLEMS = 50;
    private static final int MAX_ACCOUNT_BYTES = 256;

    private final AssetTable assets;
    private final AmountUnit unit;
    private Map<String, LedgerRow> accounts = new LinkedHashMap<>();
    private final List<Problem> kept = new ArrayList<>();
    private int maxProblems = DEFAULT_MAX_PROBLEMS;
    private long problemCount;
    private long calls;
    private boolean finished;

    /**
     * @param assets every asset the snapshot covers, with its decimal places
     * @param unit   how the amounts handed to this builder are written
     * @throws PorException {@code invalid_asset} for an empty list or a symbol listed twice
     */
    public LedgerBuilder(List<AssetSpec> assets, AmountUnit unit) {
        this.assets = AssetTable.of(Objects.requireNonNull(assets, "assets"));
        this.unit = Objects.requireNonNull(unit, "unit");
    }

    /**
     * How many problems to keep for the report (default 50). All of them are
     * counted; a ledger with a systematic fault has one problem per row, and
     * keeping every one would cost more memory than the ledger.
     */
    public LedgerBuilder maxProblems(int max) {
        if (max < 1) {
            throw new PorException("invalid_option", "maxProblems must be at least 1");
        }
        this.maxProblems = max;
        return this;
    }

    /**
     * One row per account and asset. {@code amount} is text, exactly as the
     * ledger prints it; a null in any position is treated as empty text and
     * refused under the corresponding rule.
     *
     * @return whether the row was accepted; a refused row is recorded as a problem
     */
    public boolean add(String account, String asset, String amount) {
        requireOpen();
        return longRow(++calls, orEmpty(account), orEmpty(asset), orEmpty(amount));
    }

    /**
     * One row per account: its amount for each asset, as text. An asset left
     * out of the map, or given as null or as empty text, is "holds none" —
     * what a NULL column prints as. A key that is not a declared asset
     * refuses the row.
     *
     * @return whether the row was accepted; a refused row is recorded as a problem
     */
    public boolean addAccount(String account, Map<String, String> amounts) {
        requireOpen();
        Objects.requireNonNull(amounts, "amounts");
        long line = ++calls;
        List<String> undeclared = null;
        for (String key : amounts.keySet()) {
            if (key == null || assets.indexOf(key) < 0) {
                if (undeclared == null) {
                    undeclared = new ArrayList<>();
                }
                undeclared.add(String.valueOf(key));
            }
        }
        if (undeclared != null) {
            Collections.sort(undeclared);
        }
        String[] cells = new String[assets.size()];
        for (int i = 0; i < cells.length; i++) {
            cells[i] = orEmpty(amounts.get(assets.symbols[i]));
        }
        return wideRow(line, orEmpty(account), cells, null, undeclared);
    }

    /**
     * Closes the ledger. The rows are present only when the report is ok.
     * The builder cannot be used afterwards, and no longer holds the ledger.
     */
    public Ledger finish() {
        return finish(calls, null, Collections.emptyList(), null, -1);
    }

    // ── the row rules, shared with the file reader ──────────────────────────

    /** The long row at a stated line. The checks run in the specification's order; the first failure ends the row. */
    boolean longRow(long line, String account, String assetCell, String amount) {
        if (accountRefused(line, account)) {
            return false;
        }
        String symbol = Text.trim(assetCell);
        int position = assets.indexOf(symbol);
        if (position < 0) {
            String near = assets.nearMatch(symbol);
            problem(line, "unknown_asset", near != null
                    ? "asset " + Text.quote(symbol) + " differs from the declared " + near
                            + " only by letter case; asset symbols are matched exactly"
                    : "asset " + Text.quote(symbol) + " is not a declared asset; a balance in an undeclared asset would be left out of the totals");
            return false;
        }
        LedgerRow row = accounts.get(account);
        if (row == null) {
            row = new LedgerRow(account, assets);
            accounts.put(account, row);
        }
        if (row.at(position) != null) {
            problem(line, "duplicate_row", "account " + Text.quote(account) + " has more than one " + symbol
                    + " row; give one row per account and asset (sum them in the query if they are meant to add up)");
            return false;
        }
        BigInteger value = amount(line, position, amount);
        // Held even when unreadable, so a later row for the same pair is still a duplicate.
        row.put(position, value == null ? BigInteger.ZERO : value);
        return value != null;
    }

    /**
     * The wide row at a stated line. {@code cells[k]} is the text for the
     * asset at position {@code cellAsset[k]} (or at position {@code k} when
     * that is null), in the order the cells are to be checked and remembered.
     */
    boolean wideRow(long line, String account, String[] cells, int[] cellAsset, List<String> undeclared) {
        if (accountRefused(line, account)) {
            return false;
        }
        if (accounts.containsKey(account)) {
            problem(line, "duplicate_account", "account " + Text.quote(account) + " appears on more than one row");
            return false;
        }
        if (undeclared != null) {
            StringBuilder names = new StringBuilder();
            for (String key : undeclared) {
                names.append(names.length() == 0 ? "" : ", ").append(Text.quote(key));
            }
            problem(line, "unknown_asset", names + (undeclared.size() == 1 ? " is not a declared asset" : " are not declared assets")
                    + "; a balance in an undeclared asset would be left out of the totals");
            return false;
        }
        BigInteger[] values = new BigInteger[assets.size()];
        boolean ok = true;
        for (int k = 0; k < cells.length; k++) {
            int position = cellAsset == null ? k : cellAsset[k];
            // An empty cell is "holds none" — what a NULL prints as.
            BigInteger value = Text.isBlank(cells[k]) ? BigInteger.ZERO : amount(line, position, cells[k]);
            if (value == null) {
                ok = false;
            } else {
                values[position] = value;
            }
        }
        if (!ok) {
            return false;
        }
        accounts.put(account, new LedgerRow(account, assets, values, cellAsset));
        return true;
    }

    /** Records a problem found outside the row rules (a header, a syntax error). */
    void problem(long line, String code, String message) {
        problemCount++;
        if (kept.size() < maxProblems) {
            kept.add(new Problem(line, code, message));
        }
    }

    boolean hasProblems() {
        return problemCount > 0;
    }

    AssetTable assetTable() {
        return assets;
    }

    Ledger finish(long rowsOffered, CsvLayout layout, List<String> ignoredColumns, String fileSha256, long fileBytes) {
        requireOpen();
        finished = true;
        if (accounts.isEmpty() && problemCount == 0) {
            problem(0, "no_accounts", "there are no accounts; a snapshot of nothing is not evidence");
        }
        int n = assets.size();
        BigInteger[] totals = new BigInteger[n];
        int[] holding = new int[n];
        Arrays.fill(totals, BigInteger.ZERO);
        int zeroAccounts = 0;
        for (LedgerRow row : accounts.values()) {
            boolean any = false;
            for (int i = 0; i < n; i++) {
                BigInteger v = row.at(i);
                if (v != null && v.signum() != 0) {
                    any = true;
                    totals[i] = totals[i].add(v);
                    holding[i]++;
                }
            }
            if (!any) {
                zeroAccounts++;
            }
        }
        Map<String, BigInteger> totalsByAsset = new LinkedHashMap<>();
        Map<String, Integer> holders = new LinkedHashMap<>();
        List<String> without = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            totalsByAsset.put(assets.symbols[i], totals[i]);
            holders.put(assets.symbols[i], holding[i]);
            if (holding[i] == 0) {
                without.add(assets.symbols[i]);
            }
        }
        LedgerReport report = new LedgerReport(rowsOffered, accounts.size(), zeroAccounts, totalsByAsset, holders,
                without, problemCount, new ArrayList<>(kept), layout, new ArrayList<>(ignoredColumns), fileSha256, fileBytes);
        List<LedgerRow> rows = report.ok() ? new ArrayList<>(accounts.values()) : new ArrayList<>();
        // The map was the working copy; the rows now belong to the ledger alone.
        accounts = null;
        return new Ledger(assets, rows, report);
    }

    private void requireOpen() {
        if (finished) {
            throw new PorException("ledger_finished", "this ledger was already finished; start a new LedgerBuilder");
        }
    }

    private static String orEmpty(String s) {
        return s == null ? "" : s;
    }

    /** The account rules of specification §3, in order. True when the row is refused. */
    private boolean accountRefused(long line, String account) {
        if (account.isEmpty()) {
            problem(line, "account_empty", "the account identifier is empty");
            return true;
        }
        if (Text.isWhitespace(account.charAt(0)) || Text.isWhitespace(account.charAt(account.length() - 1))) {
            problem(line, "account_whitespace", "account identifier " + Text.quote(account)
                    + " has leading or trailing whitespace; trim it at the source so the identifier is the one your customer knows");
            return true;
        }
        // The identifier sits after a line break in the hashed text, so one that
        // contains a line break could be read as a different exchange's.
        for (int i = 0; i < account.length(); i++) {
            char c = account.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                problem(line, "account_control_character",
                        "account identifier " + Text.quote(account) + " contains a control character");
                return true;
            }
        }
        // Only text handed over in code can be like this; a file is refused as a whole before any row is read.
        if (!Text.isWellFormed(account)) {
            problem(line, "account_encoding", "account identifier " + Text.quote(account)
                    + " contains an unpaired surrogate; it has no UTF-8 encoding, so it cannot be hashed");
            return true;
        }
        if (Text.utf8Length(account) > MAX_ACCOUNT_BYTES) {
            problem(line, "account_too_long", "account identifier is longer than " + MAX_ACCOUNT_BYTES + " bytes");
            return true;
        }
        return false;
    }

    /** One amount, converted; null (and a recorded problem) when it is refused. */
    private BigInteger amount(long line, int position, String text) {
        Amounts.Conversion c = Amounts.convert(text, assets.decimals[position], unit);
        if (c.code != null) {
            problem(line, c.code, assets.symbols[position] + ": " + c.message);
            return null;
        }
        return c.base.equals("0") ? BigInteger.ZERO : new BigInteger(c.base);
    }
}
