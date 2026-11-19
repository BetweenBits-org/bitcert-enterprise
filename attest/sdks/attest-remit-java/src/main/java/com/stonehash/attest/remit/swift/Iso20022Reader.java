package com.stonehash.attest.remit.swift;

import static com.stonehash.attest.remit.swift.XmlReader.at;
import static com.stonehash.attest.remit.swift.XmlReader.child;
import static com.stonehash.attest.remit.swift.XmlReader.childrenOf;
import static com.stonehash.attest.remit.swift.XmlReader.textAt;

import com.stonehash.attest.remit.swift.XmlReader.Element;
import com.stonehash.attest.remit.swift.XmlReader.XmlException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ISO 20022 customer credit transfers → {@link SwiftPayment}. (The port of
 * the reference's {@code iso20022.ts}.)
 *
 * <pre>
 *   pacs.008  FIToFICustomerCreditTransfer        (bank → bank; what CBPR+ carries)
 *   pain.001  CustomerCreditTransferInitiation    (customer → bank)
 * </pre>
 *
 * <p>Any version of either is read: the elements taken here have kept their
 * names since the early versions, with three spellings that changed and are
 * accepted both ways ({@code BIC}→{@code BICFI}, {@code BICOrBEI}→{@code AnyBIC},
 * a plain {@code ReqdExctnDt} → {@code ReqdExctnDt/Dt}). The message may be
 * the document itself or sit inside an envelope beside a Business Application
 * Header — the {@code Document} element is found wherever it is. A file that
 * holds several documents (a batch wrapper around more than one message)
 * yields every transaction of every one of them; a document of another kind
 * among them refuses the file rather than being passed over — and so do a
 * second message, or anything else, inside one Document, and a message that
 * stands outside a Document beside them.
 *
 * <p>This is a reader for one purpose: lifting the payment out of the message
 * the bank already produces. It does not validate the message against the
 * schema or against any market-practice rulebook, and says nothing about
 * whether a network would accept it.
 *
 * <p>The order in which things are read is the reference's, call for call:
 * when a message has two faults, the one the reference reports is the one
 * reported here.
 */
final class Iso20022Reader {
    private Iso20022Reader() {
    }

    private static final Pattern LOOKS_LIKE_XML = Pattern.compile("^\\uFEFF?" + Js.WS + "*<");
    private static final Pattern ISO_NS = Pattern.compile("^urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\\.\\d{3}\\.\\d{3}\\.\\d{2})\\z");
    private static final Pattern COUNTRY = Pattern.compile("^[A-Z]{2}\\z");
    private static final Pattern DATE = Pattern.compile("^(\\d{4}-\\d{2}-\\d{2})");
    private static final Pattern TEST_BIC = Pattern.compile("^[A-Z0-9]{7}0([A-Z0-9]{3})?\\z");

    private static String country(String v) {
        return Js.truthy(v) && COUNTRY.matcher(v).find() ? v : null;
    }

    /** {@code [a, b].filter(Boolean).join(sep)}. */
    private static String joinPresent(String sep, String... parts) {
        List<String> kept = new ArrayList<>();
        for (String p : parts) {
            if (Js.truthy(p)) {
                kept.add(p);
            }
        }
        return String.join(sep, kept);
    }

    /**
     * Structured parts first, free lines next, locality last — one entry per
     * line. Every part the address states is kept, including the care-of line
     * and the unit number the newer versions added.
     */
    private static List<String> addressLines(Element adr) {
        String street = joinPresent(" ", textAt(adr, "StrtNm"), textAt(adr, "BldgNb"));
        String town = joinPresent(" ", textAt(adr, "PstCd"), textAt(adr, "TwnNm"));
        String careOf = textAt(adr, "CareOf");
        List<String> lines = new ArrayList<>();
        lines.add(careOf != null ? "c/o " + careOf : null);
        lines.add(textAt(adr, "Dept"));
        lines.add(textAt(adr, "SubDept"));
        lines.add(textAt(adr, "BldgNm"));
        lines.add(street.isEmpty() ? null : street);
        lines.add(textAt(adr, "Flr"));
        lines.add(textAt(adr, "UnitNb"));
        lines.add(textAt(adr, "PstBx"));
        lines.add(textAt(adr, "Room"));
        for (Element l : childrenOf(adr, "AdrLine")) {
            lines.add(Js.trim(l.text));
        }
        lines.add(textAt(adr, "TwnLctnNm"));
        lines.add(town.isEmpty() ? null : town);
        lines.add(textAt(adr, "DstrctNm"));
        lines.add(textAt(adr, "CtrySubDvsn"));
        List<String> out = new ArrayList<>();
        for (String l : lines) {
            if (l != null && !l.isEmpty()) {
                out.add(l);
            }
        }
        return out;
    }

    private static SwiftParty party(Element el) {
        SwiftParty out = new SwiftParty();
        if (el == null) {
            return out;
        }
        String name = textAt(el, "Nm");
        if (name != null) {
            out.name = name;
        }
        Element adr = child(el, "PstlAdr");
        if (adr != null) {
            out.addressLines.clear();
            out.addressLines.addAll(addressLines(adr));
            String c = country(textAt(adr, "Ctry"));
            if (c != null) {
                out.country = c;
            }
        }
        if (out.country == null) {
            String c = country(textAt(el, "CtryOfRes"));
            if (c != null) {
                out.country = c;
                out.countryFrom = "CtryOfRes";
            }
        }
        Element org = at(el, "Id/OrgId");
        Element person = at(el, "Id/PrvtId");
        // A private identification says the party is a person, not a company.
        if (person != null) {
            out.person = Boolean.TRUE;
        }
        Element holder = org != null ? org : person;
        if (org != null) {
            String bic = textAt(org, "AnyBIC");
            if (bic == null) {
                bic = textAt(org, "BICOrBEI");
            }
            if (bic == null) {
                bic = textAt(org, "BIC");
            }
            if (bic != null) {
                out.bic = bic;
            }
            String lei = textAt(org, "LEI");
            if (lei != null) {
                out.lei = lei;
            }
        }
        // `Othr` may repeat (a tax id beside a customer number); the first is taken.
        List<Element> others = childrenOf(holder, "Othr");
        Element other = others.isEmpty() ? null : others.get(0);
        if (other != null) {
            String id = textAt(other, "Id");
            if (id != null) {
                out.identification = id;
                out.identificationFrom = "Id/" + (org != null ? "OrgId" : "PrvtId") + "/Othr/Id";
            }
            String scheme = textAt(other, "SchmeNm/Cd");
            if (scheme == null) {
                scheme = textAt(other, "SchmeNm/Prtry");
            }
            if (scheme != null) {
                out.identificationScheme = scheme;
            }
        }
        return out;
    }

    /** {@code { ...party, addressLines: [...party.addressLines] }}: a payment's own copy of a shared party. */
    private static SwiftParty copyOf(SwiftParty from) {
        SwiftParty p = new SwiftParty();
        p.name = from.name;
        p.country = from.country;
        p.addressLines.addAll(from.addressLines);
        p.lei = from.lei;
        p.bic = from.bic;
        p.identification = from.identification;
        p.identificationScheme = from.identificationScheme;
        p.identificationFrom = from.identificationFrom;
        p.countryFrom = from.countryFrom;
        p.person = from.person;
        p.account = from.account;
        return p;
    }

    private static String account(Element el) {
        String iban = textAt(el, "Id/IBAN");
        return iban != null ? iban : textAt(el, "Id/Othr/Id");
    }

    private static SwiftAgent agent(Element el) {
        Element fin = child(el, "FinInstnId");
        if (fin == null) {
            return null;
        }
        SwiftAgent out = new SwiftAgent();
        String bic = textAt(fin, "BICFI");
        if (bic == null) {
            bic = textAt(fin, "BIC");
        }
        if (bic != null) {
            out.bic = bic;
        }
        String lei = textAt(fin, "LEI");
        if (lei != null) {
            out.lei = lei;
        }
        String name = textAt(fin, "Nm");
        if (name != null) {
            out.name = name;
        }
        // A clearing-system member id, or else an id under another scheme (`Othr`):
        // an agent the message identifies only that way is still an agent, and is
        // kept with the scheme that id belongs to. The two are never mixed: the
        // scheme of an `Othr` id is never taken for a member id's clearing system.
        String member = textAt(fin, "ClrSysMmbId/MmbId");
        String other = member != null ? null : textAt(fin, "Othr/Id");
        if (member != null) {
            out.memberId = member;
        } else if (other != null) {
            out.memberId = other;
        }
        String system;
        if (other != null) {
            system = textAt(fin, "Othr/SchmeNm/Cd");
            if (system == null) {
                system = textAt(fin, "Othr/SchmeNm/Prtry");
            }
        } else {
            system = textAt(fin, "ClrSysMmbId/ClrSysId/Cd");
            if (system == null) {
                system = textAt(fin, "ClrSysMmbId/ClrSysId/Prtry");
            }
        }
        if (system != null) {
            out.clearingSystem = system;
        }
        String c = country(textAt(fin, "PstlAdr/Ctry"));
        if (c != null) {
            out.country = c;
        }
        boolean any = out.bic != null || out.lei != null || out.name != null || out.memberId != null
                || out.clearingSystem != null || out.country != null;
        return any ? out : null;
    }

    private static List<SwiftAgent> intermediaryAgents(Element tx) {
        List<SwiftAgent> out = new ArrayList<>();
        for (String n : Arrays.asList("IntrmyAgt1", "IntrmyAgt2", "IntrmyAgt3")) {
            SwiftAgent a = agent(child(tx, n));
            if (a != null) {
                out.add(a);
            }
        }
        return out;
    }

    /** An amount is an xs:decimal: a full stop or nothing — {@code 12,500} is not read as twelve and a half. */
    private static SwiftAmount amountOf(Element el, String field) {
        if (el == null) {
            return null;
        }
        String currency = SwiftText.assertCurrency(el.attrs.get("Ccy"), field + "/@Ccy");
        return new SwiftAmount(currency, SwiftText.normaliseAmount(el.text, field, false));
    }

    /** {@code 2026-11-17}, from a date, a date-time, or a {@code Dt} / {@code DtTm} choice. */
    private static String dateOf(Element el) {
        if (el == null) {
            return null;
        }
        String raw = textAt(el, "Dt");
        if (raw == null) {
            raw = textAt(el, "DtTm");
        }
        if (raw == null) {
            String own = Js.trim(el.text);
            raw = own.isEmpty() ? null : own;
        }
        Matcher m = raw != null ? DATE.matcher(raw) : null;
        return m != null && m.find() ? m.group(1) : null;
    }

    /**
     * The coded words of MT field 70, which also survive in ISO 20022 free
     * text: invoice, international payment instruction, reference for the
     * beneficiary, the ordering customer's reference, trade services utility.
     * A reference ends at the next of these — not at any three capital letters
     * between slashes, which an invoice number may well contain.
     */
    static final String REMITTANCE_CODES = "INV|IPI|RFB|ROC|TSU";
    private static final List<String> CODE_WORDS = Js.split(REMITTANCE_CODES, "|");

    /** The reference's lookahead {@code /(?:INV|IPI|RFB|ROC|TSU)/} at {@code at}. */
    private static boolean codeWordAt(String text, int at) {
        if (at + 5 > text.length() || text.charAt(at) != '/' || text.charAt(at + 4) != '/') {
            return false;
        }
        for (String code : CODE_WORDS) {
            if (text.startsWith(code, at + 1)) {
                return true;
            }
        }
        return false;
    }

    /**
     * {@code /INV/…} references inside free remittance text — the MT
     * convention, which survives translation into ISO 20022. A reference runs
     * to the next coded word ({@code /RFB/}, {@code /ROC/} …) or the end of the
     * line, so a slash inside the reference itself ({@code INV/2026/001},
     * {@code EQP/SGP/2026/0457}) is kept.
     *
     * <p>The reference's pattern, {@code /\/INV\/(.*?)(?=\/(?:INV|IPI|RFB|ROC|TSU)\/|\n|$)/gs},
     * written out: after {@code /INV/} the reference runs to the first
     * position — that very position included — where a coded word or a line
     * feed starts, or to the end. An empty code word ({@code /INV//ROC/PO-1},
     * {@code /INV/} at the end of the line) carries no reference: with one
     * character required, as before, the next code word itself was taken for
     * the invoice.
     */
    static List<String> invoiceTokens(String text) {
        List<String> out = new ArrayList<>();
        int n = text.length();
        int from = 0;
        for (;;) {
            int k = text.indexOf("/INV/", from);
            if (k < 0) {
                return out;
            }
            int start = k + 5;
            int end = start;
            while (end < n && text.charAt(end) != '\n' && !codeWordAt(text, end)) {
                end++;
            }
            // Several references under one code word are separated by "//".
            for (String part : Js.split(text.substring(start, end), "//")) {
                String ref = Js.trim(part);
                if (ref.endsWith("/")) {
                    ref = ref.substring(0, ref.length() - 1);
                }
                ref = Js.trim(ref);
                if (!ref.isEmpty()) {
                    out.add(ref);
                }
            }
            from = end;
        }
    }

    /** Referred-document types that are an invoice: commercial, metered-service, hire, self-billed. */
    private static final Set<String> INVOICE_TYPES = new HashSet<>(Arrays.asList("CINV", "MSIN", "HIRI", "SBIN"));

    private static final class Remittance {
        final List<String> info = new ArrayList<>();
        final List<String> invoices = new ArrayList<>();
        final List<String> others = new ArrayList<>();
    }

    /**
     * What the remittance information says the payment is for.
     *
     * <p>A structured referred document counts as an invoice when the message
     * types it as one, or does not type it. A purchase order or a credit note
     * is a document of another kind and is kept apart — it must not become the
     * invoice reference because it happens to stand first. Invoices the message
     * types explicitly come first, then untyped documents, then {@code /INV/}
     * words in free text.
     */
    private static Remittance remittance(Element rmt) {
        Remittance out = new Remittance();
        List<String> typed = new ArrayList<>();
        List<String> untyped = new ArrayList<>();
        List<String> tokens = new ArrayList<>();
        for (Element u : childrenOf(rmt, "Ustrd")) {
            String t = Js.trim(u.text);
            if (t.isEmpty()) {
                continue;
            }
            out.info.add(t);
            // One list into another: no limit on how many a line carries (the
            // reference now pushes them one at a time for the same reason).
            tokens.addAll(invoiceTokens(t));
        }
        for (Element s : childrenOf(rmt, "Strd")) {
            for (Element doc : childrenOf(s, "RfrdDocInf")) {
                String nb = textAt(doc, "Nb");
                if (nb == null) {
                    continue;
                }
                String type = textAt(doc, "Tp/CdOrPrtry/Cd");
                if (type == null) {
                    type = textAt(doc, "Tp/CdOrPrtry/Prtry");
                }
                if (type == null) {
                    untyped.add(nb);
                } else if (INVOICE_TYPES.contains(type)) {
                    typed.add(nb);
                } else {
                    out.others.add(type + " " + nb);
                }
            }
            String ref = textAt(s, "CdtrRefInf/Ref");
            if (ref != null) {
                out.info.add(ref);
            }
            for (Element add : childrenOf(s, "AddtlRmtInf")) {
                String t = Js.trim(add.text);
                if (!t.isEmpty()) {
                    out.info.add(t);
                }
            }
        }
        Set<String> invoices = new LinkedHashSet<>(typed);
        invoices.addAll(untyped);
        invoices.addAll(tokens);
        out.invoices.addAll(invoices);
        return out;
    }

    /** Charges the message states: amount, and the agent that took them when named. */
    private static List<String> chargesOf(Element tx) {
        List<String> out = new ArrayList<>();
        for (Element c : childrenOf(tx, "ChrgsInf")) {
            Element amt = child(c, "Amt");
            String agentBic = textAt(c, "Agt/FinInstnId/BICFI");
            if (agentBic == null) {
                agentBic = textAt(c, "Agt/FinInstnId/BIC");
            }
            String text = amt != null ? Js.trim(Js.trim(amt.text) + " " + Js.or(amt.attrs.get("Ccy"), "")) : "";
            String charge = joinPresent(" ", text, agentBic != null ? "(" + agentBic + ")" : "");
            if (!charge.isEmpty()) {
                out.add(charge);
            }
        }
        return out;
    }

    private static List<String> regulatory(Element tx) {
        List<String> out = new ArrayList<>();
        for (Element r : childrenOf(tx, "RgltryRptg")) {
            for (Element d : childrenOf(r, "Dtls")) {
                // `Tp` is plain text in the older versions and a code-or-proprietary
                // choice in the newer ones; `Cd` was renamed `RptgCd`.
                String type = textAt(d, "Tp");
                if (type == null) {
                    type = textAt(d, "Tp/Cd");
                }
                if (type == null) {
                    type = textAt(d, "Tp/Prtry");
                }
                String code = textAt(d, "Cd");
                if (code == null) {
                    code = textAt(d, "RptgCd");
                }
                String ctry = textAt(d, "Ctry");
                List<String> parts = new ArrayList<>();
                for (String part : Arrays.asList(type, code, ctry)) {
                    if (Js.truthy(part)) {
                        parts.add(part);
                    }
                }
                for (Element inf : childrenOf(d, "Inf")) {
                    String t = Js.trim(inf.text);
                    if (!t.isEmpty()) {
                        parts.add(t);
                    }
                }
                if (!parts.isEmpty()) {
                    out.add(String.join(" ", parts));
                }
            }
        }
        return out;
    }

    /** The names of an element's own children (its own namespace), each once. */
    private static List<String> names(Element el) {
        Set<String> out = new LinkedHashSet<>();
        if (el != null) {
            for (Element c : el.children) {
                if (c.ns.equals(el.ns)) {
                    out.add(c.name);
                }
            }
        }
        return new ArrayList<>(out);
    }

    /** {@code [...new Set([...(messageId ? ['MsgId'] : []), ...each list])]}. */
    @SafeVarargs
    private static List<String> present(String messageId, List<String>... lists) {
        Set<String> out = new LinkedHashSet<>();
        if (messageId != null) {
            out.add("MsgId");
        }
        for (List<String> l : lists) {
            out.addAll(l);
        }
        return new ArrayList<>(out);
    }

    /**
     * Who bears the charges, as the element states it, or null when it is not
     * there (or empty). A value outside the code list refuses the message, as
     * an unknown MT 71A does: passed over, it vanished — and in a pain.001
     * transaction it hid the value its payment block states.
     */
    private static String chargeBearerOf(Element el, String where) {
        String v = textAt(el, "ChrgBr");
        if (v == null || v.equals("DEBT") || v.equals("CRED") || v.equals("SHAR") || v.equals("SLEV")) {
            return v;
        }
        throw new SwiftMessageException("invalid_field", where + ": \"" + v + "\" is not DEBT, CRED, SHAR or SLEV", where);
    }

    private static final class Family {
        final String type;
        final Element body;

        Family(String type, Element body) {
            this.type = type;
            this.body = body;
        }
    }

    /**
     * The message bodies this SDK reads, by element name, in the reference's
     * order. Only these two names are bodies: an element named
     * {@code constructor} or {@code toString} is not one (the reference keeps
     * them in a Map so that such a name finds nothing).
     */
    private static final Map<String, String> BODIES = bodies();

    private static Map<String, String> bodies() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("FIToFICstmrCdtTrf", "pacs.008");
        m.put("CstmrCdtTrfInitn", "pain.001");
        return Collections.unmodifiableMap(m);
    }

    /** The version the namespace declares when it is of the body's family; else the family alone. */
    private static Family familyOf(Element body, String declared) {
        String family = BODIES.get(body.name);
        return new Family(declared != null && declared.startsWith(family) ? declared : family, body);
    }

    private static String declaredType(String ns) {
        Matcher m = ISO_NS.matcher(ns);
        return m.find() ? m.group(1) : null;
    }

    /**
     * The reference's one walk: every Document (not looked into here), and
     * every message body that stands outside a Document. A bare body is walked
     * through for a Document inside it, never for a second body.
     */
    private static void findWalk(Element el, boolean inBody, List<Element> documents, List<Element> bare) {
        if (el.name.equals("Document")) {
            documents.add(el);
            return;
        }
        boolean body = !inBody && BODIES.containsKey(el.name);
        if (body) {
            bare.add(el);
        }
        for (Element c : el.children) {
            findWalk(c, inBody || body, documents, bare);
        }
    }

    /**
     * Locate the business documents, bare or inside an envelope — every one of
     * them. A wrapper around several messages is a file with several payments;
     * reading only the first would drop the rest without a word. For the same
     * reason a Document carries its one message and nothing else, and a file
     * whose messages stand some inside a Document and some outside is refused:
     * read either way, part of it would be passed over.
     */
    private static List<Family> findFamilies(Element root) {
        List<Element> documents = new ArrayList<>();
        List<Element> bare = new ArrayList<>();
        findWalk(root, false, documents, bare);

        if (!documents.isEmpty() && !bare.isEmpty()) {
            throw new SwiftMessageException("malformed_message",
                    "<" + bare.get(0).name + "> stands outside a Document, beside the file's documents — put each message in a Document of its own");
        }
        // Some hubs strip the Document wrapper.
        if (!bare.isEmpty()) {
            List<Family> families = new ArrayList<>();
            for (Element body : bare) {
                families.add(familyOf(body, declaredType(body.ns)));
            }
            return families;
        }
        if (documents.isEmpty()) {
            String ns = declaredType(root.ns);
            throw new SwiftMessageException("unsupported_message",
                    "no pacs.008 or pain.001 document found" + (ns != null ? " (the message declares " + ns + ")" : " (root element <" + root.name + ">)"));
        }

        List<Family> out = new ArrayList<>();
        for (int n = 0; n < documents.size(); n++) {
            Element doc = documents.get(n);
            String which = documents.size() > 1 ? "document " + (n + 1) + " of " + documents.size() : "the document";
            String declared = declaredType(doc.ns);
            Element first = doc.children.isEmpty() ? null : doc.children.get(0);
            // The children of any namespace: a message is known by its local name.
            List<Element> bodies = new ArrayList<>();
            for (Element c : doc.children) {
                if (BODIES.containsKey(c.name)) {
                    bodies.add(c);
                }
            }
            if (bodies.size() > 1) {
                Set<String> distinct = new LinkedHashSet<>();
                for (Element b : bodies) {
                    distinct.add("<" + b.name + ">");
                }
                throw new SwiftMessageException("malformed_message",
                        which + " holds " + bodies.size() + " messages (" + String.join(", ", distinct) + ") — "
                                + "a Document carries one message; put each in a Document of its own");
            }
            Element body = bodies.isEmpty() ? null : bodies.get(0);
            if (body != null) {
                Element other = null;
                for (Element c : doc.children) {
                    if (c != body) {
                        other = c;
                        break;
                    }
                }
                if (other == null) {
                    out.add(familyOf(body, declared));
                    continue;
                }
                throw new SwiftMessageException("unsupported_message",
                        which + " holds <" + other.name + "> " + (other == first ? "before" : "after") + " its message <" + body.name + "> — "
                                + "a Document carries its message and nothing else");
            }
            // No message this SDK reads: say what the document holds instead of one, or what it is.
            String expected = null;
            if (declared != null) {
                for (Map.Entry<String, String> e : BODIES.entrySet()) {
                    if (declared.startsWith(e.getValue())) {
                        expected = e.getKey();
                        break;
                    }
                }
            }
            String holds = first != null ? "<" + first.name + ">" : "nothing";
            throw new SwiftMessageException("unsupported_message", expected != null
                    ? which + " declares " + declared + " but holds " + holds + " where its message <" + expected + "> belongs"
                    : declared != null
                            ? which + " is " + declared + ", not a customer credit transfer — this SDK reads pacs.008 and pain.001 (and MT103)"
                            : which + " holds " + holds + ", not a customer credit transfer — this SDK reads pacs.008 and pain.001 (and MT103)");
        }
        return out;
    }

    private static Element requireEl(Element el, String path) {
        if (el == null) {
            throw new SwiftMessageException("missing_field", path + " is missing", path);
        }
        return el;
    }

    private static List<SwiftPayment> pacs008(Family family, String digest) {
        Element hdr = child(family.body, "GrpHdr");
        String messageId = textAt(hdr, "MsgId");
        String createdAt = textAt(hdr, "CreDtTm");
        String headerDate = dateOf(child(hdr, "IntrBkSttlmDt"));
        List<Element> txs = childrenOf(family.body, "CdtTrfTxInf");
        if (txs.isEmpty()) {
            throw new SwiftMessageException("missing_field", "CdtTrfTxInf is missing — the message carries no transaction", "CdtTrfTxInf");
        }
        List<SwiftPayment> out = new ArrayList<>();
        for (int index = 0; index < txs.size(); index++) {
            Element tx = txs.get(index);
            String here = "CdtTrfTxInf[" + (index + 1) + "]";
            Element id = child(tx, "PmtId");
            SwiftAmount settlement = amountOf(child(tx, "IntrBkSttlmAmt"), here + "/IntrBkSttlmAmt");
            SwiftAmount instructed = amountOf(child(tx, "InstdAmt"), here + "/InstdAmt");
            SwiftAmount amount = instructed != null ? instructed : settlement;
            if (amount == null) {
                throw new SwiftMessageException("missing_field", here + "/IntrBkSttlmAmt is missing", here + "/IntrBkSttlmAmt");
            }
            SwiftParty debtor = party(requireEl(child(tx, "Dbtr"), here + "/Dbtr"));
            String debtorAccount = account(child(tx, "DbtrAcct"));
            if (debtorAccount != null) {
                debtor.account = debtorAccount;
            }
            SwiftParty creditor = party(requireEl(child(tx, "Cdtr"), here + "/Cdtr"));
            String creditorAccount = account(child(tx, "CdtrAcct"));
            if (creditorAccount != null) {
                creditor.account = creditorAccount;
            }
            Remittance rmt = remittance(child(tx, "RmtInf"));
            String charge = chargeBearerOf(tx, here + "/ChrgBr");

            SwiftPayment p = new SwiftPayment();
            p.format = "pacs.008";
            p.messageType = family.type;
            p.digest = digest;
            p.index = index;
            p.transactionCount = txs.size();
            p.amount = amount;
            p.debtor = debtor;
            p.creditor = creditor;
            p.intermediaryAgents.addAll(intermediaryAgents(tx));
            p.remittanceInformation.addAll(rmt.info);
            p.invoiceReferences.addAll(rmt.invoices);
            p.otherDocuments.addAll(rmt.others);
            p.charges.addAll(chargesOf(tx));
            p.regulatoryReporting.addAll(regulatory(tx));
            p.present.addAll(present(messageId, names(id), names(tx)));
            p.messageId = messageId;
            p.createdAt = createdAt;
            p.instructionId = textAt(id, "InstrId");
            p.endToEndId = textAt(id, "EndToEndId");
            p.transactionId = textAt(id, "TxId");
            p.uetr = SwiftText.uetrOf(textAt(id, "UETR"), "PmtId/UETR");
            String valueDate = dateOf(child(tx, "IntrBkSttlmDt"));
            p.valueDate = valueDate != null ? valueDate : headerDate;
            p.instructedAmount = instructed;
            p.settlementAmount = settlement;
            p.exchangeRate = textAt(tx, "XchgRate");
            if (charge != null) {
                p.chargeBearer = charge;
            }
            p.debtorAgent = agent(child(tx, "DbtrAgt"));
            p.creditorAgent = agent(child(tx, "CdtrAgt"));
            String purpose = textAt(tx, "Purp/Cd");
            p.purpose = purpose != null ? purpose : textAt(tx, "Purp/Prtry");
            out.add(p);
        }
        return out;
    }

    /**
     * What a payment-information block states for all its transactions, read
     * once per block. A salary or supplier run carries thousands of
     * transactions under one block; reading the block's own children again
     * for each of them made a large file quadratic.
     */
    private static final class Shared {
        final SwiftParty debtor;
        final SwiftAgent debtorAgent;
        final String valueDate;
        final String charge;
        final String paymentInfoId;
        final List<String> names;

        Shared(SwiftParty debtor, SwiftAgent debtorAgent, String valueDate, String charge, String paymentInfoId, List<String> names) {
            this.debtor = debtor;
            this.debtorAgent = debtorAgent;
            this.valueDate = valueDate;
            this.charge = charge;
            this.paymentInfoId = paymentInfoId;
            this.names = names;
        }
    }

    private static final class Flat {
        final Shared shared;
        final Element tx;
        final String where;

        Flat(Shared shared, Element tx, String where) {
            this.shared = shared;
            this.tx = tx;
            this.where = where;
        }
    }

    private static List<SwiftPayment> pain001(Family family, String digest) {
        Element hdr = child(family.body, "GrpHdr");
        String messageId = textAt(hdr, "MsgId");
        String createdAt = textAt(hdr, "CreDtTm");
        List<Element> blocks = childrenOf(family.body, "PmtInf");
        List<Flat> flat = new ArrayList<>();
        for (int b = 0; b < blocks.size(); b++) {
            Element info = blocks.get(b);
            List<Element> txs = childrenOf(info, "CdtTrfTxInf");
            if (txs.isEmpty()) {
                continue;
            }
            SwiftParty debtor = party(requireEl(child(info, "Dbtr"), "PmtInf[" + (b + 1) + "]/Dbtr"));
            String debtorAccount = account(child(info, "DbtrAcct"));
            if (debtorAccount != null) {
                debtor.account = debtorAccount;
            }
            SwiftAgent debtorAgent = agent(child(info, "DbtrAgt"));
            String valueDate = dateOf(child(info, "ReqdExctnDt"));
            // Checked only for a block that has transactions, as the reference does.
            String charge = chargeBearerOf(info, "PmtInf[" + (b + 1) + "]/ChrgBr");
            String paymentInfoId = textAt(info, "PmtInfId");
            List<String> blockNames = new ArrayList<>();
            for (String n : names(info)) {
                if (!n.equals("CdtTrfTxInf")) {
                    blockNames.add(n);
                }
            }
            Shared shared = new Shared(debtor, debtorAgent, valueDate, charge, paymentInfoId, blockNames);
            for (int t = 0; t < txs.size(); t++) {
                flat.add(new Flat(shared, txs.get(t), "PmtInf[" + (b + 1) + "]/CdtTrfTxInf[" + (t + 1) + "]"));
            }
        }
        if (flat.isEmpty()) {
            throw new SwiftMessageException("missing_field", "PmtInf/CdtTrfTxInf is missing — the message carries no transaction", "PmtInf/CdtTrfTxInf");
        }
        List<SwiftPayment> out = new ArrayList<>();
        for (int index = 0; index < flat.size(); index++) {
            Shared shared = flat.get(index).shared;
            Element tx = flat.get(index).tx;
            String where = flat.get(index).where;
            Element id = child(tx, "PmtId");
            SwiftAmount instructed = amountOf(at(tx, "Amt/InstdAmt"), where + "/Amt/InstdAmt");
            SwiftAmount equivalent = amountOf(at(tx, "Amt/EqvtAmt/Amt"), where + "/Amt/EqvtAmt/Amt");
            SwiftAmount amount = instructed != null ? instructed : equivalent;
            if (amount == null) {
                throw new SwiftMessageException("missing_field", where + "/Amt/InstdAmt is missing", where + "/Amt/InstdAmt");
            }
            // Each payment gets its own copy: the block's debtor is one object, and a
            // payment handed to a caller must not change under the next one.
            SwiftParty debtor = copyOf(shared.debtor);
            SwiftParty creditor = party(requireEl(child(tx, "Cdtr"), where + "/Cdtr"));
            String creditorAccount = account(child(tx, "CdtrAcct"));
            if (creditorAccount != null) {
                creditor.account = creditorAccount;
            }
            Remittance rmt = remittance(child(tx, "RmtInf"));
            // A valid value of the transaction overrides its block's; an invalid one refuses.
            String charge = chargeBearerOf(tx, where + "/ChrgBr");
            if (charge == null) {
                charge = shared.charge;
            }

            SwiftPayment p = new SwiftPayment();
            p.format = "pain.001";
            p.messageType = family.type;
            p.digest = digest;
            p.index = index;
            p.transactionCount = flat.size();
            p.amount = amount;
            p.debtor = debtor;
            p.creditor = creditor;
            p.intermediaryAgents.addAll(intermediaryAgents(tx));
            p.remittanceInformation.addAll(rmt.info);
            p.invoiceReferences.addAll(rmt.invoices);
            p.otherDocuments.addAll(rmt.others);
            p.regulatoryReporting.addAll(regulatory(tx));
            p.present.addAll(present(messageId, shared.names, names(id), names(tx)));
            p.messageId = messageId;
            p.createdAt = createdAt;
            // The block's id is not the instruction's: every transaction of the block shares it.
            p.instructionId = textAt(id, "InstrId");
            p.paymentInfoId = shared.paymentInfoId;
            p.endToEndId = textAt(id, "EndToEndId");
            p.uetr = SwiftText.uetrOf(textAt(id, "UETR"), "PmtId/UETR");
            p.valueDate = shared.valueDate;
            p.instructedAmount = instructed;
            p.exchangeRate = textAt(tx, "XchgRateInf/XchgRate");
            if (charge != null) {
                p.chargeBearer = charge;
            }
            // As in the reference, the transactions of a block share its agent object.
            p.debtorAgent = shared.debtorAgent;
            p.creditorAgent = agent(child(tx, "CdtrAgt"));
            String purpose = textAt(tx, "Purp/Cd");
            p.purpose = purpose != null ? purpose : textAt(tx, "Purp/Prtry");
            out.add(p);
        }
        return out;
    }

    /** {@code /!p$/i}. */
    private static boolean pilotService(String text) {
        int n = text.length();
        return n >= 2 && text.charAt(n - 2) == '!' && (text.charAt(n - 1) == 'p' || text.charAt(n - 1) == 'P');
    }

    /**
     * Does the envelope say the message is a test? Two places say so: a
     * messaging-interface header naming a pilot service ({@code …!p}), and a
     * test and training BIC — "0" in the eighth position — as sender or
     * receiver in the Business Application Header. A message body that stands
     * without a Document is walked as well, its own agents with it: a test BIC
     * found there still marks the message, and is reported by the path it
     * stands at — not as a header the message does not have.
     */
    private static SwiftPayment.TestMark testMarker(Element root) {
        SwiftPayment.TestMark[] hit = {null};
        testWalk(root, false, new ArrayList<>(), hit);
        return hit[0];
    }

    /** {@code path} holds the local names from the root down to {@code el}'s parent. */
    private static void testWalk(Element el, boolean inHeader, List<String> path, SwiftPayment.TestMark[] hit) {
        if (hit[0] != null || el.name.equals("Document")) {
            return;
        }
        path.add(el.name);
        boolean header = inHeader || el.name.equals("AppHdr");
        String text = Js.trim(el.text);
        if (el.name.equals("Service") && pilotService(text)) {
            hit[0] = new SwiftPayment.TestMark("envelope header, Service", "pilot service " + text);
        } else if (el.name.equals("BICFI") && TEST_BIC.matcher(text).find()) {
            hit[0] = new SwiftPayment.TestMark(header ? "Business Application Header" : String.join("/", path), "test and training BIC " + text);
        } else {
            for (Element c : el.children) {
                testWalk(c, header, path, hit);
            }
        }
        path.remove(path.size() - 1);
    }

    /** Does this text start like an XML document? */
    static boolean looksLikeXml(String text) {
        return LOOKS_LIKE_XML.matcher(text).find();
    }

    /**
     * Every transaction of every pacs.008 / pain.001 document in the text, in
     * the order they appear. {@code index} counts across the whole text.
     */
    static List<SwiftPayment> parse(String text, String digest) {
        Element root;
        try {
            root = XmlReader.parse(text);
        } catch (XmlException e) {
            throw new SwiftMessageException("malformed_message", "not well-formed XML: " + e.getMessage());
        }
        List<SwiftPayment> all = new ArrayList<>();
        try {
            for (Family family : findFamilies(root)) {
                all.addAll(family.type.startsWith("pacs.008") ? pacs008(family, digest) : pain001(family, digest));
            }
            SwiftPayment.TestMark test = testMarker(root);
            if (test != null) {
                for (SwiftPayment p : all) {
                    p.test = test;
                }
            }
        } catch (XmlException e) {
            // An element that may occur once and occurs twice: the message can be read two ways.
            throw new SwiftMessageException("malformed_message", e.getMessage());
        }
        for (int index = 0; index < all.size(); index++) {
            all.get(index).index = index;
            all.get(index).transactionCount = all.size();
        }
        return all;
    }
}
