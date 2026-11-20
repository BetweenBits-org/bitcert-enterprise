package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.db.TxRetry;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.log.Log;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * What the receiving institution reports back —
 * {@code POST /v1/remit/callbacks { type, payload, sig }}.
 *
 * <p>No key: the signature is the door. Five things can be reported, each
 * signed by a registered beneficiary institution over its payload:
 * the USDC arrived ({@code USDC_RECEIVED}), the local payout was handed to
 * the local rail ({@code PAYOUT_SUBMITTED}), it completed
 * ({@code PAYOUT_COMPLETED}), it failed ({@code PAYOUT_FAILED}), the USDC
 * went back ({@code USDC_RETURNED}).
 *
 * <p>Neither the order nor the number of these is anybody's promise, so it
 * is kept here. The checks run in this order, because the order decides
 * which refusal a callback with two faults gets:
 * <ol>
 * <li>400 {@code missing_field}: the type; the payload and the signature;
 *     the payment id in the payload — which is text, or it is missing;
 * <li>404 {@code payment_not_found};
 * <li>the signature ({@link PartnerSignatures}): 400 {@code unknown_signer},
 *     {@code role_mismatch}, {@code invalid_signature} — <b>before any
 *     transaction</b>: a route without a key must not be able to hold a
 *     settlement's lock;
 * <li>400 {@code unknown_callback_type}; and, for a completion, 400
 *     {@code missing_field} when the level it states is not text;
 * <li>the settlement's row is locked;
 * <li><b>the same callback again</b> — an event of that type whose payload
 *     has the same canonical form is already on file — is answered 200 and
 *     writes nothing. It is told by the payload, not by the signature:
 *     signed again, the same statement has another signature;
 * <li>then the settlement must be where this callback belongs, or the
 *     answer is 409 {@code wrong_state} and nothing is written.
 * </ol>
 *
 * <p>The repeat is looked for before the state because a callback that
 * applies moves the settlement out of the state it applies in: asked the
 * other way round, the institution that sends a callback again because it
 * never heard the answer would be refused — and stops reporting.
 *
 * <p>What applies where (each one transaction — the event, the state, the
 * notice to the bank, the job that follows):
 * <pre>
 *   USDC_RECEIVED                   ONCHAIN_SETTLED                         → PAYOUT_IN_PROGRESS
 *   PAYOUT_SUBMITTED, PAYOUT_FAILED ONCHAIN_SETTLED, PAYOUT_IN_PROGRESS     the state stays
 *   USDC_RETURNED                   ONCHAIN_SETTLED, PAYOUT_IN_PROGRESS     → RETURNED
 *   PAYOUT_COMPLETED                ONCHAIN_SETTLED, PAYOUT_IN_PROGRESS, not yet reconciled,
 *                                   no completion under reconciliation
 *       stated at exactly L1        the state stays: EVIDENCE_INSUFFICIENT — a better confirmation is waited for
 *       anything else               the state stays, a RECONCILE job is made — and run before this request is answered
 * </pre>
 *
 * <p>A completion that is not held is reconciled, and its evidence packaged,
 * inside the request, as it always was: the institution's own client waits
 * for the answer. The difference is that the work is a job in the store
 * first — a process that stops in the middle leaves it for the worker — and
 * that the answer is 200 whatever the reconciliation comes to: the callback
 * itself was taken.
 */
@Component
public class Callbacks implements RemitRouteSet {
    /** What a callback can report. */
    public static final List<String> TYPES = List.of("USDC_RECEIVED", "PAYOUT_SUBMITTED", "PAYOUT_COMPLETED", "PAYOUT_FAILED", "USDC_RETURNED");
    /** The role whose word a callback is. */
    public static final String ROLE = "BENEFICIARY_FI";
    /** Where the receiving institution's reports belong: the USDC is on the chain, and the settlement has not ended. */
    private static final List<String> REPORTING = List.of("ONCHAIN_SETTLED", "PAYOUT_IN_PROGRESS");
    /** The lane the reconciliation and the package run in. */
    static final String EVIDENCE_LANE = RemitJobs.Kind.RECONCILE.lane;

