/**
 * checkEvidence(): held to the settlement SDK, one file at a time.
 *
 * The 검증 screen checks an evidence file in the visitor's browser with
 * `src/evidence-check.ts`; a bank checks the same file on its server with the
 * SDK's `verifyEvidencePackage`. The two must not disagree except where it has
 * been decided that they should — the page stricter in the listed places, and
 * in one named place right about a file the SDK wrongly fails. So this is a
 * differential test. Every case
 * is the real, anchored evidence response in `fixtures/` with one thing
 * changed, given to both, and the module's report is held to the SDK's check
 * by check: `verified`, each of the four, and the element statuses in the
 * SDK's own order and words. Where the SDK throws there is no report to hold
 * it to, and the module has to hand back a failed one instead of throwing.
 *
 * Each case also names the checks it expects to fail, so the two cannot
 * agree on a wrong answer unnoticed.
 *
 * The places where the module is knowingly the stricter have tests of their
 * own at the end: each is a file the SDK accepts, and the test fails if the
 * module starts accepting it too without that being decided.
 *
 * Slow for a unit test — a signature takes the page's plain-JavaScript P-256
 * about 70 ms, and most cases carry six. Run `node build.mjs sync` first: the
 * module loads the vendored sources, and the tests skip with a clear message
 * when they are not there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyEvidencePackage } from '../../../packages/attest-remit/src/verify.ts';
import type { EvidenceResponse } from '../../../packages/attest-remit/src/verify.ts';
import { finishElement } from '../../../packages/attest-remit/src/signing.ts';
import { evaluate, keyring, verifyEvidenceSignatures } from '../../../packages/attest-rules/src/index.ts';
import type { Policy, SettlementEvidence } from '../../../packages/attest-rules/src/index.ts';
import { jcsString } from '../../../packages/attest-verify/src/index.ts';
import type { JcsValue } from '../../../packages/attest-verify/src/index.ts';
import type { EvidenceCheckReport } from '../src/evidence-check.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.resolve(HERE, '../../../packages/attest-rules/src');
const VENDORED_RULES = path.resolve(HERE, '../src/vendor/attest-rules');
const skip = existsSync(path.join(VENDORED_RULES, 'engine.ts'))
  ? false : 'src/vendor/attest-rules not there — run `node build.mjs sync` in apps/console first';
const { checkEvidence, looksLikeEvidence } = (skip === false
  ? await import('../src/evidence-check.ts') : {}) as typeof import('../src/evidence-check.ts');

// ── the fixtures, and reaching into them ───────────────────────────────────

type Obj = Record<string, unknown>;
const fixture = (name: string): Obj => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8')) as Obj;
/** A real evidence response from the sandbox, its anchor confirmed: all four checks hold. */
const ANCHORED = fixture('evidence-anchored.json');
/** A real proof bundle — of another record. */
const OTHER_BUNDLE = fixture('bundle-attest.json');

const pkg = (r: Obj): Obj => r.package as Obj;
const commitment = (r: Obj): Obj => r.commitment as Obj;
const attestation = (r: Obj): Obj => r.attestation as Obj;
const bundle = (r: Obj): Obj => attestation(r).bundle as Obj;
const evidence = (r: Obj): Obj => pkg(r).evidence as Obj;
const elements = (r: Obj): Record<string, Obj> => evidence(r).elements as Record<string, Obj>;
const receipts = (r: Obj): Obj[] => (elements(r) as Obj).payoutReceipts as Obj[];
const signature = (element: Obj): Obj => element.signature as Obj;
const policy = (r: Obj): Obj => pkg(r).policy as Obj;
const axes = (r: Obj): Record<string, Obj> => (pkg(r).verdict as Obj).axes as Record<string, Obj>;
const institutions = (r: Obj): Obj[] => (pkg(r).trust_registry as Obj).institutions as Obj[];
const institution = (r: Obj, id: string): Obj => institutions(r).find((i) => i.id === id)!;

/** Signs the bank's three elements in the fixture; the other two signers have the rest. */
const BANK = 'VN-BANK-001';
/** In the registry, and signs nothing in this payment. */
const BYSTANDER = 'SG-PAYBANK-001';

const flipped = (hex: string): string => (hex.startsWith('0') ? '1' : '0') + hex.slice(1);
const spkiOf = (type: 'ec' | 'ed25519', curve?: string): Buffer =>
  (type === 'ec' ? generateKeyPairSync('ec', { namedCurve: curve! }) : generateKeyPairSync('ed25519'))
    .publicKey.export({ format: 'der', type: 'spki' });

/**
 * Compute the commitment again over the package as it now stands — what
 * anyone holding the file can do after editing it. The anchor cannot be made
 * again: the leaf on the chain is still the old commitment.
 */
function reseal(r: Obj): void {
  commitment(r).value = createHash('sha256').update(Buffer.concat([
    Buffer.from('STONEHASH-EVIDENCE-V1', 'utf8'),
    Buffer.from(commitment(r).nonce as string, 'hex'),
    Buffer.from(jcsString(r.package as JcsValue), 'utf8'),
  ])).digest('hex');
}

/**
 * Sign the bank's elements again, with a key of the test's own.
 *
 * The fixture's signatures cannot be made again, so a case that needs an
 * element which says something else *and is validly signed* swaps the bank's
 * registry key for this one, signs the bank's three elements, has the SDK's
 * own engine state the verdict over the result, and computes the commitment.
 * Everything then holds but the anchor, which is still of the old package.
 */
const OWN_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' });
async function signedAgain(r: Obj): Promise<void> {
  institution(r, BANK).signing_spki = OWN_KEY.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  for (const name of ['bankInstruction', 'commercialDocs', 'bankApproval']) {
    const core = { ...elements(r)[name]! };
    delete core.signature;
    delete core.digest;
    (elements(r) as Obj)[name] = finishElement(core, OWN_KEY.privateKey, BANK, institution(r, BANK).name as string);
  }
  const ring = keyring(institutions(r).map((i) => ({
    keyId: i.id as string, issuer: i.name as string, trustLevel: 'ATTESTED' as const,
    publicKeyJwk: createPublicKey({ key: Buffer.from(i.signing_spki as string, 'base64'), format: 'der', type: 'spki' }).export({ format: 'jwk' }) as JsonWebKey,
  })));
  const checked = await verifyEvidenceSignatures(evidence(r) as unknown as SettlementEvidence, ring);
  pkg(r).verdict = JSON.parse(JSON.stringify(evaluate(checked, policy(r) as unknown as Policy))) as Obj;
  reseal(r);
}

// ── holding the module to the SDK ──────────────────────────────────────────

