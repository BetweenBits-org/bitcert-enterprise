package com.stonehash.attest.core.time;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

/**
 * The one place a time becomes text.
 *
 * <p>Every time this service stores or answers with is text of exactly this
 * form: UTC, milliseconds in three digits, {@code Z} — what JavaScript's
 * {@code Date.toISOString()} writes. The columns that hold them are text
 * columns, and they are compared and sorted as text: an expiry sweep, a usage
 * count, the order of a batch, the next attempt of a webhook, a page cursor.
 * A time written any other way (no fraction on the full second, six digits of
 * microseconds — what {@code Instant.toString()} gives) sorts in the wrong
 * place among the rows already there. So nothing else in this code base
 * formats a time.
 */
public final class IsoTime {
    private IsoTime() {
    }

    private static final DateTimeFormatter FORMAT =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** Now, to the millisecond (the rest is cut off, not rounded — as a JavaScript Date holds it). */
    public static String now() {
        return format(Instant.now());
    }

    /** The rest of a time whose year is written apart. */
    private static final DateTimeFormatter AFTER_THE_YEAR =
            DateTimeFormatter.ofPattern("-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** A year of four digits is written as it is; any other with its sign and six digits, as {@code toISOString()} writes it. */
    public static String format(Instant t) {
        int year = t.atZone(ZoneOffset.UTC).getYear();
        if (year >= 0 && year <= 9999) {
            return FORMAT.format(t);
        }
        return (year < 0 ? "-" : "+") + String.format("%06d", Math.abs(year)) + AFTER_THE_YEAR.format(t);
    }

    public static String ofEpochMilli(long ms) {
        return format(Instant.ofEpochMilli(ms));
    }
}
