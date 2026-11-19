/**
 * Issuer-signature verification.
 *
 * The thing being guarded here is specific. `Signature.status` used to arrive in
 * the evidence document as a claim, and the engine believed it: a fixture
 * saying `"status": "VALID"` rendered as `ISSUER VALID` on the Bank Review
 * screen with no cryptography having run anywhere. These tests pin both halves
 * of the fix — that real ECDSA now runs, and that an unverified status cannot
 * pass for a verified one.
 *
 * ## What the `checked` marker is and is not
 *
 * It stops the system presenting unverified signatures as verified — a caller
 * who forgets `verifyEvidenceSignatures` loses the issuer axis instead of
 * silently gaining it. It is **not** an authentication boundary, and nothing
 * here pretends otherwise: a hostile document can write `checked: true` into
 * its own JSON. That is not a privilege escalation, because the caller of
 * `/v1/settlements/reconcile` supplies the evidence *and* the policy and gets
 * the verdict back; forging a verdict for yourself fools nobody. The failure
 * worth engineering against is the accidental one, and it is the one that
 * actually happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEMO_ISSUER_KEYS, DEMO_KEYRING, evaluate, keyring, signedBytes, signedDigest,
  SIGNATURE_DOMAIN, toBase64Url, fromBase64Url, verifyEvidenceSignatures, verifySignature,
} from '../src/index.ts';
import type { Policy, SettlementEvidence } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): unknown => JSON.parse(readFileSync(path.resolve(HERE, '..', rel), 'utf8'));
const RAW = read('fixtures/a-normal-trade-payment.json') as SettlementEvidence;
const POLICY = read('policies/settlement-match-v1.json') as Policy;
const KEYS = read('keys/demo-issuers.json') as {
  keys: { keyId: string; issuer: string; trustLevel: string; publicKeyJwk: JsonWebKey; privateKeyJwk: JsonWebKey }[];
};

const fresh = (): SettlementEvidence => structuredClone(RAW);
const codes = (ev: SettlementEvidence, p: Policy = POLICY): string[] =>
  evaluate(ev, p).findings.map((f) => f.code);

// ── the keyring ────────────────────────────────────────────────────────────
test('the embedded public keys match the generated keyring', () => {
  // `src/demo-keys.ts` is generated from `keys/demo-issuers.json`. If the
  // keyring is regenerated and the module is not, every fixture signature
  // fails for a reason that looks like corruption.
  assert.equal(DEMO_ISSUER_KEYS.length, KEYS.keys.length);
  for (const k of KEYS.keys) {
    const embedded = DEMO_ISSUER_KEYS.find((x) => x.keyId === k.keyId);
    assert.ok(embedded, `${k.keyId} is missing from src/demo-keys.ts`);
    assert.deepEqual(embedded.publicKeyJwk, k.publicKeyJwk, `${k.keyId}: public key drifted`);
    assert.equal(embedded.issuer, k.issuer);
  }
});

test('the embedded keys carry no private material', () => {
  // Shipped to the browser. A `d` parameter here would publish a signing key.
  for (const k of DEMO_ISSUER_KEYS) {
    assert.equal((k.publicKeyJwk as { d?: string }).d, undefined, `${k.keyId} embeds a private scalar`);
    assert.equal(k.publicKeyJwk.crv, 'P-256');
    assert.equal(k.publicKeyJwk.kty, 'EC');
  }
});

test('every demo key is pinned to DEMO trust', () => {
  // The identity row is fixed at "demonstration key" for P0 and P1. A demo key
  // labelled ATTESTED would let the synthetic fixtures satisfy a policy that
  // asks for an established issuer, which is the claim they must never make.
  for (const k of DEMO_ISSUER_KEYS) assert.equal(k.trustLevel, 'DEMO', `${k.keyId}`);
});

// ── the signed payload ─────────────────────────────────────────────────────
test('the signed payload is domain-separated canonical JSON', () => {
  const bytes = signedBytes(RAW.elements.commercialDocs);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith(SIGNATURE_DOMAIN), 'missing the domain separator');
  // RFC 8785: keys sorted, no insignificant whitespace. A signature over
  // non-canonical bytes would verify on one machine and fail on another.
  const json = text.slice(SIGNATURE_DOMAIN.length);
  const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
  assert.deepEqual(keys, [...keys].sort(), 'object keys are not canonically ordered');
  assert.ok(!/\n|  /.test(json), 'canonical JSON carries no insignificant whitespace');
});

test('the signature is not an input to itself', () => {
  const text = new TextDecoder().decode(signedBytes(RAW.elements.commercialDocs));
  assert.ok(!text.includes('signature'), 'the signature field reached its own payload');
});

/**
 * The exclusions that keep the six axes independent. Each of these would
 * otherwise make the issuer axis move for a reason that is not about the issuer.
 */
