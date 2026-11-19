package com.stonehash.attest.remit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Re-checking evidence: the proof-file check against what the reference
 * verifier answers ({@code golden/anchor.json}), and the whole of it — all
 * four checks — against an evidence response as the sandbox issued it
 * ({@code evidence/sandbox-anchored.json} — synthetic, as all sandbox data is).
 */
final class EvidenceVerifierTest {
    private EvidenceVerifierTest() {
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> anchorCases() throws Exception {
        Map<String, Object> golden = Json.object(Json.parse(TestMain.resource("golden/anchor.json"), "invalid_json", "anchor.json"), "x", "anchor.json");
        return (List<Map<String, Object>>) golden.get("cases");
    }

    /** A copy that can be changed: what the parser returns is frozen nowhere, but one case must not reach the next. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> evidence() throws Exception {
        return (Map<String, Object>) Json.parse(TestMain.resource("evidence/sandbox-anchored.json"), "invalid_json", "the evidence");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> in(Map<String, Object> from, String... path) {
        Map<String, Object> at = from;
        for (String key : path) {
            at = (Map<String, Object>) at.get(key);
        }
        return at;
    }

    private static EvidenceReport.Check check(EvidenceReport report, String name) {
        for (EvidenceReport.Check c : report.checks()) {
            if (c.name().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("no check named " + name + " in " + report.checks());
    }

    private static String flipped(String hex, int at) {
        return hex.substring(0, at) + (hex.charAt(at) == '0' ? '1' : '0') + hex.substring(at + 1);
    }

    // ── the proof file, against the reference verifier ────────────────────────

    static void testAProofFileIsJudgedAsTheReferenceVerifierJudgesIt() throws Exception {
        int same = 0;
        int verified = 0;
        for (Map<String, Object> c : anchorCases()) {
            if (!"same".equals(c.get("java"))) {
                continue;
            }
            String name = (String) c.get("name");
            Map<String, Object> expected = Json.object(c.get("expected"), "x", "expected");
            AnchorProof.Outcome outcome = AnchorProof.verify(Json.object(c.get("bundle"), "x", "bundle"));
            Check.equal(null, outcome.unsupported, name + ": a form this SDK re-verifies");
            Check.equal(expected.get("verified"), outcome.verified, name + ": verified");
            Check.equal(expected.get("checks"), new ArrayList<Object>(outcome.checks), name + ": each check, in the reference's order");
            same++;
            verified += outcome.verified ? 1 : 0;
        }
        Check.isTrue(same >= 31, "every vector was read: " + same);
        Check.isTrue(verified >= 9 && verified < same, "sound files pass and tampered ones do not: " + verified + " of " + same);
    }

    static void testAnotherFormOfProofFileIsSaidToBeUnsupportedAndNeverPassed() throws Exception {
        int seen = 0;
        for (Map<String, Object> c : anchorCases()) {
            if (!"unsupported".equals(c.get("java"))) {
                continue;
            }
            AnchorProof.Outcome outcome = AnchorProof.verify(Json.object(c.get("bundle"), "x", "bundle"));
            Check.isTrue(outcome.unsupported != null, c.get("name") + ": said to be a form that is not re-verified here");
            Check.isTrue(!outcome.verified, c.get("name") + ": and not passed");
            seen++;
        }
        Check.equal(3, seen, "the three other forms");
    }

    // ── a whole evidence response ─────────────────────────────────────────────

    static void testAnEvidenceResponseAsTheSandboxIssuedItIsReChecked() throws Exception {
        EvidenceReport report = EvidenceVerifier.verify(evidence());
        List<String> names = new ArrayList<>();
        for (EvidenceReport.Check c : report.checks()) {
            names.add(c.name());
        }
        Check.equal(java.util.Arrays.asList("commitment", "signatures", "verdict", "anchor"), names, "the reference verifier's four checks, by its names");
        Check.equal(EvidenceReport.State.PASS, check(report, "commitment").state(), "commitment");
        Check.equal(EvidenceReport.State.PASS, check(report, "signatures").state(), "signatures: " + check(report, "signatures").detail());
        Check.equal(EvidenceReport.State.PASS, check(report, "verdict").state(), "the six-axis rules, re-run here, read as the platform's verdict reads: "
                + check(report, "verdict").detail());
        Check.equal("integrity=VALID issuer=VALID matching=MATCH completeness=COMPLETE regulatoryMapping=REVIEW_REQUIRED businessFinality=DEMO_ONLY",
                check(report, "verdict").detail(), "each axis, as it was re-computed — the last two capped, because sandbox data is synthetic");
        Check.equal(EvidenceReport.State.PASS, check(report, "anchor").state(), "anchor");
        Check.equal("leaf==commitment:true schema:pass preimage:warn merkle:pass anchor-commitment:pass txid-binding:pass onchain:skip",
                check(report, "anchor").detail(), "what the anchor check looked at — and that the public chain was not asked");
        Check.isTrue(report.noneFailed(), "nothing failed");
        Check.isTrue(report.complete() && report.verified(), "all four checks were run and passed: the package is verified");
    }

    /**
     * A file that was stored and written out again — by a tool, by a JSON
     * column — may list the members of an object in another order. The
     * commitment is made over a canonical form that sorts them, so it is the
     * same package: all four checks pass as they did, the verdict included.
     */
    static void testAPackageWhoseAxesWereWrittenInAnotherOrderIsTheSamePackage() throws Exception {
        Map<String, Object> stored = evidence();
        Map<String, Object> verdict = in(stored, "package", "verdict");
        Map<String, Object> axes = in(verdict, "axes");
        List<String> names = new ArrayList<>(axes.keySet());
        java.util.Collections.reverse(names);
        Map<String, Object> reversed = new LinkedHashMap<>();
        for (String name : names) {
            reversed.put(name, axes.get(name));
        }
        Check.isTrue(!new ArrayList<>(reversed.keySet()).equals(new ArrayList<>(axes.keySet())) && reversed.equals(axes), "the same axes, in another order");
        verdict.put("axes", reversed);

        EvidenceReport report = EvidenceVerifier.verify(stored);
        Check.equal(EvidenceReport.State.PASS, check(report, "commitment").state(), "the commitment is over the canonical form: the order of members is not in it");
        Check.equal(EvidenceReport.State.PASS, check(report, "verdict").state(), "the same verdict: " + check(report, "verdict").detail());
        Check.equal("integrity=VALID issuer=VALID matching=MATCH completeness=COMPLETE regulatoryMapping=REVIEW_REQUIRED businessFinality=DEMO_ONLY",
                check(report, "verdict").detail(), "said in the order the rules list the axes, whatever order the file had");
        Check.isTrue(report.complete() && report.verified(), "all four checks pass, as for the file as it was issued");

        // The order hides nothing: a state that is another one is still a difference — and, being inside the package, fails the commitment too.
        in(reversed, "matching").put("state", "MISMATCH");
        EvidenceReport changed = EvidenceVerifier.verify(stored);
        Check.equal(EvidenceReport.State.FAIL, check(changed, "verdict").state(), "a state that differs");
        Check.equal("local {\"integrity\":\"VALID\",\"issuer\":\"VALID\",\"matching\":\"MATCH\",\"completeness\":\"COMPLETE\",\"regulatoryMapping\":\"REVIEW_REQUIRED\","
                + "\"businessFinality\":\"DEMO_ONLY\"} ≠ platform {\"integrity\":\"VALID\",\"issuer\":\"VALID\",\"matching\":\"MISMATCH\",\"completeness\":\"COMPLETE\","
                + "\"regulatoryMapping\":\"REVIEW_REQUIRED\",\"businessFinality\":\"DEMO_ONLY\"}",
                check(changed, "verdict").detail(), "both verdicts in the rules' order, though the file lists them in reverse");
        Check.equal(EvidenceReport.State.FAIL, check(changed, "commitment").state(), "and the package is no longer the one committed to");
        Check.isTrue(!changed.verified(), "not verified");
    }

    static void testChangedEvidenceFailsTheCheckThatCoversIt() throws Exception {
        // A value inside the package: the commitment no longer recomputes (and the element it sits in no longer verifies).
        Map<String, Object> amount = evidence();
        Map<String, Object> instruction = in(amount, "package", "evidence", "elements", "bankInstruction");
        instruction.put("amount", "9999999.00");
        EvidenceReport changedAmount = EvidenceVerifier.verify(amount);
        Check.equal(EvidenceReport.State.FAIL, check(changedAmount, "commitment").state(), "a changed amount: commitment");
        Check.equal(EvidenceReport.State.FAIL, check(changedAmount, "signatures").state(), "a changed amount: signatures");
        Check.isTrue(check(changedAmount, "signatures").detail().contains("bankInstruction:INVALID"), check(changedAmount, "signatures").detail());
        // …and the rules, re-run on what is now in the package, no longer say what the platform's verdict says.
        Check.equal(EvidenceReport.State.FAIL, check(changedAmount, "verdict").state(), "a changed amount: verdict");
        Check.isTrue(check(changedAmount, "verdict").detail().startsWith("local {\"integrity\":\"VALID\",\"issuer\":\"INVALID\",\"matching\":\"MISMATCH\"")
                && check(changedAmount, "verdict").detail().contains(" ≠ platform {\"integrity\":\"VALID\",\"issuer\":\"VALID\",\"matching\":\"MATCH\""),
                check(changedAmount, "verdict").detail());
        Check.isTrue(!changedAmount.verified() && changedAmount.complete(), "every check was run, and it is not verified");

        // The verdict the platform states, changed: the package no longer recomputes, and the re-run says something else than it now claims.
        Map<String, Object> claimed = evidence();
        in(claimed, "package", "verdict", "axes", "matching").put("state", "MISMATCH");
        EvidenceReport otherVerdict = EvidenceVerifier.verify(claimed);
        Check.equal(EvidenceReport.State.FAIL, check(otherVerdict, "commitment").state(), "a changed verdict: commitment");
        Check.equal(EvidenceReport.State.PASS, check(otherVerdict, "signatures").state(), "a changed verdict: the elements are untouched");
        Check.equal(EvidenceReport.State.FAIL, check(otherVerdict, "verdict").state(), "a changed verdict: the re-run does not agree with it");

        // A policy loosened after the fact: the rules run under it give another answer than the verdict that was anchored.
        Map<String, Object> loosened = evidence();
        in(loosened, "package", "policy").put("sourceTrustLevel", "ACCREDITED");
        EvidenceReport underOtherPolicy = EvidenceVerifier.verify(loosened);
        Check.equal(EvidenceReport.State.FAIL, check(underOtherPolicy, "verdict").state(), "another policy: verdict");
        Check.isTrue(check(underOtherPolicy, "verdict").detail().contains("\"issuer\":\"UNKNOWN_ISSUER\""), check(underOtherPolicy, "verdict").detail());

        // A policy the rules cannot interpret, or a registry that cannot be read: a failed check, never a skipped one.
        Map<String, Object> noPolicy = evidence();
        in(noPolicy, "package").remove("policy");
        Check.equal(EvidenceReport.State.FAIL, check(EvidenceVerifier.verify(noPolicy), "verdict").state(), "no policy: verdict");
        Check.isTrue(check(EvidenceVerifier.verify(noPolicy), "verdict").detail().startsWith("could not be re-evaluated — "), "and why");
        Map<String, Object> noRegistry = evidence();
        in(noRegistry, "package").remove("trust_registry");
        EvidenceReport withoutRegistry = EvidenceVerifier.verify(noRegistry);
        Check.equal(EvidenceReport.State.FAIL, check(withoutRegistry, "signatures").state(), "no registry: signatures");
        Check.isTrue(check(withoutRegistry, "signatures").detail().startsWith("could not be checked — "), check(withoutRegistry, "signatures").detail());
        Check.equal(EvidenceReport.State.FAIL, check(withoutRegistry, "verdict").state(), "no registry: verdict");
        Check.equal("not re-evaluated: the element signatures could not be checked", check(withoutRegistry, "verdict").detail(), "and why");
        Check.equal(4, withoutRegistry.checks().size(), "the four checks are always reported, as four lines");

        // The nonce: the commitment is of something else.
        Map<String, Object> nonce = evidence();
        in(nonce, "commitment").put("nonce", flipped((String) in(nonce, "commitment").get("nonce"), 0));
        Check.equal(EvidenceReport.State.FAIL, check(EvidenceVerifier.verify(nonce), "commitment").state(), "a changed nonce");
        Check.equal(EvidenceReport.State.PASS, check(EvidenceVerifier.verify(nonce), "verdict").state(), "a changed nonce: the evidence itself still evaluates as it did");

        // The proof file is of another record.
        Map<String, Object> leaf = evidence();
        Map<String, Object> record = in(leaf, "attestation", "bundle", "record");
        record.put("leaf_bytes", flipped((String) record.get("leaf_bytes"), 10));
        EvidenceReport otherLeaf = EvidenceVerifier.verify(leaf);
        Check.equal(EvidenceReport.State.PASS, check(otherLeaf, "commitment").state(), "the package itself is untouched");
        Check.equal(EvidenceReport.State.FAIL, check(otherLeaf, "anchor").state(), "but what was anchored is not its commitment");
        Check.isTrue(check(otherLeaf, "anchor").detail().startsWith("leaf==commitment:false "), check(otherLeaf, "anchor").detail());

        // The proof file's own arithmetic: root, anchor output, transaction.
        Map<String, Object> root = evidence();
        Map<String, Object> merkle = in(root, "attestation", "bundle", "merkle");
        merkle.put("root", flipped((String) merkle.get("root"), 0));
        Check.isTrue(check(EvidenceVerifier.verify(root), "anchor").detail().contains("merkle:fail anchor-commitment:fail"), "a changed root");
        Check.equal(EvidenceReport.State.FAIL, check(EvidenceVerifier.verify(root), "anchor").state(), "a changed root fails");

        Map<String, Object> tx = evidence();
        Map<String, Object> anchor = in(tx, "attestation", "bundle", "anchor");
        anchor.put("reveal_txid", flipped((String) anchor.get("reveal_txid"), 7));
        EvidenceReport otherTx = EvidenceVerifier.verify(tx);
        Check.equal(EvidenceReport.State.FAIL, check(otherTx, "anchor").state(), "a transaction id the raw transaction does not have");
        Check.isTrue(check(otherTx, "anchor").detail().endsWith("merkle:pass anchor-commitment:pass txid-binding:fail onchain:skip"), check(otherTx, "anchor").detail());

        // Not anchored yet.
        Map<String, Object> pending = evidence();
        in(pending, "attestation").put("bundle", null);
        EvidenceReport noBundle = EvidenceVerifier.verify(pending);
        Check.equal(EvidenceReport.State.FAIL, check(noBundle, "anchor").state(), "no proof file");
        Check.equal("no bundle present — anchor still pending", check(noBundle, "anchor").detail(), "and why");
    }

    static void testAProofFileOfAnotherFormIsNotRunRatherThanPassed() throws Exception {
        Map<String, Object> other = evidence();
        Map<String, Object> bundle = new LinkedHashMap<>(in(other, "attestation", "bundle"));
        bundle.put("chain", new LinkedHashMap<>(java.util.Collections.singletonMap("entry", new LinkedHashMap<>(java.util.Collections.singletonMap("seq", 1L)))));
        in(other, "attestation").put("bundle", bundle);
        EvidenceReport report = EvidenceVerifier.verify(other);
        Check.equal(EvidenceReport.State.NOT_RUN, check(report, "anchor").state(), "a proof file with a chain entry");
        Check.isTrue(report.noneFailed() && !report.complete() && !report.verified(), "nothing failed, but not everything was run: it does not call itself verified");
        Check.isTrue(check(report, "anchor").detail().contains("does not re-verify (it carries a chain entry)"), check(report, "anchor").detail());
        // …but one that is not even of this package's commitment fails, whatever its form.
        Map<String, Object> record = new LinkedHashMap<>(in(bundle, "record"));
        record.put("leaf_bytes", flipped((String) record.get("leaf_bytes"), 0));
        bundle.put("record", record);
        Check.equal(EvidenceReport.State.FAIL, check(EvidenceVerifier.verify(other), "anchor").state(), "another form, and another record");
    }
}