    private final RemitStore store;
    private final RemitJobs jobs;
    private final ProductRegistry registry;
    private final PlatformKey platform;
    private final WebhookOutbox outbox;
    private final RemitExecutor executor;
    private final TransactionTemplate tx;

    public Callbacks(RemitStore store, RemitJobs jobs, ProductRegistry registry, PlatformKey platform, WebhookOutbox outbox, RemitExecutor executor,
            TransactionTemplate tx) {
        this.store = store;
        this.jobs = jobs;
        this.registry = registry;
        this.platform = platform;
        this.outbox = outbox;
        this.executor = executor;
        this.tx = tx;
    }

    @Override
    public Mark mark() {
        return Mark.AFTER_MANIFESTS;
    }

    @Override
    public void register(Router r) {
        r.post("/v1/remit/callbacks", (ctx) -> handle(ctx.body()));
    }

    // ── the checks that only read ────────────────────────────────────────────

    /** A callback that passed every check that needs no lock. */
    public static final class Checked {
        public String type;
        /** The payload as it arrived: what was signed, and what is stored. */
        public Map<String, Object> payload;
        /** The signature as it arrived. */
        public Object sig;
        /** The payment the payload names, as it names it. */
        public String paymentId;
        /** The id of the institution that signed. */
        public String issuer;
        /** A completion's level ({@code L2} where it states none); {@code null} for the other types. */
        public String level;
    }

    /** What checking a callback reads: two questions, and nothing is written. */
    public interface Lookups {
        /** Is there a settlement of that id? */
        boolean settlement(String paymentId);

        /** The institution of that id as the registry holds it ({@code id, role, signing_spki}), or {@code null}. */
        Map<String, Object> institution(String id);
    }

    private static ServiceError missing(String sentence) {
        return new ServiceError(400, "missing_field", sentence);
    }

    /**
     * Steps 1 to 4: everything about a callback that can be judged without
     * the settlement's lock.
     *
     * @param body the request body, whatever JSON it is
     * @throws ServiceError the refusal, in the order the class comment gives
     */
    @SuppressWarnings("unchecked")
    public static Checked check(Object body, Lookups lookups) {
        Map<String, Object> fields = Body.fields(body);
        Object type = fields.get("type");
        if (JsValues.nullish(type) || "".equals(type)) {
            throw missing("type is required");
        }
        Object payload = fields.get("payload");
        Object sig = fields.get("sig");
        if (!JsValues.truthy(payload) || !JsValues.truthy(sig)) {
            throw missing("payload and sig are required");
        }
        // An id is text: a payment id that is anything else is no payment id, and is never handed to the store.
        Object paymentId = payload instanceof Map ? ((Map<String, Object>) payload).get("payment_id") : null;
        if (!(paymentId instanceof String) || ((String) paymentId).isEmpty()) {
            throw missing("payload.payment_id is required");
        }
        if (!lookups.settlement((String) paymentId)) {
            throw new ServiceError(404, "payment_not_found", "no payment " + paymentId);
        }
        Map<String, Object> issuer = PartnerSignatures.verify(payload, sig, ROLE, lookups::institution);
        if (!(type instanceof String) || !TYPES.contains(type)) {
            throw new ServiceError(400, "unknown_callback_type", "unsupported callback type " + JsValues.string(type));
        }
        Checked out = new Checked();
        out.type = (String) type;
        out.payload = (Map<String, Object>) payload;
        out.sig = sig;
        out.paymentId = (String) paymentId;
        out.issuer = (String) issuer.get("id");
        if (out.type.equals("PAYOUT_COMPLETED")) {
            // The level is stored with the settlement: it is text, or the completion is refused — not read as some level.
            out.level = EvidenceEvents.levelOf(payload);
            if (out.level == null) {
                throw missing("payload.evidence_level must be text");
            }
        }
        return out;
    }

