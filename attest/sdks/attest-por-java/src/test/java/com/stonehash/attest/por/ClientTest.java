package com.stonehash.attest.por;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The platform client against a stand-in platform. The claims under test are
 * about what leaves the machine, and about connections.
 */
final class ClientTest {
    private static final String API_KEY = "sk_test_4f6a1c0de5";

    private ClientTest() {
    }

    private static StubPlatform platform() throws Exception {
        return new StubPlatform(Sample.EXCHANGE, Sample.spki());
    }

    private static PorClient client(StubPlatform p) {
        return PorClient.builder(p.base()).apiKey(API_KEY).pollInterval(Duration.ofMillis(20)).build();
    }

    private static Submission submission(PorTree tree) throws Exception {
        return Submission.sign(Sample.statement(tree), Sample.signer());
    }

    // ── what is sent ────────────────────────────────────────────────────────

    static void testByDefaultTheStatementAndItsSignatureAreSentAndNothingElse() throws Exception {
        PorTree tree = Sample.tree();
        Submission submission = submission(tree);
        try (StubPlatform p = platform()) {
            SubmitResult result = client(p).submit(submission);
            Check.equal("snap-1", result.snapshotId(), "snapshot id");
            Check.equal("ACCEPTED", result.status(), "status");
            Check.equal("att-snap-1", result.attestationId(), "attestation id");
            Check.equal(0, result.sampledAccounts(), "no account was opened");
            Check.equal(false, result.spotCheck(), "no spot check");
            Check.isTrue(result.openings().isEmpty(), "no openings");

            Check.equal(1, p.requests.size(), "exactly one request");
            StubPlatform.Request sent = p.requests.get(0);
            Check.equal("POST /v1/por/snapshots", sent.method + " " + sent.path, "where it went");
            Check.equal("Bearer " + API_KEY, sent.headers.get("authorization"), "the key travels in the Authorization header");
            Check.equal("application/json", sent.headers.get("content-type"), "content type");
            Map<String, Object> expected = new LinkedHashMap<>();
            expected.put("statement", submission.statement().toMap());
            expected.put("sig", submission.signature().toMap());
            Check.equal(expected, sent.json(), "the body is the statement and the signature");
            for (int i = 0; i < tree.leafCount(); i++) {
                InclusionProof.Leaf leaf = tree.prove(i).leaf();
                Check.isTrue(!sent.body.contains(tree.userRef(i)) && !sent.body.contains(leaf.salt()) && !sent.body.contains(leaf.userRefHash()),
                        "no reference, salt or hashed reference in what was sent");
            }
        }
    }

    static void testTheSameStatementAgainIsTheSameSnapshot() throws Exception {
        try (StubPlatform p = platform()) {
            p.override = request -> {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("snapshot_id", "snap-earlier");
                out.put("status", "ACCEPTED");
                out.put("spot_check", false);
                out.put("attestation_id", "att-earlier");
                out.put("already", true);
                return request.method.equals("POST") ? StubPlatform.Reply.json(200, out) : null;
            };
            SubmitResult result = client(p).submit(submission(Sample.tree()));
            Check.equal(true, result.already(), "the platform already held it");
            Check.equal("snap-earlier", result.snapshotId(), "and answered with the earlier record");
        }
    }

