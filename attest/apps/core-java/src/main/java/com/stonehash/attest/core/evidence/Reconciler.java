package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.remit.RemitException;
import com.stonehash.attest.remit.Rules;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Signatures checked, then the rules run: the two steps every verdict of this
 * service takes, in that order, against one keyring.
 *
 * <p>Neither step is written here. Both are the SDK's
 * ({@link com.stonehash.attest.remit.Rules}), which answers as the engine
 * this service was ported from answers — the same findings, in the same
 * order, in the same words. What this class adds is the keyring, and the
 * line between the two ways a verdict can fail to come about:
 * <ul>
 * <li>{@link Refused} — the rules say why, in a sentence that was always
 *     theirs: a policy the engine cannot evaluate ({@code policy: …}), an
 *     amount that is not a decimal string;
 * <li>{@link Unreadable} — the evidence or the policy is not shaped as a
 *     document at all (no {@code elements}, a number where the evidence
 *     belongs). The previous service failed inside its runtime there and
 *     answered with the runtime's words about its own source; the sentence
 *     here is the SDK's.
 * </ul>
 * Each route decides what a client is told in either case.
 *
 * <p>The keyring of this deployment is the demonstration issuers': it
 * reconciles synthetic evidence, and a signature from one of those keys
 * reads {@code DEMO_VALID} with the issuer axis still at
 * {@code UNKNOWN_ISSUER}. Their private halves are published, so such a
 * signature proves nothing about who signed — which is the point of them.
 */
public final class Reconciler {

    /** The rules refuse, in their own sentence. */
    public static final class Refused extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Refused(String sentence) {
            super(sentence);
        }
    }

    /** Not a document the rules can read at all. */
    public static final class Unreadable extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Unreadable(String sentence) {
            super(sentence);
        }
    }

    private final List<Object> entries;
    private final Rules.Keyring keyring;

    /** @param entries the keys, each {@code keyId, issuer, trustLevel, publicKeyJwk} */
    public Reconciler(List<Object> entries) {
        this.entries = Collections.unmodifiableList(entries);
        this.keyring = Rules.keyring(entries);
    }

    private static final class Demo {
        static final Reconciler INSTANCE = new Reconciler(demoKeys());
    }

    /** The reconciler of this deployment: the demonstration issuers' keys. */
    public static Reconciler demo() {
        return Demo.INSTANCE;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> demoKeys() {
        try (InputStream in = Reconciler.class.getResourceAsStream("/evidence/demo-issuer-keys.json")) {
            if (in == null) {
                throw new IllegalStateException("evidence/demo-issuer-keys.json is not on the classpath");
            }
            Map<String, Object> file = (Map<String, Object>) Js.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            return (List<Object>) file.get("keys");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** The keys signatures are checked against, as they were given: public halves, with the trust each carries. */
    public List<Object> keys() {
        return entries;
    }

    /**
     * The evidence with every signature's status computed here rather than
     * believed: a copy, the original is not changed.
     */
    public Map<String, Object> checkSignatures(Object evidence) {
        try {
            return plain(Rules.checkSignatures(evidence, keyring));
        } catch (RemitException e) {
            throw failure(e);
        }
    }

    /** The verdict of the rules on evidence whose signatures were checked. */
    public Map<String, Object> evaluate(Object checkedEvidence, Object policy) {
        try {
            return plain(Rules.evaluate(checkedEvidence, policy));
        } catch (RemitException e) {
            throw failure(e);
        }
    }

    /** Returns normally when the rules can run under this policy. */
    public void validatePolicy(Object policy) {
        try {
            Rules.validatePolicy(policy);
        } catch (RemitException e) {
            throw failure(e);
        }
    }

    /** The text a policy's digest is taken over: members sorted at every level, no white space. */
    public static String canonicalPolicy(Object policy) {
        return Rules.canonicalPolicy(policy);
    }

    private static RuntimeException failure(RemitException e) {
        String code = e.code();
        return "invalid_policy".equals(code) || "invalid_amount".equals(code) ? new Refused(e.getMessage()) : new Unreadable(e.getMessage());
    }

    /** The same value with every number held one way, as this service's JSON holds numbers. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> plain(Map<String, Object> value) {
        return (Map<String, Object>) plainValue(value);
    }

    private static Object plainValue(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                out.put((String) e.getKey(), plainValue(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>(((List<?>) v).size());
            for (Object item : (List<?>) v) {
                out.add(plainValue(item));
            }
            return out;
        }
        return v instanceof Number && !(v instanceof Double) ? Double.valueOf(((Number) v).doubleValue()) : v;
    }
}
