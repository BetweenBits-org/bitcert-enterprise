/**
 * What the Java settlement rail made, checked by the reference's code — the direction a vector file cannot hold.
 *
 *   node apps/core-java/tools/check-remit-b1-made.mjs
 *
 * Two files, each written by a test of the Java module and read here when it is there:
 *
 * - `target/remit-b1-made.json` (`./mvnw test`, RemitB1VectorsTest): a platform key the Java service made (as it
 *   makes one on a test store when none is there), the key's public half and id as Java computed them, and an
 *   event it signed with it. The reference's `loadOrCreatePlatformKey` reads that key file and must come to the
 *   same public key and the same key id, and the reference's `verifyEvent` must accept the signature.
 * - `target/remit-b1-made-store.json` (`./mvnw test -Dtest='Remit*IT' -Dstonehash.env=.env.dev`,
 *   RemitAcceptanceIT): what an acceptance and a day's manifest left in the store — the two events the platform
 *   signs when it accepts a settlement, the notice it queues for the bank, and a manifest's verdict with its
 *   signature and commitment. The reference's `verifyEvent` must accept each signature with the platform's
 *   registered key, and the commitment must be the one the reference computes for that manifest and verdict
 *   (`apps/core/src/remit/routes.ts`).
 *
 * The keys are test keys; the key file of the first check is written to a folder under `target/` and removed again.
 * Exit status 1 when a check fails or when neither file is there.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcs } from '../../../packages/attest-verify/src/index.ts';
import { loadOrCreatePlatformKey, sha256hex, verifyEvent } from '../../core/src/remit/sign.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(HERE, '../target');
const failures = [];
const said = [];

const keyFile = path.join(TARGET, 'remit-b1-made.json');
if (existsSync(keyFile)) {
  const made = JSON.parse(readFileSync(keyFile, 'utf8'));
  const tmp = path.join(TARGET, 'remit-b1-made-tmp');
  mkdirSync(tmp, { recursive: true });
  try {
    const pem = path.join(tmp, 'platform.pem');
    writeFileSync(pem, made.pem, { mode: 0o600 });
    const key = loadOrCreatePlatformKey(pem);
    if (key.publicSpkiBase64 !== made.spki) failures.push('the reference reads another public key out of the key file the Java service made');
    if (key.keyId !== made.keyId) failures.push(`key id: the reference says ${key.keyId}, the Java service ${made.keyId}`);
    if (!verifyEvent(made.payload, made.sig, key.publicSpkiBase64)) failures.push('the reference does not accept the event signature the Java service made');
    if (verifyEvent({ ...made.payload, changed: true }, made.sig, key.publicSpkiBase64)) failures.push('the signature verifies over another payload');
    if (made.sig.alg !== 'ES256' || made.sig.issuer !== 'STONEHASH' || made.sig.key_id !== made.keyId || Object.keys(made.sig).join(',') !== 'alg,key_id,issuer,sig') {
      failures.push(`the signature envelope is not { alg, key_id, issuer, sig } of the platform: ${JSON.stringify(Object.keys(made.sig))}`);
    }
    said.push(`a key file the Java service made is read by the reference to the same key (${made.keyId}), and its signature verifies there`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const storeFile = path.join(TARGET, 'remit-b1-made-store.json');
if (existsSync(storeFile)) {
  const made = JSON.parse(readFileSync(storeFile, 'utf8'));
  const spki = made.platform.spki;
  const envelope = (sig, what) => {
    if (sig.alg !== 'ES256' || sig.issuer !== 'STONEHASH' || sig.key_id !== made.platform.key_id || Object.keys(sig).join(',') !== 'alg,key_id,issuer,sig') failures.push(`${what}: not the platform's envelope`);
  };
  for (const e of made.events) {
    const payload = JSON.parse(e.payload);
    envelope(e.sig, `event ${e.type}`);
    if (!verifyEvent(payload, e.sig, spki)) failures.push(`event ${e.type}: the reference does not accept the platform's signature the Java service stored`);
    if (verifyEvent({ ...payload, payment_id: `${payload.payment_id}-x` }, e.sig, spki)) failures.push(`event ${e.type}: the signature verifies over another payload`);
  }
  if (made.events.map((e) => e.type).join(',') !== 'REQUEST_ACCEPTED,BANK_AUTHORIZATION_VERIFIED') failures.push(`the signed events of an acceptance are ${made.events.map((e) => e.type).join(', ')}`);
  const hook = JSON.parse(made.webhook);
  envelope(hook.signature, 'the notice');
  if (Object.keys(hook).join(',') !== 'envelope,signature' || Object.keys(hook.envelope).join(',') !== 'event_id,payment_id,sequence,type,state,occurred_at,data') failures.push('the notice is not { envelope { event_id, payment_id, sequence, type, state, occurred_at, data }, signature }');
  if (!verifyEvent(hook.envelope, hook.signature, spki)) failures.push('the reference does not accept the signature over the notice the Java service queued');
  const m = made.manifest;
  envelope(m.platform_signature, 'the manifest');
  if (!verifyEvent({ manifest: m.manifest, verdict: m.verdict }, m.platform_signature, spki)) failures.push('the reference does not accept the platform signature over the manifest and its verdict');
  const commitment = sha256hex(Buffer.concat([Buffer.from('STONEHASH-MANIFEST-V1\n', 'utf8'), Buffer.from(jcs({ manifest: m.manifest, verdict: m.verdict }))]));
  if (commitment !== m.commitment) failures.push(`the manifest's commitment: the reference computes ${commitment}, the Java service ${m.commitment}`);
  said.push(`what an acceptance and a manifest left in the Java service's store verifies with the reference's code: ${made.events.length} event signatures, the notice, the manifest's signature and its commitment`);
}

if (said.length === 0) failures.push('nothing to check: neither target/remit-b1-made.json nor target/remit-b1-made-store.json is there — run the tests first');
for (const f of failures) console.log(`FAIL ${f}`);
for (const s of said) if (failures.length === 0) console.log(s);
if (failures.length) console.log(`${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
