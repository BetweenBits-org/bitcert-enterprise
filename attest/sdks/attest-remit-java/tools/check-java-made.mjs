/**
 * What the Java SDK signs and encrypts, put to the platform's own code: every
 * event and evidence element signed through `Conventions` has to verify
 * there, and every Travel Rule message encrypted through `TravelRule.encrypt`
 * has to open with the platform's `decryptJwe` to the bytes that went in.
 *
 * This is the direction the golden files cannot hold: a signature and a
 * ciphertext are different bytes on every run, so there is nothing to store —
 * they are made now, by the Java runtime named, and checked now.
 *
 *   ./run-tests.sh                                     (builds the jar and the test classes)
 *   node tools/check-java-made.mjs [java ...]          `java` by default; name several runtimes to check each
 *
 * Nothing is written. Exits non-zero when anything the Java SDK made is not
 * taken by the platform's code.
 */
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyring, verifyEvidenceSignatures, evaluate } from '../../../packages/attest-rules/src/index.ts';
import { elementDigest, spkiToJwk, verifyEvent } from '../../../apps/core/src/remit/sign.ts';
import { decryptJwe } from '../../../apps/core/src/remit/jwe.ts';
import { buildIvms101 } from '../../../apps/core/src/remit/ivms101.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, '..');
const GOLDEN = path.join(SDK, 'src/test/resources/golden');
const classpath = `${path.join(SDK, 'dist/stonehash-attest-remit-0.1.0.jar')}:${path.join(SDK, 'build/test-classes')}`;
const runtimes = process.argv.slice(2).length ? process.argv.slice(2) : ['java'];

const signing = JSON.parse(readFileSync(path.join(GOLDEN, 'signing.json'), 'utf8'));
const travelRule = JSON.parse(readFileSync(path.join(GOLDEN, 'travel-rule.json'), 'utf8'));
const verdict = JSON.parse(readFileSync(path.join(GOLDEN, 'verdict.json'), 'utf8'));
const originals = new Map(JSON.parse(readFileSync(path.join(GOLDEN, 'conventions.json'), 'utf8')).elements.map((e) => [e.name, e.element]));
const recipient = createPrivateKey(signing.testKey.pkcs8Pem);
const messages = new Map(travelRule.messages.filter((m) => !m.threw).map((m) => [m.name, m]));

