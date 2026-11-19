package com.stonehash.attest.por;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * From a ledger row to a tree leaf: the derived values, in one place
 * (specification §4).
 *
 * <ul>
 * <li><b>user_ref_hash</b> — SHA-256 over a fixed tag, the exchange id and the
 *     account reference. Deterministic, so a customer who knows their own
 *     reference can recompute it and recognise their leaf; pseudonymous, so a
 *     leaf never carries the reference itself.
 * <li><b>salt</b> — HMAC-SHA-256 of the reference under the snapshot's seed.
 *     It blinds the balances inside the leaf hash; because it is derived
 *     rather than random, the exchange keeps one 32-byte seed per snapshot,
 *     not one secret per account.
 * </ul>
 */
public final class Leaves {
    static final byte[] USER_DOMAIN = "STONEHASH-POR-USER-V1\n".getBytes(StandardCharsets.US_ASCII);
    static final byte[] LEAF_DOMAIN = "STONEHASH-POR-LEAF-V1\n".getBytes(StandardCharsets.US_ASCII);
    static final byte[] NODE_DOMAIN = "STONEHASH-POR-NODE-V1\n".getBytes(StandardCharsets.US_ASCII);
    static final byte[] EMPTY_DOMAIN = "STONEHASH-POR-EMPTY-V1".getBytes(StandardCharsets.US_ASCII);

    /** Bytes in a snapshot's seed, and in every hash and salt. */
    public static final int SEED_BYTES = 32;

    private Leaves() {
    }

    /** A fresh seed for one snapshot, from the platform's secure random source. */
    public static byte[] newSeed() {
        byte[] seed = new byte[SEED_BYTES];
        new SecureRandom().nextBytes(seed);
        return seed;
    }

    /** The pseudonymous form of an account reference: 64 lowercase hex characters. */
    public static String userRefHash(String exchangeId, String userRef) {
        MessageDigest sha = Hex.sha256();
        sha.update(userDomain(exchangeId));
        return Hex.encode(sha.digest(Text.utf8(Objects.requireNonNull(userRef, "userRef"))));
    }

    /** The per-account salt: 64 lowercase hex characters. {@code seed} is the snapshot's 32-byte seed. */
    public static String salt(byte[] seed, String userRef) {
        return Hex.encode(saltMac(seed).doFinal(Text.utf8(Objects.requireNonNull(userRef, "userRef"))));
    }

    /**
     * The hash of a leaf. {@code balances} must already be normalised — one
     * entry for every asset of the snapshot — because the hash is taken over
     * exactly the entries given.
     */
    public static String leafHash(String salt, String userRefHash, Map<String, BigInteger> balances) {
        byte[] raw = new byte[2 * SEED_BYTES];
        if (!Hex.isHash(salt) || !Hex.decodeInto(salt, raw, 0, SEED_BYTES)) {
            throw new PorException("invalid_leaf", "salt must be 64 lowercase hex characters");
        }
        if (!Hex.isHash(userRefHash) || !Hex.decodeInto(userRefHash, raw, SEED_BYTES, SEED_BYTES)) {
            throw new PorException("invalid_leaf", "user_ref_hash must be 64 lowercase hex characters");
        }
        MessageDigest sha = Hex.sha256();
        sha.update(LEAF_DOMAIN);
        sha.update(raw);
        return Hex.encode(sha.digest(canonicalSums(balances)));
    }

    /** The text that precedes the account reference in the hashed bytes. */
    static byte[] userDomain(String exchangeId) {
        requireExchangeId(exchangeId);
        byte[] id = Text.utf8(exchangeId);
        byte[] out = new byte[USER_DOMAIN.length + id.length + 1];
        System.arraycopy(USER_DOMAIN, 0, out, 0, USER_DOMAIN.length);
        System.arraycopy(id, 0, out, USER_DOMAIN.length, id.length);
        out[out.length - 1] = '\n';
        return out;
    }

    /**
     * The exchange id is followed by a line break in the hashed text, so an id
     * holding one would make two different (exchange, account) pairs hash
     * alike.
     */
    static void requireExchangeId(String exchangeId) {
        if (exchangeId == null || exchangeId.isEmpty()) {
            throw new PorException("invalid_exchange", "the exchange (institution) id is empty");
        }
        for (int i = 0; i < exchangeId.length(); i++) {
            char c = exchangeId.charAt(i);
            if (c < 0x20 || c == 0x7f) {
                throw new PorException("invalid_exchange", "the exchange (institution) id contains a control character");
            }
        }
    }

    static Mac saltMac(byte[] seed) {
        if (seed == null || seed.length != SEED_BYTES) {
            throw new PorException("invalid_seed", "the seed must be " + SEED_BYTES + " bytes");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(seed, "HmacSHA256"));
            return mac;
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            // Every Java runtime is required to provide HmacSHA256, and any 32 bytes are a valid key for it.
            throw new IllegalStateException("this Java runtime has no HMAC-SHA-256", e);
        }
    }

    /** Canonical JSON of a sum vector held as a map: keys sorted, amounts as decimal strings. */
    static byte[] canonicalSums(Map<String, BigInteger> sums) {
        Map<String, Object> text = new TreeMap<>();
        for (Map.Entry<String, BigInteger> e : sums.entrySet()) {
            if (e.getValue() == null || e.getValue().signum() < 0) {
                throw new PorException("invalid_balance", e.getKey() + ": a balance is a non-negative integer");
            }
            text.put(e.getKey(), e.getValue().toString());
        }
        return Json.canonicalBytes(text);
    }

    /** The node that pads a level with an odd number of nodes. */
    static byte[] emptyNodeHash() {
        return Hex.sha256().digest(EMPTY_DOMAIN);
    }
}
