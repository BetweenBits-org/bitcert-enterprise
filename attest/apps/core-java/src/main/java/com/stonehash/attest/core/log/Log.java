package com.stonehash.attest.core.log;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The service's own log: one JSON object a line on standard output —
 * {@code {"ts": …, "msg": …, …}} — the lines the service it replaces wrote,
 * so whatever reads the log today reads this one.
 */
public final class Log {
    private Log() {
    }

    private static final PrintStream OUT = new PrintStream(System.out, true, StandardCharsets.UTF_8);

    public static void line(String msg) {
        line(msg, null);
    }

    public static void line(String msg, Map<String, ?> extra) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("ts", IsoTime.now());
        line.put("msg", msg);
        if (extra != null) {
            line.putAll(extra);
        }
        String text = Js.stringify(line);
        synchronized (OUT) {
            OUT.println(text);
        }
    }

    /** {@code key, value, key, value, …} as the extra fields of a line. */
    public static Map<String, Object> fields(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }
}
