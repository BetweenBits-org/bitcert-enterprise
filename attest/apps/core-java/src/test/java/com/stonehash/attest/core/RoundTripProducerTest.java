package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.anchor.Inscriber;
import com.stonehash.attest.core.btc.Inscription;
import com.stonehash.attest.core.btc.Secp256k1;
import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.format.Bc01;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.Merkle;
import com.stonehash.attest.core.format.ProofBundle;
import com.stonehash.attest.core.format.Statement;
import com.stonehash.attest.core.json.Js;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The agreement test, producer half: real documents through the whole
 * producer path here — hash → Merkle tree → BC01 payload → transaction →
 * bundle — written out for a verifier that shares no code with any of it.
 *
 * <p>{@code tools/check-roundtrip.mjs} then hands every bundle in
 * {@code target/roundtrip/} to the published TypeScript verifier
 * ({@code packages/attest-verify}) and requires links A, B and C1 to pass,
 * C2 to stay unverified (no chain is involved), and every tampered variant
 * to fail in the link that was tampered with. Two implementations written
 * separately against a published specification agreeing on real bytes is
 * evidence; one implementation agreeing with itself is not.
 *
 * <p>The other two kinds of bundle are written too, and listed apart in the
 * manifest: signed anchors — the leaf is the hash of a statement an issuer
 * signed, and the statement names the document — and inscriptions, where the
 * document rides in the witness of a reveal transaction this code builds and
 * signs (nothing is broadcast: a commit output is named, not made). The
 * verifier holds a supplied file to each: its own document passes, another
 * document fails, and for a signed anchor no document at all leaves the
 * question open.
 */
class RoundTripProducerTest {
    private static final Path OUT = Path.of("target", "roundtrip");

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    /** An anchor transaction carrying the payload: unsigned, with a placeholder input. The txid commits to the serialisation. */
    private static byte[] anchorTx(byte[] payload) {
        byte[] taproot = new byte[34];
        taproot[0] = 0x51;
        taproot[1] = 0x20;
        Arrays.fill(taproot, 2, 34, (byte) 0xab);
        return Tx.serializeLegacy(List.of(new Tx.Input("11".repeat(32), 0)),
                List.of(new Tx.Output(0, Tx.opReturnScript(payload)), new Tx.Output(9_000, taproot)));
    }

    /** One batch through the producer; a bundle for each document. */
    private static List<Map<String, Object>> issueBatch(List<byte[]> docs, String batchId, String network) {
        List<byte[]> leaves = new ArrayList<>();
        for (byte[] doc : docs) {
            leaves.add(Hex.sha256(doc));
        }
        Merkle tree = Merkle.fromLeaves(leaves);
        byte[] payload = Bc01.encode(tree.root(), Bc01.uuidToBytes(batchId));
        byte[] tx = anchorTx(payload);
        List<Map<String, Object>> bundles = new ArrayList<>();
        for (int i = 0; i < docs.size(); i++) {
            ProofBundle.Input in = new ProofBundle.Input();
            in.leafBytesHex = Hex.encode(leaves.get(i));
            in.contentType = "application/pdf";
            in.descriptor = new LinkedHashMap<>(Map.of("batch_id", batchId));
            in.merkle = tree.proof(i);
            in.anchorTxid = Tx.txidOf(tx);
            in.anchorRawTxHex = Hex.encode(tx);
            in.anchorPayloadHex = Hex.encode(payload);
            in.network = network;
            in.generatedAt = "2026-11-04T00:00:00Z";
            bundles.add(ProofBundle.assemble(in));
        }
        return bundles;
    }

