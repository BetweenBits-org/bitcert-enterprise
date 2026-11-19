package com.stonehash.attest.core.console;

import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The console's first screen: what needs a person, and how each product is
 * doing, for one organisation.
 *
 * <p>A count is not something an operator can act on; an id is. So the
 * attention queue carries the items themselves — exceptions with the error
 * that stopped them, payouts held on thin evidence, requests waiting for an
 * answer, webhooks that ran out of attempts — five per kind, newest first,
 * and the counts beside them say when there are more.
 *
 * <p>Read-only, and every figure is the organisation's own.
 */
@Component
public class Dashboard {
    /** How many items of one kind the queue shows. */
    private static final int ATTENTION_CAP = 5;

    /** JavaScript's white space: a reason is brought onto one line as the reference brought it. */
    private static final Pattern SPACES = Pattern.compile("[\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+");

    private static final List<String> IN_FLIGHT = Arrays.asList("REQUEST_ACCEPTED", "BANK_AUTHORIZED", "TRAVEL_RULE_PENDING",
            "PAYOUT_PRE_APPROVED", "ONCHAIN_SETTLED", "PAYOUT_IN_PROGRESS");
    private static final List<String> COMPLETED = Arrays.asList("BENEFICIARY_CREDIT_CONFIRMED", "EVIDENCE_ANCHORED");
    private static final List<String> RETURNED_CANCELLED = Arrays.asList("RETURNED", "CANCELLED");
    private static final List<String> EXCEPTIONS = Arrays.asList("EXCEPTION");

    private final ConsoleMapper mapper;

    public Dashboard(ConsoleMapper mapper) {
        this.mapper = mapper;
    }

    public Map<String, Object> of(String orgId) {
        long now = System.currentTimeMillis();
        String today = IsoTime.ofEpochMilli(now).substring(0, 10);
        String since = IsoTime.ofEpochMilli(Billing.monthStart(now));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("generated_at", IsoTime.now());
        out.put("attention", attention(orgId));
        out.put("attest", attest(orgId));
        out.put("remit", remit(orgId, today, since));
        out.put("por", por(orgId));
        return out;
    }

    // ── what needs a person ──────────────────────────────────────────────────

    private Map<String, Object> attention(String orgId) {
        List<Object> items = new ArrayList<>();
        for (Map<String, Object> r : mapper.exceptionItems(orgId, ATTENTION_CAP)) {
            items.add(item("exception", r.get("id"), r.get("state"), exceptionReason(r.get("payload")), r.get("created_at")));
        }
        for (Map<String, Object> r : mapper.rfiItems(orgId, ATTENTION_CAP)) {
            items.add(item("rfi", r.get("id"), r.get("state"), null, r.get("created_at")));
        }
        for (Map<String, Object> r : mapper.heldItems(orgId, ATTENTION_CAP)) {
            items.add(item("held", r.get("id"), r.get("state"), null, r.get("created_at")));
        }
        for (Map<String, Object> r : mapper.exhaustedItems(orgId, ATTENTION_CAP)) {
            items.add(item("webhook", r.get("payment_id"), "exhausted", oneLine(r.get("last_error")), r.get("created_at")));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("rfi_waiting", mapper.rfiWaitingCount(orgId));
        out.put("l1_held", mapper.l1HeldCount(orgId));
        out.put("exceptions", mapper.exceptionCount(orgId));
        out.put("webhook_exhausted", mapper.webhookExhaustedCount(orgId));
        out.put("unconfirmed_anchors", mapper.unconfirmedAnchorCount(orgId));
        out.put("items", items);
        return out;
    }

    private static Map<String, Object> item(String kind, Object id, Object state, String reason, Object at) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("kind", kind);
        out.put("id", id);
        out.put("state", state);
        out.put("reason", reason);
        out.put("at", at);
        return out;
    }

    /** Text on one line, 120 characters at most; {@code null} for anything that is not text or is blank. */
    static String oneLine(Object v) {
        if (!(v instanceof String) || Js.trim((String) v).isEmpty()) {
            return null;
        }
        String line = Js.trim(SPACES.matcher((String) v).replaceAll(" "));
        return line.length() > 120 ? line.substring(0, 119) + "…" : line;
    }

