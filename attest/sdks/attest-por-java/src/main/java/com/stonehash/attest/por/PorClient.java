package com.stonehash.attest.por;

import java.io.IOException;
import java.net.ConnectException;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import javax.net.ssl.SSLContext;

/**
 * The exchange's side of the platform API (specification §9): look up the
 * registered key, hand over a signed statement, see where its anchor stands.
 *
 * <p>What is transmitted, in full:
 * <ul>
 * <li>{@link #submit} — the statement and its signature. Root, totals, the
 *     number of accounts, the as-of time. No account, no balance, no leaf.
 * <li>{@link #submitWithSpotCheck} — the same, and then, for the accounts the
 *     platform picks at random, each one's hashed reference, salt and
 *     balances with the sums beside it up the tree. That is account-level
 *     data leaving the building, pseudonymously, which is why a spot check is
 *     something the exchange asks for rather than something it gets.
 * </ul>
 * The tree and every leaf stay in this process either way.
 *
 * <p><b>Connections.</b> Calls here can be minutes apart — a tree is rebuilt
 * between two of them — and the platform closes a connection that has been
 * idle for five seconds. A request must never be lost to a pooled connection
 * the server has meanwhile closed, so:
 * <ul>
 * <li>every POST is sent by an {@code HttpClient} made for it alone, and so
 *     can only travel on a connection opened for it;
 * <li>GETs, which may be repeated without consequence, share one client, and
 *     one that fails before an answer arrives is sent once more on a new
 *     connection.
 * </ul>
 * Not a client per request for everything: an {@code HttpClient} on Java 11
 * cannot be closed, and each discarded one keeps its selector thread until
 * the garbage collector reclaims it — a status poll every two seconds would
 * pile those up.
 *
 * <p>The API key travels in the {@code Authorization} header and nowhere
 * else: it is in no URL, no exception and no {@code toString()}. Instances
 * are immutable and safe to share between threads; make one and keep it,
 * since each holds an {@code HttpClient} of its own.
 */
public final class PorClient {
    /** The platform's answers are a few kilobytes; one that is not is not an answer to wait for. */
    private static final int MAX_ANSWER_BYTES = 8 << 20;
    private static final String USER_AGENT = "stonehash-attest-por-java/0.1.0";

    private final String base;
    private final String apiKey;
    private final Duration connectTimeout;
    private final Duration requestTimeout;
    private final Duration pollInterval;
    private final ProxySelector proxy;
    private final SSLContext sslContext;
    private final HttpClient shared;

    private PorClient(Builder b) {
        this.base = b.base;
        this.apiKey = b.apiKey;
        this.connectTimeout = b.connectTimeout;
        this.requestTimeout = b.requestTimeout;
        this.pollInterval = b.pollInterval;
        this.proxy = b.proxy;
        this.sslContext = b.sslContext;
        this.shared = newHttpClient();
    }

    /**
     * @param baseUrl the deployment's origin, for example {@code https://attest.example}
     * @throws PorException {@code invalid_url}
     */
    public static Builder builder(String baseUrl) {
        return new Builder(baseUrl);
    }

    /** Settings of a {@link PorClient}. Only the base URL is required. */
    public static final class Builder {
        private final String base;
        private String apiKey;
        private Duration connectTimeout = Duration.ofSeconds(10);
        private Duration requestTimeout = Duration.ofSeconds(120);
        private Duration pollInterval = Duration.ofSeconds(2);
        private ProxySelector proxy;
        private SSLContext sslContext;

        private Builder(String baseUrl) {
            String trimmed = Objects.requireNonNull(baseUrl, "baseUrl");
            while (trimmed.endsWith("/")) {
                trimmed = trimmed.substring(0, trimmed.length() - 1);
            }
            URI uri;
            try {
                uri = URI.create(trimmed);
            } catch (IllegalArgumentException e) {
                throw new PorException("invalid_url", "the platform URL is not a URL");
            }
            boolean http = "http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme());
            // User info in a URL is a credential that would end up in receipts and messages.
            if (!http || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null) {
                throw new PorException("invalid_url",
                        "the platform URL must be an http(s) origin such as https://attest.example, without credentials or a query");
            }
            this.base = trimmed;
        }

