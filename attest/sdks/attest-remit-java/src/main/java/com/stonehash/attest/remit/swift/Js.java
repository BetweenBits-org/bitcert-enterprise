package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Text;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The text operations of the reference implementation, with the reference's
 * meaning.
 *
 * <p>This package is a port: the same bytes must be read the same way as the
 * TypeScript SDK reads them, and the two languages disagree in small places —
 * what counts as whitespace, where {@code $} matches, what a split keeps. A
 * difference there decides whether a message is accepted or which line is
 * taken for a name. So every such operation goes through here, and none of
 * the readers calls {@link String#trim()}, {@link String#split(String)} or
 * writes {@code \s} into a pattern.
 */
final class Js {
    private Js() {
    }

    /** The character class {@code \s} of an ECMAScript regular expression (without the brackets). */
    static final String S = "\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
    /** {@code \s}, as a class to put into a pattern. */
    static final String WS = "[" + S + "]";
    /** {@code \S}. */
    static final String NWS = "[^" + S + "]";
    /** {@code .} of an ECMAScript regular expression: anything but a line terminator. */
    static final String DOT = "[^\\n\\r\\u2028\\u2029]";

    private static final Pattern RUN_OF_WS = Pattern.compile(WS + "+");

    /** {@code s.trim()}. */
    static String trim(String s) {
        return Text.trim(s);
    }

    /** {@code s.trim() === ''}. */
    static boolean blank(String s) {
        return Text.isBlank(s);
    }

    /** {@code s.replace(/\s+/g, ' ')}. */
    static String collapse(String s) {
        return RUN_OF_WS.matcher(s).replaceAll(" ");
    }

    /** {@code s.split(separator)} for a literal separator: every piece, the empty ones at the end included. */
    static List<String> split(String s, String separator) {
        List<String> out = new ArrayList<>();
        if (separator.isEmpty()) {
            throw new IllegalArgumentException("an empty separator");
        }
        int from = 0;
        for (;;) {
            int at = s.indexOf(separator, from);
            if (at < 0) {
                out.add(s.substring(from));
                return out;
            }
            out.add(s.substring(from, at));
            from = at + separator.length();
        }
    }

    /** {@code s.slice(from, to)}: negative positions count from the end, and nothing is out of range. */
    static String slice(String s, int from, int to) {
        int n = s.length();
        int a = from < 0 ? Math.max(n + from, 0) : Math.min(from, n);
        int b = to < 0 ? Math.max(n + to, 0) : Math.min(to, n);
        return a >= b ? "" : s.substring(a, b);
    }

    /** {@code s.slice(from)}. */
    static String slice(String s, int from) {
        return slice(s, from, s.length());
    }

    /** {@code s.padStart(length, pad)} for a one-character pad. */
    static String padStart(String s, int length, char pad) {
        StringBuilder out = new StringBuilder();
        for (int i = s.length(); i < length; i++) {
            out.append(pad);
        }
        return out.append(s).toString();
    }

    /** {@code s.toUpperCase()}. */
    static String upper(String s) {
        return s.toUpperCase(Locale.ROOT);
    }

    /** {@code s.toLowerCase()}. */
    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }

    /** {@code pattern.test(s)}: the pattern is found somewhere in {@code s}. */
    static boolean test(Pattern pattern, String s) {
        return pattern.matcher(s).find();
    }

    /** {@code pattern.exec(s)}: the first match, or null. */
    static Matcher exec(Pattern pattern, String s) {
        Matcher m = pattern.matcher(s);
        return m.find() ? m : null;
    }

    /** {@code s.replace(pattern, replacement)} for a pattern without the {@code g} flag: the first match only, replacement taken literally. */
    static String replaceFirst(String s, Pattern pattern, String replacement) {
        return pattern.matcher(s).replaceFirst(Matcher.quoteReplacement(replacement));
    }

    /** {@code s.replace(/…/g, replacement)}: every match, replacement taken literally. */
    static String replaceAll(String s, Pattern pattern, String replacement) {
        return pattern.matcher(s).replaceAll(Matcher.quoteReplacement(replacement));
    }

    /** {@code a ?? b} for strings. */
    static String or(String a, String b) {
        return a != null ? a : b;
    }

    /** {@code !!s}: a string that is there and not empty. */
    static boolean truthy(String s) {
        return s != null && !s.isEmpty();
    }
}
