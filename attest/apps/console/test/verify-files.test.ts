/**
 * What the 검증 screen decides, held to real files.
 *
 * The screen checks whatever is dropped on it, and the worst it could do is
 * call something sound that is not: a file hashed by the wrong product's rule,
 * a pair that only looks like one, a check that was skipped and counted. So
 * these tests run the deciding module (`src/verify-files.ts`, which has no
 * page in it) over files the sandbox really issued — a document and its
 * bundle, a signed anchor, an inscription, a reserve snapshot's proof file
 * and its bundle with the balance file it was built from, a settlement's
 * evidence package with its bundle inside — and over every way of pairing
 * them wrongly.
 *
 * The sources are loaded directly; `node build.mjs sync` puts the vendored
 * packages where they import them from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vendored = existsSync(path.resolve(HERE, '../src/vendor/attest-rules/engine.ts'));
const skip = vendored ? false : 'src/vendor is not there — run `node build.mjs sync` in apps/console first';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(HERE, 'fixtures', name)));
const json = (name: string): any => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
/** The SDK's own example: the balance file the snapshot in the fixtures was anchored from. */
const BALANCES = path.resolve(HERE, '../../../packages/attest-por/samples/balances.wide.csv');
const balances = (): Uint8Array => new Uint8Array(readFileSync(BALANCES));

const load = async () => import('../src/verify-files.ts');

/** The files, by what they are. */
const files = () => {
  const evidence = json('evidence-anchored.json');
  return {
    document: fixture('document.txt'),
    documentBundle: fixture('document-bundle.json'),
    signedDocument: fixture('signed-document.txt'),
    signedBundle: fixture('signed-bundle.json'),
    inscribedDocument: fixture('inscribed-document.txt'),
    inscriptionBundle: fixture('inscription-bundle.json'),
    proof: fixture('por-proof.json'),
    porBundle: fixture('por-bundle.json'),
    balances: balances(),
    evidence: fixture('evidence-anchored.json'),
    // The bundle of the evidence's own record, as 앵커링 기록 hands it out.
    remitBundle: bytes(evidence.attestation.bundle),
    evidencePending: bytes({ ...evidence, attestation: { ...evidence.attestation, bundle: null } }),
    otherBundle: fixture('bundle-attest.json'),
  };
};

test('the fixtures are what they are said to be', { skip }, () => {
  const proof = json('por-proof.json');
  assert.equal(createHash('sha256').update(balances()).digest('hex'), proof.source.sha256,
    'the SDK\'s example balance file is no longer the one the proof file fixture was written for — anchor it again and replace the fixtures');
  assert.equal(createHash('sha256').update(fixture('document.txt')).digest('hex'), json('document-bundle.json').record.leaf_bytes);
  const signed = json('signed-bundle.json');
  assert.equal(signed.record.preimage.scheme, 'sha256-signed-statement/v1');
  assert.equal(createHash('sha256').update(fixture('signed-document.txt')).digest('hex'), signed.record.preimage.statement.document.sha256);
  const inscription = json('inscription-bundle.json');
  assert.ok(inscription.anchor.witness_envelope, 'the inscription fixture must carry its document in the transaction');
  assert.equal(createHash('sha256').update(fixture('inscribed-document.txt')).digest('hex'), inscription.record.leaf_bytes);
  assert.equal(json('por-bundle.json').record.descriptor.snapshot_id, proof.snapshot_id);
  const evidence = json('evidence-anchored.json');
  assert.equal(evidence.attestation.bundle.record.leaf_bytes, evidence.commitment.value);
});

