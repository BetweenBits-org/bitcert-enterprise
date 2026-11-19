package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.json.JsValues;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * A partner's signature must verify, and the key must belong to a registered
 * institution holding the role that may assert this fact — the one check
 * every signed word from a partner goes through: the answers to the rail's
 * own calls, and the callbacks.
 */
@Component
public class PartnerSignatures {
    private final ProductRegistry registry;

    public PartnerSignatures(ProductRegistry registry) {
        this.registry = registry;
    }

    /**
     * @param payload what was signed
     * @param sig the signature as it came ({@code { alg, key_id, value, … }})
     * @param role the role that may assert this ({@code BFI}, {@code SETTLEMENT_ENTITY}, …)
     * @return the institution that signed
     * @throws ServiceError 400 {@code unknown_signer}, {@code role_mismatch} or {@code invalid_signature}, with the
     *         sentences of the service this one replaces
     */
    public Map<String, Object> verify(Object payload, Object sig, String role) {
        Object keyId = sig instanceof Map ? ((Map<?, ?>) sig).get("key_id") : null;
        // An id is text. Anything else names no key, and is never handed to the store.
        Map<String, Object> inst = keyId instanceof String ? registry.institution((String) keyId) : null;
        Object spki = inst == null ? null : inst.get("signing_spki");
        if (inst == null || !(spki instanceof String) || ((String) spki).isEmpty()) {
            String named = sig instanceof Map && ((Map<?, ?>) sig).containsKey("key_id") ? JsValues.string(keyId) : "undefined";
            throw new ServiceError(400, "unknown_signer", "signature names unregistered key " + named);
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
