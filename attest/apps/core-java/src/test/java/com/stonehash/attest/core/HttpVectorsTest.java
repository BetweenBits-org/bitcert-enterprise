package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.RequestTarget;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * How a request is read and how the settings are read, held to the service
 * this one replaces: {@code vectors/http.json} was written by Node's own URL
 * parser and by that service's {@code pageLimit} and {@code loadConfig}.
 */
class HttpVectorsTest {
    private static final Map<String, Object> V = Vectors.load("http.json");

    /**
     * Hosts whose names are beyond what {@code net.Urls} checks: none in the
     * vectors today. A request target that names a host is nothing a client
     * of this API sends; the reader is exact for plain names and IPv4.
     */
    private static void none(List<String> failures, String what, int ran, int atLeast) {
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " " + what + " differ from the reference:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= atLeast, "the vectors were read: " + ran + " " + what);
    }

    @Test
    void readsARequestTargetAsTheUrlStandardDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "requestTargets")) {
            ran++;
            String name = Js.stringify(c.get("path")) + (c.get("query") == null ? "" : " ? " + Js.stringify(c.get("query")));
            RequestTarget t;
            try {
                t = RequestTarget.parse((String) c.get("path"), (String) c.get("query"));
            } catch (HttpError e) {
                if (!Boolean.TRUE.equals(c.get("fails"))) {
                    failures.add(name + ": refused, the reference reads it as " + c.get("pathname"));
                } else if (e.status() != 400 || !e.code().equals("invalid_path") || !e.getMessage().equals("the request target is not a valid URL")) {
                    failures.add(name + ": refused as " + e.status() + " " + e.code() + " " + e.getMessage());
                }
                continue;
            }
            if (Boolean.TRUE.equals(c.get("fails"))) {
                failures.add(name + ": read as " + t.pathname + ", the reference refuses it");
                continue;
            }
            List<Object> params = new ArrayList<>();
            for (String[] pair : t.query.entries()) {
                params.add(java.util.Arrays.asList(pair[0], pair[1]));
            }
            Map<String, Object> got = new LinkedHashMap<>();
            got.put("pathname", t.pathname);
            got.put("search", t.search);
            got.put("params", params);
            got.put("collapsed", t.pathname.replaceAll("/{2,}", "/"));
            for (String key : got.keySet()) {
                if (!Js.stringify(got.get(key)).equals(Js.stringify(c.get(key)))) {
                    failures.add(name + ": " + key + " " + Js.stringify(got.get(key)) + ", expected " + Js.stringify(c.get(key)));
                }
            }
        }
        none(failures, "request targets", ran, 110);
    }

    @Test
    void decodesAPathParameterAsDecodeUriComponentDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "decode")) {
            ran++;
            String got = Router.decodeUriComponent((String) c.get("text"));
            Object expected = Boolean.TRUE.equals(c.get("fails")) ? null : c.get("decoded");
            if (got == null ? expected != null : !got.equals(expected)) {
                failures.add(Js.stringify(c.get("text")) + ": " + (got == null ? "refused" : Js.stringify(got)) + ", expected "
                        + (expected == null ? "a refusal" : Js.stringify(expected)));
            }
        }
        none(failures, "escapes", ran, 35);
    }

    @Test
    void readsAPageSizeAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "limits")) {
            ran++;
            long got = Router.pageLimit((String) c.get("raw"), ((Double) c.get("dflt")).longValue(), ((Double) c.get("max")).longValue());
            if (got != ((Double) c.get("limit")).longValue()) {
                failures.add("limit=" + Js.stringify(c.get("raw")) + " (default " + c.get("dflt") + ", at most " + c.get("max") + "): " + got + ", expected " + c.get("limit"));
            }
        }
        none(failures, "page sizes", ran, 150);
    }

    @Test
    void readsTheSettingsAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int refused = 0;
        for (Map<String, Object> c : Vectors.cases(V, "settings")) {
            ran++;
            @SuppressWarnings("unchecked")
            Map<String, String> env = (Map<String, String>) c.get("env");
            String name = Js.stringify(env);
            CoreConfig cfg;
            try {
                cfg = CoreConfig.load(EnvSource.of(env));
            } catch (ConfigError e) {
                refused++;
                if (c.get("error") == null) {
                    failures.add(name + ": refused (" + e.getMessage() + "), the reference accepts it");
                } else if (!c.get("error").equals(e.getMessage())) {
                    failures.add(name + ": refused with\n      " + e.getMessage() + "\n    expected\n      " + c.get("error"));
                }
                continue;
            }
            if (c.get("error") != null) {
                failures.add(name + ": accepted, the reference refuses it: " + c.get("error"));
                continue;
            }
            String got = Js.stringify(asTheReferenceShapesIt(cfg));
            String expected = Js.stringify(c.get("config"));
            if (!got.equals(expected)) {
                failures.add(name + ":\n      " + got + "\n    expected\n      " + expected);
            }
        }
        none(failures, "settings", ran, 80);
        assertTrue(refused >= 30, refused + " settings were refused");
    }

    @Test
    void sortsRequestsReadsCookiesAndCountsAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "audit")) {
            ran++;
            String path = (String) c.get("path");
            if (!com.stonehash.attest.core.audit.Audit.serviceOf(path).equals(c.get("service"))) {
                failures.add("service of " + path + ": " + com.stonehash.attest.core.audit.Audit.serviceOf(path) + ", expected " + c.get("service"));
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> audited = (Map<String, Object>) c.get("audited");
            for (Map.Entry<String, Object> m : audited.entrySet()) {
                if (com.stonehash.attest.core.audit.Audit.isAudited(m.getKey(), path) != Boolean.TRUE.equals(m.getValue())) {
                    failures.add(m.getKey() + " " + path + " audited: expected " + m.getValue());
                }
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "cookies")) {
            ran++;
            String got = com.stonehash.attest.core.auth.Auth.cookieToken((String) c.get("header"));
            if (got == null ? c.get("token") != null : !got.equals(c.get("token"))) {
                failures.add("cookie " + Js.stringify(c.get("header")) + ": " + got + ", expected " + c.get("token"));
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "addresses")) {
            ran++;
            String got = com.stonehash.attest.core.http.RateLimiter.clientKey((String) c.get("xff"), (String) c.get("socket"), Boolean.TRUE.equals(c.get("trustProxy")));
            if (!got.equals(c.get("key"))) {
                failures.add("address of " + Js.stringify(c) + ": " + got);
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "limiters")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> options = (Map<String, Object>) c.get("options");
            com.stonehash.attest.core.http.RateLimiter limiter = new com.stonehash.attest.core.http.RateLimiter(
                    ((Double) options.get("windowMs")).longValue(), ((Double) options.get("max")).longValue());
            for (Map<String, Object> e : Vectors.cases(c, "events")) {
                ran++;
                Long wait = limiter.check((String) e.get("key"), ((Double) e.get("now")).longValue());
                Long expected = e.get("wait") == null ? null : ((Double) e.get("wait")).longValue();
                if (wait == null ? expected != null : !wait.equals(expected)) {
                    failures.add("limiter " + Js.stringify(options) + " at " + Js.stringify(e) + ": " + wait);
                }
            }
        }
        none(failures, "audit, cookie, address and limiter answers", ran, 130);
    }

    /** The settings in the shape, the key order and the names of the reference's {@code Config}. */
    private static Map<String, Object> asTheReferenceShapesIt(CoreConfig c) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("env", c.env);
        out.put("port", c.port);
        out.put("host", c.host);
        out.put("dataDir", c.dataDir);
        out.put("dbUrl", c.dbUrl);
        out.put("anchorBackend", c.anchorBackend);
        out.put("bitcoinNetwork", c.bitcoinNetwork);
        out.put("bitcoind", map("url", c.bitcoind.url, "user", c.bitcoind.user, "password", c.bitcoind.password, "wallet", c.bitcoind.wallet));
        out.put("batch", map("maxLeaves", c.batch.maxLeaves, "flushIntervalMs", c.batch.flushIntervalMs));
        out.put("explorerBaseUrl", c.explorerBaseUrl);
        out.put("inscriptionMaxBytes", c.inscriptionMaxBytes);
        out.put("workerTickMs", c.workerTickMs);
        out.put("publicBaseUrl", c.publicBaseUrl);
        out.put("playgroundDir", c.playgroundDir);
        out.put("docsDir", c.docsDir);
        out.put("consoleDir", c.consoleDir);
        out.put("console", map("enabled", c.console.enabled, "cookieSecure", c.console.cookieSecure, "monthlyQuota", c.console.monthlyQuota,
                "authRateLimit", map("windowMs", c.console.authRateLimit.windowMs, "max", c.console.authRateLimit.max)));
        out.put("trustProxy", c.trustProxy);
        out.put("signupRateLimit", map("windowMs", c.signupRateLimit.windowMs, "max", c.signupRateLimit.max));
        out.put("publicAnchor", map("enabled", c.publicAnchor.enabled,
                "rateLimit", map("windowMs", c.publicAnchor.rateLimit.windowMs, "max", c.publicAnchor.rateLimit.max),
                "globalRateLimit", map("windowMs", c.publicAnchor.globalRateLimit.windowMs, "max", c.publicAnchor.globalRateLimit.max),
                "retentionDays", c.publicAnchor.retentionDays, "allowedOrigins", c.publicAnchor.allowedOrigins));
        out.put("remit", map("enabled", c.remit.enabled, "partnersBase", c.remit.partnersBase, "adminToken", c.remit.adminToken,
                "platformKeyPath", c.remit.platformKeyPath, "acceptDemoFinality", c.remit.acceptDemoFinality, "quoteTtlMs", c.remit.quoteTtlMs,
                "rates", map("usdVnd", c.remit.rateUsdVnd, "usdSgd", c.remit.rateUsdSgd), "feeUsd", c.remit.feeUsd, "chainLabel", c.remit.chainLabel,
                "explorerTxUrl", c.remit.explorerTxUrl, "chainRpc", c.remit.chainRpc, "webhookMaxAttempts", c.remit.webhookMaxAttempts,
                "porChainRpc", c.remit.porChainRpc));
        out.put("pricing", map("currency", c.pricing.currency, "attest", c.pricing.attest, "por", c.pricing.por, "remit", c.pricing.remit));
        return out;
    }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }
}
