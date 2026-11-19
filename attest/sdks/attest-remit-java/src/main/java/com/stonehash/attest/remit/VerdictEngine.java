package com.stonehash.attest.remit;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The six-axis rules, re-run on the bank's own machine: the reference
 * engine ({@code evaluate} of the platform's rules package) and the pass that
 * verifies every element signature before it ({@code verifyEvidenceSignatures}),
 * rule for rule and in the same order.
 *
 * <p>It is a pure function of the evidence and the policy the package
 * carries: no clock, no network, no state. The evidence is read the way the
 * reference reads it — a member that is not there is not the same as one that
 * is {@code null}, {@code ===} is {@code ===} — because a rule that read a
 * value more kindly here than there would be a different rule.
 *
 * <p>Where the reference gives up (a policy it cannot interpret, an amount
 * that is not a decimal string) and where the evidence is of a shape this
 * port does not evaluate (a timestamp without a zone, text where a list
 * belongs), {@link NotEvaluable} is thrown. The caller reports that as a
 * failed check: an answer is never guessed, and nothing that could not be
 * evaluated is passed.
 *
 * <p>Held to {@code golden/verdict.json}: what the reference answers for the
 * same evidence and policy — each axis, and each finding's axis, code and
 * severity, in order.
 *
 * <p>The same rules serve the platform's own back end through {@link Rules},
 * which is a producer: what it answers is put into evidence packages and
 * committed to, so there the answer has to be the reference's own, whole and
 * to the letter — every finding with its sentence and its fields — also for
 * evidence of a shape this SDK declines to interpret on a bank's behalf. The
 * two readings differ in one switch ({@code strict}): strict is the bank's
 * (never guess), the other is the reference's (read every value the way
 * JavaScript reads it). Held to {@code golden/rules.json}.
 */
final class VerdictEngine {
    /** The elements, in the order the six-element model numbers them. */
    static final List<String> ELEMENTS = Collections.unmodifiableList(Arrays.asList(
            "chainTransfer", "payoutReceipts", "bankInstruction", "commercialDocs", "travelRule", "bankApproval"));

    /** The elements that can carry an issuer signature, in the order the signature pass visits them. */
    static final List<String> SIGNABLE = Collections.unmodifiableList(Arrays.asList(
            "payoutReceipts", "bankInstruction", "commercialDocs", "travelRule", "bankApproval", "chainTransfer"));

    /** The axes, in the order a verdict lists them. */
    static final List<String> AXES = Collections.unmodifiableList(Arrays.asList(
            "integrity", "issuer", "matching", "completeness", "regulatoryMapping", "businessFinality"));

    private static final Map<String, Integer> TRUST_ORDER = new HashMap<>();
    static {
        TRUST_ORDER.put("DEMO", 0);
        TRUST_ORDER.put("ATTESTED", 1);
        TRUST_ORDER.put("ACCREDITED", 2);
    }

    /** Names every JavaScript object answers to without having them: read as a member there, they are not "absent". */
    private static final Set<String> INHERITED = new HashSet<>(Arrays.asList("constructor", "toString", "toLocaleString", "valueOf",
            "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__proto__", "__defineGetter__", "__defineSetter__",
            "__lookupGetter__", "__lookupSetter__"));

    private VerdictEngine() {
    }

    /** The reference gives up on this input, or it is of a shape this port does not evaluate. Never a pass. */
    static final class NotEvaluable extends RuntimeException {
        private static final long serialVersionUID = 1L;

        /**
         * Whose words the message is: {@code policy} and {@code amount} are
         * the reference's own sentences, about the policy and about a decimal
         * that is not one; {@code shape} and {@code nopolicy} are sentences
         * of this SDK's, about the evidence and about the policy, where the
         * reference fails inside the JavaScript engine or this port declines
         * to read the value.
         */
        final String kind;

        NotEvaluable(String message) {
            this("shape", message);
        }

        NotEvaluable(String kind, String message) {
            super(message);
            this.kind = kind;
        }
    }

    /** One observation of the engine: which axis it bears on, what it is, how much it weighs — and what it says. */
    static final class Finding {
        final String axis;
        final String code;
        /** {@code info}, {@code warning} or {@code blocking}. */
        final String severity;
        /** One sentence, in English, as the reference words it. */
        final String detail;
        /** {@code element}, {@code field}, {@code expected}, {@code actual}, {@code tolerance} — those the rule states, in its order. */
        final Map<String, Object> extra;

        Finding(String axis, String code, String severity, String detail, Map<String, Object> extra) {
            this.axis = axis;
            this.code = code;
            this.severity = severity;
            this.detail = detail;
            this.extra = extra;
        }

        /** The finding as the reference writes it. */
        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("axis", axis);
            out.put("code", code);
            out.put("severity", severity);
            out.put("detail", detail);
            for (Map.Entry<String, Object> e : extra.entrySet()) {
                out.put(e.getKey(), copy(e.getValue()));     // a copy: the result shares nothing with the evidence it speaks of
            }
            return out;
        }

