package com.stonehash.attest.por;

import java.nio.file.Files;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

/** The sample ledger of the vectors, and the things built from it that several tests need. */
final class Sample {
    static final String EXCHANGE = "KR-EX-0a1b2c";
    static final String SEED_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    /** The root every SDK must reach for {@code intake/long.csv} with the seed above. */
    static final String ROOT = "0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa";
    static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-16T01:02:03.456Z"), ZoneOffset.UTC);

    private Sample() {
    }

    static List<AssetSpec> assets() {
        return AssetSpec.parseList("BTC:8,ETH:18,USDT:6");
    }

    static byte[] seed() {
        byte[] seed = new byte[32];
        Hex.decodeInto(SEED_HEX, seed, 0, 32);
        return seed;
    }

    static Ledger ledger() {
        return CsvLedger.read(TestMain.vectors().resolve("intake/long.csv"), new CsvOptions(assets(), AmountUnit.DECIMAL));
    }

    static PorTree tree() {
        return PorTree.build(EXCHANGE, seed(), ledger());
    }

    static Statement statement(PorTree tree) {
        return Statement.builder().exchange(EXCHANGE, "Sample Exchange").asof("2026-11-16T00:00:00Z")
                .assets(assets()).tree(tree).clock(CLOCK).build();
    }

    /** The published test key of the vectors: registered nowhere, and never to be. */
    static KeySigner signer() throws Exception {
        return Signers.fromPkcs8Pem((String) testKey().get("private_pkcs8_pem"));
    }

    static String spki() throws Exception {
        return (String) testKey().get("public_spki_base64");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> vector(String name) throws Exception {
        return (Map<String, Object>) Json.parse(Files.readAllBytes(TestMain.vectors().resolve(name)), "test", name);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> testKey() throws Exception {
        return (Map<String, Object>) vector("statement.json").get("test_key");
    }
}
