package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The golden vectors of the mapping and of a payment's identity: what the
 * TypeScript SDK answers for {@code mapSwiftPayment}, {@code swiftPaymentId},
 * {@code swiftContentDigest} and {@code isoFieldNames}. The payments are taken
 * from {@code parse.json} as the reference read them, so these cases do not
 * depend on the readers.
 */
final class MappingGoldenTest {
    private MappingGoldenTest() {
    }

    /** The parse cases by name. */
    static Map<String, Map<String, Object>> parseCases() {
        Map<String, Map<String, Object>> out = new LinkedHashMap<>();
        for (Map<String, Object> c : Golden.cases("parse.json")) {
            out.put((String) c.get("name"), c);
        }
        return out;
    }

    /** Payment {@code index} of a parse case, as the reference read it. */
    static SwiftPayment payment(Map<String, Object> parseCase, int index) {
        List<Object> payments = Golden.list(Golden.map(parseCase.get("expect")).get("payments"));
        return SwiftPayment.fromJson(Golden.map(payments.get(index)));
    }

    /** The options of a mapping case, as {@code mapSwiftPayment} was given them. */
    static SwiftMappingOptions options(Map<String, Object> json) {
        SwiftMappingOptions out = new SwiftMappingOptions();
        for (Map.Entry<String, Object> e : json.entrySet()) {
            switch (e.getKey()) {
                case "supplement":
                    out.supplement(Golden.map(e.getValue()));
                    break;
                case "tradeCurrency":
                    out.tradeCurrency((String) e.getValue());
                    break;
                case "inferCountryFromBic":
                    out.inferCountryFromBic((Boolean) e.getValue());
                    break;
                case "allowTestMessages":
                    out.allowTestMessages((Boolean) e.getValue());
                    break;
                case "corridor":
                    Map<String, Object> c = Golden.map(e.getValue());
                    out.corridor((String) c.get("origin"), (String) c.get("destination"));
                    break;
                default:
                    throw new AssertionError("an option the test does not know: " + e.getKey());
            }
        }
        return out;
    }

    /**
     * The first difference between two JSON values, or null. Values first, then
     * — since a signed instruction is built from these maps — the order of the
     * keys, by comparing the text {@code JSON.stringify} would write.
     */
    static String differenceInValueOrOrder(Object expected, Object actual) {
        String d = Golden.difference(expected, actual);
        if (d != null) {
            return d;
        }
        String e = Json.compact(expected);
        String a = Json.compact(actual);
        return e.equals(a) ? null : "the same values in another key order — expected " + e + ", got " + a;
    }

