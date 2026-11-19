package com.stonehash.attest.core.sandbox;

import static com.stonehash.attest.core.json.JsValues.copy;
import static com.stonehash.attest.core.json.JsValues.member;
import static com.stonehash.attest.core.json.JsValues.memberIfAny;
import static com.stonehash.attest.core.json.JsValues.nullish;
import static com.stonehash.attest.core.json.JsValues.set;
import static com.stonehash.attest.core.json.JsValues.strictEquals;
import static com.stonehash.attest.core.json.JsValues.string;
import static com.stonehash.attest.core.json.JsValues.truthy;

import com.stonehash.attest.core.http.PlainError;
import com.stonehash.attest.core.json.JsValues;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Deliberate tampering, as pure transforms of an evidence document.
 *
 * <p>A reviewer changes an amount or corrupts a signature and runs the same
 * policy again: that is the whole exercise. Each transform returns a new
 * document and never changes the one it was given, and each records what it
 * did in {@code scenario} — so a verdict on tampered evidence describes
 * itself, and a downloaded package cannot be mistaken for one from clean
 * data.
 *
 * <p>The document may be the visitor's own, so nothing about its shape can
 * be assumed. A transform that cannot find what it is to change says so in
 * a sentence of its own ({@link PlainError}: answered 500 with that
 * sentence, as it always was). Where the document is not shaped like
 * evidence at all — a number where the elements belong — the previous
 * service failed inside its runtime; here that is a
 * {@link JsValues.EngineError} (docs/JAVA-INTENDED-DIFFERENCES.md, D-01).
 */
final class Tamper {
    private Tamper() {
    }

    /** What the transform did, appended to the scenario: the first after {@code " + tampered: "}, the rest after commas. */
    private static void tag(Object ev, String what) {
        Object scenario = member(ev, "scenario");
        boolean tampered;
        if (scenario instanceof String) {
            tampered = ((String) scenario).contains(" + tampered:");
        } else if (scenario instanceof List) {
            tampered = false;
            for (Object item : (List<?>) scenario) {
                tampered |= strictEquals(item, " + tampered:");
            }
        } else {
            // No scenario, or one that is not text: there is nothing to append to.
            throw new JsValues.EngineError("the evidence's scenario is not text");
        }
        set(ev, "scenario", tampered ? string(scenario) + ", " + what : string(scenario) + " + tampered: " + what);
    }

    /** The first payout receipt, or nothing. */
    private static Object firstReceipt(Object elements) {
        return memberIfAny(member(elements, "payoutReceipts"), "0");
    }

    /**
     * Replace an amount. The amount is text — a decimal string — and is
     * written as given: whether it is a decimal is for the rules to say.
     * A target the catalogue does not list changes nothing; the scenario
     * still says what was asked.
     */
    static Object changeAmount(Object evidence, String target, String amount) {
        Object ev = copy(evidence);
        Object el = member(ev, "elements");
        switch (target) {
            case "chainTransfer":
            case "bankInstruction":
            case "commercialDocs": {
                Object item = member(el, target);
                if (!truthy(item)) {
                    throw new PlainError("changeAmount: no " + target + " to change");
                }
                set(item, "amount", amount);
                break;
            }
            case "payoutReceipt": {
                Object receipt = firstReceipt(el);
                if (!truthy(receipt)) {
                    throw new PlainError("changeAmount: no payoutReceipts[0] to change");
                }
                set(receipt, "amount", amount);
                break;
            }
            default:
                break;
        }
        tag(ev, target + " amount set to " + amount);
        return ev;
    }

    /**
     * Invalidate a signature and leave the digest and the chain data alone:
     * the case a single green tick would hide. The signature's bytes are
     * corrupted — one character in the middle — rather than its status,
     * which is a claim the verifier overwrites; and its {@code checked} mark
     * is taken off, because nobody has checked what is there now.
     */
    static Object breakSignature(Object evidence, String target) {
        Object ev = copy(evidence);
        Object el = member(ev, "elements");
        Object item = target.equals("payoutReceipt") ? firstReceipt(el) : member(el, target);
        if (!truthy(item)) {
            throw new PlainError("breakSignature: no " + target + " to modify");
        }
        Object sig = member(item, "signature");
        if (!truthy(sig)) {
            throw new PlainError("breakSignature: " + target + " carries no signature");
        }
        Object value = member(sig, "value");
        if (!truthy(value)) {
            throw new PlainError("breakSignature: " + target + "'s signature carries no value to corrupt");
        }
        String corrupted;
        if (value instanceof String) {
            String s = (String) value;
            int i = s.length() / 2;
            corrupted = s.substring(0, i) + (s.charAt(i) == 'A' ? 'B' : 'A') + s.substring(i + 1);
        } else if (value instanceof List) {
            // A list where the signature's text belongs: its items, joined, with the middle one replaced.
            List<?> items = (List<?>) value;
            int i = items.size() / 2;
            String ch = i < items.size() && strictEquals(items.get(i), "A") ? "B" : "A";
            corrupted = string(items.subList(0, i)) + ch + string(items.subList(Math.min(i + 1, items.size()), items.size()));
        } else {
            throw new JsValues.EngineError("a signature value that is neither text nor a list cannot be corrupted");
        }
        set(sig, "value", corrupted);
        JsValues.delete(sig, "checked");
        tag(ev, target + " signature bytes corrupted");
        return ev;
    }

