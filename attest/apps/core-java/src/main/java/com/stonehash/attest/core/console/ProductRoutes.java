package com.stonehash.attest.core.console;

import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.audit.AuditActor;
import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The console's product screen (구독): what the organisation is subscribed
 * to, the institutions it acts as, what the month has used and what that
 * costs — and activating a product.
 *
 * <p>Activating the settlement rail or the reserve proofs registers the
 * organisation as an institution with one of its own issuer keys: from then
 * on that key is what its signatures are verified with. Document anchoring
 * needs no institution; it is switched on and nothing else.
 *
 * <p>Three more act on what activation made: switching a product off,
 * pointing an institution at another of the organisation's keys, and giving
 * an exchange the key its console session signs with.
 *
 * <p>All five exist where the settlement rail is enabled, as they did
 * before: the product screen is that rail's and the reserve proofs'.
 */
@Component
public class ProductRoutes {
    private static final Pattern COUNTRY = Pattern.compile("[A-Z]{2}");
    private static final Pattern INSTITUTION_ID = Pattern.compile("[A-Z]{2}-[A-Z0-9-]{2,32}");

    /** What a collection bank may assert on the settlement rail. */
    private static final List<String> BANK_AUTHORITY = Arrays.asList(
            "FIAT_FUNDS_RECEIVED", "PAYMENT_RELEASE_AUTHORIZED", "bankInstruction", "bankApproval", "commercialDocs");
    /** What an exchange may assert: its own reserve snapshots. */
    private static final List<String> EXCHANGE_AUTHORITY = Arrays.asList("POR_SNAPSHOT");

    private final CoreConfig cfg;
    private final Auth auth;
    private final ConsoleMapper mapper;
    private final ProductRegistry registry;

    public ProductRoutes(CoreConfig cfg, Auth auth, ConsoleMapper mapper, ProductRegistry registry) {
        this.cfg = cfg;
        this.auth = auth;
        this.mapper = mapper;
        this.registry = registry;
    }

    /** The door of the product screen: a console session, where the deployment has a console at all. */
    public static void requireConsole(boolean enabled, String env) {
        if (!(env.equals("test") && enabled)) {
            throw new HttpError(403, "console_disabled", "the console is not enabled on this deployment");
        }
    }

    private Map<String, Object> requireSession(Ctx ctx) {
        requireConsole(cfg.console.enabled, cfg.env);
        Map<String, Object> account = auth.accountForSession(Auth.cookieToken(Auth.cookieHeader(ctx)));
        if (account == null) {
            throw new HttpError(401, "unauthorized", "a console session is required");
        }
        ctx.audit = AuditActor.session((String) account.get("org_id"), (String) account.get("id"), (String) account.get("email"));
        return account;
    }

    /** A key an institution signs with has to be one a signature can be verified with: a P-256 public key. */
    private static void requireInstitutionKey(String publicKey) {
        PublicKeys.Problem problem = PublicKeys.es256Problem(publicKey);
        if (problem != null) {
            throw new HttpError(400, problem.code, "that issuer key is " + problem.message + ". An institution cannot verify signatures with it.");
        }
    }

    public void register(Router r) {
        r.get("/v1/console/products", this::products);
        r.post("/v1/console/products", this::activate);
        r.post("/v1/console/products/:product/deactivate", this::deactivate);
        r.post("/v1/console/institutions/:id/signing-key", this::signingKey);
        r.post("/v1/console/institutions/:id/console-key", this::consoleKey);
    }

    // ── what the organisation has ────────────────────────────────────────────

