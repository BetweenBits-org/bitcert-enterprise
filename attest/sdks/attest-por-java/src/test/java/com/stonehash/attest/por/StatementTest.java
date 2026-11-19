package com.stonehash.attest.por;

import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The statement, its commitment and its signature. */
final class StatementTest {
    private StatementTest() {
    }

    /** The vector's statement, rebuilt from its ingredients rather than read. */
    @SuppressWarnings("unchecked")
    private static Statement rebuiltVectorStatement() throws Exception {
        Map<String, Object> tree = null;
        for (Object c : (List<Object>) Sample.vector("trees.json").get("cases")) {
            if (((Map<String, Object>) c).get("name").equals("thirty-three accounts, five assets")) {
                tree = (Map<String, Object>) c;
            }
        }
        List<AssetSpec> assets = AssetSpec.parseList("A1:8,B2:18,C3:6,D4:0,E5:2");
        LedgerBuilder ledger = new LedgerBuilder(assets, AmountUnit.BASE);
        for (Object r : (List<Object>) tree.get("rows")) {
            Map<String, Object> row = (Map<String, Object>) r;
            Map<String, String> balances = new LinkedHashMap<>();
            ((Map<String, Object>) row.get("balances")).forEach((k, v) -> balances.put(k, (String) v));
            ledger.addAccount((String) row.get("user_ref"), balances);
        }
        Ledger read = ledger.finish();
        return Statement.builder()
                .exchange(Sample.EXCHANGE, "한빛 거래소 (Hanbit Exchange)")
                .asof("2026-11-16T00:00:00Z")
                .assets(read.assets())
                .tree(PorTree.build(Sample.EXCHANGE, Sample.seed(), read))
                .reserves(Arrays.asList(new ReserveEntry("eip155:1", "C3", "0x00000000000000000000000000000000000000aa",
                        "0x00000000000000000000000000000000000000bb")))
                .clock(Sample.CLOCK)
                .build();
    }

    static void testTheBuilderProducesTheVectorsStatementToTheByte() throws Exception {
        Map<String, Object> vector = Sample.vector("statement.json");
        Statement built = rebuiltVectorStatement();
        Check.equal(vector.get("statement"), built.toMap(), "the statement");
        Check.equal(vector.get("canonical"), built.canonicalJson(), "its canonical JSON");
        Check.equal(vector.get("commitment"), built.commitment(), "its commitment");
        Check.equal(Json.pretty(vector.get("statement")), built.toJson(), "and its members are in the reference's order");
        Check.equal("KR-EX-0a1b2c", built.institutionId(), "institution id");
        Check.equal(33, built.leafCount(), "leaf count");
        Check.equal("2026-11-16T01:02:03.456Z", built.generatedAt(), "generated_at comes from the clock, in milliseconds");
        Check.equal(new BigInteger("288255623867120420871540"), built.totals().get("A1"), "a total, as a number");
        Check.equal("[A1:8, B2:18, C3:6, D4:0, E5:2]", built.assets().toString(), "assets with their decimal places");
    }

    static void testReorderingOrReindentingAStatementChangesNeitherCommitmentNorSignature() throws Exception {
        Statement original = Sample.statement(Sample.tree());
        Map<String, Object> reversed = new LinkedHashMap<>();
        List<String> keys = new ArrayList<>(original.toMap().keySet());
        java.util.Collections.reverse(keys);
        for (String k : keys) {
            reversed.put(k, original.toMap().get(k));
        }
        Statement reordered = Statement.parse("  " + Json.compact(reversed) + "\n");
        Check.equal(original.commitment(), reordered.commitment(), "commitment");
        SignatureEnvelope sig = SignatureEnvelope.sign(original, Sample.signer());
        Check.isTrue(sig.verifies(reordered, Sample.spki()), "a signature over one verifies over the other");
        Check.equal(original, reordered, "they are the same statement");
    }

    static void testAStatementKeepsMembersThisVersionDoesNotKnow() {
        Map<String, Object> extended = new LinkedHashMap<>(Sample.statement(Sample.tree()).toMap());
        extended.put("future_member", Arrays.asList(1, "two"));
        Statement st = Statement.fromMap(extended);
        Check.isTrue(st.canonicalJson().contains("\"future_member\":[1,\"two\"]"), "an unknown member is part of what is signed");
        Check.equal("[]", st.validate().toString(), "and does not make the statement invalid");
        Check.fails(UnsupportedOperationException.class, () -> st.toMap().put("x", 1L));
    }

