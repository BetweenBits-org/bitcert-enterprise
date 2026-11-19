package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Check;
import com.stonehash.attest.remit.Hex;
import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.RemitException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the golden vectors do not reach, held to the reference's answers. Each
 * case is a golden payment with a patch merged in (an object merges into an
 * object, null removes a key, anything else replaces) and the options it is
 * mapped with. Every expected value here was produced by the TypeScript SDK
 * — {@code probe/expect.ts}, {@code probe/hardening.ts} and
 * {@code probe/fingerprints.ts} in the working copy compute them — and is
 * written down, not computed.
 */
final class SwiftMappingTest {
    private SwiftMappingTest() {
    }

    private static Map<String, Map<String, Object>> bases;

    /** A golden payment, as JSON, with the patch merged in. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> paymentJson(String base, String patch) {
        if (bases == null) {
            Map<String, Map<String, Object>> parsed = MappingGoldenTest.parseCases();
            Map<String, Map<String, Object>> b = new LinkedHashMap<>();
            b.put("pacs008", firstPayment(parsed.get("sample/pacs008")));
            b.put("mt103", firstPayment(parsed.get("sample/mt103-structured")));
            b.put("pain001", firstPayment(parsed.get("sample/pain001")));
            bases = b;
        }
        Map<String, Object> out = (Map<String, Object>) Json.parse(Json.compact(bases.get(base)));
        merge(out, (Map<String, Object>) Json.parse(patch));
        return out;
    }

    static SwiftPayment payment(String base, String patch) {
        return SwiftPayment.fromJson(paymentJson(base, patch));
    }

    private static Map<String, Object> firstPayment(Map<String, Object> parseCase) {
        return Golden.map(Golden.list(Golden.map(parseCase.get("expect")).get("payments")).get(0));
    }

    @SuppressWarnings("unchecked")
    private static void merge(Map<String, Object> into, Map<String, Object> patch) {
        for (Map.Entry<String, Object> e : patch.entrySet()) {
            Object v = e.getValue();
            Object current = into.get(e.getKey());
            if (v == null) {
                into.remove(e.getKey());
            } else if (v instanceof Map && current instanceof Map) {
                merge((Map<String, Object>) current, (Map<String, Object>) v);
            } else {
                into.put(e.getKey(), v);
            }
        }
    }

    static SwiftMapping map(String base, String patch, String options) {
        return Swift.map(payment(base, patch), MappingGoldenTest.options(Golden.map(Json.parse(options))));
    }

    /** The case of {@link #CASES} with this name, mapped. */
    private static SwiftMapping mapCase(String name) {
        for (String[] c : CASES) {
            if (c[0].equals(name)) {
                return map(c[1], c[2], c[3]);
            }
        }
        throw new AssertionError("no case " + name);
    }

    private static SwiftMapping.Field field(SwiftMapping m, String target) {
        for (SwiftMapping.Field f : m.fields()) {
            if (f.target().equals(target)) {
                return f;
            }
        }
        return null;
    }

    private static List<Object> json(List<?> items) {
        List<Object> out = new ArrayList<>();
        for (Object o : items) {
            out.add(o instanceof SwiftMapping.Field ? ((SwiftMapping.Field) o).toJson()
                    : o instanceof SwiftMapping.Issue ? ((SwiftMapping.Issue) o).toJson() : ((SwiftMapping.Unmapped) o).toJson());
        }
        return out;
    }

