package com.stonehash.attest.remit.swift;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The two lines every {@code toJson} in this package repeats. */
final class JsonOut {
    private JsonOut() {
    }

    /** Sets the key only when there is a value: a field the message did not state is absent, not null. */
    static void put(Map<String, Object> out, String key, Object value) {
        if (value != null) {
            out.put(key, value);
        }
    }

    static List<String> strings(Object json) {
        List<String> out = new ArrayList<>();
        if (json != null) {
            for (Object o : (List<?>) json) {
                out.add((String) o);
            }
        }
        return out;
    }
}
