package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.attest.AttestMapper;
import com.stonehash.attest.core.attest.AttestService;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The daily settlement manifest — the completeness control.
 *
 * <p>The bank signs, for one UTC day, the list of payments it instructed.
 * The platform lists everything that organisation instructed that day and
 * compares both ways — the cross-check a Merkle tree cannot do: a payment
 * the platform has and the manifest omits reads as the bank hiding one; an
 * id the platform never saw reads as a phantom. The verdict is signed by the
 * platform, and manifest and verdict together are committed to and anchored
 * like any other record.
 *
 * <p>One row per organisation and day: a manifest sent again replaces it.
 * The anchor record and the row are written in one transaction, so there is
 * no commitment on its way to the chain without the manifest it stands for.
 */
@Component
public class Manifests {
    private static final Pattern DAY = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    /** What precedes the canonical form of {@code { manifest, verdict }} when it is committed to. The line break is part of it. */
    static final String COMMIT_DOMAIN = "STONEHASH-MANIFEST-V1\n";

    private final RemitStore store;
    private final PlatformKey platform;
    private final AttestService svc;
    private final AttestMapper attestations;
    private final TransactionTemplate tx;

    public Manifests(RemitStore store, PlatformKey platform, AttestService svc, AttestMapper attestations, TransactionTemplate tx) {
        this.store = store;
        this.platform = platform;
        this.svc = svc;
        this.attestations = attestations;
        this.tx = tx;
    }

    /** The commitment a manifest and its verdict are anchored as. */
    static String commitment(Map<String, Object> signed) {
        return Hex.encode(Hex.sha256(COMMIT_DOMAIN.getBytes(StandardCharsets.UTF_8), Canonical.bytes(signed)));
    }

    /**
     * {@code POST /v1/manifests/daily}.
     *
     * @param bank the caller's collection bank, as the gate returned it
     * @param body the request body, whatever JSON it is
     */
    public HttpResult submit(String orgId, Map<String, Object> bank, Object body) {
        Map<String, Object> fields = Body.fields(body);
        Object manifest = fields.get("manifest");
        Object date = JsValues.memberIfAny(manifest, "date");
        if (!JsValues.truthy(date) || !DAY.matcher(JsValues.string(date)).matches()) {
            throw new HttpError(400, "invalid_manifest", "manifest.date must be YYYY-MM-DD");
        }
        Object ids = JsValues.member(manifest, "payment_ids");
        if (!(ids instanceof List) || !JsValues.strictEquals(JsValues.member(manifest, "count"), (double) ((List<?>) ids).size())) {
            throw new HttpError(400, "invalid_manifest", "payment_ids[] and a matching count are required");
        }
        Object sig = fields.get("sig");
        String bankSpki = (String) bank.get("signing_spki");
        if (!JsValues.truthy(sig) || !JsValues.truthy(bankSpki) || !Signatures.verifyEvent(manifest, sig, bankSpki)) {
            throw new HttpError(400, "invalid_signature", "sig must cover the manifest with the registered bank key");
        }
        List<?> stated = (List<?>) ids;
        String day = AttestService.storable(date);

        List<String> platformIds = store.paymentIdsOfDay(orgId, day);
        Set<Object> bankSet = new HashSet<>(stated);
        Set<String> platformSet = new HashSet<>(platformIds);
        List<Object> missingInManifest = new ArrayList<>();
        for (String id : platformIds) {
            if (!bankSet.contains(id)) {
                missingInManifest.add(id);
            }
        }
        List<Object> unknownToPlatform = new ArrayList<>();
        for (Object id : stated) {
            if (!(id instanceof String) || !platformSet.contains(id)) {
                unknownToPlatform.add(id);
            }
        }
        Map<String, Object> verdict = new LinkedHashMap<>();
        verdict.put("status", missingInManifest.isEmpty() && unknownToPlatform.isEmpty() ? "MATCHED" : "DISCREPANT");
        verdict.put("platform_count", platformIds.size());
        verdict.put("manifest_count", stated.size());
        verdict.put("missing_in_manifest", missingInManifest);
        verdict.put("unknown_to_platform", unknownToPlatform);
        verdict.put("checked_at", IsoTime.now());

        Map<String, Object> signed = new LinkedHashMap<>();
        signed.put("manifest", manifest);
        signed.put("verdict", verdict);
        Map<String, Object> platformSig = platform.signEvent(signed);
        String commitment = commitment(signed);

        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("kind", "remit-manifest");
        descriptor.put("date", date);
        String attestationId = tx.execute((status) -> {
            String issued = issue(orgId, commitment, descriptor);
            store.saveManifest(orgId, day, manifest, sig, verdict, platformSig, commitment, issued);
            return issued;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("verdict", verdict);
        out.put("platform_signature", platformSig);
        out.put("commitment", commitment);
        out.put("attestation_id", attestationId);
        return new HttpResult(201, out);
    }

    /**
     * The commitment goes down the ordinary anchoring path, under the bank's own organisation; an identical one reuses its record.
     * (Not private so that the store tests can hand it the same commitment twice — two submissions rarely share a millisecond.)
     */
    String issue(String orgId, String commitment, Map<String, Object> descriptor) {
        AttestService.Issue opts = new AttestService.Issue();
        opts.contentType = "application/json";
        opts.descriptor = descriptor;
        opts.product = "remit";
        try {
            return (String) svc.issue(orgId, commitment, opts).get("id");
        } catch (ServiceError e) {
            if (!"duplicate_digest".equals(e.code())) {
                throw e;
            }
            return attestations.attestationIdByDigest(orgId, commitment);
        }
    }

    /** {@code GET /v1/manifests/daily}: the organisation's manifest of a day, or — with no day — its newest thirty. */
    public Map<String, Object> list(String orgId, String date) {
        List<Object> data = new ArrayList<>();
        for (Map<String, Object> m : store.manifests(orgId, date == null || date.isEmpty() ? null : date)) {
            Map<String, Object> shown = new LinkedHashMap<>();
            shown.put("date", m.get("date"));
            shown.put("manifest", Js.parse((String) m.get("manifest")));
            shown.put("verdict", Js.parse((String) m.get("verdict")));
            shown.put("commitment", m.get("commitment"));
            shown.put("attestation", attestationBrief(orgId, m.get("attestation_id")));
            shown.put("created_at", m.get("created_at"));
            data.add(shown);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("data", data);
        return out;
    }

    /** {@code { id, status }} of a record of this organisation — {@code unknown} where the record is not its own or is gone — or {@code null} where there is no id. */
    Map<String, Object> attestationBrief(String orgId, Object attestationId) {
        if (!JsValues.truthy(attestationId)) {
            return null;
        }
        Map<String, Object> att = svc.get(orgId, (String) attestationId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", attestationId);
        out.put("status", att == null || att.get("status") == null ? "unknown" : att.get("status"));
        return out;
    }
}
