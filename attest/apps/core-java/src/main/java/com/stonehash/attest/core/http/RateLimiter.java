package com.stonehash.attest.core.http;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Fixed-window rate limiter, in memory: the first request of a key opens a
 * window of {@code windowMs}, and {@code max} requests fit in it.
 *
 * <p>It exists because some doors are unauthenticated by design — sandbox
 * sign-up, the free tier — and on a publicly reachable server that is an
 * open write endpoint. A cap per address keeps it usable for a visitor and
 * uninteresting to a script. Not a security boundary; a cost control.
 *
 * <p>In memory and per process: right for one API instance, and the reason
 * there is exactly one while this is how limits are kept.
 */
public final class RateLimiter {
    private static final class Window {
        long count;
        long resetAt;
    }

    private final Map<String, Window> hits = new HashMap<>();
    private final long windowMs;
    private final long max;

    public RateLimiter(long windowMs, long max) {
        this.windowMs = windowMs;
        this.max = max;
    }

    /** {@code null} when allowed; the seconds to wait when not. */
    public Long check(String key) {
        return check(key, System.currentTimeMillis());
    }

    public synchronized Long check(String key, long now) {
        Window e = hits.get(key);
        if (e == null || now >= e.resetAt) {
            Window fresh = new Window();
            fresh.count = 1;
            fresh.resetAt = now + windowMs;
            hits.put(key, fresh);
            // Expired entries are dropped so that a long uptime cannot grow the map without bound.
            if (hits.size() > 10_000) {
                for (Iterator<Window> it = hits.values().iterator(); it.hasNext();) {
                    if (now >= it.next().resetAt) {
                        it.remove();
                    }
                }
            }
            return null;
        }
        if (e.count >= max) {
            return (long) Math.ceil((e.resetAt - now) / 1000.0);
        }
        e.count += 1;
        return null;
    }

    /**
     * The caller's address, for limiting. {@code x-forwarded-for} is honoured
     * only when the deployment says it is behind a proxy: trusted
     * unconditionally, it would let any caller forge the header and sidestep
     * the limit.
     */
    public static String clientKey(HttpServletRequest req, boolean trustProxy) {
        List<String> all = req.getHeaders("x-forwarded-for") == null ? List.of() : Collections.list(req.getHeaders("x-forwarded-for"));
        // Several headers of that name read as one, joined as the previous server joined them.
        return clientKey(all.isEmpty() ? null : String.join(", ", all), req.getRemoteAddr(), trustProxy);
    }

    /** @param forwardedFor the {@code x-forwarded-for} header, or {@code null}; @param address the peer's address, or {@code null} */
    public static String clientKey(String forwardedFor, String address, boolean trustProxy) {
        if (trustProxy && forwardedFor != null) {
            String first = com.stonehash.attest.core.json.Js.trim(forwardedFor.split(",", -1)[0]);
            if (!first.isEmpty()) {
                return first;
            }
        }
        return address == null ? "unknown" : address;
    }
}
