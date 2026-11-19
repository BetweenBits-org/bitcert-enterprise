package com.stonehash.attest.core.db;

import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Mapper;

/** What the service asks the database about itself at start. The SQL is in {@code mapper/SchemaMapper.xml}. */
@Mapper
public interface SchemaMapper {
    /** {@code isolation}, {@code collation}, {@code sql_mode} of this connection. */
    Map<String, Object> session();

    /** 1 when the table of applied migrations exists in this schema. */
    int historyTableCount();

    /** The migrations applied, oldest first: {@code version}, {@code description}, {@code success}. */
    List<Map<String, Object>> history();
}
