package com.stonehash.attest.core.http;

import java.nio.charset.StandardCharsets;
import org.apache.coyote.Adapter;
import org.apache.coyote.Request;
import org.apache.coyote.Response;
import org.apache.tomcat.util.buf.ByteChunk;
import org.apache.tomcat.util.buf.MessageBytes;
import org.apache.tomcat.util.net.SocketEvent;

/**
 * Hands the request target to the router as it was sent, before the server
 * has an opinion about it.
 *
 * <p>The embedded server decodes and normalises a path itself and answers
 * what it does not like — a malformed escape, {@code %00}, a path that climbs
 * above the root — with a page of its own. The service this one replaces had
 * no such layer: {@code /a/../..} was {@code /}, a malformed escape was a 404
 * or the route's own 400, and every answer was the service's JSON. So the
 * target is taken aside here ({@link #RAW_TARGET}) and the server is shown
 * {@code /} in its place, which it has nothing to say about; the one servlet
 * is mapped to everything, so nothing is routed by what the server sees.
 */
final class RawTargetAdapter implements Adapter {
    /** Request attribute: the path of the request line as sent, undecoded, without the query. */
    static final String RAW_TARGET = "stonehash.rawTarget";

    private static final byte[] ROOT = { '/' };

    private final Adapter next;

    RawTargetAdapter(Adapter next) {
        this.next = next;
    }

    private static void takeTarget(Request req) {
        if (req.getAttribute(RAW_TARGET) != null) {
            return;
        }
        MessageBytes uri = req.requestURI();
        String raw;
        if (uri.getType() == MessageBytes.T_BYTES) {
            ByteChunk bytes = uri.getByteChunk();
            raw = new String(bytes.getBuffer(), bytes.getStart(), bytes.getLength(), StandardCharsets.ISO_8859_1);
        } else {
            raw = uri.toString();
        }
        req.setAttribute(RAW_TARGET, raw == null ? "" : raw);
        uri.setBytes(ROOT, 0, 1);
    }

    @Override
    public void service(Request req, Response res) throws Exception {
        takeTarget(req);
        next.service(req, res);
    }

    @Override
    public boolean prepare(Request req, Response res) throws Exception {
        takeTarget(req);
        return next.prepare(req, res);
    }

    @Override
    public boolean asyncDispatch(Request req, Response res, SocketEvent status) throws Exception {
        return next.asyncDispatch(req, res, status);
    }

    @Override
    public void log(Request req, Response res, long time) {
        next.log(req, res, time);
    }

    @Override
    public void checkRecycled(Request req, Response res) {
        next.checkRecycled(req, res);
    }

    @Override
    public String getDomain() {
        return next.getDomain();
    }
}
