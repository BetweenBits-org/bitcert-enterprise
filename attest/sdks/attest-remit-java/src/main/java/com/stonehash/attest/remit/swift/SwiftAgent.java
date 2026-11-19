package com.stonehash.attest.remit.swift;

import java.util.LinkedHashMap;
import java.util.Map;

/** A bank named in the message: the debtor's or the creditor's agent, or an intermediary. */
public final class SwiftAgent {
    String bic;
    String lei;
    String name;
    String memberId;
    String clearingSystem;
    String country;

    SwiftAgent() {
    }

    public String bic() {
        return bic;
    }

    public String lei() {
        return lei;
    }

    public String name() {
        return name;
    }

    /**
     * Clearing-system member id, when the agent is identified that way — or,
     * for an agent the message identifies only under another scheme, that id
     * ({@code FinInstnId/Othr/Id}).
     */
    public String memberId() {
        return memberId;
    }

    /**
     * Which clearing system ({@code USABA}, {@code SGIBG} …) or other scheme
     * ({@code Othr/SchmeNm}) that id belongs to, when stated.
     */
    public String clearingSystem() {
        return clearingSystem;
    }

    public String country() {
        return country;
    }

    /** The agent as the TypeScript SDK's JSON has it: a field that was not stated is absent. */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonOut.put(out, "bic", bic);
        JsonOut.put(out, "lei", lei);
        JsonOut.put(out, "name", name);
        JsonOut.put(out, "memberId", memberId);
        JsonOut.put(out, "clearingSystem", clearingSystem);
        JsonOut.put(out, "country", country);
        return out;
    }

    static SwiftAgent fromJson(Object json) {
        if (json == null) {
            return null;
        }
        Map<?, ?> m = (Map<?, ?>) json;
        SwiftAgent a = new SwiftAgent();
        a.bic = (String) m.get("bic");
        a.lei = (String) m.get("lei");
        a.name = (String) m.get("name");
        a.memberId = (String) m.get("memberId");
        a.clearingSystem = (String) m.get("clearingSystem");
        a.country = (String) m.get("country");
        return a;
    }
}
