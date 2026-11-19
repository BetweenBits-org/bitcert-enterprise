package com.stonehash.attest.core.remit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.StartMode;
import com.stonehash.attest.core.Vectors;
import com.stonehash.attest.core.WiredService;
import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.config.EnvSource;
import com.stonehash.attest.core.console.ProductRegistry;
import com.stonehash.attest.core.json.Js;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The settlement rail's store on a real schema: the rules that only the
 * database can keep.
 *
 * <ul>
 * <li><b>one message, one settlement</b> — the sequences of
 *     {@code vectors/remit-b1-store.json}, which the reference's own store
 *     answered on MySQL ({@code tools/make-remit-b1-store-vectors.mjs}), go
 *     through the transaction that accepts a settlement here, step by step;
 *     every step must come to what it came to there, and the two tables must
 *     hold the same rows afterwards — the recognitions written by refused
 *     steps included. Then the reference's MySQL test, eight connections at
 *     once ({@code apps/core/test/mysql-parity.test.ts}, last sub-test);
 * <li><b>the ledger</b> — the searches the reference's store answered on
 *     MySQL, on the same rows: what {@code q} finds inside event payloads is
 *     MySQL's own answer, so it is recorded, not reasoned about;
 * <li><b>the conditional transition and the order of events</b>;
 * <li><b>the job rows</b>: one open job per settlement and lane, a claim that
 *     only one claimer gets, and the fence around what a holder writes;
 * <li><b>the platform's own institution row</b> at start.
 * </ul>
 *
 * <p>Run by name on the Java test schema:
 * {@code ./mvnw -o test -Dtest='Remit*IT' -Dstonehash.env=.env.dev}.
 */
class RemitStoreIT {
    private static final Map<String, Object> V = Vectors.load("remit-b1-store.json");
    private static final Map<String, Object> BANK = Rail.map("id", "VN-BANK-B1IT");
    private static final String FAR = "2099-01-01T00:00:00.000Z";

    private static WiredService server;
    private static JdbcTemplate sql;
    private static RemitStore store;
    private static RemitJobs jobs;
    private static RemitMapper mapper;
    private static Acceptance acceptance;
    private static WebhookOutbox outbox;
    private static ProductRegistry registry;
    private static PlatformKey platform;
    private static TransactionTemplate tx;

    @BeforeAll
    static void start() throws Exception {
        server = WiredService.start();
        sql = new JdbcTemplate(server.bean(DataSource.class));
        store = server.bean(RemitStore.class);
        jobs = server.bean(RemitJobs.class);
        mapper = server.bean(RemitMapper.class);
        acceptance = server.bean(Acceptance.class);
        outbox = server.bean(WebhookOutbox.class);
        registry = server.bean(ProductRegistry.class);
        platform = server.bean(PlatformKey.class);
        tx = server.bean(TransactionTemplate.class);
        Rail.clean(sql);
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            Rail.clean(sql);
            server.close();
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        return (List<Map<String, Object>>) o;
    }

    private static String newOrg(String name) {
        String id = "b1it-" + name;
        Rail.org(sql, id);
        store.saveQuote(id, "QT-B1IT-" + name, "VN", "SG", Rail.map(), Rail.map(), FAR);
        return id;
    }

    /** Hand the accepting transaction an instruction made from a message; what it came to, as one line. */
    private static String send(String org, String quoteId, String id, Object sourceMessage, String key) {
        Rail.nextMillisecond();
        return Rail.outcome(() -> acceptance.create(org, BANK, key, Rail.sha("request " + key), Rail.checked(org, quoteId, id, SourceRef.of(sourceMessage))));
    }

    // ── one message, one settlement ──────────────────────────────────────────

