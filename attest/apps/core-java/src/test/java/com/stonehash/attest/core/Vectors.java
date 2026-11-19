package com.stonehash.attest.core;

import com.stonehash.attest.core.json.Js;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Reading the vector files, which Node and the reference service wrote. */
public final class Vectors {
    private Vectors() {
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> load(String name) {
        try (InputStream in = Vectors.class.getResourceAsStream("/vectors/" + name)) {
            if (in == null) {
                throw new IllegalStateException("no vector file " + name);
            }
            return (Map<String, Object>) Js.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> cases(Map<String, Object> file, String key) {
        return (List<Map<String, Object>>) file.get(key);
    }

    /** Text stored as the hex of its UTF-16 code units. */
    public static String text(Object hex) {
        String h = (String) hex;
        StringBuilder out = new StringBuilder(h.length() / 4);
        for (int i = 0; i < h.length(); i += 4) {
            out.append((char) Integer.parseInt(h.substring(i, i + 4), 16));
        }
        return out.toString();
    }

    public static String show(String s) {
        return Js.stringify(s);
    }
}