    private Object products(Ctx ctx) {
        Map<String, Object> account = requireSession(ctx);
        String orgId = (String) account.get("org_id");
        List<Map<String, Object>> subs = registry.subscriptions(orgId);

        List<Object> institutions = new ArrayList<>();
        for (String role : new String[] { "COLLECTION_BANK", "EXCHANGE" }) {
            Map<String, Object> i = registry.institutionForOrg(orgId, role);
            if (i != null) {
                Map<String, Object> shown = new LinkedHashMap<>();
                for (String k : new String[] { "id", "role", "name", "country", "signing_spki" }) {
                    shown.put(k, i.get(k));
                }
                institutions.add(shown);
            }
        }

        long monthStart = Billing.monthStart(System.currentTimeMillis());
        String since = IsoTime.ofEpochMilli(monthStart);
        long anchors = mapper.anchorsSince(orgId, since, "attest");
        long settlements = mapper.settlementsSince(orgId, since);
        long snapshots = mapper.snapshotsSince(orgId, since);

        Map<String, Object> attest = new LinkedHashMap<>();
        attest.put("plan", "sandbox");
        attest.put("meter", "anchors / month");
        attest.put("quota", cfg.console.monthlyQuota);
        attest.put("used", anchors);
        Map<String, Object> remit = new LinkedHashMap<>();
        remit.put("meter", "per settlement + bps — evidence & anchoring included");
        remit.put("settlements", settlements);
        remit.put("included_anchors", mapper.anchorsSince(orgId, since, "remit"));
        Map<String, Object> por = new LinkedHashMap<>();
        por.put("meter", "per snapshot period — challenge, anchor & public verify included");
        por.put("snapshots", snapshots);
        por.put("included_anchors", mapper.anchorsSince(orgId, since, "por"));

        Set<String> active = new HashSet<>();
        List<Object> products = new ArrayList<>();
        for (Map<String, Object> s : subs) {
            if ("active".equals(s.get("status"))) {
                active.add((String) s.get("product"));
            }
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("product", s.get("product"));
            p.put("plan", s.get("plan"));
            p.put("status", s.get("status"));
            p.put("config", Js.parse((String) s.get("config")));
            p.put("created_at", s.get("created_at"));
            products.add(p);
        }

        Map<String, Object> billing = new LinkedHashMap<>();
        billing.put("month_start", since);
        billing.put("attest", attest);
        billing.put("remit", remit);
        billing.put("por", por);
        billing.put("charges", Billing.monthlyCharges(cfg.pricing, anchors, settlements, snapshots, active, monthStart));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("products", products);
        // The first institution on its own as well, for callers written when there was one.
        out.put("institution", institutions.isEmpty() ? null : institutions.get(0));
        out.put("institutions", institutions);
        out.put("billing", billing);
        return out;
    }

    // ── activating a product ─────────────────────────────────────────────────