        @Override
        public String toString() {
            return axis + ":" + code + ":" + severity;
        }
    }

    /** A verdict: the state of each axis, in {@link #AXES} order, and every finding in the order the rules ran. */
    static final class Result {
        final Map<String, String> states;
        final List<Finding> findings;
        final Object policyVersion;
        final String policyDigest;
        /** What the evidence says of itself, as it says it; {@link #UNDEFINED} where it says nothing. */
        final Object scenario;
        final Object dataMode;
        final boolean manualReviewRequired;

        Result(Map<String, String> states, List<Finding> findings, Object policyVersion, String policyDigest, Object scenario, Object dataMode,
                boolean manualReviewRequired) {
            this.states = Collections.unmodifiableMap(states);
            this.findings = Collections.unmodifiableList(findings);
            this.policyVersion = policyVersion;
            this.policyDigest = policyDigest;
            this.scenario = scenario;
            this.dataMode = dataMode;
            this.manualReviewRequired = manualReviewRequired;
        }

        /** The whole result as the reference returns it — its {@code MatchingResult}, member for member and in its order. */
        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("policyVersion", policyVersion);
            out.put("policyDigest", policyDigest);
            if (scenario != UNDEFINED) {
                out.put("scenario", copy(scenario));
            }
            if (dataMode != UNDEFINED) {
                out.put("dataMode", copy(dataMode));
            }
            Map<String, Object> axes = new LinkedHashMap<>();
            for (String axis : AXES) {
                List<Object> own = new ArrayList<>();
                for (Finding f : findings) {
                    if (f.axis.equals(axis)) {
                        own.add(f.toJson());
                    }
                }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("state", states.get(axis));
                entry.put("findings", own);
                axes.put(axis, entry);
            }
            out.put("axes", axes);
            List<Object> all = new ArrayList<>();
            for (Finding f : findings) {
                all.add(f.toJson());
            }
            out.put("findings", all);
            out.put("manualReviewRequired", manualReviewRequired);
            out.put("regulatoryDecision", "NOT_EVALUATED");
            return out;
        }
    }

    /** A key a signature can be checked against: who the keyring says holds it, how far it is trusted, and the key itself. */
    static final class Key {
        /** The name the registry gives the institution: text, or whatever the snapshot holds there ({@link #UNDEFINED} when nothing). */
        final Object issuer;
        /** SPKI, base64 — or {@code null} for a key that cannot be used, against which nothing verifies. */
        final String spkiBase64;
        /** {@code DEMO}, {@code ATTESTED}, {@code ACCREDITED} — or whatever the keyring states ({@link #UNDEFINED} when nothing). */
        final Object trustLevel;

        /** A key of a Trust Registry snapshot: every one is {@code ATTESTED}. */
        Key(Object issuer, String spkiBase64) {
            this(issuer, spkiBase64, "ATTESTED");
        }

        Key(Object issuer, String spkiBase64, Object trustLevel) {
            this.issuer = issuer;
            this.spkiBase64 = spkiBase64;
            this.trustLevel = trustLevel;
        }
    }

    private static final class Findings {
        final List<Finding> all = new ArrayList<>();

        /** @param extra {@code name, value, name, value, …}; a value that is not there is left out, as it is when the reference's finding is written */
        void add(String axis, String code, String severity, String detail, Object... extra) {
            Map<String, Object> more = new LinkedHashMap<>();
            for (int i = 0; i + 1 < extra.length; i += 2) {
                if (extra[i + 1] != UNDEFINED) {
                    more.put((String) extra[i], extra[i + 1]);
                }
            }
            all.add(new Finding(axis, code, severity, detail, more));
        }

        boolean has(String axis, String severity) {
            for (Finding f : all) {
                if (f.axis.equals(axis) && f.severity.equals(severity)) {
                    return true;
                }
            }
            return false;
        }
    }

    // ── values, as JavaScript reads them ──────────────────────────────────────

    /** A member that is not there. Not the same as {@code null}, which is a value a document can state. */
    static final Object UNDEFINED = new Object() {
        @Override
        public String toString() {
            return "undefined";
        }
    };

    private static boolean nullish(Object v) {
        return v == null || v == UNDEFINED;
    }

    /** {@code obj.key} of an object that is known to be one. */
    private static Object member(Map<String, Object> obj, String key) {
        return obj.containsKey(key) ? obj.get(key) : UNDEFINED;
    }

    /**
     * {@code value.key}: the member of an object, nothing for text, a number,
     * a boolean or a list (which have no such member) — and no answer at all
     * for {@code null} or a value that is not there, where the reference stops.
     */
    @SuppressWarnings("unchecked")
    private static Object prop(Object value, String key) {
        if (nullish(value)) {
            throw new NotEvaluable("the evidence holds nothing where ." + key + " is read");
        }
        return value instanceof Map ? member((Map<String, Object>) value, key) : UNDEFINED;
    }

    /** {@code value?.key}. */
    private static Object optProp(Object value, String key) {
        return nullish(value) ? UNDEFINED : prop(value, key);
    }

    static boolean truthy(Object v) {
        if (nullish(v)) {
            return false;
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof String) {
            return !((String) v).isEmpty();
        }
        if (v instanceof Number) {
            return number((Number) v) != 0;
        }
        return true;
    }

    private static double number(Number n) {
        return JsValue.number(n);
    }

    /** {@code a === b}. Two objects or two lists are never the same one here: each came out of the document on its own. */
    static boolean strictEquals(Object a, Object b) {
        if (a == UNDEFINED || b == UNDEFINED) {
            return a == b;
        }
        if (a == null || b == null) {
            return a == b;
        }
        if (a instanceof String || b instanceof String || a instanceof Boolean || b instanceof Boolean) {
            return a.equals(b);
        }
        if (a instanceof Number && b instanceof Number) {
            return number((Number) a) == number((Number) b);
        }
        return a == b;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object v) {
        return (List<Object>) v;
    }

    /** {@code list.includes(x)}. */
    private static boolean includes(List<Object> list, Object x) {
        for (Object item : list) {
            if (strictEquals(item, x)) {
                return true;
            }
        }
        return false;
    }

    /** "One element or a list of them", as a list; nothing when there is none. */
    private static List<Object> toArray(Object v) {
        if (nullish(v)) {
            return Collections.emptyList();
        }
        return v instanceof List ? list(v) : Collections.singletonList(v);
    }

    /** {@code value?.[0]}. */
    @SuppressWarnings("unchecked")
    private static Object first(Object v) {
        if (v instanceof List) {
            return ((List<?>) v).isEmpty() ? UNDEFINED : ((List<?>) v).get(0);
        }
        if (v instanceof Map) {
            return member((Map<String, Object>) v, "0");
        }
        if (v instanceof String) {
            String s = (String) v;
            return s.isEmpty() ? UNDEFINED : s.substring(0, 1);
        }
        return UNDEFINED;
    }

    /** {@code String.prototype.trim}: the SDK's white space is JavaScript's, member for member. */
    private static String trim(String s) {
        return Text.trim(s);
    }

    // ── decimals: amounts never become floating point ─────────────────────────

    /** {@code value / 10^scale}. */
    private static final class Dec {
        final BigInteger value;
        final int scale;

        Dec(BigInteger value, int scale) {
            this.value = value;
            this.scale = scale;
        }
    }

    private static final Pattern DECIMAL = Pattern.compile("[+-]?(\\d+)(\\.(\\d+))?");

    /** {@code typeof v}, for a value out of a JSON document. */
    private static String typeOf(Object v) {
        return v == UNDEFINED ? "undefined" : v instanceof String ? "string" : v instanceof Number ? "number" : v instanceof Boolean ? "boolean" : "object";
    }

    /**
     * A decimal string, or the reference's own refusal of anything else — the
     * empty string, an exponent, a separator, a number.
     *
     * <p>Where a sentence names the offending value, the bank's reading
     * ({@code strict}) keeps the shorter sentence it has always given and the
     * platform's is the reference's to the letter: here, and in the policy's
     * checks below.
     */
    private static Dec parseDecimal(Object s, String field, String kind, boolean strict) {
        if (!(s instanceof String)) {
            throw new NotEvaluable(kind, field + ": expected a decimal string" + (strict ? "" : ", got " + typeOf(s)));
        }
        String t = trim((String) s);
        Matcher m = DECIMAL.matcher(t);
        if (!m.matches()) {
            throw new NotEvaluable(kind, field + ": not a plain decimal string: " + Json.compact(s));
        }
        String fraction = m.group(3) == null ? "" : m.group(3);
        BigInteger value = new BigInteger(m.group(1) + fraction);
        return new Dec(t.startsWith("-") ? value.negate() : value, fraction.length());
    }

    private static BigInteger scaled(Dec x, int scale) {
        return x.value.multiply(BigInteger.TEN.pow(scale - x.scale));
    }

    private static Dec add(Dec x, Dec y) {
        int scale = Math.max(x.scale, y.scale);
        return new Dec(scaled(x, scale).add(scaled(y, scale)), scale);
    }

    private static Dec absDifference(Dec x, Dec y) {
        int scale = Math.max(x.scale, y.scale);
        return new Dec(scaled(x, scale).subtract(scaled(y, scale)).abs(), scale);
    }

    private static int compare(Dec x, Dec y) {
        int scale = Math.max(x.scale, y.scale);
        return scaled(x, scale).compareTo(scaled(y, scale));
    }

    /** {@code x * bps / 10000}, rounded up in magnitude: a tolerance is widened, never narrowed, by rounding. */
    private static Dec bps(Dec x, BigInteger basisPoints) {
        BigInteger[] qr = x.value.abs().multiply(basisPoints).divideAndRemainder(BigInteger.valueOf(10000));
        return new Dec(qr[1].signum() == 0 ? qr[0] : qr[0].add(BigInteger.ONE), x.scale);
    }

    /** Back to a plain decimal string, with every digit of its scale. */
    private static String format(Dec x) {
        StringBuilder digits = new StringBuilder(x.value.abs().toString());
        while (digits.length() < x.scale + 1) {
            digits.insert(0, '0');
        }
        String whole = digits.substring(0, digits.length() - x.scale);
        String fraction = x.scale > 0 ? digits.substring(digits.length() - x.scale) : "";
        return (x.value.signum() < 0 ? "-" : "") + whole + (fraction.isEmpty() ? "" : "." + fraction);
    }

    // ── the policy ────────────────────────────────────────────────────────────

    private static void need(boolean condition, String message) {
        if (!condition) {
            throw new NotEvaluable("policy", "policy: " + message);
        }
    }

    /** A non-negative whole number, as {@code Number.isInteger(v) && v >= 0} takes it. */
    private static boolean wholeAndNotNegative(Object v) {
        if (!(v instanceof Number)) {
            return false;
        }
        double d = number((Number) v);
        return !Double.isInfinite(d) && !Double.isNaN(d) && d == Math.rint(d) && d >= 0;
    }

    private static BigInteger whole(Object v) {
        return new BigDecimal(number((Number) v)).toBigInteger();
    }

    private static final Pattern DURATION = Pattern.compile("P(?:(\\d+)D)?(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?)?");

    /**
     * The policy, checked as the reference checks it — in its order and in
     * its words, which a caller is shown. Strict because a silently defaulted
     * field would change verdicts without changing the policy's digest.
     *
     * <p>The reference tests two members the way JavaScript tests them: the
     * settlement window as whatever text the value turns into, and the trust
     * level as any name its table answers to. On a bank's behalf
     * ({@code strict}) both have to be plain text of the expected kind.
     */
    private static Map<String, Object> validatePolicy(Object policyValue, boolean strict) {
        try {
            return validated(policyValue, strict);
        } catch (JsValue.NotPrimitive e) {
            // The reference fails inside its engine here: no answer, in a sentence of this SDK's.
            throw new NotEvaluable("nopolicy", "policy: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> validated(Object policyValue, boolean strict) {
        if (nullish(policyValue) || (strict && !(policyValue instanceof Map))) {
            throw new NotEvaluable("nopolicy", "policy: there is none");
        }
        // A member of anything that is not an object is not there.
        Map<String, Object> p = policyValue instanceof Map ? (Map<String, Object>) policyValue : Collections.emptyMap();
        need(p.get("policyVersion") instanceof String && !((String) p.get("policyVersion")).isEmpty(), "policyVersion is required");
        need(p.get("currencies") instanceof List && !list(p.get("currencies")).isEmpty(), "currencies must be a non-empty array");
        boolean groups = p.get("unitOfAccountGroups") instanceof List;
        if (groups) {
            for (Object g : list(p.get("unitOfAccountGroups"))) {
                groups &= g instanceof List && !((List<?>) g).isEmpty();
            }
        }
        need(groups, "unitOfAccountGroups must be an array of non-empty arrays");
        // A code in two groups would make equivalence ambiguous: A≡B and B≡C would silently imply A≡C.
        List<Object> seen = new ArrayList<>();
        for (Object g : list(p.get("unitOfAccountGroups"))) {
            for (Object c : list(g)) {
                need(!includes(seen, c), strict ? "a currency appears in more than one unitOfAccountGroup"
                        : "currency " + JsValue.string(c) + " appears in more than one unitOfAccountGroup");
                seen.add(c);
                need(includes(list(p.get("currencies")), c), strict ? "unitOfAccountGroups names a currency that is not in currencies"
                        : "unitOfAccountGroups names " + JsValue.string(c) + ", which is not in currencies");
            }
        }
        parseDecimal(member(p, "amountTolerance"), "policy.amountTolerance", "policy", strict);
        need(wholeAndNotNegative(p.get("amountToleranceBps")), "amountToleranceBps must be a non-negative integer");
        need(p.containsKey("fxReference") && (p.get("fxReference") == null || p.get("fxReference") instanceof String),
                "fxReference must be a string or null");
        Object window = member(p, "settlementWindow");
        need((window instanceof String || !strict) && DURATION.matcher(JsValue.string(window)).matches(),
                "settlementWindow must be an ISO 8601 duration of days/hours/minutes/seconds" + (strict ? "" : ", got " + JsValue.string(window)));
        Object fees = p.get("fees");
        need(fees instanceof Map && ((Map<?, ?>) fees).get("deductible") instanceof Boolean, "fees.deductible must be a boolean");
        need(wholeAndNotNegative(((Map<?, ?>) fees).get("maxBps")), "fees.maxBps must be a non-negative integer");
        Object split = p.get("splitPayments");
        need(split instanceof Map && ((Map<?, ?>) split).get("allowed") instanceof Boolean, "splitPayments.allowed must be a boolean");
        need(((Map<?, ?>) split).get("aggregate") instanceof Boolean, "splitPayments.aggregate must be a boolean");
        need("exact".equals(p.get("partyIDMatch")) || "normalized".equals(p.get("partyIDMatch")), "partyIDMatch must be \"exact\" or \"normalized\"");
        Object trust = member(p, "sourceTrustLevel");
        need(strict ? trust instanceof String && TRUST_ORDER.containsKey(trust) : answersInTrustTable(trust),
                "sourceTrustLevel must be one of DEMO, ATTESTED, ACCREDITED");
        need(p.get("requiredElements") instanceof List, "requiredElements must be an array");
        need(p.get("signatureRequiredElements") instanceof List, "signatureRequiredElements must be an array");
        // Required, not defaulted: a policy silently missing this would evaluate as if the control were off.
        need(p.get("requireTravelRulePreflight") instanceof Boolean,
                "requireTravelRulePreflight must be a boolean" + (strict ? "" : " — a missing value would evaluate as \"control off\""));
        need(p.get("enforceFxQuoteWindow") instanceof Boolean, "enforceFxQuoteWindow must be a boolean");
        need(p.get("settlementIdRequiredIn") instanceof List, "settlementIdRequiredIn must be an array");
        for (Object k : list(p.get("signatureRequiredElements"))) {
            need(includes(list(p.get("requiredElements")), k), strict ? "signatureRequiredElements names an element that is not in requiredElements"
                    : "signatureRequiredElements names " + JsValue.string(k)
                            + ", which is not in requiredElements — an element that need not be supplied cannot be required to be signed");
        }
        need(p.get("regulatoryFields") instanceof List, "regulatoryFields must be an array");
        return p;
    }

    /** {@code value in TRUST_ORDER}: one of the three levels — or a name every JavaScript object answers to, which the reference lets through. */
    private static boolean answersInTrustTable(Object value) {
        String name = JsValue.string(value);
        return TRUST_ORDER.containsKey(name) || INHERITED.contains(name);
    }

    /** Where a level stands in the reference's table, or {@code null} for anything that is not one of the three. */
    private static Integer trustRank(Object level, boolean strict) {
        if (strict) {
            return level instanceof String ? TRUST_ORDER.get(level) : null;
        }
        return TRUST_ORDER.get(JsValue.string(level));
    }

    private static boolean trustAtLeast(Object have, Object need, boolean strict) {
        if (!truthy(have)) {
            return false;
        }
        Integer h = trustRank(have, strict);
        Integer n = trustRank(need, strict);
        return h != null && n != null && h >= n;
    }

    private static double durationToMs(Object window) {
        String iso = JsValue.string(window);
        Matcher m = DURATION.matcher(iso);
        if (!m.matches()) {
            throw new NotEvaluable("policy", "unsupported duration: " + iso);
        }
        double d = m.group(1) == null ? 0 : Double.parseDouble(m.group(1));
        double h = m.group(2) == null ? 0 : Double.parseDouble(m.group(2));
        double min = m.group(3) == null ? 0 : Double.parseDouble(m.group(3));
        double s = m.group(4) == null ? 0 : Double.parseDouble(m.group(4));
        return ((d * 24 + h) * 60 + min) * 60_000 + s * 1000;
    }

    private static boolean sameUnitOfAccount(Object a, Object b, Map<String, Object> policy) {
        if (strictEquals(a, b)) {
            return true;
        }
        for (Object g : list(policy.get("unitOfAccountGroups"))) {
            if (includes(list(g), a) && includes(list(g), b)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The same policy whatever order its members are written in: keys sorted
     * at every level, no white space — written as JavaScript writes an object
     * built that way, which puts whole-number names first.
     */
    static String canonicalPolicy(Object v) {
        return JsValue.stringify(sorted(v));
    }

    private static Object sorted(Object v) {
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : (List<?>) v) {
                out.add(sorted(item));
            }
            return out;
        }
        if (v instanceof Map) {
            List<String> keys = new ArrayList<>();
            for (Object k : ((Map<?, ?>) v).keySet()) {
                keys.add((String) k);
            }
            Collections.sort(keys);
            Map<String, Object> out = new LinkedHashMap<>();
            for (String k : keys) {
                // The reference assigns each member to a new object, and "__proto__" is the one name an assignment does not create.
                if (!k.equals("__proto__")) {
                    out.put(k, sorted(((Map<?, ?>) v).get(k)));
                }
            }
            return out;
        }
        return v;
    }

    /** SHA-256 of the canonical policy: what pins exactly which rules ran. */
    static String policyDigest(Object policy) {
        return Hex.sha256Hex(Text.utf8(canonicalPolicy(policy)));
    }

    /** {@code validatePolicy}, as the reference has it: nothing when the policy can be evaluated, its sentence when not. */
    static void validatePolicyAsReference(Object policy) {
        validatePolicy(policy, false);
    }

    private static final Pattern PUNCTUATION = Pattern.compile("[.,'\"()]");
    /** {@code \b(co|corp|…)\b}, with the word boundary written out: a word character is a letter of A–Z, a digit or the underscore, and nothing else. */
    private static final Pattern CORPORATE_SUFFIX = Pattern.compile(
            "(?<![A-Za-z0-9_])(?:co|corp|corporation|inc|incorporated|ltd|limited|llc|plc|gmbh|pte|pty|sa|nv|bv|ag)(?![A-Za-z0-9_])");
    private static final Pattern SPACES = Pattern.compile(
            "[\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+");

    private static String normalizedParty(String s) {
        String out = PUNCTUATION.matcher(s.toLowerCase(Locale.ROOT)).replaceAll(" ");
        out = CORPORATE_SUFFIX.matcher(out).replaceAll(" ");
        return trim(SPACES.matcher(out).replaceAll(" "));
    }

    /** Party names under the policy's chosen strictness. Both are known to be stated when this is asked. */
    static boolean partyEquals(Object a, Object b, Object mode) {
        if ("exact".equals(mode)) {
            return strictEquals(a, b);
        }
        if (!(a instanceof String) || !(b instanceof String)) {
            throw new NotEvaluable("a party name is not text");
        }
        return normalizedParty((String) a).equals(normalizedParty((String) b));
    }

    // ── instants ──────────────────────────────────────────────────────────────

    private static final Pattern INSTANT = Pattern.compile(
            "([+-]\\d{6}|\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?(?:T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?(Z|[+-]\\d{2}:\\d{2})?)?");

    /**
     * {@code Date.parse}, for the forms a reproducible verdict can be built
     * on: the date-time format of the language standard with its zone stated
     * ({@code 2026-11-18T03:03:48.308Z}, {@code …+07:00}), or a date alone,
     * which is UTC. Milliseconds since the epoch, or NaN for text that is no
     * date at all.
     *
     * <p>A date-time without a zone means "local time" to the reference and
     * so depends on the machine it runs on; and other spellings are read by
     * the reference with a parser of its own. Neither is guessed at here.
     */
    static double dateParse(Object v) {
        if (nullish(v)) {
            return Double.NaN;
        }
        if (!(v instanceof String)) {
            throw new NotEvaluable("a timestamp is not text");
        }
        String s = (String) v;
        Matcher m = INSTANT.matcher(s);
        if (!m.matches()) {
            for (int i = 0; i < s.length(); i++) {
                if (s.charAt(i) >= '0' && s.charAt(i) <= '9') {
                    throw new NotEvaluable("a timestamp is not an ISO 8601 instant: " + Json.compact(s));
                }
            }
            return Double.NaN;      // text without a single digit is no date in any spelling
        }
        if (m.group(4) != null && m.group(8) == null) {
            throw new NotEvaluable("a timestamp states a time without a zone, which reads differently on every machine: " + Json.compact(s));
        }
        if (m.group(1).equals("-000000")) {
            return Double.NaN;
        }
        long year = Long.parseLong(m.group(1));
        int month = m.group(2) == null ? 1 : Integer.parseInt(m.group(2));
        int day = m.group(3) == null ? 1 : Integer.parseInt(m.group(3));
        int hour = m.group(4) == null ? 0 : Integer.parseInt(m.group(4));
        int minute = m.group(5) == null ? 0 : Integer.parseInt(m.group(5));
        int second = m.group(6) == null ? 0 : Integer.parseInt(m.group(6));
        int millis = 0;
        if (m.group(7) != null) {
            String fraction = (m.group(7) + "00").substring(0, 3);     // the first three digits; the rest is dropped
            millis = Integer.parseInt(fraction);
        }
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59
                || (hour == 24 && (minute != 0 || second != 0 || millis != 0))) {
            return Double.NaN;
        }
        long offsetMinutes = 0;
        String zone = m.group(8);
        if (zone != null && !zone.equals("Z")) {
            int zh = Integer.parseInt(zone.substring(1, 3));
            int zm = Integer.parseInt(zone.substring(4, 6));
            if (zh > 23 || zm > 59) {
                return Double.NaN;
            }
            offsetMinutes = (zone.charAt(0) == '-' ? -1 : 1) * (zh * 60L + zm);
        }
        // A day past the end of its month runs on into the next, as the reference has it.
        long days = LocalDate.of((int) year, month, 1).toEpochDay() + (day - 1);
        double ms = days * 86_400_000d + hour * 3_600_000d + minute * 60_000d + second * 1000d + millis - offsetMinutes * 60_000d;
        return Math.abs(ms) > 8.64e15 ? Double.NaN : ms;
    }

    /**
     * The same question for the platform ({@code strict} off), which has to
     * answer as the reference does and cannot refuse: the value is read as
     * the text JavaScript makes of it, and that text as the reference's
     * engine reads a time written the ISO 8601 way or close to it
     * ({@link JsDate}) — a time without a zone being UTC. Any other spelling
     * is no date.
     */
    static double dateParse(Object v, boolean strict) {
        return strict ? dateParse(v) : JsDate.parse(JsValue.string(v));
    }

    // ── the signature pass ────────────────────────────────────────────────────

    /** A copy that can be changed without changing what was handed over. */
    private static Object copy(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                out.put((String) e.getKey(), copy(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object item : (List<?>) v) {
                out.add(copy(item));
            }
            return out;
        }
        return v;
    }

    /**
     * The evidence with every element signature replaced by one whose status
     * was computed here: {@code VALID}, {@code INVALID}, {@code UNKNOWN_KEY}
     * or {@code ABSENT}, marked {@code checked}. What the document itself
     * says of a signature — its status, its trust level — carries no weight.
     *
     * @param keys the keys of the Trust Registry snapshot in the package, by institution id; every one is {@code ATTESTED}
     */
    @SuppressWarnings("unchecked")
    static Map<String, Object> checkSignatures(Map<String, Object> evidence, Map<String, Key> keys) {
        Map<String, Object> ev = (Map<String, Object>) copy(evidence);
        if (!(ev.get("elements") instanceof Map)) {
            throw new NotEvaluable("the evidence holds no elements");
        }
        try {
            check((Map<String, Object>) ev.get("elements"), keys, true);
        } catch (JsValue.NotPrimitive e) {
            throw new NotEvaluable("the evidence cannot be read: " + e.getMessage());
        }
        return ev;
    }

    /**
     * The same pass as the reference runs it ({@code verifyEvidenceSignatures}),
     * for the platform: against a keyring whose keys each carry their own
     * trust level — a signature under a {@code DEMO} key that verifies is
     * {@code DEMO_VALID}, never {@code VALID} — and reading evidence of any
     * shape as the reference reads it. Evidence whose {@code elements} is
     * something other than an object has nothing to check and comes back as
     * it is; evidence with no {@code elements} at all is where the reference
     * stops.
     */
    @SuppressWarnings("unchecked")
    static Object checkSignaturesAsReference(Object evidence, Map<String, Key> keys) {
        if (!(evidence instanceof Map)) {
            throw new NotEvaluable("the evidence is not an object");
        }
        Map<String, Object> ev = (Map<String, Object>) copy(evidence);
        Object elements = member(ev, "elements");
        if (nullish(elements)) {
            throw new NotEvaluable("the evidence holds no elements");
        }
        if (elements instanceof Map) {
            try {
                check((Map<String, Object>) elements, keys, false);
            } catch (JsValue.NotPrimitive e) {
                throw new NotEvaluable("the evidence cannot be read: " + e.getMessage());
            }
        }
        return ev;
    }

    /**
     * @param strict the bank's reading: an element is canonicalised as it stands, so a number that is not held as a whole
     *               number has no canonical form and the signature over it does not verify. Off, a number is taken at its
     *               value, as the reference — which holds nothing else of a number — takes it
     */
    @SuppressWarnings("unchecked")
    private static void check(Map<String, Object> el, Map<String, Key> keys, boolean strict) {
        for (String name : SIGNABLE) {
            Object node = el.get(name);
            if (node instanceof List) {
                for (Object item : (List<Object>) node) {
                    if (item instanceof Map && ((Map<?, ?>) item).containsKey("signature")) {
                        ((Map<String, Object>) item).put("signature", checkSignature((Map<String, Object>) item, keys, strict));
                    }
                }
            } else if (node instanceof Map && ((Map<?, ?>) node).containsKey("signature")) {
                ((Map<String, Object>) node).put("signature", checkSignature((Map<String, Object>) node, keys, strict));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> checkSignature(Map<String, Object> element, Map<String, Key> keys, boolean strict) {
        Object declared = element.get("signature");
        Map<String, Object> out = new LinkedHashMap<>();
        // Nothing to check. A status with no signature bytes lands here too: a document
        // claiming VALID without carrying a signature is not evidence of anything.
        if (!truthy(declared) || strictEquals(prop(declared, "status"), "ABSENT") || !truthy(prop(declared, "value"))) {
            out.put("status", "ABSENT");
            out.put("checked", Boolean.TRUE);
            Object keyId = optProp(declared, "keyId");
            if (truthy(keyId)) {
                out.put("keyId", keyId);
            }
            return out;
        }
        out.putAll((Map<String, Object>) declared);
        Object keyId = out.get("keyId");
        Key key = keyId instanceof String && !((String) keyId).isEmpty() ? keys.get(keyId) : null;
        if (key == null) {
            // Trust is not inherited from the document: a signature naming a key nobody holds tells us nothing.
            out.put("status", "UNKNOWN_KEY");
            out.put("checked", Boolean.TRUE);
            out.remove("trustLevel");
            return out;
        }
        boolean ok;
        try {
            Object value = out.get("value");
            ok = value instanceof String && key.spkiBase64 != null
                    && Signers.verifies(key.spkiBase64, Signing.elementBytes(strict ? element : (Map<String, Object>) JsValue.integers(element)),
                            Base64Url.forgiving((String) value));
        } catch (RuntimeException e) {
            ok = false;     // a malformed signature or key is a verification failure, not a crash
        }
        // The keyring's word for who holds the key, and how far it is trusted, wins over anything the document claimed.
        if (key.issuer == UNDEFINED) {
            out.remove("issuer");
        } else {
            out.put("issuer", key.issuer);
        }
        if (key.trustLevel == UNDEFINED) {
            out.remove("trustLevel");
        } else {
            out.put("trustLevel", key.trustLevel);
        }
        out.put("algorithm", "ES256");
        out.put("checked", Boolean.TRUE);
        // A demonstration key that verifies is DEMO_VALID, never VALID: the arithmetic held and the identity is still unestablished.
        out.put("status", !ok ? "INVALID" : "DEMO".equals(key.trustLevel) ? "DEMO_VALID" : "VALID");
        return out;
    }

    // ── the rules ─────────────────────────────────────────────────────────────

    /**
     * @param evidence the evidence as {@link #checkSignatures} returned it
     * @param policyValue the policy the package was evaluated under
     * @throws NotEvaluable where the reference throws, or the evidence is of a shape this port does not evaluate
     */
    static Result evaluate(Map<String, Object> evidence, Object policyValue) {
        return run(evidence, policyValue, true);
    }

    /**
     * The reference's {@code evaluate}, for the platform: the same rules,
     * reading every value the way the reference reads it, so that the result
     * — every finding, sentence and field — is the one the reference returns.
     *
     * @throws NotEvaluable where the reference throws: in its own words ({@code policy}, {@code amount}), or, where it fails
     *                      inside the JavaScript engine, in a sentence of this SDK's ({@code shape})
     */
    static Result evaluateAsReference(Object evidence, Object policyValue) {
        return run(evidence, policyValue, false);
    }

    private static Result run(Object evidenceValue, Object policyValue, boolean strict) {
        try {
            return ran(evidenceValue, policyValue, strict);
        } catch (JsValue.NotPrimitive e) {
            // Where the reference's engine throws while it writes a value into a sentence, compares it or looks it up.
            throw new NotEvaluable("the evidence cannot be evaluated: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private static Result ran(Object evidenceValue, Object policyValue, boolean strict) {
        Map<String, Object> policy = validatePolicy(policyValue, strict);
        if (nullish(evidenceValue)) {
            throw new NotEvaluable("there is no evidence");
        }
        // A member of anything that is not an object is not there.
        Map<String, Object> evidence = evidenceValue instanceof Map ? (Map<String, Object>) evidenceValue : Collections.emptyMap();
        Findings f = new Findings();
        Map<String, Object> el = evidence.get("elements") instanceof Map ? (Map<String, Object>) evidence.get("elements") : Collections.emptyMap();
        List<Object> required = list(policy.get("requiredElements"));
        Object needTrust = policy.get("sourceTrustLevel");
        String version = (String) policy.get("policyVersion");

        // Completeness. First, because the other axes have to know what they are missing —
        // and absent evidence is never reported as contradicted evidence.
        Set<String> present = new HashSet<>();
        for (String key : ELEMENTS) {
            Object v = member(el, key);
            if (v instanceof List ? !((List<?>) v).isEmpty() : !nullish(v)) {
                present.add(key);
            }
        }
        for (Object req : required) {
            if (!(req instanceof String) || !present.contains(req)) {
                f.add("completeness", "ELEMENT_MISSING", "blocking",
                        JsValue.string(req) + " is required by " + version + " but was not supplied", "element", req);
            }
        }
        // A document cited by number but not attached is a request-this case, not a forgery case.
        Object citedOnly = optProp(member(el, "commercialDocs"), "citedOnly");
        if (!nullish(citedOnly)) {
            List<Object> cited = new ArrayList<>();
            if (citedOnly instanceof List) {
                cited.addAll(list(citedOnly));
            } else if (citedOnly instanceof String) {
                String text = (String) citedOnly;
                for (int i = 0; i < text.length(); i += Character.charCount(text.codePointAt(i))) {
                    cited.add(text.substring(i, i + Character.charCount(text.codePointAt(i))));
                }
            } else {
                throw new NotEvaluable("commercialDocs.citedOnly is not a list");
            }
            for (Object one : cited) {
                f.add("completeness", "DOCUMENT_CITED_NOT_ATTACHED", "blocking",
                        JsValue.string(one) + " was referenced by number but the document itself was not supplied",
                        "element", "commercialDocs", "field", one);
            }
        }

        // Integrity. A digest nobody checked is reported as not checked, not quietly treated as fine.
        int checked = 0;
        boolean integrityFailed = false;
        for (String key : ELEMENTS) {
            for (Object item : toArray(member(el, key))) {
                Object digestVerified = prop(item, "digestVerified");
                if (Boolean.TRUE.equals(digestVerified)) {
                    checked++;
                } else if (Boolean.FALSE.equals(digestVerified)) {
                    integrityFailed = true;
                    f.add("integrity", "DIGEST_MISMATCH", "blocking", key + ": submitted bytes do not hash to the committed digest",
                            "element", key, "field", "digest", "expected", prop(item, "digest"));
                } else if (prop(item, "digest") != UNDEFINED) {
                    f.add("integrity", "DIGEST_NOT_CHECKED", "warning",
                            key + ": a digest is declared but the original was not supplied to check it", "element", key, "field", "digest");
                }
            }
        }

        // Issuer. Whether the signature verifies and who signed are two things.
        boolean signatureInvalid = false;
        boolean identityUnknown = false;
        int signaturesValid = 0;
        List<Object> signatureRequired = list(policy.get("signatureRequiredElements"));
        for (String key : ELEMENTS) {
            for (Object item : toArray(member(el, key))) {
                Object sig = prop(item, "signature");
                if (!truthy(sig) || strictEquals(prop(sig, "status"), "ABSENT")) {
                    // Only where the policy says the element must be signed.
                    if (present.contains(key) && includes(signatureRequired, key)) {
                        identityUnknown = true;
                        f.add("issuer", "SIGNATURE_ABSENT", "warning",
                                key + ": no issuer signature was supplied, so its origin is unestablished", "element", key);
                    }
                    continue;
                }
                Object status = prop(sig, "status");
                // A status nobody computed is not a result.
                if (!Boolean.TRUE.equals(prop(sig, "checked"))) {
                    identityUnknown = true;
                    f.add("issuer", "SIGNATURE_NOT_CHECKED", "warning",
                            key + ": the signature was not verified, so its declared status (" + JsValue.string(status)
                                    + ") carries no weight. Run verifyEvidenceSignatures() first.",
                            "element", key, "field", "signature", "actual", status);
                    continue;
                }
                Object keyId = prop(sig, "keyId");
                if ("UNKNOWN_KEY".equals(status)) {
                    identityUnknown = true;
                    f.add("issuer", "SIGNATURE_UNKNOWN_KEY", "warning",
                            key + ": the signature names key " + (nullish(keyId) ? "(unnamed)" : JsValue.string(keyId)) + ", which is not in the "
                                    + "keyring, so neither its validity nor its signer could be established",
                            "element", key, "field", "keyId", "actual", keyId);
                    continue;
                }
                if ("INVALID".equals(status)) {
                    signatureInvalid = true;
                    f.add("issuer", "SIGNATURE_INVALID", "blocking",
                            key + ": the issuer signature does not verify against the declared key",
                            "element", key, "field", "signature", "expected", keyId);
                    continue;
                }
                // VALID or DEMO_VALID: the cryptography passed. Identity is separate.
                signaturesValid++;
                Object trustLevel = prop(sig, "trustLevel");
                if (!trustAtLeast(trustLevel, needTrust, strict)) {
                    identityUnknown = true;
                    f.add("issuer", "ISSUER_TRUST_INSUFFICIENT", "warning",
                            key + ": signature verifies, but the key's trust level (" + (nullish(trustLevel) ? "unset" : JsValue.string(trustLevel))
                                    + ") is below the policy's required " + JsValue.string(needTrust) + ", so the signer's identity is not established",
                            "element", key, "field", "trustLevel", "expected", needTrust, "actual", trustLevel);
                }
            }
        }

        String matchingBase = matching(el, policy, f, present, strict);
        corridor(evidence, el, policy, f, strict);

        // Axis states, derived from every finding: the corridor rules add to axes that the rules above them also bear on.
        Map<String, String> states = new LinkedHashMap<>();
        states.put("integrity", integrityFailed || f.has("integrity", "blocking") ? "INVALID" : checked > 0 ? "VALID" : "NOT_CHECKED");
        states.put("issuer", signatureInvalid || f.has("issuer", "blocking") ? "INVALID"
                : identityUnknown || f.has("issuer", "warning") || signaturesValid == 0 ? "UNKNOWN_ISSUER" : "VALID");
        // A blocking corridor finding is a positive disagreement, and outranks "cannot decide yet".
        states.put("matching", f.has("matching", "blocking") ? "MISMATCH" : matchingBase);

        // Regulatory mapping: the presence of the fields a form asks for. Never a compliance determination.
        Set<String> supplied = suppliedFields(evidence, el, strict);
        int missing = 0;
        for (Object k : list(policy.get("regulatoryFields"))) {
            if (!(k instanceof String) || !supplied.contains(k)) {
                missing++;
                f.add("regulatoryMapping", "REGULATORY_FIELD_MISSING", "info",
                        JsValue.string(k) + " is on the policy's submission checklist but is not present in this evidence", "field", k);
            }
        }
        Object dataMode = member(evidence, "dataMode");
        boolean synthetic = "SYNTHETIC".equals(dataMode);
        if (synthetic) {
            f.add("regulatoryMapping", "SYNTHETIC_DATA", "warning",
                    "this evidence is synthetic, so field coverage cannot stand in for a real submission");
        }

        // Business finality: did the paying institution itself confirm that the funds moved?
        boolean confirmedBySource = confirmedBySource(member(el, "payoutReceipts"), needTrust, strict);
        String finality = synthetic ? "DEMO_ONLY" : confirmedBySource ? "VERIFIED_BY_SOURCE" : "UNVERIFIED";
        if (finality.equals("DEMO_ONLY")) {
            f.add("businessFinality", "DEMO_ONLY", "warning", "no funds moved: this is synthetic evidence for demonstration");
        } else if (finality.equals("UNVERIFIED")) {
            f.add("businessFinality", "PAYOUT_UNCONFIRMED", "blocking",
                    "no payout confirmation from the paying institution carries sufficient issuer trust");
        }

        states.put("completeness", f.has("completeness", "blocking") ? "INCOMPLETE" : "COMPLETE");
        states.put("regulatoryMapping", synthetic ? "REVIEW_REQUIRED" : missing > 0 ? "MISSING" : "PRESENT");
        states.put("businessFinality", finality);
        // A human looks whenever any axis is anything other than cleanly satisfied.
        boolean manualReview = !"VALID".equals(states.get("integrity")) || !"VALID".equals(states.get("issuer"))
                || !"MATCH".equals(states.get("matching")) || !"COMPLETE".equals(states.get("completeness"))
                || !"PRESENT".equals(states.get("regulatoryMapping")) || !"VERIFIED_BY_SOURCE".equals(finality);
        return new Result(states, f.all, version, policyDigest(policy), member(evidence, "scenario"), dataMode, manualReview);
    }

    private static boolean confirmedBySource(Object receipts, Object needTrust, boolean strict) {
        if (nullish(receipts)) {
            return false;
        }
        if (receipts instanceof String) {
            if (((String) receipts).isEmpty()) {
                return false;
            }
            throw new NotEvaluable("payoutReceipts is not a list");
        }
        if (!strict && receipts instanceof Map) {
            // An object is asked for its length like any other value, and has no way to answer for its members.
            Map<?, ?> object = (Map<?, ?>) receipts;
            if (object.containsKey("length") && JsValue.toNumber(object.get("length")) > 0) {
                throw new NotEvaluable("payoutReceipts is not a list");
            }
            return false;
        }
        if (!(receipts instanceof List) || ((List<?>) receipts).isEmpty()) {
            return false;
        }
        for (Object r : (List<?>) receipts) {
            Object sig = prop(r, "signature");
            if (!truthy(sig) || !Boolean.TRUE.equals(prop(sig, "checked")) || !"VALID".equals(prop(sig, "status"))
                    || !trustAtLeast(prop(sig, "trustLevel"), needTrust, strict)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The payout receipts as the rules go through them. They are a list; the
     * reference also finds its way through text standing where the list
     * belongs — one character a receipt, until it asks the text for
     * something only a list has — and the platform's reading follows it there.
     */
    private static final class Receipts {
        final List<Object> items;
        /** {@code .length}: for text, counted in UTF-16 units, as JavaScript counts it. */
        final int length;
        /** The text, where text stands in the list's place; {@code null} for a list. */
        final String text;

        Receipts(List<Object> items, int length, String text) {
            this.items = items;
            this.length = length;
            this.text = text;
        }

        /** {@code receipts[i]}. */
        Object at(int i) {
            if (text != null) {
                return i >= 0 && i < text.length() ? String.valueOf(text.charAt(i)) : UNDEFINED;
            }
            return i >= 0 && i < items.size() ? items.get(i) : UNDEFINED;
        }

        /** A list has entries to walk and members to ask; text has neither, and the reference stops there. */
        void mustBeAList() {
            if (text != null) {
                throw new NotEvaluable("payoutReceipts is not a list");
            }
        }
    }

    private static Receipts receiptsOf(Object value, boolean strict) {
        if (nullish(value)) {
            return new Receipts(Collections.emptyList(), 0, null);
        }
        if (value instanceof List) {
            return new Receipts(list(value), list(value).size(), null);
        }
        if (!strict && value instanceof String) {
            String text = (String) value;
            List<Object> characters = new ArrayList<>();
            for (int i = 0; i < text.length(); i += Character.charCount(text.codePointAt(i))) {
                characters.add(text.substring(i, i + Character.charCount(text.codePointAt(i))));
            }
            return new Receipts(characters, text.length(), text);
        }
        return null;
    }

    /** Amounts, currencies, parties, references and timing. "Cannot decide yet" is not "the sources disagree". */
    private static String matching(Map<String, Object> el, Map<String, Object> policy, Findings f, Set<String> present, boolean strict) {
        Object instruction = member(el, "bankInstruction");
        Object transfer = member(el, "chainTransfer");
        Object receiptsValue = member(el, "payoutReceipts");
        Object docs = member(el, "commercialDocs");
        List<Object> required = list(policy.get("requiredElements"));
        String version = (String) policy.get("policyVersion");

        // Without an instruction there is no authorised amount to reconcile to.
        if (!truthy(instruction)) {
            f.add("matching", "NO_REFERENCE_AMOUNT", "warning",
                    "no bank instruction was supplied, so there is no authorised amount to reconcile against");
            return "PENDING";
        }
        Receipts receipts = receiptsOf(receiptsValue, strict);
        if (strict && receipts == null) {
            throw new NotEvaluable("payoutReceipts is not a list");
        }

        Dec expected = parseDecimal(prop(instruction, "amount"), "bankInstruction.amount", "amount", strict);
        boolean pending = false;
        boolean mismatch = false;

        // Currency. A policy with no FX reference refuses cross-currency matching rather than inventing a rate.
        List<Object> currencies = new ArrayList<>();
        Object base = prop(instruction, "currency");
        currencies.add(base);
        if (truthy(transfer) && !includes(currencies, prop(transfer, "currency"))) {
            currencies.add(prop(transfer, "currency"));
        }
        if (receipts == null) {
            // Neither a list nor text: the reference cannot go through it.
            throw new NotEvaluable("payoutReceipts is not a list");
        }
        for (Object r : receipts.items) {
            if (!includes(currencies, prop(r, "currency"))) {
                currencies.add(prop(r, "currency"));
            }
        }
        List<Object> permitted = list(policy.get("currencies"));
        for (Object c : currencies) {
            if (!includes(permitted, c)) {
                mismatch = true;
                f.add("matching", "CURRENCY_NOT_PERMITTED", "blocking", JsValue.string(c) + " is not in the policy's permitted currencies",
                        "field", "currency", "expected", JsValue.join(permitted, ","), "actual", c);
            }
        }
        // Amounts only compare directly when every code is one unit of account under the policy.
        List<Object> foreign = new ArrayList<>();
        for (Object c : currencies) {
            if (!sameUnitOfAccount(c, base, policy)) {
                foreign.add(c);
            }
        }
        if (!foreign.isEmpty()) {
            if (policy.get("fxReference") == null) {
                mismatch = true;
                f.add("matching", "CROSS_CURRENCY_WITHOUT_FX", "blocking",
                        "evidence spans " + JsValue.string(base) + " and " + JsValue.join(foreign, ", ") + ", which are different units of account "
                                + "under this policy, and no FX reference is declared — the amounts cannot be compared",
                        "field", "currency", "expected", base, "actual", JsValue.join(foreign, ","));
            } else {
                // Conversion is outside the engine: pulling a rate would make the verdict depend on something that moves.
                pending = true;
                f.add("matching", "FX_CONVERSION_REQUIRED", "warning",
                        "evidence spans " + JsValue.string(base) + " and " + JsValue.join(foreign, ", ") + "; the policy names "
                                + policy.get("fxReference") + " as its FX reference, but conversion is performed outside this "
                                + "engine so the amounts are not reconciled here",
                        "field", "currency", "expected", base, "actual", JsValue.join(foreign, ","));
            }
        }

        // The tolerance: absolute, widened by the relative and the fee allowances.
        Dec tolerance = parseDecimal(member(policy, "amountTolerance"), "policy.amountTolerance", "policy", strict);
        if (number((Number) policy.get("amountToleranceBps")) > 0) {
            tolerance = add(tolerance, bps(expected, whole(policy.get("amountToleranceBps"))));
        }
        Map<?, ?> fees = (Map<?, ?>) policy.get("fees");
        if (Boolean.TRUE.equals(fees.get("deductible")) && number((Number) fees.get("maxBps")) > 0) {
            tolerance = add(tolerance, bps(expected, whole(fees.get("maxBps"))));
        }

        // The chain transfer against the instruction.
        if (truthy(transfer)) {
            if (!withinTolerance(f, "chainTransfer", "amount", expected, parseDecimal(prop(transfer, "amount"), "chainTransfer.amount", "amount", strict), tolerance, version)) {
                mismatch = true;
            }
        } else if (includes(required, "chainTransfer")) {
            pending = true;
        }

        // A reference presented twice, before the split rules get a chance to explain it away.
        List<Object> refs = new ArrayList<>();
        List<Integer> counts = new ArrayList<>();
        for (Object r : receipts.items) {
            Object ref = prop(r, "ref");
            if (truthy(ref)) {
                if (strict && !(ref instanceof String)) {
                    throw new NotEvaluable("a payout reference is not text");
                }
                int at = -1;
                for (int i = 0; i < refs.size() && at < 0; i++) {
                    at = strictEquals(refs.get(i), ref) ? i : -1;
                }
                if (at < 0) {
                    refs.add(ref);
                    counts.add(1);
                } else {
                    counts.set(at, counts.get(at) + 1);
                }
            }
        }
        boolean duplicated = false;
        for (int i = 0; i < refs.size(); i++) {
            if (counts.get(i) >= 2) {
                mismatch = true;
                duplicated = true;
                String ref = JsValue.string(refs.get(i));
                f.add("matching", "DUPLICATE_PAYOUT_REF", "blocking",
                        "payout reference " + ref + " is presented " + counts.get(i) + " times; one settlement cannot discharge "
                                + "the same obligation more than once",
                        "element", "payoutReceipts", "field", "ref", "expected", ref + " once", "actual", ref + " x" + counts.get(i));
            }
        }

        // Payout receipts: one is a comparison; several is a split, and whether that reconciles is the policy's call.
        Map<?, ?> split = (Map<?, ?>) policy.get("splitPayments");
        if (receipts.length == 1) {
            if (!withinTolerance(f, "payoutReceipts", "amount", expected,
                    parseDecimal(prop(receipts.at(0), "amount"), "payoutReceipts[0].amount", "amount", strict), tolerance, version)) {
                mismatch = true;
            }
        } else if (receipts.length > 1) {
            if (!Boolean.TRUE.equals(split.get("allowed"))) {
                mismatch = true;
                f.add("matching", "SPLIT_NOT_ALLOWED", "blocking",
                        receipts.length + " payout receipts were supplied but the policy does not permit split payments",
                        "element", "payoutReceipts", "actual", String.valueOf(receipts.length));
            } else if (!Boolean.TRUE.equals(split.get("aggregate"))) {
                pending = true;
                f.add("matching", "SPLIT_AGGREGATION_DISABLED", "warning",
                        receipts.length + " payout receipts were supplied; the policy permits splits but does not "
                                + "aggregate them, so no single receipt can be reconciled to the instructed amount",
                        "element", "payoutReceipts", "actual", String.valueOf(receipts.length));
            } else if (duplicated) {
                // No sum is reported for a set that counts one payment twice.
                f.add("matching", "AGGREGATION_SKIPPED_DUPLICATE", "info",
                        "the payout total was not reconciled: the set repeats a reference, so its sum counts one payment more than once",
                        "element", "payoutReceipts", "actual", receipts.length + " receipts, " + refs.size() + " distinct");
            } else {
                receipts.mustBeAList();
                Dec total = new Dec(BigInteger.ZERO, 0);
                for (int i = 0; i < receipts.items.size(); i++) {
                    total = add(total, parseDecimal(prop(receipts.items.get(i), "amount"), "payoutReceipts[" + i + "].amount", "amount", strict));
                }
                if (!withinTolerance(f, "payoutReceipts", "sum", expected, total, tolerance, version)) {
                    mismatch = true;
                }
            }
        } else if (includes(required, "payoutReceipts")) {
            pending = true;
        }

        // Commercial documents, where an amount was supplied at all.
        Object docsAmount = optProp(docs, "amount");
        if (docsAmount != UNDEFINED) {
            if (!withinTolerance(f, "commercialDocs", "amount", expected, parseDecimal(docsAmount, "commercialDocs.amount", "amount", strict), tolerance, version)) {
                mismatch = true;
            }
        }

        // The instruction has to cite the commercial basis it pays.
        Object invoiceRef = optProp(docs, "invoiceRef");
        Object instructionRef = prop(instruction, "ref");
        if (invoiceRef != UNDEFINED && instructionRef != UNDEFINED) {
            boolean cited = strictEquals(instructionRef, invoiceRef);
            if (!cited) {
                Object fields = prop(instruction, "iso20022Fields");
                if (fields instanceof List) {
                    cited = includes(list(fields), invoiceRef);
                } else if (!strict && fields instanceof String) {
                    // Text is asked whether it contains the reference, written out as text.
                    cited = ((String) fields).contains(JsValue.string(invoiceRef));
                } else if (!nullish(fields)) {
                    throw new NotEvaluable("bankInstruction.iso20022Fields is not a list");
                }
            }
            if (!cited) {
                f.add("matching", "REFERENCE_NOT_LINKED", "warning",
                        "the bank instruction (" + JsValue.string(instructionRef) + ") does not cite the invoice reference ("
                                + JsValue.string(invoiceRef) + "), so the payment is not tied to this commercial basis",
                        "field", "ref", "expected", invoiceRef, "actual", instructionRef);
            }
        }

        // Parties.
        if (truthy(docs) && (truthy(prop(instruction, "debtor")) || truthy(prop(instruction, "creditor")))) {
            Object mode = policy.get("partyIDMatch");
            if (truthy(prop(docs, "buyer")) && truthy(prop(instruction, "debtor"))
                    && !partyEquals(prop(docs, "buyer"), prop(instruction, "debtor"), mode)) {
                mismatch = true;
                f.add("matching", "PARTY_MISMATCH", "blocking",
                        "the invoice buyer and the instruction debtor are different parties under " + mode + " matching",
                        "field", "debtor", "expected", prop(docs, "buyer"), "actual", prop(instruction, "debtor"));
            }
            if (truthy(prop(docs, "seller")) && truthy(prop(instruction, "creditor"))
                    && !partyEquals(prop(docs, "seller"), prop(instruction, "creditor"), mode)) {
                mismatch = true;
                f.add("matching", "PARTY_MISMATCH", "blocking",
                        "the invoice seller and the instruction creditor are different parties under " + mode + " matching",
                        "field", "creditor", "expected", prop(docs, "seller"), "actual", prop(instruction, "creditor"));
            }
        }

        // The settlement window, between timestamps the evidence itself carries. Absent ones mean "not evaluated", not "passed".
        Object window = policy.get("settlementWindow");
        double windowMs = durationToMs(window);
        Object from = prop(instruction, "approvedAt");
        Object to = optProp(transfer, "observedAt");
        if (nullish(to)) {
            to = optProp(receipts.at(receipts.length - 1), "paidAt");
        }
        if (truthy(from) && truthy(to)) {
            double delta = dateParse(to, strict) - dateParse(from, strict);
            if (Double.isNaN(delta)) {
                f.add("matching", "TIMESTAMP_UNPARSEABLE", "warning",
                        "a settlement timestamp is not a parseable instant, so the window was not evaluated", "expected", from, "actual", to);
            } else if (delta < 0) {
                mismatch = true;
                f.add("matching", "SETTLEMENT_BEFORE_APPROVAL", "blocking", "the funds moved before the bank instruction was approved",
                        "field", "approvedAt", "expected", from, "actual", to);
            } else if (delta > windowMs) {
                mismatch = true;
                f.add("matching", "SETTLEMENT_WINDOW_EXCEEDED", "blocking",
                        "settlement took longer than the policy's " + JsValue.string(window) + " window",
                        "field", "settlementWindow", "expected", window, "actual", Math.round(delta / 3_600_000d) + "h");
            }
        } else if (present.contains("chainTransfer")) {
            f.add("matching", "WINDOW_NOT_EVALUATED", "info",
                    "the settlement window was not evaluated because the evidence carries no comparable timestamps");
        }

        return mismatch ? "MISMATCH" : pending ? "PENDING" : "MATCH";
    }

    /** Within tolerance, or a finding that says by how much it is not. */
    private static boolean withinTolerance(Findings f, String element, String field, Dec expected, Dec actual, Dec tolerance, String version) {
        Dec delta = absDifference(actual, expected);
        if (compare(delta, tolerance) <= 0) {
            return true;
        }
        f.add("matching", "AMOUNT_MISMATCH", "blocking",
                element + "." + field + " differs from the instructed amount by " + format(delta) + ", which exceeds the "
                        + (tolerance.value.signum() == 0 ? "exact-match requirement" : "tolerance of " + format(tolerance)) + " in " + version,
                "element", element, "field", field, "expected", format(expected), "actual", format(actual), "tolerance", format(tolerance));
        return false;
    }

    /**
     * The corridor's controls: one settlement id across every layer, the
     * Travel Rule gate before the funds move, the FX quote window, and what a
     * refund has to cite.
     */
    private static void corridor(Map<String, Object> ev, Map<String, Object> el, Map<String, Object> policy, Findings f, boolean strict) {
        Object travelRule = member(el, "travelRule");
        Object approval = member(el, "bankApproval");
        Object chainTransfer = member(el, "chainTransfer");

        // One id across every layer — what the UETR does on SWIFT.
        List<Object> carriedIn = list(policy.get("settlementIdRequiredIn"));
        Object settlementId = member(ev, "settlementId");
        if (!carriedIn.isEmpty() && !truthy(settlementId)) {
            f.add("matching", "SETTLEMENT_ID_MISSING", "blocking",
                    "no settlement id: there is nothing tying the bank voucher, the Travel Rule message and "
                            + "the chain transaction to one payment. On SWIFT this is what the UETR carries.",
                    "field", "settlementId");
        } else if (truthy(settlementId)) {
            if (strict && !(settlementId instanceof String)) {
                throw new NotEvaluable("the settlement id is not text");
            }
            Map<String, Object> cites = new HashMap<>();
            cites.put("bankInstruction", optProp(member(el, "bankInstruction"), "ref"));
            cites.put("bankApproval", optProp(approval, "approvalRef"));
            cites.put("chainTransfer", optProp(chainTransfer, "txRef"));
            cites.put("payoutReceipts", optProp(first(member(el, "payoutReceipts")), "ref"));
            cites.put("commercialDocs", optProp(member(el, "commercialDocs"), "invoiceRef"));
            Object memo = optProp(chainTransfer, "settlementIdMemo");
            for (Object key : carriedIn) {
                if (strict && !(key instanceof String)) {
                    throw new NotEvaluable("policy: settlementIdRequiredIn names something that is not an element");
                }
                // A name is looked up as the text it turns into.
                String name = JsValue.string(key);
                if (INHERITED.contains(name)) {
                    throw new NotEvaluable("nopolicy", "policy: settlementIdRequiredIn names something that is not an element");
                }
                Object cite = cites.containsKey(name) ? cites.get(name) : UNDEFINED;
                boolean carried = false;
                // The chain leg carries the id in a memo rather than in its transaction id.
                if ("chainTransfer".equals(key) && strictEquals(memo, settlementId)) {
                    carried = true;
                } else if (cite instanceof String) {
                    carried = ((String) cite).contains(JsValue.string(settlementId));
                } else if (cite instanceof List) {
                    carried = includes(list(cite), settlementId);
                } else if (!nullish(cite)) {
                    throw new NotEvaluable("a reference that should cite the settlement id is not text");
                }
                if (!carried) {
                    f.add("matching", "SETTLEMENT_ID_NOT_CARRIED", "warning",
                            name + " does not cite settlement id " + JsValue.string(settlementId) + ", so this layer cannot be tied to the "
                                    + "payment without trusting a mapping held somewhere else",
                            "element", key, "field", "settlementId", "expected", settlementId, "actual", nullish(cite) ? memo : cite);
                }
            }
        }

        // Travel Rule: the receiving institution accepts the originator and beneficiary information before the funds move.
        if (Boolean.TRUE.equals(policy.get("requireTravelRulePreflight"))) {
            if (!truthy(travelRule)) {
                f.add("issuer", "TRAVEL_RULE_MISSING", "blocking",
                        "no Travel Rule exchange is evidenced. A transfer between VASPs above the threshold "
                                + "requires originator and beneficiary information to have been transmitted to the receiving institution.",
                        "element", "travelRule");
            } else {
                Object approvalStatus = prop(travelRule, "approvalStatus");
                if (!"APPROVED".equals(approvalStatus)) {
                    f.add("issuer", "TRAVEL_RULE_NOT_APPROVED", "blocking",
                            "the Travel Rule exchange is " + JsValue.string(approvalStatus) + ", not APPROVED, so the receiving "
                                    + "VASP had not accepted the transfer when it was made",
                            "element", "travelRule", "field", "approvalStatus", "expected", "APPROVED", "actual", approvalStatus);
                }
                if (!truthy(prop(travelRule, "approvalDigest"))) {
                    f.add("issuer", "TRAVEL_RULE_APPROVAL_UNSIGNED", "warning",
                            "the approval is asserted but no signed callback from the receiving VASP is evidenced, "
                                    + "so the pre-flight gate rests on our own record of it",
                            "element", "travelRule", "field", "approvalDigest");
                }
                // The pre-flight gate, as arithmetic: an approval timestamped before the transfer is a fact about this payment.
                Object movedAt = optProp(chainTransfer, "observedAt");
                Object approvedAt = prop(travelRule, "approvedAt");
                if (truthy(approvedAt) && truthy(movedAt)) {
                    double delta = dateParse(movedAt, strict) - dateParse(approvedAt, strict);
                    if (Double.isNaN(delta)) {
                        f.add("issuer", "TRAVEL_RULE_TIMESTAMP_UNPARSEABLE", "warning",
                                "a Travel Rule timestamp is not a parseable instant, so the pre-flight gate was not evaluated",
                                "element", "travelRule", "expected", approvedAt, "actual", movedAt);
                    } else if (delta < 0) {
                        f.add("issuer", "PREFLIGHT_VIOLATED", "blocking",
                                "the funds moved before the receiving VASP approved the Travel Rule exchange. The "
                                        + "transfer was made without the counterparty having accepted the originator and beneficiary information.",
                                "element", "travelRule", "field", "approvedAt", "expected", "approval before " + JsValue.string(movedAt),
                                "actual", approvedAt);
                    }
                } else if ("APPROVED".equals(approvalStatus)) {
                    f.add("issuer", "PREFLIGHT_NOT_EVALUATED", "warning",
                            "the approval and transfer timestamps are not both present, so whether approval "
                                    + "preceded the transfer could not be established",
                            "element", "travelRule");
                }
                // The address the counterparty approved must be the one that was paid.
                Object paidTo = optProp(chainTransfer, "toAddress");
                Object approvedAddress = prop(travelRule, "approvedBeneficiaryAddress");
                if (truthy(approvedAddress) && truthy(paidTo) && !strictEquals(approvedAddress, paidTo)) {
                    f.add("matching", "BENEFICIARY_ADDRESS_NOT_APPROVED", "blocking",
                            "the funds went to an address other than the one the receiving VASP whitelisted",
                            "element", "chainTransfer", "field", "toAddress", "expected", approvedAddress, "actual", paidTo);
                }
            }
        }

        // The FX quote window: a transfer landing outside it was priced on a rate the customer never agreed to.
        Object fxQuote = optProp(approval, "fxQuote");
        if (Boolean.TRUE.equals(policy.get("enforceFxQuoteWindow")) && truthy(fxQuote)) {
            Object movedAt = optProp(chainTransfer, "observedAt");
            if (truthy(movedAt)) {
                double t = dateParse(movedAt, strict);
                if (!Double.isNaN(t)) {
                    Object validUntilText = prop(fxQuote, "validUntil");
                    double validUntil = dateParse(validUntilText, strict);
                    if (!Double.isNaN(validUntil) && t > validUntil) {
                        f.add("matching", "FX_QUOTE_EXPIRED", "blocking",
                                "the transfer settled after the locked " + JsValue.string(prop(fxQuote, "pair")) + " quote of "
                                        + JsValue.string(prop(fxQuote, "rate")) + " expired, so it was priced on a rate the customer was not quoted",
                                "element", "bankApproval", "field", "fxQuote.validUntil", "expected", validUntilText, "actual", movedAt);
                    }
                }
                Object quotedAtText = prop(fxQuote, "quotedAt");
                double quotedAt = dateParse(quotedAtText, strict);
                if (!Double.isNaN(quotedAt) && t < quotedAt) {
                    f.add("matching", "FX_QUOTE_AFTER_SETTLEMENT", "blocking", "the quote is timestamped after the transfer it supposedly priced",
                            "element", "bankApproval", "field", "fxQuote.quotedAt", "expected", "before " + JsValue.string(movedAt),
                            "actual", quotedAtText);
                }
            }
        }

        // Refunds: a return of funds cites the settlement it reverses, and why.
        boolean refundReason = truthy(member(ev, "refundReasonCode"));
        boolean related = truthy(member(ev, "relatedSettlementId"));
        if (refundReason && !related) {
            f.add("matching", "REFUND_WITHOUT_ORIGINAL", "blocking",
                    "a refund reason is given but no original settlement id, so the return cannot be matched "
                            + "to the payment it reverses and reads as an unexplained inbound transfer",
                    "field", "relatedSettlementId");
        }
        if (related && !refundReason) {
            f.add("matching", "REFUND_WITHOUT_REASON", "warning",
                    "this settlement points back at another but states no reason code, which a supervisor reviewing the corridor will ask for",
                    "field", "refundReasonCode");
        }
    }

    /** Which of the checklist's fields this evidence carries. Presence only. */
    private static Set<String> suppliedFields(Map<String, Object> ev, Map<String, Object> el, boolean strict) {
        Set<String> out = new HashSet<>();
        Object instruction = member(el, "bankInstruction");
        Object transfer = member(el, "chainTransfer");
        mark(out, "originator", optProp(instruction, "debtor"));
        mark(out, "beneficiary", optProp(instruction, "creditor"));
        mark(out, "amount", optProp(instruction, "amount"));
        mark(out, "currency", optProp(instruction, "currency"));
        mark(out, "purpose", member(ev, "purpose"));
        mark(out, "jurisdictionFrom", optProp(member(ev, "jurisdiction"), "from"));
        mark(out, "jurisdictionTo", optProp(member(ev, "jurisdiction"), "to"));
        mark(out, "chainTxRef", optProp(transfer, "txRef"));
        mark(out, "originatorAddress", optProp(transfer, "fromAddress"));
        mark(out, "beneficiaryAddress", optProp(transfer, "toAddress"));
        mark(out, "invoiceRef", optProp(member(el, "commercialDocs"), "invoiceRef"));
        mark(out, "payoutRef", optProp(first(member(el, "payoutReceipts")), "ref"));
        Object fields = optProp(instruction, "iso20022Fields");
        if ((fields instanceof List && !((List<?>) fields).isEmpty()) || (fields instanceof String && !((String) fields).isEmpty())
                || (!strict && fields instanceof Map && ((Map<?, ?>) fields).containsKey("length") && JsValue.toNumber(((Map<?, ?>) fields).get("length")) > 0)) {
            out.add("iso20022");
        }
        return out;
    }

    private static void mark(Set<String> out, String name, Object v) {
        if (!nullish(v) && !"".equals(v)) {
            out.add(name);
        }
    }
}