test('locally-computed and submission-packaging fields are not signed', () => {
  const base = signedDigest(RAW.elements.commercialDocs);
  for (const field of ['digestVerified', 'attached', 'citedOnly'] as const) {
    const el = structuredClone(RAW.elements.commercialDocs)!;
    (el as Record<string, unknown>)[field] =
      field === 'digestVerified' ? false : ['something-else'];
    assert.equal(signedDigest(el), base,
      `${field} is covered by the signature; changing it must not disturb the issuer axis`);
  }
});

test('issuer-asserted content IS signed', () => {
  const base = signedDigest(RAW.elements.commercialDocs);
  for (const field of ['amount', 'currency', 'invoiceRef', 'buyer', 'seller', 'digest'] as const) {
    const el = structuredClone(RAW.elements.commercialDocs)!;
    (el as Record<string, unknown>)[field] = 'tampered';
    assert.notEqual(signedDigest(el), base, `${field} is not covered by the signature`);
  }
});

test('base64url round-trips', () => {
  for (const n of [0, 1, 2, 3, 31, 64, 65]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(fromBase64Url(toBase64Url(b)), b, `length ${n}`);
  }
  assert.ok(!/[+/=]/.test(toBase64Url(new Uint8Array([251, 255, 254]))), 'not url-safe');
});

// ── verification ───────────────────────────────────────────────────────────
test('the fixture signatures verify against the published keys', async () => {
  const ev = await verifyEvidenceSignatures(fresh(), DEMO_KEYRING);
  const sig = ev.elements.commercialDocs!.signature!;
  assert.equal(sig.checked, true);
  assert.equal(sig.status, 'DEMO_VALID');
  assert.equal(sig.keyId, 'demo-seller-key-01');
  assert.equal(sig.trustLevel, 'DEMO');
});

test('a verified demo signature is DEMO_VALID, never VALID', async () => {
  // One word must not imply the other: the arithmetic held, the identity did
  // not. Reporting `VALID` for a key that establishes nothing is the single
  // most misleading thing this module could do.
  const ev = await verifyEvidenceSignatures(fresh(), DEMO_KEYRING);
  for (const el of [ev.elements.commercialDocs, ev.elements.bankInstruction, ev.elements.payoutReceipts?.[0]]) {
    if (el?.signature && el.signature.status !== 'ABSENT') {
      assert.equal(el.signature.status, 'DEMO_VALID', 'a DEMO-trust key produced a non-DEMO verdict');
    }
  }
});

test('editing signed content makes the signature fail', async () => {
  const ev = fresh();
  ev.elements.commercialDocs!.amount = '49999.99';
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(checked.elements.commercialDocs!.signature!.status, 'INVALID');
  assert.ok(codes(checked).includes('SIGNATURE_INVALID'));
});

test('corrupting the signature bytes makes it fail', async () => {
  const ev = fresh();
  const sig = ev.elements.commercialDocs!.signature!;
  const v = sig.value!;
  const i = Math.floor(v.length / 2);
  sig.value = v.slice(0, i) + (v[i] === 'A' ? 'B' : 'A') + v.slice(i + 1);
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(checked.elements.commercialDocs!.signature!.status, 'INVALID');
});

test('a signature from the wrong key fails rather than passing on its label', async () => {
  // The bank's signature, relabelled as the seller's. The declared `keyId` is
  // what gets looked up, so this checks a real signature against a real key
  // that did not produce it.
  const ev = fresh();
  ev.elements.commercialDocs!.signature!.value = ev.elements.bankInstruction!.signature!.value;
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(checked.elements.commercialDocs!.signature!.status, 'INVALID');
});

test('an unknown key is UNKNOWN_KEY and inherits no trust from the document', async () => {
  const ev = fresh();
  ev.elements.commercialDocs!.signature!.keyId = 'not-in-the-keyring';
  ev.elements.commercialDocs!.signature!.trustLevel = 'ACCREDITED';
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  const sig = checked.elements.commercialDocs!.signature!;
  assert.equal(sig.status, 'UNKNOWN_KEY');
  assert.equal(sig.trustLevel, undefined, 'trust must come from the keyring, never from the evidence');
  assert.ok(codes(checked).includes('SIGNATURE_UNKNOWN_KEY'));
});

test('a status claimed without a signature value reads as ABSENT', async () => {
  // A document asserting VALID while carrying nothing to check is not evidence
  // of anything, and "absent" is the honest reading of it.
  const ev = fresh();
  ev.elements.commercialDocs!.signature = { status: 'VALID', keyId: 'demo-seller-key-01' };
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(checked.elements.commercialDocs!.signature!.status, 'ABSENT');
  assert.equal(checked.elements.commercialDocs!.signature!.checked, true);
});