    private Object activate(Ctx ctx) throws Exception {
        Map<String, Object> account = requireSession(ctx);
        String orgId = (String) account.get("org_id");
        Map<String, Object> body = Body.fields(ctx.body());
        Object product = body.get("product");
        if (!"remit".equals(product) && !"por".equals(product) && !"attest".equals(product)) {
            throw new HttpError(400, "unknown_product", "subscribable products: attest, remit, por");
        }
        if (product.equals("attest")) {
            Map<String, Object> sub = registry.subscribe(orgId, "attest", new LinkedHashMap<>());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("product", "attest");
            out.put("status", sub.get("status"));
            out.put("anchor_endpoint", "/v1/attestations");
            out.put("console_quota", cfg.console.monthlyQuota);
            return new HttpResult(201, out);
        }
        boolean reserves = product.equals("por");

        Map<String, Object> institution = Body.fields(body.get("institution"));
        if (!Body.truthy(institution.get("name"))) {
            throw new HttpError(400, "missing_field", "institution.name is required");
        }
        String name = AttestService.storable(institution.get("name"));
        String country = Body.truthy(institution.get("country")) ? AttestService.storable(institution.get("country")) : null;

        String id;
        if (!Body.truthy(institution.get("id"))) {
            // No id given: the organisation's institution in that role if it has one, otherwise a new id under its country.
            Map<String, Object> existing = registry.institutionForOrg(orgId, reserves ? "EXCHANGE" : "COLLECTION_BANK");
            if (existing != null) {
                id = (String) existing.get("id");
            } else {
                String code = institution.get("country") instanceof String ? ((String) institution.get("country")).toUpperCase(Locale.ROOT) : "";
                if (!COUNTRY.matcher(code).matches()) {
                    throw new HttpError(400, "missing_field", "institution.country (ISO2) is required to issue an institution id");
                }
                do {
                    id = code + "-" + (reserves ? "EX" : "BANK") + "-" + UUID.randomUUID().toString().substring(0, 6).toUpperCase(Locale.ROOT);
                } while (registry.institution(id) != null);
            }
        } else if (!(institution.get("id") instanceof String) || !INSTITUTION_ID.matcher((String) institution.get("id")).matches()) {
            throw new HttpError(400, "invalid_institution_id", "institution ids look like VN-BANK-001 (country prefix, uppercase)");
        } else {
            id = (String) institution.get("id");
        }

        if (!Body.truthy(body.get("issuer_key_id"))) {
            throw new HttpError(400, "missing_field", "issuer_key_id is required");
        }
        Map<String, Object> key = mapper.activeIssuerKey(AttestService.storable(body.get("issuer_key_id")), orgId);
        if (key == null) {
            throw new HttpError(404, "issuer_key_not_found", "no such issuer key for this organisation");
        }
        if (!"ES256".equals(key.get("algorithm"))) {
            throw new HttpError(400, "unsupported_algorithm", "the remit rail signs with ES256 keys");
        }
        String publicKey = (String) key.get("public_key");
        requireInstitutionKey(publicKey);

        // An id is one organisation's: activation never takes over an institution registered to another.
        Map<String, Object> taken = registry.institution(id);
        if (taken != null && !orgId.equals(taken.get("org_id"))) {
            throw new HttpError(409, "institution_id_taken", id + " is registered to another organisation");
        }

        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("institution_id", id);
        if (reserves) {
            registry.upsert(id, "EXCHANGE", name, country, orgId, publicKey, EXCHANGE_AUTHORITY);
            Map<String, Object> sub = registry.subscribe(orgId, "por", config);
            out.put("product", "por");
            out.put("status", sub.get("status"));
            out.put("institution_id", id);
            out.put("snapshot_endpoint", "/v1/por/snapshots");
            out.put("sdk", "@stonehash/attest-por — build the tree locally; submit the statement only");
            return new HttpResult(201, out);
        }
        registry.upsert(id, "COLLECTION_BANK", name, country, orgId, publicKey, BANK_AUTHORITY);
        if (Body.truthy(body.get("webhook_url"))) {
            config.put("webhook_url", body.get("webhook_url"));
        }
        Map<String, Object> sub = registry.subscribe(orgId, "remit", config);
        out.put("product", "remit");
        out.put("status", sub.get("status"));
        out.put("institution_id", id);
        out.put("webhook_url", body.get("webhook_url"));
        out.put("quote_endpoint", "/v1/quotes");
        out.put("settlement_endpoint", "/v1/settlements");
        return new HttpResult(201, out);
    }

    // ── switching a product off ──────────────────────────────────────────────

