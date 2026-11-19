package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import com.stonehash.attest.core.db.DbUrl;
import java.nio.file.Path;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The service, wired against a test schema and the regtest node, for the
 * tests that need the real store and the real chain ({@code *IT}).
 *
 * <p>They are not part of {@code ./mvnw test}: they run only when asked for
 * by name, with the env file to use —
 * {@code ./mvnw -o test -Dtest=WorkerRecoveryIT -Dstonehash.env=.env.dev-worker}.
 * The env file must name a {@code stonehash_test_} schema and the wallet
 * {@code attest-java}. The batch worker's timer is not started here; a test
 * drives its cycles itself.
 */
final class TestServer implements AutoCloseable {
    final CoreConfig cfg;
    final ConfigurableApplicationContext context;

    private TestServer(CoreConfig cfg, ConfigurableApplicationContext context) {
        this.cfg = cfg;
        this.context = context;
    }

    static TestServer start() throws Exception {
        String env = System.getProperty("stonehash.env");
        assumeTrue(env != null && !env.isEmpty(), "run with -Dstonehash.env=<env file of a test schema>");
        CoreConfig cfg = CoreConfig.load(EnvSource.system().withFile(Path.of(env)));
        DbUrl db = DbUrl.parse(cfg.dbUrl);
        if (!db.database.startsWith("stonehash_test_") || !cfg.bitcoind.wallet.equals("attest-java")) {
            throw new IllegalStateException("these tests run on a stonehash_test_ schema and the wallet attest-java only");
        }
        return new TestServer(cfg, CoreApplication.application(cfg, db, false).run());
    }

    <T> T bean(Class<T> type) {
        return context.getBean(type);
    }

    @Override
    public void close() {
        context.close();
    }
}
