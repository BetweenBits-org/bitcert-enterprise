package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import java.nio.charset.StandardCharsets;
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
 *
 * <p>How a body is read is the reference's ({@code partners-client.ts}, the
 * function {@code post}: {@code await res.json().catch(() => ({}))}), and the
 * vectors {@code remit-partner.json} hold this class to it:
 * <ul>
 * <li>the bytes are decoded as UTF-8, bytes that are none become U+FFFD and
 *     one byte order mark at the front is taken away ({@link #http(int, byte[])});
 * <li>a body that is JSON is that value whatever it is — an object, a list,
 *     text, a number, a boolean, {@code null} ({@link #returned()});
 * <li>a body that is not JSON is an empty object;
 * <li>the sentence of a refusal names {@code message}, or else {@code error},
 *     or else {@code partner error}: {@code null} and absence count as not
 *     given, everything else — empty text, {@code 0}, {@code false} — as
 *     given, and a value that is not text is written as JavaScript writes it
 *     into a sentence ({@link #failure}).
 * </ul>
 * Two answers made the reference fail inside its runtime, and here they have
 * a sentence of this service's (difference D-23): a body that is the JSON
 * {@code null} (the reference read a member of it), and a {@code message} or
 * {@code error} that is an object with a member named {@code toString} (it
 * could not be written into the sentence).
 */
public final class PartnerAnswer {
    public enum Kind { NOT_REACHED, NO_ANSWER, HTTP }

    /** What the reference says where the partner gave neither a {@code message} nor an {@code error}. */
    static final String PARTNER_ERROR = "partner error";

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
    /** The call this answers, when a connector made it ({@link #of}): the path at the partner. Otherwise {@code null}. */
    public final String path;
    /** The call this answers, when a connector made it ({@link #of}): the partner's address. Otherwise {@code null}. */
    public final String base;

    private PartnerAnswer(Kind kind, int status, String body, boolean isJson, Object json, String cause, String path, String base) {
        this.kind = kind;
        this.status = status;
        this.body = body;
        this.isJson = isJson;
        this.json = json;
        this.cause = cause;
        this.path = path;
        this.base = base;
    }

    public static PartnerAnswer notReached(String cause) {
        return new PartnerAnswer(Kind.NOT_REACHED, 0, null, false, null, cause, null, null);
    }

    public static PartnerAnswer noAnswer(String cause) {
        return new PartnerAnswer(Kind.NO_ANSWER, 0, null, false, null, cause, null, null);
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
        return new PartnerAnswer(Kind.HTTP, status, body == null ? "" : body, isJson, parsed, null, null, null);
    }

    /**
     * An answer as it came off the wire. The bytes become text the way the
     * reference's runtime makes text of a response before it parses it:
     * UTF-8, U+FFFD for what is not, one byte order mark at the front gone.
     */
    public static PartnerAnswer http(int status, byte[] body) {
        String text = new String(body == null ? new byte[0] : body, StandardCharsets.UTF_8);
        return http(status, text.startsWith("﻿") ? text.substring(1) : text);
    }

    /**
     * This answer as the answer to one call: it knows the path and the
     * address, so {@link #failure()} and {@link #error()} need not be told.
     * The connectors return their answers so.
     */
    public PartnerAnswer of(String path, String base) {
        return new PartnerAnswer(kind, status, body, isJson, json, cause, path, base);
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

    /**
     * The body as an object: the parsed object, or an empty one when the body
     * is not a JSON object. For a body that is no JSON, a list, text, a
     * number or a boolean that is how the reference reads the members the
     * rail asks for (none of them is there). For the JSON {@code null} the
     * reference fails inside its runtime at the first member it reads; here
     * {@code null} has no members either (D-23).
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> object() {
        return json instanceof Map ? (Map<String, Object>) json : new LinkedHashMap<>();
    }

    /**
     * What the reference's {@code post} hands its caller for an answer below
     * 400: the parsed body whatever it is — an object, a list, text, a
     * number, a boolean, {@code null} — and an empty object when the body is
     * not JSON. Read its members with {@link JsValues#member}, which fails
     * where the reference's runtime failed.
     */
    public Object returned() {
        return isJson ? json : new LinkedHashMap<String, Object>();
    }

    /**
     * The code the reference gave a call that did not succeed:
     * {@code partner_unreachable} where no answer was read,
     * {@code partner_error} for an answer of 400 and above. {@code null} for
     * a call that succeeded.
     */
    public String code() {
        return kind != Kind.HTTP ? "partner_unreachable" : status >= 400 ? "partner_error" : null;
    }

    /**
     * The sentence of a call that did not succeed (design 4.3) — it is stored
     * and read by programs, so it is the reference's:
     * {@code <path> → HTTP <status>: <the partner's message, or its error, or "partner error">}
     * for an answer of 400 and above, and
     * {@code <path>: partner simulator not reachable at <base> — is demo-partners running? (<cause>)}
     * where no answer was read. Only the words of the cause are this
     * service's (D-22). Never throws.
     */
    public String failure(String path, String base) {
        if (kind != Kind.HTTP) {
            return path + ": partner simulator not reachable at " + base + " — is demo-partners running? (" + cause + ")";
        }
        return path + " → HTTP " + status + ": " + said();
    }

    /** {@link #failure(String, String)} of the call this answers ({@link #of}). */
    public String failure() {
        return failure(bound(), base);
    }

    /**
     * The failed call as the error the reference threw for it: 502 with
     * {@link #code()} and {@link #failure(String, String)}. For a route that
     * answers its caller with the partner's failure (rfi-response).
     */
    public ServiceError error(String path, String base) {
        if (ok()) {
            throw new IllegalStateException("the call succeeded: there is no error to answer with");
        }
        return new ServiceError(502, code(), failure(path, base));
    }

    /** {@link #error(String, String)} of the call this answers ({@link #of}). */
    public ServiceError error() {
        return error(bound(), base);
    }

    private String bound() {
        if (path == null) {
            throw new IllegalStateException("this answer was not given the call it answers: use failure(path, base)");
        }
        return path;
    }

    /** {@code msg.message ?? msg.error ?? 'partner error'}, as the reference writes it into the sentence. */
    private String said() {
        if (!(json instanceof Map)) {
            // No JSON: an empty object. A list, text, a number, a boolean: no such members. null: D-23.
            return PARTNER_ERROR;
        }
        Map<?, ?> msg = (Map<?, ?>) json;
        Object said = msg.get("message");
        if (said == null) {
            said = msg.get("error");
        }
        if (said == null) {
            return PARTNER_ERROR;
        }
        try {
            return JsValues.string(said);
        } catch (JsValues.EngineError unprintable) {
            // An object that names its own toString: the reference's runtime gave up there (D-23).
            return PARTNER_ERROR;
        }
    }
}
