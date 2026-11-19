package com.stonehash.attest.core.por;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.attest.AttestMapper;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import com.stonehash.attest.remit.Conventions;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Proof of reserves — the platform's half.
 *
 * <p>The exchange built the tree; the platform never sees it. What arrives is
 * the signed snapshot statement — root, totals per asset, leaf count, as-of
 * time — and its commitment is what reaches Bitcoin. There are two ways in,
 * and every snapshot says publicly which one it took:
 *
 * <ul>
 * <li><b>Root only</b> (the default). The exchange's signature and the
 *     statement's shape are checked, the commitment goes into the ordinary
 *     anchoring pipeline under the exchange's own organisation at once, and
 *     the snapshot is {@code ACCEPTED}. No account-level data leaves the
 *     exchange, and nothing the platform publishes may read as if it had
 *     sampled a leaf.</li>
 * <li><b>Spot check</b> ({@code spot_check: true}). The same checks,
 *     answered with a random challenge; nothing is anchored yet. The exchange
 *     opens exactly the challenged leaves, each is checked against the
 *     declared root <em>and totals</em>, and only then is the snapshot
 *     {@code VERIFIED} and its commitment issued. One opening that fails
 *     makes it {@code REJECTED}, for good.</li>
 * </ul>
 *
 * <p>Both paths end in the same step: the commitment is issued as a record of
 * the product {@code por}, and the reserves the statement declares are
 * measured. They differ in what was checked first, never in what reaches the
 * chain or the reserve report.
 */
@Component
public class PorSnapshots {
    private final PorMapper mapper;
    private final AttestMapper attestations;
    private final AttestService svc;
    private final ProductRegistry registry;
    private final TransactionTemplate tx;
    private final String chainLabel;
    private final String chainRpc;
    private final SecureRandom random = new SecureRandom();

    public PorSnapshots(PorMapper mapper, AttestMapper attestations, AttestService svc, ProductRegistry registry, TransactionTemplate tx, CoreConfig cfg) {
        this.mapper = mapper;
        this.attestations = attestations;
        this.svc = svc;
        this.registry = registry;
        this.tx = tx;
        this.chainLabel = cfg.remit.chainLabel;
        this.chainRpc = cfg.remit.porChainRpc;
    }

    /** Which path a stored snapshot took: root-only snapshots are exactly the {@code ACCEPTED} ones. */
    public static boolean spotChecked(Object status) {
        return !"ACCEPTED".equals(status);
    }

    /** How many leaves the platform opens. */
    private static long challengeSize(long leafCount) {
        return Math.min(8, leafCount);
    }

    // ── submit ────────────────────────────────────────────────────────────────

