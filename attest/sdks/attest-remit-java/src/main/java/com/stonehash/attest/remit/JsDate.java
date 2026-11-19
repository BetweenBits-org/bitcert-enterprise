package com.stonehash.attest.remit;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * {@code Date.parse}, as the reference's JavaScript engine has it, for a time
 * written the ISO 8601 way or close to it:
 *
 * <pre>
 *   YYYY | YYYY-MM | YYYY-MM-DD                      a date alone
 *   …THH:mm | …THH:mm:ss | …THH:mm:ss.f…             with a time (the T may be a t, or one space)
 *   Z | z | ±HH:mm | ±HHmm                            and optionally a zone
 *   ±YYYYYY                                           a year of six digits, signed
 * </pre>
 *
 * <p>For text of that shape the answer is the engine's own, to the
 * millisecond, with one thing fixed: a time without a zone is UTC. (The
 * engine reads it as the local time of the machine it runs on; the platform's
 * machines run in UTC, and a verdict must not depend on where it was
 * computed.) Text of any other shape — "Nov 18, 2026", "2026/11/18",
 * "2026-1-8", a bare "99", anything with spaces around it — is no date here,
 * although the engine reads some of it with a reader of its own that the
 * language standard does not describe.
 *
 * <p>"The engine's own" includes what that reader does inside the shape
 * above, because it takes over wherever the standard's format stops matching:
 * after a space instead of the {@code T}, and at a month or a day out of
 * range. There a year below 100 is of this century or the last, a year from 1
 * to 31 is read as a month ("0001-11-18 09:00" is January 11th, 2018), a zone
 * may be more than a day wide, and of a long fraction of a second only the
 * first digits count. None of that is a rule anyone would choose; all of it
 * is what the reference answers, so the two stages are followed here step for
 * step and held to {@code golden/rules.json}, which carries the engine's
 * answers.
 */
final class JsDate {
    private JsDate() {
    }

    private static final Pattern SHAPE = Pattern.compile(
            "(?:[+-]\\d{6}|\\d{4})(?:-\\d{2}(?:-\\d{2})?)?(?:[Tt ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:[Zz]|[+-]\\d{2}:?\\d{2})?)?");

    /** Whether the text has the shape this class reads at all. */
    static boolean hasShape(String text) {
        return SHAPE.matcher(text).matches();
    }

    /** Milliseconds since the epoch, or NaN. */
    static double parse(String text) {
        return hasShape(text) ? new Reader(text).read() : Double.NaN;
    }

    private static final int NONE = Integer.MAX_VALUE;
    /** A date holds 100,000,000 days either side of 1970. */
    private static final long LIMIT = 8_640_000_000_000_000L;

    private static final int NUMBER = 0;
    private static final int MARK = 1;
    private static final int SPACE = 2;
    private static final int SEPARATOR = 3;
    private static final int ZULU = 4;
    private static final int END = 5;

    /** One piece of the text, as the engine's reader cuts it. */
    private static final class Piece {
        final int kind;
        /** Of a number: its value, counted from its first digit that is not a zero, nine digits at most. */
        final int number;
        /** Of a number: how many digits it was written with, zeros included. */
        final int length;
        final char mark;

        Piece(int kind, int number, int length, char mark) {
            this.kind = kind;
            this.number = number;
            this.length = length;
            this.mark = mark;
        }
    }

    private static final Piece THE_END = new Piece(END, 0, 0, '\0');
    /** Not a piece of any text: the standard's format matched up to the T and failed after it, which is final. */
    private static final Piece REFUSED = new Piece(END, 0, 0, '\0');

    private static final class Reader {
        private final List<Piece> pieces = new ArrayList<>();
        private int at;
        private final int[] day = new int[3];
        private int days;
        private final int[] time = new int[4];
        private int times;
        private int zoneSign = NONE;
        private int zoneHour = NONE;
        private int zoneMinute = NONE;
        /** The whole text was in the standard's format: its year is a year and its numbers are in their written order. */
        private boolean standard;

        Reader(String text) {
            int i = 0;
            while (i < text.length()) {
                char c = text.charAt(i);
                if (c >= '0' && c <= '9') {
                    int from = i;
                    while (i < text.length() && text.charAt(i) == '0') {
                        i++;
                    }
                    int value = 0;
                    for (int kept = 0; i < text.length() && text.charAt(i) >= '0' && text.charAt(i) <= '9'; i++, kept++) {
                        if (kept < 9) {
                            value = value * 10 + (text.charAt(i) - '0');
                        }
                    }
                    pieces.add(new Piece(NUMBER, value, i - from, '\0'));
                    continue;
                }
                pieces.add(c == ' ' ? new Piece(SPACE, 0, 0, c) : c == 'T' || c == 't' ? new Piece(SEPARATOR, 0, 0, c)
                        : c == 'Z' || c == 'z' ? new Piece(ZULU, 0, 0, c) : new Piece(MARK, 0, 0, c));
                i++;
            }
        }

