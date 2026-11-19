/**
 * Checks the **built** output, not the sources.
 *
 * The Playground ships unbundled ES modules, which means the emit step is load
 * bearing: `rewriteRelativeImportExtensions` turns every `./sha256.ts`
 * specifier into `./sha256.js`, and if one were missed the page would fail at
 * load in a browser while every source-level test stayed green. There is no
 * bundler to catch it, so this does.
 *
 * It runs the emitted JavaScript in Node and verifies a bundle that was really
 * anchored to a chain, then tampers with the document and asserts the failure
 * lands on link A alone. That last assertion is the product requirement: a
 * modified document must not invalidate the Merkle proof or the transaction
 * binding, and the UI has to be able to say which claim actually broke.
 *
 * Run `pnpm build` first; the test skips with a clear message otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
// Test input, not build output: the page stopped shipping these when the
// sample button went away, but a bundle anchored to a real chain is still
// the only honest thing to run the emitted verifier against.
const ASSETS = path.resolve(HERE, '../assets');
const built = existsSync(path.join(DIST, 'app.js'));
const skip = built ? false : 'dist/ not built — run `pnpm build` in apps/playground first';

test('every emitted import resolves to a real file', { skip }, () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name))
        : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

  const files = walk(DIST);
  assert.ok(files.length > 5, 'expected the emitted module graph');
  let checked = 0;
  for (const f of files) {
    const body = readFileSync(f, 'utf8');
    for (const m of body.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
      const spec = m[1]!;
      assert.match(spec, /\.js$/, `${path.relative(DIST, f)} imports ${spec} — not rewritten to .js`);
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(existsSync(target), `${path.relative(DIST, f)} imports a missing ${spec}`);
      checked++;
    }
  }
  assert.ok(checked > 10, `expected many relative imports, saw ${checked}`);
});

test('no .ts specifier survives into the build', { skip }, () => {
  const body = readFileSync(path.join(DIST, 'app.js'), 'utf8');
  assert.doesNotMatch(body, /from\s+["'][^"']*\.ts["']/);
});

test('the emitted verifier verifies a really-anchored bundle', { skip }, async () => {
  const sdk = await import(path.join(DIST, 'vendor/attest-verify/index.js')) as
    typeof import('../src/vendor/attest-verify/index.ts');
  const bundle = JSON.parse(readFileSync(path.join(ASSETS, 'anchored.bundle.json'), 'utf8'));
  const doc = new Uint8Array(readFileSync(path.join(ASSETS, 'anchored.txt')));

  const r = sdk.verifyBundle(bundle, { originalBytes: doc });
  assert.equal(r.verified, true, r.checks.map((c) => `${c.state} ${c.id}`).join(' | '));
  assert.equal(r.links.A, 'pass');
  assert.equal(r.links.B, 'pass');
  assert.equal(r.links.C1, 'pass');
  // The sample is anchored to regtest, so a third party can never establish C2.
  assert.equal(r.links.C2, 'skip');
  assert.equal(r.network, 'regtest');
  // A real batch, not a single-leaf tree: the proof must have a path to fold.
  assert.ok(bundle.merkle.siblings.length >= 2,
    'the sample should carry a multi-level Merkle path, or the Evidence tab shows nothing');
});

test('tampering with the sample breaks link A and nothing else', { skip }, async () => {
  const sdk = await import(path.join(DIST, 'vendor/attest-verify/index.js')) as
    typeof import('../src/vendor/attest-verify/index.ts');
  const bundle = JSON.parse(readFileSync(path.join(ASSETS, 'anchored.bundle.json'), 'utf8'));
  const original = readFileSync(path.join(ASSETS, 'anchored.txt'), 'utf8');
  assert.match(original, /50,000\.00/, 'the sample should contain the amount the demo edits');

  const tampered = new TextEncoder().encode(original.replace('50,000.00', '90,000.00'));
  const r = sdk.verifyBundle(bundle, { originalBytes: tampered });
  assert.equal(r.verified, false);
  assert.equal(r.links.A, 'fail', 'the substituted document must not bind');
  assert.equal(r.links.B, 'pass', 'the Merkle proof is still perfectly valid');
  assert.equal(r.links.C1, 'pass', 'so is the transaction binding');
});

test('a signed anchor is held to the document its statement names', { skip }, async () => {
  // The page's one question is "is this file the anchored one?". For a signed
  // anchor the leaf is the hash of a statement, not of the document, so the
  // emitted verifier has to compare the file with the digest the statement
  // names — and say nothing about the document when no file was given. The
  // bundle is put together here from the published layout, with no producer.
  const sdk = await import(path.join(DIST, 'vendor/attest-verify/index.js')) as
    typeof import('../src/vendor/attest-verify/index.ts');
  const st = await import(path.join(DIST, 'vendor/attest-verify/statement.js')) as
    typeof import('../src/vendor/attest-verify/statement.ts');
  const { createHash, webcrypto } = await import('node:crypto');
  const sha = (...parts: Uint8Array[]): Buffer => { const h = createHash('sha256'); for (const x of parts) h.update(x); return h.digest(); };

  const doc = new TextEncoder().encode('Wire instruction: pay 50,000.00');
  const other = new TextEncoder().encode('Wire instruction: pay 90,000.00');
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', key.publicKey)).toString('base64');
  const core = st.buildStatement({ documentSha256: sha(doc).toString('hex'), keyId: 'k1', publicKeySpkiBase64: spki, issuedAt: '2026-11-18T00:00:00.000Z' });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, st.statementSigningInput(core))).toString('base64url');
  const statement = { ...core, signature };
  const leaf = st.statementLeaf(statement);
  const root = sha(new Uint8Array([0x00]), Buffer.from(leaf, 'hex'));
  const payload = Buffer.concat([Buffer.from('BC01', 'latin1'), Buffer.from([0x01]), root, Buffer.alloc(16, 0x07)]);
  const tx = Buffer.concat([
    Buffer.from('02000000', 'hex'), Buffer.from([0x01]), Buffer.alloc(32, 0x11), Buffer.alloc(4), Buffer.from([0x00]), Buffer.from('ffffffff', 'hex'),
    Buffer.from([0x01]), Buffer.alloc(8), Buffer.from([payload.length + 2, 0x6a, payload.length]), payload, Buffer.alloc(4),
  ]);
  const bundle = {
    schema: 'bitcert-proof-bundle/v1', bitcoin_network: 'regtest', generated_at: '2026-11-18T00:00:00Z',
    record: { kind: 'attestation', leaf_bytes: leaf, preimage: { scheme: 'sha256-signed-statement/v1', statement } },
    merkle: { leaf_index: 0, root: root.toString('hex'), siblings: [], directions: [] },
    anchor: { reveal_txid: Buffer.from(sha(sha(tx))).reverse().toString('hex'), reveal_tx_hex: tx.toString('hex'), op_return_payload_hex: payload.toString('hex') },
  } as never;

  const right = sdk.verifyBundle(bundle, { originalBytes: doc });
  assert.equal(right.verified, true, right.checks.map((c) => `${c.state} ${c.id}`).join(' | '));
  assert.equal(right.links.A, 'pass');

  const wrong = sdk.verifyBundle(bundle, { originalBytes: other });
  assert.equal(wrong.verified, false, 'another document must never come out as the anchored one');
  assert.equal(wrong.links.A, 'fail');
  assert.equal(wrong.links.B, 'pass', 'the anchor itself is as good as ever');
  assert.equal(wrong.links.C1, 'pass');

  const none = sdk.verifyBundle(bundle);
  assert.equal(none.links.A, 'skip', 'nobody looked at a document, so link A is not a pass');
  assert.equal(none.verified, true);
});

test('the page declares a strict CSP-compatible shape: no inline script, no remote origin', { skip }, () => {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  // The service sends `script-src 'self'`, so an inline script or a CDN would
  // be silently blocked in the browser and the page would look broken.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/,
    'inline <script> would be blocked by the served CSP');
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']https?:\/\//,
    'the page must load no remote asset');
});









test('nothing emits an inline style attribute', { skip }, () => {
  // `style-src 'self'` drops `style` attributes silently — two Bank Review
  // headings were rendering at the browser's default h2 size because of it.
  const walkJs = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkJs(path.join(dir, e.name))
        : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
  for (const f of walkJs(DIST)) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\bstyle="/,
      `${path.relative(DIST, f)} emits a style attribute, which this page's CSP drops`);
  }
});

test('the page is one screen, anchor before verify, and names no chain', { skip }, () => {
  /*
   * Anchor then verify, because that is the order someone actually does it
   * in: you cannot check a proof you have not been given. The Explore, Bank
   * Review, Corridor and Evidence tabs were removed — they demonstrated the
   * rules engine and the byte layout, which is Developer Hub material, not
   * the thing this page exists to show.
   */
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  /*
   * One screen, not two tabs. Anchoring and verifying are a sequence — you
   * cannot check a proof you have not been given — and a tab put a click
   * between the visitor and the moment the claim becomes checkable.
   */
  assert.doesNotMatch(html, /class="tabs"/, 'the steps are stacked, not tabbed');
  const panels = [...html.matchAll(/id="panel-([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(panels, ['anchor', 'verify'], 'anchor must come first');

  // The network badge named the test chain in the corner — a detail the
  // reader cannot act on. Every bundle still carries its own network field,
  // so no proof can misrepresent itself.
  assert.doesNotMatch(html, /netbadge/);
  assert.doesNotMatch(html, /regtest|signet|testnet/i);

  // The banner was rendered at runtime from /v1/meta, so the markup check
  // above passed while the page still announced the chain above its only
  // control. Mainnet still gets a banner — there it changes what the reader
  // can do with the proof.
  const anchor = readFileSync(path.join(DIST, 'anchor.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(anchor, /비공개 테스트 체인/,
    'the test-chain banner must not be rendered');
  assert.match(anchor, /mainnet/, 'mainnet should still be announced');
});

test('the page ships only the verifier', { skip }, () => {
  // The rules engine and archive assembler went with the tabs that used them.
  // They stay in the workspace for the service; this page stopped carrying
  // roughly 60KB it no longer runs.
  const vendored = readdirSync(path.join(DIST, 'vendor'));
  assert.deepEqual(vendored, ['attest-verify']);
});

test('anchoring ends at the download, and verifying is something the visitor does', { skip }, () => {
  /*
   * The anchor step briefly handed its proof straight to the verifier, which
   * produced a verdict the visitor had not obtained — a demo verifying its
   * own output proves less than one where you supply the inputs. Anchoring
   * now ends at the download; the file you took goes back in beside your
   * original, and the verifier below reports on what you gave it.
   */
  const anchor = readFileSync(path.join(DIST, 'anchor.js'), 'utf8');
  const app = readFileSync(path.join(DIST, 'app.js'), 'utf8');

  assert.doesNotMatch(anchor, /attest:proof/, 'the anchor step must not feed the verifier');
  assert.doesNotMatch(app, /attest:proof/);
  assert.match(anchor, /btn-anchor-bundle/, 'the download is how the step ends');
  assert.doesNotMatch(anchor, /btn-anchor-verify/, 'no second verify control');

  // Both inputs stay the visitor's to supply.
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  assert.match(html, /id="file-bundle"/);
  assert.match(html, /id="file-original"/);
});

/**
 * C2 is the one verdict the page adds on top of the verifier, and the one it
 * could do real damage with. On a chain StoneHash mines, "this txid is in
 * block N" is a fact only the operator can state, and stating it is better
 * than leaving a confirmed transaction marked unchecked. On mainnet the same
 * green tick would be a claim about a public ledger that nobody consulted —
 * so the merge has to stay asleep there no matter what the bundle says.
 */
test('C2 passes on an operator-run chain and never on mainnet', { skip }, async () => {
  const { withChainInclusion } = await import(path.join(DIST, 'chain.js')) as
    { withChainInclusion: (r: any, b: any) => any };

  const report = { network: 'regtest', links: { A: 'pass', B: 'pass', C1: 'pass', C2: 'skip' },
    checks: [{ id: 'onchain', label: 'On-chain confirmation', state: 'skip', gating: false }] };
  const confirmed = { block_height: 136, block_hash: 'ab'.repeat(32), confirmations: 1 };

  const merged = withChainInclusion(report, { anchor: { confirmed } });
  assert.equal(merged.links.C2, 'pass', 'a transaction in a block is not "not checked"');
  const chk = merged.checks.find((c: any) => c.id === 'onchain');
  assert.equal(chk.state, 'pass');
  assert.match(String(chk.detail.attested_by), /제3자 아님/,
    'a pass on an operator-run chain must name who vouches for it');
  assert.equal(chk.gating, false, 'C2 must not gate `verified` either way');

  // The guard that matters.
  assert.equal(
    withChainInclusion({ ...report, network: 'mainnet' }, { anchor: { confirmed } }).links.C2,
    'skip', 'mainnet C2 must stay unchecked — the reader consults their own source');

  // No chain data is no verdict, on any network.
  assert.equal(withChainInclusion(report, { anchor: {} }).links.C2, 'skip');
  assert.equal(
    withChainInclusion(report, { anchor: { confirmed: { block_height: 136 } } }).links.C2,
    'skip', 'a height with no block hash is not an inclusion proof');

  // The verifier itself must keep abstaining, for every other caller.
  const src = readFileSync(path.join(DIST, 'vendor/attest-verify/bundle.js'), 'utf8');
  assert.match(src, /links\.C2 = 'skip'/,
    'the published verifier must never decide C2 — only the caller merges it');
  assert.doesNotMatch(src, /links\.C2 = 'pass'/);
});

test('the reserve verify page names the exchange\'s own file and verifies nothing from it', { skip }, () => {
  /*
   * An exchange keeps one proof file beside its balance file. It is not what
   * this page checks — a customer brings one account's proof — and it carries
   * the seed every account's salt is derived from. Handed here by mistake, it
   * used to draw "put both inputs in", which says nothing about what went
   * wrong and leaves the file sitting in the box on screen.
   */
  const por = readFileSync(path.join(DIST, 'por.js'), 'utf8');
  assert.match(por, /'stonehash\.por-snapshot-proof\.v1'/, 'the file is recognised by what it calls itself');
  // Recognised both when pasted and when picked as a file, and cleared from the box either way.
  const refusals = [...por.matchAll(/\.value = '';\s*(?:input\.value = '';\s*)?(?:\$\('#out'\)|out)\.innerHTML = EXCHANGE_FILE_BANNER;\s*return;/g)];
  assert.equal(refusals.length, 2, 'pasted or picked, the file is cleared and named, and the run stops there');
  // The check for it comes before anything is verified.
  assert.ok(por.indexOf('proofFile?.schema === SNAPSHOT_PROOF_SCHEMA') < por.indexOf('verifyPorInclusion(proof,'),
    'nothing may be verified from the exchange\'s file');
});