    /** The error an exception event recorded, if it recorded one. */
    private static String exceptionReason(Object payload) {
        if (!(payload instanceof String) || ((String) payload).isEmpty()) {
            return null;
        }
        try {
            Object parsed = Js.parse((String) payload);
            return parsed instanceof Map ? oneLine(((Map<?, ?>) parsed).get("error")) : null;
        } catch (Js.SyntaxException e) {
            return null;
        }
    }

    // ── document anchoring ───────────────────────────────────────────────────

    private Map<String, Object> attest(String orgId) {
        Map<String, Object> funnel = new LinkedHashMap<>();
        for (String status : new String[] { "accepted", "batched", "submitted", "confirmed" }) {
            funnel.put(status, 0L);
        }
        for (Map<String, Object> r : mapper.attestFunnel(orgId)) {
            funnel.put((String) r.get("status"), ((Number) r.get("n")).longValue());
        }
        long total = 0;
        for (Object n : funnel.values()) {
            total += (Long) n;
        }
        Map<String, Object> signed = new LinkedHashMap<>();
        signed.put("signed", mapper.signedCount(orgId));
        signed.put("registered", mapper.registeredCount(orgId));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", total);
        out.put("funnel", funnel);
        out.put("signed", signed);
        // Document anchoring's own time to confirm: the other products' anchors are not in it.
        out.put("avg_confirm_seconds", averageSeconds(mapper.confirmPairs(orgId)));
        out.put("recent", mapper.recentAttest(orgId));
        return out;
    }

    /**
     * The mean of the gaps between two times, in whole seconds; {@code null}
     * when there is none to average. A pair that cannot be read, or whose end
     * is before its start, is left out.
     */
    static Double averageSeconds(List<Map<String, Object>> pairs) {
        double sum = 0;
        int n = 0;
        for (Map<String, Object> r : pairs) {
            Long from = r.get("c") instanceof String ? IsoDate.epochMilli((String) r.get("c")) : null;
            Long to = r.get("f") instanceof String ? IsoDate.epochMilli((String) r.get("f")) : null;
            if (from == null || to == null) {
                continue;
            }
            double seconds = (to - from) / 1000.0;
            if (seconds >= 0) {
                sum += seconds;
                n++;
            }
        }
        return n == 0 ? null : Billing.round(sum / n);
    }

    // ── settlements ──────────────────────────────────────────────────────────

    private static Map<String, Object> countAndSum(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", ((Number) row.get("n")).longValue());
        Object s = row.get("s");
        out.put("trade_usd", s == null ? 0d : Js.toNumber(s.toString()));
        return out;
    }

