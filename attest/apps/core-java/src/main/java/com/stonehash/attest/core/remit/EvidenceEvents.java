package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.json.JsValues;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the evidence path writes down: the payloads of the events the
 * platform itself appends once the receiving institution has reported, and
 * what each notice to the bank carries — every member, in the order it has
 * always been written.
 *
 * <p>An event's payload is signed and then stored as text; a package repeats
 * it and is committed to; a bank's system reads the notices. So the order of
 * the members is part of each of them, and each is made here, in one place,
 * from values handed in: nothing in this class reads the store or the clock.
 */
final class EvidenceEvents {
    private EvidenceEvents() {
    }

    /** What the notice of a returned payment says beside the reason. */
    static final String RETURN_NOTE = "USDC returned to the settlement entity; the bank refunds the customer VND on its own ledger";

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }

    /** A member of a partner's payload, or what stands for it when it says nothing there ({@code a ?? b}). */
    static Object or(Object payload, String name, Object otherwise) {
        Object v = JsValues.member(payload, name);
        return JsValues.nullish(v) ? otherwise : v;
    }

    /**
     * The level a completion states: {@code L2} when it states none. Exactly
     * {@code L1} is "we were told", and holds the settlement; every other
     * value goes on to reconciliation. Levels are not compared by size.
     *
     * @return the level, or {@code null} when what is stated is not text
     */
    static String levelOf(Object completionPayload) {
        Object stated = JsValues.member(completionPayload, "evidence_level");
        if (JsValues.nullish(stated)) {
            return "L2";
        }
        return stated instanceof String ? (String) stated : null;
    }

    // ── what the receiving institution reported: the notices ─────────────────

    static Map<String, Object> receivedNotice(Object payload) {
        return map("tx_hash", or(payload, "tx_hash", null));
    }

    static Map<String, Object> submittedNotice(Object payload) {
        return map("local_rail", or(payload, "local_rail", "FAST"));
    }

    static Map<String, Object> failedNotice(Object payload) {
        return map("reason", or(payload, "reason", "local payout failed"), "will_return", true);
    }

    static Map<String, Object> completedNotice(Object payload, String level) {
        return map("bank_reference", or(payload, "bank_reference", null), "evidence_level", level);
    }

    /**
     * @param firstFailure the payload of the settlement's first {@code PAYOUT_FAILED}, or {@code null} when none was
     *        reported. The reason is that failure's — and where it gave none, the notice has no reason at all
     */
    static Map<String, Object> returnedNotice(Object payload, Object firstFailure) {
        return map("reason", firstFailure == null ? "returned" : JsValues.member(firstFailure, "reason"),
                "return_tx", or(payload, "tx_hash", null), "note", RETURN_NOTE);
    }

    // ── a completion nobody signed ───────────────────────────────────────────

    /**
     * The last-mile rule, written down: an unsigned completion is "we
     * received a message", not evidence a third party can check. The payment
     * very likely completed, and it is not declared confirmed — not a
     * failure either: what it calls for is a better confirmation.
     */
    static Map<String, Object> insufficient(String paymentId, String level) {
        return map("payment_id", paymentId, "evidence_level", level, "holds_at", "PAYOUT_IN_PROGRESS",
                "reason", "payout completion arrived without an institution signature (L1); credit confirmation requires L2 or better",
                "remediation", "request a signed (L2) or bank-referenced (L3) confirmation from the BFI, or reconcile via the daily signed statement");
    }

    static Map<String, Object> insufficientNotice(String level) {
        return map("evidence_level", level);
    }

    // ── reconciliation ───────────────────────────────────────────────────────

    /** Axis name → its state, in the order the rules list their axes. */
    static Map<String, Object> axisStates(Map<String, Object> verdict) {
        Map<String, Object> out = new LinkedHashMap<>();
        Object axes = JsValues.member(verdict, "axes");
        if (!(axes instanceof Map)) {
            throw new JsValues.EngineError("a verdict without axes was read");
        }
        for (Map.Entry<?, ?> axis : ((Map<?, ?>) axes).entrySet()) {
            out.put((String) axis.getKey(), JsValues.member(axis.getValue(), "state"));
        }
        return out;
    }

    /**
     * @param p the settlement's row
     * @param verdict the whole verdict of the rules
     * @param pass whether the gate let it through
     */
    static Map<String, Object> reconciled(Map<String, Object> p, Map<String, Object> verdict, boolean pass, String reconciledAt) {
        return map("payment_id", p.get("id"),
                "policy_version", JsValues.member(verdict, "policyVersion"),
                "policy_digest", JsValues.member(verdict, "policyDigest"),
                "pass", pass,
                "axes", axisStates(verdict),
                "amounts", map("collected", p.get("collect_currency") + " " + p.get("collect_amount"),
                        "settled", "USDC " + p.get("usdc_amount"),
                        "paid", p.get("payout_currency") + " " + p.get("payout_amount")),
                "reconciled_at", reconciledAt);
    }

    /** @param completionPayload the completion that was reconciled: the bank reference and the level are its own */
    static Map<String, Object> confirmedNotice(Map<String, Object> verdict, Object completionPayload, String level) {
        return map("axes", axisStates(verdict), "bank_reference", or(completionPayload, "bank_reference", null), "evidence_level", level);
    }

    static Map<String, Object> exceptionNotice(List<String> reasons, Map<String, Object> verdict) {
        return map("reasons", reasons, "axes", axisStates(verdict));
    }

    // ── the package, and its anchor ──────────────────────────────────────────

    /** What the anchor record of a package is described as ({@code attestations.descriptor}). */
    static Map<String, Object> packageDescriptor(String paymentId, Object schema) {
        return map("kind", "remit-evidence", "payment_id", paymentId, "schema", schema);
    }

    static Map<String, Object> committed(String paymentId, String commitment, String attestationId, String committedAt) {
        return map("payment_id", paymentId, "commitment", commitment, "attestation_id", attestationId, "committed_at", committedAt);
    }

    static Map<String, Object> committedNotice(String attestationId, String commitment) {
        return map("attestation_id", attestationId, "commitment", commitment);
    }

    static Map<String, Object> anchored(String paymentId, String attestationId, String anchoredAt) {
        return map("payment_id", paymentId, "attestation_id", attestationId, "anchored_at", anchoredAt);
    }

    static Map<String, Object> anchoredNotice(String attestationId) {
        return map("attestation_id", attestationId);
    }
}
