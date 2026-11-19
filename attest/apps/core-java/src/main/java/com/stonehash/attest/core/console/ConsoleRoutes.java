package com.stonehash.attest.core.console;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.anchor.BitcoindRpc;
import com.stonehash.attest.core.attest.AttestMapper;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.audit.AuditActor;
import com.stonehash.attest.core.audit.AuditSearch;
import com.stonehash.attest.core.auth.Accounts;
import com.stonehash.attest.core.auth.ApiKeys;
import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.auth.AuthMapper;
import com.stonehash.attest.core.auth.Passwords;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.db.StoredText;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.format.Statement;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.RateLimiter;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.log.Log;
import com.stonehash.attest.core.time.IsoTime;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

/**
 * The sandbox console's API.
 *
 * <p>The console is where a developer sees their first response, and it sits
 * beside the keyed API, not in front of it: the cookie identifies a person,
 * a bearer key identifies a system, and the two are never interchangeable
 * here — a console session cannot be used as an API key, and an API key does
 * not open the console. What a session does through these routes goes
 * through the same service as the keyed API, so the records are the same
 * records.
 *
 * <p>Self-serve accounts are the sandbox's. A deployment can switch the
 * console off, and production access is provisioned per contract; both are
 * said before anything else is looked at.
 */
@Component
public class ConsoleRoutes {
    /** A sandbox organisation holds this many keys at once: enough for a rotation and a few systems, few enough to keep track of. */
    static final int MAX_ACTIVE_KEYS = 10;

    private static final Pattern TXID = Pattern.compile("[0-9a-fA-F]{64}");
    private static final Pattern CONTROL = Pattern.compile("[\\u0000-\\u001f\\u007f]");
    /** A lookup someone is waiting for on a screen. */
    private static final Duration LOOKUP_TIMEOUT = Duration.ofSeconds(5);

    private final CoreConfig cfg;
    private final Auth auth;
    private final Accounts accounts;
    private final AuthMapper keys;
    private final ConsoleMapper mapper;
    private final AttestMapper records;
    private final AttestService svc;
    private final AuditSearch audit;
    private final Dashboard dashboard;
    private final BitcoindRpc rpc;
    private final RateLimiter authLimiter;

    public ConsoleRoutes(CoreConfig cfg, Auth auth, Accounts accounts, AuthMapper keys, ConsoleMapper mapper, AttestMapper records,
            AttestService svc, AuditSearch audit, Dashboard dashboard, BitcoindRpc rpc) {
        this.cfg = cfg;
        this.auth = auth;
        this.accounts = accounts;
        this.keys = keys;
        this.mapper = mapper;
        this.records = records;
        this.svc = svc;
        this.audit = audit;
        this.dashboard = dashboard;
        this.rpc = rpc;
        this.authLimiter = new RateLimiter(cfg.console.authRateLimit.windowMs, cfg.console.authRateLimit.max);
    }

    // ── who may ──────────────────────────────────────────────────────────────

    /** The console is the sandbox's, and a deployment can do without it. */
    public static void requireEnabled(boolean enabled, String env) {
        if (!enabled) {
            throw new HttpError(503, "console_disabled", "the sandbox console is switched off in this deployment");
        }
        if (!env.equals("test")) {
            throw new HttpError(403, "not_available", "self-serve console accounts are sandbox-only; production access is provisioned per contract");
        }
    }

    /** The signed-in account; the request is marked with who acted, for the audit trail. */
    private Map<String, Object> requireAccount(Ctx ctx) {
        requireEnabled(cfg.console.enabled, cfg.env);
        Map<String, Object> account = auth.accountForSession(Auth.cookieToken(Auth.cookieHeader(ctx)));
        if (account == null) {
            throw new HttpError(401, "not_signed_in", "sign in to continue");
        }
        ctx.audit = actor(account);
        return account;
    }

    private static AuditActor actor(Map<String, Object> account) {
        return AuditActor.session((String) account.get("org_id"), (String) account.get("id"), (String) account.get("email"));
    }