    /** {@code POST /v1/por/snapshots}: anchor at once, or — when asked — answer with the challenge. */
    public HttpResult submit(String orgId, Supplier<Object> requestBody) {
        Map<String, Object> exchange = registry.requirePor(orgId);
        // The body is read only once the organisation may submit at all. A body of JSON null is a missing field, not a fault.
        Object given = requestBody.get();
        Object body = given == null ? new LinkedHashMap<String, Object>() : given;
        Object statement = JsValues.member(body, "statement");
        Object sig = JsValues.member(body, "sig");
        if (!JsValues.truthy(statement) || !JsValues.truthy(sig)) {
            throw new HttpError(400, "missing_field", "statement and sig are required");
        }
        // Refused, not coerced: the path is what the public record states.
        Object spotCheck = JsValues.member(body, "spot_check");
        if (spotCheck != Js.UNDEFINED && !(spotCheck instanceof Boolean)) {
            throw new HttpError(400, "invalid_field", "spot_check must be true or false");
        }
        List<String> problems = SnapshotStatement.problems(statement);
        if (!problems.isEmpty()) {
            throw new HttpError(400, "invalid_statement", String.join("; ", problems));
        }
        String exchangeId = (String) exchange.get("id");
        Object named = JsValues.member(JsValues.member(statement, "exchange"), "institution_id");
        if (!exchangeId.equals(named)) {
            throw new HttpError(403, "institution_mismatch",
                    "statement names " + JsValues.string(named) + "; this organisation's registered exchange is " + exchangeId);
        }
        // Under the exchange's signing key, or under the key its console session registered for the
        // reserve screen. Which of the two is kept with the snapshot, so that the public material
        // names the key that actually signed.
        String signedWith = null;
        for (String candidate : new String[] { (String) exchange.get("signing_spki"), (String) exchange.get("console_spki") }) {
            if (signedWith == null && candidate != null && !candidate.isEmpty() && verifyEvent(statement, sig, candidate)) {
                signedWith = candidate;
            }
        }
        if (signedWith == null) {
            throw new HttpError(400, "invalid_signature", "sig does not verify over the statement with the registered EXCHANGE key");
        }
        // Last: refused before anything is issued, so that a statement that cannot be measured or stored never reaches the chain.
        List<String> unstorable = SnapshotStatement.unanchorable(statement);
        if (!unstorable.isEmpty()) {
            throw new HttpError(400, "invalid_statement", String.join("; ", unstorable));
        }
        String commitment = SumTree.commitment(statement);
        Object tree = JsValues.member(statement, "tree");
        long leafCount = (long) (double) (Double) JsValues.member(tree, "leaf_count");
        String root = AttestService.storable(JsValues.member(tree, "root"));
        String asof = (String) JsValues.member(statement, "asof");
        String signingSpki = signedWith;

        if (Boolean.TRUE.equals(spotCheck)) {
            String id = UUID.randomUUID().toString();
            long now = System.currentTimeMillis();
            Map<String, Object> challenge = new LinkedHashMap<>();
            challenge.put("indices", drawChallenge(leafCount));
            challenge.put("issued_at", IsoTime.ofEpochMilli(now));
            challenge.put("expires_at", IsoTime.ofEpochMilli(now + 3_600_000));
            mapper.insertSnapshot(id, orgId, exchangeId, "CHALLENGED", Js.stringify(statement), Js.stringify(sig), commitment, root, asof, leafCount,
                    Js.stringify(JsValues.member(statement, "totals")), Js.stringify(challenge), null, null, signingSpki, IsoTime.now());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("snapshot_id", id);
            out.put("status", "CHALLENGED");
            out.put("spot_check", true);
            out.put("challenge", challenge);
            out.put("next", "open the challenged leaves with the SDK and POST them to /v1/por/snapshots/" + id + "/openings");
            return new HttpResult(201, out);
        }

        // Root only: nothing to wait for, so the statement is anchored now. The same statement
        // sent again is the same snapshot, not a second one.
        return oneAtATime(orgId + ":" + commitment, () -> {
            Map<String, Object> stored = mapper.acceptedSnapshot(orgId, commitment);
            if (stored != null) {
                return replayed(stored);
            }
            String id = UUID.randomUUID().toString();
            // Measured before the commitment is issued, and outside the transaction: a read is a network call.
            Object reserves = measure(statement, "acceptance");
            // The challenge column is older than this path; what it holds for a root-only row says outright that there was none.
            Map<String, Object> noChallenge = new LinkedHashMap<>();
            noChallenge.put("spot_check", false);
            noChallenge.put("indices", new ArrayList<>());
            return tx.execute((status) -> {
                // Two instances would each hold their own queue: the organisation's row is the one they share.
                mapper.lockOrg(orgId);
                Map<String, Object> meanwhile = mapper.acceptedSnapshot(orgId, commitment);
                if (meanwhile != null) {
                    return replayed(meanwhile);
                }
                String attestationId = issue(orgId, commitment, id, root, asof);
                mapper.insertSnapshot(id, orgId, exchangeId, "ACCEPTED", Js.stringify(statement), Js.stringify(sig), commitment, root, asof, leafCount,
                        Js.stringify(JsValues.member(statement, "totals")), Js.stringify(noChallenge),
                        JsValues.truthy(reserves) ? Js.stringify(reserves) : null, attestationId, signingSpki, IsoTime.now());
                return new HttpResult(201, acceptedAnswer(id, attestationId, reserves));
            });
        });
    }