    @SuppressWarnings("unchecked")
    private static String invalid(String member, String child, Object value) {
        Map<String, Object> m = new LinkedHashMap<>(Sample.statement(Sample.tree()).toMap());
        if (child == null) {
            if (value == null) {
                m.remove(member);
            } else {
                m.put(member, value);
            }
        } else {
            Map<String, Object> inner = new LinkedHashMap<>((Map<String, Object>) m.get(member));
            if (value == null) {
                inner.remove(child);
            } else {
                inner.put(child, value);
            }
            m.put(member, inner);
        }
        return Statement.fromMap(m).validate().toString();
    }

    static void testValidateNamesEverythingThatIsNotAsTheSpecificationDescribes() {
        Check.equal("[]", Sample.statement(Sample.tree()).validate().toString(), "a built statement is valid");
        Check.isTrue(invalid("schema", null, "stonehash.por-snapshot.v2").contains("schema must be"), "schema");
        Check.isTrue(invalid("exchange", "institution_id", "").contains("institution_id is required"), "institution id");
        Check.isTrue(invalid("exchange", "name", null).contains("exchange.name"), "name");
        for (String asof : new String[] { "2026-11-16", "2026-11-16T00:00:00", "Nov 16 2026", "yesterday", "2026-13-01T00:00:00Z" }) {
            Check.isTrue(invalid("asof", null, asof).contains("asof must be"), "asof " + asof);
        }
        for (String asof : new String[] { "2026-11-16T00:00:00Z", "2026-11-16T09:00:00+09:00", "2026-11-16T00:00Z", "2026-11-16T00:00:00.123456Z" }) {
            Check.equal("[]", invalid("asof", null, asof), "asof " + asof);
        }
        Check.isTrue(invalid("assets", null, new ArrayList<>()).contains("assets must be a non-empty array"), "assets");
        Check.isTrue(invalid("tree", "algo", "sha1").contains("tree.algo"), "algo");
        Check.isTrue(invalid("tree", "root", "XYZ").contains("tree.root"), "root");
        Check.isTrue(invalid("tree", "leaf_count", 0L).contains("tree.leaf_count"), "leaf count 0");
        Check.isTrue(invalid("tree", "leaf_count", 2147483648L).contains("tree.leaf_count"), "leaf count beyond 2^31 - 1");
        Check.isTrue(invalid("tree", "leaf_count", "12").contains("tree.leaf_count"), "leaf count as text");
        Check.isTrue(invalid("tree", "padding", null).contains("tree.padding"), "padding");
        Check.isTrue(invalid("totals", "BTC", 5L).contains("totals.BTC"), "a total as a JSON number");
        Check.isTrue(invalid("totals", "BTC", "05").contains("totals.BTC"), "a total with a leading zero");
        Check.isTrue(invalid("totals", "BTC", null).contains("exactly one entry for each asset"), "a missing total");
        Check.isTrue(invalid("totals", "DOGE", "1").contains("exactly one entry for each asset"), "a total for an unlisted asset");
        Check.isTrue(invalid("params", "salt", "random").contains("params"), "params");
        Check.isTrue(invalid("generated_at", null, "2026-11-16T01:02:03Z").contains("generated_at"), "generated_at without milliseconds");
        Check.isTrue(invalid("reserves", null, "none").contains("reserves must be an object"), "reserves");
        Check.refuses("invalid_statement", () -> Statement.parse("[]"));
        Check.refuses("invalid_statement", () -> Statement.parse("{\"schema\": 1,}"));
        Check.refuses("invalid_statement", () -> Statement.fromMap(new LinkedHashMap<String, Object>()).requireValid());
    }