test('a file is read for what it is, and nothing unreadable is called a proof', { skip }, async () => {
  const { readFile } = await load();
  const f = files();
  assert.equal(readFile(f.document).kind, 'other');
  assert.equal(readFile(f.balances).kind, 'other');
  assert.equal(readFile(f.documentBundle).kind, 'bundle');
  assert.equal(readFile(f.porBundle).kind, 'bundle');
  assert.equal(readFile(f.remitBundle).kind, 'bundle');
  assert.equal(readFile(f.proof).kind, 'snapshot');
  assert.equal(readFile(f.evidence).kind, 'evidence');
  assert.equal(readFile(f.evidencePending).kind, 'evidence');

  const proof = json('por-proof.json');
  // One account's proof is the account holder's file, not the snapshot's.
  assert.equal(readFile(bytes({ schema: 'stonehash.por-proof.v1', root: proof.statement.tree.root })).kind, 'account-proof');
  const damaged = readFile(bytes({ ...proof, seed: 'not hex' }));
  assert.equal(damaged.kind, 'snapshot-unreadable');
  assert.equal(damaged.kind === 'snapshot-unreadable' && damaged.error.code, 'damaged');
  const later = readFile(bytes({ ...proof, schema: 'stonehash.por-snapshot-proof.v9' }));
  assert.equal(later.kind === 'snapshot-unreadable' && later.error.code, 'unsupported_version');

  // A byte-order mark in front, as an editor may leave it, is still the same file.
  assert.equal(readFile(new Uint8Array([0xef, 0xbb, 0xbf, ...f.porBundle])).kind, 'bundle');
  // Everything else is an original at best: JSON that is no proof, an array of accounts, bytes that are not text.
  for (const not of ['{}', '{"record":{}}', '{"record":{"leaf_bytes":7}}', '{"schema":"bitcert-proof-bundle/v1"}', '[{"id":"a","assets":{"BTC":"1"}}]', 'null', '"text"', '{']) {
    assert.equal(readFile(bytes(not)).kind, 'other', not);
  }
  assert.equal(readFile(new Uint8Array([0xff, 0xfe, 0x00, 0x7b])).kind, 'other');
  assert.equal(readFile(new Uint8Array(0)).kind, 'other');
});

test('the two slots mean the same whichever way round they are filled', { skip }, async () => {
  const { planCheck } = await load();
  const f = files();
  const plan = (a: Uint8Array, b: Uint8Array | null = null) => planCheck(a, b);

  // One file.
  assert.deepEqual([plan(f.documentBundle).check, plan(f.evidence).check, plan(f.proof).check], ['bundle', 'evidence', 'snapshot']);
  const alone = plan(f.proof);
  assert.ok(alone.check === 'snapshot' && alone.ledger === null, 'a proof file alone has nothing to be held against');

  // A proof and its original, either way round; the swap is reported so the screen can show the slots as they were read.
  for (const [a, b, swapped] of [[f.documentBundle, f.document, false], [f.document, f.documentBundle, true]] as const) {
    const p = plan(a, b);
    assert.ok(p.check === 'bundle' && p.original?.as === 'document' && p.swapped === swapped);
  }
  for (const [a, b, swapped] of [[f.proof, f.balances, false], [f.balances, f.proof, true]] as const) {
    const p = plan(a, b);
    assert.ok(p.check === 'snapshot' && p.ledger !== null && p.swapped === swapped);
  }
  // Two proofs that belong together are one check, whichever is first.
  for (const [a, b] of [[f.porBundle, f.proof], [f.proof, f.porBundle]] as const) {
    const p = plan(a, b);
    assert.ok(p.check === 'bundle' && p.original?.as === 'snapshot' && p.swapped === false);
  }
  for (const [a, b] of [[f.remitBundle, f.evidence], [f.evidence, f.remitBundle], [f.evidencePending, f.remitBundle]] as const) {
    const p = plan(a, b);
    assert.ok(p.check === 'evidence' && p.bundle !== null && p.spare === false);
  }
  // An evidence package is checked on its own; a file beside it that is no bundle is said to be unused.
  const spare = plan(f.evidence, f.balances);
  assert.ok(spare.check === 'evidence' && spare.bundle === null && spare.spare === true);

  // Nothing is checked from files that do not make a question.
  const why = (a: Uint8Array, b: Uint8Array | null = null): string => { const p = plan(a, b); return p.check === 'none' ? p.why : p.check; };
  assert.equal(why(f.document), 'not_a_proof');
  assert.equal(why(f.document, f.balances), 'not_a_proof');
  assert.equal(why(f.documentBundle, f.porBundle), 'two_of_a_kind');
  assert.equal(why(f.proof, f.proof), 'two_of_a_kind');
  assert.equal(why(f.evidence, f.evidencePending), 'two_of_a_kind');
  assert.equal(why(f.proof, f.evidence), 'no_pair');
  assert.equal(why(f.evidence, f.proof), 'no_pair', 'in either order');
  const account = bytes({ schema: 'stonehash.por-proof.v1' });
  assert.equal(why(account), 'account_proof');
  assert.equal(why(f.porBundle, account), 'no_pair');
  const damaged = plan(bytes({ ...json('por-proof.json'), seed: '' }), f.balances);
  assert.ok(damaged.check === 'none' && damaged.why === 'snapshot_unreadable' && damaged.error?.code === 'damaged');
});

