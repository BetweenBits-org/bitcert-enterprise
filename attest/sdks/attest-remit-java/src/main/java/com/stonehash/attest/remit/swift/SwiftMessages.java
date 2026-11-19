package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Hex;
import com.stonehash.attest.remit.Text;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.MalformedInputException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One entry point for the three message families.
 *
 * <p>The caller hands over the message exactly as the bank's system wrote it —
 * the bytes of the file, or a string — and gets the payment(s) inside. The
 * SHA-256 recorded on each payment is over those exact bytes, so the digest
 * of the bank's own copy of the file reproduces the value that later appears,
 * signed, in the settlement evidence.
 *
 * <p>A file may hold more than one payment: a pacs.008 or pain.001 with
 * several transactions, a wrapper around several documents, several MT103 one
 * after another. Every one of them is returned, in order — a file is never
 * read as "the first payment in it".
 */
final class SwiftMessages {
    private SwiftMessages() {
    }

    /** The same bound for every family: no payment message is anywhere near it. */
    static final int MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

    /**
     * The reference's {@code /^(?:\xEF\xBB\xBF)?\s*<\?xml[^>]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/},
     * run on the first 200 bytes read as Latin-1. The label is taken whole, up
     * to its closing quote — spaces, a colon and all — so that one the reader
     * cannot match is refused, never passed over for the default. {@code \s} is
     * the ECMAScript set, and {@code \b} before {@code encoding} means the
     * character before it is not an ASCII word character.
     */
    private static final Pattern XML_DECLARED_ENCODING = Pattern.compile("^(?:\\u00EF\\u00BB\\u00BF)?" + Js.WS + "*<\\?xml[^>]*?(?<![A-Za-z0-9_])encoding"
            + Js.WS + "*=" + Js.WS + "*(?:\"([^\"]*)\"|'([^']*)')");

    /**
     * The encodings an XML message may declare, with every label each goes by
     * (the reference's {@code XML_ENCODING_LABELS}, in its order). A label is
     * matched as WHATWG matches it — ASCII letters in either case, the white
     * space around it ignored — and any other label refuses the message. The
     * single-byte ones are decoded here, by the reference's own rules, not by
     * a platform table:
     * <pre>
     *   utf-8, utf-16le, utf-16be   a strict decoder
     *   iso-8859-1                  each byte is the code point of the same number
     *   us-ascii                    the same, and a byte above 0x7F refuses the message
     *   windows-1252                the code page itself: 0x80–0x9F by the table below
     * </pre>
     */
    private static final Map<String, List<String>> XML_ENCODING_LABELS = encodingLabels();
    /** Label (lower case) → encoding. */
    private static final Map<String, String> XML_ENCODING_OF = encodingOf();

