package com.stonehash.attest.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.stonehash.attest.core.db.StoredText;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.PreparedStatement;
import java.util.ArrayList;
import java.util.List;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.TypeHandler;
import org.junit.jupiter.api.Test;

/**
 * Text reaches the store well-formed: half of a surrogate pair standing
 * alone goes in as U+FFFD, which is what the previous service's driver wrote
 * for it — and not as the question mark this driver would write.
 */
class StoredTextTest {

    @Test
    void halfACharacterBecomesTheReplacementCharacter() {
        String[][] cases = {
                { "", "" }, { "plain", "plain" }, { "한국어 😀 é", "한국어 😀 é" },
                { "\ud83d", "�" }, { "\ude00", "�" }, { "a\ud83db", "a�b" }, { "a\ude00b", "a�b" },
                { "\ude00\ud83d", "��" }, { "\ud83d😀", "�😀" }, { "😀\ude00", "😀�" },
                { "x\ud83d", "x�" }, { "\ude00x", "�x" }, { "�", "�" }, };
        for (String[] c : cases) {
            assertEquals(Vectors.show(c[1]), Vectors.show(StoredText.wellFormed(c[0])), Vectors.show(c[0]));
        }
        // Text with nothing to replace is handed on as it is, not copied.
        String whole = "nothing to replace 😀";
        assertSame(whole, StoredText.wellFormed(whole));
        // And what the replacement is for: the bytes the store receives are the ones it always received.
        assertEquals("61efbfbd62", hex(StoredText.wellFormed("a\ud83db").getBytes(StandardCharsets.UTF_8)));
        assertEquals("613f62", hex("a\ud83db".getBytes(StandardCharsets.UTF_8)), "what the driver would have written on its own");
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) {
            out.append(String.format("%02x", b));
        }
        return out.toString();
    }

    /** Every statement binds its text through this handler: it is the one MyBatis picks for a text parameter. */
    @Test
    void everyTextParameterOfEveryMapperGoesThroughIt() throws Exception {
        Configuration configuration = new Configuration();
        // As the framework registers a handler it finds among the beans.
        configuration.getTypeHandlerRegistry().register(new StoredText());
        TypeHandler<String> picked = configuration.getTypeHandlerRegistry().getTypeHandler(String.class);
        assertEquals(StoredText.class, picked.getClass(), "the handler for a text parameter that names no JDBC type");
        assertEquals(StoredText.class, configuration.getTypeHandlerRegistry().getTypeHandler(String.class, (JdbcType) null).getClass());

        List<Object> bound = new ArrayList<>();
        PreparedStatement statement = (PreparedStatement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] { PreparedStatement.class }, (proxy, method, args) -> {
            if (method.getName().equals("setString")) {
                bound.add(args[1]);
            } else if (method.getName().equals("setNull")) {
                bound.add(null);
            }
            return null;
        });
        picked.setParameter(statement, 1, "label \ud83d", null);
        picked.setParameter(statement, 2, "whole 😀", null);
        picked.setParameter(statement, 3, null, JdbcType.VARCHAR);
        assertEquals(3, bound.size());
        assertEquals(Vectors.show("label �"), Vectors.show((String) bound.get(0)));
        assertEquals("whole 😀", bound.get(1));
        assertEquals(null, bound.get(2));
    }
}
