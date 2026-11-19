import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { finishElement, signEvent, verifyEvent, elementDigest, spkiOf } from '../src/signing.ts';
import { keyring, verifyEvidenceSignatures } from '@stonehash/attest-rules';
import { createPublicKey } from 'node:crypto';

const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });

test('event signatures round-trip against the registered SPKI', () => {
  const payload = { payment_id: 'P-1', reason: 'test' };
  const sig = signEvent(payload, kp.privateKey, 'VN-X-1', 'Bank');
  assert.equal(verifyEvent(payload, sig, spkiOf(kp.privateKey)), true);
  assert.equal(verifyEvent({ ...payload, reason: 'other' }, sig, spkiOf(kp.privateKey)), false);
});

test('finished elements verify under the six-axis signature pass', async () => {
  const el = finishElement({
    ref: 'PAY-1', amount: '10.00', currency: 'USD', debtor: 'A', creditor: 'B',
  }, kp.privateKey, 'VN-X-1', 'Bank');
  assert.equal(el.digest, elementDigest(el));
  const ring = keyring([{
    keyId: 'VN-X-1', issuer: 'Bank', trustLevel: 'ATTESTED',
    publicKeyJwk: createPublicKey(kp.privateKey).export({ format: 'jwk' }) as JsonWebKey,
  }]);
  const checked = await verifyEvidenceSignatures(
    { schemaVersion: 'settlement-evidence/0.1', scenario: 't', dataMode: 'SYNTHETIC',
      notRealPayment: true, elements: { bankInstruction: el as never } } as never, ring);
  const sig = (checked.elements as { bankInstruction: { signature: { status: string; checked: boolean } } }).bankInstruction.signature;
  assert.equal(sig.status, 'VALID');
  assert.equal(sig.checked, true);
});
