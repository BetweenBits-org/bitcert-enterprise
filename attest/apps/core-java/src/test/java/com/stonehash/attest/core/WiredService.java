package com.stonehash.attest.core;

import com.stonehash.attest.core.config.CoreConfig;

/**
 * {@link TestServer} for the tests of other packages: the service wired
 * against a test schema, not started to serve. Its rules are that class's —
 * run by name, with {@code -Dstonehash.env=<env file of a test schema>}.
 *
 * <p>One for the whole run. A second wired service in the same JVM cannot be
 * started once the first was closed: the mapper files are looked up through
 * a resolver the persistence library makes once and keeps, and that one is
 * bound to the first embedded web application's class loader — which is
 * stopped with it. So every test class that asks gets the same service, and
 * it is closed when the JVM ends (the application's own shutdown hook).
 */
public final class WiredService implements AutoCloseable {
    private static WiredService shared;

    private final TestServer server;

    private WiredService(TestServer server) {
        this.server = server;
    }

    public static synchronized WiredService start() throws Exception {
        if (shared == null) {
            shared = new WiredService(TestServer.start());
        }
        return shared;
    }

    public <T> T bean(Class<T> type) {
        return server.bean(type);
    }

    public CoreConfig cfg() {
        return server.cfg;
    }

    /** Nothing: the service is shared by the test classes of the run and closed with the JVM. */
    @Override
    public void close() {
    }
}
