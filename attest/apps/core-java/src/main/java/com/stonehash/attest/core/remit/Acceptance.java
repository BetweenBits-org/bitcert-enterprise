package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.db.TxRetry;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import com.stonehash.attest.remit.TravelRule;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Accepting a settlement — {@code POST /v1/settlements} once the caller is
 * known and its {@code Idempotency-Key} was read.
 *
 * <p>An instruction that fails verification is refused, not recorded:
 * everything up to the transaction below only reads. The checks run in the
 * order they have always run in, because the order decides which refusal a
 * request with two faults gets:
 * the key's stored answer → the payment id → an existing settlement of that
 * id → the quote → the amounts → the receiving institution → the bank's
 * authorisation → the travel-rule data → the three evidence elements → the
 * instruction against the quote and the id → the reference to the bank's
 * message.
 *
 * <p>Then one transaction makes the settlement whole or not at all:
 * <ol>
 * <li>the organisation's row is locked — two instructions of one
 *     organisation are judged one after the other, whatever they were made
 *     from;
 * <li>the key is looked up again: an identical request that was accepted in
 *     the meantime is answered with what that one was answered, another body
 *     under the key is a conflict;
 * <li>a settlement of that id is the same instruction sent again;
 * <li>the message the instruction was made from must not stand for a
 *     settlement already ({@link RemitStore#sourceConflict}). When it does,
 *     nothing is created — but what the judgement recorded (the recognition,
 *     an inherited UETR) is committed with the refusal;
 * <li>otherwise: the settlement, its reference to the message, the three
 *     events it was accepted on, its first state, the notice to the bank,
 *     the first job of its pipeline, and last the answer under the key.
 * </ol>
 * The request is answered 202 as soon as that has committed; the pipeline
 * runs from the job, not from the request.
 */
@Component
public class Acceptance {
    /** Bank-issued ids: generous but bounded, and never one of the two words the stateless evaluators answer under. */
    private static final Pattern PAYMENT_ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{3,63}");
    private static final Set<String> RESERVED_IDS = Set.of("reconcile", "bundle");
    private static final String[] ELEMENTS = { "bankInstruction", "bankApproval", "commercialDocs" };

    private final CoreConfig cfg;
    private final RemitStore store;
    private final RemitJobs jobs;
    private final ProductRegistry registry;
    private final PlatformKey platform;
    private final WebhookOutbox outbox;
    private final RemitExecutor executor;
    private final TransactionTemplate tx;

    public Acceptance(CoreConfig cfg, RemitStore store, RemitJobs jobs, ProductRegistry registry, PlatformKey platform, WebhookOutbox outbox,
            RemitExecutor executor, TransactionTemplate tx) {
        this.cfg = cfg;
        this.store = store;
        this.jobs = jobs;
        this.registry = registry;
        this.platform = platform;
        this.outbox = outbox;
        this.executor = executor;
        this.tx = tx;
    }

    /** The hash a request is remembered by under its key: SHA-256 of the body as JavaScript writes it back out, member order kept. */
    public static String requestHash(Object body) {
        return Hex.encode(Hex.sha256(Js.stringify(body).getBytes(StandardCharsets.UTF_8)));
    }

    private static HttpResult stored(Map<String, Object> hit) {
        return new HttpResult(((Number) hit.get("response_status")).intValue(), Js.parse((String) hit.get("response_body")));
    }

    private static ServiceError missing(String name) {
        return new ServiceError(400, "missing_field", name + " is required");
    }

    /** A value that has to be there: absent, {@code null} and empty text are not. */
    private static Object must(Object v, String name) {
        if (JsValues.nullish(v) || "".equals(v)) {
            throw missing(name);
        }
        return v;
    }

    /** What the transaction came to. */
    private static final class Outcome {
        HttpResult replay;
        RuntimeException refusal;
        Map<String, Object> accepted;
        RemitJobs.Held job;
    }

    /** What checking an instruction reads: three questions, and nothing is written. */
    public interface Lookups {
        /** Is there a settlement of that id, whoever it belongs to? */
        boolean paymentExists(String paymentId);

        /** {@code id, response, expires_at} of one of the organisation's quotes, or {@code null}. */
        Map<String, Object> quote(String orgId, String quoteId);

        /** An institution's registry row, or {@code null}. */
        Map<String, Object> institution(String id);
    }

    /** An instruction that passed every check, and what the settlement will be made of. */
    public static final class Checked {
        public String paymentId;
        public String quoteId;
        /** The settlement's row, from the stored quote. */
        public RemitStore.NewPayment fresh;
        /** The reference to the bank's message, or {@code null} for an instruction made from the bank's own data. */
        public SourceRef source;
        /** The payloads of the three events the settlement is accepted on. {@code accepted_at} and {@code verified_at} are added when it is. */
        public Map<String, Object> accepted;
        public Map<String, Object> submitted;
        public Map<String, Object> verified;
    }

    /**
     * @param bank the caller's collection bank, as the gate returned it
     * @param idemKey the request's {@code Idempotency-Key}, already found long enough and short enough
     * @param body the request body, whatever JSON it is
     */
    public HttpResult accept(String orgId, Map<String, Object> bank, String idemKey, Object body) {
        String requestHash = requestHash(body);
        Map<String, Object> hit = store.idempotencyHit(orgId, idemKey);
        if (hit != null) {
            if (requestHash.equals(hit.get("request_hash"))) {
                return stored(hit);
            }
            throw Refusals.idempotencyConflict();
        }
        // What was answered before the pause is still answered; nothing new is taken in.
        if (cfg.remit.intakePaused) {
            throw intakePaused();
        }

        Checked checked = check(new Lookups() {
            @Override
            public boolean paymentExists(String paymentId) {
                return store.exists(paymentId);
            }

            @Override
            public Map<String, Object> quote(String org, String quoteId) {
                return store.quote(org, quoteId);
            }

            @Override
            public Map<String, Object> institution(String id) {
                return registry.institution(id);
            }
        }, orgId, bank, body, System.currentTimeMillis());
        return create(orgId, bank, idemKey, requestHash, checked);
    }

    /**
     * Every check an instruction has to pass before anything is written, in
     * the order that decides which refusal a request with two faults gets.
     *
     * @param nowMs the moment a quote's expiry is measured against
     * @throws HttpError or {@link ServiceError}: the refusal
     */
    public static Checked check(Lookups lookups, String orgId, Map<String, Object> bank, Object body, long nowMs) {
        Map<String, Object> fields = Body.fields(body);
        Object pid = fields.get("payment_id");
        if (!(pid instanceof String) || !PAYMENT_ID.matcher((String) pid).matches() || RESERVED_IDS.contains(pid)) {
            throw new HttpError(400, "invalid_payment_id", "payment_id must be 4–64 chars of [A-Za-z0-9_-] and not a reserved word");
        }
        String paymentId = (String) pid;
        Object quoteRef = must(fields.get("quote_id"), "quote_id");
        if (lookups.paymentExists(paymentId)) {
            throw Refusals.duplicatePayment(paymentId);
        }

        // The quote: it must exist, belong to this organisation, and still be alive.
        Map<String, Object> quoteRow = quoteRef instanceof String ? lookups.quote(orgId, (String) quoteRef) : null;
        if (quoteRow == null) {
            throw new ServiceError(400, "quote_not_found", "no quote " + JsValues.string(quoteRef) + " for this organisation");
        }
        String quoteId = (String) quoteRef;
        Long expires = IsoDate.epochMilli((String) quoteRow.get("expires_at"));
        if (expires != null && expires < nowMs) {
            throw new ServiceError(409, "quote_expired", "quote " + quoteId + " expired at " + quoteRow.get("expires_at") + "; request a fresh quote");
        }
        Object quote = Js.parse((String) quoteRow.get("response"));

        // The amounts restate the quote exactly: the instruction is the bank committing to the quoted legs, not proposing new ones.
        Object amount = fields.get("amount");
        restates(JsValues.memberIfAny(amount, "collected"), JsValues.member(quote, "collect"), "collected");
        restates(JsValues.memberIfAny(amount, "payout"), JsValues.member(quote, "payout"), "payout");

        // The receiving institution: registered, in that role, able to receive personal data.
        Object bfiRef = must(JsValues.memberIfAny(fields.get("beneficiary"), "institution_id"), "beneficiary.institution_id");
        Map<String, Object> bfi = bfiRef instanceof String ? lookups.institution((String) bfiRef) : null;
        if (bfi == null || !"BENEFICIARY_FI".equals(bfi.get("role"))) {
            throw new ServiceError(400, "unknown_beneficiary_institution", JsValues.string(bfiRef) + " is not a registered BENEFICIARY_FI");
        }
        String bfiId = (String) bfiRef;
        if (!JsValues.truthy(bfi.get("encryption_jwk"))) {
            throw new ServiceError(502, "bfi_has_no_encryption_key",
                    bfiId + " has no encryption key registered, so the Travel Rule payload cannot be protected");
        }

        // The bank's authorisation signature — the legal heart of the request.
        String bankSpki = (String) bank.get("signing_spki");
        Object authz = fields.get("bank_authorization");
        Object bankSig = fields.get("bank_signature");
        if (!JsValues.truthy(authz) || !JsValues.isObject(authz)) {
            throw missing("bank_authorization");
        }
        if (!JsValues.truthy(JsValues.memberIfAny(bankSig, "sig"))) {
            throw missing("bank_signature");
        }
        if (!JsValues.truthy(bankSpki) || !Signatures.verifyEvent(authz, bankSig, bankSpki)) {
            throw new ServiceError(400, "invalid_signature",
                    "bank_signature does not verify over bank_authorization with the registered COLLECTION_BANK key");
        }

        // Travel-rule completeness, before anything is accepted.
        Object given = fields.get("compliance_payload");
        Object compliance = given == null ? new LinkedHashMap<String, Object>() : given;
        boolean modeB = "B".equals(JsValues.member(compliance, "mode"));
        if (modeB) {
            // The bank's SDK encrypted: the data is ciphertext already and cannot be checked here. What can be: the ciphertext is
            // there, and the bank signed a statement about exactly this message — which puts the claim on the bank's key.
            Object ciphertext = JsValues.member(compliance, "ciphertext");
            Object digest = JsValues.member(compliance, "ivms101_digest");
            if (!JsValues.truthy(ciphertext) || !Signatures.isDigestText(digest)) {
                throw new ServiceError(400, "travel_rule_incomplete", "mode B requires ciphertext (compact JWE) and ivms101_digest");
            }
            String problem = Signatures.fieldsAssertionProblem(JsValues.member(compliance, "fields_assertion"), paymentId, digest, ciphertext, bankSpki);
            if (problem != null) {
                throw new ServiceError(400, "invalid_fields_assertion", problem);
            }
        } else {
            List<String> absent = TravelRule.missingFields(compliance);
            if (!absent.isEmpty()) {
                throw new ServiceError(400, "travel_rule_incomplete", "compliance_payload is missing required fields: " + String.join(", ", absent));
            }
        }

        // The bank's three evidence elements, signed before they arrive, and consistent with the quote they will be reconciled against.
        Object given2 = fields.get("evidence_elements");
        Object elements = given2 == null ? new LinkedHashMap<String, Object>() : given2;
        for (String key : ELEMENTS) {
            Object el = JsValues.member(elements, key);
            if (!JsValues.truthy(el)) {
                throw new ServiceError(400, "missing_evidence_element", "evidence_elements." + key + " is required");
            }
            if (!Signatures.elementSignatureValid(el, bankSpki)) {
                throw new ServiceError(400, "invalid_evidence_signature",
                        "evidence_elements." + key + " signature does not verify with the registered bank key");
            }
        }
        Object instruction = JsValues.member(elements, "bankInstruction");
        Object quotedTrade = JsValues.member(JsValues.member(quote, "trade"), "amount");
        if (!JsValues.strictEquals(JsValues.member(instruction, "amount"), quotedTrade) || !"USD".equals(JsValues.member(instruction, "currency"))) {
            throw new ServiceError(400, "evidence_inconsistent", "bankInstruction must instruct the quoted trade amount " + JsValues.string(quotedTrade) + " USD");
        }
        if (!paymentId.equals(JsValues.member(instruction, "ref"))) {
            throw new ServiceError(400, "evidence_inconsistent", "bankInstruction.ref must carry the payment_id (the corridor settlement id)");
        }

        // One settlement per message: where the instruction was made from a SWIFT message, the bank signed a reference to it.
        SourceRef source = SourceRef.of(JsValues.member(instruction, "sourceMessage"));

        // What the settlement is made of comes from the stored quote, not from the request.
        RemitStore.NewPayment fresh = new RemitStore.NewPayment();
        fresh.id = paymentId;
        fresh.orgId = orgId;
        fresh.quoteId = quoteId;
        Object corridor = JsValues.member(quote, "corridor");
        fresh.corridorOrigin = AttestService.storable(JsValues.member(corridor, "origin"));
        fresh.corridorDestination = AttestService.storable(JsValues.member(corridor, "destination"));
        fresh.tradeCurrency = AttestService.storable(JsValues.member(JsValues.member(quote, "trade"), "currency"));
        fresh.tradeAmount = AttestService.storable(quotedTrade);
        fresh.collectCurrency = AttestService.storable(JsValues.member(JsValues.member(quote, "collect"), "currency"));
        fresh.collectAmount = AttestService.storable(JsValues.member(JsValues.member(quote, "collect"), "amount"));
        fresh.usdcAmount = AttestService.storable(JsValues.member(JsValues.member(quote, "settlement"), "amount"));
        fresh.payoutCurrency = AttestService.storable(JsValues.member(JsValues.member(quote, "payout"), "currency"));
        fresh.payoutAmount = AttestService.storable(JsValues.member(JsValues.member(quote, "payout"), "amount"));
        fresh.beneficiaryInstitution = bfiId;
        fresh.requestBody = Js.stringify(redactCompliance(fields, given, modeB));

        Checked out = new Checked();
        out.paymentId = paymentId;
        out.quoteId = quoteId;
        out.fresh = fresh;
        out.source = source;
        out.accepted = new LinkedHashMap<>();
        out.accepted.put("payment_id", paymentId);
        out.accepted.put("request_id", fields.get("request_id"));
        out.accepted.put("quote_id", quoteId);
        out.submitted = new LinkedHashMap<>();
        for (String key : ELEMENTS) {
            out.submitted.put(key, JsValues.member(elements, key));
        }
        out.verified = new LinkedHashMap<>();
        out.verified.put("payment_id", paymentId);
        out.verified.put("bank_authorization", authz);
        out.verified.put("bank_signature", bankSig);
        return out;
    }

    /**
     * The transaction that makes a checked instruction a settlement — or
     * finds that one already stands where it wants to stand.
     *
     * <p>Not private only so that the store tests can hand it instructions
     * without a bank's signatures on them; the service reaches it through
     * {@link #accept} alone.
     */
    HttpResult create(String orgId, Map<String, Object> bank, String idemKey, String requestHash, Checked checked) {
        String paymentId = checked.paymentId;
        String quoteId = checked.quoteId;
        SourceRef source = checked.source;
        RemitStore.NewPayment fresh = checked.fresh;
        String acceptedAt = IsoTime.now();
        String bankId = (String) bank.get("id");
        Map<String, Object> accepted = checked.accepted;
        accepted.put("accepted_at", acceptedAt);
        Map<String, Object> submitted = checked.submitted;
        Map<String, Object> verified = checked.verified;
        verified.put("verified_at", acceptedAt);

        Outcome out;
        try {
            out = TxRetry.execute(tx, (status) -> {
                Outcome o = new Outcome();
                store.lockOrg(orgId);
                Map<String, Object> meanwhile = store.idempotencyHit(orgId, idemKey);
                if (meanwhile != null) {
                    if (requestHash.equals(meanwhile.get("request_hash"))) {
                        o.replay = stored(meanwhile);
                    } else {
                        o.refusal = Refusals.idempotencyConflict();
                    }
                    return o;
                }
                // The id first: two requests under one payment id are one payment handed over twice, whatever message each was
                // made from — and the second must hear "exists", not fail.
                if (store.exists(paymentId)) {
                    o.refusal = Refusals.duplicatePayment(paymentId);
                    return o;
                }
                if (source != null) {
                    RemitStore.Conflict conflict = store.sourceConflict(orgId, source);
                    if (conflict != null) {
                        // Nothing is created. What the judgement recorded is committed with this transaction.
                        o.refusal = Refusals.sourceConflict(source, conflict);
                        return o;
                    }
                }
                store.insertPayment(fresh);
                if (source != null) {
                    store.insertSourceRef(orgId, paymentId, source);
                }
                // What the settlement is accepted on is written with it: nobody ever reads a settlement without the evidence
                // it was accepted on, and a request that lost a race to this one finds it whole.
                store.appendEvent(paymentId, "REQUEST_ACCEPTED", PlatformKey.ISSUER, accepted, platform.signEvent(accepted));
                store.appendEvent(paymentId, "BANK_EVIDENCE_SUBMITTED", bankId, submitted, null);
                int seq = store.appendEvent(paymentId, "BANK_AUTHORIZATION_VERIFIED", PlatformKey.ISSUER, verified, platform.signEvent(verified));
                if (!store.moveState(paymentId, "REQUEST_ACCEPTED", "BANK_AUTHORIZED")) {
                    throw new IllegalStateException("settlement " + paymentId + " was moved while it was being accepted");
                }
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("quote_id", quoteId);
                outbox.enqueue(orgId, paymentId, seq, "BANK_AUTHORIZED", "BANK_AUTHORIZED", data);
                o.job = jobs.insertClaimed(paymentId, orgId, RemitJobs.Kind.TRAVEL_RULE, paymentId + ":travel-rule", null);
                o.accepted = new LinkedHashMap<>();
                o.accepted.put("payment_id", paymentId);
                o.accepted.put("state", "BANK_AUTHORIZED");
                o.accepted.put("accepted_at", acceptedAt);
                store.idempotencyStore(orgId, idemKey, requestHash, 202, o.accepted);
                return o;
            });
        } catch (DuplicateKeyException e) {
            // Another organisation put a settlement under this id at the same moment: its row is the answer — "exists", not a failure.
            throw Refusals.duplicatePayment(paymentId);
        }
        if (out.replay != null) {
            return out.replay;
        }
        if (out.refusal != null) {
            throw out.refusal;
        }
        // The pipeline continues off this request's lifetime.
        executor.runNow(out.job);
        return new HttpResult(202, out.accepted);
    }

    /** Refuses unless the leg the request states is the quoted one, currency and amount, as the text they are. */
    private static void restates(Object stated, Object quoted, String leg) {
        Object currency = JsValues.member(quoted, "currency");
        Object amount = JsValues.member(quoted, "amount");
        if (!JsValues.strictEquals(JsValues.memberIfAny(stated, "currency"), currency) || !JsValues.strictEquals(JsValues.memberIfAny(stated, "value"), amount)) {
            throw new ServiceError(400, "amount_mismatch",
                    leg + " amount must restate the quote: " + JsValues.string(amount) + " " + JsValues.string(currency));
        }
    }

    /**
     * The request as it is stored. The compliance data is kept under a name
     * the travel-rule step consumes once and then deletes — personal data
     * passes through, its digest stays. In mode B only ciphertext and digest
     * are kept: there is no plaintext to hold at all.
     */
    private static Map<String, Object> redactCompliance(Map<String, Object> body, Object compliance, boolean modeB) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : body.entrySet()) {
            if (!e.getKey().equals("compliance_payload")) {
                out.put(e.getKey(), e.getValue());
            }
        }
        if (modeB) {
            Map<String, Object> kept = new LinkedHashMap<>();
            kept.put("ciphertext", JsValues.member(compliance, "ciphertext"));
            kept.put("ivms101_digest", JsValues.member(compliance, "ivms101_digest"));
            out.put("compliance_ciphertext", kept);
        } else {
            out.put("compliance_plaintext", compliance == null ? Js.UNDEFINED : compliance);
        }
        return out;
    }

    /** New quotes and settlements are not taken while the deployment is being drained. */
    static HttpError intakePaused() {
        return new HttpError(503, "intake_paused", "this deployment is not taking new quotes or settlements at the moment; "
                + "settlements already accepted go on, and can be read, cancelled and answered as before");
    }
}
