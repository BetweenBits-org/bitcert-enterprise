package com.stonehash.attest.core.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Where settings come from: the process environment, and nothing compiled in.
 *
 * <p>The names are the ones the service has always read ({@code PORT},
 * {@code STONEHASH_DB_URL}, …), so the environment file that runs it today
 * runs this. A file of {@code KEY=value} lines can be laid over the
 * environment ({@link #withFile}); it is read by the same rules as
 * {@code deploy/ecosystem.config.cjs} reads {@code apps/core/.env}:
 * {@code #} starts a comment line, there is no quoting and no interpolation.
 */
public final class EnvSource {
    private final Map<String, String> values;

    private EnvSource(Map<String, String> values) {
        this.values = values;
    }

    public static EnvSource system() {
        return new EnvSource(new LinkedHashMap<>(System.getenv()));
    }

    public static EnvSource of(Map<String, String> values) {
        return new EnvSource(new LinkedHashMap<>(values));
    }

    /** The same settings with a file's lines laid over them: what the file names wins. */
    public EnvSource withFile(Path file) throws IOException {
        Map<String, String> merged = new LinkedHashMap<>(values);
        merged.putAll(readFile(file));
        return new EnvSource(merged);
    }

    static Map<String, String> readFile(Path file) throws IOException {
        Map<String, String> out = new LinkedHashMap<>();
        for (String line : Files.readString(file, StandardCharsets.UTF_8).split("\n", -1)) {
            String t = line.trim();
            if (t.isEmpty() || t.startsWith("#")) {
                continue;
            }
            int i = t.indexOf('=');
            if (i < 1) {
                continue;
            }
            out.put(t.substring(0, i).trim(), t.substring(i + 1).trim());
        }
        return out;
    }

    /** The value as set, or {@code null}. */
    public String get(String name) {
        return values.get(name);
    }
}
