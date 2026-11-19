package com.stonehash.attest.core.ops;

import com.stonehash.attest.core.CoreApplication;
import com.stonehash.attest.core.anchor.BitcoindHealth;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.Router;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Liveness and the service's description of itself: what an orchestrator and a client read before anything else. */
@Component
public class OperationsRoutes {
    private final CoreConfig cfg;
    private final BitcoindHealth chain;
    private final AttestService attest;

    public OperationsRoutes(CoreConfig cfg, BitcoindHealth chain, AttestService attest) {
        this.cfg = cfg;
        this.chain = chain;
        this.attest = attest;
    }

    public void registerHealth(Router r) {
        r.get("/healthz", (ctx) -> {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "ok");
            return body;
        });
    }

    public void registerReady(Router r) {
        r.get("/readyz", (ctx) -> {
            Map<String, Object> health = chain.health();
            boolean ok = Boolean.TRUE.equals(health.get("ok"));
            // Not ready is a 503, not a 200 with a sad field: an orchestrator reads the status code.
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", ok ? "ready" : "degraded");
            body.put("env", cfg.env);
            body.put("network", cfg.bitcoinNetwork);
            body.put("anchorBackend", "bitcoind:" + cfg.bitcoinNetwork);
            body.put("chain", health);
            return new HttpResult(ok ? 200 : 503, body);
        });
    }

    public void registerMeta(Router r) {
        r.get("/v1/meta", (ctx) -> meta());
    }

    private Map<String, Object> meta() {
        Map<String, Object> inscription = new LinkedHashMap<>();
        inscription.put("enabled", attest.canInscribe());
        inscription.put("max_bytes", cfg.inscriptionMaxBytes);
        inscription.put("standard_relay_max_bytes", CoreConfig.STANDARD_RELAY_MAX_BODY_BYTES);
        inscription.put("hard_ceiling_bytes", CoreConfig.HARD_CEILING_BYTES);
        inscription.put("note", "max_bytes is this deployment's policy. standard_relay_max_bytes is what an "
                + "ordinary Bitcoin node will relay; above it a reveal needs a node run with "
                + "-acceptnonstdtxn. hard_ceiling_bytes is the last-line guard.");

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("inscription", inscription);
        body.put("service", "stonehash-attest-core");
        body.put("version", CoreApplication.VERSION);
        body.put("env", cfg.env);
        // Reproduced verbatim into every bundle; a client should surface it.
        body.put("bitcoin_network", cfg.bitcoinNetwork);
        body.put("anchor_backend", "bitcoind:" + cfg.bitcoinNetwork);
        body.put("bundle_schema", "bitcert-proof-bundle/v1");
        body.put("playground", cfg.playgroundDir.isEmpty() ? null : "/playground/");
        body.put("docs", cfg.docsDir.isEmpty() ? null : "/docs/");
        Map<String, Object> console = null;
        if (!cfg.consoleDir.isEmpty() && cfg.console.enabled && cfg.env.equals("test")) {
            console = new LinkedHashMap<>();
            console.put("path", "/console/");
            console.put("signup_required", true);
            console.put("self_serve", true);
            console.put("monthly_quota", cfg.console.monthlyQuota);
        }
        body.put("console", console);
        Map<String, Object> freeTier = null;
        if (cfg.publicAnchor.enabled) {
            freeTier = new LinkedHashMap<>();
            freeTier.put("endpoint", "/v1/public/anchors");
            freeTier.put("signup_required", false);
            freeTier.put("per_address_per_hour", cfg.publicAnchor.rateLimit.max);
            freeTier.put("retention_days", cfg.publicAnchor.retentionDays);
        }
        body.put("free_tier", freeTier);
        body.put("key_prefix", cfg.keyPrefix());
        // An honest statement of what this network can and cannot support.
        body.put("public_verifiability", cfg.bitcoinNetwork.equals("mainnet")
                ? "anchors are on public Bitcoin and can be confirmed by any third party"
                : "anchors are on a private regtest chain: links A, B and C1 verify offline, "
                        + "but public-chain inclusion (C2) cannot be confirmed by a third party");
        return body;
    }
}
