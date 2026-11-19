package com.stonehash.attest.core.auth;

import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** Keys, sessions and the accounts behind them. The SQL is in {@code mapper/AuthMapper.xml}. */
@Mapper
public interface AuthMapper {
    /** {@code id, org_id, key_hash, label} of the key with this hash, unless it was revoked. */
    Map<String, Object> apiKeyByHash(String hash);

    int insertApiKey(String id, String orgId, String keyHash, String prefix, String label, String createdAt);

    /** {@code account_id, expires_at}. */
    Map<String, Object> sessionByHash(String tokenHash);

    int deleteSession(String tokenHash);

    /** {@code id, email, org_id, created_at, last_login_at, disabled_at}. */
    Map<String, Object> accountById(String id);

    /** The whole row, the stored password with it: {@code id, email, password_hash, org_id, created_at, last_login_at, disabled_at}. */
    Map<String, Object> accountByEmail(String email);

    int insertAccount(String id, String email, String passwordHash, String orgId, String createdAt);

    int recordLogin(String id, String at);

    int insertSession(String tokenHash, String accountId, String createdAt, String expiresAt, String userAgent);

    /** Every session of the account but the one with this hash. */
    int deleteOtherSessions(String accountId, String keepTokenHash);
}
