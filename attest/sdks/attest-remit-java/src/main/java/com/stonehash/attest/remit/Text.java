package com.stonehash.attest.remit;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * The two words the specification fixes — "whitespace" and "ignoring case" —
 * and strict UTF-8.
 *
 * <p>None of this uses {@link String#trim()}, {@link Character#isWhitespace}
 * or {@link String#toLowerCase()}: each of those is a slightly different
 * function from its counterpart in the other SDKs' languages, and a difference
 * decides whether a file is accepted or which account an identifier names.
 */
public final class Text {
    private Text() {
    }

    /** The specification's whitespace set, exactly. Every member is in the basic plane. */
    public static boolean isWhitespace(char c) {
        return (c >= '\u0009' && c <= '\r') || c == ' ' || c == '\u00a0' || c == '\u1680'
                || (c >= '\u2000' && c <= '\u200a') || c == '\u2028' || c == '\u2029'
                || c == '\u202f' || c == '\u205f' || c == '\u3000' || c == '\ufeff';
    }

    public static String trim(String s) {
        int from = 0;
        int to = s.length();
        while (from < to && isWhitespace(s.charAt(from))) {
            from++;
        }
        while (to > from && isWhitespace(s.charAt(to - 1))) {
            to--;
        }
        return from == 0 && to == s.length() ? s : s.substring(from, to);
    }

    public static boolean isBlank(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (!isWhitespace(s.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    /** A–Z to a–z and nothing else: full Unicode folding is not the same function in any two languages. */
    public static String lowerAscii(String s) {
        int i = 0;
        while (i < s.length() && !(s.charAt(i) >= 'A' && s.charAt(i) <= 'Z')) {
            i++;
        }
        if (i == s.length()) {
            return s;
        }
        char[] out = s.toCharArray();
        for (; i < out.length; i++) {
            if (out[i] >= 'A' && out[i] <= 'Z') {
                out[i] = (char) (out[i] + ('a' - 'A'));
            }
        }
        return new String(out);
    }

    /**
     * Text from a ledger or a file, as it appears inside a message: in quotes,
     * with anything that would break the line or hide in it written as an
     * escape. A message is one line whatever the data held.
     */
    public static String quote(String s) {
        return Json.compact(s);
    }

    public static boolean isAsciiDigit(char c) {
        return c >= '0' && c <= '9';
    }

    /** True when every surrogate in {@code s} is half of a pair, so the string has a UTF-8 encoding. */
    public static boolean isWellFormed(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 == s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
                    return false;
                }
                i++;
            } else if (Character.isLowSurrogate(c)) {
                return false;
            }
        }
        return true;
    }

    /**
     * UTF-8, or a refusal. {@link String#getBytes} would write {@code ?} for an
     * unpaired surrogate, and those bytes would then be hashed as if they were
     * the text.
     */
    public static byte[] utf8(String s) {
        if (!isWellFormed(s)) {
            throw new RemitException("invalid_text",
                    "the text contains an unpaired surrogate and has no UTF-8 encoding");
        }
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** The number of bytes {@link #utf8} would produce, without producing them. */
    public static int utf8Length(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80) {
                n += 1;
            } else if (c < 0x800) {
                n += 2;
            } else if (Character.isHighSurrogate(c)) {
                n += 4;
                i++;
            } else {
                n += 3;
            }
        }
        return n;
    }

    /** Decodes bytes that must be UTF-8; malformed input is an error, never a replacement character. */
    public static String decodeUtf8(byte[] bytes, String code, String what) {
        try {
            CharBuffer chars = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes));
            return chars.toString();
        } catch (CharacterCodingException e) {
            throw new RemitException(code, what + " is not valid UTF-8");
        }
    }
}
