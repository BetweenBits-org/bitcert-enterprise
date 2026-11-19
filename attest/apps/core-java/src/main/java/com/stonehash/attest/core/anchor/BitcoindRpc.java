package com.stonehash.attest.core.anchor;

import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.json.Js;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Minimal bitcoind JSON-RPC client. No library: it is a dozen lines of POST,
 * and the alternative is auditing a dependency tree for a service whose whole
 * point is being auditable.
 *
 * <p>A call that names a wallet goes to that wallet's own path
 * ({@code /wallet/<name>}); one that names none touches no wallet.
 */
@Component
public class BitcoindRpc {
    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    /** The node answered, and refused: its code and its sentence. */
    public static final class RpcError extends Exception {
        private static final long serialVersionUID = 1L;

        public final long code;
        /** The node's own sentence, without the prefix {@link #getMessage()} adds. */
        public final String reason;

        RpcError(long code, String reason) {
            super("bitcoind rpc " + code + ": " + reason);
            this.code = code;
            this.reason = reason;
        }
    }

    /** The node could not be asked at all: unreachable, too slow, or not answering JSON. */
    public static final class RpcUnavailable extends Exception {
        private static final long serialVersionUID = 1L;

        RpcUnavailable(String message) {
            super(message);
        }
    }

    private final CoreConfig cfg;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(TIMEOUT).version(HttpClient.Version.HTTP_1_1).build();

    public BitcoindRpc(CoreConfig cfg) {
        this.cfg = cfg;
    }

    /** A call that names no wallet. */
    public Object call(String method, List<?> params) throws RpcError, RpcUnavailable {
        return call(method, params, "");
    }

    /**
     * @param wallet the wallet the call is for, or {@code ""} for none
     * @return the call's {@code result}, as JSON ({@link Js#parse})
     */
    public Object call(String method, List<?> params, String wallet) throws RpcError, RpcUnavailable {
        return call(method, params, wallet, TIMEOUT);
    }

    /** The same call, given less time: a lookup someone is waiting for on a screen does not wait as long as a worker does. */
    public Object call(String method, List<?> params, String wallet, Duration timeout) throws RpcError, RpcUnavailable {
        URI base = URI.create(cfg.bitcoind.url);
        String path = !wallet.isEmpty() ? "/wallet/" + URLEncoder.encode(wallet, StandardCharsets.UTF_8).replace("+", "%20")
                : base.getRawPath() == null || base.getRawPath().isEmpty() ? "/" : base.getRawPath();
        URI target = base.resolve(path);
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("jsonrpc", "1.0");
        call.put("id", method);
        call.put("method", method);
        call.put("params", params);
        HttpRequest.Builder request = HttpRequest.newBuilder(target).timeout(timeout)
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(Js.stringify(call), StandardCharsets.UTF_8));
        if (!cfg.bitcoind.user.isEmpty() || !cfg.bitcoind.password.isEmpty()) {
            request.header("authorization", "Basic " + Base64.getEncoder().encodeToString(
                    (cfg.bitcoind.user + ":" + cfg.bitcoind.password).getBytes(StandardCharsets.UTF_8)));
        }
        HttpResponse<String> response;
        try {
            response = http.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (HttpTimeoutException e) {
            throw new RpcUnavailable("bitcoind rpc timeout");
        } catch (IOException e) {
            // Named by where it is, not by the runtime's own words for the failure.
            throw new RpcUnavailable("bitcoind is not reachable at " + base.getHost() + ":" + (base.getPort() < 0 ? 80 : base.getPort()));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RpcUnavailable("bitcoind rpc timeout");
        }
        Object parsed;
        try {
            parsed = Js.parse(response.body());
        } catch (Js.SyntaxException e) {
            String body = response.body();
            throw new RpcUnavailable("bitcoind returned non-JSON (HTTP " + response.statusCode() + "): " + (body.length() > 200 ? body.substring(0, 200) : body));
        }
        Object error = parsed instanceof Map ? ((Map<?, ?>) parsed).get("error") : null;
        if (error instanceof Map) {
            Object code = ((Map<?, ?>) error).get("code");
            Object message = ((Map<?, ?>) error).get("message");
            throw new RpcError(code instanceof Double ? ((Double) code).longValue() : 0, text(message));
        }
        return parsed instanceof Map ? ((Map<?, ?>) parsed).get("result") : null;
    }

    static String text(Object v) {
        return v == null ? "undefined" : v instanceof Double ? Js.numberToString((Double) v) : String.valueOf(v);
    }
}
