/**
 * Sign the synthetic evidence fixtures with the demo issuer keys.
 *
 * Run after editing a fixture's content, because the signature covers the whole
 * element: change an amount and the signature stops verifying, which is the
 * property that makes the demo honest rather than a cosmetic bug.
 *
 *     node tools/sign-fixtures.mjs          # sign, write
 *     node tools/sign-fixtures.mjs --check  # verify only, non-zero on drift
 *
 * `--check` is what CI runs. A fixture whose content was edited without
 * re-signing would otherwise ship with a signature that fails for a reason
 * nobody intended, and the Bank Review demo would show a broken issuer axis on
 * the "normal payment" scenario.
 *
 * The private keys live in `keys/demo-issuers.json`, published on purpose —
 * see the warning at the top of that file. Anyone can run this tool, which is
 * exactly what a demonstration key is for.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedBytes, toBase64Url } from '../src/signature.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

const KEYS = JSON.parse(readFileSync(path.join(PKG, 'keys/demo-issuers.json'), 'utf8'));

/**
 * Which key signs which element, per fixture.
 *
 * Per fixture, not global, because the parties differ: the instructing bank in
 * the trade payment is a generic demo bank, while in the VN→SG corridor it is a
 * Vietnamese licensed bank, and the travel-rule record is attested by the
 * originating VASP rather than by a bank at all.
 *
 * This used to be one global map, and the result was wrong in a way worth
 * recording: the corridor's bank documents were signed by `demo-bank-key-01`,
 * so once the issuer started coming from the keyring instead of from a label in
 * the document, the review screen attributed the Vietnamese bank's FX approval
 * to the generic demo bank. One party, one key.
 */
const SIGNERS = {
  'fixtures/a-normal-trade-payment.json': {
    payoutReceipts: 'demo-provider-key-01',
    bankInstruction: 'demo-bank-key-01',
    commercialDocs: 'demo-seller-key-01',
  },
  'fixtures/corridor-vn-sg-normal.json': {
    payoutReceipts: 'demo-provider-key-01',
    bankInstruction: 'demo-vn-bank-key-01',
    bankApproval: 'demo-vn-bank-key-01',
    travelRule: 'demo-sending-vasp-key-01',
    commercialDocs: 'demo-seller-key-01',
  },
};

const FIXTURES = Object.keys(SIGNERS);

const check = process.argv.includes('--check');

const privateKeys = new Map();
const publicKeys = new Map();
for (const k of KEYS.keys) {
  privateKeys.set(k.keyId, await crypto.subtle.importKey(
    'jwk', k.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']));
  publicKeys.set(k.keyId, await crypto.subtle.importKey(
    'jwk', k.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
}

/** Every signable node in an evidence document, with the element name. */
function* nodes(evidence, signer) {
  for (const [name, node] of Object.entries(evidence.elements ?? {})) {
    if (!node || !signer[name]) continue;
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') yield [name, item];
    } else if (typeof node === 'object') {
      yield [name, node];
    }
  }
}

let drift = 0;
let signed = 0;

for (const rel of FIXTURES) {
  const file = path.join(PKG, rel);
  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  const signer = SIGNERS[rel];

  for (const [name, item] of nodes(evidence, signer)) {
    // Only elements the fixture already models as signed. Adding a signature
    // where the scenario intends none would change what the fixture teaches —
    // chainTransfer is a public-ledger observation and has no issuer.
    if (!item.signature || item.signature.status === 'ABSENT') continue;

    const keyId = signer[name];
    const key = KEYS.keys.find((k) => k.keyId === keyId);

    if (check) {
      const ok = item.signature.value && await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, publicKeys.get(keyId),
        Buffer.from(item.signature.value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
        signedBytes(item));
      if (!ok) {
        console.error(`DRIFT  ${rel} · ${name}: signature does not verify — content changed since signing`);
        drift++;
      }
      continue;
    }

    // Written in a fixed field order so re-signing produces a minimal diff.
    item.signature = {
      status: 'DEMO_VALID',
      keyId,
      algorithm: 'ES256',
      issuer: key.issuer,
      trustLevel: key.trustLevel,
      value: toBase64Url(new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, privateKeys.get(keyId), signedBytes(item)))),
    };
    signed++;
  }

  if (!check) writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (check) {
  if (drift > 0) {
    console.error(`\n${drift} signature(s) stale. Run: node tools/sign-fixtures.mjs`);
    process.exit(1);
  }
  console.log('all fixture signatures verify against the demo keyring');
} else {
  console.log(`signed ${signed} evidence element(s) across ${FIXTURES.length} fixtures`);
}