        /**
         * The API key. Needed for everything except {@link PorClient#registeredKey} and
         * {@link PorClient#publicUrl}.
         *
         * @throws PorException {@code invalid_api_key} when the key could not travel in a header. The message
         *                      does not quote it.
         */
        public Builder apiKey(String apiKey) {
            Objects.requireNonNull(apiKey, "apiKey");
            boolean usable = !apiKey.isEmpty();
            for (int i = 0; usable && i < apiKey.length(); i++) {
                usable = apiKey.charAt(i) > 0x20 && apiKey.charAt(i) < 0x7f;
            }
            if (!usable) {
                throw new PorException("invalid_api_key",
                        "the API key is empty or holds a space, a line break or a non-ASCII character");
            }
            this.apiKey = apiKey;
            return this;
        }

        /** How long to wait for a connection (default 10 seconds). */
        public Builder connectTimeout(Duration timeout) {
            this.connectTimeout = positive(timeout);
            return this;
        }

        /** How long to wait for the platform's answer to one request (default 120 seconds). */
        public Builder requestTimeout(Duration timeout) {
            this.requestTimeout = positive(timeout);
            return this;
        }

        /** How often {@link PorClient#waitAnchored} asks (default every 2 seconds). */
        public Builder pollInterval(Duration interval) {
            this.pollInterval = positive(interval);
            return this;
        }

        /** The proxy to go through, when the JVM's default selection is not the one to use. */
        public Builder proxy(ProxySelector proxy) {
            this.proxy = Objects.requireNonNull(proxy, "proxy");
            return this;
        }

        /** The TLS configuration, when the platform's certificate is not signed by an authority the JVM trusts by default. */
        public Builder sslContext(SSLContext sslContext) {
            this.sslContext = Objects.requireNonNull(sslContext, "sslContext");
            return this;
        }

        public PorClient build() {
            return new PorClient(this);
        }

        private static Duration positive(Duration d) {
            if (Objects.requireNonNull(d, "duration").isZero() || d.isNegative()) {
                throw new PorException("invalid_option", "a timeout or interval must be longer than zero");
            }
            return d;
        }
    }

    // ── the calls ───────────────────────────────────────────────────────────

    /**
     * The public key the platform will check this exchange's signatures
     * against: SubjectPublicKeyInfo DER, base64. No API key is needed.
     *
     * @throws PorApiException {@code institution_unregistered} when the registry has no signing key for the id
     */
    public String registeredKey(String institutionId) {
        Objects.requireNonNull(institutionId, "institutionId");
        Answer meta = call("/v1/remit/meta", null);
        Object institutions = meta.json.get("institutions");
        if (institutions instanceof List) {
            for (Object entry : (List<?>) institutions) {
                if (entry instanceof Map && institutionId.equals(((Map<?, ?>) entry).get("id"))) {
                    Object spki = ((Map<?, ?>) entry).get("signing_spki");
                    if (spki instanceof String && !((String) spki).isEmpty()) {
                        return (String) spki;
                    }
                }
            }
        }
        throw new PorApiException(meta.status, "institution_unregistered",
                institutionId + " has no signing key in the platform's registry", meta.json);
    }

    /**
     * Hands a signed statement to the platform. Nothing but the statement
     * and its signature is sent, and the call returns once the platform has
     * accepted it for anchoring.
     *
     * @throws PorException    {@code invalid_submission} when the submission is malformed — nothing is sent
     * @throws PorApiException when the platform refuses or cannot be reached
     */
    public SubmitResult submit(Submission submission) {
        Answer a = call("/v1/por/snapshots", body(submission, false));
        String attestation = a.json.get("attestation_id") instanceof String ? (String) a.json.get("attestation_id") : null;
        if (!"ACCEPTED".equals(a.json.get("status")) || attestation == null) {
            // A platform that predates the root-only path answers with a challenge.
            throw new PorApiException(a.status, "spot_check_required", "the platform answered "
                    + a.json.get("status") + "; it expects a spot check — submit with the local tree", a.json);
        }
        return new SubmitResult(snapshotId(a), attestation, "ACCEPTED", 0, Boolean.TRUE.equals(a.json.get("already")),
                false, Collections.emptyList());
    }

