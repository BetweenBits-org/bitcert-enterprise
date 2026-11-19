/**
 * The statement, checked the way three independent programs will meet it.
 *
 * The signing SDK runs offline on a customer's machine, the service anchors
 * the result, and this verifier reads it back years later. None of them share
 * a process, so the only thing holding them together is that all three
 * produce the same bytes from the same statement. These tests pin those bytes
 * and the two properties that make the design worth having:
 *
 *  - the signature covers the statement **without** itself, and
 *  - the leaf covers the statement **with** it.
 *
 * Get the second wrong and the signature is not timestamped, which is the
 * entire reason the signature goes near a blockchain at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATEMENT_DOMAIN, STATEMENT_SCHEMA,
  buildStatement, statementLeaf, statementSigningInput, verifyStatement,
} from '../src/index.ts';
import type { SignedStatement, StatementCore } from '../src/index.ts';

const b64 = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64');
const b64url = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

async function keypair(alg: 'ES256' | 'RS256' = 'ES256'): Promise<{
  core: (digest: string) => StatementCore;
  sign: (core: StatementCore) => Promise<SignedStatement>;
  spki: string;
}> {
  const params = alg === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' } as const
    : {
        name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
      } as const;
  const kp = await crypto.subtle.generateKey(params, true, ['sign', 'verify']) as CryptoKeyPair;
  const spki = b64(await crypto.subtle.exportKey('spki', kp.publicKey));
  const core = (digest: string): StatementCore => buildStatement({
    documentSha256: digest,
    contentType: 'application/pdf',
    keyId: 'ik_test_01',
    algorithm: alg,
    publicKeySpkiBase64: spki,
    issuedAt: '2026-11-06T05:00:00.000Z',
  });
  const sign = async (c: StatementCore): Promise<SignedStatement> => {
    const sigAlg = alg === 'ES256'
      ? { name: 'ECDSA', hash: 'SHA-256' } as const
      : { name: 'RSASSA-PKCS1-v1_5' } as const;
    const sig = await crypto.subtle.sign(
      sigAlg, kp.privateKey, statementSigningInput(c) as BufferSource);
    return { ...c, signature: b64url(sig) };
  };
  return { core, sign, spki };
}

const DIGEST = 'a'.repeat(64);

test('the signing input is the domain separator followed by canonical JSON', () => {
  const core = buildStatement({
    documentSha256: DIGEST, keyId: 'k', publicKeySpkiBase64: 'AA==',
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  const bytes = statementSigningInput(core);
  const text = Buffer.from(bytes).toString('utf8');
  assert.ok(text.startsWith(STATEMENT_DOMAIN), 'the domain separator must come first');

  // JCS sorts keys, so the remainder is byte-predictable and a second
  // implementation can be compared against this string directly.
  const json = text.slice(STATEMENT_DOMAIN.length);
  assert.equal(json,
    '{"document":{"sha256":"' + DIGEST + '"},'
    + '"issued_at":"2026-01-01T00:00:00.000Z",'
    + '"issuer":{"algorithm":"ES256","key_id":"k","public_key":"AA=="},'
    + '"schema":"' + STATEMENT_SCHEMA + '"}');
});

test('the signature does not cover itself, but the leaf does', async () => {
  const { core, sign } = await keypair();
  const c = core(DIGEST);
  const signed = await sign(c);

  // Signing input is identical before and after the signature is attached —
  // otherwise it could never verify.
  assert.equal(
    Buffer.from(statementSigningInput(c)).toString('hex'),
    Buffer.from(statementSigningInput(signed)).toString('hex'));

  // The leaf, by contrast, must move when the signature changes. If it did
  // not, the chain would not be committing to the signature and the whole
  // construction would prove authorship without time.
  const tampered: SignedStatement = { ...signed, signature: b64url(new Uint8Array(64).fill(7)) };
  assert.notEqual(statementLeaf(signed), statementLeaf(tampered),
    'the leaf must commit to the signature');
});

test('a correctly signed statement verifies against its anchored leaf', async () => {
  const { core, sign } = await keypair();
  const signed = await sign(core(DIGEST));
  const v = await verifyStatement(signed, statementLeaf(signed));
  assert.equal(v.signatureOk, true);
  assert.equal(v.leafOk, true);
  assert.equal(v.keyId, 'ik_test_01');
  assert.equal(v.error, undefined);
});

test('RSA is accepted, because banks cannot replace the hardware holding their keys', async () => {
  const { core, sign } = await keypair('RS256');
  const signed = await sign(core(DIGEST));
  const v = await verifyStatement(signed, statementLeaf(signed));
  assert.equal(v.signatureOk, true);
  assert.equal(v.leafOk, true);
  assert.equal(v.algorithm, 'RS256');
});

test('the two failures are reported apart, because they mean different things', async () => {
  const { core, sign } = await keypair();
  const signed = await sign(core(DIGEST));

  // Right statement, wrong anchor: someone attached a valid statement to a
  // record it does not belong to.
  const wrongLeaf = await verifyStatement(signed, 'b'.repeat(64));
  assert.equal(wrongLeaf.signatureOk, true);
  assert.equal(wrongLeaf.leafOk, false);

  // Right anchor, broken signature: the content was edited after signing.
  const edited: SignedStatement = {
    ...signed, document: { ...signed.document, sha256: 'c'.repeat(64) },
  };
  const brokenSig = await verifyStatement(edited, statementLeaf(edited));
  assert.equal(brokenSig.leafOk, true, 'the leaf still matches the edited statement');
  assert.equal(brokenSig.signatureOk, false, 'but the signature no longer covers it');
});

test('a statement signed by one key does not verify under another', async () => {
  const a = await keypair();
  const b = await keypair();
  const signed = await a.sign(a.core(DIGEST));
  // Swap in B's public key, keeping A's signature.
  const impostor: SignedStatement = {
    ...signed, issuer: { ...signed.issuer, public_key: b.spki },
  };
  const v = await verifyStatement(impostor, statementLeaf(impostor));
  assert.equal(v.signatureOk, false);
});

test('malformed statements are refused before a signature is made over them', () => {
  const ok = {
    documentSha256: DIGEST, keyId: 'k', publicKeySpkiBase64: 'AA==',
    issuedAt: '2026-01-01T00:00:00.000Z',
  };
  assert.throws(() => buildStatement({ ...ok, documentSha256: 'nothex' }), /64 lowercase hex/);
  // Uppercase is normalised rather than refused: the digest means the same
  // thing either way, and what matters is that the *signed* form is
  // canonical. Rejecting would just push the lowercasing onto every caller,
  // where one of them would forget.
  assert.equal(
    buildStatement({ ...ok, documentSha256: DIGEST.toUpperCase() }).document.sha256, DIGEST);
  assert.throws(() => buildStatement({ ...ok, keyId: '' }), /key_id/);
  assert.throws(() => buildStatement({ ...ok, publicKeySpkiBase64: '' }), /public_key/);
  assert.throws(() => buildStatement({ ...ok, issuedAt: 'whenever' }), /ISO-8601/);
  assert.throws(
    () => buildStatement({ ...ok, algorithm: 'HS256' as unknown as 'ES256' }),
    /unsupported algorithm/);
});

test('an unpadded base64url signature verifies, as every ES256 one is', async () => {
  /*
   * 64 bytes encode to 86 base64url characters, and base64url drops the two
   * `=` that would make that a multiple of 4. Node's Buffer accepts the short
   * form; `atob` does not always. Without re-padding, every ES256 signature
   * verified under `node --test` and failed in a browser — reported merely as
   * "the signature does not verify", which points nowhere near the cause.
   */
  const { core, sign } = await keypair();
  const signed = await sign(core(DIGEST));
  assert.equal(signed.signature.length % 4, 2, 'the fixture must exercise the unpadded case');
  assert.doesNotMatch(signed.signature, /=/);
  assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
});

