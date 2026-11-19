package com.stonehash.attest.core.console;

import com.stonehash.attest.core.config.CoreConfig;
import com.stonehash.attest.core.time.IsoTime;
import java.time.Instant;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What a month costs: per active product, its monthly fee plus what was used
 * times the unit price. A pure computation over the price list of the
 * deployment ({@code CONSOLE_PRICING}); with every price at 0 it is the
 * sandbox, and the console shows ₩0.
 *
 * <p>Months are calendar months in UTC: usage is counted from the first day
 * of the month at 00:00:00.000Z, and the period ends where the next begins.
 */
public final class Billing {
    private Billing() {
    }

    /** The first instant of the UTC month this instant is in. */
    public static long monthStart(long ms) {
        return YearMonth.from(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC)).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    /** The first instant of the UTC month after the one this instant is in. */
    public static long nextMonthStart(long ms) {
        return YearMonth.from(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC)).plusMonths(1).atDay(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    /** To the hundredth, a half going up — as the price list's arithmetic has always been rounded. */
    static double money(double n) {
        return round(n * 100) / 100;
    }

    /** JavaScript's {@code Math.round}: the nearest whole number, a half going towards +∞. */
    static double round(double x) {
        if (Double.isNaN(x) || Double.isInfinite(x) || Math.abs(x) >= 4_503_599_627_370_496d) {
            return x;
        }
        double floor = Math.floor(x);
        return x - floor >= 0.5 ? floor + 1 : floor;
    }

    private static Map<String, Object> line(String product, String unit, long quantity, double fee, double unitPrice) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("product", product);
        out.put("unit", unit);
        out.put("quantity", quantity);
        out.put("monthly_fee", fee);
        out.put("unit_price", unitPrice);
        out.put("amount", money(fee + quantity * unitPrice));
        return out;
    }

    /**
     * {@code currency, period {start, end}, lines, total}. A line per product
     * that is active — the settlement rail, the reserve proofs, document
     * anchoring, in that order — and none for one that is not.
     *
     * @param monthStartMs the first instant of the month billed
     */
    public static Map<String, Object> monthlyCharges(CoreConfig.Pricing pricing, long anchors, long settlements, long snapshots,
            Set<String> active, long monthStartMs) {
        return monthlyCharges(pricing.currency, pricing.attest, pricing.por, pricing.remit, anchors, settlements, snapshots, active, monthStartMs);
    }

    /** The same, from the three price lists as they are written: {@code monthly_fee} and the unit price of each product. */
    public static Map<String, Object> monthlyCharges(String currency, Map<String, Double> attest, Map<String, Double> por, Map<String, Double> remit,
            long anchors, long settlements, long snapshots, Set<String> active, long monthStartMs) {
        List<Object> lines = new ArrayList<>();
        double total = 0;
        if (active.contains("remit")) {
            lines.add(line("remit", "settlement", settlements, remit.get("monthly_fee"), remit.get("per_settlement")));
        }
        if (active.contains("por")) {
            lines.add(line("por", "snapshot", snapshots, por.get("monthly_fee"), por.get("per_snapshot")));
        }
        if (active.contains("attest")) {
            lines.add(line("attest", "anchor", anchors, attest.get("monthly_fee"), attest.get("per_anchor")));
        }
        for (Object l : lines) {
            total += (Double) ((Map<?, ?>) l).get("amount");
        }
        Map<String, Object> period = new LinkedHashMap<>();
        period.put("start", IsoTime.ofEpochMilli(monthStartMs));
        period.put("end", IsoTime.ofEpochMilli(nextMonthStart(monthStartMs)));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("currency", currency);
        out.put("period", period);
        out.put("lines", lines);
        out.put("total", money(total));
        return out;
    }
}