let failed = 0;
for (const java of runtimes) {
  const run = spawnSync(java, ['-cp', classpath, 'com.stonehash.attest.remit.PlatformProbe', 'made', GOLDEN], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) { console.error(`${java}: ${run.stderr.slice(0, 2000)}`); failed++; continue; }
  const made = JSON.parse(run.stdout);
  const problems = [];
  const { spkiBase64, keyId, issuer } = made.key;
  const ring = keyring([{ keyId, issuer, trustLevel: 'ATTESTED', publicKeyJwk: spkiToJwk(spkiBase64) }]);

  // Events: the envelope the platform would have made, and one it verifies.
  for (const e of made.events) {
    if (JSON.stringify(Object.keys(e.sig)) !== '["alg","key_id","issuer","sig"]' || e.sig.alg !== 'ES256' || e.sig.key_id !== keyId || e.sig.issuer !== issuer) {
      problems.push(`event "${e.name}": the envelope is ${JSON.stringify(e.sig)}`);
    } else if (!verifyEvent(e.payload, e.sig, spkiBase64)) {
      problems.push(`event "${e.name}": the platform does not verify the signature`);
    } else if (verifyEvent({ changed: e.payload }, e.sig, spkiBase64)) {
      problems.push(`event "${e.name}": the signature verifies over another payload`);
    }
  }

  // Elements: the platform's signature pass reads each VALID under a keyring that holds the key, and the six-axis
  // engine then finds nothing to say about its issuer.
  for (const e of made.elements) {
    for (const [how, element] of [['signed', e.signed], ['digested and signed', e.digestedAndSigned]]) {
      const checked = await verifyEvidenceSignatures({ elements: { bankInstruction: element } }, ring);
      const signature = checked.elements.bankInstruction.signature;
      if (signature.status !== 'VALID' || signature.checked !== true || signature.trustLevel !== 'ATTESTED' || signature.issuer !== issuer) {
        problems.push(`element "${e.name}", ${how}: the platform reads its signature ${JSON.stringify(signature)}`);
      }
      const edited = await verifyEvidenceSignatures({ elements: { bankInstruction: { ...element, edited: true } } }, ring);
      if (edited.elements.bankInstruction.signature.status !== 'INVALID') problems.push(`element "${e.name}", ${how}: the signature survives a change to the element`);
    }
    if (e.digestedAndSigned.digest !== elementDigest(e.digestedAndSigned)) problems.push(`element "${e.name}": declares digest ${e.digestedAndSigned.digest}, the platform computes ${elementDigest(e.digestedAndSigned)}`);
    // Signing alone adds the signature and changes nothing else — no digest is added, and one that is there stays as it is.
    const original = originals.get(e.name);
    if (JSON.stringify({ ...e.signed, signature: undefined }) !== JSON.stringify({ ...original, signature: undefined })) problems.push(`element "${e.name}": signing changed more than its signature`);
  }
  // A whole settlement signed here: the sandbox settlement's elements, re-signed by the Java SDK, under the sandbox policy.
  {
    const base = verdict.bases.sandbox;
    const resigned = made.elements.filter((e) => e.name.startsWith('the sandbox settlement\'s '));
    const elements = Object.fromEntries(resigned.map((e) => { const k = e.name.slice('the sandbox settlement\'s '.length); return [k, k === 'payoutReceipts' ? [e.digestedAndSigned] : e.digestedAndSigned]; }));
    if (Object.keys(elements).length !== 6) problems.push(`the sandbox settlement: ${Object.keys(elements).length} of its six elements were signed`);
    const checked = await verifyEvidenceSignatures({ ...base.evidence, elements }, ring);
    const result = evaluate(checked, base.policy);
    if (result.axes.issuer.state !== 'VALID' || result.axes.issuer.findings.length) problems.push(`the sandbox settlement, signed here: the platform's issuer axis reads ${JSON.stringify(result.axes.issuer)}`);
  }

  // Travel Rule messages: opened by the platform's decryptJwe, to the text the platform itself would have encrypted.
  for (const c of made.encrypted) {
    const plaintext = Buffer.from(c.plaintextBase64, 'base64');
    let opened;
    try { opened = decryptJwe(c.jwe, recipient); } catch (err) { problems.push(`"${c.name}": the platform cannot open it — ${err.message}`); continue; }
    if (!opened.equals(plaintext)) { problems.push(`"${c.name}": opens to other bytes than went in`); continue; }
    const header = JSON.parse(Buffer.from(c.jwe.split('.')[0], 'base64url').toString('utf8'));
    const wanted = c.keyId ? ['alg', 'enc', 'epk', 'kid'] : ['alg', 'enc', 'epk'];
    if (JSON.stringify(Object.keys(header)) !== JSON.stringify(wanted) || (c.keyId && header.kid !== c.keyId) || JSON.stringify(Object.keys(header.epk)) !== '["kty","crv","x","y"]') {
      problems.push(`"${c.name}": the header is ${JSON.stringify(header)}`);
    }
    const m = messages.get(c.name);
    if (m && opened.toString('utf8') !== JSON.stringify(buildIvms101(m.compliance, m.context))) problems.push(`"${c.name}": is not the message the platform builds from the same party data`);
  }

  const version = `Java ${made.java}`;
  if (problems.length) {
    failed++;
    console.error(`${version}: ${problems.length} thing(s) the platform's code does not take\n  ${problems.slice(0, 20).join('\n  ')}`);
  } else {
    console.log(`${version}: the platform's code verifies ${made.events.length} events and ${made.elements.length * 2} elements signed by the Java SDK `
      + `(and the sandbox settlement signed whole), and opens ${made.encrypted.length} messages it encrypted`);
  }
}
process.exit(failed ? 1 : 0);
