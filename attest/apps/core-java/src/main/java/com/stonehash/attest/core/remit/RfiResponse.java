package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.db.TxRetry;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.log.Log;
import com.stonehash.attest.core.time.IsoTime;
import com.stonehash.attest.remit.TravelRule;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The bank's answer to a request for information —
 * {@code POST /v1/settlements/:id/rfi-response} once the caller is known.
 *
 * <p>The receiving institution answered the travel-rule message with a
 * question; the settlement waits in {@code TRAVEL_RULE_PENDING} until the
 * bank answers it. The bank signs {@code { payment_id, answers }}. The
 * answers are encrypted to the institution's key, as the travel-rule message
 * was, and sent with the platform's signature over their digest.
 *
 * <p>This is the one call to a partner that is made inside a request and
 * not by a job: the bank is waiting for what the institution says, and it is
 * the bank that asks again. So the order is: the checks, which only read
 * (the settlement, its state, the open question, the answers, the
 * signature); the call, with no lock held; and then one transaction, the
 * settlement's row locked first, that writes what the institution said —
 * unless something else got there while the institution was being asked.
 *
 * <ul>
 * <li>The institution accepts — an acknowledgement it signed: the question is
 *     resolved, the travel rule counts as received, and the payout approval
 *     is queued. The settlement stays {@code TRAVEL_RULE_PENDING}.
 * <li>The institution rejects, or answers without an acknowledgement: the
 *     settlement is {@code CANCELLED}.
 * <li>An acknowledgement whose signature does not hold is the bank's 400 and
 *     changes nothing; an institution that cannot be asked, or refuses the
 *     call, is the bank's 502 and changes nothing. The question stays open
 *     and the bank may answer again.
 * <li>Two answers that overlap, or an answer that overlaps a cancellation:
 *     the first to commit stands. The later one writes nothing and is told
 *     so — {@code already_resolved}, or {@code wrong_state} when the
 *     settlement has left {@code TRAVEL_RULE_PENDING}. An answer that was
 *     accepted is never undone by a rejection that arrived late.
 * </ul>
 */
@Component
public class RfiResponse {
    static final String PATH = "/bfi/travel-rule-response";
    /** Why the settlement was cancelled when the institution gave no reason. */
    static final String DEFAULT_REASON = "rejected after RFI";
    /** The role whose key may acknowledge a travel-rule message. */
    static final String ACKNOWLEDGES = "BENEFICIARY_FI";
    private static final String PENDING = "TRAVEL_RULE_PENDING";
    /** A key part taken from a partner's own id is used as it is only while it is short and can be a header's value. */
    private static final int KEY_PART_MAX = 128;

    private final RemitStore store;
    private final RemitJobs jobs;
    private final WebhookOutbox outbox;
    private final RemitExecutor executor;
    private final TransactionTemplate tx;
    private final ProductRegistry registry;
    private final PlatformKey platform;
    private final PartnerSignatures signatures;
    private final Supplier<PartnerExchange> exchange;

    @Autowired
    public RfiResponse(RemitStore store, RemitJobs jobs, WebhookOutbox outbox, RemitExecutor executor, TransactionTemplate tx,
            ProductRegistry registry, PlatformKey platform, PartnerSignatures signatures, ObjectProvider<PartnerExchange> exchange) {
        this(store, jobs, outbox, executor, tx, registry, platform, signatures, exchange::getIfAvailable);
    }

    /** For a test that plays the institution itself. */
    RfiResponse(RemitStore store, RemitJobs jobs, WebhookOutbox outbox, RemitExecutor executor, TransactionTemplate tx,
            ProductRegistry registry, PlatformKey platform, PartnerSignatures signatures, Supplier<PartnerExchange> exchange) {
        this.store = store;
        this.jobs = jobs;
        this.outbox = outbox;
        this.executor = executor;
        this.tx = tx;
        this.registry = registry;
        this.platform = platform;
        this.signatures = signatures;
        this.exchange = exchange;
    }

    private static ServiceError notFound(String paymentId) {
        return new ServiceError(404, "payment_not_found", "no payment " + paymentId);
    }

    private static ServiceError wrongState(Object state) {
        return new ServiceError(409, "wrong_state", "payment is " + state + "; RFI answers apply while TRAVEL_RULE_PENDING");
    }

    private static ServiceError alreadyResolved() {
        return new ServiceError(409, "already_resolved", "this RFI was already resolved");
    }

    /** Are there answers: an object, a list or text with something in it. Nothing, a number, a boolean, and anything empty: no. */
    static boolean given(Object answers) {
        if (answers instanceof Map) {
            return !((Map<?, ?>) answers).isEmpty();
        }
        if (answers instanceof List) {
            return !((List<?>) answers).isEmpty();
        }
        return answers instanceof String && !((String) answers).isEmpty();
    }

