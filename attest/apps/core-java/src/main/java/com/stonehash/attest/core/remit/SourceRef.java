package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.json.Js;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What tells one payment from another, out of the reference to its SWIFT
 * message that the bank signed into the instruction
 * ({@code bankInstruction.sourceMessage}).
 *
 * <p>{@code sha256} and {@code index} name one transaction of one file.
 * {@code uetr} names a payment by itself. {@code content} is the bank's own
 * digest of what makes the payment this payment (amounts, parties, accounts,
 * identifiers, remittance text).
 *
 * <p>{@code twinKey} stands for the same payment written out again in other
 * bytes:
 * <ul>
 * <li>where the payment carries an instruction or an end-to-end identifier:
 *     those two, the value date and the content — whatever message it stands
 *     in. An MT103 once with and once without its header blocks; a payment
 *     retried alone after it went out in a batch;
 * <li>where it carries neither (a pain.001 whose only number is the file's
 *     message id): the message type, the message id, the position in the
 *     message, the value date and the content. The same file exported again
 *     with a new creation time. Under another message id nothing tells such
 *     a payment from a new one, and none is claimed.
 * </ul>
 *
 * <p>The twin key is stored ({@code remit_source_refs.twin_key}) and rows
 * written by the service before this one are compared with it: it is the
 * SHA-256 of the text JavaScript's {@code JSON.stringify} gives for a list
 * of these values — not of a canonical form, and not of anything else.
 */
public final class SourceRef {
    public final String messageType;
    /** Lower-case hex. */
    public final String sha256;
    public final long index;
    /** Lower case, or {@code null}. */
    public final String uetr;
    /** The value date the message states, {@code YYYY-MM-DD}, or {@code null} when it states none. */
    public final String valueDate;
    /** Lower-case hex, or {@code null}. */
    public final String content;
    public final String twinKey;
    /** The message states no value date: its twin key cannot tell one day's payment from another's. */
    public final boolean undated;

    private SourceRef(String messageType, String sha256, long index, String uetr, String valueDate, String content, String twinKey) {
        this.messageType = messageType;
        this.sha256 = sha256;
        this.index = index;
        this.uetr = uetr;
        this.valueDate = valueDate;
        this.content = content;
        this.twinKey = twinKey;
        this.undated = valueDate == null;
    }

