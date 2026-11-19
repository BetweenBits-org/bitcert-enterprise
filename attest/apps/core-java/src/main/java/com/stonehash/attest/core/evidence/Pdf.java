package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * A PDF of text and nothing else: paragraphs, labels, monospaced digests, a
 * hairline rule, a footer on every page.
 *
 * <p>PDF 1.4 with three of the standard fonts, which every reader has and no
 * file has to carry. Those fonts are single-byte and cover Latin-1, so
 * <b>the printed summary is English</b>: common typographic punctuation is
 * written as its ASCII equivalent and any other character outside Latin-1 as
 * {@code ?} — a visible placeholder rather than a word silently missing. The
 * JSON members of the same archive carry every text in full, in whatever
 * script it was supplied.
 *
 * <p>No clock: the creation date is the caller's, so the same evidence
 * exported twice is the same file. And the same file as the service this one
 * replaces wrote, byte for byte — line breaks are decided by the same
 * character widths and the same arithmetic, in the same order.
 */
public final class Pdf {
    private Pdf() {
    }

    public static final String HELVETICA = "Helvetica";
    public static final String HELVETICA_BOLD = "Helvetica-Bold";
    public static final String COURIER = "Courier";

    /** One paragraph: its text, and how it is set. */
    public static final class Run {
        /** Text — or whatever the evidence holds where text was meant; see {@link Pdf#toLatin1}. */
        final Object text;
        final String font;
        final double size;
        /** Extra space above the first line, in points. */
        final double spaceBefore;
        /** A hairline rule under the last line. */
        final boolean rule;
        /** From the left margin, in points. */
        final double indent;

        public Run(Object text, String font, double size, double spaceBefore, boolean rule, double indent) {
            this.text = text;
            this.font = font;
            this.size = size;
            this.spaceBefore = spaceBefore;
            this.rule = rule;
            this.indent = indent;
        }
    }

    // A4, in points.
    private static final double PAGE_WIDTH = 595.28;
    private static final double PAGE_HEIGHT = 841.89;
    private static final double MARGIN_LEFT = 56;
    private static final double MARGIN_RIGHT = 56;
    private static final double MARGIN_TOP = 64;
    private static final double MARGIN_BOTTOM = 64;
    private static final double LEADING = 1.45;

    /** Widths per 1000 units for the part of Helvetica a report uses, for deciding where a line breaks. */
    private static final Map<Integer, Integer> HELVETICA_WIDTH = new HashMap<>();

    static {
        String[] symbols = { "  278", "! 278", "\" 355", "# 556", "$ 556", "% 889", "& 667", "' 191", "( 333", ") 333", "* 389", "+ 584", ", 278", "- 333", ". 278", "/ 278",
                ": 278", "; 278", "< 584", "= 584", "> 584", "? 556", "@ 1015", "[ 278", "\\ 278", "] 278", "^ 469", "_ 556", "` 333", "{ 334", "| 260", "} 334", "~ 584" };
        for (String s : symbols) {
            HELVETICA_WIDTH.put((int) s.charAt(0), Integer.parseInt(s.substring(2)));
        }
        for (char c = '0'; c <= '9'; c++) {
            HELVETICA_WIDTH.put((int) c, 556);
        }
        for (char c = 'A'; c <= 'Z'; c++) {
            HELVETICA_WIDTH.put((int) c, c == 'I' || c == 'J' ? 278 : c == 'M' || c == 'W' ? 889 : 667);
        }
        for (char c = 'a'; c <= 'z'; c++) {
            HELVETICA_WIDTH.put((int) c, c == 'i' || c == 'j' || c == 'l' || c == 't' ? 250 : c == 'm' || c == 'w' ? 833 : 556);
        }
    }

    /** Approximate width in points. Courier is fixed-pitch, 600 per 1000; bold is taken as 6% wider. */
    private static double textWidth(String s, String font, double size) {
        if (font.equals(COURIER)) {
            return ((double) s.length() * 600 * size) / 1000;
        }
        double w = 0;
        for (int i = 0; i < s.length();) {
            int cp = s.codePointAt(i);
            Integer known = HELVETICA_WIDTH.get(cp);
            w += known != null ? known : 556;
            i += Character.charCount(cp);
        }
        return (w * size * (font.equals(HELVETICA_BOLD) ? 1.06 : 1)) / 1000;
    }

    /** Typographic punctuation and its ASCII equivalent. */
    private static final Map<String, String> ASCII = new HashMap<>();

    static {
        String[][] pairs = { { "‘", "'" }, { "’", "'" }, { "“", "\"" }, { "”", "\"" }, { "–", "-" }, { "—", "--" }, { "…", "..." },
                { " ", " " }, { "→", "->" }, { "←", "<-" }, { "↑", "^" }, { "↓", "v" }, { "✓", "OK" }, { "✗", "X" }, { "·", "-" },
                { "•", "*" }, { "①", "(1)" }, { "②", "(2)" }, { "③", "(3)" }, { "④", "(4)" }, { "⑤", "(5)" }, { "⑥", "(6)" } };
        for (String[] p : pairs) {
            ASCII.put(p[0], p[1]);
        }
    }

