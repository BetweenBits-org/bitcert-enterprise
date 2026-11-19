package com.stonehash.attest.por;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * What the platform answered when a statement was handed over, as the
 * exchange keeps it beside the snapshot ({@code receipt.json}).
 */
public final class Receipt {
    public static final String SCHEMA = "stonehash.por-receipt.v1";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(ZoneOffset.UTC);

    private final SubmitResult result;
    private final String commitment;
    private final String root;
    private final String platform;
    private final String publicUrl;
    private final String receivedAt;
    private final boolean anchorConfirmed;

    private Receipt(SubmitResult result, String commitment, String root, String platform, String publicUrl,
            String receivedAt, boolean anchorConfirmed) {
        this.result = result;
        this.commitment = commitment;
        this.root = root;
        this.platform = platform;
        this.publicUrl = publicUrl;
        this.receivedAt = receivedAt;
        this.anchorConfirmed = anchorConfirmed;
    }

    /**
     * @param statement  the statement that was submitted
     * @param client     the client it was submitted through
     * @param receivedAt when the platform's answer arrived
     */
    public static Receipt of(SubmitResult result, Statement statement, PorClient client, Instant receivedAt) {
        Objects.requireNonNull(result, "result");
        return new Receipt(result, statement.commitment(), statement.root(), client.baseUrl(),
                client.publicUrl(result.snapshotId()), TIME.format(Objects.requireNonNull(receivedAt, "receivedAt")), false);
    }

    /** The same receipt, recording that the anchor has since been confirmed. */
    public Receipt anchorConfirmed() {
        return new Receipt(result, commitment, root, platform, publicUrl, receivedAt, true);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", SCHEMA);
        out.put("snapshot_id", result.snapshotId());
        out.put("status", result.status());
        out.put("spot_check", result.spotCheck());
        out.put("sampled_accounts", (long) result.sampledAccounts());
        out.put("attestation_id", result.attestationId());
        out.put("commitment", commitment);
        out.put("root", root);
        out.put("platform", platform);
        out.put("public_url", publicUrl);
        out.put("received_at", receivedAt);
        out.put("anchor", anchorConfirmed ? "confirmed" : "pending");
        return out;
    }

    /** The receipt as indented JSON text. */
    public String toJson() {
        return Json.pretty(toMap());
    }
}
