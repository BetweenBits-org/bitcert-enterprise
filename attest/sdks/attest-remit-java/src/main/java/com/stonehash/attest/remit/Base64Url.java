package com.stonehash.attest.remit;

import java.util.Base64;

/** base64url without padding: how a signature travels in every envelope of the protocol. */
final class Base64Url {
    private Base64Url() {
    }

    static String encode(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /**
     * The bytes of an evidence element's signature, read the way the
     * reference verifier reads them — which is more forgiving than base64url:
     * either alphabet, padded or not, ASCII white space ignored. {@code null}
     * when the text is not base64 at all.
     *
     * <p>Kindness here decides nothing: the bytes still have to be a
     * signature that verifies. But a signature the reference verifier takes
     * must not be refused here for how it is spelled.
     */
    static byte[] forgiving(String text) {
        // The reference maps the URL-safe alphabet onto the standard one, pads to a multiple of four
        // (counted before white space is dropped), and hands the result to the platform's own decoder.
        StringBuilder s = new StringBuilder(text.length() + 3);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            s.append(c == '-' ? '+' : c == '_' ? '/' : c);
        }
        for (int pad = (4 - s.length() % 4) % 4; pad > 0; pad--) {
            s.append('=');
        }
        // That decoder: drop ASCII white space; with a length that is a multiple of four, drop one
        // or two trailing '='; refuse a length of 4n+1 and anything outside the alphabet.
        StringBuilder data = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\t' && c != '\n' && c != '\f' && c != '\r' && c != ' ') {
                data.append(c);
            }
        }
        if (data.length() % 4 == 0) {
            for (int n = 0; n < 2 && data.length() > 0 && data.charAt(data.length() - 1) == '='; n++) {
                data.setLength(data.length() - 1);
            }
        }
        if (data.length() % 4 == 1) {
            return null;
        }
        byte[] out = new byte[data.length() * 6 / 8];
        int bits = 0;
        int held = 0;
        int at = 0;
        for (int i = 0; i < data.length(); i++) {
            char c = data.charAt(i);
            int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
                    : c == '+' ? 62 : c == '/' ? 63 : -1;
            if (v < 0) {
                return null;
            }
            held = (held << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[at++] = (byte) (held >> bits);
                held &= (1 << bits) - 1;
            }
        }
        return out;       // two or four bits left over are dropped, as that decoder drops them
    }

    /**
     * The bytes of a registry key, read as the reference verifier's runtime
     * reads base64: either alphabet, anything else skipped (a key copied out
     * of a PEM block has line breaks in it), ending at the first padding
     * character. Whether the bytes are a key is for whoever asked.
     */
    static byte[] lenient(String text) {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(text.length() * 3 / 4);
        int bits = 0;
        int held = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '=') {
                break;
            }
            int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
                    : c == '+' || c == '-' ? 62 : c == '/' || c == '_' ? 63 : -1;
            if (v < 0) {
                continue;
            }
            held = (held << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write(held >> bits);
                held &= (1 << bits) - 1;
            }
        }
        return out.toByteArray();
    }

    /** Decodes base64url with or without padding; {@code null} when the text is not that. */
    static byte[] decodeOrNull(String text) {
        if (text == null) {
            return null;
        }
        try {
            return Base64.getUrlDecoder().decode(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
