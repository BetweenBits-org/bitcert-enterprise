package com.stonehash.attest.core.http;

import jakarta.servlet.http.HttpServletResponse;
import java.util.function.BiConsumer;

/**
 * Writes a response header as given.
 *
 * <p>One header needs care. The servlet container takes a Content-Type apart
 * and writes it back in its own spelling ({@code application/json;charset=utf-8},
 * without the space). The service this one replaces has always answered
 * {@code application/json; charset=utf-8}; the two mean the same, and still a
 * client that compares the header as text would see a change. So where the
 * container offers a way to set the value verbatim ({@link #verbatimContentType}),
 * it is used.
 */
public final class ResponseHeaders {
    private ResponseHeaders() {
    }

    /** Request attribute under which the server puts a setter that writes the Content-Type verbatim. */
    public static final String VERBATIM_CONTENT_TYPE = "stonehash.verbatimContentType";

    @SuppressWarnings("unchecked")
    public static void set(HttpServletResponse res, String name, String value) {
        if (name.equalsIgnoreCase("content-type")) {
            Object setter = CURRENT.get();
            if (setter != null) {
                ((BiConsumer<HttpServletResponse, String>) setter).accept(res, value);
                return;
            }
        }
        res.setHeader(name, value);
    }

    /** The verbatim setter for the request this thread is serving, put there by the server's valve. */
    static final ThreadLocal<Object> CURRENT = new ThreadLocal<>();

    public static void verbatimContentType(BiConsumer<HttpServletResponse, String> setter) {
        CURRENT.set(setter);
    }

    /** For the request this thread is serving: close the connection now, without an answer. Put there by the server's valve. */
    static final ThreadLocal<Runnable> CUT = new ThreadLocal<>();

    public static void connectionCutter(Runnable cutter) {
        CUT.set(cutter);
    }

    /**
     * Cut the connection of the request this thread is serving.
     *
     * @return whether it could be done; {@code false} where the server offers no way, and the caller answers instead
     */
    static boolean cutConnection() {
        Runnable cutter = CUT.get();
        if (cutter == null) {
            return false;
        }
        cutter.run();
        return true;
    }

    public static void clear() {
        CUT.remove();
        CURRENT.remove();
    }
}
