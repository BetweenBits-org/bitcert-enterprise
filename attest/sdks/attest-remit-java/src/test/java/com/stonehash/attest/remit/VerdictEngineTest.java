package com.stonehash.attest.remit;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The six-axis re-evaluation held to the reference: {@code golden/verdict.json}
 * records what the platform's rules engine, its signature pass and the
 * TypeScript SDK's verifier answer for evidence sound, changed and malformed;
 * the same documents are put to {@link VerdictEngine} and
 * {@link EvidenceVerifier} here, and each answer has to be the same.
 *
 * <p>Where the reference gives up on a document, this SDK must give up too —
 * never produce a verdict. Where the reference has an answer, this SDK has the
 * same one, but for the few documents listed below that it refuses by design:
 * a shape of evidence the platform does not produce, which it declines to
 * interpret rather than read the way JavaScript happens to.
 */
final class VerdictEngineTest {
    private VerdictEngineTest() {
    }

    /** Evidence the reference evaluates and this SDK refuses to: text or an object where a list belongs. */
    private static final Set<String> ENGINE_REFUSED_BY_DESIGN = new HashSet<>(Arrays.asList(
            "ISO field names that are text"));

    /** Registries the reference works with and this SDK refuses whole: a key that is not ECDSA P-256. */
    private static final Set<String> REGISTRY_REFUSED_BY_DESIGN = new HashSet<>(Arrays.asList(
            "the registry holds a P-384 key for the bank",
            "the registry holds a secp256k1 key for the bank",
            "the registry holds an Ed25519 key for the bank"));

    /**
     * Packages on which a check fails here in this SDK's own words, where the
     * reference verifier fails it in others — in both cases because this SDK
     * declines to interpret what the reference interprets:
     * <ul>
     * <li>a registry holding a key that is not ECDSA P-256 is refused whole (the reference judges each signature against it);
     * <li>a timestamp without a zone is not read (the reference reads it in the time zone of the machine it runs on).
     * </ul>
     * The check named fails in both SDKs; only what it says differs.
     */
    private static final Map<String, List<String>> STRICTER_BY_DESIGN = new LinkedHashMap<>();
    static {
        STRICTER_BY_DESIGN.put("the registry holds a P-384 key for the bank", Arrays.asList("signatures", "verdict"));
        STRICTER_BY_DESIGN.put("a timestamp without a zone", Arrays.asList("verdict"));
    }

    /** A check that could not be carried out says so in these words; what follows them is each runtime's own account of why. */
    private static final List<String> COULD_NOT = Arrays.asList("could not be checked — ", "could not be re-evaluated — ");

    private static boolean sameDetail(String expected, String actual) {
        for (String prefix : COULD_NOT) {
            if (expected.startsWith(prefix)) {
                return actual.startsWith(prefix);
            }
        }
        return expected.equals(actual);
    }

    // ── reading the vectors ───────────────────────────────────────────────────

    private static Map<String, Object> golden;

