package com.stonehash.attest.core.remit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.audit.AuditSearch;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Settlements in the store, and the rules that are the store's to keep.
 *
 * <p>A settlement's state is a summary of the signed events beneath it,
 * never a fact of its own: every transition is caused by an appended event,
 * the event is what carries a signature, and a replay of the event log lands
 * on the same state. Corrections are new events, never edits — which is why
 * nothing here updates an event.
 *
 * <p>What is the store's to keep:
 * <ul>
 * <li><b>one message, one settlement</b> ({@link #sourceConflict}): within
 *     an organisation, a SWIFT message stands for at most one settlement,
 *     in whatever rendering it arrives;
 * <li><b>the order of a settlement's events</b> ({@link #appendEvent}): the
 *     next number is taken while the settlement's row is locked;
 * <li><b>a state moves only from the state it was expected in</b>
 *     ({@link #moveState}): of two transitions that both saw the same state,
 *     one finds it gone.
 * </ul>
 *
 * <p>Nothing here opens a transaction. A caller that decides by a lock opens
 * one and takes the lock first ({@link #lockOrg}, {@link #lock}).
 */
@Component
public class RemitStore {
    /** The states a settlement advances through, in their order. */
    public static final List<String> STATES = List.of("REQUEST_ACCEPTED", "BANK_AUTHORIZED", "TRAVEL_RULE_PENDING", "PAYOUT_PRE_APPROVED",
            "ONCHAIN_SETTLED", "PAYOUT_IN_PROGRESS", "BENEFICIARY_CREDIT_CONFIRMED", "EVIDENCE_ANCHORED");
    /** Every value {@code state=} may carry in a search: those, and the three a settlement ends in out of turn. */
    public static final List<String> FILTER_STATES = List.of("REQUEST_ACCEPTED", "BANK_AUTHORIZED", "TRAVEL_RULE_PENDING", "PAYOUT_PRE_APPROVED",
            "ONCHAIN_SETTLED", "PAYOUT_IN_PROGRESS", "BENEFICIARY_CREDIT_CONFIRMED", "EVIDENCE_ANCHORED", "CANCELLED", "RETURNED", "EXCEPTION");
    /** A settlement in one of these never moves again. */
    public static final List<String> TERMINAL = List.of("EVIDENCE_ANCHORED", "CANCELLED", "RETURNED", "EXCEPTION");

    private final RemitMapper mapper;

    public RemitStore(RemitMapper mapper) {
        this.mapper = mapper;
    }

    // ── settlements ──────────────────────────────────────────────────────────

    /** A settlement's row, whoever it belongs to, or {@code null}. */
    public Map<String, Object> get(String paymentId) {
        return mapper.payment(paymentId);
    }

    /** The organisation's own settlement of that id, or {@code null}: whether another organisation has one is not the caller's to learn. */
    public Map<String, Object> getForOrg(String orgId, String paymentId) {
        Map<String, Object> p = mapper.payment(paymentId);
        return p != null && orgId.equals(p.get("org_id")) ? p : null;
    }

    public boolean exists(String paymentId) {
        return mapper.paymentExists(paymentId) != null;
    }

    /** Two acceptances of one organisation are judged one after the other: the first statement of that transaction. */
    public void lockOrg(String orgId) {
        mapper.lockOrg(orgId);
    }

    /** The settlement's row, locked until the transaction ends — the first statement of a transition. {@code null} when there is none. */
    public Map<String, Object> lock(String paymentId) {
        return mapper.paymentForUpdate(paymentId);
    }

    /** What a settlement row is created from; everything else starts empty. */
    public static final class NewPayment {
        public String id;
        public String orgId;
        public String quoteId;
        public String corridorOrigin;
        public String corridorDestination;
        public String tradeCurrency;
        public String tradeAmount;
        public String collectCurrency;
        public String collectAmount;
        public String usdcAmount;
        public String payoutCurrency;
        public String payoutAmount;
        public String beneficiaryInstitution;
        public String requestBody;
    }

    /** A new settlement, in {@code REQUEST_ACCEPTED}. */
    public void insertPayment(NewPayment p) {
        mapper.insertPayment(p.id, p.orgId, p.quoteId, p.corridorOrigin, p.corridorDestination, p.tradeCurrency, p.tradeAmount, p.collectCurrency,
                p.collectAmount, p.usdcAmount, p.payoutCurrency, p.payoutAmount, p.beneficiaryInstitution, p.requestBody, IsoTime.now());
    }

    /**
     * Move the state — only if it is still what it was expected to be.
     *
     * @return whether this call moved it. {@code false}: someone else moved it first, and the caller's transition did not happen.
     */
    public boolean moveState(String paymentId, String from, String to) {
        return mapper.moveState(paymentId, from, to, IsoTime.now()) == 1;
    }

    public void setDepositAddress(String paymentId, String depositAddress) {
        mapper.setDepositAddress(paymentId, depositAddress, IsoTime.now());
    }

    public void setChainTx(String paymentId, String chainTx) {
        mapper.setChainTx(paymentId, chainTx, IsoTime.now());
    }

    public void setEvidenceLevel(String paymentId, String evidenceLevel) {
        mapper.setEvidenceLevel(paymentId, evidenceLevel, IsoTime.now());
    }

    public void setVerdict(String paymentId, String verdict) {
        mapper.setVerdict(paymentId, verdict, IsoTime.now());
    }

    /** @return whether the settlement took the package: one that already has an evidence record keeps it. */
    public boolean setPackage(String paymentId, String packageJson, String nonce, String commitment, String attestationId) {
        return mapper.setPackage(paymentId, packageJson, nonce, commitment, attestationId, IsoTime.now()) == 1;
    }

    /** The one sanctioned change to a stored request: taking the personal data out once it has been relayed. */
    public void setRequestBody(String paymentId, String requestBody) {
        mapper.setRequestBody(paymentId, requestBody, IsoTime.now());
    }

    /** {@code id, attestation_id} of the settlements whose evidence record has confirmed on the chain and that still wait for it. */
    public List<Map<String, Object>> anchoredPending() {
        return mapper.anchoredPending();
    }

    // ── events ───────────────────────────────────────────────────────────────

    public List<Map<String, Object>> events(String paymentId) {
        return mapper.events(paymentId);
    }

    /** The first event of a type, or {@code null}. */
    public Map<String, Object> eventOfType(String paymentId, String type) {
        return mapper.eventOfType(paymentId, type);
    }

    public List<Map<String, Object>> eventsOfType(String paymentId, String type) {
        return mapper.eventsOfType(paymentId, type);
    }

    /**
     * Append one event. The caller states who asserted what; this only
     * guarantees the order: the number is the next one, taken while the
     * caller holds the settlement's row (it locked it, or is inserting it in
     * this same transaction).
     *
     * @param payload any JSON value; stored as the text JavaScript's {@code JSON.stringify} gives for it
     * @param sig the signature envelope beside it, or {@code null} for an event nobody signed
     * @return the event's sequence number: 0 for a settlement's first
     */
    public int appendEvent(String paymentId, String type, String issuer, Object payload, Object sig) {
        int seq = mapper.nextSeq(paymentId);
        mapper.insertEvent(UUID.randomUUID().toString(), paymentId, seq, type, issuer, Js.stringify(payload), sig == null ? null : Js.stringify(sig),
                IsoTime.now());
        return seq;
    }

    // ── quotes ───────────────────────────────────────────────────────────────

    public void saveQuote(String orgId, String id, String origin, String destination, Object request, Object response, String expiresAt) {
        mapper.insertQuote(id, orgId, origin, destination, Js.stringify(request), Js.stringify(response), expiresAt, IsoTime.now());
    }

    /** {@code id, response, expires_at} of one of the organisation's quotes, or {@code null}. */
    public Map<String, Object> quote(String orgId, String quoteId) {
        return mapper.quote(quoteId, orgId);
    }

    // ── request idempotency ──────────────────────────────────────────────────

    /** {@code request_hash, response_status, response_body} stored under the organisation's key, or {@code null}. */
    public Map<String, Object> idempotencyHit(String orgId, String key) {
        return mapper.idempotencyHit(orgId, key);
    }

    public void idempotencyStore(String orgId, String key, String requestHash, int status, Object body) {
        mapper.insertIdempotency(orgId, key, requestHash, status, Js.stringify(body), IsoTime.now());
    }

    // ── travel rule ──────────────────────────────────────────────────────────

    /** @param response any JSON value, or {@link Js#UNDEFINED} for none */
    public void saveTravelRule(String paymentId, String recipient, String ciphertext, String digest, String status, Object response) {
        mapper.insertTravelRule(UUID.randomUUID().toString(), paymentId, recipient, ciphertext, digest, status,
                response == Js.UNDEFINED ? null : Js.stringify(response), IsoTime.now());
    }

    /** {@code ivms101_digest, ciphertext, status} of the newest travel-rule row, or {@code null}. */
    public Map<String, Object> travelRule(String paymentId) {
        return mapper.travelRule(paymentId);
    }

    // ── one message, one settlement ──────────────────────────────────────────

    /** The settlement that already stands for a message, and on what ground. */
    public static final class Conflict {
        public final String paymentId;
        /**
         * {@code message} the same transaction of the same file;
         * {@code uetr} the two carry the same UETR;
         * {@code twin} another file that states the same payment, and at least one of the two has no UETR to settle it.
         */
        public final String ground;
        /** {@code uetr} only: the UETR stands on a different payment — other content, or another transaction of the same file. */
        public final boolean reused;
        /** {@code twin} only: neither states a value date, so nothing says whether this is that payment again. A refusal, not a recognition. */
        public final boolean undated;

        Conflict(String paymentId, String ground, boolean reused, boolean undated) {
            this.paymentId = paymentId;
            this.ground = ground;
            this.reused = reused;
            this.undated = undated;
        }
    }

    /**
     * The settlement that already stands for this message, if one does —
     * and, where the message is recognised as another rendering of it, the
     * note of that recognition. Runs inside the acceptance's transaction,
     * after the organisation's row was locked.
     *
     * <p>One settlement per payment, within an organisation — in this order:
     * <ol>
     * <li>the same transaction of the same file is the same payment,
     *     whatever else is said about it — also when two versions of a
     *     reader came to different content digests for the same bytes;
     * <li>a transaction that was recognised as a settlement before is still
     *     it;
     * <li>the same UETR is the same payment, whatever the message looks
     *     like — or, with other content or on another transaction of the
     *     same file, a UETR used twice;
     * <li>where at least one of the two has no UETR, another file that
     *     states the same payment (the twin key) is that payment sent again.
     * </ol>
     * Two different UETRs are two payments, whatever else they share, and so
     * are two transactions of one file.
     *
     * <p>A twin is matched one to one. A file with two transactions that
     * read alike is two payments; written out again, each of its
     * transactions is the twin of one of the two settlements, not both of
     * the oldest — so the recognition is recorded, and a settlement that a
     * sibling of the incoming transaction was recognised as is not offered
     * to it again. And a settlement without a UETR takes the UETR of the
     * rendering it is recognised in: from then on it is that UETR's payment.
     *
     * <p><b>What this writes stays written when the acceptance is refused.</b>
     * The recognition and the inherited UETR are facts about the message
     * that arrived; the caller commits them and then refuses.
     */
    public Conflict sourceConflict(String orgId, SourceRef ref) {
        Map<String, Object> same = mapper.sourceRefOfMessage(orgId, ref.sha256, ref.index);
        if (same != null) {
            return new Conflict((String) same.get("payment_id"), "message", false, false);
        }
        String known = mapper.sourceMatch(orgId, ref.sha256, ref.index);
        if (known != null) {
            return new Conflict(known, "twin", false, false);
        }
        if (ref.uetr != null) {
            Map<String, Object> row = mapper.sourceRefOfUetr(orgId, ref.uetr);
            if (row != null) {
                String paymentId = (String) row.get("payment_id");
                boolean otherTransaction = ref.sha256.equals(row.get("sha256")) && ((Number) row.get("idx")).longValue() != ref.index;
                boolean otherContent = ref.content != null && row.get("content") != null && !ref.content.equals(row.get("content"));
                boolean reused = otherTransaction || otherContent;
                if (!reused) {
                    recognise(orgId, ref, paymentId);
                }
                return new Conflict(paymentId, "uetr", reused, false);
            }
        }
        if (ref.twinKey != null) {
            Map<String, Object> twin = mapper.sourceTwin(orgId, ref.twinKey, ref.sha256, ref.uetr != null);
            if (twin != null) {
                String paymentId = (String) twin.get("payment_id");
                if (ref.undated) {
                    return new Conflict(paymentId, "twin", false, true);
                }
                recognise(orgId, ref, paymentId);
                if (ref.uetr != null) {
                    mapper.inheritUetr(paymentId, ref.uetr);
                }
                return new Conflict(paymentId, "twin", false, false);
            }
        }
        return null;
    }

    private void recognise(String orgId, SourceRef ref, String paymentId) {
        mapper.insertSourceMatch(orgId, ref.sha256, ref.index, paymentId, IsoTime.now());
    }

    /** The reference row of a settlement made from a message: it exists exactly when its settlement does. */
    public void insertSourceRef(String orgId, String paymentId, SourceRef ref) {
        mapper.insertSourceRef(paymentId, orgId, ref.messageType, ref.sha256, ref.index, ref.uetr, ref.valueDate, ref.content, ref.twinKey, IsoTime.now());
    }

    /** A settlement's reference row, or {@code null} for one that was not made from a message. */
    public Map<String, Object> sourceRef(String paymentId) {
        return mapper.sourceRef(paymentId);
    }

    // ── the ledger ───────────────────────────────────────────────────────────

    /** What to look for. A field left {@code null} does not narrow. */
    public static final class Search {
        /** A piece of an identifier, in any case: the payment id, the quote id, the transaction hash, or one of the bank's own references. */
        public String q;
        /** Exact lookups on the message a settlement was made from; the whole value, through an index. */
        public String sourceUetr;
        public String sourceContent;
        /** With {@code sourceContent}: only settlements whose message stated this value date. */
        public String sourceValueDate;
        /** One state, or several separated by commas. */
        public String state;
        /** Inclusive bounds on {@code created_at}, compared as the text they are. */
        public String from;
        public String to;
        public String cursor;
        public long limit = 25;
    }

    public static final class Page {
        public final List<Map<String, Object>> items;
        /** How many rows the filters leave, whatever the cursor. */
        public final long total;
        /** Where the next page starts, or {@code null} at the end. */
        public final String nextCursor;

        Page(List<Map<String, Object>> items, long total, String nextCursor) {
            this.items = items;
            this.total = total;
            this.nextCursor = nextCursor;
        }
    }

    /**
     * The organisation's ledger, filtered, a page at a time: newest first on
     * (created_at, id), both halves carried in the cursor, so rows created
     * in the same millisecond are neither skipped nor repeated across a page
     * boundary — and a page deep into a ledger that only grows costs what
     * the first one does.
     *
     * @throws ServiceError 400 {@code invalid_state}, 400 {@code invalid_cursor}
     */
    public Page search(String orgId, Search s) {
        long limit = Math.max(1, Math.min(s.limit, 100));
        String like = s.q == null || s.q.isEmpty() ? null : AuditSearch.likeContains(s.q);
        boolean lookup = s.sourceUetr != null || s.sourceContent != null;
        List<String> states = null;
        if (s.state != null && !s.state.isEmpty()) {
            // One state, or several: a bank reads "paid out" as one thing although the platform records two states for it.
            states = new ArrayList<>();
            for (String part : s.state.split(",", -1)) {
                String name = Js.trim(part);
                if (!name.isEmpty()) {
                    states.add(name);
                }
            }
            for (String name : states) {
                if (!FILTER_STATES.contains(name)) {
                    throw new ServiceError(400, "invalid_state", "state must be one of " + String.join(", ", FILTER_STATES));
                }
            }
            if (states.isEmpty()) {
                // Commas and nothing between them: the previous service put an empty list into its statement and failed on it.
                throw new IllegalStateException("a state filter that names no state cannot be asked of the store");
            }
        }
        String uetr = s.sourceUetr == null ? null : s.sourceUetr.toLowerCase(Locale.ROOT);
        String content = s.sourceContent == null ? null : s.sourceContent.toLowerCase(Locale.ROOT);
        String from = s.from == null || s.from.isEmpty() ? null : s.from;
        String to = s.to == null || s.to.isEmpty() ? null : s.to;

        long total = mapper.searchCount(orgId, like, lookup, uetr, content, s.sourceValueDate, states, from, to);

        String[] cursor = s.cursor == null || s.cursor.isEmpty() ? null : AuditSearch.decodeCursor(s.cursor);
        // One row beyond the page answers "is there a next page" without a second query, and without an empty last page.
        List<Map<String, Object>> rows = mapper.searchPage(orgId, like, lookup, uetr, content, s.sourceValueDate, states, from, to,
                cursor == null ? null : cursor[0], cursor == null ? null : cursor[1], limit + 1);
        List<Map<String, Object>> items = new ArrayList<>(rows.subList(0, (int) Math.min(limit, rows.size())));
        Map<String, Object> last = items.isEmpty() ? null : items.get(items.size() - 1);
        return new Page(items, total,
                rows.size() > limit && last != null ? AuditSearch.encodeCursor((String) last.get("created_at"), (String) last.get("id")) : null);
    }

    /** The organisation an account's e-mail address belongs to, or {@code null}. */
    public String orgOfAccount(String email) {
        return mapper.orgOfAccount(email);
    }

    // ── daily manifests ──────────────────────────────────────────────────────

    /** The ids of what the organisation instructed on a day (UTC: the first ten characters of the time each was accepted), oldest first. */
    public List<String> paymentIdsOfDay(String orgId, String date) {
        return mapper.paymentIdsOfDay(orgId, date);
    }

    /** One row per organisation and day; a manifest sent again for a day replaces the row. */
    public void saveManifest(String orgId, String date, Object manifest, Object sig, Object verdict, Object platformSig, String commitment,
            String attestationId) {
        mapper.upsertManifest(UUID.randomUUID().toString(), orgId, date, Js.stringify(manifest), Js.stringify(sig), Js.stringify(verdict),
                Js.stringify(platformSig), commitment, attestationId, IsoTime.now());
    }

    /** The organisation's manifest of a day (none or one), or — with no day — its newest thirty. */
    public List<Map<String, Object>> manifests(String orgId, String date) {
        return date == null ? mapper.latestManifests(orgId) : mapper.manifestsOfDay(orgId, date);
    }
}
