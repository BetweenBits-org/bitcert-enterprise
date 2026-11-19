package com.stonehash.attest.remit.swift;

import java.util.Arrays;
import java.util.List;

/** The golden cases of the ISO 20022 reader: every {@code xml/} case of {@code parse.json}, the XML samples, and an HTML page. */
final class Iso20022GoldenTest {
    private Iso20022GoldenTest() {
    }

    private static final List<String> OTHERS = Arrays.asList(
            "sample/pacs008", "sample/pacs008-envelope", "sample/pain001", "sample/pacs008-as-text", "other/html");

    static void testEveryXmlCaseIsReadAsTheReferenceReadsIt() {
        Golden.none(Golden.parseFailures(name -> name.startsWith("xml/") || OTHERS.contains(name)), "ISO 20022 golden cases");
    }
}