    private static Map<String, List<String>> encodingLabels() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("utf-8", Arrays.asList("utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"));
        m.put("utf-16le", Arrays.asList("utf-16", "utf-16le", "ucs-2", "unicode", "csunicode", "iso-10646-ucs-2", "unicodefeff"));
        m.put("utf-16be", Arrays.asList("utf-16be", "unicodefffe"));
        m.put("iso-8859-1", Arrays.asList("iso-8859-1", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "iso-ir-100", "csisolatin1",
                "latin1", "l1", "cp819", "ibm819"));
        m.put("us-ascii", Arrays.asList("us-ascii", "ascii", "ansi_x3.4-1968"));
        m.put("windows-1252", Arrays.asList("windows-1252", "cp1252", "x-cp1252"));
        return Collections.unmodifiableMap(m);
    }

    private static Map<String, String> encodingOf() {
        Map<String, String> m = new HashMap<>();
        for (Map.Entry<String, List<String>> e : XML_ENCODING_LABELS.entrySet()) {
            for (String label : e.getValue()) {
                m.put(label, e.getKey());
            }
        }
        return Collections.unmodifiableMap(m);
    }

    /**
     * windows-1252 bytes 0x80–0x9F, from the WHATWG index; every other byte is
     * the code point of the same number. The five the code page leaves
     * unassigned — 0x81, 0x8D, 0x8F, 0x90, 0x9D — stay U+0081 … as WHATWG has them.
     */
    private static final int[] WINDOWS_1252_80_9F = {
        /* 0x80 */ 0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
        /* 0x88 */ 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
        /* 0x90 */ 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
        /* 0x98 */ 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
    };

    /** Every customer credit transfer the message — or the file of messages — carries. */
    static List<SwiftPayment> parseAll(byte[] message) {
        if (message.length > MAX_MESSAGE_BYTES) {
            throw tooLarge();
        }
        return parseDecoded(message, textOf(message));
    }

    /**
     * The same for a message held as text: its bytes are its UTF-8 form, and
     * the bound is on those bytes. Counted in UTF-16 units, up to three times
     * the bound got through; no unit is less than one byte of UTF-8, so the
     * length alone refuses first wherever it can.
     */
    static List<SwiftPayment> parseAll(String message) {
        if (message.length() > MAX_MESSAGE_BYTES) {
            throw tooLarge();
        }
        byte[] bytes = utf8Lossy(message);
        if (bytes.length > MAX_MESSAGE_BYTES) {
            throw tooLarge();
        }
        return parseDecoded(bytes, message);
    }

    /**
     * The one payment in a message. A message carrying several transactions is
     * refused unless {@code index} says which one — a payment instruction must
     * never be picked by accident.
     */
    static SwiftPayment parse(List<SwiftPayment> all, Integer index) {
        if (index != null) {
            if (index < 0 || index >= all.size()) {
                throw new SwiftMessageException("invalid_field",
                        "the message carries " + all.size() + " transaction(s); there is no transaction at index " + index);
            }
            return all.get(index);
        }
        if (all.size() != 1) {
            throw new SwiftMessageException("multiple_transactions",
                    "the message carries " + all.size() + " transactions — pass an index to choose one, or use Swift.parseAll() to take each in turn");
        }
        return all.get(0);
    }

    private static SwiftMessageException tooLarge() {
        return new SwiftMessageException("malformed_message",
                "the message is larger than " + MAX_MESSAGE_BYTES + " bytes — split the file; no payment message is that large");
    }

    /** Bytes that are not valid in the encoding the message is read in. */
    private static SwiftMessageException notValidIn(String how) {
        return new SwiftMessageException("malformed_message",
                "the message " + how + " but holds bytes that are not valid in it — "
                        + "it was written in another code page; export it as UTF-8, or declare the encoding it is really in");
    }

    private static List<SwiftPayment> parseDecoded(byte[] bytes, String text) {
        if (Js.blank(text)) {
            throw new SwiftMessageException("not_a_swift_message", "the message is empty");
        }
        String digest = Hex.sha256Hex(bytes);
        if (Iso20022Reader.looksLikeXml(text)) {
            return markDistinct(Iso20022Reader.parse(text, digest));
        }
        if (Mt103Reader.looksLikeMt(text)) {
            return markDistinct(Mt103Reader.parse(text, digest));
        }
        throw new SwiftMessageException("not_a_swift_message",
                "neither an ISO 20022 XML document (pacs.008, pain.001) nor a FIN message (MT103) — "
                        + "the text starts with \"" + Js.collapse(Js.slice(Js.trim(text), 0, 24)) + "\"");
    }

    /** What the bytes start with decides how they are read: XML says its own encoding. */
    private static String textOf(byte[] message) {
        int k = message.length >= 3 && (message[0] & 0xff) == 0xef && (message[1] & 0xff) == 0xbb && (message[2] & 0xff) == 0xbf ? 3 : 0;
        while (k < message.length && (message[k] == 0x20 || message[k] == 0x09 || message[k] == 0x0a || message[k] == 0x0d)) {
            k++;
        }
        boolean xml = (k < message.length && message[k] == 0x3c) || startsWith(message, 0xff, 0xfe) || startsWith(message, 0xfe, 0xff);
        if (xml) {
            return decodeXml(message);
        }
        try {
            return stripBom(strict(StandardCharsets.UTF_8, message));
        } catch (CharacterCodingException e) {
            // FIN text is ASCII in practice; a legacy export in a single-byte code
            // page still reads correctly for every character the X character set allows.
            String text = new String(message, StandardCharsets.ISO_8859_1);
            // XML is never read in a guessed code page — not even when something
            // before its first "<" (a no-break space …) kept it from being seen as XML
            // above. It is refused as the same bytes without that character are.
            if (Iso20022Reader.looksLikeXml(text)) {
                throw notValidIn("is read as UTF-8");
            }
            return text;
        }
    }

    private static boolean startsWith(byte[] b, int first, int second) {
        return b.length >= 2 && (b[0] & 0xff) == first && (b[1] & 0xff) == second;
    }

    /** The white space a label may stand in: {@code [\t\n\f\r ]}, no more (not U+000B, not a no-break space). */
    private static boolean labelSpace(char c) {
        return c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' ';
    }

    /** {@code label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')}. */
    private static String trimLabel(String label) {
        int from = 0;
        int to = label.length();
        while (from < to && labelSpace(label.charAt(from))) {
            from++;
        }
        while (to > from && labelSpace(label.charAt(to - 1))) {
            to--;
        }
        return label.substring(from, to);
    }

    /**
     * The bytes of an XML message as text, in the encoding the message itself
     * declares (UTF-8 when it declares none). Bytes that are not valid in that
     * encoding refuse the message: guessing another code page would turn a
     * company's name into different characters and carry them, unremarked,
     * into the Travel Rule data.
     */
    private static String decodeXml(byte[] bytes) {
        Charset utf16 = startsWith(bytes, 0xff, 0xfe) ? StandardCharsets.UTF_16LE : startsWith(bytes, 0xfe, 0xff) ? StandardCharsets.UTF_16BE : null;
        if (utf16 != null) {
            try {
                return stripBom(strict(utf16, bytes));
            } catch (CharacterCodingException e) {
                throw new SwiftMessageException("malformed_message",
                        "the message starts with a UTF-16 byte-order mark but holds bytes that are not valid UTF-16 — the file is cut off or damaged");
            }
        }
        // The declaration is ASCII in every encoding this reader takes.
        String head = new String(bytes, 0, Math.min(bytes.length, 200), StandardCharsets.ISO_8859_1);
        Matcher m = XML_DECLARED_ENCODING.matcher(head);
        String declared = m.find() ? (m.group(1) != null ? m.group(1) : m.group(2)) : "UTF-8";
        String name = trimLabel(declared);
        String encoding = XML_ENCODING_OF.get(Text.lowerAscii(name));
        if (encoding == null) {
            throw new SwiftMessageException("malformed_message",
                    "the message declares encoding \"" + declared + "\", which this reader does not know — send it as UTF-8");
        }
        if (encoding.equals("utf-8") || encoding.equals("utf-16le") || encoding.equals("utf-16be")) {
            Charset charset = encoding.equals("utf-8") ? StandardCharsets.UTF_8
                    : encoding.equals("utf-16le") ? StandardCharsets.UTF_16LE : StandardCharsets.UTF_16BE;
            try {
                return stripBom(strict(charset, bytes));
            } catch (CharacterCodingException e) {
                throw notValidIn(encoding.equals("utf-8") ? "is read as UTF-8" : "declares " + name);
            }
        }
        if (encoding.equals("us-ascii")) {
            for (byte b : bytes) {
                if ((b & 0xff) > 0x7f) {
                    throw new SwiftMessageException("malformed_message",
                            "the message declares " + name + " but holds bytes that are not ASCII — "
                                    + "it was written in another code page; export it as UTF-8, or declare the encoding it is really in");
                }
            }
        }
        // ISO-8859-1, US-ASCII and windows-1252: each byte is the code point of the same number …
        char[] chars = new char[bytes.length];
        boolean cp1252 = encoding.equals("windows-1252");
        for (int k = 0; k < bytes.length; k++) {
            int b = bytes[k] & 0xff;
            // … but for windows-1252's own 0x80–0x9F.
            chars[k] = (char) (cp1252 && b >= 0x80 && b <= 0x9f ? WINDOWS_1252_80_9F[b - 0x80] : b);
        }
        return new String(chars);
    }

    private static String strict(Charset charset, byte[] bytes) throws CharacterCodingException {
        if (charset.equals(StandardCharsets.UTF_16LE) || charset.equals(StandardCharsets.UTF_16BE)) {
            return utf16(bytes, charset.equals(StandardCharsets.UTF_16LE));
        }
        CharsetDecoder decoder = charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
        return decoder.decode(ByteBuffer.wrap(bytes)).toString();
    }

    /**
     * UTF-16 as the reference's {@code new TextDecoder(…, { fatal: true })}
     * reads it: the bytes are whole code units, a high surrogate is followed
     * by a low one and a low one follows a high one — anything else refuses.
     * Every other code unit is the character, U+FFFE and U+FFFF included. (The
     * JDK's own UTF-16 decoders refuse U+FFFE anywhere in the text, as a
     * byte-order mark the wrong way round, where the reference reads it.)
     */
    private static String utf16(byte[] bytes, boolean littleEndian) throws CharacterCodingException {
        if (bytes.length % 2 != 0) {
            throw new MalformedInputException(1);
        }
        char[] units = new char[bytes.length / 2];
        for (int k = 0; k < units.length; k++) {
            int a = bytes[2 * k] & 0xff;
            int b = bytes[2 * k + 1] & 0xff;
            units[k] = (char) (littleEndian ? a | b << 8 : a << 8 | b);
        }
        for (int k = 0; k < units.length; k++) {
            if (Character.isHighSurrogate(units[k])) {
                if (k + 1 >= units.length || !Character.isLowSurrogate(units[k + 1])) {
                    throw new MalformedInputException(2);
                }
                k++;
            } else if (Character.isLowSurrogate(units[k])) {
                throw new MalformedInputException(2);
            }
        }
        return new String(units);
    }

    /** A decoder drops the byte-order mark it was told the encoding by. */
    private static String stripBom(String s) {
        return !s.isEmpty() && s.charAt(0) == '﻿' ? s.substring(1) : s;
    }

    /** The UTF-8 form of a string; a surrogate without its pair becomes U+FFFD, as it does in the reference. */
    private static byte[] utf8Lossy(String s) {
        CharsetEncoder encoder = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE)
                .replaceWith(new byte[] {(byte) 0xef, (byte) 0xbf, (byte) 0xbd});
        try {
            ByteBuffer out = encoder.encode(CharBuffer.wrap(s));
            return Arrays.copyOfRange(out.array(), out.arrayOffset(), out.arrayOffset() + out.limit());
        } catch (CharacterCodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Say, for each payment, whether its identifiers alone tell it from the
     * others in the same text. Where they do, the payment is the same payment
     * wherever in a file it stands; where a system writes the same identifiers
     * on every transaction, only the position is left to tell them apart. An
     * end-to-end id is the payment's own reference only as
     * {@link SwiftMapper#ownReference} has it — the one notion of "no
     * reference", wherever a reference is read.
     */
    private static List<SwiftPayment> markDistinct(List<SwiftPayment> all) {
        Map<List<String>, Integer> counts = new HashMap<>();
        for (SwiftPayment p : all) {
            counts.merge(key(p), 1, Integer::sum);
        }
        for (SwiftPayment p : all) {
            boolean own = Js.truthy(p.instructionId) || SwiftMapper.ownReference(p.endToEndId) != null;
            p.distinctIds = own && counts.get(key(p)) == 1;
        }
        return all;
    }

    /** {@code [messageType, messageId ?? '', instructionId ?? '', the end-to-end id when it is one, valueDate ?? '']}. */
    private static List<String> key(SwiftPayment p) {
        List<String> k = new ArrayList<>();
        k.add(p.messageType);
        k.add(Js.or(p.messageId, ""));
        k.add(Js.or(p.instructionId, ""));
        // As stated, not trimmed: the reference keys on the value itself once it is a reference.
        k.add(SwiftMapper.ownReference(p.endToEndId) == null ? "" : p.endToEndId);
        k.add(Js.or(p.valueDate, ""));
        return k;
    }
}
