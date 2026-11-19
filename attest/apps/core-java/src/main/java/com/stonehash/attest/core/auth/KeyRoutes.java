package com.stonehash.attest.core.auth;

import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.RateLimiter;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.time.IsoTime;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Self-serve sandbox sign-up: one call, a key back immediately, no approval
 * queue. Disabled in production, where keys are issued against a contract.
 * Unauthenticated by design, so it is capped per address.
 */
@Component
public class KeyRoutes {
    private final CoreConfig cfg;
    private final AttestService svc;
    private final AuthMapper mapper;
    private final RateLimiter signupLimiter;

    public KeyRoutes(CoreConfig cfg, AttestService svc, AuthMapper mapper) {
        this.cfg = cfg;
        this.svc = svc;
        this.mapper = mapper;
        this.signupLimiter = new RateLimiter(cfg.signupRateLimit.windowMs, cfg.signupRateLimit.max);
    }

    public void register(Router r) {
        r.post("/v1/sandbox/keys", (ctx) -> {
            if (!cfg.env.equals("test")) {
                throw new HttpError(403, "not_available", "self-serve key minting is sandbox-only; production keys are issued per contract");
            }
            Long wait = signupLimiter.check(RateLimiter.clientKey(ctx.req, cfg.trustProxy));
            if (wait != null) {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("error", "rate_limited");
                body.put("message", "sandbox sign-up is capped per address; retry in " + wait + "s");
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("retry-after", Long.toString(wait));
                return new HttpResult(429, body, headers);
            }
            Map<String, Object> body = Body.fields(ctx.body());
            String given = Body.text(body, "slug");
            String slug = (given != null ? given : "sandbox-" + UUID.randomUUID().toString().substring(0, 8)).toLowerCase(Locale.ROOT);
            // A new organisation every time. Minting into an existing slug would hand anyone who
            // knew the name a key to that organisation's records.
            if (svc.orgBySlug(slug) != null) {
                throw new HttpError(409, "slug_taken",
                        "that slug already names a sandbox organisation; pick another, or omit it for a generated one");
            }
            String name = Body.text(body, "name");
            String orgId = svc.ensureOrg(slug, name != null ? name : slug);
            String secret = ApiKeys.mint(cfg.keyPrefix());
            String label = Body.text(body, "label");
            mapper.insertApiKey(UUID.randomUUID().toString(), orgId, ApiKeys.hash(secret), cfg.keyPrefix(), label != null ? label : "sandbox", IsoTime.now());
            Map<String, Object> org = new LinkedHashMap<>();
            org.put("id", orgId);
            org.put("slug", slug);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("org", org);
            // Shown once. Only its hash is stored, so it cannot be recovered later.
            out.put("api_key", secret);
            out.put("note", "Store this now — it is not recoverable. Sandbox anchors land on a private regtest chain.");
            return new HttpResult(201, out);
        });
    }
}