    @Test
    void writesBundlesForTheIndependentVerifier() throws Exception {
        Files.createDirectories(OUT);
        List<Object> manifest = new ArrayList<>();
        int written = 0;
        // Sizes 1..16, 17 and 33: every shape of tree up to two odd levels, each member's own bundle.
        for (int n : new int[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 33 }) {
            List<byte[]> docs = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                docs.add(utf8("batch-" + n + " doc-" + i));
            }
            String batchId = String.format("00000000-0000-4000-8000-%012d", n);
            List<Map<String, Object>> bundles = issueBatch(docs, batchId, n == 16 ? "mainnet" : "regtest");
            for (int i = 0; i < n; i++) {
                String file = "batch-" + n + "-doc-" + i + ".json";
                Files.writeString(OUT.resolve(file), Js.stringify(bundles.get(i), 2));
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("bundle", file);
                entry.put("original", Base64.getEncoder().encodeToString(docs.get(i)));
                entry.put("network", n == 16 ? "mainnet" : "regtest");
                manifest.add(entry);
                written++;
            }
        }
        List<Object> signed = signedAnchors();
        List<Object> inscribed = inscriptions();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", "Written by RoundTripProducerTest: bundles the Java producer made, for tools/check-roundtrip.mjs to verify with packages/attest-verify.");
        out.put("bundles", manifest);
        out.put("signed", signed);
        out.put("inscribed", inscribed);
        Files.writeString(OUT.resolve("manifest.json"), Js.stringify(out, 1));
        assertTrue(written == 186, written + " bundles written");
        assertTrue(signed.size() == 14 && inscribed.size() == 6, signed.size() + " signed anchors and " + inscribed.size() + " inscriptions written");
    }

    // ── signed anchors ───────────────────────────────────────────────────────

    /** A statement as an issuer writes and signs one: the document's digest, the key, the time — and the signature over the rest. */
    private static Map<String, Object> statement(byte[] doc, String contentType, String algorithm, KeyPair key, String keyId) throws Exception {
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("sha256", Hex.encode(Hex.sha256(doc)));
        if (contentType != null) {
            document.put("content_type", contentType);
        }
        Map<String, Object> issuer = new LinkedHashMap<>();
        issuer.put("key_id", keyId);
        issuer.put("algorithm", algorithm);
        issuer.put("public_key", Base64.getEncoder().encodeToString(key.getPublic().getEncoded()));
        Map<String, Object> st = new LinkedHashMap<>();
        st.put("schema", Statement.SCHEMA);
        st.put("document", document);
        st.put("issuer", issuer);
        st.put("issued_at", "2026-11-18T06:00:00.000Z");
        Signature signer = Signature.getInstance(algorithm.equals("ES256") ? "SHA256withECDSAinP1363Format" : "SHA256withRSA");
        signer.initSign(key.getPrivate());
        signer.update(Statement.signingInput(st));
        st.put("signature", Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign()));
        return st;
    }

    /** Batches of signed statements through the producer: each record's leaf is the hash of its statement. */
    private static List<Object> signedAnchors() throws Exception {
        KeyPairGenerator ec = KeyPairGenerator.getInstance("EC");
        ec.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPairGenerator rsa = KeyPairGenerator.getInstance("RSA");
        rsa.initialize(2048);
        KeyPair p256 = ec.generateKeyPair();
        KeyPair rsa2048 = rsa.generateKeyPair();
        List<Object> manifest = new ArrayList<>();
        // One, two and five in a batch under a P-256 key; three under an RSA key; three mixed with a document of no content type.
        Object[][] batches = { { 1, "ES256" }, { 2, "ES256" }, { 5, "ES256" }, { 3, "RS256" }, { 3, "mixed" } };
        for (int b = 0; b < batches.length; b++) {
            int n = (Integer) batches[b][0];
            String how = (String) batches[b][1];
            List<byte[]> docs = new ArrayList<>();
            List<Map<String, Object>> statements = new ArrayList<>();
            List<byte[]> leaves = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                byte[] doc = utf8("signed batch " + b + " document " + i + " — é😀");
                String algorithm = how.equals("mixed") ? (i % 2 == 0 ? "ES256" : "RS256") : how;
                Map<String, Object> st = statement(doc, how.equals("mixed") && i == 2 ? null : "application/pdf", algorithm, algorithm.equals("ES256") ? p256 : rsa2048, "issuer-key-" + b);
                Statement.Verdict verdict = Statement.verify(st, Statement.leaf(st));
                assertTrue(verdict.signatureOk && verdict.leafOk, "the statement just signed verifies: " + verdict.error);
                docs.add(doc);
                statements.add(st);
                leaves.add(Hex.decode(Statement.leaf(st)));
            }
            String batchId = String.format("00000000-0000-4000-9000-%012d", b);
            Merkle tree = Merkle.fromLeaves(leaves);
            byte[] payload = Bc01.encode(tree.root(), Bc01.uuidToBytes(batchId));
            byte[] tx = anchorTx(payload);
            for (int i = 0; i < n; i++) {
                ProofBundle.Input in = new ProofBundle.Input();
                in.leafBytesHex = Hex.encode(leaves.get(i));
                Object type = ((Map<?, ?>) statements.get(i).get("document")).get("content_type");
                in.contentType = (String) type;
                in.statement = statements.get(i);
                in.descriptor = new LinkedHashMap<>(Map.of("batch_id", batchId));
                in.merkle = tree.proof(i);
                in.anchorTxid = Tx.txidOf(tx);
                in.anchorRawTxHex = Hex.encode(tx);
                in.anchorPayloadHex = Hex.encode(payload);
                in.network = "regtest";
                in.generatedAt = "2026-11-18T06:00:00Z";
                String file = "signed-" + b + "-doc-" + i + ".json";
                Files.writeString(OUT.resolve(file), Js.stringify(ProofBundle.assemble(in), 2));
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("bundle", file);
                entry.put("original", Base64.getEncoder().encodeToString(docs.get(i)));
                entry.put("network", "regtest");
                entry.put("algorithm", statements.get(i).get("issuer") instanceof Map ? ((Map<?, ?>) statements.get(i).get("issuer")).get("algorithm") : null);
                manifest.add(entry);
            }
        }
        return manifest;
    }

    // ── inscriptions ─────────────────────────────────────────────────────────

    /** Documents inscribed: each in the witness of a reveal transaction built and signed here, spending a commit output that is only named. */
    private static List<Object> inscriptions() throws Exception {
        List<Object> manifest = new ArrayList<>();
        byte[] returnScript = new byte[34];
        returnScript[0] = 0x51;
        returnScript[1] = 0x20;
        Arrays.fill(returnScript, 2, 34, (byte) 0xcd);
        // One byte; the largest that fits one push, and one more; several pushes; and two content types.
        int[] sizes = { 1, 520, 521, 3000, 64, 2048 };
        for (int k = 0; k < sizes.length; k++) {
            byte[] body = new byte[sizes[k]];
            for (int i = 0; i < body.length; i++) {
                body[i] = (byte) ((i * 31 + k * 7) & 0xff);
            }
            byte[] secret = Hex.sha256(utf8("round trip inscription key " + k));
            String contentType = k % 2 == 0 ? "application/pdf" : "text/plain; charset=utf-8";
            Inscription ins = Inscription.build(Secp256k1.xOnlyPubkey(secret), body, contentType, Inscription.protocolTagFor("regtest"), null);
            List<Tx.Output> outputs = Inscriber.revealOutputs(ins, returnScript);
            long commitValue = Inscriber.commitValue(Inscriber.revealVsize(ins, outputs));
            String commitTxid = Hex.encode(Hex.sha256(utf8("round trip commit " + k)));
            byte[] raw = Inscriber.signedReveal(ins, secret, new byte[32], commitTxid, 0, commitValue, outputs);
            ProofBundle.Input in = new ProofBundle.Input();
            in.leafBytesHex = ins.leafHex;
            in.contentType = contentType;
            in.descriptor = new LinkedHashMap<>(Map.of("attestation_id", "00000000-0000-4000-a000-00000000000" + k));
            in.anchorTxid = Inscriber.revealTxid(commitTxid, 0, outputs);
            in.anchorRawTxHex = Hex.encode(raw);
            // In this mode the anchor output is the leaf itself: no tree.
            in.anchorPayloadHex = ins.leafHex;
            in.witnessInputIndex = 0L;
            in.witnessContentType = contentType;
            in.witnessProtocolTag = ins.protocolTag;
            in.commitTxid = commitTxid;
            in.network = "regtest";
            in.generatedAt = "2026-11-18T06:00:00Z";
            String file = "inscribed-" + sizes[k] + ".json";
            Files.writeString(OUT.resolve(file), Js.stringify(ProofBundle.assemble(in), 2));
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("bundle", file);
            entry.put("original", Base64.getEncoder().encodeToString(body));
            entry.put("network", "regtest");
            manifest.add(entry);
        }
        return manifest;
    }
}
