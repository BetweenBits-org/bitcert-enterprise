package com.stonehash.attest.remit;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;

/**
 * JSON values as JavaScript turns them into text and numbers.
 *
 * <p>The reference rules are written in TypeScript, and what they say about a
 * value they did not expect — a number where a name belongs, a list where one
 * text was meant — is whatever JavaScript makes of it: {@code `${value}`},
 * {@code value > 0}, {@code JSON.stringify(value)}. A platform that answers
 * with the reference's findings has to make the same of it, to the letter,
 * because those sentences are committed to in evidence packages.
 *
 * <p>Nothing here is used on the bank's own path, which declines to interpret
 * such values at all.
 */
final class JsValue {
    private JsValue() {
    }

    private static final double TWO_53 = 9_007_199_254_740_992d;

    /**
     * No text and no number can be made of this value: where JavaScript
     * throws {@code TypeError: Cannot convert object to primitive value}.
     *
     * <p>That is an object with a member of its own named {@code toString} —
     * whatever the member holds, since nothing a JSON document can hold is a
     * function — or a list that such an object is reached through. The
     * engine asks an object for its text by calling its {@code toString};
     * the one every object inherits answers {@code [object Object]}, and a
     * member of the object's own by that name stands in its way. (A member
     * named {@code valueOf} alone changes nothing: the inherited
     * {@code toString} still answers. Held by {@code golden/rules.json}.)
     *
     * <p>The reference fails there, so whoever answers as the reference
     * answers refuses there: the rules as {@code unreadable_evidence} or
     * {@code unreadable_policy}, the Travel Rule message as
     * {@code unreadable_compliance}.
     */
    static final class NotPrimitive extends RuntimeException {
        private static final long serialVersionUID = 1L;

        NotPrimitive() {
            super("an object with a member of its own named toString stands where text or a number is read, and nothing can be made of it");
        }
    }

