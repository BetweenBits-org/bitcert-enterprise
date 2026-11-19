package com.stonehash.attest.remit;

import com.stonehash.attest.remit.swift.SwiftMappingException;
import com.stonehash.attest.remit.swift.SwiftMessageException;
import com.stonehash.attest.remit.swift.SwiftPayment;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@code submitSwift} held to the reference client: {@code golden/scenarios.json}
 * records, step by step, what the TypeScript SDK's {@code submitSwift} decided
 * against a stand-in platform — sent, recognised as sent already, or refused —
 * how often it quoted and posted, what it searched the ledger for, and what it
 * posted. The same steps are run here against the same stand-in platform, and
 * every one of those answers has to be the same. The stand-in holds the
 * platform's own rule — one message, one settlement — so the cases include
 * the ones only the platform can decide: the same payment in another message
 * (which of two like instalments a re-exported transaction stands for), and
 * another process handing over the same payment at the same moment.
 *
 * <p>This is the test behind the sentence "the same message handed to either
 * SDK names the same payment, and each recognises a payment the other
 * submitted": several cases start from a ledger written by the other SDK.
 */
final class SwiftScenarioTest {
    private SwiftScenarioTest() {
    }

    // ── the stand-in platform of tools/make-golden.mjs (`standInPlatform`) ────

    /**
     * The platform's ledger as far as "one message, one settlement" goes.
     *
     * <p>The reference SDK's stand-in does not copy that rule: it runs the
     * platform's own store ({@code apps/core/src/remit/store.ts}) on an
     * in-memory database
     * ({@code packages/attest-remit/test/support/source-ledger.ts}). This is
     * that store's rule ported line for line — {@code sourceRefOf},
     * {@code legacySourceRefOf}, {@code twinKeyOf}, {@code sourceConflict},
     * {@code createFromMessage}, {@code claimSource},
     * {@code backfillSourceRefs} and the lookups of {@code search} — and it is
     * written out in words in {@code scenarios.json} under
     * {@code platform.rules}.
     *
     * <p>A stand-in that only resembles the platform makes a test pass for a
     * client that would pay twice, or call a payment made that never was. So
     * nothing here is simplified: the order of the checks, twins matched one
     * to one, the recognitions that are recorded and the UETR a settlement
     * takes from its other rendering are the platform's.
     *
     * <p>Time is the ledger's own: every settlement is stamped one step after
     * the one before, so "the oldest" and "the newest" are the order of
     * arrival, the same on every run.
     */
    static final class SourceLedger {
        private static final Pattern UUID = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
        private static final Pattern DIGEST = Pattern.compile("[0-9a-fA-F]{64}");
        private static final Pattern DAY = Pattern.compile("(\\d{4})-(\\d{2})-(\\d{2})");
        private static final Pattern DIGITS = Pattern.compile("\\d{1,7}");
        /** The words the standards write where there is no reference. */
        private static final Pattern NO_REFERENCE = Pattern.compile("NOTPROVIDED|NONREF|NOREF", Pattern.CASE_INSENSITIVE);
        /** A settlement that was cancelled, returned or stopped comes after the others when old settlements are given their places. */
        private static final List<String> STOPPED = Arrays.asList("CANCELLED", "RETURNED", "EXCEPTION");

        /** What tells one payment from another, out of the reference the bank signed into the instruction. */
        private static final class Ref {
            String sha256;
            long index;
            String uetr;
            /** The value date the message states, YYYY-MM-DD — or null when it states none. */
            String valueDate;
            String content;
            String twinKey;
            /** The message states no value date: its twin key cannot tell one day's payment from another's. */
            boolean undated;
        }

        /** A settlement's place: one row of remit_source_refs. */
        private static final class Place {
            final String paymentId;
            final Ref ref;
            final long at;

            Place(String paymentId, Ref ref, long at) {
                this.paymentId = paymentId;
                this.ref = ref;
                this.at = at;
            }
        }

        /** The settlement that already stands for a message, and on what ground. */
        private static final class Conflict {
            final String paymentId;
            /** message, uetr or twin. */
            final String ground;
            /** uetr only: the UETR stands on a different payment. */
            final boolean reused;
            /** twin only: no value date tells the two apart — a refusal, not a recognition. */
            final boolean undated;

            Conflict(String paymentId, String ground, boolean reused, boolean undated) {
                this.paymentId = paymentId;
                this.ground = ground;
                this.reused = reused;
                this.undated = undated;
            }
        }

        /** How the platform answers an instruction, or a lookup, it does not accept. */
        static final class Refusal {
            final int status;
            final Map<String, Object> body;

            Refusal(int status, Map<String, Object> body) {
                this.status = status;
                this.body = body;
            }
        }

        /** What a lookup answers: the ids on this page, how many there are in all, and where the next page starts. */
        static final class Page {
            final List<String> ids;
            final long total;
            final String nextCursor;

            Page(List<String> ids, long total, String nextCursor) {
                this.ids = ids;
                this.total = total;
                this.nextCursor = nextCursor;
            }
        }

        private long clock;
        /** Every settlement the platform holds, and when it arrived. */
        private final Map<String, Long> payments = new LinkedHashMap<>();
        private final List<Place> places = new ArrayList<>();
        /** remit_source_matches: "this transaction of this file was recognised as that settlement" — (sha256, index) → payment id. */
        private final Map<String, String> recognised = new LinkedHashMap<>();
        /** The same records by (payment id, sha256): a settlement a sibling transaction was recognised as. */
        private final Set<String> recognisedFiles = new HashSet<>();

        // ── reading the signed reference ──────────────────────────────────────

        private static IllegalArgumentException bad(String what) {
            return new IllegalArgumentException("evidence_elements.bankInstruction.sourceMessage: " + what);
        }

