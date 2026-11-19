package com.stonehash.attest.core.http;

import com.stonehash.attest.core.net.Urls;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The target of a request — the path and the query of its first line — read
 * as the URL standard reads it, which is how the service this one replaces
 * read it ({@code new URL(req.url, 'http://localhost')}).
 *
 * <p>That decides things a client can see: {@code /a/../b} is {@code /b},
 * {@code /a/./b} and {@code /a/%2e/b} are {@code /a/b}, a backslash is a
 * slash, and what remains percent-encoded stays as it was sent — a route's
 * literal segments are compared with the encoded path, and only a parameter
 * is decoded, by the route that owns it.
 */
public final class RequestTarget {
    /** The path: starts with {@code /}, dot segments resolved, percent-encoding as sent. */
    public final String pathname;
    /** {@code ""}, or {@code ?} and the query. */
    public final String search;
    public final Query query;

    private RequestTarget(String pathname, String search, Query query) {
        this.pathname = pathname;
        this.search = search;
        this.query = query;
    }

    /**
     * @param rawPath  the path of the request line, undecoded
     * @param rawQuery its query without the {@code ?}, undecoded; {@code null} for none
     * @throws HttpError 400 {@code invalid_path} when the target is not a valid URL
     */
    public static RequestTarget parse(String rawPath, String rawQuery) {
        String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        if (!isSlash(path.charAt(0))) {
            path = "/" + path;
        }
        // Two slashes at the start name a host, as in any relative URL: //host/path.
        if (path.length() >= 2 && isSlash(path.charAt(0)) && isSlash(path.charAt(1))) {
            int from = 0;
            while (from < path.length() && isSlash(path.charAt(from))) {
                from++;
            }
            int to = from;
            while (to < path.length() && !isSlash(path.charAt(to))) {
                to++;
            }
            if (Urls.parse("http://" + path.substring(from, to) + "/") == null) {
                throw new HttpError(400, "invalid_path", "the request target is not a valid URL");
            }
            path = to >= path.length() ? "/" : path.substring(to);
        }
        String query = rawQuery == null ? "" : encode(rawQuery, QUERY_SET);
        return new RequestTarget(pathnameOf(path), query.isEmpty() ? "" : "?" + query, Query.parse(query));
    }

    private static boolean isSlash(char c) {
        return c == '/' || c == '\\';
    }

    private static String pathnameOf(String path) {
        List<String> segments = new ArrayList<>();
        int at = 0;
        // The path starts with a slash; each turn reads one segment up to the next slash or the end.
        while (at < path.length()) {
            at++;
            int end = at;
            while (end < path.length() && !isSlash(path.charAt(end))) {
                end++;
            }
            String segment = path.substring(at, end);
            boolean last = end >= path.length();
            String lower = segment.toLowerCase(Locale.ROOT);
            if (lower.equals("..") || lower.equals(".%2e") || lower.equals("%2e.") || lower.equals("%2e%2e")) {
                if (!segments.isEmpty()) {
                    segments.remove(segments.size() - 1);
                }
                if (last) {
                    segments.add("");
                }
            } else if (lower.equals(".") || lower.equals("%2e")) {
                if (last) {
                    segments.add("");
                }
            } else {
                segments.add(encode(segment, PATH_SET));
            }
            at = end;
        }
        return "/" + String.join("/", segments);
    }

    private static final String PATH_SET = " \"#<>?`{}";
    private static final String QUERY_SET = " \"#<>'";
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    /** Percent-encode what the standard encodes in this part of a URL: controls, the set given, and everything beyond ASCII. */
    private static String encode(String s, String set) {
        StringBuilder out = null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c > 0x20 && c < 0x7F && set.indexOf(c) < 0) {
                if (out != null) {
                    out.append(c);
                }
                continue;
            }
            if (out == null) {
                out = new StringBuilder(s.length() + 8).append(s, 0, i);
            }
            int length = Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1)) ? 2 : 1;
            String unit = Character.isSurrogate(c) && length == 1 ? "�" : s.substring(i, i + length);
            for (byte b : unit.getBytes(StandardCharsets.UTF_8)) {
                out.append('%').append(HEX[(b >> 4) & 15]).append(HEX[b & 15]);
            }
            i += length - 1;
        }
        return out == null ? s : out.toString();
    }
}
