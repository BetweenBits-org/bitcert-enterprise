package com.stonehash.attest.remit;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The Travel Rule message and its encryption.
 *
 * <p>The message has the corridor's two layers — the underlying trade payment
 * (importer → exporter) and the settlement leg (settlement entity →
 * beneficiary institution) — with IVMS 101 naming for the persons. The
 * encryption is RFC 7516 compact JWE, ECDH-ES (P-256) direct key agreement
 * with A256GCM, on the JDK alone. There is no decryption here: only the
 * beneficiary institution opens a message, with a key this SDK never sees.
 *
 * <p>Who shapes and encrypts the message depends on the mode of the
 * settlement:
 * <ul>
 * <li><b>bank-side ("mode B")</b> — {@link RemitClient} does it on the bank's
 *     machine, to the beneficiary institution's key, and the platform relays
 *     a ciphertext it cannot open. A bank integration calls nothing in this
 *     class itself.
 * <li><b>platform-side ("mode A")</b> — the bank submits the party data and
 *     the platform shapes and encrypts it. <b>The public methods of this
 *     class are that half</b>, for the platform's own back end:
 *     {@link #missingFields}, {@link #buildIvms101}, {@link #encrypt} and its
 *     key derivation {@link #concatKdf}. They answer as the reference
 *     implementation answers — the message field for field, also for party
 *     data of an unexpected shape — and are held to it by
 *     {@code golden/travel-rule.json}.
 * </ul>
 */
public final class TravelRule {
    private TravelRule() {
    }

    /** A value that is not there — as distinct from one that is {@code null}. */
    private static final Object ABSENT = VerdictEngine.UNDEFINED;

    /** The party fields the corridor requires, as paths into the compliance payload, in the order they are reported. */
    public static final List<String> REQUIRED_FIELDS = java.util.Collections.unmodifiableList(Arrays.asList(
            "originator.name", "originator.country", "originator.address", "originator.registration_number",
            "beneficiary.name", "beneficiary.country", "beneficiary.account", "beneficiary.bank"));

    /** {@code value.key}, where anything that is not an object has no members. */
    private static Object member(Object value, String key) {
        return value instanceof Map && ((Map<?, ?>) value).containsKey(key) ? ((Map<?, ?>) value).get(key) : ABSENT;
    }

    private static boolean nullish(Object v) {
        return v == null || v == ABSENT;
    }

    private static void put(Map<String, Object> out, String key, Object value) {
        if (value != ABSENT) {
            out.put(key, value);
        }
    }

    /**
     * Which of {@link #REQUIRED_FIELDS} the compliance payload does not
     * state — in that order; empty when it states them all. A field is
     * stated when it is text with something other than white space in it.
     *
     * @param compliance the party data a bank submitted: {@code originator} and {@code beneficiary}, each an object
     * @throws RemitException {@code unreadable_compliance} when there is no payload at all
     */
    public static List<String> missingFields(Object compliance) {
        if (compliance == null) {
            throw new RemitException("unreadable_compliance", "there is no compliance payload");
        }
        List<String> missing = new ArrayList<>();
        for (String path : REQUIRED_FIELDS) {
            int dot = path.indexOf('.');
            // A list is an object too, with no such member; text, a number, a boolean are not objects.
            Object value = member(member(compliance, path.substring(0, dot)), path.substring(dot + 1));
            if (!(value instanceof String) || Text.isBlank((String) value)) {
                missing.add(path);
            }
        }
        return missing;
    }

    /**
     * The Travel Rule message for a settlement whose party data the bank
     * submitted in the clear (mode A), as the reference's
     * {@code buildIvms101} builds it: member for member and in its order,
     * so that the digest the evidence carries — over the canonical form of
     * exactly this object — is the one the reference would have computed.
     *
     * <p>The party data is taken as it is and never corrected. What a party
     * does not state is left out or written as empty text, as the reference
     * does; a value of an unexpected kind is carried as it stands. Run
     * {@link #missingFields} first to refuse a payload that lacks what the
     * corridor requires.
     *
     * @param compliance {@code originator} and {@code beneficiary} (each with {@code name}, {@code country},
     *                   {@code address}, {@code registration_number}, {@code account}; the beneficiary also {@code bank}),
     *                   and optionally {@code purpose_code}
     * @param context    what the platform knows of the settlement: {@code paymentId}, {@code tradeAmount},
     *                   {@code tradeCurrency}, {@code usdcAmount}, {@code originatingInstitution} and
     *                   {@code beneficiaryInstitution} (each {@code id}, {@code name}, {@code country}) and
     *                   {@code settlementEntity} ({@code id}, {@code name})
     * @throws RemitException {@code unreadable_compliance} when there is no payload at all, or it holds a value the
     *                        reference's engine fails on (an object with a member of its own named {@code toString}
     *                        where a registration number is read as text)
     * @throws IllegalArgumentException when the context does not name one of its three institutions
     */
    public static Map<String, Object> buildIvms101(Object compliance, Map<String, Object> context) {
        java.util.Objects.requireNonNull(context, "context");
        if (compliance == null) {
            throw new RemitException("unreadable_compliance", "there is no compliance payload");
        }
        try {
            return built(compliance, context);
        } catch (JsValue.NotPrimitive e) {
            throw new RemitException("unreadable_compliance", "the compliance payload cannot be read: " + e.getMessage());
        }
    }

    private static Map<String, Object> built(Object compliance, Map<String, Object> context) {
        Object originating = institution(context, "originatingInstitution");
        Object beneficiaryInstitution = institution(context, "beneficiaryInstitution");
        Object settlementEntity = institution(context, "settlementEntity");
        Object beneficiary = member(compliance, "beneficiary");
        Object bank = nullish(beneficiary) ? ABSENT : member(beneficiary, "bank");

        Map<String, Object> institutionOfOrigin = new LinkedHashMap<>();
        put(institutionOfOrigin, "institutionId", member(originating, "id"));
        put(institutionOfOrigin, "name", member(originating, "name"));
        put(institutionOfOrigin, "country", member(originating, "country"));
        Map<String, Object> transaction = new LinkedHashMap<>();
        put(transaction, "amount", member(context, "tradeAmount"));
        put(transaction, "currency", member(context, "tradeCurrency"));
        if (VerdictEngine.truthy(member(compliance, "purpose_code"))) {
            transaction.put("purposeCode", member(compliance, "purpose_code"));
        }
        // Layer 1 — the underlying trade payment.
        Map<String, Object> underlying = new LinkedHashMap<>();
        underlying.put("originator", map("originatorPersons", list(statedPerson(member(compliance, "originator")))));
        underlying.put("beneficiary", map("beneficiaryPersons", list(statedPerson(beneficiary))));
        underlying.put("originatingInstitution", institutionOfOrigin);
        underlying.put("beneficiaryLocalBank", nullish(bank) ? "" : bank);
        underlying.put("transaction", transaction);

        // Layer 2 — the institutional settlement leg.
        Map<String, Object> originatingVasp = new LinkedHashMap<>();
        put(originatingVasp, "institutionId", member(settlementEntity, "id"));
        put(originatingVasp, "name", member(settlementEntity, "name"));
        Map<String, Object> beneficiaryVasp = new LinkedHashMap<>();
        put(beneficiaryVasp, "institutionId", member(beneficiaryInstitution, "id"));
        put(beneficiaryVasp, "name", member(beneficiaryInstitution, "name"));
        put(beneficiaryVasp, "country", member(beneficiaryInstitution, "country"));
        Map<String, Object> settled = new LinkedHashMap<>();
        put(settled, "amount", member(context, "usdcAmount"));
        settled.put("currency", "USDC");
        Map<String, Object> leg = new LinkedHashMap<>();
        leg.put("originatingVasp", originatingVasp);
        leg.put("beneficiaryVasp", beneficiaryVasp);
        leg.put("transaction", settled);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", "IVMS101-2023");
        put(out, "payment_id", member(context, "paymentId"));
        out.put("underlyingPayment", underlying);
        out.put("settlementLeg", leg);
        return out;
    }

    private static Object institution(Map<String, Object> context, String name) {
        Object value = context.get(name);
        if (value == null) {
            throw new IllegalArgumentException("the context names no " + name);
        }
        return value;
    }

    /**
     * A party as the bank stated it, read the way the reference reads it: a
     * member counts when JavaScript would call it true — which for the text
     * a party is made of means "not empty" — and is carried as it stands.
     */
    private static Map<String, Object> statedPerson(Object party) {
        Object name = member(party, "name");
        Object country = member(party, "country");
        Object address = member(party, "address");
        Object registration = member(party, "registration_number");
        Object account = member(party, "account");
        return person(nullish(name) ? "" : name, VerdictEngine.truthy(address) ? address : ABSENT, nullish(country) ? "" : country,
                VerdictEngine.truthy(registration) ? registration : ABSENT, VerdictEngine.truthy(country) ? country : ABSENT,
                VerdictEngine.truthy(account) ? account : ABSENT);
    }

    /** Twenty characters, the last two digits: the form of an LEI. */
    static boolean isLei(Object value) {
        return value instanceof String && ((String) value).matches("[A-Z0-9]{18}[0-9]{2}");
    }

    private static String text(Map<String, Object> party, String key) {
        Object v = party.get(key);
        return v instanceof String && !((String) v).isEmpty() ? (String) v : null;
    }

    /** A party on the bank's side (mode B): only text with something in it counts as stated. */
    private static Map<String, Object> legalPerson(Map<String, Object> p) {
        String name = text(p, "name");
        String country = text(p, "country");
        String address = text(p, "address");
        String registration = text(p, "registration_number");
        String account = text(p, "account");
        return person(name == null ? "" : name, address == null ? ABSENT : address, country == null ? "" : country,
                registration == null ? ABSENT : registration, country == null ? ABSENT : country, account == null ? ABSENT : account);
    }

    /**
     * One legal person, IVMS 101 naming — the one shape both modes write.
     *
     * @param name           the name, or empty text
     * @param address        the address, or {@link #ABSENT}: no address block is written then
     * @param addressCountry the country written into the address block, or empty text
     * @param registration   the registration number, or {@link #ABSENT}
     * @param country        the country of registration, or {@link #ABSENT}
     * @param account        the account number, or {@link #ABSENT}
     */
    private static Map<String, Object> person(Object name, Object address, Object addressCountry, Object registration, Object country,
            Object account) {
        Map<String, Object> identifier = new LinkedHashMap<>();
        identifier.put("legalPersonName", name);
        identifier.put("legalPersonNameIdentifierType", "LEGL");
        Map<String, Object> nameBlock = new LinkedHashMap<>();
        nameBlock.put("nameIdentifier", Arrays.asList(identifier));

        Map<String, Object> person = new LinkedHashMap<>();
        person.put("name", nameBlock);
        if (address != ABSENT) {
            Map<String, Object> geo = new LinkedHashMap<>();
            geo.put("addressType", "GEOG");
            geo.put("addressLine", Arrays.asList(address));
            geo.put("country", addressCountry);
            person.put("geographicAddress", Arrays.asList(geo));
        }
        if (registration != ABSENT) {
            // An LEI is typed as one (IVMS 101: LEIX); any other number is carried as a registration-authority
            // identifier. The test is on the number as text, which is what the reference tests.
            Map<String, Object> national = new LinkedHashMap<>();
            national.put("nationalIdentifier", registration);
            national.put("nationalIdentifierType", isLei(JsValue.string(registration)) ? "LEIX" : "RAID");
            person.put("nationalIdentification", national);
        }
        if (country != ABSENT) {
            person.put("countryOfRegistration", country);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("legalPerson", person);
        if (account != ABSENT) {
            out.put("accountNumber", Arrays.asList(account));
        }
        return out;
    }

    private static Map<String, Object> map(Object... keyValues) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            out.put((String) keyValues[i], keyValues[i + 1]);
        }
        return out;
    }

    /** The Travel Rule message. */
    static Map<String, Object> message(TradeParties parties, String paymentId, String tradeAmount, String tradeCurrency,
            String purposeCode, Map<String, Object> originatingInstitution, Map<String, Object> beneficiaryInstitution,
            Map<String, Object> settlementEntity, String settlementAmount) {
        Map<String, Object> beneficiary = new LinkedHashMap<>(parties.creditor());
        Object bank = beneficiary.remove("bank");

        Map<String, Object> transaction = map("amount", tradeAmount, "currency", tradeCurrency);
        if (purposeCode != null && !purposeCode.isEmpty()) {
            transaction.put("purposeCode", purposeCode);
        }
        Map<String, Object> underlying = new LinkedHashMap<>();
        underlying.put("originator", map("originatorPersons", Arrays.asList(legalPerson(parties.debtor()))));
        underlying.put("beneficiary", map("beneficiaryPersons", Arrays.asList(legalPerson(beneficiary))));
        underlying.put("originatingInstitution", map("institutionId", originatingInstitution.get("id"),
                "name", originatingInstitution.get("name"), "country", originatingInstitution.get("country")));
        if (bank != null) {
            underlying.put("beneficiaryLocalBank", bank);
        }
        underlying.put("transaction", transaction);

        Map<String, Object> leg = new LinkedHashMap<>();
        leg.put("originatingVasp", map("institutionId", settlementEntity.get("id"), "name", settlementEntity.get("name")));
        leg.put("beneficiaryVasp", map("institutionId", beneficiaryInstitution.get("id"),
                "name", beneficiaryInstitution.get("name"), "country", beneficiaryInstitution.get("country")));
        leg.put("transaction", map("amount", settlementAmount, "currency", "USDC"));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", "IVMS101-2023");
        out.put("payment_id", paymentId);
        out.put("underlyingPayment", underlying);
        out.put("settlementLeg", leg);
        return out;
    }

    /** The RFC 7638 thumbprint (SHA-256, base64url) of an EC public JWK. */
    static String jwkThumbprint(Map<String, Object> jwk) {
        // The required members of an EC key, in lexicographic order, without whitespace.
        Map<String, Object> required = new LinkedHashMap<>();
        required.put("crv", jwk.get("crv"));
        required.put("kty", jwk.get("kty"));
        required.put("x", jwk.get("x"));
        required.put("y", jwk.get("y"));
        return Base64Url.encode(Hex.sha256().digest(Text.utf8(Json.compact(required))));
    }

    static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        return parameters.getParameterSpec(ECParameterSpec.class);
    }

    private static byte[] fixed32(BigInteger n) {
        byte[] raw = n.toByteArray();
        byte[] out = new byte[32];
        int from = Math.max(0, raw.length - 32);
        System.arraycopy(raw, from, out, 32 - (raw.length - from), raw.length - from);
        return out;
    }

    private static byte[] lengthPrefixed(byte[] data) {
        return ByteBuffer.allocate(4 + data.length).putInt(data.length).put(data).array();
    }

    /**
     * The Concat KDF of NIST SP 800-56A as RFC 7518 §4.6 profiles it, over
     * SHA-256: the key a JWE's content is encrypted with, derived from the
     * agreed secret rather than transported. For ECDH-ES direct key
     * agreement the algorithm id is the {@code enc} value and both party
     * infos are empty; they are parameters so that the function can be held
     * to the RFC's own test vector.
     *
     * @param sharedSecret the agreed secret, Z
     * @param bits         the length of the key wanted, a multiple of 8
     * @param algorithmId  e.g. {@code "A256GCM"}
     * @param partyU       PartyUInfo ({@code apu}), as text; empty for none
     * @param partyV       PartyVInfo ({@code apv}), as text; empty for none
     */
    public static byte[] concatKdf(byte[] sharedSecret, int bits, String algorithmId, String partyU, String partyV) {
        java.util.Objects.requireNonNull(sharedSecret, "sharedSecret");
        if (bits <= 0 || bits % 8 != 0) {
            throw new IllegalArgumentException("the key length must be a positive multiple of 8 bits, not " + bits);
        }
        java.security.MessageDigest sha = Hex.sha256();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (int counter = 1; out.size() * 8 < bits; counter++) {
            sha.update(ByteBuffer.allocate(4).putInt(counter).array());
            sha.update(sharedSecret);
            sha.update(lengthPrefixed(algorithmId.getBytes(StandardCharsets.UTF_8)));
            sha.update(lengthPrefixed(partyU.getBytes(StandardCharsets.UTF_8)));
            sha.update(lengthPrefixed(partyV.getBytes(StandardCharsets.UTF_8)));
            sha.update(ByteBuffer.allocate(4).putInt(bits).array());
            out.writeBytes(sha.digest());
        }
        return Arrays.copyOf(out.toByteArray(), bits / 8);
    }

    /**
     * Encrypts to an institution's P-256 public JWK, as the reference's
     * {@code encryptJwe}: RFC 7516 compact form
     * {@code header..iv.ciphertext.tag}, the second part empty because the
     * content key is derived, not transported. A fresh key pair is made for
     * each message, used for one agreement and dropped; the protected header
     * is bound as additional data, so a swapped header fails the tag.
     *
     * @param plaintext    what to encrypt — the Travel Rule message as JSON text, in UTF-8
     * @param recipientJwk the recipient's encryption key: an EC public JWK on P-256
     * @param keyId        written into the header as {@code kid}; {@code null} or empty for none
     * @throws RemitException {@code invalid_key} when the recipient key is not an EC P-256 public JWK
     */
    public static String encrypt(byte[] plaintext, Map<String, Object> recipientJwk, String keyId) {
        java.util.Objects.requireNonNull(plaintext, "plaintext");
        java.util.Objects.requireNonNull(recipientJwk, "recipientJwk");
        return encryptToInstitution(plaintext, recipientJwk, keyId == null || keyId.isEmpty() ? null : keyId);
    }

    /**
     * Encrypt to an institution's P-256 public JWK (from the Trust Registry).
     * Returns the compact form {@code header..iv.ciphertext.tag}; the empty
     * second part is what direct key agreement looks like.
     */
    static String encryptToInstitution(byte[] plaintext, Map<String, Object> recipientJwk, String kid) {
        if (!"EC".equals(recipientJwk.get("kty")) || !"P-256".equals(recipientJwk.get("crv"))
                || !(recipientJwk.get("x") instanceof String) || !(recipientJwk.get("y") instanceof String)) {
            throw new RemitException("invalid_key", "the recipient key must be an EC P-256 public JWK");
        }
        byte[] x = Base64Url.decodeOrNull((String) recipientJwk.get("x"));
        byte[] y = Base64Url.decodeOrNull((String) recipientJwk.get("y"));
        if (x == null || y == null || x.length != 32 || y.length != 32) {
            throw new RemitException("invalid_key", "the recipient key must be an EC P-256 public JWK");
        }
        try {
            ECParameterSpec p256 = p256();
            PublicKey recipient = KeyFactory.getInstance("EC")
                    .generatePublic(new ECPublicKeySpec(new ECPoint(new BigInteger(1, x), new BigInteger(1, y)), p256));
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            KeyPair ephemeral = generator.generateKeyPair();
            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(ephemeral.getPrivate());
            agreement.doPhase(recipient, true);
            byte[] cek = concatKdf(agreement.generateSecret(), 256, "A256GCM", "", "");

            ECPoint w = ((ECPublicKey) ephemeral.getPublic()).getW();
            Map<String, Object> epk = new LinkedHashMap<>();
            epk.put("kty", "EC");
            epk.put("crv", "P-256");
            epk.put("x", Base64Url.encode(fixed32(w.getAffineX())));
            epk.put("y", Base64Url.encode(fixed32(w.getAffineY())));
            Map<String, Object> header = new LinkedHashMap<>();
            header.put("alg", "ECDH-ES");
            header.put("enc", "A256GCM");
            header.put("epk", epk);
            if (kid != null) {
                header.put("kid", kid);
            }
            String protectedHeader = Base64Url.encode(Text.utf8(Json.compact(header)));

            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, iv));
            cipher.updateAAD(protectedHeader.getBytes(StandardCharsets.US_ASCII));
            byte[] sealed = cipher.doFinal(plaintext);
            byte[] ciphertext = Arrays.copyOfRange(sealed, 0, sealed.length - 16);
            byte[] tag = Arrays.copyOfRange(sealed, sealed.length - 16, sealed.length);
            return protectedHeader + ".." + Base64Url.encode(iv) + "." + Base64Url.encode(ciphertext) + "." + Base64Url.encode(tag);
        } catch (GeneralSecurityException e) {
            throw new RemitException("encryption_failed", "the Travel Rule message could not be encrypted: " + e.getMessage(), e);
        }
    }

    /** A JWK that the registry may publish as an object or as JSON text. */
    static Map<String, Object> jwkOf(Object published) {
        Object value = published instanceof String ? Json.parse((String) published, "not_a_platform_answer") : published;
        return Json.object(value, "not_a_platform_answer", "an institution's encryption key");
    }

    static List<Object> list(Object... items) {
        return new ArrayList<>(Arrays.asList(items));
    }
}
