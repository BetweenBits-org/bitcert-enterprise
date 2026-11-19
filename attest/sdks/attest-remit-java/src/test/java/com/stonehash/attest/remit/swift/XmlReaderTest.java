package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The XML reader, held to the reference's answers: every probe of
 * {@link Iso20022Answers#XML} is read here and compared with what the
 * TypeScript {@code parseXml} gave for it — the same tree, or the same
 * refusal in the same words.
 */
final class XmlReaderTest {
    private XmlReaderTest() {
    }

    /**
     * The tree as the probe writes it: every element in document order, each
     * as {@code {depth, name, ns, attrs, text}} — flat, because the JSON
     * reader of these tests stops at 100 levels and a document may have 64.
     */
    static List<Object> elements(XmlReader.Element el, int depth, List<Object> out) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("depth", (long) depth);
        e.put("name", el.name);
        e.put("ns", el.ns);
        e.put("attrs", new LinkedHashMap<String, Object>(el.attrs));
        e.put("text", el.text);
        out.add(e);
        for (XmlReader.Element c : el.children) {
            elements(c, depth + 1, out);
        }
        return out;
    }

    private static Map<String, Object> error(String name, String message) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("name", name);
        e.put("message", message);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", e);
        return out;
    }

    static void testEveryProbeReadsAsTheReferenceReadsIt() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.XML) {
            Object expected = Json.parse(row[2]);
            Map<String, Object> actual;
            try {
                actual = new LinkedHashMap<>();
                actual.put("elements", elements(XmlReader.parse(row[1]), 0, new ArrayList<>()));
            } catch (XmlReader.XmlException e) {
                actual = error("XmlError", e.getMessage());
            }
            String d = Golden.difference(expected, actual);
            if (d != null) {
                failures.add(row[0] + ": " + d);
            }
        }
        Golden.none(failures, "XML probes");
    }

    static void testEscapingAsTheReferenceEscapes() {
        List<String> failures = new ArrayList<>();
        for (String[] row : Iso20022Answers.ESCAPES) {
            Map<String, Object> actual = new LinkedHashMap<>();
            actual.put("escaped", XmlReader.xmlEscape(row[1]));
            String d = Golden.difference(Json.parse(row[2]), actual);
            if (d != null) {
                failures.add(Json.compact(row[0]) + ": " + d);
            }
        }
        Golden.none(failures, "xmlEscape probes");
    }

    static void testNavigationTakesTheParentsNamespaceAndOneOfEach() {
        XmlReader.Element root = XmlReader.parse("<a xmlns=\"urn:a\" xmlns:o=\"urn:o\"><b> x </b><o:b>other</o:b><c/><c>y</c><d><e>deep</e></d></a>");
        Check.equal("x", XmlReader.textAt(root, "b"), "the child in the parent's namespace, trimmed");
        Check.equal(2, XmlReader.childrenOf(root, "c").size(), "every child of that name");
        Check.equal(0, XmlReader.childrenOf(null, "c").size(), "an absent parent has no children");
        Check.equal("deep", XmlReader.textAt(root, "d/e"), "a path of children");
        Check.equal(null, XmlReader.textAt(root, "d/x/e"), "a path that breaks off");
        Check.equal(null, XmlReader.child(null, "b"), "no parent, no child");
        Check.equal("deep", XmlReader.textAt(XmlReader.at(root, "d/e"), ""), "the empty path is the element itself");
        XmlReader.Element foreign = XmlReader.parse("<r><x:b xmlns:x=\"urn:x\">other</x:b></r>");
        Check.equal(null, XmlReader.child(foreign, "b"), "a child of another namespace is not the parent's");
        Check.equal("other", XmlReader.findFirst(foreign, "b").text, "findFirst looks at local names only");
        Check.equal(null, XmlReader.findFirst(foreign, "z"), "findFirst finds nothing when nothing has the name");
        try {
            XmlReader.textAt(root, "c/z");
            throw new AssertionError("two <c> where one is expected must be refused");
        } catch (XmlReader.XmlException e) {
            Check.equal("<c> occurs more than once inside <a> — one is expected", e.getMessage(), "the refusal names the element and its parent");
        }
    }

    /** The reference's timing test: many prefixes in scope over many elements, and one element gathering much text. */
    static void testLargeDocumentsAreReadInLinearTime() {
        StringBuilder prefixes = new StringBuilder();
        for (int i = 0; i < 60; i++) {
            prefixes.append(" xmlns:p").append(i).append("=\"urn:").append(i).append('"');
        }
        StringBuilder doc = new StringBuilder("<a").append(prefixes).append('>');
        for (int i = 0; i < 60_000; i++) {
            doc.append("<b><c>x</c></b>");
        }
        doc.append("</a>");
        long t0 = System.nanoTime();
        XmlReader.Element root = XmlReader.parse(doc.toString());
        long ms = (System.nanoTime() - t0) / 1_000_000;
        Check.equal(60_000, root.children.size(), "every element is read");
        Check.isTrue(ms < 4_000, "60 prefixes over 120,000 elements took " + ms + " ms");

        StringBuilder text = new StringBuilder("<a>");
        for (int i = 0; i < 200_000; i++) {
            text.append("\n  <b/>");
        }
        text.append("\n</a>");
        t0 = System.nanoTime();
        root = XmlReader.parse(text.toString());
        ms = (System.nanoTime() - t0) / 1_000_000;
        Check.equal(200_000 * 3 + 1, root.text.length(), "the text between the children is the parent's");
        Check.isTrue(ms < 4_000, "200,000 runs of text in one element took " + ms + " ms");
    }
}
