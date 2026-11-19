package com.stonehash.attest.core;

import com.stonehash.attest.core.anchor.BitcoindHealth;
import com.stonehash.attest.core.attest.BatchWorker;
import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import com.stonehash.attest.core.db.DbUrl;
import com.stonehash.attest.core.db.Migrator;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.log.Log;
import com.stonehash.attest.core.remit.PlatformKey;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.Banner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Entry point.
 *
 * <pre>
 *   java -jar stonehash-attest-core.jar [--env-file=FILE] [serve]     the service (the default)
 *   java -jar stonehash-attest-core.jar [--env-file=FILE] migrate     bring the schema to this build's version, and end
 *   java -jar stonehash-attest-core.jar [--env-file=FILE] baseline    record that the schema already is version 1 (the approved switch)
 *   java -jar stonehash-attest-core.jar [--env-file=FILE] routes      print the route table (METHOD path), and end
 * </pre>
 *
 * Settings come from the environment, under the names the service has always
 * read; {@code --env-file} lays a file of {@code KEY=value} lines over it.
 * A setting that cannot be right stops the start with one line —
 * {@code {"ts": …, "msg": "fatal", "error": …}} — and exit status 1.
 */
@SpringBootApplication
public class CoreApplication {
    public static final String VERSION = "0.1.0";
    private static final Set<String> BUILT_IN = Set.of("serve", "migrate", "baseline", "routes", "backfill-snapshot-keys");

    public static void main(String[] args) {
        int status = run(args);
        if (status != 0) {
            System.exit(status);
        }
    }

    static int run(String[] args) {
        try {
            String command = "serve";
            Path envFile = null;
            // The first word that is not an option names the command. A command a part of the service brings
            // (CoreCommand) takes everything else as its own arguments; the built-in ones take none.
            String first = null;
            String strayOption = null;
            List<String> rest = new ArrayList<>();
            for (String arg : args) {
                if (arg.startsWith("--env-file=")) {
                    envFile = Path.of(arg.substring("--env-file=".length()));
                } else if (!arg.startsWith("--")) {
                    command = arg;
                    if (first == null) {
                        first = arg;
                    } else {
                        rest.add(arg);
                    }
                } else {
                    if (strayOption == null) {
                        strayOption = arg;
                    }
                    rest.add(arg);
                }
            }
            boolean builtIn = first == null || BUILT_IN.contains(first);
            if (builtIn && strayOption != null) {
                throw new ConfigError("unknown option " + strayOption);
            }
            EnvSource env = EnvSource.system();
            if (envFile != null) {
                env = env.withFile(envFile);
            }
            CoreConfig cfg = CoreConfig.load(env);
            DbUrl db = DbUrl.parse(cfg.dbUrl);
            cfg.refuseLiveStoreUnlessApproved(db.database);
            if (!builtIn) {
                List<String> known = new ArrayList<>();
                try (ConfigurableApplicationContext context = application(cfg, db, false).run()) {
                    for (CoreCommand c : context.getBeansOfType(CoreCommand.class).values()) {
                        if (c.name().equals(first)) {
                            return c.run(List.copyOf(rest));
                        }
                        known.add(c.name());
                    }
                }
                if (strayOption != null) {
                    throw new ConfigError("unknown option " + strayOption);
                }
                Collections.sort(known);
                StringBuilder names = new StringBuilder("serve, migrate, baseline, routes, backfill-snapshot-keys");
                for (String name : known) {
                    names.append(", ").append(name);
                }
                throw new ConfigError("unknown command " + first + " (" + names + ")");
            }
            switch (command) {
                case "serve":
                    serve(cfg, db);
                    return 0;
                case "migrate":
                    Migrator.migrate(db);
                    return 0;
                case "baseline":
                    Migrator.baseline(db);
                    return 0;
                case "routes":
                    try (ConfigurableApplicationContext context = application(cfg, db, false).run()) {
                        for (Router.Route route : context.getBean(Router.class).routes()) {
                            System.out.println(route.method + " " + route.path);
                        }
                    }
                    return 0;
                case "backfill-snapshot-keys":
                    // The service this one replaces did this every time it started. Here nothing is written
                    // to the store at start, so it is a command of its own, run once.
                    try (ConfigurableApplicationContext context = application(cfg, db, false).run()) {
                        int filled = context.getBean(com.stonehash.attest.core.por.PorSnapshots.class).backfillKeys();
                        Log.line("reserve snapshots given their signing key", Log.fields("filled", filled));
                    }
                    return 0;
                default:
                    throw new ConfigError("unknown command " + command + " (serve, migrate, baseline, routes, backfill-snapshot-keys)");
            }
        } catch (Throwable e) {
            Throwable cause = e;
            while (cause.getCause() != null && !(cause instanceof ConfigError)) {
                cause = cause.getCause();
            }
            Log.line("fatal", Log.fields("error", String.valueOf(cause.getMessage() == null ? cause.toString() : cause.getMessage())));
            return 1;
        }
    }

