package com.stonehash.attest.core.net;

import java.util.Locale;

/**
 * As much of reading an absolute URL as checking a configured address needs:
 * does it parse, what is its scheme, does it carry credentials.
 *
 * <p>It follows the URL standard browsers and Node implement — the reference
 * service checked its settings with {@code new URL(value)} — for the
 * addresses a deployment actually sets. It is used at start only, on values
 * an operator wrote, and by {@code http.RequestTarget} for the rare request
 * target that names a host.
 */
public final class Urls {
    public final String protocol;
    public final String username;
    public final String password;

    private Urls(String protocol, String username, String password) {
        this.protocol = protocol;
        this.username = username;
        this.password = password;
    }

    /** The parts of the URL, or {@code null} when it does not parse as one. */
    public static Urls parse(String raw) {
        // Leading and trailing C0 controls and spaces are dropped; tabs and line ends anywhere.
        int from = 0;
        int to = raw.length();
        while (from < to && raw.charAt(from) <= ' ') {
            from++;
        }
        while (to > from && raw.charAt(to - 1) <= ' ') {
            to--;
        }
        String s = raw.substring(from, to).replace("\t", "").replace("\n", "").replace("\r", "");
        int colon = s.indexOf(':');
        if (colon < 1 || !isAlpha(s.charAt(0))) {
            return null;
        }
        for (int i = 1; i < colon; i++) {
            char c = s.charAt(i);
            if (!(isAlpha(c) || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.')) {
                return null;
            }
        }
        String protocol = s.substring(0, colon).toLowerCase(Locale.ROOT) + ":";
        if (!protocol.equals("http:") && !protocol.equals("https:")) {
            return new Urls(protocol, "", "");
        }
        int at = colon + 1;
        while (at < s.length() && (s.charAt(at) == '/' || s.charAt(at) == '\\')) {
            at++;
        }
        int end = at;
        while (end < s.length() && "/\\?#".indexOf(s.charAt(end)) < 0) {
            end++;
        }
        String authority = s.substring(at, end);
        String username = "";
        String password = "";
        int mark = authority.lastIndexOf('@');
        if (mark >= 0) {
            String userinfo = authority.substring(0, mark);
            int split = userinfo.indexOf(':');
            username = split < 0 ? userinfo : userinfo.substring(0, split);
            password = split < 0 ? "" : userinfo.substring(split + 1);
            authority = authority.substring(mark + 1);
        }
        String host = authority;
        int bracket = authority.lastIndexOf(']');
        int portAt = authority.lastIndexOf(':');
        if (portAt > bracket) {
            host = authority.substring(0, portAt);
            String port = authority.substring(portAt + 1);
            if (!port.isEmpty()) {
                if (port.length() > 5 || !port.chars().allMatch((c) -> c >= '0' && c <= '9') || Integer.parseInt(port) > 65535) {
                    return null;
                }
            }
        }
        if (host.isEmpty()) {
            return null;
        }
        if (host.startsWith("[")) {
            if (!host.endsWith("]") || host.length() < 4 || !host.substring(1, host.length() - 1).chars()
                    .allMatch((c) -> Character.digit(c, 16) >= 0 || c == ':' || c == '.')) {
                return null;
            }
        } else if (!isHost(host)) {
            return null;
        }
        return new Urls(protocol, username, password);
    }

    /**
     * A host that is a name or an IPv4 address. Percent-escapes are read
     * first; what must not appear in a host name then refuses it, and a name
     * whose last label is a number has to be an IPv4 address. (Names beyond
     * ASCII are taken as they are: the rules for those are not checked here.)
     */
    private static boolean isHost(String raw) {
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        byte[] in = raw.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (int i = 0; i < in.length; i++) {
            if (in[i] == '%' && i + 2 < in.length && Character.digit(in[i + 1], 16) >= 0 && Character.digit(in[i + 2], 16) >= 0) {
                bytes.write(Character.digit(in[i + 1], 16) * 16 + Character.digit(in[i + 2], 16));
                i += 2;
            } else {
                bytes.write(in[i]);
            }
        }
        String host = new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        if (host.isEmpty()) {
            return false;
        }
        for (int i = 0; i < host.length(); i++) {
            char c = host.charAt(i);
            if (c <= ' ' || c == 0x7F || "#/:<>?@[\\]^|%".indexOf(c) >= 0) {
                return false;
            }
        }
        String[] parts = host.split("\\.", -1);
        int count = parts.length;
        if (count > 1 && parts[count - 1].isEmpty()) {
            count--;
        }
        String last = parts[count - 1];
        boolean numeric = !last.isEmpty() && (last.chars().allMatch((c) -> c >= '0' && c <= '9') || ipv4Number(last) >= 0);
        if (!numeric) {
            return true;
        }
        if (count > 4) {
            return false;
        }
        for (int i = 0; i < count; i++) {
            long n = ipv4Number(parts[i]);
            if (n < 0 || (i < count - 1 && n > 255) || (i == count - 1 && n >= (1L << (8 * (5 - count))))) {
                return false;
            }
        }
        return true;
    }

    /** One part of an IPv4 address as the URL standard reads it — decimal, {@code 0x} hex or leading-zero octal — or −1. */
    private static long ipv4Number(String part) {
        if (part.isEmpty()) {
            return -1;
        }
        int radix = 10;
        String digits = part;
        if (part.length() >= 2 && part.charAt(0) == '0' && (part.charAt(1) == 'x' || part.charAt(1) == 'X')) {
            radix = 16;
            digits = part.substring(2);
        } else if (part.length() >= 2 && part.charAt(0) == '0') {
            radix = 8;
            digits = part.substring(1);
        }
        digits = digits.replaceFirst("^0+", "");
        if (digits.isEmpty()) {
            return 0;
        }
        if (digits.length() > 16) {
            return -1;
        }
        long value = 0;
        for (int i = 0; i < digits.length(); i++) {
            char c = digits.charAt(i);
            int d = c > 'f' ? -1 : Character.digit(c, radix);
            if (d < 0) {
                return -1;
            }
            value = value * radix + d;
        }
        return value;
    }

    private static boolean isAlpha(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