    // ── the request ──────────────────────────────────────────────────────────

    /** What the transaction came to. */
    private static final class Outcome {
        ServiceError refusal;
        /** The completion's reconciliation, to be run before the request is answered. */
        RemitJobs.Held reconcile;
    }

    private static Map<String, Object> accepted() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("accepted", true);
        return out;
    }

    /**
     * One callback, from the body to the answer.
     *
     * @return {@code { "accepted": true }}
     * @throws ServiceError 400, 404 or 409, as the class comment says
     */
    public Map<String, Object> handle(Object body) {
        Checked c = check(body, new Lookups() {
            @Override
            public boolean settlement(String paymentId) {
                return store.exists(paymentId);
            }

            @Override
            public Map<String, Object> institution(String id) {
                return registry.institution(id);
            }
        });
        Outcome out = TxRetry.execute(tx, (status) -> {
            Outcome o = apply(c);
            if (o.refusal != null) {
                // Nothing is written by a refusal, whatever was tried on the way to it.
                status.setRollbackOnly();
            }
            return o;
        });
        if (out.refusal != null) {
            throw out.refusal;
        }
        if (out.reconcile != null) {
            // Reconciled and packaged on this thread, before the institution is answered. Whatever that comes to is in the
            // store; the callback was taken either way.
            try {
                executor.runInline(out.reconcile);
            } catch (RuntimeException e) {
                // An executor does not throw. Should one do so all the same: the completion is on file and its job is in the
                // store for whoever claims it next — the institution is not told that its report failed.
                Log.line("remit callback: the reconciliation did not run to its end inside the request",
                        Log.fields("payment", c.paymentId, "job", out.reconcile.id, "error", String.valueOf(e)));
            }
        }
        return accepted();
    }

    private static ServiceError wrongState(String sentence) {
        return new ServiceError(409, "wrong_state", sentence);
    }

    private static Outcome refused(ServiceError refusal) {
        Outcome o = new Outcome();
        o.refusal = refusal;
        return o;
    }

    /** Is an event of that type on file whose payload says the same — to the canonical form — as this one? */
    private boolean onFile(String paymentId, String type, Object payload) {
        String canonical = Canonical.text(payload);
        for (Map<String, Object> e : store.eventsOfType(paymentId, type)) {
            try {
                if (canonical.equals(Canonical.text(Js.parse((String) e.get("payload"))))) {
                    return true;
                }
            } catch (RuntimeException notCanonical) {
                // A payload on file that has no canonical form is not a copy of one that has.
            }
        }
        return false;
    }

    /** Steps 5 to 7, inside the transaction: the lock first, then the repeat, then the state, then the writes. */
    private Outcome apply(Checked c) {
        Map<String, Object> p = store.lock(c.paymentId);
        if (p == null) {
            return refused(new ServiceError(404, "payment_not_found", "no payment " + c.paymentId));
        }
        String id = (String) p.get("id");
        String orgId = (String) p.get("org_id");
        String state = (String) p.get("state");
        Outcome done = new Outcome();
        if (onFile(id, c.type, c.payload)) {
            return done;
        }
        switch (c.type) {
            case "USDC_RECEIVED": {
                if (!state.equals("ONCHAIN_SETTLED")) {
                    return refused(wrongState("payment is " + state + "; USDC_RECEIVED applies while ONCHAIN_SETTLED"));
                }
                int seq = store.appendEvent(id, c.type, c.issuer, c.payload, c.sig);
                if (!store.moveState(id, state, "PAYOUT_IN_PROGRESS")) {
                    throw new IllegalStateException("settlement " + id + " moved while its row was locked");
                }
                outbox.enqueue(orgId, id, seq, "PAYOUT_IN_PROGRESS", "PAYOUT_IN_PROGRESS", EvidenceEvents.receivedNotice(c.payload));
                return done;
            }
            case "PAYOUT_SUBMITTED":
            case "PAYOUT_FAILED": {
                if (!REPORTING.contains(state)) {
                    return refused(wrongState("payment is " + state + "; " + c.type + " applies while ONCHAIN_SETTLED or PAYOUT_IN_PROGRESS"));
                }
                int seq = store.appendEvent(id, c.type, c.issuer, c.payload, c.sig);
                outbox.enqueue(orgId, id, seq, c.type, state,
                        c.type.equals("PAYOUT_SUBMITTED") ? EvidenceEvents.submittedNotice(c.payload) : EvidenceEvents.failedNotice(c.payload));
                return done;
            }
            case "USDC_RETURNED": {
                if (!REPORTING.contains(state)) {
                    return refused(wrongState("payment is " + state + "; USDC_RETURNED applies while ONCHAIN_SETTLED or PAYOUT_IN_PROGRESS"));
                }
                int seq = store.appendEvent(id, c.type, c.issuer, c.payload, c.sig);
                // The reason is the first failure's, if one was reported.
                Map<String, Object> failed = store.eventOfType(id, "PAYOUT_FAILED");
                if (!store.moveState(id, state, "RETURNED")) {
                    throw new IllegalStateException("settlement " + id + " moved while its row was locked");
                }
                outbox.enqueue(orgId, id, seq, "RETURNED", "RETURNED",
                        EvidenceEvents.returnedNotice(c.payload, failed == null ? null : Js.parse((String) failed.get("payload"))));
                return done;
            }
            case "PAYOUT_COMPLETED":
                return completed(c, id, orgId, state);
            default:
                throw new IllegalStateException("a callback of type " + c.type + " passed the checks");
        }
    }

    /** {@code PAYOUT_COMPLETED}: held at exactly {@code L1}, reconciled otherwise. */
    private Outcome completed(Checked c, String id, String orgId, String state) {
        if (!REPORTING.contains(state)) {
            return refused(wrongState("payment is " + state + "; PAYOUT_COMPLETED applies while ONCHAIN_SETTLED or PAYOUT_IN_PROGRESS"));
        }
        if (store.eventOfType(id, "SETTLEMENT_RECONCILED") != null) {
            return refused(wrongState("payment is " + state + " and was reconciled already; PAYOUT_COMPLETED applies before that"));
        }
        // One completion is reconciled at a time, and what that comes to is the answer to it: another one meanwhile — held or
        // not — is not taken.
        if (jobs.open(id, EVIDENCE_LANE) != null) {
            return refused(underReconciliation(state));
        }
        int seq = store.appendEvent(id, c.type, c.issuer, c.payload, c.sig);
        store.setEvidenceLevel(id, c.level);
        outbox.enqueue(orgId, id, seq, "PAYOUT_COMPLETED", state, EvidenceEvents.completedNotice(c.payload, c.level));
        Outcome done = new Outcome();
        if (c.level.equals("L1")) {
            Map<String, Object> held = EvidenceEvents.insufficient(id, c.level);
            int heldSeq = store.appendEvent(id, "EVIDENCE_INSUFFICIENT", PlatformKey.ISSUER, held, platform.signEvent(held));
            outbox.enqueue(orgId, id, heldSeq, "EVIDENCE_INSUFFICIENT", state, EvidenceEvents.insufficientNotice(c.level));
            return done;
        }
        try {
            // The job says which completion it reconciles: this one, by its number among the settlement's events.
            done.reconcile = jobs.insertClaimed(id, orgId, RemitJobs.Kind.RECONCILE, null, EvidenceEvents.reconcileInput(seq));
        } catch (DuplicateKeyException openedMeanwhile) {
            // A job of this lane was put back into the queue between the look above and here (an operator's requeue does not
            // take the settlement's lock): that one is being reconciled, and this completion is not taken.
            return refused(underReconciliation(state));
        }
        return done;
    }

    private static ServiceError underReconciliation(String state) {
        return wrongState("payment is " + state + " and a completion is being reconciled; another PAYOUT_COMPLETED is not taken meanwhile");
    }
}