        /** A field that is text of at most {@code max} characters, null when it is not there; anything else is refused. */
        private static String text(Map<String, Object> m, String key, int max) {
            Object v = m.get(key);
            if (v == null) {
                return null;
            }
            if (!(v instanceof String) || ((String) v).length() > max) {
                throw bad(key + " must be text of at most " + max + " characters");
            }
            return (String) v;
        }

        /** The same field read leniently: what is not text of that length is as good as absent. */
        private static String loose(Map<String, Object> m, String key, int max) {
            Object v = m.get(key);
            return v instanceof String && ((String) v).length() <= max ? (String) v : "";
        }

        private static boolean wholeNumber(Number n) {
            double d = n.doubleValue();
            return !Double.isNaN(d) && !Double.isInfinite(d) && d == Math.floor(d);
        }

        /** White space and line ends as JavaScript's {@code trim()} takes them off. */
        private static boolean jsSpace(char c) {
            return c == '\t' || c == '\n' || c == 0x0B || c == '\f' || c == '\r' || c == ' ' || c == 0xA0 || c == 0x1680
                    || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
        }

        private static String jsTrim(String s) {
            int from = 0;
            int to = s.length();
            while (from < to && jsSpace(s.charAt(from))) {
                from++;
            }
            while (to > from && jsSpace(s.charAt(to - 1))) {
                to--;
            }
            return s.substring(from, to);
        }

        /**
         * YYYY-MM-DD, and a day the calendar has. The platform asks
         * {@code Date.UTC}, which reads the years 0000 to 0099 as 1900 to
         * 1999: none of those is a calendar day to it.
         */
        private static boolean isCalendarDay(String v) {
            Matcher m = DAY.matcher(v);
            if (!m.matches()) {
                return false;
            }
            int year = Integer.parseInt(m.group(1));
            int month = Integer.parseInt(m.group(2));
            int day = Integer.parseInt(m.group(3));
            return year >= 100 && month >= 1 && month <= 12 && day >= 1 && day <= YearMonth.of(year, month).lengthOfMonth();
        }

