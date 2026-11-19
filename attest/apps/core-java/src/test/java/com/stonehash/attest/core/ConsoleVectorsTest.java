package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.audit.AuditMapper;
import com.stonehash.attest.core.audit.AuditSearch;
import com.stonehash.attest.core.auth.Accounts;
import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.auth.Passwords;
import com.stonehash.attest.core.console.Billing;
import com.stonehash.attest.core.console.ConsoleRoutes;
import com.stonehash.attest.core.console.ProductRoutes;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The pure parts of the console held to the reference: every answer in
 * {@code vectors/console.json} was given by {@code apps/core/src/account.ts},
 * {@code audit.ts} and {@code billing.ts}
 * ({@code tools/make-console-vectors.mjs}).
 */
class ConsoleVectorsTest {
    private static final Map<String, Object> V = Vectors.load("console.json");

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    private static void none(List<String> failures, String what) {
        assertTrue(failures.isEmpty(), failures.size() + " " + what + " differ from the reference:\n  " + String.join("\n  ", failures));
    }

    // ── passwords ────────────────────────────────────────────────────────────

    /**
     * A stored password verifies here exactly when it verified there — but
     * for the cases the vector file itself lists as stricter on purpose
     * (docs/JAVA-INTENDED-DIFFERENCES.md, D-10): there the reference has to
     * have said yes and this service has to say no, or the row is out of date.
     */
    @Test
    void verifiesAStoredPasswordAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int matched = 0;
        int stricter = 0;
        for (Map<String, Object> c : Vectors.cases(V, "passwords")) {
            ran++;
            boolean reference = Boolean.TRUE.equals(c.get("verifies"));
            boolean expected = c.containsKey("java") ? Boolean.TRUE.equals(c.get("java")) : reference;
            boolean actual = Passwords.verify((String) c.get("password"), (String) c.get("stored"));
            matched += actual ? 1 : 0;
            if (c.containsKey("java")) {
                stricter++;
                if (!reference || expected) {
                    failures.add(c.get("name") + ": listed as stricter here, but the reference says " + reference);
                }
            }
            if (actual != expected) {
                failures.add(c.get("name") + ": " + actual + ", expected " + expected + (c.containsKey("why") ? " (" + c.get("why") + ")" : ""));
            }
        }
        none(failures, "stored passwords");
        assertTrue(ran >= 80 && matched >= 30 && stricter == 5, ran + " stored passwords, " + matched + " matched, " + stricter + " stricter on purpose");
    }

    @Test
    void aNewPasswordIsStoredAsTheReferenceStoresOne() {
        String stored = Passwords.hash("a password long enough");
        String[] parts = stored.split("\\$", -1);
        assertEquals(6, parts.length, stored);
        assertEquals("scrypt$32768$8$1", String.join("$", Arrays.copyOf(parts, 4)));
        assertEquals(24, parts[4].length(), "a salt of 16 bytes, in standard base64 with its padding");
        assertEquals(44, parts[5].length(), "a digest of 32 bytes, in standard base64 with its padding");
        assertTrue(parts[4].endsWith("==") && parts[5].endsWith("=") && !stored.contains("-") && !stored.contains("_"), stored);
        assertTrue(Passwords.verify("a password long enough", stored));
        assertTrue(!Passwords.verify("a password long enough ", stored));
        assertTrue(!stored.equals(Passwords.hash("a password long enough")), "a salt of its own each time");
    }

    // ── addresses and passwords as they are accepted ─────────────────────────

    @Test
    void acceptsAddressesAndPasswordsAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "emails")) {
            ran++;
            String actual = Accounts.normaliseEmail(c.get("input"));
            if (!java.util.Objects.equals(actual, c.get("normalised"))) {
                failures.add("address " + Js.stringify(c.get("input")) + ": " + Js.stringify(actual) + ", expected " + Js.stringify(c.get("normalised")));
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "passwordProblems")) {
            ran++;
            String actual = Accounts.passwordProblem(c.get("input"));
            if (!java.util.Objects.equals(actual, c.get("problem"))) {
                failures.add("password " + Js.stringify(c.get("input")) + ": " + actual + ", expected " + c.get("problem"));
            }
        }
        none(failures, "answers");
        assertTrue(ran >= 55, ran + " addresses and passwords");
    }

    // ── cookies ──────────────────────────────────────────────────────────────

    @Test
    void writesAndReadsTheSessionCookieAsTheReferenceDoes() {
        Map<String, Object> cookies = map(V.get("cookies"));
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(cookies, "set")) {
            ran++;
            String actual = Accounts.sessionCookie((String) c.get("token"), ((Double) c.get("expiresAt")).longValue(), Boolean.TRUE.equals(c.get("secure")));
            if (!actual.equals(c.get("cookie"))) {
                failures.add("set: " + actual + "\n      expected " + c.get("cookie"));
            }
        }
        for (Map<String, Object> c : Vectors.cases(cookies, "cleared")) {
            ran++;
            String actual = Accounts.clearedCookie(Boolean.TRUE.equals(c.get("secure")));
            if (!actual.equals(c.get("cookie"))) {
                failures.add("cleared: " + actual + "\n      expected " + c.get("cookie"));
            }
        }
        for (Map<String, Object> c : Vectors.cases(cookies, "read")) {
            ran++;
            String actual = Auth.cookieToken((String) c.get("header"));
            if (!java.util.Objects.equals(actual, c.get("token"))) {
                failures.add("read " + Js.stringify(c.get("header")) + ": " + Js.stringify(actual) + ", expected " + Js.stringify(c.get("token")));
            }
        }
        none(failures, "cookies");
        assertTrue(ran >= 55, ran + " cookies");
    }

    // ── the audit trail: what the store is asked ─────────────────────────────

    /** A store that answers with the rows it was given and keeps what it was asked. */
    private static final class Asked implements AuditMapper {
        final List<Map<String, Object>> rows;
        String from;
        String to;
        String like;
        String cursorAt;
        String cursorId;
        long limit;

        Asked(List<Map<String, Object>> rows) {
            this.rows = rows;
        }

        @Override
        public int insert(String id, String orgId, String at, String actorType, String actorId, String actorLabel, String service, String method,
                String path, int status, long durationMs) {
            throw new UnsupportedOperationException();
        }

        @Override
        public List<Map<String, Object>> search(String orgId, String service, String actorType, String from, String to, String like, String cursorAt,
                String cursorId, long limit) {
            this.from = from;
            this.to = to;
            this.like = like;
            this.cursorAt = cursorAt;
            this.cursorId = cursorId;
            this.limit = limit;
            return rows;
        }
    }

    private static double number(Object v) {
        return v == null ? Double.NaN : v instanceof Double ? (Double) v : "Infinity".equals(v) ? Double.POSITIVE_INFINITY
                : "-Infinity".equals(v) ? Double.NEGATIVE_INFINITY : Double.NaN;
    }

    /**
     * Times the reference read as a bound because the JavaScript engine
     * reads them, and that are not ISO 8601 (D-04). The test fails if the
     * reference stops reading one, or this service starts to.
     */
    private static final Set<String> ENGINE_ONLY_TIMES = new LinkedHashSet<>(Arrays.asList("2026-3-2"));

    @Test
    void asksTheStoreForAPageAsTheReferenceDoes() {
        Map<String, Object> audit = map(V.get("audit"));
        List<String> failures = new ArrayList<>();
        int ran = 0;

        for (Map<String, Object> c : Vectors.cases(audit, "limits")) {
            ran++;
            Asked store = new Asked(new ArrayList<>());
            AuditSearch.Filter f = new AuditSearch.Filter();
            f.limit = number(c.get("limit"));
            new AuditSearch(store).search("org", f);
            if (store.limit != ((Double) c.get("rowsAskedFor")).longValue()) {
                failures.add("limit " + c.get("limit") + ": asks for " + store.limit + " rows, expected " + c.get("rowsAskedFor"));
            }
        }

        Set<String> engineOnlySeen = new LinkedHashSet<>();
        for (Map<String, Object> c : Vectors.cases(audit, "bounds")) {
            ran++;
            String raw = (String) c.get("raw");
            for (String side : new String[] { "from", "to" }) {
                Asked store = new Asked(new ArrayList<>());
                AuditSearch.Filter f = new AuditSearch.Filter();
                if (side.equals("from")) {
                    f.from = raw;
                } else {
                    f.to = raw;
                }
                String instant = null;
                String refused = null;
                try {
                    new AuditSearch(store).search("org", f);
                    instant = side.equals("from") ? store.from : store.to;
                } catch (ServiceError e) {
                    refused = e.status() + " " + e.code() + ": " + e.getMessage();
                }
                String expectedRefusal = "400 invalid_filter: " + side + " must be an ISO 8601 instant, got " + Js.stringify(raw);
                if (ENGINE_ONLY_TIMES.contains(raw)) {
                    engineOnlySeen.add(raw);
                    if (c.get("instant") == null || !expectedRefusal.equals(refused)) {
                        failures.add("bound " + Js.stringify(raw) + ": listed as a time only the engine reads — the reference "
                                + (c.get("instant") == null ? "refuses it" : "reads it") + ", this service " + (refused == null ? "reads it" : "says: " + refused));
                    }
                } else if (c.get("instant") != null) {
                    if (!c.get("instant").equals(instant)) {
                        failures.add("bound " + Js.stringify(raw) + " as " + side + ": " + (instant == null ? refused : instant) + ", expected " + c.get("instant"));
                    }
                } else if (!("400 " + c.get("error") + ": " + c.get(side)).equals(refused)) {
                    failures.add("bound " + Js.stringify(raw) + " as " + side + ": " + (refused == null ? "read as " + instant : refused) + ", expected " + c.get(side));
                }
            }
        }
        if (!engineOnlySeen.equals(ENGINE_ONLY_TIMES)) {
            failures.add("the vectors no longer carry every time listed as engine-only: " + engineOnlySeen);
        }

        for (Map<String, Object> c : Vectors.cases(audit, "needles")) {
            ran++;
            Asked store = new Asked(new ArrayList<>());
            AuditSearch.Filter f = new AuditSearch.Filter();
            f.q = (String) c.get("q");
            new AuditSearch(store).search("org", f);
            if (!c.get("pattern").equals(store.like)) {
                failures.add("a piece of a path " + Js.stringify(c.get("q")) + ": " + Js.stringify(store.like) + ", expected " + Js.stringify(c.get("pattern")));
            }
        }

        int cursorsRead = 0;
        for (Map<String, Object> c : Vectors.cases(audit, "cursors")) {
            ran++;
            Asked store = new Asked(new ArrayList<>());
            AuditSearch.Filter f = new AuditSearch.Filter();
            f.cursor = (String) c.get("cursor");
            String answer;
            try {
                new AuditSearch(store).search("org", f);
                answer = store.cursorAt == null ? "none" : Js.stringify(store.cursorAt) + " " + Js.stringify(store.cursorId);
                cursorsRead += store.cursorAt == null ? 0 : 1;
            } catch (ServiceError e) {
                answer = e.status() + " " + e.code() + ": " + e.getMessage();
            }
            String expected = Boolean.TRUE.equals(c.get("none")) ? "none"
                    : c.get("error") != null ? "400 " + c.get("error") + ": " + c.get("message") : Js.stringify(c.get("at")) + " " + Js.stringify(c.get("id"));
            if (!expected.equals(answer)) {
                failures.add("cursor " + Js.stringify(c.get("cursor")) + ": " + answer + ", expected " + expected);
            }
        }

        for (Map<String, Object> c : Vectors.cases(audit, "written")) {
            ran++;
            List<Map<String, Object>> rows = new ArrayList<>();
            rows.add(row((String) c.get("at"), (String) c.get("id")));
            rows.add(row("older", "other"));
            AuditSearch.Filter f = new AuditSearch.Filter();
            f.limit = 1;
            AuditSearch.Page page = new AuditSearch(new Asked(rows)).search("org", f);
            if (!c.get("cursor").equals(page.nextCursor)) {
                failures.add("the cursor after " + Js.stringify(c.get("at")) + " " + Js.stringify(c.get("id")) + ": " + page.nextCursor + ", expected " + c.get("cursor"));
            }
        }

        for (Map<String, Object> c : Vectors.cases(audit, "pages")) {
            ran++;
            int n = ((Double) c.get("rowsFound")).intValue();
            List<Map<String, Object>> rows = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                rows.add(row("t" + String.format("%04d", n - i), "id" + i));
            }
            AuditSearch.Filter f = new AuditSearch.Filter();
            f.limit = (Double) c.get("limit");
            AuditSearch.Page page = new AuditSearch(new Asked(rows)).search("org", f);
            Object last = c.get("last") == null ? null : map(c.get("last")).get("id");
            Object actualLast = page.items.isEmpty() ? null : page.items.get(page.items.size() - 1).get("id");
            if (page.items.size() != ((Double) c.get("returned")).intValue() || !java.util.Objects.equals(page.nextCursor, c.get("next")) || !java.util.Objects.equals(last, actualLast)) {
                failures.add("a page of " + c.get("limit") + " out of " + n + " rows: " + page.items.size() + " rows, next " + page.nextCursor + ", expected "
                        + c.get("returned") + " rows, next " + c.get("next"));
            }
        }

        none(failures, "questions to the store");
        assertTrue(ran >= 120 && cursorsRead >= 10, ran + " questions, " + cursorsRead + " cursors read");
    }

    private static Map<String, Object> row(String at, String id) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("id", id);
        r.put("at", at);
        return r;
    }

    // ── months and bills ─────────────────────────────────────────────────────

    @Test
    void countsAMonthAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "months")) {
            ran++;
            long at = ((Double) c.get("at")).longValue();
            String start = IsoTime.ofEpochMilli(Billing.monthStart(at));
            String next = IsoTime.ofEpochMilli(Billing.nextMonthStart(at));
            if (!start.equals(c.get("start")) || !next.equals(c.get("next"))) {
                failures.add(IsoTime.ofEpochMilli(at) + ": " + start + " to " + next + ", expected " + c.get("start") + " to " + c.get("next"));
            }
        }
        none(failures, "months");
        assertTrue(ran >= 12, ran + " months");
    }

    @SuppressWarnings("unchecked")
    @Test
    void billsAMonthAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int lines = 0;
        for (Map<String, Object> c : Vectors.cases(V, "billing")) {
            ran++;
            Map<String, Object> pricing = map(c.get("pricing"));
            Map<String, Object> usage = map(c.get("usage"));
            Set<String> active = new HashSet<>();
            for (Object a : list(c.get("active"))) {
                active.add((String) a);
            }
            Map<String, Object> actual = Billing.monthlyCharges((String) pricing.get("currency"), (Map<String, Double>) pricing.get("attest"),
                    (Map<String, Double>) pricing.get("por"), (Map<String, Double>) pricing.get("remit"), ((Double) usage.get("anchors")).longValue(),
                    ((Double) usage.get("settlements")).longValue(), ((Double) usage.get("snapshots")).longValue(), active, ((Double) c.get("monthStart")).longValue());
            lines += list(actual.get("lines")).size();
            if (!Js.stringify(actual).equals(Js.stringify(c.get("charges")))) {
                failures.add(c.get("name") + ": " + Js.stringify(actual) + "\n      expected " + Js.stringify(c.get("charges")));
            }
        }
        none(failures, "bills");
        assertTrue(ran >= 100 && lines >= 150, ran + " bills, " + lines + " lines");
    }

    // ── the doors ────────────────────────────────────────────────────────────

    @Test
    void theConsoleIsTheSandboxsAndCanBeSwitchedOff() {
        ConsoleRoutes.requireEnabled(true, "test");
        HttpError off = assertThrows(HttpError.class, () -> ConsoleRoutes.requireEnabled(false, "test"));
        assertEquals("503 console_disabled: the sandbox console is switched off in this deployment", off.status() + " " + off.code() + ": " + off.getMessage());
        // Switched off is said first: a live deployment without a console says that, not the other.
        assertEquals(503, assertThrows(HttpError.class, () -> ConsoleRoutes.requireEnabled(false, "live")).status());
        HttpError live = assertThrows(HttpError.class, () -> ConsoleRoutes.requireEnabled(true, "live"));
        assertEquals("403 not_available: self-serve console accounts are sandbox-only; production access is provisioned per contract",
                live.status() + " " + live.code() + ": " + live.getMessage());

        ProductRoutes.requireConsole(true, "test");
        for (Object[] c : new Object[][] { { false, "test" }, { true, "live" }, { false, "live" } }) {
            HttpError e = assertThrows(HttpError.class, () -> ProductRoutes.requireConsole((Boolean) c[0], (String) c[1]));
            assertEquals("403 console_disabled: the console is not enabled on this deployment", e.status() + " " + e.code() + ": " + e.getMessage());
        }
    }
}
