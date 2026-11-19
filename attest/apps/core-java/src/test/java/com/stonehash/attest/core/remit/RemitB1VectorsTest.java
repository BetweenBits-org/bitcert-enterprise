package com.stonehash.attest.core.remit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.Vectors;
import com.stonehash.attest.core.audit.AuditSearch;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Part 1 of the settlement rail, held to the service it replaces:
 * {@code vectors/remit-b1.json} was written by that service's own code
 * ({@code tools/make-remit-b1-vectors.mjs}) — its quote arithmetic, its
 * reading of a source reference, its acceptance handler on its own store,
 * its evidence functions, its chain lookup.
 */
class RemitB1VectorsTest {
    private static final Map<String, Object> V = Vectors.load("remit-b1.json");

    private static void none(List<String> failures, String what, int ran, int atLeast) {
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " " + what + " differ from the reference:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= atLeast, "the vectors were read: " + ran + " " + what);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    /** What a call came to, in the shape the reference's answers are recorded in. */
    private static Map<String, Object> outcome(Supplier<Object> call) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            out.put("value", call.get());
        } catch (ServiceError e) {
            Map<String, Object> body = new LinkedHashMap<>();
            if (e.detail() != null) {
                body.putAll(e.detail());
            }
            body.put("error", e.code());
            body.put("message", e.getMessage());
            out.put("status", (double) e.status());
            out.put("body", body);
        } catch (HttpError e) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("error", e.code());
            body.put("message", e.getMessage());
            out.put("status", (double) e.status());
            out.put("body", body);
        } catch (PlainError e) {
            out.put("plain", e.getMessage());
        } catch (RuntimeException e) {
            out.put("engine", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        return out;
    }

    /** Is what happened here what the reference answered? Where its runtime threw, any failure that is no refusal of ours is the same answer. */
    private static String differs(Map<String, Object> got, Map<String, Object> expected) {
        if (expected.containsKey("engine")) {
            return got.containsKey("engine") ? null : "expected a failure inside (the reference: " + expected.get("engine") + "), got " + Js.stringify(got);
        }
        return Js.stringify(got).equals(Js.stringify(expected)) ? null : "\n      got      " + Js.stringify(got) + "\n      expected " + Js.stringify(expected);
    }

    // ── quotes ───────────────────────────────────────────────────────────────

    @Test
    void multipliesAndAddsDecimalTextAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        Map<String, Object> quotes = map(V.get("quotes"));
        for (Map<String, Object> c : list(quotes.get("mul"))) {
            ran++;
            String d = differs(outcome(() -> Quotes.mulDecimal((String) c.get("a"), (String) c.get("b"), ((Double) c.get("scale")).intValue())), map(c.get("answer")));
            if (d != null) {
                failures.add(Js.stringify(c.get("a")) + " × " + Js.stringify(c.get("b")) + " to " + c.get("scale") + " places: " + d);
            }
        }
        for (Map<String, Object> c : list(quotes.get("add"))) {
            ran++;
            String d = differs(outcome(() -> Quotes.addDecimal((String) c.get("a"), (String) c.get("b"), ((Double) c.get("scale")).intValue())), map(c.get("answer")));
            if (d != null) {
                failures.add(Js.stringify(c.get("a")) + " + " + Js.stringify(c.get("b")) + " at " + c.get("scale") + " places: " + d);
            }
        }
        none(failures, "products and sums", ran, 280);
    }

    @Test
    void quotesAndRefusesAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : list(map(V.get("quotes")).get("build"))) {
            ran++;
            Map<String, Object> cfg = map(c.get("cfg"));
            Quotes.Config config = new Quotes.Config((String) cfg.get("rateUsdVnd"), (String) cfg.get("rateUsdSgd"), (String) cfg.get("feeUsd"),
                    ((Double) cfg.get("ttlMs")).longValue(), (String) cfg.get("chainLabel"));
            Map<String, Object> got = outcome(() -> {
                Map<String, Object> q = Quotes.build(Js.parse((String) c.get("requestJson")), config, ((Double) c.get("now")).longValue());
                if (!((String) q.get("quote_id")).matches("QT-[0-9a-f-]{13}")) {
                    throw new IllegalStateException("a quote id of another shape: " + q.get("quote_id"));
                }
                q.put("quote_id", "QT-<id>");
                return q;
            });
            String d = differs(got, map(c.get("answer")));
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "quote requests", ran, 70);
    }

    // ── the source reference, the request hash, the cursor ───────────────────

    @Test
    void readsASourceReferenceAndMakesItsTwinKeyAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int refused = 0;
        int keyed = 0;
        for (Map<String, Object> c : list(V.get("sourceRefs"))) {
            ran++;
            Map<String, Object> got = outcome(() -> {
                SourceRef r = SourceRef.of(Js.parse((String) c.get("json")));
                if (r == null) {
                    return null;
                }
                Map<String, Object> shown = new LinkedHashMap<>();
                shown.put("messageType", r.messageType);
                shown.put("sha256", r.sha256);
                shown.put("index", (double) r.index);
                shown.put("uetr", r.uetr);
                shown.put("valueDate", r.valueDate);
                shown.put("content", r.content);
                shown.put("twinKey", r.twinKey);
                shown.put("undated", r.undated);
                return shown;
            });
            refused += got.containsKey("status") ? 1 : 0;
            keyed += got.get("value") instanceof Map && map(got.get("value")).get("twinKey") != null ? 1 : 0;
            String d = differs(got, map(c.get("answer")));
            if (d != null) {
                failures.add(c.get("json") + ": " + d);
            }
        }
        none(failures, "source references", ran, 110);
        assertTrue(refused >= 30 && keyed >= 40, "refusals and twin keys were both among them: " + refused + ", " + keyed);
    }

    @Test
    void hashesARequestAsTheStoredRowsWereHashed() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : list(V.get("requestHashes"))) {
            ran++;
            String got = Acceptance.requestHash(Js.parse((String) c.get("text")));
            if (!got.equals(c.get("hash"))) {
                failures.add(Js.stringify(c.get("text")) + ": " + got + ", expected " + c.get("hash"));
            }
        }
        none(failures, "request hashes", ran, 35);
    }

    @Test
    void issuesAndReadsTheLedgersCursorAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        Map<String, Object> cursors = map(V.get("cursors"));
        for (Map<String, Object> c : list(cursors.get("issued"))) {
            ran++;
            String got = AuditSearch.encodeCursor((String) c.get("c"), (String) c.get("i"));
            if (!got.equals(c.get("cursor"))) {
                failures.add("cursor of " + c.get("c") + " / " + c.get("i") + ": " + got);
            }
            String[] back = AuditSearch.decodeCursor(got);
            if (!back[0].equals(c.get("c")) || !back[1].equals(c.get("i"))) {
                failures.add("cursor of " + c.get("c") + " / " + c.get("i") + " read back as " + back[0] + " / " + back[1]);
            }
        }
        for (Map<String, Object> c : list(cursors.get("read"))) {
            ran++;
            boolean refused;
            try {
                AuditSearch.decodeCursor((String) c.get("cursor"));
                refused = false;
            } catch (ServiceError e) {
                refused = true;
                Map<String, Object> body = map(map(c.getOrDefault("answer", new LinkedHashMap<String, Object>())).getOrDefault("body", new LinkedHashMap<String, Object>()));
                if (body.containsKey("message") && (!e.getMessage().equals(body.get("message")) || !e.code().equals(body.get("error")) || e.status() != 400)) {
                    failures.add(Js.stringify(c.get("cursor")) + ": refused as " + e.code() + " " + e.getMessage());
                }
            }
            if (refused != Boolean.TRUE.equals(c.get("refused"))) {
                failures.add(Js.stringify(c.get("cursor")) + ": " + (refused ? "refused" : "read") + ", the reference " + (refused ? "reads it" : "refuses it"));
            }
        }
        none(failures, "cursors", ran, 25);
    }

    // ── keys ─────────────────────────────────────────────────────────────────

    @Test
    void takesIntoTheKeyringTheKeysTheReferenceTakes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int taken = 0;
        Map<String, Object> keys = map(V.get("keys"));
        for (Map<String, Object> c : list(keys.get("converts"))) {
            ran++;
            boolean got = PublicKeys.convertsToJwk((String) c.get("text"));
            taken += got ? 1 : 0;
            if (got != Boolean.TRUE.equals(c.get("converts"))) {
                failures.add(c.get("name") + ": " + (got ? "taken" : "left out") + ", the reference " + (got ? "leaves it out" : "takes it"));
            }
        }
        none(failures, "offered keys", ran, 40);
        assertTrue(taken >= 10 && taken <= ran - 10, "both answers were among them: " + taken + " of " + ran);
    }

    @Test
    void verifiesWithEveryFormOfAKeyTheReferenceVerifiesWith() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int verified = 0;
        Map<String, Object> verify = map(map(V.get("keys")).get("verify"));
        for (Map<String, Object> c : list(verify.get("forms"))) {
            ran++;
            boolean got = Signatures.verifyEvent(verify.get("payload"), verify.get("sig"), (String) c.get("text"));
            verified += got ? 1 : 0;
            if (got != Boolean.TRUE.equals(c.get("verifies"))) {
                failures.add("the key " + c.get("name") + ": " + (got ? "verifies" : "does not verify") + ", the reference says the opposite");
            }
        }
        none(failures, "forms of a key", ran, 14);
        assertTrue(verified >= 5 && verified < ran, "both answers were among them: " + verified + " of " + ran);
    }

    @Test
    void readsThePlatformKeyFileToTheSameKeyId(@TempDir Path dir) throws Exception {
        Map<String, Object> platform = map(map(V.get("keys")).get("platform"));
        Path file = dir.resolve("platform-remit-key.pem");
        Files.writeString(file, (String) platform.get("pem"));
        PlatformKey.Loaded key = PlatformKey.read(file);
        assertEquals(platform.get("spki"), key.spki, "the public half, as the reference exports it");
        assertEquals(platform.get("keyId"), key.keyId, "the key id");
        assertEquals(platform.get("keyId"), PlatformKey.keyIdOf((String) platform.get("spki")));

        // A key this service makes — on a test store only — is a file the reference reads: checked by tools/check-remit-b1-made.mjs.
        Path made = dir.resolve("made/platform-remit-key.pem");
        PlatformKey.create(made);
        PlatformKey.create(made);
        PlatformKey.Loaded mine = PlatformKey.read(made);
        assertTrue(mine.keyId.matches("STONEHASH-SIGN-[0-9a-f]{8}"), mine.keyId);
        assertEquals("[OWNER_READ, OWNER_WRITE]", new java.util.TreeSet<>(Files.getPosixFilePermissions(made)).toString(), "readable by its owner only");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("payment_id", "PAY-B1-MADE");
        payload.put("sequence", 3);
        Map<String, Object> sig = com.stonehash.attest.remit.Conventions.signEvent(com.stonehash.attest.core.format.Canonical.forSdk(payload), mine.signer, mine.keyId,
                PlatformKey.ISSUER);
        assertTrue(Signatures.verifyEvent(payload, sig, mine.spki));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("pem", Files.readString(made));
        out.put("spki", mine.spki);
        out.put("keyId", mine.keyId);
        out.put("payload", payload);
        out.put("sig", sig);
        Path target = Path.of("target", "remit-b1-made.json");
        Files.createDirectories(target.getParent());
        Files.writeString(target, Js.stringify(out, 1) + "\n");
    }

    // ── the registry ─────────────────────────────────────────────────────────

    @Test
    void showsTheRegistryAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : list(V.get("registry"))) {
            ran++;
            List<Map<String, Object>> rows = list(c.get("rows"));
            String snapshot = Js.stringify(ProductRegistry.snapshot(rows, "<time>"));
            if (!snapshot.equals(Js.stringify(c.get("snapshot")))) {
                failures.add(c.get("name") + ": the snapshot\n      got      " + snapshot + "\n      expected " + Js.stringify(c.get("snapshot")));
            }
            List<Object> ids = new ArrayList<>();
            for (Object entry : ProductRegistry.keyringEntries(rows)) {
                ids.add(map(entry).get("keyId"));
                if (!"ATTESTED".equals(map(entry).get("trustLevel"))) {
                    failures.add(c.get("name") + ": a key of another trust level");
                }
            }
            if (!Js.stringify(ids).equals(Js.stringify(c.get("keyring")))) {
                failures.add(c.get("name") + ": the keyring holds " + Js.stringify(ids) + ", the reference's " + Js.stringify(c.get("keyring")));
            }
        }
        none(failures, "registries", ran, 3);
    }

    // ── acceptance ───────────────────────────────────────────────────────────

    private static Acceptance.Lookups lookups(Map<String, Object> world) {
        Map<String, Object> quotes = map(world.get("quotes"));
        Map<String, Object> institutions = map(world.get("institutions"));
        List<?> payments = (List<?>) world.get("payments");
        return new Acceptance.Lookups() {
            @Override
            public boolean paymentExists(String paymentId) {
                return payments.contains(paymentId);
            }

            @Override
            public Map<String, Object> quote(String orgId, String quoteId) {
                Map<String, Object> q = map(quotes.get(quoteId));
                if (q == null || !orgId.equals(q.get("org"))) {
                    return null;
                }
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", quoteId);
                row.put("response", q.get("response"));
                row.put("expires_at", q.get("expires_at"));
                return row;
            }

            @Override
            public Map<String, Object> institution(String id) {
                return map(institutions.get(id));
            }
        };
    }

    private static final String[][] COLUMNS = { { "id", "id" }, { "org_id", "orgId" }, { "quote_id", "quoteId" }, { "corridor_origin", "corridorOrigin" },
            { "corridor_destination", "corridorDestination" }, { "trade_currency", "tradeCurrency" }, { "trade_amount", "tradeAmount" },
            { "collect_currency", "collectCurrency" }, { "collect_amount", "collectAmount" }, { "usdc_amount", "usdcAmount" },
            { "payout_currency", "payoutCurrency" }, { "payout_amount", "payoutAmount" }, { "beneficiary_institution", "beneficiaryInstitution" },
            { "request_body", "requestBody" } };

    @Test
    void checksAnInstructionInTheOrderAndTheWordsOfTheReference() throws Exception {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int accepted = 0;
        int refused = 0;
        Map<String, Object> accept = map(V.get("accept"));
        Acceptance.Lookups lookups = lookups(map(accept.get("world")));
        Map<String, Object> bank = map(accept.get("bank"));
        long now = ((Double) accept.get("now")).longValue();
        for (Map<String, Object> c : list(accept.get("cases"))) {
            ran++;
            Map<String, Object> expected = map(c.containsKey("java") ? c.get("java") : c.get("answer"));
            AtomicReference<Acceptance.Checked> checked = new AtomicReference<>();
            Map<String, Object> got = outcome(() -> {
                checked.set(Acceptance.check(lookups, (String) accept.get("org"), bank, Js.parse((String) c.get("bodyJson")), now));
                return null;
            });
            if (checked.get() == null) {
                refused++;
                String d = differs(got, expected);
                if (d != null) {
                    failures.add(c.get("name") + ": " + d);
                }
                continue;
            }
            if (((Double) expected.getOrDefault("status", 0d)).intValue() != 202) {
                failures.add(c.get("name") + ": passed every check, expected " + Js.stringify(expected));
                continue;
            }
            accepted++;
            Acceptance.Checked k = checked.get();
            Map<String, Object> stored = map(c.get("stored"));
            Map<String, Object> payment = map(stored.get("payment"));
            for (String[] column : COLUMNS) {
                Object mine = RemitStore.NewPayment.class.getField(column[1]).get(k.fresh);
                if (!String.valueOf(payment.get(column[0])).equals(String.valueOf(mine))) {
                    failures.add(c.get("name") + ": " + column[0] + " would be stored as\n      " + mine + "\n    the reference stored\n      " + payment.get(column[0]));
                }
            }
            List<Map<String, Object>> events = list(stored.get("events"));
            Map<String, Object> first = new LinkedHashMap<>(k.accepted);
            first.put("accepted_at", "<time>");
            Map<String, Object> third = new LinkedHashMap<>(k.verified);
            third.put("verified_at", "<time>");
            String[] mine = { Js.stringify(first), Js.stringify(k.submitted), Js.stringify(third) };
            String[] types = { "REQUEST_ACCEPTED", "BANK_EVIDENCE_SUBMITTED", "BANK_AUTHORIZATION_VERIFIED" };
            if (events.size() != 3) {
                failures.add(c.get("name") + ": the reference wrote " + events.size() + " events");
            }
            for (int i = 0; i < 3 && i < events.size(); i++) {
                if (!types[i].equals(events.get(i).get("type")) || !mine[i].equals(events.get(i).get("payload"))) {
                    failures.add(c.get("name") + ": event " + i + " (" + types[i] + ") would be\n      " + mine[i] + "\n    the reference wrote " + events.get(i).get("type") + "\n      "
                            + events.get(i).get("payload"));
                }
            }
            Map<String, Object> ref = map(stored.get("sourceRef"));
            if ((ref == null) != (k.source == null)) {
                failures.add(c.get("name") + ": a source reference " + (k.source == null ? "is missing" : "is not expected"));
            } else if (ref != null) {
                Map<String, Object> shown = new LinkedHashMap<>();
                shown.put("payment_id", k.paymentId);
                shown.put("org_id", accept.get("org"));
                shown.put("message_type", k.source.messageType);
                shown.put("sha256", k.source.sha256);
                shown.put("idx", (double) k.source.index);
                shown.put("uetr", k.source.uetr);
                shown.put("value_date", k.source.valueDate);
                shown.put("content", k.source.content);
                shown.put("twin_key", k.source.twinKey);
                if (!Js.stringify(shown).equals(Js.stringify(ref))) {
                    failures.add(c.get("name") + ": the source reference would be\n      " + Js.stringify(shown) + "\n    the reference stored\n      " + Js.stringify(ref));
                }
            }
            String hash = Acceptance.requestHash(Js.parse((String) c.get("bodyJson")));
            if (!hash.equals(map(stored.get("idempotency")).get("request_hash"))) {
                failures.add(c.get("name") + ": the request hash " + hash + " is not the one the reference stored");
            }
        }
        // What fails only once the settlement is being written passes every check here; the store tests hold what happens then.
        for (Map<String, Object> c : list(accept.get("inTransaction"))) {
            ran++;
            Map<String, Object> got = outcome(() -> {
                Acceptance.check(lookups, (String) accept.get("org"), bank, Js.parse((String) c.get("bodyJson")), now);
                return null;
            });
            if (!got.containsKey("value")) {
                failures.add(c.get("name") + ": refused by a check — " + Js.stringify(got));
            }
        }
        none(failures, "instructions", ran, 120);
        assertTrue(accepted >= 15 && refused >= 100, "accepted and refused were both among them: " + accepted + ", " + refused);
    }

    @Test
    void refusesASecondSettlementForAMessageInTheWordsOfTheReference() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : list(V.get("conflicts"))) {
            ran++;
            Map<String, Object> expected = map(c.get("answer"));
            Map<String, Object> body = map(expected.get("body"));
            String ground = (String) body.get("ground");
            boolean reused = "reference_reused".equals(body.get("error"));
            boolean undated = "twin_undated".equals(ground);
            SourceRef source = SourceRef.of(Js.parse((String) c.get("sourceMessageJson")));
            Map<String, Object> got = outcome(() -> {
                throw Refusals.sourceConflict(source, new RemitStore.Conflict((String) body.get("existing_payment_id"), undated ? "twin" : ground, reused, undated));
            });
            String d = differs(got, expected);
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "conflicts", ran, 5);
    }

    @Test
    void readsTheBanksStatementAboutAModeBMessageAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int sound = 0;
        for (Map<String, Object> c : list(V.get("fieldsAssertion"))) {
            ran++;
            Object assertion = c.get("assertionJson") == null ? Js.UNDEFINED : Js.parse((String) c.get("assertionJson"));
            Map<String, Object> got = outcome(
                    () -> Signatures.fieldsAssertionProblem(assertion, (String) c.get("paymentId"), c.get("ivms101Digest"), c.get("ciphertext"), (String) c.get("bankSpki")));
            sound += got.containsKey("value") && got.get("value") == null ? 1 : 0;
            String d = differs(got, map(c.get("answer")));
            if (d != null) {
                failures.add(c.get("name") + ": " + d);
            }
        }
        none(failures, "statements", ran, 20);
        assertTrue(sound >= 2 && sound < ran, "sound and unsound statements were both among them: " + sound);
    }

    // ── evidence ─────────────────────────────────────────────────────────────

    @Test
    void reconcilesAndPackagesARecordedSettlementAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int packaged = 0;
        int failed = 0;
        for (Map<String, Object> c : list(V.get("evidence"))) {
            Map<String, Object> p = map(c.get("payment"));
            List<Map<String, Object>> events = list(c.get("events"));
            List<Map<String, Object>> institutions = list(c.get("institutions"));
            String collected = Js.stringify(Evidence.collectElements(events, null));
            if (!collected.equals(c.get("collected"))) {
                failures.add(c.get("name") + ": the elements collected\n      got      " + collected + "\n      expected " + c.get("collected"));
            }
            for (Map<String, Object> o : list(c.get("outcomes"))) {
                ran++;
                boolean allowance = Boolean.TRUE.equals(o.get("acceptDemoFinality"));
                String name = c.get("name") + (allowance ? " (sandbox allowance)" : " (no allowance)");
                Evidence.Outcome got;
                try {
                    got = Evidence.reconcile(p, events, null, institutions, allowance);
                } catch (RuntimeException e) {
                    if (!o.containsKey("answer")) {
                        failures.add(name + ": failed with " + e);
                    }
                    continue;
                }
                if (o.containsKey("answer")) {
                    failures.add(name + ": reconciled, the reference failed: " + Js.stringify(o.get("answer")));
                    continue;
                }
                failed += got.pass ? 0 : 1;
                if (got.pass != Boolean.TRUE.equals(o.get("pass")) || !Js.stringify(got.reasons).equals(Js.stringify(o.get("reasons")))) {
                    failures.add(name + ": pass " + got.pass + " " + got.reasons + ", expected " + o.get("pass") + " " + Js.stringify(o.get("reasons")));
                }
                if (!Js.stringify(got.evidence).equals(o.get("evidence"))) {
                    failures.add(name + ": the evidence after the signature pass\n      got      " + Js.stringify(got.evidence) + "\n      expected " + o.get("evidence"));
                }
                if (!Js.stringify(got.verdict).equals(o.get("verdict"))) {
                    failures.add(name + ": the verdict\n      got      " + Js.stringify(got.verdict) + "\n      expected " + o.get("verdict"));
                }
                if (o.containsKey("package")) {
                    packaged++;
                    Map<String, Object> pkg = map(o.get("package"));
                    Map<String, Object> mine = Evidence.assemblePackage(p, events, got.evidence, got.verdict,
                            ProductRegistry.snapshot(institutions, (String) pkg.get("takenAt")), (String) pkg.get("generatedAt"));
                    if (!Js.stringify(mine).equals(pkg.get("text"))) {
                        failures.add(name + ": the package\n      got      " + Js.stringify(mine) + "\n      expected " + pkg.get("text"));
                    } else if (!Evidence.commitment(mine, (String) pkg.get("nonce")).equals(pkg.get("commitment"))) {
                        failures.add(name + ": the commitment " + Evidence.commitment(mine, (String) pkg.get("nonce")) + ", expected " + pkg.get("commitment"));
                    }
                }
            }
        }
        none(failures, "reconciliations", ran, 24);
        assertTrue(packaged >= 4 && failed >= 8, "passing and failing settlements were both among them: " + packaged + " packaged, " + failed + " failed");
        assertTrue(Evidence.newNonce().matches("[0-9a-f]{64}"));
    }

    // ── the settlement chain ─────────────────────────────────────────────────

    @Test
    void asksTheChainNodeAndReadsItsAnswersAsTheReferenceDoes() throws Exception {
        AtomicReference<Map<String, Object>> script = new AtomicReference<>();
        List<String> asked = Collections.synchronizedList(new ArrayList<>());
        HttpServer node = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        node.createContext("/", (exchange) -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            asked.add(body);
            Map<String, Object> answer = map(script.get().get(map(Js.parse(body)).get("method")));
            if (answer == null || Boolean.TRUE.equals(answer.get("fails"))) {
                exchange.close();
                return;
            }
            byte[] bytes = ((String) answer.get("body")).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(((Double) answer.get("status")).intValue(), bytes.length == 0 ? -1 : bytes.length);
            if (bytes.length > 0) {
                exchange.getResponseBody().write(bytes);
            }
            exchange.close();
        });
        node.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        node.start();
        List<String> failures = new ArrayList<>();
        int ran = 0;
        try {
            String url = "http://127.0.0.1:" + node.getAddress().getPort() + "/";
            for (Map<String, Object> c : list(V.get("chain"))) {
                ran++;
                script.set(map(c.get("script")));
                asked.clear();
                String got = Js.stringify(ChainStatus.of("set".equals(c.get("rpc")) ? url : "", "eip155:31337", (String) c.get("txHash")));
                if (!got.equals(c.get("answerJson"))) {
                    failures.add(c.get("name") + ":\n      got      " + got + "\n      expected " + c.get("answerJson"));
                }
                List<String> sent = new ArrayList<>(asked);
                Collections.sort(sent);
                List<Object> expected = new ArrayList<>((List<?>) c.get("asked"));
                if (!Js.stringify(sent).equals(Js.stringify(expected))) {
                    failures.add(c.get("name") + ": the node was asked\n      " + Js.stringify(sent) + "\n    the reference asked\n      " + Js.stringify(expected));
                }
            }
        } finally {
            node.stop(0);
        }
        none(failures, "chain lookups", ran, 70);
        assertEquals("a%20b%2F%E2%82%ACz-_.!~*'()", ChainStatus.encodeUriComponent("a b/€z-_.!~*'()"));
    }
}
