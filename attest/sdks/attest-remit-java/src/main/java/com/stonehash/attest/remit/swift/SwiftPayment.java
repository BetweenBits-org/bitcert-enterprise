package com.stonehash.attest.remit.swift;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One customer credit transfer, as the bank's own message states it.
 *
 * <p>Three message families describe the same payment in three vocabularies —
 * ISO 20022 {@code pacs.008} (bank to bank), ISO 20022 {@code pain.001}
 * (customer to bank) and the FIN {@code MT103}. Each reader fills this one
 * shape and nothing else, so everything downstream — the mapping onto a
 * settlement instruction, the status report going back — is written once.
 *
 * <p>The rule the readers follow: record what the message says, infer
 * nothing. A country the message does not state is null here; whether it may
 * be inferred from an agent's BIC is the mapping's decision, and it is
 * reported when it happens.
 */
public final class SwiftPayment {
    /** Where the message says of itself that it is a test, and the value found there. */
    public static final class TestMark {
        private final String where;
        private final String what;

        TestMark(String where, String what) {
            this.where = where;
            this.what = what;
        }

        public String where() {
            return where;
        }

        public String what() {
            return what;
        }
    }

    String format;
    String messageType;
    String digest;
    int index;
    int transactionCount;
    Boolean distinctIds;

    String messageId;
    String instructionId;
    String paymentInfoId;
    String endToEndId;
    String transactionId;
    String uetr;
    String createdAt;
    String valueDate;

    SwiftAmount amount;
    SwiftAmount instructedAmount;
    SwiftAmount settlementAmount;
    String exchangeRate;
    String chargeBearer;
    final List<String> charges = new ArrayList<>();
    String bankOperationCode;
    TestMark test;

    SwiftParty debtor = new SwiftParty();
    SwiftAgent debtorAgent;
    SwiftParty creditor = new SwiftParty();
    SwiftAgent creditorAgent;
    final List<SwiftAgent> intermediaryAgents = new ArrayList<>();

    String purpose;
    final List<String> remittanceInformation = new ArrayList<>();
    final List<String> invoiceReferences = new ArrayList<>();
    final List<String> otherDocuments = new ArrayList<>();
    final List<String> regulatoryReporting = new ArrayList<>();

    final List<String> present = new ArrayList<>();

    SwiftPayment() {
    }

    /** {@code pacs.008}, {@code pain.001} or {@code MT103}. */
    public String format() {
        return format;
    }

    /** {@code pacs.008.001.08}, {@code pain.001.001.09}, {@code MT103} … as the message declares. */
    public String messageType() {
        return messageType;
    }

    /** SHA-256 (hex) over the exact bytes handed to the reader. */
    public String digest() {
        return digest;
    }

    /** Position of this transaction in what was handed over, from 0. */
    public int index() {
        return index;
    }

    /** How many transactions that input carries. */
    public int transactionCount() {
        return transactionCount;
    }

    /**
     * True when no other transaction of the same input carries these message,
     * instruction and end-to-end identifiers — the identifiers alone tell
     * this payment from its neighbours, wherever in a file it stands.
     */
    public boolean distinctIds() {
        return Boolean.TRUE.equals(distinctIds);
    }

    /** Group header {@code MsgId}, or the MT sender's reference (field 20). */
    public String messageId() {
        return messageId;
    }

    public String instructionId() {
        return instructionId;
    }

    /** pain.001: the identification of the payment-information block the transaction belongs to. */
    public String paymentInfoId() {
        return paymentInfoId;
    }

    public String endToEndId() {
        return endToEndId;
    }

    public String transactionId() {
        return transactionId;
    }

    /** Unique end-to-end transaction reference, lower case. */
    public String uetr() {
        return uetr;
    }

    /** Message creation time, as given. */
    public String createdAt() {
        return createdAt;
    }