    /**
     * Hands a signed statement to the platform and asks it to sample the
     * tree before anchoring. The platform answers with a challenge — leaf
     * positions of its choosing — and this call opens exactly those leaves
     * from the local tree and sends the openings. An opening holds the
     * leaf's hashed reference, salt and balances and the sums up the tree;
     * it never holds an account reference.
     *
     * @param tree the tree the statement was built from; checked against the statement before anything is sent
     * @return the result, including the openings exactly as they were sent
     * @throws PorException    {@code tree_mismatch} when the tree is not the statement's — nothing is sent
     * @throws PorApiException {@code openings_rejected} (HTTP 422) when the platform's check of the sample fails
     */
    public SubmitResult submitWithSpotCheck(Submission submission, PorTree tree) {
        Objects.requireNonNull(tree, "tree");
        Map<String, Object> first = body(submission, true);
        Statement st = submission.statement();
        if (!tree.root().equals(st.root()) || tree.leafCount() != st.leafCount() || !tree.totals().equals(st.totals())) {
            throw new PorException("tree_mismatch",
                    "the local tree is not the one this statement was built from; nothing was sent");
        }
        Answer challenged = call("/v1/por/snapshots", first);
        String id = snapshotId(challenged);
        Object challenge = challenged.json.get("challenge");
        Object indices = challenge instanceof Map ? ((Map<?, ?>) challenge).get("indices") : null;
        if (!(indices instanceof List)) {
            throw new PorApiException(challenged.status, "invalid_response",
                    "a spot check was asked for, but the platform's answer carries no challenge", challenged.json);
        }
        List<InclusionProof> openings = new ArrayList<>();
        List<Object> openingsJson = new ArrayList<>();
        for (Object index : (List<?>) indices) {
            if (!(index instanceof Long) || (Long) index < 0 || (Long) index >= tree.leafCount()) {
                throw new PorApiException(challenged.status, "challenge_out_of_range",
                        "challenged index " + index + " is not in the local tree; no leaf was opened", challenged.json);
            }
            // Pseudonymous by construction: prove() has no account reference to put in.
            InclusionProof opening = tree.prove((int) (long) (Long) index);
            openings.add(opening);
            openingsJson.add(opening.toMap());
        }
        Map<String, Object> second = new LinkedHashMap<>();
        second.put("openings", openingsJson);
        Answer verified;
        try {
            verified = call("/v1/por/snapshots/" + segment(id) + "/openings", second);
        } catch (PorApiException e) {
            if (e.status() == 422 && "REJECTED".equals(e.body().get("status"))) {
                throw new PorApiException(422, "openings_rejected",
                        "the platform rejected the openings: " + e.body().get("problems"), e.body());
            }
            throw e;
        }
        String attestation = verified.json.get("attestation_id") instanceof String ? (String) verified.json.get("attestation_id") : null;
        if (!"VERIFIED".equals(verified.json.get("status")) || attestation == null) {
            throw new PorApiException(verified.status, "openings_rejected",
                    "the platform answered " + verified.json.get("status") + " to the openings", verified.json);
        }
        Object sampled = verified.json.get("sampled_leaves");
        return new SubmitResult(id, attestation, "VERIFIED",
                sampled instanceof Long ? (int) (long) (Long) sampled : openings.size(), false, true, openings);
    }

    /** What the platform holds for a snapshot. */
    public SnapshotStatus status(String snapshotId) {
        return new SnapshotStatus(call("/v1/por/snapshots/" + segment(snapshotId), null).json);
    }

