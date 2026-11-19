package com.stonehash.attest.core.audit;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** The audit trail's rows. The SQL is in {@code mapper/AuditMapper.xml}. */
@Mapper
public interface AuditMapper {
    int insert(String id, String orgId, String at, String actorType, String actorId, String actorLabel,
            String service, String method, String path, int status, long durationMs);

    /**
     * One organisation's rows, newest first: {@code id, at, actor_type, actor_id, actor_label, service, method, path, status, duration_ms}.
     * A filter that is {@code null} is not applied; {@code cursorAt} and {@code cursorId} go together.
     */
    List<Map<String, Object>> search(String orgId, String service, String actorType, String from, String to, String like,
            String cursorAt, String cursorId, long limit);
}
