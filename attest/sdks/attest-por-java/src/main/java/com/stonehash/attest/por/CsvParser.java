package com.stonehash.attest.por;

import java.util.ArrayList;
import java.util.List;

/**
 * A CSV reader for one job: reading a balance export without guessing.
 *
 * <p>The file decides a liability total that is then signed and anchored, so
 * the reader's bias is the opposite of a spreadsheet's. A spreadsheet shows
 * something for every input; this stops, with the line number, at the first
 * thing it would otherwise have to interpret — a quote in the middle of a
 * field, text after a closing quote. Each of those is a file two programs
 * would read differently, and that is how a total comes to differ from the
 * ledger it was exported from.
 *
 * <p>A state machine fed text in arbitrary pieces, kept apart from the file
 * handling so it can be driven with the cut placed anywhere — between a CR and
 * its LF, inside {@code ""} — which is exactly where a streaming parser goes
 * wrong.
 */
final class CsvParser {
    /** Receives each record as it completes. */
    interface Sink {
        /** @param line 1-based physical line on which the record starts */
        void record(long line, String[] fields);
    }

    /** The file cannot be read as CSV from this point on. */
    static final class SyntaxError extends Exception {
        private static final long serialVersionUID = 1L;
        final long line;

        SyntaxError(long line, String message) {
            super(message, null, false, false);
            this.line = line;
        }
    }

    private enum State { START, UNQUOTED, QUOTED, QUOTE_IN_QUOTED }

    /**
     * One quoted field longer than this is an unbalanced quote, not data. The
     * reference stops at the same count (of UTF-16 units), so both report the
     * same line for the same file; without a bound, one stray quote would pull
     * the rest of a multi-gigabyte export into a single string.
     */
    static final int MAX_QUOTED_FIELD_CHARS = 1 << 20;

    private final char delimiter;
    private final StringBuilder field = new StringBuilder();
    private final List<String> fields = new ArrayList<>();
    private State state = State.START;
    /** A CR was the last character seen; a following LF belongs to the same line ending. */
    private boolean pendingCr;
    private long line = 1;
    private long recordLine = 1;
    private boolean sawAnything;
    /** The current record has no delimiter, no quote and no character: a line with nothing on it. */
    private boolean blank = true;

    CsvParser(char delimiter) {
        this.delimiter = delimiter;
    }

    void push(char[] text, int offset, int length, Sink sink) throws SyntaxError {
        int from = offset;
        int to = offset + length;
        if (!sawAnything && length > 0) {
            sawAnything = true;
            if (text[from] == '\ufeff') {
                from++;
            }
        }
        for (int i = from; i < to; i++) {
            char c = text[i];

            if (pendingCr) {
                pendingCr = false;
                // CRLF is one line ending; the CR already ended the record.
                if (c == '\n') {
                    continue;
                }
            }

            if (state == State.QUOTED) {
                if (c == '"') {
                    state = State.QUOTE_IN_QUOTED;
                    continue;
                }
                if (c == '\n') {
                    line++;
                }
                field.append(c);
                if (field.length() > MAX_QUOTED_FIELD_CHARS) {
                    throw new SyntaxError(recordLine, "a quoted field never closes (check for an unpaired \" in this record)");
                }
                continue;
            }

            if (state == State.QUOTE_IN_QUOTED) {
                if (c == '"') {
                    field.append('"');
                    state = State.QUOTED;
                    continue;
                }
                // The quote closed the field; only a delimiter or a line end may follow.
                if (c != delimiter && c != '\n' && c != '\r') {
                    throw new SyntaxError(line, "unexpected " + Text.quote(String.valueOf(c))
                            + " after a closing quote (a quote inside a quoted field is written \"\")");
                }
                state = State.UNQUOTED;
            }

            if (c == delimiter) {
                fields.add(field.toString());
                field.setLength(0);
                state = State.START;
                blank = false;
            } else if (c == '\n' || c == '\r') {
                pendingCr = c == '\r';
                endRecord(sink);
                line++;
            } else if (c == '"') {
                if (state != State.START) {
                    throw new SyntaxError(line,
                            "a \" inside an unquoted field (wrap the whole field in quotes and write the quote as \"\")");
                }
                state = State.QUOTED;
                blank = false;
            } else {
                field.append(c);
                state = State.UNQUOTED;
                blank = false;
            }
        }
    }

    /** The end of the input: the last record need not end in a line break. */
    void end(Sink sink) throws SyntaxError {
        if (state == State.QUOTED) {
            throw new SyntaxError(recordLine, "the file ends inside a quoted field (an unpaired \" in this record)");
        }
        endRecord(sink);
    }

    private void endRecord(Sink sink) {
        if (!blank) {
            fields.add(field.toString());
            sink.record(recordLine, fields.toArray(new String[0]));
        }
        field.setLength(0);
        fields.clear();
        state = State.START;
        blank = true;
        recordLine = line + 1;
    }
}
