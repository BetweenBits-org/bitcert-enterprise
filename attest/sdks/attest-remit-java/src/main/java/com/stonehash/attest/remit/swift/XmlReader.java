package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Text;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A small XML reader — exactly enough to read ISO 20022 payment messages,
 * and deliberately no more. (The port of the reference's {@code xml.ts}.)
 *
 * <p>Why not the JDK's parser: what it accepts and what it refuses are not
 * what the reference accepts and refuses, and a message must be read the same
 * way by both SDKs. This reader is the reference's, line for line.
 *
 * <p>What it refuses, on purpose:
 * <ul>
 * <li>a document type declaration ({@code <!DOCTYPE …>}), and with it every
 *     entity trick — external entities, parameter entities, entity expansion.
 *     A payment message has no use for a DTD; a parser that honours one can be
 *     made to read files or exhaust memory.
 * <li>any entity other than the five XML predefines and numeric character
 *     references.
 * <li>input over 4 MiB, nested deeper than 64 elements, or with more than 64
 *     namespace prefixes in scope.
 * <li>what is not well-formed and could be read two ways: an attribute written
 *     twice, a prefix that is not declared, a character XML does not allow.
 * </ul>
 *
 * <p>Namespaces are resolved (prefix → URI) because the message type lives in
 * the namespace URI, and because real messages arrive both with a default
 * namespace and with prefixes, bare or inside an envelope. Navigation is
 * namespace-aware for the same reason a bank's own validator is: an element
 * from another vocabulary slipped in beside {@code <Nm>} is not the name.
 */
final class XmlReader {
    private XmlReader() {
    }

    /** One element of the document. */
    static final class Element {
        /** Local name, prefix removed. */
        final String name;
        /** Namespace URI in scope for this element ("" when none). */
        final String ns;
        /**
         * Unqualified attributes by name. An attribute with a prefix belongs to
         * another vocabulary ({@code xsi:schemaLocation} …) and is not kept;
         * {@code xmlns} declarations are not included.
         */
        final Map<String, String> attrs;
        final List<Element> children = new ArrayList<>();
        /** Character data directly inside this element, entity-decoded. */
        String text = "";

        Element(String name, String ns, Map<String, String> attrs) {
            this.name = name;
            this.ns = ns;
            this.attrs = attrs;
        }
    }

    /** The reference's {@code XmlError}: the document is not one this reader takes. */
    static final class XmlException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        XmlException(String message) {
            super(message);
        }
    }

    static final int MAX_BYTES = 4 * 1024 * 1024;
    static final int MAX_DEPTH = 64;
    /** Real messages declare a handful; the cap keeps the cost of a scope bounded. */
    static final int MAX_PREFIXES = 64;

    private static final Map<String, String> NO_SCOPE = Collections.emptyMap();
    private static final Pattern NAME = Pattern.compile("^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?\\z");
    private static final Pattern DECLARATION = Pattern.compile("^<!(DOCTYPE|ENTITY)", Pattern.CASE_INSENSITIVE);
    private static final Pattern HEX_DIGITS = Pattern.compile("^[0-9a-fA-F]{1,6}\\z");
    private static final Pattern DECIMAL_DIGITS = Pattern.compile("^[0-9]{1,7}\\z");

    /**
     * The five entities XML predefines, and no other name: {@code &valueOf;},
     * {@code &constructor;} and the rest are entities that are not defined,
     * as in the reference (which keeps them in a Map for that reason).
     */
    private static final Map<String, String> PREDEFINED = predefined();

    private static Map<String, String> predefined() {
        Map<String, String> m = new HashMap<>();
        m.put("amp", "&");
        m.put("lt", "<");
        m.put("gt", ">");
        m.put("quot", "\"");
        m.put("apos", "'");
        return Collections.unmodifiableMap(m);
    }

    /**
     * The one attribute name the reference does not keep: its attributes are a
     * plain JavaScript object, and {@code attrs["__proto__"] = value} sets
     * nothing there when the value is text. The attribute is still read — its
     * value decoded, its name checked and counted, so writing it twice is
     * refused — only it is not among the element's attributes.
     */
    private static final String NOT_KEPT_ATTRIBUTE = "__proto__";

    private static boolean validCodePoint(int cp) {
        return cp == 0x9 || cp == 0xa || cp == 0xd
                || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)
                || (cp >= 0x10000 && cp <= 0x10ffff);
    }

    /**
     * The reference's {@code ILLEGAL_CHAR}: the offset of the first character
     * XML does not allow, or -1 — U+0000 to U+0008, U+000B, U+000C, U+000E to
     * U+001F, U+FFFE, U+FFFF, and a surrogate that is not half of a pair.
     * Written out because the reference's pattern runs over UTF-16 code units
     * and a Java pattern runs over code points.
     */
    private static int illegalCharAt(String s) {
        int n = s.length();
        for (int k = 0; k < n; k++) {
            char c = s.charAt(k);
            if (c <= 0x08 || c == 0x0b || c == 0x0c || (c >= 0x0e && c <= 0x1f) || c == 0xfffe || c == 0xffff) {
                return k;
            }
            if (Character.isHighSurrogate(c)) {
                if (k + 1 >= n || !Character.isLowSurrogate(s.charAt(k + 1))) {
                    return k;
                }
            } else if (Character.isLowSurrogate(c) && (k == 0 || !Character.isHighSurrogate(s.charAt(k - 1)))) {
                return k;
            }
        }
        return -1;
    }

    /** What ends an entity name: {@code [;&\s]}. */
    private static boolean endsEntityName(char c) {
        return c == ';' || c == '&' || Text.isWhitespace(c);
    }

    /**
     * {@code raw.replace(/&([^;&\s]{0,32});?/g, …)}. Written out because the
     * reference counts the 32 in UTF-16 code units and a Java pattern would
     * count code points.
     */
    private static String decodeEntities(String raw, int at) {
        if (raw.indexOf('&') < 0) {
            return raw;
        }
        int n = raw.length();
        StringBuilder out = new StringBuilder(n);
        int pos = 0;
        for (;;) {
            int amp = raw.indexOf('&', pos);
            if (amp < 0) {
                out.append(raw, pos, n);
                return out.toString();
            }
            out.append(raw, pos, amp);
            int end = amp + 1;
            int limit = Math.min(n, amp + 1 + 32);
            while (end < limit && !endsEntityName(raw.charAt(end))) {
                end++;
            }
            String body = raw.substring(amp + 1, end);
            boolean semicolon = end < n && raw.charAt(end) == ';';
            if (!semicolon || body.isEmpty()) {
                throw new XmlException("a bare \"&\" must be written &amp; (near offset " + at + ")");
            }
            out.append(entity(body, at));
            pos = end + 1;
        }
    }

    private static String entity(String body, int at) {
        if (body.startsWith("#")) {
            // XML writes a hexadecimal reference `&#x…;` — never `&#X…;`.
            boolean hex = body.length() > 1 && body.charAt(1) == 'x';
            String digits = Js.slice(body, hex ? 2 : 1);
            if (!(hex ? HEX_DIGITS : DECIMAL_DIGITS).matcher(digits).find()) {
                throw new XmlException("malformed character reference &" + body + "; (near offset " + at + ")");
            }
            int cp = Integer.parseInt(digits, hex ? 16 : 10);
            if (!validCodePoint(cp)) {
                throw new XmlException("character reference &" + body + "; is not a legal XML character");
            }
            return new String(Character.toChars(cp));
        }
        String known = PREDEFINED.get(body);
        if (known == null) {
            throw new XmlException("entity &" + body + "; is not defined — only &amp; &lt; &gt; &quot; &apos; and numeric references are accepted");
        }
        return known;
    }

    /** An element still open, and the text gathered for it so far. */
    private static final class Open {
        final Element el;
        final String qname;
        final Map<String, String> scope;
        final StringBuilder text = new StringBuilder();

        Open(Element el, String qname, Map<String, String> scope) {
            this.el = el;
            this.qname = qname;
            this.scope = scope;
        }
    }

    /** One match of {@code /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y}. */
    private static final class Attribute {
        final String key;
        final String value;
        final int end;

        Attribute(String key, String value, int end) {
            this.key = key;
            this.value = value;
            this.end = end;
        }
    }

    /**
     * The sticky attribute pattern of the reference, tried at {@code from}: the
     * match, or null. The pattern cannot match two ways (every run it takes is
     * bounded by a character the next part needs), so it is written out.
     */
    private static Attribute attributeAt(String inner, int from) {
        int n = inner.length();
        int k = from;
        while (k < n && Text.isWhitespace(inner.charAt(k))) {
            k++;
        }
        if (k == from) {
            return null;
        }
        int keyStart = k;
        while (k < n && !Text.isWhitespace(inner.charAt(k)) && inner.charAt(k) != '=') {
            k++;
        }
        if (k == keyStart) {
            return null;
        }
        String key = inner.substring(keyStart, k);
        while (k < n && Text.isWhitespace(inner.charAt(k))) {
            k++;
        }
        if (k >= n || inner.charAt(k) != '=') {
            return null;
        }
        k++;
        while (k < n && Text.isWhitespace(inner.charAt(k))) {
            k++;
        }
        if (k >= n || (inner.charAt(k) != '"' && inner.charAt(k) != '\'')) {
            return null;
        }
        int close = inner.indexOf(inner.charAt(k), k + 1);
        if (close < 0) {
            return null;
        }
        return new Attribute(key, inner.substring(k + 1, close), close + 1);
    }

    private static XmlException fail(String msg, int offset) {
        return new XmlException(msg + " (offset " + offset + ")");
    }

    /** Parse one XML document and return its root element. */
    static Element parse(String input) {
        String s = !input.isEmpty() && input.charAt(0) == '﻿' ? input.substring(1) : input;
        if (s.length() > MAX_BYTES) {
            throw new XmlException("message is larger than " + MAX_BYTES + " characters");
        }
        int illegal = illegalCharAt(s);
        if (illegal >= 0) {
            throw new XmlException("character U+" + Js.padStart(Js.upper(Integer.toHexString(s.charAt(illegal))), 4, '0')
                    + " at offset " + illegal + " is not allowed in XML");
        }

        int n = s.length();
        List<Open> stack = new ArrayList<>();
        Element root = null;
        boolean closed = false;
        int i = 0;

        while (i < n) {
            int lt = s.indexOf('<', i);
            int textEnd = lt == -1 ? n : lt;
            if (textEnd > i) {
                String raw = s.substring(i, textEnd);
                if (!stack.isEmpty()) {
                    top(stack).text.append(decodeEntities(raw, i));
                } else if (!Js.blank(raw)) {
                    throw fail("text outside the root element", i);
                }
            }
            if (lt == -1) {
                break;
            }
            i = lt;

            if (s.startsWith("<!--", i)) {
                int end = s.indexOf("-->", i + 4);
                if (end == -1) {
                    throw fail("unterminated comment", i);
                }
                i = end + 3;
                continue;
            }
            if (s.startsWith("<![CDATA[", i)) {
                int end = s.indexOf("]]>", i + 9);
                if (end == -1) {
                    throw fail("unterminated CDATA section", i);
                }
                if (stack.isEmpty()) {
                    throw fail("CDATA outside the root element", i);
                }
                top(stack).text.append(s, i + 9, end);
                i = end + 3;
                continue;
            }
            if (s.startsWith("<?", i)) {
                int end = s.indexOf("?>", i + 2);
                if (end == -1) {
                    throw fail("unterminated processing instruction", i);
                }
                i = end + 2;
                continue;
            }
            if (s.startsWith("<!", i)) {
                // Met where markup is read — not searched for in the whole text, where
                // the words may sit harmlessly inside a comment or a CDATA section.
                if (DECLARATION.matcher(Js.slice(s, i, i + 9)).find()) {
                    throw new XmlException("a document type declaration is refused — payment messages carry no DTD, and none is processed");
                }
                throw fail("markup declarations are refused", i);
            }

            if (s.startsWith("</", i)) {
                int end = s.indexOf('>', i + 2);
                if (end == -1) {
                    throw fail("unterminated closing tag", i);
                }
                String qname = Js.trim(s.substring(i + 2, end));
                if (stack.isEmpty()) {
                    throw fail("</" + qname + "> has no opening tag", i);
                }
                Open open = stack.remove(stack.size() - 1);
                if (!open.qname.equals(qname)) {
                    throw fail("</" + qname + "> closes <" + open.qname + ">", i);
                }
                open.el.text = open.text.toString();
                i = end + 1;
                if (stack.isEmpty()) {
                    closed = true;
                }
                continue;
            }

            // A start tag. Find its end without being fooled by ">" inside a quoted value.
            int j = i + 1;
            int quote = -1;
            for (; j < n; j++) {
                char c = s.charAt(j);
                if (quote != -1) {
                    if (c == quote) {
                        quote = -1;
                    }
                } else if (c == '"' || c == '\'') {
                    quote = c;
                } else if (c == '>') {
                    break;
                }
            }
            if (j >= n) {
                throw fail("unterminated tag", i);
            }
            String inner = s.substring(i + 1, j);
            boolean selfClosing = inner.endsWith("/");
            if (selfClosing) {
                inner = inner.substring(0, inner.length() - 1);
            }

            int nameEnd = 0;
            while (nameEnd < inner.length() && !Text.isWhitespace(inner.charAt(nameEnd))) {
                nameEnd++;
            }
            String qname = inner.substring(0, nameEnd);
            if (!NAME.matcher(qname).find()) {
                throw fail("\"" + Js.slice(qname, 0, 40) + "\" is not an element name", i);
            }
            if (closed) {
                throw fail("a second root element", i);
            }

            // The parent's scope is shared, not copied: only an element that declares
            // a namespace gets a map of its own. Copying per element made a message
            // with many prefixes quadratic.
            Map<String, String> scope = stack.isEmpty() ? NO_SCOPE : top(stack).scope;
            Map<String, String> declared = null;
            Map<String, String> attrs = new LinkedHashMap<>();
            Set<String> seen = new HashSet<>();
            List<String> prefixed = new ArrayList<>();
            int consumed = qname.length();
            for (Attribute m = attributeAt(inner, consumed); m != null; m = attributeAt(inner, consumed)) {
                String key = m.key;
                String value = decodeEntities(m.value, i);
                if (!NAME.matcher(key).find()) {
                    throw fail("\"" + Js.slice(key, 0, 40) + "\" is not an attribute name", i);
                }
                if (seen.contains(key)) {
                    throw fail("attribute " + key + " is written twice in <" + qname + ">", i);
                }
                seen.add(key);
                if (key.equals("xmlns") || key.startsWith("xmlns:")) {
                    if (declared == null) {
                        declared = new HashMap<>(scope);
                    }
                    declared.put(key.equals("xmlns") ? "" : key.substring(6), value);
                    if (declared.size() > MAX_PREFIXES) {
                        throw fail("more than " + MAX_PREFIXES + " namespace prefixes in scope", i);
                    }
                    scope = declared;
                } else if (key.indexOf(':') >= 0) {
                    prefixed.add(key.substring(0, key.indexOf(':')));
                } else if (!key.equals(NOT_KEPT_ATTRIBUTE)) {
                    attrs.put(key, value);
                }
                consumed = m.end;
            }
            if (!Js.blank(Js.slice(inner, consumed))) {
                throw fail("malformed attributes in <" + qname + ">", i);
            }
            for (String pfx : prefixed) {
                if (!pfx.equals("xml") && !scope.containsKey(pfx)) {
                    throw fail("namespace prefix \"" + pfx + "\" is not declared", i);
                }
            }

            int colon = qname.indexOf(':');
            String prefix = colon == -1 ? "" : qname.substring(0, colon);
            if (!prefix.isEmpty() && !scope.containsKey(prefix)) {
                throw fail("namespace prefix \"" + prefix + "\" is not declared", i);
            }
            Element el = new Element(colon == -1 ? qname : qname.substring(colon + 1), Js.or(scope.get(prefix), ""), attrs);
            if (!stack.isEmpty()) {
                top(stack).el.children.add(el);
            } else {
                root = el;
            }

            if (selfClosing) {
                if (stack.isEmpty()) {
                    closed = true;
                }
            } else {
                if (stack.size() >= MAX_DEPTH) {
                    throw fail("elements nested deeper than " + MAX_DEPTH, i);
                }
                stack.add(new Open(el, qname, scope));
            }
            i = j + 1;
        }

        if (!stack.isEmpty()) {
            throw new XmlException("<" + top(stack).qname + "> is never closed");
        }
        if (root == null) {
            throw new XmlException("no XML element found");
        }
        return root;
    }

    private static Open top(List<Open> stack) {
        return stack.get(stack.size() - 1);
    }

    // ── Navigation helpers ─────────────────────────────────────────────────────

    /**
     * The one direct child with this name, in the parent's own namespace.
     *
     * <p>For elements the message carries at most once. Two of them is a
     * message that can be read two ways — which name, which amount — and is
     * refused rather than settled by taking the first.
     */
    static Element child(Element el, String name) {
        if (el == null) {
            return null;
        }
        Element hit = null;
        for (Element c : el.children) {
            if (!c.name.equals(name) || !c.ns.equals(el.ns)) {
                continue;
            }
            if (hit != null) {
                throw new XmlException("<" + name + "> occurs more than once inside <" + el.name + "> — one is expected");
            }
            hit = c;
        }
        return hit;
    }

    /** Every direct child with this name, in the parent's own namespace — for elements that may repeat. */
    static List<Element> childrenOf(Element el, String name) {
        List<Element> out = new ArrayList<>();
        if (el == null) {
            return out;
        }
        for (Element c : el.children) {
            if (c.name.equals(name) && c.ns.equals(el.ns)) {
                out.add(c);
            }
        }
        return out;
    }

    /** Follow an {@code A/B/C} path of direct children, each expected once. */
    static Element at(Element el, String path) {
        Element cur = el;
        for (String step : Js.split(path, "/")) {
            if (cur == null) {
                return null;
            }
            cur = child(cur, step);
        }
        return cur;
    }

    /** Trimmed text at a path, or null when the element is absent or empty. */
    static String textAt(Element el, String path) {
        Element hit = path.isEmpty() ? el : at(el, path);
        String t = hit == null ? null : Js.trim(hit.text);
        return Js.truthy(t) ? t : null;
    }

    /** Depth-first search for the first element with this local name. */
    static Element findFirst(Element el, String name) {
        if (el.name.equals(name)) {
            return el;
        }
        for (Element c : el.children) {
            Element hit = findFirst(c, name);
            if (hit != null) {
                return hit;
            }
        }
        return null;
    }

    /**
     * Escape character data for an XML text node or attribute value.
     * Characters XML 1.0 does not allow at all (control characters other than
     * tab, line feed and carriage return, and U+FFFE / U+FFFF) are dropped —
     * text that came from another system's event must not be able to make the
     * report unreadable. A half surrogate cannot be written in UTF-8 at all: it
     * is dropped too, while a surrogate pair is the one character it encodes.
     *
     * <p>The reference's {@code replace(/\p{Cs}/gu, '')} reads the text by
     * code point, so a high surrogate followed by a low one is a pair and every
     * other surrogate stands alone; that is the test made here, on the text as
     * given. Dropping cannot join two halves into a new pair (a high half is
     * dropped only when no low half follows it), so one pass does all three
     * of the reference's steps.
     */
    static String xmlEscape(String text) {
        StringBuilder out = new StringBuilder(text.length());
        int n = text.length();
        for (int k = 0; k < n; k++) {
            char c = text.charAt(k);
            if (Character.isHighSurrogate(c) && k + 1 < n && Character.isLowSurrogate(text.charAt(k + 1))) {
                out.append(c).append(text.charAt(k + 1));
                k++;
                continue;
            }
            if (Character.isSurrogate(c)) {
                continue;
            }
            if (c <= 0x08 || c == 0x0b || c == 0x0c || (c >= 0x0e && c <= 0x1f) || c == 0xfffe || c == 0xffff) {
                continue;
            }
            switch (c) {
                case '&':
                    out.append("&amp;");
                    break;
                case '<':
                    out.append("&lt;");
                    break;
                case '>':
                    out.append("&gt;");
                    break;
                case '"':
                    out.append("&quot;");
                    break;
                case '\'':
                    out.append("&apos;");
                    break;
                default:
                    out.append(c);
            }
        }
        return out.toString();
    }
}
