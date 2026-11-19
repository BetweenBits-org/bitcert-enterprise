package com.stonehash.attest.core.attest;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.auth.Auth;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.format.Statement;
import com.stonehash.attest.core.http.Body;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.Router;
import com.stonehash.attest.core.json.Js;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * The keyed API of document anchoring: hand in a digest (or a signed
 * statement), read a record, export its proof bundle, and register the
 * public half of an issuer key.
 */
@Component
public class AttestRoutes {
    private final Auth auth;
    private final AttestService svc;
    private final CoreConfig cfg;

    public AttestRoutes(Auth auth, AttestService svc, CoreConfig cfg) {
        this.auth = auth;
        this.svc = svc;
        this.cfg = cfg;
    }

    /** Row → wire shape. Keeps column names out of the public contract. */
    static Map<String, Object> publicAttestation(Map<String, Object> a) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", a.get("id"));
        out.put("leaf_bytes", a.get("leaf_bytes"));
        out.put("content_type", a.get("content_type"));
        // accepted → batched → submitted → confirmed, never collapsed into a boolean.
        out.put("status", a.get("status"));
        out.put("batch_id", a.get("batch_id"));
        out.put("leaf_index", a.get("leaf_index"));
        out.put("created_at", a.get("created_at"));
        // A digest has a bundle once it is in a batch; an inscription has one from the start — its
        // transaction is the whole proof, and it never joins a batch.
        out.put("bundle_available", a.get("batch_id") != null || "inscription".equals(a.get("kind")));
        // Absent for an unsigned anchor. `unregistered` is not a softer `registered`: the signature
        // is sound and establishes nothing about whose key it is, and a caller is told so.
        Object trust = a.get("issuer_trust");
        if (trust instanceof String && !((String) trust).isEmpty()) {
            out.put("issuer_trust", trust);
        }
        return out;
    }

    public void registerAttestations(Router r) {
        r.post("/v1/attestations", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> body = Body.fields(ctx.body());
            String leaf = body.get("leaf_bytes") instanceof String ? (String) body.get("leaf_bytes") : Body.text(body, "sha256");
            if (leaf == null || leaf.isEmpty()) {
                throw new HttpError(400, "missing_digest",
                        "provide \"leaf_bytes\": the SHA-256 of your document as 64 hex characters. Hash locally; do not upload the file.");
            }
            AttestService.Issue opts = new AttestService.Issue();
            opts.contentType = Body.text(body, "content_type");
            opts.descriptor = body.get("descriptor");
            return new HttpResult(201, publicAttestation(svc.issue(orgId, leaf, opts)));
        });

        // The same anchor, with the issuer's signature over it. It costs nothing extra on the
        // chain: the leaf joins the same Merkle tree as every other record.
        r.post("/v1/attestations/signed", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> body = Body.fields(ctx.body());
            Object statement = body.get("statement");
            if (!(statement instanceof Map) && !(statement instanceof List)) {
                throw new HttpError(400, "missing_statement",
                        "provide \"statement\": a signed attestation statement from the attest-sign SDK. "
                                + "Sign locally — the private key must never reach this service.");
            }
            if (statement instanceof List) {
                // A list has no schema to be a statement of.
                throw new ServiceError(400, "invalid_statement", "statement schema must be " + Statement.SCHEMA);
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> signed = (Map<String, Object>) statement;
            return new HttpResult(201, publicAttestation(svc.issueSigned(orgId, signed, body.get("descriptor"))));
        });

        /*
         * The other path: send the document, not its digest. This is the one route in the
         * service that receives a file, and it exists because the customer asked for the
         * original itself to go on the chain — which it cannot do without passing through
         * here. The body is the raw file. No multipart: a form encoding would mean parsing a
         * document we have no reason to interpret; the content type comes from a header.
         *
         * A little more than the configured limit is read, so that an oversized document is
         * refused by the inscription check — which can say what the limit is — rather than by
         * a bare 413. Past that margin the connection is cut.
         */
        long maxUpload = cfg.inscriptionMaxBytes + 64 * 1024;
        r.post("/v1/attestations/inscribe", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            String contentType = ctx.header("content-type") != null ? ctx.header("content-type") : "application/octet-stream";
            byte[] body = ctx.raw(maxUpload);
            if (body.length == 0) {
                throw new HttpError(400, "empty_body",
                        "send the document as the raw request body; this endpoint inscribes the bytes themselves");
            }
            return new HttpResult(201, publicAttestation(svc.inscribe(orgId, body, contentType, null, "api")));
        });

        r.get("/v1/attestations", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            List<Object> data = new ArrayList<>();
            for (Map<String, Object> row : svc.list(orgId, Router.pageLimit(ctx.query.get("limit"), 50, 500))) {
                data.add(publicAttestation(row));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("data", data);
            return out;
        });

        r.get("/v1/attestations/:id", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> att = svc.get(orgId, ctx.params.get("id"));
            if (att == null) {
                throw new HttpError(404, "not_found", "no attestation " + ctx.params.get("id"));
            }
            return publicAttestation(att);
        });

        // The bundle — the only endpoint that matters to a customer long term, because after
        // this call they never need us again.
        r.get("/v1/attestations/:id/bundle", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> bundle = svc.exportBundle(orgId, ctx.params.get("id"));
            Map<String, String> headers = new LinkedHashMap<>();
            headers.put("content-disposition", "attachment; filename=\"proof-" + ctx.params.get("id") + ".json\"");
            return new HttpResult(200, bundle, headers);
        });
    }

    /*
     * The console can mint a key in a browser; a bank does not run its signing key through a
     * browser. These two routes are the server-to-server half: generate the pair wherever the
     * private key will live, then register only the public half here.
     */
    public void registerIssuerKeys(Router r) {
        r.get("/v1/issuer-keys", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("data", svc.listIssuerKeys(orgId));
            return out;
        });

        r.post("/v1/issuer-keys", (ctx) -> {
            String orgId = auth.requireAuth(ctx);
            Map<String, Object> body = Body.fields(ctx.body());
            String publicKey = body.get("public_key") instanceof String ? Js.trim((String) body.get("public_key")) : "";
            if (publicKey.isEmpty()) {
                throw new HttpError(400, "missing_public_key",
                        "provide \"public_key\": the SPKI public key, base64. The private key stays with you — there is no field for it.");
            }
            String label = "sdk";
            if (body.get("label") instanceof String && !Js.trim((String) body.get("label")).isEmpty()) {
                String trimmed = Js.trim((String) body.get("label"));
                label = trimmed.length() > 60 ? trimmed.substring(0, 60) : trimmed;
            }
            String algorithm = "RS256".equals(body.get("algorithm")) ? "RS256" : "ES256";
            // Before anything is stored: a private key is refused by name, and an ES256 key must be
            // P-256 — a key on another curve would sit in the registry and fail every signature.
            PublicKeys.Problem problem = algorithm.equals("ES256") ? PublicKeys.es256Problem(publicKey) : PublicKeys.problem(publicKey);
            if (problem != null) {
                throw new HttpError(400, problem.code, problem.message);
            }
            Map<String, Object> reg = svc.registerIssuerKey(orgId, publicKey, label, algorithm);
            Map<String, Object> out = new LinkedHashMap<>(reg);
            out.put("next", "activate the product in the console (구독) and pick this key, or reference it as issuer_key_id");
            return new HttpResult(Boolean.TRUE.equals(reg.get("already")) ? 200 : 201, out);
        });
    }
}
