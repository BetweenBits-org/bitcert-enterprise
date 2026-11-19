/**
 * Deliberate tampering, as pure transforms.
 *
 * The Bank Review workflow lets a reviewer change an amount or corrupt a
 * signature and re-run the *same* policy version. That is the whole point of the
 * exercise: if breaking the data produced a different verdict through a
 * different code path, it would demonstrate nothing. These functions return a
 * new evidence object and never mutate the original, so the pristine fixture
 * stays available to restore.
 *
 * Every transform records what it did in `scenario`, so a verdict produced from
 * tampered evidence is self-describing — a downloaded bundle cannot be mistaken
 * for one from clean data.
 */
import type { SettlementEvidence } from './types.ts';

/** Deep clone. `structuredClone` is in Node 17+ and every current browser. */
function clone<T>(v: T): T {
  return structuredClone(v);
}

function tag(ev: SettlementEvidence, what: string): void {
  ev.scenario = ev.scenario.includes(' + tampered:')
    ? `${ev.scenario}, ${what}`
    : `${ev.scenario} + tampered: ${what}`;
}

export type AmountTarget = 'chainTransfer' | 'bankInstruction' | 'commercialDocs' | 'payoutReceipt';

/**
 * Replace an amount. `amount` must be a decimal string — passing a number would
 * reintroduce float representation into the one place it must never appear.
 */
export function changeAmount(
  evidence: SettlementEvidence, target: AmountTarget, amount: string, receiptIndex = 0,
): SettlementEvidence {
  if (typeof amount !== 'string') {
    throw new Error('changeAmount: amount must be a decimal string, not a number');
  }
  const ev = clone(evidence);
  const el = ev.elements;
  switch (target) {
    case 'chainTransfer':
      if (!el.chainTransfer) throw new Error('changeAmount: no chainTransfer to change');
      el.chainTransfer.amount = amount;
      break;
    case 'bankInstruction':
      if (!el.bankInstruction) throw new Error('changeAmount: no bankInstruction to change');
      el.bankInstruction.amount = amount;
      break;
    case 'commercialDocs':
      if (!el.commercialDocs) throw new Error('changeAmount: no commercialDocs to change');
      el.commercialDocs.amount = amount;
      break;
    case 'payoutReceipt': {
      const r = el.payoutReceipts?.[receiptIndex];
      if (!r) throw new Error(`changeAmount: no payoutReceipts[${receiptIndex}] to change`);
      r.amount = amount;
      break;
    }
  }
  tag(ev, `${target} amount set to ${amount}`);
  return ev;
}

export type SignatureTarget = 'chainTransfer' | 'payoutReceipt' | 'bankInstruction' | 'commercialDocs';

/**
 * Invalidate a signature while leaving the digest and chain data intact.
 *
 * This produces the case a single green tick would hide: integrity still passes,
 * the anchor is still sound, and only the issuer axis fails. A reviewer needs to
 * be able to see that combination.
 */
export function breakSignature(
  evidence: SettlementEvidence, target: SignatureTarget, receiptIndex = 0,
): SettlementEvidence {
  const ev = clone(evidence);
  const el = ev.elements;
  const item = target === 'payoutReceipt'
    ? el.payoutReceipts?.[receiptIndex]
    : (el as Record<string, { signature?: { status: string } } | undefined>)[target];
  if (!item) throw new Error(`breakSignature: no ${target} to modify`);
  if (!item.signature) throw new Error(`breakSignature: ${target} carries no signature`);

  /*
   * Corrupt the signature itself, not its status.
   *
   * This used to set `status = 'INVALID'` — which, once verification became
   * real, would have been overwritten by the verifier on the next pass and the
   * tamper would have silently undone itself. Flipping bits in the signature
   * means the demo fails for the reason it claims to: the ECDSA check does not
   * pass. One character is enough, and base64url has no padding to preserve.
   */
  const sig = item.signature as { status: string; value?: string };
  if (!sig.value) throw new Error(`breakSignature: ${target}'s signature carries no value to corrupt`);
  const i = Math.floor(sig.value.length / 2);
  const ch = sig.value[i] === 'A' ? 'B' : 'A';
  sig.value = sig.value.slice(0, i) + ch + sig.value.slice(i + 1);
  // The declared status is cleared rather than set: a verdict here would be a
  // claim, and the verifier is what produces one.
  delete (sig as { checked?: boolean }).checked;

  tag(ev, `${target} signature bytes corrupted`);
  return ev;
}

/**
 * Remove a document, moving it from attached to cited-only.
 *
 * Modelled as "referenced but not supplied" rather than deleted outright,
 * because that is what actually happens in a submission — and it is what makes
 * the result `INCOMPLETE` rather than looking like forgery.
 */