    /**
     * The application, wired and not yet run. With {@code listen} false it binds a port of
     * the system's choosing — for a command that only needs the wiring, and for tests.
     * The batch worker is never started by this: {@link #serve} starts it.
     */
    static SpringApplication application(CoreConfig cfg, DbUrl db, boolean listen) {
        SpringApplication app = new SpringApplication(CoreApplication.class);
        app.setWebApplicationType(WebApplicationType.SERVLET);
        app.setBannerMode(Banner.Mode.OFF);
        app.setLogStartupInfo(false);
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("server.port", listen ? cfg.port : 0);
        properties.put("server.address", cfg.host);
        properties.put("server.shutdown", "graceful");
        properties.put("spring.lifecycle.timeout-per-shutdown-phase", "5s");
        // A start that fails is reported once, by this class, in the service's own line.
        properties.put("logging.level.org.springframework.boot.SpringApplication", "OFF");
        properties.put("logging.level.org.springframework.boot.diagnostics.LoggingFailureAnalysisReporter", "OFF");
        app.setDefaultProperties(properties);
        // Settings are read once, before anything is wired, and handed in as they are.
        app.addInitializers((context) -> {
            context.getBeanFactory().registerSingleton("coreConfig", cfg);
            context.getBeanFactory().registerSingleton("dbUrl", db);
            // What is done once when the server starts to serve asks this first: a command and a test are wired, not served.
            context.getBeanFactory().registerSingleton("startMode", new StartMode(listen));
        });
        return app;
    }

    private static void serve(CoreConfig cfg, DbUrl db) {
        // The settlement rail signs with a key that is a file. It is found — or, on a test store only, made — before anything
        // is wired; the platform's own row in the registry is written once the store is there and before a request is answered
        // (remit/RemitStartup).
        if (cfg.remit.enabled) {
            PlatformKey.prepareAtStart(cfg);
        }
        ConfigurableApplicationContext context = application(cfg, db, true).run();
        // Said only once it is true: the port is the one the server is bound to.
        long port = ((WebServerApplicationContext) context).getWebServer().getPort();
        Log.line("attest-core listening", Log.fields(
                "version", VERSION, "env", cfg.env, "host", cfg.host, "port", port,
                "network", cfg.bitcoinNetwork, "anchorBackend", "bitcoind:" + cfg.bitcoinNetwork,
                "db", "mysql(" + db.database + ")"));
        // Reported, not enforced: an unreachable node must not stop the API from accepting
        // attestations. They queue as `accepted` until the chain returns.
        Map<String, Object> chain = context.getBean(BitcoindHealth.class).health();
        Log.line(Boolean.TRUE.equals(chain.get("ok")) ? "anchor backend reachable" : "anchor backend NOT reachable", chain);
        if (cfg.bitcoinNetwork.equals("regtest")) {
            Log.line("NOTE: regtest is a private chain — proofs issued here are not publicly verifiable");
        }
        context.getBean(BatchWorker.class).start();
        // What else runs in a serving instance only (StartsWithServe), in its order.
        context.getBeansOfType(StartsWithServe.class).values().stream()
                .sorted(Comparator.comparingInt(StartsWithServe::order))
                .forEach(StartsWithServe::startServing);
    }
}
