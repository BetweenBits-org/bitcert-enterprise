package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.format.Hex;
import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.Js;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * What the rail's store tests share: the rows they make and take away
 * again, a clock that never gives two steps the same millisecond, and
 * several callers let go at the same moment.
 *
 * <p>Every organisation these tests make is named {@code b1seq-…} or
 * {@code b1it-…}, and what is removed is what belongs to such an
 * organisation — nothing else in the test schema is touched.
 */
final class Rail {
    private Rail() {
    }

    static final String[] OURS = { "b1seq-%", "b1it-%" };

    /** Remove everything that belongs to an organisation of these tests. */
    static void clean(JdbcTemplate sql) {
        for (String orgs : OURS) {
            sql.update("DELETE FROM remit_jobs WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_webhook_deliveries WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_idempotency WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_source_matches WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_source_refs WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_travel_rule WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id LIKE ?)", orgs);
            sql.update("DELETE FROM remit_events WHERE payment_id IN (SELECT id FROM remit_payments WHERE org_id LIKE ?)", orgs);
            sql.update("DELETE FROM remit_manifests WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM merkle_proofs WHERE attestation_id IN (SELECT id FROM attestations WHERE org_id LIKE ?)", orgs);
            sql.update("DELETE FROM attestations WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM audit_log WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_payments WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM remit_quotes WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM subscriptions WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM institutions WHERE org_id LIKE ?", orgs);
            sql.update("DELETE FROM institutions WHERE id LIKE 'B1IT-%'");
            sql.update("DELETE FROM orgs WHERE id LIKE ?", orgs);
        }
    }

    static void org(JdbcTemplate sql, String id) {
        sql.update("INSERT INTO orgs (id, slug, name, created_at) VALUES (?,?,?,?)", id, id, "B1 test " + id, "2026-01-01T00:00:00.000Z");
    }

    static long count(JdbcTemplate sql, String query, Object... args) {
        return sql.queryForObject(query, Long.class, args);
    }

    static String sha(String label) {
        return Hex.encode(Hex.sha256(("file:" + label).getBytes(StandardCharsets.UTF_8)));
    }

    static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }

    /** Wait until the clock shows a millisecond it has not shown to the caller before: rows made one after the other are then in that order by their time. */
    static void nextMillisecond() {
        long t = System.currentTimeMillis();
        while (System.currentTimeMillis() <= t) {
            Thread.onSpinWait();
        }
    }

    /** A settlement's row as the reference's tests make one. */
    static RemitStore.NewPayment payment(String org, String quoteId, String id) {
        RemitStore.NewPayment p = new RemitStore.NewPayment();
        p.id = id;
        p.orgId = org;
        p.quoteId = quoteId;
        p.corridorOrigin = "VN";
        p.corridorDestination = "SG";
        p.tradeCurrency = "USD";
        p.tradeAmount = "10.00";
        p.collectCurrency = "VND";
        p.collectAmount = "1";
        p.usdcAmount = "10.00";
        p.payoutCurrency = "SGD";
        p.payoutAmount = "13.35";
        p.beneficiaryInstitution = "SG-BFI-001";
        p.requestBody = "{}";
        return p;
    }

    /** An instruction that passed its checks — without a bank's signatures on it, which is all the store's rules need. */
    static Acceptance.Checked checked(String org, String quoteId, String id, SourceRef source) {
        Acceptance.Checked k = new Acceptance.Checked();
        k.paymentId = id;
        k.quoteId = quoteId;
        k.fresh = payment(org, quoteId, id);
        k.source = source;
        k.accepted = map("payment_id", id, "request_id", null, "quote_id", quoteId);
        k.submitted = map("bankInstruction", map("ref", id));
        k.verified = map("payment_id", id);
        return k;
    }

    /** What a call came to, as one line: {@code accepted}, or the refusal's code and what it carries. */
    static String outcome(Callable<Object> call) {
        try {
            Object r = call.call();
            return r instanceof com.stonehash.attest.core.http.HttpResult ? "status " + ((com.stonehash.attest.core.http.HttpResult) r).status : String.valueOf(r);
        } catch (ServiceError e) {
            return e.status() + " " + e.code() + (e.detail() == null ? "" : " " + Js.stringify(e.detail()));
        } catch (HttpError e) {
            return e.status() + " " + e.code();
        } catch (PlainError e) {
            return "plain " + e.getMessage();
        } catch (Exception e) {
            return "failed " + e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    /** Let {@code n} callers go at the same moment, each on a thread — and so a connection — of its own; what each came to, in the callers' order. */
    static <T> List<T> together(int n, java.util.function.IntFunction<T> one) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            CountDownLatch ready = new CountDownLatch(n);
            CountDownLatch go = new CountDownLatch(1);
            List<Future<T>> waiting = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                int index = i;
                waiting.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return one.apply(index);
                }));
            }
            if (!ready.await(30, TimeUnit.SECONDS)) {
                throw new IllegalStateException("the callers did not get ready");
            }
            go.countDown();
            List<T> out = new ArrayList<>();
            for (Future<T> f : waiting) {
                out.add(f.get(120, TimeUnit.SECONDS));
            }
            return out;
        } finally {
            pool.shutdownNow();
        }
    }
}
