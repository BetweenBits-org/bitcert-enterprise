package com.stonehash.attest.core.sandbox;

import com.stonehash.attest.core.json.Js;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The sandbox's starting data: one synthetic settlement, the policy it is
 * evaluated under unless the caller sends another, the six scenarios and the
 * catalogue of ways to damage the evidence on purpose.
 *
 * <p>Data, not code, and kept as such ({@code sandbox/material.json} on the
 * classpath; nothing is read from disk at run time). The evidence is
 * synthetic and says so in its own fields: no payment, no institution. Its
 * signatures were made once with the demonstration issuers' keys and are
 * part of the document — this service holds no private key and signs
 * nothing here.
 *
 * <p>Nothing in it is ever changed: every scenario and every tamper works on
 * a copy.
 */
public final class SandboxMaterial {
    /** Scenario A before any transform; every other scenario derives from it. */
    public final Map<String, Object> settlement;
    public final Map<String, Object> policy;
    /** {@code id, title, teaches}, in the order shown. */
    public final List<Object> scenarios;
    /** {@code id, label, asks, needs}: what each tamper is for, and what it has to be told. */
    public final List<Object> tampers;

    private final Set<String> scenarioIds = new LinkedHashSet<>();
    private final Set<String> tamperIds = new LinkedHashSet<>();

    @SuppressWarnings("unchecked")
    private SandboxMaterial(Map<String, Object> file) {
        settlement = (Map<String, Object>) file.get("settlement");
        policy = (Map<String, Object>) file.get("policy");
        scenarios = (List<Object>) file.get("scenarios");
        tampers = (List<Object>) file.get("tampers");
        for (Object s : scenarios) {
            scenarioIds.add((String) ((Map<String, Object>) s).get("id"));
        }
        for (Object t : tampers) {
            tamperIds.add((String) ((Map<String, Object>) t).get("id"));
        }
    }

    @SuppressWarnings("unchecked")
    public static SandboxMaterial load() {
        try (InputStream in = SandboxMaterial.class.getResourceAsStream("/sandbox/material.json")) {
            if (in == null) {
                throw new IllegalStateException("sandbox/material.json is not on the classpath");
            }
            return new SandboxMaterial((Map<String, Object>) Js.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public boolean hasScenario(String id) {
        return scenarioIds.contains(id);
    }

    public boolean hasTamper(String id) {
        return tamperIds.contains(id);
    }

    /**
     * One scenario's evidence, derived from the sample by the same
     * transforms a reviewer drives from the screen — so the difference
     * between two scenarios is exactly the one being shown, and nothing an
     * author happened to type.
     */
    public Object scenario(String id) {
        switch (id) {
            case "A":
                return settlement;
            case "B":
                return Tamper.changeAmount(settlement, "chainTransfer", "48000.00");
            case "C":
                return Tamper.breakSignature(settlement, "payoutReceipt");
            case "D":
                return Tamper.removeDocument(settlement, "invoice");
            case "E":
                return Tamper.splitPayout(settlement, "20000.00", "30000.00");
            case "F":
                return Tamper.duplicateReceipt(settlement);
            default:
                throw new IllegalArgumentException("unknown scenario: " + id);
        }
    }
}
