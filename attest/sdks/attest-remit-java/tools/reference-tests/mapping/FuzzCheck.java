package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Differential fuzz, Java side: reads what gen.ts wrote and reports every case the port answers differently. */
public final class FuzzCheck {
    private FuzzCheck() {
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    private static SwiftMappingOptions options(Map<String, Object> json) {
        SwiftMappingOptions out = new SwiftMappingOptions();
        for (Map.Entry<String, Object> e : json.entrySet()) {
            switch (e.getKey()) {
                case "supplement":
                    out.supplement(map(e.getValue()));
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
                    Map<String, Object> c = map(e.getValue());
                    out.corridor((String) c.get("origin"), (String) c.get("destination"));
                    break;
                default:
                    throw new IllegalArgumentException(e.getKey());
            }
        }
        return out;
    }

    public static void main(String[] args) throws Exception {
        int n = 0;
        List<String> failures = new ArrayList<>();
        try (BufferedReader r = Files.newBufferedReader(Paths.get(args[0]), StandardCharsets.UTF_8)) {
            for (String line; (line = r.readLine()) != null;) {
                if (line.isEmpty()) {
                    continue;
                }
                n++;
                Map<String, Object> c = map(Json.parse(line));
                Map<String, Object> expect = map(c.get("expect"));
                SwiftPayment p = SwiftPayment.fromJson(map(c.get("payment")));
                String at = "case " + n;
                try {
                    SwiftMapping m = SwiftMapper.map(p, options(map(c.get("options"))));
                    if (expect.get("threw") != null) {
                        failures.add(at + ": maps, the reference throws " + expect.get("threw"));
                    } else {
                        String want = Json.compact(expect.get("mapping"));
                        String got = Json.compact(m.toJson());
                        if (!want.equals(got)) {
                            failures.add(at + ": mapping differs\n   want " + want + "\n   got  " + got + "\n   payment " + Json.compact(c.get("payment")) + "\n   options " + Json.compact(c.get("options")));
                        }
                        Object error = expect.get("error");
                        String gotError = m.issues().isEmpty() ? null : new SwiftMappingException(m).getMessage();
                        if (error == null ? gotError != null : !error.equals(gotError)) {
                            failures.add(at + ": error differs\n   want " + error + "\n   got  " + gotError);
                        }
                    }
                } catch (RuntimeException e) {
                    if (expect.get("threw") == null) {
                        failures.add(at + ": throws " + e + ", the reference maps");
                    }
                }
                String digest = SwiftMapper.contentDigest(p);
                if (!digest.equals(expect.get("digest"))) {
                    failures.add(at + ": digest differs " + expect.get("digest") + " / " + digest + "\n   payment " + Json.compact(c.get("payment")));
                }
                for (Map.Entry<String, Object> e : map(expect.get("ids")).entrySet()) {
                    String id = SwiftIds.paymentId(e.getKey(), p);
                    if (!id.equals(e.getValue())) {
                        failures.add(at + ": id for " + Json.compact(e.getKey()) + " differs " + e.getValue() + " / " + id + "\n   payment " + Json.compact(c.get("payment")));
                    }
                }
                String iso = Json.compact(new ArrayList<Object>(SwiftIds.isoFieldNames(p)));
                if (!iso.equals(Json.compact(expect.get("iso")))) {
                    failures.add(at + ": iso differs " + Json.compact(expect.get("iso")) + " / " + iso);
                }
            }
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("cases", (long) n);
        summary.put("failures", (long) failures.size());
        for (String f : failures.subList(0, Math.min(failures.size(), 8))) {
            System.out.println(f);
        }
        System.out.println(Json.compact(summary));
    }
}
