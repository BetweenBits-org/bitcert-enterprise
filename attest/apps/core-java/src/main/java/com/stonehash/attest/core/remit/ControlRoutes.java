package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.http.Router;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The two requests with which a bank steers a settlement that is under way.
 *
 * <pre>
 *   POST /v1/settlements/:id/cancel            cancel, while the receiving institution has not pre-approved the payout
 *   POST /v1/settlements/:id/rfi-response      answer the receiving institution's request for information
 * </pre>
 *
 * <p>They stand in the route table where they have always stood: after the
 * evidence route and before the manifests, cancel first. Each is admitted as
 * every keyed route of the rail is — the caller, then its settlement
 * subscription and its bank — and only then is the body read: a caller that
 * is not admitted is told so whatever it sent.
 */
@Component
public class ControlRoutes implements RemitRouteSet {
    private final Auth auth;
    private final ProductRegistry registry;
    private final Cancellation cancellation;
    private final RfiResponse rfiResponse;

    public ControlRoutes(Auth auth, ProductRegistry registry, Cancellation cancellation, RfiResponse rfiResponse) {
        this.auth = auth;
        this.registry = registry;
        this.cancellation = cancellation;
        this.rfiResponse = rfiResponse;
    }

    @Override
    public Mark mark() {
        return Mark.AFTER_EVIDENCE;
    }

    @Override
    public void register(Router r) {
        r.post("/v1/settlements/:id/cancel", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> bank = registry.requireRemit(orgId);
            Object body = ctx.body();
            return cancellation.cancel(orgId, bank, ctx.params.get("id"), body);
        });
        r.post("/v1/settlements/:id/rfi-response", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> bank = registry.requireRemit(orgId);
            Object body = ctx.body();
            return rfiResponse.respond(orgId, bank, ctx.params.get("id"), body);
        });
    }
}
