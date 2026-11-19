package com.stonehash.attest.remit.swift;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The small checks every reader shares: amounts, currency codes, the UETR, a BIC's country, an LEI. */
final class SwiftText {
    private SwiftText() {
    }

    private static final Pattern AMOUNT = Pattern.compile("^(\\d{1,15})(?:\\.(\\d{0,5}))?\\z");
    private static final Pattern LEADING_ZEROS = Pattern.compile("^0+(?=\\d)");
    private static final Pattern CURRENCY = Pattern.compile("^[A-Z]{3}\\z");
    private static final Pattern UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z");
    private static final Pattern BIC = Pattern.compile("^[A-Z0-9]{4}([A-Z]{2})[A-Z0-9]{2}(?:[A-Z0-9]{3})?\\z");
    private static final Pattern LEI = Pattern.compile("^[A-Z0-9]{18}[0-9]{2}\\z");

    /**
     * {@code 1000,5} / {@code 1000.50} → a plain decimal string, or a refusal naming the field.
     *
     * <p>{@code decimalComma} takes a comma as the decimal mark, as FIN does ({@code 1000,5}),
     * and only the reader of FIN passes {@code true}. An ISO 20022 amount is an xs:decimal,
     * which has no comma at all: there {@code 12,500} is refused rather than taken as twelve
     * and a half.
     */
    static String normaliseAmount(String raw, String field, boolean decimalComma) {
        String t = Js.trim(raw);
        int comma = decimalComma ? t.indexOf(',') : -1;
        if (comma >= 0) {
            t = t.substring(0, comma) + "." + t.substring(comma + 1);
        }
        Matcher m = AMOUNT.matcher(t);
        if (!m.find()) {
            throw new SwiftMessageException("invalid_field", field + ": \"" + raw + "\" is not an amount", field);
        }
        String whole = LEADING_ZEROS.matcher(m.group(1)).replaceFirst("");
        String frac = m.group(2) == null ? "" : m.group(2);
        return frac.isEmpty() ? whole : whole + "." + frac;
    }

    static String assertCurrency(String raw, String field) {
        if (raw == null || raw.isEmpty() || !CURRENCY.matcher(raw).find()) {
            throw new SwiftMessageException("invalid_field", field + ": \"" + (raw == null ? "" : raw) + "\" is not a currency code", field);
        }
        return raw;
    }

    /**
     * Lower-case a UETR after checking it has the shape of a UUID. The
     * standard asks for version 4; this is a reader, not a validator of the
     * sender, so a UUID of another version is kept.
     */
    static String normaliseUetr(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        String t = Js.lower(Js.trim(raw));
        return UUID.matcher(t).find() ? t : null;
    }

    /**
     * The UETR a message states, or null when it states none. A value that is
     * there but is not a UUID refuses the message: read as "no UETR" the
     * payment would be known by its other references instead, its status
     * report would not name the UETR the bank's system printed, and the
     * corrected message sent afterwards would be a second payment.
     */
    static String uetrOf(String raw, String where) {
        if (raw == null || Js.blank(raw)) {
            return null;
        }
        String uetr = normaliseUetr(raw);
        if (uetr == null) {
            throw new SwiftMessageException("invalid_field",
                    "the UETR in " + where + " (\"" + Js.slice(Js.trim(raw), 0, 48) + "\") is not a UUID — correct it in the message; "
                            + "a payment is not given another identity because its UETR could not be read", where);
        }
        return uetr;
    }

    /** The two country letters of a BIC (positions 5–6), or null. */
    static String bicCountry(String bic) {
        if (bic == null || bic.isEmpty()) {
            return null;
        }
        Matcher m = BIC.matcher(Js.upper(Js.trim(bic)));
        return m.find() ? m.group(1) : null;
    }

    static boolean isLei(String value) {
        return value != null && !value.isEmpty() && LEI.matcher(value).find();
    }
}
