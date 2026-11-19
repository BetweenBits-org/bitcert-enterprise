package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** The golden vectors of the FIN MT103: what the TypeScript SDK answers for each of them. */
final class Mt103GoldenTest {
    private Mt103GoldenTest() {
    }

    /** The samples the guide tells a bank to try first. */
    private static final List<String> SAMPLES = Arrays.asList("sample/mt103-free-format", "sample/mt103-structured", "sample/mt103-as-text");

    static void testEveryMtCaseReadsAsTheReferenceReadsIt() {
        Golden.none(Golden.parseFailures(name -> name.startsWith("mt/") || SAMPLES.contains(name)), "MT103 golden cases");
    }

    /**
     * One case for each fix of the reader's hardening (M1 to M16, the "message N of M" prefix and
     * the account read from a trimmed first line), so that none of them leaves the run above unseen.
     */
    private static final List<String> HARDENING = Arrays.asList(
            "mt/minimal-70-empty-roc-then-invoice", "mt/minimal-32a-second-line", "mt/minimal-block-3-121-twice",
            "mt/minimal-71a-empty", "mt/minimal-block-3-121-empty", "mt/minimal-32a-date-260230", "mt/minimal-36-two-commas",
            "mt/minimal-57c-double-slash-only", "mt/minimal-57c-space-before-slash", "mt/minimal-50f-empty-name-and-address-lines",
            "mt/minimal-59f-line-4-refused", "mt/minimal-59f-coded-party-identifier-refused", "mt/minimal-59-account-after-a-double-slash",
            "mt/minimal-57c-other-letter", "mt/minimal-59f-town-before-country", "mt/minimal-23b-crts", "mt/second-message-71a-empty",
            "mt/space-before-the-account-slash");

    /** A renamed case must not drop out of the run above without a word. */
    static void testTheCasesAreThere() {
        List<String> names = new ArrayList<>();
        for (Map<String, Object> c : Golden.cases("parse.json")) {
            names.add((String) c.get("name"));
        }
        for (String s : SAMPLES) {
            Check.isTrue(names.contains(s), "golden case " + s + " is in parse.json");
        }
        for (String s : HARDENING) {
            Check.isTrue(names.contains(s), "golden case " + s + " is in parse.json");
        }
        Check.isTrue(names.stream().filter(n -> n.startsWith("mt/")).count() >= 346, "the mt/ cases are in parse.json");
    }
}
