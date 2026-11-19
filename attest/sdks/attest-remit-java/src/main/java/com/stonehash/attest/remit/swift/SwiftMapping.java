package com.stonehash.attest.remit.swift;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A payment read onto what a settlement instruction needs — the mapping table.
 *
 * <p>For every value the instruction carries it records where in the bank's
 * message it came from and on what basis ({@code stated}: taken verbatim from
 * the message; {@code inferred}: derived from something the message does
 * state, and reported as such; {@code supplied}: given by the bank outside the
 * message). For everything the corridor requires that the message does not
 * carry there is an {@linkplain Issue issue}, and content with no place in the
 * corridor is listed as {@linkplain Unmapped unmapped}, with the reason.
 */
public final class SwiftMapping {
    /** One value of the instruction and where it came from. */
    public static final class Field {
        private final String target;
        private final String value;
        private final String source;
        private final String basis;

        Field(String target, String value, String source, String basis) {
            this.target = target;
            this.value = value;
            this.source = source;
            this.basis = basis;
        }

        /** Where the value goes in the instruction. */
        public String target() {
            return target;
        }

        public String value() {
            return value;
        }

        /** Where it came from, in the message's own vocabulary ({@code supplement} for a supplied value). */
        public String source() {
            return source;
        }

        /** {@code stated}, {@code inferred} or {@code supplied}. */
        public String basis() {
            return basis;
        }

        /** {@code { target, value, source, basis }}. */
        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            JsonOut.put(out, "target", target);
            JsonOut.put(out, "value", value);
            JsonOut.put(out, "source", source);
            JsonOut.put(out, "basis", basis);
            return out;
        }

        @Override
        public String toString() {
            return target + " = " + value + " (" + basis + ", " + source + ")";
        }
    }

    /** Something the corridor requires that the message does not carry, or a reason it is refused. */
    public static final class Issue {
        private final String target;
        private final String source;
        private final String problem;
        private final String fix;

        Issue(String target, String source, String problem, String fix) {
            this.target = target;
            this.source = source;
            this.problem = problem;
            this.fix = fix;
        }

        /** The instruction field that cannot be filled. */
        public String target() {
            return target;
        }

        /** Where the message would have carried it. */
        public String source() {
            return source;
        }

        public String problem() {
            return problem;
        }

        /** What to do about it. */
        public String fix() {
            return fix;
        }

        /** {@code { target, source, problem, fix }}. */
        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            JsonOut.put(out, "target", target);
            JsonOut.put(out, "source", source);
            JsonOut.put(out, "problem", problem);
            JsonOut.put(out, "fix", fix);
            return out;
        }

        @Override
        public String toString() {
            return target + " (" + source + "): " + problem;
        }
    }

    /** Content of the message that has no place in the corridor, and why. */
    public static final class Unmapped {
        private final String source;
        private final String value;
        private final String why;

        Unmapped(String source, String value, String why) {
            this.source = source;
            this.value = value;
            this.why = why;
        }

        public String source() {
            return source;
        }

        public String value() {
            return value;
        }

        public String why() {
            return why;
        }

        /** {@code { source, value, why }}. */
        public Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            JsonOut.put(out, "source", source);
            JsonOut.put(out, "value", value);
            JsonOut.put(out, "why", why);
            return out;
        }

        @Override
        public String toString() {
            return source + " = " + value + ": " + why;
        }
    }

    private final SwiftPayment payment;
    private final List<Field> fields;
    private final List<Issue> issues;
    private final List<Unmapped> unmapped;
    private final SwiftInstructionInput input;

    SwiftMapping(SwiftPayment payment, List<Field> fields, List<Issue> issues, List<Unmapped> unmapped, SwiftInstructionInput input) {
        this.payment = payment;
        this.fields = Collections.unmodifiableList(new ArrayList<>(fields));
        this.issues = Collections.unmodifiableList(new ArrayList<>(issues));
        this.unmapped = Collections.unmodifiableList(new ArrayList<>(unmapped));
        this.input = input;
    }

    /** The payment that was mapped. */
    public SwiftPayment payment() {
        return payment;
    }

    /** What the instruction is built from — present exactly when {@link #issues()} is empty, null otherwise. */
    public SwiftInstructionInput input() {
        return input;
    }

    public List<Field> fields() {
        return fields;
    }

    public List<Issue> issues() {
        return issues;
    }

    public List<Unmapped> unmapped() {
        return unmapped;
    }

    /**
     * The mapping as the reference's JSON has it, without the payment (which
     * has its own {@link SwiftPayment#toJson()}): {@code fields}, {@code issues},
     * {@code unmapped} and — when there are no issues — {@code input}.
     */
    public Map<String, Object> toJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Object> f = new ArrayList<>();
        for (Field x : fields) {
            f.add(x.toJson());
        }
        out.put("fields", f);
        List<Object> i = new ArrayList<>();
        for (Issue x : issues) {
            i.add(x.toJson());
        }
        out.put("issues", i);
        List<Object> u = new ArrayList<>();
        for (Unmapped x : unmapped) {
            u.add(x.toJson());
        }
        out.put("unmapped", u);
        if (input != null) {
            out.put("input", input.toJson());
        }
        return out;
    }
}