    /**
     * {@code POST /v1/console/products/:product/deactivate}. The
     * subscription stays — its history and its billing are continuous — and
     * reads {@code inactive}: every API of that product refuses from the
     * next request until it is activated again.
     */
    private Object deactivate(Ctx ctx) {
        Map<String, Object> account = requireSession(ctx);
        String product = ctx.params.get("product");
        if (!product.equals("attest") && !product.equals("remit") && !product.equals("por")) {
            throw new HttpError(400, "unknown_product", "deactivatable products: attest, remit, por");
        }
        Map<String, Object> sub = registry.unsubscribe((String) account.get("org_id"), product);
        if (sub == null) {
            throw new HttpError(404, "not_subscribed", "no " + product + " subscription to deactivate");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("product", product);
        out.put("status", sub.get("status"));
        return out;
    }

    // ── an institution's keys ────────────────────────────────────────────────

    /** The organisation's own institution of that id. Whether an id belongs to someone else is not this caller's to learn: 404 either way. */
    private Map<String, Object> ownInstitution(Ctx ctx, Map<String, Object> account) {
        Map<String, Object> institution = registry.institution(ctx.params.get("id"));
        if (institution == null || !account.get("org_id").equals(institution.get("org_id"))) {
            throw new HttpError(404, "institution_not_found", "no institution with that id in this organisation");
        }
        return institution;
    }

    /**
     * {@code POST /v1/console/institutions/:id/signing-key}: switch the key
     * an institution's signatures are verified with.
     *
     * <p>Activation copied one registered key onto the institution; this is
     * the same copy made again with another key, so that a rotation does not
     * have to go through deactivating and activating. The candidates are the
     * organisation's own registered issuer keys and nothing else. The rails
     * verify against this one column, so the switch holds from the next
     * signature checked.
     */
    private Object signingKey(Ctx ctx) throws Exception {
        Map<String, Object> account = requireSession(ctx);
        Map<String, Object> institution = ownInstitution(ctx, account);
        Object keyId = Body.fields(ctx.body()).get("issuer_key_id");
        if (!(keyId instanceof String) || ((String) keyId).isEmpty()) {
            throw new HttpError(400, "missing_field", "issuer_key_id is required");
        }
        Map<String, Object> key = mapper.issuerKey((String) keyId, (String) account.get("org_id"));
        if (key == null) {
            throw new HttpError(404, "issuer_key_not_found", "no such issuer key for this organisation");
        }
        if (Body.truthy(key.get("revoked_at"))) {
            throw new HttpError(409, "key_revoked", "that key was revoked; register a new one and pick it instead");
        }
        if (!"ES256".equals(key.get("algorithm"))) {
            throw new HttpError(400, "unsupported_algorithm", "institutions sign with ES256 keys");
        }
        // Decoding is not enough: a key on another curve would fail every signature, here and in the keyring every
        // organisation's reconciliation shares. Refused where it can be named.
        requireInstitutionKey((String) key.get("public_key"));
        String appliedAt = IsoTime.now();
        registry.setSigningKey((String) institution.get("id"), (String) key.get("public_key"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("institution_id", institution.get("id"));
        out.put("issuer_key_id", keyId);
        out.put("applied_at", appliedAt);
        return out;
    }

    /**
     * {@code POST /v1/console/institutions/:id/console-key}: the key the
     * console's reserve screen signs with.
     *
     * <p>That screen builds and signs a reserve statement in the visitor's
     * page. It cannot hold the exchange's signing key and must not replace
     * it, so the page makes a key for the session and registers the public
     * half here: a second key, beside the signing key and never instead of
     * it. Each session's key replaces the last. Only an exchange takes one —
     * the settlement rail checks a bank's instructions against its signing
     * key and nothing else.
     */
    private Object consoleKey(Ctx ctx) throws Exception {
        Map<String, Object> account = requireSession(ctx);
        Map<String, Object> institution = ownInstitution(ctx, account);
        if (!"EXCHANGE".equals(institution.get("role"))) {
            throw new HttpError(400, "not_an_exchange", "a console key signs reserve statements; only an EXCHANGE institution takes one");
        }
        Object publicKey = Body.fields(ctx.body()).get("public_key");
        if (!(publicKey instanceof String) || ((String) publicKey).isEmpty()) {
            throw new HttpError(400, "missing_field", "public_key is required");
        }
        requireInstitutionKey((String) publicKey);
        String appliedAt = IsoTime.now();
        registry.setConsoleKey((String) institution.get("id"), (String) publicKey);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("institution_id", institution.get("id"));
        out.put("applied_at", appliedAt);
        return out;
    }
}