type Check = 'commitment' | 'signatures' | 'verdict' | 'anchor';
const CHECKS: Check[] = ['commitment', 'signatures', 'verdict', 'anchor'];
type SdkReport = { verified: boolean } & Record<Check, { ok: boolean; detail: string }>;

/** The SDK's report, or `null` where it throws instead of reporting. */
async function sdkReport(input: unknown): Promise<SdkReport | null> {
  try {
    const report = await verifyEvidencePackage(input as EvidenceResponse);
    const check = (name: Check): { ok: boolean; detail: string } => report.checks.find((c) => c.name === name)!;
    return { verified: report.verified, commitment: check('commitment'), signatures: check('signatures'), verdict: check('verdict'), anchor: check('anchor') };
  } catch {
    return null;
  }
}

const failing = (m: EvidenceCheckReport): Check[] => CHECKS.filter((c) => !m[c].ok);
/** The element statuses, written the way the SDK writes them. */
const listed = (m: EvidenceCheckReport): string => m.signatures.elements.map((e) => `${e.element}:${e.status}`).join(' ');
const statusOf = (m: EvidenceCheckReport, element: string): string[] =>
  m.signatures.elements.filter((e) => e.element === element).map((e) => e.status);

/**
 * Give one input to both and hold the module's report to the SDK's.
 *
 * Returns both, the SDK's as `null` where it threw. The module is given the
 * input itself and the SDK a copy, so that a change to the input is the
 * module's doing.
 */
async function held(what: string, input: unknown): Promise<{ mine: EvidenceCheckReport; sdk: SdkReport | null }> {
  const before = structuredClone(input);
  const sdk = await sdkReport(structuredClone(input));
  const mine = await checkEvidence(input);
  assert.deepEqual(input, before, `${what}: the module changed what it was given`);
  assert.equal(mine.verified, CHECKS.every((c) => mine[c].ok), `${what}: verified is the four checks together`);
  for (const c of CHECKS) {
    assert.ok(mine[c].problem === undefined || (mine[c].problem !== '' && !mine[c].ok), `${what}: ${c} gives a problem only when it failed`);
  }

  if (sdk === null) {
    // The SDK throws before its first check is done: on a response with no
    // package to canonicalise or no nonce to read. There is no report to
    // compare with, so the module must have reported that failure itself.
    assert.equal(mine.verified, false, `${what}: the SDK throws, the module cannot have verified`);
    assert.equal(mine.commitment.ok, false, `${what}: the SDK throws on the commitment`);
    assert.equal(typeof mine.commitment.problem, 'string', `${what}: and the module says why`);
    return { mine, sdk };
  }

  assert.deepEqual(
    { verified: mine.verified, ...Object.fromEntries(CHECKS.map((c) => [c, mine[c].ok])) },
    { verified: sdk.verified, ...Object.fromEntries(CHECKS.map((c) => [c, sdk[c].ok])) },
    `${what}: the module and the SDK disagree`);

  // Signatures: the SDK's detail is the statuses, or one of two sentences.
  if (sdk.signatures.detail.startsWith('could not be checked')) {
    assert.equal(typeof mine.signatures.problem, 'string', `${what}: the SDK could not check the signatures; the module must say so too`);
    assert.deepEqual(mine.signatures.elements, [], what);
  } else if (sdk.signatures.detail === 'the package carries no evidence element') {
    assert.deepEqual([mine.signatures.elements, mine.signatures.problem], [[], sdk.signatures.detail], `${what}: nothing to check, in the SDK's words`);
  } else {
    assert.equal(mine.signatures.problem, undefined, `${what}: the SDK checked the signatures; so must the module`);
    assert.equal(listed(mine), sdk.signatures.detail, `${what}: element statuses`);
  }

  // Verdict: not re-run, run and agreeing, run and differing, or not runnable.
  if (sdk.verdict.detail.startsWith('not re-evaluated')) {
    assert.match(mine.verdict.problem ?? '', /^not re-evaluated/, what);
    assert.equal(mine.verdict.mine, null, what);
  } else if (sdk.verdict.ok) {
    assert.equal(Object.entries(mine.verdict.mine ?? {}).map(([k, v]) => `${k}=${v}`).join(' '), sdk.verdict.detail, `${what}: the axes the engine found`);
    assert.deepEqual(mine.verdict.theirs, mine.verdict.mine, what);
  } else if (sdk.verdict.detail.startsWith('local ')) {
    // The SDK prints both maps. A state that is not text is shown by the
    // module as the JSON it is, so the SDK's are put the same way to compare.
    const [, local, platform] = /^local (.*) ≠ platform (.*)$/s.exec(sdk.verdict.detail)!;
    assert.deepEqual(mine.verdict.mine, JSON.parse(local!), `${what}: the axes the engine found`);
    assert.deepEqual(mine.verdict.theirs, Object.fromEntries(Object.entries(JSON.parse(platform!) as Obj)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])), `${what}: the axes the package states`);
    assert.equal(mine.verdict.problem, undefined, `${what}: a difference is not a problem`);
  } else {
    assert.match(sdk.verdict.detail, /^could not be re-evaluated/, what);
    assert.equal(typeof mine.verdict.problem, 'string', `${what}: the SDK could not re-evaluate; the module must say so too`);
  }

  // Anchor: pending, a bundle report, or a bundle that could not be read.
  if (sdk.anchor.detail.startsWith('no bundle present')) {
    assert.deepEqual([mine.anchor.pending, mine.anchor.leafMatches, mine.anchor.bundle], [true, null, null], what);
  } else if (mine.anchor.bundle !== null) {
    assert.equal(
      `leaf==commitment:${mine.anchor.leafMatches} ${mine.anchor.bundle.checks.map((c) => `${c.id}:${c.state}`).join(' ')}`,
      sdk.anchor.detail, `${what}: the bundle's own checks`);
    assert.equal(mine.anchor.pending, false, what);
  } else {
    assert.equal(mine.anchor.problem, sdk.anchor.detail, `${what}: why the bundle could not be read`);
    assert.equal(mine.anchor.pending, false, what);
  }
  return { mine, sdk };
}

// ── the cases ──────────────────────────────────────────────────────────────

interface Case {
  what: string;
  /** Edits a deep copy of the fixture — or returns something else to check instead. */
  edit: (r: Obj) => unknown;
  /** The checks that must fail, in the report's order. */
  fails: Check[];
  /** The SDK gives no report for this: it throws. */
  sdkThrows?: true;
  /** What else the report has to say. */
  also?: (m: EvidenceCheckReport) => void;
}

