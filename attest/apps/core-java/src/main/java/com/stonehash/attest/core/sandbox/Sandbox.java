package com.stonehash.attest.core.sandbox;

import com.stonehash.attest.core.evidence.Reconciler;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * The evaluation sandbox: build evidence, break it on purpose, and take a
 * package away that still verifies somewhere else.
 *
 * <p>Nothing here evaluates on its own. The verdict a visitor sees comes
 * from {@code POST /v1/settlements/reconcile} — the endpoint a customer
 * integrates against — so that the verdict on the screen and the verdict in
 * their system are produced by the same code. What the sandbox adds is the
 * material to feed it: the starting documents, the catalogue of ways to
 * damage them, and the package that makes a verdict portable. Everything is
 * a pure transform of constants and of what the request carries; nothing is
 * stored.
 *
 * <p><b>The package.</b> A verdict is worth little if the only place it can
 * be checked is the screen that produced it. The package carries the
 * evidence, the exact policy, the verdict and the public keys the signatures
 * were checked against — enough for the recipient to redo the work rather
 * than believe the sender. Its {@code digest} is the SHA-256 of everything
 * else in canonical form, so an edit to any of it shows without a second
 * file to keep alongside.
 */
public final class Sandbox {
    private final SandboxMaterial material;
    private final Reconciler reconciler;
    private final Map<String, Object> catalogue;

    public Sandbox(SandboxMaterial material, Reconciler reconciler) {
        this.material = material;
        this.reconciler = reconciler;
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("scenarios", material.scenarios);
        c.put("tampers", material.tampers);
        c.put("policy", material.policy);
        c.put("policyDigest", sha256(canonical(material.policy)));
        // Said once, here, so that every screen repeats it from one source.
        c.put("dataMode", material.settlement.get("dataMode"));
        c.put("notRealPayment", JsValues.strictEquals(material.settlement.get("notRealPayment"), Boolean.TRUE));
        c.put("reconcileEndpoint", "/v1/settlements/reconcile");
        c.put("bundleEndpoint", "/v1/settlements/bundle");
        this.catalogue = c;
    }

    // ── canonical form ───────────────────────────────────────────────────────

    /** Canonical JSON: names sorted at every level, no white space, numbers and text as JSON writes them. */
    static String canonical(Object value) {
        StringBuilder out = new StringBuilder();
        canonical(value, out);
        return out.toString();
    }

