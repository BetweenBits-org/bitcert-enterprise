package com.stonehash.attest.por;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Reading an export: the CSV dialect and the intake rules. These tests are
 * about refusal as much as about reading — the cases that matter most are the
 * ones where a lenient reader would have produced a number anyway.
 */
final class CsvTest {
    private CsvTest() {
    }

    /** Records as "line:field|field", for comparing at a glance. */
    private static List<String> parse(String text, char delimiter, int... cuts) throws CsvParser.SyntaxError {
        List<String> out = new ArrayList<>();
        CsvParser.Sink sink = (line, fields) -> out.add(line + ":" + String.join("|", fields));
        CsvParser parser = new CsvParser(delimiter);
        char[] chars = text.toCharArray();
        int from = 0;
        for (int cut : cuts) {
            parser.push(chars, from, cut - from, sink);
            from = cut;
        }
        parser.push(chars, from, chars.length - from, sink);
        parser.end(sink);
        return out;
    }

    private static String syntaxError(String text) {
        try {
            parse(text, ',');
            return "accepted";
        } catch (CsvParser.SyntaxError e) {
            return e.line + ": " + e.getMessage();
        }
    }

    private static Ledger read(String text, CsvOptions options) {
        return CsvLedger.read(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), options);
    }

    private static CsvOptions options() {
        return new CsvOptions(Sample.assets(), AmountUnit.DECIMAL);
    }

    private static String problems(Ledger ledger) {
        List<String> out = new ArrayList<>();
        for (Problem p : ledger.report().problems()) {
            out.add(p.line() + ":" + p.code());
        }
        return String.join(" ", out);
    }

    // ── the dialect ─────────────────────────────────────────────────────────

    static void testParserPlainQuotedEscapedCrlfBomAndBlankLines() throws Exception {
        Check.equal(Arrays.asList("1:a|b", "2:1|2"), parse("a,b\n1,2\n", ','), "plain");
        Check.equal(Arrays.asList("1:a|b", "2:1|2"), parse("a,b\r\n1,2", ','), "the last record need not end in a line break");
        Check.equal(Arrays.asList("1:a|b"), parse("\ufeffa,b\n", ','), "a byte-order mark is skipped");
        Check.equal(Arrays.asList("1:x,1|say \"hi\"|"), parse("\"x,1\",\"say \"\"hi\"\"\",\"\"\n", ','), "quotes");
        Check.equal(Arrays.asList("1:a", "4:b"), parse("a\n\n\r\nb\n", ','), "blank lines are skipped but counted");
        Check.equal(Arrays.asList("1:a|"), parse("a,\n", ','), "a trailing delimiter is an empty last field");
        Check.equal(Arrays.asList("1:a|b"), parse("a;b\n", ';'), "another delimiter");
        Check.equal(Arrays.asList("1:h", "2:two\nlines", "4:next"), parse("h\n\"two\nlines\"\nnext\n", ','),
                "a record keeps the line it started on");
        Check.equal(Arrays.asList("1:a", "2:b", "3:c"), parse("a\rb\rc", ','), "a lone CR ends a record too, as in the reference");
        Check.equal(Arrays.asList("1:  "), parse("  \n", ','), "a line of spaces is not a line with nothing on it");
    }

    static void testParserRefusesWhatASpreadsheetWouldGuessAt() {
        Check.isTrue(syntaxError("a,b\n1,2\"3\n").startsWith("2: a \" inside an unquoted field"), syntaxError("a,b\n1,2\"3\n"));
        Check.isTrue(syntaxError("a\n\"x\"y\n").startsWith("2: unexpected \"y\" after a closing quote"), syntaxError("a\n\"x\"y\n"));
        Check.isTrue(syntaxError("a\n\"never closed\nmore\n").startsWith("2: the file ends inside a quoted field"), "line where the record began");
        Check.isTrue(syntaxError("a\n\"x\" ,1\n").startsWith("2: unexpected \" \""), "a space after a closing quote");
        // An unpaired quote must not pull the rest of the file into one field.
        String runaway = "h\nok\n\"" + "x".repeat(CsvParser.MAX_QUOTED_FIELD_CHARS + 1);
        Check.isTrue(syntaxError(runaway).startsWith("3: a quoted field never closes"), "bounded at the record's line");
        Check.refuses("invalid_option", () -> options().delimiter('"'));
        Check.refuses("invalid_option", () -> options().delimiter('\n'));
    }

    static void testParserResultDoesNotDependOnWhereTheInputWasCut() throws Exception {
        // Inside CRLF, inside "", and right after a closing quote are where a streaming parser goes wrong.
        String text = "\ufeffid,note\r\n1,\"a \"\"b\"\" c\"\r\n2,\"line\r\nbreak\"\r\n\r\n3,plain";
        List<String> whole = parse(text, ',');
        Check.equal(4, whole.size(), "records");
        for (int cut = 0; cut <= text.length(); cut++) {
            Check.equal(whole, parse(text, ',', cut), "cut at " + cut);
            for (int second = cut; second <= text.length(); second += 7) {
                Check.equal(whole, parse(text, ',', cut, second), "cut at " + cut + " and " + second);
            }
        }
    }

    // ── a file as a whole ───────────────────────────────────────────────────

    static void testFileLevelFailuresAreProblemsNotExceptions() {
        Check.equal("0:empty_file", problems(read("", options())), "nothing at all");
        Check.equal("0:empty_file", problems(read("\n\r\n\n", options())), "only blank lines");
        Check.equal("0:no_accounts", problems(read("account_id,asset,balance\n", options())), "a header and nothing else");
        Check.equal("2:csv_syntax", problems(read("account_id,asset,balance\nu1,BTC,\"1\n", options())), "an unpaired quote");
        Check.equal("1:csv_syntax", problems(read("account_id,\"asset\"x,balance\nu1,BTC,1\n", options())), "in the header itself");
        Check.equal("1:header_no_account", problems(read("account_id;asset;balance\nu1;BTC;1\n", options())), "another delimiter");
        Check.isTrue(read("account_id;asset;balance\nu1;BTC;1\n", options()).report().problems().get(0).message().contains("delimiter"),
                "and the message says so");
        Check.isTrue(read("account_id;asset;balance\nu1;BTC;1\n", options().delimiter(';')).ok(), "stated, it reads");
        Check.equal("3:amount_negative 4:csv_syntax", problems(read("account_id,asset,balance\nu1,BTC,1\nu2,BTC,-1\nu3,BTC,\"1\"x\nu4,BTC,-1\n", options())),
                "reading stops at a syntax error, keeping what was found before it");
        Check.refuses("io_error", () -> CsvLedger.read(TestMain.vectors().resolve("no-such-file.csv"), options()));
    }

    /** {@code text}, then the two bytes of a CP949 character, then {@code more}. */
    private static Ledger readWithBadBytes(String text, String more) {
        ByteArrayOutputStream file = new ByteArrayOutputStream();
        byte[] before = text.getBytes(StandardCharsets.UTF_8);
        byte[] after = more.getBytes(StandardCharsets.UTF_8);
        file.write(before, 0, before.length);
        file.write(0xb0);
        file.write(0xa1);
        file.write(after, 0, after.length);
        return CsvLedger.read(new ByteArrayInputStream(file.toByteArray()), options());
    }

    static void testAFileThatIsNotUtf8IsRefusedAsSuchNotDecodedIntoOtherIdentifiers() {
        String head = "account_id,asset,balance\nu1,BTC,-1\n";
        Ledger ledger = readWithBadBytes(head, ",BTC,1\nu3,BTC,\"x\"y\n");
        // Not the negative amount on line 2, not the syntax error on line 4: a block that is not UTF-8 is not text to act on.
        Check.equal("0:file_encoding", problems(ledger), "one problem");
        Check.isTrue(ledger.report().problems().get(0).message().contains("near byte " + head.length()), ledger.report().problems().get(0).message());
        Check.equal(0, ledger.report().accounts(), "nothing in the block was interpreted");
        Check.equal((long) head.length() + 2 + 19, ledger.report().fileBytes(), "but the whole file was hashed");
        Check.equal("0:file_encoding", problems(readWithBadBytes("account_id,asset,balance\nu1,BTC,\"x\"y\n", "\n")), "a syntax error in the same block does not hide it");

        byte[] whole = "account_id,asset,balance\nu1,BTC,-1\n가".getBytes(StandardCharsets.UTF_8);
        byte[] truncated = Arrays.copyOf(whole, whole.length - 1);
        Check.equal("2:amount_negative 0:file_encoding", problems(CsvLedger.read(new ByteArrayInputStream(truncated), options())),
                "a character cut off by the end of the file is found after everything before it was read");
        byte[] overlong = { 'a', (byte) 0xc0, (byte) 0xaf };
        Check.equal("0:file_encoding", problems(CsvLedger.read(new ByteArrayInputStream(overlong), options())), "an overlong encoding");
        byte[] surrogate = { 'a', (byte) 0xed, (byte) 0xa0, (byte) 0x80 };
        Check.equal("0:file_encoding", problems(CsvLedger.read(new ByteArrayInputStream(surrogate), options())), "an encoded surrogate");
    }

    static void testWhatIsReportedBesideAnEncodingErrorGoesByTheReferencesBlocks() {
        // The reference decodes the file in blocks of 65,536 bytes: problems from the blocks before the bad one are
        // kept, and after a syntax error nothing further is decoded at all. The same here, so both SDKs say the
        // same about the same file. In both files below the bad bytes come after a whole first block of good text.
        StringBuilder firstBlock = new StringBuilder("account_id,asset,balance\nu1,BTC,-1\n");
        for (int i = 0; firstBlock.length() < 65536; i++) {
            firstBlock.append("filler-").append(i).append(",BTC,1\n");
        }
        Check.equal("2:amount_negative 0:file_encoding", problems(readWithBadBytes(firstBlock.toString(), ",BTC,1\n")),
                "the problem of an earlier block is kept");
        String syntaxFirst = firstBlock.toString().replace("u1,BTC,-1", "u1,BTC,\"1\"x");
        Check.equal("2:csv_syntax", problems(readWithBadBytes(syntaxFirst, ",BTC,1\n")), "after a syntax error the rest is not examined");
    }

    static void testALargeFileIsStreamedAndCharactersSplitByTheBufferSurvive() throws Exception {
        // 40,000 accounts with three-byte characters in every identifier: about 1.3 MB, so the 64 KiB buffer boundary
        // falls inside a character many times over.
        StringBuilder text = new StringBuilder("account_id,asset,balance\n");
        for (int i = 0; i < 40000; i++) {
            text.append("계정-").append(i).append(",BTC,0.5\n");
        }
        byte[] bytes = text.toString().getBytes(StandardCharsets.UTF_8);
        Path file = TestMain.newDirectory("csv").resolve("large.csv");
        Files.write(file, bytes);
        Ledger ledger = CsvLedger.read(file, options());
        Check.isTrue(ledger.ok(), problems(ledger));
        Check.equal(40000, ledger.rows().size(), "accounts");
        Check.equal("계정-39999", ledger.rows().get(39999).userRef(), "the last identifier, intact");
        Check.equal("2000000000000", ledger.report().totals().get("BTC").toString(), "the total");
        Check.equal(Hex.encode(Hex.sha256().digest(bytes)), ledger.report().fileSha256(), "the checksum is the file's");
        Check.equal((long) bytes.length, ledger.report().fileBytes(), "and so is the size");
    }

    // ── the header ──────────────────────────────────────────────────────────

    static void testHeaderRulesInTheSpecificationsOrder() {
        Check.equal("1:header_empty_name", problems(read("account_id,,asset,asset\nu1,x,BTC,1\n", options())), "the first failure in column order");
        Check.equal("1:header_duplicate", problems(read("account_id,Asset,asset,\nu1,x,BTC,1\n", options())), "ignoring case");
        Check.equal("1:header_no_account", problems(read("user,asset,balance\nu1,BTC,1\n", options())), "no account column");
        Check.equal("1:header_unrecognised", problems(read("account_id,currency,amount\nu1,BTC,1\n", options())), "neither layout");
        Check.equal("1:header_missing_column", problems(read("account_id,asset,amount\nu1,BTC,1\n", options())), "long, but no balance column");
        Check.equal("1:header_missing_column", problems(read("account_id,BTC\nu1,1\n", options().layout(CsvLayout.LONG))), "long was stated");
        Check.equal("1:header_unknown_column 1:header_missing_asset 1:header_missing_asset",
                problems(read("account_id,asset,BTC\nu1,x,1\n", options())), "an asset-like column makes it wide when long is incomplete");
        Ledger mapped = read("  USER_ID , Currency,AMOUNT,updated_at\nu1,BTC,1,2026-11-16\n",
                options().accountColumn("user_id").assetColumn("currency").balanceColumn("amount"));
        Check.isTrue(mapped.ok(), problems(mapped));
        Check.equal(Arrays.asList("updated_at"), mapped.report().ignoredColumns(), "in the long layout an extra column cannot hide a balance");
        Check.equal(CsvLayout.LONG, mapped.report().layout(), "layout");
        Check.refuses("invalid_option", () -> read("a,b\n", options().accountColumn("x").assetColumn("X")));
    }

    static void testWideHeaderEveryColumnIsAnAssetOrNamedAsIgnorable() {
        Check.equal("1:header_unknown_column", problems(read("account_id,BTC,ETH,USDT,DOGE\nu1,1,1,1,5\n", options())), "an unknown column might be an asset");
        Check.isTrue(read("account_id,BTC,ETH,USDT,Memo\nu1,1,1,1,x\n", options().ignoreColumns(Arrays.asList("MEMO"))).ok(), "named, it is read past");
        Check.equal("1:header_missing_asset", problems(read("account_id,BTC,ETH\nu1,1,1\n", options())), "a declared asset with no column would count as zero");
        Ledger twin = read("account_id,btc,ETH,USDT\nu1,1,1,1\n", options());
        Check.equal("1:header_unknown_column", problems(twin), "letter case is not folded, and the asset is reported once, not twice");
        Check.isTrue(twin.report().problems().get(0).message().contains("only by letter case"), "the message says what is the matter");
        // The lower-case twin is on the ignore list, so it was not reported as an unknown column — and then the
        // declared asset has no column, which the specification makes a problem. (The reference lets this through
        // and the snapshot would show a total of zero for BTC.)
        Check.equal("1:header_missing_asset", problems(read("account_id,btc,ETH,USDT\nu1,1,1,1\n", options().ignoreColumns(Arrays.asList("btc")))),
                "an ignored column does not stand in for a declared asset");
        Ledger reordered = read("USDT,account_id,ETH,BTC\n2,u1,,1\n", options());
        Check.isTrue(reordered.ok(), problems(reordered));
        Check.equal("{USDT=2000000, ETH=0, BTC=100000000}", reordered.rows().get(0).balances().toString(), "values in the order the columns gave them");
        Check.equal(CsvLayout.WIDE, reordered.report().layout(), "layout");
    }

    // ── the rows ────────────────────────────────────────────────────────────

    static void testNothingThatCouldChangeATotalIsDecidedSilently() {
        Ledger undeclared = read("account_id,asset,balance\nu1,DOGE,5\n", options());
        Check.equal("2:unknown_asset", problems(undeclared), "an asset nobody declared is an error, not a dropped row");
        Check.isTrue(undeclared.report().problems().get(0).message().contains("left out of the totals"), "and the message says why");
        Check.isTrue(read("account_id,asset,balance\nu1,btc,5\n", options()).report().problems().get(0).message().contains("only by letter case"), "case");
        Check.equal("4:duplicate_row", problems(read("account_id,asset,balance\nu1,BTC,1\nu1,ETH,1\nu1,BTC,2\n", options())), "a second row is an error, not a sum");
        Check.equal("2:amount_negative 3:duplicate_row", problems(read("account_id,asset,balance\nu1,BTC,-1\nu1,BTC,2\n", options())),
                "a refused amount still counts as that account's row for the asset");
        Check.equal("3:duplicate_account", problems(read("account_id,BTC,ETH,USDT\nu1,1,1,1\nu1,2,2,2\n", options())), "wide: the same account twice");
        Check.equal("2:amount_negative 2:amount_exponent", problems(read("account_id,BTC,ETH,USDT\nu1,-1,1e3,\nu1,2,2,2\n", options())),
                "wide: every refused cell is reported, and a refused row is not that account's row");
        Check.equal("2:field_count 3:field_count", problems(read("account_id,asset,balance\nu1,BTC\nu2,BTC,1,x\n", options())), "field count");
        Check.isTrue(read("account_id,asset,balance\nu1, BTC ,1\n", options()).ok(), "the asset cell is trimmed");
    }

    static void testAccountIdentifiersAreUsedByteForByte() {
        Ledger quoted = read("account_id,asset,balance\n\"kim, 민수\",BTC,1\n", options());
        Check.equal("kim, 민수", quoted.rows().get(0).userRef(), "the field as written");
        Check.equal("2:account_whitespace", problems(read("account_id,asset,balance\n\u00a0u1,BTC,1\n", options())), "a no-break space is whitespace");
        Check.equal("2:account_whitespace", problems(read("account_id,asset,balance\n\"u1\t\",BTC,1\n", options())), "a trailing tab is whitespace before it is a control character");
        Check.equal("2:account_control_character", problems(read("account_id,asset,balance\n\"a\nb\",BTC,1\n", options())), "a line break inside");
        Check.equal("2:account_control_character", problems(read("account_id,asset,balance\na\u007fb,BTC,1\n", options())), "DEL");
        Check.isTrue(read("account_id,asset,balance\na\u200bb,BTC,1\n", options()).ok(), "U+200B is neither whitespace nor a control character here");
        Check.isTrue(read("account_id,asset,balance\n" + "가".repeat(85) + "x,BTC,1\n", options()).ok(), "256 bytes of UTF-8 are allowed");
        Check.equal("2:account_too_long", problems(read("account_id,asset,balance\n" + "가".repeat(85) + "xy,BTC,1\n", options())), "257 are not");
        Check.equal("2:account_empty", problems(read("account_id,asset,balance\n,BTC,1\n", options())), "empty");
    }

    static void testProblemsAreAllCountedAndTheFirstOnesKept() {
        StringBuilder text = new StringBuilder("account_id,asset,balance\n");
        for (int i = 0; i < 120; i++) {
            text.append("u").append(i).append(",BTC,-1\n");
        }
        Ledger byDefault = read(text.toString(), options());
        Check.equal(50, byDefault.report().problems().size(), "kept by default");
        Check.equal(120L, byDefault.report().problemCount(), "counted");
        Check.equal(120L, byDefault.report().rows(), "rows read");
        Check.isTrue(byDefault.rows().isEmpty(), "never a tree from the rows that happened to parse");
        Check.equal(5, read(text.toString(), options().maxProblems(5)).report().problems().size(), "a stated limit");
    }

    static void testTheReportAddsUpWhatWasRead() {
        Ledger ledger = read("account_id,asset,balance\nu1,BTC,0.5\nu1,ETH,2\nu2,USDT,10.25\nu3,BTC,0\n", options());
        LedgerReport r = ledger.report();
        Check.isTrue(r.ok(), problems(ledger));
        Check.equal(4L, r.rows(), "rows");
        Check.equal(3, r.accounts(), "accounts");
        Check.equal(1, r.zeroBalanceAccounts(), "an account with only zeros is still an account");
        Check.equal("{BTC=50000000, ETH=2000000000000000000, USDT=10250000}", r.totals().toString(), "totals");
        Check.equal("{BTC=1, ETH=1, USDT=1}", r.holders().toString(), "holders");
        Check.equal("[]", r.assetsWithoutBalance().toString(), "every asset is held");
        Check.equal("{BTC=0}", ledger.rows().get(2).balances().toString(), "the balances a row was given, zero included");
        Check.equal("[ETH, USDT]", read("account_id,asset,balance\nu1,BTC,5\n", new CsvOptions(Sample.assets(), AmountUnit.BASE))
                .report().assetsWithoutBalance().toString(), "assets nobody holds are pointed out");
    }
}
