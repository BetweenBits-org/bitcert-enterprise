package com.stonehash.attest.core.http;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * The one servlet. Every request, whatever its method or path, is handed to
 * the {@link Router}: which request is a 404, how a path is read and what an
 * error looks like are this service's contract, not the container's defaults.
 */
public final class CoreServlet extends HttpServlet {
    private static final long serialVersionUID = 1L;

    private final transient Router router;

    public CoreServlet(Router router) {
        this.router = router;
    }

    @Override
    protected void service(HttpServletRequest req, HttpServletResponse res) throws IOException {
        router.handle(req, res);
    }
}
