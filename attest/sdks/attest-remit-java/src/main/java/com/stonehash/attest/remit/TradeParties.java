package com.stonehash.attest.remit;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * The two companies of the trade.
 *
 * <p>The {@linkplain Debtor debtor} is the importing company — also the Travel
 * Rule originator; the {@linkplain Creditor creditor} is the exporting company
 * — also the Travel Rule beneficiary. Companies only: the corridor settles
 * trade payments between legal persons.
 *
 * <pre>{@code
 * TradeParties parties = TradeParties.of(
 *     new TradeParties.Debtor().name("Saigon Import Co., Ltd.").country("VN")
 *         .address("12 Le Loi, Ho Chi Minh City").registrationNumber("0312345678").account("VN-ACC-1"),
 *     new TradeParties.Creditor().name("Lion City Exports Pte. Ltd.").country("SG").account("SG-ACC-9").bank("Demo Payout Bank"));
 * }</pre>
 *
 * <p>Which of these the beneficiary institution requires is stated by the
 * quote; {@link RemitClient#buildInstruction} refuses, before anything is
 * signed, parties that lack one of them.
 */
public final class TradeParties {
    private final Map<String, Object> debtor;
    private final Map<String, Object> creditor;

    private TradeParties(Map<String, Object> debtor, Map<String, Object> creditor) {
        this.debtor = Collections.unmodifiableMap(debtor);
        this.creditor = Collections.unmodifiableMap(creditor);
    }

    public static TradeParties of(Debtor debtor, Creditor creditor) {
        Objects.requireNonNull(debtor, "debtor");
        Objects.requireNonNull(creditor, "creditor");
        return new TradeParties(new LinkedHashMap<>(debtor.json), new LinkedHashMap<>(creditor.json));
    }

    /**
     * The parties as the fields the instruction carries — for a caller that
     * already holds them in that shape, such as the reading of a SWIFT message.
     * Keys: {@code name}, {@code country}, {@code address},
     * {@code registration_number}, {@code account} for the debtor;
     * {@code name}, {@code country}, {@code account}, {@code bank} for the creditor.
     */
    public static TradeParties ofFields(Map<String, Object> debtor, Map<String, Object> creditor) {
        Objects.requireNonNull(debtor, "debtor");
        Objects.requireNonNull(creditor, "creditor");
        return new TradeParties(new LinkedHashMap<>(debtor), new LinkedHashMap<>(creditor));
    }

    /** The debtor's fields, as they are written into the instruction. */
    public Map<String, Object> debtor() {
        return debtor;
    }

    /** The creditor's fields, as they are written into the instruction. */
    public Map<String, Object> creditor() {
        return creditor;
    }

    String debtorName() {
        return String.valueOf(debtor.get("name"));
    }

    String creditorName() {
        return String.valueOf(creditor.get("name"));
    }

    /** Fields in the order the instruction writes them, whatever order they were given in; absent ones left out. */
    private static Map<String, Object> ordered(Map<String, String> given, String... keys) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : keys) {
            String value = given.get(key);
            if (value != null) {
                out.put(key, value);
            }
        }
        return out;
    }

    /**
     * The importing company: who pays. Each value is named as it is given, so
     * that an address cannot be passed where a registration number belongs.
     */
    public static final class Debtor {
        private final Map<String, String> given = new LinkedHashMap<>();
        private Map<String, Object> json = Collections.emptyMap();

        public Debtor() {
        }

        private Debtor set(String key, String value) {
            if (value == null) {
                given.remove(key);
            } else {
                given.put(key, value);
            }
            json = ordered(given, "name", "country", "address", "registration_number", "account");
            return this;
        }

        /** The company's registered name. */
        public Debtor name(String name) {
            return set("name", name);
        }

        /** ISO 3166-1 alpha-2, e.g. {@code VN}. */
        public Debtor country(String country) {
            return set("country", country);
        }

        /** Its registered address, one line. */
        public Debtor address(String address) {
            return set("address", address);
        }

        /** Its business registration number, or its LEI. */
        public Debtor registrationNumber(String registrationNumber) {
            return set("registration_number", registrationNumber);
        }

        /** The account the funds were collected from, as your core banking system names it. Optional. */
        public Debtor account(String account) {
            return set("account", account);
        }
    }

    /** The exporting company: who is paid. */
    public static final class Creditor {
        private final Map<String, String> given = new LinkedHashMap<>();
        private Map<String, Object> json = Collections.emptyMap();

        public Creditor() {
        }

        private Creditor set(String key, String value) {
            if (value == null) {
                given.remove(key);
            } else {
                given.put(key, value);
            }
            json = ordered(given, "name", "country", "account", "bank");
            return this;
        }

        /** The company's registered name. */
        public Creditor name(String name) {
            return set("name", name);
        }

        /** ISO 3166-1 alpha-2, e.g. {@code SG}. */
        public Creditor country(String country) {
            return set("country", country);
        }

        /** The account to be credited. */
        public Creditor account(String account) {
            return set("account", account);
        }

        /** The bank that holds that account. */
        public Creditor bank(String bank) {
            return set("bank", bank);
        }
    }
}