    /**
     * Asks until the snapshot's anchor is confirmed.
     *
     * @return the status that showed the confirmation
     * @throws PorApiException {@code anchor_timeout} (status 0) when it is not confirmed in time. The snapshot is
     *                         unaffected; ask again later.
     * @throws PorException    {@code interrupted} when the waiting thread is interrupted
     */
    public SnapshotStatus waitAnchored(String snapshotId, Duration timeout) {
        long deadline = System.nanoTime() + Objects.requireNonNull(timeout, "timeout").toNanos();
        while (true) {
            SnapshotStatus status = status(snapshotId);
            if (status.anchored()) {
                return status;
            }
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                throw new PorApiException(0, "anchor_timeout", "the anchor was not confirmed within " + timeout.getSeconds()
                        + " seconds; the platform still holds the snapshot — ask again later", status.toMap());
            }
            try {
                TimeUnit.NANOSECONDS.sleep(Math.min(left, pollInterval.toNanos()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new PorException("interrupted", "interrupted while waiting for the anchor");
            }
        }
    }

    /** Where anyone can fetch the snapshot's public verification material. No request is made. */
    public String publicUrl(String snapshotId) {
        return base + "/v1/public/por/snapshots/" + segment(snapshotId);
    }

    /** The platform's base URL, without a trailing slash. */
    public String baseUrl() {
        return base;
    }

    @Override
    public String toString() {
        return "PorClient(" + base + ")";
    }

    // ── one request, one answer ─────────────────────────────────────────────

    private static final class Answer {
        final int status;
        final Map<String, Object> json;

        Answer(int status, Map<String, Object> json) {
            this.status = status;
            this.json = json;
        }
    }

    private static Map<String, Object> body(Submission submission, boolean spotCheck) {
        List<String> problems = Objects.requireNonNull(submission, "submission").validate();
        if (!problems.isEmpty()) {
            throw new PorException("invalid_submission",
                    "the submission is not usable: " + String.join("; ", problems) + "; nothing was sent");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("statement", submission.statement().toMap());
        body.put("sig", submission.signature().toMap());
        if (spotCheck) {
            body.put("spot_check", Boolean.TRUE);
        }
        return body;
    }

    private static String snapshotId(Answer a) {
        Object id = a.json.get("snapshot_id");
        if (!(id instanceof String) || ((String) id).isEmpty()) {
            throw new PorApiException(a.status, "invalid_response", "the platform's answer names no snapshot", a.json);
        }
        return (String) id;
    }

    /** A GET when {@code body} is null, otherwise a POST of that JSON value. */
    private Answer call(String path, Map<String, Object> body) {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path)).timeout(requestTimeout)
                .header("Accept", "application/json").header("User-Agent", USER_AGENT);
        if (apiKey != null) {
            request.header("Authorization", "Bearer " + apiKey);
        }
        if (body == null) {
            request.GET();
        } else {
            request.header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(Json.compact(body).getBytes(StandardCharsets.UTF_8)));
        }

