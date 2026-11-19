package com.stonehash.attest.core.db;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The connection pool, and what every connection of it is told.
 *
 * <p>Nothing here is left to a server's defaults, because the rows already in
 * the store were written under particular ones and a bank's server will have
 * others:
 * <ul>
 * <li><b>utf8mb4_bin</b> for the connection, as for every table: comparison
 *     is by byte, so a key, an idempotency key or a hex digest that differs
 *     only in case is a different one;
 * <li><b>READ COMMITTED</b>: a transaction sees what was committed before
 *     each statement. What has to hold between statements is held by a lock
 *     taken explicitly, first thing in the transaction, and not by the
 *     isolation level;
 * <li><b>strict SQL mode</b>, set by name: a value that does not fit a column
 *     is an error, not a truncation;
 * <li><b>matched rows</b> as the count an UPDATE reports (the driver's
 *     default, and what the previous service's driver reported): a
 *     conditional update that matched its row and changed nothing still
 *     counts one.
 * </ul>
 */
@Configuration
public class DbConfig {
    /** The SQL mode every connection runs under: MySQL 8's strict default, named so that it does not depend on the server's. */
    static final String SQL_MODE = "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

    public static HikariDataSource pool(DbUrl db, String poolName, int size) {
        HikariConfig c = new HikariConfig();
        c.setPoolName(poolName);
        c.setJdbcUrl(db.jdbcUrl());
        c.setUsername(db.user);
        c.setPassword(db.password);
        c.setMaximumPoolSize(size);
        c.setMinimumIdle(Math.min(2, size));
        c.setTransactionIsolation("TRANSACTION_READ_COMMITTED");
        c.setConnectionInitSql("SET SESSION sql_mode = '" + SQL_MODE + "'");
        c.addDataSourceProperty("characterEncoding", "UTF-8");
        c.addDataSourceProperty("connectionCollation", "utf8mb4_bin");
        c.addDataSourceProperty("useAffectedRows", "false");
        c.addDataSourceProperty("tinyInt1isBit", "false");
        c.addDataSourceProperty("connectionTimeZone", "UTC");
        c.addDataSourceProperty("forceConnectionTimeZoneToSession", "false");
        c.addDataSourceProperty("sslMode", "PREFERRED");
        c.addDataSourceProperty("allowPublicKeyRetrieval", "true");
        return new HikariDataSource(c);
    }

    @Bean(destroyMethod = "close")
    public DataSource dataSource(DbUrl db) {
        // Ten connections, as the pool this replaces had.
        return pool(db, "core", 10);
    }
}
