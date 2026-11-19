package com.stonehash.attest.por;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Reads a balance export — the CSV file an exchange writes from its ledger —
 * into the tree's input (specification §7).
 *
 * <p>Streaming: the file is hashed, decoded and split a buffer at a time, so
 * its size is bounded by the accounts it holds, not by its length in bytes.
 * The result carries a report either way; rows only when the file read
 * cleanly from its first byte to its last.
 *
 * <p>Two layouts are read, because those are the two shapes a ledger exports
 * in — one row per account and asset ({@code account_id,asset,balance}), or
 * one row per account with a column per asset ({@code account_id,BTC,ETH}).
 */
public final class CsvLedger {
    /**
     * The file is decoded a block at a time, and the size is part of what a
     * reader of a damaged file sees: when a block holds bytes that are not
     * UTF-8, the problems found in the blocks before it are kept and nothing
     * from that block on is interpreted. The reference reads in blocks of
     * this size, so both report the same problems for the same file.
     */
    private static final int BLOCK_BYTES = 1 << 16;

    private CsvLedger() {
    }

    /**
     * Reads and checks an export.
     *
     * @throws PorException {@code io_error} when the file cannot be read at all; {@code invalid_option} for
     *                      options that contradict each other. Everything wrong <em>in</em> the file is a
     *                      {@link Problem} in the report, not an exception.
     */
    public static Ledger read(Path file, CsvOptions options) {
        Objects.requireNonNull(file, "file");
        try (InputStream in = Files.newInputStream(file)) {
            return read(in, options);
        } catch (IOException e) {
            throw new PorException("io_error", "could not read " + file + ": " + e.getMessage(), e);
        }
    }

    /** Reads an export from a stream, for one that is not a local file. The stream is read to its end and not closed. */
    public static Ledger read(InputStream in, CsvOptions options) {
        Objects.requireNonNull(in, "in");
        Objects.requireNonNull(options, "options");
        try {
            return new Reading(options).run(in);
        } catch (IOException e) {
            throw new PorException("io_error", "could not read the export: " + e.getMessage(), e);
        }
    }

    /** One pass over one file. */
    private static final class Reading implements CsvParser.Sink {
        private final CsvOptions o;
        private final AssetTable assets;
        private final LedgerBuilder ledger;

        private CsvLayout layout;
        private String[] header;
        private boolean sawHeader;
        private boolean headerOk;
        private long rows;
        private int colAccount = -1;
        private int colAsset = -1;
        private int colBalance = -1;
        /** Wide layout: for the k-th asset column, its index in a record and the asset's position. */
        private int[] assetColumn;
        private int[] assetPosition;
        private String[] cells;
        private final List<String> ignored = new ArrayList<>();

        Reading(CsvOptions o) {
            String account = Text.lowerAscii(o.accountColumn());
            String asset = Text.lowerAscii(o.assetColumn());
            String balance = Text.lowerAscii(o.balanceColumn());
            if (account.equals(asset) || account.equals(balance) || asset.equals(balance)) {
                throw new PorException("invalid_option",
                        "the account, asset and balance columns must be three different columns");
            }
            this.o = o;
            this.ledger = new LedgerBuilder(o.assets(), o.unit()).maxProblems(o.maxProblems());
            // Rows are stored by position in the builder's table, so columns are resolved against that same table.
            this.assets = ledger.assetTable();
            this.layout = o.layout();
        }

        Ledger run(InputStream in) throws IOException {
            MessageDigest sha = Hex.sha256();
            CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT);
            CsvParser parser = new CsvParser(o.delimiter());
            byte[] block = new byte[BLOCK_BYTES];
            // Room for the block and for the first bytes of a character the previous block ended in the middle of.
            ByteBuffer bytes = ByteBuffer.allocate(BLOCK_BYTES + 4);
            CharBuffer chars = CharBuffer.allocate(BLOCK_BYTES + 4);
            long fileBytes = 0;
            // A syntax or encoding error ends interpretation. Reading goes on to
            // the last byte all the same, so that the checksum in the report is
            // that of the whole file and not of the part that parsed.
            boolean stopped = false;

