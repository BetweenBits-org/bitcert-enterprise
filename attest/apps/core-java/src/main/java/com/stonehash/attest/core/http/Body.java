package com.stonehash.attest.core.http;

import java.util.Collections;
import java.util.Map;

/** Reading the fields of a request body that may be any JSON at all. */
public final class Body {
    private Body() {
    }

    /**
     * The body as an object to read fields from. A body that is not an
     * object — a list, text, a number, {@code null} — has no fields, so each
     * route answers it with its own "this field is missing".
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> fields(Object body) {
        return body instanceof Map ? (Map<String, Object>) body : Collections.emptyMap();
    }

    /** A field that is text, or {@code null} when it is absent or anything else. */
    public static String text(Map<String, Object> fields, String key) {
        Object v = fields.get(key);
        return v instanceof String ? (String) v : null;
    }

    /**
     * Does a JSON value count as given, the way the reference's
     * {@code if (!value)} read it? Absent, {@code null}, {@code false},
     * {@code 0} and empty text do not; anything else does — an empty list or
     * object included.
     */
    public static boolean truthy(Object v) {
        if (v == null || v == com.stonehash.attest.core.json.Js.UNDEFINED) {
            return false;
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return d != 0 && !Double.isNaN(d);
        }
        return !(v instanceof String) || !((String) v).isEmpty();
    }
}
