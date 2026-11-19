package com.stonehash.attest.core.db;

import com.stonehash.attest.core.config.ConfigError;
import com.stonehash.attest.core.http.Router;

/**
 * {@code STONEHASH_DB_URL} — {@code mysql://user:password@host:port/database},
 * the form the service has always been configured with — taken apart for the
 * JDBC driver. User and password are percent-decoded, as before. A value that
 * cannot be read is refused in words that never repeat it: it holds a password.
 */
public final class DbUrl {
    public final String host;
    public final int port;
    public final String user;
    public final String password;
    public final String database;

    private DbUrl(String host, int port, String user, String password, String database) {
        this.host = host;
        this.port = port;
        this.user = user;
        this.password = password;
        this.database = database;
    }

    public static DbUrl parse(String url) {
        if (url == null || url.isEmpty()) {
            throw new ConfigError("STONEHASH_DB_URL is required: mysql://user:password@host:port/database "
                    + "(this service has no file database to fall back to)");
        }
        ConfigError unreadable = new ConfigError("STONEHASH_DB_URL must be mysql://user:password@host:port/database; the value set does not read as one");
        if (!url.startsWith("mysql://")) {
            throw unreadable;
        }
        String rest = url.substring("mysql://".length());
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            if ("/?#".indexOf(rest.charAt(i)) >= 0) {
                end = i;
                break;
            }
        }
        String authority = rest.substring(0, end);
        String path = rest.substring(end);
        int cut = path.length();
        for (int i = 0; i < path.length(); i++) {
            if ("?#".indexOf(path.charAt(i)) >= 0) {
                cut = i;
                break;
            }
        }
        String database = path.substring(0, cut).replaceFirst("^/", "");
        String user = "";
        String password = "";
        int at = authority.lastIndexOf('@');
        if (at >= 0) {
            String userinfo = authority.substring(0, at);
            int colon = userinfo.indexOf(':');
            user = Router.decodeUriComponent(colon < 0 ? userinfo : userinfo.substring(0, colon));
            password = Router.decodeUriComponent(colon < 0 ? "" : userinfo.substring(colon + 1));
            authority = authority.substring(at + 1);
        }
        if (user == null || password == null) {
            throw unreadable;
        }
        String host = authority;
        int port = 3306;
        int colon = authority.lastIndexOf(':');
        if (colon > authority.lastIndexOf(']')) {
            host = authority.substring(0, colon);
            String digits = authority.substring(colon + 1);
            if (!digits.isEmpty()) {
                if (digits.length() > 5 || !digits.chars().allMatch((c) -> c >= '0' && c <= '9') || Integer.parseInt(digits) > 65535) {
                    throw unreadable;
                }
                port = Integer.parseInt(digits);
            }
        }
        if (host.isEmpty()) {
            throw unreadable;
        }
        if (database.isEmpty()) {
            throw new ConfigError("STONEHASH_DB_URL must name a database, e.g. mysql://user:pass@host:3306/stonehash_attest");
        }
        return new DbUrl(host, port, user, password, database);
    }

    /** The JDBC address: host, port and database only. Credentials and settings are handed to the driver separately. */
    public String jdbcUrl() {
        return "jdbc:mysql://" + host + ":" + port + "/" + database;
    }
}
