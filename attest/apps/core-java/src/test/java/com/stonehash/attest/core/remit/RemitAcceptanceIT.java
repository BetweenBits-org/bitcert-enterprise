package com.stonehash.attest.core.remit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.Vectors;
import com.stonehash.attest.core.WiredService;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.format.Canonical;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.HttpResult;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.remit.Conventions;
import com.stonehash.attest.remit.Signer;
import com.stonehash.attest.remit.Signers;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Accepting a settlement on a real schema, with a bank's signatures on
 * every instruction — {@code POST /v1/settlements} from the point where the
 * caller and its {@code Idempotency-Key} are known.
 *
 * <ul>
 * <li>every instruction of {@code vectors/remit-b1.json} — the ones the
 *     reference accepted and the ones it refused — is judged here against
 *     the store, and must be answered as the reference answered it; an
 *     accepted one must leave the rows the reference left;
 * <li>the same key: with the same body, with another body, after a refusal
 *     — one after the other and eight at once
 *     ({@code docs/JAVA-REMIT-DESIGN.md} 6);
 * <li>the same message under eight ids at once; what a refused instruction
 *     leaves behind (the recognition, and nothing else);
 * <li>intake paused: what was answered before is still answered.
 * </ul>
 *
 * <p>The world is the vectors' own (the bank, the receiving institutions,
 * the quotes — test keys made for the vectors), put into the Java test
 * schema under an organisation of this test and taken out again. Run by
 * name: {@code ./mvnw -o test -Dtest='Remit*IT' -Dstonehash.env=.env.dev}.
 */
class RemitAcceptanceIT {
    private static final Map<String, Object> V = Vectors.load("remit-b1.json");
    private static final Map<String, Object> MATERIALS = Vectors.load("remit-b1-materials.json");
    private static final String ORG = "b1it-accept";
    private static final String OTHER_ORG = "b1it-accept-other";
    private static final String KEY_ID = "VN-BANK-B1";
    private static final String ISSUER = "B1 Collection Bank";
    private static final String HOOK = "http://127.0.0.1:3301/hooks/b1it-accept";

    private static WiredService server;
    private static JdbcTemplate sql;
    private static RemitStore store;
    private static RemitJobs jobs;
    private static RemitMapper mapper;
    private static Acceptance acceptance;
    private static ProductRegistry registry;
    private static PlatformKey platform;
    private static Map<String, Object> bank;
    private static Signer bankSigner;
    /** The vectors' institutions, id → the time each row carries: a row is this test's when it has that id and that time. */
    private static Map<String, String> worldInstitutions;
    private static String template;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    @BeforeAll
    static void start() throws Exception {
        server = WiredService.start();
        sql = new JdbcTemplate(server.bean(DataSource.class));
        store = server.bean(RemitStore.class);
        jobs = server.bean(RemitJobs.class);
        mapper = server.bean(RemitMapper.class);
        acceptance = server.bean(Acceptance.class);
        registry = server.bean(ProductRegistry.class);
        platform = server.bean(PlatformKey.class);
        Map<String, Object> accept = map(V.get("accept"));
        Map<String, Object> world = map(accept.get("world"));
        worldInstitutions = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : map(world.get("institutions")).entrySet()) {
            worldInstitutions.put(e.getKey(), (String) map(e.getValue()).get("created_at"));
        }
        removeWorld();

