package com.stonehash.attest.core.format;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Is this text a time written the ISO 8601 way — what {@code toISOString()}
 * writes, and the forms close to it that clients send?
 *
 * <pre>
 *   YYYY | YYYY-MM | YYYY-MM-DD                      a date alone
 *   …THH:mm | …THH:mm:ss | …THH:mm:ss.f…             with a time (the T may be a t or one space)
 *   Z | z | ±HH:mm | ±HHmm                            and optionally a zone
 *   ±YYYYYY                                           a year of six digits, signed
 * </pre>
 *
 * A day runs to 31 in any month, as the reference read it. The time has to
 * lie within what a JavaScript date can hold (100,000,000 days either side
 * of 1970).
 *
 * <p>The reference asked the JavaScript engine's {@code Date.parse}, which
 * also reads forms the language standard leaves to each engine — "Nov 18,
 * 2026", "2026/11/18", "2026-1-8", a bare "99". Those are not read here: the
 * sentence a client gets has always said "ISO-8601"
 * (docs/JAVA-INTENDED-DIFFERENCES.md, D-04).
 */
public final class IsoDate {
    private IsoDate() {
    }

    private static final Pattern FORMAT = Pattern.compile(
            "([+-]\\d{6}|\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?"
                    + "(?:[Tt ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(?:([Zz])|([+-])(\\d{2}):?(\\d{2}))?)?");

    private static final long MAX_MS = 8_640_000_000_000_000L;

    public static boolean parses(String text) {
        return epochMilli(text) != null;
    }

    /**
     * The instant the text names, in milliseconds since 1970 (UTC), or
     * {@code null} where it is not a time written this way. A time with no
     * zone is read as UTC.
     */
    public static Long epochMilli(String text) {
        Matcher m = FORMAT.matcher(text);
        if (!m.matches() || m.group(1).equals("-000000")) {
            return null;
        }
        int year = Integer.parseInt(m.group(1));
        int month = m.group(2) == null ? 1 : Integer.parseInt(m.group(2));
        int day = m.group(3) == null ? 1 : Integer.parseInt(m.group(3));
        if (month < 1 || month > 12 || day < 1 || day > 31) {
            return null;
        }
        long ms = 0;
        if (m.group(4) != null) {
            int hour = Integer.parseInt(m.group(4));
            int minute = Integer.parseInt(m.group(5));
            int second = m.group(6) == null ? 0 : Integer.parseInt(m.group(6));
            String fraction = m.group(7) == null ? "" : m.group(7);
            boolean midnight = hour == 24 && minute == 0 && second == 0 && fraction.matches("0*");
            if ((hour > 23 && !midnight) || minute > 59 || second > 59) {
                return null;
            }
            ms = ((hour * 60L + minute) * 60 + second) * 1000 + Long.parseLong((fraction + "000").substring(0, 3));
            if (m.group(9) != null) {
                int zh = Integer.parseInt(m.group(10));
                int zm = Integer.parseInt(m.group(11));
                if (zh > 23 || zm > 59) {
                    return null;
                }
                long offset = (zh * 60L + zm) * 60_000;
                ms += m.group(9).equals("-") ? offset : -offset;
            }
        }
        long days;
        try {
            // A day beyond the month's end counts on into the next month.
            days = LocalDate.of(year, month, 1).toEpochDay() + (day - 1);
        } catch (DateTimeException e) {
            return null;
        }
        return Math.abs(days) <= 100_000_001L && Math.abs(days * 86_400_000L + ms) <= MAX_MS ? Long.valueOf(days * 86_400_000L + ms) : null;
    }
}
