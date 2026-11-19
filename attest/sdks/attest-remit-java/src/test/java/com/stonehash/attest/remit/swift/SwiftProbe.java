package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.RemitException;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Answers, for inputs given one per line, what this package makes of them — in
 * the shape the TypeScript SDK's answers are recorded in, so the two can be
 * compared line by line. A line in is {@code {"base64": "…", "as": "bytes"|"string"}};
 * a line out is {@code {"payments": […], "derived": […], "mappings": […]}} or {@code {"error": {…}}}.
 */
public final class SwiftProbe {
    private SwiftProbe() {
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, false, "UTF-8");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        List<String> institutions = new ArrayList<>();
        for (String a : args) {
            institutions.add(a);
        }
        for (String line = in.readLine(); line != null; line = in.readLine()) {
            if (line.isEmpty()) {
                continue;
            }
            out.println(Json.compact(answer(line, institutions)));
        }
        out.flush();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> answer(String line, List<String> institutions) {
        Map<String, Object> result = new LinkedHashMap<>();
        try {
            Map<String, Object> request = (Map<String, Object>) Json.parse(line);
            byte[] bytes = Base64.getDecoder().decode((String) request.get("base64"));
            List<SwiftPayment> all = "string".equals(request.get("as"))
                    ? Swift.parseAll(new String(bytes, StandardCharsets.UTF_8)) : Swift.parseAll(bytes);
            List<Object> payments = new ArrayList<>();
            List<Object> derived = new ArrayList<>();
            List<Object> mappings = new ArrayList<>();
            for (SwiftPayment p : all) {
                payments.add(p.toJson());
                Map<String, Object> d = new LinkedHashMap<>();
                Map<String, Object> ids = new LinkedHashMap<>();
                for (String i : institutions) {
                    ids.put(i, Swift.paymentId(i, p));
                }
                d.put("paymentIds", ids);
                d.put("contentDigest", Swift.contentDigest(p));
                d.put("isoFieldNames", new ArrayList<Object>(Swift.isoFieldNames(p)));
                derived.add(d);
                Map<String, Object> m = Swift.map(p, new SwiftMappingOptions()).toJson();
                if (!m.containsKey("input")) {
                    m.put("input", null);
                }
                mappings.add(m);
            }
            result.put("payments", payments);
            result.put("derived", derived);
            result.put("mappings", mappings);
        } catch (RemitException e) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("code", e.code());
            if (e instanceof SwiftMessageException && ((SwiftMessageException) e).field() != null) {
                err.put("field", ((SwiftMessageException) e).field());
            }
            err.put("message", e.getMessage());
            result.put("error", err);
        } catch (RuntimeException | StackOverflowError e) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("crash", e.toString());
            result.put("error", err);
        }
        return result;
    }
}
