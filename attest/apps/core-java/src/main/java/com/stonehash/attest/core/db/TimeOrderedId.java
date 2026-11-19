package com.stonehash.attest.core.db;

import java.security.SecureRandom;

/**
 * Ids for the tables this service adds: text that sorts in the order the ids
 * were made (a version 7 UUID — the time in milliseconds first, then a
 * counter, then random bits).
 *
 * <p>The tables the service inherited keep the random ids their rows already
 * have. A new table has no rows to stay compatible with, and an id that
 * grows with time keeps a primary key's index appended to rather than
 * scattered over, and lets "the oldest" be read off the key.
 *
 * <p>Within one process two ids of the same millisecond are in the order
 * they were made (the counter). Across processes the order within a
 * millisecond is arbitrary; nothing relies on it.
 */
public final class TimeOrderedId {
    private TimeOrderedId() {
    }

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private static long lastMillis = -1;
    private static int counter;

    public static String next() {
        long millis;
        int count;
        synchronized (TimeOrderedId.class) {
            long now = System.currentTimeMillis();
            if (now > lastMillis) {
                lastMillis = now;
                // Starts in the lower half, so that a burst within one millisecond has room to count up.
                counter = RANDOM.nextInt(0x800);
            } else if (++counter > 0xfff) {
                // More ids in one millisecond than the counter holds, or a clock that stepped back: the next millisecond is borrowed.
                lastMillis++;
                counter = RANDOM.nextInt(0x800);
            }
            millis = lastMillis;
            count = counter;
        }
        long high = (millis << 16) | 0x7000L | count;
        long low = (RANDOM.nextLong() & 0x3fffffffffffffffL) | 0x8000000000000000L;
        char[] out = new char[36];
        hex(out, 0, high >>> 32, 8);
        out[8] = '-';
        hex(out, 9, high >>> 16, 4);
        out[13] = '-';
        hex(out, 14, high, 4);
        out[18] = '-';
        hex(out, 19, low >>> 48, 4);
        out[23] = '-';
        hex(out, 24, low, 12);
        return new String(out);
    }

    private static void hex(char[] out, int at, long value, int digits) {
        for (int i = digits - 1; i >= 0; i--) {
            out[at + i] = HEX[(int) (value & 15)];
            value >>>= 4;
        }
    }
}