    /** Settlement / requested execution / value date, {@code YYYY-MM-DD}. */
    public String valueDate() {
        return valueDate;
    }

    /** The amount the payment is for: instructed amount, else settlement amount. */
    public SwiftAmount amount() {
        return amount;
    }

    public SwiftAmount instructedAmount() {
        return instructedAmount;
    }

    public SwiftAmount settlementAmount() {
        return settlementAmount;
    }

    public String exchangeRate() {
        return exchangeRate;
    }

    /** ISO 20022 charge bearer: {@code DEBT}, {@code CRED}, {@code SHAR} or {@code SLEV}. MT 71A is translated. */
    public String chargeBearer() {
        return chargeBearer;
    }

    /** Charges the message states ({@code ChrgsInf}, MT 71F / 71G), as given. */
    public List<String> charges() {
        return Collections.unmodifiableList(charges);
    }

    /** MT103 field 23B — {@code CRED}, {@code SPAY}, {@code SSTD}, {@code SPRI}, or {@code CRTS} for a test message. */
    public String bankOperationCode() {
        return bankOperationCode;
    }

    /** Set when the message says of itself that it is a test; null otherwise. */
    public TestMark test() {
        return test;
    }

    public SwiftParty debtor() {
        return debtor;
    }

    public SwiftAgent debtorAgent() {
        return debtorAgent;
    }

    public SwiftParty creditor() {
        return creditor;
    }

    public SwiftAgent creditorAgent() {
        return creditorAgent;
    }

    public List<SwiftAgent> intermediaryAgents() {
        return Collections.unmodifiableList(intermediaryAgents);
    }

    /** Purpose code or proprietary purpose, as given. */
    public String purpose() {
        return purpose;
    }

    /** Unstructured remittance information, one entry per occurrence / line. */
    public List<String> remittanceInformation() {
        return Collections.unmodifiableList(remittanceInformation);
    }

    /** Invoice references: documents the message types as an invoice, or does not type at all. */
    public List<String> invoiceReferences() {
        return Collections.unmodifiableList(invoiceReferences);
    }

    /** Referred documents of another kind (purchase order, credit note …): {@code PUOR PO-88812}. */
    public List<String> otherDocuments() {
        return Collections.unmodifiableList(otherDocuments);
    }

    public List<String> regulatoryReporting() {
        return Collections.unmodifiableList(regulatoryReporting);
    }

    /**
     * What the message contained, by its own names: ISO 20022 element names
     * for the XML families, field tags ({@code 20}, {@code 32A}, {@code 50K} …) for MT103.
     */
    public List<String> present() {
        return Collections.unmodifiableList(present);
    }

