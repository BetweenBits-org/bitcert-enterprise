/**
 * The signer, checked against the verifier that will read its output.
 *
 * This package exists so a customer's offline signature verifies years later
 * in code they did not run. The only way to know that holds is to sign here
 * and verify with `@stonehash/attest-verify` — never with a helper written
 * alongside the signer, which would agree with it about any shared mistake.
 *
 * The other half of the file is about a negative claim. "We never receive
 * your private key" is the reason this tool exists, and a claim like that is
 * worth a test, not a sentence in a README.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statementLeaf, verifyStatement } from '@stonehash/attest-verify';
import { generateKey, signPreparedStatement, signStatement, buildStatement } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DIGEST = 'd'.repeat(64);

test('a signature made here verifies in the independent verifier', async () => {
  const key = await generateKey();
  const signed = await signStatement(key, {
    documentSha256: DIGEST, contentType: 'application/pdf',
  });
  const v = await verifyStatement(signed, statementLeaf(signed));
  assert.equal(v.signatureOk, true, 'the verifier rejected our signature');
  assert.equal(v.leafOk, true);
  assert.equal(v.keyId, key.keyId);
});

test('RSA signatures verify too', async () => {
  const key = await generateKey('RS256');
  const signed = await signStatement(key, { documentSha256: DIGEST });
  const v = await verifyStatement(signed, statementLeaf(signed));
  assert.equal(v.signatureOk, true);
  assert.equal(v.algorithm, 'RS256');
});

test('signing a console-prepared statement gives the same result as building one', async () => {
  /*
   * The console shows the operator the exact statement it will anchor and
   * offers it as a download. Signing that file must be equivalent to the
   * SDK composing the same statement itself — if the two paths could differ,
   * the preview would be a lie.
   */
  const key = await generateKey();
  const issuedAt = '2026-11-06T05:00:00.000Z';
  const prepared = buildStatement({
    documentSha256: DIGEST,
    contentType: 'application/pdf',
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKeySpkiBase64: key.publicKeySpkiBase64,
    issuedAt,
  });

  const viaFile = await signPreparedStatement(key, prepared);
  const viaOpts = await signStatement(key, {
    documentSha256: DIGEST, contentType: 'application/pdf', issuedAt,
  });

  // ES256 is randomised, so the signatures differ — the statements must not.
  const strip = (s: typeof viaFile): unknown => ({ ...s, signature: undefined });
  assert.deepEqual(strip(viaFile), strip(viaOpts));
  assert.equal(statementLeaf(viaFile).length, 64);

  for (const signed of [viaFile, viaOpts]) {
    assert.equal((await verifyStatement(signed, statementLeaf(signed))).signatureOk, true);
  }
});

test('the key id is derived from the public key, so it leaks nothing', async () => {
  const key = await generateKey();
  assert.match(key.keyId, /^ik_[0-9a-f]{16}$/);
  // Same public key in, same id out — recoverable without the secret.
  const again = await signStatement(key, { documentSha256: DIGEST });
  assert.equal(again.issuer.key_id, key.keyId);
  assert.notEqual(key.keyId, (await generateKey()).keyId, 'two keys must not share an id');
});

test('two keygens never produce the same key', async () => {
  // A seeded or constant generator is the one defect that would be invisible
  // in every other test here and fatal in production.
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) seen.add((await generateKey()).privateKeyPkcs8Base64);
  assert.equal(seen.size, 5);
});

test('the signer contains no network call, by inspection of its own source', () => {
  /*
   * The product claim is that the private key never leaves the customer's
   * machine. Nothing in a unit test can prove that in general, but the
   * narrow version is checkable and is the one that would actually break:
   * no module here may fetch, open a socket, or spawn something that could.
   *
   * `node:net` is permitted in the CLI for exactly one purpose — the
   * `--offline-check` probe, which connects *outward to prove it cannot* and
   * never carries key material. It is listed explicitly so adding a second
   * use has to be a deliberate edit to this test.
   */
  const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|child_process|node:http\b|node:https|node:dgram)\b/;
  for (const file of ['index.ts', 'cli.ts']) {
    const src = readFileSync(path.join(SRC, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, forbidden, `${file} can reach the network`);
  }
  const cli = readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  assert.equal((cli.match(/node:net/g) ?? []).length, 1,
    'node:net may appear once, for the offline probe');
  assert.match(cli, /assertOffline/, 'and that one use must be the probe');
});

test('nothing writes the private key anywhere the caller did not name', () => {
  const cli = readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  // Every write goes to a path taken from an argument. A literal path would
  // mean the tool chose where a secret lands, which is not its decision.
  for (const m of cli.matchAll(/writeFileSync\(([^,]+),/g)) {
    assert.doesNotMatch(m[1]!.trim(), /^['"`]/,
      `writeFileSync to a hardcoded path: ${m[1]}`);
  }
  const index = readFileSync(path.join(SRC, 'index.ts'), 'utf8');
  assert.doesNotMatch(index, /writeFileSync|appendFileSync|createWriteStream/,
    'the library must not touch the filesystem at all; that is the CLI\'s job');
});
