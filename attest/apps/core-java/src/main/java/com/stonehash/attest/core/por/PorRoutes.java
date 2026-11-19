package com.stonehash.attest.core.por;

import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.Router;
import java.io.IOException;
import java.io.UncheckedIOException;
import org.springframework.stereotype.Component;

/**
 * Proof of reserves over HTTP — see {@link PorSnapshots}.
 *
 * <pre>
 *   POST /v1/por/snapshots                 submit a signed statement: anchored at once, or challenged
 *   POST /v1/por/snapshots/:id/openings    answer a challenge (spot check only)
 *   GET  /v1/por/snapshots                 the organisation's snapshots
 *   GET  /v1/por/snapshots/:id             one of them
 *   GET  /v1/public/por/snapshots/:id      what anyone needs to check a proof against it — no key
 * </pre>
 *
 * <p>The four keyed routes are admitted like every keyed API; the two that
 * write also need an active subscription and a registered exchange. The
 * public one is public by design.
 */
@Component
public class PorRoutes {
    private final Auth auth;
    private final PorSnapshots snapshots;

    public PorRoutes(Auth auth, PorSnapshots snapshots) {
        this.auth = auth;
        this.snapshots = snapshots;
    }

    public void register(Router r) {
        r.post("/v1/por/snapshots", (ctx) -> snapshots.submit(auth.requireAuth(ctx), () -> body(ctx)));
        r.post("/v1/por/snapshots/:id/openings", (ctx) -> snapshots.openings(auth.requireAuth(ctx), ctx.params.get("id"), () -> body(ctx)));
        r.get("/v1/por/snapshots", (ctx) -> snapshots.list(auth.requireAuth(ctx)));
        r.get("/v1/por/snapshots/:id", (ctx) -> snapshots.get(auth.requireAuth(ctx), ctx.params.get("id")));
        r.get("/v1/public/por/snapshots/:id", (ctx) -> snapshots.published(ctx.params.get("id")));
    }

    /** The body, read when the handler gets to it: a request refused before that is refused whatever it carried. */
    private static Object body(Ctx ctx) {
        try {
            return ctx.body();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
