package com.stonehash.attest.remit;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The six-axis rules as the platform's own back end runs them: the reference
 * engine's answer, whole and to the letter.
 *
 * <p><b>A bank integration does not need this class.</b> A bank re-checks an
 * evidence package with {@link EvidenceVerifier}, which declines to interpret
 * evidence of an unexpected shape rather than guess. This class is for the
 * side that <em>produces</em> verdicts — they are written into evidence
 * packages and committed to — so it has to answer exactly as the reference
 * answers, for every input the reference answers:
 *
 * <pre>{@code
 * Rules.Keyring keys = Rules.keyring(entries);                      // key id, issuer, trust level, public key
 * Map<String, Object> checked = Rules.checkSignatures(evidence, keys);
 * Map<String, Object> verdict = Rules.evaluate(checked, policy);    // the reference's MatchingResult
 * }</pre>
 *
 * <p>Values are JSON values, as {@link Json#parse} returns them: {@code Map},
 * {@code List}, {@code String}, {@code Long} or {@code BigDecimal},
 * {@code Boolean}, {@code null}. A value the caller did not expect — a number
 * where a name belongs, a list where one text was meant — is read the way the
 * reference's JavaScript reads it, because that is what the reference's
 * findings say about it.
 *
 * <p>A number is its value. The reference holds nothing else of a number, so
 * 1, 1.0 and 1e0 are one number to it; here that number may arrive as a
 * {@code Long}, as a {@code BigDecimal} that remembers how it was written or
 * as a {@code Double} — whatever the caller's JSON reader makes of it — and
 * the answer is the same: the same findings, the same digest of a policy,
 * and the same signature verified over an element that holds it.
 *
 * <p><b>Where this class and the reference part ways</b> — each of them on
 * purpose, and each held by a vector in {@code golden/rules.json}:
 * <ul>
 * <li><b>Where the reference fails inside the JavaScript engine</b> (it reads
 *     a member of {@code null}, walks something that is not a list, or has to
 *     make text or a number of an object that has a member of its own named
 *     {@code toString} — alone, or inside a list) it throws
 *     an engine error whose words describe its own source code. Here that is
 *     {@link RemitException} {@code unreadable_evidence} or
 *     {@code unreadable_policy}, in a sentence of this SDK's. Where the
 *     reference refuses in its own words — a policy it cannot evaluate
 *     ({@code invalid_policy}), an amount that is not a decimal string
 *     ({@code invalid_amount}) — the message is the reference's, to the
 *     letter.
 * <li><b>Times.</b> A timestamp written the ISO 8601 way, or close to it,
 *     is read exactly as the reference's engine reads it: a date
 *     ({@code YYYY}, {@code YYYY-MM}, {@code YYYY-MM-DD}; the year may also
 *     be six digits with a sign), optionally a time ({@code THH:mm},
 *     {@code THH:mm:ss}, {@code THH:mm:ss.f…}; the {@code T} may be a
 *     {@code t} or one space) and optionally a zone ({@code Z}, {@code z},
 *     {@code ±HH:mm}, {@code ±HHmm}). A time without a zone is UTC: the
 *     reference reads it as the local time of its machine, and the
 *     platform's machines run in UTC. Any other spelling ("Nov 18, 2026",
 *     "2026/11/18", a count of milliseconds, anything with spaces around
 *     it) is not a parseable instant here, though the reference's engine
 *     reads some of them: where the reference would have measured the
 *     settlement window, the Travel Rule gate or the FX quote against such
 *     a time, this class reports the timestamp as unparseable
 *     ({@code TIMESTAMP_UNPARSEABLE},
 *     {@code TRAVEL_RULE_TIMESTAMP_UNPARSEABLE}) or, for the FX quote,
 *     reports nothing.
 * <li><b>Key ids</b> in a keyring are text. (The reference would also match a
 *     signature that names key {@code 7} against a keyring entry whose id is
 *     the number {@code 7}.)
 * </ul>
 */
public final class Rules {
    private Rules() {
    }

    /**
     * The public keys a signature pass checks against, by key id: for each,
     * who the keyring says holds it and how far it is trusted
     * ({@code DEMO}, {@code ATTESTED} or {@code ACCREDITED}).
     */
    public static final class Keyring {
        final Map<String, VerdictEngine.Key> keys;

        Keyring(Map<String, VerdictEngine.Key> keys) {
            this.keys = Collections.unmodifiableMap(keys);
        }

        /** The key ids, in the order the keys were given. */
        public Set<String> keyIds() {
            return keys.keySet();
        }

        /**
         * Whether the key under this id can verify anything: {@code false}
         * for an id the keyring does not hold, and for a key that is not a
         * usable ECDSA P-256 public key — every signature naming such a key
         * reads {@code INVALID}.
         */
        public boolean usable(String keyId) {
            VerdictEngine.Key key = keys.get(keyId);
            return key != null && key.spkiBase64 != null;
        }
    }