    /**
     * name, base payment, patch, options, and the SHA-256 of the reference's
     * complete answer: {@code JSON.stringify({ fields, issues, unmapped, input? })},
     * a line break, and the SwiftMappingError message (empty when there is none).
     */
    private static final String[][] CASES = {
            {"nothing-iso", "pacs008", "{\"debtor\":{\"name\":null,\"country\":null,\"addressLines\":[],\"identification\":null,\"identificationFrom\":null,\"identificationScheme\":null,\"bic\":\"AAAAVNVX\",\"account\":null},\"creditor\":{\"name\":null,\"country\":null,\"account\":null},\"creditorAgent\":null,\"debtorAgent\":null,\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED\",\"remittanceInformation\":[],\"amount\":{\"currency\":\"EUR\",\"value\":\"10.00\"},\"instructedAmount\":{\"currency\":\"EUR\",\"value\":\"10.00\"},\"settlementAmount\":{\"currency\":\"EUR\",\"value\":\"10.00\"}}", "{}", "367700631b59ac09540bfb67db27b5cea94836641cbac7df4cd4b7fe0f0f7684"},
            {"nothing-mt", "mt103", "{\"debtor\":{\"name\":null,\"country\":null,\"addressLines\":[],\"identification\":null,\"identificationFrom\":null,\"identificationScheme\":null,\"account\":null},\"creditor\":{\"name\":null,\"country\":null,\"account\":null},\"creditorAgent\":null,\"debtorAgent\":null,\"invoiceReferences\":[],\"remittanceInformation\":[],\"amount\":{\"currency\":\"USD\",\"value\":\"0.00\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"0.00\"}}", "{}", "078134880e40389a7472c6fedd0ada28eb28470ab910ba747a3f46608cba910c"},
            {"nothing-pain", "pain001", "{\"debtor\":{\"name\":\"  \",\"country\":null,\"addressLines\":[],\"identification\":null,\"bic\":\"\"},\"creditor\":{\"name\":\"\\u3000\",\"country\":null,\"account\":\"\\ufeff\"},\"creditorAgent\":{},\"debtorAgent\":{\"bic\":\"bad\"},\"invoiceReferences\":[],\"endToEndId\":\"noref\",\"remittanceInformation\":[\"\\u00a0\"],\"amount\":{\"currency\":\"USD\",\"value\":\"12.345\"},\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"12.345\"}}", "{}", "02133412ddef0934251f94fb9497006eacc561be08ef5806f6e94199c2581b26"},
            {"persons-and-test-iso", "pacs008", "{\"debtor\":{\"person\":true},\"creditor\":{\"person\":true},\"test\":{\"where\":\"Business Application Header\",\"what\":\"test and training BIC DEMOVNV0\"}}", "{}", "3d9ef4c2fcbd8495461ca04f8b93ee18373fff034b3e7bc2072d281fbe1cae42"},
            {"persons-and-test-mt", "mt103", "{\"debtor\":{\"person\":true},\"creditor\":{\"person\":true},\"test\":{\"where\":\"field 23B\",\"what\":\"CRTS\"},\"bankOperationCode\":\"CRTS\"}", "{\"allowTestMessages\":true}", "4fa3f1666a3cf465635006d7d99b7ebbf9ab93dfaa5a160583ab1239233cc1f4"},
            {"unmapped-everything", "pacs008", "{\"exchangeRate\":\"1.1\",\"intermediaryAgents\":[{\"bic\":\"INTMSGSG\",\"name\":\"Correspondent\"},{\"name\":\"Correspondent\"},{\"memberId\":\"021000021\"},{},{\"bic\":\"\"}],\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"12510.00\"},\"amount\":{\"currency\":\"USD\",\"value\":\"12510.00\"},\"charges\":[\"10.00 USD (DEMOVNVX)\"],\"invoiceReferences\":[\"INV-1\",\" INV-2 \",\"INV-1\"],\"otherDocuments\":[\"PUOR PO-88812\"],\"regulatoryReporting\":[\"CRED EXPORT VN CERAMICS\"],\"present\":[\"MsgId\",\"PmtId\",\"UltmtDbtr\",\"UltmtCdtr\",\"InstrForCdtrAgt\",\"InstrForNxtAgt\",\"77T\",\"72\",\"23E\"]}", "{}", "ba1e608df1848e7242805d8025f75228df616120cc8ccd6af4c29212d9b7c752"},
            {"why-prepaid", "mt103", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"1000\"},\"amount\":{\"currency\":\"USD\",\"value\":\"1000\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"1015\"},\"chargeBearer\":\"DEBT\",\"charges\":[\"receiver's charges USD15,\"]}", "{\"supplement\":{\"debtor\":{\"registration_number\":\"0312345678\"}}}", "c623d509d50567a674dbe56f16280845c12ca15b746cc66d5fd32a87891e33d1"},
            {"why-converted-before", "pacs008", "{\"instructedAmount\":{\"currency\":\"VND\",\"value\":\"322537500\"},\"amount\":{\"currency\":\"VND\",\"value\":\"322537500\"}}", "{}", "71d67e978660d53b72165a6ab7ff9d284c6497ec29327a3064ff3fe40cfee7db"},
            {"why-settled-elsewhere", "pacs008", "{\"settlementAmount\":{\"currency\":\"SGD\",\"value\":\"16687.50\"}}", "{}", "a6cbf3f6cff7d510fa5765a1efb248923c0faf19dc61d324315be269f911e819"},
            {"equal-amounts-written-differently", "pacs008", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"100.10\"},\"amount\":{\"currency\":\"USD\",\"value\":\"100.10\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"100.1\"}}", "{}", "0d923fef3141388baab01217b15b0ef6fba0b6eab965d787efbd2a61ac74ca59"},
            {"beyond-double-precision", "pacs008", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"123456789012345.12\"},\"amount\":{\"currency\":\"USD\",\"value\":\"123456789012345.12\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"123456789012345.13\"}}", "{}", "e6dffda4c3cf87c0f54e2d448a68327c97382f8c941a8a0842b8715074ef043f"},
            {"invoice-from-e2e", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"E2E-77\"}", "{}", "d96e76371f0c6a8a86267686cf901925efb48bc543f7da09a62f3ac4f41f2c9b"},
            {"invoice-from-remittance", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"notprovided\",\"remittanceInformation\":[\"  Payment\\u3000for \\u00a0 goods xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\ud83d\\ude00 and more\",\"second line\"]}", "{}", "aa54679f469466decd84527830b00bdf0742fca5bb9e8799fd0b6f349997e621"},
            {"invoice-missing", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NONREF\",\"remittanceInformation\":[\" \"]}", "{}", "ec8f615bbb2209b848f314f2d0f0b37e320a46c88bd1b1b9105e7401a6f2bdc6"},
            {"supplement-trimmed", "pacs008", "{}", "{\"supplement\":{\"debtor\":{\"name\":\" Vina\\u3000Trading\\ufeff \",\"country\":\"  \",\"registration_number\":\"\\u00a0\",\"account\":null},\"creditor\":\"not an object\",\"invoiceRef\":\" INV-SUP \",\"purposeCode\":\"  \"}}", "803e88ab2eb991e01d2e5f2cd7266c40d6acb0c2fb0cd4f8d55920e709197411"},
            {"supplement-everything", "mt103", "{\"debtor\":{\"identification\":null}}", "{\"supplement\":{\"debtor\":{\"name\":\"Vina Trading\",\"country\":\"VN\",\"address\":\"12 Le Loi\",\"registration_number\":\"0312345678\",\"account\":\"ACC-1\"},\"creditor\":{\"name\":\"Pacific\",\"country\":\"SG\",\"account\":\"SG-1\",\"bank\":\"Example Bank Ltd\"},\"invoiceRef\":\"INV-2026-0478\",\"purposeCode\":\"GDDS\"}}", "2d8aecaccb7ee282a976dca18838fa3926d3d19378319e345ca1034ea11a7703"},
            {"source-of-a-batch", "pain001", "{\"transactionCount\":3,\"index\":2,\"endToEndId\":\"NOTPROVIDED\"}", "{}", "c4aa42f153c0927f6ad14014853170cab0d5b207731678a597000721ba4c703c"},
            {"empty-instruction-id", "pain001", "{\"instructionId\":\"\"}", "{}", "3afddda630ca27d874192ff7a2fa4a47b0f376722f64c641e4fbb94f62467566"},
            {"corridor-vn-us", "pacs008", "{}", "{\"corridor\":{\"origin\":\"VN\",\"destination\":\"US\"}}", "74d85bb9ddbc188291eb825756cb0d0e53a3d8c5bb2b901a85ea92853376cec5"},
            {"corridor-without-destination", "pacs008", "{\"debtor\":{\"country\":\"TH\"}}", "{\"corridor\":{\"origin\":\"VN\"}}", "d0fa6ca62a1dbfcc4da6873db112bca86f84c9b1822f1ddbba81ff9bc3c82e41"},
            {"empty-trade-currency", "pacs008", "{}", "{\"tradeCurrency\":\"\"}", "4a0f4ae8f26148b4b5886dd80cd7e881f8ea015a9123da304612ecd8cf1aab08"},
            {"inferred-countries", "mt103", "{\"debtor\":{\"country\":null},\"creditor\":{\"country\":null},\"debtorAgent\":{\"bic\":\"aaaavnvx\"},\"creditorAgent\":{\"country\":\"SG\",\"memberId\":\"7171\",\"clearingSystem\":\"\"}}", "{\"supplement\":{\"debtor\":{\"registration_number\":\"1\"}}}", "f111912a2f1ea4515e895be25ccc1230d282a209f16e11e52808c5327fa574a4"},
            {"no-inference", "mt103", "{\"debtor\":{\"country\":null},\"creditor\":{\"country\":null},\"creditorAgent\":{\"country\":\"SG\",\"memberId\":\"7171\"}}", "{\"inferCountryFromBic\":false}", "472eb8088bcc3235d2f9bfd1e997222f749de04411811c99ece35d65558cc447"},
            {"where-it-stood", "mt103", "{\"debtor\":{\"countryFrom\":\"CtryOfRes\",\"lei\":\"\",\"identification\":\"0312345678\"},\"creditor\":{\"countryFrom\":\"field 77B /BENEFRES/\"}}", "{}", "2536ab1fd402406be37cb686904f8d842415f11ea851e6d17d0615161779facf"},
            {"lei-stated", "pacs008", "{\"debtor\":{\"lei\":\"5493001KJTIIGC8Y1R12\",\"countryFrom\":\"CtryOfRes\",\"identificationFrom\":\"\"}}", "{}", "47a435b4c094e5fdd8ee72f40521d7be1a2757e517958cf8ff00d2a5b2d92f1a"},
            {"test-mark-without-words", "pacs008", "{\"test\":{\"where\":\"x\"}}", "{}", "a182003514c6b251cd4af55241a8231ca3217d0ff397747431941987daa78875"},
            {"country-from-agent-country", "pacs008", "{\"creditor\":{\"country\":null},\"creditorAgent\":{\"bic\":null,\"name\":null,\"country\":\"SG\",\"memberId\":\"026009593\",\"clearingSystem\":\"SGIBG\"}}", "{}", "dec568e1256dfb74fb5202906ba6506ec048d5c2134ed1e8a5ea9e6c764eeebf"},
            {"agent-in-another-country", "pacs008", "{\"creditorAgent\":{\"bic\":\"DEMOMYKL\",\"country\":\"SG\"}}", "{}", "960d31a41e922fe3eda5fe8a3db18b5a9b3af5284ed78e2936c96adee5e43508"},
            {"amount-of-its-own", "pacs008", "{\"amount\":{\"currency\":\"EUR\",\"value\":\"10.00\"},\"instructedAmount\":{\"currency\":\"SGD\",\"value\":\"5\"},\"settlementAmount\":{\"currency\":\"EUR\",\"value\":\"10.00\"}}", "{}", "305287c5b29484423a2c72122ab0df6ea7fdaee61b02614c5973cc82e996099a"},
            {"address-with-a-gap", "pacs008", "{\"debtor\":{\"addressLines\":[null,\"Le Loi Boulevard 12\",null]}}", "{}", "870e5ea7690a77886de6de4d918ff481f7f295fe0b73e2bd7d937f8bc896bf00"},
            // The hardening of the mapping (A1–A10): payments handed over already parsed, with values the
            // readers never produce — empty and untrimmed strings, amounts that are not plain decimals.
            {"past-double-precision-the-other-way", "pacs008", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"999999999999999.99\"},\"amount\":{\"currency\":\"USD\",\"value\":\"999999999999999.99\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"999999999999999.98\"}}", "{}", "3337cc07b69ec7740c3f32f6c50a6a0168c3427241094aff874e5c57b5854e5b"},
            {"instructed-not-a-decimal", "pacs008", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"twelve\"}}", "{}", "8e62eb974da9abeaa52ee6817edbdadd6f52ab5c8facd0b8e5da5b8e35466307"},
            {"settled-not-a-decimal", "pacs008", "{\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"twelve\"}}", "{}", "9f082e1d0b19631d965090bb3df03281fa3d1753b6674a5f1adb3dbe1c9419ea"},
            {"country-from-agent-country-mt", "mt103", "{\"creditor\":{\"country\":null,\"countryFrom\":null},\"creditorAgent\":{\"bic\":null,\"name\":\"DEMO PAYOUT BANK\",\"country\":\"SG\"}}", "{}", "d4530c9b8fcbb7d9fd5bbe9cfb79a650c9ecf7ca00a244dfd9c0c8e39deb083d"},
            {"remittance-cut-after-a-pair", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED\",\"remittanceInformation\":[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\ud83d\\ude00tail\"]}", "{}", "df85483b4016b66a23922bb44ef43c78ed9cb81aa1f6a9f57779093f24d688d6"},
            {"remittance-cut-at-a-space", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED\",\"remittanceInformation\":[\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx tail\"]}", "{}", "4c2aa9e10257802187abd7d5fc6b8a2f6cfa85dc39da748d83c54e978e6580fe"},
            {"empty-lei", "pacs008", "{\"debtor\":{\"lei\":\"\"}}", "{}", "4a0f4ae8f26148b4b5886dd80cd7e881f8ea015a9123da304612ecd8cf1aab08"},
            {"blank-lei", "pacs008", "{\"debtor\":{\"lei\":\"   \"}}", "{}", "4a0f4ae8f26148b4b5886dd80cd7e881f8ea015a9123da304612ecd8cf1aab08"},
            {"blank-lei-and-identification", "pacs008", "{\"debtor\":{\"lei\":\"\",\"identification\":\" \"}}", "{}", "b2dc9e903c7a5ac7d561169fd2a09044e7709ec27aa4e699367586ac43c96a36"},
            {"blank-instruction-id", "pain001", "{\"instructionId\":\" \",\"paymentInfoId\":\"\"}", "{}", "2e098b38395a33a867cf1c38099884daa8cc37d5b3f4e8f836b102796a1370f0"},
            {"empty-instruction-id-pacs", "pacs008", "{\"instructionId\":\"\"}", "{}", "ad155cb0b99f6b629ed3dff0fa0f8d7bdb76da58244ecaefbf83110833240805"},
            {"no-instruction-reference", "pacs008", "{\"instructionId\":\"\",\"messageId\":\"\"}", "{}", "925ba45b491cb4e51b30f2880e174386726bd3f5854ce8fd57002c38f3ad92f3"},
            {"blank-clearing-system", "pacs008", "{\"creditorAgent\":{\"memberId\":\"7171\",\"clearingSystem\":\"  \"}}", "{}", "e3aa83984602383d6749c48ba0afb86ded826f6a1647315d561562d5db4713f4"},
            {"blank-trade-currency", "pacs008", "{}", "{\"tradeCurrency\":\"  \"}", "4a0f4ae8f26148b4b5886dd80cd7e881f8ea015a9123da304612ecd8cf1aab08"},
            {"blank-agent-country", "pacs008", "{\"creditorAgent\":{\"bic\":null,\"country\":\" \"}}", "{}", "92dc4536147bff2ca682c5ccde4d0617a807431bd6f269ae079d508722b053a9"},
            {"empty-intermediaries", "pacs008", "{\"intermediaryAgents\":[{\"bic\":\"\",\"name\":\"Correspondent Bank\"},{\"bic\":\" \",\"name\":\"\",\"memberId\":\"\"}]}", "{}", "b72540014a03d08b663a62dd49625f3e6f918395c51b2e3d246c8c3af3a58b0d"},
            {"padded-invoices", "pacs008", "{\"invoiceReferences\":[\" INV-1 \",\"INV-1\",\"INV-2\\n\"]}", "{}", "155f0deb9993799debfa5dce20ebfb92e069044584ec5a214e19842e0e3b2c57"},
            {"empty-invoices", "pacs008", "{\"invoiceReferences\":[\"\",\" \",\"INV-3\"]}", "{}", "88a28550904b97f84bac0894ea26ccf6116e75d4da082b0af9426068e6b21184"},
            {"padded-invoice-supplied", "pacs008", "{\"invoiceReferences\":[\" INV-1 \"]}", "{\"supplement\":{\"invoiceRef\":\"INV-1\"}}", "a5f3ead0b6d6f7ce576af3bed190e53754c6ff445cafc6b27043cdd1e08712fe"},
            {"test-mark-live", "mt103", "{\"test\":{\"where\":\"field 23B\",\"what\":\"CRTS\"}}", "{\"supplement\":{\"debtor\":{\"registration_number\":\"1\"}}}", "3853b9f2c59d47110358168aa821ce7aa0c279484f63e66ceb841e5ce923e68f"},
            {"no-reference-with-white-space", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"\\tnonref \"}", "{}", "ec8f615bbb2209b848f314f2d0f0b37e320a46c88bd1b1b9105e7401a6f2bdc6"},
            {"no-reference-line-end", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED\\n\"}", "{}", "ec8f615bbb2209b848f314f2d0f0b37e320a46c88bd1b1b9105e7401a6f2bdc6"},
            {"padded-end-to-end-id", "pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\" PO-7781\\n\"}", "{}", "dbecc894d4b6f9bfda4d1ec68baff9d9f4d93de7e1a92c81749c7ac49aac7d8d"},
    };

