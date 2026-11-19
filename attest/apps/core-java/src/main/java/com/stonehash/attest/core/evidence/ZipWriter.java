package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * A ZIP archive, written out field by field.
 *
 * <p>Only what the format requires: local headers, the central directory,
 * the end record. No Zip64 (an evidence archive is kilobytes), no
 * encryption, no data descriptors. Members keep the order given, names are
 * UTF-8 and flagged as such, and every member carries the one modification
 * time the caller supplies — never the clock, so that the same evidence
 * exported twice is the same archive.
 *
 * <p>Compression is the platform's DEFLATE, at its default level, and a
 * member that would not get smaller is stored as it is. The compressed bytes
 * are therefore this runtime's: another runtime's DEFLATE packs the same
 * member into other bytes that unpack to the same thing. What a reader
 * relies on is in the archive itself — each member's CRC here, and its
 * SHA-256 in the manifest.
 */
public final class ZipWriter {
    private ZipWriter() {
    }

    /** One member: its path inside the archive (forward slashes, not from the root) and its bytes. */
    public static final class Entry {
        final String path;
        final byte[] data;

        public Entry(String path, byte[] data) {
            this.path = path;
            this.data = data;
        }
    }

    /**
     * @param modifiedAtMs the time written into every member, in milliseconds since 1970 (UTC); DOS time has no zone
     *                     and a resolution of two seconds
     * @param compress     {@code false} stores every member as it is
     */
    public static byte[] write(List<Entry> entries, long modifiedAtMs, boolean compress) {
        if (entries.isEmpty()) {
            throw new PlainError("writeZip: an archive needs at least one entry");
        }
        Set<String> seen = new HashSet<>();
        for (Entry e : entries) {
            if (e.path.startsWith("/") || e.path.contains("..")) {
                throw new PlainError("writeZip: unsafe entry path " + Js.stringify(e.path));
            }
            if (!seen.add(e.path)) {
                throw new PlainError("writeZip: duplicate entry " + e.path);
            }
        }
        ZonedDateTime d = Instant.ofEpochMilli(modifiedAtMs).atZone(ZoneOffset.UTC);
        if (d.getYear() < 1980) {
            throw new PlainError("ZIP cannot represent a date before 1980, got " + IsoTime.ofEpochMilli(modifiedAtMs));
        }
        // Sixteen bits each. A year past 2107 does not fit and loses its high bits, as it always did.
        int date = ((d.getYear() - 1980) << 9) | (d.getMonthValue() << 5) | d.getDayOfMonth();
        int time = (d.getHour() << 11) | (d.getMinute() << 5) | (d.getSecond() / 2);

        Out body = new Out();
        Out central = new Out();
        for (Entry e : entries) {
            byte[] name = e.path.getBytes(StandardCharsets.UTF_8);
            CRC32 sum = new CRC32();
            sum.update(e.data);
            long crc = sum.getValue();
            byte[] packed = compress ? deflate(e.data) : e.data;
            // DEFLATE can come out longer than what went in, on tiny or incompressible members; storing is then smaller.
            boolean deflated = compress && packed.length < e.data.length;
            byte[] payload = deflated ? packed : e.data;
            int method = deflated ? 8 : 0;
            int offset = body.size();

            body.u32(0x04034b50L);              // local file header
            body.u16(deflated ? 20 : 10);       // version needed
            body.u16(0x0800);                   // flags: UTF-8 names
            body.u16(method);
            body.u16(time);
            body.u16(date);
            body.u32(crc);
            body.u32(payload.length);
            body.u32(e.data.length);
            body.u16(name.length);
            body.u16(0);                        // extra field length
            body.writeBytes(name);
            body.writeBytes(payload);

            central.u32(0x02014b50L);           // central directory header
            central.u16(0x031e);                // made by: UNIX, spec 3.0
            central.u16(deflated ? 20 : 10);
            central.u16(0x0800);
            central.u16(method);
            central.u16(time);
            central.u16(date);
            central.u32(crc);
            central.u32(payload.length);
            central.u32(e.data.length);
            central.u16(name.length);
            central.u16(0);                     // extra
            central.u16(0);                     // comment
            central.u16(0);                     // disk number
            central.u16(0);                     // internal attributes
            central.u32(0100644L << 16);        // external attributes: regular file, rw-r--r--
            central.u32(offset);
            central.writeBytes(name);
        }

        Out out = new Out();
        out.writeBytes(body.toByteArray());
        int centralOffset = out.size();
        out.writeBytes(central.toByteArray());
        out.u32(0x06054b50L);                   // end of central directory
        out.u16(0);                             // this disk
        out.u16(0);                             // disk with the central directory
        out.u16(entries.size());
        out.u16(entries.size());
        out.u32(central.size());
        out.u32(centralOffset);
        out.u16(0);                             // archive comment length
        return out.toByteArray();
    }

    private static byte[] deflate(byte[] data) {
        Deflater d = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
        try {
            d.setInput(data);
            d.finish();
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length / 2));
            byte[] chunk = new byte[8192];
            while (!d.finished()) {
                out.write(chunk, 0, d.deflate(chunk));
            }
            return out.toByteArray();
        } finally {
            d.end();
        }
    }

    /** Little-endian fields, appended. */
    private static final class Out extends ByteArrayOutputStream {
        void u16(int n) {
            write(n & 0xff);
            write((n >>> 8) & 0xff);
        }

        void u32(long n) {
            write((int) (n & 0xff));
            write((int) ((n >>> 8) & 0xff));
            write((int) ((n >>> 16) & 0xff));
            write((int) ((n >>> 24) & 0xff));
        }

    }
}
