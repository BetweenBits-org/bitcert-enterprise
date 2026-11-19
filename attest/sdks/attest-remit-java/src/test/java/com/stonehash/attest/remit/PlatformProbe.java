package com.stonehash.attest.remit;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The platform's half of the SDK — {@link Rules}, {@link Conventions},
 * {@link TravelRule} — on the command line, for the two tools that put it
 * side by side with the reference:
 *
 * <pre>
 *   PlatformProbe rules [doubles]       one case a line on standard input, one answer a line on standard output
 *                                       (tools/diff-fuzz-rules.mjs); with "doubles", every number of a case is
 *                                       held as a Double first — which is how the platform's JSON reader hands
 *                                       numbers over — and the answers have to be the same
 *   PlatformProbe made &lt;golden dir&gt;     things signed and encrypted here, for the platform's code to verify and open
 *                                       (tools/check-java-made.mjs)
 * </pre>
 *
 * A case is JSON: {@code { evidence, policy }} (the verdict),
 * {@code { evidence, keyring }} (the signature pass), {@code { policy }}
 * (its validation, canonical text and digest) or {@code { time }}. An answer
 * is written as JavaScript writes JSON, so that the two sides can be compared
 * as text.
 */
public final class PlatformProbe {
    private PlatformProbe() {
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, false, "UTF-8");
        if (args.length >= 1 && args.length <= 2 && args[0].equals("rules") && (args.length == 1 || args[1].equals("doubles"))) {
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                Object c = Json.parse(line);
                out.println(JsValue.stringify(answer(VerdictEngineTest.object(args.length == 2 ? RulesTest.doubles(c) : c))));
            }
        } else if (args.length == 2 && args[0].equals("made")) {
            out.println(JsValue.stringify(made(Paths.get(args[1]))));
        } else {
            System.err.println("usage: PlatformProbe rules [doubles] < cases   |   PlatformProbe made <golden dir>");
            System.exit(2);
        }
        out.flush();
    }

    private static Map<String, Object> one(String key, Object value) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(key, value);
        return out;
    }

    private static Map<String, Object> threw(RemitException e) {
        Map<String, Object> refusal = new LinkedHashMap<>();
        refusal.put("code", e.code());
        refusal.put("message", e.getMessage());
        return one("threw", refusal);
    }

    private static Map<String, Object> answer(Map<String, Object> c) {
        try {
            if (c.containsKey("time")) {
                double ms = VerdictEngine.dateParse(c.get("time"), false);
                return one("ms", Double.isNaN(ms) ? null : (Object) (long) ms);
            }
            if (c.containsKey("keyring")) {
                return one("evidence", Rules.checkSignatures(c.get("evidence"), Rules.keyring(VerdictEngineTest.list(c.get("keyring")))));
            }
            if (c.containsKey("evidence")) {
                return one("result", Rules.evaluate(c.get("evidence"), c.get("policy")));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            try {
                Rules.validatePolicy(c.get("policy"));
                out.put("problem", null);
            } catch (RemitException e) {
                out.put("problem", threw(e).get("threw"));
            }
            out.put("canonical", Rules.canonicalPolicy(c.get("policy")));
            out.put("digest", Rules.policyDigest(c.get("policy")));
            return out;
        } catch (RemitException e) {
            return threw(e);
        } catch (RuntimeException e) {
            // Never an answer of the SDK's: the tool reports it as a crash.
            return one("crash", String.valueOf(e));
        }
    }

    private static Map<String, Object> read(Path golden, String file) throws Exception {
        return VerdictEngineTest.object(Json.parse(Files.readAllBytes(golden.resolve(file)), "invalid_json", file));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> cases(Object list) {
        return (List<Map<String, Object>>) list;
    }

    /** Signed and encrypted here with the test key of {@code signing.json}: whether the platform's code takes it is for that code to say. */
    private static Map<String, Object> made(Path golden) throws Exception {
        Map<String, Object> key = VerdictEngineTest.object(read(golden, "signing.json").get("testKey"));
        KeySigner signer = Signers.fromPkcs8Pem((String) key.get("pkcs8Pem"));
        String keyId = (String) key.get("keyId");
        String issuer = (String) key.get("issuer");
        Map<String, Object> conventions = read(golden, "conventions.json");
        Map<String, Object> travelRule = read(golden, "travel-rule.json");

        List<Object> events = new ArrayList<>();
        for (Map<String, Object> c : cases(conventions.get("events"))) {
            if (!c.containsKey("threw")) {
                Map<String, Object> e = one("name", c.get("name"));
                e.put("payload", c.get("payload"));
                e.put("sig", Conventions.signEvent(c.get("payload"), signer, keyId, issuer));
                events.add(e);
            }
        }
        List<Object> elements = new ArrayList<>();
        for (Map<String, Object> c : cases(conventions.get("elements"))) {
            if (!c.containsKey("signingThrew")) {
                Map<String, Object> element = VerdictEngineTest.object(c.get("element"));
                Map<String, Object> e = one("name", c.get("name"));
                e.put("signed", Conventions.signElement(element, signer, keyId, issuer));
                e.put("digestedAndSigned", Conventions.digestAndSignElement(element, signer, keyId, issuer));
                elements.add(e);
            }
        }
        // Travel Rule messages, built here from the party data and encrypted here to the recipient of the vectors.
        Map<String, Object> recipient = VerdictEngineTest.object(travelRule.get("recipient"));
        Map<String, Object> jwk = VerdictEngineTest.object(recipient.get("publicJwk"));
        List<Object> encrypted = new ArrayList<>();
        for (Map<String, Object> c : cases(travelRule.get("messages"))) {
            if (!c.containsKey("threw")) {
                String json = JsValue.stringify(TravelRule.buildIvms101(c.get("compliance"), VerdictEngineTest.object(c.get("context"))));
                encrypted.add(jwe((String) c.get("name"), json.getBytes(StandardCharsets.UTF_8), jwk, (String) recipient.get("keyId")));
            }
        }
        encrypted.add(jwe("nothing at all", new byte[0], jwk, (String) recipient.get("keyId")));
        encrypted.add(jwe("no key id", "no kid".getBytes(StandardCharsets.UTF_8), jwk, null));
        encrypted.add(jwe("an empty key id", "no kid either".getBytes(StandardCharsets.UTF_8), jwk, ""));
        byte[] large = new byte[100_000];
        for (int i = 0; i < large.length; i++) {
            large[i] = (byte) (i * 131 + 7);
        }
        encrypted.add(jwe("a hundred thousand bytes", large, jwk, (String) recipient.get("keyId")));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("java", System.getProperty("java.version"));
        Map<String, Object> signedBy = new LinkedHashMap<>();
        signedBy.put("spkiBase64", signer.publicKeySpkiBase64());
        signedBy.put("keyId", keyId);
        signedBy.put("issuer", issuer);
        out.put("key", signedBy);
        out.put("events", events);
        out.put("elements", elements);
        out.put("encrypted", encrypted);
        return out;
    }

    private static Map<String, Object> jwe(String name, byte[] plaintext, Map<String, Object> jwk, String keyId) {
        Map<String, Object> out = one("name", name);
        out.put("keyId", keyId);
        out.put("plaintextBase64", Base64.getEncoder().encodeToString(plaintext));
        out.put("jwe", TravelRule.encrypt(plaintext, jwk, keyId));
        return out;
    }
}
