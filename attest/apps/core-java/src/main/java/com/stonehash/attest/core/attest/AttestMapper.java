package com.stonehash.attest.core.attest;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** Organisations, attestations, issuer keys and what a bundle is assembled from. The SQL is in {@code mapper/AttestMapper.xml}. */
@Mapper
public interface AttestMapper {
    String orgIdBySlug(String slug);

    int insertOrg(String id, String slug, String name, String createdAt);

    /** One organisation's record, every column a record has (the insertion counter is not one). */
    Map<String, Object> attestation(String id, String orgId);

    /** A free-tier record by id alone: the id is the capability, and only free-tier records are reachable this way. */
    Map<String, Object> publicAttestation(String id);

    Map<String, Object> publicAttestationByDigest(String leafBytes);

    String attestationIdByDigest(String orgId, String leafBytes);

    int insertAttestation(String id, String orgId, String leafBytes, String contentType, String descriptor, String createdAt,
            String source, String expiresAt, String statement, String issuerTrust, String product);

    int insertInscription(String id, String orgId, String leafBytes, String contentType, String descriptor, String createdAt,
            String source, String commitTxid, String revealTxid, String revealTxHex, long bodyLength, String protocolTag);

    /** The organisation's newest records, each with its batch's anchoring transaction as {@code anchor_txid}. */
    List<Map<String, Object>> attestations(String orgId, String product, long limit);

    String activeIssuerKeyId(String orgId, String publicKey);

    /** The key material of one of the organisation's keys, unless it was revoked. */
    String activeIssuerKeyMaterial(String id, String orgId);

    int revokeIssuerKey(String at, String id, String orgId);

    int withdrawInstitutionKey(String orgId, String publicKey);

    int insertIssuerKey(String id, String orgId, String label, String publicKey, String algorithm, String createdAt);

    /** {@code id, label, algorithm, public_key, created_at} of the keys not revoked, newest first. */
    List<Map<String, Object>> issuerKeys(String orgId);

    /** {@code leaf_index, siblings, directions}. */
    Map<String, Object> proof(String attestationId);

    /** {@code merkle_root} of a batch; a row even when the root is not there yet. */
    Map<String, Object> batch(String batchId);

    /** {@code txid, raw_tx_hex, payload_hex, status, block_height, block_hash, confirmations}. */
    Map<String, Object> anchor(String batchId);
}
