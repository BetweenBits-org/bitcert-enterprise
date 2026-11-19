package com.stonehash.attest.core.console;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;

/**
 * The trust registry and the product subscriptions.
 *
 * <p>The registry answers one question per signature: was this key, under
 * this role, entitled to assert this kind of fact? An institution row holds
 * public material only: the key its signatures are verified with, never a
 * private one. The settlement rail and the reserve proofs check a partner's
 * signature against that row, so what activation writes here is what those
 * products trust from the next request on.
 *
 * <p>Three views of the same rows: the row itself (a signature's key, an
 * organisation's institution), the keyring the rules engine verifies evidence
 * against, and the snapshot carried inside every evidence package — so the
 * verdict on a settlement is computed against the registry the API trusts,
 * not against a list kept beside it.
 */
@Component
public class ProductRegistry {
    private final ConsoleMapper mapper;

    public ProductRegistry(ConsoleMapper mapper) {
        this.mapper = mapper;
    }

    /** The institution with this id, whoever it belongs to, or {@code null}. */
    public Map<String, Object> institution(String id) {
        return mapper.institution(id);
    }

    /** The organisation's institution in this role, or {@code null}. */
    public Map<String, Object> institutionForOrg(String orgId, String role) {
        return mapper.institutionForOrg(orgId, role);
    }

    /**
     * Register an institution, or bring one up to date: idempotent on the
     * id. A key that is given replaces the one on file — that is a rotation,
     * recorded by overwriting. The country is replaced with what is given,
     * and with nothing when none is.
     *
     * @param country may be {@code null}
     */
    public Map<String, Object> upsert(String id, String role, String name, String country, String orgId, String signingSpki, List<String> authority) {
        return upsert(id, role, name, country, orgId, signingSpki, Js.UNDEFINED, authority);
    }

    /**
     * {@link #upsert(String, String, String, String, String, String, List)}
     * with everything a registration can say, as the registry has always
     * read it:
     * <ul>
     * <li>no organisation given ({@code null}) leaves an institution that is
     *     already there with the organisation it has — a partner registering
     *     itself again does not detach anything;
     * <li>a signing key or an encryption key that is not given stays as it
     *     was. An encryption key that <em>is</em> given is stored as its JSON
     *     text, whatever JSON it is ({@code null} included);
     * <li>the country is replaced with what is given, and with nothing when
     *     none is; what the institution may assert is replaced too, by the
     *     empty list when none is given.
     * </ul>
     *
     * @param encryptionJwk any JSON value, or {@link Js#UNDEFINED} for "not given"
     * @param authority any JSON value, or {@code null} for "not given"
     */
    public Map<String, Object> upsert(String id, String role, String name, String country, String orgId, String signingSpki,
            Object encryptionJwk, Object authority) {
        String listed = Js.stringify(authority == null ? new ArrayList<Object>() : authority);
        String encryption = encryptionJwk == Js.UNDEFINED ? null : Js.stringify(encryptionJwk);
        Map<String, Object> existing = mapper.institution(id);
        if (existing != null) {
            mapper.updateInstitution(id, role, name, country, orgId != null ? orgId : (String) existing.get("org_id"), signingSpki, encryption, listed);
        } else {
            mapper.insertInstitution(id, orgId, role, name, country, signingSpki, encryption, listed, IsoTime.now());
        }
        return mapper.institution(id);
    }

    /** Every institution of the deployment, in the order they were registered. */
    public List<Map<String, Object>> list() {
        return mapper.institutions();
    }

    /** The organisation's subscription to a product — {@code id, org_id, product, plan, status, config, created_at} — or {@code null}. */
    public Map<String, Object> subscription(String orgId, String product) {
        return mapper.subscription(orgId, product);
    }

    /**
     * The gate of the settlement API: an active subscription, and a
     * collection bank registered for the organisation with a key its
     * instructions can be verified with.
     *
     * @return the bank's institution row
     */
    public Map<String, Object> requireRemit(String orgId) {
        Map<String, Object> sub = mapper.subscription(orgId, "remit");
        if (sub == null || !"active".equals(sub.get("status"))) {
            throw new ServiceError(403, "subscription_required", "this organisation has no active Cross-border Settlement subscription; "
                    + "activate it from the console (Products) or POST /v1/console/products");
        }
        Map<String, Object> bank = mapper.institutionForOrg(orgId, "COLLECTION_BANK");
        Object key = bank == null ? null : bank.get("signing_spki");
        if (!(key instanceof String) || ((String) key).isEmpty()) {
            throw new ServiceError(403, "institution_unregistered", "no COLLECTION_BANK institution with a signing key is registered for this organisation");
        }
        return bank;
    }

