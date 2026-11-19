package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * What the settlement chain says about one transfer, right now.
 *
 * <p>The settlement's state is what the platform recorded; this is the
 * node's answer this second, and when the two disagree the disagreement is
 * the information. A bank waiting on a transfer wants to see it move from
 * "sent" to "in a block" to "N confirmations", and on a chain no public
 * explorer indexes this is the only place that answer can come from.
 *
 * <p>Read-only by construction: four {@code eth_} reads, no account, no key.
 * The node's address stays on the server — and that includes the text of a
 * failed call, which can quote the address: whatever goes wrong, the answer
 * is one fixed sentence, and only the kind of failure reaches the log.
 *
 * <p>The node's answers are read as the service this one replaces read
 * them, kind for kind — a number where text was expected, a missing member
 * — because what it then answered is what a bank's screen was built against.
 */
public final class ChainStatus {
    private ChainStatus() {
    }

    private static final Pattern TX_HASH = Pattern.compile("0x[0-9a-fA-F]{64}");
    /** keccak256("Transfer(address,address,uint256)"). */
    private static final String TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    /** How long one read may take, start to finish. */
    static final Duration TIMEOUT = Duration.ofMillis(5_000);
    private static final double MAX_DATE_MS = 8.64e15;

    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NORMAL).proxy(HttpClient.Builder.NO_PROXY).connectTimeout(TIMEOUT).build();
    /** For the one read that runs beside another. Its threads end with the process and never hold it open. */
    private static final java.util.concurrent.ExecutorService READS = java.util.concurrent.Executors.newCachedThreadPool((work) -> {
        Thread t = new Thread(work, "chain-read");
        t.setDaemon(true);
        return t;
    });

    /** Any way a lookup cannot be finished. What it says is for the log's one word, never for the answer. */
    private static final class Failed extends Exception {
        private static final long serialVersionUID = 1L;

        Failed(String kind) {
            super(kind);
        }
    }

    /** One read: the method's {@code result}, whatever JSON it is. */
    interface Node {
        Object call(String method, List<Object> params) throws Exception;
    }

    /** The request one read sends. */
    static String request(String method, List<Object> params) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jsonrpc", "2.0");
        body.put("id", 1d);
        body.put("method", method);
        body.put("params", params);
        return Js.stringify(body);
    }

    private static Node over(String rpcUrl, Duration timeout) {
        return (method, params) -> {
            URI uri;
            try {
                uri = URI.create(rpcUrl);
                if (uri.getScheme() == null || uri.getHost() == null) {
                    throw new IllegalArgumentException("not an absolute URL");
                }
            } catch (IllegalArgumentException e) {
                throw new Failed("TypeError");
            }
            HttpRequest req = HttpRequest.newBuilder(uri).header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(request(method, params), StandardCharsets.UTF_8)).build();
            CompletableFuture<HttpResponse<byte[]>> pending = HTTP.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray());
            HttpResponse<byte[]> res;
            try {
                res = pending.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                pending.cancel(true);
                throw new Failed("TimeoutError");
            } catch (ExecutionException e) {
                throw new Failed("TypeError");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new Failed("TypeError");
            }
            if (res.statusCode() < 200 || res.statusCode() > 299) {
                throw new Failed("Error");
            }
            String text = new String(res.body(), StandardCharsets.UTF_8);
            if (text.startsWith("﻿")) {
                text = text.substring(1);
            }
            Object json;
            try {
                json = Js.parse(text);
            } catch (Js.SyntaxException e) {
                throw new Failed("SyntaxError");
            }
            if (JsValues.truthy(JsValues.member(json, "error"))) {
                throw new Failed("Error");
            }
            Object result = JsValues.member(json, "result");
            return result == Js.UNDEFINED ? null : result;
        };
    }

    /**
     * {@code tx_hash, chain, state} and, as far as the node told:
     * {@code block_number, confirmations, block_time, transfer, detail}.
     * {@code state} is {@code confirmed}, {@code failed}, {@code pending},
     * {@code not_found} or {@code unreachable}.
     *
     * @param rpcUrl the settlement chain's node, or {@code ""} where none is configured
     * @param chain the chain's label, e.g. {@code eip155:31337}
     */
    public static Map<String, Object> of(String rpcUrl, String chain, String txHash) {
        return of(rpcUrl.isEmpty() ? null : over(rpcUrl, TIMEOUT), chain, txHash);
    }

    static Map<String, Object> of(Node node, String chain, String txHash) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tx_hash", txHash);
        out.put("chain", chain);
        if (!TX_HASH.matcher(txHash).matches()) {
            return partial(out, "not_found", "not a transaction hash of this chain");
        }
        if (node == null) {
            return partial(out, "unreachable", "no RPC is configured for the settlement chain");
        }
        try {
            List<Object> byHash = new ArrayList<>();
            byHash.add(txHash);
            Object tx = node.call("eth_getTransactionByHash", byHash);
            if (!JsValues.truthy(tx)) {
                return partial(out, "not_found", "the node does not know this transaction");
            }
            if (!JsValues.truthy(JsValues.member(tx, "blockNumber"))) {
                return partial(out, "pending", "broadcast, not yet in a block");
            }
            // The receipt and the head of the chain are asked at once, as they always were: the node sees both requests
            // even when one of them fails.
            CompletableFuture<Object> heading = CompletableFuture.supplyAsync(() -> {
                try {
                    return node.call("eth_blockNumber", new ArrayList<>());
                } catch (Exception e) {
                    throw new java.util.concurrent.CompletionException(e);
                }
            }, READS);
            Object receipt = null;
            Exception failure = null;
            try {
                receipt = node.call("eth_getTransactionReceipt", byHash);
            } catch (Exception e) {
                failure = e;
            }
            Object head = null;
            try {
                head = heading.get();
            } catch (ExecutionException e) {
                failure = failure != null ? failure : e.getCause() instanceof Exception ? (Exception) e.getCause() : e;
            }
            if (failure != null) {
                throw failure;
            }
            if (!JsValues.truthy(receipt)) {
                return partial(out, "pending", "in a block, receipt not yet available");
            }
            Object blockNumber = JsValues.member(receipt, "blockNumber");
            double height = hexNumber(blockNumber);
            List<Object> byNumber = new ArrayList<>();
            byNumber.add(blockNumber == Js.UNDEFINED ? null : blockNumber);
            byNumber.add(false);
            Object block = node.call("eth_getBlockByNumber", byNumber);

            Object log = transferLog(JsValues.member(receipt, "logs"));
            boolean reverted = "0x0".equals(JsValues.member(receipt, "status"));
            // Receipts from before the status field existed have none; every chain this rail runs on has it.
            out.put("state", reverted ? "failed" : "confirmed");
            out.put("block_number", height);
            double confirmations = hexNumber(head) - height + 1;
            out.put("confirmations", Double.isNaN(confirmations) ? Double.NaN : Math.max(1, confirmations));
            if (JsValues.truthy(block)) {
                double ms = hexNumber(JsValues.member(block, "timestamp")) * 1000;
                if (Double.isNaN(ms) || Math.abs(ms) > MAX_DATE_MS) {
                    throw new Failed("RangeError");
                }
                out.put("block_time", IsoTime.ofEpochMilli((long) ms));
            }
            if (log != null) {
                Object topics = JsValues.member(log, "topics");
                Map<String, Object> transfer = new LinkedHashMap<>();
                transfer.put("token", JsValues.member(log, "address"));
                transfer.put("from", topicAddress(JsValues.member(topics, "1")));
                transfer.put("to", topicAddress(JsValues.member(topics, "2")));
                Object data = JsValues.member(log, "data");
                transfer.put("amount", bigInt("0x".equals(data) ? Double.valueOf(0) : data).toString());
                out.put("transfer", transfer);
            }
            if (reverted) {
                out.put("detail", "the transaction was mined and reverted");
            }
            return out;
        } catch (Exception e) {
            // A fixed sentence, never the error: a failed call can quote the node's address, credentials and all, and this
            // answer goes to any organisation with a settlement. The log gets the kind of failure and no more.
            System.err.println("settlement chain lookup failed (" + chain + "): " + (e instanceof Failed ? e.getMessage() : "TypeError"));
            out.remove("state");
            out.remove("block_number");
            out.remove("confirmations");
            out.remove("block_time");
            out.remove("transfer");
            return partial(out, "unreachable", "the chain node did not answer");
        }
    }

    private static Map<String, Object> partial(Map<String, Object> out, String state, String detail) {
        out.put("state", state);
        out.put("detail", detail);
        return out;
    }

    /** The first log that is an ERC-20 transfer: three topics, the first of them the transfer's. {@code null} when there is none. */
    private static Object transferLog(Object logs) throws Failed {
        if (!(logs instanceof List)) {
            throw new Failed("TypeError");
        }
        for (Object log : (List<?>) logs) {
            Object topics = JsValues.member(log, "topics");
            Object first = JsValues.member(topics, "0");
            if (JsValues.nullish(first)) {
                continue;
            }
            if (!(first instanceof String)) {
                throw new Failed("TypeError");
            }
            if (((String) first).toLowerCase(Locale.ROOT).equals(TRANSFER_TOPIC) && JsValues.strictEquals(JsValues.member(topics, "length"), 3d)) {
                return log;
            }
        }
        return null;
    }

    /** The last 20 bytes of a 32-byte topic, as an address. */
    private static String topicAddress(Object topic) throws Failed {
        if (topic instanceof String) {
            String t = (String) topic;
            return "0x" + t.substring(Math.max(0, t.length() - 40));
        }
        if (topic instanceof List) {
            List<?> list = (List<?>) topic;
            return "0x" + JsValues.string(new ArrayList<>(list.subList(Math.max(0, list.size() - 40), list.size())));
        }
        throw new Failed("TypeError");
    }

    /**
     * A quantity as the previous service read one ({@code parseInt} with a
     * radix of 16): the value as text, white space before it skipped, a
     * sign and a {@code 0x} taken, then as many hex digits as there are.
     * None at all is not a number.
     */
    static double hexNumber(Object v) {
        String s = Js.trim(JsValues.string(v));
        int i = 0;
        boolean negative = false;
        if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
            negative = s.charAt(i) == '-';
            i++;
        }
        if (i + 1 < s.length() && s.charAt(i) == '0' && (s.charAt(i + 1) == 'x' || s.charAt(i + 1) == 'X')) {
            i += 2;
        }
        int start = i;
        while (i < s.length() && Character.digit(s.charAt(i), 16) >= 0 && s.charAt(i) < 128) {
            i++;
        }
        if (i == start) {
            return Double.NaN;
        }
        double value = new BigInteger(s.substring(start, i), 16).doubleValue();
        return negative ? -value : value;
    }

    private static final Pattern DECIMAL = Pattern.compile("[+-]?[0-9]+");
    private static final Pattern HEX = Pattern.compile("0[xX][0-9a-fA-F]+");
    private static final Pattern OCTAL = Pattern.compile("0[oO][0-7]+");
    private static final Pattern BINARY = Pattern.compile("0[bB][01]+");

    /** A value as the whole number it is written as: decimal with a sign, or hex, octal or binary with their prefixes; nothing at all is zero. */
    private static BigInteger bigInt(Object v) throws Failed {
        if (v instanceof Boolean) {
            return (Boolean) v ? BigInteger.ONE : BigInteger.ZERO;
        }
        if (v instanceof Double) {
            double d = (Double) v;
            if (d != Math.rint(d) || Double.isInfinite(d) || Double.isNaN(d)) {
                throw new Failed("RangeError");
            }
            return new BigDecimal(d).toBigIntegerExact();
        }
        if (JsValues.nullish(v)) {
            throw new Failed("TypeError");
        }
        String text = Js.trim(JsValues.string(v));
        if (text.isEmpty()) {
            return BigInteger.ZERO;
        }
        if (DECIMAL.matcher(text).matches()) {
            return new BigInteger(text.startsWith("+") ? text.substring(1) : text);
        }
        if (HEX.matcher(text).matches()) {
            return new BigInteger(text.substring(2), 16);
        }
        if (OCTAL.matcher(text).matches()) {
            return new BigInteger(text.substring(2), 8);
        }
        if (BINARY.matcher(text).matches()) {
            return new BigInteger(text.substring(2), 2);
        }
        throw new Failed("SyntaxError");
    }

    /**
     * {@code encodeURIComponent}: everything but letters, digits and
     * {@code - _ . ! ~ * ' ( )} as the percent-escapes of its UTF-8 bytes.
     */
    static String encodeUriComponent(String s) {
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length();) {
            int cp = s.codePointAt(i);
            int n = Character.charCount(cp);
            if (cp < 128 && (Character.isLetterOrDigit(cp) || "-_.!~*'()".indexOf(cp) >= 0)) {
                out.append((char) cp);
            } else {
                if (cp >= 0xd800 && cp <= 0xdfff) {
                    // Half a surrogate pair has no UTF-8 form: there the previous service failed inside its runtime.
                    throw new JsValues.EngineError("a transaction hash that is not well-formed text was put into an address");
                }
                for (byte b : s.substring(i, i + n).getBytes(StandardCharsets.UTF_8)) {
                    out.append('%').append(Character.toUpperCase(Character.forDigit((b >> 4) & 15, 16))).append(Character.toUpperCase(Character.forDigit(b & 15, 16)));
                }
            }
            i += n;
        }
        return out.toString();
    }
}
