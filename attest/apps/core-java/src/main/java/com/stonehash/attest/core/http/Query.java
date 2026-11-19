package com.stonehash.attest.core.http;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The parameters of a query string, read as a browser's
 * {@code URLSearchParams} reads them: {@code &} separates, the first
 * {@code =} splits name from value, {@code +} is a space, {@code %XX} is a
 * byte of UTF-8 and a {@code %} that is not one stays as it is.
 *
 * <p>Read from the query alone. The servlet API's own parameters also take a
 * form posted in the body, which would consume the body a handler is about to
 * read; they are never asked.
 */
public final class Query {
    private final List<String[]> pairs;

    private Query(List<String[]> pairs) {
        this.pairs = pairs;
    }

    /** @param query the query without its {@code ?}; {@code null} for none */
    public static Query parse(String query) {
        List<String[]> pairs = new ArrayList<>();
        if (query != null) {
            for (String part : query.split("&", -1)) {
                if (part.isEmpty()) {
                    continue;
                }
                int eq = part.indexOf('=');
                pairs.add(new String[] { decode(eq < 0 ? part : part.substring(0, eq)), eq < 0 ? "" : decode(part.substring(eq + 1)) });
            }
        }
        return new Query(Collections.unmodifiableList(pairs));
    }

    private static String decode(String s) {
        byte[] in = s.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length);
        for (int i = 0; i < in.length; i++) {
            byte b = in[i];
            if (b == '+') {
                out.write(' ');
            } else if (b == '%' && i + 2 < in.length && hex(in[i + 1]) >= 0 && hex(in[i + 2]) >= 0) {
                out.write(hex(in[i + 1]) * 16 + hex(in[i + 2]));
                i += 2;
            } else {
                out.write(b);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static int hex(int c) {
        return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
    }

    /** The first value under this name, or {@code null}. */
    public String get(String name) {
        for (String[] pair : pairs) {
            if (pair[0].equals(name)) {
                return pair[1];
            }
        }
        return null;
    }

    public boolean has(String name) {
        return get(name) != null;
    }

    public List<String> getAll(String name) {
        List<String> out = new ArrayList<>();
        for (String[] pair : pairs) {
            if (pair[0].equals(name)) {
                out.add(pair[1]);
            }
        }
        return out;
    }

    /** Every {@code [name, value]}, in the order sent. */
    public List<String[]> entries() {
        return pairs;
    }
}
