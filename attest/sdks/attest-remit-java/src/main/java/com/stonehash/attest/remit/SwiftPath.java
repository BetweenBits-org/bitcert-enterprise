package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.Swift;
import com.stonehash.attest.remit.swift.SwiftInstructionInput;
import com.stonehash.attest.remit.swift.SwiftMapping;
import com.stonehash.attest.remit.swift.SwiftMappingException;
import com.stonehash.attest.remit.swift.SwiftMappingOptions;
import com.stonehash.attest.remit.swift.SwiftPayment;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * From a SWIFT message to a submitted instruction, and the question that has
 * to be answered on the way: is this payment in the ledger already?
 *
 * <p>The decisions here are the reference SDK's, taken in the same order and
 * on the same grounds, so that the same message handed to either SDK names
 * the same payment and is recognised by the other.
 */
final class SwiftPath {
    /**
     * The platform's answers that mean "this payment is here already": the
     * payment id or the idempotency key is taken, or the message it was made
     * from already has a settlement.
     */
    private static final Set<String> TAKEN_ALREADY = new HashSet<>(Arrays.asList(
            "duplicate_payment", "idempotency_conflict", "duplicate_source_message", "reference_reused"));

    private final RemitClient client;

    SwiftPath(RemitClient client) {
        this.client = client;
    }

    // ── reading and mapping ───────────────────────────────────────────────────

    /**
     * @param message a {@code byte[]}, a {@code String}, or a {@link SwiftPayment} already parsed out of a
     *                file of many (parsing the whole file again for each of its payments would be quadratic)
     */
    SwiftMapping map(Object message, SwiftOptions o) {
        SwiftPayment payment = message instanceof SwiftPayment ? (SwiftPayment) message
                : message instanceof byte[] ? Swift.parse((byte[]) message, o.index) : Swift.parse((String) message, o.index);
        PartySupplement supplement = o.supplement == null ? null : o.supplement.apply(payment);
        // A message marked as a test is taken with a test key and with no other.
        SwiftMappingOptions options = new SwiftMappingOptions().allowTestMessages(client.testKey());
        if (supplement != null) {
            options.supplement(supplement.toJson());
        }
        if (o.inferCountryFromBic != null) {
            options.inferCountryFromBic(o.inferCountryFromBic);
        }
        return Swift.map(payment, options);
    }

    SwiftInstruction instruction(Object message, SwiftOptions o) {
        SwiftMapping mapping = map(message, o);
        if (mapping.input() == null) {
            throw new SwiftMappingException(mapping);
        }
        return instructionFromMapping(mapping, o, o.paymentId);
    }

    private SwiftInstruction instructionFromMapping(SwiftMapping mapping, SwiftOptions o, String paymentId) {
        SwiftInstructionInput input = mapping.input();
        Quote quote = client.quote(input.tradeAmount());
        InstructionOptions options = new InstructionOptions()
                .paymentId(paymentId != null ? paymentId : Swift.paymentId(client.institutionId(), mapping.payment()))
                .invoiceRef(input.invoiceRef())
                .source(input.source())
                .messageFields(Swift.isoFieldNames(mapping.payment()));
        if (truthy(input.purposeCode())) {
            options.purposeCode(input.purposeCode());
        }
        if (truthy(input.instructionRef())) {
            options.instructionRef(input.instructionRef());
        }
        if (truthy(o.beneficiaryInstitution)) {
            options.beneficiaryInstitution(o.beneficiaryInstitution);
        }
        if (o.review != null) {
            options.review(o.review);
        }
        if (o.travelRule != null) {
            options.travelRule(o.travelRule);
        }
        Map<String, Object> parties = input.parties();
        Instruction built = client.buildInstruction(quote,
                TradeParties.ofFields(object(parties.get("debtor")), object(parties.get("creditor"))), options);
        return new SwiftInstruction(built, quote, mapping);
    }

    // ── is it there already? ──────────────────────────────────────────────────

    private enum Relation {
        /** The same payment: byte for byte, or written out again. */
        SAME,
        /**
         * The same reference on a different payment. This is the one that must
         * never be answered "already submitted": that would drop a payment
         * without a word.
         */
        REUSED,
        /** Another payment altogether — as far as this pair shows. */
        UNRELATED
    }