        HttpResponse<byte[]> response;
        try {
            response = send(body == null ? shared : newHttpClient(), request.build());
        } catch (IOException first) {
            // Only a request that may be repeated is repeated, and not one the
            // server was slow to answer or was not there to receive.
            if (body != null || first instanceof HttpTimeoutException || first instanceof ConnectException) {
                throw unreachable(first);
            }
            try {
                response = send(newHttpClient(), request.build());
            } catch (IOException second) {
                throw unreachable(second);
            }
        }
        return answer(response);
    }

    private HttpClient newHttpClient() {
        HttpClient.Builder b = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(connectTimeout).followRedirects(HttpClient.Redirect.NEVER);
        if (proxy != null) {
            b.proxy(proxy);
        }
        if (sslContext != null) {
            b.sslContext(sslContext);
        }
        return b.build();
    }

    private HttpResponse<byte[]> send(HttpClient client, HttpRequest request) throws IOException {
        CompletableFuture<HttpResponse<byte[]>> pending = client.sendAsync(request, info -> new CappedBody());
        try {
            // The request's own timeout covers the wait for the answer's head;
            // this one also covers a body that stops arriving.
            return pending.get(connectTimeout.plus(requestTimeout).toMillis(), TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            throw cause instanceof IOException ? (IOException) cause : new IOException(String.valueOf(cause), cause);
        } catch (TimeoutException e) {
            pending.cancel(true);
            throw new HttpTimeoutException("no complete answer within " + connectTimeout.plus(requestTimeout).getSeconds() + " seconds");
        } catch (InterruptedException e) {
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw new PorException("interrupted", "interrupted while waiting for the platform");
        }
    }

    private PorApiException unreachable(IOException e) {
        String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        return new PorApiException(0, "unreachable", "could not reach " + base + ": " + why, e);
    }

    @SuppressWarnings("unchecked")
    private static Answer answer(HttpResponse<byte[]> response) {
        int status = response.statusCode();
        Map<String, Object> json = null;
        try {
            Object parsed = Json.parse(response.body(), "invalid_response", "the platform's answer");
            if (parsed instanceof Map) {
                json = (Map<String, Object>) Json.freeze(parsed);
            }
        } catch (PorException notJson) {
            // Reported below as what it is for this status: an error page, or an answer that cannot be used.
        }
        if (status >= 400) {
            Object code = json == null ? null : json.get("error");
            Object message = json == null ? null : json.get("message");
            throw new PorApiException(status, code instanceof String ? (String) code : "error",
                    message instanceof String ? (String) message : "HTTP " + status, json);
        }
        if (status < 200 || status >= 300) {
            // Redirects are not followed: the request carries the API key, and the next host is not the platform.
            throw new PorApiException(status, "unexpected_status", "the platform answered HTTP " + status, json);
        }
        if (json == null) {
            throw new PorApiException(status, "invalid_response", "the platform's answer is not a JSON object", (Map<String, Object>) null);
        }
        return new Answer(status, json);
    }

    /** One path segment, percent-encoded: an id is data, and must not be able to name another path. */
    private static String segment(String id) {
        if (Objects.requireNonNull(id, "snapshotId").isEmpty() || id.equals(".") || id.equals("..")) {
            throw new PorException("invalid_argument", "that is not a snapshot id");
        }
        StringBuilder out = new StringBuilder();
        for (byte b : Text.utf8(id)) {
            int c = b & 0xff;
            boolean unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~';
            if (unreserved) {
                out.append((char) c);
            } else {
                out.append('%').append(Character.toUpperCase(Character.forDigit(c >>> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 0x0f, 16)));
            }
        }
        return out.toString();
    }

    /** Collects the answer's bytes, and gives up on one that grows past the limit instead of buffering it. */
    private static final class CappedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final HttpResponse.BodySubscriber<byte[]> all = HttpResponse.BodySubscribers.ofByteArray();
        private Flow.Subscription subscription;
        private long seen;
        private boolean abandoned;

        @Override
        public CompletionStage<byte[]> getBody() {
            return all.getBody();
        }

        @Override
        public void onSubscribe(Flow.Subscription subscription) {
            this.subscription = subscription;
            all.onSubscribe(subscription);
        }

        @Override
        public void onNext(List<ByteBuffer> buffers) {
            if (abandoned) {
                return;
            }
            for (ByteBuffer b : buffers) {
                seen += b.remaining();
            }
            if (seen > MAX_ANSWER_BYTES) {
                abandoned = true;
                subscription.cancel();
                all.onError(new IOException("the answer is larger than " + MAX_ANSWER_BYTES + " bytes"));
            } else {
                all.onNext(buffers);
            }
        }

        @Override
        public void onError(Throwable error) {
            if (!abandoned) {
                all.onError(error);
            }
        }

        @Override
        public void onComplete() {
            if (!abandoned) {
                all.onComplete();
            }
        }
    }
}
