package com.stonehash.attest.remit;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The JSON this library reads and writes, with nothing borrowed.
 *
 * <p>Public because the SDK's own packages share it; it is not part of what a
 * bank's code is expected to call, and carries no compatibility promise.
 *
 * <p>A value is a {@code Map<String, Object>} (in the order it was read or
 * built), a {@code List<Object>}, a {@code String}, a {@code Long}, a
 * {@code Boolean} or {@code null}. A number that is not a plain integer within
 * ±(2^53 - 1) is read as a {@link BigDecimal} so that nothing is rounded on the
 * way in — the platform's answers may hold such numbers — and is refused by
 * {@link #canonical}, where the specification makes it an error.
 *
 * <p>Three writers, because three different texts are needed:
 * <ul>
 * <li>{@link #canonical} — the bytes that are hashed and signed (specification §1);
 * <li>{@link #pretty} and {@link #compact} — files and request bodies, written
 *     the way the reference SDK's {@code JSON.stringify} writes them, so a
 *     directory built here is byte for byte the one the reference builds.
 * </ul>
 */
public final class Json {
    /** 2^53 - 1: beyond it a JSON number is not the same value in every reader. */
    static final long MAX_SAFE_INTEGER = 9007199254740991L;

    /** Deeper than any document of this protocol; a bound so hostile input cannot exhaust the stack. */
    private static final int MAX_DEPTH = 100;

    private Json() {
    }

    // ── reading ─────────────────────────────────────────────────────────────

    /** Parses one JSON document; a malformed one is the {@link RemitException} {@code invalid_json}. */
    public static Object parse(String text) {
        return parse(text, "invalid_json");
    }

    /** Parses one JSON document. {@code code} is the error code a malformed document is reported under. */
    public static Object parse(String text, String code) {
        Parser p = new Parser(text, code);
        p.skipWhitespace();
        Object value = p.value(0);
        p.skipWhitespace();
        if (p.at < text.length()) {
            throw p.fail("unexpected text after the JSON value");
        }
        return value;
    }

    public static Object parse(byte[] utf8, String code, String what) {
        return parse(Text.decodeUtf8(utf8, code, what), code);
    }

    private static final class Parser {
        private final String s;
        private final String code;
        private int at;

        Parser(String s, String code) {
            this.s = s;
            this.code = code;
        }

        RemitException fail(String what) {
            return new RemitException(code, "not valid JSON: " + what + " (at character " + at + ")");
        }

        void skipWhitespace() {
            while (at < s.length()) {
                char c = s.charAt(at);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
                    return;
                }
                at++;
            }
        }

        Object value(int depth) {
            if (at >= s.length()) {
                throw fail("the document ends where a value should be");
            }
            if (depth > MAX_DEPTH) {
                throw fail("nested more than " + MAX_DEPTH + " levels deep");
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
                    if (c == '-' || Text.isAsciiDigit(c)) {
                        return number();
                    }
                    throw fail("unexpected character");
            }
        }

        private Object literal(String word, Object value) {
            if (!s.startsWith(word, at)) {
                throw fail("unexpected character");
            }
            at += word.length();
            return value;
        }

        private Map<String, Object> object(int depth) {
            Map<String, Object> out = new LinkedHashMap<>();
            at++;
            skipWhitespace();
            if (at < s.length() && s.charAt(at) == '}') {
                at++;
                return out;
            }
            while (true) {
                skipWhitespace();
                if (at >= s.length() || s.charAt(at) != '"') {
                    throw fail("an object key must be a string");
                }
                String key = string();
                skipWhitespace();
                if (at >= s.length() || s.charAt(at) != ':') {
                    throw fail("expected ':' after an object key");
                }
                at++;
                skipWhitespace();
                Object value = value(depth + 1);
                // A second member under one key means the document says two
                // things, and readers disagree on which one counts. That is
                // not a statement anybody should sign or verify.
                if (out.containsKey(key)) {
                    throw fail("the key " + Text.quote(key) + " appears twice in one object");
                }
                out.put(key, value);
                skipWhitespace();
                if (at >= s.length()) {
                    throw fail("the document ends inside an object");
                }
                char c = s.charAt(at++);
                if (c == '}') {
                    return out;
                }
                if (c != ',') {
                    at--;
                    throw fail("expected ',' or '}' in an object");
                }
            }
        }

        private List<Object> array(int depth) {
            List<Object> out = new ArrayList<>();
            at++;
            skipWhitespace();
            if (at < s.length() && s.charAt(at) == ']') {
                at++;
                return out;
            }
            while (true) {
                skipWhitespace();
                out.add(value(depth + 1));
                skipWhitespace();
                if (at >= s.length()) {
                    throw fail("the document ends inside an array");
                }
                char c = s.charAt(at++);
                if (c == ']') {
                    return out;
                }
                if (c != ',') {
                    at--;
                    throw fail("expected ',' or ']' in an array");
                }
            }
        }

        private String string() {
            at++;
            int start = at;
            StringBuilder sb = null;
            while (true) {
                if (at >= s.length()) {
                    throw fail("the document ends inside a string");
                }
                char c = s.charAt(at);
                if (c == '"') {
                    String out = sb == null ? s.substring(start, at) : sb.append(s, start, at).toString();
                    at++;
                    return out;
                }
                if (c < 0x20) {
                    throw fail("a control character inside a string must be escaped");
                }
                if (c != '\\') {
                    at++;
                    continue;
                }
                if (sb == null) {
                    sb = new StringBuilder();
                }
                sb.append(s, start, at);
                at++;
                if (at >= s.length()) {
                    throw fail("the document ends inside an escape");
                }
                char e = s.charAt(at++);
                switch (e) {
                    case '"':
                        sb.append('"');
                        break;
                    case '\\':
                        sb.append('\\');
                        break;
                    case '/':
                        sb.append('/');
                        break;
                    case 'b':
                        sb.append('\b');
                        break;
                    case 'f':
                        sb.append('\f');
                        break;
                    case 'n':
                        sb.append('\n');
                        break;
                    case 'r':
                        sb.append('\r');
                        break;
                    case 't':
                        sb.append('\t');
                        break;
                    case 'u':
                        sb.append(unicodeEscape());
                        break;
                    default:
                        at--;
                        throw fail("unknown escape");
                }
                start = at;
            }
        }

        private char unicodeEscape() {
            if (at + 4 > s.length()) {
                throw fail("the document ends inside a \\u escape");
            }
            int v = 0;
            for (int i = 0; i < 4; i++) {
                char h = s.charAt(at + i);
                int d = h <= 'f' ? Character.digit(h, 16) : -1;
                if (d < 0) {
                    throw fail("a \\u escape needs four hex digits");
                }
                v = (v << 4) | d;
            }
            at += 4;
            return (char) v;
        }

        private Object number() {
            int start = at;
            if (s.charAt(at) == '-') {
                at++;
            }
            int firstDigit = at;
            while (at < s.length() && Text.isAsciiDigit(s.charAt(at))) {
                at++;
            }
            if (at == firstDigit) {
                throw fail("a number needs a digit");
            }
            if (s.charAt(firstDigit) == '0' && at - firstDigit > 1) {
                at = firstDigit;
                throw fail("a number may not have leading zeros");
            }
            boolean plainInteger = true;
            if (at < s.length() && s.charAt(at) == '.') {
                plainInteger = false;
                at++;
                int fraction = at;
                while (at < s.length() && Text.isAsciiDigit(s.charAt(at))) {
                    at++;
                }
                if (at == fraction) {
                    throw fail("a decimal point needs a digit after it");
                }
            }
            if (at < s.length() && (s.charAt(at) == 'e' || s.charAt(at) == 'E')) {
                plainInteger = false;
                at++;
                if (at < s.length() && (s.charAt(at) == '+' || s.charAt(at) == '-')) {
                    at++;
                }
                int exponent = at;
                while (at < s.length() && Text.isAsciiDigit(s.charAt(at))) {
                    at++;
                }
                if (at == exponent) {
                    throw fail("an exponent needs a digit");
                }
            }
            String text = s.substring(start, at);
            // 16 digits always fit a long; whether they are within 2^53 - 1 is checked on the value.
            if (plainInteger && at - firstDigit <= 16) {
                long v = Long.parseLong(text);
                if (v >= -MAX_SAFE_INTEGER && v <= MAX_SAFE_INTEGER) {
                    return v;
                }
            }
            try {
                return new BigDecimal(text);
            } catch (NumberFormatException e) {
                throw fail("a number outside any representable range");
            }
        }
    }

    // ── canonical JSON (specification §1) ───────────────────────────────────

    /** The canonical text. Anything the specification does not allow in it is refused, not formatted. */
    public static String canonical(Object value) {
        StringBuilder sb = new StringBuilder();
        writeCanonical(sb, value);
        return sb.toString();
    }

    public static byte[] canonicalBytes(Object value) {
        return canonical(value).getBytes(StandardCharsets.UTF_8);
    }

    private static void writeCanonical(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString(sb, (String) v, true);
        } else if (v instanceof Boolean) {
            sb.append(((Boolean) v).booleanValue() ? "true" : "false");
        } else if (v instanceof Long || v instanceof Integer) {
            long n = ((Number) v).longValue();
            if (n < -MAX_SAFE_INTEGER || n > MAX_SAFE_INTEGER) {
                throw new RemitException("not_canonical",
                        "canonical JSON holds integers within ±(2^53 - 1) only; " + n + " is outside that range");
            }
            sb.append(n);
        } else if (v instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) v;
            String[] keys = new String[map.size()];
            int i = 0;
            for (Object k : map.keySet()) {
                if (!(k instanceof String)) {
                    throw new RemitException("not_canonical", "an object key must be a string");
                }
                keys[i++] = (String) k;
            }
            // String.compareTo compares UTF-16 code units, which is the order the specification asks for.
            Arrays.sort(keys);
            sb.append('{');
            for (int k = 0; k < keys.length; k++) {
                if (k > 0) {
                    sb.append(',');
                }
                writeString(sb, keys[k], true);
                sb.append(':');
                writeCanonical(sb, map.get(keys[k]));
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeCanonical(sb, item);
            }
            sb.append(']');
        } else if (v instanceof Number) {
            // A fraction, an exponent, a value beyond 2^53 - 1 — or an amount
            // that should have been a decimal string.
            throw new RemitException("not_canonical",
                    "canonical JSON holds integers within ±(2^53 - 1) only; " + v + " is not one "
                            + "(an amount is written as a decimal string, never as a number)");
        } else {
            throw new RemitException("not_canonical", "a " + v.getClass().getSimpleName() + " has no canonical JSON form");
        }
    }

    // ── files and request bodies ────────────────────────────────────────────

    /** What {@code JSON.stringify(value, null, 2)} writes. */
    public static String pretty(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, 0, true);
        return sb.toString();
    }

    /** What {@code JSON.stringify(value)} writes. */
    public static String compact(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, 0, false);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v, int depth, boolean indent) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString(sb, (String) v, false);
        } else if (v instanceof Boolean) {
            sb.append(((Boolean) v).booleanValue() ? "true" : "false");
        } else if (v instanceof Long || v instanceof Integer) {
            sb.append(((Number) v).longValue());
        } else if (v instanceof BigDecimal) {
            sb.append(v.toString());
        } else if (v instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) v;
            if (map.isEmpty()) {
                sb.append("{}");
                return;
            }
            sb.append('{');
            boolean first = true;
            for (String key : javascriptKeyOrder(map)) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                newline(sb, depth + 1, indent);
                writeString(sb, key, false);
                sb.append(indent ? ": " : ":");
                write(sb, map.get(key), depth + 1, indent);
            }
            newline(sb, depth, indent);
            sb.append('}');
        } else if (v instanceof List) {
            List<?> list = (List<?>) v;
            if (list.isEmpty()) {
                sb.append("[]");
                return;
            }
            sb.append('[');
            boolean first = true;
            for (Object item : list) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                newline(sb, depth + 1, indent);
                write(sb, item, depth + 1, indent);
            }
            newline(sb, depth, indent);
            sb.append(']');
        } else {
            throw new RemitException("invalid_json", "a " + v.getClass().getSimpleName() + " cannot be written as JSON here "
                    + "(an amount is written as a decimal string)");
        }
    }

    private static void newline(StringBuilder sb, int depth, boolean indent) {
        if (indent) {
            sb.append('\n');
            for (int i = 0; i < depth; i++) {
                sb.append("  ");
            }
        }
    }

    /**
     * The order in which JavaScript lists an object's keys: those that are
     * array indices ("0", "7", "42") first, ascending, then the rest as they
     * were added. It only shows when an asset symbol is all digits, but then
     * it decides the bytes of every file the reference writes.
     */
    static List<String> javascriptKeyOrder(Map<?, ?> map) {
        List<String> rest = new ArrayList<>(map.size());
        List<String> indices = null;
        for (Object k : map.keySet()) {
            if (!(k instanceof String)) {
                throw new RemitException("invalid_json", "an object key must be a string");
            }
            String key = (String) k;
            if (arrayIndex(key) >= 0) {
                if (indices == null) {
                    indices = new ArrayList<>();
                }
                indices.add(key);
            } else {
                rest.add(key);
            }
        }
        if (indices == null) {
            return rest;
        }
        indices.sort((a, b) -> Long.compare(arrayIndex(a), arrayIndex(b)));
        indices.addAll(rest);
        return indices;
    }

    /** The value of a canonical array index (no sign, no leading zero, at most 2^32 - 2), or -1. */
    private static long arrayIndex(String key) {
        int n = key.length();
        if (n == 0 || n > 10 || (n > 1 && key.charAt(0) == '0')) {
            return -1;
        }
        long v = 0;
        for (int i = 0; i < n; i++) {
            char c = key.charAt(i);
            if (!Text.isAsciiDigit(c)) {
                return -1;
            }
            v = v * 10 + (c - '0');
        }
        return v <= 4294967294L ? v : -1;
    }

    /**
     * A JSON string. The escapes are those of the specification, which are
     * also JavaScript's. An unpaired surrogate has no UTF-8 encoding and is
     * written as its escape, as JavaScript writes it — in canonical text as
     * well, because that is the text the reference SDK hashes and signs.
     */
    private static void writeString(StringBuilder sb, String s, boolean canonical) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                default:
                    if (c < 0x20) {
                        appendEscape(sb, c);
                    } else if (Character.isHighSurrogate(c) && i + 1 < s.length()
                            && Character.isLowSurrogate(s.charAt(i + 1))) {
                        sb.append(c).append(s.charAt(++i));
                    } else if (Character.isSurrogate(c)) {
                        // Half a pair has no UTF-8 encoding. It is written as its escape, in
                        // canonical text too: that is what the reference SDK signs.
                        appendEscape(sb, c);
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    private static void appendEscape(StringBuilder sb, char c) {
        sb.append("\\u");
        String hex = Integer.toHexString(c);
        for (int i = hex.length(); i < 4; i++) {
            sb.append('0');
        }
        sb.append(hex);
    }

    // ── reading a parsed document field by field ────────────────────────────

    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(Object v, String code, String what) {
        if (!(v instanceof Map)) {
            throw new RemitException(code, what + " must be a JSON object");
        }
        return (Map<String, Object>) v;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> array(Object v, String code, String what) {
        if (!(v instanceof List)) {
            throw new RemitException(code, what + " must be a JSON array");
        }
        return (List<Object>) v;
    }

    public static String string(Object v, String code, String what) {
        if (!(v instanceof String)) {
            throw new RemitException(code, what + " must be a string");
        }
        return (String) v;
    }

    public static long integer(Object v, String code, String what) {
        if (!(v instanceof Long)) {
            throw new RemitException(code, what + " must be an integer");
        }
        return (Long) v;
    }

    /** A copy that cannot be changed through, so a document handed to a caller stays the one that was signed. */
    public static Object freeze(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!(e.getKey() instanceof String)) {
                    throw new RemitException("invalid_json", "an object key must be a string");
                }
                out.put((String) e.getKey(), freeze(e.getValue()));
            }
            return Collections.unmodifiableMap(out);
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : (List<?>) v) {
                out.add(freeze(item));
            }
            return Collections.unmodifiableList(out);
        }
        if (v instanceof Integer) {
            return Long.valueOf((Integer) v);
        }
        return v;
    }
}
