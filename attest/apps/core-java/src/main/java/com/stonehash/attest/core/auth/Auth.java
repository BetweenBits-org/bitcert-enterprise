package com.stonehash.attest.core.auth;

import com.stonehash.attest.core.audit.AuditActor;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.http.Ctx;
import com.stonehash.attest.core.http.HttpError;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Who a request is: an API key, or — in the sandbox — the console session.
 *
 * <p>The console has to reach the real endpoints, because a sandbox whose
 * answers came from a sandbox-only path would prove nothing about the one a
 * customer integrates against; and the console deliberately keeps no
 * credential in the browser. So the credential differs and nothing else
 * does: same route, same body, same code. In production the cookie never
 * opens the keyed API.
 */
@Component
public class Auth {
    public static final String SESSION_COOKIE = "stonehash_session";

    private final CoreConfig cfg;
    private final AuthMapper mapper;

    public Auth(CoreConfig cfg, AuthMapper mapper) {
        this.cfg = cfg;
        this.mapper = mapper;
    }

    /**
     * The organisation this request acts for; the request is marked with who
     * acted, for the audit trail.
     *
     * @throws HttpError 401 when neither a key nor (in the sandbox) a session admits it
     */
    public String requireAuth(Ctx ctx) {
        Map<String, Object> key = authenticate(ctx.token);
        if (key != null) {
            ctx.audit = AuditActor.key((String) key.get("org_id"), (String) key.get("id"), (String) key.get("label"));
            return (String) key.get("org_id");
        }
        if (cfg.env.equals("test") && cfg.console.enabled) {
            Map<String, Object> account = accountForSession(cookieToken(cookieHeader(ctx)));
            if (account != null) {
                ctx.audit = AuditActor.session((String) account.get("org_id"), (String) account.get("id"), (String) account.get("email"));
                return (String) account.get("org_id");
            }
        }
        throw new HttpError(401, "unauthorized", "supply a valid " + cfg.keyPrefix() + "… key as \"Authorization: Bearer <key>\"");
    }

    /**
     * The key a bearer token is, or {@code null}. A key whose prefix belongs
     * to the other environment is refused before the database is asked: a
     * {@code sk_live_} token presented to the sandbox is a configuration
     * mistake, not a lookup miss.
     */
    Map<String, Object> authenticate(String token) {
        if (token == null || token.isEmpty() || !token.startsWith(cfg.keyPrefix())) {
            return null;
        }
        String hash = ApiKeys.hash(token);
        Map<String, Object> found = mapper.apiKeyByHash(hash);
        if (found == null) {
            return null;
        }
        // The lookup already matched on the hash; this guards a future change that widens the query.
        if (!MessageDigest.isEqual(String.valueOf(found.get("key_hash")).getBytes(StandardCharsets.US_ASCII), hash.getBytes(StandardCharsets.US_ASCII))) {
            return null;
        }
        return found;
    }

    /** The request's Cookie header; several headers read as one, as the previous server joined them. */
    public static String cookieHeader(Ctx ctx) {
        List<String> all = ctx.req.getHeaders("cookie") == null ? new ArrayList<>() : Collections.list(ctx.req.getHeaders("cookie"));
        return all.isEmpty() ? null : String.join("; ", all);
    }

    /** The session token in a Cookie header, or {@code null}. The first cookie of that name decides. */
    public static String cookieToken(String header) {
        if (header == null || header.isEmpty()) {
            return null;
        }
        for (String part : header.split(";", -1)) {
            int eq = part.indexOf('=');
            if (eq < 1) {
                continue;
            }
            if (com.stonehash.attest.core.json.Js.trim(part.substring(0, eq)).equals(SESSION_COOKIE)) {
                String value = com.stonehash.attest.core.json.Js.trim(part.substring(eq + 1));
                return value.isEmpty() ? null : value;
            }
        }
        return null;
    }

    /**
     * The account a session cookie belongs to, or {@code null}. An expired
     * row is deleted on the way past rather than left to a sweeper: the
     * request already found it.
     */
    public Map<String, Object> accountForSession(String token) {
        if (token == null || token.isEmpty()) {
            return null;
        }
        String hash = ApiKeys.hash(token);
        Map<String, Object> found = mapper.sessionByHash(hash);
        if (found == null) {
            return null;
        }
        if (expired(String.valueOf(found.get("expires_at")))) {
            mapper.deleteSession(hash);
            return null;
        }
        Map<String, Object> account = mapper.accountById((String) found.get("account_id"));
        if (account == null || (account.get("disabled_at") != null && !"".equals(account.get("disabled_at")))) {
            return null;
        }
        return account;
    }

    private static boolean expired(String expiresAt) {
        try {
            return Instant.parse(expiresAt).toEpochMilli() <= System.currentTimeMillis();
        } catch (DateTimeParseException e) {
            // A time that cannot be read is not a time that has passed; the reference read it the same way.
            return false;
        }
    }
}
