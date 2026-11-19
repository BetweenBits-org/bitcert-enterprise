package com.stonehash.attest.remit;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the bank knows about a payment beyond its message — typically from the
 * customer master record of the debtor. A free-format MT103 has no field for a
 * company's registration number; the bank's own records do.
 *
 * <p>A value given here is used instead of the message's, because a customer
 * record is firmer than a line of free text. So give only what the message
 * lacks or states too loosely. Every value taken from here is reported as
 * such in the mapping.
 *
 * <pre>{@code
 * new SwiftOptions().supplement(payment ->
 *     new PartySupplement().debtorRegistrationNumber(customers.registrationNumberOf(payment.debtor().account())));
 * }</pre>
 */
public final class PartySupplement {
    private final Map<String, Object> debtor = new LinkedHashMap<>();
    private final Map<String, Object> creditor = new LinkedHashMap<>();
    private String invoiceRef;
    private String purposeCode;

    private static void put(Map<String, Object> into, String key, String value) {
        if (value == null) {
            into.remove(key);
        } else {
            into.put(key, value);
        }
    }

    public PartySupplement debtorName(String name) {
        put(debtor, "name", name);
        return this;
    }

    /** ISO 3166-1 alpha-2. */
    public PartySupplement debtorCountry(String country) {
        put(debtor, "country", country);
        return this;
    }

    public PartySupplement debtorAddress(String address) {
        put(debtor, "address", address);
        return this;
    }

    /** The debtor's business registration number, or its LEI. */
    public PartySupplement debtorRegistrationNumber(String registrationNumber) {
        put(debtor, "registration_number", registrationNumber);
        return this;
    }

    public PartySupplement debtorAccount(String account) {
        put(debtor, "account", account);
        return this;
    }

    public PartySupplement creditorName(String name) {
        put(creditor, "name", name);
        return this;
    }

    /** ISO 3166-1 alpha-2. */
    public PartySupplement creditorCountry(String country) {
        put(creditor, "country", country);
        return this;
    }

    public PartySupplement creditorAccount(String account) {
        put(creditor, "account", account);
        return this;
    }

    public PartySupplement creditorBank(String bank) {
        put(creditor, "bank", bank);
        return this;
    }

    /** The invoice the payment settles, where the message's remittance information does not name one. */
    public PartySupplement invoiceRef(String invoiceRef) {
        this.invoiceRef = invoiceRef;
        return this;
    }

    public PartySupplement purposeCode(String purposeCode) {
        this.purposeCode = purposeCode;
        return this;
    }

    /**
     * A supplement held as JSON, in the shape of the SDK's sample customer-master
     * extract: {@code { "debtor": { "registration_number": "…" }, "creditor": { … },
     * "invoiceRef": "…", "purposeCode": "…" }}.
     *
     * @return the supplement, or {@code null} when {@code json} is {@code null} — "the records hold nothing for this payment"
     * @throws RemitException {@code invalid_supplement} when it is not an object of text values
     */
    public static PartySupplement fromJson(Object json) {
        if (json == null) {
            return null;
        }
        Map<String, Object> object = Json.object(json, "invalid_supplement", "the supplement");
        PartySupplement out = new PartySupplement();
        for (String side : new String[] { "debtor", "creditor" }) {
            Object party = object.get(side);
            if (party == null) {
                continue;
            }
            Map<String, Object> into = "debtor".equals(side) ? out.debtor : out.creditor;
            for (Map.Entry<String, Object> field : Json.object(party, "invalid_supplement", "the supplement's " + side).entrySet()) {
                if (field.getValue() != null) {
                    into.put(field.getKey(), Json.string(field.getValue(), "invalid_supplement", side + "." + field.getKey()));
                }
            }
        }
        if (object.get("invoiceRef") != null) {
            out.invoiceRef = Json.string(object.get("invoiceRef"), "invalid_supplement", "invoiceRef");
        }
        if (object.get("purposeCode") != null) {
            out.purposeCode = Json.string(object.get("purposeCode"), "invalid_supplement", "purposeCode");
        }
        return out;
    }

    /** The supplement in the shape the mapping takes. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!debtor.isEmpty()) {
            out.put("debtor", new LinkedHashMap<>(debtor));
        }
        if (!creditor.isEmpty()) {
            out.put("creditor", new LinkedHashMap<>(creditor));
        }
        if (invoiceRef != null) {
            out.put("invoiceRef", invoiceRef);
        }
        if (purposeCode != null) {
            out.put("purposeCode", purposeCode);
        }
        return out;
    }
}