    /** Signing up and signing in are the two doors a stranger can knock on; each address gets so many knocks. */
    private void limitAuth(Ctx ctx) {
        Long wait = authLimiter.check(RateLimiter.clientKey(ctx.req, cfg.trustProxy));
        if (wait != null) {
            throw new HttpError(429, "rate_limited", "too many attempts from this address; retry in " + wait + "s");
        }
    }

    // ── what every screen shows ──────────────────────────────────────────────

    /** This month's allowance: {@code used, limit, remaining, resets}. Only document anchoring's own records count. */
    private Map<String, Object> quota(String orgId) {
        long now = System.currentTimeMillis();
        long used = mapper.anchorsSince(orgId, IsoTime.ofEpochMilli(Billing.monthStart(now)), "attest");
        long limit = cfg.console.monthlyQuota;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("used", used);
        out.put("limit", limit);
        out.put("remaining", Math.max(0, limit - used));
        out.put("resets", IsoTime.ofEpochMilli(Billing.nextMonthStart(now)));
        return out;
    }

    private void requireQuota(String orgId) {
        Map<String, Object> q = quota(orgId);
        if ((Long) q.get("remaining") <= 0) {
            throw new HttpError(429, "quota_exhausted", "the sandbox allows " + q.get("limit")
                    + " attestations per month; this month's allowance resets at " + q.get("resets"));
        }
    }

    /** The account, its organisation, its newest key (never the secret), and what this deployment's chain can and cannot prove. */
    private Map<String, Object> overview(Map<String, Object> account, Object lastLoginAt) {
        String orgId = (String) account.get("org_id");
        Map<String, Object> who = new LinkedHashMap<>();
        who.put("id", account.get("id"));
        who.put("email", account.get("email"));
        who.put("created_at", account.get("created_at"));
        who.put("last_login_at", lastLoginAt);

        Map<String, Object> key = mapper.newestActiveKey(orgId);
        Map<String, Object> apiKey = null;
        if (key != null) {
            apiKey = new LinkedHashMap<>();
            apiKey.put("id", key.get("id"));
            apiKey.put("label", key.get("label"));
            apiKey.put("prefix", cfg.keyPrefix());
            apiKey.put("created_at", key.get("created_at"));
        }

        Map<String, Object> inscription = new LinkedHashMap<>();
        inscription.put("enabled", svc.canInscribe());
        inscription.put("max_bytes", cfg.inscriptionMaxBytes);
        inscription.put("standard_relay_max_bytes", CoreConfig.STANDARD_RELAY_MAX_BODY_BYTES);
        inscription.put("hard_ceiling_bytes", CoreConfig.HARD_CEILING_BYTES);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("account", who);
        out.put("org", mapper.org(orgId));
        out.put("api_key", apiKey);
        out.put("issuer_keys", mapper.activeIssuerKeys(orgId));
        out.put("quota", quota(orgId));
        out.put("bitcoin_network", cfg.bitcoinNetwork);
        out.put("anchor_backend", "bitcoind:" + cfg.bitcoinNetwork);
        out.put("explorer_base_url", cfg.explorerBaseUrl);
        out.put("settlement_explorer_tx_url", cfg.remit.explorerTxUrl.isEmpty() ? null : cfg.remit.explorerTxUrl);
        out.put("inscription", inscription);
        // An honest statement of what this network can and cannot support, in the console's own language.
        out.put("public_verifiability", cfg.bitcoinNetwork.equals("mainnet")
                ? "앵커는 공개 비트코인에 기록되며 누구든 제3자가 확인할 수 있습니다 "
                        + "(anchors are on public Bitcoin and can be confirmed by any third party)."
                : "앵커는 " + cfg.bitcoinNetwork + ", 즉 비공개 테스트 체인(private test chain)에 기록됩니다. "
                        + "문서에서 해시로, Merkle 포함, 트랜잭션 결합까지는 네트워크 없이 완전히 검증됩니다. "
                        + "그러나 블록을 저희가 직접 생성하므로 공개 체인 포함은 여기서 제3자가 확인할 수 "
                        + "없습니다 (cannot be confirmed by a third party). 파이프라인 전 구간을 그대로 "
                        + "재현하지만, 공개적으로 검증 가능한 증명은 아닙니다.");
        return out;
    }