        Rail.org(sql, ORG);
        Rail.org(sql, OTHER_ORG);
        registry.subscribe(ORG, "remit", Rail.map("webhook_url", HOOK));
        for (Map.Entry<String, Object> e : map(world.get("institutions")).entrySet()) {
            Map<String, Object> row = map(e.getValue());
            if (Rail.count(sql, "SELECT COUNT(*) FROM institutions WHERE id = ?", e.getKey()) != 0) {
                // The schema has an institution of that id already (a seed's): it is used as it is, and left where it is.
                Map<String, Object> there = registry.institution(e.getKey());
                assertEquals(row.get("role"), there.get("role"), e.getKey() + " is there with another role");
                assertEquals(row.get("encryption_jwk") == null, there.get("encryption_jwk") == null, e.getKey() + " is there with another kind of encryption key");
                continue;
            }
            sql.update("INSERT INTO institutions (id, org_id, role, name, country, signing_spki, console_spki, encryption_jwk, authority, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    e.getKey(), row.get("org_id") == null ? null : ORG, row.get("role"), row.get("name"), row.get("country"), row.get("signing_spki"), row.get("console_spki"),
                    row.get("encryption_jwk"), row.get("authority"), row.get("created_at"));
        }
        for (Map.Entry<String, Object> e : map(world.get("quotes")).entrySet()) {
            Map<String, Object> q = map(e.getValue());
            sql.update("INSERT INTO remit_quotes (id, org_id, corridor_origin, corridor_destination, request, response, expires_at, created_at) VALUES (?,?,'VN','SG','{}',?,?,?)",
                    e.getKey(), accept.get("org").equals(q.get("org")) ? ORG : OTHER_ORG, q.get("response"), q.get("expires_at"), "2026-11-19T00:00:00.000Z");
        }
        bank = registry.institution((String) map(accept.get("bank")).get("id"));
        assertEquals(ORG, bank.get("org_id"), "the bank of the vectors is this test's organisation's");
        bankSigner = Signers.fromPkcs8Pem((String) map(MATERIALS.get("pem")).get("bank"));
        assertEquals(bank.get("signing_spki"), bankSigner.publicKeySpkiBase64(), "and its key is the one the vectors' instructions were signed with");
        template = (String) list(accept.get("cases")).stream().filter((c) -> c.get("name").equals("an instruction made from the bank's own data")).findFirst().get().get("bodyJson");
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            removeWorld();
            server.close();
        }
    }

    private static void removeWorld() {
        Rail.clean(sql);
        for (Map.Entry<String, String> made : worldInstitutions.entrySet()) {
            sql.update("DELETE FROM institutions WHERE id = ? AND created_at = ?", made.getKey(), made.getValue());
        }
    }

    /** The organisation's ledger as the vectors' world has it before a request: the two settlements that are already there, and nothing else. */
    @BeforeEach
    void emptyLedger() {
        for (String org : new String[] { ORG, OTHER_ORG }) {
            sql.update("DELETE FROM remit_jobs WHERE org_id = ?", org);
            sql.update("DELETE FROM remit_webhook_deliveries WHERE org_id = ?", org);
            sql.update("DELETE FROM remit_idempotency WHERE org_id = ?", org);
            sql.update("DELETE FROM remit_source_matches WHERE org_id = ?", org);
            sql.update("DELETE FROM remit_source_refs WHERE org_id = ?", org);
            sql.update("DELETE FROM remit_events WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id = ?)", org);
            sql.update("DELETE FROM remit_payments WHERE org_id = ?", org);
        }
        server.bean(TransactionTemplate.class).executeWithoutResult((s) -> {
            store.insertPayment(Rail.payment(ORG, "QT-B1-GOOD", "PAY-B1-TAKEN"));
            store.insertPayment(Rail.payment(OTHER_ORG, "QT-B1-OTHER", "PAY-B1-OTHERS"));
        });
    }

    // ── what a call came to, in the shape the reference's answers are recorded in ──

    private static Map<String, Object> outcome(Supplier<HttpResult> call) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            HttpResult r = call.get();
            out.put("status", (double) r.status);
            out.put("body", r.body);
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
            out.put("status", (double) e.status());
            out.put("body", Rail.map("error", e.code(), "message", e.getMessage()));
        } catch (PlainError e) {
            out.put("plain", e.getMessage());
        } catch (RuntimeException e) {
            out.put("engine", e.getClass().getSimpleName() + ": " + e.getMessage());
        }
        return out;
    }

    private static Map<String, Object> accept(String key, Object body) {
        return outcome(() -> acceptance.accept(ORG, bank, key, body));
    }

    /** {@code 202}, {@code 409 duplicate_payment}, {@code plain …}: an answer as one word or two. */
    private static String brief(Map<String, Object> answer) {
        if (answer.containsKey("plain")) {
            return "plain " + answer.get("plain");
        }
        if (answer.containsKey("engine")) {
            return "engine " + answer.get("engine");
        }
        int status = ((Double) answer.get("status")).intValue();
        Object error = answer.get("body") instanceof Map ? map(answer.get("body")).get("error") : null;
        Object ground = answer.get("body") instanceof Map ? map(answer.get("body")).get("ground") : null;
        return status + (error == null ? "" : " " + error) + (ground == null ? "" : " (" + ground + ")");
    }

    /** The answer with the one thing in it that is a time of this run replaced as the vectors have it. */
    private static String timeless(Map<String, Object> answer) {
        return Js.stringify(answer).replaceAll("\"accepted_at\":\"[0-9T:.Z-]{24}\"", "\"accepted_at\":\"<time>\"");
    }

    // ── instructions with a bank's signatures on them ────────────────────────

    /** An instruction as the vectors' bank would send it: the given id, optionally made from a message, signed anew. */
    private static Map<String, Object> instruction(String paymentId, Map<String, Object> sourceMessage) {
        Map<String, Object> body = map(Js.parse(template));
        body.put("payment_id", paymentId);
        body.put("request_id", "REQ-" + paymentId);
        Map<String, Object> authz = map(body.get("bank_authorization"));
        authz.put("payment_id", paymentId);
        body.put("bank_signature", Conventions.signEvent(Canonical.forSdk(authz), bankSigner, KEY_ID, ISSUER));
        Map<String, Object> core = map(map(body.get("evidence_elements")).get("bankInstruction"));
        core.remove("digest");
        core.remove("signature");
        core.put("ref", paymentId);
        if (sourceMessage != null) {
            core.put("sourceMessage", sourceMessage);
        }
        Map<String, Object> signed = Conventions.digestAndSignElement(map(Canonical.forSdk(core)), bankSigner, KEY_ID, ISSUER);
        core.put("digest", signed.get("digest"));
        core.put("signature", signed.get("signature"));
        // As it would arrive: written out and read back.
        return map(Js.parse(Js.stringify(body)));
    }

    private static Map<String, Object> message(String file, Object... more) {
        Map<String, Object> m = Rail.map("type", "MT103", "sha256", Rail.sha(file));
        for (int i = 0; i < more.length; i += 2) {
            m.put((String) more[i], more[i + 1]);
        }
        return m;
    }

    private static long settlements() {
        return Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE org_id = ? AND id <> 'PAY-B1-TAKEN'", ORG);
    }

    private static void nothingLeft(String what) {
        assertEquals(0, settlements(), what + ": no settlement");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_events"
                + " WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id = ?)", ORG), what + ": no event");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_source_refs WHERE org_id = ?", ORG), what + ": no reference");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_jobs WHERE org_id = ?", ORG), what + ": no job");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", ORG), what + ": no stored answer");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_webhook_deliveries WHERE org_id = ?", ORG), what + ": no notice");
    }

    // ── the vectors, on the store ────────────────────────────────────────────

    @Test
    void judgesEveryInstructionOfTheVectorsAsTheReferenceDidAndStoresWhatItStored() {
        Map<String, Object> accept = map(V.get("accept"));
        List<String> failures = new ArrayList<>();
        int ran = 0;
        int accepted = 0;
        for (Map<String, Object> c : list(accept.get("cases"))) {
            ran++;
            emptyLedger();
            String name = (String) c.get("name");
            Map<String, Object> expected = map(c.containsKey("java") ? c.get("java") : c.get("answer"));
            String key = "b1it-case-" + ran;
            Object body = Js.parse((String) c.get("bodyJson"));
            Map<String, Object> got = accept(key, body);
            if (expected.containsKey("engine")) {
                if (!got.containsKey("engine")) {
                    failures.add(name + ": expected a failure inside (the reference: " + expected.get("engine") + "), got " + Js.stringify(got));
                }
            } else if (!timeless(got).equals(Js.stringify(expected))) {
                failures.add(name + ":\n      got      " + timeless(got) + "\n      expected " + Js.stringify(expected));
            }
            if (!Double.valueOf(202).equals(got.get("status"))) {
                try {
                    nothingLeft(name);
                } catch (AssertionError e) {
                    failures.add("a refused instruction left something behind — " + e.getMessage());
                }
                continue;
            }
            accepted++;
            Map<String, Object> stored = map(c.get("stored"));
            if (stored == null) {
                failures.add(name + ": accepted here; the reference stored nothing");
                continue;
            }
            String id = (String) map(got.get("body")).get("payment_id");
            String at = (String) map(got.get("body")).get("accepted_at");
            Map<String, Object> row = store.get(id);
            for (Map.Entry<String, Object> column : map(stored.get("payment")).entrySet()) {
                Object theirs = column.getKey().equals("org_id") ? ORG : column.getValue();
                if (!String.valueOf(theirs).equals(String.valueOf(row.get(column.getKey())))) {
                    failures.add(name + ": " + column.getKey() + " is stored as\n      " + row.get(column.getKey()) + "\n    the reference stored\n      " + theirs);
                }
            }
            if (!at.equals(row.get("created_at")) && ((String) row.get("created_at")).compareTo(at) < 0) {
                failures.add(name + ": created " + row.get("created_at") + ", before it was accepted at " + at);
            }
            List<Map<String, Object>> events = store.events(id);
            List<Map<String, Object>> theirs = list(stored.get("events"));
            if (events.size() != theirs.size()) {
                failures.add(name + ": " + events.size() + " events, the reference wrote " + theirs.size());
            }
            for (int i = 0; i < Math.min(events.size(), theirs.size()); i++) {
                Map<String, Object> mine = events.get(i);
                Map<String, Object> ref = theirs.get(i);
                String payload = ((String) mine.get("payload")).replace("\"accepted_at\":\"" + at + "\"", "\"accepted_at\":\"<time>\"")
                        .replace("\"verified_at\":\"" + at + "\"", "\"verified_at\":\"<time>\"");
                if (((Number) mine.get("seq")).intValue() != ((Double) ref.get("seq")).intValue() || !mine.get("type").equals(ref.get("type"))
                        || !mine.get("issuer").equals(ref.get("issuer")) || !payload.equals(ref.get("payload"))) {
                    failures.add(name + ": event " + i + " is\n      " + mine.get("seq") + " " + mine.get("type") + " by " + mine.get("issuer") + " " + payload
                            + "\n    the reference wrote\n      " + Js.stringify(ref));
                }
                boolean signed = mine.get("sig") != null;
                if (signed != Boolean.TRUE.equals(ref.get("signed"))) {
                    failures.add(name + ": event " + i + " is " + (signed ? "signed" : "not signed"));
                } else if (signed) {
                    Map<String, Object> sig = map(Js.parse((String) mine.get("sig")));
                    if (!Signatures.verifyEvent(Js.parse((String) mine.get("payload")), sig, platform.spki()) || !platform.keyId().equals(sig.get("key_id"))
                            || !"STONEHASH".equals(sig.get("issuer")) || !sig.keySet().toString().equals("[alg, key_id, issuer, sig]")) {
                        failures.add(name + ": the platform's signature on event " + i + " does not verify, or is not its envelope: " + sig.keySet());
                    }
                }
            }
            Map<String, Object> ref = store.sourceRef(id);
            Map<String, Object> theirRef = map(stored.get("sourceRef"));
            if ((ref == null) != (theirRef == null)) {
                failures.add(name + ": a source reference " + (ref == null ? "is missing" : "is not expected"));
            } else if (ref != null) {
                Map<String, Object> shown = new LinkedHashMap<>(ref);
                shown.remove("created_at");
                Map<String, Object> wanted = new LinkedHashMap<>(theirRef);
                wanted.put("org_id", ORG);
                if (!Js.stringify(shown).equals(Js.stringify(wanted))) {
                    failures.add(name + ": the source reference is\n      " + Js.stringify(shown) + "\n    the reference stored\n      " + Js.stringify(wanted));
                }
            }
            Map<String, Object> hit = store.idempotencyHit(ORG, key);
            Map<String, Object> theirHit = map(stored.get("idempotency"));
            if (hit == null || !hit.get("request_hash").equals(theirHit.get("request_hash"))
                    || ((Number) hit.get("response_status")).intValue() != ((Double) theirHit.get("response_status")).intValue()
                    || !((String) hit.get("response_body")).replace(at, "<time>").equals(theirHit.get("response_body"))) {
                failures.add(name + ": the stored answer is " + (hit == null ? null : Js.stringify(hit)) + "\n    the reference stored " + Js.stringify(theirHit));
            }
            // What the reference kept in memory and this service keeps in the store: the first job, held by the request that made it.
            List<Map<String, Object>> made = jobs.ofPayment(id);
            if (made.size() != 1 || !"TRAVEL_RULE".equals(made.get(0).get("kind")) || !"running".equals(made.get(0).get("state")) || made.get(0).get("lease_owner") == null
                    || !(id + ":travel-rule").equals(made.get(0).get("idempotency_key")) || ((Number) made.get(0).get("attempts")).intValue() != 0) {
                failures.add(name + ": the first job is not one TRAVEL_RULE job held by its inserter: " + Js.stringify(made));
            }
            // The notice to the bank, as the reference queues it: the number of the last event, the state reached, the quote.
            List<Map<String, Object>> notices = mapper.webhooksOfPayment(id);
            if (notices.size() != 1) {
                failures.add(name + ": " + notices.size() + " notices");
            } else {
                Map<String, Object> sent = map(Js.parse((String) notices.get(0).get("body")));
                Map<String, Object> envelope = map(sent.get("envelope"));
                String shape = Js.stringify(Rail.map("payment_id", envelope.get("payment_id"), "sequence", envelope.get("sequence"), "type", envelope.get("type"),
                        "state", envelope.get("state"), "data", envelope.get("data")));
                String wanted = Js.stringify(Rail.map("payment_id", id, "sequence", 2, "type", "BANK_AUTHORIZED", "state", "BANK_AUTHORIZED",
                        "data", Rail.map("quote_id", row.get("quote_id"))));
                if (!shape.equals(wanted) || !HOOK.equals(notices.get(0).get("url")) || !Signatures.verifyEvent(envelope, sent.get("signature"), platform.spki())) {
                    failures.add(name + ": the notice is " + shape + " to " + notices.get(0).get("url") + ", expected " + wanted + " signed by the platform");
                }
            }
        }
        // What fails only once the settlement is being written: the reference's answer, and nothing left of the settlement.
        for (Map<String, Object> c : list(accept.get("inTransaction"))) {
            ran++;
            emptyLedger();
            Map<String, Object> got = accept("b1it-case-" + ran, Js.parse((String) c.get("bodyJson")));
            if (!Js.stringify(got).equals(Js.stringify(c.get("answer")))) {
                failures.add(c.get("name") + ":\n      got      " + Js.stringify(got) + "\n      expected " + Js.stringify(c.get("answer")));
            }
            try {
                nothingLeft((String) c.get("name"));
            } catch (AssertionError e) {
                failures.add("a settlement that could not be written whole left something behind — " + e.getMessage());
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " differences from the reference in " + ran + " instructions:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= 126 && accepted >= 15, "the vectors were read: " + ran + " instructions, " + accepted + " accepted");
        System.out.println("acceptance on the store: " + ran + " instructions judged as the reference judged them — " + accepted + " accepted with the rows the reference left, "
                + (ran - accepted) + " refused with nothing left");
    }

    /**
     * The reference's route answered these one after the other on one store: an instruction accepted, then the same key
     * with the same body, with its members in another order, with a body that could not be accepted, another key with
     * the same body, a refusal, and the refused key again. (The three entries before them are about the header alone —
     * no key, a key of seven characters — and are compared over HTTP: parity/cases/remit-b1-routes.mjs.)
     */
    @Test
    void answersARunOfRequestsUnderTheirKeysAsTheReferencesRouteDid() {
        List<String> failures = new ArrayList<>();
        int ran = 0;
        for (Map<String, Object> c : list(map(V.get("accept")).get("route"))) {
            String key = (String) map(c.get("headers")).get("idempotency-key");
            if (key == null || key.length() < 8) {
                continue;
            }
            ran++;
            Map<String, Object> got = accept(key, Js.parse((String) c.get("bodyJson")));
            if (!timeless(got).equals(Js.stringify(c.get("answer")))) {
                failures.add(c.get("name") + ":\n      got      " + timeless(got) + "\n      expected " + Js.stringify(c.get("answer")));
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " answers differ from the reference's:\n  " + String.join("\n  ", failures));
        assertEquals(7, ran, "the vectors were read");
        assertEquals(1, settlements(), "one settlement came of the seven requests");
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", ORG), "and one answer is kept: that of the accepted one");
    }

    // ── the same key ─────────────────────────────────────────────────────────

    @Test
    void answersTheSameKeyAsTheDesignSays() {
        Map<String, Object> first = instruction("PAY-B1IT-IDEM-1", null);
        Map<String, Object> answer = accept("b1it-idem-key-1", first);
        assertEquals("202", brief(answer));

        // The same key and the same body: the stored answer, to the character — and nothing is written again.
        Map<String, Object> again = accept("b1it-idem-key-1", first);
        assertEquals(Js.stringify(answer), Js.stringify(again));
        assertEquals(Js.stringify(answer), Js.stringify(accept("b1it-idem-key-1", map(Js.parse(Js.stringify(first))))), "the same bytes sent again are the same body");
        assertEquals(1, settlements());
        assertEquals(3, store.events("PAY-B1IT-IDEM-1").size());
        assertEquals(1, jobs.ofPayment("PAY-B1IT-IDEM-1").size());

        // The same members in another order are another body: the hash is of the body as it was sent.
        Map<String, Object> reordered = new LinkedHashMap<>();
        List<String> names = new ArrayList<>(first.keySet());
        java.util.Collections.reverse(names);
        for (String name : names) {
            reordered.put(name, first.get(name));
        }
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-1", reordered)));
        // The instruction built anew is another body too — its signatures are new ones.
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-1", instruction("PAY-B1IT-IDEM-1", null))));
        // Another body under the key — also one that could never be accepted: a conflict, before anything else is looked at.
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-1", instruction("PAY-B1IT-IDEM-2", null))));
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-1", Rail.map("nothing", "of use"))));
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-1", null)));
        // Another key, the same body: the settlement exists.
        assertEquals("409 duplicate_payment", brief(accept("b1it-idem-key-2", first)));
        assertEquals(1, settlements());
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", ORG), "a refusal is not stored under its key");

        // A refusal is not remembered: the key is judged again — with the same body, and with a corrected one (which is what a bank sends next).
        Map<String, Object> wrong = instruction("PAY-B1IT-IDEM-3", null);
        map(map(wrong.get("amount")).get("payout")).put("value", "1.00");
        assertEquals("400 amount_mismatch", brief(accept("b1it-idem-key-3", wrong)));
        assertEquals("400 amount_mismatch", brief(accept("b1it-idem-key-3", wrong)));
        assertEquals("202", brief(accept("b1it-idem-key-3", instruction("PAY-B1IT-IDEM-3", null))));
        assertEquals("409 idempotency_conflict", brief(accept("b1it-idem-key-3", wrong)), "once accepted, the key is the accepted body's");
        assertEquals(2, settlements());

        // The same key under another organisation is another key.
        Map<String, Object> others = outcome(() -> acceptance.accept(OTHER_ORG, bank, "b1it-idem-key-1", first));
        assertEquals("409 duplicate_payment", brief(others), "judged afresh: the id is taken, not the key");
    }

    @Test
    void answersEightRequestsUnderOneKeyArrivingTogether() throws Exception {
        // The same body eight times at once: all eight get the one answer, and there is one settlement.
        for (int round = 0; round < 3; round++) {
            String id = "PAY-B1IT-SAME-" + round;
            String key = "b1it-same-key-" + round;
            Map<String, Object> body = instruction(id, message("same " + round, "instructionId", "S" + round, "valueDate", "2026-11-17", "content", "5a".repeat(32)));
            List<Map<String, Object>> answers = Rail.together(8, (i) -> accept(key, map(Js.parse(Js.stringify(body)))));
            TreeSet<String> distinct = new TreeSet<>();
            for (Map<String, Object> a : answers) {
                distinct.add(Js.stringify(a));
            }
            assertEquals(1, distinct.size(), "one answer for all eight: " + distinct);
            assertEquals("202", brief(answers.get(0)));
            assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE id = ?", id));
            assertEquals(3, store.events(id).size());
            assertEquals(1, jobs.ofPayment(id).size());
            assertEquals(1, mapper.webhooksOfPayment(id).size());
            assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ? AND idem_key = ?", ORG, key));
        }

        // Eight different bodies under one key at once: one is accepted, the others hear that the key is taken.
        List<Map<String, Object>> different = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            different.add(instruction("PAY-B1IT-DIFF-" + i, null));
        }
        List<String> answers = Rail.together(8, (i) -> brief(accept("b1it-diff-key", different.get(i))));
        assertEquals(1, answers.stream().filter((a) -> a.equals("202")).count(), answers.toString());
        assertEquals(7, answers.stream().filter((a) -> a.equals("409 idempotency_conflict")).count(), answers.toString());
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE id LIKE 'PAY-B1IT-DIFF-%'"));

        // The same key, the same payment id, bodies that differ in a member nobody reads: the key decides, not the id.
        List<Map<String, Object>> sameId = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            Map<String, Object> body = instruction("PAY-B1IT-ONEID", null);
            body.put("note", "sent as number " + i);
            sameId.add(body);
        }
        answers = Rail.together(8, (i) -> brief(accept("b1it-oneid-key", sameId.get(i))));
        assertEquals(1, answers.stream().filter((a) -> a.equals("202")).count(), answers.toString());
        assertEquals(7, answers.stream().filter((a) -> a.equals("409 idempotency_conflict")).count(), answers.toString());

        // The same body under eight keys at once: one settlement, seven "exists".
        Map<String, Object> body = instruction("PAY-B1IT-KEYS", null);
        answers = Rail.together(8, (i) -> brief(accept("b1it-keys-key-" + i, body)));
        assertEquals(1, answers.stream().filter((a) -> a.equals("202")).count(), answers.toString());
        assertEquals(7, answers.stream().filter((a) -> a.equals("409 duplicate_payment")).count(), answers.toString());
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ? AND idem_key LIKE 'b1it-keys-key-%'", ORG));
    }

    // ── the same message ─────────────────────────────────────────────────────

    @Test
    void makesOneSettlementOfEightSignedInstructionsForOneMessage() throws Exception {
        List<Map<String, Object>> bodies = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            bodies.add(instruction("PAY-B1IT-MSG-" + i, message("one message", "uetr", "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", "instructionId", "D4", "valueDate", "2026-11-17",
                    "content", "cd".repeat(32))));
        }
        List<Map<String, Object>> answers = Rail.together(8, (i) -> accept("b1it-msg-key-" + i, bodies.get(i)));
        List<String> briefs = answers.stream().map(RemitAcceptanceIT::brief).toList();
        assertEquals(1, briefs.stream().filter((a) -> a.equals("202")).count(), briefs.toString());
        assertEquals(7, briefs.stream().filter((a) -> a.equals("409 duplicate_source_message (message)")).count(), briefs.toString());
        String winner = (String) map(answers.get(briefs.indexOf("202")).get("body")).get("payment_id");
        for (Map<String, Object> a : answers) {
            if (!"202".equals(brief(a))) {
                assertEquals(winner, map(a.get("body")).get("existing_payment_id"), "each refusal names the settlement that holds the message");
                assertEquals("this message's payment is already settlement " + winner + " — the same transaction of the same message. Nothing was accepted; read its state with "
                        + "GET /v1/settlements/" + winner + " instead of sending it again", map(a.get("body")).get("message"));
            }
        }
        assertEquals(1, settlements());
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_source_refs WHERE org_id = ?", ORG));
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", ORG), "the seven refusals are not remembered");
        // Any of the seven, sent again under its key, is judged again and hears the same.
        assertEquals("409 duplicate_source_message (message)", brief(accept("b1it-msg-key-" + (briefs.indexOf("202") == 0 ? 1 : 0), bodies.get(briefs.indexOf("202") == 0 ? 1 : 0))));
    }

    @Test
    void keepsTheRecognitionOfARefusedInstruction() {
        // The payment, without a UETR.
        Map<String, Object> bare = message("H bare", "instructionId", "H1", "messageId", "H1", "valueDate", "2026-11-17", "content", "10".repeat(32));
        assertEquals("202", brief(accept("b1it-rec-key-1", instruction("PAY-B1IT-H", bare))));
        assertNull(store.sourceRef("PAY-B1IT-H").get("uetr"));

        // The same payment in another file, now with a UETR: refused as that settlement — and the refusal leaves its two facts behind.
        Map<String, Object> withUetr = message("H with U1", "uetr", "7C2D8E4F-1A3B-4C5D-8E9F-0A1B2C3D4E5F", "instructionId", " H1 ", "messageId", "H1", "valueDate", "2026-11-17",
                "content", "10".repeat(32));
        Map<String, Object> refused = accept("b1it-rec-key-2", instruction("PAY-B1IT-W1", withUetr));
        assertEquals("409 duplicate_source_message (twin)", brief(refused));
        assertEquals("PAY-B1IT-H", map(refused.get("body")).get("existing_payment_id"));
        assertEquals("PAY-B1IT-H", mapper.sourceMatch(ORG, Rail.sha("H with U1"), 0), "the recognition is on record");
        assertEquals("7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f", store.sourceRef("PAY-B1IT-H").get("uetr"), "and the settlement took the UETR of the rendering it was recognised in");
        assertNull(store.get("PAY-B1IT-W1"), "no settlement was made");
        assertNull(store.idempotencyHit(ORG, "b1it-rec-key-2"), "and the refusal is not stored under its key");
        assertEquals(1, settlements());

        // So a second payment with the same content and another UETR is a payment of its own — which it would not be had the first refusal been rolled back.
        Map<String, Object> second = message("H with U2", "uetr", "11111111-2222-4333-8444-555555555555", "instructionId", "H1", "messageId", "H1", "valueDate", "2026-11-17",
                "content", "10".repeat(32));
        assertEquals("202", brief(accept("b1it-rec-key-3", instruction("PAY-B1IT-W2", second))));
        // The recognised file again, under another id: still that settlement, by the record.
        assertEquals("409 duplicate_source_message (twin)", brief(accept("b1it-rec-key-4", instruction("PAY-B1IT-W1b", withUetr))));
        // Another file with the first UETR: the same payment by its UETR.
        Map<String, Object> third = message("H with U1, again", "uetr", "7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f", "instructionId", "H1", "messageId", "H1", "valueDate", "2026-11-17",
                "content", "10".repeat(32));
        assertEquals("409 duplicate_source_message (uetr)", brief(accept("b1it-rec-key-5", instruction("PAY-B1IT-W1c", third))));
        // The first UETR on other content: a reference used twice.
        Map<String, Object> reused = message("other content", "uetr", "7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f", "instructionId", "Z9", "valueDate", "2026-11-17", "content", "ee".repeat(32));
        Map<String, Object> twice = accept("b1it-rec-key-6", instruction("PAY-B1IT-R", reused));
        assertEquals("409 reference_reused (uetr)", brief(twice));
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_source_matches WHERE org_id = ? AND sha256 = ?", ORG, Rail.sha("other content")), "a reference used twice is not a recognition");
        assertEquals(2, settlements());

        // The ledger finds the settlement by the UETR it inherited.
        RemitStore.Search byUetr = new RemitStore.Search();
        byUetr.sourceUetr = "7c2d8e4f-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
        assertEquals("PAY-B1IT-H", store.search(ORG, byUetr).items.get(0).get("id"));
    }

    // ── a day's manifest ─────────────────────────────────────────────────────

    @Test
    void comparesADaysManifestAnchorsItAndKeepsOneRowADay() throws Exception {
        Manifests manifests = server.bean(Manifests.class);
        assertEquals("202", brief(accept("b1it-man-key-1", instruction("PAY-B1IT-MAN-1", null))));
        assertEquals("202", brief(accept("b1it-man-key-2", instruction("PAY-B1IT-MAN-2", null))));
        String day = ((String) store.get("PAY-B1IT-MAN-2").get("created_at")).substring(0, 10);
        List<String> ofDay = store.paymentIdsOfDay(ORG, day);
        assertTrue(ofDay.contains("PAY-B1IT-MAN-2"));

        // Everything of the day: matched, signed by the platform over manifest and verdict, committed, anchored under the bank's organisation.
        Map<String, Object> manifest = Rail.map("date", day, "institution_id", KEY_ID, "payment_ids", new ArrayList<Object>(ofDay), "count", ofDay.size());
        Map<String, Object> sent = map(Js.parse(Js.stringify(Rail.map("manifest", manifest, "sig", Conventions.signEvent(Canonical.forSdk(manifest), bankSigner, KEY_ID, ISSUER)))));
        HttpResult first = manifests.submit(ORG, bank, sent);
        assertEquals(201, first.status);
        Map<String, Object> answer = map(first.body);
        assertEquals("[verdict, platform_signature, commitment, attestation_id]", answer.keySet().toString());
        Map<String, Object> verdict = map(answer.get("verdict"));
        assertEquals("[status, platform_count, manifest_count, missing_in_manifest, unknown_to_platform, checked_at]", verdict.keySet().toString());
        assertEquals("MATCHED", verdict.get("status"));
        assertEquals(ofDay.size(), ((Number) verdict.get("platform_count")).intValue());
        Map<String, Object> signedPart = Rail.map("manifest", sent.get("manifest"), "verdict", verdict);
        assertTrue(Signatures.verifyEvent(map(Js.parse(Js.stringify(signedPart))), answer.get("platform_signature"), platform.spki()), "the platform signed the manifest and its verdict");
        Map<String, Object> record = server.bean(com.stonehash.attest.core.attest.AttestService.class).get(ORG, (String) answer.get("attestation_id"));
        assertNotNull(record, "the commitment is an anchor record of the bank's own organisation");
        Map<String, Object> stored = sql.queryForMap("SELECT leaf_bytes, product, content_type, descriptor, status FROM attestations WHERE id = ?", answer.get("attestation_id"));
        assertEquals(answer.get("commitment"), stored.get("leaf_bytes"));
        assertEquals("remit", stored.get("product"));
        assertEquals("application/json", stored.get("content_type"));
        assertEquals("{\"kind\":\"remit-manifest\",\"date\":\"" + day + "\"}", stored.get("descriptor"));
        Map<String, Object> listed = map(((List<?>) manifests.list(ORG, day).get("data")).get(0));
        assertEquals("[date, manifest, verdict, commitment, attestation, created_at]", listed.keySet().toString());
        assertEquals(answer.get("commitment"), listed.get("commitment"));
        assertEquals(Js.stringify(Rail.map("id", answer.get("attestation_id"), "status", "accepted")), Js.stringify(listed.get("attestation")));

        // What the reference's code is asked to check (tools/check-remit-b1-made.mjs): the commitment, and every platform signature made on the way.
        List<Object> events = new ArrayList<>();
        for (Map<String, Object> e : store.events("PAY-B1IT-MAN-1")) {
            if (e.get("sig") != null) {
                events.add(Rail.map("type", e.get("type"), "payload", e.get("payload"), "sig", Js.parse((String) e.get("sig"))));
            }
        }
        Map<String, Object> made = Rail.map("platform", Rail.map("spki", platform.spki(), "key_id", platform.keyId()), "events", events,
                "webhook", mapper.webhooksOfPayment("PAY-B1IT-MAN-1").get(0).get("body"),
                "manifest", Rail.map("manifest", sent.get("manifest"), "verdict", verdict, "platform_signature", answer.get("platform_signature"), "commitment", answer.get("commitment")));
        java.nio.file.Files.createDirectories(java.nio.file.Path.of("target"));
        java.nio.file.Files.writeString(java.nio.file.Path.of("target", "remit-b1-made-store.json"), Js.stringify(made, 1) + "\n");

        // Sent again with one left out, one nobody knows and one that is no text: discrepant both ways, and the day's row is replaced.
        List<Object> other = new ArrayList<>(ofDay.subList(1, ofDay.size()));
        other.add("PAY-B1IT-NOBODY");
        other.add(7);
        Map<String, Object> second = Rail.map("date", day, "institution_id", KEY_ID, "payment_ids", other, "count", other.size());
        Map<String, Object> again = map(manifests.submit(ORG, bank,
                map(Js.parse(Js.stringify(Rail.map("manifest", second, "sig", Conventions.signEvent(Canonical.forSdk(second), bankSigner, KEY_ID, ISSUER)))))).body);
        assertEquals("DISCREPANT", map(again.get("verdict")).get("status"));
        assertEquals("[\"" + ofDay.get(0) + "\"]", Js.stringify(map(again.get("verdict")).get("missing_in_manifest")));
        assertEquals("[\"PAY-B1IT-NOBODY\",7]", Js.stringify(map(again.get("verdict")).get("unknown_to_platform")));
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_manifests WHERE org_id = ? AND date = ?", ORG, day), "one row a day");
        assertEquals(again.get("commitment"), map(((List<?>) manifests.list(ORG, day).get("data")).get(0)).get("commitment"), "the newer one");
        assertEquals(2, Rail.count(sql, "SELECT COUNT(*) FROM attestations WHERE org_id = ? AND product = 'remit'", ORG), "each commitment its own anchor record");

        // The same commitment twice: the record that holds it is used again, and the transaction around it still commits.
        TransactionTemplate tx = server.bean(TransactionTemplate.class);
        String reused = tx.execute((s) -> manifests.issue(ORG, (String) again.get("commitment"), Rail.map("kind", "remit-manifest", "date", day)));
        assertEquals(again.get("attestation_id"), reused);
        String fresh = "5e".repeat(32);
        List<String> both = tx.execute((s) -> List.of(manifests.issue(ORG, fresh, Rail.map("kind", "remit-manifest", "date", day)),
                manifests.issue(ORG, fresh, Rail.map("kind", "remit-manifest", "date", day))));
        assertEquals(both.get(0), both.get(1));
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM attestations WHERE org_id = ? AND leaf_bytes = ?", ORG, fresh));

        // The refusals, in their order.
        assertEquals("400 invalid_manifest", brief(outcome(() -> manifests.submit(ORG, bank, Rail.map()))));
        assertEquals("400 invalid_manifest", brief(outcome(() -> manifests.submit(ORG, bank, Rail.map("manifest", Rail.map("date", day, "payment_ids", List.of("a"), "count", 2d))))));
        assertEquals("400 invalid_signature", brief(outcome(() -> manifests.submit(ORG, bank, Rail.map("manifest", Js.parse(Js.stringify(second)))))));
        assertEquals("400 invalid_signature", brief(outcome(() -> manifests.submit(ORG, bank, Rail.map("manifest", Js.parse(Js.stringify(second)), "sig", sent.get("sig"))))));
    }

    // ── intake paused ────────────────────────────────────────────────────────

    @Test
    void takesNothingNewWhilePausedAndStillAnswersWhatItAnsweredBefore() {
        Map<String, Object> before = instruction("PAY-B1IT-PAUSE-1", null);
        Map<String, Object> answer = accept("b1it-pause-key-1", before);
        assertEquals("202", brief(answer));

        Map<String, String> env = new LinkedHashMap<>();
        env.put("STONEHASH_DATA_DIR", "/srv/stonehash/data");
        env.put("REMIT_INTAKE_PAUSED", "1");
        CoreConfig pausedCfg = CoreConfig.load(EnvSource.of(env));
        assertTrue(pausedCfg.remit.intakePaused);
        Acceptance paused = new Acceptance(pausedCfg, store, jobs, registry, platform, server.bean(WebhookOutbox.class), server.bean(RemitExecutor.class),
                server.bean(TransactionTemplate.class));

        // A bank that did not get its 202 sends again: it gets it.
        assertEquals(Js.stringify(answer), Js.stringify(outcome(() -> paused.accept(ORG, bank, "b1it-pause-key-1", before))));
        // The key with another body is still a conflict.
        assertEquals("409 idempotency_conflict", brief(outcome(() -> paused.accept(ORG, bank, "b1it-pause-key-1", instruction("PAY-B1IT-PAUSE-2", null)))));
        // Anything new — acceptable or not — is not looked at.
        Map<String, Object> refused = outcome(() -> paused.accept(ORG, bank, "b1it-pause-key-2", instruction("PAY-B1IT-PAUSE-2", null)));
        assertEquals("503 intake_paused", brief(refused));
        assertEquals("503 intake_paused", brief(outcome(() -> paused.accept(ORG, bank, "b1it-pause-key-3", Rail.map("payment_id", 7)))));
        assertEquals("503 intake_paused", brief(outcome(() -> paused.accept(ORG, bank, "b1it-pause-key-4", before))), "also the accepted body under a new key");
        assertEquals(1, settlements());
        assertNotNull(map(refused.get("body")).get("message"));
        // Not paused, the same request is accepted.
        assertEquals("202", brief(accept("b1it-pause-key-2", instruction("PAY-B1IT-PAUSE-2", null))));
    }
}