test('verification reports an error rather than throwing on junk input', async () => {
  const v = await verifyStatement({ } as unknown as SignedStatement, DIGEST);
  assert.equal(v.signatureOk, false);
  assert.ok(v.error, 'a malformed statement should be reported, not thrown');
});

test('P-256 verification works without WebCrypto, which plain-http pages lack', async () => {
  /*
   * The console and the Playground are served over `http://` at an IP, where
   * `crypto.subtle` is `undefined`. Before the fallback existed, every
   * signature check on those pages threw inside `verifyStatement` and was
   * reported as "the signature does not verify" — a wrong answer, on the one
   * screen whose job is to give the right one.
   *
   * The subtle-backed path has to produce the signature (there is no signer
   * in this package), so the test signs first and then hides `subtle` for the
   * verification, which is exactly the asymmetry those deployments have.
   */
  const { core, sign } = await keypair();
  const signed = await sign(core(DIGEST));
  const leaf = statementLeaf(signed);

  const real = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: real.getRandomValues.bind(real) },
      configurable: true,
    });
    assert.equal(globalThis.crypto.subtle, undefined, 'the fixture must actually remove subtle');
    const v = await verifyStatement(signed, leaf);
    assert.equal(v.signatureOk, true, 'the pure-JS path must agree with WebCrypto');
    assert.equal(v.leafOk, true);

    // And it must still reject what WebCrypto rejects.
    const tampered = { ...signed, document: { ...signed.document, sha256: 'e'.repeat(64) } };
    assert.equal((await verifyStatement(tampered, statementLeaf(tampered))).signatureOk, false);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('the pure-JS verifier agrees with WebCrypto across many random keys', async () => {
  // One pair proves the happy path; a hand-written curve fails on particular
  // values, so this walks a spread of them.
  const { verifyP256 } = await import('../src/p256.ts');
  for (let i = 0; i < 12; i++) {
    const { core, sign } = await keypair();
    const signed = await sign(core(DIGEST.slice(0, 63) + (i % 10)));
    const input = statementSigningInput(signed);
    const b = (x: string): Uint8Array => {
      const t = x.replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(Buffer.from(t + '='.repeat((4 - t.length % 4) % 4), 'base64'));
    };
    assert.equal(
      verifyP256(b(signed.signature), input, b(signed.issuer.public_key)), true,
      `pure-JS verification disagreed on iteration ${i}`);
    // A flipped bit in the message must fail.
    const bad = Uint8Array.from(input); bad[bad.length - 1]! ^= 1;
    assert.equal(verifyP256(b(signed.signature), bad, b(signed.issuer.public_key)), false);
  }
});
