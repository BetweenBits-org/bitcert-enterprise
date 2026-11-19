package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.anchor.Inscriber;
import com.stonehash.attest.core.btc.Inscription;
import com.stonehash.attest.core.btc.Secp256k1;
import com.stonehash.attest.core.btc.Taproot;
import com.stonehash.attest.core.btc.Tx;
import com.stonehash.attest.core.format.Hex;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.bouncycastle.math.ec.ECPoint;
import org.junit.jupiter.api.Test;

/**
 * The Bitcoin code an inscription needs — secp256k1 and BIP340, taproot, the
 * envelope, the reveal transaction — held to the code it replaces and to
 * BIP340's published vectors: {@code vectors/btc.json} was written by
 * {@code apps/core/src/btc} ({@code tools/make-btc-vectors.mjs}).
 */
class BtcVectorsTest {
    private static final Map<String, Object> V = Vectors.load("btc.json");

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

    private static String sha(byte[] b) {
        return Hex.encode(Hex.sha256(b));
    }

    private static void none(List<String> failures, String what, int ran, int atLeast) {
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " " + what + " differ from the reference:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= atLeast, "the vectors were read: " + ran + " " + what);
    }

    /** The document of a given size that the generator and this test both build: byte i is (i·31 + size) mod 256. */
    private static byte[] documentOf(int size) {
        byte[] out = new byte[size];
        for (int i = 0; i < size; i++) {
            out[i] = (byte) ((i * 31 + size) & 0xff);
        }
        return out;
    }

    private static BigInteger scalar(Object hex) {
        return new BigInteger((String) hex, 16);
    }

    /** A point as the vectors write it: {@code null} for infinity, else both coordinates. */
    private static Object shown(ECPoint p) {
        if (p == null || p.isInfinity()) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        ECPoint n = p.normalize();
        out.put("x", Hex.encode(Secp256k1.bigintTo32(n.getAffineXCoord().toBigInteger())));
        out.put("y", Hex.encode(Secp256k1.bigintTo32(n.getAffineYCoord().toBigInteger())));
        return out;
    }

    private static boolean same(Object a, Object b) {
        return a == null ? b == null : a.equals(b);
    }

    /** What a call answers, or the sentence it refuses with. */
    private static String refusal(Supplier<Object> call) {
        try {
            call.get();
            return null;
        } catch (IllegalArgumentException e) {
            return e.getMessage();
        }
    }

    // ── the curve ─────────────────────────────────────────────────────────────