    /**
     * Text reduced to what a standard PDF font can render: mapped
     * punctuation as ASCII, anything else outside Latin-1 as {@code ?}.
     *
     * <p>Evidence is a document someone else wrote, and where text was meant
     * it may hold something else. A list was always read item by item — an
     * item that is one of the mapped characters is mapped; any other has to
     * be text, and is kept whole when its first character is Latin-1 and
     * written {@code ?} otherwise. Nothing else can be read as text
     * ({@link JsValues.EngineError}).
     */
    public static String toLatin1(Object text) {
        StringBuilder out = new StringBuilder();
        if (text instanceof String) {
            String s = (String) text;
            for (int i = 0; i < s.length();) {
                int cp = s.codePointAt(i);
                int n = Character.charCount(cp);
                String ch = s.substring(i, i + n);
                String mapped = ASCII.get(ch);
                out.append(mapped != null ? mapped : cp <= 0xff ? ch : "?");
                i += n;
            }
        } else if (text instanceof List) {
            for (Object item : (List<?>) text) {
                String mapped = ASCII.get(JsValues.string(item));
                if (mapped != null) {
                    out.append(mapped);
                } else if (item instanceof String) {
                    String s = (String) item;
                    out.append(!s.isEmpty() && s.codePointAt(0) <= 0xff ? s : "?");
                } else {
                    throw new JsValues.EngineError("an item of a list given as text is not text");
                }
            }
        } else {
            throw new JsValues.EngineError("a value given as text cannot be read character by character");
        }
        return out.toString();
    }