    /** The payment as the TypeScript SDK's JSON has it: a field that was not stated is absent. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("format", format);
        out.put("messageType", messageType);
        out.put("digest", digest);
        out.put("index", (long) index);
        out.put("transactionCount", (long) transactionCount);
        JsonOut.put(out, "distinctIds", distinctIds);
        JsonOut.put(out, "messageId", messageId);
        JsonOut.put(out, "instructionId", instructionId);
        JsonOut.put(out, "paymentInfoId", paymentInfoId);
        JsonOut.put(out, "endToEndId", endToEndId);
        JsonOut.put(out, "transactionId", transactionId);
        JsonOut.put(out, "uetr", uetr);
        JsonOut.put(out, "createdAt", createdAt);
        JsonOut.put(out, "valueDate", valueDate);
        out.put("amount", amount == null ? null : amount.toJson());
        JsonOut.put(out, "instructedAmount", instructedAmount == null ? null : instructedAmount.toJson());
        JsonOut.put(out, "settlementAmount", settlementAmount == null ? null : settlementAmount.toJson());
        JsonOut.put(out, "exchangeRate", exchangeRate);
        JsonOut.put(out, "chargeBearer", chargeBearer);
        out.put("charges", new ArrayList<Object>(charges));
        JsonOut.put(out, "bankOperationCode", bankOperationCode);
        if (test != null) {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("where", test.where);
            t.put("what", test.what);
            out.put("test", t);
        }
        out.put("debtor", debtor.toJson());
        JsonOut.put(out, "debtorAgent", debtorAgent == null ? null : debtorAgent.toJson());
        out.put("creditor", creditor.toJson());
        JsonOut.put(out, "creditorAgent", creditorAgent == null ? null : creditorAgent.toJson());
        List<Object> agents = new ArrayList<>();
        for (SwiftAgent a : intermediaryAgents) {
            agents.add(a.toJson());
        }
        out.put("intermediaryAgents", agents);
        JsonOut.put(out, "purpose", purpose);
        out.put("remittanceInformation", new ArrayList<Object>(remittanceInformation));
        out.put("invoiceReferences", new ArrayList<Object>(invoiceReferences));
        out.put("otherDocuments", new ArrayList<Object>(otherDocuments));
        out.put("regulatoryReporting", new ArrayList<Object>(regulatoryReporting));
        out.put("present", new ArrayList<Object>(present));
        return out;
    }

    /**
     * A payment from the JSON the TypeScript SDK writes — what {@link #toJson()}
     * gives. For a payment that was read by another process, and for the tests.
     */
    public static SwiftPayment fromJson(Map<String, Object> m) {
        SwiftPayment p = new SwiftPayment();
        p.format = (String) m.get("format");
        p.messageType = (String) m.get("messageType");
        p.digest = (String) m.get("digest");
        p.index = ((Number) m.get("index")).intValue();
        p.transactionCount = ((Number) m.get("transactionCount")).intValue();
        p.distinctIds = (Boolean) m.get("distinctIds");
        p.messageId = (String) m.get("messageId");
        p.instructionId = (String) m.get("instructionId");
        p.paymentInfoId = (String) m.get("paymentInfoId");
        p.endToEndId = (String) m.get("endToEndId");
        p.transactionId = (String) m.get("transactionId");
        p.uetr = (String) m.get("uetr");
        p.createdAt = (String) m.get("createdAt");
        p.valueDate = (String) m.get("valueDate");
        p.amount = SwiftAmount.fromJson(m.get("amount"));
        p.instructedAmount = SwiftAmount.fromJson(m.get("instructedAmount"));
        p.settlementAmount = SwiftAmount.fromJson(m.get("settlementAmount"));
        p.exchangeRate = (String) m.get("exchangeRate");
        p.chargeBearer = (String) m.get("chargeBearer");
        p.charges.addAll(JsonOut.strings(m.get("charges")));
        p.bankOperationCode = (String) m.get("bankOperationCode");
        Map<?, ?> t = (Map<?, ?>) m.get("test");
        p.test = t == null ? null : new TestMark((String) t.get("where"), (String) t.get("what"));
        p.debtor = SwiftParty.fromJson(m.get("debtor"));
        p.debtorAgent = SwiftAgent.fromJson(m.get("debtorAgent"));
        p.creditor = SwiftParty.fromJson(m.get("creditor"));
        p.creditorAgent = SwiftAgent.fromJson(m.get("creditorAgent"));
        if (m.get("intermediaryAgents") != null) {
            for (Object a : (List<?>) m.get("intermediaryAgents")) {
                p.intermediaryAgents.add(SwiftAgent.fromJson(a));
            }
        }
        p.purpose = (String) m.get("purpose");
        p.remittanceInformation.addAll(JsonOut.strings(m.get("remittanceInformation")));
        p.invoiceReferences.addAll(JsonOut.strings(m.get("invoiceReferences")));
        p.otherDocuments.addAll(JsonOut.strings(m.get("otherDocuments")));
        p.regulatoryReporting.addAll(JsonOut.strings(m.get("regulatoryReporting")));
        p.present.addAll(JsonOut.strings(m.get("present")));
        return p;
    }
}
