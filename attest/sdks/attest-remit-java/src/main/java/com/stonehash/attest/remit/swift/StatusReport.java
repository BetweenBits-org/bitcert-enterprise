package com.stonehash.attest.remit.swift;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The way back: a settlement's state, said in the vocabulary the bank's
 * payment systems already consume.
 *
 * <p>{@link #statusOf} turns a settlement view into an ISO 20022 transaction
 * status code; {@link #buildPacs002} writes it as a {@code pacs.002} status
 * report (FIToFIPaymentStatusReport) that points at the bank's original
 * message by its own identifiers — message id, instruction id, end-to-end id,
 * UETR.
 *
 * <p>The codes are the ISO 20022 ones. The reasons are this platform's own
 * event names, carried as proprietary reasons, because an invented mapping
 * onto standard reason codes would claim more than is known: {@code RFI} is
 * not a code the standard has, and saying so is more useful than a near miss.
 *
 * <p>Everything is derived from the settlement view alone — the references
 * sit in the bank-signed instruction the platform stores — so a status report
 * can be produced by a process that never saw the original message.
 *
 * <p>The view is read as any JSON may be: a value of another kind than the
 * one expected reads as absent, and a status and a report are still given.
 * Nothing here throws for what a view holds. An element whose value is empty
 * once cleaned, or not in the form the schema asks for, is left out of the
 * report: never written empty, never written wrong.
 */
final class StatusReport {
    private StatusReport() {
    }

    private static final long MAX_SAFE_INTEGER = 9007199254740991L;

    private static final Map<String, String> MEANING = new LinkedHashMap<>();

    static {
        MEANING.put("ACTC", "AcceptedTechnicalValidation — the instruction was authenticated and validated");
        MEANING.put("ACSP", "AcceptedSettlementInProcess — accepted, settlement is under way");
        MEANING.put("ACCC", "AcceptedCreditSettlementCompleted — the creditor's account has been credited");
        MEANING.put("PDNG", "Pending — further checks or information are outstanding");
        MEANING.put("RJCT", "Rejected — the payment did not go through");
    }

    /** The table a bank maps onto its own status codes. One row per situation: {@code state}, {@code when}, {@code code}, {@code reason}. */
    static final List<Map<String, Object>> SWIFT_STATUS_TABLE = Collections.unmodifiableList(Arrays.asList(
            row("BANK_AUTHORIZED", "instruction accepted, signatures verified", "ACTC", ""),
            row("TRAVEL_RULE_PENDING", "waiting for the beneficiary institution", "PDNG", "TRAVEL_RULE_PENDING"),
            row("TRAVEL_RULE_PENDING", "the beneficiary institution asked a question", "PDNG", "RFI"),
            row("PAYOUT_PRE_APPROVED", "the beneficiary institution approved the payout", "ACSP", "PAYOUT_PRE_APPROVED"),
            row("ONCHAIN_SETTLED", "the settlement transfer is confirmed", "ACSP", "ONCHAIN_SETTLED"),
            row("PAYOUT_IN_PROGRESS", "local payout under way", "ACSP", "PAYOUT_IN_PROGRESS"),
            row("PAYOUT_IN_PROGRESS", "payout reported without signed proof", "PDNG", "EVIDENCE_INSUFFICIENT"),
            row("PAYOUT_IN_PROGRESS", "local payout failed, the funds are on their way back", "PDNG", "PAYOUT_FAILED"),
            row("BENEFICIARY_CREDIT_CONFIRMED", "credit confirmed by signed evidence", "ACCC", ""),
            row("EVIDENCE_ANCHORED", "credit confirmed and the evidence anchored", "ACCC", ""),
            row("CANCELLED", "cancelled at the bank's request", "RJCT", "CANCELLED_BY_BANK"),
            row("CANCELLED", "refused by the beneficiary institution", "RJCT", "TRAVEL_RULE_REJECTED"),
            row("RETURNED", "local payout failed and the funds came back", "RJCT", "RETURNED"),
            row("EXCEPTION", "stopped for manual follow-up", "PDNG", "EXCEPTION")));

    private static Map<String, Object> row(String state, String when, String code, String reason) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", state);
        out.put("when", when);
        out.put("code", code);
        out.put("reason", reason);
        return Collections.unmodifiableMap(out);
    }

    // ── The view, read as any JSON may be ───────────────────────────────────

    /**
     * A field the object carries. Anything else — a value that is not an
     * object, a name it does not hold — reads as absent ({@code null}):
     * nothing is asked of a value from the view before its kind is known.
     */
    private static Object field(Object o, String name) {
        return o instanceof Map ? ((Map<?, ?>) o).get(name) : null;
    }

    /** What an event's payload says under {@code name}. */
    private static Object said(Object event, String name) {
        return field(field(event, "payload"), name);
    }

    private static String text(Object v) {
        return v instanceof String ? (String) v : "";
    }

    /** The view's events. A list that is not a list is no events; an entry that is not an object is an event of no type. */
    private static List<?> eventsOf(Object view) {
        Object events = field(view, "events");
        return events instanceof List ? (List<?>) events : Collections.emptyList();
    }

    private static String typeOf(Object event) {
        return text(field(event, "type"));
    }

    private static final Pattern ISO_TIME =
            Pattern.compile("(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(?:Z|[+-](\\d{2}):(\\d{2}))");

    /**
     * The form the platform writes a time in: {@code 2026-11-17T09:30:00.000Z},
     * or with an offset instead of {@code Z}. A time in any other form —
     * "yesterday", a number, a date alone, a time without a zone, a day the
     * calendar does not have — is no time ({@code null}): the report's
     * date-time elements are left out rather than written with a value the
     * schema refuses or a reader could take two ways.
     */
    static String isoTime(Object v) {
        if (!(v instanceof String)) {
            return null;
        }
        Matcher m = ISO_TIME.matcher((String) v);
        if (!m.matches()) {
            return null;
        }
        int year = Integer.parseInt(m.group(1));
        int month = Integer.parseInt(m.group(2));
        int day = Integer.parseInt(m.group(3));
        int offsetHours = m.group(7) == null ? 0 : Integer.parseInt(m.group(7));
        int offsetMinutes = m.group(8) == null ? 0 : Integer.parseInt(m.group(8));
        boolean leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        int[] lengths = {31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        int days = month >= 1 && month <= 12 ? lengths[month - 1] : 0;
        boolean fits = year >= 1 && day >= 1 && day <= days && Integer.parseInt(m.group(4)) <= 23 && Integer.parseInt(m.group(5)) <= 59
                && Integer.parseInt(m.group(6)) <= 59 && offsetMinutes <= 59 && offsetHours * 60 + offsetMinutes <= 14 * 60;
        return fits ? (String) v : null;
    }

    private static String timeOf(Object event) {
        return isoTime(field(event, "at"));
    }

    /**
     * The events after which a question of the beneficiary institution is no
     * longer open: the bank's answer delivered, the institution's acceptance
     * or its refusal. A question asked after the last of them is open.
     */
    private static final List<String> TRAVEL_RULE_ANSWERED =
            Arrays.asList("TRAVEL_RULE_RFI_RESOLVED", "TRAVEL_RULE_RECEIVED", "TRAVEL_RULE_REJECTED");

    private static int lastAt(List<?> events, String type) {
        for (int i = events.size() - 1; i >= 0; i--) {
            if (typeOf(events.get(i)).equals(type)) {
                return i;
            }
        }
        return -1;
    }

    private static Object last(List<?> events, String type) {
        int i = lastAt(events, type);
        return i == -1 ? null : events.get(i);
    }

    private static Object first(List<?> events, String type) {
        for (Object e : events) {
            if (typeOf(e).equals(type)) {
                return e;
            }
        }
        return null;
    }

    // ── The status ──────────────────────────────────────────────────────────

    /** What every status of one view shares: its state, and when the instruction was accepted. */
    private static final class Context {
        final String state;
        final String accepted;

        Context(String state, String accepted) {
            this.state = state;
            this.accepted = accepted;
        }
    }

    /**
     * Every status names the time it reflects: an event's own, or none — a
     * missing time is never filled in with another event's.
     */
    private static SwiftStatus make(Context c, String code, String reason, List<String> detail, boolean isFinal, String at) {
        SwiftStatus s = new SwiftStatus();
        s.code = code;
        s.meaning = MEANING.get(code);
        s.state = c.state;
        s.reason = reason.isEmpty() ? null : reason;
        s.detail.addAll(detail);
        s.isFinal = isFinal;
        s.at = at;
        s.acceptedAt = c.accepted;
        return s;
    }

    /** The entries that say something: an empty one is left out. */
    private static List<String> nonEmpty(String... values) {
        List<String> out = new ArrayList<>();
        for (String v : values) {
            if (!v.isEmpty()) {
                out.add(v);
            }
        }
        return out;
    }

    /** The ISO 20022 status of a settlement, from its view. */
    static SwiftStatus statusOf(Object view) {
        List<?> events = eventsOf(view);
        Object given = field(view, "state");
        // A state that is not text is a state the table does not know.
        String state = given instanceof String ? (String) given : "UNKNOWN";
        Object acceptance = first(events, "REQUEST_ACCEPTED");
        Context c = new Context(state, timeOf(acceptance != null ? acceptance : events.isEmpty() ? null : events.get(0)));
        // A status that no single event explains takes the time of the latest one.
        String latest = timeOf(events.isEmpty() ? null : events.get(events.size() - 1));

        switch (state) {
            case "REQUEST_ACCEPTED":
            case "BANK_AUTHORIZED":
                return make(c, "ACTC", "", Collections.emptyList(), false, latest);
            case "TRAVEL_RULE_PENDING": {
                // A question is open when it was asked after the last answer, acceptance
                // or refusal — a second question after an answered first one is open too.
                int asked = lastAt(events, "TRAVEL_RULE_RFI");
                int answered = -1;
                for (String type : TRAVEL_RULE_ANSWERED) {
                    answered = Math.max(answered, lastAt(events, type));
                }
                if (asked > answered) {
                    Object rfi = events.get(asked);
                    Object questions = said(rfi, "questions");
                    // A question is given in words when it is text, a number or true/false; anything else is not guessed at.
                    List<String> words = new ArrayList<>();
                    if (questions instanceof List) {
                        for (Object q : (List<?>) questions) {
                            if (q instanceof String) {
                                words.add((String) q);
                            } else if (q instanceof Number) {
                                words.add(numberToString(toDouble((Number) q)));
                            } else if (q instanceof Boolean) {
                                words.add(q.toString());
                            }
                        }
                    }
                    SwiftStatus s = make(c, "PDNG", "RFI", words, false, timeOf(rfi));
                    s.needs = "bank_answer";
                    return s;
                }
                return make(c, "PDNG", "TRAVEL_RULE_PENDING", Collections.emptyList(), false, latest);
            }
            case "PAYOUT_PRE_APPROVED":
                return make(c, "ACSP", "PAYOUT_PRE_APPROVED", Collections.emptyList(), false, latest);
            case "ONCHAIN_SETTLED":
                return make(c, "ACSP", "ONCHAIN_SETTLED", Collections.emptyList(), false, latest);
            case "PAYOUT_IN_PROGRESS": {
                // The payout failed and the return has not arrived yet: no longer "in process".
                Object failed = last(events, "PAYOUT_FAILED");
                if (failed != null) {
                    return make(c, "PDNG", "PAYOUT_FAILED",
                            nonEmpty("The local payout failed; the settlement funds are being returned.", text(said(failed, "reason"))),
                            false, timeOf(failed));
                }
                Object held = last(events, "EVIDENCE_INSUFFICIENT");
                if (held != null) {
                    return make(c, "PDNG", "EVIDENCE_INSUFFICIENT",
                            nonEmpty("The payout was reported without signed proof of credit; confirmation is withheld until it arrives."),
                            false, timeOf(held));
                }
                return make(c, "ACSP", "PAYOUT_IN_PROGRESS", Collections.emptyList(), false, latest);
            }
            case "BENEFICIARY_CREDIT_CONFIRMED":
            case "EVIDENCE_ANCHORED": {
                // The time of the credit is the payout's own: without a payout event, no time.
                Object done = last(events, "PAYOUT_COMPLETED");
                String ref = text(said(done, "bank_reference"));
                SwiftStatus s = make(c, "ACCC", "", Collections.emptyList(), true, timeOf(done));
                if (!ref.isEmpty()) {
                    s.creditReference = ref;
                }
                return s;
            }
            case "CANCELLED": {
                Object refused = last(events, "TRAVEL_RULE_REJECTED");
                if (refused != null) {
                    return make(c, "RJCT", "TRAVEL_RULE_REJECTED", nonEmpty(text(said(refused, "reason"))), true, timeOf(refused));
                }
                Object asked = last(events, "CANCEL_REQUESTED");
                return make(c, "RJCT", "CANCELLED_BY_BANK", nonEmpty(text(said(asked, "reason"))), true, timeOf(asked));
            }
            case "RETURNED": {
                Object failed = last(events, "PAYOUT_FAILED");
                Object back = last(events, "USDC_RETURNED");
                String tx = text(said(back, "tx_hash"));
                return make(c, "RJCT", "RETURNED",
                        nonEmpty(text(said(failed, "reason")), tx.isEmpty() ? "" : "Settlement funds returned in transaction " + tx + "."),
                        true, timeOf(back != null ? back : failed));
            }
            case "EXCEPTION": {
                Object ex = last(events, "EXCEPTION");
                // Its outcome is not settled, and nothing moves it on by itself: the
                // platform sends no further status of its own. The report says so in
                // words, because PDNG alone reads as "an update will follow".
                SwiftStatus s = make(c, "PDNG", "EXCEPTION",
                        nonEmpty("Processing stopped. No further status follows automatically; the payment is resolved by a person.",
                                text(said(ex, "error"))),
                        false, timeOf(ex));
                s.needs = "manual_resolution";
                return s;
            }
            default:
                // One value, here and in the report's Prtry (Max35Text): the state's name, tidied once.
                return make(c, "PDNG", max(state, 35), Collections.emptyList(), false, latest);
        }
    }

    private static final List<String> REFERENCE_KEYS =
            Arrays.asList("messageId", "instructionId", "paymentInfoId", "endToEndId", "uetr", "valueDate", "content");

    /**
     * The reference to the bank's message that the bank signed into its
     * instruction, or null: {@code type}, {@code sha256}, {@code index} and
     * whichever of {@code messageId}, {@code instructionId},
     * {@code paymentInfoId}, {@code endToEndId}, {@code uetr},
     * {@code valueDate}, {@code content} it states.
     */
    static Map<String, Object> sourceMessageOf(Object view) {
        Object ref = field(said(first(eventsOf(view), "BANK_EVIDENCE_SUBMITTED"), "bankInstruction"), "sourceMessage");
        Object type = field(ref, "type");
        Object sha256 = field(ref, "sha256");
        if (!(type instanceof String) || !(sha256 instanceof String)) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", type);
        out.put("sha256", sha256);
        Object index = field(ref, "index");
        if (index instanceof Number) {
            out.put("index", jsonNumber((Number) index));
        }
        for (String k : REFERENCE_KEYS) {
            Object val = field(ref, k);
            if (val instanceof String && !((String) val).isEmpty()) {
                out.put(k, val);
            }
        }
        return out;
    }

    // ── The report ──────────────────────────────────────────────────────────

    /** The characters XML 1.0 does not allow anywhere (tab, line feed and carriage return aside). */
    private static final Pattern NOT_XML = Pattern.compile("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uFFFE\\uFFFF]");
    private static final Pattern UUID_V4 = Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}");
    private static final Pattern TRAILING_SPACE = Pattern.compile(Js.WS + "+\\z");
    private static final Pattern SPACE = Pattern.compile(Js.WS);

    private static final DateTimeFormatter ISO_MILLIS =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** The text without half surrogate pairs: a pair is kept whole, a half that stands alone is dropped. */
    private static String withoutHalves(String s) {
        StringBuilder out = null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean pair = Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1));
            if (Character.isSurrogate(c) && !pair) {
                if (out == null) {
                    out = new StringBuilder(s.length()).append(s, 0, i);
                }
                continue;
            }
            if (out != null) {
                out.append(c);
                if (pair) {
                    out.append(s.charAt(i + 1));
                }
            }
            if (pair) {
                i++;
            }
        }
        return out == null ? s : out.toString();
    }

    /**
     * Text from another system, made fit for the report before anything is
     * measured: characters XML does not allow are removed first, so that a
     * value made only of them is seen to be empty — and left out — instead of
     * being written as an element the schema refuses. Half of a surrogate
     * pair is one of them, and goes before the rest: two halves that stood
     * apart are never joined into a character the text did not have.
     */
    static String tidy(String s) {
        return Js.trim(Js.collapse(NOT_XML.matcher(withoutHalves(s)).replaceAll("")));
    }

    /**
     * The first {@code n} characters of {@code s}, counted by code point as
     * the schema counts a length: a surrogate pair is never cut in two.
     * {@code s} itself when it fits.
     */
    private static String firstCodePoints(String s, int n) {
        int units = 0;
        int count = 0;
        while (units < s.length()) {
            if (count++ == n) {
                return s.substring(0, units);
            }
            units += Character.charCount(s.codePointAt(units));
        }
        return s;
    }

    /** Tidy, cut to {@code n} characters, and tidy still: a cut that ends on a space does not keep it. */
    private static String max(String s, int n) {
        return TRAILING_SPACE.matcher(firstCodePoints(tidy(s), n)).replaceFirst("");
    }

    /**
     * Split text into chunks that fit {@code AddtlInf} (Max105Text), breaking
     * at spaces where it can. Counted by code point, like every length in the
     * report. One pass over the text, however long it is.
     */
    private static List<String> chunks105(String s) {
        List<String> out = new ArrayList<>();
        String all = tidy(s);
        int end = all.length();
        int start = 0;
        for (;;) {
            // Look at the next 106 characters: where the 106th starts, and the last
            // space among the 61st to the 106th — a break earlier than that wastes the line.
            int units = start;
            int count = 0;
            int space = -1;
            while (units < end) {
                int ch = all.codePointAt(units);
                if (ch == ' ' && count >= 60) {
                    space = units;
                }
                if (count == 105) {
                    break;
                }
                units += Character.charCount(ch);
                count++;
            }
            if (units == end) {
                break;
            }
            int cut = space == -1 ? units : space;
            out.add(Js.trim(all.substring(start, cut)));
            start = cut;
            while (start < end && SPACE.matcher(all.subSequence(start, start + 1)).matches()) {
                start++;
            }
        }
        if (start < end) {
            out.add(all.substring(start));
        }
        return out;
    }

    /**
     * A {@code pacs.002.001.10} status report for one settlement.
     *
     * <p>{@code OrgnlGrpInf}, {@code OrgnlInstrId}, {@code OrgnlEndToEndId} and
     * {@code OrgnlUETR} are filled from the reference the bank signed into its
     * instruction; a settlement that did not come from a SWIFT message gets a
     * report without them. A UETR the schema's pattern does not take is given
     * in words, under {@code AddtlInf}.
     *
     * @param messageIdOption override the report's own message id (Max35Text), or null
     * @param createdAtOption override the creation time, for reproducible output, or null; one that is not in
     *                        the ISO 8601 form the platform writes is not used
     */
    static String buildPacs002(Object view, String messageIdOption, String createdAtOption) {
        SwiftStatus status = statusOf(view);
        Map<String, Object> src = sourceMessageOf(view);
        List<?> events = eventsOf(view);
        // The report is named after the payment and its latest event. A number that
        // is not a whole number from 0 counts as 0: an id never reads "undefined".
        Object lastSeq = field(events.isEmpty() ? null : events.get(events.size() - 1), "seq");
        long seq = 0;
        if (lastSeq instanceof Number) {
            double d = toDouble((Number) lastSeq);
            if (d == Math.rint(d) && d >= 0 && d <= MAX_SAFE_INTEGER) {
                seq = (long) d;
            }
        }
        String paymentId = tidy(text(field(view, "payment_id")));
        String idBase = paymentId + "-" + seq;
        // Where the two do not fit in 35 characters, the payment id is cut and the number kept whole.
        String derived = paymentId.isEmpty() ? "" : firstCodePoints(idBase, 35).equals(idBase) ? idBase
                : max(paymentId, Math.min(28, 34 - Long.toString(seq).length())) + "-" + seq;
        String messageId = max(messageIdOption != null ? messageIdOption : derived, 35);
        if (messageId.isEmpty()) {
            messageId = "STATUS-" + seq;
        }
        // CreDtTm cannot be left out: a given time not in the ISO 8601 form is not
        // used, and the report states when it was made.
        String createdAt = isoTime(createdAtOption);
        if (createdAt == null) {
            createdAt = ISO_MILLIS.format(Instant.now());
        }

        List<String> lines = new ArrayList<>(Arrays.asList(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                "<Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10\">",
                "  <FIToFIPmtStsRpt>",
                "    <GrpHdr>",
                "      <MsgId>" + xmlEscape(messageId) + "</MsgId>",
                "      <CreDtTm>" + xmlEscape(createdAt) + "</CreDtTm>",
                "    </GrpHdr>",
                "    <TxInfAndSts>"));
        identifier(lines, "StsId", paymentId, "      ");
        // The group is written with both of its elements or not at all: the schema
        // requires the message's name beside its id.
        String groupId = src == null ? "" : max(text(src.get("messageId")), 35);
        String groupName = src == null ? "" : max(text(src.get("type")), 35);
        if (!groupId.isEmpty() && !groupName.isEmpty()) {
            lines.add("      <OrgnlGrpInf>");
            identifier(lines, "OrgnlMsgId", groupId, "        ");
            identifier(lines, "OrgnlMsgNmId", groupName, "        ");
            lines.add("      </OrgnlGrpInf>");
        }
        identifier(lines, "OrgnlInstrId", src == null ? "" : text(src.get("instructionId")), "      ");
        identifier(lines, "OrgnlEndToEndId", src == null ? "" : text(src.get("endToEndId")), "      ");
        // The schema takes a UETR only as a lower-case version-4 UUID. One it does
        // not take — another version, capitals — is given in words, never dropped.
        String uetr = src == null ? "" : tidy(text(src.get("uetr")));
        boolean uetrFits = UUID_V4.matcher(uetr).matches();
        if (uetrFits) {
            lines.add("      <OrgnlUETR>" + xmlEscape(uetr) + "</OrgnlUETR>");
        }
        lines.add("      <TxSts>" + status.code + "</TxSts>");
        // A credit reference too long for its own element is given in words rather than cut short.
        String reference = status.creditReference == null ? "" : tidy(status.creditReference);
        boolean referenceFits = firstCodePoints(reference, 35).equals(reference);
        List<String> detail = new ArrayList<>();
        for (String d : status.detail) {
            detail.addAll(chunks105(d));
        }
        if (!uetr.isEmpty() && !uetrFits) {
            detail.addAll(chunks105("UETR " + uetr));
        }
        if (!reference.isEmpty() && !referenceFits) {
            detail.addAll(chunks105("Credit reference " + reference));
        }
        // The status's own reason, tidied once where it was made: the report and the status say the same word.
        String reason = status.reason == null ? "" : status.reason;
        if (!reason.isEmpty() || !detail.isEmpty()) {
            lines.add("      <StsRsnInf>");
            if (!reason.isEmpty()) {
                lines.add("        <Rsn><Prtry>" + xmlEscape(reason) + "</Prtry></Rsn>");
            }
            for (String d : detail) {
                lines.add("        <AddtlInf>" + xmlEscape(d) + "</AddtlInf>");
            }
            lines.add("      </StsRsnInf>");
        }
        // The acceptance time is when the instruction was accepted — whatever the
        // status now is. The time of the credit goes where the schema puts it.
        if (status.acceptedAt != null) {
            lines.add("      <AccptncDtTm>" + xmlEscape(status.acceptedAt) + "</AccptncDtTm>");
        }
        if (status.code.equals("ACCC") && status.at != null) {
            lines.add("      <FctvIntrBkSttlmDt>");
            lines.add("        <DtTm>" + xmlEscape(status.at) + "</DtTm>");
            lines.add("      </FctvIntrBkSttlmDt>");
        }
        if (!reference.isEmpty() && referenceFits) {
            lines.add("      <AcctSvcrRef>" + xmlEscape(reference) + "</AcctSvcrRef>");
        }
        lines.add("    </TxInfAndSts>");
        lines.add("  </FIToFIPmtStsRpt>");
        lines.add("</Document>");
        lines.add("");
        return String.join("\n", lines);
    }

    /** An identifier that is empty once cleaned is left out, never written empty. */
    private static void identifier(List<String> lines, String name, String value, String indent) {
        String v = value.isEmpty() ? "" : max(value, 35);
        if (!v.isEmpty()) {
            lines.add(indent + "<" + name + ">" + xmlEscape(v) + "</" + name + ">");
        }
    }

    /** {@code xmlEscape} of the reference's {@code xml.ts}: the XML reader of this package owns it. */
    private static String xmlEscape(String text) {
        return XmlReader.xmlEscape(text);
    }

    // ── Numbers, as JavaScript writes them ──────────────────────────────────

    /** The JavaScript number a JSON number becomes: a double, rounded as JSON.parse rounds. */
    private static double toDouble(Number n) {
        if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) {
            return (double) n.longValue();
        }
        if (n instanceof Double || n instanceof Float) {
            return n.doubleValue();
        }
        try {
            return Double.parseDouble(n.toString());
        } catch (NumberFormatException e) {
            return n.doubleValue();
        }
    }

    /**
     * {@code Number.prototype.toString()}: the shortest digits that read back
     * as the same double (the closest of them, an even last digit on a tie),
     * written plainly from 1e-6 to below 1e21 and with an exponent outside.
     * {@link Double#toString} is not that function: its digits are not always
     * the shortest, and it writes {@code 1.0E21} where JavaScript writes {@code 1e+21}.
     */
    static String numberToString(double d) {
        if (Double.isNaN(d)) {
            return "NaN";
        }
        if (d == 0) {
            return "0";
        }
        if (Double.isInfinite(d)) {
            return d > 0 ? "Infinity" : "-Infinity";
        }
        if (d < 0) {
            return "-" + numberToString(-d);
        }
        BigDecimal exact = new BigDecimal(d);
        BigDecimal best = null;
        // Seventeen significant digits always read back as the same double, so the loop ends by then.
        for (int p = 1; best == null && p <= 17; p++) {
            BigDecimal down = exact.round(new MathContext(p, RoundingMode.DOWN));
            BigDecimal up = exact.round(new MathContext(p, RoundingMode.UP));
            boolean downReads = Double.parseDouble(down.toString()) == d;
            boolean upReads = Double.parseDouble(up.toString()) == d;
            if (downReads && upReads) {
                int closer = exact.subtract(down).compareTo(up.subtract(exact));
                best = closer < 0 ? down : closer > 0 ? up : !down.unscaledValue().testBit(0) ? down : up;
            } else if (downReads) {
                best = down;
            } else if (upReads) {
                best = up;
            }
        }
        if (best == null) {
            throw new IllegalStateException("no decimal of 17 digits reads back as " + d);
        }
        best = best.stripTrailingZeros();
        String digits = best.unscaledValue().toString();
        int k = digits.length();
        int n = k - best.scale();
        if (k <= n && n <= 21) {
            return digits + zeros(n - k);
        }
        if (0 < n && n <= 21) {
            return digits.substring(0, n) + "." + digits.substring(n);
        }
        if (-6 < n && n <= 0) {
            return "0." + zeros(-n) + digits;
        }
        int e = n - 1;
        String exponent = "e" + (e < 0 ? "-" : "+") + Math.abs(e);
        return k == 1 ? digits + exponent : digits.charAt(0) + "." + digits.substring(1) + exponent;
    }

    private static String zeros(int count) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append('0');
        }
        return out.toString();
    }

    /**
     * A JSON number as JSON.stringify writes the JavaScript number it becomes:
     * an integer as a Long, another finite value as the decimal JavaScript
     * prints, and a value beyond the double range — Infinity — as null.
     */
    static Object jsonNumber(Number n) {
        if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) {
            long v = n.longValue();
            if (v >= -MAX_SAFE_INTEGER && v <= MAX_SAFE_INTEGER) {
                return v;
            }
        }
        double d = toDouble(n);
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            return null;
        }
        if (d == Math.rint(d) && Math.abs(d) <= MAX_SAFE_INTEGER) {
            return (long) d;
        }
        return new BigDecimal(numberToString(d));
    }
}
