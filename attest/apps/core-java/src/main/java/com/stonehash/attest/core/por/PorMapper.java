package com.stonehash.attest.core.por;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** Reserve snapshots in the store. The SQL is in {@code mapper/PorMapper.xml}. */
@Mapper
public interface PorMapper {
    /** Every column of one snapshot, or {@code null}. */
    Map<String, Object> snapshot(String id);

    /** The organisation's oldest root-only snapshot of this statement, or {@code null}. */
    Map<String, Object> acceptedSnapshot(String orgId, String commitment);

    /** The organisation's snapshots, newest first, a hundred at most. */
    List<Map<String, Object>> snapshotsOfOrg(String orgId);

    /** {@code id, status} of a record, whoever it belongs to, or {@code null}. */
    Map<String, Object> attestationBrief(String id);

    int insertSnapshot(String id, String orgId, String institutionId, String status, String statement, String sig, String commitment, String root,
            String asof, long leafCount, String totals, String challenge, String reserves, String attestationId, String signingSpki, String at);

    /** Only a snapshot still waiting for its openings: the number of rows changed says whether this request was the one that settled it. */
    int rejectSnapshot(String id, String problems, String at);

    /** As {@link #rejectSnapshot}. */
    int verifySnapshot(String id, String attestationId, String reserves, String at);

    /** Taken first inside a submission's transaction, so that two submissions of one organisation store one after the other. */
    String lockOrg(String orgId);

    /** {@code id, institution_id, statement, sig} of the snapshots stored before each kept its own key. */
    List<Map<String, Object>> snapshotsWithoutKey();

    int setSnapshotKey(String id, String spki);
}