    /**
     * How one settlement in the ledger relates to the payment in hand.
     *
     * <p>"The same reference" is claimed on strong grounds only: the same
     * UETR, or — where neither message has one — a settlement that stands
     * under the id derived from this message's own identifiers
     * ({@code byDerivedId}; an id the caller chose says nothing about the
     * message). Only then can the answer be {@link Relation#REUSED}.
     *
     * <p>Short of that, the settlement may still be this payment in another
     * message: the same instruction and end-to-end identifiers, value date
     * and content — or, for a payment that carries neither identifier, the
     * same message id, position, value date and content. That is the payment
     * a bank retries alone after a batch, an MT103 once with and once without
     * its header blocks, a file exported again.
     *
     * <p>This judges ONE settlement the caller already has in hand — the one
     * under the payment id, or the one that holds the UETR. It is not used to
     * pick "the" twin out of several settlements that read alike: which of
     * two like instalments a re-exported transaction stands for is the
     * platform's to decide, one to one, when the instruction is sent.
     */
    private Relation relate(Settlement view, SwiftMapping mapping, boolean byDerivedId) {
        Map<String, Object> ref = mapping.input().source();
        Map<String, Object> stored = Swift.sourceMessageOf(view.json());
        if (stored == null) {
            return Relation.UNRELATED;
        }
        boolean sameBytes = Objects.equals(stored.get("sha256"), ref.get("sha256"));
        boolean sameIndex = samePosition(stored.get("index"), ref.get("index"));
        if (sameBytes && sameIndex) {
            return Relation.SAME;
        }

        boolean both = truthy(ref.get("uetr")) && truthy(stored.get("uetr"));
        boolean neither = !truthy(ref.get("uetr")) && !truthy(stored.get("uetr"));
        boolean sameIds = Objects.equals(orEmpty(stored.get("instructionId")), orEmpty(ref.get("instructionId")))
                && Objects.equals(orEmpty(stored.get("endToEndId")), orEmpty(ref.get("endToEndId")));
        boolean sameMessage = Objects.equals(stored.get("type"), ref.get("type"))
                && Objects.equals(orEmpty(stored.get("messageId")), orEmpty(ref.get("messageId")));
        boolean sameDay = Objects.equals(orEmpty(stored.get("valueDate")), orEmpty(ref.get("valueDate")));
        boolean strong = both
                ? Objects.equals(ref.get("uetr"), stored.get("uetr"))
                : byDerivedId && neither && (truthy(ref.get("messageId")) || truthy(ref.get("instructionId")))
                        && sameMessage && sameIds && sameDay;
        if (strong) {
            // Two transactions of one file under one reference are two payments, whatever each says.
            if (sameBytes) {
                return Relation.REUSED;
            }
            return sameContent(view, stored, mapping) ? Relation.SAME : Relation.REUSED;
        }
        // Two different UETRs are two payments; so are two transactions of one file.
        if (both || sameBytes) {
            return Relation.UNRELATED;
        }
        boolean ownIds = truthy(ref.get("instructionId")) || truthy(ref.get("endToEndId"));
        boolean twin = sameIds && truthy(ref.get("valueDate")) && sameDay
                && truthy(ref.get("content")) && Objects.equals(ref.get("content"), stored.get("content"))
                && (ownIds || (sameMessage && truthy(ref.get("messageId")) && sameIndex));
        return twin ? Relation.SAME : Relation.UNRELATED;
    }