    // ── the registry as the rules engine and an evidence package see it ──────

    /**
     * The registry as the entries of a verification keyring, trust level
     * {@code ATTESTED}: one per institution that has a signing key, named by
     * the institution's id — the id in a signature names its owner.
     *
     * <p>An institution whose key the reference's runtime could not turn
     * into a JWK is left out, and named on the error stream by its id only
     * (the column is meant to hold public material, but a row that does not
     * decode may not be that). Left out, its own signatures read
     * {@code UNKNOWN_KEY} and nobody else's change: one keyring serves every
     * organisation's reconciliation.
     *
     * @param institutions rows as {@link #list} gives them
     */
    public static List<Object> keyringEntries(List<Map<String, Object>> institutions) {
        List<Object> entries = new ArrayList<>();
        for (Map<String, Object> inst : institutions) {
            Object spki = inst.get("signing_spki");
            if (!(spki instanceof String) || ((String) spki).isEmpty()) {
                continue;
            }
            if (!PublicKeys.convertsToJwk((String) spki)) {
                System.err.println("registry: institution " + inst.get("id") + " has a signing key that does not convert; left out of the keyring");
                continue;
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("keyId", inst.get("id"));
            entry.put("issuer", inst.get("name"));
            entry.put("trustLevel", "ATTESTED");
            entry.put("publicKeySpki", PublicKeys.forVerification((String) spki));
            entries.add(entry);
        }
        return entries;
    }

    /**
     * The registry as it is carried inside every evidence package and
     * answered by {@code GET /v1/remit/meta}: public material only.
     *
     * @param institutions rows as {@link #list} gives them
     * @param takenAt the moment the rows were read
     */
    public static Map<String, Object> snapshot(List<Map<String, Object>> institutions, String takenAt) {
        List<Object> listed = new ArrayList<>();
        for (Map<String, Object> i : institutions) {
            Map<String, Object> shown = new LinkedHashMap<>();
            shown.put("id", i.get("id"));
            shown.put("role", i.get("role"));
            shown.put("name", i.get("name"));
            shown.put("country", i.get("country"));
            shown.put("signing_spki", i.get("signing_spki"));
            shown.put("authority", Js.parse((String) i.get("authority")));
            // A bank's SDK (mode B) encrypts to this.
            Object encryption = i.get("encryption_jwk");
            if (encryption instanceof String && !((String) encryption).isEmpty()) {
                shown.put("encryption_jwk", Js.parse((String) encryption));
            }
            listed.add(shown);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("taken_at", takenAt);
        out.put("institutions", listed);
        return out;
    }

    /** {@link #snapshot(List, String)} of the registry as it stands now. */
    public Map<String, Object> snapshot() {
        String takenAt = IsoTime.now();
        return snapshot(list(), takenAt);
    }

    // ── the platform's own institution ───────────────────────────────────────

    /** The id, and the role, the platform signs under. */
    public static final String PLATFORM_ID = "STONEHASH";
    static final String PLATFORM_NAME = "StoneHash (platform)";
    /** What the platform itself may assert. */
    static final List<String> PLATFORM_AUTHORITY = Arrays.asList("REQUEST_ACCEPTED", "BANK_AUTHORIZATION_VERIFIED", "TRAVEL_RULE_SENT",
            "SETTLEMENT_INSTRUCTED", "SETTLEMENT_RECONCILED", "EVIDENCE_COMMITTED", "EVIDENCE_ANCHORED", "webhook");

    /** What stands in the registry for the platform, compared with the key it signs with now. */
    public enum PlatformRow {
        /** No row. */
        ABSENT,
        /** A row with this key and this content: nothing to write. */
        CURRENT,
        /** A row with this key whose other content is not what is registered today. */
        STALE,
        /** A row with another key. */
        OTHER_KEY
    }

    /** How the platform's own institution row stands against {@code spki}, the key the platform signs with now. Reads only. */
    public PlatformRow platformRow(String spki) {
        Map<String, Object> row = mapper.institution(PLATFORM_ID);
        if (row == null) {
            return PlatformRow.ABSENT;
        }
        if (!spki.equals(row.get("signing_spki"))) {
            return PlatformRow.OTHER_KEY;
        }
        boolean same = PLATFORM_ID.equals(row.get("role")) && PLATFORM_NAME.equals(row.get("name")) && row.get("country") == null
                && Js.stringify(PLATFORM_AUTHORITY).equals(row.get("authority"));
        return same ? PlatformRow.CURRENT : PlatformRow.STALE;
    }

    /**
     * Register the platform itself, so that its event and webhook signatures
     * resolve like any other institution's: the row the previous service
     * wrote every time it started, with the same content.
     */
    public Map<String, Object> registerPlatform(String spki) {
        try {
            return upsert(PLATFORM_ID, PLATFORM_ID, PLATFORM_NAME, null, null, spki, Js.UNDEFINED, PLATFORM_AUTHORITY);
        } catch (DuplicateKeyException e) {
            // Two instances starting side by side both found no row; the other's is there now. Brought to this content.
            return upsert(PLATFORM_ID, PLATFORM_ID, PLATFORM_NAME, null, null, spki, Js.UNDEFINED, PLATFORM_AUTHORITY);
        }
    }

    /**
     * The gate of the reserve-proof API: an active subscription, and an
     * exchange registered for the organisation with a key its statements
     * can be verified with.
     *
     * @return the exchange's institution row
     */
    public Map<String, Object> requirePor(String orgId) {
        Map<String, Object> sub = mapper.subscription(orgId, "por");
        if (sub == null || !"active".equals(sub.get("status"))) {
            throw new ServiceError(403, "subscription_required", "this organisation has no active Proof of Reserves subscription; "
                    + "activate it from the console (Products) or POST /v1/console/products");
        }
        Map<String, Object> exchange = mapper.institutionForOrg(orgId, "EXCHANGE");
        Object key = exchange == null ? null : exchange.get("signing_spki");
        if (!(key instanceof String) || ((String) key).isEmpty()) {
            throw new ServiceError(403, "institution_unregistered", "no EXCHANGE institution with a signing key is registered for this organisation");
        }
        return exchange;
    }

    /** The organisation's subscriptions, oldest first: {@code id, org_id, product, plan, status, config, created_at}. */
    public List<Map<String, Object>> subscriptions(String orgId) {
        return mapper.subscriptions(orgId);
    }

    /**
     * Subscribe the organisation to a product, or — where it has been
     * subscribed before — make that subscription active again with this
     * configuration. One row per organisation and product: its history and
     * its billing stay continuous.
     */
    public Map<String, Object> subscribe(String orgId, String product, Map<String, Object> config) {
        Map<String, Object> existing = mapper.subscription(orgId, product);
        if (existing != null) {
            mapper.reactivateSubscription((String) existing.get("id"), Js.stringify(config));
        } else {
            mapper.insertSubscription(UUID.randomUUID().toString(), orgId, product, Js.stringify(config), IsoTime.now());
        }
        return mapper.subscription(orgId, product);
    }

    /**
     * Switch a product off. The row stays, for its history and so that
     * billing is continuous; the products' gates read {@code status}, so
     * every API of that product refuses until it is activated again.
     *
     * @return the subscription as it now stands, or {@code null} where the organisation never had one
     */
    public Map<String, Object> unsubscribe(String orgId, String product) {
        Map<String, Object> existing = mapper.subscription(orgId, product);
        if (existing == null) {
            return null;
        }
        mapper.deactivateSubscription((String) existing.get("id"));
        return mapper.subscription(orgId, product);
    }

    /**
     * Point an institution at another key. The rails verify against this
     * column and nothing else, so the switch holds from the next signature
     * checked: no restart, no new subscription.
     */
    public void setSigningKey(String institutionId, String spki) {
        mapper.setSigningKey(institutionId, spki);
    }

    /**
     * The key the console's reserve screen signs with: a second key, beside
     * the signing key and never instead of it. The exchange's own key stays
     * where the exchange keeps it. Each session's key replaces the last.
     */
    public void setConsoleKey(String institutionId, String spki) {
        mapper.setConsoleKey(institutionId, spki);
    }
}