    /**
     * What signing up gives a new address: an organisation of its own, a
     * key, a placeholder issuer key the screens can show, and one sample
     * record — so that the first bundle export has something to export.
     *
     * @return the organisation's id and the key's secret, which is shown once
     */
    private String[] provision(String email) {
        String slug = "sandbox-" + UUID.randomUUID().toString().substring(0, 8);
        String orgId = svc.ensureOrg(slug, email.split("@", -1)[0]);

        String secret = ApiKeys.mint(cfg.keyPrefix());
        keys.insertApiKey(UUID.randomUUID().toString(), orgId, ApiKeys.hash(secret), cfg.keyPrefix(), "default", IsoTime.now());
        records.insertIssuerKey(UUID.randomUUID().toString(), orgId, "demo issuer (sandbox)", "DEMO-PUBLIC-KEY-PLACEHOLDER", "ES256", IsoTime.now());

        String sample = Hex.encode(Hex.sha256(("stonehash:sandbox:sample\n" + orgId).getBytes(StandardCharsets.UTF_8)));
        AttestService.Issue opts = new AttestService.Issue();
        opts.contentType = "text/plain";
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("sample", true);
        descriptor.put("note", "Seeded at signup so your first bundle export has something to export.");
        opts.descriptor = descriptor;
        try {
            svc.issue(orgId, sample, opts);
        } catch (ServiceError e) {
            // The sample is a convenience; an account is not refused for want of it.
        }
        return new String[] { orgId, secret };
    }