    /** Do the stored instruction and the message in hand describe one payment? */
    private boolean sameContent(Settlement view, Map<String, Object> stored, SwiftMapping mapping) {
        SwiftInstructionInput input = mapping.input();
        Map<String, Object> source = input.source();
        if (truthy(stored.get("content")) && truthy(source.get("content"))) {
            return Objects.equals(stored.get("content"), source.get("content"));
        }
        // A settlement made before instructions carried a content digest: what its signed elements state.
        Map<String, Object> was = new LinkedHashMap<>();
        for (Map<String, Object> event : view.events()) {
            if ("BANK_EVIDENCE_SUBMITTED".equals(event.get("type"))) {
                if (event.get("payload") instanceof Map) {
                    was = object(event.get("payload"));
                }
                break;
            }
        }
        Map<String, Object> bankInstruction = was.get("bankInstruction") instanceof Map ? object(was.get("bankInstruction")) : new LinkedHashMap<>();
        Map<String, Object> commercialDocs = was.get("commercialDocs") instanceof Map ? object(was.get("commercialDocs")) : new LinkedHashMap<>();
        Map<String, Object> parties = input.parties();
        // The amount as the instruction writes it: at least two decimals.
        String[] parts = input.tradeAmount().split("\\.", -1);
        StringBuilder fraction = new StringBuilder(parts.length > 1 ? parts[1] : "");
        while (fraction.length() < 2) {
            fraction.append('0');
        }
        // An invoice reference that is there has to be the same one: a null in its place is not "none".
        boolean sameInvoice = !commercialDocs.containsKey("invoiceRef")
                || (commercialDocs.get("invoiceRef") != null && Objects.equals(commercialDocs.get("invoiceRef"), input.invoiceRef()));
        return Objects.equals(bankInstruction.get("amount"), parts[0] + "." + fraction)
                && bankInstruction.get("debtor") != null && Objects.equals(bankInstruction.get("debtor"), object(parties.get("debtor")).get("name"))
                && bankInstruction.get("creditor") != null && Objects.equals(bankInstruction.get("creditor"), object(parties.get("creditor")).get("name"))
                && sameInvoice
                && Objects.equals(orEmpty(stored.get("instructionId")), orEmpty(source.get("instructionId")))
                && Objects.equals(orEmpty(stored.get("endToEndId")), orEmpty(source.get("endToEndId")));
    }

    private RemitApiException reused(Settlement view, Map<String, Object> ref) {
        Map<String, Object> stored = Swift.sourceMessageOf(view.json());
        boolean sameFile = stored != null && Objects.equals(stored.get("sha256"), ref.get("sha256"));
        return new RemitApiException(409, "reference_reused",
                "this message's reference" + (truthy(ref.get("uetr")) ? " (UETR " + ref.get("uetr") + ")" : "") + " is already on settlement "
                        + view.paymentId() + " (" + view.state() + "), which is a different payment — "
                        + (sameFile ? "the same reference appears on two transactions of this file"
                                : "its amount, parties, accounts or identifiers differ")
                        + ", and nothing was sent. A reference names one payment: "
                        + (truthy(ref.get("uetr")) ? "give this one its own UETR"
                                : "give this one a reference of its own, or pass an explicit paymentId if it is meant as a payment of its own"),
                view.paymentId());
    }

    /**
     * Is this payment in the ledger already — as far as can be said for
     * certain before anything is sent? Returns its settlement when it is;
     * throws {@code reference_reused} when its reference is there on a
     * different payment; returns {@code null} otherwise.
     *
     * <p>Two things are certain without the platform's judgement: the
     * settlement that stands under this payment's id (the one a caller chose,
     * and the one derived from the message's own identifiers — a payment this
     * SDK submitted before), and the settlement that holds its UETR. Each is
     * one settlement, looked up exactly.
     *
     * <p>Everything else — the same payment in another message, under another
     * id — is NOT searched for here. The platform decides that when the
     * instruction arrives: it refuses a message that already has a
     * settlement, also when two requests arrive at the same moment, names the
     * settlement, and {@link #submit} answers with it. Guessing it here would
     * mean picking one of several settlements that read alike, and calling a
     * payment made because one like it was.
     */
    private Settlement known(String paymentId, String derivedId, SwiftMapping mapping) {
        Map<String, Object> ref = mapping.input().source();

        Settlement byId = client.find(paymentId).orElse(null);
        if (byId != null) {
            Relation relation = relate(byId, mapping, paymentId.equals(derivedId));
            if (relation == Relation.SAME) {
                return byId;
            }
            if (relation == Relation.REUSED) {
                throw reused(byId, ref);
            }
            throw new RemitApiException(409, "payment_id_conflict",
                    paymentId + " already names a settlement made from a different message; give this payment an id of its own",
                    byId.paymentId());
        }
        // A caller's own id names the settlement; it does not hide the one this SDK made from
        // the same message before. (Where that one is a DIFFERENT payment under the same
        // identifiers, the caller's own id is its statement that this is a payment of its own.)
        if (!paymentId.equals(derivedId)) {
            Settlement derived = client.find(derivedId).orElse(null);
            if (derived != null && relate(derived, mapping, true) == Relation.SAME) {
                return derived;
            }
        }

        // The settlement that holds this UETR, if any: at most one.
        if (truthy(ref.get("uetr"))) {
            Map<String, String> lookup = new LinkedHashMap<>();
            lookup.put("source_uetr", (String) ref.get("uetr"));
            lookup.put("limit", "50");
            Map<String, Object> page = client.list(lookup);
            for (Object row : (List<?>) page.get("data")) {
                Object id = row instanceof Map ? ((Map<?, ?>) row).get("payment_id") : null;
                if (!(id instanceof String) || id.equals(paymentId)) {
                    continue;
                }
                Settlement view = client.find((String) id).orElse(null);
                if (view == null) {
                    continue;
                }
                Relation relation = relate(view, mapping, false);
                if (relation == Relation.SAME) {
                    return view;
                }
                if (relation == Relation.REUSED) {
                    throw reused(view, ref);
                }
            }
        }
        return null;
    }

