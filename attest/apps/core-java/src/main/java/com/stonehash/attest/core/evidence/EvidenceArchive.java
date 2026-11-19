package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The evidence archive: one file a reviewer can attach to a case, hand to an
 * auditor or keep for years, and from which the whole result can be derived
 * again without asking this service anything.
 *
 * <p>That is why it carries the inputs as well as the conclusion — the
 * evidence as it was checked, the exact policy, the verdict as data — next
 * to a printable summary. A report alone would be an assertion; the inputs
 * make it checkable.
 *
 * <pre>
 *   manifest.json             what the archive holds, with the SHA-256 of every other member
 *   evidence.json             the evidence, with the signature states this service computed
 *   policy.json               the policy in the canonical form its digest is taken over
 *   matching-results.json     the verdict: six axes, every finding
 *   source-hashes.json        each source's digest, and whether its bytes were checked against it
 *   issuer-signatures.json    each element's signature state
 *   verification-report.pdf   the summary, for filing
 * </pre>
 *
 * <p>Nothing here reads a clock or draws a random number: the id and the
 * time are the caller's, members come in a fixed order and every JSON
 * member is written with its names sorted. Every member is, byte for byte,
 * what the service this one replaces wrote for the same evidence — and so
 * is the manifest that digests them.
 */
public final class EvidenceArchive {
    private EvidenceArchive() {
    }

    /** One member of the archive. */
    public static final class Member {
        public final String path;
        /** One line on what it is, repeated in the manifest. */
        public final String describes;
        public final byte[] bytes;

        Member(String path, String describes, byte[] bytes) {
            this.path = path;
            this.describes = describes;
            this.bytes = bytes;
        }
    }

    /** The archive, and how to cite it. */
    public static final class Assembled {
        public final byte[] zip;
        /** SHA-256 of the archive as sent. */
        public final String sha256;
        public final List<Member> members;
        /** The name a download suggests. */
        public final String filename;

        Assembled(byte[] zip, List<Member> members, String filename) {
            this.zip = zip;
            this.sha256 = Hex.encode(Hex.sha256(zip));
            this.members = members;
            this.filename = filename;
        }
    }

    /**
     * JSON as a member carries it: names sorted at every level, two spaces,
     * a line break at the end. (Names that are whole numbers come first, in
     * numeric order — as they always did.)
     */
    static byte[] json(Object value) {
        return (Js.stringify(sorted(value), 2) + "\n").getBytes(StandardCharsets.UTF_8);
    }

