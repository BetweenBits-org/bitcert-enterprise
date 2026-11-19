package com.stonehash.attest.remit.swift;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A party of the payment — the ordering customer or the beneficiary — as the
 * message states it. What the message does not state is null: nothing is
 * inferred here.
 */
public final class SwiftParty {
    String name;
    String country;
    final List<String> addressLines = new ArrayList<>();
    String lei;
    String bic;
    String identification;
    String identificationScheme;
    String identificationFrom;
    String countryFrom;
    Boolean person;
    String account;

    SwiftParty() {
    }

    public String name() {
        return name;
    }

    /** ISO 3166-1 alpha-2, when the message states one. */
    public String country() {
        return country;
    }

    /** The address as carried, one entry per line. */
    public List<String> addressLines() {
        return Collections.unmodifiableList(addressLines);
    }

    /** Legal Entity Identifier (ISO 17442). */
    public String lei() {
        return lei;
    }

    public String bic() {
        return bic;
    }

    /** Another identification: {@code Othr/Id}, or an MT option-F party identifier. */
    public String identification() {
        return identification;
    }

    /** What that identification is, as the message labels it ({@code TXID}, {@code CUST} …). */
    public String identificationScheme() {
        return identificationScheme;
    }

    /** Where in the message the identification stands, in the message's own words. */
    public String identificationFrom() {
        return identificationFrom;
    }

    /** Where the country was stated, when it was not the postal address. */
    public String countryFrom() {
        return countryFrom;
    }

    /** True when the message identifies this party as a private person. */
    public boolean person() {
        return Boolean.TRUE.equals(person);
    }

    /** IBAN or other account identification. */
    public String account() {
        return account;
    }

    /** The party as the TypeScript SDK's JSON has it: a field that was not stated is absent. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonOut.put(out, "name", name);
        JsonOut.put(out, "country", country);
        out.put("addressLines", new ArrayList<Object>(addressLines));
        JsonOut.put(out, "lei", lei);
        JsonOut.put(out, "bic", bic);
        JsonOut.put(out, "identification", identification);
        JsonOut.put(out, "identificationScheme", identificationScheme);
        JsonOut.put(out, "identificationFrom", identificationFrom);
        JsonOut.put(out, "countryFrom", countryFrom);
        JsonOut.put(out, "person", person);
        JsonOut.put(out, "account", account);
        return out;
    }

    static SwiftParty fromJson(Object json) {
        Map<?, ?> m = (Map<?, ?>) json;
        SwiftParty p = new SwiftParty();
        p.name = (String) m.get("name");
        p.country = (String) m.get("country");
        p.addressLines.addAll(JsonOut.strings(m.get("addressLines")));
        p.lei = (String) m.get("lei");
        p.bic = (String) m.get("bic");
        p.identification = (String) m.get("identification");
        p.identificationScheme = (String) m.get("identificationScheme");
        p.identificationFrom = (String) m.get("identificationFrom");
        p.countryFrom = (String) m.get("countryFrom");
        p.person = (Boolean) m.get("person");
        p.account = (String) m.get("account");
        return p;
    }
}