    private Map<String, String> cookie(Accounts.Session session) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("set-cookie", Accounts.sessionCookie(session.token, session.expiresAtMs, cfg.console.cookieSecure));
        return headers;
    }

    /**
     * A label as it is kept: no control characters, trimmed, sixty characters
     * at most, and never empty. A character cut in half by the limit (or
     * half a character sent as such) is kept as U+FFFD, which is what the
     * store was always handed for it.
     */
    static String cleanLabel(Object raw) {
        String t = raw instanceof String ? Js.trim(CONTROL.matcher((String) raw).replaceAll("")) : "";
        t = t.length() > 60 ? t.substring(0, 60) : t;
        return t.isEmpty() ? "default" : wellFormed(t);
    }

    /** Text with every half of a surrogate pair that stands alone replaced by U+FFFD: as the store keeps any text ({@link StoredText}). */
    static String wellFormed(String t) {
        return StoredText.wellFormed(t);
    }

    // ── the routes ───────────────────────────────────────────────────────────

    public void register(Router r) {
        r.post("/v1/console/signup", this::signup);
        r.post("/v1/console/login", this::login);
        r.post("/v1/console/logout", this::logout);
        r.get("/v1/console/me", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            return overview(account, account.get("last_login_at"));
        });
        r.get("/v1/console/dashboard", (ctx) -> dashboard.of((String) requireAccount(ctx).get("org_id")));
        r.get("/v1/console/audit", this::auditPage);
        r.get("/v1/console/attestations", this::list);
        r.post("/v1/console/attestations", this::create);
        r.post("/v1/console/attestations/inscribe", this::inscribe);
        r.post("/v1/console/attestations/signed", this::createSigned);
        r.get("/v1/console/issuer-keys", (ctx) -> data(svc.listIssuerKeys((String) requireAccount(ctx).get("org_id"))));
        r.post("/v1/console/issuer-keys", this::registerIssuerKey);
        r.post("/v1/console/issuer-keys/:id/revoke", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            if (!svc.revokeIssuerKey((String) account.get("org_id"), param(ctx, "id"))) {
                throw new HttpError(404, "not_found", "no active issuer key with that id");
            }
            return ok();
        });
        r.get("/v1/console/tx/:txid", this::tx);
        r.get("/v1/console/attestations/:id/bundle", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            String id = ctx.params.get("id");
            Map<String, Object> bundle = svc.exportBundle((String) account.get("org_id"), id);
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("content-disposition", "attachment; filename=\"proof-" + id + ".json\"");
            return new HttpResult(200, bundle, headers);
        });
        r.get("/v1/console/keys", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            Map<String, Object> out = data(mapper.activeKeys((String) account.get("org_id")));
            out.put("max_active", MAX_ACTIVE_KEYS);
            return out;
        });
        r.post("/v1/console/keys", this::createKey);
        r.post("/v1/console/keys/:id/label", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            Map<String, Object> body = Body.fields(ctx.body());
            if (mapper.renameKey(cleanLabel(body.get("label")), param(ctx, "id"), (String) account.get("org_id")) == 0) {
                throw new HttpError(404, "not_found", "no active key with that id");
            }
            return ok();
        });
        r.post("/v1/console/keys/:id/revoke", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            String orgId = (String) account.get("org_id");
            if (mapper.revokeKey(IsoTime.now(), param(ctx, "id"), orgId) == 0) {
                throw new HttpError(404, "not_found", "no active key with that id");
            }
            Map<String, Object> out = ok();
            out.put("active_remaining", mapper.activeKeyCount(orgId));
            return out;
        });
        r.post("/v1/console/keys/rotate", this::rotateKey);
        r.post("/v1/console/sessions/revoke-others", (ctx) -> {
            Map<String, Object> account = requireAccount(ctx);
            accounts.destroyOtherSessions((String) account.get("id"), Auth.cookieToken(Auth.cookieHeader(ctx)));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("revoked", true);
            return out;
        });
    }

    private static String param(Ctx ctx, String name) {
        String v = ctx.params.get(name);
        return v == null ? "" : v;
    }

    private static Map<String, Object> ok() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        return out;
    }

    private static Map<String, Object> data(Object rows) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("data", rows);
        return out;
    }

    // ── accounts and sessions ────────────────────────────────────────────────

    private Object signup(Ctx ctx) throws Exception {
        requireEnabled(cfg.console.enabled, cfg.env);
        limitAuth(ctx);
        Map<String, Object> body = Body.fields(ctx.body());

        String email = Accounts.normaliseEmail(body.get("email"));
        if (email == null) {
            throw new HttpError(400, "invalid_email", "provide a valid \"email\"");
        }
        String problem = Accounts.passwordProblem(body.get("password"));
        if (problem != null) {
            throw new HttpError(400, "invalid_password", problem);
        }
        String password = (String) body.get("password");
        if (accounts.findByEmail(email) != null) {
            throw taken();
        }

        String[] provisioned = provision(email);
        Map<String, Object> account;
        try {
            account = accounts.create(email, password, provisioned[0]);
        } catch (DuplicateKeyException e) {
            // Two sign-ups for one address arrived together and the other was stored first.
            throw taken();
        }
        // Every sandbox account starts subscribed to document anchoring: the product a new developer tries first.
        mapper.subscribeToAttest(UUID.randomUUID().toString(), provisioned[0], IsoTime.now());
        Accounts.Session session = accounts.createSession((String) account.get("id"), ctx.header("user-agent"));
        accounts.recordLogin((String) account.get("id"));
        ctx.audit = actor(account);

        Map<String, Object> out = overview(account, IsoTime.now());
        // Shown once. Only its hash is stored, so it cannot be recovered later.
        out.put("api_key_secret", provisioned[1]);
        out.put("note", "Store this key now — it is not recoverable. A sample attestation is already in your account.");
        return new HttpResult(201, out, cookie(session));
    }

    private static HttpError taken() {
        return new HttpError(409, "email_taken", "an account already exists for that address — sign in instead");
    }

    private Object login(Ctx ctx) throws Exception {
        requireEnabled(cfg.console.enabled, cfg.env);
        limitAuth(ctx);
        Map<String, Object> body = Body.fields(ctx.body());
        String email = Accounts.normaliseEmail(body.get("email"));
        Object password = body.get("password");

        // One answer for an address nobody registered, a wrong password and a disabled account:
        // the door does not say which.
        Map<String, Object> found = email != null ? accounts.findByEmail(email) : null;
        boolean ok = found != null && password instanceof String && !Body.truthy(found.get("disabled_at"))
                && Passwords.verify((String) password, String.valueOf(found.get("password_hash")));
        if (!ok) {
            throw new HttpError(401, "invalid_credentials", "that email and password do not match an account");
        }

        Accounts.Session session = accounts.createSession((String) found.get("id"), ctx.header("user-agent"));
        accounts.recordLogin((String) found.get("id"));
        ctx.audit = actor(found);
        return new HttpResult(200, overview(found, IsoTime.now()), cookie(session));
    }

    private Object logout(Ctx ctx) {
        accounts.destroySession(Auth.cookieToken(Auth.cookieHeader(ctx)));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("signed_out", true);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("set-cookie", Accounts.clearedCookie(cfg.console.cookieSecure));
        return new HttpResult(200, out, headers);
    }

    // ── records ──────────────────────────────────────────────────────────────

    /** The organisation's records as the store holds them — the console shows every column — with the month's allowance beside them. */
    private Object list(Ctx ctx) {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        String product = ctx.query.get("product");
        if (product != null && product.isEmpty()) {
            product = null;
        }
        if (product != null && !product.equals("attest") && !product.equals("remit") && !product.equals("por")) {
            throw new HttpError(400, "unknown_product", "product must be one of: attest, remit, por");
        }
        Map<String, Object> out = data(svc.list(orgId, Router.pageLimit(ctx.query.get("limit"), 50, 500), product));
        out.put("quota", quota(orgId));
        return out;
    }

    private Map<String, Object> withQuota(Map<String, Object> record, String orgId) {
        Map<String, Object> out = new LinkedHashMap<>(record);
        out.put("quota", quota(orgId));
        return out;
    }

    private Object create(Ctx ctx) throws Exception {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        requireQuota(orgId);
        Map<String, Object> body = Body.fields(ctx.body());
        Object raw = body.get("sha256") != null ? body.get("sha256") : body.get("leaf_bytes");
        if (!(raw instanceof String)) {
            throw new HttpError(400, "missing_digest",
                    "provide \"sha256\": the SHA-256 of your file as 64 hex characters. Hash it locally — the file is never uploaded.");
        }
        AttestService.Issue opts = new AttestService.Issue();
        opts.contentType = AttestService.storable(body.get("content_type"));
        opts.descriptor = body.get("descriptor");
        return new HttpResult(201, withQuota(svc.issue(orgId, (String) raw, opts), orgId));
    }

    /** The document itself, to be inscribed whole; the same path, the same limits and the same margin as the keyed route. */
    private Object inscribe(Ctx ctx) throws Exception {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        requireQuota(orgId);
        String contentType = ctx.header("content-type") != null ? ctx.header("content-type") : "application/octet-stream";
        byte[] body = ctx.raw(cfg.inscriptionMaxBytes + 64 * 1024);
        if (body.length == 0) {
            throw new HttpError(400, "empty_body", "send the document as the raw request body");
        }
        return new HttpResult(201, withQuota(svc.inscribe(orgId, body, contentType, null, "api"), orgId));
    }

    private Object createSigned(Ctx ctx) throws Exception {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        requireQuota(orgId);
        Map<String, Object> body = Body.fields(ctx.body());
        Object statement = body.get("statement");
        if (!(statement instanceof Map) && !(statement instanceof List)) {
            throw new HttpError(400, "missing_statement", "provide a signed statement");
        }
        if (statement instanceof List) {
            // A list has no schema to be a statement of.
            throw new ServiceError(400, "invalid_statement", "statement schema must be " + Statement.SCHEMA);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> signed = (Map<String, Object>) statement;
        return new HttpResult(201, withQuota(svc.issueSigned(orgId, signed, null), orgId));
    }

    private Object registerIssuerKey(Ctx ctx) throws Exception {
        Map<String, Object> account = requireAccount(ctx);
        Map<String, Object> body = Body.fields(ctx.body());
        String publicKey = body.get("public_key") instanceof String ? Js.trim((String) body.get("public_key")) : "";
        if (publicKey.isEmpty()) {
            throw new HttpError(400, "missing_public_key", "provide \"public_key\" (SPKI, base64)");
        }
        String algorithm = "RS256".equals(body.get("algorithm")) ? "RS256" : "ES256";
        // Before anything is stored: a private key is refused by name, and an ES256 key must be
        // P-256 — the same checks as the keyed route's.
        PublicKeys.Problem problem = algorithm.equals("ES256") ? PublicKeys.es256Problem(publicKey) : PublicKeys.problem(publicKey);
        if (problem != null) {
            throw new HttpError(400, problem.code, "public_key is " + problem.message + ". Nothing was stored.");
        }
        Map<String, Object> reg = svc.registerIssuerKey((String) account.get("org_id"), publicKey, cleanLabel(body.get("label")), algorithm);
        return new HttpResult(Boolean.TRUE.equals(reg.get("already")) ? 200 : 201, reg);
    }

    // ── API keys ─────────────────────────────────────────────────────────────

    private Object createKey(Ctx ctx) throws Exception {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        if (mapper.activeKeyCount(orgId) >= MAX_ACTIVE_KEYS) {
            throw new HttpError(409, "too_many_keys", "this org already has " + MAX_ACTIVE_KEYS + " active keys; revoke one before issuing another");
        }
        Map<String, Object> body = Body.fields(ctx.body());
        String secret = ApiKeys.mint(cfg.keyPrefix());
        String id = UUID.randomUUID().toString();
        keys.insertApiKey(id, orgId, ApiKeys.hash(secret), cfg.keyPrefix(), cleanLabel(body.get("label")), IsoTime.now());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("prefix", cfg.keyPrefix());
        out.put("api_key_secret", secret);
        out.put("note", "Store this key now — only its hash is kept, so it cannot be shown again.");
        return new HttpResult(201, out);
    }

    /** A new key, and the newest of the old ones stopped in the same call: what a leaked key needs. */
    private Object rotateKey(Ctx ctx) {
        Map<String, Object> account = requireAccount(ctx);
        String orgId = (String) account.get("org_id");
        Map<String, Object> previous = mapper.newestActiveKey(orgId);
        String secret = ApiKeys.mint(cfg.keyPrefix());
        keys.insertApiKey(UUID.randomUUID().toString(), orgId, ApiKeys.hash(secret), cfg.keyPrefix(), "rotated", IsoTime.now());
        Map<String, Object> revoked = null;
        if (previous != null) {
            mapper.revokeKeyById(IsoTime.now(), (String) previous.get("id"));
            revoked = new LinkedHashMap<>();
            revoked.put("id", previous.get("id"));
            revoked.put("at", IsoTime.now());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("api_key_secret", secret);
        out.put("revoked", revoked);
        out.put("note", "Store this key now — it is not recoverable. The previous key stopped working immediately.");
        return new HttpResult(201, out);
    }

    // ── the audit trail ──────────────────────────────────────────────────────

    private Object auditPage(Ctx ctx) {
        Map<String, Object> account = requireAccount(ctx);
        AuditSearch.Filter f = new AuditSearch.Filter();
        f.service = given(ctx, "service");
        f.actorType = given(ctx, "actor_type");
        f.from = given(ctx, "from");
        f.to = given(ctx, "to");
        f.q = given(ctx, "q");
        f.cursor = given(ctx, "cursor");
        String limit = ctx.query.get("limit");
        f.limit = Js.toNumber(limit == null ? "50" : limit);
        AuditSearch.Page page = audit.search((String) account.get("org_id"), f);
        Map<String, Object> paging = new LinkedHashMap<>();
        paging.put("returned", page.items.size());
        paging.put("next_cursor", page.nextCursor);
        Map<String, Object> out = data(page.items);
        out.put("page", paging);
        return out;
    }

    /** A query parameter that was given a value; one given empty is one not given. */
    private static String given(Ctx ctx, String name) {
        String v = ctx.query.get(name);
        return v == null || v.isEmpty() ? null : v;
    }

    // ── one of the organisation's own transactions, as the node sees it ──────

    private Object tx(Ctx ctx) {
        Map<String, Object> account = requireAccount(ctx);
        String txid = param(ctx, "txid");
        if (!TXID.matcher(txid).matches()) {
            throw new HttpError(400, "invalid_txid", "a txid is 64 hex characters");
        }
        txid = txid.toLowerCase(java.util.Locale.ROOT);
        // Not a block explorer: only a transaction that anchors one of the caller's own records is looked up.
        if (mapper.recordUsingTx((String) account.get("org_id"), txid) == null) {
            throw new HttpError(404, "not_found",
                    "no anchor of yours used this transaction. This view reports on your own anchors, not on the chain at large.");
        }
        return lookupTx(txid);
    }

    /**
     * Where a transaction stands: waiting in the node's mempool, in the
     * wallet with or without a block, or unknown to the node. Read-only, and
     * short on patience: the screen is waiting.
     */
    private Map<String, Object> lookupTx(String txid) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("txid", txid);
        out.put("network", cfg.bitcoinNetwork);
        out.put("backend", "bitcoind:" + cfg.bitcoinNetwork);
        if (!cfg.explorerBaseUrl.isEmpty()) {
            out.put("explorer_url", cfg.explorerBaseUrl + "/tx/" + txid);
        }

        try {
            Object entry = rpc.call("getmempoolentry", List.of(txid), "", LOOKUP_TIMEOUT);
            out.put("state", "mempool");
            Map<?, ?> e = (Map<?, ?>) entry;
            out.put("vsize", e.get("vsize"));
            out.put("weight", e.get("weight"));
            out.put("fee_sats", Billing.round(((Number) ((Map<?, ?>) e.get("fees")).get("base")).doubleValue() * 1e8));
            out.put("seen_at", IsoTime.ofEpochMilli((long) (((Number) e.get("time")).doubleValue() * 1000)));
            return out;
        } catch (BitcoindRpc.RpcError notWaiting) {
            // Not in the mempool; the wallet may still know it.
        } catch (BitcoindRpc.RpcUnavailable | RuntimeException e) {
            out.put("state", "unavailable");
            Log.line("console tx lookup: node unavailable", Log.fields("error", e.getClass().getSimpleName()));
            out.put("detail", "the node did not answer");
            return out;
        }

        try {
            Map<?, ?> tx = (Map<?, ?>) rpc.call("gettransaction", Arrays.asList(txid, true, true), cfg.bitcoind.wallet, LOOKUP_TIMEOUT);
            double confirmations = ((Number) tx.get("confirmations")).doubleValue();
            out.put("state", confirmations > 0 ? "confirmed" : "pending");
            out.put("confirmations", tx.get("confirmations"));
            if (Body.truthy(tx.get("blockhash"))) {
                out.put("block_hash", tx.get("blockhash"));
            }
            if (tx.get("blockheight") instanceof Number) {
                out.put("block_height", tx.get("blockheight"));
            }
            if (tx.get("blocktime") instanceof Number) {
                out.put("block_time", IsoTime.ofEpochMilli((long) (((Number) tx.get("blocktime")).doubleValue() * 1000)));
            }
            out.put("size_bytes", ((String) tx.get("hex")).length() / 2.0);
        } catch (BitcoindRpc.RpcError e) {
            out.put("state", "unknown");
            out.put("detail", "the node has no record of this transaction");
        } catch (BitcoindRpc.RpcUnavailable | RuntimeException e) {
            out.put("state", "unknown");
            out.put("detail", "the node did not answer");
        }
        return out;
    }
}