    private static Object sorted(Object v) {
        if (v instanceof List) {
            List<Object> out = new ArrayList<>(((List<?>) v).size());
            for (Object item : (List<?>) v) {
                out.add(sorted(item));
            }
            return out;
        }
        if (v instanceof Map) {
            Map<String, Object> byName = new TreeMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                byName.put((String) e.getKey(), sorted(e.getValue()));
            }
            return Js.inPropertyOrder(new LinkedHashMap<>(byName));
        }
        return v;
    }

    /**
     * The members, manifest first.
     *
     * @param evidence the evidence after its signatures were checked
     * @param verdict  the rules' result on it under {@code policy}
     */
    @SuppressWarnings("unchecked")
    public static List<Member> members(Map<String, Object> evidence, Object policy, Map<String, Object> verdict, String bundleId, long generatedAtMs) {
        List<Member> files = new ArrayList<>();

        files.add(new Member("evidence.json",
                "The source evidence as submitted: the fund movement, payout confirmation, bank instruction "
                        + "and commercial documents, with their digests and signature states.",
                json(evidence)));

        // The canonical form, not a pretty-printed copy: these are the bytes the verdict's policy digest was
        // taken over, so a reader can hash the member and confirm which rules ran.
        files.add(new Member("policy.json",
                "The exact rules that produced the verdict, in the canonical form the policy digest is "
                        + "taken over. Re-hash this file to confirm it matches matching-results.json.",
                (Reconciler.canonicalPolicy(policy) + "\n").getBytes(StandardCharsets.UTF_8)));

        files.add(new Member("matching-results.json",
                "The verdict as data: six axis states, every finding with its expected and actual values, "
                        + "and the policy version and digest that produced them.",
                json(verdict)));

        // Digests and signature states, lifted out for a reader who wants them without walking the evidence.
        Object el = JsValues.member(evidence, "elements");
        Map<String, Object> sources = new LinkedHashMap<>();
        Map<String, Object> signatures = new LinkedHashMap<>();
        record("chainTransfer", JsValues.member(el, "chainTransfer"), sources, signatures);
        Object receipts = JsValues.member(el, "payoutReceipts");
        if (!JsValues.nullish(receipts)) {
            if (!(receipts instanceof List)) {
                throw new JsValues.EngineError("the payout receipts are not a list and cannot be listed");
            }
            int n = 0;
            for (Object receipt : (List<Object>) receipts) {
                record("payoutReceipt[" + (n++) + "]", receipt, sources, signatures);
            }
        }
        record("bankInstruction", JsValues.member(el, "bankInstruction"), sources, signatures);
        record("commercialDocs", JsValues.member(el, "commercialDocs"), sources, signatures);

        files.add(new Member("source-hashes.json",
                "Digest of each source document and whether the submitted bytes were checked against it. "
                        + "`verified: null` means no check was performed - it does not mean the document is intact.",
                json(sources)));

        files.add(new Member("issuer-signatures.json",
                "Signature state per element. Signature validity and issuer identity are separate: a "
                        + "demonstration key can produce a valid signature while establishing nothing about who signed.",
                json(signatures)));

        Object dataMode = JsValues.member(evidence, "dataMode");
        boolean synthetic = JsValues.strictEquals(dataMode, "SYNTHETIC");
        byte[] pdf = Pdf.render(Report.build(verdict, evidence, bundleId, generatedAtMs),
                "Settlement Evidence Verification Report - " + bundleId, generatedAtMs,
                "StoneHash Attest  ·  " + bundleId + "  ·  policy " + JsValues.string(verdict.get("policyVersion")) + (synthetic ? "  ·  SYNTHETIC DATA" : ""));
        files.add(new Member("verification-report.pdf",
                "A printable summary for filing. English only - the standard PDF fonts cover Latin-1, so "
                        + "text in other scripts appears in full in the JSON files instead.",
                pdf));

        // The manifest is made last so that it can digest everything above it, and placed first so that a reader meets it first.
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("bundleFormat", "stonehash-evidence/v1");
        manifest.put("bundleId", bundleId);
        manifest.put("generatedAt", IsoTime.ofEpochMilli(generatedAtMs));
        for (String said : new String[] { "dataMode", "notRealPayment", "scenario" }) {
            Object v = JsValues.member(evidence, said);
            if (v != Js.UNDEFINED) {
                manifest.put(said, v);
            }
        }
        manifest.put("policyVersion", verdict.get("policyVersion"));
        manifest.put("policyDigest", verdict.get("policyDigest"));
        manifest.put("manualReviewRequired", verdict.get("manualReviewRequired"));
        manifest.put("regulatoryDecision", verdict.get("regulatoryDecision"));
        Map<String, Object> axes = new LinkedHashMap<>();
        for (Map.Entry<String, Object> axis : ((Map<String, Object>) verdict.get("axes")).entrySet()) {
            axes.put(axis.getKey(), ((Map<String, Object>) axis.getValue()).get("state"));
        }
        manifest.put("axes", axes);
        // This archive holds no Bitcoin proof: the stateless route anchors nothing.
        manifest.put("bitcoinNetwork", null);
        manifest.put("anchorTxid", null);
        List<Object> contents = new ArrayList<>();
        for (Member f : files) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("path", f.path);
            entry.put("bytes", f.bytes.length);
            entry.put("sha256", Hex.encode(Hex.sha256(f.bytes)));
            entry.put("describes", f.describes);
            contents.add(entry);
        }
        manifest.put("contents", contents);
        List<Object> limitations = new ArrayList<>();
        limitations.add("Field-coverage mapping is not a compliance determination.");
        limitations.add("Signature validity does not establish the signer's legal identity.");
        limitations.add("A Bitcoin block is not an RFC 3161 accredited timestamp.");
        limitations.add("Hash-linked history cannot evidence an event that was never submitted.");
        if (synthetic) {
            limitations.add("All data in this archive is synthetic. No funds moved and no institution certified it.");
        }
        manifest.put("limitations", limitations);
        files.add(0, new Member("manifest.json", "What this archive contains, with a digest of every other member.", json(manifest)));
        return files;
    }

    /** An element's digest and its signature state, where it states them. Anything that is not an object states neither. */
    private static void record(String name, Object element, Map<String, Object> sources, Map<String, Object> signatures) {
        if (!JsValues.isObject(element)) {
            return;
        }
        Object digest = JsValues.member(element, "digest");
        if (digest != Js.UNDEFINED) {
            Map<String, Object> source = new LinkedHashMap<>();
            source.put("digest", digest);
            Object verified = JsValues.member(element, "digestVerified");
            source.put("verified", JsValues.nullish(verified) ? null : verified);
            sources.put(name, source);
        }
        Object signature = JsValues.member(element, "signature");
        if (signature != Js.UNDEFINED) {
            signatures.put(name, signature);
        }
    }

    /** The archive itself. */
    public static Assembled assemble(Map<String, Object> evidence, Object policy, Map<String, Object> verdict, String bundleId, long generatedAtMs) {
        List<Member> members = members(evidence, policy, verdict, bundleId, generatedAtMs);
        List<ZipWriter.Entry> entries = new ArrayList<>();
        for (Member m : members) {
            entries.add(new ZipWriter.Entry(m.path, m.bytes));
        }
        return new Assembled(ZipWriter.write(entries, generatedAtMs, true), members, "stonehash-evidence-" + bundleId + ".zip");
    }
}