    private Map<String, Object> remit(String orgId, String today, String since) {
        Map<String, Long> states = new LinkedHashMap<>();
        for (Map<String, Object> r : mapper.remitStates(orgId)) {
            states.put((String) r.get("state"), ((Number) r.get("n")).longValue());
        }
        Map<String, Object> buckets = new LinkedHashMap<>();
        buckets.put("in_flight", bucket(states, IN_FLIGHT));
        buckets.put("completed", bucket(states, COMPLETED));
        buckets.put("returned_cancelled", bucket(states, RETURNED_CANCELLED));
        buckets.put("exceptions", bucket(states, EXCEPTIONS));

        Map<String, Object> month = countAndSum(mapper.remitSince(orgId, since));
        month.put("terminal_bad", mapper.terminalBadSince(orgId, since));

        Map<String, Object> webhooks = new LinkedHashMap<>();
        for (String status : new String[] { "pending", "delivered", "exhausted" }) {
            webhooks.put(status, 0L);
        }
        for (Map<String, Object> r : mapper.webhookStatuses(orgId)) {
            webhooks.put((String) r.get("status"), ((Number) r.get("n")).longValue());
        }

        String verdictToday = mapper.manifestVerdict(orgId, today);
        Map<String, Object> latest = mapper.latestManifest(orgId);
        Map<String, Object> manifestLatest = null;
        if (latest != null) {
            manifestLatest = new LinkedHashMap<>();
            manifestLatest.put("date", latest.get("date"));
            manifestLatest.put("status", property(Js.parse((String) latest.get("verdict")), "status"));
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("today", countAndSum(mapper.remitOfDay(orgId, today)));
        out.put("month", month);
        out.put("buckets", buckets);
        out.put("manifest_today", verdictToday == null ? null : property(Js.parse(verdictToday), "status"));
        out.put("manifest_latest", manifestLatest);
        out.put("webhooks", webhooks);
        out.put("avg_credit_seconds", averageSeconds(mapper.creditPairs(orgId)));
        out.put("recent", mapper.recentRemit(orgId));
        return out;
    }

    private static long bucket(Map<String, Long> states, List<String> keys) {
        long n = 0;
        for (String k : keys) {
            n += states.getOrDefault(k, 0L);
        }
        return n;
    }

    /** A field of a stored JSON value; absent where the value has no such field. A stored {@code null} is not a verdict at all. */
    private static Object property(Object parsed, String key) {
        if (parsed == null) {
            throw new IllegalStateException("a stored verdict is null");
        }
        return parsed instanceof Map && ((Map<?, ?>) parsed).containsKey(key) ? ((Map<?, ?>) parsed).get(key) : Js.UNDEFINED;
    }

    // ── reserve proofs ───────────────────────────────────────────────────────

    /** Was the snapshot challenged? One that was only accepted — its root taken on the exchange's word — was not. */
    static boolean spotChecked(Object status) {
        return !"ACCEPTED".equals(status);
    }

    /** Per asset, how far the reserves cover the liabilities, out of a snapshot's stored reserves; nothing where there is none to read. */
    static List<Object> coverageOf(Object reserves) {
        List<Object> out = new ArrayList<>();
        if (!(reserves instanceof String) || ((String) reserves).isEmpty()) {
            return out;
        }
        Object parsed;
        try {
            parsed = Js.parse((String) reserves);
        } catch (Js.SyntaxException e) {
            return out;
        }
        Object solvency = parsed instanceof Map ? ((Map<?, ?>) parsed).get("solvency") : null;
        if (!(solvency instanceof List)) {
            return out;
        }
        for (Object line : (List<?>) solvency) {
            if (line == null) {
                // A list with a hole in it is not a list of lines.
                return new ArrayList<>();
            }
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("asset", line instanceof Map && ((Map<?, ?>) line).containsKey("asset") ? ((Map<?, ?>) line).get("asset") : Js.UNDEFINED);
            one.put("coverage", line instanceof Map && ((Map<?, ?>) line).containsKey("coverage") ? ((Map<?, ?>) line).get("coverage") : Js.UNDEFINED);
            out.add(one);
        }
        return out;
    }

    private Map<String, Object> por(String orgId) {
        List<Map<String, Object>> snaps = mapper.recentSnapshots(orgId);
        Map<String, Object> latest = null;
        if (!snaps.isEmpty()) {
            Map<String, Object> s = snaps.get(0);
            String anchor = null;
            if (s.get("attestation_id") instanceof String && !((String) s.get("attestation_id")).isEmpty()) {
                anchor = mapper.attestationStatus((String) s.get("attestation_id"));
            }
            latest = new LinkedHashMap<>();
            latest.put("id", s.get("id"));
            latest.put("status", s.get("status"));
            latest.put("spot_check", spotChecked(s.get("status")));
            latest.put("asof", s.get("asof"));
            latest.put("root", s.get("root"));
            latest.put("leaf_count", ((Number) s.get("leaf_count")).longValue());
            latest.put("totals", Js.parse((String) s.get("totals")));
            latest.put("coverage", coverageOf(s.get("reserves")));
            latest.put("anchor_status", anchor);
            latest.put("created_at", s.get("created_at"));
        }
        List<Object> trend = new ArrayList<>();
        for (Map<String, Object> s : snaps) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("id", s.get("id"));
            point.put("asof", s.get("asof"));
            point.put("status", s.get("status"));
            point.put("spot_check", spotChecked(s.get("status")));
            point.put("coverage", coverageOf(s.get("reserves")));
            trend.add(point);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("latest", latest);
        out.put("trend", trend);
        return out;
    }
}