    static void testEveryCaseAnswersAsTheReferenceDoes() {
        List<String> failures = new ArrayList<>();
        for (String[] c : CASES) {
            try {
                SwiftMapping m = map(c[1], c[2], c[3]);
                String json = Json.compact(m.toJson());
                String error = m.issues().isEmpty() ? "" : new SwiftMappingException(m).getMessage();
                if (!Hex.sha256Hex(json + "\n" + error).equals(c[4])) {
                    failures.add(c[0] + ": not the reference's answer (node probe/expect.ts mapping shows it) — got\n        " + json + "\n        " + error);
                }
            } catch (RuntimeException e) {
                failures.add(c[0] + ": " + e);
            }
        }
        Check.isTrue(CASES.length >= 53, "the cases are there");
        Golden.none(failures, "hand-written mapping cases");
    }

    static void testTheWordsOfEachRefusal() {
        SwiftMapping iso = mapCase("nothing-iso");
        Check.equal("[{\"target\":\"trade.amount\",\"source\":\"CdtTrfTxInf/IntrBkSttlmAmt\",\"problem\":\"the message instructs 10.00 EUR; this corridor denominates trades in USD\",\"fix\":\"send the USD amount of the trade (the corridor converts the funding and payout legs itself, from the quote)\"},{\"target\":\"debtor.name\",\"source\":\"CdtTrfTxInf/Dbtr/Nm\",\"problem\":\"the ordering customer has no name\",\"fix\":\"add it to the message, or pass it as supplement.debtor.name (from your customer master)\"},{\"target\":\"debtor.country\",\"source\":\"CdtTrfTxInf/Dbtr/PstlAdr/Ctry\",\"problem\":\"the ordering customer's country is not stated\",\"fix\":\"add it to the message, or pass it as supplement.debtor.country (from your customer master)\"},{\"target\":\"debtor.address\",\"source\":\"CdtTrfTxInf/Dbtr/PstlAdr\",\"problem\":\"the ordering customer has no address — the receiving institution requires one\",\"fix\":\"add it to the message, or pass it as supplement.debtor.address (from your customer master)\"},{\"target\":\"debtor.registration_number\",\"source\":\"CdtTrfTxInf/Dbtr/Id/OrgId (LEI or Othr/Id)\",\"problem\":\"the ordering customer carries no identification (LEI, business registration number or tax id) — only the BIC AAAAVNVX, which is not one; the receiving institution requires one\",\"fix\":\"add it to the message, or pass it as supplement.debtor.registration_number (from your customer master)\"},{\"target\":\"creditor.name\",\"source\":\"CdtTrfTxInf/Cdtr/Nm\",\"problem\":\"the beneficiary has no name\",\"fix\":\"add it to the message, or pass it as supplement.creditor.name (from your customer master)\"},{\"target\":\"creditor.country\",\"source\":\"CdtTrfTxInf/Cdtr/PstlAdr/Ctry\",\"problem\":\"the beneficiary's country is not stated\",\"fix\":\"add it to the message, or pass it as supplement.creditor.country (from your customer master)\"},{\"target\":\"creditor.account\",\"source\":\"CdtTrfTxInf/CdtrAcct/Id\",\"problem\":\"the beneficiary has no account — the payout cannot be credited\",\"fix\":\"add it to the message, or pass it as supplement.creditor.account (from your customer master)\"},{\"target\":\"creditor.bank\",\"source\":\"CdtTrfTxInf/CdtrAgt/FinInstnId\",\"problem\":\"the beneficiary's bank is not identified\",\"fix\":\"add it to the message, or pass it as supplement.creditor.bank (from your customer master)\"},{\"target\":\"invoice_ref\",\"source\":\"CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)\",\"problem\":\"nothing in the message identifies the commercial basis of the payment (no invoice reference, end-to-end id or remittance text)\",\"fix\":\"carry the invoice number in the remittance information, or pass supplement.invoiceRef\"}]",
                Json.compact(json(iso.issues())), "every issue of a pacs.008 that states nothing, in the reference's words and order");
        Check.equal(null, iso.input(), "no input while there are issues");

        SwiftMappingException mt = new SwiftMappingException(mapCase("nothing-mt"));
        Check.equal("the message cannot be turned into a settlement instruction — 10 thing(s) missing: trade.amount (field 32A); debtor.name (field 50a (name line)); debtor.country (field 50F line 3/ or field 77B /ORDERRES/); debtor.address (field 50a (address lines)); debtor.registration_number (field 50F party identifier or line 6/ 7/); creditor.name (field 59a (name line)); creditor.country (field 59F line 3/ or field 77B /BENEFRES/); creditor.account (field 59a (/account line)); creditor.bank (field 57a or the receiver BIC); invoice_ref (field 70 /INV/)",
                mt.getMessage(), "an MT103 names each missing thing by its field");
        Check.equal("mapping_incomplete", mt.code(), "the code of the refusal");
        Check.equal("\"0.00\" is not a positive USD amount with at most two decimals", mt.issues().get(0).problem(), "a zero amount");

        SwiftMappingException pain = new SwiftMappingException(mapCase("nothing-pain"));
        Check.equal("the message cannot be turned into a settlement instruction — 8 thing(s) missing: trade.amount (CdtTrfTxInf/Amt/InstdAmt); debtor.name (PmtInf/Dbtr/Nm); debtor.country (PmtInf/Dbtr/PstlAdr/Ctry); debtor.address (PmtInf/Dbtr/PstlAdr); debtor.registration_number (PmtInf/Dbtr/Id/OrgId (LEI or Othr/Id)); creditor.name (CdtTrfTxInf/Cdtr/Nm); creditor.account (CdtTrfTxInf/CdtrAcct/Id); invoice_ref (CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd))",
                pain.getMessage(), "a pain.001 names the debtor's elements under PmtInf; whitespace (U+3000, U+FEFF, NBSP) is no value");

        SwiftMapping persons = mapCase("persons-and-test-iso");
        Check.equal("the message cannot be turned into a settlement instruction — 3 thing(s) missing: instruction (Business Application Header); debtor (CdtTrfTxInf/Dbtr/Id/PrvtId); creditor (CdtTrfTxInf/Cdtr/Id/PrvtId)",
                new SwiftMappingException(persons).getMessage(), "a test message and two private persons");
        Check.equal("test and training BIC DEMOVNV0 — the message is marked as a test and must not be executed as a payment",
                persons.issues().get(0).problem(), "the test mark");
        Check.equal("this corridor carries payments between companies — send a payment by or to a private person through the channel you use for it today",
                persons.issues().get(1).fix(), "the fix for a private person");

        SwiftMapping allowed = map("mt103", "{\"debtor\":{\"person\":true},\"creditor\":{\"person\":true},\"test\":{\"where\":\"field 23B\",\"what\":\"CRTS\"}}", "{\"allowTestMessages\":true}");
        Check.equal(Arrays.asList("debtor|field 50", "creditor|field 59"), targetsAndSources(allowed.issues()), "with a test key the test mark is no issue; an MT103 party is its field");
        SwiftMapping.Unmapped mark = allowed.unmapped().get(allowed.unmapped().size() - 1);
        Check.equal("field 23B|CRTS|the message is marked as a test; it is taken because this client uses a test key, and a live key refuses it",
                mark.source() + "|" + mark.value() + "|" + mark.why(), "and it is listed as taken");

        // With a live key the test mark is refused — and only refused: nothing in the answer says it was taken.
        SwiftMapping live = mapCase("test-mark-live");
        Check.equal(Arrays.asList("CRTS — the message is marked as a test and must not be executed as a payment"), problems(live), "refused");
        Check.equal(Arrays.asList("instruction|field 23B"), targetsAndSources(live.issues()), "by the field that marks it");
        Check.equal(Arrays.asList("field 71A|SHAR", "field 32A|2026-11-17"), sourcesAndValues(live.unmapped()),
                "and not listed as taken with a test key: the charge bearer and the value date are all that has no place");
        Check.equal(Arrays.asList("field 71A|SHAR", "field 32A|2026-11-17"),
                sourcesAndValues(map("mt103", "{\"test\":{\"where\":\"field 23B\",\"what\":\"CRTS\"}}", "{\"allowTestMessages\":false}").unmapped()),
                "allowTestMessages false is a live key");

        // A test mark that does not say what it found: the reference writes `undefined` in the refusal, and lists nothing …
        SwiftMapping bare = map("pacs008", "{\"test\":{\"where\":\"x\"}}", "{}");
        Check.equal("undefined — the message is marked as a test and must not be executed as a payment", bare.issues().get(0).problem(), "what is not there");
        Check.equal(Arrays.asList("ChrgBr|DEBT", "IntrBkSttlmDt|2026-11-17"), sourcesAndValues(bare.unmapped()), "refused, and not listed as taken");
        // … and, taken with a test key, lists the mark without a value.
        SwiftMapping bareTaken = map("pacs008", "{\"test\":{\"where\":\"x\"}}", "{\"allowTestMessages\":true}");
        Check.equal(0, bareTaken.issues().size(), "a test key takes it");
        Check.equal("{\"source\":\"x\",\"why\":\"the message is marked as a test; it is taken because this client uses a test key, and a live key refuses it\"}",
                Json.compact(bareTaken.unmapped().get(bareTaken.unmapped().size() - 1).toJson()), "a value that is not there is left out");
    }

    private static List<String> sourcesAndValues(List<SwiftMapping.Unmapped> unmapped) {
        List<String> out = new ArrayList<>();
        for (SwiftMapping.Unmapped u : unmapped) {
            out.add(u.source() + "|" + u.value());
        }
        return out;
    }

    /** What has no place and was found at this source, in the mapping's order. */
    private static List<SwiftMapping.Unmapped> unmappedFrom(SwiftMapping m, String source) {
        List<SwiftMapping.Unmapped> out = new ArrayList<>();
        for (SwiftMapping.Unmapped u : m.unmapped()) {
            if (u.source().equals(source)) {
                out.add(u);
            }
        }
        return out;
    }

    private static List<String> targetsAndSources(List<SwiftMapping.Issue> issues) {
        List<String> out = new ArrayList<>();
        for (SwiftMapping.Issue i : issues) {
            out.add(i.target() + "|" + i.source());
        }
        return out;
    }