export function removeDocument(evidence: SettlementEvidence, document: string): SettlementEvidence {
  const ev = clone(evidence);
  const docs = ev.elements.commercialDocs;
  if (!docs) throw new Error('removeDocument: no commercialDocs present');
  docs.attached = (docs.attached ?? []).filter((d) => d !== document);
  docs.citedOnly = [...new Set([...(docs.citedOnly ?? []), document])];

  // An invoice that is no longer attached cannot supply an amount to reconcile.
  if (document.toLowerCase().includes('invoice')) {
    delete docs.amount;
    /*
     * And with the document withheld, its signature is not ours to check.
     *
     * The amount is content the seller signed, so removing it does break the
     * signature — but reporting `INVALID` here would be a false accusation.
     * `INVALID` means "someone altered a document the issuer signed";
     * what actually happened is that the submission never included the
     * document, so there is no signed invoice in front of us to verify.
     *
     * `ABSENT` is the accurate reading, and it is the one that keeps scenario
     * D's lesson intact: a forgotten invoice is `INCOMPLETE` and calls for a
     * request, while a forged one is `INVALID` and calls for escalation.
     * Letting a withheld document read as forgery would send the reviewer down
     * precisely the wrong path.
     */
    if (docs.signature) docs.signature = { status: 'ABSENT', checked: true };
  }

  tag(ev, `${document} removed from the submission`);
  return ev;
}

/** Corrupt the bytes behind a digest, so integrity fails but signatures do not. */
export function breakDigest(
  evidence: SettlementEvidence, target: SignatureTarget, receiptIndex = 0,
): SettlementEvidence {
  const ev = clone(evidence);
  const el = ev.elements;
  const item = target === 'payoutReceipt'
    ? el.payoutReceipts?.[receiptIndex]
    : (el as Record<string, { digestVerified?: boolean } | undefined>)[target];
  if (!item) throw new Error(`breakDigest: no ${target} to modify`);
  item.digestVerified = false;
  tag(ev, `${target} document bytes altered`);
  return ev;
}

/** Split a single payout into two, for exercising the aggregation rules. */
export function splitPayout(
  evidence: SettlementEvidence, firstAmount: string, secondAmount: string,
): SettlementEvidence {
  if (typeof firstAmount !== 'string' || typeof secondAmount !== 'string') {
    throw new Error('splitPayout: amounts must be decimal strings');
  }
  const ev = clone(evidence);
  const base = ev.elements.payoutReceipts?.[0];
  if (!base) throw new Error('splitPayout: no payout receipt to split');
  const second = clone(base);
  base.amount = firstAmount;
  second.amount = secondAmount;
  second.ref = base.ref ? `${base.ref}-2` : undefined;

  /*
   * Both halves lose their issuer signature.
   *
   * The provider signed one receipt for the full amount; it did not sign these
   * two. Re-signing is impossible here on purpose — the library holds no
   * private keys — and leaving the original signature in place would assert
   * that the provider signed a document it never saw. `ABSENT` is the only
   * accurate statement, and the engine reads it as "origin unestablished"
   * rather than as a forgery, which is the correct reading of a split a
   * reviewer synthesised in a demo.
   */
  for (const r of [base, second]) {
    if (r.signature) r.signature = { status: 'ABSENT', checked: true };
  }

  ev.elements.payoutReceipts = [base, second];
  tag(ev, `payout split into ${firstAmount} + ${secondAmount} (issuer signatures voided — the provider signed neither half)`);
  return ev;
}

/**
 * Present the same payout receipt twice.
 *
 * Unlike every other transform here, this one breaks nothing. The copy keeps
 * its digest and its issuer signature, because the provider really did sign
 * that receipt — resubmitting a genuine document forges nothing. What is false
 * is the claim assembled on top of it: one settlement discharging an
 * obligation twice.
 *
 * That is why it belongs in the catalogue. Integrity passes, the issuer
 * passes, and the payment still must not be released — the case that a single
 * green tick cannot express, and the one a reviewer most needs to see.
 */
export function duplicateReceipt(evidence: SettlementEvidence): SettlementEvidence {
  const ev = clone(evidence);
  const first = ev.elements.payoutReceipts?.[0];
  if (!first) throw new Error('duplicateReceipt: no payout receipt to duplicate');
  ev.elements.payoutReceipts = [first, clone(first)];
  tag(ev, `payout ${first.ref ?? 'receipt'} submitted twice (document untouched — the claim is what repeats)`);
  return ev;
}
