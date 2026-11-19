package com.stonehash.attest.remit;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The platform's half of the Travel Rule — the public methods of
 * {@link TravelRule} — held to the platform's own code:
 * {@code golden/travel-rule.json} records which required fields it finds
 * missing, the message it builds and the keys it derives. That a message
 * encrypted here opens with the recipient's key is shown here with a
 * decryption written for the test (the SDK has none), and against the
 * platform's own {@code decryptJwe} by {@code tools/check-java-made.mjs}.
 */
final class TravelRuleTest {
    private TravelRuleTest() {
    }

    private static Map<String, Object> golden;

    private static Map<String, Object> golden() throws Exception {
        if (golden == null) {
            golden = Json.object(Json.parse(TestMain.resource("golden/travel-rule.json"), "invalid_json", "travel-rule.json"), "invalid_json", "travel-rule.json");
        }
        return golden;
    }

    private static Map<String, Object> object(Object o) {
        return VerdictEngineTest.object(o);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> cases(Object list) {
        return (List<Map<String, Object>>) list;
    }

    // ── the message ───────────────────────────────────────────────────────────

    static void testTheRequiredFieldsAndWhatIsMissingAreThePlatforms() throws Exception {
        Check.equal(golden().get("required"), new ArrayList<>(TravelRule.REQUIRED_FIELDS), "the fields the corridor requires, in the platform's order");
        Check.fails(UnsupportedOperationException.class, () -> TravelRule.REQUIRED_FIELDS.add("x"));
        int checked = 0;
        int complete = 0;
        for (Map<String, Object> c : cases(golden().get("missing"))) {
            Object compliance = c.get("compliance");
            if (c.containsKey("threw")) {
                Check.refuses("unreadable_compliance", () -> TravelRule.missingFields(compliance));
                continue;
            }
            Check.equal(c.get("missing"), TravelRule.missingFields(compliance), c.get("name") + ": what is missing");
            Check.equal(c.get("missing"), TravelRule.missingFields(RulesTest.doubles(compliance)), c.get("name") + ": what is missing, numbers held as doubles");
            checked++;
            complete += VerdictEngineTest.list(c.get("missing")).isEmpty() ? 1 : 0;
        }
        Check.isTrue(checked >= 35 && complete >= 8 && checked - complete >= 20, "the vectors were read: " + checked + " payloads, " + complete + " complete");
    }

    static void testTheMessageIsThePlatformsMemberForMember() throws Exception {
        List<String> failures = new ArrayList<>();
        int built = 0;
        for (Map<String, Object> c : cases(golden().get("messages"))) {
            String name = (String) c.get("name");
            Object compliance = c.get("compliance");
            Map<String, Object> context = object(c.get("context"));
            if (c.containsKey("threw")) {
                Check.refuses("unreadable_compliance", () -> TravelRule.buildIvms101(compliance, context));
                continue;
            }
            String before = JsValue.stringify(compliance);
            Map<String, Object> message = TravelRule.buildIvms101(compliance, context);
            // What the platform encrypts is this text; what the evidence carries is the digest of its canonical form.
            String json = JsValue.stringify(message);
            if (!c.get("json").equals(json)) {
                failures.add(name + ":\n        here:         " + json + "\n        the platform: " + c.get("json"));
                continue;
            }
            Check.equal(JsValue.stringify(c.get("message")), json, name + ": the message as an object");
            Check.equal(before, JsValue.stringify(compliance), name + ": the party data is not changed");
            // The platform's own JSON reader hands numbers over as doubles: the same message, the same digest.
            Map<String, Object> fromDoubles = TravelRule.buildIvms101(RulesTest.doubles(compliance), object(RulesTest.doubles(context)));
            Check.equal(json, JsValue.stringify(fromDoubles), name + ": with its numbers held as doubles");
            if (!c.containsKey("digestThrew")) {
                Check.equal(c.get("digest"), Hex.sha256Hex(Conventions.canonicalBytes(fromDoubles)), name + ": and its digest");
            }
            if (c.containsKey("digestThrew")) {
                Check.refuses("not_canonical", () -> Conventions.canonicalBytes(message));
            } else {
                Check.equal(c.get("digest"), Hex.sha256Hex(Conventions.canonicalBytes(message)), name + ": the digest the evidence carries");
            }
            built++;
        }
        VerdictEngineTest.none(failures, "Travel Rule messages");
        Check.isTrue(built >= 35, "the vectors were read: " + built + " messages");
        Map<String, Object> first = cases(golden().get("messages")).get(0);
        Check.fails(NullPointerException.class, () -> TravelRule.buildIvms101(first.get("compliance"), null));
        Map<String, Object> incomplete = new LinkedHashMap<>(object(first.get("context")));
        incomplete.remove("settlementEntity");
        Check.fails(IllegalArgumentException.class, () -> TravelRule.buildIvms101(first.get("compliance"), incomplete));
    }

    /** The message a bank's own SDK builds (mode B) is, for the parties a bank states, the message the platform builds (mode A). */
    static void testTheBankSideMessageIsTheSameMessage() throws Exception {
        Map<String, Object> c = cases(golden().get("messages")).get(0);
        Map<String, Object> compliance = object(c.get("compliance"));
        Map<String, Object> context = object(c.get("context"));
        TradeParties parties = TradeParties.ofFields(object(compliance.get("originator")), object(compliance.get("beneficiary")));
        Map<String, Object> bankSide = TravelRule.message(parties, (String) context.get("paymentId"), (String) context.get("tradeAmount"), (String) context.get("tradeCurrency"),
                (String) compliance.get("purpose_code"), object(context.get("originatingInstitution")), object(context.get("beneficiaryInstitution")),
                object(context.get("settlementEntity")), (String) context.get("usdcAmount"));
        Check.equal(c.get("json"), JsValue.stringify(bankSide), "one message, whoever builds it");
        Check.isTrue(TravelRule.isLei("5493001KJTIIGC8Y1R12") && !TravelRule.isLei("5493001KJTIIGC8Y1R1") && !TravelRule.isLei(null), "an LEI is twenty characters, the last two digits");
    }

    // ── the encryption ────────────────────────────────────────────────────────

    static void testTheKeyDerivationIsThePlatforms() throws Exception {
        int derived = 0;
        for (Map<String, Object> c : cases(golden().get("kdf"))) {
            byte[] key = TravelRule.concatKdf(ConventionsTest.unhex((String) c.get("z")), ((Number) c.get("bits")).intValue(), (String) c.get("alg"), (String) c.get("apu"), (String) c.get("apv"));
            Check.equal(c.get("key"), Hex.encode(key), (String) c.get("name"));
            derived++;
        }
        Check.isTrue(derived >= 12, "the vectors were read: " + derived);
        // RFC 7518, Appendix C, as the RFC states it.
        byte[] z = { (byte) 158, 86, (byte) 217, 29, (byte) 129, 113, 53, (byte) 211, 114, (byte) 131, 66, (byte) 131, (byte) 191, (byte) 132, 38, (byte) 156, (byte) 251, 49, 110,
                (byte) 163, (byte) 218, (byte) 128, 106, 72, (byte) 246, (byte) 218, (byte) 167, 121, (byte) 140, (byte) 254, (byte) 144, (byte) 196 };
        Check.equal("VqqN6vgjbSBcIijNcacQGg", Conventions.base64Url(TravelRule.concatKdf(z, 128, "A128GCM", "Alice", "Bob")), "the RFC's own vector");
        Check.fails(IllegalArgumentException.class, () -> TravelRule.concatKdf(z, 0, "A256GCM", "", ""));
        Check.fails(IllegalArgumentException.class, () -> TravelRule.concatKdf(z, 12, "A256GCM", "", ""));
        Check.fails(NullPointerException.class, () -> TravelRule.concatKdf(null, 256, "A256GCM", "", ""));
    }

    private static PrivateKey recipientKey() throws Exception {
        Map<String, Object> signing = Json.object(Json.parse(TestMain.resource("golden/signing.json"), "invalid_json", "signing.json"), "invalid_json", "signing.json");
        String pem = (String) object(signing.get("testKey")).get("pkcs8Pem");
        byte[] der = Base64.getMimeDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", ""));
        return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(der));
    }

