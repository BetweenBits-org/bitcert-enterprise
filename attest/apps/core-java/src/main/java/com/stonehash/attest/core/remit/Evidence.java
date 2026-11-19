package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.evidence.Reconciler;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.remit.Conventions;
import com.stonehash.attest.remit.Rules;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Evidence — where the settlement rail meets the six-axis rules.
 *
 * <p>The elements are collected from the parties that signed them (the bank
 * at submission, the receiving institution and the settlement entity during
 * the run), assembled into the same settlement-evidence document the
 * stateless evaluators take, and judged by the same rules — with one
 * difference: the keyring is the trust registry, so the issuer axis reports
 * registered identities ({@code ATTESTED}) instead of demonstration keys.
 *
 * <p>The package then commits through the ordinary anchoring path: a
 * commitment over the canonical package and a nonce is what reaches the
 * chain, and the package — stored as the text it was assembled as, in the
 * order its members were written — is what a holder re-derives it from.
 *
 * <p>Nothing here reads the store or the clock by itself: the events, the
 * registry rows and the times are handed in, so that a package assembled
 * later still says what was true when the settlement was reconciled.
 */
public final class Evidence {
    private Evidence() {
    }

    /** What the commitment is taken under, and what {@code GET …/evidence} names as its domain. */
    public static final String COMMIT_DOMAIN = Conventions.EVIDENCE_COMMIT_DOMAIN;

    /**
     * The corridor policy, {@code remit-corridor-v1}. USD and USDC are one
     * unit of account — the visible judgement that a USDC settlement
     * discharges a USD obligation at par; the VND funding leg and the SGD
     * payout leg ride inside the elements as locked conversions of the USD
     * amounts, so every figure the rules compare is in one unit.
     *
     * <p>The policy is written into every evidence package and committed to
     * with it, so it is data, with its members in the order the previous
     * service wrote them ({@code remit/corridor-policy.json}, generated from
     * that service's own constant). It is checked when this class is first
     * used: a policy the rules cannot run under stops the start, not the
     * first settlement.
     */
    public static final Map<String, Object> POLICY = loadPolicy();

    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadPolicy() {
        Map<String, Object> policy;
        try (InputStream in = Evidence.class.getResourceAsStream("/remit/corridor-policy.json")) {
            if (in == null) {
                throw new IllegalStateException("remit/corridor-policy.json is not on the classpath");
            }
            Map<String, Object> file = (Map<String, Object>) Js.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            policy = (Map<String, Object>) file.get("policy");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        Rules.validatePolicy(policy);
        return java.util.Collections.unmodifiableMap(policy);
    }

    private static final String[] BANK_ELEMENTS = { "bankInstruction", "bankApproval", "commercialDocs" };

    private static Map<String, Object> firstOf(List<Map<String, Object>> events, String type) {
        for (Map<String, Object> e : events) {
            if (type.equals(e.get("type"))) {
                return e;
            }
        }
        return null;
    }

    /** An element handed over inside an event's payload: there only when it is an object. */
    private static Object grab(Map<String, Object> event, String key) {
        if (event == null) {
            return Js.UNDEFINED;
        }
        Object el = JsValues.member(Js.parse((String) event.get("payload")), key);
        return JsValues.truthy(el) && JsValues.isObject(el) ? el : Js.UNDEFINED;
    }

    /**
     * The signed elements, out of the event log, as the JSON they arrived
     * as: the bank's three from the request, the travel-rule element with
     * the payout approval, the chain transfer with the transfer's
     * confirmation, the payout receipt with the completion.
     *
     * @param events a settlement's events in their order ({@code type, payload, …})
     * @param completion the {@code PAYOUT_COMPLETED} event whose receipt is meant, or {@code null} for the first one there is
     * @return {@code bankInstruction, bankApproval, commercialDocs, travelRule, chainTransfer, payoutReceipt}; a member that is not there is absent
     */
    public static Map<String, Object> collectElements(List<Map<String, Object>> events, Map<String, Object> completion) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> bank = firstOf(events, "BANK_EVIDENCE_SUBMITTED");
        if (bank != null) {
            Object payload = Js.parse((String) bank.get("payload"));
            for (String key : BANK_ELEMENTS) {
                out.put(key, JsValues.member(payload, key));
            }
        }
        out.put("travelRule", grab(firstOf(events, "PAYOUT_ACCEPTED"), "travel_rule_element"));
        out.put("chainTransfer", grab(firstOf(events, "USDC_TRANSFER_CONFIRMED"), "chain_transfer_element"));
        out.put("payoutReceipt", grab(completion != null ? completion : firstOf(events, "PAYOUT_COMPLETED"), "payout_receipt_element"));
        return out;
    }

