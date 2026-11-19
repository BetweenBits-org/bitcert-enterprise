package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.Swift;
import com.stonehash.attest.remit.swift.SwiftMapping;
import com.stonehash.attest.remit.swift.SwiftPayment;
import com.stonehash.attest.remit.swift.SwiftStatus;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a bank's system calls, in the order the corridor runs: quote →
 * buildInstruction (your key signs everything) → submit → track → evidence.
 * Each method is one HTTP exchange; the signing all happens locally, so what
 * leaves the machine is exactly what the bank signed and nothing else.
 *
 * <pre>{@code
 * RemitClient client = RemitClient.builder()
 *     .core(System.getenv("STONEHASH_CORE"))
 *     .apiKey(System.getenv("STONEHASH_API_KEY"))
 *     .institution(System.getenv("STONEHASH_INSTITUTION"), "Your bank")
 *     .signer(Signers.fromPkcs8Pem(Files.readString(Path.of("stonehash-remit-signing-key.pem"))))
 *     .build();
 * client.assertRegistered();
 *
 * Quote quote = client.quote("10000.00");
 * Instruction instruction = client.buildInstruction(quote, parties, new InstructionOptions().invoiceRef("INV-2026-0457"));
 * client.submit(instruction);
 * Settlement settled = client.track(instruction.paymentId());
 * }</pre>
 *
 * <p>Two ways to sign: a key held by this process ({@link Signers#fromPkcs8Pem},
 * the sandbox key the console hands out), or a {@link Signer} over an HSM, a
 * KMS or a signing service ({@link Signers#external}). Either way the SDK
 * checks every signature against the signer's public key before using it.
 *
 * <p>A client built with {@link Builder#readOnly()} holds no key and only
 * reads — for the system that follows payments and must not be able to
 * authorise one.
 *
 * <p>Instances are safe to share between threads; make one and keep it.
 */
public final class RemitClient {
    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
    private static final DateTimeFormatter COMPACT_DATE = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC);

    /** The largest answer taken for one of the platform's. Its largest real ones — an evidence package, a ledger page — are far below it. */
    private static final int MAX_ANSWER_BYTES = 16 * 1024 * 1024;

    /** Says which SDK is calling, so that a question to support can be matched to a version. */
    private static final String USER_AGENT = "stonehash-attest-remit-java/0.1.0";

    /** ISO 20022 element names the default (non-SWIFT) instruction declares. */
    private static final List<String> DEFAULT_MESSAGE_FIELDS = Arrays.asList("Dbtr", "Cdtr", "InstdAmt", "Ccy", "RmtInf");

    private final String core;
    private final String apiKey;
    private final String institutionId;
    private final String institutionName;
    private final Signer signer;
    private final boolean readOnly;
    private final Map<String, String> beneficiaryKeys;
    private final Duration requestTimeout;
    private final HttpClient http;

    private final Object metaLock = new Object();
    private Map<String, Object> metaCache;
    private long metaAt;

    /** The path from a SWIFT message to a submitted instruction. */
    private final SwiftPath swift = new SwiftPath(this);

    private RemitClient(Builder b) {
        this.core = b.core.replaceAll("/+$", "");
        this.apiKey = b.apiKey;
        this.institutionId = b.institutionId;
        this.institutionName = b.institutionName;
        this.signer = b.signer;
        this.readOnly = b.readOnly;
        this.beneficiaryKeys = new LinkedHashMap<>(b.beneficiaryKeys);
        this.requestTimeout = b.requestTimeout;
        if (b.http != null) {
            this.http = b.http;
        } else {
            // A redirect is an answer from something in between, not from the platform: never followed.
            HttpClient.Builder http = HttpClient.newBuilder().connectTimeout(b.connectTimeout).followRedirects(HttpClient.Redirect.NEVER);
            if (b.proxy != null) {
                http.proxy(ProxySelector.of(b.proxy));
            }
            this.http = http.build();
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    /** How a {@link RemitClient} is made. {@code core}, {@code apiKey} and {@code institution} are required, and a signer unless read-only. */
    public static final class Builder {
        private String core;
        private String apiKey;
        private String institutionId;
        private String institutionName;
        private Signer signer;
        private boolean readOnly;
        private final Map<String, String> beneficiaryKeys = new LinkedHashMap<>();
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(60);
        private InetSocketAddress proxy;
        private HttpClient http;

        private Builder() {
        }

        /** The platform's origin, e.g. {@code https://api.stonehash.example} or the sandbox. */
        public Builder core(String core) {
            this.core = core;
            return this;
        }

        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        /**
         * @param id   the institution id the console issued when Cross-border Settlement was activated
         * @param name your bank's name as it should appear beside its signatures
         */
        public Builder institution(String id, String name) {
            this.institutionId = id;
            this.institutionName = name;
            return this;
        }

        /** What signs for the institution: a key in this process, or an HSM/KMS behind {@link Signers#external}. */
        public Builder signer(Signer signer) {
            this.signer = signer;
            return this;
        }

        /**
         * A client that holds no signing key and only reads: the status, the
         * status report, the ledger, the evidence. Whatever would sign or send
         * throws before anything leaves this machine.
         */
        public Builder readOnly() {
            this.readOnly = true;
            return this;
        }

        /**
         * Travel Rule mode B: the encryption key your bank expects for an
         * institution, as the RFC 7638 thumbprint of its public JWK
         * (base64url). With a thumbprint here, a registry key that does not
         * match is refused and nothing is encrypted to it. Exchange the
         * thumbprint with the institution out of band.
         */
        public Builder beneficiaryKey(String institutionId, String jwkThumbprint) {
            this.beneficiaryKeys.put(institutionId, jwkThumbprint);
            return this;
        }

        /**
         * The outbound HTTP proxy the platform is reached through. Without
         * this the JVM's own proxy settings apply ({@code https.proxyHost},
         * {@code https.proxyPort}).
         */
        public Builder proxy(String host, int port) {
            this.proxy = new InetSocketAddress(Objects.requireNonNull(host, "host"), port);
            return this;
        }

        /**
         * Your own {@link HttpClient}, for what a bank's network asks of an
         * outbound connection: a proxy that wants credentials, a private
         * certificate authority, a client certificate, your own executor.
         * {@link #proxy} and {@link #connectTimeout} are then yours to set on
         * it, and it must not follow redirects — a redirect is an answer from
         * something in between, never the platform's.
         */
        public Builder httpClient(HttpClient client) {
            this.http = Objects.requireNonNull(client, "client");
            return this;
        }

        public Builder connectTimeout(Duration timeout) {
            this.connectTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /** How long one request may take, from sending it to the last byte of its answer. Default one minute. */
        public Builder requestTimeout(Duration timeout) {
            this.requestTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        public RemitClient build() {
            if (core == null || core.isEmpty() || apiKey == null || apiKey.isEmpty() || institutionId == null || institutionId.isEmpty()) {
                throw new IllegalArgumentException("RemitClient needs core, apiKey and institution");
            }
            if (institutionName == null) {
                institutionName = institutionId;
            }
            if (readOnly && signer != null) {
                throw new IllegalArgumentException("a read-only RemitClient holds no signing key — leave out signer(), or leave out readOnly()");
            }
            if (http != null && http.followRedirects() != HttpClient.Redirect.NEVER) {
                throw new IllegalArgumentException("the HttpClient given to httpClient(…) follows redirects; build it with "
                        + "followRedirects(HttpClient.Redirect.NEVER) — a redirect is not the platform's answer");
            }
            if (http != null && proxy != null) {
                throw new IllegalArgumentException("proxy(…) has no effect on an HttpClient of your own — set the proxy on that client");
            }
            if (!readOnly && signer == null) {
                throw new IllegalArgumentException("RemitClient needs a signing key: pass signer(Signers.fromPkcs8Pem(…)) for a key in this process "
                        + "or signer(Signers.external(…)) for an HSM/KMS — or readOnly() for a client that only reads");
            }
            return new RemitClient(this);
        }
    }

    // ── the wire ──────────────────────────────────────────────────────────────

    /**
     * An answer that did not come from the platform. Reported as a 502 so that
     * callers treat it as "not reached, try again" and never as an outcome.
     */
    private static RemitApiException notThePlatform(String method, String path, String what) {
        int q = path.indexOf('?');
        return new RemitApiException(502, "not_a_platform_answer",
                method + " " + (q < 0 ? path : path.substring(0, q)) + " was answered with " + what + " — not the platform's own answer. "
                        + "Something between this machine and the platform replied instead, so nothing is taken to have happened");
    }

    private Map<String, Object> call(String method, String path, Object body, String idempotencyKey) {
        if (readOnly && !"GET".equals(method)) {
            int q = path.indexOf('?');
            throw new IllegalStateException(method + " " + (q < 0 ? path : path.substring(0, q))
                    + ": this client is read-only — it reads, and sends nothing else");
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(core + path))
                .timeout(requestTimeout)
                .header("authorization", "Bearer " + apiKey)
                .header("content-type", "application/json")
                .header("user-agent", USER_AGENT);
        if (idempotencyKey != null) {
            request.header("idempotency-key", idempotencyKey);
        }
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(Json.compact(body), StandardCharsets.UTF_8));

        HttpResponse<byte[]> response;
        try {
            response = send(request.build(), "GET".equals(method));
        } catch (AnswerTooLarge e) {
            throw notThePlatform(method, path, "more than " + (MAX_ANSWER_BYTES >> 20) + " MiB");
        } catch (IOException e) {
            throw new RemitApiException(0, "unreachable", "could not reach " + core + ": " + e, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RemitApiException(0, "interrupted", "interrupted while waiting for " + core, e);
        }
        int status = response.statusCode();
        String contentType = response.headers().firstValue("content-type").orElse("with no content type");
        Object json;
        try {
            json = Json.parse(response.body(), "not_json", "the answer");
        } catch (RemitException notJson) {
            json = null;
        }
        boolean object = json instanceof Map;
        if (status >= 400) {
            // The platform refuses in its own JSON, with a code. An error page from a
            // gateway or a proxy (502, 503, a login wall) is something in between
            // answering — the request may or may not have arrived.
            Object error = object ? ((Map<?, ?>) json).get("error") : null;
            if (!(error instanceof String)) {
                throw notThePlatform(method, path, "HTTP " + status + " " + contentType);
            }
            Object message = ((Map<?, ?>) json).get("message");
            Object existing = ((Map<?, ?>) json).get("existing_payment_id");
            Object ground = ((Map<?, ?>) json).get("ground");
            throw new RemitApiException(status, (String) error, message instanceof String ? (String) message : "HTTP " + status,
                    existing instanceof String ? (String) existing : null, ground instanceof String ? (String) ground : null);
        }
        // Success is the platform saying so, in its own JSON. A proxy, a gateway or
        // a maintenance page answering 200 with something else has accepted nothing.
        if (status < 200 || status > 299 || !object) {
            throw notThePlatform(method, path, "HTTP " + status + " " + contentType);
        }
        return Json.object(json, "not_a_platform_answer", "the answer");
    }

    /**
     * A read is asked once more when the connection failed under it: a server
     * closes an idle connection, and the request that was just then sent on it
     * is lost. A write is not repeated here — its caller decides.
     */
    private HttpResponse<byte[]> send(HttpRequest request, boolean retry) throws IOException, InterruptedException {
        try {
            return exchange(request);
        } catch (AnswerTooLarge e) {
            throw e;
        } catch (IOException e) {
            if (!retry) {
                throw e;
            }
            return exchange(request);
        }
    }

    /**
     * One request and its whole answer, within the request timeout. The
     * timeout an {@link HttpRequest} carries ends when the answer's first
     * line arrives; an answer whose body then never finishes would hold the
     * calling thread for good. Here the body is inside the limit too, and so
     * is its size.
     */
    private HttpResponse<byte[]> exchange(HttpRequest request) throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<byte[]>> pending = http.sendAsync(request, (info) -> new BoundedBody());
        try {
            return pending.get(requestTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            pending.cancel(true);
            throw new HttpTimeoutException("no complete answer within " + requestTimeout.toMillis() + " ms");
        } catch (InterruptedException e) {
            pending.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof IOException) {
                throw (IOException) cause;
            }
            throw new IOException(String.valueOf(cause), cause);
        }
    }

    /** An answer no instruction, settlement or ledger page comes near: not the platform's. */
    private static final class AnswerTooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        AnswerTooLarge() {
            super("the answer is larger than " + MAX_ANSWER_BYTES + " bytes");
        }
    }

    /** Collects an answer's body, and gives up on one that grows past the limit instead of holding it in memory. */
    private static final class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> body = new CompletableFuture<>();
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        private Flow.Subscription subscription;

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            subscription.request(Long.MAX_VALUE);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            if (body.isDone()) {
                return;
            }
            for (ByteBuffer buffer : buffers) {
                if (bytes.size() + buffer.remaining() > MAX_ANSWER_BYTES) {
                    subscription.cancel();
                    body.completeExceptionally(new AnswerTooLarge());
                    return;
                }
                byte[] chunk = new byte[buffer.remaining()];
                buffer.get(chunk);
                bytes.write(chunk, 0, chunk.length);
            }
        }

        @Override
        public void onError(Throwable error) {
            body.completeExceptionally(error);
        }

        @Override
        public void onComplete() {
            body.complete(bytes.toByteArray());
        }

        @Override
        public CompletionStage<byte[]> getBody() {
            return body;
        }
    }

    private static String enc(String segment) {
        return URLEncoder.encode(segment, StandardCharsets.UTF_8).replace("+", "%20");
    }

    // ── signing ───────────────────────────────────────────────────────────────

    /** Where a read-only client stops: it has nothing to sign with. */
    private Signer mustSign(String what) {
        if (readOnly) {
            throw new IllegalStateException(what + " needs the signing key, and this client is read-only — build one with signer(…)");
        }
        return signer;
    }

    /** The public key this client signs with, SPKI DER in base64. */
    public String publicKey() {
        return mustSign("publicKey()").publicKeySpkiBase64();
    }

    private Map<String, Object> signEvent(Object payload) {
        return Signing.signEvent(mustSign("a signature"), payload, institutionId, institutionName);
    }

    // ── the Trust Registry ────────────────────────────────────────────────────

    /**
     * The Trust Registry, kept for five minutes: long enough not to ask for it
     * with every payment, short enough that a rotated key is picked up.
     * {@code fresh} asks again — but not more than once in ten seconds, so that
     * a stream of deliveries that do not verify cannot be turned into a stream
     * of requests.
     */
    private Map<String, Object> meta(boolean fresh) {
        synchronized (metaLock) {
            long age = System.currentTimeMillis() - metaAt;
            if (metaCache == null || age > 300_000 || (fresh && age > 10_000)) {
                metaAt = System.currentTimeMillis();
                metaCache = null;
                metaCache = call("GET", "/v1/remit/meta", null, null);
            }
            return metaCache;
        }
    }

    private List<Map<String, Object>> institutions(Map<String, Object> meta) {
        List<Map<String, Object>> out = new ArrayList<>();
        Object list = meta.get("institutions");
        if (list instanceof List) {
            for (Object i : (List<?>) list) {
                if (i instanceof Map) {
                    out.add(Json.object(i, "not_a_platform_answer", "an institution"));
                }
            }
        }
        return out;
    }

    private static Map<String, Object> byId(List<Map<String, Object>> institutions, String id) {
        for (Map<String, Object> i : institutions) {
            if (id.equals(i.get("id"))) {
                return i;
            }
        }
        return null;
    }

    /**
     * Confirm the registry knows this institution by exactly this key. Worth
     * calling once at start-up: a wrong key file is then a message here, before
     * the first payment, instead of a refusal on it.
     *
     * @throws RemitApiException {@code institution_unregistered} or {@code key_mismatch}
     */
    public void assertRegistered() {
        Map<String, Object> institution = byId(institutions(meta(true)), institutionId);
        if (institution == null) {
            throw new RemitApiException(404, "institution_unregistered",
                    institutionId + " is not in the Trust Registry — activate Cross-border Settlement in the console "
                            + "(Subscriptions); the institution id is issued there");
        }
        if (!publicKey().equals(institution.get("signing_spki"))) {
            throw new RemitApiException(409, "key_mismatch",
                    "the signing key given to this client is not the one registered for " + institutionId + " — "
                            + "use the key whose public half the institution verifies with (console: Integrate → institutions), "
                            + "or apply this key's public half there");
        }
    }

    // ── quote ─────────────────────────────────────────────────────────────────

    /**
     * A quote for a trade amount in USD, on the sandbox corridor (VN → SG,
     * collected in VND, paid out in SGD).
     *
     * @param tradeAmountUsd the amount as decimal text, e.g. {@code "10000.00"} — text, so no digit is lost
     * @throws RemitApiException {@code quote_mismatch} when the answer is not for what was asked; nothing is signed on it
     */
    public Quote quote(String tradeAmountUsd) {
        Objects.requireNonNull(tradeAmountUsd, "tradeAmountUsd");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("corridor", map("origin", "VN", "destination", "SG"));
        body.put("trade", map("currency", "USD", "amount", tradeAmountUsd));
        body.put("collect", map("currency", "VND"));
        body.put("payout", map("currency", "SGD"));
        Quote quote = new Quote(call("POST", "/v1/quotes", body, null));
        if (quote.quoteId() == null || quote.tradeAmount() == null) {
            throw notThePlatform("POST", "/v1/quotes", "a body that is not a quote");
        }
        // The bank signs what the quote says. It is checked to be what was asked
        // for — amount, currency, route, legs — before anything is signed on it.
        Integer compared = compareDecimal(quote.tradeAmount(), tradeAmountUsd);
        boolean same = compared != null && compared == 0 && "USD".equals(quote.tradeCurrency())
                && "VN".equals(quote.text("corridor", "origin")) && "SG".equals(quote.text("corridor", "destination"))
                && "VND".equals(quote.collectCurrency()) && "SGD".equals(quote.payoutCurrency());
        if (!same) {
            String origin = quote.text("corridor", "origin");
            String destination = quote.text("corridor", "destination");
            throw new RemitApiException(502, "quote_mismatch",
                    "a quote for " + tradeAmountUsd + " USD, VN to SG, was asked for; the answer is for " + quote.tradeAmount() + " "
                            + quote.tradeCurrency() + ", " + (origin == null ? "?" : origin) + " to " + (destination == null ? "?" : destination)
                            + " — nothing was signed");
        }
        return quote;
    }

    // ── building the instruction ──────────────────────────────────────────────

    private static final Pattern PLAIN_DECIMAL = Pattern.compile("(\\d+)(?:\\.(\\d+))?");

    /**
     * Two amounts compared exactly, as the decimal text they are
     * ({@code 12500.00}, {@code 7000.5}): negative, zero or positive as
     * {@code a} is less than, equal to or more than {@code b}; {@code null}
     * when either is not a plain decimal — digits, then optionally a full stop
     * and digits. No sign, no exponent, no spaces: an amount written any other
     * way is not taken to be the amount that was asked for.
     */
    static Integer compareDecimal(String a, String b) {
        Matcher x = PLAIN_DECIMAL.matcher(a);
        Matcher y = PLAIN_DECIMAL.matcher(b);
        if (!x.matches() || !y.matches()) {
            return null;
        }
        String xWhole = x.group(1).replaceFirst("^0+", "");
        String yWhole = y.group(1).replaceFirst("^0+", "");
        if (xWhole.length() != yWhole.length()) {
            return xWhole.length() < yWhole.length() ? -1 : 1;
        }
        // Whole parts of one length, fractions padded to one length: the digits compare as text.
        StringBuilder xDigits = new StringBuilder(xWhole).append(x.group(2) == null ? "" : x.group(2));
        StringBuilder yDigits = new StringBuilder(yWhole).append(y.group(2) == null ? "" : y.group(2));
        while (xDigits.length() < yDigits.length()) {
            xDigits.append('0');
        }
        while (yDigits.length() < xDigits.length()) {
            yDigits.append('0');
        }
        return Integer.signum(xDigits.toString().compareTo(yDigits.toString()));
    }

    private static Map<String, Object> map(Object... keyValues) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            out.put((String) keyValues[i], keyValues[i + 1]);
        }
        return out;
    }

    public Instruction buildInstruction(Quote quote, TradeParties parties) {
        return buildInstruction(quote, parties, new InstructionOptions());
    }

    /**
     * Everything the platform needs to accept an instruction, signed here:
     * the three evidence elements, the payment-release authorization, and the
     * Travel Rule payload assembled from the same party data — in clear for
     * the platform to encrypt (mode A), or encrypted here to the beneficiary
     * institution (mode B). Four signatures are requested, one after another.
     */
    public Instruction buildInstruction(Quote quote, TradeParties parties, InstructionOptions options) {
        Objects.requireNonNull(quote, "quote");
        Objects.requireNonNull(parties, "parties");
        InstructionOptions o = options == null ? new InstructionOptions() : options;
        Signer key = mustSign("buildInstruction()");
        requireTravelRuleFields(quote, parties);

        Instant instant = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        String now = ISO_MILLIS.format(instant);
        // Drawn, when the bank gives none: the day, then forty random bits. Twenty-three
        // characters, the length the ledger's column is laid out for. Forty bits, so that
        // a bank sending tens of thousands of payments a day does not draw the same id twice.
        String paymentId = o.paymentId != null ? o.paymentId
                : "PAY-" + COMPACT_DATE.format(instant) + "-" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);
        String invoiceRef = o.invoiceRef != null ? o.invoiceRef
                : "INV-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(java.util.Locale.ROOT);
        String purpose = o.purposeCode != null ? o.purposeCode : "GOODS_PAYMENT";
        InstructionOptions.Review review = o.review;
        String beneficiaryInstitution = o.beneficiaryInstitution != null ? o.beneficiaryInstitution : "SG-BFI-001";
        String tradeAmount = quote.tradeAmount();
        String tradeCurrency = quote.tradeCurrency();

        Map<String, Object> authorization = new LinkedHashMap<>();
        authorization.put("bank_id", institutionId);
        authorization.put("instruction_ref", o.instructionRef != null ? o.instructionRef : "INST-" + paymentId);
        authorization.put("fiat_received_ref", review.fiatReceivedRef != null ? review.fiatReceivedRef : "RCPT-" + paymentId);
        authorization.put("kyb_status", review.kybStatus);
        authorization.put("kyb_policy_version", review.kybPolicyVersion);
        authorization.put("trade_review", review.tradeReview);
        authorization.put("purpose_code", purpose);
        authorization.put("payment_release", "AUTHORIZED");
        authorization.put("approved_at", now);
        Object uetr = o.source == null ? null : o.source.get("uetr");
        if (uetr instanceof String && !((String) uetr).isEmpty()) {
            authorization.put("uetr", uetr);
        }

        List<Object> fields = new ArrayList<>(o.messageFields != null ? o.messageFields : DEFAULT_MESSAGE_FIELDS);
        fields.add(invoiceRef);
        Map<String, Object> bankInstruction = new LinkedHashMap<>();
        bankInstruction.put("ref", paymentId);
        bankInstruction.put("amount", tradeAmount);
        bankInstruction.put("currency", tradeCurrency);
        bankInstruction.put("debtor", parties.debtorName());
        bankInstruction.put("creditor", parties.creditorName());
        bankInstruction.put("approvedAt", now);
        bankInstruction.put("iso20022Fields", fields);
        if (o.source != null) {
            bankInstruction.put("sourceMessage", o.source);
        }

        Map<String, Object> bankApproval = new LinkedHashMap<>();
        bankApproval.put("approvalRef", "APPR-" + paymentId);
        bankApproval.put("regulatorReportRef", review.regulatorReportRef);
        bankApproval.put("approvedByRole", review.approvedByRole);
        bankApproval.put("approvedAt", now);
        bankApproval.put("fxQuote", map("pair", quote.text("collect", "rate_pair"), "rate", quote.text("collect", "rate"),
                "quotedAt", quote.quotedAt(), "validUntil", quote.expiresAt()));

        Map<String, Object> commercialDocs = new LinkedHashMap<>();
        commercialDocs.put("invoiceRef", invoiceRef);
        commercialDocs.put("amount", tradeAmount);
        commercialDocs.put("currency", tradeCurrency);
        commercialDocs.put("buyer", parties.debtorName());
        commercialDocs.put("seller", parties.creditorName());
        commercialDocs.put("attached", new ArrayList<>(Arrays.asList("invoice")));
        commercialDocs.put("citedOnly", new ArrayList<>());

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("request_id", "REQ-" + paymentId);
        body.put("payment_id", paymentId);
        body.put("quote_id", quote.quoteId());
        body.put("corridor", quote.part("corridor"));
        body.put("amount", map(
                "collected", map("currency", quote.collectCurrency(), "value", quote.collectAmount()),
                "payout", map("currency", quote.payoutCurrency(), "value", quote.payoutAmount())));
        body.put("commercial_reference", map("invoice_ref", invoiceRef,
                "invoice_commitment", Hex.sha256Hex(invoiceRef + "|" + tradeAmount + " " + tradeCurrency + "|" + parties.debtorName())));
        body.put("beneficiary", map("institution_id", beneficiaryInstitution, "beneficiary_ref", "BEN-" + paymentId));

        // Signed in the order the reference SDK signs: the three elements, then the authorization.
        Map<String, Object> signedInstruction = Signing.finishElement(key, bankInstruction, institutionId, institutionName);
        Map<String, Object> signedApproval = Signing.finishElement(key, bankApproval, institutionId, institutionName);
        Map<String, Object> signedDocs = Signing.finishElement(key, commercialDocs, institutionId, institutionName);
        Map<String, Object> bankSignature = signEvent(authorization);

        Map<String, Object> compliance;
        if (o.travelRule == InstructionOptions.TravelRule.B) {
            compliance = encryptTravelRule(paymentId, purpose, beneficiaryInstitution, quote, parties);
        } else {
            compliance = new LinkedHashMap<>();
            compliance.put("format", "IVMS101-2023");
            compliance.put("mode", "A");
            compliance.put("originator", parties.debtor());
            compliance.put("beneficiary", parties.creditor());
            compliance.put("purpose_code", purpose);
        }

        body.put("bank_authorization", authorization);
        body.put("bank_signature", bankSignature);
        body.put("compliance_payload", compliance);
        body.put("evidence_elements", map("bankInstruction", signedInstruction, "bankApproval", signedApproval, "commercialDocs", signedDocs));
        return new Instruction(paymentId, body);
    }

    /**
     * The quote names the party fields the beneficiary institution requires.
     * An instruction that lacks one is refused by the platform as
     * {@code travel_rule_incomplete}; it is refused here first, under the same
     * code, by name and before the key is asked for a single signature.
     */
    private static void requireTravelRuleFields(Quote quote, TradeParties parties) {
        List<String> missing = new ArrayList<>();
        for (String field : quote.requiredTravelRuleFields()) {
            int dot = field.indexOf('.');
            String who = dot < 0 ? "" : field.substring(0, dot);
            Map<String, Object> party = "originator".equals(who) ? parties.debtor() : "beneficiary".equals(who) ? parties.creditor() : null;
            if (party == null) {
                continue; // a field this version does not know how to look for: the platform decides
            }
            Object value = party.get(field.substring(dot + 1));
            if (!(value instanceof String) || ((String) value).trim().isEmpty()) {
                missing.add(field);
            }
        }
        if (!missing.isEmpty()) {
            throw new RemitException("travel_rule_incomplete",
                    "the beneficiary institution requires " + String.join(", ", missing) + ", and the parties given do not state "
                            + (missing.size() == 1 ? "it" : "them") + " — nothing was signed. The originator is the debtor (the importing company), "
                            + "the beneficiary the creditor (the exporting company)");
        }
    }

    /** Mode B: shape the Travel Rule message here and encrypt it to the beneficiary institution. */
    private Map<String, Object> encryptTravelRule(String paymentId, String purpose, String beneficiaryInstitution,
            Quote quote, TradeParties parties) {
        List<Map<String, Object>> institutions = institutions(meta(false));
        Map<String, Object> self = byId(institutions, institutionId);
        Map<String, Object> bfi = byId(institutions, beneficiaryInstitution);
        Map<String, Object> settle = null;
        for (Map<String, Object> i : institutions) {
            if ("SETTLEMENT_ENTITY".equals(i.get("role"))) {
                settle = i;
                break;
            }
        }
        if (bfi == null || bfi.get("encryption_jwk") == null) {
            throw new RemitApiException(502, "bfi_has_no_encryption_key", beneficiaryInstitution
                    + " publishes no encryption key in /v1/remit/meta, so the Travel Rule message cannot be encrypted to it");
        }
        if (settle == null) {
            throw new RemitApiException(502, "no_settlement_entity", "the Trust Registry lists no settlement entity");
        }
        Map<String, Object> jwk = TravelRule.jwkOf(bfi.get("encryption_jwk"));
        String pinned = beneficiaryKeys.get(beneficiaryInstitution);
        if (pinned != null && !pinned.equals(TravelRule.jwkThumbprint(jwk))) {
            throw new RemitApiException(502, "bfi_key_mismatch",
                    "the registry names an encryption key for " + beneficiaryInstitution + " (thumbprint " + TravelRule.jwkThumbprint(jwk)
                            + ") that is not the one this bank expects (" + pinned + ") — nothing was encrypted to it. If the institution "
                            + "rotated its key, confirm the new thumbprint with it and update beneficiaryKey(…)");
        }

        Map<String, Object> message = TravelRule.message(parties, paymentId, quote.tradeAmount(), quote.tradeCurrency(), purpose,
                map("id", institutionId, "name", textOr(self, "name", institutionName), "country", textOr(self, "country", quote.text("corridor", "origin"))),
                map("id", beneficiaryInstitution, "name", textOr(bfi, "name", beneficiaryInstitution),
                        "country", textOr(bfi, "country", quote.text("corridor", "destination"))),
                map("id", settle.get("id"), "name", textOr(settle, "name", String.valueOf(settle.get("id")))),
                quote.settlementAmount());
        String digest = Hex.sha256Hex(Json.canonicalBytes(message));
        String ciphertext = TravelRule.encryptToInstitution(Text.utf8(Json.compact(message)), jwk, beneficiaryInstitution + "-ENC");
        // What the bank puts its key to: not only that the fields are there, but
        // which message they are in. The digest of the message and of the
        // ciphertext are signed, so whoever relays the instruction cannot put
        // another message — another beneficiary account — in its place.
        Map<String, Object> assertion = new LinkedHashMap<>();
        assertion.put("payment_id", paymentId);
        assertion.put("required_fields_present", Boolean.TRUE);
        assertion.put("field_count", Long.valueOf(quote.requiredTravelRuleFieldCount()));
        assertion.put("schema", "IVMS101-2023");
        assertion.put("ivms101_digest", digest);
        assertion.put("ciphertext_sha256", Hex.sha256Hex(ciphertext));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("format", "IVMS101-2023");
        out.put("mode", "B");
        out.put("ciphertext", ciphertext);
        out.put("ivms101_digest", digest);
        out.put("fields_assertion", map("payload", assertion, "sig", signEvent(assertion)));
        return out;
    }

    private static String textOr(Map<String, Object> from, String key, String otherwise) {
        Object v = from == null ? null : from.get(key);
        return v instanceof String && !((String) v).isEmpty() ? (String) v : otherwise;
    }

    // ── from a SWIFT message ──────────────────────────────────────────────────

    /**
     * Read an MT103, a pacs.008 or a pain.001 and say what would be sent: the
     * mapping table, what is missing, what has no place. Nothing is signed
     * and nothing leaves the machine.
     *
     * @param message the message as your payment system wrote it
     * @throws com.stonehash.attest.remit.swift.SwiftMessageException when it cannot be read as one of the three
     */
    public SwiftMapping inspectSwift(byte[] message) {
        return swift.map(Objects.requireNonNull(message, "message"), new SwiftOptions());
    }

    public SwiftMapping inspectSwift(byte[] message, SwiftOptions options) {
        return swift.map(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    public SwiftMapping inspectSwift(String message) {
        return swift.map(Objects.requireNonNull(message, "message"), new SwiftOptions());
    }

    public SwiftMapping inspectSwift(String message, SwiftOptions options) {
        return swift.map(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    /** As {@link #inspectSwift(byte[])}, for one payment already parsed out of a file of many ({@code Swift.parseAll}). */
    public SwiftMapping inspectSwift(SwiftPayment payment) {
        return swift.map(Objects.requireNonNull(payment, "payment"), new SwiftOptions());
    }

    public SwiftMapping inspectSwift(SwiftPayment payment, SwiftOptions options) {
        return swift.map(Objects.requireNonNull(payment, "payment"), Objects.requireNonNull(options, "options"));
    }

    /**
     * A signed settlement instruction made from a SWIFT message: parse, map,
     * quote, sign. Not submitted — {@link #submit(Instruction)} does that, or
     * use {@link #submitSwift(byte[])} for the whole path.
     *
     * @throws com.stonehash.attest.remit.swift.SwiftMappingException {@code mapping_incomplete}, with every missing
     *         field named in the message's own vocabulary, when the message lacks something the corridor requires
     */
    public SwiftInstruction instructionFromSwift(byte[] message) {
        return instructionFromSwift(message, new SwiftOptions());
    }

    public SwiftInstruction instructionFromSwift(byte[] message, SwiftOptions options) {
        mustSign("instructionFromSwift()");
        return swift.instruction(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    public SwiftInstruction instructionFromSwift(String message) {
        return instructionFromSwift(message, new SwiftOptions());
    }

    public SwiftInstruction instructionFromSwift(String message, SwiftOptions options) {
        mustSign("instructionFromSwift()");
        return swift.instruction(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    public SwiftInstruction instructionFromSwift(SwiftPayment payment) {
        return instructionFromSwift(payment, new SwiftOptions());
    }

    public SwiftInstruction instructionFromSwift(SwiftPayment payment, SwiftOptions options) {
        mustSign("instructionFromSwift()");
        return swift.instruction(Objects.requireNonNull(payment, "payment"), Objects.requireNonNull(options, "options"));
    }

    /**
     * The whole path for a SWIFT message: parse → map → quote → sign → submit.
     *
     * <p>Safe to repeat. The payment id is derived from the message's own
     * references, and the ledger is asked for them first, so a payment handed
     * over twice is recognised: the second call sends nothing and returns the
     * settlement's current state with {@link SwiftSubmission#already()} true.
     * A reference that comes back on a <em>different</em> payment (another
     * amount, other parties, another account or invoice) is refused as
     * {@code reference_reused} — it is never mistaken for a repeat.
     *
     * <p>The platform holds the same line at acceptance: one message is one
     * settlement there, also when two processes hand the same payment over at
     * the same moment. The one that came second is answered
     * {@code duplicate_source_message}, and this call turns that into the same
     * {@link SwiftSubmission#already()} — unless the two cannot be told apart
     * at all (the same identifiers and content, and no value date), which is
     * passed on as the refusal it is.
     *
     * <p>Without a UETR a payment is recognised by its own identifiers and its
     * value date — the reference-and-date rule of a bank's duplicate check. A
     * payment that comes again with the same instruction and end-to-end
     * identifiers, the same value date and the same content is the same
     * payment, in whatever message it stands; on another day, or with other
     * content, it is a new one. The UETR is what makes a payment recognisable
     * beyond doubt.
     *
     * @param message the MT103, pacs.008 or pain.001 as your payment system wrote it
     * @throws com.stonehash.attest.remit.swift.SwiftMessageException when it cannot be read
     * @throws com.stonehash.attest.remit.swift.SwiftMappingException {@code mapping_incomplete}
     * @throws RemitApiException {@code reference_reused}, {@code payment_id_conflict}, or the platform's refusal; where it names
     *         the settlement that already stands for the message, {@link RemitApiException#existingPaymentId()} is that settlement
     */
    public SwiftSubmission submitSwift(byte[] message) {
        return submitSwift(message, new SwiftOptions());
    }

    public SwiftSubmission submitSwift(byte[] message, SwiftOptions options) {
        mustSign("submitSwift()");
        return swift.submit(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    public SwiftSubmission submitSwift(String message) {
        return submitSwift(message, new SwiftOptions());
    }

    public SwiftSubmission submitSwift(String message, SwiftOptions options) {
        mustSign("submitSwift()");
        return swift.submit(Objects.requireNonNull(message, "message"), Objects.requireNonNull(options, "options"));
    }

    /** As {@link #submitSwift(byte[])}, for one payment already parsed out of a file of many ({@code Swift.parseAll}). */
    public SwiftSubmission submitSwift(SwiftPayment payment) {
        return submitSwift(payment, new SwiftOptions());
    }

    public SwiftSubmission submitSwift(SwiftPayment payment, SwiftOptions options) {
        mustSign("submitSwift()");
        return swift.submit(Objects.requireNonNull(payment, "payment"), Objects.requireNonNull(options, "options"));
    }

    /**
     * The settlement's state as an ISO 20022 transaction status. For a
     * settlement already read, {@code Swift.statusOf(settlement.json())} is
     * the same without another request.
     */
    public SwiftStatus swiftStatus(String paymentId) {
        return Swift.statusOf(status(paymentId).json());
    }

    /**
     * The settlement's state as a {@code pacs.002} status report (XML). For a
     * settlement already read, {@code Swift.buildPacs002(settlement.json())}.
     */
    public String statusReport(String paymentId) {
        return Swift.buildPacs002(status(paymentId).json());
    }


    // ── submitting, reading, and what follows ────────────────────────────────

    /** Submit a signed instruction. */
    public Settlement submit(Instruction instruction) {
        return submit(instruction.body(), null);
    }

    /**
     * Submit a signed instruction body. Returns only when the platform has
     * named the payment it accepted: an answer without that is not an
     * acceptance. Safe to repeat with the same idempotency key.
     *
     * @param idempotencyKey {@code null} for the default, {@code sdk-<payment id>}
     */
    public Settlement submit(Map<String, Object> body, String idempotencyKey) {
        Object paymentId = body.get("payment_id");
        Map<String, Object> accepted = call("POST", "/v1/settlements", body,
                idempotencyKey != null ? idempotencyKey : "sdk-" + paymentId);
        if (paymentId == null || !paymentId.equals(accepted.get("payment_id")) || !(accepted.get("state") instanceof String)) {
            throw notThePlatform("POST", "/v1/settlements", "a body that does not name the payment and its state");
        }
        return new Settlement(accepted);
    }

    /** What the platform holds for a payment. */
    public Settlement status(String paymentId) {
        Map<String, Object> view = call("GET", "/v1/settlements/" + enc(paymentId), null, null);
        if (!(view.get("payment_id") instanceof String) || !(view.get("state") instanceof String) || !(view.get("events") instanceof List)) {
            throw notThePlatform("GET", "/v1/settlements/{id}", "a body that is not a settlement");
        }
        return new Settlement(view);
    }

    /** {@link #status}, or empty when the organisation has no such settlement. */
    public Optional<Settlement> find(String paymentId) {
        try {
            return Optional.of(status(paymentId));
        } catch (RemitApiException e) {
            if (e.status() == 404) {
                return Optional.empty();
            }
            throw e;
        }
    }

    /**
     * One page of the settlement ledger. Server-side filters, keyset cursor:
     * pass {@code page.next_cursor} of one page as {@code cursor} of the next.
     * {@code q} matches the payment id, quote id, chain transaction, payout
     * bank reference and the references of the originating SWIFT message — a
     * part of any of them.
     *
     * <p>{@code source_uetr} and {@code source_content} are exact lookups on
     * the message a settlement was made from: the whole UETR, or the content
     * digest signed into the instruction ({@code source_value_date},
     * {@code YYYY-MM-DD}, narrows the latter to one value date). They answer
     * "is this payment here already?".
     *
     * @param filters any of {@code q}, {@code source_uetr}, {@code source_content}, {@code source_value_date}, {@code state},
     *                {@code from}, {@code to}, {@code cursor}, {@code limit}; may be empty
     * @return the page as the platform answers it: {@code data} (rows) and {@code page} ({@code total}, {@code returned}, {@code next_cursor})
     */
    public Map<String, Object> list(Map<String, String> filters) {
        StringBuilder query = new StringBuilder();
        for (String name : Arrays.asList("q", "source_uetr", "source_content", "source_value_date", "state", "from", "to", "cursor", "limit")) {
            String value = filters == null ? null : filters.get(name);
            if (value != null && !value.isEmpty()) {
                query.append(query.length() == 0 ? '?' : '&').append(name).append('=').append(enc(value));
            }
        }
        Map<String, Object> page = call("GET", "/v1/settlements" + query, null, null);
        if (!(page.get("data") instanceof List) || !(page.get("page") instanceof Map)) {
            throw notThePlatform("GET", "/v1/settlements", "a body that is not a ledger page");
        }
        return page;
    }

    /** The evidence package of a payment, its commitment and its anchor — what {@link EvidenceVerifier} re-checks. */
    public Map<String, Object> evidence(String paymentId) {
        return call("GET", "/v1/settlements/" + enc(paymentId) + "/evidence", null, null);
    }

    public Settlement cancel(String paymentId, String reason) {
        Map<String, Object> payload = map("payment_id", paymentId, "reason", reason);
        return new Settlement(call("POST", "/v1/settlements/" + enc(paymentId) + "/cancel",
                map("reason", reason, "sig", signEvent(payload)), null));
    }

    /** Answer a Travel Rule request for information. */
    public Settlement answerRfi(String paymentId, Map<String, String> answers) {
        Map<String, Object> copy = new LinkedHashMap<>(answers);
        Map<String, Object> payload = map("payment_id", paymentId, "answers", copy);
        return new Settlement(call("POST", "/v1/settlements/" + enc(paymentId) + "/rfi-response",
                map("answers", copy, "sig", signEvent(payload)), null));
    }

    /** The day's payments, signed: the bank's side of the daily reconciliation. */
    public Map<String, Object> submitDailyManifest(String date, List<String> paymentIds) {
        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("date", date);
        manifest.put("institution_id", institutionId);
        manifest.put("payment_ids", new ArrayList<Object>(paymentIds));
        manifest.put("count", Long.valueOf(paymentIds.size()));
        return call("POST", "/v1/manifests/daily", map("manifest", manifest, "sig", signEvent(manifest)), null);
    }

    /**
     * Check a webhook delivery before acting on it: the platform signs every
     * envelope, and this verifies the signature against the platform key the
     * Trust Registry publishes. Returns the envelope only when it verifies.
     * Deliveries are at-least-once — dedupe on {@code event_id}, order by {@code sequence}.
     *
     * @param deliveryJson the request body the platform delivered, as text
     */
    public Optional<Map<String, Object>> verifyWebhook(String deliveryJson) {
        Object parsed;
        try {
            parsed = Json.parse(deliveryJson, "invalid_json");
        } catch (RemitException e) {
            return Optional.empty();
        }
        if (!(parsed instanceof Map)) {
            return Optional.empty();
        }
        Map<String, Object> delivery = Json.object(parsed, "invalid_json", "the delivery");
        Object envelope = delivery.get("envelope");
        Object signature = delivery.get("signature");
        if (!(envelope instanceof Map) || !(signature instanceof Map)) {
            return Optional.empty();
        }
        for (boolean fresh : new boolean[] { false, true }) {
            // A second look with a fresh key covers a platform key rotation.
            Object signerInfo = meta(fresh).get("platform_signer");
            Object spki = signerInfo instanceof Map ? ((Map<?, ?>) signerInfo).get("spki") : null;
            boolean valid;
            try {
                valid = spki instanceof String && Signing.verifyEvent(envelope, signature, (String) spki);
            } catch (RemitException notCanonical) {
                valid = false;
            }
            if (valid) {
                return Optional.of(Json.object(envelope, "invalid_json", "the envelope"));
            }
        }
        return Optional.empty();
    }

    /** {@link #track(String, Duration, Duration, BiConsumer)} for up to three minutes, asking every second and a half. */
    public Settlement track(String paymentId) {
        return track(paymentId, Duration.ofMinutes(3), Duration.ofMillis(1500), null);
    }

    /** As {@link #track(String)}, telling {@code onState} each new state as it is first seen. */
    public Settlement track(String paymentId, BiConsumer<String, Settlement> onState) {
        return track(paymentId, Duration.ofMinutes(3), Duration.ofMillis(1500), onState);
    }

    /**
     * Wait for a terminal-or-paused outcome. Returns on {@code EVIDENCE_ANCHORED}
     * and on every state where the pipeline stops moving on its own (a Travel
     * Rule request for information, {@code CANCELLED}, {@code RETURNED},
     * {@code EXCEPTION}, an evidence hold) — the caller decides what each of
     * those means for its ledger.
     *
     * @param onState called with each new state as it is first seen; may be {@code null}
     * @throws RemitApiException {@code tracking_timeout}
     */
    public Settlement track(String paymentId, Duration timeout, Duration interval, BiConsumer<String, Settlement> onState) {
        long started = System.currentTimeMillis();
        String last = "";
        for (;;) {
            Settlement view = status(paymentId);
            if (!view.state().equals(last)) {
                last = view.state();
                if (onState != null) {
                    onState.accept(last, view);
                }
            }
            List<String> types = view.eventTypes();
            // A question asked after an earlier answer waits for the bank as much as the first did.
            boolean paused = ("TRAVEL_RULE_PENDING".equals(last) && view.travelRuleQuestionOpen())
                    || ("PAYOUT_IN_PROGRESS".equals(last) && types.contains("EVIDENCE_INSUFFICIENT"));
            if (view.isFinal() || paused) {
                return view;
            }
            if (System.currentTimeMillis() - started > timeout.toMillis()) {
                throw new RemitApiException(408, "tracking_timeout", "payment " + paymentId + " still " + last + " after timeout");
            }
            try {
                Thread.sleep(interval.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RemitApiException(0, "interrupted", "interrupted while tracking " + paymentId, e);
            }
        }
    }

    // ── what the SWIFT path needs from this class ─────────────────────────────

    String institutionId() {
        return institutionId;
    }

    boolean testKey() {
        return apiKey.startsWith("sk_test_");
    }
}
