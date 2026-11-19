package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.RemitException;
import com.stonehash.attest.remit.TestMain;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.Predicate;

/**
 * The golden vectors: what the TypeScript SDK answers, read from
 * {@code src/test/resources/golden} and compared with what this package
 * answers for the same input.
 */
final class Golden {
    private Golden() {
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> file(String name) {
        try {
            return (Map<String, Object>) Json.parse(new String(TestMain.resource("golden/" + name), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new AssertionError("golden/" + name + " could not be read: " + e, e);
        }
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> cases(String name) {
        return (List<Map<String, Object>>) (List<?>) file(name).get("cases");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    /** The input of a parse case, as the TypeScript SDK was handed it: a String or a byte[]. */
    static Object input(Map<String, Object> c) {
        Map<String, Object> in = map(c.get("input"));
        boolean asString = "string".equals(in.get("as"));
        if (in.get("repeat") != null) {
            // An input too large to store: a prefix, then a text written a number of times.
            Map<String, Object> r = map(in.get("repeat"));
            String unit = (String) r.get("text");
            int times = ((Number) r.get("times")).intValue();
            StringBuilder text = new StringBuilder(r.get("prefix") == null ? "" : (String) r.get("prefix"));
            for (int i = 0; i < times; i++) {
                text.append(unit);
            }
            return asString ? (Object) text.toString() : (Object) text.toString().getBytes(StandardCharsets.ISO_8859_1);
        }
        if (asString) {
            return in.get("text");
        }
        return Base64.getDecoder().decode((String) in.get("base64"));
    }

    static List<SwiftPayment> parseAll(Object input) {
        return input instanceof String ? Swift.parseAll((String) input) : Swift.parseAll((byte[]) input);
    }

    static SwiftPayment parse(Object input, Integer index) {
        return input instanceof String ? Swift.parse((String) input, index) : Swift.parse((byte[]) input, index);
    }

    /**
     * Where the TypeScript SDK's words name its own API, the Java SDK names
     * its own. Everything else is the same sentence.
     */
    static String javaWording(String message) {
        return message.replace("pass { index } to choose one, or use parseSwiftMessages() to take each in turn",
                "pass an index to choose one, or use Swift.parseAll() to take each in turn");
    }

    /** An exception, as the vectors record an error: code, field and message. */
    static Map<String, Object> errorOf(RemitException e) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", e.code());
        if (e instanceof SwiftMessageException && ((SwiftMessageException) e).field() != null) {
            out.put("field", ((SwiftMessageException) e).field());
        }
        out.put("message", e.getMessage());
        return out;
    }

    /** The recorded error, reduced to what is compared: its code, its field and its words (in Java's wording). */
    static Map<String, Object> expectedError(Object recorded) {
        Map<String, Object> r = map(recorded);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", r.get("code"));
        if (r.get("field") != null) {
            out.put("field", r.get("field"));
        }
        out.put("message", javaWording((String) r.get("message")));
        return out;
    }

    /**
     * The first place two JSON values differ, as a path and the two values, or
     * null when they are the same. Objects are compared by key, whatever the
     * order; a number is compared by value.
     */
    static String difference(Object expected, Object actual) {
        return difference("$", expected, actual);
    }

    private static String difference(String path, Object e, Object a) {
        if (e instanceof Map && a instanceof Map) {
            Map<String, Object> em = map(e);
            Map<String, Object> am = map(a);
            TreeSet<String> keys = new TreeSet<>(em.keySet());
            keys.addAll(am.keySet());
            for (String k : keys) {
                if (!em.containsKey(k)) {
                    return path + "." + k + ": not expected, got " + Json.compact(am.get(k));
                }
                if (!am.containsKey(k)) {
                    return path + "." + k + ": expected " + Json.compact(em.get(k)) + ", missing";
                }
                String d = difference(path + "." + k, em.get(k), am.get(k));
                if (d != null) {
                    return d;
                }
            }
            return null;
        }
        if (e instanceof List && a instanceof List) {
            List<Object> el = list(e);
            List<Object> al = list(a);
            for (int i = 0; i < Math.min(el.size(), al.size()); i++) {
                String d = difference(path + "[" + i + "]", el.get(i), al.get(i));
                if (d != null) {
                    return d;
                }
            }
            if (el.size() != al.size()) {
                return path + ": expected " + el.size() + " entries, got " + al.size() + " — expected " + Json.compact(e) + ", got " + Json.compact(a);
            }
            return null;
        }
        if (e instanceof Number && a instanceof Number) {
            return new java.math.BigDecimal(e.toString()).compareTo(new java.math.BigDecimal(a.toString())) == 0 ? null
                    : path + ": expected " + e + ", got " + a;
        }
        if (e == null ? a == null : e.equals(a)) {
            return null;
        }
        return path + ": expected " + Json.compact(e) + ", got " + Json.compact(a);
    }

    /**
     * Runs every case of {@code parse.json} whose name passes the filter and
     * returns what went wrong, one line per case — empty when nothing did.
     */
    static List<String> parseFailures(Predicate<String> names) {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : cases("parse.json")) {
            String name = (String) c.get("name");
            if (!names.test(name)) {
                continue;
            }
            ran++;
            Object input = input(c);
            Map<String, Object> expect = map(c.get("expect"));
            try {
                List<SwiftPayment> all;
                try {
                    all = parseAll(input);
                } catch (RemitException e) {
                    if (expect.get("error") == null) {
                        failures.add(name + ": refused, but the reference reads it — " + e.code() + ": " + e.getMessage());
                    } else {
                        String d = difference(expectedError(expect.get("error")), errorOf(e));
                        if (d != null) {
                            failures.add(name + ": the refusal differs — " + d);
                        }
                    }
                    continue;
                }
                if (expect.get("error") != null) {
                    failures.add(name + ": read, but the reference refuses it — " + Json.compact(expect.get("error")));
                    continue;
                }
                List<Object> got = new ArrayList<>();
                for (SwiftPayment p : all) {
                    got.add(p.toJson());
                }
                String d = difference(expect.get("payments"), got);
                if (d != null) {
                    failures.add(name + ": " + d);
                    continue;
                }
                for (String which : Arrays.asList("single", "beyond")) {
                    Map<String, Object> want = map(c.get(which));
                    Integer index = which.equals("single") ? null : Integer.valueOf(all.size());
                    try {
                        SwiftPayment one = parse(input, index);
                        if (want.get("error") != null) {
                            failures.add(name + " (" + which + "): returned a payment, the reference refuses — " + Json.compact(want.get("error")));
                        } else if (((Number) want.get("index")).intValue() != one.index()) {
                            failures.add(name + " (" + which + "): index " + one.index() + ", expected " + want.get("index"));
                        }
                    } catch (RemitException e) {
                        if (want.get("error") == null) {
                            failures.add(name + " (" + which + "): refused, the reference returns index " + want.get("index") + " — " + e.getMessage());
                        } else {
                            String dd = difference(expectedError(want.get("error")), errorOf(e));
                            if (dd != null) {
                                failures.add(name + " (" + which + "): the refusal differs — " + dd);
                            }
                        }
                    }
                }
            } catch (RuntimeException e) {
                failures.add(name + ": " + e);
            }
        }
        if (ran == 0) {
            failures.add("no case of parse.json matched the filter");
        }
        return failures;
    }

    static void none(List<String> failures, String what) {
        if (!failures.isEmpty()) {
            throw new AssertionError(what + ": " + failures.size() + " case(s) differ from the reference\n      " + String.join("\n      ", failures));
        }
    }
}
