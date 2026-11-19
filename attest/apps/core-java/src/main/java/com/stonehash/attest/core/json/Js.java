package com.stonehash.attest.core.json;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON as JavaScript reads and writes it.
 *
 * <p>The service this one replaces was written in TypeScript, and what it
 * stored and what its clients rely on were produced by {@code JSON.parse} and
 * {@code JSON.stringify}: the hash that makes a request idempotent is the
 * SHA-256 of {@code JSON.stringify(body)}, a response is
 * {@code JSON.stringify(body, null, 2)}, and a number is printed the way
 * JavaScript prints a number. A general JSON library agrees with that most of
 * the time, which is not the same thing. So this class is those two functions
 * and nothing else, held to vectors written by Node
 * ({@code tools/make-js-vectors.mjs}).
 *
 * <p>Values: {@code null}, {@link Boolean}, {@link String}, a number
 * ({@link Double} out of {@link #parse}; {@link Integer} and {@link Long} are
 * also written), {@link List} and {@link Map} with {@code String} keys. A map
 * out of {@link #parse} lists its keys in the order JavaScript lists an
 * object's: array indices first, ascending, then the rest in the order they
 * were first written. {@link #UNDEFINED} stands for a value that is not
 * there: a property holding it is left out, an array element holding it is
 * written {@code null}.
 *
 * <p>This is not the canonical form (RFC 8785) that signatures and
 * commitments are made over. That is the SDK's {@code Json.canonical}, and
 * bytes that are signed never come from here.
 */
public final class Js {
    private Js() {
    }

    /** A value that is not there, where JavaScript has {@code undefined}. */
    public static final Object UNDEFINED = new Object() {
        @Override
        public String toString() {
            return "undefined";
        }
    };

    /** Text that is not JSON. */
    public static final class SyntaxException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        SyntaxException(String message) {
            super(message);
        }
    }

    /**
     * Arrays and objects nested deeper than this are refused. JavaScript has
     * no such limit; nothing this service is sent comes near it, and without
     * one a megabyte of {@code [} is a megabyte of nested lists.
     */
    public static final int MAX_DEPTH = 1_000;

    // ── JSON.parse ────────────────────────────────────────────────────────────

    /** {@code JSON.parse(text)}. */
    public static Object parse(String text) {
        Parser p = new Parser(text);
        p.whitespace();
        Object value = p.value(0);
        p.whitespace();
        if (p.at < text.length()) {
            throw p.unexpected();
        }
        return value;
    }

    private static final class Parser {
        private final String s;
        private int at;

        Parser(String s) {
            this.s = s;
        }

        SyntaxException unexpected() {
            return new SyntaxException(at >= s.length() ? "Unexpected end of JSON input"
                    : "Unexpected token " + s.charAt(at) + " in JSON at position " + at);
        }

        void whitespace() {
            while (at < s.length()) {
                char c = s.charAt(at);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    at++;
                } else {
                    break;
                }
            }
        }

        Object value(int depth) {
            if (at >= s.length()) {
                throw unexpected();
            }
            char c = s.charAt(at);
            switch (c) {
                case '{':
                    return object(depth);
                case '[':
                    return array(depth);
                case '"':
                    return string();
                case 't':
                    return literal("true", Boolean.TRUE);
                case 'f':
                    return literal("false", Boolean.FALSE);
                case 'n':
                    return literal("null", null);
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        return number();
                    }
                    throw unexpected();
            }
        }

        private Object literal(String word, Object value) {
            for (int i = 0; i < word.length(); i++, at++) {
                if (at >= s.length() || s.charAt(at) != word.charAt(i)) {
                    throw unexpected();
                }
            }
            return value;
        }

        private Map<String, Object> object(int depth) {
            if (depth >= MAX_DEPTH) {
                throw new SyntaxException("nested deeper than " + MAX_DEPTH + " levels");
            }
            at++;
            LinkedHashMap<String, Object> out = new LinkedHashMap<>();
            boolean indexed = false;
            whitespace();
            if (at < s.length() && s.charAt(at) == '}') {
                at++;
                return out;
            }
            while (true) {
                whitespace();
                if (at >= s.length() || s.charAt(at) != '"') {
                    throw unexpected();
                }
                String key = string();
                whitespace();
                if (at >= s.length() || s.charAt(at) != ':') {
                    throw unexpected();
                }
                at++;
                whitespace();
                // A key written twice keeps its first place and its last value.
                out.put(key, value(depth + 1));
                indexed |= isArrayIndex(key);
                whitespace();
                if (at >= s.length()) {
                    throw unexpected();
                }
                char c = s.charAt(at++);
                if (c == '}') {
                    return indexed ? inPropertyOrder(out) : out;
                }
                if (c != ',') {
                    at--;
                    throw unexpected();
                }
            }
        }

        private List<Object> array(int depth) {
            if (depth >= MAX_DEPTH) {
                throw new SyntaxException("nested deeper than " + MAX_DEPTH + " levels");
            }
            at++;
            ArrayList<Object> out = new ArrayList<>();
            whitespace();
            if (at < s.length() && s.charAt(at) == ']') {
                at++;
                return out;
            }
            while (true) {
                whitespace();
                out.add(value(depth + 1));
                whitespace();
                if (at >= s.length()) {
                    throw unexpected();
                }
                char c = s.charAt(at++);
                if (c == ']') {
                    return out;
                }
                if (c != ',') {
                    at--;
                    throw unexpected();
                }
            }
        }

        private String string() {
            at++;
            StringBuilder out = null;
            int start = at;
            while (true) {
                if (at >= s.length()) {
                    throw unexpected();
                }
                char c = s.charAt(at);
                if (c == '"') {
                    String text = out == null ? s.substring(start, at) : out.append(s, start, at).toString();
                    at++;
                    return text;
                }
                if (c < 0x20) {
                    throw unexpected();
                }
                if (c != '\\') {
                    at++;
                    continue;
                }
                if (out == null) {
                    out = new StringBuilder();
                }
                out.append(s, start, at);
                at++;
                if (at >= s.length()) {
                    throw unexpected();
                }
                char e = s.charAt(at++);
                switch (e) {
                    case '"':
                        out.append('"');
                        break;
                    case '\\':
                        out.append('\\');
                        break;
                    case '/':
                        out.append('/');
                        break;
                    case 'b':
                        out.append('\b');
                        break;
                    case 'f':
                        out.append('\f');
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        int code = 0;
                        for (int i = 0; i < 4; i++, at++) {
                            int digit = at < s.length() ? Character.digit(s.charAt(at), 16) : -1;
                            // Character.digit also reads digits of other scripts; JSON has the ASCII ones only.
                            if (digit < 0 || s.charAt(at) > 'f') {
                                throw unexpected();
                            }
                            code = code * 16 + digit;
                        }
                        out.append((char) code);
                        break;
                    default:
                        at--;
                        throw unexpected();
                }
                start = at;
            }
        }

        private Double number() {
            int start = at;
            if (s.charAt(at) == '-') {
                at++;
            }
            if (at >= s.length()) {
                throw unexpected();
            }
            if (s.charAt(at) == '0') {
                at++;
            } else if (s.charAt(at) >= '1' && s.charAt(at) <= '9') {
                digits();
            } else {
                throw unexpected();
            }
            if (at < s.length() && s.charAt(at) == '.') {
                at++;
                if (at >= s.length() || s.charAt(at) < '0' || s.charAt(at) > '9') {
                    throw unexpected();
                }
                digits();
            }
            if (at < s.length() && (s.charAt(at) == 'e' || s.charAt(at) == 'E')) {
                at++;
                if (at < s.length() && (s.charAt(at) == '+' || s.charAt(at) == '-')) {
                    at++;
                }
                if (at >= s.length() || s.charAt(at) < '0' || s.charAt(at) > '9') {
                    throw unexpected();
                }
                digits();
            }
            return Double.valueOf(s.substring(start, at));
        }

        private void digits() {
            while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') {
                at++;
            }
        }
    }

    // ── property order ────────────────────────────────────────────────────────

    /**
     * Is this key an array index — the text of a whole number from 0 to
     * 2^32 − 2, written without a sign or a leading zero? JavaScript lists
     * such keys before the others, in ascending order.
     */
    public static boolean isArrayIndex(String key) {
        int n = key.length();
        if (n == 0 || n > 10) {
            return false;
        }
        if (key.charAt(0) == '0') {
            return n == 1;
        }
        long value = 0;
        for (int i = 0; i < n; i++) {
            char c = key.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
            value = value * 10 + (c - '0');
        }
        return value <= 4_294_967_294L;
    }

    /** The same properties in the order JavaScript lists them: array indices ascending, then the rest as written. */
    public static <V> LinkedHashMap<String, V> inPropertyOrder(Map<String, V> map) {
        List<String> indices = new ArrayList<>();
        for (String key : map.keySet()) {
            if (isArrayIndex(key)) {
                indices.add(key);
            }
        }
        LinkedHashMap<String, V> out = new LinkedHashMap<>();
        if (!indices.isEmpty()) {
            indices.sort((a, b) -> Long.compare(Long.parseLong(a), Long.parseLong(b)));
            for (String key : indices) {
                out.put(key, map.get(key));
            }
        }
        for (Map.Entry<String, V> e : map.entrySet()) {
            if (indices.isEmpty() || !isArrayIndex(e.getKey())) {
                out.put(e.getKey(), e.getValue());
            }
        }
        return out;
    }

    // ── JSON.stringify ────────────────────────────────────────────────────────

    /** {@code JSON.stringify(value)}; {@code null} where JavaScript answers {@code undefined}. */
    public static String stringify(Object value) {
        return stringify(value, 0);
    }

    /** {@code JSON.stringify(value, null, indent)}; {@code null} where JavaScript answers {@code undefined}. */
    public static String stringify(Object value, int indent) {
        if (value == UNDEFINED) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        write(out, value, " ".repeat(Math.max(0, Math.min(indent, 10))), "", 0);
        return out.toString();
    }

    private static void write(StringBuilder out, Object value, String gap, String indent, int depth) {
        if (value == null || value == UNDEFINED) {
            out.append("null");
        } else if (value instanceof CharSequence) {
            quote(out, value.toString());
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value).booleanValue() ? "true" : "false");
        } else if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            out.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : numberToString(d));
        } else if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            out.append(((Number) value).longValue());
        } else if (value instanceof Map) {
            object(out, (Map<?, ?>) value, gap, indent, depth);
        } else if (value instanceof List) {
            array(out, (List<?>) value, gap, indent, depth);
        } else {
            // A programming error, caught where it is made: nothing else has a JSON form here.
            throw new IllegalArgumentException("not a JSON value: " + value.getClass().getName());
        }
    }

    private static void object(StringBuilder out, Map<?, ?> map, String gap, String indent, int depth) {
        if (depth >= MAX_DEPTH) {
            throw new IllegalArgumentException("nested deeper than " + MAX_DEPTH + " levels");
        }
        boolean indexed = false;
        for (Object key : map.keySet()) {
            if (!(key instanceof String)) {
                throw new IllegalArgumentException("a JSON object has text for keys, not " + (key == null ? "null" : key.getClass().getName()));
            }
            indexed |= isArrayIndex((String) key);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> ordered = indexed ? inPropertyOrder((Map<String, Object>) map) : (Map<String, Object>) map;
        String inner = indent + gap;
        boolean first = true;
        for (Map.Entry<String, Object> e : ordered.entrySet()) {
            if (e.getValue() == UNDEFINED) {
                continue;
            }
            out.append(first ? "{" : ",");
            if (!gap.isEmpty()) {
                out.append('\n').append(inner);
            }
            quote(out, e.getKey());
            out.append(gap.isEmpty() ? ":" : ": ");
            write(out, e.getValue(), gap, inner, depth + 1);
            first = false;
        }
        if (first) {
            out.append("{}");
            return;
        }
        if (!gap.isEmpty()) {
            out.append('\n').append(indent);
        }
        out.append('}');
    }

    private static void array(StringBuilder out, List<?> list, String gap, String indent, int depth) {
        if (depth >= MAX_DEPTH) {
            throw new IllegalArgumentException("nested deeper than " + MAX_DEPTH + " levels");
        }
        if (list.isEmpty()) {
            out.append("[]");
            return;
        }
        String inner = indent + gap;
        boolean first = true;
        for (Object element : list) {
            out.append(first ? "[" : ",");
            if (!gap.isEmpty()) {
                out.append('\n').append(inner);
            }
            write(out, element, gap, inner, depth + 1);
            first = false;
        }
        if (!gap.isEmpty()) {
            out.append('\n').append(indent);
        }
        out.append(']');
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /** A string as {@code JSON.stringify} quotes it: half a surrogate pair is escaped, everything else above U+001F is itself. */
    private static void quote(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        escape(out, c);
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                            out.append(c).append(s.charAt(++i));
                        } else {
                            escape(out, c);
                        }
                    } else if (Character.isLowSurrogate(c)) {
                        escape(out, c);
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    private static void escape(StringBuilder out, char c) {
        out.append("\\u").append(HEX[c >> 12]).append(HEX[(c >> 8) & 15]).append(HEX[(c >> 4) & 15]).append(HEX[c & 15]);
    }

    // ── numbers ───────────────────────────────────────────────────────────────

    private static final double TWO_53 = 9_007_199_254_740_992d;

    /**
     * A number as JavaScript prints it ({@code String(d)}): the fewest digits
     * that still read back as the same number, in plain notation from 1e-6 up
     * to 1e21 and with an exponent beyond.
     *
     * <p>{@code Double.toString} is not used: it writes {@code 1.0E21} and
     * {@code 5.0}, and before Java 19 it does not always find the fewest
     * digits.
     */
    public static String numberToString(double d) {
        if (Double.isNaN(d)) {
            return "NaN";
        }
        if (d == 0) {
            return "0";
        }
        if (Double.isInfinite(d)) {
            return d > 0 ? "Infinity" : "-Infinity";
        }
        if (d < 0) {
            return "-" + numberToString(-d);
        }
        // Whole numbers a double holds exactly are their own digits.
        if (d < TWO_53 && d == Math.rint(d)) {
            return Long.toString((long) d);
        }
        BigDecimal exact = new BigDecimal(d);
        BigDecimal pick = null;
        for (int precision = 1; precision <= 17 && pick == null; precision++) {
            // The two numbers of this many digits on either side of the value; the nearer one that reads back wins.
            BigDecimal lo = exact.round(new MathContext(precision, RoundingMode.DOWN));
            BigDecimal hi = lo.compareTo(exact) == 0 ? lo : lo.add(lo.ulp());
            boolean loReads = Double.parseDouble(lo.toString()) == d;
            boolean hiReads = Double.parseDouble(hi.toString()) == d;
            if (loReads && hiReads) {
                int nearer = exact.subtract(lo).compareTo(hi.subtract(exact));
                pick = nearer < 0 ? lo : nearer > 0 ? hi : (lo.unscaledValue().testBit(0) ? hi : lo);
            } else if (loReads) {
                pick = lo;
            } else if (hiReads) {
                pick = hi;
            }
        }
        if (pick == null) {
            // Seventeen digits always read back; this is not reached.
            pick = exact.round(new MathContext(17, RoundingMode.HALF_EVEN));
        }
        pick = pick.stripTrailingZeros();
        String digits = pick.unscaledValue().toString();
        int k = digits.length();
        int n = k - pick.scale();
        StringBuilder out = new StringBuilder();
        if (k <= n && n <= 21) {
            out.append(digits).append("0".repeat(n - k));
        } else if (0 < n && n <= 21) {
            out.append(digits, 0, n).append('.').append(digits, n, k);
        } else if (-6 < n && n <= 0) {
            out.append("0.").append("0".repeat(-n)).append(digits);
        } else {
            int e = n - 1;
            out.append(digits.charAt(0));
            if (k > 1) {
                out.append('.').append(digits, 1, k);
            }
            out.append('e').append(e < 0 ? '-' : '+').append(Math.abs(e));
        }
        return out.toString();
    }

    /** JavaScript's white space and line ends: what {@code trim()} removes and {@code Number()} ignores around a number. */
    public static boolean isSpace(char c) {
        switch (c) {
            case '\t':
            case '\n':
            case 0x0B:
            case '\f':
            case '\r':
            case ' ':
            case 0xA0:
            case 0x1680:
            case 0x2028:
            case 0x2029:
            case 0x202F:
            case 0x205F:
            case 0x3000:
            case 0xFEFF:
                return true;
            default:
                return c >= 0x2000 && c <= 0x200A;
        }
    }

    /** {@code s.trim()} as JavaScript trims. */
    public static String trim(String s) {
        int from = 0;
        int to = s.length();
        while (from < to && isSpace(s.charAt(from))) {
            from++;
        }
        while (to > from && isSpace(s.charAt(to - 1))) {
            to--;
        }
        return s.substring(from, to);
    }

    /**
     * {@code Number(text)}: the number a string stands for, or NaN. Empty
     * text is 0; {@code 0x}, {@code 0o} and {@code 0b} are read; so are
     * {@code Infinity} and an exponent. Nothing else Java's own parser takes
     * ({@code 1f}, {@code 0x1p3}, {@code NaN}) is a number here.
     */
    public static double toNumber(String text) {
        String s = trim(text);
        if (s.isEmpty()) {
            return 0;
        }
        if (s.length() > 2 && s.charAt(0) == '0') {
            int radix = "xX".indexOf(s.charAt(1)) >= 0 ? 16 : "oO".indexOf(s.charAt(1)) >= 0 ? 8 : "bB".indexOf(s.charAt(1)) >= 0 ? 2 : 0;
            if (radix != 0) {
                for (int i = 2; i < s.length(); i++) {
                    char c = s.charAt(i);
                    if (c > 'f' || Character.digit(c, radix) < 0) {
                        return Double.NaN;
                    }
                }
                return new BigInteger(s.substring(2), radix).doubleValue();
            }
        }
        int i = 0;
        if (s.charAt(0) == '+' || s.charAt(0) == '-') {
            i = 1;
        }
        if (s.startsWith("Infinity", i) && s.length() == i + 8) {
            return s.charAt(0) == '-' ? Double.NEGATIVE_INFINITY : Double.POSITIVE_INFINITY;
        }
        int digits = 0;
        int at = i;
        while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') {
            at++;
            digits++;
        }
        if (at < s.length() && s.charAt(at) == '.') {
            at++;
            while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') {
                at++;
                digits++;
            }
        }
        if (digits == 0) {
            return Double.NaN;
        }
        if (at < s.length() && (s.charAt(at) == 'e' || s.charAt(at) == 'E')) {
            at++;
            if (at < s.length() && (s.charAt(at) == '+' || s.charAt(at) == '-')) {
                at++;
            }
            int exponent = at;
            while (at < s.length() && s.charAt(at) >= '0' && s.charAt(at) <= '9') {
                at++;
            }
            if (at == exponent) {
                return Double.NaN;
            }
        }
        if (at != s.length()) {
            return Double.NaN;
        }
        return Double.parseDouble(s);
    }
}