    static void testASpotCheckIsAnsweredFromTheLocalTreeWithoutAnyAccountReference() throws Exception {
        PorTree tree = Sample.tree();
        try (StubPlatform p = platform()) {
            SubmitResult result = client(p).submitWithSpotCheck(submission(tree), tree);
            Check.equal("VERIFIED", result.status(), "the stand-in verified every opening against root and totals");
            Check.equal(3, result.sampledAccounts(), "sampled");
            Check.equal(true, result.spotCheck(), "spot check");

            List<StubPlatform.Request> posts = p.posts();
            Check.equal(Arrays.asList("/v1/por/snapshots", "/v1/por/snapshots/snap-1/openings"),
                    Arrays.asList(posts.get(0).path, posts.get(1).path), "two requests, in order");
            Check.equal(Boolean.TRUE, posts.get(0).json().get("spot_check"), "the first asks for the spot check");
            Check.equal("[statement, sig, spot_check]", posts.get(0).json().keySet().toString(), "and holds nothing more than that");

            List<Object> openings = Json.array(posts.get(1).json().get("openings"), "test", "openings");
            List<Object> indices = new ArrayList<>();
            for (Object opening : openings) {
                indices.add(Json.object(opening, "test", "opening").get("leaf_index"));
                Check.isTrue(!Json.object(Json.object(opening, "test", "opening").get("leaf"), "test", "leaf").containsKey("user_ref"),
                        "pseudonymous: never the account reference");
            }
            Check.equal(Arrays.asList(0L, 3L, 7L), indices, "exactly the challenged leaves");
            Check.isTrue(!posts.get(1).body.contains("user_ref\"") && !posts.get(1).body.contains("U-1000"), "no reference anywhere in the body");
            List<Object> returned = new ArrayList<>();
            for (InclusionProof opening : result.openings()) {
                returned.add(opening.toMap());
            }
            Check.equal(openings, returned, "what the call returns is what was sent");
        }
    }