    private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", Pattern.CASE_INSENSITIVE);
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}", Pattern.CASE_INSENSITIVE);
    /** The words the standards write where there is no reference. */
    private static final Pattern NO_REFERENCE = Pattern.compile("(NOTPROVIDED|NONREF|NOREF)", Pattern.CASE_INSENSITIVE);
    private static final Pattern DAY = Pattern.compile("([0-9]{4})-([0-9]{2})-([0-9]{2})");

    /** Is this a UETR as the ledger's exact lookup takes one: a UUID, in either case. */
    static boolean isUuid(String s) {
        return UUID.matcher(s).matches();
    }

    /** Is this a SHA-256 digest in hex, in either case. */
    static boolean isDigest(String s) {
        return DIGEST.matcher(s).matches();
    }

    /**
     * {@code YYYY-MM-DD}, and a day the calendar has. The years 0000 to 0099
     * are not read as such by the service this one replaces (its runtime
     * takes a two-digit year for one of the twentieth century), so no day of
     * theirs is one here either.
     */
    static boolean isCalendarDay(String v) {
        Matcher m = DAY.matcher(v);
        if (!m.matches()) {
            return false;
        }
        int year = Integer.parseInt(m.group(1));
        if (year < 100) {
            return false;
        }
        try {
            LocalDate.of(year, Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
            return true;
        } catch (DateTimeException e) {
            return false;
        }
    }

    private static ServiceError bad(String what) {
        return new ServiceError(400, "invalid_source_message", "evidence_elements.bankInstruction.sourceMessage: " + what);
    }

    /** A member that is text of at most so many characters, or {@code null} where it is absent or {@code null}. */
    private static String text(Map<?, ?> m, String key, int max) {
        Object v = m.get(key);
        if (v == null || v == Js.UNDEFINED) {
            return null;
        }
        if (!(v instanceof String) || ((String) v).length() > max) {
            throw bad(key + " must be text of at most " + max + " characters");
        }
        return (String) v;
    }

    /**
     * Read the signed source-message reference. {@code null} when the
     * instruction was not made from a message.
     *
     * <p>A reference that is there but cannot be what it claims to be is
     * refused: a UETR that is not a UUID, a digest that is not a digest, a
     * value date that is not a day. Taken as written, it would never equal
     * the same reference written properly, and the payment would walk past
     * the duplicate check it is signed for. What never tells two references
     * apart is normalised instead: letter case in a UETR or a digest, white
     * space around an identifier, and the words that stand for "no
     * end-to-end id".
     *
     * @throws ServiceError 400 {@code invalid_source_message}
     */
    public static SourceRef of(Object sourceMessage) {
        if (sourceMessage == null || sourceMessage == Js.UNDEFINED) {
            return null;
        }
        if (!(sourceMessage instanceof Map)) {
            throw bad("must be an object");
        }
        Map<?, ?> m = (Map<?, ?>) sourceMessage;
        String messageType = text(m, "type", 40);
        if (messageType == null || messageType.isEmpty()) {
            throw bad("type is required (the message type, e.g. pacs.008.001.08 or MT103)");
        }
        String sha256 = text(m, "sha256", 64);
        if (sha256 == null || !DIGEST.matcher(sha256).matches()) {
            throw bad("sha256 is required: the SHA-256 of the message as the bank's system wrote it, in hex");
        }
        Object given = m.get("index");
        long index = 0;
        if (given != null && given != Js.UNDEFINED) {
            double d = given instanceof Double ? (Double) given : Double.NaN;
            if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d) || d < 0 || d > 1_000_000) {
                throw bad("index must be the position of the transaction in its message, counted from 0");
            }
            index = (long) d;
        }
        String uetr = text(m, "uetr", 36);
        if (uetr != null && !UUID.matcher(uetr).matches()) {
            throw bad("uetr must be a UUID");
        }
        String content = text(m, "content", 64);
        if (content != null && !DIGEST.matcher(content).matches()) {
            throw bad("content must be a SHA-256 digest in hex");
        }
        String valueDate = text(m, "valueDate", 32);
        if (valueDate != null && !isCalendarDay(valueDate)) {
            throw bad("valueDate must be a calendar day written YYYY-MM-DD");
        }
        String instructionId = trimmed(text(m, "instructionId", 256));
        String endToEnd = trimmed(text(m, "endToEndId", 256));
        String messageId = trimmed(text(m, "messageId", 256));
        String normalContent = content == null ? null : content.toLowerCase(Locale.ROOT);
        return new SourceRef(messageType, sha256.toLowerCase(Locale.ROOT), index, uetr == null ? null : uetr.toLowerCase(Locale.ROOT), valueDate,
                normalContent, twinKey(messageType, index, normalContent, instructionId, NO_REFERENCE.matcher(endToEnd).matches() ? "" : endToEnd,
                        messageId, valueDate == null ? "" : valueDate));
    }

    private static String trimmed(String s) {
        return s == null ? "" : Js.trim(s);
    }

    /** The text whose SHA-256 is the twin key of a reference whose parts have been read and normalised, or {@code null} where it has no key. */
    static String twinKeyText(String messageType, long index, String content, String instructionId, String endToEndId, String messageId, String valueDate) {
        if (content == null) {
            return null;
        }
        List<Object> parts = new ArrayList<>();
        if (!instructionId.isEmpty() || !endToEndId.isEmpty()) {
            parts.add("stonehash:remit:twin:v1");
            parts.add(instructionId);
            parts.add(endToEndId);
            parts.add(valueDate);
            parts.add(content);
        } else if (!messageId.isEmpty()) {
            parts.add("stonehash:remit:twin-by-message:v1");
            parts.add(messageType);
            parts.add(messageId);
            parts.add((double) index);
            parts.add(valueDate);
            parts.add(content);
        } else {
            return null;
        }
        return Js.stringify(parts);
    }

    static String twinKey(String messageType, long index, String content, String instructionId, String endToEndId, String messageId, String valueDate) {
        String text = twinKeyText(messageType, index, content, instructionId, endToEndId, messageId, valueDate);
        return text == null ? null : Hex.encode(Hex.sha256(text.getBytes(StandardCharsets.UTF_8)));
    }
}
