package com.stonehash.attest.por;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The database path: rows straight from code, under the rules of the file. */
final class LedgerBuilderTest {
    private LedgerBuilderTest() {
    }

    private static LedgerBuilder builder() {
        return new LedgerBuilder(Sample.assets(), AmountUnit.DECIMAL);
    }

    private static String problems(Ledger ledger) {
        List<String> out = new ArrayList<>();
        for (Problem p : ledger.report().problems()) {
            out.add(p.line() + ":" + p.code());
        }
        return String.join(" ", out);
    }

    private static Map<String, String> map(String... keysAndValues) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            out.put(keysAndValues[i], keysAndValues[i + 1]);
        }
        return out;
    }

    /** The data rows of the sample export, split the simple way: it holds no quoted field. */
    private static List<String[]> sampleRows() throws Exception {
        List<String[]> rows = new ArrayList<>();
        List<String> lines = java.nio.file.Files.readAllLines(TestMain.vectors().resolve("intake/long.csv"));
        for (String line : lines.subList(1, lines.size())) {
            rows.add(line.split(","));
        }
        return rows;
    }

    static void testTheSameLedgerThreeWaysGivesTheSameRowsAndTheSameRoot() throws Exception {
        Ledger fromFile = Sample.ledger();
        LedgerBuilder perBalance = builder();
        Map<String, Map<String, String>> byAccount = new LinkedHashMap<>();
        for (String[] row : sampleRows()) {
            Check.isTrue(perBalance.add(row[0], row[1], row[2]), "accepted");
            byAccount.computeIfAbsent(row[0], k -> new HashMap<>()).put(row[1], row[2]);
        }
        Ledger viaAdd = perBalance.finish();
        LedgerBuilder perAccount = builder();
        for (Map.Entry<String, Map<String, String>> e : byAccount.entrySet()) {
            Check.isTrue(perAccount.addAccount(e.getKey(), e.getValue()), "accepted");
        }
        Ledger viaAccount = perAccount.finish();

        Check.isTrue(viaAdd.ok() && viaAccount.ok(), "both read cleanly");
        Check.equal(20L, viaAdd.report().rows(), "rows offered are calls");
        Check.equal(12L, viaAccount.report().rows(), "one call per account");
        Check.equal(fromFile.report().totals(), viaAdd.report().totals(), "totals, row per balance");
        Check.equal(fromFile.report().totals(), viaAccount.report().totals(), "totals, row per account");
        for (int i = 0; i < 12; i++) {
            Check.equal(fromFile.rows().get(i).userRef(), viaAdd.rows().get(i).userRef(), "order of first appearance");
            Check.equal(fromFile.rows().get(i).balances(), viaAdd.rows().get(i).balances(), "the balances given");
        }
        Check.equal(null, viaAdd.report().layout(), "no file, no layout");
        Check.equal(null, viaAdd.report().fileSha256(), "and no checksum");
        Check.equal(Sample.ROOT, PorTree.build(Sample.EXCHANGE, Sample.seed(), viaAdd).root(), "root, row per balance");
        Check.equal(Sample.ROOT, PorTree.build(Sample.EXCHANGE, Sample.seed(), viaAccount).root(), "root, row per account");
    }

    static void testRowsMayArriveInAnyOrder() throws Exception {
        List<String[]> rows = sampleRows();
        Collections.reverse(rows);
        LedgerBuilder ledger = builder();
        for (String[] row : rows) {
            ledger.add(row[0], row[1], row[2]);
        }
        Ledger reversed = ledger.finish();
        Check.equal("U-100012", reversed.rows().get(0).userRef(), "accounts in order of first appearance");
        Check.equal("[ETH, BTC]", reversed.rows().get(0).balances().keySet().toString(), "an account's balances in the order they were given");
        Check.equal(Sample.ROOT, PorTree.build(Sample.EXCHANGE, Sample.seed(), reversed).root(), "and the root does not depend on any of it");
    }

    static void testARefusedRowIsAProblemAtTheOrdinalOfTheCallAndTheLedgerYieldsNothing() {
        LedgerBuilder l = builder();
        Check.equal(true, l.add("u1", "BTC", "0.5"), "1");
        Check.equal(false, l.add("u1", "BTC", "1"), "2 duplicate_row");
        Check.equal(false, l.add(" u2", "BTC", "1"), "3 account_whitespace");
        Check.equal(false, l.add("u3", "DOGE", "1"), "4 unknown_asset");
        Check.equal(false, l.add("u4", "ETH", "0.0000000000000000001"), "5 amount_precision");
        Check.equal(false, l.addAccount("u5", map("BTC", "1", "SHIB", "9", "DOGE", "5")), "6 unknown_asset, both named");
        Check.equal(false, l.addAccount("u1", map("ETH", "1")), "7 duplicate_account: u1 already has a value");
        Check.equal(false, l.addAccount("u6", map("USDT", "-3")), "8 amount_negative");
        Check.equal(true, l.addAccount("u7", map("BTC", "", "USDT", "2.5")), "9: an empty value is holds none");
        Check.equal(false, l.add("u7", "USDT", "1"), "10 duplicate_row: the account row set every asset");
        Check.equal(false, l.add("u4", "ETH", "1"), "11 duplicate_row: the refused amount still was u4's ETH row");
        Ledger ledger = l.finish();
        Check.isTrue(ledger.rows().isEmpty(), "no rows");
        Check.equal("2:duplicate_row 3:account_whitespace 4:unknown_asset 5:amount_precision 6:unknown_asset 7:duplicate_account "
                + "8:amount_negative 10:duplicate_row 11:duplicate_row", problems(ledger), "problems");
        Check.isTrue(ledger.report().problems().get(4).message().contains("\"DOGE\", \"SHIB\" are not declared assets"),
                "undeclared keys are named in ascending order: " + ledger.report().problems().get(4).message());
        Check.equal(11L, ledger.report().rows(), "every call counts");
    }

    static void testAnEmptyLedgerAndALedgerOfOne() {
        Check.equal("0:no_accounts", problems(builder().finish()), "a snapshot of nothing is not evidence");
        LedgerBuilder one = builder();
        one.addAccount("only", map("USDT", "2.5"));
        Check.equal("{BTC=0, ETH=0, USDT=2500000}", one.finish().rows().get(0).balances().toString(), "an account row sets every asset");
        LedgerBuilder allRefused = builder();
        allRefused.add("", "BTC", "1");
        Check.equal("1:account_empty", problems(allRefused.finish()), "no_accounts would only repeat what the problems already say");
    }

    static void testNullsFromAQueryAreDataNotCrashes() {
        LedgerBuilder l = builder();
        Check.equal(false, l.add(null, "BTC", "1"), "a NULL account");
        Check.equal(false, l.add("u1", null, "1"), "a NULL asset");
        Check.equal(false, l.add("u1", "BTC", null), "a NULL amount in a row of its own is not a number");
        Map<String, String> withNull = new HashMap<>();
        withNull.put("BTC", null);
        withNull.put("ETH", "  ");
        Check.equal(true, l.addAccount("u2", withNull), "in an account row a NULL column is holds none");
        Check.equal("1:account_empty 2:unknown_asset 3:amount_empty", problems(l.finish()), "problems");
    }

    static void testTextThatHasNoUtf8EncodingIsRefusedNotAltered() {
        LedgerBuilder l = builder();
        Check.equal(false, l.add("half\ud83d", "BTC", "1"), "an unpaired surrogate cannot be hashed byte for byte");
        Check.equal(true, l.add("whole😀", "BTC", "1"), "a pair is a character like any other");
        Check.equal("1:account_encoding", problems(l.finish()), "problem");
    }

    static void testAFinishedBuilderIsFinished() {
        LedgerBuilder l = builder();
        l.add("u1", "BTC", "1");
        Ledger ledger = l.finish();
        Check.refuses("ledger_finished", () -> l.add("u2", "BTC", "1"));
        Check.refuses("ledger_finished", l::finish);
        Check.equal(BigInteger.valueOf(100000000), ledger.rows().get(0).balances().get("BTC"), "the ledger it returned is unaffected");
        Check.refuses("invalid_asset", () -> new LedgerBuilder(Collections.emptyList(), AmountUnit.BASE));
        Check.refuses("invalid_option", () -> builder().maxProblems(0));
    }
}