    static void testWhatHasNoPlaceIsListedWithItsReason() {
        SwiftMapping m = map("pacs008", "{\"exchangeRate\":\"1.1\",\"intermediaryAgents\":[{\"bic\":\"INTMSGSG\",\"name\":\"Correspondent\"},{\"name\":\"Correspondent\"},{\"memberId\":\"021000021\"},{},{\"bic\":\"\"}],\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"12510.00\"},\"amount\":{\"currency\":\"USD\",\"value\":\"12510.00\"},\"charges\":[\"10.00 USD (DEMOVNVX)\"],\"invoiceReferences\":[\"INV-1\",\" INV-2 \",\"INV-1\"],\"otherDocuments\":[\"PUOR PO-88812\"],\"regulatoryReporting\":[\"CRED EXPORT VN CERAMICS\"],\"present\":[\"MsgId\",\"PmtId\",\"UltmtDbtr\",\"UltmtCdtr\",\"InstrForCdtrAgt\",\"InstrForNxtAgt\",\"77T\",\"72\",\"23E\"]}", "{}");
        Check.equal("[{\"source\":\"ChrgBr\",\"value\":\"DEBT\",\"why\":\"charges follow the quote: the platform fee is added to the funding leg and the beneficiary is paid the full trade amount\"},{\"source\":\"XchgRate\",\"value\":\"1.1\",\"why\":\"both conversion rates are fixed by the quote the instruction cites, not by the message\"},{\"source\":\"IntrBkSttlmDt\",\"value\":\"2026-11-17\",\"why\":\"settlement starts when the instruction is accepted; there is no forward value date\"},{\"source\":\"IntrmyAgt1…3\",\"value\":\"INTMSGSG\",\"why\":\"the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly\"},{\"source\":\"IntrmyAgt1…3\",\"value\":\"Correspondent\",\"why\":\"the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly\"},{\"source\":\"IntrmyAgt1…3\",\"value\":\"021000021\",\"why\":\"the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly\"},{\"source\":\"IntrmyAgt1…3\",\"value\":\"?\",\"why\":\"the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly\"},{\"source\":\"IntrmyAgt1…3\",\"value\":\"?\",\"why\":\"the corridor has no correspondent chain — the settlement entity pays the beneficiary institution directly\"},{\"source\":\"CdtTrfTxInf/InstdAmt\",\"value\":\"12510.00 USD\",\"why\":\"charges were deducted on the way: the interbank amount is what the beneficiary is owed, and what is sent\"},{\"source\":\"ChrgsInf\",\"value\":\"10.00 USD (DEMOVNVX)\",\"why\":\"charges follow the quote: the platform fee is added to the funding leg; a charge the message records stays with the bank's own accounting\"},{\"source\":\"CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)\",\"value\":\" INV-2 \",\"why\":\"the instruction carries one commercial reference; a further invoice stays in the bank's message, whose digest the instruction cites\"},{\"source\":\"RmtInf/Strd/RfrdDocInf\",\"value\":\"PUOR PO-88812\",\"why\":\"a referred document that is not an invoice (a purchase order, a credit note …) — it is not the commercial reference\"},{\"source\":\"field 77T\",\"value\":\"(present)\",\"why\":\"not read — the envelope contents of an MT103 REMIT stay in the bank's message; carry the invoice reference in field 70\"},{\"source\":\"RgltryRptg\",\"value\":\"CRED EXPORT VN CERAMICS\",\"why\":\"regulatory reporting stays with the bank's own reporting system and is not forwarded\"},{\"source\":\"UltmtDbtr\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"},{\"source\":\"UltmtCdtr\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"},{\"source\":\"InstrForCdtrAgt\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"},{\"source\":\"InstrForNxtAgt\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"},{\"source\":\"field 72\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"},{\"source\":\"field 23E\",\"value\":\"(present)\",\"why\":\"not read — the corridor carries the debtor and the creditor only, and no agent instructions\"}]",
                Json.compact(json(m.unmapped())), "everything without a place, in the reference's order: an invoice equal to the one taken is not listed again, and an intermediary that states nothing — an empty BIC is no BIC — is \"?\"");
        Check.equal("12500.00 USD|CdtTrfTxInf/IntrBkSttlmAmt", field(m, "trade.amount").value() + "|" + field(m, "trade.amount").source(),
                "the smaller of two amounts in the corridor's currency is the trade");

        // An intermediary is named by the first thing it states — its BIC, its name, its member id — trimmed:
        // an empty or blank value states nothing, and what states nothing at all is "?".
        SwiftMapping via = map("pacs008", "{\"intermediaryAgents\":[{\"bic\":\"\",\"name\":\"Correspondent Bank\"},{\"bic\":\" \",\"name\":\"\",\"memberId\":\"\"},"
                + "{\"bic\":\" INTMSGSG \"},{\"name\":\"\\u3000\",\"memberId\":\" 021000021\"},{\"bic\":\"\\n\",\"name\":\"\\t\"}]}", "{}");
        Check.equal(Arrays.asList("IntrmyAgt1…3|Correspondent Bank", "IntrmyAgt1…3|?", "IntrmyAgt1…3|INTMSGSG", "IntrmyAgt1…3|021000021", "IntrmyAgt1…3|?"),
                sourcesAndValues(unmappedFrom(via, "IntrmyAgt1…3")), "each intermediary, by what it does state");
        Check.equal(0, via.issues().size(), "an intermediary is no issue");
        SwiftMapping viaMt = map("mt103", "{\"intermediaryAgents\":[{\"bic\":\"\",\"name\":\"CORRESPONDENT BANK\"},{\"bic\":\" \"}]}", "{}");
        Check.equal(Arrays.asList("field 56a|CORRESPONDENT BANK", "field 56a|?"), sourcesAndValues(unmappedFrom(viaMt, "field 56a")),
                "in an MT103, field 56a");

        // Which amount names the trade decides the reason the other one is listed with.
        String[][] whys = {
            {"mt103", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"1000\"},\"amount\":{\"currency\":\"USD\",\"value\":\"1000\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"1015\"}}",
                "field 32A|1015 USD|the interbank amount includes charges prepaid for the receiving bank; the beneficiary is owed the instructed amount, and that is what is sent"},
            {"pacs008", "{\"instructedAmount\":{\"currency\":\"VND\",\"value\":\"322537500\"},\"amount\":{\"currency\":\"VND\",\"value\":\"322537500\"}}",
                "CdtTrfTxInf/InstdAmt|322537500 VND|the interbank amount is in the corridor's currency and names the trade; the instructed amount is the same payment before conversion"},
            {"pacs008", "{\"settlementAmount\":{\"currency\":\"SGD\",\"value\":\"16687.50\"}}",
                "CdtTrfTxInf/IntrBkSttlmAmt|16687.50 SGD|the instructed amount is in the corridor's currency and names the trade; the settlement leg is recomputed from the quote"},
            {"pacs008", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"100.10\"},\"amount\":{\"currency\":\"USD\",\"value\":\"100.10\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"100.1\"}}",
                null},
        };
        for (String[] w : whys) {
            SwiftMapping x = map(w[0], w[1], "{\"supplement\":{\"debtor\":{\"registration_number\":\"0312345678\"}}}");
            String got = null;
            for (SwiftMapping.Unmapped u : x.unmapped()) {
                // The entry for the other amount is the one whose value is an amount and a currency.
                if (AN_AMOUNT.matcher(u.value()).matches()) {
                    got = u.source() + "|" + u.value() + "|" + u.why();
                }
            }
            Check.equal(w[2], got, "the other amount of " + w[1]);
        }
    }

    private static final java.util.regex.Pattern AN_AMOUNT = java.util.regex.Pattern.compile("[0-9.]+ [A-Z]{3}");

