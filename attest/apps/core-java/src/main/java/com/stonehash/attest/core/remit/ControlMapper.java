package com.stonehash.attest.core.remit;

import org.apache.ibatis.annotations.Mapper;

/**
 * What the operator's commands write to {@code remit_jobs} beyond what the
 * rail's own mapper has. The SQL is in {@code mapper/ControlMapper.xml}.
 */
@Mapper
public interface ControlMapper {
    /**
     * A job a person has looked at is closed for good: {@code attention}
     * becomes {@code done}, and what the person noted is kept in front of
     * the error the job stopped with. Only a job that is in
     * {@code attention} — the count says whether it was.
     */
    int closeAttentionJob(String id, String memo);
}
