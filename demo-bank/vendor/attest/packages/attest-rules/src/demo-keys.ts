/**
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
 * Their private halves are published too, in `keys/demo-issuers.json`, so
 * anyone can forge these signatures — which is the point. `trustLevel` is
 * pinned to `DEMO`, the bottom of the ladder, so no policy requiring
 * `ATTESTED` or `ACCREDITED` can be satisfied by them and the issuer axis
 * reports `UNKNOWN_ISSUER` however sound the arithmetic was. A verified demo
 * signature and an established identity are two different findings, and this
 * is the mechanism that keeps them from being confused.
 *
 * ## Generated file
 *
 * Written by `tools/make-demo-keys.mjs` from `keys/demo-issuers.json`.
 * Do not edit by hand — `test/signature.test.ts` asserts the two agree, so a
 * regenerated keyring cannot leave this stale.
 */
import { keyring } from './signature.ts';
import type { VerificationKey } from './signature.ts';

export const DEMO_ISSUER_KEYS: readonly VerificationKey[] = [
  {
    keyId: "demo-provider-key-01",
    issuer: "DEMO_PROVIDER",
    trustLevel: 'DEMO',
    publicKeyJwk: {"kty":"EC","x":"1FPQIP1R1aYB6urCDAcXzdJY5IYVx9SFOMnbbJtExfM","y":"_7gTFtl--uVDMHI18wPzkOQ5DANQqflQJiYPwTEoquc","crv":"P-256"},
  },
  {
    keyId: "demo-bank-key-01",
    issuer: "DEMO_BANK",
    trustLevel: 'DEMO',
    publicKeyJwk: {"kty":"EC","x":"vo4TK9FC3_MYzV4J0T7b7LRMPwDBIesxysThGq7zCIU","y":"0LSeeU5xCOg_vPyINABHDCZ3VcvITHWDxTTrnVy-aMU","crv":"P-256"},
  },
  {
    keyId: "demo-seller-key-01",
    issuer: "DEMO_SELLER",
    trustLevel: 'DEMO',
    publicKeyJwk: {"kty":"EC","x":"VThJkSp0N_T-GjUiaQ_g7fEhfPZlVxRoCzAAsmCZLT0","y":"k51_HneBOXFAVSglG3mLE8ISPiyPbhA1U0oZRMb61Kk","crv":"P-256"},
  },
  {
    keyId: "demo-vn-bank-key-01",
    issuer: "DEMO_VN_LICENSED_BANK",
    trustLevel: 'DEMO',
    publicKeyJwk: {"kty":"EC","x":"SL0hJmz2E9Gz_pFL7XIG57rOczBoCYOrMMvJk8606ds","y":"VNO-QUo8KcSwDDj_93WPLMv75yQVMk_FqRcx-7ybjwQ","crv":"P-256"},
  },
  {
    keyId: "demo-sending-vasp-key-01",
    issuer: "DEMO_SENDING_VASP",
    trustLevel: 'DEMO',
    publicKeyJwk: {"kty":"EC","x":"E8_FXPM_BTsi84lfNEP1U69pPNdb6PGtH_3vJEhNb4U","y":"0ZIf_eq8ruRSapvtRrfD-kPMjDz4g6gZ42x9wJ3S3_w","crv":"P-256"},
  },
];

/** Ready-made keyring for the demo fixtures. */
export const DEMO_KEYRING = keyring(DEMO_ISSUER_KEYS);
