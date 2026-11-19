package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The settlement rail over HTTP — the part of it that needs no partner.
 *
 * <pre>
 *   GET  /v1/remit/meta                        what a counterparty needs to verify the platform — no key
 *   POST /v1/remit/registry/institutions       register a partner institution (admin token)
 *   POST /v1/remit/registry/deactivate         switch an organisation's products off, by account e-mail (admin token)
 *   POST /v1/quotes                            a quote for the corridor
 *   POST /v1/settlements                       accept a settlement instruction
 *   GET  /v1/settlements                       the ledger: search, exact lookups, a page at a time
 *   GET  /v1/settlements/:id                   one settlement with its events
 *   GET  /v1/settlements/:id/chain             what the settlement chain says of its transfer, now
 *   GET  /v1/settlements/:id/evidence          its evidence package, the commitment, the anchor
 *   POST /v1/manifests/daily                   a day's signed manifest, compared and anchored
 *   GET  /v1/manifests/daily                   the manifests on file
 * </pre>
 *
 * <p>Mounted only where the rail is enabled: a deployment without it has no
 * trace of these routes. Payment ids are issued by the bank and held to a
 * pattern that cannot be one of the two words the stateless evaluators
 * answer under ({@code /v1/settlements/reconcile}, {@code /bundle}) — a
 * {@code GET} of those two is answered here, as "no such settlement".
 *
 * <p>Keyed routes mark the request with who acted, so each is in the audit
 * trail with the status it ended in. The metadata and the two routes behind
 * the admin token act as nobody and leave no row, as they never did.
 */
@Component
public class RemitRoutes {
    private final CoreConfig cfg;
    private final Auth auth;
    private final ProductRegistry registry;
    private final RemitStore store;
    private final PlatformKey platform;
    private final Acceptance acceptance;
    private final Manifests manifests;
    private final AttestService svc;
    private final Quotes.Config quoteCfg;
    private final org.springframework.beans.factory.ObjectProvider<RemitRouteSet> more;

    public RemitRoutes(CoreConfig cfg, Auth auth, ProductRegistry registry, RemitStore store, PlatformKey platform, Acceptance acceptance,
            Manifests manifests, AttestService svc, org.springframework.beans.factory.ObjectProvider<RemitRouteSet> more) {
        this.more = more;
        this.cfg = cfg;
        this.auth = auth;
        this.registry = registry;
        this.store = store;
        this.platform = platform;
        this.acceptance = acceptance;
        this.manifests = manifests;
        this.svc = svc;
        this.quoteCfg = new Quotes.Config(cfg.remit.rateUsdVnd, cfg.remit.rateUsdSgd, cfg.remit.feeUsd, cfg.remit.quoteTtlMs, cfg.remit.chainLabel);
        // The corridor policy is read and checked now, where the rail is on: a policy the rules cannot run under stops the start.
        if (cfg.remit.enabled && Evidence.POLICY.isEmpty()) {
            throw new IllegalStateException("the corridor policy is empty");
        }
    }

    /** The two routes that come before the console's product screen in the route table. */
    public void registerProvisioning(Router r) {
        r.get("/v1/remit/meta", this::meta);
        r.post("/v1/remit/registry/institutions", this::registerInstitution);
    }

