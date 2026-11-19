package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.http.HttpError;
import com.stonehash.attest.core.json.JsValues;
import com.stonehash.attest.core.time.IsoTime;
import com.stonehash.attest.remit.TravelRule;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The quote engine — a static corridor table and exact decimal arithmetic.
 *
 * <p>Rates are configuration, not a market feed: a sandbox quote must be
 * reproducible in the evidence that later cites it. The trade is in USD —
 * the unit of account the reconciliation policy groups 1:1 with USDC — and
 * the VND funding leg and the SGD payout leg are carried as locked
 * conversions of it.
 *
 * <p>Amounts are decimal text from end to end. Nothing here is a floating
 * point number: a product is rounded half up to the leg's number of decimal
 * places and written out in plain digits.
 */
public final class Quotes {
    private Quotes() {
    }

    /** What a quote is computed from besides the request. */
    public static final class Config {
        public final String rateUsdVnd;
        public final String rateUsdSgd;
        public final String feeUsd;
        public final long ttlMs;
        public final String chainLabel;

        public Config(String rateUsdVnd, String rateUsdSgd, String feeUsd, long ttlMs, String chainLabel) {
            this.rateUsdVnd = rateUsdVnd;
            this.rateUsdSgd = rateUsdSgd;
            this.feeUsd = feeUsd;
            this.ttlMs = ttlMs;
            this.chainLabel = chainLabel;
        }
    }

    /** Digits, and optionally a point with digits after it. Nothing else: no sign, no exponent, no space. */
    private static final Pattern DEC = Pattern.compile("[0-9]+(\\.[0-9]+)?");

    private static BigDecimal decimal(String s) {
        if (!DEC.matcher(s).matches()) {
            throw new HttpError(400, "invalid_amount", "not a positive decimal: " + s);
        }
        return new BigDecimal(s);
    }

    /** Fixed-point multiply: decimal text in, decimal text out, with exactly {@code outScale} decimal places, rounded half up. */
    public static String mulDecimal(String a, String b, int outScale) {
        BigDecimal x = decimal(a);
        BigDecimal y = decimal(b);
        return x.multiply(y).setScale(outScale, RoundingMode.HALF_UP).toPlainString();
    }

    /** The sum of two amounts, each first rounded half up to {@code scale} decimal places. */
    public static String addDecimal(String a, String b, int scale) {
        BigDecimal x = decimal(a).setScale(scale, RoundingMode.HALF_UP);
        BigDecimal y = decimal(b).setScale(scale, RoundingMode.HALF_UP);
        return x.add(y).toPlainString();
    }

    /**
     * A quote for a request, or the refusal the request gets.
     *
     * @param req the request body, whatever JSON it is
     * @param nowMs the moment of the quote
     * @return the quote, its members in the order it is answered and stored in
     * @throws HttpError 400 {@code unsupported_corridor}, {@code unsupported_trade_currency}, {@code unsupported_leg_currency}, {@code invalid_amount}
     */
    public static Map<String, Object> build(Object req, Config cfg, long nowMs) {
        Object corridor = JsValues.memberIfAny(req, "corridor");
        if (!"VN".equals(JsValues.memberIfAny(corridor, "origin")) || !"SG".equals(JsValues.memberIfAny(corridor, "destination"))) {
            throw new HttpError(400, "unsupported_corridor", "this sandbox quotes the VN→SG corridor only");
        }
        Object trade = JsValues.memberIfAny(req, "trade");
        if (!"USD".equals(JsValues.memberIfAny(trade, "currency"))) {
            throw new HttpError(400, "unsupported_trade_currency",
                    "trades are denominated in USD in this corridor (the unit of account the settlement reconciles 1:1 with USDC)");
        }
        if (!"VND".equals(JsValues.memberIfAny(JsValues.memberIfAny(req, "collect"), "currency"))
                || !"SGD".equals(JsValues.memberIfAny(JsValues.memberIfAny(req, "payout"), "currency"))) {
            throw new HttpError(400, "unsupported_leg_currency", "collection must be VND and payout SGD on VN→SG");
        }
        Object given = JsValues.member(trade, "amount");
        if (!DEC.matcher(JsValues.nullish(given) ? "" : JsValues.string(given)).matches()) {
            throw new HttpError(400, "invalid_amount", "trade.amount must be a positive decimal string");
        }
        if (!(given instanceof String)) {
            // A number that reads as a decimal got past the previous service's pattern and then stopped it inside its runtime.
            throw new JsValues.EngineError("trade.amount is not text");
        }
        String amount = (String) given;

        String usdc = mulDecimal(amount, "1", 2);
        String fundedUsd = addDecimal(amount, cfg.feeUsd, 2);
        String collectVnd = mulDecimal(fundedUsd, cfg.rateUsdVnd, 0);
        String payoutSgd = mulDecimal(amount, cfg.rateUsdSgd, 2);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("quote_id", "QT-" + UUID.randomUUID().toString().substring(0, 13));
        out.put("corridor", map("origin", "VN", "destination", "SG"));
        out.put("trade", map("currency", "USD", "amount", usdc));
        out.put("settlement", map("asset", "USDC", "amount", usdc, "chain", cfg.chainLabel));
        out.put("collect", map("currency", "VND", "amount", collectVnd, "rate", cfg.rateUsdVnd, "rate_pair", "USD/VND"));
        out.put("payout", map("currency", "SGD", "amount", payoutSgd, "rate", cfg.rateUsdSgd, "rate_pair", "USD/SGD"));
        List<Object> fees = new ArrayList<>();
        fees.add(map("type", "platform", "currency", "USD", "amount", cfg.feeUsd));
        out.put("fees", fees);
        out.put("quoted_at", IsoTime.ofEpochMilli(nowMs));
        out.put("expires_at", IsoTime.ofEpochMilli(nowMs + cfg.ttlMs));
        out.put("required_travel_rule_fields", new ArrayList<Object>(TravelRule.REQUIRED_FIELDS));
        return out;
    }

    private static Map<String, Object> map(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }
}
