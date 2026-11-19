package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Hex;
import com.stonehash.attest.remit.Json;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A {@link SwiftPayment} → what a settlement instruction needs.
 *
 * <p>The mapping is a table, and the table is the product: for every value the
 * instruction carries it records where in the bank's message it came from and
 * on what basis —
 *
 * <pre>
 *   stated     taken verbatim from the message
 *   inferred   derived from something the message does state (a country
 *              from an agent's BIC), and reported as such
 *   supplied   given by the bank outside the message (its customer master)
 * </pre>
 *
 * <p>— and for everything the corridor requires that the message does not
 * carry, an issue that names the missing element in the message's own
 * vocabulary and says how to provide it. Nothing is guessed silently and
 * nothing in the message is dropped silently: content with no place in the
 * corridor is listed under {@code unmapped} with the reason.
 */
public final class SwiftMapper {
    private SwiftMapper() {
    }

    private static final Pattern NOT_PROVIDED = Pattern.compile("^(NOTPROVIDED|NONREF|NOREF)\\z", Pattern.CASE_INSENSITIVE);

    /**
     * The payment's own reference, trimmed — or {@code null} when it gives none: an empty
     * value, or one of the words the standards write where there is no reference
     * ({@code NOTPROVIDED}, {@code NONREF}, {@code NOREF}), in any case and whatever white
     * space surrounds it. The one notion of "no reference", wherever a reference is read.
     */
    static String ownReference(String value) {
        if (value == null) {
            return null;
        }
        String t = Js.trim(value);
        return !t.isEmpty() && !Js.test(NOT_PROVIDED, t) ? t : null;
    }

    /** A value as the message states it, trimmed. An empty one, or white space alone, is no value. */
    static String given(String value) {
        if (value == null) {
            return null;
        }
        String t = Js.trim(value);
        return t.isEmpty() ? null : t;
    }

    private static final Pattern PLAIN_DECIMAL = Pattern.compile("^(\\d+)(?:\\.(\\d+))?\\z");
    private static final Pattern LEADING_ZEROS = Pattern.compile("^0+");

    /**
     * Two amounts compared exactly, as the decimal strings they are ({@code 12500.00},
     * {@code 7000.5}): -1, 0 or 1 as {@code a} is less than, equal to or more than {@code b};
     * {@code null} when either is not a plain decimal — digits, then optionally a full stop
     * and digits. Never as floating-point numbers: past the fifteenth significant digit, two
     * different amounts are the same number.
     */
    static Integer compareDecimal(String a, String b) {
        Matcher x = PLAIN_DECIMAL.matcher(a);
        Matcher y = PLAIN_DECIMAL.matcher(b);
        if (!x.find() || !y.find()) {
            return null;
        }
        String xWhole = LEADING_ZEROS.matcher(x.group(1)).replaceFirst("");
        String yWhole = LEADING_ZEROS.matcher(y.group(1)).replaceFirst("");
        if (xWhole.length() != yWhole.length()) {
            return xWhole.length() < yWhole.length() ? -1 : 1;
        }
        // Whole parts of one length, fractions padded to one length: the digits compare as text.
        String xFrac = x.group(2) == null ? "" : x.group(2);
        String yFrac = y.group(2) == null ? "" : y.group(2);
        int width = Math.max(xFrac.length(), yFrac.length());
        String xDigits = xWhole + padEnd(xFrac, width);
        String yDigits = yWhole + padEnd(yFrac, width);
        int order = xDigits.compareTo(yDigits);
        return order == 0 ? 0 : order < 0 ? -1 : 1;
    }

    private static String padEnd(String s, int width) {
        StringBuilder out = new StringBuilder(s);
        while (out.length() < width) {
            out.append('0');
        }
        return out.toString();
    }

    /** The first {@code n} characters of {@code s}, counted by code point: a surrogate pair is never cut in two. */
    private static String firstCodePoints(String s, int n) {
        int count = s.codePointCount(0, s.length());
        return count <= n ? s : s.substring(0, s.offsetByCodePoints(0, n));
    }
    private static final Pattern TRAILING_ZEROS = Pattern.compile("0+\\z");
    private static final Pattern TRAILING_POINT = Pattern.compile("\\.\\z");
    private static final Pattern TRADE_AMOUNT = Pattern.compile("^\\d+(\\.\\d{1,2})?\\z");
    private static final Pattern ZERO_AMOUNT = Pattern.compile("^0+(\\.0+)?\\z");
    private static final Pattern DIGIT_FIRST = Pattern.compile("^\\d");

    /** Where each family carries a thing — used in the mapping table and in issues. */
    private static final class Vocabulary {
        String debtorName;
        String debtorAddress;
        String debtorCountry;
        String debtorId;
        String debtorAccount;
        String debtorAgent;
        String creditorName;
        String creditorCountry;
        String creditorAccount;
        String creditorAgent;
        String amount;
        String settled;
        String instructed;
        String invoice;
        String purpose;
        String charges;
        String rate;
        String valueDate;
        String intermediary;
        String regulatory;
        String chargeAmounts;
        /** In the reference's table; nothing reads it. */
        String person;
        String debtorParty;
        String creditorParty;
    }

    private static Vocabulary vocabulary(SwiftPayment p) {
        Vocabulary v = new Vocabulary();
        if ("MT103".equals(p.format)) {
            v.debtorName = "field 50a (name line)";
            v.debtorAddress = "field 50a (address lines)";
            v.debtorCountry = "field 50F line 3/ or field 77B /ORDERRES/";
            v.debtorId = "field 50F party identifier or line 6/ 7/";
            v.debtorAccount = "field 50a (/account line)";
            v.debtorAgent = "field 52A or the sender BIC";
            v.creditorName = "field 59a (name line)";
            v.creditorCountry = "field 59F line 3/ or field 77B /BENEFRES/";
            v.creditorAccount = "field 59a (/account line)";
            v.creditorAgent = "field 57a or the receiver BIC";
            v.amount = "field 32A";
            v.settled = "field 32A";
            v.instructed = "field 33B";
            v.invoice = "field 70 /INV/";
            v.purpose = "field 26T";
            v.charges = "field 71A";
            v.rate = "field 36";
            v.valueDate = "field 32A";
            v.intermediary = "field 56a";
            v.regulatory = "field 77B";
            v.chargeAmounts = "field 71F / 71G";
            v.person = "field 50F";
            v.debtorParty = "field 50";
            v.creditorParty = "field 59";
            return v;
        }
        boolean pain = "pain.001".equals(p.format);
        String tx = pain ? "PmtInf" : "CdtTrfTxInf";
        v.debtorName = tx + "/Dbtr/Nm";
        v.debtorAddress = tx + "/Dbtr/PstlAdr";
        v.debtorCountry = tx + "/Dbtr/PstlAdr/Ctry";
        v.debtorId = tx + "/Dbtr/Id/OrgId (LEI or Othr/Id)";
        v.debtorAccount = tx + "/DbtrAcct/Id";
        v.debtorAgent = tx + "/DbtrAgt/FinInstnId/BICFI";
        v.creditorName = "CdtTrfTxInf/Cdtr/Nm";
        v.creditorCountry = "CdtTrfTxInf/Cdtr/PstlAdr/Ctry";
        v.creditorAccount = "CdtTrfTxInf/CdtrAcct/Id";
        v.creditorAgent = "CdtTrfTxInf/CdtrAgt/FinInstnId";
        v.amount = pain ? "CdtTrfTxInf/Amt" : "CdtTrfTxInf/IntrBkSttlmAmt";
        v.settled = "CdtTrfTxInf/IntrBkSttlmAmt";
        v.instructed = pain ? "CdtTrfTxInf/Amt/InstdAmt" : "CdtTrfTxInf/InstdAmt";
        v.invoice = "CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)";
        v.purpose = "CdtTrfTxInf/Purp";
        v.charges = "ChrgBr";
        v.rate = "XchgRate";
        v.valueDate = pain ? "PmtInf/ReqdExctnDt" : "IntrBkSttlmDt";
        v.intermediary = "IntrmyAgt1…3";
        v.regulatory = "RgltryRptg";
        v.chargeAmounts = "ChrgsInf";
        v.person = "Id/PrvtId";
        v.debtorParty = tx + "/Dbtr";
        v.creditorParty = "CdtTrfTxInf/Cdtr";
        return v;
    }

    /**
     * A fingerprint of the payment a message describes — not of the message.
     *
     * <p>Covered: the instructed and the settlement amount, the debtor's and
     * the creditor's name and account, the instruction, end-to-end and
     * transaction identifiers, the invoice references and the remittance text.
     * Left out on purpose: everything that changes when the same payment is
     * written out again — the message id, the creation time, the value date,
     * whitespace — and the UETR, which is the reference being checked. Agents
     * are left out too: the same MT103 names its receiver in a header block
     * that an exporter may strip.
     */
    public static String contentDigest(SwiftPayment payment) {
        String own = ownReference(payment.endToEndId);
        String e2e = own == null ? "" : own;
        List<Object> invoices = new ArrayList<>();
        for (String r : payment.invoiceReferences) {
            invoices.add(tidy(r));
        }
        List<Object> remittance = new ArrayList<>();
        for (String r : payment.remittanceInformation) {
            remittance.add(tidy(r));
        }
        List<Object> value = new ArrayList<>(Arrays.<Object>asList(
                "stonehash:swift:content:v1",
                money(payment.instructedAmount), money(payment.settlementAmount), money(payment.amount),
                tidy(payment.debtor.name), tidy(payment.debtor.account),
                tidy(payment.creditor.name), tidy(payment.creditor.account),
                tidy(payment.instructionId), tidy(e2e), tidy(payment.transactionId),
                invoices, remittance));
        // JSON.stringify escapes an unpaired surrogate, so the text always has a UTF-8 form.
        return Hex.sha256Hex(Json.compact(value));
    }

    /** {@code (v ?? '').replace(/\s+/g, ' ').trim()}. */
    private static String tidy(String v) {
        return Js.trim(Js.collapse(Js.or(v, "")));
    }

    /** {@code currency value}, the value without trailing zeros after its point; {@code ''} for no amount. */
    private static String money(SwiftAmount a) {
        return a == null ? "" : a.currency() + " " + withoutTrailingZeros(a.value());
    }

    /** {@code value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value}. */
    private static String withoutTrailingZeros(String value) {
        return value.contains(".") ? Js.replaceFirst(Js.replaceFirst(value, TRAILING_ZEROS, ""), TRAILING_POINT, "") : value;
    }

    /** Map one parsed payment. Never throws for missing data — it reports. Null options are the defaults. */
    public static SwiftMapping map(SwiftPayment payment, SwiftMappingOptions options) {
        SwiftMappingOptions opts = options == null ? new SwiftMappingOptions() : options;
        Vocabulary v = vocabulary(payment);
        Map<String, Object> sup = opts.supplement() == null ? new LinkedHashMap<>() : opts.supplement();
        String tradeCurrency = Js.or(given(opts.tradeCurrency()), "USD");
        Table t = new Table();
        boolean infer = opts.inferCountryFromBic();

        // ── Amount ───────────────────────────────────────────────────────────────
        // The trade amount is what the beneficiary is owed, and what the bank
        // collected for. Where the message states both an instructed and an
        // interbank amount in the corridor's currency, that is the smaller of the
        // two: with the charges on the beneficiary or shared, the interbank amount
        // is the instructed one less what was deducted; with the charges on the
        // debtor, the interbank amount may be the instructed one plus charges
        // prepaid for the receiving bank, which are not the beneficiary's money.
        SwiftAmount settled = payment.settlementAmount;
        SwiftAmount instructed = payment.instructedAmount;
        SwiftAmount amount = payment.amount;
        String amountSource = v.amount;
        if (settled != null && tradeCurrency.equals(settled.currency()) && instructed != null && tradeCurrency.equals(instructed.currency())) {
            // Compared as the decimals they are: as floating-point numbers, two amounts
            // that differ past the fifteenth significant digit compared equal, and the
            // larger was taken. One that is not a plain decimal cannot be put in
            // order — it is the one taken, so that the check below refuses it by name.
            Integer order = compareDecimal(instructed.value(), settled.value());
            boolean useInstructed = order == null ? !Js.test(PLAIN_DECIMAL, instructed.value()) : order < 0;
            amount = useInstructed ? instructed : settled;
            amountSource = useInstructed ? v.instructed : v.settled;
        } else if (settled != null && tradeCurrency.equals(settled.currency())) {
            amount = settled;
            amountSource = v.settled;
        } else if (instructed != null && tradeCurrency.equals(instructed.currency())) {
            amount = instructed;
            amountSource = v.instructed;
        }
        String tradeAmount = null;
        if (!amount.currency().equals(tradeCurrency)) {
            t.missing("trade.amount", amountSource,
                    "the message instructs " + amount.value() + " " + amount.currency() + "; this corridor denominates trades in " + tradeCurrency,
                    "send the " + tradeCurrency + " amount of the trade (the corridor converts the funding and payout legs itself, from the quote)");
        } else if (!Js.test(TRADE_AMOUNT, amount.value()) || Js.test(ZERO_AMOUNT, amount.value())) {
            t.missing("trade.amount", amountSource,
                    "\"" + amount.value() + "\" is not a positive " + tradeCurrency + " amount with at most two decimals",
                    "correct the amount in the message");
        } else {
            tradeAmount = amount.value();
            t.field("trade.amount", amount.value() + " " + amount.currency(), amountSource, "stated");
        }

        // A message marked as a test is not a payment.
        // …unless this client uses a test key: then, and only then, the mark does not stop it.
        boolean testTaken = payment.test != null && opts.allowTestMessages();
        if (payment.test != null && !testTaken) {
            t.missing("instruction", payment.test.where(),
                    template(payment.test.what()) + " — the message is marked as a test and must not be executed as a payment",
                    "send it as a real payment; a test message is taken only with a test key");
        }

        // ── Debtor (the Travel Rule originator) ──────────────────────────────────
        boolean mt = "MT103".equals(payment.format);
        // The corridor's Travel Rule data describes two companies. A party the
        // message identifies as a private person would be sent as a legal person.
        SwiftParty d = payment.debtor;
        Object supDebtor = sup.get("debtor");
        if (d.person()) {
            refusePerson(t, mt, "debtor", v.debtorParty, "ordering customer");
        }
        String debtorName = t.pick("debtor.name", v.debtorName, member(supDebtor, "name"), d.name, null);
        if (debtorName == null) {
            t.missing("debtor.name", v.debtorName, "the ordering customer has no name", supplementHint("debtor.name"));
        }

        String debtorCountry = t.pick("debtor.country",
                within(mt, v.debtorParty, d.countryFrom, mt ? "field 50F line 3/" : v.debtorParty + "/PstlAdr/Ctry"),
                member(supDebtor, "country"), d.country,
                infer ? new Inferred(SwiftText.bicCountry(payment.debtorAgent == null ? null : payment.debtorAgent.bic),
                        v.debtorAgent + " (country letters of the BIC)") : null);
        if (debtorCountry == null) {
            t.missing("debtor.country", v.debtorCountry, "the ordering customer's country is not stated",
                    supplementHint("debtor.country"));
        }

        String debtorAddress = t.pick("debtor.address", v.debtorAddress, member(supDebtor, "address"),
                d.addressLines.size() > 0 ? join(d.addressLines, ", ") : null, null);
        if (debtorAddress == null) {
            t.missing("debtor.address", v.debtorAddress, "the ordering customer has no address — the receiving institution requires one",
                    supplementHint("debtor.address"));
        }

        // A BIC names the party on a network; it is not the registration number
        // the receiving institution asks for, and is not passed off as one.
        // An empty LEI is no LEI: it does not hide the identification the message does state.
        String lei = given(d.lei);
        String statedId = lei != null ? lei : given(d.identification);
        String idSource = lei != null ? v.debtorParty + "/Id/OrgId/LEI"
                : within(mt, v.debtorParty, d.identificationFrom, v.debtorId)
                        + (Js.truthy(d.identificationScheme) ? " — " + d.identificationScheme : "");
        String debtorId = t.pick("debtor.registration_number", idSource, member(supDebtor, "registration_number"), statedId, null);
        if (debtorId == null) {
            t.missing("debtor.registration_number", v.debtorId,
                    "the ordering customer carries no identification (LEI, business registration number or tax id)"
                            + (Js.truthy(d.bic) ? " — only the BIC " + d.bic + ", which is not one" : "") + "; the receiving institution requires one",
                    supplementHint("debtor.registration_number"));
        }

        String debtorAccount = t.pick("debtor.account", v.debtorAccount, member(supDebtor, "account"), d.account, null);

        // ── Creditor (the Travel Rule beneficiary) ───────────────────────────────
        SwiftParty c = payment.creditor;
        Object supCreditor = sup.get("creditor");
        if (c.person()) {
            refusePerson(t, mt, "creditor", v.creditorParty, "beneficiary");
        }
        String creditorName = t.pick("creditor.name", v.creditorName, member(supCreditor, "name"), c.name, null);
        if (creditorName == null) {
            t.missing("creditor.name", v.creditorName, "the beneficiary has no name", supplementHint("creditor.name"));
        }

        SwiftAgent agent = payment.creditorAgent;
        // From the bank's BIC, or else from the country its address states — each labelled as what it is.
        String agentBicCountry = SwiftText.bicCountry(agent == null ? null : agent.bic);
        Inferred countryOfTheBank = !infer ? null
                : Js.truthy(agentBicCountry)
                        ? new Inferred(agentBicCountry, v.creditorAgent + " (country letters of the BIC)")
                        : new Inferred(agent == null ? null : agent.country,
                                v.creditorAgent + (mt ? "" : "/PstlAdr/Ctry") + " (the country of the beneficiary's bank)");
        String creditorCountry = t.pick("creditor.country",
                within(mt, v.creditorParty, c.countryFrom, mt ? "field 59F line 3/" : v.creditorParty + "/PstlAdr/Ctry"),
                member(supCreditor, "country"), c.country, countryOfTheBank);
        if (creditorCountry == null) {
            t.missing("creditor.country", v.creditorCountry, "the beneficiary's country is not stated",
                    supplementHint("creditor.country"));
        }

        String creditorAccount = t.pick("creditor.account", v.creditorAccount, member(supCreditor, "account"), c.account, null);
        if (creditorAccount == null) {
            t.missing("creditor.account", v.creditorAccount, "the beneficiary has no account — the payout cannot be credited",
                    supplementHint("creditor.account"));
        }

        // Every identification the message gives for the beneficiary's bank is
        // carried: a name alone loses the routing number, a number alone does not
        // say which clearing system it belongs to.
        List<String> bankParts = new ArrayList<>();
        if (agent != null) {
            for (String part : Arrays.asList(
                    agent.name,
                    Js.truthy(agent.bic) ? (Js.truthy(agent.name) ? "BIC " + agent.bic : agent.bic) : null,
                    Js.truthy(agent.memberId) ? Js.or(given(agent.clearingSystem), "clearing member") + " " + agent.memberId : null)) {
                if (Js.truthy(part)) {
                    bankParts.add(part);
                }
            }
        }
        String creditorBank = t.pick("creditor.bank", v.creditorAgent, member(supCreditor, "bank"),
                bankParts.size() > 0 ? String.join(" · ", bankParts) : null, null);
        if (creditorBank == null) {
            t.missing("creditor.bank", v.creditorAgent, "the beneficiary's bank is not identified",
                    supplementHint("creditor.bank"));
        }

        // ── The route ────────────────────────────────────────────────────────────
        // Checked on what will be sent, after the customer master has had its say.
        String origin = opts.corridorOrigin();
        String destination = opts.corridorDestination();
        String fix = "send this payment through the channel you use for that route today";
        if (debtorCountry != null && !debtorCountry.equals(origin)) {
            t.missing("corridor", v.debtorCountry,
                    "the ordering customer is in " + debtorCountry + "; this corridor carries payments from " + template(origin) + " to "
                            + template(destination), fix);
        }
        if (creditorCountry != null && !creditorCountry.equals(destination)) {
            t.missing("corridor", v.creditorCountry,
                    "the beneficiary is in " + creditorCountry + "; this corridor carries payments from " + template(origin) + " to "
                            + template(destination), fix);
        }
        String payoutCountry = Js.or(SwiftText.bicCountry(agent == null ? null : agent.bic), given(agent == null ? null : agent.country));
        if (Js.truthy(payoutCountry) && !payoutCountry.equals(destination)) {
            t.missing("corridor", v.creditorAgent,
                    "the beneficiary's bank is in " + payoutCountry + "; the payout of this corridor is made in " + template(destination), fix);
        }

        // ── References ───────────────────────────────────────────────────────────
        // Trimmed before it is tested: "NOTPROVIDED" with a line end after it is still no reference.
        String e2e = ownReference(payment.endToEndId);
        String firstLine = payment.remittanceInformation.isEmpty() ? null : payment.remittanceInformation.get(0);
        // At most 64 characters, counted by code point: cut by UTF-16 unit, the line
        // could end in half of a surrogate pair, and that half was signed into the instruction.
        String remittanceLine = firstLine == null ? null : trimEnd(firstCodePoints(Js.trim(Js.collapse(firstLine)), 64));
        // The first invoice reference that says something; an empty entry is no invoice.
        String firstInvoice = null;
        for (String r : payment.invoiceReferences) {
            if (!Js.trim(r).isEmpty()) {
                firstInvoice = r;
                break;
            }
        }
        String invoiceRef = t.pick("invoice_ref", v.invoice, sup.get("invoiceRef"), firstInvoice, null);
        if (!Js.truthy(invoiceRef) && Js.truthy(e2e)) {
            invoiceRef = e2e;
            t.field("invoice_ref", e2e, "end-to-end identification (no invoice reference in the message)", "inferred");
        }
        if (!Js.truthy(invoiceRef) && Js.truthy(remittanceLine)) {
            invoiceRef = remittanceLine;
            t.field("invoice_ref", remittanceLine, "first line of the remittance information", "inferred");
        }
        if (!Js.truthy(invoiceRef)) {
            t.missing("invoice_ref", v.invoice,
                    "nothing in the message identifies the commercial basis of the payment (no invoice reference, end-to-end id or remittance text)",
                    "carry the invoice number in the remittance information, or pass supplement.invoiceRef");
        }
        String purposeCode = t.pick("purpose_code", v.purpose, sup.get("purposeCode"), payment.purpose, null);

        Map<String, Object> source = new LinkedHashMap<>();
        JsonOut.put(source, "type", payment.messageType);
        JsonOut.put(source, "sha256", payment.digest);
        source.put("content", contentDigest(payment));
        if (Js.truthy(payment.valueDate)) {
            source.put("valueDate", payment.valueDate);
        }
        if (payment.transactionCount > 1) {
            source.put("index", (long) payment.index);
        }
        if (Js.truthy(payment.paymentInfoId)) {
            source.put("paymentInfoId", payment.paymentInfoId);
        }
        for (String k : Arrays.asList("messageId", "instructionId", "endToEndId", "uetr")) {
            // "NOTPROVIDED" is the standard's way of saying there is no end-to-end id.
            String val = k.equals("endToEndId") ? e2e
                    : k.equals("messageId") ? payment.messageId : k.equals("instructionId") ? payment.instructionId : payment.uetr;
            if (Js.truthy(val)) {
                source.put(k, val);
                boolean fin = "MT103".equals(payment.format);
                String from = k.equals("uetr")
                        ? (fin ? "block 3, field 121" : "PmtId/UETR")
                        : (fin ? (k.equals("endToEndId") ? "field 70 /ROC/" : "field 20") : k.equals("messageId") ? "GrpHdr/MsgId"
                                : k.equals("instructionId") ? "PmtId/InstrId" : "PmtId/EndToEndId");
                t.field("sourceMessage." + k, val, from, "stated");
            }
        }

        // ── What the corridor has no place for ───────────────────────────────────
        if (Js.truthy(payment.chargeBearer)) {
            t.unmapped(v.charges, payment.chargeBearer,
                    "charges follow the quote: the platform fee is added to the funding leg and the beneficiary is paid the full trade amount");
        }
        if (Js.truthy(payment.exchangeRate)) {
            t.unmapped(v.rate, payment.exchangeRate,
                    "both conversion rates are fixed by the quote the instruction cites, not by the message");
        }
        if (Js.truthy(payment.valueDate)) {
            t.unmapped(v.valueDate, payment.valueDate,
                    "settlement starts when the instruction is accepted; there is no forward value date");
        }
        for (SwiftAgent a : payment.intermediaryAgents) {
            t.unmapped(v.intermediary, Js.or(given(a.bic), Js.or(given(a.name), Js.or(given(a.memberId), "?"))),
                    "the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly");
        }
        // `amount === settled` is identity, as in the reference: which object the amount was taken from.
        if (instructed != null && settled != null && !plain(instructed).equals(plain(settled))) {
            SwiftAmount other = amount == settled ? instructed : settled;
            boolean sameCurrency = instructed.currency().equals(settled.currency());
            t.unmapped(amount == settled ? v.instructed : v.settled,
                    other.value() + " " + other.currency(),
                    amount == settled
                            ? (sameCurrency
                                    ? "charges were deducted on the way: the interbank amount is what the beneficiary is owed, and what is sent"
                                    : "the interbank amount is in the corridor's currency and names the trade; the instructed amount is the same payment before conversion")
                            : (sameCurrency
                                    ? "the interbank amount includes charges prepaid for the receiving bank; the beneficiary is owed the instructed amount, and that is what is sent"
                                    : "the instructed amount is in the corridor's currency and names the trade; the settlement leg is recomputed from the quote"));
        }
        for (String charge : payment.charges) {
            t.unmapped(v.chargeAmounts, charge,
                    "charges follow the quote: the platform fee is added to the funding leg; a charge the message records stays with the bank's own accounting");
        }
        // Compared as the reference taken was: trimmed. An empty entry is no further invoice.
        for (String extra : payment.invoiceReferences) {
            String said = Js.trim(extra);
            if (!said.isEmpty() && !said.equals(invoiceRef)) {
                t.unmapped(v.invoice, extra,
                        "the instruction carries one commercial reference; a further invoice stays in the bank's message, whose digest the instruction cites");
            }
        }
        for (String doc : payment.otherDocuments) {
            t.unmapped("RmtInf/Strd/RfrdDocInf", doc,
                    "a referred document that is not an invoice (a purchase order, a credit note …) — it is not the commercial reference");
        }
        if (payment.test != null && testTaken) {
            t.unmapped(payment.test.where(), payment.test.what(),
                    "the message is marked as a test; it is taken because this client uses a test key, and a live key refuses it");
        }
        if (payment.present.contains("77T")) {
            t.unmapped("field 77T", "(present)",
                    "not read — the envelope contents of an MT103 REMIT stay in the bank's message; carry the invoice reference in field 70");
        }
        for (String r : payment.regulatoryReporting) {
            t.unmapped(v.regulatory, r,
                    "regulatory reporting stays with the bank's own reporting system and is not forwarded");
        }
        for (String name : Arrays.asList("UltmtDbtr", "UltmtCdtr", "InstrForCdtrAgt", "InstrForNxtAgt", "72", "23E")) {
            if (payment.present.contains(name)) {
                t.unmapped(Js.test(DIGIT_FIRST, name) ? "field " + name : name, "(present)",
                        "not read — the corridor carries the debtor and the creditor only, and no agent instructions");
            }
        }

        SwiftInstructionInput input = null;
        if (t.issues.isEmpty()) {
            // An empty instruction id does not hide the block's id or the message's.
            String instructionRef = Js.or(given(payment.instructionId), Js.or(given(payment.paymentInfoId), given(payment.messageId)));
            Map<String, Object> debtor = new LinkedHashMap<>();
            debtor.put("name", debtorName);
            debtor.put("country", debtorCountry);
            debtor.put("address", debtorAddress);
            debtor.put("registration_number", debtorId);
            if (Js.truthy(debtorAccount)) {
                debtor.put("account", debtorAccount);
            }
            Map<String, Object> creditor = new LinkedHashMap<>();
            creditor.put("name", creditorName);
            creditor.put("country", creditorCountry);
            creditor.put("account", creditorAccount);
            creditor.put("bank", creditorBank);
            Map<String, Object> parties = new LinkedHashMap<>();
            parties.put("debtor", debtor);
            parties.put("creditor", creditor);
            input = new SwiftInstructionInput(tradeAmount, tradeCurrency, parties, invoiceRef,
                    Js.truthy(purposeCode) ? purposeCode : null, Js.truthy(instructionRef) ? instructionRef : null,
                    source, payment.present);
        }
        return new SwiftMapping(payment, t.fields, t.issues, t.unmapped, input);
    }

    /** {@code LEI} when the registration number is an LEI — what IVMS 101 calls it — and {@code other} otherwise. */
    static String identifierKind(String registrationNumber) {
        return SwiftText.isLei(registrationNumber) ? "LEI" : "other";
    }

    /** The three lists the mapping fills, and the two ways it fills them. */
    private static final class Table {
        final List<SwiftMapping.Field> fields = new ArrayList<>();
        final List<SwiftMapping.Issue> issues = new ArrayList<>();
        final List<SwiftMapping.Unmapped> unmapped = new ArrayList<>();

        void field(String target, String value, String source, String basis) {
            fields.add(new SwiftMapping.Field(target, value, source, basis));
        }

        void missing(String target, String source, String problem, String fix) {
            issues.add(new SwiftMapping.Issue(target, source, problem, fix));
        }

        void unmapped(String source, String value, String why) {
            unmapped.add(new SwiftMapping.Unmapped(source, value, why));
        }

        /**
         * Resolve one target: the bank's supplement first, then the message, then
         * an inference. Returns the value taken (trimmed, never empty) or null.
         * A supplement value that is not a string fails as it does in the
         * reference, where it has no {@code trim()}.
         */
        String pick(String target, String source, Object supplied, String stated, Inferred inferred) {
            String s = supplied == null ? null : Js.trim((String) supplied);
            if (Js.truthy(s)) {
                field(target, s, "supplement", "supplied");
                return s;
            }
            String m = stated == null ? null : Js.trim(stated);
            if (Js.truthy(m)) {
                field(target, m, source, "stated");
                return m;
            }
            String i = inferred == null || inferred.value == null ? null : Js.trim(inferred.value);
            if (Js.truthy(i)) {
                field(target, i, inferred.from, "inferred");
                return i;
            }
            return null;
        }
    }

    /** A value derived from something else the message states, and where from. */
    private static final class Inferred {
        final String value;
        final String from;

        Inferred(String value, String from) {
            this.value = value;
            this.from = from;
        }
    }

    private static String supplementHint(String path) {
        return "add it to the message, or pass it as supplement." + path + " (from your customer master)";
    }

    /** A party's own element or field, for a value read from a place the vocabulary does not name by default. */
    private static String within(boolean mt, String base, String place, String fallback) {
        return Js.truthy(place) ? (place.startsWith("field ") ? place : base + (mt ? " " : "/") + place) : fallback;
    }

    private static void refusePerson(Table t, boolean mt, String target, String base, String role) {
        t.missing(target, base + (mt ? "" : "/Id/PrvtId"),
                "the " + role + " is identified as a private person (a private identification, a date or place of birth, or a personal document)",
                "this corridor carries payments between companies — send a payment by or to a private person through the channel you use for it today");
    }

    /** {@code obj?.key} on a supplement member: what is not an object has no members. */
    private static Object member(Object obj, String key) {
        return obj instanceof Map ? ((Map<?, ?>) obj).get(key) : null;
    }

    /** {@code lines.join(sep)}: a missing entry is written as nothing. */
    private static String join(List<String> lines, String separator) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) {
                out.append(separator);
            }
            if (lines.get(i) != null) {
                out.append(lines.get(i));
            }
        }
        return out.toString();
    }

    /** {@code `${a.value without trailing zeros} ${a.currency}`}: equal amounts written differently are not a difference. */
    private static String plain(SwiftAmount a) {
        return withoutTrailingZeros(a.value()) + " " + a.currency();
    }

    /** {@code `${s}`}: a value that is not there is written as {@code undefined}, as the reference writes it. */
    static String template(String s) {
        return s == null ? "undefined" : s;
    }

    /**
     * The end of a line that was collapsed to single spaces and cut: a cut that
     * lands on such a space does not keep it ({@code String.prototype.trimEnd} — the
     * only white space left in the line is the plain space).
     */
    private static String trimEnd(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == ' ') {
            end--;
        }
        return s.substring(0, end);
    }
}