    /**
     * Recompute each element's declared digest and say whether it holds
     * ({@code digestVerified}) — which turns the integrity axis into
     * arithmetic rather than a claim. An element that declares no digest
     * passes as it is.
     */
    @SuppressWarnings("unchecked")
    static Map<String, Object> stampDigests(Map<String, Object> elements) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : elements.entrySet()) {
            Object el = e.getValue();
            if (!JsValues.truthy(el)) {
                continue;
            }
            if (el instanceof Map && ((Map<String, Object>) el).get("digest") instanceof String) {
                Map<String, Object> stamped = new LinkedHashMap<>((Map<String, Object>) el);
                stamped.put("digestVerified", Conventions.elementDigest((Map<String, Object>) Canonical.forSdk(el)).equals(stamped.get("digest")));
                out.put(e.getKey(), stamped);
            } else {
                out.put(e.getKey(), el);
            }
        }
        return out;
    }

    /** The settlement-evidence document for a settlement and its elements, its members in the order they have always been written. */
    static Map<String, Object> settlementEvidence(Map<String, Object> p, Map<String, Object> els) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schemaVersion", "settlement-evidence/0.1");
        out.put("scenario", "remit · " + p.get("corridor_origin") + "→" + p.get("corridor_destination") + " · " + p.get("id"));
        out.put("settlementId", p.get("id"));
        // The sandbox rail: mock USDC on a private chain.
        out.put("dataMode", "SYNTHETIC");
        out.put("notRealPayment", true);
        Map<String, Object> jurisdiction = new LinkedHashMap<>();
        jurisdiction.put("from", p.get("corridor_origin"));
        jurisdiction.put("to", p.get("corridor_destination"));
        out.put("jurisdiction", jurisdiction);
        out.put("purpose", "Import trade payment under quote " + p.get("quote_id"));
        Map<String, Object> elements = new LinkedHashMap<>();
        if (JsValues.truthy(els.get("chainTransfer"))) {
            elements.put("chainTransfer", els.get("chainTransfer"));
        }
        if (JsValues.truthy(els.get("payoutReceipt"))) {
            List<Object> receipts = new ArrayList<>();
            receipts.add(els.get("payoutReceipt"));
            elements.put("payoutReceipts", receipts);
        }
        for (String key : new String[] { "bankInstruction", "commercialDocs", "travelRule", "bankApproval" }) {
            if (JsValues.truthy(els.get(key))) {
                elements.put(key, els.get(key));
            }
        }
        out.put("elements", elements);
        return out;
    }

    /** What reconciling a settlement came to. */
    public static final class Outcome {
        /** The evidence document, every signature's status computed against the registry. */
        public final Map<String, Object> evidence;
        /** The whole verdict of the rules, axes in the engine's order. */
        public final Map<String, Object> verdict;
        /** All axes green, with the sandbox allowance applied. */
        public final boolean pass;
        /** {@code <axis>=<state>} for each axis that is not, in the order of the axes. */
        public final List<String> reasons;

        Outcome(Map<String, Object> evidence, Map<String, Object> verdict, boolean pass, List<String> reasons) {
            this.evidence = evidence;
            this.verdict = verdict;
            this.pass = pass;
            this.reasons = reasons;
        }
    }

    private static String stateOf(Object axes, String axis) {
        return JsValues.string(JsValues.member(JsValues.member(axes, axis), "state"));
    }

    /**
     * Verify the signatures against the registry, evaluate under the
     * corridor policy, and apply the gate.
     *
     * <p>The gate: integrity and issuer {@code VALID}, matching
     * {@code MATCH}, completeness {@code COMPLETE}. Synthetic data pins two
     * axes by rule, not by measurement — regulatory mapping at best
     * {@code REVIEW_REQUIRED}, business finality at best {@code DEMO_ONLY} —
     * and the sandbox allowance accepts exactly those two ceilings: the
     * regulatory one only when the field coverage is in fact complete, so a
     * field that is really missing still fails the gate in the sandbox.
     *
     * @param p the settlement's row
     * @param events its events, in their order
     * @param completion the completion that is being reconciled, or {@code null} for the first there is
     * @param institutions the registry's rows, read once for this reconciliation
     * @param acceptDemoFinality the sandbox allowance
     */
    public static Outcome reconcile(Map<String, Object> p, List<Map<String, Object>> events, Map<String, Object> completion,
            List<Map<String, Object>> institutions, boolean acceptDemoFinality) {
        Map<String, Object> raw = settlementEvidence(p, stampDigests(collectElements(events, completion)));
        Reconciler reconciler = new Reconciler(ProductRegistry.keyringEntries(institutions));
        Map<String, Object> evidence = reconciler.checkSignatures(raw);
        Map<String, Object> verdict = reconciler.evaluate(evidence, POLICY);

        List<String> reasons = new ArrayList<>();
        Object axes = JsValues.member(verdict, "axes");
        if (!"VALID".equals(stateOf(axes, "integrity"))) {
            reasons.add("integrity=" + stateOf(axes, "integrity"));
        }
        if (!"VALID".equals(stateOf(axes, "issuer"))) {
            reasons.add("issuer=" + stateOf(axes, "issuer"));
        }
        if (!"MATCH".equals(stateOf(axes, "matching"))) {
            reasons.add("matching=" + stateOf(axes, "matching"));
        }
        if (!"COMPLETE".equals(stateOf(axes, "completeness"))) {
            reasons.add("completeness=" + stateOf(axes, "completeness"));
        }
        boolean fieldsComplete = true;
        Object findings = JsValues.member(JsValues.member(axes, "regulatoryMapping"), "findings");
        if (!(findings instanceof List)) {
            throw new JsValues.EngineError("the verdict's regulatory findings are not a list");
        }
        for (Object finding : (List<?>) findings) {
            if ("REGULATORY_FIELD_MISSING".equals(JsValues.member(finding, "code"))) {
                fieldsComplete = false;
            }
        }
        String regulatory = stateOf(axes, "regulatoryMapping");
        if (!(regulatory.equals("PRESENT") || (acceptDemoFinality && regulatory.equals("REVIEW_REQUIRED") && fieldsComplete))) {
            reasons.add("regulatoryMapping=" + regulatory);
        }
        String finality = stateOf(axes, "businessFinality");
        if (!(finality.equals("VERIFIED_BY_SOURCE") || (acceptDemoFinality && finality.equals("DEMO_ONLY")))) {
            reasons.add("businessFinality=" + finality);
        }
        return new Outcome(evidence, verdict, reasons.isEmpty(), reasons);
    }

    private static Map<String, Object> pair(String a, Object x, String b, Object y) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(a, x);
        out.put(b, y);
        return out;
    }

    /**
     * The evidence package of a settlement: {@code schema} to
     * {@code generated_at}, in that order. It is stored as the text
     * {@code Js.stringify} gives for it and answered as stored; the
     * canonical form is used only for the commitment.
     *
     * @param p the settlement's row, as it stands when the package is assembled
     * @param events its events up to that moment
     * @param evidence the evidence as reconciled ({@link Outcome#evidence})
     * @param verdict the verdict as reconciled ({@link Outcome#verdict})
     * @param trustRegistry the registry's snapshot ({@code taken_at, institutions})
     */
    public static Map<String, Object> assemblePackage(Map<String, Object> p, List<Map<String, Object>> events, Map<String, Object> evidence,
            Map<String, Object> verdict, Map<String, Object> trustRegistry, String generatedAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", "stonehash.payment-evidence.v1");
        out.put("payment_id", p.get("id"));
        out.put("corridor", pair("origin", p.get("corridor_origin"), "destination", p.get("corridor_destination")));
        out.put("state", p.get("state"));
        Map<String, Object> amounts = new LinkedHashMap<>();
        amounts.put("trade", pair("currency", p.get("trade_currency"), "value", p.get("trade_amount")));
        amounts.put("collected", pair("currency", p.get("collect_currency"), "value", p.get("collect_amount")));
        amounts.put("settled", pair("asset", "USDC", "value", p.get("usdc_amount")));
        amounts.put("paid", pair("currency", p.get("payout_currency"), "value", p.get("payout_amount")));
        out.put("amounts", amounts);
        out.put("quote_id", p.get("quote_id"));
        out.put("events", eventViews(events, false));
        out.put("evidence", evidence);
        out.put("policy", POLICY);
        out.put("verdict", verdict);
        out.put("trust_registry", trustRegistry);
        out.put("generated_at", generatedAt);
        return out;
    }

    /**
     * A settlement's events as they are shown: {@code seq, type, issuer},
     * the payload as the JSON it is, the signature envelope or {@code null}
     * for an event nobody signed, and the time — in the order the two
     * places that show them want the last two.
     *
     * @param timeFirst the settlement's own view ({@code at, payload, sig}); otherwise a package's ({@code payload, sig, at})
     */
    static List<Object> eventViews(List<Map<String, Object>> events, boolean timeFirst) {
        List<Object> out = new ArrayList<>();
        for (Map<String, Object> e : events) {
            Map<String, Object> shown = new LinkedHashMap<>();
            shown.put("seq", e.get("seq"));
            shown.put("type", e.get("type"));
            shown.put("issuer", e.get("issuer"));
            Object payload = Js.parse((String) e.get("payload"));
            Object sig = JsValues.truthy(e.get("sig")) ? Js.parse((String) e.get("sig")) : null;
            if (timeFirst) {
                shown.put("at", e.get("created_at"));
                shown.put("payload", payload);
                shown.put("sig", sig);
            } else {
                shown.put("payload", payload);
                shown.put("sig", sig);
                shown.put("at", e.get("created_at"));
            }
            out.add(shown);
        }
        return out;
    }

    /**
     * The commitment over a package and its nonce:
     * {@code SHA-256("STONEHASH-EVIDENCE-V1" ‖ nonce ‖ JCS(package))}. The
     * anchored leaf reveals nothing about the payment, and the nonce —
     * disclosed with the package — lets its holder, and only its holder,
     * re-derive the leaf from the content.
     */
    public static String commitment(Map<String, Object> pkg, String nonceHex) {
        return Conventions.commitment(Canonical.forSdk(pkg), nonceHex);
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    /** 32 random bytes, in hex. */
    public static String newNonce() {
        byte[] nonce = new byte[32];
        RANDOM.nextBytes(nonce);
        return com.stonehash.attest.core.format.Hex.encode(nonce);
    }
}
