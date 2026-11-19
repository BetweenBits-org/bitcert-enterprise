package com.stonehash.attest.core.db;

import com.stonehash.attest.core.log.Log;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;

/**
 * The migration step: brings a schema to the version this build expects, and
 * ends. It is the only code that changes the schema.
 *
 * <p>{@code migrate} applies what is not applied yet — on an empty schema
 * that is everything, starting with the baseline. {@code baseline} is for a
 * schema that already has the tables of version 1 because the previous
 * service created them: it records that fact and creates nothing. It is run
 * once, at the approved switch.
 */
public final class Migrator {
    private Migrator() {
    }

    private static Flyway flyway(HikariDataSource pool, DbUrl db) {
        return Flyway.configure()
                .dataSource(pool)
                .locations("classpath:db/migration/mysql")
                .defaultSchema(db.database)
                .createSchemas(false)
                .baselineVersion("1")
                .baselineDescription("the schema as the previous service left it")
                .baselineOnMigrate(false)
                .validateOnMigrate(true)
                .cleanDisabled(true)
                .load();
    }

    public static void migrate(DbUrl db) {
        try (HikariDataSource pool = DbConfig.pool(db, "migrate", 2)) {
            MigrateResult result = flyway(pool, db).migrate();
            Log.line("schema migrated", Log.fields("database", db.database, "applied", (long) result.migrationsExecuted,
                    "version", result.targetSchemaVersion == null ? result.initialSchemaVersion : result.targetSchemaVersion));
        }
    }

    public static void baseline(DbUrl db) {
        try (HikariDataSource pool = DbConfig.pool(db, "migrate", 2)) {
            flyway(pool, db).baseline();
            Log.line("schema registered at its baseline", Log.fields("database", db.database, "version", "1"));
        }
    }
}
