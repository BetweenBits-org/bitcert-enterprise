package com.stonehash.attest.remit;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@link Rules} — the six-axis engine as the platform's own back end runs
 * it — held to the reference, whole: {@code golden/rules.json} records the
 * reference's entire answer for every engine case of
 * {@code golden/verdict.json} and for the evidence a bank's re-evaluation
 * declines to read; the same documents are put to {@code Rules} here, and
 * what it answers has to be, written out as JavaScript writes JSON, the
 * same text.
 *
 * <p>Where the reference refuses in its own words, so does {@code Rules}, in
 * the same words. Where the reference fails inside the JavaScript engine,
 * {@code Rules} refuses with {@code unreadable_evidence} or
 * {@code unreadable_policy} — and never answers.
 */
final class RulesTest {
    private RulesTest() {
    }

    private static Map<String, Object> rules;

    private static Map<String, Object> rules() throws Exception {
        if (rules == null) {
            rules = object(Json.parse(TestMain.resource("golden/rules.json"), "invalid_json", "rules.json"));
        }
        return rules;
    }

    private static Map<String, Object> object(Object o) {
        return VerdictEngineTest.object(o);
    }

    private static List<Object> list(Object o) {
        return VerdictEngineTest.list(o);
    }

    /** A case of {@code verdict.json} by its name: the inputs of the cases this file answers in full. */
    private static Map<String, Object> verdictCase(String section, String name) throws Exception {
        for (Object each : list(VerdictEngineTest.golden().get(section))) {
            if (name.equals(object(each).get("name"))) {
                return object(each);
            }
        }
        throw new AssertionError("verdict.json has no " + section + " case named " + name);
    }

    /** What a refusal has to be: the reference's sentence under the reference's kind of refusal, or one of this SDK's. */
    private static String refusalDiffers(Map<String, Object> threw, RemitException e, String... ownCodes) {
        String message = (String) threw.get("message");
        if (Boolean.TRUE.equals(threw.get("engine"))) {
            return e.code().startsWith("unreadable_") ? null : "refused as " + e.code() + " (" + e.getMessage() + "), where the reference's engine fails: " + message;
        }
        if (!Arrays.asList(ownCodes).contains(e.code())) {
            return "refused as " + e.code() + ", where the reference refuses in its own words: " + message;
        }
        return message.equals(e.getMessage()) ? null : "refused with \"" + e.getMessage() + "\", the reference says \"" + message + "\"";
    }

    // ── the rules ─────────────────────────────────────────────────────────────