test('any file may have been anchored as a document, a proof file included', { skip }, async () => {
  const { planCheck } = await load();
  const f = files();
  // An evidence package or a proof file whose own bytes are what the bundle anchors was anchored as a
  // document, and is held against the hash as one — not by its product's commitment, which would differ.
  for (const original of [f.evidence, f.proof]) {
    const asDocument = bytes({ schema: 'bitcert-proof-bundle/v1', record: { leaf_bytes: createHash('sha256').update(original).digest('hex'), preimage: { scheme: 'sha256-file' } }, anchor: {} });
    for (const [a, b] of [[asDocument, original], [original, asDocument]] as const) {
      const p = planCheck(a, b);
      assert.ok(p.check === 'bundle' && p.original?.as === 'document', 'the document rule comes first');
    }
  }
});

test('a bundle holds only with the original that was anchored, by that product\'s rule', { skip }, async () => {
  const { checkBundle, planCheck, checkEvidenceWith } = await load();
  const f = files();
  const parse = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

  // A document: the verifier hashes it by the rule the bundle names.
  const doc = await checkBundle(parse(f.documentBundle), { as: 'document', bytes: f.document });
  assert.deepEqual([doc.verified, doc.original, doc.originalMatches, doc.report.links.A], [true, 'document', true, 'pass']);
  const alone = await checkBundle(parse(f.documentBundle), null);
  assert.deepEqual([alone.verified, alone.original, alone.originalMatches], [true, 'none', null], 'a bundle alone holds, and says nothing of any original');
  const wrong = await checkBundle(parse(f.documentBundle), { as: 'document', bytes: f.balances });
  assert.deepEqual([wrong.verified, wrong.originalMatches, wrong.report.links.A], [false, false, 'fail']);

  // A reserve snapshot: its statement's commitment is the anchored hash — its bytes hashed as a document are not.
  const proof = json('por-proof.json');
  const snap = await checkBundle(parse(f.porBundle), { as: 'snapshot', proof });
  assert.deepEqual([snap.verified, snap.original, snap.originalMatches], [true, 'snapshot', true]);
  assert.deepEqual(snap.subject, { kind: 'por-snapshot', snapshotId: proof.snapshot_id });
  const asDocument = await checkBundle(parse(f.porBundle), { as: 'document', bytes: f.proof });
  assert.equal(asDocument.verified, false, 'hashed as a document the honest proof file does not match — which is why it is not hashed as one');
  // One character of the statement changed: the bundle still holds, the pair does not.
  for (const change of [
    (p: any) => { p.statement.totals.BTC = String(BigInt(p.statement.totals.BTC) + 1n); },
    (p: any) => { p.statement.tree.root = `${p.statement.tree.root.slice(0, 63)}${p.statement.tree.root.endsWith('0') ? '1' : '0'}`; },
    (p: any) => { p.statement.asof = '2026-11-18T08:10:17Z'; },
    (p: any) => { p.statement.tree.leaf_count += 1; },
  ]) {
    const changed = structuredClone(proof);
    change(changed);
    const r = await checkBundle(parse(f.porBundle), { as: 'snapshot', proof: changed });
    assert.deepEqual([r.report.verified, r.originalMatches, r.verified], [true, false, false]);
  }
  // The right proof file and a bundle that does not hold: not holding.
  const broken = parse(f.porBundle);
  broken.record.leaf_bytes = `${broken.record.leaf_bytes.slice(0, 62)}00`;
  const onBroken = await checkBundle(broken, { as: 'snapshot', proof });
  assert.equal(onBroken.verified, false);

  // Every bundle with every file: only the true pairs hold. Nothing else is ever called sound.
  const bundles = { document: f.documentBundle, signed: f.signedBundle, inscription: f.inscriptionBundle, snapshot: f.porBundle, evidence: f.remitBundle };
  const originals = {
    document: f.document, signed: f.signedDocument, inscription: f.inscribedDocument,
    snapshot: f.proof, evidence: f.evidence, balances: f.balances, pending: f.evidencePending,
  };
  const holds: string[] = [];
  for (const [bn, b] of Object.entries(bundles)) {
    for (const [on, o] of Object.entries(originals)) {
      for (const [first, second] of [[b, o], [o, b]]) {
        const p = planCheck(first!, second!);
        let ok = false;
        if (p.check === 'bundle') ok = (await checkBundle(p.bundle, p.original)).verified;
        else if (p.check === 'evidence') ok = (await checkEvidenceWith(p.evidence, p.bundle)).verified;
        else assert.fail(`${bn} + ${on}: a bundle and one other file always make a check`);
        if (ok) holds.push(`${bn}+${on}`);
      }
    }
  }
  assert.deepEqual([...new Set(holds)].sort(),
    ['document+document', 'evidence+evidence', 'evidence+pending', 'inscription+inscription', 'signed+signed', 'snapshot+snapshot'],
    'only a file with the bundle of its own record holds (a package downloaded before its anchor holds once given that bundle)');
  assert.equal(holds.length, 12, 'and each of them in either order of the slots');
});

