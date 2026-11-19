package com.stonehash.attest.core.format;

import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The canonical JSON that is hashed and signed (the RFC 8785 subset of the
 * bundle schema: keys sorted by code unit, no white space, whole numbers
 * only).
 *
 * <p>There is one implementation of those bytes, and it is the SDK's
 * {@code Json.canonical}: the bank's side and the platform's side must never
 * come to different bytes for the same value. This class only carries a value
 * as a request brought it ({@link Js#parse}: numbers are doubles) across to
 * it, and refuses what cannot be canonical in the words the service has
 * always used — a client reads them in a 400.
 */
public final class Canonical {
    private Canonical() {
    }

    private static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;

    /** The canonical text of a value. */
    public static String text(Object value) {
        return Json.canonical(forSdk(value));
    }

    /** The canonical bytes of a value: its text in UTF-8. */
    public static byte[] bytes(Object value) {
        return Json.canonicalBytes(forSdk(value));
    }

    /**
     * A value as the SDK's conventions take one (whole numbers as integers),
     * for what signs or verifies over the canonical form rather than taking
     * it as text. Refuses what cannot be canonical, as {@link #text} does.
     */
    public static Object forSdk(Object v) {
        if (v == null || v instanceof String || v instanceof Boolean || v instanceof Long || v instanceof Integer) {
            return v;
        }
        if (v instanceof Double) {
            double d = (Double) v;
            if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d)) {
                throw new PlainError("jcs: only integers are supported in this schema, got " + Js.numberToString(d));
            }
            if (Math.abs(d) > MAX_SAFE_INTEGER) {
                throw new PlainError("jcs: integer out of safe range: " + Js.numberToString(d));
            }
            return (long) d;
        }
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (e.getValue() != Js.UNDEFINED) {
                    out.put((String) e.getKey(), forSdk(e.getValue()));
                }
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : (List<?>) v) {
                out.add(forSdk(item));
            }
            return out;
        }
        throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
    }
}
