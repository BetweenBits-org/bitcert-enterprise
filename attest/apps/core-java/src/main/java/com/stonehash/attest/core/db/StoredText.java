package com.stonehash.attest.core.db;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedTypes;
import org.springframework.stereotype.Component;

/**
 * Text on its way into the store — every piece of it, for every mapper.
 *
 * <p>Text in this service is a sequence of UTF-16 units, and a client can
 * send half of a surrogate pair on its own (in JSON, {@code "\ud83d"}).
 * That is not a character and has no UTF-8 form. The service this one
 * replaces handed such text to a driver that wrote U+FFFD in its place; the
 * driver here writes a question mark. A label, a name or an address is then
 * stored as something else than it always was — and a lookup by it finds
 * something else.
 *
 * <p>So the half is replaced here, by U+FFFD, before the driver sees it:
 * once, for every text any statement binds — what is stored, and what is
 * searched for. Reading is untouched.
 */
@Component
@MappedTypes(String.class)
public class StoredText extends BaseTypeHandler<String> {

    /** Text with every half of a surrogate pair that stands alone replaced by U+FFFD; other text is returned as it is. */
    public static String wellFormed(String text) {
        StringBuilder out = null;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean paired = Character.isHighSurrogate(c) ? i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))
                    : !Character.isLowSurrogate(c) || (i > 0 && Character.isHighSurrogate(text.charAt(i - 1)));
            if (!paired) {
                if (out == null) {
                    out = new StringBuilder(text);
                }
                out.setCharAt(i, '�');
            }
        }
        return out == null ? text : out.toString();
    }

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, String parameter, JdbcType jdbcType) throws SQLException {
        ps.setString(i, wellFormed(parameter));
    }

    @Override
    public String getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return rs.getString(columnName);
    }

    @Override
    public String getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return rs.getString(columnIndex);
    }

    @Override
    public String getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return cs.getString(columnIndex);
    }
}