    static void testEveryVerdictIsTheReferencesWholeAnswer() throws Exception {
        List<String> failures = new ArrayList<>();
        int answered = 0;
        int inItsWords = 0;
        int whereItsEngineFails = 0;
        int otherSpellings = 0;
        Set<String> codes = new HashSet<>();
        Set<String> fromVerdict = new HashSet<>();
        for (Object each : list(rules().get("engine"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Map<String, Object> doc;
            if ("verdict.json".equals(c.get("from"))) {
                Map<String, Object> source = verdictCase("engine", name);
                doc = source.get("base") != null ? VerdictEngineTest.apply(VerdictEngineTest.base((String) source.get("base")), source.get("ops")) : source;
                fromVerdict.add(name);
            } else {
                doc = c.get("base") != null ? VerdictEngineTest.apply(VerdictEngineTest.base((String) c.get("base")), c.get("ops")) : c;
            }
            Object evidence = doc.get("evidence");
            Object policy = doc.get("policy");
            String before = JsValue.stringify(Arrays.asList(evidence, policy));
            Map<String, Object> result;
            try {
                result = Rules.evaluate(evidence, policy);
            } catch (RemitException e) {
                if (c.get("threw") == null) {
                    failures.add(name + ": refused (" + e.code() + ": " + e.getMessage() + "), but the reference answers");
                    continue;
                }
                String differs = refusalDiffers(object(c.get("threw")), e, "invalid_policy", "invalid_amount");
                if (differs != null) {
                    failures.add(name + ": " + differs);
                } else if (Boolean.TRUE.equals(object(c.get("threw")).get("engine"))) {
                    whereItsEngineFails++;
                } else {
                    inItsWords++;
                }
                continue;
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
                continue;
            }
            if (c.get("threw") != null) {
                failures.add(name + ": answered, but the reference gives up — " + object(c.get("threw")).get("message"));
                continue;
            }
            answered++;
            String expected = JsValue.stringify(c.get("result"));
            String actual = JsValue.stringify(result);
            if (!expected.equals(actual)) {
                failures.add(name + ":\n        Rules:     " + firstDifference(actual, expected) + "\n        reference: " + firstDifference(expected, actual));
            }
            if (!before.equals(JsValue.stringify(Arrays.asList(evidence, policy)))) {
                failures.add(name + ": the evidence or the policy was changed by evaluating it");
            }
            for (Object f : list(result.get("findings"))) {
                codes.add((String) object(f).get("code"));
            }
            if (c.get("reference") != null) {
                otherSpellings++;
                Check.isTrue(!JsValue.stringify(c.get("reference")).equals(expected), name + ": carries a reference answer that is no different");
            }
        }
        VerdictEngineTest.none(failures, "the whole verdict");
        Check.equal(list(VerdictEngineTest.golden().get("engine")).size(), fromVerdict.size(), "every engine case of verdict.json is answered in full");
        Check.isTrue(answered >= 380 && inItsWords >= 60 && whereItsEngineFails >= 40,
                "the vectors were read: " + answered + " verdicts, " + inItsWords + " refusals in the reference's words, " + whereItsEngineFails + " where its engine fails");
        Check.equal(41, codes.size(), "every finding the engine can make was made at least once");
        Check.equal(15, otherSpellings, "the cases that turn on a spelling of a time Rules does not read");
    }

    /** The text around the first place two texts part ways. */
    private static String firstDifference(String a, String b) {
        int i = 0;
        while (i < a.length() && i < b.length() && a.charAt(i) == b.charAt(i)) {
            i++;
        }
        return "…" + a.substring(Math.max(0, i - 60), Math.min(a.length(), i + 100)) + "…";
    }

    static void testARefusalSaysWhoseWordsItIs() throws Exception {
        Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
        Object evidence = sandbox.get("evidence");
        Map<String, Object> policy = object(VerdictEngineTest.copy(sandbox.get("policy")));
        // No policy at all, and a name that no element has: about the policy, in this SDK's words.
        Check.refuses("unreadable_policy", () -> Rules.evaluate(evidence, null));
        Check.refuses("unreadable_policy", () -> Rules.validatePolicy(null));
        policy.put("settlementIdRequiredIn", Arrays.asList("constructor"));
        Check.refuses("unreadable_policy", () -> Rules.evaluate(evidence, policy));
        // No evidence: about the evidence — and the policy is judged first, as the reference judges it first.
        Check.refuses("unreadable_evidence", () -> Rules.evaluate(null, sandbox.get("policy")));
        Check.refuses("unreadable_policy", () -> Rules.evaluate(null, null));
        policy.put("settlementWindow", "P1M");
        RemitException e = Check.refuses("invalid_policy", () -> Rules.evaluate(null, policy));
        Check.equal("policy: settlementWindow must be an ISO 8601 duration of days/hours/minutes/seconds, got P1M", e.getMessage(), "the reference's sentence");
        // An amount that is not a decimal string: the reference's sentence, under a code of its own.
        Map<String, Object> changed = VerdictEngineTest.apply(sandbox, Json.parse("[{\"at\":[\"evidence\",\"elements\",\"chainTransfer\",\"amount\"],\"set\":2500}]"));
        e = Check.refuses("invalid_amount", () -> Rules.evaluate(changed.get("evidence"), changed.get("policy")));
        Check.equal("chainTransfer.amount: expected a decimal string, got number", e.getMessage(), "the reference's sentence");
        // Anything that is not JSON is a mistake of the caller's, and is said to be.
        Check.fails(IllegalArgumentException.class, () -> Rules.evaluate(new Object(), sandbox.get("policy")));
        Check.fails(IllegalArgumentException.class, () -> Rules.evaluate(Collections.singletonMap("elements", new int[0]), sandbox.get("policy")));
        Check.fails(IllegalArgumentException.class, () -> Rules.policyDigest(Collections.singletonMap(7, "x")));
    }

    static void testAVerdictSharesNothingWithWhatItWasComputedFrom() throws Exception {
        Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
        Map<String, Object> doc = VerdictEngineTest.apply(sandbox, Json.parse(
                "[{\"at\":[\"policy\",\"sourceTrustLevel\"],\"set\":[\"ACCREDITED\"]},{\"at\":[\"evidence\",\"scenario\"],\"set\":{\"id\":[1]}}]"));
        Map<String, Object> result = Rules.evaluate(doc.get("evidence"), doc.get("policy"));
        String written = JsValue.stringify(result);
        Check.isTrue(written.contains("\"expected\":[\"ACCREDITED\"]") && written.contains("\"scenario\":{\"id\":[1]}"), "the verdict quotes the policy and the evidence");
        // Changing the inputs afterwards changes nothing in the verdict, and the other way round.
        list(object(doc.get("policy")).get("sourceTrustLevel")).set(0, "DEMO");
        list(object(object(doc.get("evidence")).get("scenario")).get("id")).set(0, 2L);
        Check.equal(written, JsValue.stringify(result), "a verdict is a value of its own");
        object(result.get("scenario")).put("id", "changed");
        Check.equal("{\"id\":[2]}", JsValue.stringify(object(doc.get("evidence")).get("scenario")), "and so is the evidence");
        // Numbers are carried as they were given; written out, they are written as JavaScript writes them.
        Map<String, Object> policy = object(VerdictEngineTest.copy(sandbox.get("policy")));
        policy.put("amountToleranceBps", new BigDecimal("0.0"));
        policy.put("note", new BigDecimal("1.50"));
        Check.equal(Rules.policyDigest(Json.parse(JsValue.stringify(policy))), Rules.policyDigest(policy), "1.50 and 1.5 are one number, and so one policy");
        Check.isTrue(Rules.canonicalPolicy(policy).contains("\"amountToleranceBps\":0,") && Rules.canonicalPolicy(policy).contains("\"note\":1.5,"), "written the short way");
    }

    // ── numbers ───────────────────────────────────────────────────────────────

    /** The document with every number held as a {@code Double} — which is how the platform's own JSON reader hands numbers over. */
    static Object doubles(Object v) {
        if (v instanceof Number) {
            return Double.valueOf(((Number) v).doubleValue());
        }
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : object(v).entrySet()) {
                out.put(e.getKey(), doubles(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : list(v)) {
                out.add(doubles(item));
            }
            return out;
        }
        return v;
    }

    private static boolean holdsANumber(Object v) {
        if (v instanceof Map) {
            for (Object member : object(v).values()) {
                if (holdsANumber(member)) {
                    return true;
                }
            }
        } else if (v instanceof List) {
            for (Object item : list(v)) {
                if (holdsANumber(item)) {
                    return true;
                }
            }
        }
        return v instanceof Number;
    }

    /** What was answered, as text: the result as JavaScript writes it, or the refusal. */
    private static String answered(Check.Action action, Object[] result) {
        try {
            action.run();
            return JsValue.stringify(result[0]);
        } catch (RemitException e) {
            return "refused " + e.code() + ": " + e.getMessage();
        } catch (Exception e) {
            return "failed " + e;
        }
    }

    /**
     * A number is its value. The reference holds nothing else of it, so 1,
     * 1.0 and 1e0 are one number there — and here the same document has to
     * get the same answer whether its numbers arrive as {@code Long} and
     * {@code BigDecimal} (this SDK's reader) or as {@code Double} (the
     * platform's): the verdict, the refusal, the policy's digest, and above
     * all the signature over an element that holds a number.
     */
    static void testANumberIsTheSameNumberHoweverItIsHeld() throws Exception {
        List<String> failures = new ArrayList<>();
        int verdicts = 0;
        int withNumbers = 0;
        for (Object each : list(rules().get("engine"))) {
            Map<String, Object> c = object(each);
            Map<String, Object> doc;
            if ("verdict.json".equals(c.get("from"))) {
                Map<String, Object> source = verdictCase("engine", (String) c.get("name"));
                doc = source.get("base") != null ? VerdictEngineTest.apply(VerdictEngineTest.base((String) source.get("base")), source.get("ops")) : source;
            } else {
                doc = c.get("base") != null ? VerdictEngineTest.apply(VerdictEngineTest.base((String) c.get("base")), c.get("ops")) : c;
            }
            Object[] one = new Object[1];
            String asRead = answered(() -> one[0] = Rules.evaluate(doc.get("evidence"), doc.get("policy")), one);
            String asDoubles = answered(() -> one[0] = Rules.evaluate(doubles(doc.get("evidence")), doubles(doc.get("policy"))), one);
            if (!asRead.equals(asDoubles)) {
                failures.add("verdict, " + c.get("name") + ":\n        as read:    " + firstDifference(asRead, asDoubles) + "\n        as doubles: " + firstDifference(asDoubles, asRead));
            }
            verdicts++;
            withNumbers += holdsANumber(doc.get("evidence")) ? 1 : 0;
        }
        int policies = 0;
        for (Object each : list(rules().get("policies"))) {
            Object policy = object(each).get("policy");
            Object held = doubles(policy);
            Object[] one = { "taken" };
            String asRead = answered(() -> Rules.validatePolicy(policy), one);
            String asDoubles = answered(() -> Rules.validatePolicy(held), one);
            if (!asRead.equals(asDoubles)) {
                failures.add("policy, " + object(each).get("name") + ": " + asRead + " as read, " + asDoubles + " as doubles");
            } else if (!Rules.canonicalPolicy(policy).equals(Rules.canonicalPolicy(held)) || !Rules.policyDigest(policy).equals(Rules.policyDigest(held))) {
                failures.add("policy, " + object(each).get("name") + ": another canonical text when its numbers are doubles");
            }
            policies++;
        }
        int passes = 0;
        for (Object each : list(rules().get("signatures"))) {
            Map<String, Object> c = object(each);
            Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
            Object evidence;
            if ("verdict.json".equals(c.get("from"))) {
                Map<String, Object> base = new LinkedHashMap<>();
                base.put("evidence", sandbox.get("evidence"));
                base.put("registry", sandbox.get("registry"));
                evidence = VerdictEngineTest.apply(base, verdictCase("signatures", (String) c.get("name")).get("ops")).get("evidence");
            } else if (c.get("base") != null) {
                evidence = VerdictEngineTest.apply(Collections.singletonMap("evidence", sandbox.get("evidence")), c.get("ops")).get("evidence");
            } else {
                evidence = c.get("evidence");
            }
            Object[] one = new Object[1];
            String asRead = answered(() -> one[0] = Rules.checkSignatures(evidence, Rules.keyring(list(c.get("keyring")))), one);
            String asDoubles = answered(() -> one[0] = Rules.checkSignatures(doubles(evidence), Rules.keyring(list(doubles(c.get("keyring"))))), one);
            if (!asRead.equals(asDoubles)) {
                failures.add("signature pass, " + c.get("name") + ":\n        as read:    " + firstDifference(asRead, asDoubles) + "\n        as doubles: " + firstDifference(asDoubles, asRead));
            }
            passes++;
        }
        VerdictEngineTest.none(failures, "numbers held as doubles");
        Check.isTrue(verdicts >= 490 && policies >= 200 && passes >= 130 && withNumbers >= 400, "the vectors were read: " + verdicts + " verdicts (" + withNumbers + " over documents that hold a number), "
                + policies + " policies, " + passes + " signature passes");
        // The case that matters most, said outright: the sandbox settlement's chain transfer holds a number (its
        // confirmations), and its signature verifies whether that number arrives as 1, as 1.0 or as a double.
        Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
        List<Object> entries = new ArrayList<>();
        for (Object each : list(sandbox.get("registry"))) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("keyId", object(each).get("id"));
            entry.put("trustLevel", "ATTESTED");
            entry.put("publicKeySpki", object(each).get("signing_spki"));
            entries.add(entry);
        }
        for (Object confirmations : new Object[] { 1L, 1, Double.valueOf(1.0), new BigDecimal("1.0"), new BigDecimal("1"), new BigDecimal("1E+0"), new BigDecimal("0.1E1"), Float.valueOf(1f) }) {
            Map<String, Object> evidence = object(VerdictEngineTest.copy(sandbox.get("evidence")));
            Map<String, Object> transfer = object(object(evidence.get("elements")).get("chainTransfer"));
            Check.equal(1L, transfer.put("confirmations", confirmations), "the chain transfer states its confirmations");
            Map<String, Object> checked = object(object(Rules.checkSignatures(evidence, Rules.keyring(entries)).get("elements")).get("chainTransfer"));
            Check.equal("VALID", object(checked.get("signature")).get("status"), "confirmations held as " + confirmations.getClass().getSimpleName() + " " + confirmations);
            Check.isTrue(checked.get("confirmations") == confirmations, "and handed back as it was handed over");
        }
        for (Object confirmations : new Object[] { 2L, Double.valueOf(1.5), new BigDecimal("1.0000001"), Double.valueOf(Double.NaN), "1" }) {
            Map<String, Object> evidence = object(VerdictEngineTest.copy(sandbox.get("evidence")));
            object(object(evidence.get("elements")).get("chainTransfer")).put("confirmations", confirmations);
            Map<String, Object> checked = object(object(Rules.checkSignatures(evidence, Rules.keyring(entries)).get("elements")).get("chainTransfer"));
            Check.equal("INVALID", object(checked.get("signature")).get("status"), "confirmations changed to " + confirmations);
        }
    }

    // ── policies ──────────────────────────────────────────────────────────────

    static void testEveryPolicyIsJudgedAndDigestedAsTheReferenceDoes() throws Exception {
        List<String> failures = new ArrayList<>();
        int taken = 0;
        int refused = 0;
        Set<String> sentences = new HashSet<>();
        Map<String, String> digests = new HashMap<>();
        for (Object each : list(rules().get("policies"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Object policy = c.get("policy");
            try {
                Rules.validatePolicy(policy);
                if (c.get("problem") != null) {
                    failures.add(name + ": taken, but the reference says " + object(c.get("problem")).get("message"));
                }
                taken++;
            } catch (RemitException e) {
                if (c.get("problem") == null) {
                    failures.add(name + ": refused (" + e.getMessage() + "), but the reference takes it");
                } else {
                    String differs = refusalDiffers(object(c.get("problem")), e, "invalid_policy");
                    if (differs != null) {
                        failures.add(name + ": " + differs);
                    }
                    sentences.add(e.getMessage());
                }
                refused++;
            }
            try {
                String canonical = Rules.canonicalPolicy(policy);
                if (!c.get("canonical").equals(canonical)) {
                    failures.add(name + ": canonical text\n        Rules:     " + firstDifference(canonical, (String) c.get("canonical"))
                            + "\n        reference: " + firstDifference((String) c.get("canonical"), canonical));
                } else if (!c.get("digest").equals(Rules.policyDigest(policy))) {
                    failures.add(name + ": digest " + Rules.policyDigest(policy) + ", the reference's is " + c.get("digest"));
                }
                digests.put(name, Rules.policyDigest(policy));
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
            }
        }
        VerdictEngineTest.none(failures, "policies");
        Check.isTrue(taken >= 70 && refused >= 120 && sentences.size() >= 60, "the vectors were read: " + taken + " taken, " + refused + " refused in " + sentences.size() + " sentences");
        // The order a policy's members are written in is not part of the policy; the order of a list is.
        String sandbox = digests.get("the sandbox corridor policy");
        Check.equal(sandbox, digests.get("the sandbox policy, its members in reverse order"), "members in another order");
        Check.equal(sandbox, digests.get("the sandbox policy, the members of its objects in reverse order"), "nested members in another order");
        Check.isTrue(!sandbox.equals(digests.get("the sandbox policy, its lists in reverse order")), "a list in another order is another policy");
        Check.isTrue(Hex.isHash(sandbox), "a digest is 64 lowercase hex characters");
    }

    // ── the table: values no text and no number can be made of ───────────────

    /**
     * How an answer, or a refusal, differs from a cell of the table — or
     * null. A cell is the SHA-256 of the reference's answer as JSON, or its
     * refusal: {@code engine: …} where the JavaScript engine fails (here a
     * refusal in words of this SDK's), {@code refused: …} where the reference
     * refuses in its own sentence (here the same sentence).
     */
    private static String cellDiffers(String cell, String answer, RemitException refusal, String... ownCodes) {
        if (cell.startsWith("engine: ")) {
            if (refusal == null) {
                return "answered, where the reference's engine fails — " + cell.substring(8);
            }
            return refusal.code().startsWith("unreadable_") ? null
                    : "refused as " + refusal.code() + " (" + refusal.getMessage() + "), where the reference's engine fails — " + cell.substring(8);
        }
        if (cell.startsWith("refused: ")) {
            String message = cell.substring(9);
            if (refusal == null) {
                return "answered, where the reference refuses — " + message;
            }
            if (!Arrays.asList(ownCodes).contains(refusal.code())) {
                return "refused as " + refusal.code() + " (" + refusal.getMessage() + "), where the reference refuses in its own words: " + message;
            }
            return message.equals(refusal.getMessage()) ? null : "refused with \"" + refusal.getMessage() + "\", the reference says \"" + message + "\"";
        }
        if (refusal != null) {
            return "refused (" + refusal.code() + ": " + refusal.getMessage() + "), but the reference answers";
        }
        return cell.equals(Hex.sha256Hex(Text.utf8(answer))) ? null
                : "another answer than the reference's — " + (answer.length() > 400 ? answer.substring(0, 400) + "…" : answer);
    }

    private static Map<String, Object> put(List<Object> at, Object value) {
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("at", at);
        op.put("set", value);
        return op;
    }

    /**
     * An object with a member of its own named {@code toString} — alone, or
     * reached through a list — is a value the reference's engine can make no
     * text and no number of; an object with a member named {@code valueOf}
     * alone is not. Each of them is put at every position the other cases
     * vary, and {@code Rules} has to answer, or refuse, exactly where the
     * reference does — whichever rule happens to read the value first.
     */
    static void testAValueNoTextCanBeMadeOfIsRefusedWhereverTheReferenceFailsOnIt() throws Exception {
        Map<String, Object> table = object(rules().get("table"));
        List<Object> values = list(table.get("values"));
        List<String> failures = new ArrayList<>();
        int answered = 0;
        int inItsWords = 0;
        int[] unwritable = new int[values.size()];
        int otherwise = 0;

        Map<String, Object> engine = object(table.get("engine"));
        List<Object> contexts = list(engine.get("contexts"));
        List<Object> positions = list(engine.get("positions"));
        for (int c = 0; c < contexts.size(); c++) {
            for (int p = 0; p < positions.size(); p++) {
                for (int v = 0; v < values.size(); v++) {
                    String cell = (String) list(list(list(engine.get("cells")).get(c)).get(p)).get(v);
                    List<Object> ops = new ArrayList<>(list(object(contexts.get(c)).get("ops")));
                    ops.add(put(list(positions.get(p)), object(values.get(v)).get("value")));
                    Map<String, Object> doc = VerdictEngineTest.apply(VerdictEngineTest.base("sandbox"), ops);
                    String answer = null;
                    RemitException refusal = null;
                    try {
                        answer = JsValue.stringify(Rules.evaluate(doc.get("evidence"), doc.get("policy")));
                    } catch (RemitException e) {
                        refusal = e;
                    } catch (RuntimeException e) {
                        failures.add(object(contexts.get(c)).get("name") + " · " + Json.compact(positions.get(p)) + " · " + object(values.get(v)).get("name") + ": " + e);
                        continue;
                    }
                    String differs = cellDiffers(cell, answer, refusal, "invalid_policy", "invalid_amount");
                    if (differs != null) {
                        failures.add(object(contexts.get(c)).get("name") + " · " + Json.compact(positions.get(p)) + " · " + object(values.get(v)).get("name") + ": " + differs
                                + "\n        (node tools/make-rules-golden.mjs --cell engine " + c + " " + p + " " + v + " prints the reference's answer in full)");
                    }
                    answered += refusal == null ? 1 : 0;
                    inItsWords += cell.startsWith("refused: ") ? 1 : 0;
                    if (cell.equals("engine: Cannot convert object to primitive value")) {
                        unwritable[v]++;
                    } else if (cell.startsWith("engine: ")) {
                        otherwise++;
                    }
                }
            }
        }
        VerdictEngineTest.none(failures, "the table, put to the rules");

        Map<String, Object> policies = object(table.get("policies"));
        Object sandboxPolicy = VerdictEngineTest.base("sandbox").get("policy");
        int policyCells = 0;
        for (int p = 0; p < list(policies.get("positions")).size(); p++) {
            List<Object> at = list(list(policies.get("positions")).get(p));
            for (int v = 0; v < values.size(); v++) {
                String cell = (String) list(list(policies.get("cells")).get(p)).get(v);
                Object value = object(values.get(v)).get("value");
                Object policy;
                if (at.isEmpty()) {
                    policy = value;
                } else {
                    List<Object> path = new ArrayList<>();
                    path.add("policy");
                    path.addAll(at);
                    policy = VerdictEngineTest.apply(Collections.singletonMap("policy", sandboxPolicy), Arrays.asList(put(path, value))).get("policy");
                }
                String where = "the policy at " + Json.compact(at) + " · " + object(values.get(v)).get("name");
                String digest = Rules.policyDigest(policy);
                if (!cell.startsWith(digest + " ")) {
                    failures.add(where + ": digest " + digest + ", the reference's is " + cell.substring(0, 64));
                }
                RemitException refusal = null;
                try {
                    Rules.validatePolicy(policy);
                } catch (RemitException e) {
                    refusal = e;
                }
                String said = cell.substring(65);
                String differs = said.equals("taken") ? (refusal == null ? null : "refused (" + refusal.code() + ": " + refusal.getMessage() + "), but the reference takes it")
                        : cellDiffers(said, null, refusal, "invalid_policy");
                if (differs != null) {
                    failures.add(where + ": " + differs + "\n        (node tools/make-rules-golden.mjs --cell policies " + p + " " + v + ")");
                }
                policyCells++;
            }
        }
        VerdictEngineTest.none(failures, "the table, put to the policy checks");

        Map<String, Object> signatures = object(table.get("signatures"));
        Rules.Keyring ring = Rules.keyring(list(signatures.get("keyring")));
        Object sandboxEvidence = VerdictEngineTest.base("sandbox").get("evidence");
        int signatureCells = 0;
        for (int p = 0; p < list(signatures.get("positions")).size(); p++) {
            for (int v = 0; v < values.size(); v++) {
                String cell = (String) list(list(signatures.get("cells")).get(p)).get(v);
                Object evidence = VerdictEngineTest.apply(Collections.singletonMap("evidence", sandboxEvidence),
                        Arrays.asList(put(list(list(signatures.get("positions")).get(p)), object(values.get(v)).get("value")))).get("evidence");
                String answer = null;
                RemitException refusal = null;
                try {
                    answer = JsValue.stringify(Rules.checkSignatures(evidence, ring));
                } catch (RemitException e) {
                    refusal = e;
                }
                String differs = cellDiffers(cell, answer, refusal, "invalid_keyring");
                if (differs != null) {
                    failures.add("the signature pass at " + Json.compact(list(signatures.get("positions")).get(p)) + " · " + object(values.get(v)).get("name") + ": " + differs);
                }
                signatureCells++;
            }
        }
        VerdictEngineTest.none(failures, "the table, put to the signature pass");

        // The rule itself, read off the vectors: a member named toString stands in the way; a member named valueOf alone does not.
        int withToString = 0;
        for (int v = 0; v < values.size(); v++) {
            String written = JsValue.stringify(object(values.get(v)).get("value"));
            if (written.contains("\"toString\"")) {
                Check.isTrue(unwritable[v] >= 40, object(values.get(v)).get("name") + ": the engine fails on it at " + unwritable[v] + " places");
                withToString++;
            } else {
                Check.equal(0, unwritable[v], object(values.get(v)).get("name") + ": no member named toString, so text is made of it everywhere");
            }
        }
        Check.isTrue(withToString >= 6 && withToString < values.size(), "values of both kinds are in the table");
        Check.isTrue(answered >= 1200 && inItsWords >= 400 && otherwise >= 100 && policyCells >= 250 && signatureCells >= 300,
                "the table was read: " + answered + " answers, " + inItsWords + " refusals in the reference's words, " + otherwise
                        + " other engine failures; " + policyCells + " policy cells, " + signatureCells + " signature cells");
    }

    // ── the signature pass ────────────────────────────────────────────────────

    static void testTheSignaturePassLeavesTheEvidenceAsTheReferenceLeavesIt() throws Exception {
        List<String> failures = new ArrayList<>();
        int passed = 0;
        int refused = 0;
        Set<String> statuses = new HashSet<>();
        Set<String> levels = new HashSet<>();
        for (Object each : list(rules().get("signatures"))) {
            Map<String, Object> c = object(each);
            String name = (String) c.get("name");
            Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
            Object evidence;
            if ("verdict.json".equals(c.get("from"))) {
                Map<String, Object> base = new LinkedHashMap<>();
                base.put("evidence", sandbox.get("evidence"));
                base.put("registry", sandbox.get("registry"));
                evidence = VerdictEngineTest.apply(base, verdictCase("signatures", name).get("ops")).get("evidence");
            } else if (c.get("base") != null) {
                evidence = VerdictEngineTest.apply(Collections.singletonMap("evidence", sandbox.get("evidence")), c.get("ops")).get("evidence");
            } else {
                evidence = c.get("evidence");
            }
            Map<String, Object> expected = object(c.get("expected"));
            String before = JsValue.stringify(evidence);
            Map<String, Object> checked;
            try {
                checked = Rules.checkSignatures(evidence, Rules.keyring(list(c.get("keyring"))));
            } catch (RemitException e) {
                if (expected.get("threw") == null) {
                    failures.add(name + ": refused (" + e.code() + ": " + e.getMessage() + "), but the reference answers");
                } else {
                    String differs = refusalDiffers(object(expected.get("threw")), e, "invalid_keyring");
                    if (differs != null) {
                        failures.add(name + ": " + differs);
                    }
                    refused++;
                }
                continue;
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
                continue;
            }
            if (expected.get("threw") != null) {
                failures.add(name + ": answered, but the reference gives up — " + object(expected.get("threw")).get("message"));
                continue;
            }
            passed++;
            String want = JsValue.stringify(expected.get("evidence"));
            String got = JsValue.stringify(checked);
            if (!want.equals(got)) {
                failures.add(name + ":\n        Rules:     " + firstDifference(got, want) + "\n        reference: " + firstDifference(want, got));
            }
            if (!before.equals(JsValue.stringify(evidence))) {
                failures.add(name + ": the evidence handed over was changed");
            }
            collect(checked.get("elements"), statuses, levels);
        }
        VerdictEngineTest.none(failures, "the signature pass");
        Check.isTrue(passed >= 120 && refused >= 8, "the vectors were read: " + passed + " passes, " + refused + " refusals");
        Check.equal(new HashSet<>(Arrays.asList("VALID", "DEMO_VALID", "INVALID", "UNKNOWN_KEY", "ABSENT")), statuses, "every status a signature can be left with");
        Check.isTrue(levels.containsAll(Arrays.asList("\"ATTESTED\"", "\"DEMO\"", "\"ACCREDITED\"", "\"PLATINUM\"", "null", "2")), "every kind of trust level a keyring can state: " + levels);
    }

    private static void collect(Object v, Set<String> statuses, Set<String> levels) {
        if (v instanceof List) {
            for (Object item : list(v)) {
                collect(item, statuses, levels);
            }
        } else if (v instanceof Map) {
            Object signature = object(v).get("signature");
            if (signature instanceof Map && Boolean.TRUE.equals(object(signature).get("checked"))) {
                statuses.add(String.valueOf(object(signature).get("status")));
                if (object(signature).containsKey("trustLevel")) {
                    levels.add(JsValue.stringify(object(signature).get("trustLevel")));
                }
            }
            for (Object member : object(v).values()) {
                collect(member, statuses, levels);
            }
        }
    }

    static void testAKeyringHoldsWhatItIsGivenAndSaysWhatItCannotUse() throws Exception {
        Map<String, Object> sandbox = VerdictEngineTest.base("sandbox");
        List<Object> entries = new ArrayList<>();
        for (Object each : list(sandbox.get("registry"))) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("keyId", object(each).get("id"));
            entry.put("issuer", object(each).get("name"));
            entry.put("trustLevel", "ATTESTED");
            entry.put("publicKeySpki", object(each).get("signing_spki"));
            entries.add(entry);
        }
        Rules.Keyring ring = Rules.keyring(entries);
        Check.equal(new ArrayList<>(Arrays.asList("SG-BFI-001", "SETTLE-ENTITY-001", "VN-BANK-34897F")), new ArrayList<>(ring.keyIds()), "the key ids, in the order given");
        Check.isTrue(ring.usable("SG-BFI-001") && !ring.usable("nobody"), "a key it holds can be used; one it does not hold cannot");
        // A key that is no P-256 key stays in the keyring and is of no use: its signatures read INVALID, not UNKNOWN_KEY.
        for (String unusable : new String[] { "AAAA", "", "not base64 at all",
                "MCowBQYDK2VwAyEAY0FGd1FX6rrwLDNTz52DSxMa7cvoJBeucGzr99R3/V4=" }) {
            Map<String, Object> entry = object(VerdictEngineTest.copy(entries.get(2)));
            entry.put("publicKeySpki", unusable);
            Rules.Keyring changed = Rules.keyring(Arrays.asList(entries.get(0), entries.get(1), entry));
            Check.isTrue(!changed.usable("VN-BANK-34897F") && changed.usable("SG-BFI-001"), "a key that is not one: " + unusable);
            Map<String, Object> elements = object(Rules.checkSignatures(sandbox.get("evidence"), changed).get("elements"));
            Check.equal("INVALID", object(object(elements.get("bankInstruction")).get("signature")).get("status"), "nothing verifies under it");
            Check.equal("VALID", object(object(elements.get("travelRule")).get("signature")).get("status"), "and the other keys are as they were");
        }
        Check.equal("duplicate keyId in keyring: SG-BFI-001",
                Check.refuses("invalid_keyring", () -> Rules.keyring(Arrays.asList(entries.get(0), entries.get(0)))).getMessage(), "the reference's sentence");
        Check.refuses("invalid_keyring", () -> Rules.keyring(Arrays.asList("SG-BFI-001")));
        Check.refuses("invalid_keyring", () -> Rules.keyring(Arrays.asList(Collections.singletonMap("keyId", 7L))));
        Check.refuses("invalid_keyring", () -> Rules.keyring(Arrays.asList(Collections.singletonMap("issuer", "nobody"))));
        Check.equal(0, Rules.keyring(new ArrayList<>()).keyIds().size(), "an empty keyring is a keyring");
        Check.fails(NullPointerException.class, () -> Rules.checkSignatures(sandbox.get("evidence"), null));
    }

    // ── instants ──────────────────────────────────────────────────────────────

    static void testEveryInstantIsTheOneTheReferencesEngineReads() throws Exception {
        Map<String, Object> instants = object(rules().get("instants"));
        List<String> failures = new ArrayList<>();
        int dates = 0;
        int none = 0;
        for (Object each : list(instants.get("shaped"))) {
            String text = (String) list(each).get(0);
            Object ms = list(each).get(1);
            double expected = ms == null ? Double.NaN : ((Number) ms).doubleValue();
            double actual = VerdictEngine.dateParse(text, false);
            if (!JsDate.hasShape(text)) {
                failures.add(Json.compact(text) + " is said to have the shape, and has not");
            } else if (Double.compare(expected, actual) != 0 && failures.size() < 40) {
                failures.add(Json.compact(text) + ": " + JsValue.numberToString(actual) + ", the engine reads " + JsValue.numberToString(expected));
            }
            if (ms == null) {
                none++;
            } else {
                dates++;
            }
        }
        // Text of another shape is no date here — also where the engine, with a reader of its own, makes one of it.
        int theEngineReads = 0;
        for (Object each : list(instants.get("other"))) {
            String text = (String) list(each).get(0);
            if (JsDate.hasShape(text) || !Double.isNaN(VerdictEngine.dateParse(text, false))) {
                failures.add(Json.compact(text) + " has another shape and was read all the same");
            }
            theEngineReads += list(each).get(1) == null ? 0 : 1;
        }
        VerdictEngineTest.none(failures, "instants");
        Check.isTrue(dates >= 2000 && none >= 1000 && theEngineReads >= 50,
                "the vectors were read: " + dates + " dates, " + none + " that are none, " + theEngineReads + " other spellings the engine reads");
        // A value that is not text is read as the text JavaScript makes of it.
        Check.equal(1767225600000d, VerdictEngine.dateParse(2026L, false), "the number 2026 is the year");
        Check.equal(1794971028308d, VerdictEngine.dateParse(Arrays.asList("2026-11-18T03:03:48.308Z"), false), "a list of one is its member");
        Check.isTrue(Double.isNaN(VerdictEngine.dateParse(null, false)) && Double.isNaN(VerdictEngine.dateParse(Boolean.TRUE, false))
                && Double.isNaN(VerdictEngine.dateParse(new LinkedHashMap<String, Object>(), false)) && Double.isNaN(VerdictEngine.dateParse(1794971028308L, false)),
                "null, true, an object and a count of milliseconds are no dates");
    }
}