    static Map<String, Object> golden() throws Exception {
        if (golden == null) {
            golden = object(Json.parse(TestMain.resource("golden/verdict.json"), "invalid_json", "verdict.json"));
        }
        return golden;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    static Object copy(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : object(v).entrySet()) {
                out.put(e.getKey(), copy(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : list(v)) {
                out.add(copy(item));
            }
            return out;
        }
        return v;
    }

    /** The base document with the case's changes applied, in order: {@code { at: [path], set }} or {@code { at: [path], unset: true }}. */
    static Map<String, Object> apply(Object base, Object ops) {
        Map<String, Object> out = object(copy(base));
        for (Object each : list(ops)) {
            Map<String, Object> op = object(each);
            List<Object> path = list(op.get("at"));
            Object at = out;
            for (Object key : path.subList(0, path.size() - 1)) {
                at = at instanceof List ? list(at).get(((Number) key).intValue()) : object(at).get((String) key);
            }
            Object last = path.get(path.size() - 1);
            if (Boolean.TRUE.equals(op.get("unset"))) {
                if (at instanceof List) {
                    list(at).remove(((Number) last).intValue());
                } else {
                    object(at).remove((String) last);
                }
            } else if (at instanceof List) {
                int index = ((Number) last).intValue();
                if (index == list(at).size()) {
                    list(at).add(copy(op.get("set")));
                } else {
                    list(at).set(index, copy(op.get("set")));
                }
            } else {
                object(at).put((String) last, copy(op.get("set")));
            }
        }
        return out;
    }

    static Map<String, Object> base(String name) throws Exception {
        return object(object(golden().get("bases")).get(name));
    }

    /** Equal as JSON values, whatever order their members are written in. */
    private static boolean same(Object a, Object b) {
        return Json.canonical(a).equals(Json.canonical(b));
    }

    static void none(List<String> failures, String what) {
        if (!failures.isEmpty()) {
            throw new AssertionError(what + ": " + failures.size() + " case(s) differ from the reference\n      " + String.join("\n      ", failures));
        }
    }

    // ── the rules ─────────────────────────────────────────────────────────────

    static void testEveryAxisAndEveryFindingIsWhatTheReferenceEngineAnswers() throws Exception {
        List<String> failures = new ArrayList<>();
        int answered = 0;
        int refusedWithIt = 0;
        int refusedByDesign = 0;
        Set<String> codes = new HashSet<>();
        for (Object each : list(golden().get("engine"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Map<String, Object> doc = c.get("base") != null ? apply(base((String) c.get("base")), c.get("ops")) : c;
            Map<String, Object> expected = object(c.get("expected"));
            VerdictEngine.Result result;
            try {
                result = VerdictEngine.evaluate(object(doc.get("evidence")), doc.get("policy"));
            } catch (VerdictEngine.NotEvaluable e) {
                if (expected.get("threw") != null) {
                    refusedWithIt++;
                } else if (ENGINE_REFUSED_BY_DESIGN.contains(name)) {
                    refusedByDesign++;
                } else {
                    failures.add(name + ": refused (" + e.getMessage() + "), but the reference answers " + Json.compact(expected.get("states")));
                }
                continue;
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
                continue;
            }
            if (expected.get("threw") != null) {
                failures.add(name + ": answered " + Json.compact(result.states) + ", but the reference gives up — " + expected.get("threw"));
                continue;
            }
            answered++;
            List<Object> findings = new ArrayList<>();
            for (VerdictEngine.Finding f : result.findings) {
                findings.add(f.toString());
                codes.add(f.code);
            }
            if (!Json.compact(expected.get("states")).equals(Json.compact(result.states))) {
                failures.add(name + ": axes " + Json.compact(result.states) + ", the reference says " + Json.compact(expected.get("states")));
            } else if (!expected.get("findings").equals(findings)) {
                failures.add(name + ": findings " + findings + ", the reference lists " + expected.get("findings"));
            }
        }
        none(failures, "the six-axis rules");
        Check.isTrue(answered >= 160 && refusedWithIt >= 40, "the vectors were read: " + answered + " verdicts, " + refusedWithIt + " refusals");
        Check.equal(ENGINE_REFUSED_BY_DESIGN.size(), refusedByDesign, "every refusal by design is one the vectors still hold");
        Check.equal(41, codes.size(), "every finding the engine can make was made at least once");
    }

    // ── the signature pass ────────────────────────────────────────────────────

    private static Map<String, Object> signaturesOf(Map<String, Object> evidence) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : object(evidence.get("elements")).entrySet()) {
            List<Object> items = new ArrayList<>();
            for (Object item : e.getValue() instanceof List ? list(e.getValue()) : Arrays.asList(e.getValue())) {
                items.add(item instanceof Map && object(item).containsKey("signature") ? object(item).get("signature") : "none");
            }
            out.put(e.getKey(), items);
        }
        return out;
    }

    private static Map<String, Object> registryOf(Object institutions) {
        Map<String, Object> registry = new LinkedHashMap<>();
        registry.put("institutions", institutions);
        return registry;
    }

    static void testEverySignatureIsJudgedAsTheReferenceJudgesIt() throws Exception {
        List<String> failures = new ArrayList<>();
        int judged = 0;
        int refusedByDesign = 0;
        Set<String> statuses = new HashSet<>();
        for (Object each : list(golden().get("signatures"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Map<String, Object> doc = apply(base((String) c.get("base")), c.get("ops"));
            Map<String, Object> expected = object(c.get("expected"));
            Map<String, Object> checked;
            try {
                checked = VerdictEngine.checkSignatures(object(doc.get("evidence")), EvidenceVerifier.keyring(registryOf(doc.get("registry"))));
            } catch (VerdictEngine.NotEvaluable e) {
                if (expected.get("threw") == null && REGISTRY_REFUSED_BY_DESIGN.contains(name)) {
                    refusedByDesign++;
                } else if (expected.get("threw") == null) {
                    failures.add(name + ": refused (" + e.getMessage() + "), but the reference judges the signatures");
                }
                continue;
            }
            if (expected.get("threw") != null) {
                failures.add(name + ": judged, but the reference gives up — " + expected.get("threw"));
                continue;
            }
            judged++;
            Map<String, Object> got = signaturesOf(checked);
            if (!same(expected.get("signatures"), got)) {
                failures.add(name + ": " + Json.compact(got) + "\n        the reference: " + Json.compact(expected.get("signatures")));
            }
            for (Object items : got.values()) {
                for (Object s : list(items)) {
                    if (s instanceof Map) {
                        statuses.add(String.valueOf(object(s).get("status")));
                    }
                }
            }
            // The evidence handed in is not what is changed.
            if (!same(doc.get("evidence"), apply(base((String) c.get("base")), c.get("ops")).get("evidence"))) {
                failures.add(name + ": the evidence that was handed over was changed");
            }
        }
        none(failures, "the signature pass");
        Check.isTrue(judged >= 40, "the vectors were read: " + judged);
        Check.equal(REGISTRY_REFUSED_BY_DESIGN.size(), refusedByDesign, "every registry refused by design is one the vectors still hold");
        Check.equal(new HashSet<>(Arrays.asList("VALID", "INVALID", "UNKNOWN_KEY", "ABSENT")), statuses, "every status a signature can be given was given");
    }

    // ── the two checks, as a bank's code sees them ────────────────────────────

    private static EvidenceReport.Check check(EvidenceReport report, String name) {
        for (EvidenceReport.Check c : report.checks()) {
            if (c.name().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("no check named " + name + " in " + report.checks());
    }

    static void testTheSignatureAndVerdictChecksReadAsTheReferenceVerifiersDo() throws Exception {
        List<String> failures = new ArrayList<>();
        int compared = 0;
        int passed = 0;
        int strictCases = 0;
        for (Object each : list(golden().get("packages"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Map<String, Object> doc = apply(golden().get("bases"), c.get("ops"));
            Map<String, Object> expected = object(c.get("expected"));
            EvidenceReport report = EvidenceVerifier.verify(object(doc.get("response")));
            EvidenceReport.Check verdict = check(report, "verdict");
            EvidenceReport.Check signatures = check(report, "signatures");
            if (expected.get("threw") != null) {
                // The reference verifier gives up on the whole package; here that is a failed check, never a passed one.
                if (verdict.state() != EvidenceReport.State.FAIL) {
                    failures.add(name + ": verdict " + verdict.state() + ", but the reference gives up — " + expected.get("threw"));
                }
                continue;
            }
            compared++;
            List<String> stricter = STRICTER_BY_DESIGN.getOrDefault(name, new ArrayList<>());
            strictCases += stricter.isEmpty() ? 0 : 1;
            for (EvidenceReport.Check got : Arrays.asList(signatures, verdict)) {
                Map<String, Object> want = object(expected.get(got.name()));
                if (stricter.contains(got.name())) {
                    if (got.state() != EvidenceReport.State.FAIL || Boolean.TRUE.equals(want.get("ok"))) {
                        failures.add(name + ": " + got.name() + " " + got.state() + " — it fails in both SDKs, each in its own words");
                    }
                } else if ((got.state() == EvidenceReport.State.PASS) != Boolean.TRUE.equals(want.get("ok"))
                        || !sameDetail((String) want.get("detail"), got.detail())) {
                    failures.add(name + ": " + got.name() + " " + got.state() + " — " + got.detail() + "\n        the reference: " + Json.compact(want));
                }
            }
            if (name.equals("an element nobody knows, claiming a valid signature")) {
                Check.isTrue(signatures.state() == EvidenceReport.State.FAIL && signatures.detail().contains("customsDeclaration:NOT_VERIFIED"),
                        "a status that was declared and not computed does not count: " + signatures.detail());
            }
            if (name.equals("no elements")) {
                Check.equal("the package carries no evidence element", signatures.detail(), "a package with nothing in it has shown nothing");
            }
            passed += verdict.state() == EvidenceReport.State.PASS ? 1 : 0;
        }
        none(failures, "the signatures and verdict checks");
        Check.isTrue(compared >= 15 && passed >= 2 && passed < compared, "the vectors were read: " + compared + " compared, " + passed + " with a verdict that agrees");
        Check.equal(STRICTER_BY_DESIGN.size(), strictCases, "every case this SDK is stricter on by design is one the vectors still hold");
    }

    // ── instants and names ────────────────────────────────────────────────────

    static void testAnInstantIsReadAsTheReferenceReadsItOrNotAtAll() throws Exception {
        List<String> failures = new ArrayList<>();
        int read = 0;
        int refused = 0;
        for (Object each : list(golden().get("dates"))) {
            Map<String, Object> c = object(each);
            String text = (String) c.get("text");
            String form = (String) c.get("form");
            Double got = null;
            try {
                got = VerdictEngine.dateParse(text);
            } catch (VerdictEngine.NotEvaluable e) {
                refused++;
            }
            if (form.equals("local") || form.equals("other")) {
                // A time without a zone, or a spelling outside the standard's format: not guessed at.
                if (got != null) {
                    failures.add(Json.compact(text) + " (" + form + "): read as " + got + ", but it is to be refused");
                }
                continue;
            }
            if (got == null) {
                failures.add(Json.compact(text) + " (" + form + "): refused, the reference reads " + c.get("ms"));
            } else if (c.get("ms") == null ? !got.isNaN() : got.isNaN() || got.longValue() != ((Number) c.get("ms")).longValue()) {
                failures.add(Json.compact(text) + " (" + form + "): " + got + ", the reference reads " + c.get("ms"));
            } else {
                read++;
            }
        }
        none(failures, "instants");
        Check.isTrue(read >= 50 && refused >= 15, "the vectors were read: " + read + " read, " + refused + " refused");
        Check.isTrue(Double.isNaN(VerdictEngine.dateParse(null)), "no timestamp is no instant");
        Check.fails(VerdictEngine.NotEvaluable.class, () -> VerdictEngine.dateParse(1794971028308L));
    }

    static void testPartyNamesAreComparedAsTheReferenceComparesThem() throws Exception {
        List<String> failures = new ArrayList<>();
        int equal = 0;
        List<Object> cases = list(golden().get("parties"));
        for (Object each : cases) {
            Map<String, Object> c = object(each);
            boolean got = VerdictEngine.partyEquals(c.get("a"), c.get("b"), "normalized");
            if (got != Boolean.TRUE.equals(c.get("equal"))) {
                failures.add(Json.compact(c.get("a")) + " and " + Json.compact(c.get("b")) + ": " + got + ", the reference says " + c.get("equal"));
            }
            equal += got ? 1 : 0;
        }
        none(failures, "party names");
        Check.isTrue(equal >= 10 && equal < cases.size(), "names that are the same and names that are not: " + equal + " of " + cases.size());
    }
}
