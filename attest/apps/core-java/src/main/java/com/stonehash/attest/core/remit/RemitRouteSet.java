package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.http.Router;

/**
 * Routes a part of the rail adds to the route table, at one of the two
 * places the table has for them ({@link RemitRoutes#register}). The order of
 * the route table is the reference's, so the place is part of the route:
 * {@code POST /v1/settlements/:id/cancel} and then
 * {@code POST /v1/settlements/:id/rfi-response} after the evidence route;
 * {@code POST /v1/remit/callbacks} after the manifests.
 */
public interface RemitRouteSet {
    enum Mark { AFTER_EVIDENCE, AFTER_MANIFESTS }

    Mark mark();

    void register(Router r);
}
