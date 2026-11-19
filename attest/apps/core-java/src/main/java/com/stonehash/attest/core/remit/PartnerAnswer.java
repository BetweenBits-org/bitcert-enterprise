package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What one call to a partner came to ({@link PartnerExchange#post}).
 *
 * <p>Three kinds, because what may be done next differs (design 3.5):
 * <ul>
 * <li>{@link Kind#NOT_REACHED} — no connection was made (refused, timed out
 *     while connecting, the name did not resolve). The request certainly did
 *     not leave: sending it again is safe.
 * <li>{@link Kind#NO_ANSWER} — a connection was made and no complete answer
 *     was read (the time limit, the connection lost, a response that cannot
 *     be read). The partner may have acted on the request.
 * <li>{@link Kind#HTTP} — a status and a body were read. Below 400 the call
 *     succeeded, as the service this one replaces reads it; 4xx is a refusal
 *     (asking again gives the same); 5xx leaves the outcome unknown.
 * </ul>
 */
public final class PartnerAnswer {
    public enum Kind { NOT_REACHED, NO_ANSWER, HTTP }

    public final Kind kind;
    /** {@link Kind#HTTP}: the status. Otherwise 0. */
    public final int status;
    /** {@link Kind#HTTP}: the body as text. Otherwise {@code null}. */
    public final String body;
    /** {@link Kind#HTTP}: whether the body is JSON. */
    public final boolean isJson;
    /** {@link Kind#HTTP} with {@link #isJson}: the parsed body — a map, a list, a string, a number, a boolean or {@code null}. */
    public final Object json;
    /** {@link Kind#NOT_REACHED}, {@link Kind#NO_ANSWER}: what happened, in a few words; it goes into the sentence. */
    public final String cause;

    private PartnerAnswer(Kind kind, int status, String body, boolean isJson, Object json, String cause) {
        this.kind = kind;
        this.status = status;
        this.body = body;
        this.isJson = isJson;
        this.json = json;
        this.cause = cause;
    }

    public static PartnerAnswer notReached(String cause) {
        return new PartnerAnswer(Kind.NOT_REACHED, 0, null, false, null, cause);
    }

    public static PartnerAnswer noAnswer(String cause) {
        return new PartnerAnswer(Kind.NO_ANSWER, 0, null, false, null, cause);
    }

    public static PartnerAnswer http(int status, String body) {
        Object parsed = null;
        boolean isJson = false;
        try {
            parsed = Js.parse(body == null ? "" : body);
            isJson = true;
        } catch (RuntimeException notJson) {
            // Read as the service this one replaces reads it: an empty object (see object()).
        }
        return new PartnerAnswer(Kind.HTTP, status, body == null ? "" : body, isJson, parsed, null);
    }

    /** The call succeeded: an answer below 400. */
    public boolean ok() {
        return kind == Kind.HTTP && status < 400;
    }

    /** The partner refused: 4xx. Asking again gives the same. */
    public boolean refused() {
        return kind == Kind.HTTP && status >= 400 && status < 500;
    }

    /** The request may have been acted on and no usable answer is on hand: no answer after connecting, or 5xx. */
    public boolean unknown() {
        return kind == Kind.NO_ANSWER || (kind == Kind.HTTP && status >= 500);
    }

    /** The body as the service this one replaces reads it: the parsed object, or an empty one when the body is not a JSON object. */
    @SuppressWarnings("unchecked")
    public Map<String, Object> object() {
        return json instanceof Map ? (Map<String, Object>) json : new LinkedHashMap<>();
    }

    /**
     * The sentence of a call that did not succeed (design 4.3) — it is stored
     * and read by programs, so it is the reference's:
     * {@code <path> → HTTP <status>: <the partner's message, or its error, or "partner error">}
     * for an answer of 400 and above, and
     * {@code <path>: partner simulator not reachable at <base> — is demo-partners running? (<cause>)}
     * where no answer was read.
     */
    public String failure(String path, String base) {
        if (kind != Kind.HTTP) {
            return path + ": partner simulator not reachable at " + base + " — is demo-partners running? (" + cause + ")";
        }
        Map<String, Object> msg = object();
        Object said = msg.get("message") != null ? msg.get("message") : msg.get("error") != null ? msg.get("error") : "partner error";
        return path + " → HTTP " + status + ": " + JsValues.string(said);
    }
}
