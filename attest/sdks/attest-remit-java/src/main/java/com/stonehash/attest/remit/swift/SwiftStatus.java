package com.stonehash.attest.remit.swift;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A settlement's state as an ISO 20022 transaction status: the code a bank's
 * payment system reads ({@code ACTC}, {@code ACSP}, {@code ACCC},
 * {@code PDNG}, {@code RJCT}), the platform's reason word, and what a person
 * needs to know.
 *
 * <p>{@code CANC} is deliberately not among the codes: a payment hub reads a
 * {@code pacs.002} by the interbank codes, so a payment withdrawn at the
 * bank's request is reported {@code RJCT} with the reason
 * {@code CANCELLED_BY_BANK}.
 *
 * <p>Made by {@link Swift#statusOf}, from the settlement view as it was
 * handed over. Any view gives a status: where the view holds something other
 * than what is expected in a place, that place reads as absent.
 */
public final class SwiftStatus {
    String code;
    String meaning;
    String state;
    /** The reason word, or null when the status carries none. */
    String reason;
    final List<String> detail = new ArrayList<>();
    boolean isFinal;
    String needs;
    String creditReference;
    String at;
    String acceptedAt;

    SwiftStatus() {
    }

    /** ISO 20022 transaction status: {@code ACTC}, {@code ACSP}, {@code ACCC}, {@code PDNG} or {@code RJCT}. */
    public String code() {
        return code;
    }

    /** What the code means, in the standard's words. */
    public String meaning() {
        return meaning;
    }

    /** The platform state it was derived from — {@code UNKNOWN} where the view states none as text. */
    public String state() {
        return state;
    }

    /** The platform's reason word, when the status needs one; null otherwise. */
    public String reason() {
        return reason;
    }

    /** Detail for a person: questions asked, the refusal, the return. */
    public List<String> detail() {
        return Collections.unmodifiableList(detail);
    }

    /** The outcome is settled: paid, cancelled, refused or returned. */
    public boolean isFinal() {
        return isFinal;
    }

    /**
     * Who has to act before the payment moves again, when it will not move by
     * itself: {@code bank_answer} — the receiving institution asked a question;
     * {@code manual_resolution} — processing stopped, the platform will send no
     * further status on its own, and a person resolves it. Null otherwise.
     */
    public String needs() {
        return needs;
    }

    /** The beneficiary bank's own credit reference, once the payout is confirmed; null before. */
    public String creditReference() {
        return creditReference;
    }

    /**
     * Time of the event the status reflects — null when that event is not
     * there or carries no time in the platform's form. Never another event's.
     */
    public String at() {
        return at;
    }

    /** When the platform accepted the instruction, or null. */
    public String acceptedAt() {
        return acceptedAt;
    }

    /**
     * The status as the TypeScript SDK's JSON has it: {@code code},
     * {@code meaning}, {@code state}, {@code reason}, {@code detail},
     * {@code final}, {@code at}, {@code acceptedAt}, {@code needs},
     * {@code creditReference} — a value that is not there is absent.
     */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", code);
        out.put("meaning", meaning);
        out.put("state", state);
        JsonOut.put(out, "reason", reason);
        out.put("detail", new ArrayList<Object>(detail));
        out.put("final", isFinal);
        JsonOut.put(out, "at", at);
        JsonOut.put(out, "acceptedAt", acceptedAt);
        JsonOut.put(out, "needs", needs);
        JsonOut.put(out, "creditReference", creditReference);
        return out;
    }
}