    static void testEveryMappingCaseMapsAsTheReferenceDoes() {
        Map<String, Map<String, Object>> parsed = parseCases();
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Golden.cases("mapping.json")) {
            String name = (String) c.get("name");
            ran++;
            try {
                Map<String, Object> parseCase = parsed.get((String) c.get("parse"));
                if (parseCase == null) {
                    failures.add(name + ": no parse case " + c.get("parse"));
                    continue;
                }
                SwiftPayment p = payment(parseCase, ((Number) c.get("index")).intValue());
                SwiftMapping m = Swift.map(p, options(Golden.map(c.get("options"))));
                Map<String, Object> expect = Golden.map(c.get("expect"));
                Map<String, Object> got = m.toJson();
                List<String> keys = m.input() == null ? Arrays.asList("fields", "issues", "unmapped")
                        : Arrays.asList("fields", "issues", "unmapped", "input");
                if (!keys.equals(new ArrayList<>(got.keySet()))) {
                    failures.add(name + ": the mapping's JSON has the keys " + got.keySet() + ", expected " + keys);
                }
                for (String k : Arrays.asList("fields", "issues", "unmapped")) {
                    String d = differenceInValueOrOrder(expect.get(k), got.get(k));
                    if (d != null) {
                        failures.add(name + " " + k + ": " + d);
                    }
                }
                if (expect.get("input") == null) {
                    if (got.containsKey("input") || m.input() != null) {
                        failures.add(name + ": an input, where the reference has none — " + Json.compact(got.get("input")));
                    }
                } else {
                    String d = differenceInValueOrOrder(expect.get("input"), got.get("input"));
                    if (d != null) {
                        failures.add(name + " input: " + d);
                    } else {
                        // The accessors say what the JSON says.
                        SwiftInstructionInput in = m.input();
                        Map<String, Object> ei = Golden.map(expect.get("input"));
                        String dd = differenceInValueOrOrder(ei, accessorView(in));
                        if (dd != null) {
                            failures.add(name + " input accessors: " + dd);
                        }
                    }
                }
                Object error = expect.get("error");
                if (error == null) {
                    if (!m.issues().isEmpty()) {
                        failures.add(name + ": issues, where the reference has none — " + m.issues());
                    }
                } else {
                    Map<String, Object> e = Golden.map(error);
                    SwiftMappingException ex = new SwiftMappingException(m);
                    if (!"SwiftMappingError".equals(e.get("name"))) {
                        failures.add(name + ": the reference throws " + e.get("name") + ", not a SwiftMappingError");
                    }
                    if (!"mapping_incomplete".equals(ex.code())) {
                        failures.add(name + ": code " + ex.code());
                    }
                    String want = Golden.javaWording((String) e.get("message"));
                    if (!want.equals(ex.getMessage())) {
                        failures.add(name + ": the refusal differs — expected " + Json.compact(want) + ", got " + Json.compact(ex.getMessage()));
                    }
                    if (ex.issues() != m.issues() || ex.mapping() != m) {
                        failures.add(name + ": the exception does not carry the mapping it was made from");
                    }
                }
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
            }
        }
        Check.isTrue(ran >= 25, "mapping.json has its cases (" + ran + ")");
        Golden.none(failures, "mapping.json");
    }

    /** The input rebuilt from its accessors, in the reference's key order. */
    private static Map<String, Object> accessorView(SwiftInstructionInput in) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tradeAmount", in.tradeAmount());
        out.put("tradeCurrency", in.tradeCurrency());
        out.put("parties", in.parties());
        out.put("invoiceRef", in.invoiceRef());
        if (in.purposeCode() != null) {
            out.put("purposeCode", in.purposeCode());
        }
        if (in.instructionRef() != null) {
            out.put("instructionRef", in.instructionRef());
        }
        out.put("source", in.source());
        out.put("messageFields", new ArrayList<Object>(in.messageFields()));
        return out;
    }

    static void testEveryParsedPaymentHasTheReferenceIdsDigestAndFieldNames() {
        Map<String, Object> file = Golden.file("parse.json");
        Set<String> institutions = new HashSet<>();
        for (Object i : Golden.list(file.get("institutions"))) {
            institutions.add((String) i);
        }
        List<String> failures = new ArrayList<>();
        int payments = 0;
        int ids = 0;
        for (Map<String, Object> c : Golden.cases("parse.json")) {
            String name = (String) c.get("name");
            Map<String, Object> expect = Golden.map(c.get("expect"));
            if (expect.get("payments") == null) {
                continue;
            }
            List<Object> all = Golden.list(expect.get("payments"));
            List<Object> derived = Golden.list(expect.get("derived"));
            if (derived == null || derived.size() != all.size()) {
                failures.add(name + ": " + all.size() + " payment(s) but " + (derived == null ? 0 : derived.size()) + " derived");
                continue;
            }
            for (int i = 0; i < all.size(); i++) {
                String at = name + " [" + i + "]";
                try {
                    payments++;
                    SwiftPayment p = SwiftPayment.fromJson(Golden.map(all.get(i)));
                    Map<String, Object> want = Golden.map(derived.get(i));
                    Map<String, Object> wantIds = Golden.map(want.get("paymentIds"));
                    if (!wantIds.keySet().equals(institutions)) {
                        failures.add(at + ": ids for " + wantIds.keySet() + ", the file names " + institutions);
                    }
                    for (Map.Entry<String, Object> e : wantIds.entrySet()) {
                        ids++;
                        String got = Swift.paymentId(e.getKey(), p);
                        if (!e.getValue().equals(got)) {
                            failures.add(at + ": payment id for " + e.getKey() + " — expected " + e.getValue() + ", got " + got);
                        }
                    }
                    String digest = Swift.contentDigest(p);
                    if (!want.get("contentDigest").equals(digest)) {
                        failures.add(at + ": content digest — expected " + want.get("contentDigest") + ", got " + digest);
                    }
                    String d = differenceInValueOrOrder(want.get("isoFieldNames"), new ArrayList<Object>(Swift.isoFieldNames(p)));
                    if (d != null) {
                        failures.add(at + ": ISO field names — " + d);
                    }
                } catch (RuntimeException e) {
                    failures.add(at + ": " + e);
                }
            }
        }
        Check.isTrue(payments >= 45 && ids >= 90, "parse.json has its payments (" + payments + " payments, " + ids + " ids)");
        Golden.none(failures, "payment ids, content digests and ISO field names");
    }
}
