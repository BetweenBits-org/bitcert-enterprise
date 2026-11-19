package com.stonehash.attest.core.audit;

import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.time.IsoTime;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Audit log — who called what, when, with what result, per organisation.
 *
 * <p>One row per request that acted as someone. The row is written once the
 * outcome is known and before the response goes out, so a reader who asks
 * right after a call already sees the call — the console's audit screen does
 * exactly that, and a record that lagged its own actions would read as
 * entries going missing.
 *
 * <p>Anonymous requests are not here. There is no organisation to file them
 * under, and a per-tenant record that mixed in unauthenticated probes would
 * be a server log, not an audit trail.
 */
@Component
public class Audit {
    /** The column is sized to this; a longer path is a client being odd, not something to keep. */
    private static final int PATH_MAX = 512;

    /**
     * Reads the console makes on every page view. Recording them would bury
     * the calls an auditor is looking for under thousands of "the dashboard
     * was opened". Only the GET is silent.
     */
    private static final Set<String> SILENT_READS = Set.of(
            "/healthz", "/readyz", "/v1/meta",
            "/v1/console/audit", "/v1/console/me", "/v1/console/dashboard",
            "/v1/console/products", "/v1/console/sandbox");

    private final AuditMapper mapper;

    public Audit(AuditMapper mapper) {
        this.mapper = mapper;
    }

    private static boolean startsWithAny(String path, String... prefixes) {
        for (String prefix : prefixes) {
            if (path.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Which product a path belongs to, for the per-service view. Decided by
     * path rather than by which class registered the route, and by prefix, so
     * that a new sub-route lands in the right bucket without an edit here.
     * Anything else is the console's own housekeeping.
     */
    public static String serviceOf(String path) {
        if (startsWithAny(path, "/v1/settlements", "/v1/quotes", "/v1/manifests", "/v1/remit/")) {
            return "remit";
        }
        if (path.startsWith("/v1/por")) {
            return "por";
        }
        if (startsWithAny(path, "/v1/attestations", "/v1/issuer-keys", "/v1/public/anchors", "/v1/console/attestations", "/v1/console/tx/")) {
            return "attest";
        }
        return "console";
    }

    public static boolean isAudited(String method, String path) {
        return !(method.equals("GET") && SILENT_READS.contains(path));
    }

    /** The router's hook: called with the status about to be sent, before it is sent. */
    public void afterRequest(Ctx ctx, int status, double durationMs) {
        if (!(ctx.audit instanceof AuditActor) || !isAudited(ctx.method, ctx.path)) {
            return;
        }
        AuditActor actor = (AuditActor) ctx.audit;
        mapper.insert(UUID.randomUUID().toString(), actor.orgId, IsoTime.now(), actor.actorType, actor.actorId, actor.actorLabel,
                serviceOf(ctx.path), ctx.method, ctx.path.length() > PATH_MAX ? ctx.path.substring(0, PATH_MAX) : ctx.path, status,
                Math.max(0, Math.round(durationMs)));
    }
}