    /**
     * The rest, after the console's product screen. The routes that drive a
     * settlement on — cancel, the answer to a request for information, the
     * partner's callbacks — belong between the evidence route and the
     * manifests, and after the manifests, where the marks are.
     */
    public void register(Router r) {
        r.post("/v1/remit/registry/deactivate", this::deactivate);
        r.post("/v1/quotes", this::quote);
        r.post("/v1/settlements", this::settle);
        r.get("/v1/settlements", this::ledger);
        r.get("/v1/settlements/:id", this::settlement);
        r.get("/v1/settlements/:id/chain", this::chain);
        r.get("/v1/settlements/:id/evidence", this::evidence);
        // POST /v1/settlements/:id/cancel and POST /v1/settlements/:id/rfi-response register here.
        registerMore(r, RemitRouteSet.Mark.AFTER_EVIDENCE);
        r.post("/v1/manifests/daily", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> bank = registry.requireRemit(orgId);
            return manifests.submit(orgId, bank, ctx.body());
        });
        r.get("/v1/manifests/daily", (ctx) -> manifests.list(auth.requireAuth(ctx), ctx.query.get("date")));
        // POST /v1/remit/callbacks registers here.
        registerMore(r, RemitRouteSet.Mark.AFTER_MANIFESTS);
    }

    /** The routes the other parts of the rail add at this place of the table ({@link RemitRouteSet}). */
    private void registerMore(Router r, RemitRouteSet.Mark mark) {
        more.orderedStream().filter((set) -> set.mark() == mark).forEach((set) -> set.register(r));
    }

    /** A header as the previous server handed it over: sent more than once, its values joined by a comma and a space. {@code null} when absent. */
    static String joinedHeader(Ctx ctx, String name) {
        List<String> all = ctx.req.getHeaders(name) == null ? new ArrayList<>() : Collections.list(ctx.req.getHeaders(name));
        return all.isEmpty() ? null : String.join(", ", all);
    }

    private void requireAdmin(Ctx ctx, String sentence) {
        String token = joinedHeader(ctx, "x-admin-token");
        if (cfg.remit.adminToken.isEmpty() || !cfg.remit.adminToken.equals(token)) {
            throw new HttpError(403, "forbidden", sentence);
        }
    }

    // ── public metadata: what a counterparty needs to verify the platform ────

    private Object meta(Ctx ctx) {
        Map<String, Object> signer = new LinkedHashMap<>();
        signer.put("key_id", platform.keyId());
        signer.put("spki", platform.spki());
        signer.put("algorithm", "ES256");
        Map<String, Object> corridor = new LinkedHashMap<>();
        corridor.put("origin", "VN");
        corridor.put("destination", "SG");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("product", "cross-border-settlement");
        out.put("mode", "sandbox");
        out.put("corridor", corridor);
        out.put("platform_signer", signer);
        out.put("institutions", registry.snapshot().get("institutions"));
        // A link template per transaction ({tx} = its hash), or null where nothing indexes the chain.
        out.put("explorer_tx_url", cfg.remit.explorerTxUrl.isEmpty() ? null : cfg.remit.explorerTxUrl);
        out.put("note", "Synthetic demo rail: mock USDC on a private chain, no real funds move.");
        return out;
    }

    // ── provisioning, behind the admin token ─────────────────────────────────

    /**
     * {@code POST /v1/remit/registry/institutions}: register a partner
     * institution, or bring one up to date. Whatever arrives is stored — no
     * key, role or id is checked here; the registry's keyring leaves out a
     * key it cannot use.
     */
    private Object registerInstitution(Ctx ctx) throws Exception {
        requireAdmin(ctx, "registry registration needs the remit admin token");
        Map<String, Object> body = Body.fields(ctx.body());
        if (!Body.truthy(body.get("id")) || !Body.truthy(body.get("role")) || !Body.truthy(body.get("name"))) {
            throw new HttpError(400, "missing_field", "id, role and name are required");
        }
        Map<String, Object> inst = registry.upsert(
                AttestService.storable(body.get("id")), AttestService.storable(body.get("role")), AttestService.storable(body.get("name")),
                Body.truthy(body.get("country")) ? AttestService.storable(body.get("country")) : null,
                null,
                Body.truthy(body.get("signing_spki")) ? AttestService.storable(body.get("signing_spki")) : null,
                body.containsKey("encryption_jwk") ? body.get("encryption_jwk") : Js.UNDEFINED,
                Body.truthy(body.get("authority")) ? body.get("authority") : null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", inst.get("id"));
        out.put("role", inst.get("role"));
        out.put("name", inst.get("name"));
        return new HttpResult(201, out);
    }

    /**
     * {@code POST /v1/remit/registry/deactivate}: switch an organisation's
     * subscriptions off, by an account's e-mail address — what an operator
     * reaches for instead of editing the store by hand.
     */
    private Object deactivate(Ctx ctx) throws Exception {
        requireAdmin(ctx, "deactivation needs the remit admin token");
        Map<String, Object> body = Body.fields(ctx.body());
        Object email = body.get("email");
        if (!Body.truthy(email)) {
            throw new HttpError(400, "missing_field", "email is required");
        }
        if (!(email instanceof String)) {
            throw new JsValues.EngineError("an e-mail address that is not text was put in lower case");
        }
        String orgId = store.orgOfAccount(((String) email).toLowerCase(Locale.ROOT));
        if (orgId == null) {
            throw new HttpError(404, "not_found", "no account with that email");
        }
        Object given = body.get("products");
        List<Object> targets = new ArrayList<>();
        if (given == null) {
            targets.add("attest");
            targets.add("remit");
            targets.add("por");
        } else if (given instanceof List) {
            targets.addAll((List<?>) given);
        } else if (given instanceof String) {
            // Text was gone through a character at a time.
            ((String) given).codePoints().forEach((cp) -> targets.add(new String(Character.toChars(cp))));
        } else {
            throw new JsValues.EngineError("a list of products that is not a list was gone through");
        }
        Map<String, Object> results = new LinkedHashMap<>();
        for (Object product : targets) {
            Map<String, Object> sub = registry.unsubscribe(orgId, AttestService.storable(product));
            results.put(JsValues.string(product), sub == null ? "not_subscribed" : sub.get("status"));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("email", email);
        out.put("results", results);
        return out;
    }

    // ── quotes ───────────────────────────────────────────────────────────────

    private Object quote(Ctx ctx) throws Exception {
        String orgId = auth.requireAuth(ctx);
        registry.requireRemit(orgId);
        Object body = ctx.body();
        if (cfg.remit.intakePaused) {
            throw Acceptance.intakePaused();
        }
        Map<String, Object> quote = Quotes.build(body, quoteCfg, System.currentTimeMillis());
        Object corridor = quote.get("corridor");
        store.saveQuote(orgId, (String) quote.get("quote_id"), (String) JsValues.member(corridor, "origin"),
                (String) JsValues.member(corridor, "destination"), body, quote, (String) quote.get("expires_at"));
        return new HttpResult(201, quote);
    }

    // ── settlements ──────────────────────────────────────────────────────────

    private Object settle(Ctx ctx) throws Exception {
        String orgId = auth.requireAuth(ctx);
        Map<String, Object> bank = registry.requireRemit(orgId);
        String idemKey = joinedHeader(ctx, "idempotency-key");
        if (idemKey == null || idemKey.length() < 8) {
            throw new HttpError(400, "missing_idempotency_key", "supply an Idempotency-Key header (≥8 chars); it is what makes a retry safe");
        }
        // The column that keeps the key holds 191 characters. A longer one is refused before anything is accepted under it.
        if (idemKey.length() > 191) {
            throw new HttpError(400, "invalid_idempotency_key", "the Idempotency-Key header is longer than 191 characters");
        }
        return acceptance.accept(orgId, bank, idemKey, ctx.body());
    }

    private static final java.util.regex.Pattern DAY = java.util.regex.Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");

    /**
     * The exact lookups of the ledger: by the UETR of the message a
     * settlement was made from, or by the digest of that message's content
     * (optionally narrowed to one value date). A value that could never
     * match is refused, not answered with an empty page — "nothing found"
     * must mean nothing is there.
     */
    private static void sourceLookup(Ctx ctx, RemitStore.Search s) {
        String uetr = ctx.query.get("source_uetr");
        String content = ctx.query.get("source_content");
        String day = ctx.query.get("source_value_date");
        if (uetr != null) {
            if (!SourceRef.isUuid(uetr)) {
                throw new HttpError(400, "invalid_source_lookup", "source_uetr must be a UUID");
            }
            s.sourceUetr = uetr.toLowerCase(Locale.ROOT);
        }
        if (content != null) {
            if (!SourceRef.isDigest(content)) {
                throw new HttpError(400, "invalid_source_lookup", "source_content must be a SHA-256 digest in hex");
            }
            s.sourceContent = content.toLowerCase(Locale.ROOT);
        }
        if (day != null) {
            if (content == null) {
                throw new HttpError(400, "invalid_source_lookup", "source_value_date narrows source_content and needs it");
            }
            if (!DAY.matcher(day).matches()) {
                throw new HttpError(400, "invalid_source_lookup", "source_value_date must be YYYY-MM-DD");
            }
            s.sourceValueDate = day;
        }
    }

    private static String given(String v) {
        return v == null || v.isEmpty() ? null : v;
    }

    private static Map<String, Object> pair(String a, Object x, String b, Object y) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(a, x);
        out.put(b, y);
        return out;
    }

    /**
     * {@code GET /v1/settlements}: the ledger, shaped for an organisation
     * with thousands of rows — filters run in the store, pages are continued
     * by the {@code cursor} of the previous answer, and {@code total} counts
     * what the filters leave. A bare GET is the newest page.
     */
    private Object ledger(Ctx ctx) {
        String orgId = auth.requireAuth(ctx);
        RemitStore.Search s = new RemitStore.Search();
        s.q = given(ctx.query.get("q"));
        sourceLookup(ctx, s);
        s.state = given(ctx.query.get("state"));
        s.from = given(ctx.query.get("from"));
        s.to = given(ctx.query.get("to"));
        s.cursor = given(ctx.query.get("cursor"));
        s.limit = Router.pageLimit(ctx.query.get("limit"), 25, 100);
        RemitStore.Page page = store.search(orgId, s);

        List<Object> data = new ArrayList<>();
        for (Map<String, Object> p : page.items) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("payment_id", p.get("id"));
            row.put("state", p.get("state"));
            row.put("corridor", pair("origin", p.get("corridor_origin"), "destination", p.get("corridor_destination")));
            row.put("trade", pair("currency", p.get("trade_currency"), "value", p.get("trade_amount")));
            row.put("collected", pair("currency", p.get("collect_currency"), "value", p.get("collect_amount")));
            row.put("paid", pair("currency", p.get("payout_currency"), "value", p.get("payout_amount")));
            row.put("evidence_level", p.get("evidence_level"));
            row.put("evidence_available", p.get("package_json") != null);
            row.put("chain_tx", p.get("chain_tx"));
            row.put("attestation", manifests.attestationBrief(orgId, p.get("attestation_id")));
            row.put("created_at", p.get("created_at"));
            row.put("updated_at", p.get("updated_at"));
            data.add(row);
        }
        Map<String, Object> paging = new LinkedHashMap<>();
        paging.put("total", page.total);
        paging.put("returned", data.size());
        paging.put("next_cursor", page.nextCursor);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("data", data);
        out.put("page", paging);
        return out;
    }

    private Map<String, Object> own(String orgId, Ctx ctx) {
        Map<String, Object> p = store.getForOrg(orgId, ctx.params.get("id"));
        if (p == null) {
            throw new HttpError(404, "not_found", "no settlement " + ctx.params.get("id"));
        }
        return p;
    }

    /** {@code GET /v1/settlements/:id}: the settlement, and every event beneath its state. */
    private Object settlement(Ctx ctx) {
        String orgId = auth.requireAuth(ctx);
        Map<String, Object> p = own(orgId, ctx);
        Map<String, Object> att = JsValues.truthy(p.get("attestation_id")) ? svc.get(orgId, (String) p.get("attestation_id")) : null;
        Map<String, Object> amounts = new LinkedHashMap<>();
        amounts.put("trade", pair("currency", p.get("trade_currency"), "value", p.get("trade_amount")));
        amounts.put("collected", pair("currency", p.get("collect_currency"), "value", p.get("collect_amount")));
        amounts.put("settled", pair("asset", "USDC", "value", p.get("usdc_amount")));
        amounts.put("paid", pair("currency", p.get("payout_currency"), "value", p.get("payout_amount")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("payment_id", p.get("id"));
        out.put("state", p.get("state"));
        out.put("corridor", pair("origin", p.get("corridor_origin"), "destination", p.get("corridor_destination")));
        out.put("amounts", amounts);
        out.put("quote_id", p.get("quote_id"));
        out.put("beneficiary_institution", p.get("beneficiary_institution"));
        out.put("deposit_address", p.get("deposit_address"));
        out.put("chain_tx", p.get("chain_tx"));
        out.put("evidence_level", p.get("evidence_level"));
        out.put("evidence_available", p.get("package_json") != null);
        out.put("attestation", att == null ? null : pair("id", att.get("id"), "status", att.get("status")));
        out.put("created_at", p.get("created_at"));
        out.put("updated_at", p.get("updated_at"));
        out.put("events", Evidence.eventViews(store.events((String) p.get("id")), true));
        return out;
    }

    /**
     * {@code GET /v1/settlements/:id/chain}: the node's answer about this
     * settlement's transfer, now. Asked by the settlement, never by a bare
     * hash, so an organisation can only ask about its own transfer; the
     * node's address stays on the server.
     */
    private Object chain(Ctx ctx) {
        String orgId = auth.requireAuth(ctx);
        Map<String, Object> p = own(orgId, ctx);
        String chainTx = (String) p.get("chain_tx");
        if (chainTx == null || chainTx.isEmpty()) {
            throw new HttpError(404, "no_chain_tx", "settlement " + p.get("id") + " has not reached the chain yet");
        }
        Map<String, Object> status = ChainStatus.of(cfg.remit.chainRpc, cfg.remit.chainLabel, chainTx);
        String template = cfg.remit.explorerTxUrl;
        if (template.isEmpty()) {
            status.put("explorer_url", null);
        } else {
            // The first {tx} only, as it always was.
            int at = template.indexOf("{tx}");
            status.put("explorer_url", template.substring(0, at) + ChainStatus.encodeUriComponent(chainTx) + template.substring(at + 4));
        }
        return status;
    }

    /** {@code GET /v1/settlements/:id/evidence}: the package as it was stored, what it was committed as, and the anchor once there is one. */
    private Object evidence(Ctx ctx) {
        String orgId = auth.requireAuth(ctx);
        Map<String, Object> p = own(orgId, ctx);
        if (!JsValues.truthy(p.get("package_json")) || !JsValues.truthy(p.get("commitment")) || !JsValues.truthy(p.get("nonce"))) {
            throw new HttpError(409, "evidence_not_ready", "evidence is assembled at BENEFICIARY_CREDIT_CONFIRMED; this payment is " + p.get("state"));
        }
        Object attestationId = p.get("attestation_id");
        Object bundle = null;
        if (JsValues.truthy(attestationId)) {
            try {
                bundle = svc.exportBundle(orgId, (String) attestationId);
            } catch (ServiceError e) {
                // Not in a batch yet, or the batch not on the chain yet: there is no bundle to show, and that is not a failure.
                if (!"not_batched".equals(e.code()) && !"not_anchored".equals(e.code())) {
                    throw e;
                }
            }
        }
        Map<String, Object> commitment = new LinkedHashMap<>();
        commitment.put("value", p.get("commitment"));
        commitment.put("nonce", p.get("nonce"));
        commitment.put("domain", Evidence.COMMIT_DOMAIN);
        commitment.put("how_to_verify", "SHA256(domain || nonce_bytes || JCS(package)) must equal value, and value is the anchored leaf");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("package", Js.parse((String) p.get("package_json")));
        out.put("commitment", commitment);
        if (JsValues.truthy(attestationId)) {
            Map<String, Object> attestation = manifests.attestationBrief(orgId, attestationId);
            attestation.put("bundle", bundle);
            out.put("attestation", attestation);
        } else {
            out.put("attestation", null);
        }
        return out;
    }
}
