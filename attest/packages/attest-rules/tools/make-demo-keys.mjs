/**
 * Generate the demonstration issuer keyring.
 *
 *     node tools/make-demo-keys.mjs        # add any missing issuer, keep the rest
 *     node tools/make-demo-keys.mjs --all  # regenerate every key from scratch
 *
 * Writes two files:
 *
 * - `keys/demo-issuers.json` — public **and private** halves. Published on
 *   purpose; see the warning the file carries.
 * - `src/demo-keys.ts` — public halves only, embedded so the browser needs no
 *   fetch and the Playground keeps working offline.
 *
 * Existing keys are preserved by default. Regenerating one invalidates every
 * fixture signature it made, so churn here is not free — run `--all` only when
 * you intend to re-sign everything.
 *
 * ## One party, one key
 *
 * Each counterparty in the fixtures gets its own key, because the issuer shown
 * on a verified signature now comes from this keyring rather than from a label
 * in the evidence document. Sharing one key across two parties would mean the
 * review screen attributed both of their documents to the same signer — which
 * was exactly the bug that made this file necessary: the corridor fixture's
 * Vietnamese bank was being reported as the generic demo bank.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const KEYFILE = path.join(PKG, 'keys/demo-issuers.json');
const MODULE = path.join(PKG, 'src/demo-keys.ts');

/** Every party that signs something in the fixtures. */
const ISSUERS = [
  { keyId: 'demo-provider-key-01', issuer: 'DEMO_PROVIDER',
    note: 'payment provider issuing payout receipts' },
  { keyId: 'demo-bank-key-01', issuer: 'DEMO_BANK',
    note: 'the instructing bank in the trade-payment fixture' },
  { keyId: 'demo-seller-key-01', issuer: 'DEMO_SELLER',
    note: 'the seller issuing commercial documents' },
  { keyId: 'demo-vn-bank-key-01', issuer: 'DEMO_VN_LICENSED_BANK',
    note: 'the Vietnamese licensed bank in the corridor fixture — a distinct party '
      + 'from DEMO_BANK, so a distinct key' },
  { keyId: 'demo-sending-vasp-key-01', issuer: 'DEMO_SENDING_VASP',
    note: 'the originating VASP attesting the travel-rule record' },
];

const WARNING =
  'These are DEMONSTRATION keys and their private halves are published on purpose. '
  + 'A signature from one of them proves that this repository signed something — nothing more. '
  + 'It establishes NO identity, and `trustLevel` is pinned to DEMO so no policy requiring '
  + 'ATTESTED or ACCREDITED can ever be satisfied by them. Anyone can forge these signatures, '
  + 'which is precisely the point: the synthetic bank fixtures must not look authentic.';

const all = process.argv.includes('--all');
const existing = new Map();
if (!all && existsSync(KEYFILE)) {
  for (const k of JSON.parse(readFileSync(KEYFILE, 'utf8')).keys) existing.set(k.keyId, k);
}

const keys = [];
let made = 0;
for (const meta of ISSUERS) {
  const have = existing.get(meta.keyId);
  if (have) {
    // Keep the key material; refresh the descriptive fields so a reworded note
    // does not require regenerating a keypair.
    keys.push({ ...meta, trustLevel: 'DEMO', algorithm: 'ES256',
      publicKeyJwk: have.publicKeyJwk, privateKeyJwk: have.privateKeyJwk });
    continue;
  }
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const prv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  for (const o of [pub, prv]) { delete o.key_ops; delete o.ext; }
  keys.push({ ...meta, trustLevel: 'DEMO', algorithm: 'ES256',
    publicKeyJwk: pub, privateKeyJwk: prv });
  made++;
}

writeFileSync(KEYFILE, `${JSON.stringify({
  '!!! READ THIS !!!': WARNING,
  purpose: 'Sign the synthetic settlement-evidence fixtures so the Bank Review demo performs '
    + 'real ECDSA verification instead of trusting a declared status field.',
  algorithm: 'ECDSA P-256 / SHA-256 (ES256, RFC 7515)',
  regenerate: 'node tools/make-demo-keys.mjs  (then: node tools/sign-fixtures.mjs)',
  keys,
}, null, 2)}\n`);

const entries = keys.map((k) => `  {
    keyId: ${JSON.stringify(k.keyId)},
    issuer: ${JSON.stringify(k.issuer)},
    trustLevel: 'DEMO',
    publicKeyJwk: ${JSON.stringify(k.publicKeyJwk)},
  },`).join('\n');

writeFileSync(MODULE, `/**
 * The demonstration issuer keys, public halves only.
 *
 * ## Why these are in the source tree
 *
 * The synthetic bank fixtures are signed so the Bank Review demo performs real
 * ECDSA verification rather than displaying a status a file asserted. A
 * verifier needs the public keys to do that, and a browser that had to fetch
 * them would break the Playground's offline guarantee.
 *
 * ## What a signature from one of these proves
 *
 * That this repository signed something. Nothing else.
 *
 * Their private halves are published too, in \`keys/demo-issuers.json\`, so
 * anyone can forge these signatures — which is the point. \`trustLevel\` is
 * pinned to \`DEMO\`, the bottom of the ladder, so no policy requiring
 * \`ATTESTED\` or \`ACCREDITED\` can be satisfied by them and the issuer axis
 * reports \`UNKNOWN_ISSUER\` however sound the arithmetic was. A verified demo
 * signature and an established identity are two different findings, and this
 * is the mechanism that keeps them from being confused.
 *
 * ## Generated file
 *
 * Written by \`tools/make-demo-keys.mjs\` from \`keys/demo-issuers.json\`.
 * Do not edit by hand — \`test/signature.test.ts\` asserts the two agree, so a
 * regenerated keyring cannot leave this stale.
 */
import { keyring } from './signature.ts';
import type { VerificationKey } from './signature.ts';

export const DEMO_ISSUER_KEYS: readonly VerificationKey[] = [
${entries}
];

/** Ready-made keyring for the demo fixtures. */
export const DEMO_KEYRING = keyring(DEMO_ISSUER_KEYS);
`);

console.log(`${keys.length} demo issuer keys (${made} newly generated, ${keys.length - made} preserved)`);
for (const k of keys) console.log(`  ${k.keyId.padEnd(26)} ${k.issuer}`);
if (made > 0) console.log('\nNow re-sign the fixtures: node tools/sign-fixtures.mjs');
