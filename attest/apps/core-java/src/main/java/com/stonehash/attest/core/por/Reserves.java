package com.stonehash.attest.core.por;

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
 * Reserve measurement — the on-chain half of the solvency picture.
 *
 * <p>The statement declares addresses; this reads their token balances from
 * the chain at the time the snapshot is accepted or verified. Reading, not
 * trusting: the figure in a snapshot's reserve report came from an
 * {@code eth_call}, not from the exchange. An entry on a chain this
 * deployment cannot reach is reported {@code DECLARED_ONLY} and never
 * counted; one whose read failed is {@code UNREACHABLE} with what went wrong.
 *
 * <p>Deliberately not here: proof that the exchange controls an address.
 * The report says which addresses were measured and leaves ownership as the
 * declared claim it is.
 */
public final class Reserves {
    private Reserves() {
    }

    /** {@code balanceOf(address)}. */
    private static final String BALANCE_OF = "0x70a08231";
    /** How long one read may take, start to finish. */
    static final Duration TIMEOUT = Duration.ofMillis(5_000);

    private static final HttpClient HTTP = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NORMAL).proxy(HttpClient.Builder.NO_PROXY).connectTimeout(TIMEOUT).build();

    /** A read that did not come to a balance; the message is what the report says of it. */
    static final class Unreadable extends Exception {
        private static final long serialVersionUID = 1L;

        Unreadable(String message) {
            super(message);
        }
    }

    /**
     * Read every declared entry, in order, one after the other.
     *
     * @param entries {@code { chain, asset, address, token_contract? }} with text values, as {@link SnapshotStatement#unanchorable} left them
     * @param localChain the one chain this deployment reads
     * @param rpcUrl where it reads it
     * @return one measurement per entry: {@code chain, asset, address, status} and {@code balance, measured_at} or {@code detail}
     */
    public static List<Map<String, Object>> measure(List<?> entries, String localChain, String rpcUrl) {
        return measure(entries, localChain, rpcUrl, TIMEOUT);
    }

    static List<Map<String, Object>> measure(List<?> entries, String localChain, String rpcUrl, Duration timeout) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object e : entries) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("chain", JsValues.member(e, "chain"));
            m.put("asset", JsValues.member(e, "asset"));
            m.put("address", JsValues.member(e, "address"));
            Object token = JsValues.member(e, "token_contract");
            if (!localChain.equals(m.get("chain")) || !JsValues.truthy(token)) {
                m.put("status", "DECLARED_ONLY");
                m.put("detail", "no reachable RPC for this chain in the sandbox");
                out.add(m);
                continue;
            }
            try {
                BigInteger balance = balanceOf(rpcUrl, (String) token, (String) m.get("address"), timeout);
                m.put("status", "MEASURED");
                m.put("balance", balance.toString());
                m.put("measured_at", IsoTime.now());
            } catch (Unreadable err) {
                m.put("status", "UNREACHABLE");
                m.put("detail", err.getMessage());
            }
            out.add(m);
        }
        return out;
    }

    /** The request one read sends: an {@code eth_call} of {@code balanceOf(holder)} on the token, at the latest block. */
    static String request(String token, String holder) {
        String address = holder.startsWith("0x") ? holder.substring(2) : holder;
        StringBuilder data = new StringBuilder(BALANCE_OF);
        String lower = address.toLowerCase(Locale.ROOT);
        for (int i = lower.length(); i < 64; i++) {
            data.append('0');
        }
        data.append(lower);
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("to", token);
        call.put("data", data.toString());
        List<Object> params = new ArrayList<>();
        params.add(call);
        params.add("latest");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("jsonrpc", "2.0");
        body.put("id", 1d);
        body.put("method", "eth_call");
        body.put("params", params);
        return Js.stringify(body);
    }

    private static BigInteger balanceOf(String rpcUrl, String token, String holder, Duration timeout) throws Unreadable {
        URI uri;
        try {
            uri = URI.create(rpcUrl);
            if (uri.getScheme() == null || uri.getHost() == null) {
                throw new IllegalArgumentException("not an absolute URL");
            }
        } catch (IllegalArgumentException e) {
            throw new Unreadable("Failed to parse URL from " + rpcUrl);
        }
        HttpRequest req = HttpRequest.newBuilder(uri).header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(request(token, holder), StandardCharsets.UTF_8)).build();
        CompletableFuture<HttpResponse<byte[]>> pending = HTTP.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray());
        byte[] bytes;
        try {
            bytes = pending.get(timeout.toMillis(), TimeUnit.MILLISECONDS).body();
        } catch (TimeoutException e) {
            pending.cancel(true);
            throw new Unreadable("The operation was aborted due to timeout");
        } catch (ExecutionException e) {
            throw new Unreadable("fetch failed");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Unreadable("fetch failed");
        }
        return balance(bytes);
    }

    /** The balance an RPC answer states, or why it states none. */
    static BigInteger balance(byte[] answer) throws Unreadable {
        String text = new String(answer, StandardCharsets.UTF_8);
        if (text.startsWith("﻿")) {
            text = text.substring(1);
        }
        Object json;
        try {
            json = Js.parse(text);
        } catch (Js.SyntaxException e) {
            throw new Unreadable("the reserve RPC did not answer in JSON");
        }
        if (json == null) {
            throw new Unreadable("the reserve RPC answered null");
        }
        try {
            Object error = JsValues.member(json, "error");
            Object result = JsValues.member(json, "result");
            if (JsValues.truthy(error) || !JsValues.truthy(result)) {
                Object message = JsValues.memberIfAny(error, "message");
                throw new Unreadable(JsValues.nullish(message) ? "empty eth_call result" : JsValues.string(message));
            }
            return bigInt(result);
        } catch (JsValues.EngineError e) {
            // An object that names its own `toString` cannot be written into a sentence or read as a number.
            throw new Unreadable("Cannot convert object to primitive value");
        }
    }

    private static final Pattern DECIMAL = Pattern.compile("[+-]?[0-9]+");
    private static final Pattern HEX = Pattern.compile("0[xX][0-9a-fA-F]+");
    private static final Pattern OCTAL = Pattern.compile("0[oO][0-7]+");
    private static final Pattern BINARY = Pattern.compile("0[bB][01]+");

    /** A value as the integer it is written as: decimal with a sign, or hex, octal or binary with their prefixes; white space around it and nothing at all are read as the service always read them. */
    static BigInteger bigInt(Object v) throws Unreadable {
        if (v instanceof Boolean) {
            return (Boolean) v ? BigInteger.ONE : BigInteger.ZERO;
        }
        if (v instanceof Double) {
            double d = (Double) v;
            if (d != Math.rint(d) || Double.isInfinite(d) || Double.isNaN(d)) {
                throw new Unreadable("The number " + Js.numberToString(d) + " cannot be converted to a BigInt because it is not an integer");
            }
            return new BigDecimal(d).toBigIntegerExact();
        }
        String original = JsValues.string(v);
        String text = Js.trim(original);
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
        throw new Unreadable("Cannot convert " + original + " to a BigInt");
    }

    /**
     * Coverage per asset: measured reserves over committed liabilities.
     *
     * @param totals the statement's totals, as it wrote them
     * @param measurements what {@link #measure} returned
     * @return one line per asset of the totals, in their order: {@code asset, liabilities, reserves_measured, coverage, status}
     */
    public static List<Map<String, Object>> solvency(Object totals, List<Map<String, Object>> measurements) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<String, Object> e : SumTree.own(totals).entrySet()) {
            String asset = e.getKey();
            Object liabilities = e.getValue();
            BigInteger measured = BigInteger.ZERO;
            boolean hasMeasurement = false;
            for (Map<String, Object> m : measurements) {
                if (asset.equals(m.get("asset")) && "MEASURED".equals(m.get("status"))) {
                    hasMeasurement = true;
                    measured = measured.add(new BigInteger((String) m.get("balance")));
                }
            }
            Object coverage = null;
            if (hasMeasurement) {
                BigInteger owed = SumTree.integer(liabilities);
                if (owed.signum() > 0) {
                    // Per cent with four implied decimals, cut — not rounded — to two.
                    StringBuilder text = new StringBuilder(measured.multiply(BigInteger.valueOf(1_000_000)).divide(owed).toString());
                    while (text.length() < 5) {
                        text.insert(0, '0');
                    }
                    int n = text.length();
                    coverage = text.substring(0, n - 4) + "." + text.substring(n - 4, n - 2) + "%";
                }
            }
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("asset", asset);
            line.put("liabilities", liabilities);
            line.put("reserves_measured", measured.toString());
            line.put("coverage", coverage);
            line.put("status", hasMeasurement ? "MEASURED" : "NOT_MEASURED");
            out.add(line);
        }
        return out;
    }
}
