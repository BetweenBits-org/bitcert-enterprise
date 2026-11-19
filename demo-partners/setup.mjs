/**
 * One-time provisioning for the partner estate — the steps each institution's
 * own ops team would do, scripted for reproducibility:
 *
 *   SG-BFI-001        signing key + Travel-Rule encryption key  (Triple-A profile)
 *   SG-PAYBANK-001    signing key                               (FAST payout bank)
 *   SETTLE-ENTITY-001 signing key                               (settlement entity)
 *
 * Public halves are registered into the platform's Trust Registry via the
 * sandbox admin endpoint. Private halves never leave keys/ (0600).
 */
import { writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSigningKey, newEncryptionKey } from './lib/crypto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const ADMIN = process.env.REMIT_ADMIN_TOKEN ?? 'remit-admin-sandbox';

if (existsSync(STATE)) {
  console.error('state.json already exists — delete it (and keys/) to re-provision.');
  process.exit(1);
}
mkdirSync(path.join(HERE, 'keys'), { recursive: true });

const institutions = {
  bfi: {
    id: 'SG-BFI-001', role: 'BENEFICIARY_FI', country: 'SG',
    name: 'Triple-A profile BFI (sim)',
    authority: ['TRAVEL_RULE_RECEIVED', 'PAYOUT_ACCEPTED', 'USDC_RECEIVED', 'PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED', 'travelRule', 'payoutReceipts'],
  },
  sgbank: {
    id: 'SG-PAYBANK-001', role: 'LOCAL_PAYOUT_BANK', country: 'SG',
    name: 'SG Payout Bank (FAST sim)',
    authority: ['LOCAL_CREDIT_CONFIRMED'],
  },
  wallet: {
    id: 'SETTLE-ENTITY-001', role: 'SETTLEMENT_ENTITY', country: 'SG',
    name: 'Licensed Settlement Entity (sim)',
    authority: ['USDC_TRANSFER_CONFIRMED', 'chainTransfer'],
  },
};

const state = { provisionedAt: new Date().toISOString(), core: CORE, institutions: {} };

for (const [slug, inst] of Object.entries(institutions)) {
  const sk = newSigningKey();
  const keyFile = path.join(HERE, 'keys', `${slug}.key`);
  writeFileSync(keyFile, sk.pem);
  chmodSync(keyFile, 0o600);

  const body = {
    id: inst.id, role: inst.role, name: inst.name, country: inst.country,
    signing_spki: sk.spki, authority: inst.authority,
  };
  if (slug === 'bfi') {
    const enc = newEncryptionKey();
    const encFile = path.join(HERE, 'keys', 'bfi-enc.key');
    writeFileSync(encFile, enc.privatePem);
    chmodSync(encFile, 0o600);
    body.encryption_jwk = enc.publicJwk;
  }

  const res = await fetch(`${CORE}/v1/remit/registry/institutions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (res.status !== 201) {
    console.error(`registering ${inst.id} failed:`, res.status, JSON.stringify(json));
    process.exit(1);
  }
  state.institutions[slug] = { id: inst.id, role: inst.role, spki: sk.spki };
  console.log(`registered ${inst.id} (${inst.role})`);
}

writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
chmodSync(STATE, 0o600);
console.log('partner estate provisioned.');