    /** A JSON number as the double JavaScript holds it. */
    static double number(Number n) {
        if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) {
            return n.longValue();
        }
        if (n instanceof Double || n instanceof Float) {
            return n.doubleValue();
        }
        return new BigDecimal(n.toString()).doubleValue();
    }

    /**
     * {@code String(d)}: the fewest digits that still read back as the same
     * number, plain from 1e-6 up to 1e21 and with an exponent beyond.
     */
    static String numberToString(double d) {
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
            pick = exact.round(new MathContext(17, RoundingMode.HALF_EVEN));
        }
        pick = pick.stripTrailingZeros();
        String digits = pick.unscaledValue().toString();
        int k = digits.length();
        int n = k - pick.scale();
        StringBuilder out = new StringBuilder();
        if (k <= n && n <= 21) {
            out.append(digits);
            for (int i = k; i < n; i++) {
                out.append('0');
            }
        } else if (0 < n && n <= 21) {
            out.append(digits, 0, n).append('.').append(digits, n, k);
        } else if (-6 < n && n <= 0) {
            out.append("0.");
            for (int i = n; i < 0; i++) {
                out.append('0');
            }
            out.append(digits);
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

    /**
     * {@code String(v)} — what a template literal writes: text as it is,
     * a number as JavaScript prints it, a list as its members joined by
     * commas, any object as {@code [object Object]}, and the two nothings by
     * name.
     *
     * @throws NotPrimitive for an object with a member of its own named {@code toString}, or a list that holds one
     */
    static String string(Object v) {
        if (v == VerdictEngine.UNDEFINED) {
            return "undefined";
        }
        if (v == null) {
            return "null";
        }
        if (v instanceof String) {
            return (String) v;
        }
        if (v instanceof Boolean) {
            return v.toString();
        }
        if (v instanceof Number) {
            return numberToString(number((Number) v));
        }
        if (v instanceof List) {
            return join((List<?>) v, ",");
        }
        if (v instanceof Map && ((Map<?, ?>) v).containsKey("toString")) {
            throw new NotPrimitive();
        }
        return "[object Object]";
    }

    /** {@code list.join(separator)}: a member that is null or not there is written as nothing. */
    static String join(List<?> list, String separator) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) {
                out.append(separator);
            }
            Object item = list.get(i);
            if (item != null && item != VerdictEngine.UNDEFINED) {
                out.append(string(item));
            }
        }
        return out.toString();
    }

    /**
     * {@code Number(v)}, for a comparison: text is read as a number, the nothings are 0 and NaN, an object is whatever its text is.
     *
     * @throws NotPrimitive where no text can be made of the value
     */
    static double toNumber(Object v) {
        if (v == VerdictEngine.UNDEFINED) {
            return Double.NaN;
        }
        if (v == null) {
            return 0;
        }
        if (v instanceof Boolean) {
            return (Boolean) v ? 1 : 0;
        }
        if (v instanceof Number) {
            return number((Number) v);
        }
        return stringToNumber(string(v));
    }

    /** {@code Number(text)}: empty is 0; {@code 0x}, {@code 0o}, {@code 0b}, {@code Infinity} and an exponent are read; anything else is NaN. */
    static double stringToNumber(String text) {
        String s = Text.trim(text);      // the SDK's white space is JavaScript's, member for member
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
        int i = s.charAt(0) == '+' || s.charAt(0) == '-' ? 1 : 0;
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
        return at == s.length() ? Double.parseDouble(s) : Double.NaN;
    }

    private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;

    /**
     * The value with every whole number in it held as one.
     *
     * <p>The reference holds a number as its value and nothing else: 1,
     * 1.0 and 1e0 are one number there, and canonical JSON writes it
     * {@code 1}. Here the same number arrives as whatever the caller's JSON
     * reader made of it — a {@code Long}, a {@code BigDecimal} that remembers
     * its decimal point, a {@code Double}. So before anything is
     * canonicalised on the platform's path, a number whose value is a whole
     * number within ±(2^53 − 1) becomes that {@code Long}. Any other number
     * is left as it is, for the canonical writer to refuse as the reference
     * refuses it.
     *
     * <p>Nothing handed over is changed: where a number has to be replaced,
     * what holds it is copied.
     */
    static Object integers(Object v) {
        if (v instanceof Long || v instanceof Integer) {
            return v;
        }
        if (v instanceof Number) {
            double d = number((Number) v);
            return d == Math.rint(d) && Math.abs(d) <= MAX_SAFE_INTEGER ? (Object) Long.valueOf((long) d) : v;
        }
        if (v instanceof List) {
            List<Object> copy = null;
            List<?> list = (List<?>) v;
            for (int i = 0; i < list.size(); i++) {
                Object item = integers(list.get(i));
                if (item != list.get(i) && copy == null) {
                    copy = new java.util.ArrayList<>(list);
                }
                if (copy != null) {
                    copy.set(i, item);
                }
            }
            return copy == null ? v : copy;
        }
        if (v instanceof Map) {
            Map<Object, Object> copy = null;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                Object member = integers(e.getValue());
                if (member != e.getValue()) {
                    if (copy == null) {
                        copy = new java.util.LinkedHashMap<>((Map<?, ?>) v);
                    }
                    copy.put(e.getKey(), member);
                }
            }
            return copy == null ? v : copy;
        }
        return v;
    }

    /**
     * {@code JSON.stringify(v)}: no white space, an object's members in the
     * order JavaScript lists them (whole-number names first, ascending, then
     * the rest as they stand), a number as JavaScript prints it (one it
     * cannot hold is {@code null}), a member that is not there left out.
     */
    static String stringify(Object v) {
        StringBuilder out = new StringBuilder();
        write(out, v);
        return out.toString();
    }

    private static void write(StringBuilder out, Object v) {
        if (v == null || v == VerdictEngine.UNDEFINED) {
            out.append("null");
        } else if (v instanceof String) {
            out.append(Json.compact(v));
        } else if (v instanceof Boolean) {
            out.append(v.toString());
        } else if (v instanceof Number) {
            double d = number((Number) v);
            out.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : numberToString(d));
        } else if (v instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                write(out, item);
            }
            out.append(']');
        } else if (v instanceof Map) {
            out.append('{');
            boolean first = true;
            Map<?, ?> map = (Map<?, ?>) v;
            for (String key : Json.javascriptKeyOrder(map)) {
                if (map.get(key) == VerdictEngine.UNDEFINED) {
                    continue;
                }
                if (!first) {
                    out.append(',');
                }
                first = false;
                out.append(Json.compact(key)).append(':');
                write(out, map.get(key));
            }
            out.append('}');
        } else {
            throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
        }
    }
}
