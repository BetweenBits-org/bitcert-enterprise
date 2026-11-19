package com.stonehash.attest.core.audit;

import com.stonehash.attest.core.ServiceError;
import com.stonehash.attest.core.format.IsoDate;
import com.stonehash.attest.core.format.PublicKeys;
import com.stonehash.attest.core.json.Js;
import com.stonehash.attest.core.time.IsoTime;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * Reading the audit trail: one organisation's rows, newest first, narrowed by
 * service, by kind of actor, by time and by a piece of the path, a page at a
 * time.
 *
 * <p>A page ends with a cursor — the time and id of its last row, as the
 * base64url of {@code {"c":time,"i":id}} — and the next page is what sorts
 * after that row. The cursor is the same text the service before this one
 * issued, so a client that holds one keeps paging across the change.
 */
@Component
public class AuditSearch {
    public static final List<String> SERVICES = List.of("attest", "remit", "por", "console");
    public static final List<String> ACTOR_TYPES = List.of("api_key", "session");

    private final AuditMapper mapper;

    public AuditSearch(AuditMapper mapper) {
        this.mapper = mapper;
    }

    /** What to look for. A field left {@code null} does not narrow; an empty {@code q} or {@code cursor} is none. */
    public static final class Filter {
        public String service;
        public String actorType;
        public String from;
        public String to;
        public String q;
        public String cursor;
        /** The page size asked for; NaN or an infinity is the default. */
        public double limit = Double.NaN;
    }

    public static final class Page {
        public final List<Map<String, Object>> items;
        /** Where the next page starts, or {@code null} when this is the last one. */
        public final String nextCursor;

        Page(List<Map<String, Object>> items, String nextCursor) {
            this.items = items;
            this.nextCursor = nextCursor;
        }
    }

    public Page search(String orgId, Filter f) {
        int limit = pageSize(f.limit);
        String service = f.service == null ? null : oneOf("service", f.service, SERVICES);
        String actorType = f.actorType == null ? null : oneOf("actor_type", f.actorType, ACTOR_TYPES);
        String from = f.from == null ? null : instant("from", f.from);
        String to = f.to == null ? null : instant("to", f.to);
        String like = f.q == null || f.q.isEmpty() ? null : likeContains(f.q);
        String[] cursor = f.cursor == null || f.cursor.isEmpty() ? null : decodeCursor(f.cursor);
        List<Map<String, Object>> rows = mapper.search(orgId, service, actorType, from, to, like,
                cursor == null ? null : cursor[0], cursor == null ? null : cursor[1], limit + 1L);
        List<Map<String, Object>> items = new ArrayList<>(rows.subList(0, Math.min(limit, rows.size())));
        Map<String, Object> last = items.isEmpty() ? null : items.get(items.size() - 1);
        return new Page(items, rows.size() > limit && last != null ? encodeCursor((String) last.get("at"), (String) last.get("id")) : null);
    }

    /** From 1 to 200 rows; 50 where none was asked for. The size is cut to a whole number, never trusted. */
    static int pageSize(double raw) {
        double n = Double.isNaN(raw) || Double.isInfinite(raw) ? 50 : Math.floor(raw);
        return (int) Math.max(1, Math.min(n, 200));
    }

    private static String oneOf(String name, String raw, List<String> allowed) {
        if (!allowed.contains(raw)) {
            throw new ServiceError(400, "invalid_filter", name + " must be one of " + String.join(", ", allowed));
        }
        return raw;
    }

    /**
     * A bound of the time range, as the text the column is compared with.
     * An offset is taken out first: the column holds UTC, and it is compared
     * as text.
     */
    static String instant(String name, String raw) {
        Long ms = IsoDate.epochMilli(raw);
        if (ms == null) {
            throw new ServiceError(400, "invalid_filter", name + " must be an ISO 8601 instant, got " + Js.stringify(raw));
        }
        return IsoTime.ofEpochMilli(ms);
    }

    /** A piece of a path as a LIKE pattern: upper case (the column is compared in upper case), and its wildcards taken literally. */
    public static String likeContains(String needle) {
        return "%" + needle.toUpperCase(Locale.ROOT).replaceAll("[%_!]", "!$0") + "%";
    }

    public static String encodeCursor(String at, String id) {
        Map<String, Object> cursor = new LinkedHashMap<>();
        cursor.put("c", at);
        cursor.put("i", id);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(Js.stringify(cursor).getBytes(StandardCharsets.UTF_8));
    }

    /** {@code [time, id]} of the row a cursor names. Anything that is not a cursor this API issued is refused as such. */
    public static String[] decodeCursor(String cursor) {
        Object v;
        try {
            v = Js.parse(new String(PublicKeys.base64(cursor), StandardCharsets.UTF_8));
        } catch (Js.SyntaxException e) {
            v = null;
        }
        if (v instanceof Map && ((Map<?, ?>) v).get("c") instanceof String && ((Map<?, ?>) v).get("i") instanceof String) {
            return new String[] { (String) ((Map<?, ?>) v).get("c"), (String) ((Map<?, ?>) v).get("i") };
        }
        throw new ServiceError(400, "invalid_cursor", "the cursor is not one this API issued");
    }
}
