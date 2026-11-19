package com.stonehash.attest.remit.swift;

import com.stonehash.attest.remit.Json;
import com.stonehash.attest.remit.RemitException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The Java half of probe/fuzz.ts: reads the inputs, writes this package's answers in the same shape. */
public final class FuzzDriver {
    private FuzzDriver() {
    }

    private static Map<String, Object> error(String name, RuntimeException e) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("name", name);
        if (e instanceof RemitException) {
            err.put("code", ((RemitException) e).code());
        }
        if (e instanceof SwiftMessageException && ((SwiftMessageException) e).field() != null) {
            err.put("field", ((SwiftMessageException) e).field());
        }
        err.put("message", e.getMessage());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", err);
        return out;
    }

    private static List<Object> elements(XmlReader.Element el, int depth, List<Object> out) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("depth", (long) depth);
        e.put("name", el.name);
        e.put("ns", el.ns);
        e.put("attrs", new LinkedHashMap<String, Object>(el.attrs));
        e.put("text", el.text);
        out.add(e);
        for (XmlReader.Element c : el.children) {
            elements(c, depth + 1, out);
        }
        return out;
    }

    private static Object answer(String kind, String text) {
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            if (kind.equals("xml")) {
                out.put("elements", elements(XmlReader.parse(text), 0, new ArrayList<>()));
            } else if (kind.equals("bytes")) {
                List<Object> payments = new ArrayList<>();
                for (SwiftPayment p : Swift.parseAll(java.util.Base64.getDecoder().decode(text))) {
                    payments.add(p.toJson());
                }
                out.put("payments", payments);
            } else if (kind.equals("tokens")) {
                out.put("tokens", new ArrayList<Object>(Iso20022Reader.invoiceTokens(text)));
            } else {
                List<Object> payments = new ArrayList<>();
                for (SwiftPayment p : Swift.parseAll(text)) {
                    payments.add(p.toJson());
                }
                out.put("payments", payments);
            }
            return out;
        } catch (XmlReader.XmlException e) {
            return error("XmlError", e);
        } catch (SwiftMessageException e) {
            return error("SwiftMessageError", e);
        } catch (IllegalStateException e) {
            return error("TypeError", e);
        } catch (RuntimeException e) {
            return error(e.getClass().getName(), e);
        }
    }

    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        List<Object> inputs = (List<Object>) Json.parse(new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8));
        List<Object> out = new ArrayList<>();
        for (Object o : inputs) {
            Map<String, Object> c = (Map<String, Object>) o;
            out.add(answer((String) c.get("kind"), (String) c.get("text")));
        }
        Files.write(Paths.get(args[1]), Json.compact(out).getBytes(StandardCharsets.UTF_8));
    }
}
