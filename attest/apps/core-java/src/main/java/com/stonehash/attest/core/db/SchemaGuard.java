package com.stonehash.attest.core.db;

import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.log.Log;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Component;

/**
 * Checked once, before the service answers anything: the connection is what
 * {@link DbConfig} asked for, and the schema is at the version this build was
 * written for.
 *
 * <p>The service never changes the schema as it starts. Migrations are a step
 * of their own ({@code migrate}), run once and on purpose — at a bank by the
 * DBA, from the same scripts — and a service that finds another schema than
 * the one it expects says so and stops, rather than reading rows it may
 * misunderstand.
 */
@Component
public class SchemaGuard implements InitializingBean {
    /** The newest migration in {@code db/migration}. Raised in the same change that adds one. */
    public static final String EXPECTED_VERSION = "3";

    private final SchemaMapper mapper;
    private final DbUrl db;

    public SchemaGuard(SchemaMapper mapper, DbUrl db) {
        this.mapper = mapper;
        this.db = db;
    }

    @Override
    public void afterPropertiesSet() {
        Map<String, Object> session = mapper.session();
        if (!"READ-COMMITTED".equals(session.get("isolation"))) {
            throw new ConfigError("the database connection runs at " + session.get("isolation") + ", not READ-COMMITTED");
        }
        if (!"utf8mb4_bin".equals(session.get("collation"))) {
            throw new ConfigError("the database connection compares text as " + session.get("collation") + ", not utf8mb4_bin");
        }
        if (mapper.historyTableCount() == 0) {
            throw new ConfigError("schema " + db.database + " has no migration history: run the migrate step first");
        }
        List<Map<String, Object>> history = mapper.history();
        String version = null;
        for (Map<String, Object> row : history) {
            if (!isTrue(row.get("success"))) {
                throw new ConfigError("schema " + db.database + ": migration " + row.get("version") + " did not complete");
            }
            version = String.valueOf(row.get("version"));
        }
        if (!EXPECTED_VERSION.equals(version)) {
            throw new ConfigError("schema " + db.database + " is at version " + version + "; this build expects " + EXPECTED_VERSION
                    + " — run the migrate step of this build");
        }
        Log.line("storage ready", Log.fields("engine", "mysql", "database", db.database, "schema_version", version));
    }

    private static boolean isTrue(Object v) {
        return v instanceof Boolean ? (Boolean) v : v instanceof Number && ((Number) v).intValue() != 0;
    }
}