test('a malformed signature value fails instead of throwing', async () => {
  // The reviewer's screen has to render. A crash here would take out the whole
  // verdict over one bad field.
  const ev = fresh();
  ev.elements.commercialDocs!.signature!.value = 'not-base64url-$$$';
  const checked = await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(checked.elements.commercialDocs!.signature!.status, 'INVALID');
});

test('verification does not mutate the caller’s evidence', async () => {
  const ev = fresh();
  const before = JSON.stringify(ev);
  await verifyEvidenceSignatures(ev, DEMO_KEYRING);
  assert.equal(JSON.stringify(ev), before,
    'the engine is deterministic only if evaluating twice cannot differ');
});

test('an unsigned public-ledger observation stays absent, not failed', async () => {
  // chainTransfer has no issuer — a public ledger does not sign anything — so
  // its lack of a signature must not be reported as a verification failure.
  const ev = await verifyEvidenceSignatures(fresh(), DEMO_KEYRING);
  assert.equal(ev.elements.chainTransfer!.signature!.status, 'ABSENT');
  assert.ok(!codes(ev).includes('SIGNATURE_INVALID'));
});

// ── the regression this whole module exists for ────────────────────────────
test('an unverified status carries no weight, however good it looks', () => {
  // This is the bug. Before `checked` existed the engine read this as a
  // verified signature from an accredited issuer and the review screen said so.
  const ev = fresh();
  ev.elements.commercialDocs!.signature = {
    status: 'VALID', keyId: 'demo-seller-key-01', trustLevel: 'ACCREDITED', issuer: 'DEMO_SELLER',
  };
  const r = evaluate(ev, POLICY);
  assert.notEqual(r.axes.issuer.state, 'VALID', 'an unverified signature reached a VALID issuer axis');
  assert.ok(r.findings.some((f) => f.code === 'SIGNATURE_NOT_CHECKED'),
    'the verdict must say the signature was never checked');
});

test('skipping verification costs the issuer axis rather than granting it', () => {
  // The fixture's signatures are real and would verify. Not running the
  // verifier must still not credit them.
  const r = evaluate(fresh(), POLICY);
  assert.equal(r.axes.issuer.state, 'UNKNOWN_ISSUER');
  assert.ok(r.findings.filter((f) => f.code === 'SIGNATURE_NOT_CHECKED').length >= 3);
});

test('business finality cannot be established by an unverified receipt', () => {
  const ev = fresh();
  ev.dataMode = 'LIVE';
  ev.notRealPayment = false;
  ev.elements.payoutReceipts![0]!.signature = {
    status: 'VALID', keyId: 'demo-provider-key-01', trustLevel: 'ACCREDITED',
  };
  assert.notEqual(evaluate(ev, POLICY).axes.businessFinality.state, 'VERIFIED_BY_SOURCE',
    'money moving was confirmed by a signature nobody verified');
});

test('a demo key cannot satisfy a policy requiring an attested issuer', async () => {
  const ev = await verifyEvidenceSignatures(fresh(), DEMO_KEYRING);
  for (const need of ['ATTESTED', 'ACCREDITED'] as const) {
    const r = evaluate(ev, { ...POLICY, sourceTrustLevel: need });
    assert.equal(r.axes.issuer.state, 'UNKNOWN_ISSUER', `policy requiring ${need}`);
    assert.ok(r.findings.some((f) => f.code === 'ISSUER_TRUST_INSUFFICIENT'));
  }
});

test('trust comes from the keyring the verifier was handed', async () => {
  // The same bytes, the same keys, a different keyring: the operator decides
  // what a key is worth, and the evidence document never does.
  const attested = keyring(DEMO_ISSUER_KEYS.map((k) => ({ ...k, trustLevel: 'ATTESTED' as const })));
  const ev = await verifyEvidenceSignatures(fresh(), attested);
  assert.equal(ev.elements.commercialDocs!.signature!.status, 'VALID');
  assert.equal(evaluate(ev, POLICY).axes.issuer.state, 'VALID');
});

test('verifySignature reports on a single element', async () => {
  const sig = await verifySignature(RAW.elements.bankInstruction, DEMO_KEYRING);
  assert.equal(sig.status, 'DEMO_VALID');
  assert.equal(sig.checked, true);
  assert.equal(sig.issuer, 'DEMO_BANK');
});

test('keyring rejects a duplicate keyId', () => {
  // Two keys under one id means verification depends on insertion order.
  assert.throws(() => keyring([DEMO_ISSUER_KEYS[0]!, DEMO_ISSUER_KEYS[0]!]), /duplicate keyId/);
});