    /**
     * The key the call to the institution carries: the settlement and the
     * question — {@code <payment id>:rfi:<rfi id>} — so that every answer to
     * one question goes out under one key. The question's id is the
     * institution's own word; one that could not be a header's value, or is
     * very long, is replaced by its hash.
     */
    static String keyOf(String paymentId, Object rfiId) {
        String part;
        if (rfiId instanceof String) {
            part = (String) rfiId;
        } else {
            String json = JsValues.nullish(rfiId) ? null : Js.stringify(rfiId);
            part = json == null ? "" : json;
        }
        if (!plain(part)) {
            part = "sha256-" + Hex.encode(Hex.sha256(part.getBytes(StandardCharsets.UTF_8)));
        }
        return paymentId + ":rfi:" + part;
    }

    /** Short, printable ASCII, and no blank at either end. */
    private static boolean plain(String part) {
        if (part.length() > KEY_PART_MAX || part.startsWith(" ") || part.endsWith(" ")) {
            return false;
        }
        for (int i = 0; i < part.length(); i++) {
            char c = part.charAt(i);
            if (c < 0x20 || c > 0x7e) {
                return false;
            }
        }
        return true;
    }

    /** What the transaction came to. */
    private static final class Outcome {
        ServiceError refusal;
        RemitJobs.Held approval;
    }