    private HttpResult replayed(Map<String, Object> stored) {
        Object reserves = stored.get("reserves");
        Map<String, Object> out = acceptedAnswer((String) stored.get("id"), stored.get("attestation_id"),
                JsValues.truthy(reserves) ? Js.parse((String) reserves) : null);
        out.put("already", true);
        return new HttpResult(200, out);
    }

    /** What a root-only submission is answered with — the first time, or replayed from the stored row. */
    private static Map<String, Object> acceptedAnswer(String id, Object attestationId, Object reserves) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("snapshot_id", id);
        out.put("status", "ACCEPTED");
        out.put("spot_check", false);
        out.put("attestation_id", attestationId);
        if (JsValues.truthy(reserves)) {
            out.put("reserves", reserves);
        }
        out.put("note", "the exchange signature was verified and the snapshot commitment is in the anchoring pipeline; "
                + "no account was opened to the platform — poll GET for anchor status");
        return out;
    }

    private List<Double> drawChallenge(long leafCount) {
        long k = challengeSize(leafCount);
        TreeSet<Integer> picked = new TreeSet<>();
        while (picked.size() < k) {
            picked.add(random.nextInt((int) leafCount));
        }
        List<Double> out = new ArrayList<>();
        for (int i : picked) {
            out.add((double) i);
        }
        return out;
    }

    /**
     * The reserve side, measured not trusted: declared addresses on the
     * local chain are read now; everything else stays declared only. The
     * report is stored with the snapshot and travels on the public endpoint
     * next to the liability commitment it answers.
     *
     * @return the report, or {@code null} where the statement declares no reserves
     */
    private Object measure(Object statement, String readAt) {
        List<?> entries = SnapshotStatement.reserveEntries(statement);
        if (entries.isEmpty()) {
            return null;
        }
        List<Map<String, Object>> measurements = Reserves.measure(entries, chainLabel, chainRpc);
        Map<String, Object> reserves = new LinkedHashMap<>();
        reserves.put("declared", (double) entries.size());
        reserves.put("measurements", measurements);
        reserves.put("solvency", Reserves.solvency(JsValues.member(statement, "totals"), measurements));
        // Worded by path: a root-only snapshot was accepted, not verified.
        reserves.put("note", "balances read on chain at " + readAt + " time; address control is a declared claim in the sandbox");
        return reserves;
    }

    /**
     * The commitment goes down the same batching and anchoring path as every
     * other record, owned by the exchange's organisation. An identical
     * statement reuses its existing anchor rather than minting a second leaf
     * for the same bytes.
     */
    private String issue(String orgId, String commitment, String snapshotId, String root, String asof) {
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("kind", "por-snapshot");
        descriptor.put("snapshot_id", snapshotId);
        descriptor.put("root", root);
        descriptor.put("asof", asof);
        AttestService.Issue opts = new AttestService.Issue();
        opts.contentType = "application/json";
        opts.descriptor = descriptor;
        opts.product = "por";
        try {
            return (String) svc.issue(orgId, commitment, opts).get("id");
        } catch (ServiceError e) {
            if (!"duplicate_digest".equals(e.code())) {
                throw e;
            }
            return attestations.attestationIdByDigest(orgId, commitment);
        }
    }

    // ── openings ──────────────────────────────────────────────────────────────

    /** {@code POST /v1/por/snapshots/:id/openings} (spot check only): verify the sample, then anchor. */
    public Object openings(String orgId, String id, Supplier<Object> requestBody) {
        registry.requirePor(orgId);
        Map<String, Object> s = mapper.snapshot(id);
        if (s == null || !orgId.equals(s.get("org_id"))) {
            throw new HttpError(404, "not_found", "no snapshot " + id);
        }
        refuseUnlessChallenged(s.get("status"));
        Object challenge = Js.parse((String) s.get("challenge"));
        Object expires = JsValues.member(challenge, "expires_at");
        Long until = expires instanceof String ? IsoDate.epochMilli((String) expires) : null;
        if (until != null && until < System.currentTimeMillis()) {
            throw new HttpError(409, "challenge_expired", "the challenge window has passed; submit a fresh snapshot");
        }
        Object given = requestBody.get();
        Object body = given == null ? new LinkedHashMap<String, Object>() : given;
        Object openings = JsValues.member(body, "openings");
        if (!(openings instanceof List)) {
            throw new HttpError(400, "missing_field", "openings[] is required");
        }
        Object statement = Js.parse((String) s.get("statement"));
        List<String> problems = new ArrayList<>();

        List<Object> provided = new ArrayList<>();
        for (Object o : (List<?>) openings) {
            provided.add(JsValues.member(o, "leaf_index"));
        }
        provided = Openings.sorted(provided);
        Object indices = JsValues.member(challenge, "indices");
        if (indices == Js.UNDEFINED || !Js.stringify(provided).equals(Js.stringify(indices))) {
            if (!(indices instanceof List)) {
                throw new JsValues.EngineError("the stored challenge names no list of indices");
            }
            problems.add("openings must cover exactly the challenged indices " + Openings.joined((List<?>) indices) + " (got " + Openings.joined(provided) + ")");
        }
        Object root = JsValues.member(JsValues.member(statement, "tree"), "root");
        Object totals = JsValues.member(statement, "totals");
        for (Object o : (List<?>) openings) {
            SumTree.Result r = SumTree.verify(o, root, totals);
            if (!r.ok) {
                problems.add("leaf " + JsValues.string(JsValues.member(o, "leaf_index")) + ": " + String.join("; ", r.problems));
            }
        }

        if (!problems.isEmpty()) {
            // Only a snapshot still waiting: of two answers arriving together, one settles it and the other is told so.
            if (mapper.rejectSnapshot(id, Js.stringify(problems), IsoTime.now()) == 0) {
                refuseUnlessChallenged(mapper.snapshot(id).get("status"));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("snapshot_id", id);
            out.put("status", "REJECTED");
            out.put("problems", problems);
            return new HttpResult(422, out);
        }

        Object reserves = measure(statement, "verification");
        String attestationId = tx.execute((status) -> {
            String issued = issue(orgId, (String) s.get("commitment"), id, (String) s.get("root"), (String) s.get("asof"));
            if (mapper.verifySnapshot(id, issued, JsValues.truthy(reserves) ? Js.stringify(reserves) : null, IsoTime.now()) == 0) {
                status.setRollbackOnly();
                return null;
            }
            return issued;
        });
        if (attestationId == null) {
            refuseUnlessChallenged(mapper.snapshot(id).get("status"));
            throw new IllegalStateException("snapshot " + id + " could not be marked verified");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("snapshot_id", id);
        out.put("status", "VERIFIED");
        out.put("sampled_leaves", JsValues.member(indices, "length"));
        out.put("attestation_id", attestationId);
        if (JsValues.truthy(reserves)) {
            out.put("reserves", reserves);
        }
        out.put("note", "the snapshot commitment is now in the anchoring pipeline; poll GET for anchor status");
        return out;
    }

    private static void refuseUnlessChallenged(Object status) {
        if ("ACCEPTED".equals(status)) {
            throw new HttpError(409, "wrong_state",
                    "snapshot was accepted without a spot check; no leaves were challenged, so there is nothing to open");
        }
        if (!"CHALLENGED".equals(status)) {
            throw new HttpError(409, "wrong_state", "snapshot is " + status + "; openings are accepted once, while CHALLENGED");
        }
    }

    // ── status ────────────────────────────────────────────────────────────────

    /** {@code GET /v1/por/snapshots}: the organisation's snapshots, newest first, a hundred at most. */
    public Map<String, Object> list(String orgId) {
        List<Object> data = new ArrayList<>();
        for (Map<String, Object> s : mapper.snapshotsOfOrg(orgId)) {
            data.add(wire(s, false));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("data", data);
        return out;
    }

    /** {@code GET /v1/por/snapshots/:id}. */
    public Map<String, Object> get(String orgId, String id) {
        Map<String, Object> s = mapper.snapshot(id);
        if (s == null || !orgId.equals(s.get("org_id"))) {
            throw new HttpError(404, "not_found", "no snapshot " + id);
        }
        return wire(s, true);
    }

    private Map<String, Object> wire(Map<String, Object> s, boolean includeChallenge) {
        Object attestationId = s.get("attestation_id");
        Map<String, Object> att = JsValues.truthy(attestationId) ? mapper.attestationBrief((String) attestationId) : null;
        Object status = s.get("status");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("snapshot_id", s.get("id"));
        out.put("status", status);
        out.put("spot_check", spotChecked(status));
        out.put("exchange", s.get("institution_id"));
        out.put("asof", s.get("asof"));
        out.put("root", s.get("root"));
        out.put("leaf_count", ((Number) s.get("leaf_count")).doubleValue());
        out.put("totals", Js.parse((String) s.get("totals")));
        out.put("commitment", s.get("commitment"));
        // A root-only snapshot was never challenged; an empty challenge object would read as one that was.
        if (includeChallenge && spotChecked(status)) {
            out.put("challenge", Js.parse((String) s.get("challenge")));
        }
        if (JsValues.truthy(s.get("problems"))) {
            out.put("problems", Js.parse((String) s.get("problems")));
        }
        if (JsValues.truthy(s.get("reserves"))) {
            out.put("reserves", Js.parse((String) s.get("reserves")));
        }
        if (att != null) {
            Map<String, Object> brief = new LinkedHashMap<>();
            brief.put("id", att.get("id"));
            brief.put("status", att.get("status"));
            out.put("attestation", brief);
        } else {
            out.put("attestation", null);
        }
        out.put("created_at", s.get("created_at"));
        return out;
    }

    /**
     * {@code GET /v1/public/por/snapshots/:id} — what an exchange's user, or
     * anyone, needs to check a proof: the statement, the exchange's signature
     * over it, and the anchor bundle once there is one. Public by design: a
     * reserve statement that only its subject can read proves little.
     *
     * <p>Published means anchored by either path, and the answer says which.
     * A root-only snapshot reports no sampled leaves and no spot check among
     * the checks: the platform does not claim a sample it did not take.
     */
    public Map<String, Object> published(String id) {
        Map<String, Object> s = mapper.snapshot(id);
        Object status = s == null ? null : s.get("status");
        if (s == null || (!"VERIFIED".equals(status) && !"ACCEPTED".equals(status))) {
            throw new HttpError(404, "not_found", "no published snapshot with this id");
        }
        Object attestationId = s.get("attestation_id");
        Object bundle = null;
        if (JsValues.truthy(attestationId)) {
            try {
                bundle = svc.exportBundle((String) s.get("org_id"), (String) attestationId);
            } catch (ServiceError e) {
                if (!"not_batched".equals(e.code()) && !"not_anchored".equals(e.code())) {
                    throw e;
                }
            }
        }
        // The key is the snapshot's own: the one its signature was verified against when it was
        // accepted. An exchange can replace its key afterwards, and what it published under the old
        // one must go on verifying. Rows older than the column fall back to the institution's key.
        Object spki = s.get("signing_spki");
        if (spki == null) {
            Map<String, Object> inst = registry.institution((String) s.get("institution_id"));
            spki = inst == null ? null : inst.get("signing_spki");
        }
        // Only a VERIFIED snapshot had leaves opened and checked.
        boolean sampled = "VERIFIED".equals(status);
        long leafCount = ((Number) s.get("leaf_count")).longValue();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("snapshot_id", s.get("id"));
        out.put("statement", Js.parse((String) s.get("statement")));
        out.put("exchange_signature", Js.parse((String) s.get("sig")));
        if (JsValues.truthy(spki)) {
            Map<String, Object> key = new LinkedHashMap<>();
            key.put("key_id", s.get("institution_id"));
            key.put("algorithm", "ES256");
            key.put("spki", spki);
            out.put("exchange_key", key);
        } else {
            out.put("exchange_key", null);
        }
        // The domain is written with the line break it ends in; the commitment's, below, with the two characters that stand for one.
        out.put("signature_scheme", "ECDSA P-256/SHA-256 raw r||s over \"stonehash:remit:event:v1\n\" + JCS(statement)");
        out.put("commitment", s.get("commitment"));
        out.put("commitment_scheme", "SHA256(\"STONEHASH-POR-V1\\n\" || JCS(statement))");
        if (JsValues.truthy(attestationId)) {
            Map<String, Object> attestation = new LinkedHashMap<>();
            attestation.put("id", attestationId);
            attestation.put("bundle", bundle);
            out.put("attestation", attestation);
        } else {
            out.put("attestation", null);
        }
        if (JsValues.truthy(s.get("reserves"))) {
            out.put("reserves", Js.parse((String) s.get("reserves")));
        }
        out.put("spot_check", sampled);
        Map<String, Object> sampling = new LinkedHashMap<>();
        sampling.put("sampled", (double) (sampled ? challengeSize(leafCount) : 0));
        sampling.put("of", (double) leafCount);
        out.put("verified_sampling", sampling);
        List<Object> checks = new ArrayList<>();
        checks.add("exchange_signature");
        checks.add("statement_shape");
        if (sampled) {
            checks.add("spot_check");
        }
        out.put("platform_checks", checks);
        return out;
    }

    // ── keys ──────────────────────────────────────────────────────────────────

    /**
     * Does the envelope's signature verify over the payload with this key:
     * ECDSA P-256 over the event domain and the payload's canonical form. A
     * key that cannot be read, a payload with no canonical form and a
     * signature that is not text all answer no.
     */
    static boolean verifyEvent(Object payload, Object sig, String spki) {
        if (!"ES256".equals(JsValues.member(sig, "alg")) || !JsValues.truthy(JsValues.member(sig, "sig"))) {
            return false;
        }
        Object canonical;
        try {
            canonical = Canonical.forSdk(payload);
        } catch (PlainError | IllegalArgumentException e) {
            return false;
        }
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("alg", "ES256");
        envelope.put("sig", JsValues.member(sig, "sig"));
        return Conventions.verifyEvent(canonical, envelope, spki);
    }

    /**
     * Give every snapshot stored before each kept its own key the key it was
     * signed with, while the institution still holds that key. A key is
     * written only if it verifies the signature stored beside it, so a row
     * whose institution has already rotated stays empty rather than being
     * stamped with a key that never signed it.
     *
     * @return how many rows were filled
     */
    public int backfillKeys() {
        int filled = 0;
        for (Map<String, Object> s : mapper.snapshotsWithoutKey()) {
            Map<String, Object> inst = registry.institution((String) s.get("institution_id"));
            Object spki = inst == null ? null : inst.get("signing_spki");
            if (!JsValues.truthy(spki)) {
                continue;
            }
            boolean signedWithIt;
            try {
                signedWithIt = verifyEvent(Js.parse((String) s.get("statement")), Js.parse((String) s.get("sig")), (String) spki);
            } catch (RuntimeException e) {
                signedWithIt = false;
            }
            if (signedWithIt) {
                filled += mapper.setSnapshotKey((String) s.get("id"), (String) spki);
            }
        }
        return filled;
    }

    // ── one submission of a statement at a time ───────────────────────────────

    private static final class Turn {
        final ReentrantLock lock = new ReentrantLock();
        int waiting;
    }

    private final ConcurrentHashMap<String, Turn> turns = new ConcurrentHashMap<>();

    /**
     * Root-only submissions of one statement run one at a time. The replay
     * check and the insert sit either side of reserve measurement — seconds
     * per declared address when the RPC hangs — so a retry sent while the
     * first attempt is still measuring would otherwise pass the check and
     * store a second snapshot of the same statement. Whichever way the
     * attempt ahead ends, its failure is its own caller's answer.
     */
    private <T> T oneAtATime(String key, Supplier<T> fn) {
        Turn turn = turns.compute(key, (k, t) -> {
            Turn mine = t == null ? new Turn() : t;
            mine.waiting++;
            return mine;
        });
        turn.lock.lock();
        try {
            return fn.get();
        } finally {
            turn.lock.unlock();
            turns.compute(key, (k, t) -> --t.waiting == 0 ? null : t);
        }
    }
}
