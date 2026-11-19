package com.stonehash.attest.core.attest;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.Handler;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.RateLimiter;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.time.IsoTime;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The free tier: anchor a digest with no account.
 *
 * <p>It is unauthenticated because the product claim is that anyone can get
 * an independently verifiable proof without trusting us; a signup form in
 * front of the first step would make that claim something to take on faith.
 * What keeps it from being an open write endpoint:
 * <ul>
 * <li>only a 32-byte digest is accepted — there is no field to store content in;
 * <li>two rate limits, per address and service-wide;
 * <li>the shared batch: a free anchor joins the ordinary batch, so one caller
 *     cannot make us spend a transaction fee on demand;
 * <li>a retention window: records expire here; the bundle the visitor
 *     downloads does not.
 * </ul>
 * Every response states the network and, when it is not mainnet, says
 * plainly that a third party cannot confirm public-chain inclusion.
 */
@Component
public class PublicRoutes {
    private static final Pattern HEX64 = Pattern.compile("[0-9a-fA-F]{64}");

    private final CoreConfig cfg;
    private final AttestService svc;
    private final RateLimiter perAddress;
    private final RateLimiter global;
    /** The organisation every free-tier record belongs to; found, or made, the first time one is anchored. */
    private volatile String publicOrgId;

    public PublicRoutes(CoreConfig cfg, AttestService svc) {
        this.cfg = cfg;
        this.svc = svc;
        this.perAddress = new RateLimiter(cfg.publicAnchor.rateLimit.windowMs, cfg.publicAnchor.rateLimit.max);
        this.global = new RateLimiter(cfg.publicAnchor.globalRateLimit.windowMs, cfg.publicAnchor.globalRateLimit.max);
    }

    private String publicOrg() {
        String id = publicOrgId;
        if (id == null) {
            synchronized (this) {
                if (publicOrgId == null) {
                    publicOrgId = svc.ensureOrg("public-free-tier", "Public free tier (no signup)");
                }
                id = publicOrgId;
            }
        }
        return id;
    }

    /** What this deployment can and cannot evidence, in words, on every response. */
    private String verifiability() {
        return cfg.bitcoinNetwork.equals("mainnet")
                ? "Anchored to public Bitcoin. Confirm inclusion through any Bitcoin source you choose — "
                        + "your own node or a public explorer, never ours."
                : "Anchored to " + cfg.bitcoinNetwork + ", a private test chain. The original-to-digest, "
                        + "Merkle-inclusion and transaction-binding steps verify completely offline, but "
                        + "public-chain inclusion cannot be confirmed by a third party here, because we mine the "
                        + "blocks. This is a faithful run of the whole pipeline, not a publicly verifiable proof.";
    }

    /**
     * CORS for this surface only: the verification tool is served from
     * another host in production, so a browser needs permission. The keyed
     * API is called from servers and has no reason to be reachable from
     * arbitrary pages.
     */
    private void cors(Ctx ctx) {
        List<String> allowed = cfg.publicAnchor.allowedOrigins;
        List<String> origins = ctx.req.getHeaders("origin") == null ? List.of() : Collections.list(ctx.req.getHeaders("origin"));
        String origin = origins.isEmpty() ? null : String.join(", ", origins);
        if (allowed.contains("*")) {
            ctx.res.setHeader("access-control-allow-origin", "*");
        } else if (origin != null && allowed.contains(origin)) {
            ctx.res.setHeader("access-control-allow-origin", origin);
            ctx.res.setHeader("vary", "origin");
        }
        ctx.res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        ctx.res.setHeader("access-control-allow-headers", "content-type");
        ctx.res.setHeader("access-control-max-age", "600");
    }

    private Handler withCors(Handler fn) {
        return (ctx) -> {
            cors(ctx);
            return fn.handle(ctx);
        };
    }

    private void requireEnabled() {
        if (!cfg.publicAnchor.enabled) {
            throw new HttpError(503, "free_tier_disabled", "the no-signup anchoring tier is switched off in this deployment");
        }
    }