            int n;
            do {
                n = in.readNBytes(block, 0, BLOCK_BYTES);
                sha.update(block, 0, n);
                if (!stopped && n > 0) {
                    bytes.put(block, 0, n).flip();
                    // A block is interpreted only if all of it decodes: text from
                    // a block that turns out not to be UTF-8 is not text to act on.
                    if (decoder.decode(bytes, chars, false).isError()) {
                        notUtf8(fileBytes + n - bytes.remaining());
                        stopped = true;
                    } else {
                        stopped = !parse(parser, chars);
                        bytes.compact();
                    }
                }
                fileBytes += n;
            } while (n == BLOCK_BYTES);

            if (!stopped) {
                bytes.flip();
                if (decoder.decode(bytes, chars, true).isError()) {
                    // The file ends in the middle of a character.
                    notUtf8(fileBytes - bytes.remaining());
                } else {
                    try {
                        parser.end(this);
                    } catch (CsvParser.SyntaxError e) {
                        ledger.problem(e.line, "csv_syntax", e.getMessage());
                    }
                }
            }
            if (!sawHeader && !ledger.hasProblems()) {
                ledger.problem(0, "empty_file", "the file has no header row");
            }
            return ledger.finish(rows, layout, ignored, Hex.encode(sha.digest()), fileBytes);
        }

        /** Hands the decoded text to the parser. False when the file stops being CSV here. */
        private boolean parse(CsvParser parser, CharBuffer chars) {
            try {
                parser.push(chars.array(), 0, chars.position(), this);
                return true;
            } catch (CsvParser.SyntaxError e) {
                ledger.problem(e.line, "csv_syntax", e.getMessage());
                return false;
            } finally {
                chars.clear();
            }
        }

        /**
         * A file in another encoding must stop here. Decoded leniently, every
         * identifier with a non-ASCII character would silently become a
         * different one, and the people it belongs to could never match their
         * proof. The decoder knows the byte, not the line: this is a problem
         * with the file, not with a row.
         */
        private void notUtf8(long nearByte) {
            ledger.problem(0, "file_encoding", "the file is not valid UTF-8 (near byte " + nearByte + "); export it as UTF-8");
        }

        @Override
        public void record(long line, String[] fields) {
            if (!sawHeader) {
                sawHeader = true;
                headerOk = readHeader(fields, line);
                return;
            }
            // Without a usable header the rows cannot be interpreted.
            if (!headerOk) {
                return;
            }
            rows++;
            if (fields.length != header.length) {
                ledger.problem(line, "field_count", fields.length + " field" + (fields.length == 1 ? "" : "s")
                        + ", but the header has " + header.length);
                return;
            }
            if (layout == CsvLayout.LONG) {
                ledger.longRow(line, fields[colAccount], fields[colAsset], fields[colBalance]);
            } else {
                for (int k = 0; k < assetColumn.length; k++) {
                    cells[k] = fields[assetColumn[k]];
                }
                ledger.wideRow(line, fields[colAccount], cells, assetPosition, null);
            }
        }

