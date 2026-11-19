package com.stonehash.attest.remit;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The signing conventions against what the TypeScript SDK answers
 * ({@code golden/signing.json}): the same canonical bytes, the same bytes to
 * sign, the same digests — and signatures the TypeScript SDK made, verified
 * here.
 */
final class GoldenSigningTest {
    private GoldenSigningTest() {
    }

    private static Map<String, Object> golden() throws Exception {
        return Json.object(Json.parse(TestMain.resource("golden/signing.json"), "invalid_json", "signing.json"), "invalid_json", "signing.json");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> cases(Object list) {
        return (List<Map<String, Object>>) list;
    }

    static void testTheDomainsAreTheReferenceSdks() throws Exception {
        Map<String, Object> domains = Json.object(golden().get("domains"), "x", "domains");
        Check.equal(domains.get("event"), Signing.EVENT_DOMAIN, "the event domain");
        Check.equal(domains.get("digest"), Signing.DIGEST_DOMAIN, "the digest domain");
    }

    static void testCanonicalJsonIsByteForByteTheReferenceSdks() throws Exception {
        int same = 0;
        int refused = 0;
        for (Map<String, Object> c : cases(golden().get("jcs"))) {
            Object value = c.get("value");
            if (c.containsKey("error")) {
                Check.refuses("not_canonical", () -> Json.canonical(value));
                refused++;
            } else {
                Check.equal(c.get("utf8Hex"), Hex.encode(Json.canonicalBytes(value)), "canonical bytes of " + Json.compact(value));
                same++;
            }
        }
        Check.isTrue(same >= 20 && refused >= 4, "the vectors were read: " + same + " values, " + refused + " refusals");
    }

    static void testTheBytesSignedForAnEventAndAnElementAreTheReferenceSdks() throws Exception {
        Map<String, Object> g = golden();
        for (Map<String, Object> c : cases(g.get("events"))) {
            Check.equal(c.get("signingBytesHex"), Hex.encode(Signing.eventBytes(c.get("payload"))), "the bytes signed for an event");
        }
        for (Map<String, Object> c : cases(g.get("elements"))) {
            Map<String, Object> element = Json.object(c.get("element"), "x", "element");
            Check.equal(c.get("digest"), Signing.elementDigest(element), "an element's digest");
            Map<String, Object> withDigest = new LinkedHashMap<>(element);
            withDigest.put("digest", c.get("digest"));
            Check.equal(c.get("signingBytesHex"), Hex.encode(Signing.elementBytes(withDigest)), "the bytes signed for an element");
        }
    }

    static void testSignaturesMadeByTheReferenceSdkVerifyHere() throws Exception {
        Map<String, Object> g = golden();
        Map<String, Object> key = Json.object(g.get("testKey"), "x", "testKey");
        String spki = (String) key.get("spkiBase64");
        Map<String, Object> signed = Json.object(g.get("signedByTypeScript"), "x", "signedByTypeScript");
        int n = 0;
        for (Map<String, Object> c : cases(signed.get("events"))) {
            Check.isTrue(Signing.verifyEvent(c.get("payload"), c.get("signature"), spki), "an event signed by the reference SDK verifies");
            Map<String, Object> edited = new LinkedHashMap<>(Json.object(c.get("payload"), "x", "payload"));
            edited.put("tampered", Boolean.TRUE);
            Check.isTrue(!Signing.verifyEvent(edited, c.get("signature"), spki), "and not over a changed payload");
            n++;
        }
        for (Map<String, Object> element : cases(signed.get("elements"))) {
            Check.isTrue(Signing.verifyElement(element, spki), "an element signed by the reference SDK verifies");
            n++;
        }
        Check.isTrue(n >= 4, "the vectors were read: " + n);
    }

    static void testTheSameKeyFileIsTheSameKeyHere() throws Exception {
        Map<String, Object> key = Json.object(golden().get("testKey"), "x", "testKey");
        KeySigner signer = Signers.fromPkcs8Pem((String) key.get("pkcs8Pem"));
        Check.equal(key.get("spkiBase64"), signer.publicKeySpkiBase64(), "the public half derived from the PEM");
        // A signature made here verifies under the public key the reference SDK states for that file.
        byte[] message = "stonehash".getBytes(StandardCharsets.UTF_8);
        Check.isTrue(Signers.verifies((String) key.get("spkiBase64"), message, Signers.signRaw(signer, message)), "signed here, verified under the stated key");
    }
}
