package com.stonehash.attest.core.config;

/** A setting that cannot be what it is set to. The service does not start; the message names the variable, never a secret value. */
public final class ConfigError extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public ConfigError(String message) {
        super(message);
    }
}