    private Map<String, Object> view(Map<String, Object> att, String note) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", att.get("id"));
        out.put("sha256", att.get("leaf_bytes"));
        // accepted → batched → submitted → confirmed, never collapsed into a flag.
        out.put("status", att.get("status"));
        out.put("bundle_available", att.get("batch_id") != null);
        out.put("bundle_url", att.get("batch_id") != null ? "/v1/public/anchors/" + att.get("id") + "/bundle" : null);
        out.put("created_at", att.get("created_at"));
        out.put("retrievable_until", att.get("expires_at"));
        out.put("bitcoin_network", cfg.bitcoinNetwork);
        out.put("public_verifiability", verifiability());
        if (note != null) {
            out.put("note", note);
        }
        return out;
    }

    private static HttpResult limited(String code, String message, long wait) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("retry-after", Long.toString(wait));
        return new HttpResult(429, body, headers);
    }

    public void register(Router r) {
        Handler preflight = withCors((ctx) -> new HttpResult(204, null));
        r.add("OPTIONS", "/v1/public/anchors", preflight);
        r.add("OPTIONS", "/v1/public/anchors/:id", preflight);
        r.add("OPTIONS", "/v1/public/anchors/:id/bundle", preflight);

        // POST /v1/public/anchors — body { "sha256": "<64 hex>" }.
        r.post("/v1/public/anchors", withCors((ctx) -> {
            requireEnabled();
            Long wait = perAddress.check(RateLimiter.clientKey(ctx.req, cfg.trustProxy));
            if (wait != null) {
                return limited("rate_limited", "free anchoring is capped per address; retry in " + wait + "s. "
                        + "A sandbox key raises the limit and is self-serve.", wait);
            }
            // Service-wide cap, so many addresses cannot do what one cannot.
            Long globalWait = global.check("all");
            if (globalWait != null) {
                return limited("capacity", "the free tier is at capacity for this window; retry in " + globalWait + "s", globalWait);
            }

            Map<String, Object> body = Body.fields(ctx.body());
            Object raw = body.get("sha256") != null ? body.get("sha256") : body.get("leaf_bytes") != null ? body.get("leaf_bytes") : body.get("digest");
            if (!(raw instanceof String) || !HEX64.matcher((String) raw).matches()) {
                throw new HttpError(400, "invalid_digest",
                        "provide \"sha256\": the SHA-256 of your file as 64 hex characters. Hash it locally — "
                                + "the file itself is never sent, so we cannot disclose what we never received.");
            }
            String digest = ((String) raw).toLowerCase(Locale.ROOT);
            AttestService.Issue opts = new AttestService.Issue();
            Map<String, Object> descriptor = new LinkedHashMap<>();
            descriptor.put("tier", "free");
            opts.descriptor = descriptor;
            opts.source = "public";
            opts.expiresAt = IsoTime.ofEpochMilli(System.currentTimeMillis() + cfg.publicAnchor.retentionDays * 86_400_000L);
            Map<String, Object> att;
            try {
                att = svc.issue(publicOrg(), digest, opts);
            } catch (ServiceError e) {
                // A digest already anchored is a useful answer, not a failure: the caller gets
                // the existing record rather than a duplicate.
                if (e.code().equals("duplicate_digest")) {
                    Map<String, Object> existing = svc.findPublicByDigest(digest);
                    if (existing != null) {
                        return new HttpResult(200, view(existing, "already anchored"));
                    }
                }
                throw e;
            }
            return new HttpResult(202, view(att, "accepted; it joins the next shared batch rather than its own transaction"));
        }));

        // GET /v1/public/anchors/:id — the id is the capability.
        r.get("/v1/public/anchors/:id", withCors((ctx) -> {
            requireEnabled();
            Map<String, Object> att = svc.getPublic(ctx.params.get("id"));
            if (att == null) {
                throw new HttpError(404, "not_found", "no free anchor " + ctx.params.get("id") + ". Free records are retrievable for "
                        + cfg.publicAnchor.retentionDays + " days; a downloaded bundle stays verifiable indefinitely without us.");
            }
            return view(att, null);
        }));

        // GET /v1/public/anchors/:id/bundle — the whole point of the tier.
        r.get("/v1/public/anchors/:id/bundle", withCors((ctx) -> {
            requireEnabled();
            String id = ctx.params.get("id");
            Map<String, Object> bundle = svc.exportPublicBundle(id);
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("content-disposition", "attachment; filename=\"proof-" + id + ".json\"");
            return new HttpResult(200, bundle, headers);
        }));
    }
}