    // ── the whole path ────────────────────────────────────────────────────────

    /**
     * Parse → map → quote → sign → submit, safe to repeat.
     *
     * <p>The payment id is derived from the message's own references, and the
     * ledger is asked for them first, so a payment handed over twice is
     * recognised: the second call sends nothing and answers with the
     * settlement as it stands. A reference that comes back on a different
     * payment is refused as {@code reference_reused} — never mistaken for a
     * repeat.
     *
     * <p>The platform holds the line at acceptance: one message is one
     * settlement there — the same payment in another message, under another
     * id, or handed over by two processes at the same moment. The one that
     * came second is answered {@code duplicate_source_message} with the
     * settlement that stands, and this turns that into the same "already"
     * (it costs a quote and a signature that are then not used). The one
     * exception is two messages that nothing tells apart — the same
     * identifiers and content, and no value date: that is passed on as the
     * refusal it is.
     */
    SwiftSubmission submit(Object message, SwiftOptions o) {
        SwiftMapping mapping = map(message, o);
        if (mapping.input() == null) {
            throw new SwiftMappingException(mapping);
        }
        String derivedId = Swift.paymentId(client.institutionId(), mapping.payment());
        String paymentId = o.paymentId != null ? o.paymentId : derivedId;

        Settlement before = known(paymentId, derivedId, mapping);
        if (before != null) {
            return already(before, mapping);
        }
        SwiftInstruction built = instructionFromMapping(mapping, o, paymentId);
        try {
            Settlement accepted = client.submit(built.instruction().body(), "swift-" + paymentId);
            return new SwiftSubmission(paymentId, accepted.state(), false, mapping, built.quote());
        } catch (RemitApiException e) {
            if (TAKEN_ALREADY.contains(e.code())) {
                // The platform has this payment: under another id, from another rendering of the
                // message, or from the process that got there first. Where it names the settlement,
                // that settlement is the answer — except when it says the two cannot be told apart.
                if ("duplicate_source_message".equals(e.code()) && truthy(e.existingPaymentId()) && !"twin_undated".equals(e.ground())) {
                    Settlement stands = client.find(e.existingPaymentId()).orElse(null);
                    if (stands != null) {
                        return already(stands, mapping);
                    }
                }
                // Otherwise the ledger now says which: the same id or UETR taken a moment ago.
                Settlement after = known(paymentId, derivedId, mapping);
                if (after != null) {
                    return already(after, mapping);
                }
            }
            throw e;
        }
    }

    private static SwiftSubmission already(Settlement view, SwiftMapping mapping) {
        return new SwiftSubmission(view.paymentId(), view.state(), true, mapping, null);
    }

    // ── values as the reference SDK reads them ────────────────────────────────

    /** Present and not empty — the reference SDK's test for "the message states it". */
    private static boolean truthy(Object v) {
        if (v == null) {
            return false;
        }
        if (v instanceof String) {
            return !((String) v).isEmpty();
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof Number) {
            return ((Number) v).doubleValue() != 0;
        }
        return true;
    }

    private static Object orEmpty(Object v) {
        return v == null ? "" : v;
    }

    /**
     * Two positions in a file, an absent one meaning the first: the same when
     * they are the same number, whatever type holds it — 1.5 is not 1.
     */
    private static boolean samePosition(Object a, Object b) {
        Object x = a == null ? (Object) 0L : a;
        Object y = b == null ? (Object) 0L : b;
        if (x instanceof Number && y instanceof Number) {
            return ((Number) x).doubleValue() == ((Number) y).doubleValue();
        }
        return !(x instanceof Number) && !(y instanceof Number) && x.equals(y);
    }

    private static Map<String, Object> object(Object v) {
        return Json.object(v, "not_a_platform_answer", "an object");
    }
}
