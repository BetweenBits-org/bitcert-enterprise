package com.stonehash.attest.core.remit;

/**
 * One exchange with a partner — the receiving institution's connector or the
 * settlement wallet: one POST of a JSON text, and what came of it.
 *
 * <p>The seam between the parts of the rail that call out. The implementation
 * (the HTTP client, its time limit, how it tells "never connected" from
 * "connected and no answer") is one class; the callers build the body, give
 * the key the design names for the step (design 4.1), read the answer and
 * decide what it means for the settlement.
 */
public interface PartnerExchange {
    /**
     * POST {@code body} — these bytes, UTF-8, as they are — to
     * {@code base() + path} with {@code content-type: application/json} and,
     * when {@code idempotencyKey} is not {@code null}, the header
     * {@code Idempotency-Key}. One attempt: nothing is sent twice in here.
     * The whole exchange, from connecting to the last byte of the answer, is
     * over within 20 seconds. Never throws: whatever happened is the
     * {@link PartnerAnswer}.
     *
     * @param path the path at the partner, with its leading slash ({@code /bfi/travel-rule})
     */
    PartnerAnswer post(String path, String idempotencyKey, String body);

    /** The address calls go to ({@code REMIT_PARTNERS_BASE}); the "not reachable" sentence names it. */
    String base();

    /** Whether the partner behind this exchange has said it honours idempotency keys. The simulator profile: no. */
    boolean honoursIdempotencyKeys();
}