    static void testAmountsAreComparedDigitByDigit() {
        // Of an instructed and a settled amount in the corridor's currency, the smaller is the trade — compared as
        // the decimals they are written as (the reference's compareDecimal), never as floating-point numbers. Each
        // row: instructed, settled, the one taken, and the trade amount — or "refused" when the amount check refuses
        // the one taken, which it names by its element.
        String[][] rows = {
            // What Number() read as a number is not a plain decimal — digits, then optionally a full stop and digits —
            // and cannot be put in order. The instructed amount is taken exactly when it is the malformed one (the
            // settled amount otherwise), so that the check refuses the malformed amount by name, whichever it is.
            {"0x10", "15", "instructed", "refused"}, {"1e1", "9.5", "instructed", "refused"}, {"", "5", "instructed", "refused"},
            {"abc", "5", "instructed", "refused"}, {"5", "abc", "settled", "refused"}, {".5", "0.6", "instructed", "refused"},
            {"5.", "5.01", "instructed", "refused"}, {" 7 ", "8", "instructed", "refused"}, {"\u00a07\u3000", "8", "instructed", "refused"},
            {"\u180e7", "8", "instructed", "refused"}, {"0b11", "4", "instructed", "refused"}, {"0o7", "8", "instructed", "refused"},
            {"0b2", "4", "instructed", "refused"}, {"+3", "4", "instructed", "refused"}, {"-3", "0", "instructed", "refused"},
            {"Infinity", "1e400", "instructed", "refused"}, {"+Infinity", "5", "instructed", "refused"}, {"-Infinity", "5", "instructed", "refused"},
            {"infinity", "5", "instructed", "refused"}, {"0X1F", "32", "instructed", "refused"}, {"-0x1", "5", "instructed", "refused"},
            {"1_0", "20", "instructed", "refused"}, {"1e", "5", "instructed", "refused"}, {"0x", "5", "instructed", "refused"},
            {"1d", "5", "instructed", "refused"}, {"0x1p3", "9", "instructed", "refused"}, {"\u0661", "5", "instructed", "refused"},
            {"\uff11", "5", "instructed", "refused"}, {"NaN", "5", "instructed", "refused"}, {"1.2.3", "5", "instructed", "refused"},
            {"+.5e-3", "0.001", "instructed", "refused"}, {"abc", "xyz", "instructed", "refused"}, {"", "", "instructed", "refused"},
            // A plain instructed amount against a malformed settled one: the settled one is taken, and refused.
            {"0", "-0", "settled", "refused"}, {"1000000000000000000000000000000", "1e30", "settled", "refused"},
            // Plain decimals, digit by digit — past double precision, where Number() made two amounts one …
            {"9007199254740993", "9007199254740992", "settled", "9007199254740992"},
            {"9007199254740992", "9007199254740993", "instructed", "9007199254740992"},
            {"0.1", "0.10000000000000001", "instructed", "0.1"},
            {"999999999999999.98", "999999999999999.99", "instructed", "999999999999999.98"},
            {"999999999999999.99", "999999999999999.98", "settled", "999999999999999.98"},
            {"123456789012345.12", "123456789012345.13", "instructed", "123456789012345.12"},
            {"1000000000000000000000000000000", "999999999999999999999999999999.99", "settled", "999999999999999999999999999999.99"},
            // … with leading zeros, which do not count and stay in the trade amount as written (the reference takes
            // "00012"), and with fractions of different lengths: equal amounts, however written, take the settled one …
            {"00012", "13", "instructed", "00012"}, {"0100", "100", "settled", "100"}, {"100", "0100", "settled", "0100"},
            {"007.50", "7.5", "settled", "7.5"}, {"12", "12.0", "settled", "12.0"}, {"7000.5", "7000.50", "settled", "7000.50"},
            {"100.10", "100.1", "settled", "100.1"},
            // … and the smaller is taken even when the check then refuses it: the order does not judge the amount.
            {"0.00", "0", "settled", "refused"}, {"99.999", "100", "instructed", "refused"}, {"12499.995", "12500", "instructed", "refused"},
            {"100.001", "100", "settled", "100"}, {"12500.001", "12500.00", "settled", "12500.00"},
            {"7010.50", "7000.50", "settled", "7000.50"}, {"1000", "1015", "instructed", "1000"},
        };
        List<String> failures = new ArrayList<>();
        for (String[] r : rows) {
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("instructedAmount", amount("USD", r[0]));
            patch.put("amount", amount("USD", r[0]));
            patch.put("settlementAmount", amount("USD", r[1]));
            SwiftMapping m = Swift.map(payment("pacs008", Json.compact(patch)), null);
            SwiftMapping.Field f = field(m, "trade.amount");
            String source = f == null ? null : f.source();
            for (SwiftMapping.Issue i : m.issues()) {
                if (i.target().equals("trade.amount")) {
                    source = i.source();
                }
            }
            String taken = "CdtTrfTxInf/InstdAmt".equals(source) ? "instructed" : "CdtTrfTxInf/IntrBkSttlmAmt".equals(source) ? "settled" : source;
            String outcome = f == null ? "refused" : m.input() == null ? "taken, with other issues" : m.input().tradeAmount();
            if (!(taken + " " + outcome).equals(r[2] + " " + r[3]) || m.issues().size() != (f == null ? 1 : 0)) {
                failures.add(Json.compact(r[0]) + " against " + Json.compact(r[1]) + ": the " + taken + " amount, " + outcome + " ("
                        + m.issues().size() + " issue(s)) — the reference takes the " + r[2] + " amount, " + r[3]);
            }
        }
        Golden.none(failures, "instructed against settled");

        // Past double precision two amounts are still two: the smaller, instructed one is the trade, and the
        // interbank amount is listed with the reason a larger interbank amount has.
        SwiftMapping m = mapCase("beyond-double-precision");
        Check.equal("trade.amount|123456789012345.12 USD|stated|CdtTrfTxInf/InstdAmt", row(m, "trade.amount"), "the reference's trade amount");
        Check.equal("CdtTrfTxInf/IntrBkSttlmAmt|123456789012345.13 USD|the interbank amount includes charges prepaid for the receiving bank; the beneficiary is owed the instructed amount, and that is what is sent",
                m.unmapped().get(2).source() + "|" + m.unmapped().get(2).value() + "|" + m.unmapped().get(2).why(), "and the other one is listed");

        // An amount that is not a plain decimal is refused by its element and its value — the instructed one or the
        // settled one, whichever it is: it is not passed over for the other.
        Check.equal(Arrays.asList("trade.amount|CdtTrfTxInf/InstdAmt|\"twelve\" is not a positive USD amount with at most two decimals"),
                issueRows(mapCase("instructed-not-a-decimal")), "the instructed amount");
        Check.equal(Arrays.asList("trade.amount|CdtTrfTxInf/IntrBkSttlmAmt|\"twelve\" is not a positive USD amount with at most two decimals"),
                issueRows(mapCase("settled-not-a-decimal")), "the settled amount");
        Check.equal(Arrays.asList("trade.amount|field 33B|\"1,000.00\" is not a positive USD amount with at most two decimals"),
                issueRows(map("mt103", "{\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"1,000.00\"},\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"990.75\"}}", "{}")),
                "an MT103's instructed amount, field 33B");

        // The comparison itself, as the reference's compareDecimal answers: -1, 0 or 1, exactly …
        Check.equal(Arrays.asList(-1, 0, 0, -1, 1, 0, 1, 1, -1, 0, 1), Arrays.asList(
                SwiftMapper.compareDecimal("999999999999999.98", "999999999999999.99"), SwiftMapper.compareDecimal("100.5", "100.50"),
                SwiftMapper.compareDecimal("0100", "100"), SwiftMapper.compareDecimal("99.999", "100"), SwiftMapper.compareDecimal("100.001", "100"),
                SwiftMapper.compareDecimal("0.00", "0"), SwiftMapper.compareDecimal("1" + "0".repeat(30), "9".repeat(30) + ".99"),
                SwiftMapper.compareDecimal("9007199254740993", "9007199254740992"), SwiftMapper.compareDecimal("0.1", "0.10000000000000001"),
                SwiftMapper.compareDecimal("000", "0.0"), SwiftMapper.compareDecimal("10", "9")), "compareDecimal");
        // … and no answer for what is not a plain decimal, on either side — "1\n" too: the reference's $ is the end
        // of the text, not of a line.
        for (String bad : new String[] {"1e3", "", "1.", ".5", "-1", " 1", "1 ", "1,5", "\u0661\u0662", "\uff11", "+1", "0x1", "1\n", "Infinity", "NaN"}) {
            Check.equal(Arrays.asList(null, null), Arrays.asList(SwiftMapper.compareDecimal(bad, "1"), SwiftMapper.compareDecimal("1", bad)),
                    "compareDecimal of " + Json.compact(bad));
        }
    }

    private static List<String> issueRows(SwiftMapping m) {
        List<String> out = new ArrayList<>();
        for (SwiftMapping.Issue i : m.issues()) {
            out.add(i.target() + "|" + i.source() + "|" + i.problem());
        }
        return out;
    }

    private static Map<String, Object> amount(String currency, String value) {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("currency", currency);
        a.put("value", value);
        return a;
    }

