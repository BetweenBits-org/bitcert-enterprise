package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Text;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * FIN MT103 (single customer credit transfer) → {@link SwiftPayment}.
 *
 * <p>Accepts the message as systems actually hand it over: the full five-block
 * form (<code>{1:…}{2:…}{3:…}{4:</code> … <code>-}{5:…}</code>), CRLF or LF, or the text
 * block alone (the lines from {@code :20:} on) when an exporter strips the
 * headers. A file may hold several messages one after another, as a batch
 * export writes them (optionally separated by {@code $}); each is read.
 *
 * <p>What makes a text an MT103 is checked, not assumed. With the header
 * blocks, block 2 names the type. Without them nothing does, so the text itself
 * has to be one: only fields an MT103 carries, each as often as an MT103
 * allows, and every mandatory one present. An MT102 or the cover of an MT103
 * (MT202 COV) shares most of its tags with an MT103; read as one, it would
 * become a payment of the wrong amount to the wrong party.
 *
 * <p>A field that is read has to carry a value: present but empty, or with a
 * second line under a field the standard writes on one, it refuses the
 * message — it is not read as absent, nor cut to its first line.
 *
 * <p>What is read, by field:
 * <pre>
 *   block 1 / 2   sender and receiver BIC, and that the type is 103
 *   block 3       121 → UETR
 *   20            sender's reference
 *   23B           bank operation code, kept — CRTS marks a test message
 *   71F / 71G     sender's and receiver's charges, kept as given
 *   32A           value date, currency, interbank settled amount
 *   33B           instructed currency and amount
 *   36            exchange rate
 *   50A / 50F / 50K   ordering customer
 *   52A / 52D     ordering institution
 *   56A / 56D     intermediary institution
 *   57A / 57C / 57D   account with institution
 *   59 / 59A / 59F    beneficiary customer
 *   70            remittance information (/INV/ invoice references, /ROC/ the
 *                 ordering customer's reference)
 *   71A           details of charges → ISO charge bearer
 *   26T / 77B     transaction type and regulatory reporting, kept as given;
 *                 /ORDERRES/CC and /BENEFRES/CC in 77B give the parties'
 *                 countries of residence
 * </pre>
 *
 * <p>A free-format party (50K, 59) is "name and address" with no markers: the
 * first line is taken as the name and the rest as address lines. That is the
 * convention, not a guarantee — which is why the mapping layer accepts
 * corrections for it.
 *
 * <p>A port of the TypeScript SDK's {@code swift/mt103.ts}, function by
 * function and check by check: the same bytes give the same payments and the
 * same refusals, in the same order. Every text operation goes through
 * {@link Js}, with the reference's meaning.
 */
final class Mt103Reader {
    private Mt103Reader() {
    }

    private static final Pattern LOOKS_LIKE_MT =
            Pattern.compile("^\\uFEFF?" + Js.WS + "*\\{1:|^\\uFEFF?" + Js.WS + "*:20:|^\\uFEFF?" + Js.WS + "*\\{4:" + Js.WS + "*:20:");

    /** Does this text look like a FIN message (blocks, or a bare text block)? */
    static boolean looksLikeMt(String text) {
        return LOOKS_LIKE_MT.matcher(text).find();
    }

    /** The blocks of one message. A block the message does not have is null. */
    private static final class Blocks {
        String b1;
        String b2;
        String b3;
        String b4;
    }

    private static SwiftMessageException malformed(String message, String field) {
        return new SwiftMessageException("malformed_message", message, field);
    }

    /** A block whose content is balanced braces (1, 2, 3, 5, S): where it ends. */
    private static int closeOf(String text, int open, String id) {
        int depth = 0;
        for (int j = open; j < text.length(); j++) {
            char c = text.charAt(j);
            if (c == '{') {
                depth++;
            } else if (c == '}') {
                depth--;
                if (depth == 0) {
                    return j;
                }
            }
        }
        throw malformed("block " + id + " is not closed", "block " + id);
    }

    /**
     * Trailer blocks that may follow the text block: {@code {5:…}}, {@code {S:…}}.
     * The length of what the reference's <code>/^(?:\s|\{[5S]:(?:[^{}]|\{[^{}]*\})*\})*&#47;</code>
     * matches at {@code from}: whitespace and whole trailer blocks, each with
     * brace-free sub-blocks, up to the first thing that is neither.
     *
     * <p>Written out as a scan rather than as that pattern: Java's regular
     * expressions recurse once per repetition of a group with alternatives,
     * and a few thousand spaces after a message overflow the stack — where the
     * reference reads a file padded with megabytes of them. The pattern ends
     * with its repetition, so its first match takes each whitespace character
     * and each complete block in turn and stops at the first position where
     * neither begins; that is what this does.
     */
    private static int trailers(String text, int from) {
        int i = from;
        for (;;) {
            if (i < text.length() && isSpace(text.charAt(i))) {
                i++;
                continue;
            }
            int end = trailerBlockEnd(text, i);
            if (end < 0) {
                return i - from;
            }
            i = end;
        }
    }

    /** {@code \{[5S]:(?:[^{}]|\{[^{}]*\})*\}} at {@code i}: the index just past it, or -1 when it does not match there. */
    private static int trailerBlockEnd(String text, int i) {
        if (i + 3 > text.length() || text.charAt(i) != '{' || (text.charAt(i + 1) != '5' && text.charAt(i + 1) != 'S')
                || text.charAt(i + 2) != ':') {
            return -1;
        }
        int k = i + 3;
        while (k < text.length()) {
            char c = text.charAt(k);
            if (c == '}') {
                return k + 1;
            }
            if (c == '{') {
                // A sub-block, with no braces inside.
                int j = k + 1;
                while (j < text.length() && text.charAt(j) != '{' && text.charAt(j) != '}') {
                    j++;
                }
                if (j == text.length() || text.charAt(j) == '{') {
                    return -1;
                }
                k = j + 1;
                continue;
            }
            k++;
        }
        return -1;
    }

    /** {@code /\s/.test(c)}: the reference's whitespace. */
    private static boolean isSpace(char c) {
        return Text.isWhitespace(c);
    }

    private static final Pattern WRAPPED_TEXT_BLOCK = Pattern.compile("^\\{4:[ \\t]*\\n");
    private static final Pattern END_OF_TEXT = Pattern.compile("^-\\}?");

    /** The text block alone, as an exporter that strips the headers writes it. */
    private static Blocks bareText(String text) {
        // The text block may come inside its own wrapper and nothing else: `{4:` … `-}`.
        List<String> lines = Js.split(Js.replaceFirst(Js.trim(text), WRAPPED_TEXT_BLOCK, ""), "\n");
        // The end-of-text marker, when the exporter kept it. Nothing but trailer
        // blocks may follow: more text there is a second message, or a field cut off
        // from the first — either way not something to read past.
        int end = -1;
        for (int k = 0; k < lines.size(); k++) {
            String l = lines.get(k);
            if (l.startsWith("-}") || l.equals("-")) {
                end = k;
                break;
            }
        }
        Blocks out = new Blocks();
        if (end == -1) {
            out.b4 = String.join("\n", lines);
            return out;
        }
        List<String> after = new ArrayList<>();
        after.add(Js.replaceFirst(lines.get(end), END_OF_TEXT, ""));
        after.addAll(from(lines, end + 1));
        String rest = String.join("\n", after);
        if (!onlySpaceOrDollar(rest, trailers(rest, 0))) {
            throw malformed("there is text after the end-of-text marker (\"-}\") — a file of several messages needs each one's "
                    + "header blocks ({1:…}{2:…}), so that it is clear where one ends and what each is", "block 4");
        }
        out.b4 = String.join("\n", lines.subList(0, end));
        return out;
    }

    /** {@code text.slice(from).replace(/[\s$]/g, '') === ''}. */
    private static boolean onlySpaceOrDollar(String text, int from) {
        for (int k = from; k < text.length(); k++) {
            char c = text.charAt(k);
            if (!isSpace(c) && c != '$') {
                return false;
            }
        }
        return true;
    }

    private static final Pattern LEADING_BOM = Pattern.compile("^\\uFEFF");
    private static final Pattern LINE_END = Pattern.compile("\\r\\n?");
    private static final Pattern STARTS_WITH_BLOCK_1 = Pattern.compile("^" + Js.WS + "*\\{1:");
    private static final Pattern HEADER_BLOCK = Pattern.compile("^\\{([1-3]):");
    private static final Pattern LEADING_LINE_FEED = Pattern.compile("^\\n");

    /**
     * Split a file into its FIN messages, and each message into its blocks —
     * without tripping on braces inside block 3, and without reading past the
     * end of one message into the next.
     */
    private static List<Blocks> splitMessages(String raw) {
        String text = Js.replaceAll(Js.replaceFirst(raw, LEADING_BOM, ""), LINE_END, "\n");
        if (!Js.test(STARTS_WITH_BLOCK_1, text)) {
            return Collections.singletonList(bareText(text));
        }

        List<Blocks> out = new ArrayList<>();
        int i = skip(text, 0, false);
        while (i < text.length()) {
            int n = out.size() + 1;
            if (!text.startsWith("{1:", i)) {
                throw malformed("after message " + (n - 1) + " there is text that is not another message: "
                        + "\"" + Js.collapse(Js.slice(text, i, i + 24)) + "\" — a message starts with {1:", "block 4");
            }
            Blocks cur = new Blocks();
            for (String id : new String[] {"1", "2", "3"}) {
                i = skip(text, i, false);
                if (!text.startsWith("{" + id + ":", i)) {
                    continue;
                }
                int close = closeOf(text, i, id);
                String content = Js.slice(text, i + 3, close);
                if (id.equals("1")) {
                    cur.b1 = content;
                } else if (id.equals("2")) {
                    cur.b2 = content;
                } else {
                    cur.b3 = content;
                }
                i = close + 1;
            }
            i = skip(text, i, false);
            if (!text.startsWith("{4:", i)) {
                Matcher m = Js.exec(HEADER_BLOCK, Js.slice(text, i, i + 3));
                throw malformed(m != null ? "block " + m.group(1) + " appears twice or out of order" : "the message has no text block (block 4)",
                        m != null ? "block " + m.group(1) : "block 4");
            }
            int end = text.indexOf("\n-}", i);
            if (end == -1) {
                throw malformed("block 4 has no end-of-text marker (\"-}\") — the message is truncated", "block 4");
            }
            cur.b4 = Js.replaceFirst(Js.slice(text, i + 3, end), LEADING_LINE_FEED, "");
            i = end + 3;
            i += trailers(text, i);
            // A batch export separates messages with "$".
            i = skip(text, i, true);
            out.add(cur);
        }
        return out;
    }

    /** From {@code i}, past every whitespace character (and every {@code $} when {@code dollar}). */
    private static int skip(String text, int i, boolean dollar) {
        int k = i;
        while (k < text.length() && (isSpace(text.charAt(k)) || (dollar && text.charAt(k) == '$'))) {
            k++;
        }
        return k;
    }

    private static final Pattern BIC8 = Pattern.compile("^[A-Z0-9]{8}\\z");
    private static final Pattern BRANCH = Pattern.compile("^[A-Z0-9]{3}\\z");

    /** Logical-terminal address (12 chars) → BIC, 8 or 11 characters. */
    private static String bicFromLt(String lt) {
        if (!Js.truthy(lt) || lt.length() < 12) {
            return null;
        }
        String bic8 = Js.slice(lt, 0, 8);
        String branch = Js.slice(lt, 9, 12);
        if (!Js.test(BIC8, bic8)) {
            return null;
        }
        return branch.equals("XXX") || !Js.test(BRANCH, branch) ? bic8 : bic8 + branch;
    }

    /** One field of block 4: its tag, and its lines (the first is what follows the tag). */
    private static final class Field {
        final String tag;
        final List<String> lines = new ArrayList<>();

        Field(String tag, String first) {
            this.tag = tag;
            lines.add(first);
        }
    }

    /** Every field an MT103 may carry. */
    private static final Set<String> MT103_TAGS = new HashSet<>(Arrays.asList(
            "20", "13C", "23B", "23E", "26T", "32A", "33B", "36", "50A", "50F", "50K", "51A", "52A", "52D",
            "53A", "53B", "53D", "54A", "54B", "54D", "55A", "55B", "55D", "56A", "56C", "56D",
            "57A", "57B", "57C", "57D", "59", "59A", "59F", "70", "71A", "71F", "71G", "72", "77B", "77T"));
    /** The ones that may occur more than once. */
    private static final Set<String> REPEATABLE = new HashSet<>(Arrays.asList("13C", "23E", "71F"));
    /** Fields written with one of several letter options — one option, once. */
    private static final Set<String> OPTION_FIELDS = new HashSet<>(Arrays.asList("50", "52", "53", "54", "55", "56", "57", "59"));

    private static final Pattern FIELD_LINE = Pattern.compile("^:(\\d{2}[A-Z]?):(" + Js.DOT + "*)\\z");
    private static final Pattern INDENTED_TAG = Pattern.compile("^" + Js.WS + "+:\\d{2}[A-Za-z]?:");

    private static List<Field> fieldsOf(String b4) {
        List<Field> fields = new ArrayList<>();
        for (String line : Js.split(b4, "\n")) {
            Matcher m = Js.exec(FIELD_LINE, line);
            if (m != null) {
                fields.add(new Field(m.group(1), m.group(2)));
                continue;
            }
            // A line of text never starts with ":" in FIN. One that does is a tag
            // written wrongly — read as text, it would vanish into the field before it.
            if (line.startsWith(":")) {
                throw malformed("\"" + Js.slice(line, 0, 12) + "\" starts like a field tag but is not one — "
                        + "a tag is two digits and an optional capital letter, as in \":57A:\"", "block 4");
            }
            if (Js.test(INDENTED_TAG, line)) {
                throw malformed("\"" + Js.slice(Js.trim(line), 0, 8) + "\" is indented — a field tag starts its line", "block 4");
            }
            if (!fields.isEmpty()) {
                fields.get(fields.size() - 1).lines.add(line);
            } else if (!Js.blank(line)) {
                throw malformed("text before the first field: \"" + Js.slice(line, 0, 40) + "\"", "block 4");
            }
        }
        for (Field f : fields) {
            while (f.lines.size() > 1 && Js.blank(f.lines.get(f.lines.size() - 1))) {
                f.lines.remove(f.lines.size() - 1);
            }
        }
        return fields;
    }

    /**
     * Is this set of fields an MT103's? Every tag one an MT103 carries, none
     * more often than it may, every mandatory one there.
     *
     * <p>{@code declared} says block 2 named the type. When it did not, a tag
     * from another message type is the sign that this is not an MT103 at all.
     */
    private static void assertMt103Fields(List<Field> fields, boolean declared) {
        Map<String, String> seen = new HashMap<>();
        for (Field f : fields) {
            if (!MT103_TAGS.contains(f.tag)) {
                throw declared
                        ? malformed("field " + f.tag + " is not an MT103 field", f.tag)
                        : new SwiftMessageException("unsupported_message",
                                "field " + f.tag + " is not an MT103 field — this text is another message type, or not one message. "
                                        + "Without the header blocks nothing states the type; send the message with them ({1:…}{2:I103…})", f.tag);
            }
            if (REPEATABLE.contains(f.tag)) {
                continue;
            }
            String number = Js.slice(f.tag, 0, 2);
            String key = OPTION_FIELDS.contains(number) ? number : f.tag;
            String earlier = seen.get(key);
            if (earlier != null) {
                throw malformed(earlier.equals(f.tag)
                        ? "field " + f.tag + " occurs twice — it may occur once, and the two could not both be meant"
                        : "fields " + earlier + " and " + f.tag + " are both present — they are two forms of one field, and only one may be used", f.tag);
            }
            seen.put(key, f.tag);
        }
        String[][] mandatory = {
            {"20", "field 20 (sender's reference)"}, {"23B", "field 23B (bank operation code)"},
            {"32A", "field 32A (value date, currency, amount)"}, {"50", "field 50a (ordering customer)"},
            {"59", "field 59a (beneficiary customer)"}, {"71A", "field 71A (details of charges)"},
        };
        for (String[] entry : mandatory) {
            String key = entry[0];
            String label = entry[1];
            if (seen.containsKey(key)) {
                continue;
            }
            String tag = key.length() == 2 && OPTION_FIELDS.contains(key) ? key + "a" : key;
            throw new SwiftMessageException(declared || seen.containsKey("32A") ? "missing_field" : "not_a_swift_message",
                    label + " is missing — an MT103 always carries it" + (declared ? "" : "; the text may be cut short, or is not an MT103"), tag);
        }
    }

    /** The fields this reader takes a value from. */
    private static final Set<String> READ_TAGS = new HashSet<>(Arrays.asList(
            "20", "23B", "26T", "32A", "33B", "36", "50A", "50F", "50K", "52A", "52D", "56A", "56C", "56D",
            "57A", "57C", "57D", "59", "59A", "59F", "70", "71A", "71F", "71G", "77B"));
    /** The ones the standard writes on a single line. */
    private static final Set<String> ONE_LINE = new HashSet<>(Arrays.asList(
            "20", "23B", "26T", "32A", "33B", "36", "56C", "57C", "71A", "71F", "71G"));

    /**
     * A field the reader takes a value from carries one, and a field written on a
     * single line has no second. Read as it stands, an empty 71A was "no charges
     * code" and an empty 33B "no instructed amount"; a second line under 32A or
     * 71A was dropped, and with it a second amount or another charges code.
     *
     * <p>Field by field in the order of the message: first whether it is empty,
     * then whether a one-line field has a second line. Blank lines at the end of
     * a field were dropped by {@link #fieldsOf}; a blank line between does not
     * hide a later one.
     */
    private static void assertFieldShapes(List<Field> fields) {
        for (Field f : fields) {
            if (!READ_TAGS.contains(f.tag)) {
                continue;
            }
            boolean empty = true;
            for (String l : f.lines) {
                if (!Js.blank(l)) {
                    empty = false;
                    break;
                }
            }
            if (empty) {
                throw new SwiftMessageException("invalid_field",
                        "field " + f.tag + " is present but empty — write its value; an empty field is not read as one left out", f.tag);
            }
            if (!ONE_LINE.contains(f.tag)) {
                continue;
            }
            // `f.lines.slice(1).find((l) => l.trim() !== '')`: the first line after the first that says something.
            for (int k = 1; k < f.lines.size(); k++) {
                String second = f.lines.get(k);
                if (!Js.blank(second)) {
                    throw malformed("field " + f.tag + " takes one line, but \"" + Js.slice(Js.trim(second), 0, 35) + "\" follows it — "
                            + "a value cut in two, or a field whose tag was lost; correct the message", f.tag);
                }
            }
        }
    }

    /** Field 23B: what the standard allows, exactly as written. */
    private static final Set<String> BANK_OPERATION_CODES = new HashSet<>(Arrays.asList("CRED", "CRTS", "SPAY", "SPRI", "SSTD"));

    /** What {@link #takeAccount} gives: the account (null when none) and the lines after it. */
    private static final class Account {
        final String account;
        final List<String> rest;

        Account(String account, List<String> rest) {
            this.account = account;
            this.rest = rest;
        }
    }

    /**
     * {@code /account} on the first line of a customer field (50a, 59a), when
     * the option allows one: everything after the slash. The {@code /C/} and
     * {@code /D/} marks belong to the institution fields; here {@code /S/123}
     * is the account {@code S/123}, and {@code //CH123456} the account
     * {@code /CH123456}.
     *
     * <p>The first line is trimmed, as the structured and the institution fields
     * read theirs: with a space before the slash the account was taken for the
     * name, and the name for an address line.
     */
    private static Account takeAccount(List<String> lines) {
        String first = Js.trim(lines.isEmpty() ? "" : lines.get(0));
        if (first.startsWith("/")) {
            String account = Js.trim(Js.slice(first, 1));
            return new Account(Js.truthy(account) ? account : null, from(lines, 1));
        }
        return new Account(null, lines);
    }

    /** {@code lines.slice(k)}. */
    private static List<String> from(List<String> lines, int k) {
        return k >= lines.size() ? new ArrayList<>() : new ArrayList<>(lines.subList(k, lines.size()));
    }

    /** Each line trimmed, the empty ones left out. */
    private static List<String> clean(List<String> lines) {
        List<String> out = new ArrayList<>();
        for (String l : lines) {
            String t = Js.trim(l);
            if (!t.isEmpty()) {
                out.add(t);
            }
        }
        return out;
    }

    /** Options K (ordering customer) and no-letter 59: account, then name and address. */
    private static SwiftParty freeParty(List<String> lines) {
        Account taken = takeAccount(lines);
        List<String> body = clean(taken.rest);
        SwiftParty out = new SwiftParty();
        out.addressLines.addAll(from(body, 1));
        if (!body.isEmpty() && Js.truthy(body.get(0))) {
            out.name = body.get(0);
        }
        if (Js.truthy(taken.account)) {
            out.account = taken.account;
        }
        return out;
    }

    /** Option A: account, then a BIC. */
    private static SwiftParty bicParty(List<String> lines) {
        Account taken = takeAccount(lines);
        SwiftParty out = new SwiftParty();
        List<String> rest = clean(taken.rest);
        String bic = rest.isEmpty() ? null : rest.get(0);
        if (Js.truthy(bic)) {
            out.bic = bic;
        }
        if (Js.truthy(taken.account)) {
            out.account = taken.account;
        }
        return out;
    }

    /** Party-identifier codes that name a person's document, not a company's number. */
    private static final Set<String> PERSONAL_CODES = new HashSet<>(Arrays.asList("ARNU", "CCPT", "DRLC", "NIDN", "SOSE"));

    private static final Pattern PARTY_IDENTIFIER = Pattern.compile("^[A-Z]{4}/[A-Z]{2}/" + Js.DOT + "+");
    private static final Pattern NUMBERED_LINE = Pattern.compile("^([1-8])/(" + Js.DOT + "*)\\z");
    /**
     * The reference's {@code /^[A-Z]{2}(?:\/|$)/}: {@code $} there is the end of the
     * text, and Java's {@code $} would also match before a final U+0085 — which
     * a trim leaves in place.
     */
    private static final Pattern COUNTRY_LINE = Pattern.compile("^[A-Z]{2}(?:/|\\z)");

    /**
     * Option F: a party identifier line, then numbered lines —
     * 1/ name · 2/ address · 3/ country[/town] · 4/ birth date · 5/ birth place ·
     * 6/ customer id · 7/ national id · 8/ continuation of an identifier.
     * In 50F the first line is either {@code /account} or {@code code/country/identifier}.
     *
     * <p>Numbers 1, 2 and 3 may repeat. The first 3/ carries the country; a later
     * one continues the address (a postcode, a region) and must not be read as
     * another country. 8/ continues whichever identifier came before it — the
     * one of the first line included.
     *
     * <p>59F has only 1/, 2/ and 3/, and its first line is only ever
     * {@code /account}: a birth date, a place of birth and an identity number
     * describe the ordering customer, and read from 59F they would describe a
     * beneficiary the message does not.
     */
    private static SwiftParty structuredParty(List<String> lines, String tag) {
        SwiftParty out = new SwiftParty();
        List<String> body = lines;
        String first = Js.trim(lines.isEmpty() ? "" : lines.get(0));
        if (first.startsWith("/")) {
            String account = Js.trim(Js.slice(first, 1));
            if (Js.truthy(account)) {
                out.account = account;
            }
            body = from(lines, 1);
        } else if (tag.equals("50F") && Js.test(PARTY_IDENTIFIER, first)) {
            List<String> parts = Js.split(first, "/");
            String scheme = parts.get(0);
            out.identificationScheme = scheme;
            out.identification = String.join("/", from(parts, 2));
            out.identificationFrom = "field " + tag + " party identifier";
            if (PERSONAL_CODES.contains(scheme)) {
                out.person = Boolean.TRUE;
            }
            body = from(lines, 1);
        }
        int last = tag.equals("59F") ? 3 : 8;
        List<String> names = new ArrayList<>();
        boolean countryLine = false;
        // Which identifier an 8/ line would continue: the one read last.
        boolean continues = out.identification != null;
        for (String raw : clean(body)) {
            Matcher m = Js.exec(NUMBERED_LINE, raw);
            if (m == null) {
                throw new SwiftMessageException("invalid_field",
                        "field " + tag + ": \"" + Js.slice(raw, 0, 35) + "\" is not a numbered line (expected 1/ … " + last + "/)", tag);
            }
            String n = m.group(1);
            if (n.charAt(0) - '0' > last) {
                throw malformed("field " + tag + ": \"" + Js.slice(raw, 0, 35) + "\" is line " + n + "/, which " + tag + " does not have — "
                        + "its lines are 1/ (name), 2/ (address) and 3/ (country and town)", tag);
            }
            String v = Js.trim(m.group(2));
            // An empty line adds nothing: no blank part of the name, no blank address line.
            if (n.equals("1")) {
                if (Js.truthy(v)) {
                    names.add(v);
                }
            } else if (n.equals("2")) {
                if (Js.truthy(v)) {
                    out.addressLines.add(v);
                }
            } else if (n.equals("3")) {
                if (countryLine) {
                    if (Js.truthy(v)) {
                        out.addressLines.add(v);
                    }
                } else {
                    // The first 3/ states the country: its two-letter code, then "/" and the town.
                    if (!Js.test(COUNTRY_LINE, v)) {
                        throw new SwiftMessageException("invalid_field",
                                "field " + tag + ": line \"" + Js.slice(raw, 0, 35) + "\" does not start with a country code — the first 3/ line is "
                                        + "the two-letter ISO country code, then \"/\" and the town, as 3/SG/SINGAPORE", tag);
                    }
                    countryLine = true;
                    List<String> parts = Js.split(v, "/");
                    out.country = parts.get(0);
                    String t = Js.trim(String.join("/", from(parts, 1)));
                    if (Js.truthy(t)) {
                        out.addressLines.add(t);
                    }
                }
            } else if (n.equals("4") || n.equals("5")) {
                // A date or a place of birth: the party is a person.
                out.person = Boolean.TRUE;
            } else if (n.equals("6") || n.equals("7")) {
                if (n.equals("7")) {
                    out.person = Boolean.TRUE;
                }
                if (!Js.truthy(out.identification)) {
                    // 6/CC/issuer/number · 7/CC/number
                    List<String> parts = Js.split(v, "/");
                    String id = String.join("/", from(parts, n.equals("6") ? 2 : 1));
                    out.identification = Js.truthy(id) ? id : v;
                    out.identificationScheme = n.equals("6") ? "CUST" : "NIDN";
                    out.identificationFrom = "field " + tag + " line " + n + "/";
                    continues = true;
                } else {
                    continues = false;
                }
            } else if (n.equals("8") && continues && Js.truthy(out.identification)) {
                out.identification += v;
            }
        }
        if (!names.isEmpty()) {
            out.name = String.join(" ", names);
        }
        return out;
    }

    /** The credit or debit mark an institution field may put before its account: {@code /^[CD]\//}. */
    private static final Pattern CREDIT_DEBIT_MARK = Pattern.compile("^[CD]/");

    /** Options A / C / D of an institution field. */
    private static SwiftAgent institution(String tag, List<String> lines) {
        SwiftAgent out = new SwiftAgent();
        List<String> body = lines;
        // One reading of the first line: the branch and the value both come from it.
        String first = Js.trim(lines.isEmpty() ? "" : lines.get(0));
        if (first.startsWith("//")) {
            // A national clearing code leads the field: `//XXnnnn…`. `//` alone names none.
            String code = Js.trim(Js.slice(first, 2));
            if (Js.truthy(code)) {
                out.memberId = code;
            }
            body = from(lines, 1);
        } else if (first.startsWith("/")) {
            // `/account`, or `/C/account` / `/D/account` with the credit or debit mark
            // the institution fields allow; option C is a clearing code written this way.
            String account = Js.trim(Js.replaceFirst(Js.slice(first, 1), CREDIT_DEBIT_MARK, ""));
            if (tag.endsWith("C") && Js.truthy(account)) {
                out.memberId = account;
            }
            body = from(lines, 1);
        }
        List<String> text = clean(body);
        if (tag.endsWith("A")) {
            if (!text.isEmpty() && Js.truthy(text.get(0))) {
                out.bic = text.get(0);
            }
        } else if (tag.endsWith("D")) {
            if (!text.isEmpty() && Js.truthy(text.get(0))) {
                out.name = text.get(0);
            }
        }
        boolean any = out.bic != null || out.lei != null || out.name != null || out.memberId != null
                || out.clearingSystem != null || out.country != null;
        return any ? out : null;
    }

    /**
     * The coded words of MT field 70: invoice, international payment
     * instruction, reference for the beneficiary, the ordering customer's
     * reference, trade services utility. A reference ends at the next of these.
     * The list, and the reading of {@code /INV/} references, are the ISO 20022
     * reader's — one definition for both families, as in the reference.
     */
    private static final String REMITTANCE_CODES = Iso20022Reader.REMITTANCE_CODES;

    /** {@code s.replace(/\/$/, '')}. */
    private static String withoutTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    /**
     * A coded reference inside field 70: {@code /ROC/…}, {@code /RFB/…}. A code
     * word with nothing after it has no value, and does not take the code word
     * that follows for its own: the first occurrence that says something is
     * the reference.
     *
     * <p>The reference's {@code /\/ROC\/(.*?)(?=\/(?:INV|IPI|RFB|ROC|TSU)\/|\n|$)/gs},
     * every match in turn. Each match takes the five characters of its code
     * word, so the search always moves on, as the reference's {@code lastIndex}
     * does; {@code \z} is the reference's {@code $}, the end of the text.
     */
    private static String codedReference(String text, String code) {
        Matcher m = Pattern.compile("/" + code + "/(.*?)(?=/(?:" + REMITTANCE_CODES + ")/|\\n|\\z)", Pattern.DOTALL).matcher(text);
        while (m.find()) {
            // Several references under one code word are separated by "//": the first is the reference.
            String v = Js.trim(withoutTrailingSlash(Js.trim(Js.split(m.group(1), "//").get(0))));
            if (Js.truthy(v)) {
                return v;
            }
        }
        return null;
    }

    /**
     * A day of the calendar: month 1 to 12, day 1 to the month's last. The
     * reference asks {@code Date.UTC(year, month, 0)} for the month's last day;
     * both calendars are the proleptic Gregorian one, and the years 32A can
     * name (1980 to 2079) are the same in each.
     */
    private static boolean isCalendarDate(int year, int month, int day) {
        return month >= 1 && month <= 12 && day >= 1 && day <= YearMonth.of(year, month).lengthOfMonth();
    }

    /** Every MT103 in the text, in order. {@code index} counts across the whole text. */
    static List<SwiftPayment> parse(String raw, String digest) {
        List<Blocks> messages = splitMessages(raw);
        List<SwiftPayment> out = new ArrayList<>();
        for (int index = 0; index < messages.size(); index++) {
            try {
                SwiftPayment p = parseOne(messages.get(index), digest);
                p.index = index;
                p.transactionCount = messages.size();
                out.add(p);
            } catch (SwiftMessageException e) {
                if (messages.size() > 1) {
                    throw new SwiftMessageException(e.code(), "message " + (index + 1) + " of " + messages.size() + ": " + e.getMessage(), e.field());
                }
                throw e;
            }
        }
        return out;
    }

    private static final Pattern MESSAGE_TYPE = Pattern.compile("^[IO](\\d{3})");
    private static final Pattern F32A = Pattern.compile("^(\\d{2})(\\d{2})(\\d{2})([A-Z]{3})([\\d,]+)\\z");
    private static final Pattern F33B = Pattern.compile("^([A-Z]{3})([\\d,]+)\\z");
    private static final Pattern ORDERING_CUSTOMER = Pattern.compile("^50[AFK]\\z");
    private static final Pattern BENEFICIARY = Pattern.compile("^59[AF]?\\z");
    private static final Pattern ORDERING_INSTITUTION = Pattern.compile("^52[AD]\\z");
    private static final Pattern ACCOUNT_WITH_INSTITUTION = Pattern.compile("^57[ACD]\\z");
    private static final Pattern INTERMEDIARY = Pattern.compile("^56[ACD]\\z");
    private static final Pattern ORDERING_RESIDENCE = Pattern.compile("/ORDERRES/([A-Z]{2})(?![A-Za-z0-9_])");
    private static final Pattern BENEFICIARY_RESIDENCE = Pattern.compile("/BENEFRES/([A-Z]{2})(?![A-Za-z0-9_])");
    private static final Pattern UETR_FIELD = Pattern.compile("\\{121:([^}]*)\\}");
    private static final Pattern TRAINING_LT = Pattern.compile("^[A-Z0-9]{7}0");
    /** Field 36, {@code /^\d+,\d*$/}: {@code \z} for the reference's {@code $}, as everywhere here. */
    private static final Pattern RATE = Pattern.compile("^\\d+,\\d*\\z");

    private static List<Field> all(List<Field> fields, String tag) {
        List<Field> out = new ArrayList<>();
        for (Field f : fields) {
            if (f.tag.equals(tag)) {
                out.add(f);
            }
        }
        return out;
    }

    private static Field one(List<Field> fields, String tag) {
        List<Field> found = all(fields, tag);
        return found.isEmpty() ? null : found.get(0);
    }

    private static Field need(List<Field> fields, String tag) {
        Field f = one(fields, tag);
        if (f == null) {
            throw new SwiftMessageException("missing_field", "field " + tag + " is missing", tag);
        }
        return f;
    }

    /** {@code fields.find((f) => pattern.test(f.tag))}. */
    private static Field find(List<Field> fields, Pattern tag) {
        for (Field f : fields) {
            if (Js.test(tag, f.tag)) {
                return f;
            }
        }
        return null;
    }

    /** {@code one(tag)?.lines[0]?.trim()}: the first line of the first such field, trimmed, or null. */
    private static String firstLine(List<Field> fields, String tag) {
        Field f = one(fields, tag);
        return f == null || f.lines.isEmpty() ? null : Js.trim(f.lines.get(0));
    }

    private static SwiftPayment parseOne(Blocks blocks, String digest) {
        // Block 2 names the message type: I103… (input) or O103… (output).
        if (blocks.b2 != null) {
            Matcher m = Js.exec(MESSAGE_TYPE, blocks.b2);
            if (m == null) {
                throw new SwiftMessageException("malformed_message", "block 2 does not name a message type", "block 2");
            }
            if (!m.group(1).equals("103")) {
                throw new SwiftMessageException("unsupported_message",
                        "MT" + m.group(1) + " is not a customer credit transfer — this SDK reads MT103 (and pacs.008, pain.001)");
            }
        }

        List<Field> fields = fieldsOf(blocks.b4);
        assertMt103Fields(fields, blocks.b2 != null);
        assertFieldShapes(fields);

        // 32A — 6!n3!a15d
        String f32 = Js.trim(need(fields, "32A").lines.get(0));
        Matcher m32 = Js.exec(F32A, f32);
        if (m32 == null) {
            throw new SwiftMessageException("invalid_field", "field 32A: \"" + f32 + "\" is not date, currency and amount", "32A");
        }
        int yy = Integer.parseInt(m32.group(1));
        int year = yy < 80 ? 2000 + yy : 1900 + yy;
        // The value date is part of the payment's identity: 30 February is not a day it can name.
        if (!isCalendarDate(year, Integer.parseInt(m32.group(2)), Integer.parseInt(m32.group(3)))) {
            throw new SwiftMessageException("invalid_field", "field 32A: the value date \"" + Js.slice(f32, 0, 6) + "\" is not a calendar date — "
                    + "it is written YYMMDD, as 261117 for 17 November 2026", "32A");
        }
        String valueDate = year + "-" + m32.group(2) + "-" + m32.group(3);
        SwiftAmount settlementAmount = new SwiftAmount(SwiftText.assertCurrency(m32.group(4), "32A"), SwiftText.normaliseAmount(m32.group(5), "32A", true));

        // 33B — 3!a15d
        String f33 = firstLine(fields, "33B");
        SwiftAmount instructedAmount = null;
        if (Js.truthy(f33)) {
            Matcher m33 = Js.exec(F33B, f33);
            if (m33 == null) {
                throw new SwiftMessageException("invalid_field", "field 33B: \"" + f33 + "\" is not currency and amount", "33B");
            }
            instructedAmount = new SwiftAmount(SwiftText.assertCurrency(m33.group(1), "33B"), SwiftText.normaliseAmount(m33.group(2), "33B", true));
        }

        // Ordering customer — exactly one of 50A, 50F, 50K.
        Field f50 = find(fields, ORDERING_CUSTOMER);
        if (f50 == null) {
            throw new SwiftMessageException("missing_field", "field 50a (ordering customer) is missing", "50a");
        }
        SwiftParty debtor = f50.tag.equals("50A") ? bicParty(f50.lines)
                : f50.tag.equals("50F") ? structuredParty(f50.lines, "50F")
                : freeParty(f50.lines);

        // Beneficiary customer — 59, 59A or 59F.
        Field f59 = find(fields, BENEFICIARY);
        if (f59 == null) {
            throw new SwiftMessageException("missing_field", "field 59a (beneficiary customer) is missing", "59a");
        }
        SwiftParty creditor = f59.tag.equals("59A") ? bicParty(f59.lines)
                : f59.tag.equals("59F") ? structuredParty(f59.lines, "59F")
                : freeParty(f59.lines);

        // 77B — residence codes are the one structured statement of country in a free-format MT.
        List<String> regulatoryReporting = new ArrayList<>();
        for (Field f : all(fields, "77B")) {
            regulatoryReporting.add(String.join(" ", clean(f.lines)));
        }
        String reg = String.join(" ", regulatoryReporting);
        Matcher orderMatch = Js.exec(ORDERING_RESIDENCE, reg);
        String orderRes = orderMatch == null ? null : orderMatch.group(1);
        Matcher benefMatch = Js.exec(BENEFICIARY_RESIDENCE, reg);
        String benefRes = benefMatch == null ? null : benefMatch.group(1);
        if (!Js.truthy(debtor.country) && Js.truthy(orderRes)) {
            debtor.country = orderRes;
            debtor.countryFrom = "field 77B /ORDERRES/";
        }
        if (!Js.truthy(creditor.country) && Js.truthy(benefRes)) {
            creditor.country = benefRes;
            creditor.countryFrom = "field 77B /BENEFRES/";
        }

        // Input form (as sent): block 1 is the sender, block 2 names the receiver.
        // Output form (as delivered): block 1 is the receiver and the sender sits
        // in the message input reference inside block 2.
        String ownLt = bicFromLt(Js.truthy(blocks.b1) ? Js.slice(blocks.b1, 3, 15) : null);
        boolean output = blocks.b2 != null && blocks.b2.startsWith("O");
        String senderBic = output ? bicFromLt(Js.slice(blocks.b2, 14, 26)) : ownLt;
        String receiverBic = output ? ownLt : (Js.truthy(blocks.b2) ? bicFromLt(Js.slice(blocks.b2, 4, 16)) : null);

        Field f52 = find(fields, ORDERING_INSTITUTION);
        SwiftAgent debtorAgent = f52 != null ? institution(f52.tag, f52.lines) : null;
        if (debtorAgent == null && Js.truthy(senderBic)) {
            debtorAgent = new SwiftAgent();
            debtorAgent.bic = senderBic;
        }
        Field f57 = find(fields, ACCOUNT_WITH_INSTITUTION);
        SwiftAgent creditorAgent = f57 != null ? institution(f57.tag, f57.lines) : null;
        if (creditorAgent == null && Js.truthy(receiverBic)) {
            creditorAgent = new SwiftAgent();
            creditorAgent.bic = receiverBic;
        }
        List<SwiftAgent> intermediaries = new ArrayList<>();
        for (Field f : fields) {
            if (Js.test(INTERMEDIARY, f.tag)) {
                SwiftAgent a = institution(f.tag, f.lines);
                if (a != null) {
                    intermediaries.add(a);
                }
            }
        }

        Field f70 = one(fields, "70");
        List<String> remittanceText = f70 != null ? clean(f70.lines) : new ArrayList<>();
        // A coded line may continue on the next with a leading "//".
        StringBuilder joinedLines = new StringBuilder();
        for (String l : remittanceText) {
            joinedLines.append(l.startsWith("//") ? Js.slice(l, 2) : "\n" + l);
        }
        String joined = Js.trim(joinedLines.toString());
        List<String> invoices = Iso20022Reader.invoiceTokens(joined);
        // The ordering customer's own reference travels as /ROC/ — the field the
        // ISO 20022 translation carries as the end-to-end identification.
        String roc = codedReference(joined, "ROC");

        String charge = firstLine(fields, "71A");
        String chargeBearer = "OUR".equals(charge) ? "DEBT" : "BEN".equals(charge) ? "CRED" : "SHA".equals(charge) ? "SHAR" : null;
        if (Js.truthy(charge) && chargeBearer == null) {
            throw new SwiftMessageException("invalid_field", "field 71A: \"" + charge + "\" is not OUR, SHA or BEN", "71A");
        }

        String reference = Js.trim(need(fields, "20").lines.get(0));
        // Block 3 field 121: one UETR, or none. Two would be two identities for one payment.
        // (The reference collects every {121:…}; only whether there is a second one, and the
        // first, decide anything, so the search stops at the second.)
        List<String> f121 = new ArrayList<>();
        if (blocks.b3 != null) {
            Matcher m121 = UETR_FIELD.matcher(blocks.b3);
            while (f121.size() < 2 && m121.find()) {
                f121.add(m121.group(1));
            }
        }
        if (f121.size() > 1) {
            throw malformed("block 3 carries field 121 (the UETR) more than once — a payment has one UETR, "
                    + "and the two could not both be meant", "block 3 field 121");
        }
        String stated121 = f121.isEmpty() ? null : f121.get(0);
        if (stated121 != null && Js.blank(stated121)) {
            throw new SwiftMessageException("invalid_field", "block 3 field 121 (the UETR) is present but empty — write the UETR, "
                    + "or leave the field out; an empty field is not read as one left out", "block 3 field 121");
        }
        String uetr = SwiftText.uetrOf(stated121, "block 3 field 121");

        SwiftPayment p = new SwiftPayment();
        p.format = "MT103";
        p.messageType = "MT103";
        p.digest = digest;
        p.index = 0;
        p.transactionCount = 1;
        p.messageId = reference;
        p.instructionId = reference;
        p.valueDate = valueDate;
        p.amount = instructedAmount != null ? instructedAmount : settlementAmount;
        p.settlementAmount = settlementAmount;
        p.debtor = debtor;
        p.creditor = creditor;
        p.intermediaryAgents.addAll(intermediaries);
        p.remittanceInformation.addAll(remittanceText);
        p.invoiceReferences.addAll(invoices);
        for (Field f : all(fields, "71F")) {
            p.charges.add("sender's charges " + Js.trim(f.lines.isEmpty() ? "" : f.lines.get(0)));
        }
        for (Field f : all(fields, "71G")) {
            p.charges.add("receiver's charges " + Js.trim(f.lines.isEmpty() ? "" : f.lines.get(0)));
        }
        p.regulatoryReporting.addAll(regulatoryReporting);
        Set<String> present = new LinkedHashSet<>();
        for (Field f : fields) {
            present.add(f.tag);
        }
        p.present.addAll(present);

        String operation = firstLine(fields, "23B");
        // Written any other way, CRTS would not mark a test, and a test would go out as a payment.
        if (operation != null && !BANK_OPERATION_CODES.contains(operation)) {
            throw new SwiftMessageException("invalid_field", "field 23B: \"" + Js.slice(operation, 0, 35) + "\" is not a bank operation code — "
                    + "it is CRED, CRTS (a test message), SPAY, SPRI or SSTD, in capitals", "23B");
        }
        if (Js.truthy(operation)) {
            p.bankOperationCode = operation;
        }
        // A message that says of itself that it is a test: the bank operation code,
        // or a test and training BIC — "0" in the eighth position — in the header.
        String trainingLt = null;
        for (String lt : Arrays.asList(blocks.b1 == null ? null : Js.slice(blocks.b1, 3, 15),
                blocks.b2 == null ? null : output ? Js.slice(blocks.b2, 14, 26) : Js.slice(blocks.b2, 4, 16))) {
            if (lt != null && Js.test(TRAINING_LT, lt)) {
                trainingLt = lt;
                break;
            }
        }
        if ("CRTS".equals(operation)) {
            p.test = new SwiftPayment.TestMark("field 23B", "CRTS");
        } else if (Js.truthy(trainingLt)) {
            p.test = new SwiftPayment.TestMark("header blocks 1 and 2", "test and training BIC " + Js.slice(trainingLt, 0, 8));
        }
        if (instructedAmount != null) {
            p.instructedAmount = instructedAmount;
        }
        if (Js.truthy(uetr)) {
            p.uetr = uetr;
            p.present.add("121");
        }
        if (Js.truthy(roc)) {
            p.endToEndId = roc;
        }
        String rate = firstLine(fields, "36");
        if (rate != null) {
            // 12d: digits with one decimal comma, the comma counted in the twelve.
            if (!Js.test(RATE, rate) || rate.length() > 12) {
                throw new SwiftMessageException("invalid_field", "field 36: \"" + Js.slice(rate, 0, 35) + "\" is not an exchange rate — "
                        + "a rate is digits with one decimal comma, at most 12 characters, as 0,9125", "36");
            }
            // `rate.replace(',', '.').replace(/\.$/, '')`: the one comma becomes a full stop, and goes when it is last.
            int comma = rate.indexOf(',');
            String dotted = rate.substring(0, comma) + "." + rate.substring(comma + 1);
            p.exchangeRate = dotted.endsWith(".") ? dotted.substring(0, dotted.length() - 1) : dotted;
        }
        if (chargeBearer != null) {
            p.chargeBearer = chargeBearer;
        }
        if (debtorAgent != null) {
            p.debtorAgent = debtorAgent;
        }
        if (creditorAgent != null) {
            p.creditorAgent = creditorAgent;
        }
        String type = firstLine(fields, "26T");
        if (Js.truthy(type)) {
            p.purpose = type;
        }
        return p;
    }
}
