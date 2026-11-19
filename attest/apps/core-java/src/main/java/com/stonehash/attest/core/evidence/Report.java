package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The printable verification report: what a reviewer files.
 *
 * <p>It states the verdict axis by axis, the findings behind each, the
 * policy that produced them and — at the same prominence — what the report
 * does not establish. A summary that left the limits out would be the most
 * misleading member of the archive, because a PDF looks authoritative in a
 * way a JSON file does not. For the same reason the caveat about synthetic
 * data comes first, not in an appendix: a reader who stops after the first
 * page must still know what they are holding.
 *
 * <p>The sentences are fixed text of the product and are the same, to the
 * character, as the service this one replaces printed.
 */
final class Report {
    private Report() {
    }

    private static final Map<String, String> AXIS_LABEL = new LinkedHashMap<>();

    static {
        AXIS_LABEL.put("integrity", "Integrity");
        AXIS_LABEL.put("issuer", "Issuer");
        AXIS_LABEL.put("matching", "Matching");
        AXIS_LABEL.put("completeness", "Completeness");
        AXIS_LABEL.put("regulatoryMapping", "Regulatory mapping");
        AXIS_LABEL.put("businessFinality", "Business finality");
    }

    // The five ways a paragraph is set.
    private static Pdf.Run h1(Object text) {
        return new Pdf.Run(text, Pdf.HELVETICA_BOLD, 17, 0, false, 0);
    }

    private static Pdf.Run h2(Object text, boolean rule) {
        return new Pdf.Run(text, Pdf.HELVETICA_BOLD, 11.5, 18, rule, 0);
    }

    private static Pdf.Run body(Object text, double spaceBefore, boolean rule, double indent) {
        return new Pdf.Run(text, Pdf.HELVETICA, 9.5, spaceBefore, rule, indent);
    }

    private static Pdf.Run mono(Object text) {
        return new Pdf.Run(text, Pdf.COURIER, 8.5, 0, false, 12);
    }

    private static Pdf.Run label(Object text, double spaceBefore) {
        return new Pdf.Run(text, Pdf.HELVETICA_BOLD, 9, spaceBefore, false, 0);
    }

    /** A label, and under it its value in monospace. */
    private static void kv(List<Pdf.Run> runs, String label, Object value) {
        runs.add(label(label, 6));
        runs.add(mono(value));
    }

