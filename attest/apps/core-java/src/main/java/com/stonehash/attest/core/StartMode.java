package com.stonehash.attest.core;

/**
 * How this process was started: to serve, or only to be wired — for a
 * command that needs the wiring and ends, and for tests.
 *
 * <p>What the service does once, when it starts to serve — and only then —
 * asks here first. A command that lists the routes must not write to the
 * store or make a key file because the same beans are wired for it.
 */
public final class StartMode {
    /** The server is being started to answer requests. */
    public final boolean serving;

    public StartMode(boolean serving) {
        this.serving = serving;
    }
}
