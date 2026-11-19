package com.stonehash.attest.por;

import java.util.Objects;

/** The assertions the tests are written in. A failure is an {@link AssertionError} naming what was being checked. */
final class Check {
    private Check() {
    }

    interface Action {
        void run() throws Exception;
    }

    static void equal(Object expected, Object actual, String what) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError(what + "\n      expected: " + expected + "\n      actual:   " + actual);
        }
    }

    static void isTrue(boolean condition, String what) {
        if (!condition) {
            throw new AssertionError(what);
        }
    }

    /** Runs the action and requires it to end in an exception of the given type. */
    static void fails(Class<? extends Throwable> type, Action action) {
        try {
            action.run();
        } catch (Throwable e) {
            isTrue(type.isInstance(e), "expected " + type.getSimpleName() + ", got " + e);
            return;
        }
        throw new AssertionError("expected " + type.getSimpleName() + ", but nothing was thrown");
    }

    /** Runs the action and requires it to end in a {@link PorException} with the given code. */
    static PorException refuses(String code, Action action) {
        try {
            action.run();
        } catch (PorException e) {
            equal(code, e.code(), "the code of the refusal (" + e.getMessage() + ")");
            return e;
        } catch (Exception e) {
            throw new AssertionError("expected a refusal with code " + code + ", got " + e, e);
        }
        throw new AssertionError("expected a refusal with code " + code + ", but nothing was refused");
    }
}
