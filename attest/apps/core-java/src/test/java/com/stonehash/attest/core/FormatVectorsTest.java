package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.btc.Varint;
import com.stonehash.attest.core.format.Bc01;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.format.Merkle;
import com.stonehash.attest.core.format.ProofBundle;
import com.stonehash.attest.core.format.Statement;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The producer side — Merkle tree, BC01, transaction bytes, bundle assembly,
 * canonical JSON, the signed statement — held to the code it replaces:
 * {@code vectors/format.json} was written by {@code apps/core/src} and
 * {@code packages/attest-verify/src} themselves.
 */
class FormatVectorsTest {
    private static final Map<String, Object> V = Vectors.load("format.json");

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    private static long num(Object o) {
        return ((Double) o).longValue();
    }

    private static void none(List<String> failures, String what, int ran, int atLeast) {
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " " + what + " differ from the reference:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= atLeast, "the vectors were read: " + ran + " " + what);
    }

    @Test
    void buildsTheTreeAndItsProofsAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int proofs = 0;
        for (Map<String, Object> c : Vectors.cases(V, "merkle")) {
            int n = (int) num(c.get("n"));
            List<byte[]> leaves = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                leaves.add(c.get("leaves") == null ? Hex.sha256((c.get("seed") + "" + i).getBytes(StandardCharsets.UTF_8)) : Hex.decode((String) list(c.get("leaves")).get(i)));
            }
            Merkle tree = Merkle.fromLeaves(leaves);
            if (!tree.rootHex().equals(c.get("root"))) {
                failures.add(n + " leaves: root " + tree.rootHex() + ", expected " + c.get("root"));
            }
            for (Object each : list(c.get("proofs"))) {
                proofs++;
                Map<String, Object> p = map(each);
                Merkle.Proof got = tree.proof((int) num(p.get("index")));
                if (!got.siblings.equals(p.get("siblings")) || !got.directions.equals(p.get("directions")) || !got.root.equals(c.get("root"))) {
                    failures.add(n + " leaves, proof " + p.get("index") + " differs");
                }
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "merkleRefused")) {
            proofs++;
            try {
                List<byte[]> leaves = new ArrayList<>();
                for (Object h : list(c.get("leaves"))) {
                    leaves.add(Hex.decode((String) h));
                }
                Merkle.fromLeaves(leaves);
                failures.add(Js.stringify(c.get("leaves")) + ": built, the reference refuses: " + c.get("error"));
            } catch (IllegalArgumentException e) {
                if (!e.getMessage().equals(c.get("error"))) {
                    failures.add(Js.stringify(c.get("leaves")) + ": refused with " + e.getMessage() + ", expected " + c.get("error"));
                }
            }
        }
        none(failures, "trees and proofs", proofs, 200);
    }

    @Test
    void writesThePayloadAndTheTransactionBytesAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "bc01")) {
            ran++;
            String got = Hex.encode(Bc01.encode(Hex.decode((String) c.get("root")), Bc01.uuidToBytes((String) c.get("uuid"))));
            if (!got.equals(c.get("payload"))) {
                failures.add("BC01 " + c.get("uuid") + ": " + got);
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "uuids")) {
            ran++;
            try {
                String got = Hex.encode(Bc01.uuidToBytes((String) c.get("uuid")));
                if (!got.equals(c.get("bytes"))) {
                    failures.add("uuid " + Js.stringify(c.get("uuid")) + ": " + got + ", expected " + (c.get("bytes") == null ? "a refusal: " + c.get("error") : c.get("bytes")));
                }
            } catch (IllegalArgumentException e) {
                if (!e.getMessage().equals(c.get("error"))) {
                    failures.add("uuid " + Js.stringify(c.get("uuid")) + ": refused with " + e.getMessage() + ", expected " + c.get("error"));
                }
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "varints")) {
            ran++;
            long n = num(c.get("n"));
            if (!Hex.encode(Varint.encode(n)).equals(c.get("varint")) || !Hex.encode(Varint.uintLE(n, 8)).equals(c.get("le8"))
                    || !Hex.encode(Varint.uintLE(n % (1L << 32), 4)).equals(c.get("le4"))) {
                failures.add("varint " + n);
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "scripts")) {
            ran++;
            if (!Hex.encode(Tx.opReturnScript(Hex.decode((String) c.get("payload")))).equals(c.get("script"))) {
                failures.add("OP_RETURN of " + ((String) c.get("payload")).length() / 2 + " bytes");
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "txs")) {
            ran++;
            List<Tx.Input> inputs = new ArrayList<>();
            for (Object each : list(c.get("inputs"))) {
                Map<String, Object> i = map(each);
                inputs.add(new Tx.Input((String) i.get("txid"), num(i.get("vout")), i.get("scriptSig") == null ? new byte[0] : Hex.decode((String) i.get("scriptSig")),
                        i.get("sequence") == null ? 0xffffffffL : num(i.get("sequence"))));
            }
            List<Tx.Output> outputs = new ArrayList<>();
            for (Object each : list(c.get("outputs"))) {
                Map<String, Object> o = map(each);
                outputs.add(new Tx.Output(num(o.get("value")), Hex.decode((String) o.get("script"))));
            }
            byte[] legacy = Tx.serializeLegacy(inputs, outputs, c.get("version") == null ? 2 : num(c.get("version")), c.get("locktime") == null ? 0 : num(c.get("locktime")));
            if (!Hex.encode(legacy).equals(c.get("legacy")) || !Tx.txidOf(legacy).equals(c.get("txid"))) {
                failures.add("transaction with " + inputs.size() + " inputs: " + Tx.txidOf(legacy) + ", expected " + c.get("txid"));
            }
        }
        none(failures, "payloads and transactions", ran, 30);
    }

    @Test
    void assemblesABundleAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "bundles")) {
            ran++;
            Map<String, Object> in = map(c.get("input"));
            Map<String, Object> anchor = map(in.get("anchor"));
            ProofBundle.Input i = new ProofBundle.Input();
            i.leafBytesHex = (String) in.get("leafBytesHex");
            i.contentType = (String) in.get("contentType");
            i.statement = in.get("statement") == null ? null : map(in.get("statement"));
            i.descriptor = in.get("descriptor") == null ? null : map(in.get("descriptor"));
            if (in.get("merkle") != null) {
                Map<String, Object> m = map(in.get("merkle"));
                List<byte[]> leaves = Arrays.asList(Hex.sha256("a".getBytes(StandardCharsets.UTF_8)), Hex.sha256("b".getBytes(StandardCharsets.UTF_8)),
                        Hex.sha256("c".getBytes(StandardCharsets.UTF_8)));
                i.merkle = Merkle.fromLeaves(leaves).proof((int) num(m.get("leafIndex")));
            }
            i.anchorTxid = (String) anchor.get("txid");
            i.anchorRawTxHex = (String) anchor.get("rawTxHex");
            i.anchorPayloadHex = (String) anchor.get("payloadHex");
            if (anchor.get("confirmed") != null) {
                Map<String, Object> confirmed = map(anchor.get("confirmed"));
                i.confirmed = true;
                i.blockHeight = confirmed.get("blockHeight") == null ? null : num(confirmed.get("blockHeight"));
                i.blockHash = (String) confirmed.get("blockHash");
                i.confirmations = confirmed.get("confirmations") == null ? null : num(confirmed.get("confirmations"));
            }
            if (anchor.get("witnessEnvelope") != null) {
                Map<String, Object> w = map(anchor.get("witnessEnvelope"));
                i.witnessInputIndex = num(w.get("inputIndex"));
                i.witnessContentType = (String) w.get("contentType");
                i.witnessProtocolTag = (String) w.get("protocolTag");
            }
            i.commitTxid = (String) in.get("commitTxid");
            i.network = (String) in.get("network");
            i.generatedAt = (String) in.get("generatedAt");
            String got = Js.stringify(ProofBundle.assemble(i), 2);
            if (!got.equals(c.get("json"))) {
                failures.add("bundle " + ran + ":\n" + got + "\nexpected\n" + c.get("json"));
            }
        }
        none(failures, "bundles", ran, 15);
    }

    @Test
    void writesCanonicalJsonAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "canonical")) {
            ran++;
            String text = (String) c.get("text");
            try {
                String got = Canonical.text(Js.parse(text));
                if (!got.equals(c.get("canonical"))) {
                    failures.add(text + ": " + got + ", expected " + (c.get("canonical") == null ? "a refusal: " + c.get("error") : c.get("canonical")));
                }
            } catch (PlainError e) {
                if (!e.getMessage().equals(c.get("error"))) {
                    failures.add(text + ": refused with " + e.getMessage() + ", expected " + (c.get("error") == null ? c.get("canonical") : c.get("error")));
                }
            }
        }
        none(failures, "canonical texts", ran, 30);
    }

    /**
     * Refusals the reference worded as the JavaScript engine's complaint
     * about its own code. Here each is a sentence of this service's: the
     * status and the code a client gets are the same, the words are ones a
     * person can act on (docs/JAVA-INTENDED-DIFFERENCES.md, D-03).
     */
    private static final Map<String, String> IN_OUR_WORDS = new LinkedHashMap<>();
    static {
        IN_OUR_WORDS.put("Cannot read properties of undefined (reading 'sha256')", "document is required: { sha256, content_type? }");
        IN_OUR_WORDS.put("Cannot read properties of null (reading 'sha256')", "document is required: { sha256, content_type? }");
        IN_OUR_WORDS.put("Cannot read properties of undefined (reading 'key_id')", "issuer is required: { key_id, algorithm, public_key }");
        IN_OUR_WORDS.put("Cannot read properties of null (reading 'key_id')", "issuer is required: { key_id, algorithm, public_key }");
        IN_OUR_WORDS.put("b64.replace is not a function", "signature must be text: the base64url of the signature|issuer.public_key must be text: the base64 of the key's SPKI");
    }

    /**
     * Times the reference read because the JavaScript engine reads them, and
     * that are not ISO 8601 (docs/JAVA-INTENDED-DIFFERENCES.md, D-04). The
     * test fails if the reference stops reading one, or this service starts to.
     */
    private static final Set<String> ENGINE_ONLY_TIMES = new LinkedHashSet<>(Arrays.asList(
            "2026/11/18", "11/18/2026", "Nov 18, 2026", "Wed, 18 Nov 2026 06:00:00 GMT", "18 Nov 2026", "2026-1-8", "0", "1", "99", "100", "２０２６-11-18"));

    @Test
    void readsAndChecksASignedStatementAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int verified = 0;
        Set<String> engineOnlySeen = new LinkedHashSet<>();
        for (Map<String, Object> c : Vectors.cases(V, "statements")) {
            ran++;
            String name = (String) c.get("name");
            Map<String, Object> statement = map(c.get("statement"));
            Map<String, Object> expected = map(c.get("verdict"));
            String time = statement.get("issued_at") instanceof String ? (String) statement.get("issued_at") : null;

            String leaf = null;
            String leafError = null;
            try {
                leaf = Statement.leaf(statement);
            } catch (Statement.Malformed e) {
                leafError = e.getMessage();
            }
            if (name.startsWith("issued at") && ENGINE_ONLY_TIMES.contains(time)) {
                engineOnlySeen.add(time);
                if (c.get("leaf") == null || !"issued_at must be an ISO-8601 timestamp".equals(leafError)) {
                    failures.add(name + ": listed as a time only the engine reads — the reference " + (c.get("leaf") == null ? "refuses it" : "reads it")
                            + ", this service " + (leafError == null ? "reads it" : "says: " + leafError));
                }
                continue;
            }
            if (c.get("leaf") != null) {
                if (!c.get("leaf").equals(leaf)) {
                    failures.add(name + ": leaf " + leaf + (leafError == null ? "" : " (" + leafError + ")") + ", expected " + c.get("leaf"));
                }
                String input = Hex.encode(Statement.signingInput(statement));
                if (leaf != null && c.get("signingInput") != null && !c.get("signingInput").equals(input)) {
                    failures.add(name + ": the signing input differs");
                }
            } else if (leafError == null) {
                failures.add(name + ": read, the reference refuses it: " + c.get("leafError"));
            } else if (!sameWords((String) c.get("leafError"), leafError)) {
                failures.add(name + ": refused with \"" + leafError + "\", expected \"" + c.get("leafError") + "\"");
            }

            Statement.Verdict v = Statement.verify(statement, c.get("leaf") != null ? (String) c.get("leaf") : "00".repeat(32));
            verified += v.signatureOk ? 1 : 0;
            if (v.signatureOk != Boolean.TRUE.equals(expected.get("signatureOk")) || v.leafOk != Boolean.TRUE.equals(expected.get("leafOk"))
                    || !v.computedLeaf.equals(expected.get("computedLeaf"))) {
                failures.add(name + ": verdict signatureOk=" + v.signatureOk + " leafOk=" + v.leafOk + " leaf=" + v.computedLeaf + " error=" + v.error
                        + ", expected " + Js.stringify(expected));
            } else if (expected.get("error") == null ? v.error != null : !sameWords((String) expected.get("error"), v.error)) {
                failures.add(name + ": verdict says \"" + v.error + "\", expected \"" + expected.get("error") + "\"");
            }
            if (expected.get("keyId") instanceof String && !expected.get("keyId").equals(v.keyId)) {
                failures.add(name + ": key id " + v.keyId);
            }
            if (expected.get("algorithm") instanceof String && !expected.get("algorithm").equals(v.algorithm)) {
                failures.add(name + ": algorithm " + v.algorithm);
            }
            // The leaf is compared with what the chain holds: against another leaf the same statement does not bind.
            if (Statement.verify(statement, "ff".repeat(32)).leafOk != Boolean.TRUE.equals(c.get("leafOkElsewhere"))) {
                failures.add(name + ": binds to a leaf that is not its own");
            }
        }
        none(failures, "statements", ran, 150);
        assertEquals(ENGINE_ONLY_TIMES, engineOnlySeen, "every listed time is in the vectors");
        assertTrue(verified >= 4, verified + " statements verified");
    }

    private static boolean sameWords(String reference, String ours) {
        if (reference.equals(ours)) {
            return true;
        }
        String allowed = IN_OUR_WORDS.get(reference);
        return allowed != null && ours != null && Arrays.asList(allowed.split("\\|")).contains(ours);
    }
}
