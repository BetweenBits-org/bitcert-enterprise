/**
 * The external-signer path: a key that lives in an HSM or KMS and cannot
 * leave it.
 *
 * Node's own crypto stands in for the hardware here, which is fair: what the
 * SDK sees in both cases is only a function that returns signature bytes.
 * What these tests pin down is the part that actually goes wrong in the
 * field — devices emit DER where WebCrypto emits raw `r‖s`, text where the
 * tool expects binary — and the claim that nothing unverifiable is ever
 * emitted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statementLeaf, statementSigningInput, verifyStatement } from '@stonehash/attest-verify';
import type { SignedStatement, StatementCore } from '../src/index.ts';
import { buildStatement, deriveKeyId, signPreparedStatementWith, signStatementWith } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../src/cli.ts');
const DIGEST = 'a'.repeat(64);

/** A stand-in HSM: P-256 keypair, signing via node:crypto, key not exported to the SDK. */
function ecDevice(): {
  spkiBase64: string;
  signRaw(input: Uint8Array): Uint8Array;
  signDer(input: Uint8Array): Uint8Array;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const sign = (input: Uint8Array, dsaEncoding?: 'ieee-p1363'): Uint8Array =>
    new Uint8Array(createSign('SHA256').update(input).sign(
      dsaEncoding ? { key: privateKey, dsaEncoding } : privateKey));
  return {
    spkiBase64,
    signRaw: (input) => sign(input, 'ieee-p1363'),
    signDer: (input) => sign(input),
  };
}

test('a raw r‖s signature from outside verifies in the independent verifier', async () => {
  const device = ecDevice();
  const signed = await signStatementWith({
    algorithm: 'ES256',
    publicKeySpkiBase64: device.spkiBase64,
    sign: (input) => device.signRaw(input),
  }, { documentSha256: DIGEST, contentType: 'application/pdf' });

  const v = await verifyStatement(signed, statementLeaf(signed));
  assert.equal(v.signatureOk, true);
  assert.equal(v.leafOk, true);
  assert.equal(signed.issuer.key_id, await deriveKeyId(device.spkiBase64),
    'the key id must be derivable from the public half alone');
});

test('a DER signature is normalised to the 64 raw bytes the format wants', async () => {
  const device = ecDevice();
  const signed = await signStatementWith({
    algorithm: 'ES256',
    publicKeySpkiBase64: device.spkiBase64,
    sign: (input) => device.signDer(input),
  }, { documentSha256: DIGEST });

  assert.equal(signed.signature.length, 86,
    'raw 64 bytes encode to 86 base64url characters; DER would be longer');
  assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
});