    private static void canonical(Object v, StringBuilder out) {
        if (v instanceof List) {
            out.append('[');
            boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                canonical(item, out);
            }
            out.append(']');
        } else if (v instanceof Map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : new TreeMap<String, Object>(typed(v)).entrySet()) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                out.append(Js.stringify(e.getKey())).append(':');
                canonical(e.getValue(), out);
            }
            out.append('}');
        } else {
            out.append(Js.stringify(v));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> typed(Object map) {
        return (Map<String, Object>) map;
    }

    static String sha256(String text) {
        return Hex.encode(Hex.sha256(text.getBytes(StandardCharsets.UTF_8)));
    }

    // ── the catalogue ────────────────────────────────────────────────────────

    /** Everything a screen needs to draw itself: the scenarios, the tampers, the policy. No evidence, no verdicts. */
    public Map<String, Object> catalogue() {
        return catalogue;
    }

    // ── evidence ─────────────────────────────────────────────────────────────

    private static final class Step {
        String id;
        String target;
        String amount;
        String document;
    }

    private List<Step> steps(Object given) {
        List<Step> steps = new ArrayList<>();
        if (given == Js.UNDEFINED) {
            return steps;
        }
        if (!(given instanceof List)) {
            throw new HttpError(400, "invalid_tampers", "\"tampers\" must be an array");
        }
        for (Object raw : (List<?>) given) {
            Object id = JsValues.memberIfAny(raw, "id");
            if (!(id instanceof String) || !material.hasTamper((String) id)) {
                throw new HttpError(400, "unknown_tamper", "no such tamper: " + JsValues.string(id));
            }
            Step step = new Step();
            step.id = (String) id;
            step.target = text(JsValues.member(raw, "target"));
            step.amount = text(JsValues.member(raw, "amount"));
            step.document = text(JsValues.member(raw, "document"));
            steps.add(step);
        }
        return steps;
    }

    private static String text(Object v) {
        return v instanceof String ? (String) v : null;
    }

    private static Object apply(Object ev, Step step) {
        switch (step.id) {
            case "amount":
                if (step.amount == null || step.amount.isEmpty()) {
                    throw new HttpError(400, "missing_amount", "an amount change needs \"amount\"");
                }
                return Tamper.changeAmount(ev, step.target != null ? step.target : "chainTransfer", step.amount);
            case "signature":
                return Tamper.breakSignature(ev, step.target != null ? step.target : "payoutReceipt");
            case "document":
                return Tamper.removeDocument(ev, step.document != null ? step.document : "invoice");
            case "digest":
                return Tamper.breakDigest(ev, step.target != null ? step.target : "payoutReceipt");
            case "duplicate":
                return Tamper.duplicateReceipt(ev);
            default:
                throw new HttpError(400, "unknown_tamper", "no such tamper: " + step.id);
        }
    }

    /**
     * {@code POST /v1/console/sandbox/evidence}: the evidence of a scenario
     * — or the caller's own — with the tampers applied in order.
     *
     * <p>The starting document is the caller's if they supplied one. That is
     * the difference between a demonstration and the product: the tampers
     * have to work on uploaded evidence too, or the evaluation would only
     * ever prove something about our fixture.
     *
     * <p>Signatures are checked last. A tamper that rewrites signed content
     * changes what there is to verify, and checking first would describe
     * evidence that no longer exists.
     */
    public Map<String, Object> evidence(Object body) {
        Map<String, Object> fields = Body.fields(body);
        List<Step> steps = steps(given(fields, "tampers"));

        Object supplied = given(fields, "evidence");
        Object ev;
        String id = null;
        if (supplied != Js.UNDEFINED) {
            if (!JsValues.isObject(supplied)) {
                throw new HttpError(400, "invalid_evidence", "\"evidence\" must be an object");
            }
            ev = supplied;
        } else {
            Object chosen = JsValues.nullish(fields.get("scenario")) ? "A" : fields.get("scenario");
            if (!(chosen instanceof String) || !material.hasScenario((String) chosen)) {
                throw new HttpError(400, "unknown_scenario", "no such scenario: " + JsValues.string(chosen));
            }
            id = (String) chosen;
            ev = material.scenario(id);
        }

        List<Object> applied = new ArrayList<>();
        for (Step step : steps) {
            ev = apply(ev, step);
            applied.add(step.id);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scenario", id);
        out.put("source", id != null ? "sample" : "supplied");
        out.put("applied", applied);
        out.put("evidence", checked(ev));
        return out;
    }

    private static Object given(Map<String, Object> fields, String name) {
        return fields.containsKey(name) ? fields.get(name) : Js.UNDEFINED;
    }

    /** The evidence with its signatures checked. Evidence that is not shaped as evidence is where the previous runtime gave up. */
    private Map<String, Object> checked(Object ev) {
        try {
            return reconciler.checkSignatures(ev);
        } catch (Reconciler.Unreadable e) {
            throw new JsValues.EngineError(e.getMessage());
        }
    }

    /** The verdict. A refusal of the rules is answered in their sentence (a 500, as it always was on these routes). */
    private Map<String, Object> verdict(Map<String, Object> checked, Object policy) {
        try {
            return reconciler.evaluate(checked, policy);
        } catch (Reconciler.Refused e) {
            throw new PlainError(e.getMessage());
        } catch (Reconciler.Unreadable e) {
            throw new JsValues.EngineError(e.getMessage());
        }
    }

    // ── the package ──────────────────────────────────────────────────────────

    private Object policyOf(Map<String, Object> fields) {
        Object supplied = given(fields, "policy");
        if (supplied == Js.UNDEFINED) {
            return material.policy;
        }
        if (!JsValues.isObject(supplied)) {
            throw new HttpError(400, "invalid_policy", "\"policy\" must be an object");
        }
        try {
            reconciler.validatePolicy(supplied);
        } catch (Reconciler.Refused | Reconciler.Unreadable e) {
            throw new HttpError(400, "invalid_policy", e.getMessage());
        }
        return supplied;
    }

    /** The public half of each key the signatures were checked against, with the trust it carries: what a recipient needs to redo the check. */
    @SuppressWarnings("unchecked")
    private List<Object> publicKeyMaterial() {
        List<Object> out = new ArrayList<>();
        for (Object each : reconciler.keys()) {
            Map<String, Object> k = (Map<String, Object>) each;
            Map<String, Object> shown = new LinkedHashMap<>();
            shown.put("id", k.get("keyId"));
            shown.put("issuer", k.get("issuer"));
            // The trust level travels with the key, so that a recipient cannot take a demonstration key for an attested one.
            shown.put("trustLevel", k.get("trustLevel"));
            shown.put("publicKeyJwk", k.get("publicKeyJwk"));
            out.add(shown);
        }
        return out;
    }

    /**
     * {@code POST /v1/console/sandbox/package}: seal a verdict into
     * something that can be handed on.
     *
     * @param nowMs the clock: written into the package as {@code generatedAt}
     */
    public Map<String, Object> pack(Object body, long nowMs) {
        Map<String, Object> fields = Body.fields(body);
        Object raw = fields.get("evidence");
        if (!JsValues.isObject(raw)) {
            throw new HttpError(400, "missing_evidence", "provide \"evidence\"");
        }
        Object policy = policyOf(fields);
        Map<String, Object> checked = checked(raw);
        Map<String, Object> verdict = verdict(checked, policy);

        Map<String, Object> pkg = new LinkedHashMap<>();
        pkg.put("schema", "attest-evidence-package/0.1");
        pkg.put("bundleId", fields.get("bundleId") instanceof String ? fields.get("bundleId")
                : "EV-" + sha256(canonical(checked)).substring(0, 8).toUpperCase(Locale.ROOT));
        pkg.put("generatedAt", IsoTime.ofEpochMilli(nowMs));
        pkg.put("evidence", checked);
        pkg.put("policy", policy);
        pkg.put("verdict", verdict);
        Map<String, Object> verificationMaterial = new LinkedHashMap<>();
        verificationMaterial.put("issuerKeys", publicKeyMaterial());
        verificationMaterial.put("policyDigest", verdict.get("policyDigest"));
        pkg.put("verificationMaterial", verificationMaterial);
        // The digest covers everything except itself.
        pkg.put("digest", sha256(canonical(pkg)));
        return pkg;
    }

    /**
     * {@code POST /v1/console/sandbox/package/verify}: re-check a package
     * that came back.
     *
     * <p>Two questions, answered apart because they fail for different
     * reasons. {@code digestOk}: is the file the one that was issued.
     * {@code reproduced}: does running the stated policy over the enclosed
     * evidence still give the enclosed verdict — which can differ honestly,
     * if the rules moved since.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> verifyPackage(Object body) {
        Map<String, Object> fields = Body.fields(body);
        // The package under `package`, or the body itself.
        Object pkg = !JsValues.nullish(fields.get("package")) ? fields.get("package") : body == null ? fields : body;
        if (!JsValues.isObject(pkg) || !(JsValues.member(pkg, "digest") instanceof String) || !JsValues.truthy(JsValues.member(pkg, "evidence"))
                || !JsValues.truthy(JsValues.member(pkg, "policy")) || !JsValues.truthy(JsValues.member(pkg, "verdict"))) {
            throw new HttpError(400, "not_a_package",
                    "that file is not an evidence package: expected \"evidence\", \"policy\", \"verdict\" and \"digest\"");
        }
        Map<String, Object> pack = (Map<String, Object>) pkg;
        String digest = (String) pack.get("digest");
        Map<String, Object> rest = new LinkedHashMap<>(pack);
        rest.remove("digest");
        String recomputed = sha256(canonical(rest));

        Map<String, Object> checked = checked(pack.get("evidence"));
        Map<String, Object> fresh = verdict(checked, pack.get("policy"));

        Object recorded = pack.get("verdict");
        Object recordedAxes = JsValues.member(recorded, "axes");
        List<Object> differences = new ArrayList<>();
        for (Map.Entry<String, Object> axis : ((Map<String, Object>) fresh.get("axes")).entrySet()) {
            Object now = ((Map<String, Object>) axis.getValue()).get("state");
            if (JsValues.strictEquals(now, JsValues.memberIfAny(JsValues.memberIfAny(recordedAxes, axis.getKey()), "state"))) {
                continue;
            }
            // A verdict with no axes at all has nothing to set beside ours: there the previous runtime gave up.
            Object was = JsValues.memberIfAny(JsValues.member(recordedAxes, axis.getKey()), "state");
            Map<String, Object> difference = new LinkedHashMap<>();
            difference.put("axis", axis.getKey());
            if (was != Js.UNDEFINED) {
                difference.put("recorded", was);
            }
            difference.put("now", now);
            differences.add(difference);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("digestOk", recomputed.equals(digest));
        out.put("recordedDigest", digest);
        out.put("recomputedDigest", recomputed);
        out.put("policyUnchanged", JsValues.strictEquals(fresh.get("policyDigest"), JsValues.member(recorded, "policyDigest")));
        out.put("reproduced", differences.isEmpty());
        out.put("differences", differences);
        out.put("verdict", fresh);
        return out;
    }
}