    @Test
    void keepsOneSettlementPerMessageAsTheReferencesStoreDoes() {
        List<String> failures = new ArrayList<>();
        int steps = 0;
        int accepted = 0;
        int conflicts = 0;
        int taken = 0;
        int recognitions = 0;
        for (Map<String, Object> seq : list(V.get("sequences"))) {
            String org = (String) seq.get("org");
            String quoteId = "QT-" + seq.get("prefix");
            Rail.org(sql, org);
            store.saveQuote(org, quoteId, "VN", "SG", Rail.map(), Rail.map(), FAR);
            int n = 0;
            for (Map<String, Object> step : list(seq.get("steps"))) {
                steps++;
                String id = (String) step.get("id");
                String expected;
                if (Boolean.TRUE.equals(step.get("accepted"))) {
                    accepted++;
                    expected = "status 202";
                } else if (Boolean.TRUE.equals(step.get("idTaken"))) {
                    taken++;
                    expected = "409 duplicate_payment";
                } else {
                    conflicts++;
                    Map<String, Object> c = map(step.get("conflict"));
                    boolean reused = Boolean.TRUE.equals(c.get("reused"));
                    boolean undated = Boolean.TRUE.equals(c.get("undated"));
                    expected = "409 " + (reused ? "reference_reused" : "duplicate_source_message") + " "
                            + Js.stringify(Rail.map("existing_payment_id", c.get("paymentId"), "ground", undated ? "twin_undated" : c.get("ground")));
                }
                String got = send(org, quoteId, id, Js.parse((String) step.get("sourceJson")), org + "-step-" + n++);
                if (!got.equals(expected)) {
                    failures.add(seq.get("name") + ", step " + n + " (" + id + "): " + got + "\n      the reference: " + expected + "\n      message: " + step.get("sourceJson"));
                }
            }
            String refs = Js.stringify(sql.queryForList(
                    "SELECT payment_id, message_type, sha256, idx, uetr, value_date, content, twin_key FROM remit_source_refs WHERE org_id = ? ORDER BY payment_id", org));
            if (!refs.equals(Js.stringify(seq.get("refs")))) {
                failures.add(seq.get("name") + ": the reference rows\n      " + refs + "\n    the reference's\n      " + Js.stringify(seq.get("refs")));
            }
            List<Map<String, Object>> matches = sql.queryForList("SELECT sha256, idx, payment_id FROM remit_source_matches WHERE org_id = ? ORDER BY sha256, idx", org);
            recognitions += matches.size();
            if (!Js.stringify(matches).equals(Js.stringify(seq.get("matches")))) {
                failures.add(seq.get("name") + ": the recognitions\n      " + Js.stringify(matches) + "\n    the reference's\n      " + Js.stringify(seq.get("matches")));
            }
            // A reference row exists exactly when its settlement does, and a settlement is whole: three events, one open job, one answer under its key.
            long made = Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE org_id = ?", org);
            if (made != Rail.count(sql, "SELECT COUNT(*) FROM remit_source_refs WHERE org_id = ?", org)
                    || made * 3 != Rail.count(sql, "SELECT COUNT(*) FROM remit_events WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id = ?)", org)
                    || made != Rail.count(sql, "SELECT COUNT(*) FROM remit_jobs WHERE org_id = ? AND kind = 'TRAVEL_RULE' AND state = 'running' AND open_slot = 1", org)
                    || made != Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ? AND response_status = 202", org)
                    || made != Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE org_id = ? AND state = 'BANK_AUTHORIZED'", org)) {
                failures.add(seq.get("name") + ": " + made + " settlements, and not as many reference rows, triples of events, first jobs or stored answers");
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " differences from the reference's store in " + steps + " steps:\n  " + String.join("\n  ", failures));
        assertTrue(steps >= 1000 && accepted >= 400 && conflicts >= 500 && taken >= 40 && recognitions >= 90,
                "the vectors were read: " + steps + " steps, " + accepted + " accepted, " + conflicts + " conflicts, " + taken + " ids taken, " + recognitions + " recognitions");
        System.out.println("one message, one settlement: " + steps + " steps of " + list(V.get("sequences")).size() + " sequences as the reference's store on MySQL — " + accepted
                + " accepted, " + conflicts + " conflicts, " + taken + " ids taken, " + recognitions + " recognitions");
    }

    private static Map<String, Object> message(Object... over) {
        Map<String, Object> m = Rail.map("type", "MT103", "sha256", Rail.sha("base"), "uetr", "b4d9e7a1-5c36-4f82-a1d0-6e9f3c2b8a57", "messageId", "A1", "instructionId", "A1",
                "valueDate", "2026-11-17", "content", "cd".repeat(32));
        for (int i = 0; i < over.length; i += 2) {
            if (over[i + 1] == null) {
                m.remove((String) over[i]);
            } else {
                m.put((String) over[i], over[i + 1]);
            }
        }
        return m;
    }

    private static long accepted(List<String> outcomes) {
        return outcomes.stream().filter((o) -> o.equals("status 202")).count();
    }

    /** {@code apps/core/test/mysql-parity.test.ts}, "one message is one settlement — also when the requests arrive together": the part with eight connections. */
    @Test
    void makesOneSettlementOfEightRequestsForOneMessageArrivingTogether() throws Exception {
        String org = newOrg("race");
        String quote = "QT-B1IT-race";

        // Eight requests for one message on eight connections: one settlement.
        List<String> sameUetr = Rail.together(8, (i) -> send(org, quote, "B1IT-RACE-U" + i,
                message("sha256", Rail.sha("race"), "uetr", "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", "instructionId", "D4"), "race-u-" + i));
        assertEquals(1, accepted(sameUetr), "same UETR: " + sameUetr);
        assertEquals(7, sameUetr.stream().filter((o) -> o.startsWith("409 duplicate_source_message ") && o.endsWith("\"ground\":\"message\"}")).count(), sameUetr.toString());

        // The renderings only the twin rule recognises: one with its UETR, seven with the header blocks cut away.
        List<String> twins = Rail.together(8, (i) -> send(org, quote, "B1IT-RACE-T" + i,
                message("sha256", Rail.sha("twin " + i), "uetr", i == 0 ? "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" : null, "instructionId", "E5"), "race-t-" + i));
        assertEquals(1, accepted(twins), "twins: " + twins);
        assertEquals(7, twins.stream().filter((o) -> o.startsWith("409 duplicate_source_message ") && o.endsWith("\"ground\":\"twin\"}")).count(), twins.toString());

        // Eight renderings of a payment known only by its message id.
        List<String> byMessage = Rail.together(8, (i) -> send(org, quote, "B1IT-RACE-M" + i,
                message("type", "pain.001.001.09", "uetr", null, "instructionId", null, "endToEndId", "NOTPROVIDED", "messageId", "FILE-9", "content", "cc".repeat(32),
                        "sha256", Rail.sha("file 9, " + i)),
                "race-m-" + i));
        assertEquals(1, accepted(byMessage), "known by its message id: " + byMessage);

        // Eight requests under one payment id, each made from another message: one settlement, seven "exists" — none fails.
        List<String> oneId = Rail.together(8, (i) -> send(org, quote, "B1IT-RACE-ID",
                message("sha256", Rail.sha("one id " + i), "uetr", null, "instructionId", "I" + i), "race-id-" + i));
        assertEquals(1, accepted(oneId), oneId.toString());
        assertEquals(7, oneId.stream().filter((o) -> o.equals("409 duplicate_payment")).count(), oneId.toString());

        assertEquals(4, Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE org_id = ?", org), "one settlement per message, and none half-made");
        assertEquals(4, Rail.count(sql, "SELECT COUNT(*) FROM remit_source_refs WHERE org_id = ?", org), "a reference exists exactly when its settlement does");
        assertEquals(12, Rail.count(sql, "SELECT COUNT(*) FROM remit_events WHERE payment_id LIKE 'B1IT-RACE-%'"), "each with the three events it was accepted on");
        assertEquals(4, Rail.count(sql, "SELECT COUNT(*) FROM remit_jobs WHERE org_id = ?", org), "and its first job");
        assertEquals(4, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", org), "and one stored answer: a refusal is not remembered");

        // Different messages at the same moment do not stand in each other's way.
        List<String> apart = Rail.together(8, (i) -> send(org, quote, "B1IT-APART-" + i,
                message("sha256", Rail.sha("apart " + i), "uetr", null, "instructionId", "F" + i), "apart-" + i));
        assertEquals(8, accepted(apart), apart.toString());

        // The exact lookups find what was accepted.
        RemitStore.Search byUetr = new RemitStore.Search();
        byUetr.sourceUetr = "9D8C7B6A-5F4E-4D3C-8B2A-1F0E9D8C7B6A";
        assertEquals(1, store.search(org, byUetr).items.size());
    }

    /**
     * A file with two transactions that read alike is two payments — also when the two requests arrive together; and
     * written out again as another file, each of its transactions is recognised as one of the two settlements, not
     * both as the older one — also when those two arrive together.
     */
    @Test
    void matchesTheTransactionsOfAFileWrittenOutAgainOneToOne() throws Exception {
        String org = newOrg("pair");
        String quote = "QT-B1IT-pair";
        for (int round = 0; round < 6; round++) {
            int r = round;
            Map<String, Object> instalment = message("type", "pain.001.001.09", "uetr", null, "instructionId", null, "messageId", "BATCH-" + r, "endToEndId", "RENT-" + r,
                    "content", "aa".repeat(32));
            List<String> both = Rail.together(2, (i) -> {
                Map<String, Object> m = new LinkedHashMap<>(instalment);
                m.put("sha256", Rail.sha("pair " + r));
                m.put("index", (double) i);
                return send(org, quote, "B1IT-PAIR-" + r + "-" + i, m, "pair-" + r + "-" + i);
            });
            assertEquals(2, accepted(both), "two transactions of one file are two payments: " + both);

            List<String> again = Rail.together(2, (i) -> {
                Map<String, Object> m = new LinkedHashMap<>(instalment);
                m.put("messageId", "BATCH-" + r + "R");
                m.put("sha256", Rail.sha("pair " + r + ", written out again"));
                m.put("index", (double) i);
                return send(org, quote, "B1IT-PAIR-" + r + "-X" + i, m, "pair-again-" + r + "-" + i);
            });
            assertEquals(0, accepted(again), again.toString());
            assertEquals(new TreeSet<>(List.of(
                    "409 duplicate_source_message {\"existing_payment_id\":\"B1IT-PAIR-" + r + "-0\",\"ground\":\"twin\"}",
                    "409 duplicate_source_message {\"existing_payment_id\":\"B1IT-PAIR-" + r + "-1\",\"ground\":\"twin\"}")), new TreeSet<>(again),
                    "each transaction of the second file is one of the two settlements");
            assertEquals(2, Rail.count(sql, "SELECT COUNT(DISTINCT payment_id) FROM remit_source_matches WHERE org_id = ? AND sha256 = ?", org,
                    Rail.sha("pair " + r + ", written out again")), "and both recognitions are on record although both requests were refused");
        }
        assertEquals(12, Rail.count(sql, "SELECT COUNT(*) FROM remit_payments WHERE org_id = ?", org));
    }

    // ── a settlement is accepted whole, or not at all ────────────────────────

    @Test
    void leavesNothingOfASettlementThatCouldNotBeAcceptedWhole() {
        String org = newOrg("whole");
        String quote = "QT-B1IT-whole";
        Map<String, Object> source = message("sha256", Rail.sha("half"), "uetr", null, "instructionId", "W2");

        // An event that cannot be signed: the settlement's row and its reference were written before it in the same transaction.
        Acceptance.Checked fraction = Rail.checked(org, quote, "B1IT-HALF", SourceRef.of(source));
        fraction.accepted.put("request_id", 1.5);
        String first = Rail.outcome(() -> acceptance.create(org, BANK, "whole-half-1", Rail.sha("a"), fraction));
        assertEquals("plain jcs: only integers are supported in this schema, got 1.5", first);
        nothingOf(org, "B1IT-HALF");

        // The last statement of all fails — the answer under the key does not fit its column: everything before it goes with it.
        String longKey = "k".repeat(200);
        assertThrows(DataAccessException.class, () -> acceptance.create(org, BANK, longKey, Rail.sha("b"), Rail.checked(org, quote, "B1IT-HALF", SourceRef.of(source))));
        nothingOf(org, "B1IT-HALF");

        // Its message is free, and so is its id.
        assertEquals("status 202", send(org, quote, "B1IT-HALF", source, "whole-half-3"));
        assertEquals(3, store.events("B1IT-HALF").size());
        assertEquals("BANK_AUTHORIZED", store.get("B1IT-HALF").get("state"));
    }

    private static void nothingOf(String org, String id) {
        assertNull(store.get(id), "no settlement");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_events WHERE payment_id = ?", id), "no event");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_source_refs WHERE org_id = ?", org), "no reference");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_jobs WHERE org_id = ?", org), "no job");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_idempotency WHERE org_id = ?", org), "no stored answer");
        assertEquals(0, Rail.count(sql, "SELECT COUNT(*) FROM remit_webhook_deliveries WHERE org_id = ?", org), "no notice");
    }

    // ── the ledger ───────────────────────────────────────────────────────────

    @Test
    void searchesTheLedgerAsTheReferencesStoreDoesOnMySql() {
        Map<String, Object> ledger = map(V.get("ledger"));
        String org = (String) ledger.get("org");
        Map<String, Object> rows = map(ledger.get("rows"));
        Rail.org(sql, org);
        Map<String, String> createdAt = new LinkedHashMap<>();
        for (Map<String, Object> p : list(rows.get("payments"))) {
            String quote = (String) p.get("quote_id");
            if (Rail.count(sql, "SELECT COUNT(*) FROM remit_quotes WHERE id = ?", quote) == 0) {
                store.saveQuote(org, quote, "VN", "SG", Rail.map(), Rail.map(), FAR);
            }
            String at = (String) p.get("created_at");
            createdAt.put((String) p.get("id"), at);
            sql.update("INSERT INTO remit_payments (id, org_id, quote_id, state, corridor_origin, corridor_destination, trade_currency, trade_amount, collect_currency, "
                    + "collect_amount, usdc_amount, payout_currency, payout_amount, beneficiary_institution, chain_tx, request_body, created_at, updated_at) "
                    + "VALUES (?,?,?,?,'VN','SG','USD','10.00','VND','1','10.00','SGD','13.35','SG-BFI-001',?,'{}',?,?)",
                    p.get("id"), org, quote, p.get("state"), p.get("chain_tx"), at, at);
        }
        for (Map<String, Object> e : list(rows.get("events"))) {
            sql.update("INSERT INTO remit_events (id, payment_id, seq, type, issuer, payload, sig, created_at) VALUES (?,?,?,?,?,?,NULL,?)",
                    java.util.UUID.randomUUID().toString(), e.get("payment_id"), ((Double) e.get("seq")).intValue(), e.get("type"), e.get("issuer"), e.get("payload"),
                    createdAt.get(e.get("payment_id")));
        }
        for (Map<String, Object> r : list(rows.get("refs"))) {
            sql.update("INSERT INTO remit_source_refs (payment_id, org_id, message_type, sha256, idx, uetr, value_date, content, twin_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    r.get("payment_id"), org, r.get("message_type"), r.get("sha256"), ((Double) r.get("idx")).longValue(), r.get("uetr"), r.get("value_date"), r.get("content"),
                    r.get("twin_key"), r.get("created_at"));
        }

        List<String> failures = new ArrayList<>();
        int ran = 0;
        int found = 0;
        int refused = 0;
        int pages = 0;
        for (Map<String, Object> c : list(ledger.get("searches"))) {
            ran++;
            Map<String, Object> p = map(c.get("params"));
            RemitStore.Search s = new RemitStore.Search();
            s.q = (String) p.get("q");
            s.state = (String) p.get("state");
            s.from = (String) p.get("from");
            s.to = (String) p.get("to");
            s.cursor = (String) p.get("cursor");
            s.sourceUetr = (String) p.get("sourceUetr");
            s.sourceContent = (String) p.get("sourceContent");
            s.sourceValueDate = (String) p.get("sourceValueDate");
            if (p.get("limit") != null) {
                s.limit = ((Double) p.get("limit")).longValue();
            }
            String got;
            try {
                RemitStore.Page page = store.search(org, s);
                List<Object> ids = new ArrayList<>();
                for (Map<String, Object> item : page.items) {
                    ids.add(item.get("id"));
                }
                found += ids.isEmpty() ? 0 : 1;
                pages += page.nextCursor == null ? 0 : 1;
                got = Js.stringify(Rail.map("ids", ids, "total", page.total, "nextCursor", page.nextCursor));
            } catch (ServiceError e) {
                refused++;
                got = Js.stringify(Rail.map("status", e.status(), "error", e.code(), "message", e.getMessage()));
            }
            String expected;
            if (c.get("refused") != null) {
                Map<String, Object> r = map(c.get("refused"));
                expected = Js.stringify(Rail.map("status", r.get("status"), "error", r.get("error"), "message", r.get("message")));
            } else {
                expected = Js.stringify(c.get("answer"));
            }
            if (!got.equals(expected)) {
                failures.add(Js.stringify(p) + ":\n      got      " + got + "\n      expected " + expected);
            }
        }
        assertTrue(failures.isEmpty(), failures.size() + " of " + ran + " searches differ from the reference's store:\n  " + String.join("\n  ", failures));
        assertTrue(ran >= 115 && found >= 70 && refused == 5 && pages >= 10, "the vectors were read: " + ran + " searches, " + found + " found something, " + refused + " refused, "
                + pages + " with a next page");

        // Commas with nothing between them name no state: the reference fails on its own statement there; here it is a failure the request never reaches the store with.
        RemitStore.Search none = new RemitStore.Search();
        none.state = " , ";
        assertThrows(IllegalStateException.class, () -> store.search(org, none));
        System.out.println("the ledger: " + ran + " searches as the reference's store on MySQL — " + found + " found something, " + refused + " refused, " + pages + " continued by a cursor");
    }

    // ── the conditional transition, and the order of events ──────────────────

    @Test
    void movesAStateOnlyFromTheStateItWasExpectedIn() throws Exception {
        String org = newOrg("move");
        tx.executeWithoutResult((s) -> store.insertPayment(Rail.payment(org, "QT-B1IT-move", "B1IT-MOVE-1")));
        assertEquals("REQUEST_ACCEPTED", store.get("B1IT-MOVE-1").get("state"));
        assertFalse(store.moveState("B1IT-MOVE-1", "BANK_AUTHORIZED", "TRAVEL_RULE_PENDING"), "not from a state it is not in");
        assertEquals("REQUEST_ACCEPTED", store.get("B1IT-MOVE-1").get("state"));
        assertTrue(store.moveState("B1IT-MOVE-1", "REQUEST_ACCEPTED", "BANK_AUTHORIZED"));
        assertFalse(store.moveState("B1IT-MOVE-1", "REQUEST_ACCEPTED", "BANK_AUTHORIZED"), "the second of two identical transitions finds the state gone");
        assertFalse(store.moveState("B1IT-NO-SUCH", "REQUEST_ACCEPTED", "BANK_AUTHORIZED"));

        // A cancellation and seven approvals at once, each a transaction that locks the settlement first: one of the eight moves it.
        for (int round = 0; round < 5; round++) {
            String id = "B1IT-MOVE-R" + round;
            tx.executeWithoutResult((s) -> {
                store.insertPayment(Rail.payment(org, "QT-B1IT-move", id));
                store.moveState(id, "REQUEST_ACCEPTED", "TRAVEL_RULE_PENDING");
            });
            List<Boolean> moved = Rail.together(8, (i) -> tx.execute((s) -> {
                Map<String, Object> row = store.lock(id);
                if (!"TRAVEL_RULE_PENDING".equals(row.get("state"))) {
                    return false;
                }
                String to = i == 0 ? "CANCELLED" : "PAYOUT_PRE_APPROVED";
                store.appendEvent(id, to, "B1IT", Rail.map("by", i), null);
                return store.moveState(id, "TRAVEL_RULE_PENDING", to);
            }));
            assertEquals(1, moved.stream().filter((m) -> m).count(), "one transition of eight: " + moved);
            List<Map<String, Object>> events = store.events(id);
            assertEquals(1, events.size(), "and only its event");
            assertEquals(events.get(0).get("type"), store.get(id).get("state"), "the state is the one its event names");
        }

        // The same without the lock: the statement alone lets one through.
        String bare = "B1IT-MOVE-BARE";
        tx.executeWithoutResult((s) -> store.insertPayment(Rail.payment(org, "QT-B1IT-move", bare)));
        List<Boolean> moved = Rail.together(8, (i) -> store.moveState(bare, "REQUEST_ACCEPTED", i % 2 == 0 ? "BANK_AUTHORIZED" : "CANCELLED"));
        assertEquals(1, moved.stream().filter((m) -> m).count(), moved.toString());

        // updated_at moves with every write to the row.
        String before = (String) store.get(bare).get("updated_at");
        Rail.nextMillisecond();
        store.setChainTx(bare, "0xabc");
        assertNotEquals(before, store.get(bare).get("updated_at"));
        assertEquals("0xabc", store.get(bare).get("chain_tx"));
        assertTrue(store.setPackage(bare, "{}", "00", "11", null), "a settlement without an evidence record takes a package");

        // The other columns a transition writes, each with updated_at.
        store.setDepositAddress(bare, "0x00000000000000000000000000000000000000aa");
        store.setEvidenceLevel(bare, "L3");
        store.setVerdict(bare, "{\"status\":\"PASS\"}");
        store.setRequestBody(bare, "{\"payment_id\":\"B1IT-MOVE-BARE\"}");
        Map<String, Object> row = store.get(bare);
        assertEquals("0x00000000000000000000000000000000000000aa", row.get("deposit_address"));
        assertEquals("L3", row.get("evidence_level"));
        assertEquals("{\"status\":\"PASS\"}", row.get("verdict"));
        assertEquals("{\"payment_id\":\"B1IT-MOVE-BARE\"}", row.get("request_body"));
        assertEquals("{}", row.get("package_json"));
        // A settlement that has its evidence record keeps it: the package of a second assembly is not taken.
        String anchor = (String) server.bean(com.stonehash.attest.core.attest.AttestService.class)
                .issue(org, Rail.sha("an evidence commitment").substring(0, 64), new com.stonehash.attest.core.attest.AttestService.Issue()).get("id");
        String withRecord = "B1IT-MOVE-RECORD";
        tx.executeWithoutResult((s) -> {
            store.insertPayment(Rail.payment(org, "QT-B1IT-move", withRecord));
            store.moveState(withRecord, "REQUEST_ACCEPTED", "BENEFICIARY_CREDIT_CONFIRMED");
        });
        assertTrue(store.setPackage(withRecord, "{\"n\":1}", "aa", "bb", anchor));
        assertFalse(store.setPackage(withRecord, "{\"n\":2}", "cc", "dd", anchor), "a second package is not taken");
        assertEquals("{\"n\":1}", store.get(withRecord).get("package_json"));
        // Waiting for its anchor: listed only once the record has confirmed on the chain.
        assertFalse(store.anchoredPending().stream().anyMatch((p) -> p.get("id").equals(withRecord)), "its record is not confirmed yet");
        sql.update("UPDATE attestations SET status = 'confirmed' WHERE id = ?", anchor);
        assertTrue(store.anchoredPending().stream().anyMatch((p) -> p.get("id").equals(withRecord) && p.get("attestation_id").equals(anchor)));
    }

    @Test
    void numbersTheEventsOfASettlementInTheOrderTheyWereAppended() throws Exception {
        String org = newOrg("seq");
        String id = "B1IT-SEQ-1";
        tx.executeWithoutResult((s) -> {
            store.insertPayment(Rail.payment(org, "QT-B1IT-seq", id));
            assertEquals(0, store.appendEvent(id, "REQUEST_ACCEPTED", "STONEHASH", Rail.map("n", 0), Rail.map("alg", "ES256")), "a settlement's first event is number 0");
        });
        // Twenty-four appends on eight connections, each under the settlement's lock: the numbers 1 to 24, none twice, none missing, none failed.
        List<Integer> numbers = new ArrayList<>();
        for (int round = 0; round < 3; round++) {
            numbers.addAll(Rail.together(8, (i) -> tx.execute((s) -> {
                store.lock(id);
                return store.appendEvent(id, "NOTE", "B1IT", Rail.map("by", i), null);
            })));
        }
        assertEquals(24, new TreeSet<>(numbers).size(), numbers.toString());
        assertEquals(1, Collections.min(numbers));
        assertEquals(24, Collections.max(numbers));
        List<Map<String, Object>> events = store.events(id);
        assertEquals(25, events.size());
        for (int i = 0; i < events.size(); i++) {
            assertEquals(i, ((Number) events.get(i).get("seq")).intValue(), "read back in their order");
        }
        assertEquals("{\"n\":0}", events.get(0).get("payload"), "the payload as JavaScript writes it");
        assertEquals("{\"alg\":\"ES256\"}", events.get(0).get("sig"));
        assertNull(events.get(1).get("sig"), "an event nobody signed has no envelope");
        assertEquals("REQUEST_ACCEPTED", store.eventOfType(id, "REQUEST_ACCEPTED").get("type"));
        assertEquals(24, store.eventsOfType(id, "NOTE").size());
        assertNull(store.eventOfType(id, "NO_SUCH"));
    }

    // ── the other tables ─────────────────────────────────────────────────────

    @Test
    void keepsQuotesAnswersTravelRuleRowsNoticesAndManifests() {
        String org = newOrg("rows");
        String other = newOrg("rows-other");
        String id = "B1IT-ROWS-1";
        tx.executeWithoutResult((s) -> store.insertPayment(Rail.payment(org, "QT-B1IT-rows", id)));

        // A quote is its organisation's.
        store.saveQuote(org, "QT-B1IT-rows-2", "VN", "SG", Rail.map("a", 1.5), Rail.map("quote_id", "QT-B1IT-rows-2", "n", 2), "2026-11-19T00:10:00.000Z");
        assertEquals("{\"quote_id\":\"QT-B1IT-rows-2\",\"n\":2}", store.quote(org, "QT-B1IT-rows-2").get("response"));
        assertEquals("2026-11-19T00:10:00.000Z", store.quote(org, "QT-B1IT-rows-2").get("expires_at"));
        assertNull(store.quote(other, "QT-B1IT-rows-2"), "another organisation's quote is no quote");
        assertNull(store.quote(org, "QT-NO-SUCH"));
        assertNotNull(store.getForOrg(org, id));
        assertNull(store.getForOrg(other, id), "nor is its settlement");
        assertTrue(store.exists(id));

        // An answer under a key, per organisation.
        assertNull(store.idempotencyHit(org, "rows-key-1"));
        store.idempotencyStore(org, "rows-key-1", "ab".repeat(32), 202, Rail.map("payment_id", id, "state", "BANK_AUTHORIZED"));
        Map<String, Object> hit = store.idempotencyHit(org, "rows-key-1");
        assertEquals("ab".repeat(32), hit.get("request_hash"));
        assertEquals(202, ((Number) hit.get("response_status")).intValue());
        assertEquals("{\"payment_id\":\"B1IT-ROWS-1\",\"state\":\"BANK_AUTHORIZED\"}", hit.get("response_body"));
        assertNull(store.idempotencyHit(other, "rows-key-1"), "the same key of another organisation is another key");
        assertThrows(DuplicateKeyException.class, () -> store.idempotencyStore(org, "rows-key-1", "cd".repeat(32), 202, Rail.map()), "a key holds one answer");

        // The travel-rule rows: the newest is the one read.
        assertNull(store.travelRule(id));
        store.saveTravelRule(id, "SG-BFI-001", "ciphertext-1", "d1".repeat(32), "SENT", Js.UNDEFINED);
        Rail.nextMillisecond();
        store.saveTravelRule(id, "SG-BFI-001", "ciphertext-2", "d2".repeat(32), "ACK", Rail.map("status", "ACK"));
        assertEquals("ACK", store.travelRule(id).get("status"));
        assertEquals("ciphertext-2", store.travelRule(id).get("ciphertext"));
        assertEquals(1, Rail.count(sql, "SELECT COUNT(*) FROM remit_travel_rule WHERE payment_id = ? AND response IS NULL AND protocol = 'IVMS101/JWE'", id));

        // A notice is queued for an organisation that named an address, signed by the platform, and written as it will be sent.
        outbox.enqueue(org, id, 2, "BANK_AUTHORIZED", "BANK_AUTHORIZED", Rail.map("quote_id", "QT-B1IT-rows"));
        assertEquals(0, mapper.webhooksOfPayment(id).size(), "no subscription, no address, no notice");
        registry.subscribe(org, "remit", Rail.map("webhook_url", "http://127.0.0.1:3301/hooks/b1it"));
        outbox.enqueue(org, id, 2, "BANK_AUTHORIZED", "BANK_AUTHORIZED", Rail.map("quote_id", "QT-B1IT-rows"));
        List<Map<String, Object>> notices = mapper.webhooksOfPayment(id);
        assertEquals(1, notices.size());
        Map<String, Object> notice = notices.get(0);
        assertEquals("http://127.0.0.1:3301/hooks/b1it", notice.get("url"));
        assertEquals("pending", notice.get("status"));
        assertEquals(0, ((Number) notice.get("attempts")).intValue());
        Map<String, Object> body = map(Js.parse((String) notice.get("body")));
        assertEquals("[envelope, signature]", body.keySet().toString());
        Map<String, Object> envelope = map(body.get("envelope"));
        assertEquals("[event_id, payment_id, sequence, type, state, occurred_at, data]", envelope.keySet().toString());
        assertEquals(notice.get("event_id"), envelope.get("event_id"));
        assertEquals(2d, envelope.get("sequence"));
        assertEquals("{\"quote_id\":\"QT-B1IT-rows\"}", Js.stringify(envelope.get("data")));
        assertEquals("[alg, key_id, issuer, sig]", map(body.get("signature")).keySet().toString());
        assertTrue(Signatures.verifyEvent(envelope, body.get("signature"), platform.spki()), "the platform's signature over the envelope");
        assertEquals(platform.keyId(), map(body.get("signature")).get("key_id"));
        // What part 2's delivery writes: each write only on the row as it was read.
        String noticeId = (String) notice.get("id");
        assertTrue(mapper.dueWebhooks(FAR, 1_000_000).stream().anyMatch((w) -> w.get("id").equals(noticeId)));
        assertEquals(1, mapper.webhookRescheduled(noticeId, 0, "HTTP 500", FAR));
        assertEquals(0, mapper.webhookRescheduled(noticeId, 0, "HTTP 500", FAR), "a second writer that read the same row writes nothing");
        assertFalse(mapper.dueWebhooks("2026-11-19T00:00:00.000Z", 1_000_000).stream().anyMatch((w) -> w.get("id").equals(noticeId)), "not due before its time");
        assertEquals(1, mapper.webhookDelivered(noticeId, 1));
        assertEquals(0, mapper.webhookExhausted(noticeId, 2, "late"), "a delivered notice is not written again");
        assertEquals("delivered", mapper.webhooksOfPayment(id).get(0).get("status"));
        assertEquals(2, ((Number) mapper.webhooksOfPayment(id).get(0).get("attempts")).intValue());

        // One manifest per organisation and day; sent again, it replaces the row.
        assertEquals(List.of(id), store.paymentIdsOfDay(org, ((String) store.get(id).get("created_at")).substring(0, 10)));
        assertEquals(List.of(), store.paymentIdsOfDay(org, "2020-01-01"));
        store.saveManifest(org, "2026-11-18", Rail.map("n", 1), Rail.map("sig", "a"), Rail.map("status", "MATCH"), Rail.map("sig", "p"), "c1", null);
        store.saveManifest(org, "2026-11-18", Rail.map("n", 2), Rail.map("sig", "b"), Rail.map("status", "MISMATCH"), Rail.map("sig", "q"), "c2", null);
        store.saveManifest(org, "2026-11-17", Rail.map("n", 0), Rail.map("sig", "z"), Rail.map("status", "MATCH"), Rail.map("sig", "y"), "c0", null);
        List<Map<String, Object>> day = store.manifests(org, "2026-11-18");
        assertEquals(1, day.size());
        assertEquals("{\"n\":2}", day.get(0).get("manifest"));
        assertEquals("c2", day.get(0).get("commitment"));
        List<Map<String, Object>> all = store.manifests(org, null);
        assertEquals("[2026-11-18, 2026-11-17]", all.stream().map((m) -> m.get("date")).toList().toString(), "newest day first");
        assertEquals(0, store.manifests(other, null).size());
    }

    // ── jobs ─────────────────────────────────────────────────────────────────

    private static int number(Map<String, Object> row, String column) {
        return ((Number) row.get(column)).intValue();
    }

    @Test
    void keepsOneOpenJobPerSettlementAndLaneAndFencesWhatItsHolderWrites() throws Exception {
        String org = newOrg("jobs");
        String pay = "B1IT-JOBS-1";

        // Inserted as its inserter's: running, under a claim of its own, with a lease — nobody else can take it.
        RemitJobs.Held first = jobs.insertClaimed(pay, org, RemitJobs.Kind.TRAVEL_RULE, pay + ":travel-rule", null);
        Map<String, Object> row = jobs.get(first.id);
        assertEquals("running", row.get("state"));
        assertEquals("pipeline", row.get("lane"));
        assertEquals("TRAVEL_RULE", row.get("kind"));
        assertEquals(1, number(row, "open_slot"));
        assertEquals(0, number(row, "attempts"), "nothing was started yet");
        assertEquals(first.owner, row.get("lease_owner"));
        assertEquals(0, number(row, "lease_expired"));
        assertEquals(pay + ":travel-rule", row.get("idempotency_key"));
        assertNull(row.get("input"));
        assertTrue(((String) row.get("created_at")).matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}"), "the database's clock, to the millisecond: " + row.get("created_at"));
        long drift = Math.abs(java.time.Instant.parse(((String) row.get("created_at")).replace(' ', 'T') + "Z").toEpochMilli() - System.currentTimeMillis());
        assertTrue(drift < 60_000, "written in UTC");
        assertNull(jobs.claim(first.id), "a running job under a live lease is not there to be claimed");
        assertFalse(jobs.claimable(1000).stream().anyMatch((j) -> j.get("id").equals(first.id)));

        // One open job per settlement and lane; the other lanes are free; a closed job does not count.
        assertThrows(DuplicateKeyException.class, () -> jobs.insertQueued(pay, org, RemitJobs.Kind.PAYOUT_APPROVAL, null, null));
        assertThrows(DuplicateKeyException.class, () -> jobs.insertClaimed(pay, org, RemitJobs.Kind.TRANSFER, null, null));
        String notice = jobs.insertQueued(pay, org, RemitJobs.Kind.SETTLEMENT_NOTICE, pay + ":settlement-notice", Rail.map("body", Rail.map("n", 1)));
        String evidence = jobs.insertQueued(pay, org, RemitJobs.Kind.RECONCILE, null, Rail.map("receipt_seq", 7));
        assertEquals("{\"body\":{\"n\":1}}", jobs.get(notice).get("input"));
        assertEquals("notice", jobs.get(notice).get("lane"));
        assertEquals("evidence", jobs.get(evidence).get("lane"));
        assertEquals(first.id, jobs.open(pay, "pipeline").get("id"));
        assertEquals(3, jobs.ofPayment(pay).size());
        assertTrue(first.id.compareTo(notice) < 0 && notice.compareTo(evidence) < 0, "ids sort in the order the jobs were made");

        // The holder's writes go through while the job is its own.
        assertTrue(jobs.start(first));
        assertEquals(1, number(jobs.get(first.id), "attempts"), "an attempt is counted when the work starts");
        assertTrue(jobs.renew(first));
        assertTrue(jobs.setInput(first, Rail.map("body", "as first made"), null));
        assertEquals(pay + ":travel-rule", jobs.get(first.id).get("idempotency_key"), "no key given: the key stays");
        assertTrue(jobs.markCallStarted(first));
        assertNotNull(jobs.get(first.id).get("call_started_at"));

        // The lease runs out, and someone else claims the job: a fresh claim, another token.
        sql.update("UPDATE remit_jobs SET lease_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?", first.id);
        assertEquals(1, number(jobs.get(first.id), "lease_expired"));
        assertTrue(jobs.claimable(1000).stream().anyMatch((j) -> j.get("id").equals(first.id)));
        RemitJobs.Held second = jobs.claim(first.id);
        assertNotNull(second);
        assertNotEquals(first.owner, second.owner, "a claim is named by a token of its own");
        assertEquals(1, number(jobs.get(first.id), "attempts"), "claiming is not starting");

        // The first holder is fenced out of everything it writes before it has a result.
        String before = Js.stringify(withoutClock(jobs.get(first.id)));
        assertFalse(jobs.start(first));
        assertFalse(jobs.renew(first));
        assertFalse(jobs.markCallStarted(first));
        assertFalse(jobs.setInput(first, Rail.map("body", "stale"), "stale-key"));
        assertFalse(jobs.waitFor(first, 1000, "stale"));
        assertFalse(jobs.requeue(first));
        assertFalse(jobs.close(first, RemitJobs.ATTENTION, "stale"));
        assertEquals(before, Js.stringify(withoutClock(jobs.get(first.id))), "and has changed nothing");

        // The second holder starts (a second attempt), fails, and waits.
        assertTrue(jobs.start(second));
        assertEquals(2, number(jobs.get(first.id), "attempts"));
        assertTrue(jobs.waitFor(second, 60_000, "the partner did not answer"));
        row = jobs.get(first.id);
        assertEquals("waiting", row.get("state"));
        assertNull(row.get("lease_owner"));
        assertEquals("the partner did not answer", row.get("last_error"));
        assertEquals(0, number(row, "due"));
        assertEquals(1, number(row, "open_slot"), "a waiting job is still open");
        assertNull(jobs.claim(first.id), "not before its time");
        assertFalse(jobs.start(second), "the claim was given up with the wait");
        sql.update("UPDATE remit_jobs SET next_attempt_at = UTC_TIMESTAMP(3) WHERE id = ?", first.id);
        RemitJobs.Held third = jobs.claim(first.id);
        assertNotNull(third, "due: claimed again");

        // A result is recorded whoever holds the job by then: closing as a result needs no claim.
        jobs.closeAnyway(first.id, RemitJobs.DONE, null);
        row = jobs.get(first.id);
        assertEquals("done", row.get("state"));
        assertNull(row.get("open_slot"));
        assertNull(row.get("lease_owner"));
        assertNull(row.get("last_error"));
        assertFalse(jobs.close(third, RemitJobs.DONE, null), "a closed job is nobody's");
        assertNull(jobs.claim(first.id), "and is not claimed again");
        assertNull(jobs.open(pay, "pipeline"));

        // The lane is free for the next job, in the same transaction that closed the one before it.
        String approval = tx.execute((s) -> jobs.insertQueued(pay, org, RemitJobs.Kind.PAYOUT_APPROVAL, pay + ":payout-approval", null));
        assertEquals(approval, jobs.open(pay, "pipeline").get("id"));

        // A queued job back in the queue unstarted; a job that needs a person; and back again.
        RemitJobs.Held held = jobs.claim(approval);
        assertTrue(jobs.requeue(held));
        assertEquals("queued", jobs.get(approval).get("state"));
        assertEquals(0, number(jobs.get(approval), "attempts"));
        held = jobs.claim(approval);
        assertTrue(jobs.start(held));
        assertTrue(jobs.close(held, RemitJobs.ATTENTION, "the step did not complete after 5 attempts"));
        assertEquals("attention", jobs.get(approval).get("state"));
        assertNull(jobs.get(approval).get("open_slot"));
        assertTrue(jobs.unfinished().stream().anyMatch((j) -> j.get("id").equals(approval)), "what waits for a person is listed");
        assertTrue(jobs.unfinished().stream().anyMatch((j) -> j.get("id").equals(notice)), "and what is open");
        assertFalse(jobs.unfinished().stream().anyMatch((j) -> j.get("id").equals(first.id)), "not what is done");
        assertTrue(jobs.reopen(approval));
        row = jobs.get(approval);
        assertEquals("queued", row.get("state"));
        assertEquals(0, number(row, "attempts"), "no attempt is counted against a job a person sent back");
        assertEquals(1, number(row, "open_slot"));
        assertNull(row.get("last_error"));
        assertFalse(jobs.reopen(approval), "only a job that waits for a person");
        // Not while the lane has another open job.
        String cancelled = "B1IT-JOBS-2";
        RemitJobs.Held a = jobs.insertClaimed(cancelled, org, RemitJobs.Kind.TRAVEL_RULE, null, null);
        assertTrue(jobs.close(a, RemitJobs.ATTENTION, "x"));
        jobs.insertQueued(cancelled, org, RemitJobs.Kind.TRAVEL_RULE, null, null);
        assertFalse(jobs.reopen(a.id), "the lane is taken");
        assertEquals("attention", jobs.get(a.id).get("state"));
    }

    private static Map<String, Object> withoutClock(Map<String, Object> job) {
        Map<String, Object> out = new LinkedHashMap<>(job);
        out.remove("due");
        out.remove("lease_expired");
        return out;
    }

    @Test
    void givesAJobToOneOfEightClaimers() throws Exception {
        String org = newOrg("claim");
        for (int round = 0; round < 10; round++) {
            String id = jobs.insertQueued("B1IT-CLAIM-" + round, org, RemitJobs.Kind.SETTLEMENT_NOTICE, null, null);
            List<RemitJobs.Held> claims = Rail.together(8, (i) -> jobs.claim(id));
            List<RemitJobs.Held> won = claims.stream().filter((c) -> c != null).toList();
            assertEquals(1, won.size(), "one claimer gets the job");
            assertEquals(won.get(0).owner, jobs.get(id).get("lease_owner"));
            // Eight starts under that one claim count eight attempts; under any other, none.
            assertTrue(jobs.start(won.get(0)));
            assertEquals(1, number(jobs.get(id), "attempts"));
        }
        // A lease that ran out: of eight that see it, one takes over — and the holder before it is out.
        RemitJobs.Held holder = jobs.insertClaimed("B1IT-CLAIM-X", org, RemitJobs.Kind.TRANSFER, "B1IT-CLAIM-X:transfer", null);
        sql.update("UPDATE remit_jobs SET lease_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?", holder.id);
        List<RemitJobs.Held> claims = Rail.together(8, (i) -> jobs.claim(holder.id));
        assertEquals(1, claims.stream().filter((c) -> c != null).count());
        assertFalse(jobs.markCallStarted(holder), "the holder whose lease ran out may not mark the call as started");
        assertNull(jobs.get(holder.id).get("call_started_at"));
    }

    // ── the platform's own institution ───────────────────────────────────────

    @Test
    void registersThePlatformAtStartOnlyWhereTheRowIsAbsentOrDifferent() {
        CoreConfig cfg = server.cfg();
        List<Map<String, Object>> kept = sql.queryForList("SELECT * FROM institutions WHERE id = ?", ProductRegistry.PLATFORM_ID);
        try {
            sql.update("DELETE FROM institutions WHERE id = ?", ProductRegistry.PLATFORM_ID);
            String spki = platform.spki();
            assertEquals(ProductRegistry.PlatformRow.ABSENT, registry.platformRow(spki));

            // A command or a test is wired, not started to serve: nothing is written.
            new RemitStartup(cfg, new StartMode(false), platform, registry).afterSingletonsInstantiated();
            assertEquals(ProductRegistry.PlatformRow.ABSENT, registry.platformRow(spki));

            // The server's start writes the row the reference writes.
            RemitStartup start = new RemitStartup(cfg, new StartMode(true), platform, registry);
            start.afterSingletonsInstantiated();
            assertEquals(ProductRegistry.PlatformRow.CURRENT, registry.platformRow(spki));
            Map<String, Object> row = registry.institution(ProductRegistry.PLATFORM_ID);
            assertEquals("STONEHASH", row.get("role"));
            assertEquals("StoneHash (platform)", row.get("name"));
            assertNull(row.get("country"));
            assertNull(row.get("org_id"));
            assertNull(row.get("encryption_jwk"));
            assertEquals(spki, row.get("signing_spki"));
            assertEquals("[\"REQUEST_ACCEPTED\",\"BANK_AUTHORIZATION_VERIFIED\",\"TRAVEL_RULE_SENT\",\"SETTLEMENT_INSTRUCTED\",\"SETTLEMENT_RECONCILED\",\"EVIDENCE_COMMITTED\","
                    + "\"EVIDENCE_ANCHORED\",\"webhook\"]", row.get("authority"));

            // A row that says what would be written is left alone: read first.
            sql.update("UPDATE institutions SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", ProductRegistry.PLATFORM_ID);
            start.afterSingletonsInstantiated();
            assertEquals("2026-01-01T00:00:00.000Z", registry.institution(ProductRegistry.PLATFORM_ID).get("created_at"));

            // Other content under the same key is brought up to date.
            sql.update("UPDATE institutions SET name = 'an older name', authority = '[]' WHERE id = ?", ProductRegistry.PLATFORM_ID);
            assertEquals(ProductRegistry.PlatformRow.STALE, registry.platformRow(spki));
            start.afterSingletonsInstantiated();
            assertEquals(ProductRegistry.PlatformRow.CURRENT, registry.platformRow(spki));

            // Another key: the live store is not overwritten — the start stops; a test store follows its key file.
            String otherKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(86) + "==";
            sql.update("UPDATE institutions SET signing_spki = ? WHERE id = ?", otherKey, ProductRegistry.PLATFORM_ID);
            assertEquals(ProductRegistry.PlatformRow.OTHER_KEY, registry.platformRow(spki));
            Map<String, String> live = new LinkedHashMap<>();
            live.put("STONEHASH_DATA_DIR", "/srv/stonehash/data");
            live.put("STONEHASH_ENV", "live");
            live.put("ANCHOR_BACKEND", "mainnet");
            live.put("REMIT_ENABLED", "1");
            live.put("REMIT_CHAIN_RPC", "https://rpc.example");
            ConfigError refused = assertThrows(ConfigError.class,
                    () -> new RemitStartup(CoreConfig.load(EnvSource.of(live)), new StartMode(true), platform, registry).afterSingletonsInstantiated());
            assertTrue(refused.getMessage().startsWith("refusing to start: the platform's own institution (STONEHASH) is registered with another signing key"), refused.getMessage());
            assertEquals(otherKey, registry.institution(ProductRegistry.PLATFORM_ID).get("signing_spki"), "the live row was not touched");
            start.afterSingletonsInstantiated();
            assertEquals(ProductRegistry.PlatformRow.CURRENT, registry.platformRow(spki), "the test store's row follows the key file");
        } finally {
            sql.update("DELETE FROM institutions WHERE id = ?", ProductRegistry.PLATFORM_ID);
            for (Map<String, Object> row : kept) {
                sql.update("INSERT INTO institutions (id, org_id, role, name, country, signing_spki, console_spki, encryption_jwk, authority, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        row.get("id"), row.get("org_id"), row.get("role"), row.get("name"), row.get("country"), row.get("signing_spki"), row.get("console_spki"),
                        row.get("encryption_jwk"), row.get("authority"), row.get("created_at"));
            }
        }
    }

    // ── the gate ─────────────────────────────────────────────────────────────

    private static Object outboxUrlAfterSwitchingOff(String org) {
        registry.subscribe(org, "remit", Rail.map("webhook_url", "http://127.0.0.1:3301/hooks/gate"));
        registry.unsubscribe(org, "remit");
        return outbox.urlOf(org);
    }

    @Test
    void letsOnlyASubscribedOrganisationWithItsBankOntoTheRail() {
        String org = newOrg("gate");
        ServiceError none = assertThrows(ServiceError.class, () -> registry.requireRemit(org));
        assertEquals("403 subscription_required", none.status() + " " + none.code());
        registry.subscribe(org, "remit", Rail.map());
        ServiceError noBank = assertThrows(ServiceError.class, () -> registry.requireRemit(org));
        assertEquals("403 institution_unregistered", noBank.status() + " " + noBank.code());
        registry.upsert("B1IT-BANK-GATE", "COLLECTION_BANK", "B1IT gate bank", "VN", org, "c3BraQ==", Js.UNDEFINED, null);
        Map<String, Object> bank = registry.requireRemit(org);
        assertEquals("B1IT-BANK-GATE", bank.get("id"));
        assertEquals("[]", bank.get("authority"), "no authority given: none");

        // upsert: an organisation that is not given stays; keys that are not given stay; the authority is what is given.
        registry.upsert("B1IT-BANK-GATE", "COLLECTION_BANK", "B1IT gate bank, renamed", null, null, null, Js.UNDEFINED, List.of("FIAT_FUNDS_RECEIVED"));
        bank = registry.institution("B1IT-BANK-GATE");
        assertEquals(org, bank.get("org_id"));
        assertEquals("c3BraQ==", bank.get("signing_spki"));
        assertEquals("B1IT gate bank, renamed", bank.get("name"));
        assertNull(bank.get("country"));
        assertEquals("[\"FIAT_FUNDS_RECEIVED\"]", bank.get("authority"));
        registry.upsert("B1IT-BANK-GATE", "COLLECTION_BANK", "B1IT gate bank", "VN", org, null, Rail.map("kty", "EC"), null);
        assertEquals("{\"kty\":\"EC\"}", registry.institution("B1IT-BANK-GATE").get("encryption_jwk"));
        registry.upsert("B1IT-BANK-GATE", "COLLECTION_BANK", "B1IT gate bank", "VN", org, null, Js.UNDEFINED, null);
        assertEquals("{\"kty\":\"EC\"}", registry.institution("B1IT-BANK-GATE").get("encryption_jwk"), "an encryption key that is not given stays");

        // Switched off, the gate refuses again; the notice address is still read.
        registry.unsubscribe(org, "remit");
        assertEquals("subscription_required", assertThrows(ServiceError.class, () -> registry.requireRemit(org)).code());
        assertEquals("http://127.0.0.1:3301/hooks/gate", outboxUrlAfterSwitchingOff(org));
    }
}