        private Piece peek() {
            return at < pieces.size() ? pieces.get(at) : THE_END;
        }

        private Piece next() {
            return at < pieces.size() ? pieces.get(at++) : THE_END;
        }

        private boolean skip(char mark) {
            if (isMark(peek(), mark)) {
                at++;
                return true;
            }
            return false;
        }

        private static boolean isMark(Piece p, char mark) {
            return p.kind == MARK && p.mark == mark;
        }

        private static boolean isSign(Piece p) {
            return p.kind == MARK && (p.mark == '+' || p.mark == '-');
        }

        private static boolean digits(Piece p, int count) {
            return p.kind == NUMBER && p.length == count;
        }

        private boolean addDay(int n) {
            if (days >= 3) {
                return false;
            }
            day[days++] = n;
            return true;
        }

        private boolean addTime(int n) {
            if (times >= 4) {
                return false;
            }
            time[times++] = n;
            return true;
        }

        /** The last number of a time; whatever was left unsaid is zero. */
        private void finishTime(int n) {
            if (addTime(n)) {
                while (times < 4) {
                    time[times++] = 0;
                }
            }
        }

        /** Whether a number can be the next part of the time: a minute, a second, or milliseconds. */
        private boolean expectingTime(int n) {
            return (times == 1 && n <= 59) || (times == 2 && n <= 59) || (times == 3 && n <= 999);
        }

        private void zone(int sign, int hour, int minute) {
            zoneSign = sign;
            zoneHour = hour;
            zoneMinute = minute;
        }

        /** A fraction of a second as milliseconds: its first three digits — counted as the engine counts them. */
        private static int milliseconds(Piece fraction) {
            int n = fraction.number;
            int length = fraction.length;
            if (length == 1) {
                return n * 100;
            }
            if (length == 2) {
                return n * 10;
            }
            for (length = Math.min(length, 9); length > 3; length--) {
                n /= 10;
            }
            return n;
        }

        double read() {
            Piece unhandled = standardFormat();
            if (unhandled == REFUSED || (unhandled != null && !olderReader(unhandled))) {
                return Double.NaN;
            }
            return instant();
        }

        /**
         * The date-time format of the language standard. Answers {@code null}
         * when all of the text was that; {@link #REFUSED} when it was that up
         * to the T and not after; otherwise the piece at which it stopped
         * being that, for the older reader to go on from.
         */
        private Piece standardFormat() {
            if (isSign(peek())) {
                Piece sign = next();
                if (!digits(peek(), 6)) {
                    return sign;
                }
                int year = next().number;
                if (sign.mark == '-' && year == 0) {
                    return sign;        // "-000000" is no year; and its digits have been passed over by now
                }
                addDay(sign.mark == '-' ? -year : year);
            } else if (digits(peek(), 4)) {
                addDay(next().number);
            } else {
                return next();
            }
            if (skip('-')) {
                if (!digits(peek(), 2) || peek().number < 1 || peek().number > 12) {
                    return next();
                }
                addDay(next().number);
                if (skip('-')) {
                    if (!digits(peek(), 2) || peek().number < 1 || peek().number > 31) {
                        return next();
                    }
                    addDay(next().number);
                }
            }
            if (peek().kind != SEPARATOR) {
                if (peek().kind != END) {
                    return next();
                }
            } else {
                next();
                if (!digits(peek(), 2) || peek().number > 24) {
                    return REFUSED;
                }
                // 24:00:00.000 is the end of the day; nothing else may start with 24.
                boolean endOfDay = peek().number == 24;
                addTime(next().number);
                if (!skip(':') || !digits(peek(), 2) || peek().number > 59 || (endOfDay && peek().number > 0)) {
                    return REFUSED;
                }
                addTime(next().number);
                if (skip(':')) {
                    if (!digits(peek(), 2) || peek().number > 59 || (endOfDay && peek().number > 0)) {
                        return REFUSED;
                    }
                    addTime(next().number);
                    if (skip('.')) {
                        if (peek().kind != NUMBER || (endOfDay && peek().number > 0)) {
                            return REFUSED;
                        }
                        addTime(milliseconds(next()));
                    }
                }
                if (peek().kind == ZULU) {
                    next();
                    zone(1, 0, 0);
                } else if (isSign(peek())) {
                    zoneSign = next().mark == '+' ? 1 : -1;
                    if (digits(peek(), 4)) {
                        int hourMinute = next().number;
                        if (hourMinute / 100 > 23 || hourMinute % 100 > 59) {
                            return REFUSED;
                        }
                        zoneHour = hourMinute / 100;
                        zoneMinute = hourMinute % 100;
                    } else {
                        if (!digits(peek(), 2) || peek().number > 23) {
                            return REFUSED;
                        }
                        zoneHour = next().number;
                        if (!skip(':') || !digits(peek(), 2) || peek().number > 59) {
                            return REFUSED;
                        }
                        zoneMinute = next().number;
                    }
                }
                if (peek().kind != END) {
                    return REFUSED;
                }
            }
            // A date alone is UTC by the standard; a time without a zone is UTC by this class's one rule.
            standard = true;
            return null;
        }