    static void testTheBuilderRefusesWhatWouldNotBeAStatement() {
        PorTree tree = Sample.tree();
        Check.refuses("invalid_statement", () -> Statement.builder().exchange(Sample.EXCHANGE, "x").asof("2026-11-16T00:00:00Z").build());
        Check.refuses("invalid_statement", () -> Statement.builder().exchange(Sample.EXCHANGE, "x").asof("2026-11-16")
                .assets(Sample.assets()).tree(tree).build());
        // Decimal places are a claim about the tree's integers; another list of assets would be another claim.
        Check.refuses("invalid_statement", () -> Statement.builder().exchange(Sample.EXCHANGE, "x").asof("2026-11-16T00:00:00Z")
                .assets(AssetSpec.parseList("ETH:18,BTC:8,USDT:6")).tree(tree).build());
        Check.refuses("invalid_statement", () -> Statement.builder().exchange("", "x").asof("2026-11-16T00:00:00Z")
                .assets(Sample.assets()).tree(tree).build());
        Check.refuses("invalid_reserve", () -> new ReserveEntry("eip155:1", "USDT", ""));
        Statement now = Statement.builder().exchange(Sample.EXCHANGE, "x").asof("2026-11-16T00:00:00Z").assets(Sample.assets()).tree(tree).build();
        Check.isTrue(now.generatedAt().matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"), "the system clock, in milliseconds: " + now.generatedAt());
        Check.isTrue(!now.toMap().containsKey("reserves"), "no reserves unless declared");
    }

    static void testSigningAndVerifying() throws Exception {
        Statement statement = Sample.statement(Sample.tree());
        KeySigner signer = Sample.signer();
        Check.equal(Sample.spki(), signer.publicKeySpkiBase64(), "the public half, derived from the private key alone");
        SignatureEnvelope sig = SignatureEnvelope.sign(statement, signer);
        Check.equal("ES256", sig.alg(), "alg");
        Check.equal(Sample.EXCHANGE, sig.keyId(), "key_id is the institution id");
        Check.equal("Sample Exchange", sig.issuer(), "issuer is the exchange's name");
        Check.equal(86, sig.sig().length(), "64 bytes in base64url without padding");
        Check.isTrue(sig.verifies(statement, Sample.spki()), "verifies under its key");
        Check.isTrue(!SignatureEnvelope.sign(statement, signer).sig().equals(sig.sig()), "ECDSA uses a fresh nonce each time");

        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        String otherKey = Base64.getEncoder().encodeToString(generator.generateKeyPair().getPublic().getEncoded());
        Check.isTrue(!sig.verifies(statement, otherKey), "not under another key");
        Check.isTrue(!sig.verifies(statement, "not base64 at all"), "nor under something that is not a key");
        Check.isTrue(!sig.verifies(statement, ""), "nor under nothing");
        generator.initialize(new ECGenParameterSpec("secp384r1"));
        Check.isTrue(!sig.verifies(statement, Base64.getEncoder().encodeToString(generator.generateKeyPair().getPublic().getEncoded())),
                "nor under a key on another curve");
        Statement other = Statement.builder().exchange(Sample.EXCHANGE, "Sample Exchange").asof("2026-11-17T00:00:00Z")
                .assets(Sample.assets()).tree(Sample.tree()).clock(Sample.CLOCK).build();
        Check.isTrue(!sig.verifies(other, Sample.spki()), "not over another statement");
        Map<String, Object> tampered = sig.toMap();
        tampered.put("alg", "ES384");
        Check.isTrue(!SignatureEnvelope.fromMap(tampered).verifies(statement, Sample.spki()), "the algorithm is part of the envelope");
        tampered.put("alg", "ES256");
        tampered.put("sig", sig.sig() + "=");
        Check.isTrue(!SignatureEnvelope.fromMap(tampered).verifies(statement, Sample.spki()), "padding is not base64url without padding");
        tampered.put("sig", sig.sig().substring(2));
        Check.isTrue(!SignatureEnvelope.fromMap(tampered).verifies(statement, Sample.spki()), "63 bytes are not a signature");
        tampered.remove("issuer");
        Check.refuses("invalid_signature", () -> SignatureEnvelope.fromMap(tampered));
    }

    static void testASignerOverAnHsmOrKmsIsBytesInSixtyFourBytesOut() throws Exception {
        Statement statement = Sample.statement(Sample.tree());
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair held = generator.generateKeyPair();
        String spki = Base64.getEncoder().encodeToString(held.getPublic().getEncoded());
        // Stands in for a service that signs with a key this process never sees and answers in DER, as most do.
        Signer service = message -> {
            try {
                Signature s = Signature.getInstance("SHA256withECDSA");
                s.initSign(held.getPrivate());
                s.update(message);
                return Signers.derToRaw(s.sign());
            } catch (java.security.GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        };
        for (int i = 0; i < 50; i++) {
            Check.isTrue(Submission.sign(statement, service).verifies(spki), "every DER signature converts to one that verifies");
        }
        Signer derWithoutConversion = message -> new byte[70];
        PorException e = Check.refuses("invalid_signature_format", () -> SignatureEnvelope.sign(statement, derWithoutConversion));
        Check.isTrue(e.getMessage().contains("derToRaw"), "the message points at the conversion: " + e.getMessage());
        Check.refuses("invalid_signature_format", () -> SignatureEnvelope.sign(statement, message -> null));
        for (byte[] notDer : new byte[][] { {}, new byte[64], { 0x30, 0x06, 0x02, 0x01, (byte) 0x80, 0x02, 0x01, 0x01 },
                { 0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00 }, { 0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01 } }) {
            Check.refuses("invalid_signature_format", () -> Signers.derToRaw(notDer));
        }
        byte[] small = Signers.derToRaw(new byte[] { 0x30, 0x06, 0x02, 0x01, 0x05, 0x02, 0x01, 0x07 });
        Check.equal(5, (int) small[31], "a short r is right-aligned");
        Check.equal(7, (int) small[63], "and so is a short s");
    }

    static void testKeysThatAreNotTheRightKindAreRefusedWithoutBeingQuoted() throws Exception {
        String secretLooking = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg";
        PorException notPem = Check.refuses("invalid_key", () -> Signers.fromPkcs8Pem("not a key " + secretLooking));
        Check.isTrue(!notPem.getMessage().contains(secretLooking), "the message never quotes what it was given");
        Check.isTrue(Check.refuses("invalid_key", () -> Signers.fromPkcs8Pem("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----"))
                .getMessage().contains("pkcs8"), "a SEC1 key gets the command that converts it");
        Check.refuses("invalid_key", () -> Signers.fromPkcs8Pem("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"));
        Check.refuses("invalid_key", () -> Signers.fromPkcs8Pem("-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----"));
        for (String algorithm : new String[] { "RSA", "EC" }) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(algorithm);
            if (algorithm.equals("EC")) {
                generator.initialize(new ECGenParameterSpec("secp384r1"));
            } else {
                generator.initialize(2048);
            }
            String pem = "-----BEGIN PRIVATE KEY-----\n" + Base64.getMimeEncoder().encodeToString(generator.generateKeyPair().getPrivate().getEncoded())
                    + "\n-----END PRIVATE KEY-----\n";
            Check.isTrue(Check.refuses("invalid_key", () -> Signers.fromPkcs8Pem(pem)).getMessage().contains("P-256"), algorithm + " is not P-256");
        }
        // A key written by Java itself carries no public half; it is derived all the same.
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair pair = generator.generateKeyPair();
        KeySigner fromJava = Signers.fromPkcs8Pem("-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder().encodeToString(pair.getPrivate().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
        Check.equal(Base64.getEncoder().encodeToString(pair.getPublic().getEncoded()), fromJava.publicKeySpkiBase64(), "the derived public key");
    }

    static void testTheSubmissionIsTheStatementAndItsSignatureAndNothingElse() throws Exception {
        Statement statement = Sample.statement(Sample.tree());
        Submission submission = Submission.sign(statement, Sample.signer());
        Check.equal("[schema, statement, sig]", submission.toMap().keySet().toString(), "members");
        Check.equal("[]", submission.validate().toString(), "usable");
        Submission read = Submission.parse(submission.toJson());
        Check.equal(statement, read.statement(), "the statement survives the file");
        Check.isTrue(read.verifies(Sample.spki()), "and so does the signature");
        Check.isTrue(!submission.toJson().contains("U-1000"), "no account is in it");

        Map<String, Object> edited = new LinkedHashMap<>(statement.toMap());
        Map<String, Object> totals = new LinkedHashMap<>(statement.totals().size());
        statement.totals().forEach((k, v) -> totals.put(k, "1"));
        edited.put("totals", totals);
        Check.isTrue(!Submission.of(Statement.fromMap(edited), submission.signature()).verifies(Sample.spki()), "an edited statement no longer carries a valid signature");

        Check.refuses("invalid_statement", () -> Submission.sign(Statement.fromMap(new LinkedHashMap<String, Object>()), Sample.signer()));
        Check.refuses("invalid_submission", () -> Submission.parse("{\"schema\":\"x\"}"));
        Check.refuses("invalid_submission", () -> Submission.parse("nonsense"));
        Check.isTrue(Submission.parse(submission.toJson().replace("stonehash.por-submission.v1", "v0")).validate().toString().contains("schema must be"), "schema");
        Check.isTrue(Submission.parse(submission.toJson().replace("\"ES256\"", "\"none\"")).validate().toString().contains("sig must be"), "alg");
    }
}
