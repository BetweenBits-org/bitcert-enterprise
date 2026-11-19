package com.stonehash.attest.core.auth;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Sandbox console accounts and their sessions.
 *
 * <p>The keyed API has no accounts: a bearer key is the whole credential.
 * What a key cannot do is let a person close the tab and come back, so the
 * console has sign-in — for quota attribution, key rotation and abuse
 * control, each of which needs a durable identity.
 *
 * <p>Sessions are stored, not self-contained: a signed cookie cannot be
 * revoked before it expires, which would make "sign out" a word without a
 * meaning. The cookie carries a random token and the table holds its hash,
 * so a copy of the table cannot be replayed as a signed-in browser. The
 * servlet container's own sessions are not used.
 */
@Component
public class Accounts {
    static final long SESSION_TTL_MS = 14L * 24 * 60 * 60 * 1000;

    /** JavaScript's white space, as a character class body: an address is checked as the reference checked it. */
    private static final String SPACE = "\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";
    /** One {@code @}, something either side, a dot in the domain. Deliberately not a full RFC 5322 attempt. */
    private static final Pattern EMAIL = Pattern.compile("[^" + SPACE + "@]+@[^" + SPACE + "@.]+(\\.[^" + SPACE + "@.]+)+");

    /** {@code Wed, 02 Dec 2026 09:10:11 GMT} — the date of a cookie's {@code Expires}. */
    private static final DateTimeFormatter HTTP_DATE =
            DateTimeFormatter.ofPattern("EEE, dd MMM uuuu HH:mm:ss 'GMT'", Locale.ENGLISH).withZone(ZoneOffset.UTC);

    private static final SecureRandom RANDOM = new SecureRandom();

    private final AuthMapper mapper;

    public Accounts(AuthMapper mapper) {
        this.mapper = mapper;
    }

    // ── what is accepted ─────────────────────────────────────────────────────

    /** The address as it is stored — trimmed, lower case — or {@code null} where it is not one that could be delivered to. */
    public static String normaliseEmail(Object input) {
        if (!(input instanceof String)) {
            return null;
        }
        String email = Js.trim((String) input).toLowerCase(Locale.ROOT);
        if (email.length() < 5 || email.length() > 254) {
            return null;
        }
        return EMAIL.matcher(email).matches() ? email : null;
    }

    /**
     * What is wrong with a password, or {@code null}. Length is the only
     * rule: it is the one that reliably helps, and composition rules push
     * people towards {@code Password1!}.
     */
    public static String passwordProblem(Object password) {
        if (!(password instanceof String)) {
            return "a password is required";
        }
        int length = ((String) password).length();
        if (length < 10) {
            return "the password must be at least 10 characters";
        }
        if (length > 200) {
            return "the password must be at most 200 characters";
        }
        return null;
    }

    // ── accounts ─────────────────────────────────────────────────────────────

    /** The whole row, {@code password_hash} with it, or {@code null}. */
    public Map<String, Object> findByEmail(String email) {
        return mapper.accountByEmail(email);
    }

    /** {@code id, email, org_id, created_at, last_login_at, disabled_at} of the new account. */
    public Map<String, Object> create(String email, String password, String orgId) {
        String id = UUID.randomUUID().toString();
        mapper.insertAccount(id, email, Passwords.hash(password), orgId, IsoTime.now());
        return mapper.accountById(id);
    }

    public void recordLogin(String accountId) {
        mapper.recordLogin(accountId, IsoTime.now());
    }

    // ── sessions ─────────────────────────────────────────────────────────────

    /** A session just made: the token goes into the cookie and is not kept; the table holds its hash. */
    public static final class Session {
        public final String token;
        public final long expiresAtMs;

        Session(String token, long expiresAtMs) {
            this.token = token;
            this.expiresAtMs = expiresAtMs;
        }
    }

    public Session createSession(String accountId, String userAgent) {
        byte[] random = new byte[32];
        RANDOM.nextBytes(random);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(random);
        long now = System.currentTimeMillis();
        String agent = userAgent == null ? "" : userAgent;
        mapper.insertSession(ApiKeys.hash(token), accountId, IsoTime.ofEpochMilli(now), IsoTime.ofEpochMilli(now + SESSION_TTL_MS),
                agent.length() > 200 ? agent.substring(0, 200) : agent);
        return new Session(token, now + SESSION_TTL_MS);
    }

    /** Signing out deletes the session; clearing the cookie alone would leave it usable. */
    public void destroySession(String token) {
        if (token == null || token.isEmpty()) {
            return;
        }
        mapper.deleteSession(ApiKeys.hash(token));
    }

    /** Every other session of the account — what "sign out everywhere else" needs. */
    public void destroyOtherSessions(String accountId, String keepToken) {
        mapper.deleteOtherSessions(accountId, ApiKeys.hash(keepToken));
    }

    // ── the cookie ───────────────────────────────────────────────────────────

    /**
     * {@code Set-Cookie} for a session. {@code HttpOnly}, so that a script
     * cannot read it; {@code SameSite=Lax}, so that it does not ride along on
     * a cross-site POST — the console has no CSRF token, and {@code Lax} is
     * what makes that safe. {@code Secure} is configuration: the test server
     * is plain HTTP, where a {@code Secure} cookie would never be stored.
     */
    public static String sessionCookie(String token, long expiresAtMs, boolean secure) {
        return Auth.SESSION_COOKIE + "=" + token + "; Path=/; Expires=" + HTTP_DATE.format(Instant.ofEpochMilli(expiresAtMs))
                + "; HttpOnly; SameSite=Lax" + (secure ? "; Secure" : "");
    }

    public static String clearedCookie(boolean secure) {
        return Auth.SESSION_COOKIE + "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax" + (secure ? "; Secure" : "");
    }
}