    /**
     * A keyring from its entries, as the reference's {@code keyring()} builds
     * one. Each entry is an object:
     *
     * <pre>
     *   keyId          text; what a signature's keyId has to equal
     *   issuer         who the key stands for — written into every signature checked against it
     *   trustLevel     "DEMO", "ATTESTED" or "ACCREDITED" — likewise
     *   publicKeyJwk   the public key as a JWK (EC, P-256), as the reference's keyring carries it — or
     *   publicKeySpki  the same key as base64 of its SPKI (DER), as a Trust Registry stores it
     * </pre>
     *
     * <p>An entry whose key is not a usable ECDSA P-256 public key stays in
     * the keyring, and no signature verifies against it ({@code INVALID}) —
     * what the reference does with a key it cannot import. A JWK is usable
     * when it is a public EC key on P-256 ({@code kty}, {@code crv}, no
     * {@code d}), is not marked for another use ({@code use} absent or
     * {@code "sig"}; {@code key_ops} absent or a list naming
     * {@code "verify"}, no operation twice; {@code alg} absent or
     * {@code "ES256"}), and its {@code x} and {@code y} are a point of the
     * curve. Leaving a key <em>out</em> of the keyring — so that its
     * signatures read {@code UNKNOWN_KEY} — is the caller's decision.
     *
     * @throws RemitException {@code invalid_keyring}: the same key id twice ({@code duplicate keyId in keyring: …}, the
     *                        reference's sentence), an entry that is not an object, or a key id that is not text
     */
    public static Keyring keyring(List<?> entries) {
        Objects.requireNonNull(entries, "entries");
        Map<String, VerdictEngine.Key> keys = new LinkedHashMap<>();
        for (Object entry : entries) {
            if (!(entry instanceof Map)) {
                throw new RemitException("invalid_keyring", "a keyring entry is not an object");
            }
            Map<?, ?> key = (Map<?, ?>) entry;
            if (!(key.get("keyId") instanceof String)) {
                throw new RemitException("invalid_keyring", "a keyring entry's keyId is not text");
            }
            String keyId = (String) key.get("keyId");
            if (keys.containsKey(keyId)) {
                throw new RemitException("invalid_keyring", "duplicate keyId in keyring: " + keyId);
            }
            keys.put(keyId, new VerdictEngine.Key(key.containsKey("issuer") ? key.get("issuer") : VerdictEngine.UNDEFINED, spkiOf(key),
                    key.containsKey("trustLevel") ? key.get("trustLevel") : VerdictEngine.UNDEFINED));
        }
        return new Keyring(keys);
    }

    private static final List<String> KEY_OPERATIONS = Arrays.asList(
            "sign", "verify", "encrypt", "decrypt", "wrapKey", "unwrapKey", "deriveKey", "deriveBits");

    /** The key of a keyring entry as base64 SPKI, or {@code null} when it is not a usable P-256 verification key. */
    private static String spkiOf(Map<?, ?> entry) {
        try {
            ECPublicKey key;
            if (entry.containsKey("publicKeyJwk")) {
                key = fromJwk(entry.get("publicKeyJwk"));
            } else if (entry.get("publicKeySpki") instanceof String) {
                // Read as the reference's runtime reads base64: a key copied out of a PEM block has line breaks in it.
                key = Signers.publicKeyOf(Base64Url.lenient((String) entry.get("publicKeySpki")));
            } else {
                return null;
            }
            return key != null && EvidenceVerifier.onCurve(key) ? Base64.getEncoder().encodeToString(key.getEncoded()) : null;
        } catch (RuntimeException | GeneralSecurityException e) {
            return null;
        }
    }

    private static ECPublicKey fromJwk(Object value) throws GeneralSecurityException {
        if (!(value instanceof Map)) {
            return null;
        }
        Map<?, ?> jwk = (Map<?, ?>) value;
        if (!"EC".equals(jwk.get("kty")) || !"P-256".equals(jwk.get("crv")) || jwk.containsKey("d")
                || (jwk.containsKey("use") && !"sig".equals(jwk.get("use"))) || (jwk.containsKey("alg") && !"ES256".equals(jwk.get("alg")))
                || !(jwk.get("x") instanceof String) || !(jwk.get("y") instanceof String)) {
            return null;
        }
        if (jwk.containsKey("key_ops")) {
            if (!(jwk.get("key_ops") instanceof List)) {
                return null;
            }
            List<?> operations = (List<?>) jwk.get("key_ops");
            Set<Object> seen = new LinkedHashSet<>();
            for (Object operation : operations) {
                if (KEY_OPERATIONS.contains(operation) && !seen.add(operation)) {
                    return null;
                }
            }
            if (!seen.contains("verify")) {
                return null;
            }
        }
        BigInteger x = new BigInteger(1, Base64Url.lenient((String) jwk.get("x")));
        BigInteger y = new BigInteger(1, Base64Url.lenient((String) jwk.get("y")));
        return (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(new ECPoint(x, y), TravelRule.p256()));
    }

