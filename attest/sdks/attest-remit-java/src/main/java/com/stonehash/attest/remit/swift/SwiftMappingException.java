package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.RemitException;
import java.util.List;

/**
 * A message that cannot become a settlement instruction, with every reason at
 * once. The code is {@code mapping_incomplete}; {@link #issues()} names each
 * missing element in the message's own vocabulary and says how to provide it.
 */
public final class SwiftMappingException extends RemitException {
    private static final long serialVersionUID = 1L;

    private final transient SwiftMapping mapping;

    public SwiftMappingException(SwiftMapping mapping) {
        super("mapping_incomplete", messageOf(mapping));
        this.mapping = mapping;
    }

    private static String messageOf(SwiftMapping mapping) {
        StringBuilder out = new StringBuilder("the message cannot be turned into a settlement instruction — ")
                .append(mapping.issues().size()).append(" thing(s) missing: ");
        boolean first = true;
        for (SwiftMapping.Issue i : mapping.issues()) {
            if (!first) {
                out.append("; ");
            }
            first = false;
            out.append(SwiftMapper.template(i.target())).append(" (").append(SwiftMapper.template(i.source())).append(')');
        }
        return out.toString();
    }

    /** Every reason the message cannot become an instruction. */
    public List<SwiftMapping.Issue> issues() {
        return mapping.issues();
    }

    /** The whole mapping table, issues and all. */
    public SwiftMapping mapping() {
        return mapping;
    }
}
