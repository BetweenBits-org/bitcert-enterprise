package com.stonehash.attest.remit;

import java.math.BigInteger;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECFieldFp;
import java.security.spec.ECPoint;
import java.security.spec.EllipticCurve;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Re-checking a settlement's evidence package on the bank's own machine, from
 * what {@link RemitClient#evidence} returns and nothing else.
 *
 * <p>The four checks of the reference verifier, under its names:
 * <ol>
 * <li><b>commitment</b> — {@code SHA-256("STONEHASH-EVIDENCE-V1" ‖ nonce ‖ JCS(package))}
 *     equals the value the platform anchored;
 * <li><b>signatures</b> — every evidence element re-verified against the
 *     Trust Registry snapshot carried <em>inside</em> the package;
 * <li><b>verdict</b> — the six-axis rules re-run here, on what check 2
 *     established and under the policy the package carries; every axis must
 *     read as the platform's verdict reads, in whatever order the package
 *     lists its axes (a file re-serialised by a tool or a JSON column is the
 *     same package);
 * <li><b>anchor</b> — the proof file re-checked (the record is in the batch's
 *     Merkle root, the anchor output commits that root, the output belongs to
 *     the stated transaction), and its leaf is the commitment from (1).
 * </ol>
 * A check that could not be carried out — a registry that cannot be read, a
 * policy the rules cannot interpret — fails; it is never passed and never
 * skipped. The one thing reported as {@link EvidenceReport.State#NOT_RUN} is
 * a proof file of a form this SDK does not re-verify.
 *
 * <p>Neither SDK confirms that the transaction is in a block of a public
 * chain: that is {@code onchain:skip} in the anchor check's detail, and is for
 * a Bitcoin source of the reader's choosing.
 */
public final class EvidenceVerifier {
    static final String COMMIT_DOMAIN = "STONEHASH-EVIDENCE-V1";

    private EvidenceVerifier() {
    }

    /**
     * @param evidenceResponse what {@link RemitClient#evidence} returned: {@code package}, {@code commitment}, {@code attestation}
     */
    public static EvidenceReport verify(Map<String, Object> evidenceResponse) {
        List<EvidenceReport.Check> checks = new ArrayList<>();
        Object pkg = evidenceResponse.get("package");
        Object commitment = evidenceResponse.get("commitment");
        if (!(pkg instanceof Map) || !(commitment instanceof Map)) {
            checks.add(new EvidenceReport.Check("commitment", EvidenceReport.State.FAIL, "the response holds no package or no commitment"));
            return new EvidenceReport(checks);
        }
        Map<String, Object> packageJson = Json.object(pkg, "invalid_evidence", "package");
        Map<String, Object> commit = Json.object(commitment, "invalid_evidence", "commitment");
        String stated = commit.get("value") instanceof String ? (String) commit.get("value") : "";

        // 1 — commitment
        String recomputed;
        try {
            if (!(commit.get("nonce") instanceof String)) {
                throw new RemitException("invalid_evidence", "the commitment's nonce is not hex");
            }
            recomputed = Signing.commitment(packageJson, (String) commit.get("nonce"));
            checks.add(new EvidenceReport.Check("commitment", recomputed.equals(stated) ? EvidenceReport.State.PASS : EvidenceReport.State.FAIL,
                    "recomputed " + recomputed.substring(0, 16) + "…"));
        } catch (RemitException e) {
            checks.add(new EvidenceReport.Check("commitment", EvidenceReport.State.FAIL, e.getMessage()));
        }

        // Checks 2 and 3 rest on one pass: every element signature computed against the registry in the package.
        // What the evidence says of its own signatures — a status, a trust level — is never taken for a result.
        Map<String, Object> checked = null;
        String unreadable = null;
        try {
            if (!(packageJson.get("evidence") instanceof Map)) {
                throw new VerdictEngine.NotEvaluable("the package carries no evidence");
            }
            checked = VerdictEngine.checkSignatures(Json.object(packageJson.get("evidence"), "invalid_evidence", "evidence"),
                    keyring(packageJson.get("trust_registry")));
        } catch (VerdictEngine.NotEvaluable e) {
            unreadable = e.getMessage();
        }

        // 2 — element signatures
        if (checked == null) {
            // A check that cannot be carried out is a check that failed, reported like the others.
            checks.add(new EvidenceReport.Check("signatures", EvidenceReport.State.FAIL, "could not be checked — " + unreadable));
        } else {
            List<String> states = new ArrayList<>();
            for (Map.Entry<String, Object> e : Json.object(checked.get("elements"), "invalid_evidence", "elements").entrySet()) {
                List<?> items = e.getValue() instanceof List ? (List<?>) e.getValue() : Collections.singletonList(e.getValue());
                for (Object item : items) {
                    states.add(e.getKey() + ":" + signatureState(e.getKey(), item));
                }
            }
            boolean allValid = !states.isEmpty() && states.stream().allMatch((s) -> s.endsWith(":VALID"));
            checks.add(new EvidenceReport.Check("signatures", allValid ? EvidenceReport.State.PASS : EvidenceReport.State.FAIL,
                    states.isEmpty() ? "the package carries no evidence element" : String.join(" ", states)));
        }

        // 3 — the six-axis verdict, re-run here
        checks.add(verdict(packageJson, checked, unreadable));

        // 4 — the Bitcoin anchor: the proof file re-checked, and its leaf must be the commitment from (1)
        Object attestation = evidenceResponse.get("attestation");
        Object bundle = attestation instanceof Map ? ((Map<?, ?>) attestation).get("bundle") : null;
        if (bundle instanceof Map) {
            Map<String, Object> proof = Json.object(bundle, "invalid_evidence", "the proof file");
            Object record = proof.get("record");
            Object leaf = record instanceof Map ? ((Map<?, ?>) record).get("leaf_bytes") : null;
            boolean leafOk = stated.equals(leaf);
            AnchorProof.Outcome outcome = AnchorProof.verify(proof);
            String detail = "leaf==commitment:" + leafOk + " " + String.join(" ", outcome.checks);
            if (outcome.unsupported != null && leafOk) {
                checks.add(new EvidenceReport.Check("anchor", EvidenceReport.State.NOT_RUN, detail + " — this proof file is of a form the Java SDK "
                        + "does not re-verify (" + outcome.unsupported + "); the TypeScript SDK and the public verify page do"));
            } else {
                checks.add(new EvidenceReport.Check("anchor", leafOk && outcome.unsupported == null && outcome.verified
                        ? EvidenceReport.State.PASS : EvidenceReport.State.FAIL, detail));
            }
        } else {
            checks.add(new EvidenceReport.Check("anchor", EvidenceReport.State.FAIL, "no bundle present — anchor still pending"));
        }
        return new EvidenceReport(checks);
    }

    /**
     * The status the signature pass computed for one element. Only a status
     * computed here counts: an element under a name the pass does not check
     * keeps whatever status it arrived with — "VALID", written by whoever
     * built the package — so it is reported as not verified.
     */
    private static String signatureState(String name, Object element) {
        if (!VerdictEngine.SIGNABLE.contains(name)) {
            return "NOT_VERIFIED";
        }
        if (!(element instanceof Map)) {
            return "ABSENT";
        }
        Object signature = ((Map<?, ?>) element).get("signature");
        Object status = signature instanceof Map ? ((Map<?, ?>) signature).get("status") : null;
        return status instanceof String ? (String) status : "ABSENT";
    }

    /** The rules re-run on the verified evidence, and each axis compared with what the platform's verdict says. */
    private static EvidenceReport.Check verdict(Map<String, Object> packageJson, Map<String, Object> checked, String unreadable) {
        if (checked == null) {
            return new EvidenceReport.Check("verdict", EvidenceReport.State.FAIL, "not re-evaluated: the element signatures could not be checked");
        }
        VerdictEngine.Result mine;
        try {
            mine = VerdictEngine.evaluate(checked, packageJson.get("policy"));
        } catch (VerdictEngine.NotEvaluable e) {
            return new EvidenceReport.Check("verdict", EvidenceReport.State.FAIL, "could not be re-evaluated — " + e.getMessage());
        }
        Object verdict = packageJson.get("verdict");
        Object axes = verdict instanceof Map ? ((Map<?, ?>) verdict).get("axes") : null;
        if (!(axes instanceof Map)) {
            return new EvidenceReport.Check("verdict", EvidenceReport.State.FAIL,
                    "could not be re-evaluated — the package states no verdict to compare the re-run with");
        }
        // What the package states: every axis it names, and the state of each that gives one, whatever that state is.
        Map<String, Object> named = Json.object(axes, "invalid_evidence", "axes");
        Map<String, Object> theirs = new LinkedHashMap<>();
        for (Map.Entry<String, Object> axis : named.entrySet()) {
            if (axis.getValue() == null) {
                return new EvidenceReport.Check("verdict", EvidenceReport.State.FAIL,
                        "could not be re-evaluated — the package's verdict cannot be read: " + axis.getKey() + " is null");
            }
            if (axis.getValue() instanceof Map && ((Map<?, ?>) axis.getValue()).containsKey("state")) {
                theirs.put(axis.getKey(), ((Map<?, ?>) axis.getValue()).get("state"));
            }
        }
        // Compared as the reference compares them: the package names the same axes and gives each the same state.
        // The order it lists them in carries no meaning and is not compared — the commitment is made over a
        // canonical form that sorts members, so a file re-serialised by a tool or stored in a JSON column is the
        // same package. An axis only one side has is a difference, also one the package names without a state.
        boolean agree = named.size() == mine.states.size();
        for (Map.Entry<String, String> axis : mine.states.entrySet()) {
            agree = agree && theirs.containsKey(axis.getKey()) && axis.getValue().equals(theirs.get(axis.getKey()));
        }
        if (!agree) {
            // One order whatever order the file had, and the reference's: the axes of the re-run first, as the rules
            // list them, then any other axis the package gives a state for, by name (UTF-16 code units, as String
            // compares). An axis named without a state is not listed: there is no state to show for it.
            List<String> stated = new ArrayList<>();
            for (String axis : mine.states.keySet()) {
                if (theirs.containsKey(axis)) {
                    stated.add(axis);
                }
            }
            List<String> others = new ArrayList<>();
            for (String axis : theirs.keySet()) {
                if (!mine.states.containsKey(axis)) {
                    others.add(axis);
                }
            }
            Collections.sort(others);
            stated.addAll(others);
            // What the two maps do not show: an axis named beyond the six, without a state.
            List<String> silent = new ArrayList<>();
            for (String axis : named.keySet()) {
                if (!mine.states.containsKey(axis) && !theirs.containsKey(axis)) {
                    silent.add(axis);
                }
            }
            Collections.sort(silent);       // by name, before a name is written as JSON text
            StringBuilder also = new StringBuilder();
            for (String axis : silent) {
                also.append(also.length() == 0 ? " — the package also names " : ", ").append(Json.compact(axis));
            }
            if (also.length() > 0) {
                also.append(", without a state");
            }
            return new EvidenceReport.Check("verdict", EvidenceReport.State.FAIL,
                    "local " + axesText(new ArrayList<>(mine.states.keySet()), mine.states) + " ≠ platform " + axesText(stated, theirs) + also);
        }
        List<String> said = new ArrayList<>();
        for (Map.Entry<String, String> axis : mine.states.entrySet()) {
            said.add(axis.getKey() + "=" + axis.getValue());
        }
        return new EvidenceReport.Check("verdict", EvidenceReport.State.PASS, String.join(" ", said));
    }

    /**
     * Axes and their states as JSON text, in the order given — written member
     * by member, as the reference writes this sentence, so that an axis named
     * like a whole number stands where the order puts it and not where a JSON
     * object would list it.
     */
    private static String axesText(List<String> order, Map<String, ?> states) {
        StringBuilder out = new StringBuilder("{");
        for (String axis : order) {
            if (out.length() > 1) {
                out.append(',');
            }
            out.append(Json.compact(axis)).append(':').append(JsValue.stringify(states.get(axis)));
        }
        return out.append('}').toString();
    }

    /**
     * The keys of the Trust Registry snapshot a package carries, by
     * institution id.
     *
     * <p>The corridor signs with ECDSA P-256 and nothing else, so a snapshot
     * holding a key that is not one — or the same institution twice — is not
     * one this SDK reads: both checks that rest on it then fail, rather than
     * some signatures being judged against a registry that cannot be trusted
     * as a whole.
     */
    static Map<String, VerdictEngine.Key> keyring(Object registry) {
        Object institutions = registry instanceof Map ? ((Map<?, ?>) registry).get("institutions") : null;
        if (!(institutions instanceof List)) {
            throw new VerdictEngine.NotEvaluable("the package carries no Trust Registry snapshot");
        }
        Map<String, VerdictEngine.Key> keys = new LinkedHashMap<>();
        List<Object> ids = new ArrayList<>();
        for (Object entry : (List<?>) institutions) {
            if (entry == null) {
                throw new VerdictEngine.NotEvaluable("the Trust Registry snapshot holds an entry that is null");
            }
            Map<?, ?> institution = entry instanceof Map ? (Map<?, ?>) entry : Collections.emptyMap();
            Object spki = institution.get("signing_spki");
            if (!VerdictEngine.truthy(spki)) {
                continue;       // an institution with no signing key signs nothing
            }
            Object id = institution.containsKey("id") ? institution.get("id") : VerdictEngine.UNDEFINED;
            for (Object seen : ids) {
                if (VerdictEngine.strictEquals(seen, id)) {
                    throw new VerdictEngine.NotEvaluable("the Trust Registry snapshot lists " + id + " twice");
                }
            }
            ids.add(id);
            ECPublicKey key;
            try {
                key = Signers.publicKeyOf(Base64Url.lenient((String) spki));
            } catch (RuntimeException e) {
                throw new VerdictEngine.NotEvaluable("the Trust Registry snapshot holds a key for " + id + " that is not an ECDSA P-256 public key");
            }
            if (!onCurve(key)) {
                throw new VerdictEngine.NotEvaluable("the Trust Registry snapshot holds a key for " + id + " that is not a point of the curve");
            }
            if (id instanceof String) {
                keys.put((String) id, new VerdictEngine.Key(institution.containsKey("name") ? institution.get("name") : VerdictEngine.UNDEFINED,
                        Base64.getEncoder().encodeToString(key.getEncoded())));
            }
        }
        return keys;
    }

    /** y² = x³ + ax + b over the curve's field: a public key that is not on its curve is no key. */
    static boolean onCurve(ECPublicKey key) {
        ECPoint w = key.getW();
        EllipticCurve curve = key.getParams().getCurve();
        if (w == null || ECPoint.POINT_INFINITY.equals(w) || !(curve.getField() instanceof ECFieldFp)) {
            return false;
        }
        BigInteger p = ((ECFieldFp) curve.getField()).getP();
        BigInteger x = w.getAffineX();
        BigInteger y = w.getAffineY();
        if (x.signum() < 0 || y.signum() < 0 || x.compareTo(p) >= 0 || y.compareTo(p) >= 0) {
            return false;
        }
        BigInteger right = x.pow(3).add(curve.getA().multiply(x)).add(curve.getB()).mod(p);
        return y.multiply(y).mod(p).equals(right);
    }
}