        private static String sha256Hex(String text) {
            try {
                StringBuilder hex = new StringBuilder();
                for (byte b : MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))) {
                    hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
                }
                return hex.toString();
            } catch (java.security.NoSuchAlgorithmException e) {
                throw new AssertionError(e);
            }
        }

        /**
         * The twin key of a reference whose parts have been read and
         * normalised: the same payment written out again in other bytes. (The
         * platform keeps the SHA-256 of this text; the text tells the same
         * rows apart.)
         */
        private static String twinKeyOf(String messageType, long index, String content,
                String instructionId, String endToEndId, String messageId, String valueDate) {
            if (content == null) {
                return null;
            }
            if (!instructionId.isEmpty() || !endToEndId.isEmpty()) {
                return Json.compact(Arrays.asList("stonehash:remit:twin:v1", instructionId, endToEndId, valueDate, content));
            }
            if (!messageId.isEmpty()) {
                return Json.compact(Arrays.asList("stonehash:remit:twin-by-message:v1", messageType, messageId, index, valueDate, content));
            }
            return null;
        }

        /**
         * {@code sourceRefOf}: the signed reference, or null when the
         * instruction was not made from a message. A reference that is there
         * but cannot be what it claims to be is refused; what never tells two
         * references apart is normalised.
         */
        private static Ref refOf(Object sourceMessage) {
            if (sourceMessage == null) {
                return null;
            }
            if (!(sourceMessage instanceof Map)) {
                throw bad("must be an object");
            }
            Map<String, Object> m = object(sourceMessage);
            String messageType = text(m, "type", 40);
            if (messageType == null || messageType.isEmpty()) {
                throw bad("type is required (the message type, e.g. pacs.008.001.08 or MT103)");
            }
            String sha256 = text(m, "sha256", 64);
            if (sha256 == null || !DIGEST.matcher(sha256).matches()) {
                throw bad("sha256 is required: the SHA-256 of the message as the bank's system wrote it, in hex");
            }
            Object index = m.get("index") == null ? (Object) 0L : m.get("index");
            if (!(index instanceof Number) || !wholeNumber((Number) index)
                    || ((Number) index).doubleValue() < 0 || ((Number) index).doubleValue() > 1_000_000) {
                throw bad("index must be the position of the transaction in its message, counted from 0");
            }
            String uetr = text(m, "uetr", 36);
            if (uetr != null && !UUID.matcher(uetr).matches()) {
                throw bad("uetr must be a UUID");
            }
            String content = text(m, "content", 64);
            if (content != null && !DIGEST.matcher(content).matches()) {
                throw bad("content must be a SHA-256 digest in hex");
            }
            String valueDate = text(m, "valueDate", 32);
            if (valueDate != null && !isCalendarDay(valueDate)) {
                throw bad("valueDate must be a calendar day written YYYY-MM-DD");
            }
            String instructionId = text(m, "instructionId", 256);
            String endToEnd = text(m, "endToEndId", 256);
            String messageId = text(m, "messageId", 256);
            instructionId = instructionId == null ? "" : jsTrim(instructionId);
            endToEnd = endToEnd == null ? "" : jsTrim(endToEnd);
            messageId = messageId == null ? "" : jsTrim(messageId);
            Ref ref = new Ref();
            ref.sha256 = sha256.toLowerCase(Locale.ROOT);
            ref.index = ((Number) index).longValue();
            ref.uetr = uetr == null ? null : uetr.toLowerCase(Locale.ROOT);
            ref.valueDate = valueDate;
            ref.content = content == null ? null : content.toLowerCase(Locale.ROOT);
            ref.twinKey = twinKeyOf(messageType, ref.index, ref.content, instructionId,
                    NO_REFERENCE.matcher(endToEnd).matches() ? "" : endToEnd, messageId, valueDate == null ? "" : valueDate);
            ref.undated = valueDate == null;
            return ref;
        }

        /**
         * {@code legacySourceRefOf}: the same reference, read out of a
         * settlement that was accepted before the platform checked any of it.
         * Nothing is refused, and whatever identifies the settlement is kept;
         * a file digest that cannot be read is replaced by one of the
         * settlement itself. Null only when there is no reference.
         */
        private static Ref legacyRefOf(Object sourceMessage, String paymentId) {
            if (!(sourceMessage instanceof Map)) {
                return null;
            }
            Map<String, Object> m = object(sourceMessage);
            String type = loose(m, "type", 40);
            String messageType = type.isEmpty() ? "unknown" : type;
            Ref ref = new Ref();
            String sha256 = loose(m, "sha256", 64);
            ref.sha256 = DIGEST.matcher(sha256).matches() ? sha256.toLowerCase(Locale.ROOT) : sha256Hex("stonehash:remit:legacy-source:" + paymentId);
            Object raw = m.get("index") instanceof String && DIGITS.matcher((String) m.get("index")).matches()
                    ? (Object) Long.valueOf((String) m.get("index")) : m.get("index");
            ref.index = raw instanceof Number && wholeNumber((Number) raw) && ((Number) raw).doubleValue() > 0
                    && ((Number) raw).doubleValue() <= 1_000_000 ? ((Number) raw).longValue() : 0;
            String uetr = jsTrim(loose(m, "uetr", 36));
            ref.uetr = UUID.matcher(uetr).matches() ? uetr.toLowerCase(Locale.ROOT) : null;
            String content = loose(m, "content", 64);
            ref.content = DIGEST.matcher(content).matches() ? content.toLowerCase(Locale.ROOT) : null;
            String day = jsTrim(loose(m, "valueDate", 32));
            ref.valueDate = isCalendarDay(day) ? day : null;
            String endToEnd = jsTrim(loose(m, "endToEndId", 256));
            ref.twinKey = twinKeyOf(messageType, ref.index, ref.content, jsTrim(loose(m, "instructionId", 256)),
                    NO_REFERENCE.matcher(endToEnd).matches() ? "" : endToEnd, jsTrim(loose(m, "messageId", 256)),
                    ref.valueDate == null ? "" : ref.valueDate);
            ref.undated = ref.valueDate == null;
            return ref;
        }

        /** evidence_elements?.bankInstruction?.sourceMessage */
        private static Object sourceMessageIn(Object elements) {
            Object instruction = elements instanceof Map ? object(elements).get("bankInstruction") : null;
            return instruction instanceof Map ? object(instruction).get("sourceMessage") : null;
        }

        /** The evidence elements the bank signed: the payload of a settlement's first BANK_EVIDENCE_SUBMITTED event. */
        static Object elementsOf(Map<String, Object> view) {
            for (Object event : list(view.get("events"))) {
                if (event instanceof Map && "BANK_EVIDENCE_SUBMITTED".equals(object(event).get("type"))) {
                    return object(event).get("payload");
                }
            }
            return null;
        }

        // ── one settlement per payment ────────────────────────────────────────

        private void recognise(Ref ref, String paymentId) {
            recognised.put(ref.sha256 + "#" + ref.index, paymentId);
            recognisedFiles.add(paymentId + "|" + ref.sha256);
        }

        /**
         * {@code sourceConflict}: the settlement that already stands for this
         * message, if one does — and, where the message is recognised as
         * another rendering of it, the note of that recognition. In this
         * order, the first that applies decides.
         */
        private Conflict conflict(Ref ref) {
            // The same transaction of the same file first: it is the same payment whatever else is said about it.
            for (Place same : places) {
                if (same.ref.sha256.equals(ref.sha256) && same.ref.index == ref.index) {
                    return new Conflict(same.paymentId, "message", false, false);
                }
            }
            // A transaction that was recognised as a settlement before is still it.
            String known = recognised.get(ref.sha256 + "#" + ref.index);
            if (known != null) {
                return new Conflict(known, "twin", false, false);
            }
            if (ref.uetr != null) {
                for (Place row : places) {
                    if (ref.uetr.equals(row.ref.uetr)) {
                        boolean otherTransaction = row.ref.sha256.equals(ref.sha256) && row.ref.index != ref.index;
                        boolean otherContent = ref.content != null && row.ref.content != null && !row.ref.content.equals(ref.content);
                        boolean reused = otherTransaction || otherContent;
                        if (!reused) {
                            recognise(ref, row.paymentId);
                        }
                        return new Conflict(row.paymentId, "uetr", reused, false);
                    }
                }
            }
            if (ref.twinKey != null) {
                // With a UETR in hand, only a settlement without one can be its twin. And a
                // settlement that another transaction of this same file was recognised as is taken.
                Place twin = null;
                for (Place row : places) {
                    if (ref.twinKey.equals(row.ref.twinKey) && !row.ref.sha256.equals(ref.sha256)
                            && (ref.uetr == null || row.ref.uetr == null)
                            && !recognisedFiles.contains(row.paymentId + "|" + ref.sha256)
                            && (twin == null || row.at < twin.at || (row.at == twin.at && row.paymentId.compareTo(twin.paymentId) < 0))) {
                        twin = row;
                    }
                }
                if (twin != null) {
                    if (ref.undated) {
                        return new Conflict(twin.paymentId, "twin", false, true);
                    }
                    recognise(ref, twin.paymentId);
                    if (ref.uetr != null && twin.ref.uetr == null) {
                        // From then on it is that UETR's payment, and a payment with another UETR is not its twin.
                        twin.ref.uetr = ref.uetr;
                    }
                    return new Conflict(twin.paymentId, "twin", false, false);
                }
            }
            return null;
        }

        private static Map<String, Object> error(String code, String message) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("error", code);
            out.put("message", message);
            return out;
        }

        private static Refusal refusal(Conflict conflict, String uetr) {
            String id = conflict.paymentId;
            String code = "duplicate_source_message";
            String ground;
            String message;
            if (conflict.reused) {
                code = "reference_reused";
                ground = "uetr";
                message = "UETR " + uetr + " is already on settlement " + id + ", which is a different payment";
            } else if (conflict.undated) {
                ground = "twin_undated";
                message = "this payment cannot be told from settlement " + id + ": the message states no value date";
            } else {
                ground = conflict.ground;
                message = "this message's payment is already settlement " + id + " — "
                        + (ground.equals("message") ? "the same transaction of the same message"
                                : ground.equals("uetr") ? "the same UETR" : "the same payment in another message");
            }
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("existing_payment_id", id);
            body.put("ground", ground);
            body.put("error", code);
            body.put("message", message);
            return new Refusal(409, body);
        }

        boolean has(String paymentId) {
            return payments.containsKey(paymentId);
        }

        /**
         * {@code POST /v1/settlements}, as far as the ledger decides it: a
         * payment id that is taken, a reference that is not one, a message
         * that already has a settlement — or the settlement is taken and null
         * is returned.
         */
        Refusal accept(String paymentId, Object evidenceElements) {
            if (has(paymentId)) {
                return new Refusal(409, error("duplicate_payment", "exists"));
            }
            Ref ref;
            try {
                ref = refOf(sourceMessageIn(evidenceElements));
            } catch (IllegalArgumentException e) {
                return new Refusal(400, error("invalid_source_message", e.getMessage()));
            }
            if (ref != null) {
                Conflict found = conflict(ref);
                if (found != null) {
                    return refusal(found, ref.uetr);
                }
            }
            long at = ++clock;
            payments.put(paymentId, at);
            if (ref != null) {
                places.add(new Place(paymentId, ref, at));
            }
            return null;
        }

        /**
         * Settlements that were on the platform before it kept one settlement
         * per message, in the order given: each is stored, and then given its
         * place the way a start of the platform gives it
         * ({@code backfillSourceRefs}) — a reference written loosely is still
         * read; those that were not cancelled, returned or stopped first,
         * then the older. One that conflicts takes no place; what the check
         * recognised on the way is recorded all the same.
         */
        void addFromBefore(List<Map<String, Object>> settlements) {
            List<Object[]> waiting = new ArrayList<>();
            for (Map<String, Object> v : settlements) {
                String id = (String) v.get("payment_id");
                long at = ++clock;
                payments.put(id, at);
                waiting.add(new Object[] { id, at, STOPPED.contains(v.get("state")), elementsOf(v) });
            }
            waiting.sort((a, b) -> {
                int stopped = Boolean.compare((Boolean) a[2], (Boolean) b[2]);
                int age = Long.compare((Long) a[1], (Long) b[1]);
                return stopped != 0 ? stopped : age != 0 ? age : ((String) a[0]).compareTo((String) b[0]);
            });
            for (Object[] row : waiting) {
                Ref ref = legacyRefOf(sourceMessageIn(row[3]), (String) row[0]);
                if (ref != null && conflict(ref) == null) {
                    places.add(new Place((String) row[0], ref, (Long) row[1]));
                }
            }
        }

        private static Refusal lookupRefused(String message) {
            return new Refusal(400, error("invalid_source_lookup", message));
        }

        /** {@code Math.min(100, Math.max(1, Number(limit ?? '25') || 25))} */
        private static int limitOf(String given) {
            double n = 25;
            if (given != null) {
                String t = jsTrim(given);
                try {
                    n = t.isEmpty() ? 0 : Double.parseDouble(t);
                } catch (NumberFormatException e) {
                    n = Double.NaN;
                }
            }
            if (Double.isNaN(n) || n == 0) {
                n = 25;
            }
            return (int) Math.min(100, Math.max(1, n));
        }

        private static String cursorOf(long at, String id) {
            Map<String, Object> at_ = new LinkedHashMap<>();
            at_.put("c", at);
            at_.put("i", id);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(Json.compact(at_).getBytes(StandardCharsets.UTF_8));
        }

        /**
         * {@code GET /v1/settlements}: every settlement, or — with
         * {@code source_uetr}, or {@code source_content} (and
         * {@code source_value_date}) — those that hold a matching place.
         * Newest first, paged by {@code limit} and {@code cursor}. A lookup
         * value that could never match is refused. Answers a {@link Page} or
         * a {@link Refusal}.
         */
        Object listed(Map<String, String> query) {
            String uetr = query.get("source_uetr");
            String content = query.get("source_content");
            String day = query.get("source_value_date");
            if (uetr != null && !UUID.matcher(uetr).matches()) {
                return lookupRefused("source_uetr must be a UUID");
            }
            if (content != null && !DIGEST.matcher(content).matches()) {
                return lookupRefused("source_content must be a SHA-256 digest in hex");
            }
            if (day != null && content == null) {
                return lookupRefused("source_value_date narrows source_content and needs it");
            }
            if (day != null && !Pattern.matches("\\d{4}-\\d{2}-\\d{2}", day)) {
                return lookupRefused("source_value_date must be YYYY-MM-DD");
            }
            int limit = limitOf(query.get("limit"));
            Long before = null;
            String beforeId = null;
            String cursor = query.get("cursor");
            if (cursor != null && !cursor.isEmpty()) {
                try {
                    Map<String, Object> at = object(Json.parse(new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8)));
                    before = ((Number) at.get("c")).longValue();
                    beforeId = (String) at.get("i");
                    if (beforeId == null) {
                        throw new IllegalArgumentException("shape");
                    }
                } catch (RuntimeException e) {
                    return new Refusal(400, error("invalid_cursor", "the cursor is not one this API issued"));
                }
            }
            Map<String, Place> placeOf = new LinkedHashMap<>();
            for (Place p : places) {
                placeOf.put(p.paymentId, p);
            }
            List<Map.Entry<String, Long>> newestFirst = new ArrayList<>(payments.entrySet());
            newestFirst.sort((a, b) -> a.getValue().equals(b.getValue()) ? b.getKey().compareTo(a.getKey()) : Long.compare(b.getValue(), a.getValue()));
            long total = 0;
            List<Map.Entry<String, Long>> rows = new ArrayList<>();
            for (Map.Entry<String, Long> p : newestFirst) {
                if (uetr != null || content != null) {
                    Place place = placeOf.get(p.getKey());
                    if (place == null || (uetr != null && !uetr.toLowerCase(Locale.ROOT).equals(place.ref.uetr))
                            || (content != null && !content.toLowerCase(Locale.ROOT).equals(place.ref.content))
                            || (day != null && !day.equals(place.ref.valueDate))) {
                        continue;
                    }
                }
                total++;
                if (before == null || p.getValue() < before || (p.getValue().equals(before) && p.getKey().compareTo(beforeId) < 0)) {
                    rows.add(p);
                }
            }
            // One row beyond the page answers "is there a next page".
            List<String> ids = new ArrayList<>();
            for (Map.Entry<String, Long> p : rows.subList(0, Math.min(limit, rows.size()))) {
                ids.add(p.getKey());
            }
            Map.Entry<String, Long> last = ids.isEmpty() ? null : rows.get(ids.size() - 1);
            return new Page(ids, total, rows.size() > limit && last != null ? cursorOf(last.getValue(), last.getKey()) : null);
        }
    }

    /**
     * The stand-in platform of the vectors ({@code standInPlatform} in
     * {@code tools/make-golden.mjs}): it quotes, takes a settlement and keeps
     * what was posted, lists the ledger and answers the exact lookups, answers
     * for one settlement and cancels one — and holds the platform's rule
     * through {@link SourceLedger}. Its ledger can be filled beforehand, and a
     * step can be raced.
     */
    static final class StandIn implements Function<StubPlatform.Request, StubPlatform.Answer> {
        private final Map<String, Map<String, Object>> settlements = new LinkedHashMap<>();
        private final SourceLedger sources = new SourceLedger();
        private final Map<String, Object> quote;
        /**
         * What the next settlement POST meets: an error code — the settlement
         * is kept and that error answered, as when the same request got there
         * first — or {@code { taken: <settlement> }}: another process's
         * instruction arrives just before this one, and is judged like any
         * other.
         */
        volatile Object race;

        StandIn(Map<String, Object> quote, List<Object> ledger) {
            this.quote = quote;
            List<Map<String, Object>> before = new ArrayList<>();
            for (Object entry : ledger) {
                Map<String, Object> view = copy(entry);
                settlements.put((String) view.get("payment_id"), view);
                before.add(view);
            }
            sources.addFromBefore(before);
        }

        private static StubPlatform.Answer refused(SourceLedger.Refusal refusal) {
            return StubPlatform.Answer.json(refusal.status, refusal.body);
        }

        @Override
        public synchronized StubPlatform.Answer apply(StubPlatform.Request r) {
            String path = pathOf(r);
            if (path.equals("/v1/quotes")) {
                // Number(body.trade.amount).toFixed(2): the amount as a double, written with two decimals.
                Map<String, Object> answer = new LinkedHashMap<>(quote);
                Map<String, Object> trade = new LinkedHashMap<>();
                trade.put("currency", "USD");
                trade.put("amount", new BigDecimal(Double.parseDouble(String.valueOf(object(r.json().get("trade")).get("amount"))))
                        .setScale(2, RoundingMode.HALF_UP).toPlainString());
                answer.put("trade", trade);
                return StubPlatform.Answer.json(201, answer);
            }
            if (r.method.equals("POST") && path.equals("/v1/settlements")) {
                Map<String, Object> body = r.json();
                String id = (String) body.get("payment_id");
                Object raced = race;
                race = null;
                if (raced instanceof Map) {
                    // The other process's instruction arrives first, and is judged like any other.
                    Map<String, Object> other = copy(object(raced).get("taken"));
                    if (sources.accept((String) other.get("payment_id"), SourceLedger.elementsOf(other)) == null) {
                        settlements.put((String) other.get("payment_id"), other);
                    }
                }
                Object elements = body.get("evidence_elements");
                SourceLedger.Refusal refusal = sources.accept(id, elements);
                if (refusal != null) {
                    return refused(refusal);
                }
                Map<String, Object> kept = copy(Json.parse("{\"payment_id\":null,\"state\":\"BANK_AUTHORIZED\",\"evidence_level\":null,"
                        + "\"evidence_available\":false,\"chain_tx\":null,\"attestation\":null,\"events\":["
                        + "{\"seq\":0,\"type\":\"REQUEST_ACCEPTED\",\"issuer\":\"STONEHASH\",\"at\":\"2026-11-17T00:00:00.000Z\",\"payload\":{},\"sig\":null},"
                        + "{\"seq\":1,\"type\":\"BANK_EVIDENCE_SUBMITTED\",\"issuer\":\"VN-BANK-T1\",\"at\":\"2026-11-17T00:00:00.100Z\",\"payload\":null,\"sig\":null}]}"));
                kept.put("payment_id", id);
                object(list(kept.get("events")).get(1)).put("payload", elements);
                settlements.put(id, kept);
                if (raced instanceof String) {
                    return StubPlatform.Answer.json(409, error((String) raced, "another request for this payment was taken a moment earlier"));
                }
                Map<String, Object> accepted = new LinkedHashMap<>();
                accepted.put("payment_id", id);
                accepted.put("state", "BANK_AUTHORIZED");
                return StubPlatform.Answer.json(202, accepted);
            }
            if (r.method.equals("GET") && path.equals("/v1/settlements")) {
                // The first value of each parameter, as URLSearchParams.get answers.
                Map<String, String> query = new LinkedHashMap<>();
                for (String[] pair : queryOf(r)) {
                    query.putIfAbsent(pair[0], pair[1]);
                }
                Object looked = sources.listed(query);
                if (looked instanceof SourceLedger.Refusal) {
                    return refused((SourceLedger.Refusal) looked);
                }
                SourceLedger.Page found = (SourceLedger.Page) looked;
                List<Object> rows = new ArrayList<>();
                for (String id : found.ids) {
                    Map<String, Object> v = settlements.get(id);
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("payment_id", v.get("payment_id"));
                    row.put("state", v.get("state"));
                    rows.add(row);
                }
                Map<String, Object> page = new LinkedHashMap<>();
                page.put("total", found.total);
                page.put("returned", (long) rows.size());
                page.put("next_cursor", found.nextCursor);
                Map<String, Object> answer = new LinkedHashMap<>();
                answer.put("data", rows);
                answer.put("page", page);
                return StubPlatform.Answer.json(200, answer);
            }
            if (path.startsWith("/v1/settlements/")) {
                String rest = path.substring("/v1/settlements/".length());
                if (r.method.equals("POST") && rest.endsWith("/cancel") && rest.indexOf('/') == rest.length() - "/cancel".length()) {
                    Map<String, Object> hit = settlements.get(decode(rest.substring(0, rest.length() - "/cancel".length())));
                    if (hit == null) {
                        return StubPlatform.Answer.json(404, error("not_found", "no such settlement"));
                    }
                    if ("CANCELLED".equals(hit.get("state"))) {
                        return StubPlatform.Answer.json(409, error("not_cancellable", "the settlement is already CANCELLED"));
                    }
                    hit.put("state", "CANCELLED");
                    Map<String, Object> answer = new LinkedHashMap<>();
                    answer.put("payment_id", hit.get("payment_id"));
                    answer.put("state", "CANCELLED");
                    return StubPlatform.Answer.json(200, answer);
                }
                if (r.method.equals("GET") && rest.indexOf('/') < 0) {
                    Map<String, Object> hit = settlements.get(decode(rest));
                    return hit == null ? StubPlatform.Answer.json(404, error("not_found", "no such settlement")) : StubPlatform.Answer.json(200, hit);
                }
            }
            return StubPlatform.Answer.json(404, error("not_found", path));
        }

        private static Map<String, Object> error(String code, String message) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("error", code);
            out.put("message", message);
            return out;
        }
    }

    static String pathOf(StubPlatform.Request r) {
        int at = r.path.indexOf('?');
        return at < 0 ? r.path : r.path.substring(0, at);
    }

    /** The parameters of a request's query, decoded, in the order they were sent. */
    static List<String[]> queryOf(StubPlatform.Request r) {
        List<String[]> out = new ArrayList<>();
        int at = r.path.indexOf('?');
        if (at >= 0 && at + 1 < r.path.length()) {
            for (String pair : r.path.substring(at + 1).split("&")) {
                int eq = pair.indexOf('=');
                out.add(new String[] { decode(eq < 0 ? pair : pair.substring(0, eq)), eq < 0 ? "" : decode(pair.substring(eq + 1)) });
            }
        }
        return out;
    }

    /** What a GET of the ledger asked for: its parameters as sent, without the paging ones. */
    private static String askedOf(StubPlatform.Request r) {
        List<String> out = new ArrayList<>();
        for (String[] pair : queryOf(r)) {
            if (!pair[0].equals("limit") && !pair[0].equals("cursor")) {
                out.add(pair[0] + "=" + pair[1]);
            }
        }
        return String.join("&", out);
    }

    private static String decode(String text) {
        return URLDecoder.decode(text, StandardCharsets.UTF_8);
    }

    // ── reading the vectors ───────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return (List<Object>) o;
    }

    /** A copy that can be changed: one case must not reach the next. */
    private static Map<String, Object> copy(Object json) {
        return object(Json.parse(Json.compact(json)));
    }

    static Map<String, Object> golden(String name) throws Exception {
        return object(Json.parse(TestMain.resource("golden/" + name), "invalid_json", name));
    }

    /** The input of a case of {@code parse.json}, as the reference SDK was handed it: a String or a byte[]. */
    static Object input(Map<String, Object> in) {
        boolean asString = "string".equals(in.get("as"));
        if (in.get("repeat") != null) {
            Map<String, Object> r = object(in.get("repeat"));
            StringBuilder text = new StringBuilder(r.get("prefix") == null ? "" : (String) r.get("prefix"));
            for (long i = 0; i < ((Number) r.get("times")).longValue(); i++) {
                text.append((String) r.get("text"));
            }
            return asString ? (Object) text.toString() : (Object) text.toString().getBytes(StandardCharsets.ISO_8859_1);
        }
        return asString ? in.get("text") : (Object) Base64.getDecoder().decode((String) in.get("base64"));
    }

    /**
     * Where the reference SDK's words name its own API, this SDK names its
     * own (the same replacement the reader's tests make). Everything else is
     * the same sentence.
     */
    private static String javaWording(String message) {
        return message.replace("pass { index } to choose one, or use parseSwiftMessages() to take each in turn",
                "pass an index to choose one, or use Swift.parseAll() to take each in turn");
    }

    /**
     * An exception as the vectors record an error. The reference SDK's mapping
     * error carries no code, so none is compared for it; this SDK gives it
     * {@code mapping_incomplete}, which is checked on its own.
     */
    private static Map<String, Object> errorOf(RuntimeException e) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", e instanceof SwiftMessageException ? "SwiftMessageError" : e instanceof SwiftMappingException ? "SwiftMappingError"
                : e instanceof RemitApiException ? "RemitApiError" : e.getClass().getName());
        if (e instanceof RemitException && !(e instanceof SwiftMappingException)) {
            out.put("code", ((RemitException) e).code());
        }
        if (e instanceof SwiftMessageException && ((SwiftMessageException) e).field() != null) {
            out.put("field", ((SwiftMessageException) e).field());
        }
        out.put("message", String.valueOf(e.getMessage()));
        if (e instanceof RemitApiException) {
            out.put("status", (long) ((RemitApiException) e).status());
            // The settlement that already stands for the message, where the refusal names one — and on what ground.
            if (((RemitApiException) e).existingPaymentId() != null) {
                out.put("existingPaymentId", ((RemitApiException) e).existingPaymentId());
            }
            if (((RemitApiException) e).ground() != null) {
                out.put("ground", ((RemitApiException) e).ground());
            }
        }
        return out;
    }

    /** The first place two JSON values differ, or null. Objects by key, whatever the order; numbers by value. */
    private static String difference(String path, Object e, Object a) {
        if (e instanceof Map && a instanceof Map) {
            Map<String, Object> em = object(e);
            Map<String, Object> am = object(a);
            TreeSet<String> keys = new TreeSet<>(em.keySet());
            keys.addAll(am.keySet());
            for (String k : keys) {
                if (!em.containsKey(k)) {
                    return path + "." + k + ": not expected, got " + Json.compact(am.get(k));
                }
                if (!am.containsKey(k)) {
                    return path + "." + k + ": expected " + Json.compact(em.get(k)) + ", missing";
                }
                String d = difference(path + "." + k, em.get(k), am.get(k));
                if (d != null) {
                    return d;
                }
            }
            return null;
        }
        if (e instanceof List && a instanceof List) {
            List<Object> el = list(e);
            List<Object> al = list(a);
            if (el.size() != al.size()) {
                return path + ": expected " + Json.compact(e) + ", got " + Json.compact(a);
            }
            for (int i = 0; i < el.size(); i++) {
                String d = difference(path + "[" + i + "]", el.get(i), al.get(i));
                if (d != null) {
                    return d;
                }
            }
            return null;
        }
        if (e instanceof Number && a instanceof Number) {
            return new BigDecimal(e.toString()).compareTo(new BigDecimal(a.toString())) == 0 ? null : path + ": expected " + e + ", got " + a;
        }
        return (e == null ? a == null : e.equals(a)) ? null : path + ": expected " + Json.compact(e) + ", got " + Json.compact(a);
    }

    static long count(List<StubPlatform.Request> requests, String method, String path) {
        long n = 0;
        for (StubPlatform.Request r : requests) {
            if (r.method.equals(method) && pathOf(r).equals(path)) {
                n++;
            }
        }
        return n;
    }

    // ── the scenarios ─────────────────────────────────────────────────────────

    static void testSubmitSwiftDecidesWhatTheReferenceClientDecides() throws Exception {
        Map<String, Object> scenarios = golden("scenarios.json");
        Map<String, Object> clientOf = object(scenarios.get("client"));
        Map<String, Object> quote = object(object(scenarios.get("platform")).get("quote"));
        Map<String, Object> testKey = object(golden("signing.json").get("testKey"));
        KeySigner key = Signers.fromPkcs8Pem((String) testKey.get("pkcs8Pem"));
        Map<String, Object> inputs = new LinkedHashMap<>();
        for (Object c : list(golden("parse.json").get("cases"))) {
            inputs.put((String) object(c).get("name"), object(c).get("input"));
        }

        List<String> failures = new ArrayList<>();
        int cases = 0;
        int steps = 0;
        int sent = 0;
        int recognised = 0;
        int refused = 0;
        for (Object each : list(scenarios.get("cases"))) {
            Map<String, Object> scenario = object(each);
            String name = (String) scenario.get("name");
            cases++;
            StandIn standIn = new StandIn(quote, scenario.get("ledger") == null ? new ArrayList<>() : list(scenario.get("ledger")));
            try (StubPlatform platform = new StubPlatform()) {
                platform.answer(standIn);
                RemitClient client = RemitClient.builder().core(platform.origin())
                        .apiKey(scenario.get("apiKey") == null ? (String) clientOf.get("apiKey") : (String) scenario.get("apiKey"))
                        .institution((String) clientOf.get("institutionId"), (String) clientOf.get("institutionName"))
                        .signer(key).build();
                int stepNo = 0;
                for (Object s : list(scenario.get("steps"))) {
                    Map<String, Object> step = object(s);
                    String where = name + " step " + stepNo++;
                    steps++;
                    int before = platform.requests().size();
                    Map<String, Object> outcome = new LinkedHashMap<>();
                    Map<String, Object> got = new LinkedHashMap<>();
                    got.put("outcome", outcome);

                    if (step.get("cancel") != null) {
                        Map<String, Object> cancel = object(step.get("cancel"));
                        try {
                            Settlement done = client.cancel((String) cancel.get("paymentId"), (String) cancel.get("reason"));
                            outcome.put("paymentId", done.paymentId());
                            outcome.put("state", done.state());
                        } catch (RuntimeException e) {
                            outcome.put("error", errorOf(e));
                        }
                        List<StubPlatform.Request> all = platform.requests();
                        got.put("posts", count(all, "POST", "/v1/settlements"));
                        got.put("quotes", count(all, "POST", "/v1/quotes"));
                    } else {
                        Map<String, Object> message = object(step.get("message"));
                        if (message.get("parse") != null && !inputs.containsKey((String) message.get("parse"))) {
                            // The steps of a case build on one another: without this message the rest cannot be run.
                            failures.add(where + ": parse.json holds no case named " + message.get("parse")
                                    + " — the message cannot be handed over, and the steps after it were not run");
                            break;
                        }
                        Object handed = message.get("parse") != null ? input(object(inputs.get((String) message.get("parse")))) : input(message);
                        Map<String, Object> given = step.get("options") == null ? new LinkedHashMap<>() : object(step.get("options"));
                        SwiftOptions options = new SwiftOptions();
                        for (Map.Entry<String, Object> option : given.entrySet()) {
                            switch (option.getKey()) {
                                case "index":
                                    options.index(((Number) option.getValue()).intValue());
                                    break;
                                case "paymentId":
                                    options.paymentId((String) option.getValue());
                                    break;
                                case "supplementByAccount":
                                    // The bank's customer master, looked up by the debtor's account.
                                    Map<String, Object> master = object(option.getValue());
                                    options.supplement((SwiftPayment p) -> p.debtor().account() != null && master.containsKey(p.debtor().account())
                                            ? PartySupplement.fromJson(master.get(p.debtor().account())) : null);
                                    break;
                                default:
                                    throw new AssertionError(where + ": an option this test does not know: " + option.getKey());
                            }
                        }
                        standIn.race = step.get("race");
                        try {
                            SwiftSubmission submission = handed instanceof String ? client.submitSwift((String) handed, options)
                                    : client.submitSwift((byte[]) handed, options);
                            outcome.put("paymentId", submission.paymentId());
                            outcome.put("state", submission.state());
                            outcome.put("already", submission.already());
                            sent += submission.already() ? 0 : 1;
                            recognised += submission.already() ? 1 : 0;
                            if (submission.already() != (submission.quote() == null)) {
                                failures.add(where + ": a quote is returned exactly when something was sent");
                            }
                        } catch (RuntimeException e) {
                            outcome.put("error", errorOf(e));
                            refused++;
                            if (e instanceof SwiftMappingException && !"mapping_incomplete".equals(((SwiftMappingException) e).code())) {
                                failures.add(where + ": a mapping refusal's code is mapping_incomplete, got " + ((SwiftMappingException) e).code());
                            }
                        }
                        standIn.race = null;

                        List<StubPlatform.Request> all = platform.requests();
                        List<StubPlatform.Request> mine = all.subList(before, all.size());
                        got.put("posts", count(all, "POST", "/v1/settlements"));
                        got.put("quotes", count(all, "POST", "/v1/quotes"));
                        List<Object> searched = new ArrayList<>();
                        StubPlatform.Request post = null;
                        for (StubPlatform.Request r : mine) {
                            if (r.method.equals("GET") && pathOf(r).equals("/v1/settlements")) {
                                searched.add(askedOf(r));
                            }
                            if (r.method.equals("POST") && pathOf(r).equals("/v1/settlements")) {
                                post = r;
                            }
                        }
                        got.put("searched", searched);
                        if (post != null) {
                            Map<String, Object> body = post.json();
                            Map<String, Object> authorization = object(body.get("bank_authorization"));
                            Map<String, Object> elements = object(body.get("evidence_elements"));
                            Map<String, Object> posted = new LinkedHashMap<>();
                            posted.put("idempotencyKey", post.headers.get("idempotency-key"));
                            posted.put("payment_id", body.get("payment_id"));
                            posted.put("sourceMessage", object(elements.get("bankInstruction")).get("sourceMessage"));
                            if (authorization.containsKey("instruction_ref")) {
                                posted.put("instruction_ref", authorization.get("instruction_ref"));
                            }
                            if (authorization.containsKey("uetr")) {
                                posted.put("uetr", authorization.get("uetr"));
                            }
                            got.put("posted", posted);
                            // What was posted is the bank's signed statement: it has to verify, message reference and all.
                            if (!Signing.verifyEvent(authorization, body.get("bank_signature"), key.publicKeySpkiBase64())) {
                                failures.add(where + ": the posted authorization does not verify under the bank's key");
                            }
                            for (Map.Entry<String, Object> element : elements.entrySet()) {
                                if (!Signing.verifyElement(object(element.getValue()), key.publicKeySpkiBase64())) {
                                    failures.add(where + ": the posted element " + element.getKey() + " does not verify under the bank's key");
                                }
                            }
                        }
                    }

                    Map<String, Object> expect = copy(step.get("expect"));
                    Object expectedError = object(expect.get("outcome")).get("error");
                    if (expectedError != null) {
                        object(expectedError).put("message", javaWording((String) object(expectedError).get("message")));
                    }
                    String d = difference("$", expect, got);
                    if (d != null) {
                        failures.add(where + ": " + d);
                    }
                }
            }
        }
        if (!failures.isEmpty()) {
            throw new AssertionError(failures.size() + " step(s) differ from the reference client\n      " + String.join("\n      ", failures));
        }
        Check.isTrue(cases >= 51 && steps >= 190, "every scenario was read: " + cases + " cases, " + steps + " steps");
        Check.isTrue(sent >= 60 && recognised >= 65 && refused >= 35,
                "the three outcomes all occur: " + sent + " sent, " + recognised + " recognised, " + refused + " refused");
    }
}