    /** RFC 7516 compact, ECDH-ES direct with A256GCM, opened with the recipient's private key: test code, there is none in the SDK. */
    static byte[] open(String compact, PrivateKey recipient) throws Exception {
        String[] parts = compact.split("\\.", -1);
        Check.equal(5, parts.length, "five parts");
        Check.equal("", parts[1], "no encrypted key: it is derived, not transported");
        Map<String, Object> header = object(Json.parse(new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8)));
        Check.equal("ECDH-ES", header.get("alg"), "alg");
        Check.equal("A256GCM", header.get("enc"), "enc");
        Map<String, Object> epk = object(header.get("epk"));
        Check.equal(Arrays.asList("kty", "crv", "x", "y"), new ArrayList<>(epk.keySet()), "the ephemeral key's members, in the platform's order");
        PublicKey ephemeral = KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(
                new BigInteger(1, Base64.getUrlDecoder().decode((String) epk.get("x"))), new BigInteger(1, Base64.getUrlDecoder().decode((String) epk.get("y")))), TravelRule.p256()));
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(recipient);
        agreement.doPhase(ephemeral, true);
        byte[] key = TravelRule.concatKdf(agreement.generateSecret(), 256, "A256GCM", "", "");
        byte[] iv = Base64.getUrlDecoder().decode(parts[2]);
        byte[] ciphertext = Base64.getUrlDecoder().decode(parts[3]);
        byte[] tag = Base64.getUrlDecoder().decode(parts[4]);
        Check.equal(12, iv.length, "a 96-bit nonce");
        Check.equal(16, tag.length, "a 128-bit tag");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(parts[0].getBytes(StandardCharsets.US_ASCII));
        cipher.update(ciphertext);
        return cipher.doFinal(tag);
    }

    static void testAMessageEncryptedHereOpensWithTheRecipientsKeyAndNoOther() throws Exception {
        Map<String, Object> recipient = object(golden().get("recipient"));
        Map<String, Object> jwk = object(recipient.get("publicJwk"));
        String keyId = (String) recipient.get("keyId");
        PrivateKey key = recipientKey();
        Map<String, Object> c = cases(golden().get("messages")).get(0);
        byte[] plaintext = ((String) c.get("json")).getBytes(StandardCharsets.UTF_8);

        String jwe = TravelRule.encrypt(plaintext, jwk, keyId);
        Check.equal(new String(plaintext, StandardCharsets.UTF_8), new String(open(jwe, key), StandardCharsets.UTF_8), "what went in comes out");
        Map<String, Object> header = object(Json.parse(new String(Base64.getUrlDecoder().decode(jwe.substring(0, jwe.indexOf('.'))), StandardCharsets.UTF_8)));
        Check.equal(Arrays.asList("alg", "enc", "epk", "kid"), new ArrayList<>(header.keySet()), "the header's members, in the platform's order");
        Check.equal(keyId, header.get("kid"), "the recipient's key id");
        Check.isTrue(!jwe.contains("=") && !jwe.contains("+") && !jwe.contains("/"), "base64url, unpadded, throughout");
        // No key id, or an empty one: no kid member at all, as the platform writes it.
        for (String none : new String[] { null, "" }) {
            String without = TravelRule.encrypt(plaintext, jwk, none);
            Map<String, Object> h = object(Json.parse(new String(Base64.getUrlDecoder().decode(without.substring(0, without.indexOf('.'))), StandardCharsets.UTF_8)));
            Check.equal(Arrays.asList("alg", "enc", "epk"), new ArrayList<>(h.keySet()), "no kid");
            Check.equal(new String(plaintext, StandardCharsets.UTF_8), new String(open(without, key), StandardCharsets.UTF_8), "and it opens");
        }
        // Every message is encrypted under a key of its own: the same text twice is two different ciphertexts.
        String again = TravelRule.encrypt(plaintext, jwk, keyId);
        Check.isTrue(!again.equals(jwe) && !again.split("\\.", -1)[0].equals(jwe.split("\\.", -1)[0]), "a fresh key each time");
        // An empty message and a large one.
        Check.equal(0, open(TravelRule.encrypt(new byte[0], jwk, keyId), key).length, "nothing");
        byte[] large = new byte[70_000];
        for (int i = 0; i < large.length; i++) {
            large[i] = (byte) (i * 31);
        }
        Check.isTrue(Arrays.equals(large, open(TravelRule.encrypt(large, jwk, keyId), key)), "seventy thousand bytes");
        // The header is bound to the ciphertext: change one, and the tag no longer holds.
        String[] parts = jwe.split("\\.", -1);
        String swapped = again.split("\\.", -1)[0] + "." + parts[1] + "." + parts[2] + "." + parts[3] + "." + parts[4];
        Check.fails(javax.crypto.AEADBadTagException.class, () -> open(swapped, key));
        String edited = parts[0] + ".." + parts[2] + "." + parts[3].substring(0, parts[3].length() - 2) + (parts[3].endsWith("AA") ? "BB" : "AA") + "." + parts[4];
        Check.fails(javax.crypto.AEADBadTagException.class, () -> open(edited, key));
        // A recipient key that is not a P-256 public JWK is refused.
        for (String member : Arrays.asList("kty", "crv", "x", "y")) {
            Map<String, Object> broken = new LinkedHashMap<>(jwk);
            broken.put(member, "P-384");
            Check.refuses("invalid_key", () -> TravelRule.encrypt(plaintext, broken, keyId));
        }
        Check.fails(NullPointerException.class, () -> TravelRule.encrypt(null, jwk, keyId));
        Check.fails(NullPointerException.class, () -> TravelRule.encrypt(plaintext, null, keyId));
    }
}
