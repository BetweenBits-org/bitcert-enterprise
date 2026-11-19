package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The two stateless settlement-evidence operations: the verdict as data, and
 * the evidence archive.
 *
 * <p>Stateless is the point. Evidence and policy arrive in the request, the
 * verdict and the archive are computed and returned, and nothing is stored:
 * a reviewer's case data never rests on this service's disk, there is
 * nothing to leak later and nothing to serve stale.
 *
 * <p>Both operations check every issuer signature before a rule runs. A
 * signature's status arrives in the evidence as a claim, and the rules
 * refuse to credit one they did not compute — so the answer is about
 * cryptography and not about what the caller wrote in a field.
 *
 * <p>There is no default policy: a verdict without a stated policy would not
 * be reproducible.
 */
public final class SettlementEvidence {
    private final Reconciler reconciler;

    public SettlementEvidence(Reconciler reconciler) {
        this.reconciler = reconciler;
    }

    private static final class Request {
        final Map<String, Object> fields;
        final Object evidence;
        final Object policy;

        Request(Map<String, Object> fields, Object evidence, Object policy) {
            this.fields = fields;
            this.evidence = evidence;
            this.policy = policy;
        }
    }

    /** What both operations accept: {@code evidence} and {@code policy}, each an object, the policy one the rules can run under. */
    private Request parse(Object body) {
        Map<String, Object> fields = Body.fields(body);
        Object evidence = fields.get("evidence");
        if (!JsValues.isObject(evidence)) {
            throw new HttpError(400, "missing_evidence", "provide \"evidence\": the settlement evidence document to reconcile");
        }
        Object policy = fields.get("policy");
        if (!JsValues.isObject(policy)) {
            throw new HttpError(400, "missing_policy",
                    "provide \"policy\": the rule set to evaluate against. A verdict without a stated policy "
                            + "would not be reproducible, so there is no default.");
        }
        try {
            reconciler.validatePolicy(policy);
        } catch (Reconciler.Refused | Reconciler.Unreadable e) {
            throw new HttpError(400, "invalid_policy", e.getMessage());
        }
        return new Request(fields, evidence, policy);
    }

    /** {@code POST /v1/settlements/reconcile}: the verdict — six axes, every finding, the policy's version and digest. */
    public Map<String, Object> reconcile(Object body) {
        Request r = parse(body);
        try {
            return reconciler.evaluate(reconciler.checkSignatures(r.evidence), r.policy);
        } catch (Reconciler.Refused | Reconciler.Unreadable e) {
            // A malformed amount, or evidence that is no evidence, is the caller's data and not a fault of the service.
            throw new HttpError(400, "invalid_evidence", e.getMessage());
        }
    }

    /**
     * {@code POST /v1/settlements/bundle}: the archive itself, not a link to
     * one — there is no stored object to link to, and a download address
     * would imply a retention this service does not have.
     *
     * <p>The id and the time are the caller's where given, because the
     * archive is a pure function of what goes in and that is what lets its
     * digest be cited. Without them: a random id, and the clock.
     *
     * @param nowMs the clock, for a request that names no time
     * @param uuid  a random UUID, for a request that names no id
     */
    public HttpResult bundle(Object body, long nowMs, Supplier<String> uuid) {
        Request r = parse(body);
        Object named = r.fields.get("bundleId");
        String bundleId = named instanceof String && !((String) named).isEmpty() ? (String) named
                : "EV-" + uuid.get().substring(0, 8).toUpperCase(Locale.ROOT);
        Object given = r.fields.get("generatedAt");
        long generatedAt = nowMs;
        if (JsValues.truthy(given)) {
            Long at = instant(given);
            if (at == null) {
                throw new HttpError(400, "invalid_timestamp", "\"generatedAt\" is not a valid instant: " + JsValues.string(given));
            }
            generatedAt = at;
        }

        Map<String, Object> checked;
        Map<String, Object> verdict;
        try {
            checked = reconciler.checkSignatures(r.evidence);
            verdict = reconciler.evaluate(checked, r.policy);
        } catch (Reconciler.Refused | Reconciler.Unreadable e) {
            throw new HttpError(400, "invalid_evidence", e.getMessage());
        }

        // The archive carries the evidence as it was checked, not as it arrived: a reviewer opening it sees
        // what was verified, not the statuses the document declared.
        EvidenceArchive.Assembled archive = EvidenceArchive.assemble(checked, r.policy, verdict, bundleId, generatedAt);

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("content-type", "application/zip");
        headers.put("content-disposition", "attachment; filename=\"" + archive.filename + "\"");
        // So that a caller can cite the archive without hashing it, and can tell a truncated transfer.
        headers.put("x-evidence-sha256", archive.sha256);
        headers.put("x-evidence-bundle-id", bundleId);
        return new HttpResult(200, archive.zip, headers);
    }

    private static final double MAX_INSTANT_MS = 8.64e15;

    /**
     * The instant a {@code generatedAt} names, in milliseconds since 1970,
     * or {@code null} where it names none. Text is a time written the
     * ISO 8601 way (docs/JAVA-INTENDED-DIFFERENCES.md, D-04); a number is a
     * count of milliseconds; a list is read as the text its items make.
     */
    private static Long instant(Object given) {
        if (given instanceof String) {
            return IsoDate.epochMilli((String) given);
        }
        if (given instanceof Number) {
            double ms = ((Number) given).doubleValue();
            return Double.isNaN(ms) || Math.abs(ms) > MAX_INSTANT_MS ? null : Long.valueOf((long) ms);
        }
        if (given instanceof Boolean) {
            return (Boolean) given ? 1L : 0L;
        }
        if (given instanceof List) {
            return IsoDate.epochMilli(JsValues.string(given));
        }
        // An object: one with a member named toString is where the previous runtime gave up; any other names no time.
        JsValues.string(given);
        return null;
    }
}