    /**
     * @param bank the caller's collection bank, as the gate of the settlement API returned it
     * @param paymentId the id as the request named it
     * @param body the request body, any JSON at all
     * @return {@code { payment_id, state }}: {@code TRAVEL_RULE_PENDING} when the institution accepted the answers,
     *         {@code CANCELLED} when it did not
     * @throws ServiceError 404 {@code payment_not_found}; 409 {@code wrong_state}, {@code no_rfi}, {@code already_resolved};
     *         400 {@code missing_field}, {@code invalid_signature}; 502 {@code partner_unreachable}, {@code partner_error};
     *         400 {@code unknown_signer}, {@code role_mismatch}, {@code invalid_signature} for the institution's acknowledgement
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> respond(String orgId, Map<String, Object> bank, String paymentId, Object body) {
        Map<String, Object> fields = Body.fields(body);
        Map<String, Object> p = store.get(paymentId);
        if (p == null || !orgId.equals(p.get("org_id"))) {
            throw notFound(paymentId);
        }
        if (!PENDING.equals(p.get("state"))) {
            throw wrongState(p.get("state"));
        }
        // From here on the id is the settlement's own, as stored.
        String id = (String) p.get("id");
        Map<String, Object> asked = store.eventOfType(id, "TRAVEL_RULE_RFI");
        if (asked == null) {
            throw new ServiceError(409, "no_rfi", "no outstanding RFI on this payment");
        }
        if (store.eventOfType(id, "TRAVEL_RULE_RECEIVED") != null) {
            throw alreadyResolved();
        }
        Object answers = fields.get("answers");
        if (!given(answers)) {
            throw new ServiceError(400, "missing_field", "answers is required");
        }
        Object sig = fields.get("sig");
        Object spki = bank.get("signing_spki");
        Map<String, Object> signed = new LinkedHashMap<>();
        signed.put("payment_id", id);
        signed.put("answers", answers);
        if (!JsValues.truthy(sig) || !(spki instanceof String) || ((String) spki).isEmpty() || !Signatures.verifyEvent(signed, sig, (String) spki)) {
            throw new ServiceError(400, "invalid_signature", "sig must cover {payment_id, answers} with the bank key");
        }

        // What is sent: the answers under the question's id, encrypted to the institution; their digest; the platform's signature.
        Map<String, Object> bfi = registry.institution((String) p.get("beneficiary_institution"));
        if (bfi == null) {
            throw new JsValues.EngineError("the settlement's receiving institution is not in the registry");
        }
        String bfiId = (String) bfi.get("id");
        Object rfiId = JsValues.member(Js.parse((String) asked.get("payload")), "rfi_id");
        Map<String, Object> message = new LinkedHashMap<>();
        message.put("payment_id", id);
        message.put("rfi_id", rfiId);
        message.put("answers", answers);
        Object jwk = bfi.get("encryption_jwk") instanceof String ? Js.parse((String) bfi.get("encryption_jwk")) : null;
        if (!(jwk instanceof Map)) {
            throw new JsValues.EngineError("the receiving institution has no encryption key to read");
        }
        String jwe = TravelRule.encrypt(Js.stringify(message).getBytes(StandardCharsets.UTF_8), (Map<String, Object>) jwk, bfiId + "-ENC");
        String answersDigest = Hex.encode(Hex.sha256(Canonical.bytes(message)));
        Map<String, Object> vouched = new LinkedHashMap<>();
        vouched.put("payment_id", id);
        vouched.put("rfi_id", rfiId);
        vouched.put("answers_digest", answersDigest);
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("payment_id", id);
        request.put("jwe", jwe);
        request.put("answers_digest", answersDigest);
        request.put("sender", platform.signEvent(vouched));

        PartnerExchange partner = exchange.get();
        if (partner == null) {
            throw new ServiceError(502, "partner_unreachable", PATH + ": this build has no connection to the receiving institution");
        }
        // One call, inside the request, with no lock held. Whatever it comes to short of an answer below 400 writes nothing.
        PartnerAnswer answer = partner.post(PATH, keyOf(id, rfiId), Js.stringify(request));
        if (answer.kind != PartnerAnswer.Kind.HTTP) {
            throw new ServiceError(502, "partner_unreachable", answer.failure(PATH, partner.base()));
        }
        if (answer.status >= 400) {
            throw new ServiceError(502, "partner_error", answer.failure(PATH, partner.base()));
        }

        // The answer, read as it has always been read: whatever JSON came; a body that is no JSON is an empty object.
        Object ack = answer.isJson ? answer.json : new LinkedHashMap<String, Object>();
        Object acknowledgement = JsValues.member(ack, "ack");
        boolean rejected = "REJECTED".equals(JsValues.member(ack, "status")) || !JsValues.truthy(acknowledgement);
        Object reason = null;
        Object ackPayload = null;
        Object ackSig = null;
        if (rejected) {
            Object said = JsValues.member(ack, "reason");
            reason = JsValues.nullish(said) ? DEFAULT_REASON : said;
        } else {
            // An acknowledgement stands on its signature. One that does not hold is the bank's to hear, and changes nothing.
            ackPayload = JsValues.member(acknowledgement, "payload");
            ackSig = JsValues.member(acknowledgement, "sig");
            JsValues.member(ackSig, "key_id"); // an acknowledgement with no signature at all is nothing that can be read
            signatures.verify(ackPayload, ackSig, ACKNOWLEDGES);
        }

        Object rejectedFor = reason;
        Object receivedPayload = ackPayload;
        Object receivedSig = ackSig;
        Outcome out = TxRetry.execute(tx, (status) -> {
            Outcome o = new Outcome();
            // The lock is the first statement: what is read after it is what is there now.
            Map<String, Object> now = store.lock(id);
            if (now == null || !orgId.equals(now.get("org_id"))) {
                o.refusal = notFound(paymentId);
                return o;
            }
            if (!PENDING.equals(now.get("state"))) {
                // Cancelled, or moved on, while the institution was being asked.
                o.refusal = wrongState(now.get("state"));
                return o;
            }
            if (store.eventOfType(id, "TRAVEL_RULE_RECEIVED") != null) {
                // Another answer to this question was accepted first. It stands, whatever this one came to.
                o.refusal = alreadyResolved();
                return o;
            }
            if (rejected) {
                Map<String, Object> refused = new LinkedHashMap<>();
                refused.put("payment_id", id);
                refused.put("reason", rejectedFor);
                int seq = store.appendEvent(id, "TRAVEL_RULE_REJECTED", bfiId, refused, null);
                if (!store.moveState(id, PENDING, "CANCELLED")) {
                    throw new IllegalStateException("settlement " + id + " was moved while its row was locked");
                }
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("reason", rejectedFor);
                outbox.enqueue(orgId, id, seq, "CANCELLED", "CANCELLED", data);
                return o;
            }
            Map<String, Object> resolved = new LinkedHashMap<>();
            resolved.put("payment_id", id);
            resolved.put("rfi_id", rfiId);
            resolved.put("answers_digest", answersDigest);
            resolved.put("resolved_at", IsoTime.now());
            int seq = store.appendEvent(id, "TRAVEL_RULE_RFI_RESOLVED", PlatformKey.ISSUER, resolved, platform.signEvent(resolved));
            // The acknowledgement is kept as the institution sent it, signature and all.
            store.appendEvent(id, "TRAVEL_RULE_RECEIVED", bfiId, receivedPayload, receivedSig);
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("rfi_id", rfiId);
            outbox.enqueue(orgId, id, seq, "TRAVEL_RULE_RFI_RESOLVED", PENDING, data);
            try {
                o.approval = jobs.insertClaimed(id, orgId, RemitJobs.Kind.PAYOUT_APPROVAL, id + ":approval", null);
            } catch (DuplicateKeyException e) {
                // The pipeline of a settlement that waits for the bank's answer has no open job. If it has one, something is
                // wrong that this request cannot repair: nothing is written, and the line says where to look.
                Log.line("rfi-response: the settlement already has an open pipeline job, the answer was not recorded", Log.fields("payment", id));
                throw new IllegalStateException("settlement " + id + " has an open pipeline job while it waits for an answer", e);
            }
            return o;
        });
        if (out.refusal != null) {
            throw out.refusal;
        }
        if (out.approval != null) {
            // The payout approval goes on off this request's lifetime.
            executor.runNow(out.approval);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("payment_id", id);
        result.put("state", rejected ? "CANCELLED" : PENDING);
        return result;
    }
}
