package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.json.JsValues;
import java.util.Map;
import java.util.function.Function;
import org.springframework.stereotype.Component;

/**
 * A partner's signature must verify, and the key must belong to a registered
 * institution holding the role that may assert this fact — the one check
 * every signed word from a partner goes through: the answers to the rail's
 * own calls, and the callbacks.
 *
 * <p>Three refusals, in this order, each a 400 with the sentence the service
 * this one replaces gave it:
 * <ol>
 * <li>{@code unknown_signer} — {@code signature names unregistered key <key id>}:
 *     the signature names no institution of the registry, or one that has no
 *     signing key;
 * <li>{@code role_mismatch} — {@code <id> holds role <its role>, which may not assert <role> facts};
 * <li>{@code invalid_signature} — {@code signature by <id> does not verify}:
 *     not {@code ES256}, no signature text, a key that cannot be read, a
 *     payload that has no canonical form, or simply not that key's signature
 *     over that payload.
 * </ol>
 *
 * <p><b>An id is text.</b> The registry is asked only for a key id that is
 * text. Anything else a signature carries where its key id belongs — a
 * number, {@code true}, a list, an object, {@code null} — names no key: it
 * is refused as an unknown signer, in the same sentence, with the value
 * written as it reads inside a sentence ({@code 12345}, {@code true},
 * {@code a,b}, {@code [object Object]}, {@code null}), and is never handed
 * to the store. A signature without a key id, and one that is not an object
 * at all (text, a number, a list), reads {@code undefined} there.
 *
 * <p>A signature that is nothing at all ({@code null}, absent) is not this
 * check's to judge: the callback route refuses it first ({@code payload and
 * sig are required}), and so should any other caller. The service this one
 * replaces failed inside its runtime when handed one; here it is the first
 * refusal, with {@code undefined} for the key.
 */
@Component
public class PartnerSignatures {
    private final ProductRegistry registry;

    public PartnerSignatures(ProductRegistry registry) {
        this.registry = registry;
    }

    /**
     * @param payload what was signed
     * @param sig the signature as it came ({@code { alg, key_id, issuer, sig }}), whatever JSON it is
     * @param role the role that may assert this ({@code BENEFICIARY_FI}, {@code SETTLEMENT_ENTITY}, …)
     * @return the institution that signed, as the registry holds it
     * @throws ServiceError 400 {@code unknown_signer}, {@code role_mismatch} or {@code invalid_signature}, with the
     *         sentences of the service this one replaces
     */
    public Map<String, Object> verify(Object payload, Object sig, String role) {
        return verify(payload, sig, role, registry::institution);
    }

    /**
     * {@link #verify(Object, Object, String)} against any registry.
     *
     * @param institution an institution's row by its id ({@code id, role, signing_spki} are read), or {@code null} for an
     *        id nobody has; asked at most once, and only with text
     */
    public static Map<String, Object> verify(Object payload, Object sig, String role, Function<String, Map<String, Object>> institution) {
        boolean named = sig instanceof Map && ((Map<?, ?>) sig).containsKey("key_id");
        Object keyId = named ? ((Map<?, ?>) sig).get("key_id") : null;
        // An id is text. Anything else names no key, and is never handed to the store.
        Map<String, Object> inst = keyId instanceof String ? institution.apply((String) keyId) : null;
        Object spki = inst == null ? null : inst.get("signing_spki");
        if (inst == null || !(spki instanceof String) || ((String) spki).isEmpty()) {
            throw new ServiceError(400, "unknown_signer", "signature names unregistered key " + (named ? JsValues.string(keyId) : "undefined"));
        }
        if (!role.equals(inst.get("role"))) {
            throw new ServiceError(400, "role_mismatch", inst.get("id") + " holds role " + inst.get("role") + ", which may not assert " + role + " facts");
        }
        if (!Signatures.verifyEvent(payload, sig, (String) spki)) {
            throw new ServiceError(400, "invalid_signature", "signature by " + inst.get("id") + " does not verify");
        }
        return inst;
    }
}