    @Test
    void multipliesAndAddsPointsAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "multiples")) {
            ran++;
            if (!same(shown(Secp256k1.pointMul(scalar(c.get("k")))), c.get("point"))) {
                failures.add(c.get("k") + "·G");
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "sums")) {
            ran++;
            if (!same(shown(Secp256k1.pointAdd(Secp256k1.pointMul(scalar(c.get("a"))), Secp256k1.pointMul(scalar(c.get("b"))))), c.get("sum"))) {
                failures.add(c.get("a") + "·G + " + c.get("b") + "·G");
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "mixed")) {
            ran++;
            if (!same(shown(Secp256k1.pointMul(scalar(c.get("k")), Secp256k1.pointMul(scalar(c.get("base"))))), c.get("point"))) {
                failures.add(c.get("k") + "·(" + c.get("base") + "·G)");
            }
        }
        none(failures, "curve operations", ran, 60);
        assertEquals(V.get("order"), Hex.encode(Secp256k1.bigintTo32(Secp256k1.N)));
    }

    @Test
    void liftsAnXCoordinateOnlyWhenItIsOnTheCurveAndAlwaysToTheEvenPoint() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int off = 0;
        for (Map<String, Object> c : Vectors.cases(V, "lifts")) {
            ran++;
            ECPoint p = Secp256k1.liftX(scalar(c.get("x")));
            off += p == null ? 1 : 0;
            if (!same(shown(p), c.get("point")) || !same(p == null ? null : Secp256k1.hasEvenY(p), c.get("evenY"))) {
                failures.add("lift_x(" + c.get("x") + ")");
            }
        }
        none(failures, "lift_x cases", ran, 40);
        assertTrue(off >= 5 && off < ran, "some of the x are off the curve, some on it: " + off + " of " + ran);
    }

    @Test
    void hashesWithATagAsBip340Does() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "tagged")) {
            ran++;
            byte[][] parts = list(c.get("parts")).stream().map((h) -> Hex.decode((String) h)).toArray(byte[][]::new);
            if (!Hex.encode(Secp256k1.taggedHash((String) c.get("tag"), parts)).equals(c.get("hash"))) {
                failures.add("tag " + Vectors.show((String) c.get("tag")) + ", " + parts.length + " parts");
            }
        }
        none(failures, "tagged hashes", ran, 40);
    }

    // ── BIP340 ────────────────────────────────────────────────────────────────

    @Test
    void signsTheOfficialVectorsToTheByte() {
        List<Map<String, Object>> official = Vectors.cases(V, "official");
        assertEquals(4, official.size(), "the four signing vectors of BIP340");
        for (Map<String, Object> c : official) {
            byte[] secret = Hex.decode((String) c.get("secret"));
            byte[] msg = Hex.decode((String) c.get("msg"));
            assertEquals(c.get("pubkey"), Hex.encode(Secp256k1.xOnlyPubkey(secret)));
            byte[] sig = Secp256k1.schnorrSign(msg, secret, Hex.decode((String) c.get("aux")));
            assertEquals(c.get("sig"), Hex.encode(sig), "the signature BIP340 publishes for this key, message and randomness");
            assertTrue(Secp256k1.schnorrVerify(sig, msg, Hex.decode((String) c.get("pubkey"))));
        }
    }

    @Test
    void signsAsTheReferenceDoesForTheSameRandomness() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "signings")) {
            ran++;
            byte[] secret = Hex.decode((String) c.get("secret"));
            byte[] msg = Hex.decode((String) c.get("msg"));
            byte[] sig = Secp256k1.schnorrSign(msg, secret, Hex.decode((String) c.get("aux")));
            if (!Hex.encode(Secp256k1.xOnlyPubkey(secret)).equals(c.get("pubkey")) || !Hex.encode(sig).equals(c.get("sig"))
                    || !Secp256k1.schnorrVerify(sig, msg, Hex.decode((String) c.get("pubkey")))) {
                failures.add("a message of " + msg.length + " bytes under " + c.get("pubkey"));
            }
        }
        none(failures, "signatures", ran, 24);
    }

    @Test
    void verifiesWhatBip340SaysIsValidAndNothingElse() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int valid = 0;
        for (Map<String, Object> c : Vectors.cases(V, "verifications")) {
            ran++;
            boolean ok = Secp256k1.schnorrVerify(Hex.decode((String) c.get("sig")), Hex.decode((String) c.get("msg")), Hex.decode((String) c.get("pubkey")));
            valid += ok ? 1 : 0;
            if (ok != (Boolean) c.get("ok")) {
                failures.add(c.get("name") + ": " + ok + ", the reference says " + c.get("ok"));
            }
        }
        none(failures, "verifications", ran, 19);
        assertTrue(valid == 5, "the five valid ones are accepted, the " + (ran - 5) + " others refused");
    }

    @Test
    void aSignatureMadeWithFreshRandomnessVerifiesAndIsNeverTheSameTwice() {
        byte[] secret = Hex.decode("b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef");
        byte[] msg = Hex.sha256("a message".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] a = Secp256k1.schnorrSign(msg, secret);
        byte[] b = Secp256k1.schnorrSign(msg, secret);
        assertTrue(Secp256k1.schnorrVerify(a, msg, Secp256k1.xOnlyPubkey(secret)));
        assertTrue(Secp256k1.schnorrVerify(b, msg, Secp256k1.xOnlyPubkey(secret)));
        assertFalse(Arrays.equals(a, b));
    }

    @Test
    void derivesAPublicKeyOnlyFromASecretInRange() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "secrets")) {
            ran++;
            String[] got = new String[1];
            String error = refusal(() -> got[0] = Hex.encode(Secp256k1.xOnlyPubkey(Hex.decode((String) c.get("secret")))));
            if (!same(got[0], c.get("pubkey")) || !same(error, c.get("error"))) {
                failures.add("secret " + c.get("secret") + ": " + got[0] + " / " + error + ", expected " + c.get("pubkey") + " / " + c.get("error"));
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "ephemeral")) {
            ran++;
            List<Object> draws = list(c.get("draws"));
            int[] at = new int[1];
            String[] got = new String[1];
            String error = refusal(() -> got[0] = Hex.encode(Taproot.ephemeralSecret(() -> Hex.decode((String) draws.get(at[0]++)))));
            if (!same(got[0], c.get("secret")) || !same(error, c.get("error")) || at[0] != num(c.get("drawn"))) {
                failures.add("a key drawn from " + draws.size() + " candidates: " + got[0] + " / " + error + " after " + at[0]);
            }
        }
        none(failures, "keys", ran, 15);
    }

    // ── taproot ───────────────────────────────────────────────────────────────

    @Test
    void pushesDataMinimallyAndRefusesWhatOneScriptCannotHold() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "pushes")) {
            ran++;
            int size = (int) num(c.get("size"));
            byte[][] got = new byte[1][];
            String error = refusal(() -> got[0] = Taproot.pushData(documentOf(size)));
            boolean ok = same(error, c.get("error")) && (got[0] == null ? c.get("sha256") == null
                    : sha(got[0]).equals(c.get("sha256")) && got[0].length == num(c.get("length"))
                            && Hex.encode(Arrays.copyOfRange(got[0], 0, Math.min(4, got[0].length))).equals(c.get("head")));
            if (!ok) {
                failures.add("a push of " + size + " bytes" + (error == null ? "" : ": " + error));
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "leaves")) {
            ran++;
            if (!Hex.encode(Taproot.tapleafHash(documentOf((int) num(c.get("size"))))).equals(c.get("tapleaf"))) {
                failures.add("the leaf hash of a script of " + c.get("size") + " bytes");
            }
        }
        none(failures, "pushes and leaf hashes", ran, 25);
    }

    @Test
    void commitsOneLeafToAnInternalKeyWithTheParityOfTheTweakedKey() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        boolean[] parities = new boolean[2];
        for (Map<String, Object> c : Vectors.cases(V, "outputs")) {
            ran++;
            Taproot.Output[] got = new Taproot.Output[1];
            String error = refusal(() -> got[0] = Taproot.singleLeaf(Hex.decode((String) c.get("internal")), documentOf((int) num(c.get("scriptSize")))));
            if (!same(error, c.get("error"))) {
                failures.add("internal key " + c.get("internal") + ": refused with " + error + ", expected " + c.get("error"));
                continue;
            }
            if (got[0] == null) {
                continue;
            }
            Map<String, Object> want = map(c.get("output"));
            parities[got[0].parity] = true;
            if (!Hex.encode(got[0].outputKey).equals(want.get("outputKey")) || got[0].parity != num(want.get("parity"))
                    || !Hex.encode(got[0].scriptPubKey).equals(want.get("scriptPubKey")) || !Hex.encode(got[0].controlBlock).equals(want.get("controlBlock"))
                    || !Hex.encode(got[0].tapleaf).equals(want.get("tapleaf"))) {
                failures.add("internal key " + c.get("internal") + ": " + Hex.encode(got[0].controlBlock) + " " + Hex.encode(got[0].outputKey));
            }
            // The low bit of the control block is the parity of the output key's point — which lift_x always gives as even.
            ECPoint even = Secp256k1.liftX(Secp256k1.bytesToBigint(got[0].outputKey));
            ECPoint q = Secp256k1.pointAdd(Secp256k1.liftX(Secp256k1.bytesToBigint(Hex.decode((String) c.get("internal")))),
                    Secp256k1.pointMul(Secp256k1.bytesToBigint(Secp256k1.taggedHash("TapTweak", Hex.decode((String) c.get("internal")), got[0].tapleaf))));
            if (q.equals(even) != ((got[0].controlBlock[0] & 1) == 0)) {
                failures.add("internal key " + c.get("internal") + ": the control block's parity bit is not the tweaked key's");
            }
        }
        none(failures, "taproot outputs", ran, 29);
        assertTrue(parities[0] && parities[1], "both parities occur in the vectors");
    }

    private static List<Tx.Input> inputs(Object o) {
        List<Tx.Input> out = new ArrayList<>();
        for (Object each : list(o)) {
            Map<String, Object> i = map(each);
            out.add(i.get("sequence") == null ? new Tx.Input((String) i.get("txid"), num(i.get("vout")))
                    : new Tx.Input((String) i.get("txid"), num(i.get("vout")), new byte[0], num(i.get("sequence"))));
        }
        return out;
    }

    @Test
    void computesTheScriptPathSighashAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "sighashCases")) {
            ran++;
            List<Tx.Output> outputs = new ArrayList<>();
            for (Object o : list(c.get("outputs"))) {
                outputs.add(new Tx.Output(num(map(o).get("value")), Hex.decode((String) map(o).get("script"))));
            }
            List<Taproot.Prevout> prevouts = new ArrayList<>();
            for (Object o : list(c.get("prevouts"))) {
                prevouts.add(new Taproot.Prevout(num(map(o).get("value")), Hex.decode((String) map(o).get("script"))));
            }
            String[] got = new String[1];
            String error = refusal(() -> got[0] = Hex.encode(Taproot.tapSighash(inputs(c.get("inputs")), outputs, prevouts, (int) num(c.get("inputIndex")),
                    Hex.decode((String) c.get("tapleaf")), c.get("version") == null ? 2 : num(c.get("version")), c.get("locktime") == null ? 0 : num(c.get("locktime")))));
            if (!same(got[0], c.get("sighash")) || !same(error, c.get("error"))) {
                failures.add("case " + ran + ": " + got[0] + " / " + error + ", expected " + c.get("sighash") + " / " + c.get("error"));
            }
        }
        none(failures, "sighashes", ran, 5);
    }

    // ── the envelope ──────────────────────────────────────────────────────────

    @Test
    void writesTheEnvelopeWithEveryBodySplitAt520Bytes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "envelopes")) {
            ran++;
            int size = (int) num(c.get("size"));
            byte[] body = documentOf(size);
            byte[] script = Inscription.envelopeScript((String) c.get("tag"), (String) c.get("contentType"), body);
            List<byte[]> chunks = Inscription.chunk(body);
            List<Object> shape = new ArrayList<>();
            for (int i = 0; i < chunks.size(); i++) {
                if (i < 2 || i == chunks.size() - 1) {
                    shape.add((double) chunks.get(i).length);
                }
            }
            boolean ok = script.length == num(c.get("length")) && sha(script).equals(c.get("sha256")) && (c.get("hex") == null || Hex.encode(script).equals(c.get("hex")))
                    && chunks.size() == num(c.get("chunkCount")) && shape.equals(c.get("chunks"));
            if (!ok) {
                failures.add(size + " bytes as " + Vectors.show((String) c.get("contentType")));
                continue;
            }
            // And read back by a reader that shares nothing with the writer.
            byte[] key = new byte[32];
            Arrays.fill(key, (byte) 7);
            WitnessReader.Envelope e = WitnessReader.envelope(Inscription.leafScript(key, (String) c.get("tag"), (String) c.get("contentType"), body));
            boolean every520 = true;
            for (int i = 0; i < e.pushes.size() - 1; i++) {
                every520 &= e.pushes.get(i) == Inscription.MAX_PUSH;
            }
            if (!Arrays.equals(e.body, body) || !e.contentType.equals(c.get("contentType")) || !e.protocolTag.equals(c.get("tag")) || !every520
                    || e.pushes.get(e.pushes.size() - 1) > Inscription.MAX_PUSH) {
                failures.add(size + " bytes as " + Vectors.show((String) c.get("contentType")) + ": not read back as written");
            }
        }
        for (Map<String, Object> c : Vectors.cases(V, "leafScripts")) {
            ran++;
            byte[][] got = new byte[1][];
            String error = refusal(() -> got[0] = Inscription.leafScript(Hex.decode((String) c.get("pubkey")), "bcrt", "application/pdf", documentOf((int) num(c.get("size")))));
            if (!same(error, c.get("error")) || (got[0] != null && (got[0].length != num(c.get("length")) || !sha(got[0]).equals(c.get("sha256"))))) {
                failures.add("the leaf script of " + c.get("size") + " bytes");
            }
        }
        none(failures, "envelopes", ran, 70);
        assertEquals(520, Inscription.MAX_PUSH);
        assertEquals(V.get("maxPush"), (double) Inscription.MAX_PUSH);
        assertEquals(V.get("nums"), Hex.encode(Inscription.numsInternalKey()));
        for (Map<String, Object> c : Vectors.cases(V, "tags")) {
            assertEquals(c.get("tag"), Inscription.protocolTagFor((String) c.get("network")));
        }
    }

    @Test
    void buildsAnInscriptionOrRefusesItInTheReferencesWords() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int stricter = 0;
        for (Map<String, Object> c : Vectors.cases(V, "builds")) {
            ran++;
            Inscription[] got = new Inscription[1];
            String error = refusal(() -> got[0] = Inscription.build(Hex.decode((String) c.get("pubkey")), documentOf((int) num(c.get("size"))),
                    (String) c.get("contentType"), (String) c.get("tag"), c.get("maxBodyBytes") == null ? null : num(c.get("maxBodyBytes"))));
            String what = c.get("size") + " bytes, content type of " + ((String) c.get("contentType")).length() + " characters, limit " + c.get("maxBodyBytes");
            if (Boolean.TRUE.equals(c.get("pushOver520Bytes"))) {
                // The one place this differs on purpose (D-09): the reference measures the content type and the tag in
                // UTF-16 units and builds a script with a push no node accepts; here it is refused before a coin moves.
                stricter++;
                if (!"content_type and protocol_tag must each fit in one push".equals(error)) {
                    failures.add(what + ": a push of more than 520 bytes was not refused (" + error + ")");
                }
                continue;
            }
            if (!same(error, c.get("error"))) {
                failures.add(what + ": refused with " + error + ", expected " + c.get("error"));
                continue;
            }
            if (got[0] == null) {
                continue;
            }
            Map<String, Object> want = map(c.get("built"));
            Inscription ins = got[0];
            if (!ins.leafHex.equals(want.get("leafHex")) || ins.leafScript.length != num(want.get("leafScriptLength")) || !sha(ins.leafScript).equals(want.get("leafScriptSha256"))
                    || !Hex.encode(ins.taproot.outputKey).equals(want.get("outputKey")) || ins.taproot.parity != num(want.get("parity"))
                    || !Hex.encode(ins.taproot.scriptPubKey).equals(want.get("scriptPubKey")) || !Hex.encode(ins.taproot.controlBlock).equals(want.get("controlBlock"))
                    || !Hex.encode(ins.taproot.tapleaf).equals(want.get("tapleaf")) || !ins.contentType.equals(want.get("contentType"))
                    || !ins.protocolTag.equals(want.get("protocolTag")) || ins.bodyLength != num(want.get("bodyLength"))) {
                failures.add(what + ": built differently");
            }
            // The internal key is the point nobody holds a key for, whatever key signs the leaf.
            if (!Hex.encode(Arrays.copyOfRange(ins.taproot.controlBlock, 1, 33)).equals(V.get("nums"))) {
                failures.add(what + ": the internal key is not the NUMS point");
            }
        }
        none(failures, "inscriptions", ran, 23);
        assertTrue(stricter >= 3, "the cases refused here and built by the reference were read: " + stricter);
    }

    // ── the reveal transaction ────────────────────────────────────────────────

    @Test
    void buildsAndSignsTheRevealToTheByte() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : Vectors.cases(V, "reveals")) {
            ran++;
            int size = (int) num(c.get("size"));
            byte[] secret = Hex.decode((String) c.get("secret"));
            byte[] body = documentOf(size);
            Inscription ins = Inscription.build(Secp256k1.xOnlyPubkey(secret), body, (String) c.get("contentType"), (String) c.get("tag"), null);
            List<Tx.Output> outputs = Inscriber.revealOutputs(ins, Hex.decode((String) c.get("revealScript")));
            long vsize = Inscriber.revealVsize(ins, outputs);
            long commitValue = Inscriber.commitValue(vsize);
            String commitTxid = (String) c.get("commitTxid");
            long vout = num(c.get("commitVout"));
            byte[] raw = Inscriber.signedReveal(ins, secret, Hex.decode((String) c.get("aux")), commitTxid, vout, commitValue, outputs);
            String txid = Inscriber.revealTxid(commitTxid, vout, outputs);
            boolean ok = vsize == num(c.get("vsize")) && commitValue == num(c.get("commitValue")) && raw.length == num(c.get("length")) && sha(raw).equals(c.get("sha256"))
                    && (c.get("hex") == null || Hex.encode(raw).equals(c.get("hex"))) && txid.equals(c.get("txid")) && Taproot.wtxidOf(raw).equals(c.get("wtxid"));
            if (!ok) {
                failures.add("the reveal of " + size + " bytes: vsize " + vsize + ", " + raw.length + " bytes, txid " + txid);
                continue;
            }
            // Read back: the witness is [signature, leaf script, control block]; the signature is the leaf key's over the
            // sighash that commits to the commit output's amount and script; the script holds the document.
            List<byte[]> witness = WitnessReader.witnessItems(raw, 0);
            WitnessReader.Envelope e = WitnessReader.envelope(witness.get(1));
            List<Tx.Input> in = java.util.Collections.singletonList(new Tx.Input(commitTxid, vout, new byte[0], 0xfffffffdL));
            byte[] sighash = Taproot.tapSighash(in, outputs, java.util.Collections.singletonList(new Taproot.Prevout(commitValue, ins.taproot.scriptPubKey)), 0, ins.taproot.tapleaf);
            byte[] other = Taproot.tapSighash(in, outputs, java.util.Collections.singletonList(new Taproot.Prevout(commitValue + 1, ins.taproot.scriptPubKey)), 0, ins.taproot.tapleaf);
            if (witness.size() != 3 || !Hex.encode(witness.get(0)).equals(c.get("signature")) || !Hex.encode(sighash).equals(c.get("sighash"))
                    || !Secp256k1.schnorrVerify(witness.get(0), sighash, e.pubkey) || Secp256k1.schnorrVerify(witness.get(0), other, e.pubkey)
                    || !Arrays.equals(e.pubkey, Secp256k1.xOnlyPubkey(secret)) || !Arrays.equals(witness.get(2), ins.taproot.controlBlock)
                    || !Arrays.equals(e.body, body) || !sha(e.body).equals(ins.leafHex)) {
                failures.add("the reveal of " + size + " bytes is not read back as it was built");
            }
            // The anchor output — the digest, where the txid covers it — comes first.
            if (!Hex.encode(outputs.get(0).scriptPubKey).equals("6a20" + ins.leafHex) || outputs.get(0).value != 0 || outputs.get(1).value != 1000) {
                failures.add("the reveal of " + size + " bytes: its outputs are not the anchor and the 1000-satoshi return");
            }
        }
        none(failures, "reveal transactions", ran, 5);
    }

    // ── the conformance fixture ───────────────────────────────────────────────

    @Test
    void readsTheDocumentOutOfTheConformanceFixtureAndWritesItsScriptToTheByte() throws Exception {
        Map<String, Object> f = map(V.get("fixture"));
        Path dir = Path.of("..", "..").resolve((String) f.get("directory"));
        Map<String, Object> bundle = map(com.stonehash.attest.core.json.Js.parse(Files.readString(dir.resolve("bundle.json"))));
        byte[] original = Files.readAllBytes(dir.resolve("original.pdf"));
        Map<String, Object> anchor = map(bundle.get("anchor"));
        Map<String, Object> declared = map(anchor.get("witness_envelope"));

        List<byte[]> witness = WitnessReader.witnessItems(Hex.decode((String) anchor.get("reveal_tx_hex")), (int) num(declared.get("input_index")));
        assertEquals(3, witness.size(), "signature, leaf script, control block");
        WitnessReader.Envelope e = WitnessReader.envelope(witness.get(1));
        assertArrayEquals(original, e.body, "the document recovered from the witness is the fixture's original");
        assertEquals(map(bundle.get("record")).get("leaf_bytes"), sha(e.body), "and its digest is the record's leaf");
        assertEquals(declared.get("content_type"), e.contentType);
        assertEquals(declared.get("protocol_tag"), e.protocolTag);
        assertEquals(f.get("originalSha256"), sha(original));
        assertEquals(f.get("leafScriptSha256"), sha(witness.get(1)));

        // The same script, written here from the fixture's parts.
        assertArrayEquals(witness.get(1), Inscription.leafScript(e.pubkey, e.protocolTag, e.contentType, original), "the leaf script, byte for byte");
        // Asked to commit that script to the fixture's internal key, this answers what the reference answers. (The
        // fixture is a known-answer document for the envelope; whether its key is a point at all is part of the answer.)
        Map<String, Object> commitment = map(f.get("commitment"));
        Taproot.Output[] out = new Taproot.Output[1];
        String error = refusal(() -> out[0] = Taproot.singleLeaf(Arrays.copyOfRange(witness.get(2), 1, 33), witness.get(1)));
        assertEquals(commitment.get("error"), error);
        assertEquals(commitment.get("controlBlock"), out[0] == null ? null : Hex.encode(out[0].controlBlock));
        assertEquals(commitment.get("outputKey"), out[0] == null ? null : Hex.encode(out[0].outputKey));

        // The tampered fixture: same transaction id, another body — which only its digest shows.
        Map<String, Object> t = map(f.get("tampered"));
        Map<String, Object> bad = map(com.stonehash.attest.core.json.Js.parse(Files.readString(Path.of("..", "..").resolve((String) t.get("directory")).resolve("bundle.json"))));
        byte[] body = WitnessReader.envelope(WitnessReader.witnessItems(Hex.decode((String) map(bad.get("anchor")).get("reveal_tx_hex")), 0).get(1)).body;
        assertEquals(t.get("bodySha256"), sha(body));
        assertNotEquals(map(bad.get("record")).get("leaf_bytes"), sha(body), "a body changed in the witness no longer hashes to the record's leaf");
    }
}