test('DER whose r needs a sign-padding zero still converts', async () => {
  const device = ecDevice();
  const core = buildStatement({
    documentSha256: DIGEST,
    keyId: await deriveKeyId(device.spkiBase64),
    publicKeySpkiBase64: device.spkiBase64,
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  const input = statementSigningInput(core);

  // ECDSA draws a fresh nonce per signature, so r's top bit is set about
  // every other try; 64 misses in a row has probability 2^-64.
  let padded: Uint8Array | undefined;
  for (let i = 0; i < 64 && !padded; i++) {
    const der = device.signDer(input);
    if (der[3] === 0x21) padded = der;
  }
  assert.ok(padded, 'no padded-r signature in 64 draws');

  const signed = await signPreparedStatementWith(
    { algorithm: 'ES256', sign: () => padded! }, core);
  assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
});

test('an RSA device works the same way', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signed = await signStatementWith({
    algorithm: 'RS256',
    publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (input) => new Uint8Array(createSign('RSA-SHA256').update(input).sign(privateKey)),
  }, { documentSha256: DIGEST });
  assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
});

test('a device that signed the wrong bytes is caught before anything is emitted', async () => {
  const device = ecDevice();
  await assert.rejects(
    signStatementWith({
      algorithm: 'ES256',
      publicKeySpkiBase64: device.spkiBase64,
      sign: () => device.signRaw(new TextEncoder().encode('not the statement')),
    }, { documentSha256: DIGEST }),
    /does not verify/);
});

test('bytes that are neither raw nor DER are named as the problem', async () => {
  const device = ecDevice();
  await assert.rejects(
    signStatementWith({
      algorithm: 'ES256',
      publicKeySpkiBase64: device.spkiBase64,
      sign: () => randomBytes(50),
    }, { documentSha256: DIGEST }),
    /64 raw bytes or their DER/);
});

// ── the CLI, end to end: prepare → sign elsewhere → assemble ───────────────

function run(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

test('prepare → external DER signature → assemble, from a PEM public key', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attest-sign-ext-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(path.join(dir, 'issuer-public.pem'),
    publicKey.export({ type: 'spki', format: 'pem' }) as string);
  writeFileSync(path.join(dir, 'contract.txt'), 'INVOICE 2026-0042\nUSD 95,000.00\n');

  const prep = run(dir, ['prepare', '--file', 'contract.txt',
    '--public-key', 'issuer-public.pem', '--content-type', 'text/plain']);
  assert.equal(prep.status, 0, prep.stderr);
  assert.match(prep.stderr, /sign these\s+signing-input\.bin/);

  const core = JSON.parse(readFileSync(path.join(dir, 'prepared.json'), 'utf8')) as StatementCore;
  assert.equal(core.issuer.algorithm, 'ES256', 'the algorithm must be inferred from the PEM');
  assert.match(core.issuer.key_id, /^ik_[0-9a-f]{16}$/);

  const input = readFileSync(path.join(dir, 'signing-input.bin'));
  assert.deepEqual(new Uint8Array(input), statementSigningInput(core),
    'the bytes on disk must be exactly what the SDK would sign');

  // "The HSM": OpenSSL-style DER over the input file.
  writeFileSync(path.join(dir, 'sig.der'),
    createSign('SHA256').update(input).sign(privateKey));

  const asm = run(dir, ['assemble', '--statement', 'prepared.json',
    '--signature', 'sig.der', '--out', 'signed.json']);
  assert.equal(asm.status, 0, asm.stderr);
  assert.match(asm.stderr, /signature verified/);

  const signed = JSON.parse(readFileSync(path.join(dir, 'signed.json'), 'utf8')) as SignedStatement;
  const leaf = statementLeaf(signed);
  assert.match(asm.stderr, new RegExp(`anchor leaf\\s+${leaf}`),
    'the leaf the operator reads must be the leaf the service will anchor');
  const v = await verifyStatement(signed, leaf);
  assert.equal(v.signatureOk, true);
  assert.equal(v.leafOk, true);
});

test('assemble accepts the signature as base64 text, as a KMS CLI emits it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attest-sign-b64-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(path.join(dir, 'pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }) as string);

  const prep = run(dir, ['prepare', '--digest', DIGEST, '--public-key', 'pub.pem']);
  assert.equal(prep.status, 0, prep.stderr);

  const input = readFileSync(path.join(dir, 'signing-input.bin'));
  writeFileSync(path.join(dir, 'sig.b64'),
    `${createSign('SHA256').update(input).sign(privateKey).toString('base64')}\n`);

  const asm = run(dir, ['assemble', '--statement', 'prepared.json', '--signature', 'sig.b64']);
  assert.equal(asm.status, 0, asm.stderr);
  const signed = JSON.parse(asm.stdout) as SignedStatement;
  assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
});

test('a tampered signature never leaves assemble', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attest-sign-bad-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(path.join(dir, 'pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }) as string);
  assert.equal(run(dir, ['prepare', '--digest', DIGEST, '--public-key', 'pub.pem']).status, 0);

  const input = readFileSync(path.join(dir, 'signing-input.bin'));
  const sig = createSign('SHA256').update(input).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  sig[20] = (sig[20] ?? 0) ^ 0xff;
  writeFileSync(path.join(dir, 'sig.raw'), sig);

  const asm = run(dir, ['assemble', '--statement', 'prepared.json', '--signature', 'sig.raw']);
  assert.notEqual(asm.status, 0, 'assemble must refuse to emit an unverifiable statement');
  assert.match(asm.stderr, /does not verify/);
});

test('prepare --statement emits the bytes for a console-composed statement', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attest-sign-con-'));
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const core = buildStatement({
    documentSha256: DIGEST,
    keyId: await deriveKeyId(spkiBase64),
    publicKeySpkiBase64: spkiBase64,
    issuedAt: '2026-01-01T00:00:00.000Z',
  });
  writeFileSync(path.join(dir, 'from-console.json'), JSON.stringify(core));

  const prep = run(dir, ['prepare', '--statement', 'from-console.json', '--input-out', 'input.bin']);
  assert.equal(prep.status, 0, prep.stderr);
  assert.deepEqual(new Uint8Array(readFileSync(path.join(dir, 'input.bin'))),
    statementSigningInput(core));
});