        /**
         * The engine's older reader, from the piece the standard's format
         * stopped at: numbers go to the time when a colon or the time's own
         * progress says so, to the zone when one is open, and otherwise to
         * the date — also a second of 60 or a zone minute of 99, which is how
         * text of this shape comes to mean a date nobody wrote.
         */
        private boolean olderReader(Piece first) {
            boolean numberRead = days > 0;
            for (Piece piece = first; piece.kind != END; piece = next()) {
                if (piece.kind == NUMBER) {
                    numberRead = true;
                    int n = piece.number;
                    if (skip(':')) {
                        if (skip(':')) {
                            if (times > 0) {
                                return false;
                            }
                            addTime(n);
                            addTime(0);
                        } else {
                            if (!addTime(n)) {
                                return false;
                            }
                            if (isMark(peek(), '.')) {
                                next();
                            }
                        }
                    } else if (skip('.') && expectingTime(n)) {
                        addTime(n);
                        if (peek().kind != NUMBER) {
                            return false;
                        }
                        finishTime(milliseconds(next()));
                    } else if (zoneHour != NONE && zoneMinute == NONE && n <= 59) {
                        zoneMinute = n;
                    } else if (expectingTime(n)) {
                        finishTime(n);
                        Piece after = peek();
                        if (after.kind != END && after.kind != SPACE && after.kind != ZULU && !isSign(after)) {
                            return false;
                        }
                    } else {
                        if (!addDay(n)) {
                            return false;
                        }
                        skip('-');
                    }
                } else if (piece.kind == ZULU && numberRead) {
                    zone(1, 0, 0);
                } else if (piece.kind == ZULU || piece.kind == SEPARATOR) {
                    // A word that means nothing here: fatal after a number, and before one that follows it directly.
                    if (numberRead || peek().kind == NUMBER) {
                        return false;
                    }
                } else if (isSign(piece) && ((zoneHour == 0 && zoneMinute == 0) || times > 0)) {
                    zoneSign = piece.mark == '+' ? 1 : -1;
                    int n = 0;
                    int length = 0;
                    if (peek().kind == NUMBER) {
                        Piece number = next();
                        length = number.length;
                        n = number.number;
                    }
                    numberRead = true;
                    if (isMark(peek(), ':')) {
                        zoneHour = n;
                        zoneMinute = NONE;
                    } else if (length == 1 || length == 2) {
                        zoneHour = n;
                        zoneMinute = 0;
                    } else if (length == 3 || length == 4) {
                        zoneHour = n / 100;
                        zoneMinute = n % 100;
                    } else {
                        return false;
                    }
                } else if (isSign(piece) && numberRead) {
                    return false;
                }
                // anything else — a space, a colon — is passed over
            }
            return true;
        }

        private double instant() {
            if (days < 1) {
                return Double.NaN;
            }
            while (days < 3) {
                day[days++] = 1;
            }
            int year;
            int month;
            int dayOfMonth;
            if (standard || day[0] < 1 || day[0] > 31) {
                year = day[0];
                month = day[1];
                dayOfMonth = day[2];
            } else {
                // A first number that could be a day is taken for a month: month, day, year.
                month = day[0];
                dayOfMonth = day[1];
                year = day[2];
            }
            if (!standard) {
                if (year >= 0 && year <= 49) {
                    year += 2000;
                } else if (year >= 50 && year <= 99) {
                    year += 1900;
                }
            }
            if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) {
                return Double.NaN;
            }
            while (times < 4) {
                time[times++] = 0;
            }
            if ((time[0] > 23 || time[1] > 59 || time[2] > 59 || time[3] > 999)
                    && (time[0] != 24 || time[1] != 0 || time[2] != 0 || time[3] != 0)) {
                return Double.NaN;
            }
            // A day past the end of its month runs on into the next.
            long total = (LocalDate.of(year, month, 1).toEpochDay() + (dayOfMonth - 1)) * 86_400_000L
                    + ((time[0] * 60L + time[1]) * 60 + time[2]) * 1000 + time[3];
            if (zoneSign != NONE) {
                long hours = zoneHour == NONE ? 0 : zoneHour;
                long minutes = zoneMinute == NONE ? 0 : zoneMinute;
                total -= zoneSign * (hours * 3600 + minutes * 60) * 1000;
            }
            return Math.abs(total) > LIMIT ? Double.NaN : total;
        }
    }
}
