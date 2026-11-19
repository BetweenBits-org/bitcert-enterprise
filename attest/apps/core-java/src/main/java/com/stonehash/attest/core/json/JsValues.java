package com.stonehash.attest.core.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON values handled the way the service this one replaces handled them.
 *
 * <p>The sandbox takes a document a visitor uploaded and changes it — an
 * amount, a signature, which papers came with it. That document can hold
 * anything: text where a list was meant, a number where an object was. What
 * the answer is then was never written down as a rule; it is whatever the
 * previous service did when it read a member of such a value, joined it into
 * a sentence or assigned to it. These are those few operations, so that the
 * code that uses them reads as the rule it ports and answers as it always
 * did.
 *
 * <p>A JSON value here is what {@link Js#parse} returns: {@code Map} (in
 * property order), {@code List}, {@code String}, {@code Double},
 * {@code Boolean}, {@code null} — and {@link Js#UNDEFINED} for a member that
 * is not there, which is not the same as {@code null}.
 *
 * <p>Where the previous service failed inside its runtime — it read a member
 * of nothing, called something that is not a function — it answered with the
 * runtime's own complaint about its source code. Here that is an
 * {@link EngineError}: the caller decides what the client is told, and it is
 * never that sentence.
 *
 * <p>One thing is not reproduced. Every value of the previous runtime also
 * had members nobody put there ({@code constructor}, {@code toString},
 * {@code __proto__}, a list's {@code map} …). A document cannot contain those,
 * and a name chosen by a client is looked up among the members the document
 * has and nowhere else.
 */
public final class JsValues {
    private JsValues() {
    }

    /** Where the previous service's runtime threw on its own: no sentence of this service's, and none for a client. */
    public static final class EngineError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        public EngineError(String what) {
            super(what);
        }
    }

    /** Absent or {@code null}. */
    public static boolean nullish(Object v) {
        return v == null || v == Js.UNDEFINED;
    }

    /** Does the value count as given: not absent, {@code null}, {@code false}, {@code 0} or empty text. */
    public static boolean truthy(Object v) {
        if (nullish(v)) {
            return false;
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return d != 0 && !Double.isNaN(d);
        }
        return !(v instanceof String) || !((String) v).isEmpty();
    }

    /** Is the value an object or a list ({@code typeof v === 'object'} and not {@code null}). */
    public static boolean isObject(Object v) {
        return v instanceof Map || v instanceof List;
    }

    /**
     * A member of a value: of an object, the member of that name; of a list
     * or of text, a position or its {@code length}; of a number or a
     * boolean, nothing. Of nothing at all — an {@link EngineError}.
     */
    public static Object member(Object of, String name) {
        if (nullish(of)) {
            throw new EngineError("a member (" + name + ") of " + (of == null ? "null" : "nothing") + " was read");
        }
        if (of instanceof Map) {
            Map<?, ?> map = (Map<?, ?>) of;
            Object v = map.get(name);
            return v != null || map.containsKey(name) ? v : Js.UNDEFINED;
        }
        if (of instanceof List) {
            List<?> list = (List<?>) of;
            if (name.equals("length")) {
                return (double) list.size();
            }
            int i = index(name);
            return i >= 0 && i < list.size() ? list.get(i) : Js.UNDEFINED;
        }
        if (of instanceof String) {
            String text = (String) of;
            if (name.equals("length")) {
                return (double) text.length();
            }
            int i = index(name);
            return i >= 0 && i < text.length() ? String.valueOf(text.charAt(i)) : Js.UNDEFINED;
        }
        return Js.UNDEFINED;
    }

    /** {@link #member} where nothing has no members instead of being an error ({@code of?.name}). */
    public static Object memberIfAny(Object of, String name) {
        return nullish(of) ? Js.UNDEFINED : member(of, name);
    }

    private static int index(String name) {
        if (!Js.isArrayIndex(name) || name.length() > 9) {
            return -1;
        }
        return Integer.parseInt(name);
    }

    /**
     * Give a value a member. An object takes it (a member it already has
     * keeps its place). A list takes it too and never shows it — a list is
     * written out by position — so here that is nothing. Text, a number or a
     * boolean cannot take one, and nothing cannot: an {@link EngineError}.
     */
    @SuppressWarnings("unchecked")
    public static void set(Object on, String name, Object value) {
        if (on instanceof Map) {
            ((Map<String, Object>) on).put(name, value);
        } else if (!(on instanceof List)) {
            throw new EngineError("a member (" + name + ") was set on a value that cannot take one");
        }
    }

    /** Take a member away, where there is one. */
    public static void delete(Object from, String name) {
        if (nullish(from)) {
            throw new EngineError("a member (" + name + ") of nothing was deleted");
        }
        if (from instanceof Map) {
            ((Map<?, ?>) from).remove(name);
        }
    }

    /** {@code a === b}: the same kind and the same value; two objects or two lists only when they are the very same one. */
    public static boolean strictEquals(Object a, Object b) {
        if (a == b) {
            return true;
        }
        if (a == null || b == null || a == Js.UNDEFINED || b == Js.UNDEFINED) {
            return false;
        }
        if (a instanceof Number && b instanceof Number) {
            return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        }
        if (a instanceof String || a instanceof Boolean) {
            return a.equals(b);
        }
        return false;
    }

    /**
     * A value as the text it becomes inside a sentence. Text is itself; a
     * number is written as JavaScript writes it; {@code null} and absence
     * are the words; a list is its items joined by commas (nothing for a
     * {@code null}); an object is {@code [object Object]}.
     */
    public static String string(Object v) {
        if (v == null) {
            return "null";
        }
        if (v == Js.UNDEFINED) {
            return "undefined";
        }
        if (v instanceof String) {
            return (String) v;
        }
        if (v instanceof Boolean) {
            return v.toString();
        }
        if (v instanceof Number) {
            return Js.numberToString(((Number) v).doubleValue());
        }
        if (v instanceof List) {
            StringBuilder out = new StringBuilder();
            boolean first = true;
            for (Object item : (List<?>) v) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                if (!nullish(item)) {
                    out.append(string(item));
                }
            }
            return out.toString();
        }
        if (v instanceof Map) {
            // An object that names its own `toString` has one that cannot be called: there the runtime gave up.
            if (((Map<?, ?>) v).containsKey("toString")) {
                throw new EngineError("an object with a member named toString was put into a sentence");
            }
            return "[object Object]";
        }
        throw new IllegalArgumentException(v.getClass().getName() + " is not a JSON value");
    }

    /** A copy that shares nothing with the original: objects and lists all the way down, in the same order. */
    public static Object copy(Object v) {
        if (v instanceof Map) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                out.put((String) e.getKey(), copy(e.getValue()));
            }
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>(((List<?>) v).size());
            for (Object item : (List<?>) v) {
                out.add(copy(item));
            }
            return out;
        }
        return v;
    }
}
