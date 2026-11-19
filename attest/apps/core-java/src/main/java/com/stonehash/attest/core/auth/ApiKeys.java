package com.stonehash.attest.core.auth;

import com.stonehash.attest.core.format.Hex;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * API keys.
 *
 * <p>A key is shown once, at creation, and only its SHA-256 is stored — so a
 * copy of the database cannot be replayed as a client. Lookup is by hash.
 *
 * <p>The prefix is deliberately visible and deliberately different per
 * environment: {@code sk_test_} on the sandbox, {@code sk_live_} in
 * production. Mixing the two is the most common production accident with
 * keyed APIs, and a key that can be told at a glance in a log or a config
 * file prevents most of it.
 */
public final class ApiKeys {
    private ApiKeys() {
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    public static String hash(String secret) {
        return Hex.encode(Hex.sha256(secret.getBytes(StandardCharsets.UTF_8)));
    }

    /** A new secret: the prefix and 24 random bytes as base64url. Returned once and never recoverable afterwards. */
    public static String mint(String prefix) {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return prefix + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