    /** A PDF literal string's three escapes. */
    private static String literal(String s) {
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)");
    }

    /** White space as the previous runtime's {@code \s} counts it. */
    private static final Pattern SPACES = Pattern.compile("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+");

    /** One paragraph as the lines it takes at this width. A token longer than a line — a digest — is cut by the character. */
    private static List<String> wrap(Run run, double width) {
        String text = toLatin1(run.text);
        List<String> out = new ArrayList<>();
        if (textWidth(text, run.font, run.size) <= width) {
            out.add(text);
            return out;
        }
        String line = "";
        for (String word : SPACES.split(text, -1)) {
            String next = line.isEmpty() ? word : line + " " + word;
            if (textWidth(next, run.font, run.size) <= width) {
                line = next;
                continue;
            }
            if (!line.isEmpty()) {
                out.add(line);
            }
            if (textWidth(word, run.font, run.size) > width) {
                String chunk = "";
                for (int i = 0; i < word.length();) {
                    int n = Character.charCount(word.codePointAt(i));
                    String ch = word.substring(i, i + n);
                    if (textWidth(chunk + ch, run.font, run.size) > width) {
                        out.add(chunk);
                        chunk = ch;
                    } else {
                        chunk += ch;
                    }
                    i += n;
                }
                line = chunk;
            } else {
                line = word;
            }
        }
        if (!line.isEmpty()) {
            out.add(line);
        }
        return out;
    }

    private static final class Line {
        final String text;
        final String font;
        final double size;
        final double y;
        final double x;
        boolean rule;

        Line(String text, String font, double size, double y, double x) {
            this.text = text;
            this.font = font;
            this.size = size;
            this.y = y;
            this.x = x;
        }
    }

    /**
     * @param createdAtMs written as the creation date; supplied, never read from the clock
     * @param footer      at the foot of every page, before the page number; may be {@code null}
     */
    public static byte[] render(List<Run> runs, String title, long createdAtMs, String footer) {
        double contentWidth = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

        List<List<Line>> pages = new ArrayList<>();
        List<Line> page = new ArrayList<>();
        double y = PAGE_HEIGHT - MARGIN_TOP;
        for (Run run : runs) {
            y -= run.spaceBefore;
            for (String text : wrap(run, contentWidth - run.indent)) {
                if (y < MARGIN_BOTTOM + run.size) {
                    pages.add(page);
                    page = new ArrayList<>();
                    y = PAGE_HEIGHT - MARGIN_TOP;
                }
                y -= run.size * LEADING;
                page.add(new Line(text, run.font, run.size, y, MARGIN_LEFT + run.indent));
            }
            if (run.rule && !page.isEmpty()) {
                page.get(page.size() - 1).rule = true;
            }
        }
        pages.add(page);

        // Objects 1 to 3 are the fonts; the page contents, the pages, the page tree, the document information and the catalogue follow.
        List<String> objects = new ArrayList<>();
        objects.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        objects.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        objects.add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

        List<Integer> contentIds = new ArrayList<>();
        for (int i = 0; i < pages.size(); i++) {
            List<String> ops = new ArrayList<>();
            for (Line l : pages.get(i)) {
                ops.add("BT");
                ops.add("/F" + fontId(l.font) + " " + Js.numberToString(l.size) + " Tf");
                ops.add("1 0 0 1 " + fixed2(l.x) + " " + fixed2(l.y) + " Tm");
                ops.add("(" + literal(l.text) + ") Tj");
                ops.add("ET");
                if (l.rule) {
                    ops.add("0.85 0.85 0.85 RG 0.5 w");
                    ops.add(Js.numberToString(MARGIN_LEFT) + " " + fixed2(l.y - 5) + " m " + fixed2(PAGE_WIDTH - MARGIN_RIGHT) + " " + fixed2(l.y - 5) + " l S");
                }
            }
            String numbered = "page " + (i + 1) + " of " + pages.size();
            String foot = footer != null && !footer.isEmpty() ? toLatin1(footer) + "  ·  " + numbered : numbered;
            ops.add("BT");
            ops.add("/F1 7.5 Tf");
            ops.add("0.45 0.45 0.45 rg");
            ops.add("1 0 0 1 " + Js.numberToString(MARGIN_LEFT) + " " + fixed2(MARGIN_BOTTOM - 24) + " Tm");
            ops.add("(" + literal(toLatin1(foot)) + ") Tj");
            ops.add("ET");
            ops.add("0 0 0 rg");
            String stream = String.join("\n", ops);
            // The length is counted as UTF-8 while the file is written one byte per character: for a stream with a
            // character between U+0080 and U+00FF in it the two differ. Kept as it was — readers find `endstream`.
            objects.add("<< /Length " + utf8Length(stream) + " >>\nstream\n" + stream + "\nendstream");
            contentIds.add(objects.size());
        }

        int pagesId = objects.size() + pages.size() + 1;
        List<String> kids = new ArrayList<>();
        for (int i = 0; i < pages.size(); i++) {
            objects.add("<< /Type /Page /Parent " + pagesId + " 0 R /MediaBox [0 0 " + Js.numberToString(PAGE_WIDTH) + " " + Js.numberToString(PAGE_HEIGHT) + "] "
                    + "/Resources << /Font << /F1 1 0 R /F2 2 0 R /F3 3 0 R >> >> /Contents " + contentIds.get(i) + " 0 R >>");
            kids.add(objects.size() + " 0 R");
        }
        objects.add("<< /Type /Pages /Kids [" + String.join(" ", kids) + "] /Count " + pages.size() + " >>");
        int realPagesId = objects.size();
        if (realPagesId != pagesId) {
            throw new IllegalStateException("pdf: page tree id drifted (" + realPagesId + " vs predicted " + pagesId + ")");
        }
        String iso = IsoTime.ofEpochMilli(createdAtMs);
        String d = "D:" + slice(iso, 0, 4) + slice(iso, 5, 7) + slice(iso, 8, 10) + slice(iso, 11, 13) + slice(iso, 14, 16) + slice(iso, 17, 19) + "Z";
        objects.add("<< /Title (" + literal(toLatin1(title)) + ") /Producer (StoneHash Attest) /Creator (StoneHash Attest) /CreationDate (" + d + ") /ModDate (" + d + ") >>");
        int infoId = objects.size();
        objects.add("<< /Type /Catalog /Pages " + realPagesId + " 0 R >>");
        int catalogId = objects.size();

        // Written out with a cross-reference table. One byte per character, so a length in characters is an offset in bytes.
        StringBuilder pdf = new StringBuilder("%PDF-1.4\n%âãÏÓ\n");
        List<Integer> offsets = new ArrayList<>();
        for (int i = 0; i < objects.size(); i++) {
            offsets.add(pdf.length());
            pdf.append(i + 1).append(" 0 obj\n").append(objects.get(i)).append("\nendobj\n");
        }
        int xref = pdf.length();
        pdf.append("xref\n0 ").append(objects.size() + 1).append("\n0000000000 65535 f \n");
        for (int off : offsets) {
            String digits = Integer.toString(off);
            pdf.append("0".repeat(Math.max(0, 10 - digits.length()))).append(digits).append(" 00000 n \n");
        }
        pdf.append("trailer\n<< /Size ").append(objects.size() + 1).append(" /Root ").append(catalogId).append(" 0 R /Info ").append(infoId).append(" 0 R >>\n")
                .append("startxref\n").append(xref).append("\n%%EOF\n");

        byte[] out = new byte[pdf.length()];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) (pdf.charAt(i) & 0xff);
        }
        return out;
    }

    private static int fontId(String font) {
        return font.equals(HELVETICA) ? 1 : font.equals(HELVETICA_BOLD) ? 2 : 3;
    }

    private static String slice(String s, int from, int to) {
        return s.substring(Math.min(from, s.length()), Math.min(to, s.length()));
    }

    /** A number with two decimals, rounded half up on its exact value. */
    private static String fixed2(double x) {
        if (x < 0) {
            return "-" + fixed2(-x);
        }
        return new BigDecimal(x).setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    /** The length of the text as UTF-8; half a surrogate pair standing alone counts as the three bytes of U+FFFD. */
    private static int utf8Length(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80) {
                n += 1;
            } else if (c < 0x800) {
                n += 2;
            } else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                n += 4;
                i++;
            } else {
                n += 3;
            }
        }
        return n;
    }
}
