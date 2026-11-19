package com.stonehash.attest.core;

/**
 * Something that runs only in a serving instance and is started once the
 * server listens, after the batch worker: {@code serve} starts every bean of
 * this type, in the order of {@link #order}. A command and a test wire the
 * same beans and start none of them. What is started stops with the
 * application context (make the bean a {@code DisposableBean}).
 */
public interface StartsWithServe {
    /** Lower first. */
    default int order() {
        return 100;
    }

    void startServing();
}
