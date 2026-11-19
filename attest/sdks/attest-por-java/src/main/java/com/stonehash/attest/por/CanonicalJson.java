package com.stonehash.attest.por;

/**
 * Canonical JSON as the protocol defines it (specification §1): the subset of
 * RFC 8785 in which the only numbers are integers within ±(2^53 - 1). Keys
 * are sorted by UTF-16 code unit and there is no insignificant whitespace.
 *
 * <p>Every hash and signature in the protocol is taken over this text in
 * UTF-8. It is exposed so that a figure can be logged or compared in exactly
 * the form the other SDKs print it.
 */
public final class CanonicalJson {
    private CanonicalJson() {
    }

    /**
     * @param value a JSON value built from {@code Map<String, ?>}, {@code List<?>}, {@code String},
     *              {@code Long} or {@code Integer}, {@code Boolean} and null
     * @throws PorException {@code not_canonical} for anything else — a fraction, an integer beyond
     *                      2^53 - 1, an amount held as a number instead of a decimal string
     */
    public static String of(Object value) {
        return Json.canonical(value);
    }
}
