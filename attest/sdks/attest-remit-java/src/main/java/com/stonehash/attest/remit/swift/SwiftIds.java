package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Hex;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The identity of a payment read from a SWIFT message, and the ISO 20022 names of what it carried. */
public final class SwiftIds {
    private SwiftIds() {
    }

    /** FIN field tag → the ISO 20022 element the same content travels in. */
    private static final Map<String, List<String>> MT_TO_ISO = mtToIso();

    private static Map<String, List<String>> mtToIso() {
        Map<String, List<String>> m = new HashMap<>();
        m.put("20", Arrays.asList("InstrId"));
        m.put("121", Arrays.asList("UETR"));
        m.put("32A", Arrays.asList("IntrBkSttlmAmt", "IntrBkSttlmDt"));
        m.put("33B", Arrays.asList("InstdAmt"));
        m.put("36", Arrays.asList("XchgRate"));
        m.put("50A", Arrays.asList("Dbtr", "DbtrAcct"));
        m.put("50F", Arrays.asList("Dbtr", "DbtrAcct"));
        m.put("50K", Arrays.asList("Dbtr", "DbtrAcct"));
        m.put("52A", Arrays.asList("DbtrAgt"));
        m.put("52D", Arrays.asList("DbtrAgt"));
        m.put("56A", Arrays.asList("IntrmyAgt1"));
        m.put("56C", Arrays.asList("IntrmyAgt1"));
        m.put("56D", Arrays.asList("IntrmyAgt1"));
        m.put("57A", Arrays.asList("CdtrAgt"));
        m.put("57C", Arrays.asList("CdtrAgt"));
        m.put("57D", Arrays.asList("CdtrAgt"));
        m.put("59", Arrays.asList("Cdtr", "CdtrAcct"));
        m.put("59A", Arrays.asList("Cdtr", "CdtrAcct"));
        m.put("59F", Arrays.asList("Cdtr", "CdtrAcct"));
        m.put("70", Arrays.asList("RmtInf"));
        m.put("71A", Arrays.asList("ChrgBr"));
        m.put("26T", Arrays.asList("Purp"));
        m.put("77B", Arrays.asList("RgltryRptg"));
        return Collections.unmodifiableMap(m);
    }

    /**
     * The ISO 20022 element names a parsed message's content corresponds to:
     * for pacs.008 and pain.001 the elements the message contained (but
     * {@code PmtId}), for an MT103 the elements its field tags travel in, each
     * once, in the order first met.
     */
    public static List<String> isoFieldNames(SwiftPayment payment) {
        if (!"MT103".equals(payment.format)) {
            List<String> out = new ArrayList<>();
            for (String n : payment.present) {
                if (!"PmtId".equals(n)) {
                    out.add(n);
                }
            }
            return out;
        }
        Set<String> out = new LinkedHashSet<>();
        for (String tag : payment.present) {
            List<String> iso = MT_TO_ISO.get(tag);
            if (iso != null) {
                out.addAll(iso);
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * The payment id a SWIFT message always maps to. It is derived from the
     * message's own references and from nothing else — the UETR when there is
     * one — so the same payment written out again (a retry, a re-export the
     * next day, a file dropped twice) names the same settlement instead of
     * creating a second one. The creation time is no part of it.
     *
     * <p>Without a UETR the identity is the message's own identifiers and its
     * value date — the reference-and-date rule a bank's duplicate check uses,
     * so a reference that a system reuses on a later day is a new payment. The
     * position in the file is part of it only where the identifiers do not tell
     * the file's transactions apart. An end-to-end id that is a word for "none"
     * ({@code NOTPROVIDED}, {@code NONREF}, {@code NOREF}, in any case, white
     * space around it ignored) is no identifier: written so or left out, the
     * payment is the same payment.
     *
     * <p>The form is {@code PAY-<8>-<10>}. For a message with a UETR the first
     * group is the UETR's own first group, so an operator can match the id to
     * the bank's reference by eye; the second is a hash that also covers the
     * institution.
     */
    public static String paymentId(String institutionId, SwiftPayment payment) {
        String identity;
        if (Js.truthy(payment.uetr)) {
            identity = "uetr|" + payment.uetr;
        } else if (Js.truthy(payment.messageId) || Js.truthy(payment.instructionId)) {
            // [...].join('|'): a missing entry is written as nothing.
            identity = String.join("|", "ids", Js.or(payment.messageType, ""), Js.or(payment.messageId, ""),
                    Js.or(payment.instructionId, ""),
                    // An end-to-end id that is a word for "none" is no identifier; one that is, goes in as written.
                    SwiftMapper.ownReference(payment.endToEndId) == null ? "" : payment.endToEndId,
                    Js.or(payment.valueDate, ""),
                    payment.distinctIds() ? "" : "#" + payment.index);
        } else {
            identity = "bytes|" + SwiftMapper.template(payment.digest) + "|" + payment.index;
        }
        String hash = Hex.encode(Hex.sha256().digest(utf8(SwiftMapper.template(institutionId) + "\n" + identity)));
        return Js.truthy(payment.uetr)
                ? "PAY-" + Js.slice(payment.uetr, 0, 8) + "-" + Js.slice(hash, 0, 10)
                : "PAY-" + Js.slice(hash, 0, 8) + "-" + Js.slice(hash, 8, 18);
    }

    /** The UTF-8 bytes the reference hashes a string as: a surrogate without its pair becomes U+FFFD. */
    private static byte[] utf8(String s) {
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
}