    /**
     * Remove a document: from attached to cited-only, which is what happens
     * in a real submission and what makes the result incomplete rather than
     * forged. An invoice that is not attached cannot supply an amount, and
     * its signature is not there to check — it reads absent, not invalid: a
     * withheld document is not a forged one.
     */
    static Object removeDocument(Object evidence, String document) {
        Object ev = copy(evidence);
        Object docs = member(member(ev, "elements"), "commercialDocs");
        if (!truthy(docs)) {
            throw new PlainError("removeDocument: no commercialDocs present");
        }
        Object attached = member(docs, "attached");
        List<Object> kept = new ArrayList<>();
        if (!nullish(attached)) {
            if (!(attached instanceof List)) {
                throw new JsValues.EngineError("the attached documents are not a list");
            }
            for (Object d : (List<?>) attached) {
                if (!strictEquals(d, document)) {
                    kept.add(d);
                }
            }
        }
        set(docs, "attached", kept);

        Object cited = member(docs, "citedOnly");
        List<Object> all = new ArrayList<>();
        if (cited instanceof List) {
            all.addAll((List<?>) cited);
        } else if (cited instanceof String) {
            // Text where the list belongs was always read as its characters.
            String s = (String) cited;
            for (int i = 0; i < s.length();) {
                int n = Character.charCount(s.codePointAt(i));
                all.add(s.substring(i, i + n));
                i += n;
            }
        } else if (!nullish(cited)) {
            throw new JsValues.EngineError("the cited documents are not a list");
        }
        all.add(document);
        List<Object> once = new ArrayList<>();
        for (Object d : all) {
            boolean seen = false;
            for (Object o : once) {
                seen |= d == o || strictEquals(d, o);
            }
            if (!seen) {
                once.add(d);
            }
        }
        set(docs, "citedOnly", once);

        if (document.toLowerCase(Locale.ROOT).contains("invoice")) {
            JsValues.delete(docs, "amount");
            if (truthy(member(docs, "signature"))) {
                set(docs, "signature", absent());
            }
        }
        tag(ev, document + " removed from the submission");
        return ev;
    }

    /** Corrupt the bytes behind a digest, so that integrity fails and the signatures do not. */
    static Object breakDigest(Object evidence, String target) {
        Object ev = copy(evidence);
        Object el = member(ev, "elements");
        Object item = target.equals("payoutReceipt") ? firstReceipt(el) : member(el, target);
        if (!truthy(item)) {
            throw new PlainError("breakDigest: no " + target + " to modify");
        }
        set(item, "digestVerified", Boolean.FALSE);
        tag(ev, target + " document bytes altered");
        return ev;
    }

    /**
     * Split the one payout into two. Both halves lose their issuer
     * signature: the provider signed one receipt for the full amount and
     * neither of these, and leaving the signature in place would say it had.
     */
    static Object splitPayout(Object evidence, String firstAmount, String secondAmount) {
        Object ev = copy(evidence);
        Object el = member(ev, "elements");
        Object base = firstReceipt(el);
        if (!truthy(base)) {
            throw new PlainError("splitPayout: no payout receipt to split");
        }
        Object second = copy(base);
        set(base, "amount", firstAmount);
        set(second, "amount", secondAmount);
        Object ref = member(base, "ref");
        if (truthy(ref)) {
            set(second, "ref", string(ref) + "-2");
        } else {
            JsValues.delete(second, "ref");
        }
        for (Object receipt : new Object[] { base, second }) {
            if (truthy(member(receipt, "signature"))) {
                set(receipt, "signature", absent());
            }
        }
        List<Object> both = new ArrayList<>();
        both.add(base);
        both.add(second);
        set(el, "payoutReceipts", both);
        tag(ev, "payout split into " + firstAmount + " + " + secondAmount + " (issuer signatures voided — the provider signed neither half)");
        return ev;
    }

    /**
     * Present the same payout receipt twice. This one breaks nothing: the
     * copy keeps its digest and its signature, because the provider did sign
     * that receipt. What is false is the claim built on it — one settlement
     * discharging an obligation twice. Integrity passes, the issuer passes,
     * and the payment still must not be released.
     */
    static Object duplicateReceipt(Object evidence) {
        Object ev = copy(evidence);
        Object el = member(ev, "elements");
        Object first = firstReceipt(el);
        if (!truthy(first)) {
            throw new PlainError("duplicateReceipt: no payout receipt to duplicate");
        }
        List<Object> twice = new ArrayList<>();
        twice.add(first);
        twice.add(copy(first));
        set(el, "payoutReceipts", twice);
        Object ref = member(first, "ref");
        tag(ev, "payout " + (nullish(ref) ? "receipt" : string(ref)) + " submitted twice (document untouched — the claim is what repeats)");
        return ev;
    }

    /** A signature that is not there to check — and that someone did look. */
    private static Map<String, Object> absent() {
        Map<String, Object> signature = new LinkedHashMap<>();
        signature.put("status", "ABSENT");
        signature.put("checked", Boolean.TRUE);
        return signature;
    }
}