    static void testASpotCheckIsNotAnsweredFromTheWrongTreeOrBeyondIt() throws Exception {
        PorTree tree = Sample.tree();
        LedgerBuilder other = new LedgerBuilder(Sample.assets(), AmountUnit.DECIMAL);
        other.add("someone-else", "BTC", "1");
        PorTree otherTree = PorTree.build(Sample.EXCHANGE, Sample.seed(), other.finish());
        try (StubPlatform p = platform()) {
            Check.refuses("tree_mismatch", () -> client(p).submitWithSpotCheck(submission(tree), otherTree));
            Check.equal(0, p.requests.size(), "nothing was sent");

            p.challenge = new ArrayList<>(Arrays.asList(0L, 12L));
            PorApiException e = (PorApiException) Check.refuses("challenge_out_of_range", () -> client(p).submitWithSpotCheck(submission(tree), tree));
            Check.isTrue(e.getMessage().contains("12"), e.getMessage());
            Check.equal(1, p.posts().size(), "no opening was sent for a challenge that cannot be met");

            p.requests.clear();
            p.challenge = new ArrayList<>(Arrays.asList(1L));
            p.override = request -> {
                if (!request.path.endsWith("/openings")) {
                    return null;
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("status", "REJECTED");
                out.put("problems", Arrays.asList("leaf 1: computed root differs"));
                return StubPlatform.Reply.json(422, out);
            };
            PorApiException rejected = (PorApiException) Check.refuses("openings_rejected", () -> client(p).submitWithSpotCheck(submission(tree), tree));
            Check.equal(422, rejected.status(), "HTTP status");
            Check.isTrue(rejected.getMessage().contains("computed root differs"), "the platform's problems are in the message: " + rejected.getMessage());
            Check.equal("REJECTED", rejected.body().get("status"), "and its answer is at hand");
        }
    }

    static void testAnUnusableSubmissionIsNotSent() throws Exception {
        Submission good = submission(Sample.tree());
        Submission bad = Submission.parse(good.toJson().replace("merkle-sum-sha256-v1", "md5"));
        try (StubPlatform p = platform()) {
            Check.refuses("invalid_submission", () -> client(p).submit(bad));
            Check.equal(0, p.requests.size(), "nothing was sent");
        }
    }

    // ── answers ─────────────────────────────────────────────────────────────

    static void testTheRegisteredKeyIsLookedUpWithoutNeedingAnApiKey() throws Exception {
        try (StubPlatform p = platform()) {
            PorClient keyless = PorClient.builder(p.base() + "///").build();
            Check.equal(Sample.spki(), keyless.registeredKey(Sample.EXCHANGE), "the registered key");
            Check.equal("GET /v1/remit/meta", p.requests.get(0).method + " " + p.requests.get(0).path, "where it asked");
            Check.equal(null, p.requests.get(0).headers.get("authorization"), "no key, no Authorization header");
            Check.equal(p.base(), keyless.baseUrl(), "trailing slashes are not part of the base URL");
            PorApiException e = (PorApiException) Check.refuses("institution_unregistered", () -> keyless.registeredKey("KR-EX-unknown"));
            Check.isTrue(e.getMessage().contains("KR-EX-unknown"), e.getMessage());
            Check.isTrue(submission(Sample.tree()).verifies(keyless.registeredKey(Sample.EXCHANGE)), "a submission is checked against it before sending");
        }
    }

    static void testARefusalCarriesTheStatusTheCodeAndTheMessage() throws Exception {
        try (StubPlatform p = platform()) {
            PorClient client = client(p);
            p.override = request -> StubPlatform.refusal(403, "subscription_required", "proof of reserves is not part of this plan");
            PorApiException refused = (PorApiException) Check.refuses("subscription_required", () -> client.submit(submission(Sample.tree())));
            Check.equal(403, refused.status(), "status");
            Check.equal("proof of reserves is not part of this plan", refused.getMessage(), "the platform's message");

            p.override = request -> new StubPlatform.Reply(502, "<html>Bad Gateway</html>");
            PorApiException gateway = (PorApiException) Check.refuses("error", () -> client.status("snap-1"));
            Check.equal(502, gateway.status(), "status of an answer that is not JSON");
            Check.equal("HTTP 502", gateway.getMessage(), "message");

            p.override = request -> new StubPlatform.Reply(200, "<html>a captive portal</html>");
            Check.equal(200, ((PorApiException) Check.refuses("invalid_response", () -> client.status("snap-1"))).status(), "a success that is not JSON");
            p.override = request -> new StubPlatform.Reply(200, "[1,2]");
            Check.refuses("invalid_response", () -> client.status("snap-1"));
            p.override = request -> new StubPlatform.Reply(302, "{}");
            Check.equal(302, ((PorApiException) Check.refuses("unexpected_status", () -> client.status("snap-1"))).status(), "a redirect is not followed");

            Map<String, Object> challenged = new LinkedHashMap<>();
            challenged.put("snapshot_id", "snap-9");
            challenged.put("status", "CHALLENGED");
            p.override = request -> StubPlatform.Reply.json(201, challenged);
            Check.refuses("spot_check_required", () -> client.submit(submission(Sample.tree())));
            Check.refuses("invalid_response", () -> client.submitWithSpotCheck(submission(Sample.tree()), Sample.tree()));
        }
    }

    static void testTheApiKeyIsInNoMessageAndNoToString() throws Exception {
        try (StubPlatform p = platform()) {
            PorClient client = client(p);
            Check.isTrue(!client.toString().contains(API_KEY), "toString");
            p.override = request -> StubPlatform.refusal(401, "unauthorized", "unknown API key");
            PorApiException e = (PorApiException) Check.refuses("unauthorized", () -> client.status("snap-1"));
            Check.isTrue(!String.valueOf(e).contains(API_KEY) && !e.body().toString().contains(API_KEY), "a refusal");
        }
        // The JDK's own complaint about such a header value quotes the value; this one must not.
        for (String key : new String[] { "sk_secret\nX-Injected: 1", "sk secret", "", "sk_시크릿" }) {
            PorException e = Check.refuses("invalid_api_key", () -> PorClient.builder("https://attest.example").apiKey(key));
            Check.isTrue(!e.getMessage().contains("sk") && !e.getMessage().contains("ecret"), "the message does not quote the key: " + e.getMessage());
        }
        PorClient unreachable = PorClient.builder("http://127.0.0.1:1").apiKey(API_KEY).connectTimeout(Duration.ofSeconds(2)).build();
        PorApiException e = (PorApiException) Check.refuses("unreachable", () -> unreachable.status("snap-1"));
        Check.equal(0, e.status(), "no answer, no status");
        StringBuilder everything = new StringBuilder();
        for (Throwable t = e; t != null; t = t.getCause()) {
            everything.append(t);
        }
        Check.isTrue(!everything.toString().contains(API_KEY), "nor does an unreachable platform's: " + everything);
        Check.isTrue(e.getMessage().contains("http://127.0.0.1:1"), "it says what could not be reached");
    }

    static void testBaseUrlsAndSnapshotIds() throws Exception {
        for (String bad : new String[] { "attest.example", "ftp://attest.example", "https://user:pw@attest.example", "https://attest.example?x=1",
                "https://attest.example#f", "http://", "not a url" }) {
            Check.refuses("invalid_url", () -> PorClient.builder(bad));
        }
        PorClient client = PorClient.builder("https://attest.example/api/").build();
        Check.equal("https://attest.example/api/v1/public/por/snapshots/3f6c-11", client.publicUrl("3f6c-11"), "the public URL");
        Check.equal("https://attest.example/api/v1/public/por/snapshots/a%2Fb%20c%3F%23%25%EA%B0%80", client.publicUrl("a/b c?#%가"),
                "an id is data: it is percent-encoded as one path segment");
        for (String bad : new String[] { "", ".", ".." }) {
            Check.refuses("invalid_argument", () -> client.publicUrl(bad));
        }
        try (StubPlatform p = platform()) {
            Check.refuses("not_found", () -> client(p).status("../remit/meta"));
            Check.equal("/v1/por/snapshots/..%2Fremit%2Fmeta", p.requests.get(0).path, "an id cannot name another path");
        }
    }

    static void testWaitingForTheAnchor() throws Exception {
        try (StubPlatform p = platform()) {
            PorClient client = client(p);
            p.confirmAfterPolls = 4;
            String id = client.submit(submission(Sample.tree())).snapshotId();
            Check.equal(false, client.status(id).anchored(), "pending");
            Check.equal("pending", client.status(id).attestationStatus(), "attestation status");
            SnapshotStatus confirmed = client.waitAnchored(id, Duration.ofSeconds(10));
            Check.equal(true, confirmed.anchored(), "confirmed");
            Check.equal("confirmed", confirmed.attestationStatus(), "attestation status");
            Check.equal(Sample.ROOT, confirmed.root(), "the root the platform holds");
            Check.equal(id, confirmed.snapshotId(), "snapshot id");
            Check.isTrue(confirmed.toJson().contains("\"leaf_count\": 12"), "the whole answer is at hand: " + confirmed.toJson());

            p.confirmAfterPolls = Integer.MAX_VALUE;
            PorApiException e = (PorApiException) Check.refuses("anchor_timeout", () -> client.waitAnchored(id, Duration.ofMillis(120)));
            Check.equal(0, e.status(), "a timeout is not an answer");
        }
    }

    // ── connections ─────────────────────────────────────────────────────────

    static void testRequestsFartherApartThanTheServersIdleLimitAllSucceed() throws Exception {
        try (StubPlatform p = platform()) {
            // The real platform closes after five seconds idle; 100 ms keeps the test short.
            p.idleCloseMillis = 100;
            PorClient client = client(p);
            String id = client.submit(submission(Sample.tree())).snapshotId();
            Thread.sleep(300);
            Check.equal(id, client.status(id).snapshotId(), "a GET after the idle limit");
            Thread.sleep(300);
            Check.equal(id, client.status(id).snapshotId(), "another, on a connection the server has closed since");
            Thread.sleep(300);
            Check.equal("ACCEPTED", client.submit(submission(Sample.tree())).status(), "and a POST");
            Check.equal(4, p.requests.size(), "every request arrived");
        }
    }

    static void testAStaleConnectionCannotFailARequest() throws Exception {
        try (StubPlatform p = platform()) {
            // Any request that is not the first on its connection is closed unanswered: what a client sees when it
            // reuses a pooled connection at the moment the server closes it.
            p.dropReusedConnections = true;

            // The stand-in does bite: Java's HTTP client, used the plain way, loses the second POST to it.
            HttpClient plain = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
            HttpRequest post = HttpRequest.newBuilder(URI.create(p.base() + "/nowhere"))
                    .POST(HttpRequest.BodyPublishers.ofString("{}")).build();
            Check.equal(404, plain.send(post, HttpResponse.BodyHandlers.ofString()).statusCode(), "the first POST is answered");
            Check.fails(java.io.IOException.class, () -> plain.send(post, HttpResponse.BodyHandlers.ofString()));
            p.requests.clear();

            PorClient client = client(p);
            PorTree tree = Sample.tree();
            String id = client.submit(submission(tree)).snapshotId();
            Check.equal("ACCEPTED", client.submit(submission(tree)).status(), "POST after POST");
            Check.equal(id, client.status(id).snapshotId(), "GET");
            Check.equal(id, client.status(id).snapshotId(), "GET after GET");
            Check.equal("VERIFIED", client.submitWithSpotCheck(submission(tree), tree).status(), "two POSTs in one call");
            Check.equal(id, client.status(id).snapshotId(), "GET after POST");

            Set<Integer> postConnections = new HashSet<>();
            for (StubPlatform.Request r : p.posts()) {
                Check.isTrue(postConnections.add(r.connection), "every POST travelled on a connection opened for it");
            }
            Check.equal(4, p.posts().size(), "each POST was sent once: none was lost, none repeated");
        }
    }

    static void testAGetThatFailsIsSentOnceMoreOnANewConnectionAndAPostIsNeverRepeated() throws Exception {
        try (StubPlatform p = platform()) {
            PorClient client = client(p);
            String id = client.submit(submission(Sample.tree())).snapshotId();

            // An answer that breaks off after its first bytes. Java's own client does not try again once it has
            // read anything, so what is counted here is this library's doing.
            p.requests.clear();
            p.truncateNext.set(1);
            Check.equal(id, client.status(id).snapshotId(), "the GET is answered on its second try");
            Check.equal(2, p.requests.size(), "two attempts");
            Check.isTrue(p.requests.get(0).connection != p.requests.get(1).connection, "the second on a new connection");

            p.requests.clear();
            p.truncateNext.set(2);
            Check.refuses("unreachable", () -> client.status(id));
            Check.equal(2, p.requests.size(), "it is tried once more, not for ever");

            p.requests.clear();
            p.truncateNext.set(1);
            Check.refuses("unreachable", () -> client.submit(submission(Sample.tree())));
            Check.equal(1, p.requests.size(), "a POST is never repeated: the platform may have acted on it");

            // A connection closed before any answer at all.
            p.requests.clear();
            p.dropNext.set(1);
            Check.equal(id, client.status(id).snapshotId(), "a GET survives it");
            p.requests.clear();
            p.dropNext.set(1);
            Check.refuses("unreachable", () -> client.submit(submission(Sample.tree())));
            Check.equal(1, p.requests.size(), "and a POST is still sent only once");
        }
    }

    static void testAnAnswerTooLargeToBeOneIsAbandoned() throws Exception {
        try (StubPlatform p = platform()) {
            String huge = "{\"padding\":\"" + "x".repeat(9 << 20) + "\"}";
            p.override = request -> new StubPlatform.Reply(200, huge);
            PorApiException e = (PorApiException) Check.refuses("unreachable", () -> client(p).status("snap-1"));
            Check.isTrue(e.getMessage().contains("larger than"), e.getMessage());
        }
    }

    static void testAPlatformThatDoesNotAnswerIsGivenUpOn() throws Exception {
        try (StubPlatform p = platform()) {
            p.override = request -> {
                try {
                    Thread.sleep(1500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return null;
            };
            PorClient impatient = PorClient.builder(p.base()).apiKey(API_KEY).requestTimeout(Duration.ofMillis(200)).build();
            long started = System.nanoTime();
            Check.refuses("unreachable", () -> impatient.status("snap-1"));
            Check.isTrue(System.nanoTime() - started < 1_200_000_000L, "within the timeout, not the server's pace");
            Check.equal(1, p.requests.size(), "a request that timed out is not sent again");
            Check.refuses("invalid_option", () -> PorClient.builder(p.base()).requestTimeout(Duration.ZERO));
        }
    }
}