    /**
     * The evidence with every element signature replaced by one whose status
     * was computed here — the reference's {@code verifyEvidenceSignatures}.
     * What the document says of a signature (its status, its issuer, its
     * trust level) carries no weight: after this pass a signature reads
     * {@code ABSENT}, {@code UNKNOWN_KEY}, {@code INVALID}, {@code VALID}
     * or — under a {@code DEMO} key, however sound the arithmetic —
     * {@code DEMO_VALID}, is marked {@code checked}, and carries the issuer
     * and the trust level the keyring gives its key.
     *
     * <p>Returns a copy; what was handed over is not changed. Elements under
     * any other name than the six the engine knows are left as they are.
     *
     * @param evidence the settlement evidence
     * @return the evidence as the reference leaves it
     * @throws RemitException {@code unreadable_evidence} where the reference fails inside its engine: the evidence is
     *                        not an object, or holds no {@code elements}
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> checkSignatures(Object evidence, Keyring keyring) {
        Objects.requireNonNull(keyring, "keyring");
        try {
            return (Map<String, Object>) VerdictEngine.checkSignaturesAsReference(json(evidence, "evidence"), keyring.keys);
        } catch (VerdictEngine.NotEvaluable e) {
            throw refusal(e);
        }
    }

    /**
     * The verdict: the reference's {@code evaluate}, and its whole
     * {@code MatchingResult} — {@code policyVersion}, {@code policyDigest},
     * {@code scenario} and {@code dataMode} where the evidence states them,
     * {@code axes} (each of the six with its {@code state} and its own
     * {@code findings}), every finding in the order the rules ran,
     * {@code manualReviewRequired}, and {@code regulatoryDecision}, which is
     * always {@code NOT_EVALUATED}.
     *
     * <p>A finding is {@code axis}, {@code code}, {@code severity},
     * {@code detail} — the reference's sentence — and whichever of
     * {@code element}, {@code field}, {@code expected}, {@code actual} and
     * {@code tolerance} the rule states, in that order. Written out with
     * numbers as JavaScript writes them, the result is byte for byte the
     * JSON the reference's result is written as.
     *
     * <p>Run {@link #checkSignatures} first: a signature nobody checked is
     * reported as exactly that.
     *
     * @throws RemitException {@code invalid_policy} or {@code invalid_amount} with the reference's own sentence;
     *                        {@code unreadable_evidence} or {@code unreadable_policy} where the reference fails inside its engine
     */
    public static Map<String, Object> evaluate(Object evidence, Object policy) {
        try {
            return VerdictEngine.evaluateAsReference(json(evidence, "evidence"), json(policy, "policy")).toJson();
        } catch (VerdictEngine.NotEvaluable e) {
            throw refusal(e);
        }
    }

    /**
     * Whether the engine can evaluate under this policy — the reference's
     * {@code validatePolicy}. Returns normally when it can.
     *
     * @throws RemitException {@code invalid_policy} with the reference's own sentence ({@code policy: …}), in the order
     *                        the reference checks; {@code unreadable_policy} when there is no policy at all
     */
    public static void validatePolicy(Object policy) {
        try {
            VerdictEngine.validatePolicyAsReference(json(policy, "policy"));
        } catch (VerdictEngine.NotEvaluable e) {
            throw refusal(e);
        }
    }

    /**
     * The policy's canonical text, of which {@link #policyDigest} is the
     * SHA-256: members sorted by name at every level, no white space, numbers
     * as JavaScript writes them. Two policies that differ only in the order
     * of their members are the same policy.
     */
    public static String canonicalPolicy(Object policy) {
        return VerdictEngine.canonicalPolicy(json(policy, "policy"));
    }

    /** What pins exactly which rules ran: SHA-256 of {@link #canonicalPolicy}, 64 lowercase hex characters. */
    public static String policyDigest(Object policy) {
        return VerdictEngine.policyDigest(json(policy, "policy"));
    }

    private static RemitException refusal(VerdictEngine.NotEvaluable e) {
        String code = e.kind.equals("policy") ? "invalid_policy" : e.kind.equals("amount") ? "invalid_amount"
                : e.kind.equals("nopolicy") ? "unreadable_policy" : "unreadable_evidence";
        return new RemitException(code, e.getMessage());
    }

    /** The value, having made sure it is JSON all the way down: anything else is a mistake of the caller's, not evidence. */
    private static Object json(Object value, String what) {
        check(value, what);
        return value;
    }

    private static void check(Object value, String what) {
        if (value instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (!(e.getKey() instanceof String)) {
                    throw new IllegalArgumentException("the " + what + " holds an object whose member name is not text");
                }
                check(e.getValue(), what);
            }
        } else if (value instanceof List) {
            for (Object item : (List<?>) value) {
                check(item, what);
            }
        } else if (value != null && !(value instanceof String) && !(value instanceof Boolean) && !(value instanceof Number)) {
            throw new IllegalArgumentException("the " + what + " holds a " + value.getClass().getName() + ", which is not a JSON value");
        }
    }
}