    /**
     * @param verdict  the rules' own result, as {@link Reconciler#evaluate} returns it
     * @param evidence the evidence it is about. What it says of itself (scenario, data mode, purpose, corridor) is
     *                 printed as it stands; where that is not text the summary cannot be written
     *                 ({@link JsValues.EngineError}, from {@link Pdf#toLatin1})
     */
    @SuppressWarnings("unchecked")
    static List<Pdf.Run> build(Map<String, Object> verdict, Map<String, Object> evidence, String bundleId, long generatedAtMs) {
        List<Pdf.Run> runs = new ArrayList<>();
        Object dataMode = JsValues.member(evidence, "dataMode");

        runs.add(h1("Settlement Evidence Verification Report"));
        runs.add(body("StoneHash Attest", 2, true, 0));

        if (JsValues.strictEquals(dataMode, "SYNTHETIC")) {
            runs.add(label("SYNTHETIC DATA - NOT A RECORD OF A REAL PAYMENT", 14));
            runs.add(body("Every transaction, document and signature described below was fabricated for "
                    + "demonstration. No financial institution has certified it, no regulator has approved it, "
                    + "and no funds moved. Signing keys are demonstration keys, so a valid signature here "
                    + "establishes nothing about who signed.", 0, false, 0));
        }

        runs.add(h2("Subject", true));
        kv(runs, "Scenario", JsValues.member(evidence, "scenario"));
        kv(runs, "Data mode", dataMode);
        Object purpose = JsValues.member(evidence, "purpose");
        if (JsValues.truthy(purpose)) {
            kv(runs, "Stated purpose", purpose);
        }
        Object jurisdiction = JsValues.member(evidence, "jurisdiction");
        if (JsValues.truthy(jurisdiction)) {
            kv(runs, "Corridor", JsValues.string(JsValues.member(jurisdiction, "from")) + " -> " + JsValues.string(JsValues.member(jurisdiction, "to")));
        }
        kv(runs, "Bundle id", bundleId);
        kv(runs, "Report generated", IsoTime.ofEpochMilli(generatedAtMs));

        runs.add(h2("Verdict by axis", false));
        runs.add(body("Reported separately by design. A single pass or fail would hide which claim failed, "
                + "and missing evidence is kept distinct from contradicted evidence because they call for "
                + "different action.", 0, true, 0));
        for (Map.Entry<String, Object> axis : ((Map<String, Object>) verdict.get("axes")).entrySet()) {
            Map<String, Object> result = (Map<String, Object>) axis.getValue();
            String name = AXIS_LABEL.containsKey(axis.getKey()) ? AXIS_LABEL.get(axis.getKey()) : axis.getKey();
            runs.add(label(name + ": " + JsValues.string(result.get("state")), 7));
            List<Object> findings = (List<Object>) result.get("findings");
            for (Object each : findings) {
                Map<String, Object> f = (Map<String, Object>) each;
                runs.add(mono("[" + ((String) f.get("severity")).toUpperCase(Locale.ROOT) + "] " + JsValues.string(f.get("code"))));
                runs.add(body(f.get("detail"), 0, false, 12));
                List<String> parts = new ArrayList<>();
                if (JsValues.truthy(stated(f, "element"))) {
                    Object field = stated(f, "field");
                    parts.add("element=" + JsValues.string(f.get("element")) + (JsValues.truthy(field) ? "." + JsValues.string(field) : ""));
                }
                for (String k : new String[] { "expected", "actual", "tolerance" }) {
                    if (stated(f, k) != Js.UNDEFINED) {
                        parts.add(k + "=" + JsValues.string(f.get(k)));
                    }
                }
                if (!parts.isEmpty()) {
                    runs.add(mono(String.join("   ", parts)));
                }
            }
            if (findings.isEmpty()) {
                runs.add(body("No findings on this axis.", 0, false, 12));
            }
        }

        runs.add(h2("Manual review", true));
        runs.add(body(JsValues.truthy(verdict.get("manualReviewRequired"))
                ? "REQUIRED. At least one axis is not cleanly satisfied. This engine reconciles evidence; "
                        + "whether the payment is acceptable is a judgement about counterparty, jurisdiction and "
                        + "AML risk that it does not make."
                : "Not indicated by the reconciliation. This is not an approval: the engine reports only "
                        + "that every axis it evaluates is satisfied under the stated policy.", 0, false, 0));

        runs.add(h2("Policy", true));
        runs.add(body("The verdict above is reproducible only against the exact rules that produced it. The "
                + "version is a label a human chose; the digest is derived from the canonicalised policy "
                + "bytes, so an edited policy is a different policy whether or not the version was bumped.", 0, false, 0));
        kv(runs, "Policy version", verdict.get("policyVersion"));
        kv(runs, "Policy digest (SHA-256)", verdict.get("policyDigest"));
        kv(runs, "Regulatory decision", verdict.get("regulatoryDecision"));

        runs.add(h2("What this report does not establish", true));
        for (String line : new String[] {
                "AML or CFT suitability. Field-coverage mapping shows whether required data is present in a "
                        + "submission; it is not a compliance determination and no regulator has reviewed it.",
                "The legal identity of any party. Verifying a signature proves a key signed specific bytes. "
                        + "Binding that key to an incorporated entity requires a certificate authority or an "
                        + "identity check, reported here as a separate axis.",
                "The true source of funds, or that the payment was lawful.",
                "A legally certified instant. A Bitcoin block bounds when a commitment existed; it is not an "
                        + "RFC 3161 timestamp from an accredited authority.",
                "That nothing was withheld. Hash-linked history makes tampering with submitted records "
                        + "evident and says nothing about an event that was never submitted.", }) {
            runs.add(body("- " + line, 5, false, 0));
        }

        runs.add(h2("How to re-check this independently", true));
        runs.add(body("This PDF is a summary. The archive it came from carries the full record: evidence.json "
                + "(the sources), policy.json (the exact rules), matching-results.json (this verdict as "
                + "data), and where present merkle-proof.json and bitcoin-anchor.json. Re-running the "
                + "published rules engine over the same evidence and policy reproduces the verdict; running "
                + "the published verifier over the proof files re-derives the anchoring independently of "
                + "StoneHash.", 0, false, 0));
        runs.add(body("Note on language: this summary is rendered with the standard PDF fonts, which cover "
                + "Latin-1 only. Text supplied in other scripts appears in full in the JSON files inside "
                + "the archive.", 10, false, 0));
        return runs;
    }

    /** What a finding states under this name; {@link Js#UNDEFINED} where it states nothing. */
    private static Object stated(Map<String, Object> finding, String name) {
        return finding.containsKey(name) ? finding.get(name) : Js.UNDEFINED;
    }
}