test('a file nobody looked at is never said to match', { skip }, async () => {
  /*
   * The verifier checks a bundle. For two kinds it does not look at the file
   * given beside it: an inscription's document is read out of the
   * transaction, and a signed anchor's first link is the statement against
   * the hash. Reported as they come, both would say "this is the document"
   * of whatever file was handed in. What the visitor's file is held against
   * is decided by this module instead.
   */
  const { checkBundle } = await load();
  const f = files();
  const parse = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));

  // A signed anchor: the hash is of the issuer's statement; the statement names the document's SHA-256.
  const signedAlone = await checkBundle(parse(f.signedBundle), null);
  assert.deepEqual([signedAlone.verified, signedAlone.original, signedAlone.documentLink, signedAlone.issuer?.signature], [true, 'none', 'skip', 'pass'],
    'with no document given the bundle holds and its signature verifies — and nothing is said of any document');
  const signedRight = await checkBundle(parse(f.signedBundle), { as: 'document', bytes: f.signedDocument });
  assert.deepEqual([signedRight.verified, signedRight.originalMatches, signedRight.documentLink], [true, true, 'pass']);
  const signedWrong = await checkBundle(parse(f.signedBundle), { as: 'document', bytes: f.document });
  assert.deepEqual([signedWrong.verified, signedWrong.originalMatches, signedWrong.documentLink], [false, false, 'fail'],
    'another document is not the one the issuer signed, whatever the bundle\'s own checks say');
  // A signature that does not verify is not a signed anchor that holds.
  const forged = parse(f.signedBundle);
  const sig: string = forged.record.preimage.statement.signature;
  forged.record.preimage.statement.signature = `${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
  const onForged = await checkBundle(forged, null);
  assert.deepEqual([onForged.issuer?.signature, onForged.verified], ['fail', false]);
  // A hash-anchor bundle has no issuer to speak of.
  assert.equal((await checkBundle(parse(f.documentBundle), null)).issuer, null);

  // An inscription: the document is in the transaction, so with no file given the first link is already answered…
  const inscribedAlone = await checkBundle(parse(f.inscriptionBundle), null);
  assert.deepEqual([inscribedAlone.verified, inscribedAlone.original, inscribedAlone.documentLink], [true, 'none', 'pass']);
  const inscribedRight = await checkBundle(parse(f.inscriptionBundle), { as: 'document', bytes: f.inscribedDocument });
  assert.deepEqual([inscribedRight.verified, inscribedRight.originalMatches, inscribedRight.documentLink], [true, true, 'pass']);
  // …but a file given beside it is held against that document, not waved through.
  const inscribedWrong = await checkBundle(parse(f.inscriptionBundle), { as: 'document', bytes: f.document });
  assert.deepEqual([inscribedWrong.report.verified, inscribedWrong.verified, inscribedWrong.originalMatches, inscribedWrong.documentLink], [true, false, false, 'fail']);

  // A hash anchor with no file given: holding, and silent about any document.
  const plain = await checkBundle(parse(f.documentBundle), null);
  assert.deepEqual([plain.verified, plain.documentLink], [true, 'skip']);
});

test('a bundle that does not itself hold is never called holding, whatever is given beside it', { skip }, async () => {
  /*
   * The original can be exactly right and the bundle still prove nothing: a
   * batch the hash is not in, a transaction that does not carry the batch, no
   * transaction at all. Each of these left the "original matches" half true,
   * and a verdict made from that half alone would call the pair sound.
   */
  const { checkBundle } = await load();
  const f = files();
  const parse = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));
  const flip = (hex: string): string => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  const breaks: [string, (b: any) => void][] = [
    // A batch of one has no sibling to change: its root is the leaf's own hash, and that is changed instead.
    ['a sibling of the batch path changed', (b) => { if (b.merkle.siblings.length > 0) b.merkle.siblings[0] = flip(b.merkle.siblings[0]); else b.merkle.root = flip(b.merkle.root); }],
    ['the batch root changed', (b) => { b.merkle.root = flip(b.merkle.root); }],
    ['the transaction taken out', (b) => { delete b.anchor.reveal_tx_hex; }],
    ['the transaction changed', (b) => { b.anchor.reveal_tx_hex = flip(b.anchor.reveal_tx_hex); }],
  ];
  const proof = json('por-proof.json');
  for (const [what, edit] of breaks) {
    for (const [name, bundleBytes, original] of [
      ['a document', f.documentBundle, { as: 'document', bytes: f.document }],
      ['a signed anchor', f.signedBundle, { as: 'document', bytes: f.signedDocument }],
      ['a snapshot', f.porBundle, { as: 'snapshot', proof }],
      ['a bundle alone', f.documentBundle, null],
    ] as const) {
      const broken = parse(bundleBytes);
      edit(broken);
      const o = await checkBundle(broken, original as never);
      assert.equal(o.verified, false, `${name}, ${what}`);
      assert.equal(o.unsigned, false, `${name}, ${what}: not the third state either`);
    }
  }
  // A bundle built with no transaction at all, naming a real transaction's id, beside the very text its hash is of.
  const made = await checkBundle(json('crafted/bundle-without-transaction.json'), { as: 'document', bytes: fixture('crafted/bundle-without-transaction.txt') });
  assert.deepEqual([made.originalMatches, made.report.links.C1, made.verified], [true, 'skip', false], 'the text is the hash\'s, and the hash is tied to nothing');
  assert.equal((await checkBundle(json('crafted/real-bundle-transaction-removed.json'), null)).verified, false);
});

test('a signed anchor holds only when its issuer\'s signature was verified over the anchored statement', { skip }, async () => {
  const { checkBundle, planCheck } = await load();
  const f = files();
  // A statement that IS what was anchored, and carries no signature: anchored through the plain hash door.
  const unsigned = json('crafted/signed-anchor-without-signature.json');
  const doc = fixture('crafted/signed-anchor-without-signature.txt');
  for (const original of [null, { as: 'document' as const, bytes: doc }]) {
    const o = await checkBundle(unsigned, original);
    assert.deepEqual([o.report.verified, o.issuer?.signature, o.verified, o.unsigned], [true, 'fail', false, false], 'the bundle\'s own checks pass; the signature does not');
    assert.notEqual(o.documentLink, 'pass', 'nothing is "the document the issuer signed" without a signature');
  }
  // A statement copied from another record into an inscription's bundle: it is not what the transaction
  // anchors, the verifier never looks at it, and no issuer is spoken of. The inscription is judged as one.
  const transplanted = json('crafted/inscription-with-transplanted-statement.json');
  const t1 = await checkBundle(transplanted, null);
  assert.deepEqual([t1.issuer, t1.verified, t1.documentLink], [null, true, 'pass']);
  const t2 = await checkBundle(transplanted, { as: 'document', bytes: f.signedDocument });
  assert.deepEqual([t2.issuer, t2.verified, t2.documentLink], [null, false, 'fail'], 'the document the copied statement names is not the inscribed one');
  // The same statement on a plain hash anchor's bundle: it does not hash to what was anchored.
  const grafted = json('document-bundle.json');
  grafted.record.preimage = json('signed-bundle.json').record.preimage;
  const g = await checkBundle(grafted, null);
  assert.deepEqual([g.issuer?.signature, g.verified], ['fail', false]);
  // …and what such a statement says of a document is nobody's word: the very document it names does not "match".
  const gd = await checkBundle(grafted, { as: 'document', bytes: f.signedDocument });
  assert.deepEqual([gd.originalMatches, gd.verified, gd.documentLink], [false, false, 'fail']);
  // A genuine one, for contrast — and an RSA signature in a browser that withholds WebCrypto: not a pass, a third state.
  assert.deepEqual([(await checkBundle(json('signed-bundle.json'), null)).issuer?.signature], ['pass']);
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const p = planCheck(fixture('crafted/signed-anchor-rs256-never-signed.json'), null);
    const o = p.check === 'bundle' ? await checkBundle(p.bundle, p.original) : assert.fail();
    assert.deepEqual([o.issuer?.signature, o.verified, o.unsigned, o.documentLink], ['skip', false, true, 'skip']);
    const es = await checkBundle(json('signed-bundle.json'), { as: 'document', bytes: f.signedDocument });
    assert.deepEqual([es.issuer?.signature, es.verified], ['pass', true], 'an ES256 signature is still checked there');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('the document rule comes before every other reading, for every kind of anchor and in either slot', { skip }, async () => {
  const { planCheck, checkBundle } = await load();
  const holds = async (a: Uint8Array, b: Uint8Array): Promise<[string, boolean, boolean]> => {
    const p = planCheck(a, b);
    if (p.check !== 'bundle') return [p.check === 'none' ? p.why : p.check, false, p.swapped];
    const o = await checkBundle(p.bundle, p.original);
    return [o.original, o.verified, p.swapped];
  };
  // One account's proof, anchored by its hash as a document: in the proof slot it would otherwise be refused outright.
  const accountBundle = fixture('crafted/bundle-of-account-proof.json');
  const account = fixture('crafted/account-proof.json');
  assert.deepEqual(await holds(accountBundle, account), ['document', true, false]);
  assert.deepEqual(await holds(account, accountBundle), ['document', true, true]);
  // An evidence file under a signed anchor: the statement names the file's SHA-256.
  const signedOverEvidence = fixture('crafted/signed-anchor-of-evidence-file.json');
  assert.deepEqual(await holds(signedOverEvidence, fixture('evidence-anchored.json')), ['document', true, false]);
  assert.deepEqual(await holds(fixture('evidence-anchored.json'), signedOverEvidence), ['document', true, true]);
  // A document the caller labelled as a snapshot: held as the document it is; a proof file beside it is not its original.
  const labelled = fixture('crafted/document-labelled-as-snapshot.json');
  assert.deepEqual(await holds(labelled, fixture('crafted/document-labelled-as-snapshot.txt')), ['document', true, false]);
  assert.deepEqual((await holds(labelled, fixture('por-proof.json'))).slice(0, 2), ['snapshot', false]);
});

test('a rule that takes no file, or one nobody knows, says nothing about the file given', { skip }, async () => {
  const { checkBundle } = await load();
  const f = files();
  // The producer's own published fixture: a daily balance, whose hash is of fields the bundle carries.
  const daily = JSON.parse(readFileSync(path.resolve(HERE, '../../../fixtures/conformance/02-daily-balance/bundle.json'), 'utf8'));
  const withFile = await checkBundle(daily, { as: 'document', bytes: f.document });
  assert.deepEqual([withFile.original, withFile.originalMatches, withFile.documentLink, withFile.schemeKnown], ['unused', null, 'skip', true],
    'the file was not used, and the first link is not a pass over it');
  const unknown = json('document-bundle.json');
  unknown.record.preimage.scheme = 'sha256-of-something-else/v9';
  const u = await checkBundle(unknown, { as: 'document', bytes: f.document });
  assert.deepEqual([u.schemeKnown, u.verified, u.documentLink], [false, false, 'skip']);
});

test('a ledger past what the screen takes is too large, not a mismatch', { skip }, async () => {
  const { checkSnapshotFiles } = await load();
  const { MAX_ACCOUNTS } = await import('../src/por-ledger.ts');
  const proof = json('por-proof.json');
  const header = readFileSync(BALANCES, 'utf8').split('\n')[0]!;
  const zeros = header.split(',').slice(1).map(() => '0').join(',');
  const rowsOf = (n: number): Uint8Array => { const rows = [header]; for (let i = 0; i < n; i++) rows.push(`A-${i},${zeros}`); return bytes(rows.join('\n')); };
  // A snapshot of more accounts than a page rebuilds: too large, said without reading the file at all.
  const huge = structuredClone(proof);
  huge.statement.tree.leaf_count = MAX_ACCOUNTS + 1;
  const tooLarge = checkSnapshotFiles(huge, rowsOf(3));
  assert.deepEqual([tooLarge.result, tooLarge.result === 'too_large' && tooLarge.accounts], ['too_large', MAX_ACCOUNTS + 1]);
  // A file with far more rows than this snapshot's twelve accounts is another file — not one too large, and
  // not a proof file that was changed. It is turned away before it is parsed: a hundred megabytes dropped in
  // the slot must not hold the page for half a minute.
  const started = performance.now();
  const other = checkSnapshotFiles(proof, rowsOf(MAX_ACCOUNTS + 1));
  assert.equal(other.result, 'too_many_rows');
  assert.ok(performance.now() - started < 1_500, 'turned away without reading it through');
  assert.equal(other.result === 'too_many_rows' && other.accounts, proof.statement.tree.leaf_count, 'the count given is the snapshot\'s own');
  assert.equal(other.sameFile, false, 'a file of another length is not hashed to find that out');
});

test('an evidence package is completed by the bundle of its record, and by no other', { skip }, async () => {
  const { checkEvidenceWith } = await load();
  const evidence = json('evidence-anchored.json');
  const own = evidence.attestation.bundle;
  const pending = { ...evidence, attestation: { ...evidence.attestation, bundle: null } };

  const whole = await checkEvidenceWith(evidence, null);
  assert.deepEqual([whole.verified, whole.given, whole.report.commitment.ok, whole.report.signatures.ok, whole.report.verdict.ok, whole.report.anchor.ok],
    [true, null, true, true, true, true]);
  const before = await checkEvidenceWith(pending, null);
  assert.deepEqual([before.verified, before.report.anchor.ok, before.report.anchor.pending], [false, false, true], 'no bundle yet: not holding, and waiting rather than failed');
  assert.deepEqual([before.report.commitment.ok, before.report.signatures.ok, before.report.verdict.ok], [true, true, true]);
  const completed = await checkEvidenceWith(pending, own);
  assert.deepEqual([completed.verified, completed.given?.matches, completed.report.anchor.pending, completed.report.anchor.leafMatches], [true, true, false, true]);

  // A sound bundle of another record is a mistake in the pairing: the pair does not hold, the bundle is
  // named for what it is of, and the package is reported as it came — not failed for a bundle that is not its own.
  const other = json('bundle-attest.json');
  const mispaired = await checkEvidenceWith(evidence, other);
  assert.deepEqual([mispaired.verified, mispaired.given?.matches], [false, false], 'the pair never holds');
  assert.equal(mispaired.report.verified, true, 'and the package, checked with the bundle it carries, is not called broken');
  assert.equal(mispaired.report.anchor.bundle?.txid, (await checkEvidenceWith(evidence, null)).report.anchor.bundle?.txid,
    'the transaction a reader is told to look up is the package\'s own, not the other record\'s');
  const mispairedPending = await checkEvidenceWith(pending, other);
  assert.deepEqual([mispairedPending.verified, mispairedPending.given?.matches, mispairedPending.report.anchor.pending], [false, false, true]);
  // What the stray bundle is of comes from its own label.
  const remitOther = structuredClone(own);
  remitOther.record.leaf_bytes = 'ab'.repeat(32);
  assert.deepEqual((await checkEvidenceWith(evidence, remitOther)).given?.subject, { kind: 'remit-evidence', paymentId: evidence.package.payment_id });

  // The caller's objects are as they were.
  assert.equal(pending.attestation.bundle, null);
  assert.deepEqual(evidence, json('evidence-anchored.json'));
});

test('a proof file and a balance file make the snapshot again, or it is said what differs', { skip }, async () => {
  const { checkSnapshotFiles } = await load();
  const proof = json('por-proof.json');
  const text = readFileSync(BALANCES, 'utf8');
  const rows = text.split('\n');

  const same = checkSnapshotFiles(proof, balances());
  assert.deepEqual([same.result, same.sameFile, same.result === 'match' && same.accounts], ['match', true, proof.statement.tree.leaf_count]);

  // The same rows saved with other line endings: another file, the same snapshot.
  const crlf = checkSnapshotFiles(proof, bytes(text.replace(/\n/g, '\r\n')));
  assert.deepEqual([crlf.result, crlf.sameFile], ['match', false]);

  // One amount changed: the root and that asset's total differ, and the account count does not.
  const header = rows[0]!.split(',');
  const cells = rows[1]!.split(',');
  const column = header.findIndex((h, i) => i > 0 && /^\d/.test(cells[i] ?? ''));
  cells[column] = cells[column]!.replace(/\d(?!.*\d)/, (d) => String((Number(d) + 1) % 10));
  const changed = checkSnapshotFiles(proof, bytes([rows[0], cells.join(','), ...rows.slice(2)].join('\n')));
  assert.equal(changed.result, 'mismatch');
  if (changed.result === 'mismatch') {
    assert.notEqual(changed.mismatch.root[0], changed.mismatch.root[1]);
    assert.deepEqual(Object.keys(changed.mismatch.totals), [header[column]]);
    assert.equal(changed.mismatch.accounts[0], changed.mismatch.accounts[1]);
    assert.equal(changed.sameFile, false);
  }

  // One account left out.
  const fewer = checkSnapshotFiles(proof, bytes([rows[0], ...rows.slice(2)].join('\n')));
  assert.ok(fewer.result === 'mismatch' && fewer.mismatch.accounts[0] === fewer.mismatch.accounts[1] + 1);

  // The same balance file and a proof file whose statement was changed: it is the proof file that differs.
  const tampered = structuredClone(proof);
  tampered.statement.tree.root = 'ab'.repeat(32);
  const onTampered = checkSnapshotFiles(tampered, balances());
  assert.deepEqual([onTampered.result, onTampered.sameFile], ['mismatch', true]);

  // A file that is not the balance file at all is refused by the reader, with the reader's first line.
  const notIt = checkSnapshotFiles(proof, fixture('document.txt'));
  assert.ok(notIt.result === 'unreadable' && notIt.why === 'problems' && notIt.message.length > 0);
  // The proof file is never changed by a check.
  assert.deepEqual(proof, json('por-proof.json'));
});
