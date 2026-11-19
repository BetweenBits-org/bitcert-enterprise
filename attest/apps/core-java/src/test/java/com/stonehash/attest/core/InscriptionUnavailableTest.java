package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.stonehash.attest.core.anchor.Inscriber;
import com.stonehash.attest.core.attest.AttestService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

/**
 * A deployment that was given nothing to inscribe with. The running service
 * always has an inscriber; the absence is a capability that is missing, said
 * as such — before the document is looked at, and before the store is.
 */
class InscriptionUnavailableTest {
    @Test
    void withoutAnInscriberTheServiceSaysItCannotInscribe() {
        // No store and no configuration either: the refusal comes before anything is asked of them.
        AttestService svc = new AttestService(null, null, new StaticListableBeanFactory().getBeanProvider(Inscriber.class));
        assertFalse(svc.canInscribe(), "what /v1/meta reports as inscription.enabled");
        ServiceError refused = assertThrows(ServiceError.class, () -> svc.inscribe("an-organisation", new byte[] { 1 }, "text/plain", null, null));
        assertEquals(501, refused.status());
        assertEquals("inscription_unavailable", refused.code());
        assertEquals("this deployment has no inscription backend; only digest anchoring is available", refused.getMessage());
    }
}