    static void testTheCommercialReference() {
        SwiftMapping e2e = map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"E2E-77\"}", "{}");
        SwiftMapping.Field f = field(e2e, "invoice_ref");
        Check.equal("E2E-77|end-to-end identification (no invoice reference in the message)|inferred", f.value() + "|" + f.source() + "|" + f.basis(),
                "without an invoice reference, the end-to-end id");
        // NOTPROVIDED (in any letter case) is no reference; the first remittance line is, whitespace collapsed, cut at
        // 64 characters counted by code point: the emoji that is the 64th is kept whole, both of its UTF-16 units.
        SwiftMapping line = map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"notprovided\",\"remittanceInformation\":[\"  Payment\\u3000for \\u00a0 goods "
                + "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\ud83d\\ude00 and more\",\"second line\"]}", "{}");
        f = field(line, "invoice_ref");
        Check.equal("Payment for goods xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ud83d\ude00", f.value(), "the first remittance line, 64 code points");
        Check.equal("first line of the remittance information|inferred", f.source() + "|" + f.basis(), "and where it came from");
        Check.equal(null, line.input().source().get("endToEndId"), "NOTPROVIDED is not carried as the end-to-end id");
        Check.equal(null, field(line, "sourceMessage.endToEndId"), "nor listed");
        Check.equal("\"Payment for goods xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ud83d\ude00\"", Json.compact(line.input().invoiceRef()),
                "a whole pair is written as itself, as the reference writes it");

        // Where the cut falls: after 64 code points, never inside a pair; a space the cut ends on is not kept (white
        // space of any kind was collapsed to one space before). A lone surrogate that the message itself holds is a
        // code point of its own: the reference keeps it, and JSON writes it as its escape.
        String[][] cuts = {
            {"x".repeat(63) + "\ud83d\ude00tail", "x".repeat(63) + "\ud83d\ude00"},
            {"x".repeat(64) + "\ud83d\ude00", "x".repeat(64)},
            {"\ud83d\ude00".repeat(70), "\ud83d\ude00".repeat(64)},
            {"SPARE   PARTS", "SPARE PARTS"},
            {"x".repeat(63) + " tail", "x".repeat(63)},
            {"x".repeat(62) + "\ud83d\ude00 tail", "x".repeat(62) + "\ud83d\ude00"},
            {"x".repeat(63) + "\u3000\u00a0tail", "x".repeat(63)},
            {"x".repeat(63) + "\ud800tail", "x".repeat(63) + "\ud800"},
        };
        for (String[] c : cuts) {
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("invoiceReferences", new ArrayList<Object>());
            patch.put("endToEndId", "NOTPROVIDED");
            patch.put("remittanceInformation", Arrays.<Object>asList(c[0]));
            Check.equal(c[1], map("pacs008", Json.compact(patch), "{}").input().invoiceRef(), "the remittance line " + Json.compact(c[0]) + ", cut");
        }
        SwiftMapping lone = map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED\",\"remittanceInformation\":[\"" + "x".repeat(63) + "\\ud800tail\"]}", "{}");
        Check.equal("\"" + "x".repeat(63) + "\\ud800\"", Json.compact(lone.input().invoiceRef()), "the lone surrogate is written as its escape, as the reference writes it");

        SwiftMapping none = map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NONREF\",\"remittanceInformation\":[\" \"]}", "{}");
        Check.equal("the message cannot be turned into a settlement instruction — 1 thing(s) missing: invoice_ref (CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd))",
                new SwiftMappingException(none).getMessage(), "nothing identifies the commercial basis");
        Check.equal("carry the invoice number in the remittance information, or pass supplement.invoiceRef", none.issues().get(0).fix(), "and the fix says how");

        // The invoice taken is the first entry that says something, trimmed; the further invoices are compared with it
        // trimmed, and listed as the message writes them. An empty entry is no invoice: not the one taken, not a further one.
        SwiftMapping spaced = map("pacs008", "{\"invoiceReferences\":[\" INV-1 \"]}", "{}");
        Check.equal("invoice_ref|INV-1|stated|CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)", row(spaced, "invoice_ref"), "the invoice taken");
        Check.equal(Arrays.asList(), furtherInvoices(spaced), "and not listed again as a further invoice");
        SwiftMapping several = mapCase("padded-invoices");
        Check.equal("INV-1", several.input().invoiceRef(), "of \" INV-1 \", \"INV-1\" and \"INV-2\\n\", the first");
        Check.equal(Arrays.asList("INV-2\n"), furtherInvoices(several), "the same invoice once, a further one as written");
        SwiftMapping empty = mapCase("empty-invoices");
        Check.equal("INV-3", empty.input().invoiceRef(), "empty entries before it are passed over");
        Check.equal(Arrays.asList(), furtherInvoices(empty), "and are not further invoices");
        // The same reference from the customer master is the same reference; another one leaves the message's listed.
        SwiftMapping supplied = mapCase("padded-invoice-supplied");
        Check.equal("invoice_ref|INV-1|supplied|supplement", row(supplied, "invoice_ref"), "supplied");
        Check.equal(Arrays.asList(), furtherInvoices(supplied), "the message's \" INV-1 \" is the supplied INV-1");
        SwiftMapping other = map("pacs008", "{\"invoiceReferences\":[\" INV-1 \",\"INV-9\"]}", "{\"supplement\":{\"invoiceRef\":\" INV-9 \"}}");
        Check.equal("invoice_ref|INV-9|supplied|supplement", row(other, "invoice_ref"), "a supplied reference, trimmed");
        Check.equal(Arrays.asList(" INV-1 "), furtherInvoices(other), "the message's other invoice stays listed, as written");
        SwiftMapping blankOnly = map("pacs008", "{\"invoiceReferences\":[\"\",\"\\u3000\"],\"endToEndId\":\"E2E-5\"}", "{}");
        Check.equal("invoice_ref|E2E-5|inferred|end-to-end identification (no invoice reference in the message)", row(blankOnly, "invoice_ref"),
                "nothing but empty entries is no invoice reference: the end-to-end id comes next");

        // The words for "no reference" are no reference whatever white space surrounds them — a line break after
        // NOTPROVIDED too: the reference trims before it tests — and never the invoice. With nothing else in the
        // message, the payment is refused for its commercial basis.
        for (String word : new String[] {" NOTPROVIDED", "NOTPROVIDED\n", "\tnonref ", "NOREF\r\n", "\u3000NoRef\ufeff", "  ", ""}) {
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("invoiceReferences", new ArrayList<Object>());
            patch.put("endToEndId", word);
            SwiftMapping m = map("pacs008", Json.compact(patch), "{}");
            Check.equal(Arrays.asList("invoice_ref|CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)"), targetsAndSources(m.issues()),
                    Json.compact(word) + " is no reference");
            Check.equal(Arrays.asList(null, null), Arrays.asList(field(m, "invoice_ref"), field(m, "sourceMessage.endToEndId")),
                    Json.compact(word) + " is neither the invoice nor the end-to-end id");
        }
        Check.equal("invoice_ref|Invoice 77|inferred|first line of the remittance information",
                row(map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\" NOTPROVIDED\",\"remittanceInformation\":[\"Invoice 77\"]}", "{}"), "invoice_ref"),
                "after a word for no reference, the remittance line");
        // A real end-to-end id is taken trimmed — as the invoice, and as the reference the instruction cites.
        SwiftMapping padded = mapCase("padded-end-to-end-id");
        Check.equal(Arrays.asList("invoice_ref|PO-7781|inferred|end-to-end identification (no invoice reference in the message)",
                "sourceMessage.endToEndId|PO-7781|stated|PmtId/EndToEndId"), Arrays.asList(row(padded, "invoice_ref"), row(padded, "sourceMessage.endToEndId")),
                "\" PO-7781\\n\", trimmed");
        Check.equal(Arrays.asList("PO-7781", "PO-7781"), Arrays.asList(padded.input().invoiceRef(), padded.input().source().get("endToEndId")), "in the input");
        // A word that only starts like one of them is a real reference.
        Check.equal("invoice_ref|NOTPROVIDED-1|inferred|end-to-end identification (no invoice reference in the message)",
                row(map("pacs008", "{\"invoiceReferences\":[],\"endToEndId\":\"NOTPROVIDED-1\"}", "{}"), "invoice_ref"), "a reference that only starts like NOTPROVIDED");
    }

    /** The values listed as further invoices of an ISO 20022 message. */
    private static List<String> furtherInvoices(SwiftMapping m) {
        List<String> out = new ArrayList<>();
        for (SwiftMapping.Unmapped u : unmappedFrom(m, "CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)")) {
            out.add(u.value());
        }
        return out;
    }

    static void testTheCustomerMasterWins() {
        SwiftMapping m = map("pacs008", "{}", "{\"supplement\":{\"debtor\":{\"name\":\" Vina\\u3000Trading\\ufeff \",\"country\":\"  \",\"registration_number\":\"\\u00a0\",\"account\":null},\"creditor\":\"not an object\",\"invoiceRef\":\" INV-SUP \",\"purposeCode\":\"  \"}}");
        Check.equal(Arrays.asList("debtor.name|Vina\u3000Trading|supplied|supplement", "debtor.country|VN|stated|CdtTrfTxInf/Dbtr/PstlAdr/Ctry",
                "debtor.registration_number|0312345678|stated|CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID", "creditor.name|Pacific Supply Pte Ltd|stated|CdtTrfTxInf/Cdtr/Nm",
                "invoice_ref|INV-SUP|supplied|supplement", "purpose_code|GDDS|stated|CdtTrfTxInf/Purp"),
                Arrays.asList(row(m, "debtor.name"), row(m, "debtor.country"), row(m, "debtor.registration_number"), row(m, "creditor.name"),
                        row(m, "invoice_ref"), row(m, "purpose_code")),
                "a supplied value is trimmed as the reference trims (U+3000 inside stays, U+FEFF at the end goes); whitespace alone supplies nothing; a member that is not an object has no values");
        Check.equal("CdtTrfTxInf/RmtInf (Strd/RfrdDocInf/Nb, or /INV/ in Ustrd)|INV-2026-0457", m.unmapped().get(2).source() + "|" + m.unmapped().get(2).value(),
                "the message's invoice, set aside for the supplied one, is listed");

        // A value that is not a string fails, as `trim` on it fails in the reference — it is not taken as absent.
        Check.fails(ClassCastException.class, () -> map("pacs008", "{}", "{\"supplement\":{\"debtor\":{\"name\":5}}}"));
        Check.fails(ClassCastException.class, () -> map("pacs008", "{}", "{\"supplement\":{\"invoiceRef\":true}}"));
        Check.equal(0, map("pacs008", "{}", "{\"supplement\":{\"debtor\":{\"name\":null},\"creditor\":[\"x\"]}}").issues().size(),
                "null is no value, and an array has no members");
    }

    private static String row(SwiftMapping m, String target) {
        SwiftMapping.Field f = field(m, target);
        return f == null ? null : f.target() + "|" + f.value() + "|" + f.basis() + "|" + f.source();
    }

    static void testTheSourceReferenceKeepsTheReferenceOrder() {
        SwiftMapping batch = map("pain001", "{\"transactionCount\":3,\"index\":2,\"endToEndId\":\"NOTPROVIDED\"}", "{}");
        Check.equal("{\"type\":\"pain.001.001.09\",\"sha256\":\"4fc04ccec498accd32f3d130ca568b84d0068b4c37580f9902a112eaa174c8b0\",\"content\":\"94e234b1b44e21dbf80f41dc1fd2324b43233d57a2116965c6cc32d1b39493f8\",\"valueDate\":\"2026-11-17\",\"index\":2,\"paymentInfoId\":\"VINATRD-PMT-0031\",\"messageId\":\"VINATRD-20261117-0031\",\"instructionId\":\"VINATRD-INS-0031-1\"}",
                Json.compact(batch.input().source()), "the position in a batch, the block, then the references, in the reference's order");
        Check.equal("VINATRD-INS-0031-1", batch.input().instructionRef(), "the instruction's own reference");
        Check.equal("{\"debtor\":{\"name\":\"Vina Trading Co., Ltd.\",\"country\":\"VN\",\"address\":\"Le Loi Boulevard 12, Ho Chi Minh City\",\"registration_number\":\"0312345678\",\"account\":\"VN-ACC-000777\"},\"creditor\":{\"name\":\"Pacific Supply Pte Ltd\",\"country\":\"SG\",\"account\":\"SG-ACC-000009\",\"bank\":\"DEMOSGSG\"}}",
                Json.compact(batch.input().parties()), "the parties, in the shape and order the instruction takes them");
        Check.equal(Arrays.asList("tradeAmount", "tradeCurrency", "parties", "invoiceRef", "purposeCode", "instructionRef", "source", "messageFields"),
                new ArrayList<>(batch.input().toJson().keySet()), "the input's keys");

        // An empty instruction id is no instruction id: it does not hide the block's id, which is the reference.
        SwiftMapping empty = map("pain001", "{\"instructionId\":\"\"}", "{}");
        Check.equal("VINATRD-PMT-0031", empty.input().instructionRef(), "the payment-information id");
        Check.equal(Arrays.asList("tradeAmount", "tradeCurrency", "parties", "invoiceRef", "purposeCode", "instructionRef", "source", "messageFields"),
                new ArrayList<>(empty.input().toJson().keySet()), "in its place in the JSON");
        Check.equal("{\"type\":\"pain.001.001.09\",\"sha256\":\"4fc04ccec498accd32f3d130ca568b84d0068b4c37580f9902a112eaa174c8b0\",\"content\":\"91ffb44a8d7cd54b12a879c046abb00c4cb4c59eab48beecd993dd82aec0f588\",\"valueDate\":\"2026-11-17\",\"paymentInfoId\":\"VINATRD-PMT-0031\",\"messageId\":\"VINATRD-20261117-0031\",\"endToEndId\":\"PO-7803\"}",
                Json.compact(empty.input().source()), "the source cites no empty instruction id");
        Check.fails(UnsupportedOperationException.class, () -> empty.input().source().put("x", "y"));
        Check.fails(UnsupportedOperationException.class, () -> empty.fields().clear());

        // The instruction's reference is the first of its own id, the block's id and the message id that says
        // something, trimmed; when none does, there is none (the client's own default applies).
        String[][] refs = {
            {"pain001", "{}", "VINATRD-INS-0031-1"},
            {"pain001", "{\"instructionId\":\" \",\"paymentInfoId\":\"\"}", "VINATRD-20261117-0031"},
            {"pain001", "{\"instructionId\":\"\",\"paymentInfoId\":\"\\t\",\"messageId\":\"\"}", null},
            {"pain001", "{\"instructionId\":\" VINATRD-INS-0031-1 \"}", "VINATRD-INS-0031-1"},
            {"pacs008", "{\"instructionId\":\"\"}", "DEMOVNVX20261117000123"},
            {"pacs008", "{\"instructionId\":\"\",\"messageId\":\"\"}", null},
            {"pacs008", "{\"instructionId\":null,\"messageId\":\" \"}", null},
            {"mt103", "{\"instructionId\":\"\",\"messageId\":\"\"}", null},
        };
        for (String[] r : refs) {
            SwiftInstructionInput input = map(r[0], r[1], "{}").input();
            Check.equal(Arrays.asList(r[2], r[2] != null), Arrays.asList(input.instructionRef(), input.toJson().containsKey("instructionRef")),
                    "the instruction reference of " + r[0] + " " + r[1]);
        }
        // White space alone is no reference — yet it is what the message states, and the source cites it as stated;
        // a padded id is cited as written, too, while the reference is trimmed.
        SwiftMapping blank = mapCase("blank-instruction-id");
        Check.equal("{\"type\":\"pain.001.001.09\",\"sha256\":\"4fc04ccec498accd32f3d130ca568b84d0068b4c37580f9902a112eaa174c8b0\",\"content\":\"91ffb44a8d7cd54b12a879c046abb00c4cb4c59eab48beecd993dd82aec0f588\",\"valueDate\":\"2026-11-17\",\"messageId\":\"VINATRD-20261117-0031\",\"instructionId\":\" \",\"endToEndId\":\"PO-7803\"}",
                Json.compact(blank.input().source()), "the source of a blank instruction id and an empty block id");
        Check.equal(Arrays.asList("sourceMessage.messageId|VINATRD-20261117-0031|stated|GrpHdr/MsgId", "sourceMessage.instructionId| |stated|PmtId/InstrId",
                "sourceMessage.endToEndId|PO-7803|stated|PmtId/EndToEndId"),
                Arrays.asList(row(blank, "sourceMessage.messageId"), row(blank, "sourceMessage.instructionId"), row(blank, "sourceMessage.endToEndId")),
                "and the references it lists");
        SwiftMapping paddedId = map("pain001", "{\"instructionId\":\" VINATRD-INS-0031-1 \"}", "{}");
        Check.equal(Arrays.asList("VINATRD-INS-0031-1", " VINATRD-INS-0031-1 "), Arrays.asList(paddedId.input().instructionRef(), paddedId.input().source().get("instructionId")),
                "the reference trimmed, the source as stated");
    }

    static void testCountriesAndTheRoute() {
        SwiftMapping inferred = map("mt103", "{\"debtor\":{\"country\":null},\"creditor\":{\"country\":null},\"debtorAgent\":{\"bic\":\"aaaavnvx\"},\"creditorAgent\":{\"country\":\"SG\",\"memberId\":\"7171\",\"clearingSystem\":\"\"}}",
                "{\"supplement\":{\"debtor\":{\"registration_number\":\"1\"}}}");
        Check.equal(Arrays.asList("debtor.country|VN|inferred|field 52A or the sender BIC (country letters of the BIC)",
                "creditor.country|SG|inferred|field 57a or the receiver BIC (country letters of the BIC)",
                "creditor.bank|DEMOSGSG · clearing member 7171|stated|field 57a or the receiver BIC"),
                Arrays.asList(row(inferred, "debtor.country"), row(inferred, "creditor.country"), row(inferred, "creditor.bank")),
                "countries from the agents' BICs (a lower-case BIC too); an empty clearing system is none: the member id is a clearing member's");

        // A country the beneficiary's bank states in its address — the bank has no BIC — is labelled as that, not as the letters of a BIC.
        SwiftMapping agentCountry = map("pacs008", "{\"creditor\":{\"country\":null},\"creditorAgent\":{\"bic\":null,\"name\":null,\"country\":\"SG\",\"memberId\":\"026009593\",\"clearingSystem\":\"SGIBG\"}}", "{}");
        Check.equal("creditor.country|SG|inferred|CdtTrfTxInf/CdtrAgt/FinInstnId/PstlAdr/Ctry (the country of the beneficiary's bank)", row(agentCountry, "creditor.country"),
                "the country of the beneficiary's bank, by its element");
        Check.equal("creditor.bank|SGIBG 026009593|stated|CdtTrfTxInf/CdtrAgt/FinInstnId", row(agentCountry, "creditor.bank"), "a bank known by its clearing number");
        Check.equal(0, agentCountry.issues().size(), "and nothing is missing");
        SwiftMapping mtAgent = mapCase("country-from-agent-country-mt");
        Check.equal("creditor.country|SG|inferred|field 57a or the receiver BIC (the country of the beneficiary's bank)", row(mtAgent, "creditor.country"),
                "an MT103's field 57a, taken for what it is");
        Check.equal(0, mtAgent.issues().size(), "and nothing is missing there either");
        // With a BIC, it is the BIC's letters, and says so — whatever country the bank states.
        Check.equal("creditor.country|SG|inferred|CdtTrfTxInf/CdtrAgt/FinInstnId (country letters of the BIC)",
                row(map("pacs008", "{\"creditor\":{\"country\":null},\"creditorAgent\":{\"country\":\"MY\"}}", "{}"), "creditor.country"), "the BIC first");
        // Told not to infer, it does not — from either.
        Check.equal(Arrays.asList("creditor.country|CdtTrfTxInf/Cdtr/PstlAdr/Ctry"),
                targetsAndSources(map("pacs008", "{\"creditor\":{\"country\":null},\"creditorAgent\":{\"bic\":null,\"country\":\"SG\"}}", "{\"inferCountryFromBic\":false}").issues()),
                "no inference from the bank's address");

        SwiftMapping strict = map("mt103", "{\"debtor\":{\"country\":null},\"creditor\":{\"country\":null},\"creditorAgent\":{\"country\":\"SG\",\"memberId\":\"7171\"}}", "{\"inferCountryFromBic\":false}");
        Check.equal(Arrays.asList("debtor.country|field 50F line 3/ or field 77B /ORDERRES/", "creditor.country|field 59F line 3/ or field 77B /BENEFRES/"),
                targetsAndSources(strict.issues()), "without inference the countries are missing");
        Check.equal("creditor.bank|DEMOSGSG · clearing member 7171|stated|field 57a or the receiver BIC", row(strict, "creditor.bank"), "a member id without its system");

        // A member id is a "clearing member"'s, with one space, unless a clearing system says something — trimmed.
        String[][] banks = {
            {"{\"memberId\":\"7171\"}", "Demo Payout Bank (SG) · BIC DEMOSGSG · clearing member 7171"},
            {"{\"memberId\":\"7171\",\"clearingSystem\":\"\"}", "Demo Payout Bank (SG) · BIC DEMOSGSG · clearing member 7171"},
            {"{\"memberId\":\"7171\",\"clearingSystem\":\"  \"}", "Demo Payout Bank (SG) · BIC DEMOSGSG · clearing member 7171"},
            {"{\"memberId\":\"7171\",\"clearingSystem\":\" SGIBG \"}", "Demo Payout Bank (SG) · BIC DEMOSGSG · SGIBG 7171"},
            {"{\"bic\":null,\"memberId\":\"7171\",\"clearingSystem\":\"SGIBG\"}", "Demo Payout Bank (SG) · SGIBG 7171"},
        };
        for (String[] b : banks) {
            Check.equal("creditor.bank|" + b[1] + "|stated|CdtTrfTxInf/CdtrAgt/FinInstnId", row(map("pacs008", "{\"creditorAgent\":" + b[0] + "}", "{}"), "creditor.bank"),
                    "the bank of " + b[0]);
        }

        SwiftMapping us = map("pacs008", "{}", "{\"corridor\":{\"origin\":\"VN\",\"destination\":\"US\"}}");
        Check.equal(Arrays.asList("the beneficiary is in SG; this corridor carries payments from VN to US",
                "the beneficiary's bank is in SG; the payout of this corridor is made in US"), problems(us), "another corridor");
        Check.equal("send this payment through the channel you use for that route today", us.issues().get(0).fix(), "the fix for another route");

        SwiftMapping noDestination = map("pacs008", "{\"debtor\":{\"country\":\"TH\"}}", "{\"corridor\":{\"origin\":\"VN\"}}");
        Check.equal(Arrays.asList("the ordering customer is in TH; this corridor carries payments from VN to undefined",
                "the beneficiary is in SG; this corridor carries payments from VN to undefined",
                "the beneficiary's bank is in SG; the payout of this corridor is made in undefined"), problems(noDestination),
                "a corridor without a destination is written as the reference writes it");

        SwiftMapping my = map("pacs008", "{\"creditorAgent\":{\"bic\":\"DEMOMYKL\",\"country\":\"SG\"}}", "{}");
        Check.equal(Arrays.asList("the beneficiary's bank is in MY; the payout of this corridor is made in SG"), problems(my),
                "the BIC's country wins over the agent's stated country");

        // A blank country of the beneficiary's bank states no country: it is not a bank "in  ". A padded one is trimmed.
        for (String blank : new String[] {"{\"bic\":null,\"country\":\" \"}", "{\"bic\":null,\"country\":\"\"}", "{\"bic\":null,\"country\":\"\\u3000\"}"}) {
            Check.equal(Arrays.asList(), problems(map("pacs008", "{\"creditorAgent\":" + blank + "}", "{}")), "the payout country of " + blank);
        }
        Check.equal(Arrays.asList("the beneficiary's bank is in MY; the payout of this corridor is made in SG"),
                problems(map("pacs008", "{\"creditorAgent\":{\"bic\":null,\"country\":\" MY \"}}", "{}")), "a padded country, trimmed");

        // An empty or blank trade currency is no currency: the default, USD. A padded one is trimmed.
        for (String currency : new String[] {"\"\"", "\"  \"", "null", "\" USD \""}) {
            SwiftMapping m = map("pacs008", "{}", "{\"tradeCurrency\":" + currency + "}");
            Check.equal(Arrays.asList(0, "USD"), Arrays.asList(m.issues().size(), m.input().tradeCurrency()), "the trade currency " + currency);
        }
        SwiftMapping eur = map("pacs008", "{}", "{\"tradeCurrency\":\" EUR \"}");
        Check.equal("the message instructs 12500.00 USD; this corridor denominates trades in EUR|send the EUR amount of the trade (the corridor converts the funding and payout legs itself, from the quote)",
                eur.issues().get(0).problem() + "|" + eur.issues().get(0).fix(), "\" EUR \" is EUR");

        SwiftMapping where = map("mt103", "{\"debtor\":{\"countryFrom\":\"CtryOfRes\",\"lei\":\"\",\"identification\":\"0312345678\"},\"creditor\":{\"countryFrom\":\"field 77B /BENEFRES/\"}}", "{}");
        Check.equal(Arrays.asList("debtor.country|VN|stated|field 50 CtryOfRes", "creditor.country|SG|stated|field 77B /BENEFRES/"),
                Arrays.asList(row(where, "debtor.country"), row(where, "creditor.country")), "where a country stood, in the message's words");
        Check.equal("debtor.registration_number|0312345678|stated|field 50F line 6/ — CUST", row(where, "debtor.registration_number"),
                "an empty LEI is no LEI: the identification the message states is taken");
        Check.equal(0, where.issues().size(), "and nothing is missing");

        SwiftMapping lei = map("pacs008", "{\"debtor\":{\"lei\":\"5493001KJTIIGC8Y1R12\",\"countryFrom\":\"CtryOfRes\",\"identificationFrom\":\"\"}}", "{}");
        Check.equal(Arrays.asList("debtor.country|VN|stated|CdtTrfTxInf/Dbtr/CtryOfRes", "debtor.registration_number|5493001KJTIIGC8Y1R12|stated|CdtTrfTxInf/Dbtr/Id/OrgId/LEI"),
                Arrays.asList(row(lei, "debtor.country"), row(lei, "debtor.registration_number")), "an LEI is named as one");

        // An LEI that is empty or blank does not hide the identification; one that says something comes first, trimmed;
        // nothing but blank values is still nothing, and refused by name.
        String[][] ids = {
            {"{\"lei\":\"\"}", "debtor.registration_number|0312345678|stated|CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID"},
            {"{\"lei\":\"   \"}", "debtor.registration_number|0312345678|stated|CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID"},
            {"{\"lei\":\"\\u3000\"}", "debtor.registration_number|0312345678|stated|CdtTrfTxInf/Dbtr/Id/OrgId/Othr/Id — TXID"},
            {"{\"lei\":\" 9845003X7Y4K2B1Q8W63 \"}", "debtor.registration_number|9845003X7Y4K2B1Q8W63|stated|CdtTrfTxInf/Dbtr/Id/OrgId/LEI"},
            {"{\"lei\":\"\",\"identification\":\" \"}", null},
            {"{\"lei\":\" \",\"identification\":\"\"}", null},
        };
        for (String[] d : ids) {
            SwiftMapping m = map("pacs008", "{\"debtor\":" + d[0] + "}", "{}");
            Check.equal(d[1], row(m, "debtor.registration_number"), "the registration number of " + d[0]);
            Check.equal(d[1] != null ? Arrays.asList() : Arrays.asList("debtor.registration_number|CdtTrfTxInf/Dbtr/Id/OrgId (LEI or Othr/Id)"),
                    targetsAndSources(m.issues()), "what is missing with " + d[0]);
        }
        Check.equal("the ordering customer carries no identification (LEI, business registration number or tax id); the receiving institution requires one",
                mapCase("blank-lei-and-identification").issues().get(0).problem(), "in the reference's words");
    }

    private static List<String> problems(SwiftMapping m) {
        List<String> out = new ArrayList<>();
        for (SwiftMapping.Issue i : m.issues()) {
            out.add(i.problem());
        }
        return out;
    }

    static void testTheContentDigestIsThePaymentNotTheMessage() {
        String[][] rows = {
            {"pacs008", "{}", "fac9040b378c5d8e132d34558fbf34b6036ed763fa5f612727fc0cd11b16f811"},
            {"pacs008", "{\"settlementAmount\":{\"currency\":\"USD\",\"value\":\"12500.0\"},\"instructedAmount\":{\"currency\":\"USD\",\"value\":\"12500\"},\"amount\":{\"currency\":\"USD\",\"value\":\"12500.000\"}}",
                "fac9040b378c5d8e132d34558fbf34b6036ed763fa5f612727fc0cd11b16f811"},
            {"pacs008", "{\"debtor\":{\"name\":\"  Vina\\u00a0Trading \\u3000 Co.,\\nLtd.\\ufeff\"}}", "fac9040b378c5d8e132d34558fbf34b6036ed763fa5f612727fc0cd11b16f811"},
            {"pacs008", "{\"endToEndId\":\"NOTPROVIDED\"}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"endToEndId\":null}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"debtor\":{\"name\":\"Vina \\ud800 Trading\"}}", "2fe4f661a118baecef099ba772c657b6335e82511593e271c8f632aba7b91aad"},
            {"mt103", "{\"invoiceReferences\":[\" A \",\"B  C\"],\"remittanceInformation\":[\"/INV/A\\r\\n/RFB/X\",\"\\u2028\"],\"transactionId\":\" T 1 \"}",
                "42e2ec06ca1cadb13fbf311fc23b0abb6be0479bb2943b9fc6d44e610efa2ee7"},
            {"pacs008", "{\"instructedAmount\":null,\"settlementAmount\":null}", "bd6784d0e157bb7d3dcabc692c642bf72c6c43f3a5a8949d2fbc5133d287049e"},
            // A word for "no reference" with white space around it is no end-to-end id, as the mapping reads it;
            // a real one is read trimmed, as the mapping takes it.
            {"pacs008", "{\"endToEndId\":\" NOTPROVIDED\"}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"endToEndId\":\"NOTPROVIDED\\n\"}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"endToEndId\":\"\\tnonref \"}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"endToEndId\":\"NOREF\\r\\n\"}", "3ec85ba70857cac3d9dd03c5d67d97f99e2c630fd297e8043d38ea1ac7abb367"},
            {"pacs008", "{\"endToEndId\":\" PO-7781\\n\"}", "fac9040b378c5d8e132d34558fbf34b6036ed763fa5f612727fc0cd11b16f811"},
            {"pacs008", "{\"endToEndId\":\"NOTPROVIDED-1\"}", "81d727e2417935f0a58a1e6e5b18e3222080ebc1658169b648298ac82200d136"},
        };
        for (String[] r : rows) {
            Check.equal(r[2], Swift.contentDigest(payment(r[0], r[1])), "the content digest of " + r[1]);
        }
    }

    static void testThePaymentIdIsTheMessagesIdentity() {
        String[][] rows = {
            {"pacs008", "{}", "VN-BANK-T1", "PAY-3f1c9a52-175c822e37"},
            {"pacs008", "{\"uetr\":null}", "VN-BANK-T1", "PAY-4eb61666-ceb6509152"},
            {"pacs008", "{\"uetr\":null,\"distinctIds\":false,\"index\":4}", "VN-BANK-T1", "PAY-a3219a4d-707d2de92b"},
            {"pacs008", "{\"uetr\":null,\"distinctIds\":null}", "VN-BANK-T1", "PAY-787b8375-b31fbc84ac"},
            {"pacs008", "{\"uetr\":null,\"messageType\":null,\"endToEndId\":null,\"valueDate\":null}", "VN-BANK-T1", "PAY-1c088287-9c14908b50"},
            {"mt103", "{\"uetr\":null,\"messageId\":\"\"}", "VN-BANK-T1", "PAY-433960e7-51a2d39ad6"},
            {"pacs008", "{\"uetr\":\"\",\"messageId\":\"\",\"instructionId\":null,\"index\":1}", "VN-BANK-T1", "PAY-0a5c04cb-5d101e327d"},
            {"pacs008", "{\"uetr\":null,\"messageId\":null,\"instructionId\":null,\"digest\":null}", "VN-BANK-T1", "PAY-d073238f-9c3e557a7a"},
            {"pacs008", "{}", "VN-\ud800BANK", "PAY-3f1c9a52-cd39749dff"},
            {"pacs008", "{\"uetr\":null,\"messageId\":\"M-\\udc00-1\"}", "VN-BANK-T1", "PAY-547a9403-b689b8abf8"},
            {"pacs008", "{}", null, "PAY-3f1c9a52-75b0fe80d0"},
            // The words for "no end-to-end id" are no part of the identity: NOTPROVIDED, in any case and
            // whatever white space surrounds it, names the same payment as no end-to-end id at all.
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"NOTPROVIDED\"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\" notprovided \"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"NONREF\"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":null}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"NOTPROVIDED\\n\"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"\\tnonref \"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"\"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"  \"}", "VN-BANK-T1", "PAY-316d46cd-02a91565fd"},
            // A word that only contains one of them is a real id. A real id is part of the identity as the message
            // writes it — white space and all: " PO-7781\n" does not name the payment PO-7781 names ({"uetr":null}, PAY-4eb61666-…).
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\"NOTPROVIDED-1\"}", "VN-BANK-T1", "PAY-533f9dce-b65fbd8614"},
            {"pacs008", "{\"uetr\":null,\"endToEndId\":\" PO-7781\\n\"}", "VN-BANK-T1", "PAY-49a1d38c-8db4ddc5be"},
        };
        for (String[] r : rows) {
            Check.equal(r[3], Swift.paymentId(r[2], payment(r[0], r[1])), "the payment id of " + r[1] + " for " + Json.compact(r[2]));
        }
    }

    static void testIsoFieldNames() {
        Check.equal(Arrays.asList("InstrId", "Cdtr", "CdtrAcct", "Dbtr", "DbtrAcct", "UETR", "IntrBkSttlmAmt", "IntrBkSttlmDt", "InstdAmt", "XchgRate",
                "DbtrAgt", "IntrmyAgt1", "CdtrAgt", "Purp", "RgltryRptg", "ChrgBr", "RmtInf"),
                Swift.isoFieldNames(payment("mt103", "{\"present\":[\"20\",\"20\",\"59\",\"50K\",\"99Z\",\"121\",\"32A\",\"33B\",\"36\",\"52D\",\"56C\",\"57D\",\"59A\",\"26T\",\"77B\",\"71A\",\"70\",\"23B\",\"50A\"]}")),
                "an MT103's tags become elements, each once, in the order first met; a tag without one is dropped");
        Check.equal(Arrays.asList("MsgId", "InstrId", "InstrId", "Dbtr"),
                Swift.isoFieldNames(payment("pacs008", "{\"present\":[\"MsgId\",\"PmtId\",\"InstrId\",\"PmtId\",\"InstrId\",\"Dbtr\"]}")),
                "an ISO 20022 message keeps its own names, PmtId left out, repeats kept");
        Check.equal(Arrays.asList("20", "32A"), Swift.isoFieldNames(payment("mt103", "{\"format\":\"other\",\"present\":[\"20\",\"PmtId\",\"32A\"]}")),
                "what is not an MT103 is read as ISO 20022");
    }

    static void testTheExceptionAndTheOptions() {
        SwiftMapping complete = Swift.map(payment("pacs008", "{}"), null);
        SwiftMappingException e = new SwiftMappingException(complete);
        Check.equal("the message cannot be turned into a settlement instruction — 0 thing(s) missing: ", e.getMessage(), "made from a complete mapping, as the reference makes it");
        Check.isTrue(e instanceof RemitException && e.issues().isEmpty() && e.mapping() == complete, "a RemitException carrying the mapping");

        SwiftMappingOptions o = new SwiftMappingOptions();
        Check.equal(Arrays.asList(null, null, true, false, false, "VN", "SG"),
                Arrays.asList(o.supplement(), o.tradeCurrency(), o.inferCountryFromBic(), o.allowTestMessages(), o.corridorGiven(), o.corridorOrigin(), o.corridorDestination()),
                "the defaults");
        Check.equal(Json.compact(complete.toJson()), Json.compact(Swift.map(payment("pacs008", "{}"), o).toJson()), "null options are the defaults");
        o.corridor(null, "SG");
        Check.equal(Arrays.asList(true, null, "SG"), Arrays.asList(o.corridorGiven(), o.corridorOrigin(), o.corridorDestination()), "a corridor as given");

        Check.equal("LEI", SwiftMapper.identifierKind("5493001KJTIIGC8Y1R12"), "an LEI");
        Check.equal("other", SwiftMapper.identifierKind("0312345678"), "a registration number");
    }
}
