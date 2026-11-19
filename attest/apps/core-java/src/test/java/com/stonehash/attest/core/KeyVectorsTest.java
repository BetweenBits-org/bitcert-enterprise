package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.format.PublicKeys;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The check of offered key material held to the reference: every answer in
 * {@code vectors/keys.json} was given by {@code apps/core/src/remit/sign.ts}.
 */
class KeyVectorsTest {
    @SuppressWarnings("unchecked")
    private static String show(Object problem) {
        return problem == null ? "accepted" : ((Map<String, Object>) problem).get("code") + ": " + ((Map<String, Object>) problem).get("message");
    }

    private static String show(PublicKeys.Problem problem) {
        return problem == null ? "accepted" : problem.code + ": " + problem.message;
    }

    @Test
    void refusesAndAcceptsOfferedKeysAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int refused = 0;
        for (Map<String, Object> c : Vectors.cases(Vectors.load("keys.json"), "keys")) {
            ran++;
            String text = (String) c.get("text");
            String any = show(PublicKeys.problem(text));
            String es256 = show(PublicKeys.es256Problem(text));
            refused += es256.equals("accepted") ? 0 : 1;
            if (!any.equals(show(c.get("any")))) {
                failures.add(c.get("name") + " as a key of any kind: " + any + "\n      expected " + show(c.get("any")));
            }
            if (!es256.equals(show(c.get("es256")))) {
                failures.add(c.get("name") + " as an ES256 key: " + es256 + "\n      expected " + show(c.get("es256")));
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " answers differ from the reference:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= 55 && refused >= 35, ran + " offered keys, " + refused + " refused as ES256");
    }
}
