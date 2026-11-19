package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;

/** Every case of {@code parse.json}, through the public entry point: what is read, what is refused, and in which words. */
final class SwiftParseGoldenTest {
    private SwiftParseGoldenTest() {
    }

    static void testEveryCaseIsAnsweredAsTheReferenceAnswersIt() {
        Golden.none(Golden.parseFailures((name) -> true), "parse.json");
    }

    static void testTheVectorsAreThere() {
        Check.isTrue(Golden.cases("parse.json").size() >= 64, "parse.json holds the cases it was written with, or more");
    }
}
