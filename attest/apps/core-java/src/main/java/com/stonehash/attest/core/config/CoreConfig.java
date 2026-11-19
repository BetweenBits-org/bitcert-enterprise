package com.stonehash.attest.core.config;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.net.Urls;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Configuration — entirely from the environment, with no path or host name
 * compiled in.
 *
 * <p>The variable names, their defaults and the sentences a wrong value is
 * refused with are those of the service this one replaces
 * ({@code apps/core/src/config.ts}), read in the same order, so that the
 * environment file that runs that one runs this. Three things differ, all on
 * purpose:
 * <ul>
 * <li>{@code STONEHASH_DB_URL} is required. There is no file database to fall
 *     back to, and a service that starts on an empty store nobody asked for
 *     is worse than one that says what is missing.
 * <li>{@code STONEHASH_CUTOVER_APPROVED} is new. While both services exist,
 *     this one does not attach to the live schema or the live wallet without
 *     it ({@link #refuseLiveStoreUnlessApproved}).
 * <li>{@code REMIT_STEP_RETRY_MS} and {@code REMIT_INTAKE_PAUSED} are new: the
 *     settlement rail's retry delays, and the switch that stops new quotes
 *     and settlements while what is under way is finished.
 * </ul>
 */
public final class CoreConfig {
    /** What an ordinary Bitcoin node will relay as the body of an inscription. */
    public static final long STANDARD_RELAY_MAX_BODY_BYTES = 390_000;
    /** The last-line guard on an inscription's size, whatever is configured. */
    public static final long HARD_CEILING_BYTES = 3_500_000;
    /** The size this deployment inscribes by default. */
    public static final long DEFAULT_SOFT_CAP_BYTES = 100_000;

    /** The schema and the wallet the service in production uses on this installation. */
    static final String LIVE_SCHEMA = "stonehash_attest";
    static final String LIVE_WALLET = "attest";

    /** {@code test} keys and {@code live} keys never share a database or an anchor backend. */
    public final String env;
    public final long port;
    public final String host;
    public final String dataDir;
    /** {@code mysql://user:pass@host:port/db}. */
    public final String dbUrl;
    public final String anchorBackend;
    /** Written verbatim into every bundle's {@code bitcoin_network}. */
    public final String bitcoinNetwork;
    public final Bitcoind bitcoind;
    public final Batch batch;
    /** Largest document this deployment will inscribe, in bytes: its own policy, within the hard ceiling. */
    public final long inscriptionMaxBytes;
    /** Base URL of a block explorer that indexes this chain, or {@code ""}. */
    public final String explorerBaseUrl;
    /** {@code 0} turns both workers off. */
    public final long workerTickMs;
    public final String publicBaseUrl;
    /** Absolute paths of the built screens, or {@code ""} to not serve one. */
    public final String playgroundDir;
    public final String docsDir;
    public final String consoleDir;
    public final Console console;
    /** Honour {@code x-forwarded-for} when rate limiting. Only true behind a proxy. */
    public final boolean trustProxy;
    public final RateLimit signupRateLimit;
    public final PublicAnchor publicAnchor;
    public final Remit remit;
    /** The price list the console's billing card is computed from. */
    public final Pricing pricing;
    /** This start was approved to attach to the live schema and wallet. */
    public final boolean cutoverApproved;

    public static final class Bitcoind {
        public final String url;
        public final String user;
        public final String password;
        public final String wallet;

        Bitcoind(String url, String user, String password, String wallet) {
            this.url = url;
            this.user = user;
            this.password = password;
            this.wallet = wallet;
        }
    }

    public static final class Batch {
        public final long maxLeaves;
        public final long flushIntervalMs;

        Batch(long maxLeaves, long flushIntervalMs) {
            this.maxLeaves = maxLeaves;
            this.flushIntervalMs = flushIntervalMs;
        }
    }

    public static final class RateLimit {
        public final long windowMs;
        public final long max;

        RateLimit(long windowMs, long max) {
            this.windowMs = windowMs;
            this.max = max;
        }
    }

    public static final class Console {
        public final boolean enabled;
        /** Mark the session cookie {@code Secure}. Required under HTTPS; breaks plain HTTP. */
        public final boolean cookieSecure;
        /** Attestations one organisation may create in a calendar month. */
        public final long monthlyQuota;
        public final RateLimit authRateLimit;

        Console(boolean enabled, boolean cookieSecure, long monthlyQuota, RateLimit authRateLimit) {
            this.enabled = enabled;
            this.cookieSecure = cookieSecure;
            this.monthlyQuota = monthlyQuota;
            this.authRateLimit = authRateLimit;
        }
    }

    public static final class PublicAnchor {
        public final boolean enabled;
        public final RateLimit rateLimit;
        public final RateLimit globalRateLimit;
        /** Days a free anchor stays retrievable here. Only the free tier expires. */
        public final long retentionDays;
        public final List<String> allowedOrigins;

        PublicAnchor(boolean enabled, RateLimit rateLimit, RateLimit globalRateLimit, long retentionDays, List<String> allowedOrigins) {
            this.enabled = enabled;
            this.rateLimit = rateLimit;
            this.globalRateLimit = globalRateLimit;
            this.retentionDays = retentionDays;
            this.allowedOrigins = allowedOrigins;
        }
    }

    public static final class Remit {
        public final boolean enabled;
        public final String partnersBase;
        public final String adminToken;
        public final String platformKeyPath;
        public final boolean acceptDemoFinality;
        public final long quoteTtlMs;
        public final String rateUsdVnd;
        public final String rateUsdSgd;
        public final String feeUsd;
        public final String chainLabel;
        public final String explorerTxUrl;
        public final String chainRpc;
        public final long webhookMaxAttempts;
        public final String porChainRpc;
        /**
         * How long to wait before a step that did not get through is tried again, in milliseconds, one entry per
         * further attempt. Empty: a step is never tried again ({@code REMIT_STEP_RETRY_MS=off}), which is when the
         * service this one replaces gave up. Not a setting of that service.
         */
        public final List<Long> stepRetryMs;
        /** New quotes and new settlements are refused (503 {@code intake_paused}); everything else goes on. Not a setting of that service. */
        public final boolean intakePaused;

        Remit(boolean enabled, String partnersBase, String adminToken, String platformKeyPath, boolean acceptDemoFinality, long quoteTtlMs,
                String rateUsdVnd, String rateUsdSgd, String feeUsd, String chainLabel, String explorerTxUrl, String chainRpc,
                long webhookMaxAttempts, String porChainRpc, List<Long> stepRetryMs, boolean intakePaused) {
            this.enabled = enabled;
            this.partnersBase = partnersBase;
            this.adminToken = adminToken;
            this.platformKeyPath = platformKeyPath;
            this.acceptDemoFinality = acceptDemoFinality;
            this.quoteTtlMs = quoteTtlMs;
            this.rateUsdVnd = rateUsdVnd;
            this.rateUsdSgd = rateUsdSgd;
            this.feeUsd = feeUsd;
            this.chainLabel = chainLabel;
            this.explorerTxUrl = explorerTxUrl;
            this.chainRpc = chainRpc;
            this.webhookMaxAttempts = webhookMaxAttempts;
            this.porChainRpc = porChainRpc;
            this.stepRetryMs = stepRetryMs;
            this.intakePaused = intakePaused;
        }
    }

    /**
     * What the console bills against: one currency, and per product a monthly
     * fee and a unit price. Everything at 0 is the sandbox. The numbers are
     * kept as the price list wrote them, and answered as JavaScript prints
     * them.
     */
    public static final class Pricing {
        public final String currency;
        /** {@code monthly_fee}, {@code per_anchor}. */
        public final Map<String, Double> attest;
        /** {@code monthly_fee}, {@code per_snapshot}. */
        public final Map<String, Double> por;
        /** {@code monthly_fee}, {@code per_settlement}. */
        public final Map<String, Double> remit;

        Pricing(String currency, Map<String, Double> attest, Map<String, Double> por, Map<String, Double> remit) {
            this.currency = currency;
            this.attest = attest;
            this.por = por;
            this.remit = remit;
        }
    }

    private static final Map<String, List<String>> PRICE_KEYS = new LinkedHashMap<>();
    static {
        PRICE_KEYS.put("attest", Arrays.asList("monthly_fee", "per_anchor"));
        PRICE_KEYS.put("por", Arrays.asList("monthly_fee", "per_snapshot"));
        PRICE_KEYS.put("remit", Arrays.asList("monthly_fee", "per_settlement"));
    }

    /**
     * Names every JavaScript object answers to. The reference check for an
     * unknown key of the price list ({@code k in PRICE_KEYS}) lets these
     * through, so this one does.
     */
    private static final Set<String> OBJECT_NAMES = Set.of("constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
            "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString");

    private static Pricing sandboxPricing() {
        return new Pricing("KRW", prices(0, 0, PRICE_KEYS.get("attest")), prices(0, 0, PRICE_KEYS.get("por")), prices(0, 0, PRICE_KEYS.get("remit")));
    }

    private static Map<String, Double> prices(double fee, double unit, List<String> keys) {
        Map<String, Double> out = new LinkedHashMap<>();
        out.put(keys.get(0), fee);
        out.put(keys.get(1), unit);
        return Collections.unmodifiableMap(out);
    }

    // ── reading ───────────────────────────────────────────────────────────────

    private static long integer(EnvSource env, String name, long dflt) {
        String raw = env.get(name);
        if (raw == null || raw.isEmpty()) {
            return dflt;
        }
        double n = Js.toNumber(raw);
        if (Double.isNaN(n) || Double.isInfinite(n) || n != Math.rint(n) || n < 0) {
            throw new ConfigError(name + " must be a non-negative integer, got " + raw);
        }
        return (long) n;
    }

    private static String text(EnvSource env, String name, String dflt) {
        String raw = env.get(name);
        return raw == null || raw.isEmpty() ? dflt : raw;
    }

    private static final Pattern CURRENCY = Pattern.compile("[A-Z]{3}");

    /**
     * A price list from the environment, as JSON of the {@link Pricing}
     * shape. Every key is required and no other key is accepted: a misspelt
     * price must stop the start, not silently bill at zero.
     */
    private static Pricing pricing(EnvSource env, String name, Pricing dflt) {
        String raw = env.get(name);
        if (raw == null || Js.trim(raw).isEmpty()) {
            return dflt;
        }
        Object parsed;
        try {
            parsed = Js.parse(raw);
        } catch (Js.SyntaxException e) {
            throw new ConfigError(name + " must be JSON");
        }
        if (!(parsed instanceof Map)) {
            throw new ConfigError(name + " must be a JSON object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> obj = (Map<String, Object>) parsed;
        for (String k : obj.keySet()) {
            if (!k.equals("currency") && !PRICE_KEYS.containsKey(k) && !OBJECT_NAMES.contains(k)) {
                throw new ConfigError(name + ": unknown key " + Js.stringify(k));
            }
        }
        Object currency = obj.get("currency");
        if (!(currency instanceof String) || !CURRENCY.matcher((String) currency).matches()) {
            throw new ConfigError(name + ": currency must be an ISO 4217 code such as \"KRW\"");
        }
        Map<String, Map<String, Double>> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> product : PRICE_KEYS.entrySet()) {
            Object p = obj.get(product.getKey());
            if (!(p instanceof Map)) {
                throw new ConfigError(name + ": " + product.getKey() + " must be an object");
            }
            Map<?, ?> rec = (Map<?, ?>) p;
            for (Object k : rec.keySet()) {
                if (!product.getValue().contains(k)) {
                    throw new ConfigError(name + ": unknown key " + product.getKey() + "." + k);
                }
            }
            Map<String, Double> values = new LinkedHashMap<>();
            for (String k : product.getValue()) {
                Object v = rec.get(k);
                if (!(v instanceof Double) || ((Double) v).isNaN() || ((Double) v).isInfinite() || (Double) v < 0) {
                    throw new ConfigError(name + ": " + product.getKey() + "." + k + " must be a non-negative number");
                }
                values.put(k, (Double) v);
            }
            out.put(product.getKey(), Collections.unmodifiableMap(values));
        }
        return new Pricing((String) currency, out.get("attest"), out.get("por"), out.get("remit"));
    }

    /**
     * A link template with one {@code {tx}} placeholder, or {@code ""} when
     * unset. Checked at start: a template that cannot take a hash would put a
     * dead link beside every settlement.
     */
    private static String txUrlTemplate(EnvSource env, String name) {
        String raw = text(env, name, "");
        if (raw.isEmpty()) {
            return "";
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            throw new ConfigError(name + " must start with http:// or https://, got " + Js.stringify(raw));
        }
        if (!raw.contains("{tx}")) {
            throw new ConfigError(name + " must contain the literal {tx} placeholder, e.g. https://etherscan.io/tx/{tx}");
        }
        return raw;
    }

    /**
     * A JSON-RPC address the server calls, or {@code ""} when unset. The
     * errors name the variable and never the value: an address with
     * credentials in it is exactly what must not reach a log.
     */
    private static String rpcUrl(EnvSource env, String name, String dflt) {
        String raw = text(env, name, dflt);
        if (raw.isEmpty()) {
            return "";
        }
        Urls url = Urls.parse(raw);
        if (url == null) {
            throw new ConfigError(name + " must be an absolute http:// or https:// URL; the value set does not parse as one");
        }
        if (!url.protocol.equals("http:") && !url.protocol.equals("https:")) {
            throw new ConfigError(name + " must be an http:// or https:// URL");
        }
        if (!url.username.isEmpty() || !url.password.isEmpty()) {
            throw new ConfigError(name + " must not carry credentials (user:pass@ in the URL): fetch will not send them, "
                    + "and the error it throws instead quotes them");
        }
        return raw;
    }

    /** The delays the settlement rail waits before it tries a step again, where the environment names none. */
    static final String DEFAULT_STEP_RETRY_MS = "2000,10000,30000";

    /**
     * A list of delays in milliseconds, separated by commas, or the word
     * {@code off} for none at all. Blank is "not set", as for every other
     * setting, and means the default — which is why "never again" has a word
     * of its own.
     */
    private static List<Long> delays(EnvSource env, String name, String dflt) {
        String raw = text(env, name, dflt);
        if (raw.equals("off")) {
            return Collections.emptyList();
        }
        List<Long> out = new ArrayList<>();
        for (String part : raw.split(",", -1)) {
            String item = Js.trim(part);
            double n = item.isEmpty() ? Double.NaN : Js.toNumber(item);
            if (Double.isNaN(n) || Double.isInfinite(n) || n != Math.rint(n) || n < 0) {
                throw new ConfigError(name + " must be \"off\" or a comma-separated list of non-negative integers (milliseconds), got " + raw);
            }
            out.add((long) n);
        }
        return Collections.unmodifiableList(out);
    }

    public static CoreConfig load(EnvSource e) {
        return new CoreConfig(e);
    }

    private CoreConfig(EnvSource e) {
        env = text(e, "STONEHASH_ENV", "test");
        if (!env.equals("test") && !env.equals("live")) {
            throw new ConfigError("STONEHASH_ENV must be \"test\" or \"live\", got " + Js.stringify(env));
        }
        boolean test = env.equals("test");

        anchorBackend = text(e, "ANCHOR_BACKEND", "regtest");
        if (!anchorBackend.equals("regtest") && !anchorBackend.equals("mainnet")) {
            throw new ConfigError("ANCHOR_BACKEND must be \"regtest\" or \"mainnet\", got " + Js.stringify(anchorBackend));
        }
        // A private chain cannot back a production environment: a third party has no
        // way to confirm an anchor we mined ourselves. Caught at start, not in a customer's audit.
        if (env.equals("live") && anchorBackend.equals("regtest") && !text(e, "ALLOW_REGTEST_IN_LIVE", "").equals("1")) {
            throw new ConfigError("refusing to start: STONEHASH_ENV=live with ANCHOR_BACKEND=regtest. "
                    + "Proofs on a private chain are not publicly verifiable. "
                    + "Set ALLOW_REGTEST_IN_LIVE=1 only if this is a deliberate internal deployment.");
        }

        dataDir = Path.of(text(e, "STONEHASH_DATA_DIR", Path.of("").toAbsolutePath().resolve(".data").toString()))
                .toAbsolutePath().normalize().toString();

        port = integer(e, "PORT", 8787);
        host = text(e, "HOST", "127.0.0.1");
        dbUrl = text(e, "STONEHASH_DB_URL", "");
        bitcoinNetwork = anchorBackend.equals("mainnet") ? "mainnet" : "regtest";
        bitcoind = new Bitcoind(text(e, "BITCOIND_URL", "http://127.0.0.1:18443"), text(e, "BITCOIND_USER", ""),
                text(e, "BITCOIND_PASSWORD", ""), text(e, "BITCOIND_WALLET", "attest"));
        batch = new Batch(integer(e, "BATCH_MAX_LEAVES", 1024), integer(e, "BATCH_FLUSH_INTERVAL_MS", 10_000));
        explorerBaseUrl = text(e, "EXPLORER_BASE_URL", "").replaceAll("/+\\z", "");
        // Clamped, not refused: a deployment that sets this above what Bitcoin can carry
        // gets the largest workable value, not a failed start.
        inscriptionMaxBytes = Math.min(Math.max(integer(e, "INSCRIPTION_MAX_BYTES", DEFAULT_SOFT_CAP_BYTES), 1), HARD_CEILING_BYTES);
        workerTickMs = integer(e, "WORKER_TICK_MS", 2_000);
        publicBaseUrl = text(e, "PUBLIC_BASE_URL", "");
        playgroundDir = text(e, "PLAYGROUND_DIR", "");
        docsDir = text(e, "DOCS_DIR", "");
        consoleDir = text(e, "CONSOLE_DIR", "");
        console = new Console(text(e, "CONSOLE_ENABLED", "1").equals("1"), text(e, "COOKIE_SECURE", "").equals("1"),
                integer(e, "CONSOLE_MONTHLY_QUOTA", 1_000),
                new RateLimit(integer(e, "CONSOLE_AUTH_WINDOW_MS", 900_000), integer(e, "CONSOLE_AUTH_MAX", 20)));
        trustProxy = text(e, "TRUST_PROXY", "").equals("1");
        signupRateLimit = new RateLimit(integer(e, "SIGNUP_RATE_WINDOW_MS", 3_600_000), integer(e, "SIGNUP_RATE_MAX", 20));
        boolean publicEnabled = text(e, "PUBLIC_ANCHOR_ENABLED", "1").equals("1");
        RateLimit perAddress = new RateLimit(integer(e, "PUBLIC_ANCHOR_WINDOW_MS", 3_600_000), integer(e, "PUBLIC_ANCHOR_MAX", 10));
        RateLimit global = new RateLimit(integer(e, "PUBLIC_ANCHOR_GLOBAL_WINDOW_MS", 3_600_000), integer(e, "PUBLIC_ANCHOR_GLOBAL_MAX", 500));
        long retentionDays = integer(e, "PUBLIC_ANCHOR_RETENTION_DAYS", 30);
        List<String> origins = new ArrayList<>();
        for (String origin : text(e, "PUBLIC_ANCHOR_ORIGINS", "*").split(",", -1)) {
            String trimmed = Js.trim(origin);
            if (!trimmed.isEmpty()) {
                origins.add(trimmed);
            }
        }
        publicAnchor = new PublicAnchor(publicEnabled, perAddress, global, retentionDays, Collections.unmodifiableList(origins));
        remit = new Remit(
                text(e, "REMIT_ENABLED", test ? "1" : "0").equals("1"),
                text(e, "REMIT_PARTNERS_BASE", "http://127.0.0.1:3300"),
                // The sandbox default lets provisioning work out of the box; live must set it.
                text(e, "REMIT_ADMIN_TOKEN", test ? "remit-admin-sandbox" : ""),
                text(e, "REMIT_PLATFORM_KEY_PATH", Path.of(dataDir, "platform-remit-key.pem").toString()),
                text(e, "REMIT_ACCEPT_DEMO_FINALITY", test ? "1" : "0").equals("1"),
                integer(e, "REMIT_QUOTE_TTL_MS", 600_000),
                text(e, "REMIT_RATE_USD_VND", "25380"),
                text(e, "REMIT_RATE_USD_SGD", "1.3350"),
                text(e, "REMIT_FEE_USD", "25.00"),
                text(e, "REMIT_CHAIN_LABEL", "eip155:31337"),
                txUrlTemplate(e, "REMIT_EXPLORER_TX_URL"),
                rpcUrl(e, "REMIT_CHAIN_RPC", test ? "http://127.0.0.1:8545" : ""),
                integer(e, "REMIT_WEBHOOK_MAX_ATTEMPTS", 5),
                rpcUrl(e, "POR_CHAIN_RPC", "http://127.0.0.1:8545"),
                delays(e, "REMIT_STEP_RETRY_MS", DEFAULT_STEP_RETRY_MS),
                text(e, "REMIT_INTAKE_PAUSED", "").equals("1"));
        pricing = pricing(e, "CONSOLE_PRICING", sandboxPricing());
        cutoverApproved = text(e, "STONEHASH_CUTOVER_APPROVED", "").equals("1");
    }

    /** {@code sk_live_} or {@code sk_test_}: what an API key of this environment starts with. */
    public String keyPrefix() {
        return env.equals("live") ? "sk_live_" : "sk_test_";
    }

    /**
     * While the service this one replaces is still the one in production,
     * both must never be attached to the same schema or the same wallet: two
     * workers would seal the same batch twice, spend the same outputs and
     * send the same webhook twice. So a start that names the live schema or
     * the live wallet is refused unless the switch was approved
     * ({@code STONEHASH_CUTOVER_APPROVED=1}).
     *
     * @param database the schema named by {@code STONEHASH_DB_URL}
     */
    public void refuseLiveStoreUnlessApproved(String database) {
        if (cutoverApproved) {
            return;
        }
        if (LIVE_SCHEMA.equals(database)) {
            throw new ConfigError("refusing to start: STONEHASH_DB_URL names the live schema " + LIVE_SCHEMA
                    + ", which the running service owns. Point this one at a schema of its own (stonehash_test_…); "
                    + "STONEHASH_CUTOVER_APPROVED=1 is set only at the approved switch.");
        }
        if (LIVE_WALLET.equals(bitcoind.wallet)) {
            throw new ConfigError("refusing to start: BITCOIND_WALLET is the live wallet \"" + LIVE_WALLET
                    + "\", which the running service spends from. Give this one a wallet of its own; "
                    + "STONEHASH_CUTOVER_APPROVED=1 is set only at the approved switch.");
        }
    }
}