const pending = (m: EvidenceCheckReport): void => assert.equal(m.anchor.pending, true);
const uncheckable = (m: EvidenceCheckReport): void => {
  assert.equal(typeof m.signatures.problem, 'string');
  assert.match(m.verdict.problem ?? '', /^not re-evaluated/, 'a verdict is not re-run over signatures nobody could check');
};
/** Every check failed, and nothing was found pending: there is no response to wait on. */
const nothing = (m: EvidenceCheckReport): void => {
  for (const c of CHECKS) assert.equal(typeof m[c].problem, 'string', `${c} says why`);
  assert.equal(m.anchor.pending, false);
  assert.deepEqual(m.subject, { paymentId: null, state: null, generatedAt: null });
};

const stranger = spkiOf('ec', 'P-256').toString('base64');

const CASES: Case[] = [
  {
    what: 'the file as the platform handed it out',
    edit: () => undefined,
    fails: [],
    also: (m) => {
      assert.equal(m.verified, true);
      assert.equal(m.commitment.computed, m.commitment.stated);
      assert.equal(listed(m), 'chainTransfer:VALID payoutReceipts:VALID bankInstruction:VALID commercialDocs:VALID travelRule:VALID bankApproval:VALID');
      assert.deepEqual(m.verdict.mine, {
        integrity: 'VALID', issuer: 'VALID', matching: 'MATCH', completeness: 'COMPLETE', regulatoryMapping: 'REVIEW_REQUIRED', businessFinality: 'DEMO_ONLY',
      });
      assert.deepEqual([m.anchor.pending, m.anchor.leafMatches, m.anchor.bundle?.verified, m.anchor.bundle?.network], [false, true, true, 'regtest']);
      assert.deepEqual(m.subject, { paymentId: 'PAY-ce3ea871-0ed0920352', state: 'BENEFICIARY_CREDIT_CONFIRMED', generatedAt: '2026-11-18T07:34:42.253Z' });
    },
  },

  // ── the anchor ───────────────────────────────────────────────────────────
  { what: 'no bundle yet: the anchor is not confirmed', edit: (r) => { attestation(r).bundle = null; }, fails: ['anchor'], also: pending },
  { what: 'no attestation at all', edit: (r) => { delete r.attestation; }, fails: ['anchor'], also: pending },
  {
    what: 'the bundle of another record',
    edit: (r) => { attestation(r).bundle = structuredClone(OTHER_BUNDLE); },
    fails: ['anchor'],
    also: (m) => assert.deepEqual([m.anchor.leafMatches, m.anchor.bundle?.verified], [false, true], 'a sound bundle, of something else'),
  },
  {
    what: 'a merkle path that does not lead to the root',
    edit: (r) => { Object.assign(bundle(r).merkle as Obj, { siblings: ['00'.repeat(32)], directions: ['left'] }); },
    fails: ['anchor'],
    also: (m) => assert.deepEqual([m.anchor.leafMatches, m.anchor.bundle?.verified, m.anchor.bundle?.links.B], [true, false, 'fail']),
  },
  {
    what: 'a merkle root with one digit changed',
    edit: (r) => { const merkle = bundle(r).merkle as Obj; merkle.root = flipped(merkle.root as string); },
    fails: ['anchor'],
    also: (m) => assert.deepEqual([m.anchor.leafMatches, m.anchor.bundle?.verified], [true, false]),
  },
  {
    what: 'the leaf written in capitals',
    edit: (r) => { const record = bundle(r).record as Obj; record.leaf_bytes = (record.leaf_bytes as string).toUpperCase(); },
    fails: ['anchor'],
    also: (m) => assert.deepEqual([m.anchor.leafMatches, m.anchor.bundle?.verified], [false, true], 'the bundle reads it; it is not the commitment as stated'),
  },
  { what: 'a bundle that is text', edit: (r) => { attestation(r).bundle = 'not a bundle'; }, fails: ['anchor'], also: (m) => assert.equal(m.anchor.bundle?.verified, false) },
  {
    what: 'a bundle with a schema and nothing under it',
    edit: (r) => { attestation(r).bundle = { schema: 'bitcert-proof-bundle/v1' }; },
    fails: ['anchor'],
    also: (m) => assert.deepEqual([m.anchor.bundle, m.anchor.pending, typeof m.anchor.problem], [null, false, 'string']),
  },

  // ── the commitment ───────────────────────────────────────────────────────
  {
    what: 'one digit of the nonce changed',
    edit: (r) => { commitment(r).nonce = flipped(commitment(r).nonce as string); },
    fails: ['commitment'],
    also: (m) => {
      assert.match(m.commitment.computed ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(m.commitment.computed, m.commitment.stated);
      assert.equal(m.commitment.problem, undefined, 'the hash was made; it is simply another hash');
    },
  },
  { what: 'a nonce in capitals', edit: (r) => { commitment(r).nonce = (commitment(r).nonce as string).toUpperCase(); }, fails: [] },
  {
    what: 'a nonce one digit short',
    edit: (r) => { commitment(r).nonce = (commitment(r).nonce as string).slice(0, -1); },
    fails: ['commitment'],
    also: (m) => assert.deepEqual([m.commitment.computed, typeof m.commitment.problem], [null, 'string']),
  },
  {
    what: 'a nonce that is not hex',
    edit: (r) => { commitment(r).nonce = `zz${(commitment(r).nonce as string).slice(2)}`; },
    fails: ['commitment'],
    also: (m) => assert.deepEqual([m.commitment.computed, typeof m.commitment.problem], [null, 'string']),
  },
  {
    what: 'a nonce whose last byte is half hex, committed to the way a looser reader takes it',
    edit: (r) => {
      // The nonce ends "…b4"; as "…bg" a reader that parses each pair as a
      // number takes the last byte for 0b, and Node stops before it. The
      // commitment here is made for that looser reading: neither may take it.
      const nonce = commitment(r).nonce as string;
      commitment(r).nonce = `${nonce.slice(0, -1)}g`;
      commitment(r).value = createHash('sha256').update(Buffer.concat([
        Buffer.from('STONEHASH-EVIDENCE-V1', 'utf8'),
        Buffer.from(nonce.slice(0, -2), 'hex'), Buffer.from([Number.parseInt(nonce.at(-2)!, 16)]),
        Buffer.from(jcsString(r.package as JcsValue), 'utf8'),
      ])).digest('hex');
    },
    fails: ['commitment', 'anchor'],
  },
  { what: 'an empty nonce', edit: (r) => { commitment(r).nonce = ''; }, fails: ['commitment'], also: (m) => assert.equal(m.commitment.problem, undefined) },
  { what: 'a nonce that is an empty list', edit: (r) => { commitment(r).nonce = []; }, fails: ['commitment'], also: (m) => assert.equal(typeof m.commitment.problem, 'string') },
  { what: 'a nonce that is a number', edit: (r) => { commitment(r).nonce = 7; }, fails: ['commitment'], sdkThrows: true },
  { what: 'no nonce', edit: (r) => { delete commitment(r).nonce; }, fails: ['commitment'], sdkThrows: true },
  {
    what: 'no commitment',
    edit: (r) => { delete r.commitment; },
    fails: ['commitment', 'anchor'],
    sdkThrows: true,
    also: (m) => assert.deepEqual([m.commitment.stated, m.anchor.leafMatches, m.anchor.bundle?.verified], [null, false, true], 'nothing for the leaf to be'),
  },
  {
    what: 'the stated commitment in capitals',
    edit: (r) => { commitment(r).value = (commitment(r).value as string).toUpperCase(); },
    fails: ['commitment', 'anchor'],
    also: (m) => assert.equal(m.anchor.leafMatches, false),
  },
  {
    what: 'a stated commitment that is not text',
    edit: (r) => { commitment(r).value = 7; },
    fails: ['commitment', 'anchor'],
    also: (m) => assert.deepEqual([m.commitment.stated, typeof m.commitment.computed], [null, 'string']),
  },
  {
    what: 'a number with a fraction in the package, which the canonical form has no rule for',
    edit: (r) => { pkg(r).fee = 1.5; },
    fails: ['commitment'],
    sdkThrows: true,
    also: (m) => assert.match(m.commitment.problem ?? '', /jcs/),
  },
  { what: 'a package that is null', edit: (r) => { r.package = null; }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  { what: 'no package', edit: (r) => { delete r.package; }, fails: ['commitment', 'signatures', 'verdict'], sdkThrows: true, also: uncheckable },

  // ── the signatures ───────────────────────────────────────────────────────
  {
    what: 'an amount changed inside a signed element',
    edit: (r) => { elements(r).bankInstruction!.amount = '8400.51'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => {
      assert.equal(listed(m), 'chainTransfer:VALID payoutReceipts:VALID bankInstruction:INVALID commercialDocs:VALID travelRule:VALID bankApproval:VALID');
      assert.deepEqual([m.verdict.mine?.issuer, m.verdict.mine?.matching], ['INVALID', 'MISMATCH'], 'an edited instruction breaks its signature and the reconciliation');
    },
  },
  {
    what: 'the same, with the commitment computed again over the edited package',
    edit: (r) => { elements(r).bankInstruction!.amount = '8400.51'; reseal(r); },
    fails: ['signatures', 'verdict', 'anchor'],
    also: (m) => assert.deepEqual([m.commitment.ok, m.anchor.leafMatches, m.anchor.bundle?.verified], [true, false, true], 'the chain still holds the old commitment'),
  },
  {
    what: "one element's signature value swapped for another element's",
    edit: (r) => { signature(elements(r).bankInstruction!).value = signature(elements(r).commercialDocs!).value; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), statusOf(m, 'commercialDocs')], [['INVALID'], ['VALID']]),
  },
  {
    what: 'a signature whose keyId names a key the registry does not hold',
    edit: (r) => { signature(elements(r).travelRule!).keyId = 'NOBODY-001'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'travelRule'), m.verdict.mine?.issuer], [['UNKNOWN_KEY'], 'UNKNOWN_ISSUER']),
  },
  {
    what: "a signature whose keyId names another institution's key",
    edit: (r) => { signature(elements(r).travelRule!).keyId = BANK; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'travelRule'), ['INVALID']),
  },
  {
    what: 'a keyId that is the number 7 where the registry has the text "7"',
    edit: (r) => { institution(r, BANK).id = '7'; for (const name of ['bankInstruction', 'commercialDocs', 'bankApproval']) signature(elements(r)[name]!).keyId = 7; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'bankInstruction'), ['UNKNOWN_KEY'], 'an id is matched as written, not as text'),
  },
  {
    what: 'a keyId and a registry id that are both the number 7',
    edit: (r) => { institution(r, BANK).id = 7; for (const name of ['bankInstruction', 'commercialDocs', 'bankApproval']) signature(elements(r)[name]!).keyId = 7; },
    fails: ['commitment'],
  },
  {
    what: 'a signature removed',
    edit: (r) => { delete elements(r).commercialDocs!.signature; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'commercialDocs'), m.verdict.mine?.issuer], [['ABSENT'], 'UNKNOWN_ISSUER']),
  },
  {
    what: 'signatures that declare VALID and carry no value',
    edit: (r) => { delete signature(elements(r).bankInstruction!).value; signature(elements(r).commercialDocs!).value = ''; elements(r).bankApproval!.signature = null; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), statusOf(m, 'commercialDocs'), statusOf(m, 'bankApproval')], [['ABSENT'], ['ABSENT'], ['ABSENT']]),
  },
  {
    what: 'a signature that says INVALID, DEMO and unchecked of itself, over a value that verifies',
    edit: (r) => { Object.assign(signature(elements(r).bankInstruction!), { status: 'INVALID', trustLevel: 'DEMO', checked: false, issuer: 'someone else', algorithm: 'RS256' }); },
    // What a signature says of itself is not signed and not read: the status,
    // the trust level and the signer the engine sees are the ones found here.
    fails: ['commitment'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), m.verdict.mine?.issuer], [['VALID'], 'VALID']),
  },
  {
    what: 'a signature that says ABSENT of itself though a value is there',
    edit: (r) => { signature(elements(r).travelRule!).status = 'ABSENT'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'travelRule'), ['ABSENT']),
  },
  {
    what: 'signature values that cannot be decoded',
    edit: (r) => { signature(elements(r).bankInstruction!).value = 12345; signature(elements(r).commercialDocs!).value = '***'; signature(elements(r).bankApproval!).value = 'AAAA'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), statusOf(m, 'commercialDocs'), statusOf(m, 'bankApproval')], [['INVALID'], ['INVALID'], ['INVALID']]),
  },
  {
    what: 'a signature value in the standard alphabet, padded',
    edit: (r) => { const s = signature(elements(r).bankInstruction!); s.value = Buffer.from(s.value as string, 'base64url').toString('base64'); },
    fails: ['commitment'],
    also: (m) => assert.deepEqual(statusOf(m, 'bankInstruction'), ['VALID'], 'the same 64 bytes, written the other way'),
  },
  {
    what: 'a number with a fraction inside one element, so what its issuer signed cannot be put in canonical form',
    edit: (r) => { elements(r).travelRule!.kytRiskScore = 12.5; },
    fails: ['commitment', 'signatures', 'verdict'],
    sdkThrows: true,
    also: (m) => assert.deepEqual(statusOf(m, 'travelRule'), ['INVALID']),
  },
  {
    what: "the signer's registry key replaced by garbage",
    edit: (r) => { institution(r, BANK).signing_spki = 'bm90IGEga2V5'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: uncheckable,
  },
  {
    what: "a bystander's registry key replaced by garbage",
    edit: (r) => { institution(r, BYSTANDER).signing_spki = 'bm90IGEga2V5'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: uncheckable,
  },
  {
    what: 'a registry key that is junk with a real key\'s point as its last 65 bytes',
    edit: (r) => {
      const point = Buffer.from(institution(r, BANK).signing_spki as string, 'base64').subarray(-65);
      institution(r, BANK).signing_spki = Buffer.concat([Buffer.from('00112233445566778899', 'hex'), point]).toString('base64');
    },
    fails: ['commitment', 'signatures', 'verdict'],
    also: uncheckable,
  },
  {
    what: "the signer's registry key with one byte of its header changed",
    edit: (r) => {
      const der = Buffer.from(institution(r, BANK).signing_spki as string, 'base64');
      der[20] = der[20]! ^ 1; // inside the curve's name: still 91 bytes, still the same point
      institution(r, BANK).signing_spki = der.toString('base64');
    },
    fails: ['commitment', 'signatures', 'verdict'],
    also: uncheckable,
  },
  {
    what: "the signer's registry key replaced by another valid P-256 key",
    edit: (r) => { institution(r, BANK).signing_spki = stranger; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.equal(listed(m), 'chainTransfer:VALID payoutReceipts:VALID bankInstruction:INVALID commercialDocs:INVALID travelRule:VALID bankApproval:INVALID'),
  },
  {
    what: "the signer's key withdrawn from the registry",
    edit: (r) => { institution(r, BANK).signing_spki = null; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'bankApproval'), ['UNKNOWN_KEY']),
  },
  { what: "a bystander's key withdrawn from the registry", edit: (r) => { institution(r, BYSTANDER).signing_spki = ''; }, fails: ['commitment'] },
  { what: 'an institution listed twice', edit: (r) => { institutions(r).push(structuredClone(institution(r, BYSTANDER))); }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  { what: 'an institution that is null', edit: (r) => { institutions(r).push(null as unknown as Obj); }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  { what: 'an institution that is text', edit: (r) => { institutions(r).push('VN-BANK-002' as unknown as Obj); }, fails: ['commitment'] },
  { what: 'institutions that are not a list', edit: (r) => { (pkg(r).trust_registry as Obj).institutions = { [BANK]: institution(r, BANK) }; }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  { what: 'no trust registry', edit: (r) => { delete pkg(r).trust_registry; }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  {
    what: 'an extra element under a name nobody checks, calling itself VALID',
    edit: (r) => { elements(r).notarisation = { signature: { status: 'VALID' } }; },
    fails: ['commitment', 'signatures'],
    also: (m) => assert.deepEqual([statusOf(m, 'notarisation'), m.verdict.ok], [['NOT_VERIFIED'], true], 'the engine does not read it; the signatures check does not take its word'),
  },
  {
    what: 'a list of them',
    edit: (r) => { (elements(r) as Obj).extras = [{ signature: { status: 'VALID' } }, { signature: { status: 'VALID' } }]; },
    fails: ['commitment', 'signatures'],
    also: (m) => assert.deepEqual(statusOf(m, 'extras'), ['NOT_VERIFIED', 'NOT_VERIFIED']),
  },
  {
    what: 'no elements at all',
    edit: (r) => { evidence(r).elements = {}; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([m.signatures.elements, m.signatures.problem, m.verdict.mine?.completeness, m.verdict.problem],
      [[], 'the package carries no evidence element', 'INCOMPLETE', undefined], 'nothing was there to check; the engine was still run'),
  },
  { what: 'elements that are null', edit: (r) => { evidence(r).elements = null; }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  { what: 'no evidence', edit: (r) => { delete pkg(r).evidence; }, fails: ['commitment', 'signatures', 'verdict'], also: uncheckable },
  {
    what: 'elements that are text',
    edit: (r) => { evidence(r).elements = 'abc'; },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.equal(listed(m), '0:NOT_VERIFIED 1:NOT_VERIFIED 2:NOT_VERIFIED'),
  },
  {
    what: 'a second payout receipt whose amount was changed after signing',
    edit: (r) => { receipts(r).push({ ...structuredClone(receipts(r)[0]!), amount: '1.00' }); },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'payoutReceipts'), ['VALID', 'INVALID']),
  },
  {
    what: 'payout receipts with things in the list that are not receipts',
    edit: (r) => { receipts(r).push('a receipt' as unknown as Obj, [receipts(r)[0]] as unknown as Obj); },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual(statusOf(m, 'payoutReceipts'), ['VALID', 'ABSENT', 'ABSENT']),
  },
  {
    what: 'the payout receipt given as one object, not a list',
    edit: (r) => { (elements(r) as Obj).payoutReceipts = receipts(r)[0]; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'payoutReceipts'), m.verdict.mine, typeof m.verdict.problem], [['VALID'], null, 'string'], 'signed, and nothing the engine can evaluate'),
  },
  {
    what: 'the bank instruction given as a list',
    edit: (r) => { (elements(r) as Obj).bankInstruction = [elements(r).bankInstruction]; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), m.verdict.mine, typeof m.verdict.problem], [['VALID'], null, 'string']),
  },
  {
    what: 'elements that are null, text and a number',
    edit: (r) => { Object.assign(elements(r), { bankInstruction: null, travelRule: 'approved', bankApproval: 7 }); },
    fails: ['commitment', 'signatures', 'verdict'],
    also: (m) => assert.deepEqual([statusOf(m, 'bankInstruction'), statusOf(m, 'travelRule'), statusOf(m, 'bankApproval')], [['ABSENT'], ['ABSENT'], ['ABSENT']]),
  },

  // ── the verdict ──────────────────────────────────────────────────────────
  {
    what: 'one axis of the stated verdict flipped',
    edit: (r) => { axes(r).matching!.state = 'MISMATCH'; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([m.verdict.mine?.matching, m.verdict.theirs?.matching, m.verdict.problem], ['MATCH', 'MISMATCH', undefined]),
  },
  {
    what: 'the same, with the commitment computed again',
    edit: (r) => { axes(r).matching!.state = 'MISMATCH'; reseal(r); },
    fails: ['verdict', 'anchor'],
  },
  { what: 'a stated axis missing', edit: (r) => { delete axes(r).businessFinality; }, fails: ['commitment', 'verdict'] },
  {
    what: 'a stated state that is not text',
    edit: (r) => { axes(r).matching!.state = 7; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.equal(m.verdict.theirs?.matching, '7'),
  },
  {
    what: 'a stated axis that is null',
    edit: (r) => { (axes(r) as Obj).matching = null; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([m.verdict.theirs, m.verdict.mine?.matching, typeof m.verdict.problem], [null, 'MATCH', 'string']),
  },
  {
    what: 'no stated verdict',
    edit: (r) => { delete pkg(r).verdict; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([m.verdict.theirs, m.verdict.mine?.matching, typeof m.verdict.problem], [null, 'MATCH', 'string']),
  },
  {
    what: 'the policy changed to ask for more trust than the signers have',
    edit: (r) => { policy(r).sourceTrustLevel = 'ACCREDITED'; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([m.verdict.mine?.issuer, m.verdict.theirs?.issuer], ['UNKNOWN_ISSUER', 'VALID']),
  },
  {
    what: 'the policy changed to stop allowing the settlement currency',
    edit: (r) => { policy(r).currencies = ['USD']; policy(r).unitOfAccountGroups = [['USD']]; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.equal(m.verdict.mine?.matching, 'MISMATCH'),
  },
  { what: 'the policy changed where no axis depends on it', edit: (r) => { policy(r).amountTolerance = '0.01'; }, fails: ['commitment'] },
  {
    what: 'a policy the engine refuses',
    edit: (r) => { policy(r).settlementWindow = 'P1M'; },
    fails: ['commitment', 'verdict'],
    also: (m) => assert.deepEqual([m.verdict.mine, typeof m.verdict.theirs?.matching, /settlementWindow/.test(m.verdict.problem ?? '')], [null, 'string', true]),
  },
  { what: 'no policy', edit: (r) => { delete pkg(r).policy; }, fails: ['commitment', 'verdict'], also: (m) => assert.equal(typeof m.verdict.problem, 'string') },

  // ── not an evidence response at all ──────────────────────────────────────
  { what: 'null', edit: () => null, fails: CHECKS, sdkThrows: true, also: nothing },
  { what: 'text', edit: () => 'PAY-ce3ea871-0ed0920352', fails: CHECKS, sdkThrows: true, also: nothing },
  { what: 'a number', edit: () => 7, fails: CHECKS, sdkThrows: true, also: nothing },
  { what: 'an empty list', edit: () => [], fails: CHECKS, sdkThrows: true },
  { what: 'an empty object', edit: () => ({}), fails: CHECKS, sdkThrows: true },
  { what: 'a list holding the response', edit: (r) => [r], fails: CHECKS, sdkThrows: true },
  { what: 'a proof bundle', edit: () => structuredClone(OTHER_BUNDLE), fails: CHECKS, sdkThrows: true },
  { what: 'the package alone, without the response around it', edit: (r) => r.package, fails: CHECKS, sdkThrows: true },
];

for (const c of CASES) {
  test(`evidence check — ${c.what}`, { skip }, async () => {
    const copy = structuredClone(ANCHORED);
    const made = c.edit(copy);
    const { mine, sdk } = await held(c.what, made === undefined ? copy : made);
    assert.equal(sdk === null, c.sdkThrows === true, c.sdkThrows ? 'the SDK was expected to throw on this' : 'the SDK was expected to report on this');
    assert.deepEqual(failing(mine), c.fails, 'the checks that fail');
    c.also?.(mine);
  });
}

// ── what the cases above cannot say one at a time ──────────────────────────

test('evidence check — the fixture is told from a proof bundle', { skip }, () => {
  assert.equal(looksLikeEvidence(ANCHORED), true);
  // The two bundle samples: another record's, and this response's own.
  assert.equal(looksLikeEvidence(OTHER_BUNDLE), false);
  assert.equal(looksLikeEvidence(bundle(ANCHORED)), false);
  assert.equal(looksLikeEvidence({ package: {}, commitment: {} }), true, 'the shape is all it looks at');
  const throwing = new Proxy({}, { get: () => { throw new Error('no'); } });
  for (const other of [null, undefined, 'text', 7, true, [], {}, [ANCHORED], pkg(ANCHORED), { package: {} }, { commitment: {} },
    { package: [], commitment: {} }, { package: {}, commitment: 'x' }, { package: null, commitment: null }, () => ANCHORED, throwing]) {
    assert.equal(looksLikeEvidence(other), false);
  }
});

test('evidence check — whatever it is given, it answers with a report', { skip }, async () => {
  // Not JSON, and nothing the SDK is ever handed: a page can be. Each of
  // these would throw somewhere if a check read it outside its own guard.
  const cyclic: Obj = { commitment: { value: 'x', nonce: '00' } };
  cyclic.package = cyclic;
  const sealed = (over: Obj): Obj => ({ ...structuredClone(ANCHORED), ...over });
  const hostile: [string, unknown][] = [
    ['undefined', undefined], ['a symbol', Symbol('evidence')], ['a function', () => ANCHORED], ['a date', new Date(0)], ['a map', new Map([['package', {}]])],
    ['an object every read of which throws', new Proxy({}, { get: () => { throw new Error('no'); } })],
    ['a package that throws when read', Object.defineProperty({ commitment: {} }, 'package', { enumerable: true, get: () => { throw new Error('no'); } })],
    ['something thrown that cannot be put into words', Object.defineProperty({}, 'package', { get: () => { throw { toString: () => { throw new Error('no'); } }; } })],
    ['a package that contains itself', cyclic],
    ['a state that JSON cannot write', sealed({ package: { ...structuredClone(pkg(ANCHORED)), evidence: null, verdict: { axes: { matching: { state: 10n } } } } })],
    ['evidence that cannot be copied', sealed({ package: { ...structuredClone(pkg(ANCHORED)), evidence: { elements: { bankInstruction: () => 'signed' } } } })],
    ['a bundle every read of which throws', sealed({ attestation: { bundle: new Proxy({}, { get: () => { throw new Error('no'); } }) } })],
  ];
  for (const [what, value] of hostile) {
    assert.doesNotThrow(() => looksLikeEvidence(value), what);
    const report = await checkEvidence(value);
    assert.equal(report.verified, false, what);
    for (const c of CHECKS) assert.equal(typeof report[c].ok, 'boolean', `${what}: ${c}`);
    assert.ok(CHECKS.some((c) => typeof report[c].problem === 'string'), `${what}: some check says what was wrong`);
  }
});

test('evidence check — the caller\'s object is left as it was, frozen or not', { skip }, async () => {
  const freeze = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
  };
  const frozen = freeze(structuredClone(ANCHORED));
  const report = await checkEvidence(frozen);
  assert.equal(report.verified, true, 'a check that wrote to its input would have failed on a frozen one');
  assert.deepEqual(frozen, ANCHORED);
  // The stored evidence already says `checked: true` on every signature. That
  // is the platform's word; what the engine is given is computed here.
  assert.equal(signature(elements(ANCHORED).bankInstruction!).checked, true);
});

test('evidence check — it needs no crypto.subtle, which this console\'s origin does not have', { skip }, async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try {
    assert.equal(globalThis.crypto.subtle, undefined, 'the page as the browser serves it over plain http');
    // The SDK's way of verifying does not fail loudly here: it calls every signature invalid.
    const sdk = (await sdkReport(structuredClone(ANCHORED)))!;
    assert.deepEqual([sdk.signatures.ok, /bankInstruction:INVALID/.test(sdk.signatures.detail)], [false, true]);
    // The module must not have gone that way.
    const mine = await checkEvidence(structuredClone(ANCHORED));
    assert.deepEqual([mine.verified, failing(mine)], [true, []]);
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
  }
  assert.equal(typeof globalThis.crypto.subtle, 'object');
});

test('evidence check — the module is a value in and a report out, on the SDK\'s own rules', { skip }, () => {
  const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const source = strip(readFileSync(path.resolve(HERE, '../src/evidence-check.ts'), 'utf8'));
  assert.doesNotMatch(source, /\b(document|window|navigator|location|fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|console)\b/, 'no DOM, no network, no storage, no logging');
  assert.doesNotMatch(source, /from 'node:|\bBuffer\b|\brequire\(|\bprocess\b/, 'nothing of Node');
  assert.doesNotMatch(source, /\bcrypto\b/, 'no WebCrypto: the origin has none');
  assert.doesNotMatch(source, /\bverifySignature\b|\bverifyEvidenceSignatures\b/, 'the engine\'s verifier needs crypto.subtle and answers INVALID without it');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).filter((spec) => !spec!.startsWith('./vendor/')), [], 'only the vendored packages are imported');

  // The engine and the signed-bytes rule the module runs are the package's
  // own files; the one edit is the verifier's specifier, which a browser with
  // no bundler cannot follow by package name. A stale copy would make every
  // comparison above one between two versions of the rules.
  const names = readdirSync(VENDORED_RULES).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(names, ['decimal.ts', 'engine.ts', 'policy.ts', 'signature.ts', 'types.ts']);
  for (const f of names) {
    const want = readFileSync(path.join(RULES, f), 'utf8').replaceAll("from '@stonehash/attest-verify'", "from '../attest-verify/index.ts'");
    assert.equal(readFileSync(path.join(VENDORED_RULES, f), 'utf8'), want, `vendor/attest-rules/${f} has drifted from the package — run \`node build.mjs sync\``);
    assert.doesNotMatch(strip(want), /from 'node:|\bBuffer\b/, `${f} is not portable`);
    for (const m of strip(want).matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(existsSync(path.resolve(VENDORED_RULES, m[1]!)), `${f} imports ${m[1]}, which is not vendored`);
    }
  }
});

/**
 * The order a package lists its axes in carries no meaning.
 *
 * The canonical form the commitment is made over sorts keys, so a package
 * whose stated axes are in another order is the same package: its commitment
 * and its anchor hold. The module compares the two verdicts axis by axis, and
 * since its release of 2026-11-19 so does the SDK — it used to compare them as
 * JSON text, where order counts, and called this a mismatch, which any tool
 * that re-serialises a stored file would then cause. Nothing differs in this
 * direction any more: every difference left is the module refusing what the
 * SDK accepts.
 */
test('evidence check — a package whose stated axes are in another order is the same package', { skip }, async () => {
  const input = structuredClone(ANCHORED);
  const verdict = pkg(input).verdict as Obj;
  verdict.axes = Object.fromEntries(Object.entries(axes(input)).reverse());
  const sdk = (await sdkReport(structuredClone(input)))!;
  const mine = await checkEvidence(input);
  assert.deepEqual([sdk.commitment.ok, sdk.signatures.ok, sdk.verdict.ok, sdk.anchor.ok], [true, true, true, true], 'the SDK reads it as the same package too');
  assert.deepEqual([mine.commitment.ok, mine.signatures.ok, mine.verdict.ok, mine.anchor.ok, mine.verified], [true, true, true, true, true]);
  assert.deepEqual(Object.entries(mine.verdict.theirs ?? {}).reverse(), Object.entries(mine.verdict.mine ?? {}), 'each axis agrees; only the order differs');
  // The same order-blindness must not hide a real difference: one state changed, in the reversed map.
  const changed = structuredClone(input);
  axes(changed).matching!.state = 'MISMATCH';
  reseal(changed);
  assert.equal((await checkEvidence(changed)).verdict.ok, false);
  // …nor an axis left out or added.
  const fewer = structuredClone(input);
  delete axes(fewer).businessFinality;
  reseal(fewer);
  assert.equal((await checkEvidence(fewer)).verdict.ok, false);
  const more = structuredClone(input);
  axes(more).extra = { state: 'VALID' };
  reseal(more);
  assert.equal((await checkEvidence(more)).verdict.ok, false);
});

/**
 * Where the module is stricter than the SDK, on purpose.
 *
 * Node reads these files and the SDK passes them; a page cannot follow how
 * Node read them, so the module refuses instead. Every entry is a file on
 * which the two differ, the check they differ on, and the direction — always
 * the SDK accepting what the module does not. If one of these starts to pass
 * here, that has to have been decided, not to have happened.
 */
test('evidence check — where Node reads a malformed file generously, the module refuses it', { skip }, async () => {
  const bankKey = Buffer.from(institution(ANCHORED, BANK).signing_spki as string, 'base64');
  const point = bankKey.subarray(-65);
  const compressed = Buffer.concat([
    Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'),
    Buffer.from([2 + (point[64]! & 1)]), point.subarray(1, 33),
  ]);
  const withKey = (spki: unknown, id = BANK) => (r: Obj): void => { institution(r, id).signing_spki = spki; };
  const differences: { what: string; edit: (r: Obj) => void; on: Check[] }[] = [
    // The nonce: Node decodes hex up to the first thing that is not a hex byte and hashes what it got.
    { what: 'a nonce with something after its last byte', edit: (r) => { commitment(r).nonce = `${commitment(r).nonce as string}zz`; }, on: ['commitment'] },
    { what: 'a nonce with half a byte after its last byte', edit: (r) => { commitment(r).nonce = `${commitment(r).nonce as string}a`; }, on: ['commitment'] },
    { what: 'a nonce given as a list of byte values', edit: (r) => { commitment(r).nonce = [...Buffer.from(commitment(r).nonce as string, 'hex')]; }, on: ['commitment'] },
    // A registry key: Node skips what is not base64, takes either alphabet, and reads more than one form of key.
    { what: 'the signer\'s key with a line break in its base64', edit: withKey(`${bankKey.toString('base64').slice(0, 64)}\n${bankKey.toString('base64').slice(64)}`), on: ['signatures', 'verdict'] },
    { what: 'the signer\'s key in the URL alphabet, unpadded', edit: withKey(bankKey.toString('base64url')), on: ['signatures', 'verdict'] },
    { what: 'the signer\'s key as a list of byte values', edit: withKey([...bankKey]), on: ['signatures', 'verdict'] },
    { what: 'the signer\'s key with bytes after it', edit: withKey(Buffer.concat([bankKey, Buffer.from('deadbeef', 'hex')]).toString('base64')), on: ['signatures', 'verdict'] },
    { what: 'the signer\'s key with its point compressed', edit: withKey(compressed.toString('base64')), on: ['signatures', 'verdict'] },
    // A key of another kind: the SDK keeps it in its ring, where it only matters to a signature that names it.
    { what: 'a bystander holding an Ed25519 key', edit: withKey(spkiOf('ed25519').toString('base64'), BYSTANDER), on: ['signatures', 'verdict'] },
    { what: 'a bystander holding a P-384 key', edit: withKey(spkiOf('ec', 'P-384').toString('base64'), BYSTANDER), on: ['signatures', 'verdict'] },
  ];
  for (const d of differences) {
    const input = structuredClone(ANCHORED);
    d.edit(input);
    reseal(input); // so that the commitment is not what differs, except where the nonce is
    const before = structuredClone(input);
    const sdk = (await sdkReport(structuredClone(input)))!;
    const mine = await checkEvidence(input);
    assert.deepEqual(input, before, d.what);
    for (const c of CHECKS) {
      if (d.on.includes(c)) {
        assert.deepEqual([sdk[c].ok, mine[c].ok, typeof mine[c].problem], [true, false, 'string'], `${d.what}: ${c} — the SDK accepts, the module refuses and says why`);
      } else {
        assert.equal(mine[c].ok, sdk[c].ok, `${d.what}: ${c} is not where they differ`);
      }
    }
    assert.equal(mine.verified, false, d.what);
  }

  // One more, on a field and not on an answer: the SDK's anchor line says the
  // leaf "is" the commitment when both are missing. The check fails in both;
  // the module does not call two absent things a match.
  const hollow = structuredClone(ANCHORED);
  delete commitment(hollow).value;
  delete (bundle(hollow).record as Obj).leaf_bytes;
  const sdk = (await sdkReport(structuredClone(hollow)))!;
  const mine = await checkEvidence(hollow);
  assert.match(sdk.anchor.detail, /^leaf==commitment:true /);
  assert.deepEqual([sdk.anchor.ok, mine.anchor.ok, mine.anchor.leafMatches], [false, false, false]);
});

/**
 * Times. The engine subtracts one from another, and `Date.parse` reads a time
 * that states no zone in the zone of the machine it runs on: the SDK's verdict
 * over such a time is the verdict of that server, nine hours away from a
 * browser in Seoul. Other spellings are read by each engine's own habits. The
 * module holds every time the engine reads to ISO 8601 with its zone, and
 * gives no verdict over anything else.
 *
 * A time sits inside a signed element, so these are signed again with the
 * test's own key: what is checked is an institution that signed such a time,
 * not a time edited afterwards — that one fails on its signature, in both.
 */
test('evidence check — a time the engine reads has to read the same on every machine', { skip }, async () => {
  const instruction = (r: Obj): Obj => elements(r).bankInstruction!;
  const quote = (r: Obj): Obj => elements(r).bankApproval!.fxQuote as Obj;

  // Written the other ways the standard allows, a time is the same instant everywhere: the same answers as the SDK.
  const same = structuredClone(ANCHORED);
  instruction(same).approvedAt = '2026-11-18T14:34:41.959+07:00';
  Object.assign(quote(same), { quotedAt: '2026-11-18T07:34:41.946000Z', validUntil: '2026-11-18T07:44:41Z' });
  await signedAgain(same);
  const held1 = await held('times written the other ways the standard allows', same);
  assert.deepEqual([failing(held1.mine), held1.sdk?.verdict.ok], [['anchor'], true], 'all but the anchor, which is of the package before it was signed again');

  const refused: [string, (r: Obj) => void, RegExp][] = [
    ['a time without a zone', (r) => { instruction(r).approvedAt = '2026-11-18T07:34:41.959'; }, /bankInstruction\.approvedAt/],
    ['a time with a space where the T belongs', (r) => { quote(r).validUntil = '2026-11-18 07:44:41Z'; }, /fxQuote\.validUntil/],
    ['a day the calendar does not have', (r) => { quote(r).quotedAt = '2026-02-30T00:00:00Z'; }, /fxQuote\.quotedAt/],
    ['a time that is a number', (r) => { instruction(r).approvedAt = 1794900881959; }, /bankInstruction\.approvedAt/],
  ];
  for (const [what, edit, where] of refused) {
    const input = structuredClone(ANCHORED);
    edit(input);
    await signedAgain(input);
    const sdk = (await sdkReport(structuredClone(input)))!;
    const mine = await checkEvidence(input);
    assert.deepEqual(CHECKS.map((c) => sdk[c].ok), [true, true, true, false], `${what}: to the SDK, on this machine, all but the anchor hold`);
    assert.deepEqual(CHECKS.map((c) => mine[c].ok), [true, true, false, false], `${what}: the module gives no verdict over it`);
    assert.match(mine.verdict.problem ?? '', where, `${what}: and names the time`);
    assert.equal(mine.verdict.mine, null, `${what}: an answer that depends on the machine is not shown as one`);
  }

  // Which times those are is the engine's business, and the module has its
  // list of them. If the engine comes to read another, this is where it shows.
  const engine = readFileSync(path.join(RULES, 'engine.ts'), 'utf8');
  assert.deepEqual([...new Set([...engine.matchAll(/Date\.parse\(([^)]+)\)/g)].map((m) => m[1]))].sort(),
    ['from', 'movedAt', 'quotedAt', 'to', 'tr.approvedAt', 'validUntil'], 'the engine parses a time that machineReadTime() in the module does not look at');
  for (const binding of [
    'const movedAt = el.chainTransfer?.observedAt;',
    'const { quotedAt, validUntil, pair, rate } = approval.fxQuote;',
    'const from = instruction.approvedAt;',
    'const to = transfer?.observedAt ?? receipts[receipts.length - 1]?.paidAt;',
  ]) {
    assert.ok(engine.includes(binding), `the engine no longer reads a time as \`${binding}\` — check machineReadTime() in the module against it`);
  }
});
