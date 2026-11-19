package com.stonehash.attest.core;

import java.util.List;

/**
 * A command of the service beyond the built-in ones ({@code serve},
 * {@code migrate}, {@code baseline}, {@code routes},
 * {@code backfill-snapshot-keys}): {@code java -jar … <name> [arguments]}.
 * A bean of this type is found by its name and run with the service wired
 * and not serving — no port for clients, no worker, nothing done "at start".
 */
public interface CoreCommand {
    /** The word on the command line. */
    String name();

    /**
     * Run it. What it reports goes to standard output; its return value is
     * the exit status. A {@link com.stonehash.attest.core.config.ConfigError}
     * it throws is reported as every fatal error is, in one line, exit 1.
     *
     * @param args what followed the name on the command line, in order ({@code --env-file=…} taken out)
     */
    int run(List<String> args) throws Exception;
}
