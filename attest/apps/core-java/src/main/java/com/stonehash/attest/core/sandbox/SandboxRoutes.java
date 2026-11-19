package com.stonehash.attest.core.sandbox;

import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.evidence.Reconciler;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.Router;
import org.springframework.stereotype.Component;

/**
 * The material of the evaluation sandbox, over HTTP — see {@link Sandbox}.
 *
 * <pre>
 *   GET  /v1/console/sandbox                  the catalogue: scenarios, tampers, the policy
 *   POST /v1/console/sandbox/evidence         a scenario's evidence, or the caller's, with tampers applied
 *   POST /v1/console/sandbox/package          a verdict sealed into a package
 *   POST /v1/console/sandbox/package/verify   a package re-checked
 * </pre>
 *
 * <p>Admitted like the settlement-evidence endpoints the sandbox feeds: by
 * an API key, or in the sandbox by the console's session. These produce
 * documents and packages; the verdict itself always comes from
 * {@code POST /v1/settlements/reconcile}.
 */
@Component
public class SandboxRoutes {
    private final Auth auth;
    private final Sandbox sandbox = new Sandbox(SandboxMaterial.load(), Reconciler.demo());

    public SandboxRoutes(Auth auth) {
        this.auth = auth;
    }

    public void register(Router r) {
        r.get("/v1/console/sandbox", this::catalogue);
        r.post("/v1/console/sandbox/evidence", this::evidence);
        r.post("/v1/console/sandbox/package", this::pack);
        r.post("/v1/console/sandbox/package/verify", this::verifyPackage);
    }

    private Object catalogue(Ctx ctx) {
        auth.requireAuth(ctx);
        return sandbox.catalogue();
    }

    private Object evidence(Ctx ctx) throws Exception {
        auth.requireAuth(ctx);
        return sandbox.evidence(ctx.body());
    }

    private Object pack(Ctx ctx) throws Exception {
        auth.requireAuth(ctx);
        return sandbox.pack(ctx.body(), System.currentTimeMillis());
    }

    private Object verifyPackage(Ctx ctx) throws Exception {
        auth.requireAuth(ctx);
        return sandbox.verifyPackage(ctx.body());
    }
}