        /** The header rules of the specification, in order. False when the rows cannot be interpreted. */
        private boolean readHeader(String[] fields, long line) {
            header = new String[fields.length];
            Set<String> seen = new HashSet<>();
            for (int i = 0; i < fields.length; i++) {
                header[i] = Text.trim(fields[i]);
                if (header[i].isEmpty()) {
                    ledger.problem(line, "header_empty_name", "the header has a column with no name");
                    return false;
                }
                if (!seen.add(Text.lowerAscii(header[i]))) {
                    ledger.problem(line, "header_duplicate", "the header names " + Text.quote(header[i]) + " twice");
                    return false;
                }
            }
            colAccount = find(o.accountColumn());
            colAsset = find(o.assetColumn());
            colBalance = find(o.balanceColumn());
            String found = "found: " + Json.compact(Arrays.asList(header));

            if (colAccount < 0) {
                boolean otherDelimiter = header.length == 1
                        && (header[0].indexOf(';') >= 0 || header[0].indexOf('\t') >= 0 || header[0].indexOf('|') >= 0);
                ledger.problem(line, "header_no_account", "no " + Text.quote(o.accountColumn()) + " column in the header (" + found + ")"
                        + (otherDelimiter ? " — the file may use another delimiter; state it in the options"
                                : "; name the account column in the options if it is called something else"));
                return false;
            }

            if (layout == null) {
                if (colAsset >= 0 && colBalance >= 0) {
                    layout = CsvLayout.LONG;
                } else if (hasAssetLikeColumn()) {
                    layout = CsvLayout.WIDE;
                } else if (colAsset >= 0 || colBalance >= 0) {
                    layout = CsvLayout.LONG;
                } else {
                    // Naming one layout here would send the reader after the wrong fix.
                    ledger.problem(line, "header_unrecognised", "the header matches neither layout (" + found + "). Long: "
                            + o.accountColumn() + "," + o.assetColumn() + "," + o.balanceColumn()
                            + " — one row per account and asset. Wide: " + o.accountColumn()
                            + " and one column per declared asset (" + String.join(", ", assets.symbols)
                            + "). Columns with other names can be mapped in the options.");
                    return false;
                }
            }

            if (layout == CsvLayout.LONG) {
                if (colAsset < 0 || colBalance < 0) {
                    String missing = colAsset < 0 && colBalance < 0
                            ? "s " + Text.quote(o.assetColumn()) + " and " + Text.quote(o.balanceColumn())
                            : " " + Text.quote(colAsset < 0 ? o.assetColumn() : o.balanceColumn());
                    ledger.problem(line, "header_missing_column", "the long layout needs the column" + missing + " (" + found
                            + "); map a differently named column in the options");
                    return false;
                }
                for (int i = 0; i < header.length; i++) {
                    if (i != colAccount && i != colAsset && i != colBalance) {
                        ignored.add(header[i]);
                    }
                }
                return true;
            }

            // Wide: every other column is an asset, or has been named as ignorable.
            Set<String> ignorable = new HashSet<>();
            for (String name : o.ignoreColumns()) {
                ignorable.add(Text.lowerAscii(name));
            }
            boolean ok = true;
            int[] columnOf = new int[assets.size()];
            Arrays.fill(columnOf, -1);
            List<Integer> order = new ArrayList<>();
            Set<String> refused = new HashSet<>();
            for (int i = 0; i < header.length; i++) {
                if (i == colAccount) {
                    continue;
                }
                int position = assets.indexOf(header[i]);
                if (position >= 0) {
                    columnOf[position] = i;
                    order.add(position);
                } else if (ignorable.contains(Text.lowerAscii(header[i]))) {
                    ignored.add(header[i]);
                } else {
                    ok = false;
                    refused.add(Text.lowerAscii(header[i]));
                    String near = assets.nearMatch(header[i]);
                    ledger.problem(line, "header_unknown_column", near != null
                            ? "column " + Text.quote(header[i]) + " differs from the declared asset " + near
                                    + " only by letter case; asset symbols are matched exactly"
                            : "column " + Text.quote(header[i]) + " is not a declared asset; declare it if it is a balance, "
                                    + "or name it as a column to ignore if it is not");
                }
            }
            for (int position = 0; position < columnOf.length; position++) {
                // An asset whose column was just refused for its letter case has been reported once already.
                if (columnOf[position] < 0 && !refused.contains(Text.lowerAscii(assets.symbols[position]))) {
                    ok = false;
                    ledger.problem(line, "header_missing_asset", "declared asset " + assets.symbols[position]
                            + " has no column; do not declare it if the exchange holds none");
                }
            }
            assetColumn = new int[order.size()];
            assetPosition = new int[order.size()];
            for (int k = 0; k < assetColumn.length; k++) {
                assetPosition[k] = order.get(k);
                assetColumn[k] = columnOf[assetPosition[k]];
            }
            cells = new String[assetColumn.length];
            return ok;
        }

        private int find(String name) {
            String wanted = Text.lowerAscii(name);
            for (int i = 0; i < header.length; i++) {
                if (Text.lowerAscii(header[i]).equals(wanted)) {
                    return i;
                }
            }
            return -1;
        }

        private boolean hasAssetLikeColumn() {
            for (int i = 0; i < header.length; i++) {
                if (i != colAccount && assets.nearMatch(header[i]) != null) {
                    return true;
                }
            }
            return false;
        }
    }
}
