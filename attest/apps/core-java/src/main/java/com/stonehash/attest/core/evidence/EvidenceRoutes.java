package com.stonehash.attest.core.evidence;

import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.Router;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * {@code POST /v1/settlements/reconcile} and {@code POST /v1/settlements/bundle}
 * — see {@link SettlementEvidence}.
 *
 * <p>An API key admits a request; in the sandbox the console's session does
 * too, because the console has to reach the very endpoint a customer
 * integrates against: a sandbox whose verdicts came from an evaluator of its
 * own would prove nothing about that one. The credential differs and nothing
 * else does — same route, same body, same code.
 */
@Component
public class EvidenceRoutes {
    private final Auth auth;
    private final SettlementEvidence evidence = new SettlementEvidence(Reconciler.demo());

    public EvidenceRoutes(Auth auth) {
        this.auth = auth;
    }

    public void register(Router r) {
        r.post("/v1/settlements/reconcile", this::reconcile);
        r.post("/v1/settlements/bundle", this::bundle);
    }

    private Object reconcile(Ctx ctx) throws Exception {
        auth.requireAuth(ctx);
        return evidence.reconcile(ctx.body());
    }

    private Object bundle(Ctx ctx) throws Exception {
        auth.requireAuth(ctx);
        return evidence.bundle(ctx.body(), System.currentTimeMillis(), () -> UUID.randomUUID().toString());
    }
}
