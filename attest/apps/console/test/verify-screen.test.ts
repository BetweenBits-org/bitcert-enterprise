/**
 * What the 검증 screen says, held to what was found.
 *
 * `verify-files.test.ts` holds the deciding module to real files. This file
 * holds the wording: the headline for each outcome, the first tile, and that
 * nothing a file contains reaches the page as markup. The result builders of
 * `src/verify.ts` are pure — a result in, a string out — so they are run
 * here as they are, in Korean, with the two globals the language helper
 * reads at load.
 *
 * A wrong headline over a right decision is still a wrong answer on the
 * screen, and every one of these lines once passed a suite that did not look
 * at them: swapping the two headlines, taking the first tile from the
 * verifier instead of from what was held against the file, showing a waiting
 * anchor as passed, dropping an escape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vendored = existsSync(path.resolve(HERE, '../src/vendor/attest-rules/engine.ts'));
const skip = vendored ? false : 'src/vendor is not there — run `node build.mjs sync` in apps/console first';

// The language helper reads the address and the browser's language when it is loaded.
Object.defineProperty(globalThis, 'location', { value: { search: '?lang=ko', href: 'http://console.test/console/?lang=ko' }, configurable: true });

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(HERE, 'fixtures', name)));
const json = (name: string): any => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const BALANCES = path.resolve(HERE, '../../../packages/attest-por/samples/balances.wide.csv');

const load = async () => ({ files: await import('../src/verify-files.ts'), screen: await import('../src/verify.ts') });

/** The text of the page as a reader would see it: tags out, entities back. */
const shown = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The headline: the `<b>` of the element that carries the verdict. */
const headline = (html: string): string => {
  const at = html.indexOf('id="v-verdict"');
  assert.ok(at >= 0, 'a result has a verdict');
  return shown(/<b>([\s\S]*?)<\/b>/.exec(html.slice(at))?.[1] ?? '');
};
/** The chips of the tiles, in order: the first is whether the file given is what was anchored. */
const tiles = (html: string): string[] => [...html.matchAll(/<div class="lk [^"]*"><span class="chip [^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!);
/** Every element in the markup, by tag name. */
const tags = (html: string): Set<string> => new Set([...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase()));
/** The only elements a result is ever built from. Anything else in it came out of a file. */
const OWN = new Set(['div', 'span', 'b', 'small', 'ul', 'li', 'p', 'code', 'a', 'details', 'summary']);
const noForeignMarkup = (html: string, what: string): void => {
  for (const tag of tags(html)) assert.ok(OWN.has(tag), `${what}: <${tag}> is not an element this screen writes`);
  // Inside the tags that are there: no handler, no script address, and only the attributes this screen writes.
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    assert.doesNotMatch(m[0], /\son[a-z]+\s*=/i, `${what}: an event handler attribute in ${m[0].slice(0, 60)}`);
    assert.doesNotMatch(m[0], /javascript:/i, what);
    for (const attr of m[0].matchAll(/\s([a-zA-Z-]+)=/g)) assert.ok(['class', 'id', 'href', 'target', 'rel'].includes(attr[1]!), `${what}: attribute ${attr[1]}`);
  }
};
const MARK = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'&';

test('a bundle: the headline and the first tile say what was held against the file', { skip }, async () => {
  const { files, screen } = await load();
  const outcome = async (a: Uint8Array, b: Uint8Array | null = null) => {
    const p = files.planCheck(a, b);
    assert.equal(p.check, 'bundle');
    return p.check === 'bundle' ? files.checkBundle(p.bundle, p.original) : assert.fail();
  };
  const said = async (a: Uint8Array, b: Uint8Array | null = null) => {
    const html = screen.bundleHtml(await outcome(a, b));
    return { html, headline: headline(html), tiles: tiles(html), text: shown(html) };
  };

  // A document and its bundle; the bundle alone; another document.
  const pair = await said(fixture('document-bundle.json'), fixture('document.txt'));
  assert.deepEqual([pair.headline, pair.tiles[0]], ['성립합니다', '통과']);
  const alone = await said(fixture('document-bundle.json'));
  assert.deepEqual([alone.headline, alone.tiles[0]], ['성립합니다', '확인 안 함'], 'nothing was held against the hash, and the tile says so');
  assert.doesNotMatch(alone.text, /주의/, 'a check that was not run is not marked for attention');
  // Another document beside a sound bundle: the pairing is what is wrong, and the headline says that rather than blaming the bundle.
  const wrong = await said(fixture('document-bundle.json'), fixture('signed-document.txt'));
  assert.deepEqual([wrong.headline, wrong.tiles[0]], ['넣은 파일은 이 번들이 고정한 것이 아닙니다', '실패']);
  assert.match(wrong.text, /번들 자체의 검사는 통과했습니다/);
  assert.doesNotMatch(wrong.text, /성립합니다/);

  // A signed anchor: nothing is "the document the issuer signed" unless a document was held and the signature verified.
  const signedAlone = await said(fixture('signed-bundle.json'));
  assert.deepEqual([signedAlone.headline, signedAlone.tiles[0]], ['성립합니다', '확인 안 함']);
  // The verifier marks its "original" check for attention when it is given no file. For a signed anchor the
  // line on this screen is about the statement, which does hash to the anchored value: a pass, not a caution.
  assert.match(signedAlone.text, /통과\s*서명된 선언문과 앵커링된 해시의 일치/);
  assert.doesNotMatch(signedAlone.text, /주의/, 'a signed anchor checked on its own shows nothing for attention');
  assert.match(shown(signedAlone.html.slice(signedAlone.html.indexOf('id="v-unchecked"'))), /서명한 키가 누구의 것인지/, 'whose key it is, is listed as not checked');
  const signedWrong = await said(fixture('signed-bundle.json'), fixture('document.txt'));
  assert.deepEqual([signedWrong.headline, signedWrong.tiles[0]], ['넣은 파일은 이 번들이 고정한 것이 아닙니다', '실패'], 'another document beside a signed anchor does not hold');
  const unsignedPair = await said(fixture('crafted/signed-anchor-without-signature.json'), fixture('crafted/signed-anchor-without-signature.txt'));
  assert.equal(unsignedPair.headline, '성립하지 않습니다', 'a statement nobody signed is not a signed anchor that holds');
  assert.notEqual(unsignedPair.tiles[0], '통과', 'and nothing is called the document the issuer signed');

  // An inscription: its document is in the transaction; a file given beside it is held against that.
  const inscribedWrong = await said(fixture('inscription-bundle.json'), fixture('document.txt'));
  assert.deepEqual([inscribedWrong.headline, inscribedWrong.tiles[0]], ['넣은 파일은 이 번들이 고정한 것이 아닙니다', '실패']);
  // A signed statement written into an inscription's bundle is not what the transaction anchors: no issuer is spoken of.
  const transplanted = await said(fixture('crafted/inscription-with-transplanted-statement.json'), fixture('inscribed-document.txt'));
  assert.doesNotMatch(transplanted.text, /발급자/, 'nothing about an issuer for a statement that was never anchored');

  // A bundle with no transaction in it: not holding, and no transaction id is handed over to be "confirmed" in an explorer.
  const noTx = await said(fixture('crafted/bundle-without-transaction.json'), fixture('crafted/bundle-without-transaction.txt'));
  assert.equal(noTx.headline, '성립하지 않습니다');
  assert.doesNotMatch(noTx.html, /id="v-txid"/, 'an id the bundle merely names is not offered for look-up');
  assert.doesNotMatch(noTx.text, /4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b/);
  // A sound bundle gives the id it recomputed. On the sandbox's own chain no explorer has it, and the result
  // says where this deployment's answer is instead of sending the reader to look for one.
  assert.match(pair.html, /id="v-txid"/);
  assert.match(pair.text, /regtest는 이 샌드박스의 시험 체인이라 공개 익스플로러에 없습니다/);
  assert.doesNotMatch(pair.text, /익스플로러에서 조회하십시오/);
  // Any other network is the bundle's own word for where to look, and is given as that.
  const elsewhere = json('document-bundle.json');
  elsewhere.bitcoin_network = 'mainnet';
  const named = screen.bundleHtml(await files.checkBundle(elsewhere, null));
  assert.match(shown(named), /익스플로러에서 조회하십시오 — 번들에 적힌 네트워크: mainnet/);

  // A reserve snapshot's bundle: the question is about the statement, never about "a document".
  const snap = await said(fixture('por-bundle.json'), fixture('por-proof.json'));
  assert.deepEqual([snap.headline, snap.tiles[0]], ['성립합니다', '통과']);
  assert.doesNotMatch(snap.text, /문서가/, 'a snapshot is not asked about as a document');
  assert.match(snap.text, /준비금 증명 파일에 적힌 값: 스냅샷 ID/, 'the id is the proof file\'s own word');
  // The balance file beside a snapshot's bundle is an exchange's likeliest first slip: which file is the pair is said in the headline's own box.
  const snapWrongKind = await said(fixture('por-bundle.json'), new Uint8Array(readFileSync(BALANCES)));
  assert.equal(snapWrongKind.headline, '넣은 파일은 이 번들이 고정한 것이 아닙니다');
  // …and the tile that failed asks about the file that was added, not about a reserve proof file nobody added.
  assert.equal(snapWrongKind.tiles[0], '실패');
  assert.match(snapWrongKind.text, /넣은 파일이 이 번들이 고정한 것입니까/);
  assert.doesNotMatch(snapWrongKind.text, /준비금 증명 파일의 스냅샷이 앵커링된 그대로입니까/);
  assert.match(shown(snapWrongKind.html.slice(0, snapWrongKind.html.indexOf('id="v-unchecked"'))), /짝이 되는 파일은 잔고 파일이 아니라 준비금 증명 파일/, 'which file is the pair, is said with the verdict');
});

test('a signature this page cannot check is a third state, not a pass', { skip }, async () => {
  const { files, screen } = await load();
  // As the console is reached — plain http — the browser withholds WebCrypto, and an RSA signature cannot be checked.
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    const p = files.planCheck(fixture('crafted/signed-anchor-rs256-never-signed.json'), null);
    assert.equal(p.check, 'bundle');
    const o = p.check === 'bundle' ? await files.checkBundle(p.bundle, p.original) : assert.fail();
    assert.deepEqual([o.verified, o.unsigned, o.issuer?.signature], [false, true, 'skip']);
    const html = screen.bundleHtml(o);
    assert.equal(headline(html), '발급자 서명을 확인하지 못했습니다');
    assert.doesNotMatch(shown(html), /성립합니다/);
    // The genuine ES256 anchor is still checked there, with the verifier's own arithmetic.
    const g = files.planCheck(fixture('signed-bundle.json'), fixture('signed-document.txt'));
    const go = g.check === 'bundle' ? await files.checkBundle(g.bundle, g.original) : assert.fail();
    assert.equal(headline(screen.bundleHtml(go)), '성립합니다');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  }
});

test('an evidence package: the headline follows all four checks, and a waiting anchor is not a pass', { skip }, async () => {
  const { files, screen } = await load();
  const evidence = json('evidence-anchored.json');
  const said = async (value: any, bundle: any = null, spare = false) => {
    const html = screen.evidenceHtml(await files.checkEvidenceWith(value, bundle), spare);
    return { html, headline: headline(html), tiles: tiles(html), text: shown(html) };
  };
  const whole = await said(evidence);
  assert.deepEqual([whole.headline, whole.tiles], ['성립합니다', ['통과', '통과', '통과', '통과']]);
  assert.match(shown(whole.html.slice(whole.html.indexOf('id="v-unchecked"'))), /서명 공개키가 실제 그 기관의 것인지/, 'whose keys they are is listed as not checked');
  assert.match(whole.text, /서명이 증빙에 실린 기관 서명 공개키로 검증됩니까/, 'and the tile says which keys the signatures were checked with');
  assert.doesNotMatch(whole.text, /BENEFICIARY_CREDIT_CONFIRMED/, 'a state the file merely gives is not shown beside a verdict');

  const pending = { ...evidence, attestation: { ...evidence.attestation, bundle: null } };
  const waiting = await said(pending);
  // The file carries no bundle: that is what is known, and it is said of the file — not of an anchor's confirmation.
  assert.deepEqual([waiting.headline, waiting.tiles], ['앵커 번들이 없는 증빙입니다', ['통과', '통과', '통과', '번들 없음']]);
  assert.doesNotMatch(shown(waiting.html.slice(0, waiting.html.indexOf('class="links"'))), /확정|대기/, 'nothing is said about an anchor confirming');

  // An amount inside a signed element changed: the signature and the verdict fail, and their tiles say so.
  const tampered = structuredClone(evidence);
  tampered.package.evidence.elements.bankInstruction.amount = '999999.00';
  const broken = await said(tampered);
  assert.equal(broken.headline, '성립하지 않습니다');
  assert.equal(broken.tiles[1], '실패', 'the signatures tile');
  assert.match(broken.text, /무효 은행 지시 서명/);

  // The bundle inside carries no transaction: the hash is tied to nothing, and the anchor tile is not a pass.
  const noTx = structuredClone(evidence);
  delete noTx.attestation.bundle.anchor.reveal_tx_hex;
  const untied = await said(noTx);
  assert.equal(untied.headline, '성립하지 않습니다');
  assert.equal(untied.tiles[3], '실패');
  assert.doesNotMatch(untied.html, /id="v-txid"/);

  // A bundle of another record beside the package: a pairing mistake, said first; the package is reported as it came.
  const stray = await said(evidence, json('bundle-attest.json'));
  assert.match(stray.html, /id="v-pair"/);
  assert.match(shown(stray.html.slice(0, stray.html.indexOf('id="v-verdict"'))), /함께 넣은 번들은 이 증빙의 것이 아닙니다/);
  assert.equal(stray.headline, '성립합니다', 'the package itself, with the bundle it carries');
  // A file beside it that is no bundle is said to be unused.
  assert.match((await said(evidence, null, true)).text, /원본 칸의 파일은 쓰지 않았습니다/);
  // The same axes in another order are the same verdict.
  const reordered = structuredClone(evidence);
  reordered.package.verdict.axes = Object.fromEntries(Object.entries(reordered.package.verdict.axes).reverse());
  assert.equal((await said(reordered)).headline, '성립합니다');
});

test('a proof file and a balance file: a match, or what differs — never "anchored"', { skip }, async () => {
  const { files, screen } = await load();
  const proof = json('por-proof.json');
  const text = readFileSync(BALANCES, 'utf8');
  const said = (p: any, ledger: Uint8Array) => { const html = screen.snapshotHtml(files.checkSnapshotFiles(p, ledger)); return { html, headline: headline(html), text: shown(html) }; };

  const match = said(proof, bytes(text));
  assert.equal(match.headline, '원본과 일치합니다');
  assert.match(shown(match.html.slice(match.html.indexOf('id="v-unchecked"'))), /이 스냅샷이 앵커링되었는지/, 'what the pair cannot show is listed as not checked');

  // The balance file is the recorded one and the proof file's total was edited: the proof file is what changed,
  // the two roots are the same and are not printed as if they differed.
  const edited = structuredClone(proof);
  edited.statement.totals.BTC = String(BigInt(edited.statement.totals.BTC) + 1n);
  const altered = said(edited, bytes(text));
  assert.match(altered.headline, /^불일치 — 준비금 증명 파일이 내려받은 뒤 바뀌었습니다/);
  assert.doesNotMatch(altered.text, /머클 루트/, 'the roots agree, so no line says they do not');
  assert.match(altered.text, /BTC 총액/);

  // One amount changed in the balance file.
  const rows = text.split('\n');
  const cells = rows[1]!.split(',');
  cells[1] = cells[1]!.replace(/\d(?!.*\d)/, (d) => String((Number(d) + 1) % 10));
  const other = said(proof, bytes([rows[0], cells.join(','), ...rows.slice(2)].join('\n')));
  assert.match(other.headline, /^원본 불일치/);
  assert.match(other.text, /머클 루트/);
  for (const r of [altered, other]) {
    assert.doesNotMatch(r.text, /앵커/, 'nothing in a pair of files was held against an anchor');
  }
  // In a match the anchor is named once — as the thing not checked.
  assert.doesNotMatch(shown(match.html.slice(0, match.html.indexOf('id="v-unchecked"'))), /앵커/);
  // A file with far more rows than the snapshot holds is another file, said at once.
  const big = said(proof, bytes(`account_id,BTC,ETH,USDT\n${Array.from({ length: 5_000 }, (_, i) => `X-${i},0,0,0`).join('\n')}`));
  assert.match(big.headline, /^원본 불일치/);
  assert.match(big.text, /훨씬 많은 줄/);
  // The proof file alone: nothing checked, and it says so.
  const aloneHtml = screen.snapshotAloneHtml(proof);
  assert.equal(headline(aloneHtml), '원본 잔고 파일을 함께 넣으십시오');
  assert.match(shown(aloneHtml), /준비금 증명 파일만으로는 확인할 것이 없습니다/);
});

test('nothing a file contains becomes markup on the page', { skip }, async () => {
  const { files, screen } = await load();

  // A bundle: its label, its network, its statement's key id and algorithm.
  const bundle = json('signed-bundle.json');
  bundle.bitcoin_network = MARK;
  bundle.record.descriptor = { kind: MARK };
  bundle.record.preimage.statement.issuer.key_id = MARK;
  for (const descriptor of [{ kind: MARK }, { kind: 'remit-evidence', payment_id: MARK }, { kind: 'por-snapshot', snapshot_id: MARK, root: MARK, asof: MARK }, { kind: 'remit-manifest', date: MARK }]) {
    const b = structuredClone(bundle);
    b.record.descriptor = descriptor;
    const html = screen.bundleHtml(await files.checkBundle(b, { as: 'document', bytes: fixture('signed-document.txt') }));
    noForeignMarkup(html, `a bundle labelled ${JSON.stringify(descriptor).slice(0, 40)}`);
    assert.ok(shown(html).includes('alert(1)'), 'the value is shown, as text');
  }
  const unknown = json('document-bundle.json');
  unknown.record.preimage.scheme = MARK;
  noForeignMarkup(screen.bundleHtml(await files.checkBundle(unknown, null)), 'a bundle naming an unknown rule');

  // A reserve proof file: its id, its as-of time, the file it names; and the reader's own words about a wrong file.
  const proof = json('por-proof.json');
  proof.snapshot_id = MARK;
  proof.statement.asof = MARK;
  proof.source.file = MARK;
  const csv = bytes(readFileSync(BALANCES, 'utf8'));
  for (const [what, html] of [
    ['alone', screen.snapshotAloneHtml(proof)],
    ['a pair', screen.snapshotHtml(files.checkSnapshotFiles(proof, csv))],
    ['a file of another shape', screen.snapshotHtml(files.checkSnapshotFiles(proof, bytes(`${MARK},${MARK}\n${MARK},1\n`)))],
    ['with its bundle', screen.bundleHtml(await files.checkBundle(json('por-bundle.json'), { as: 'snapshot', proof }))],
  ] as const) noForeignMarkup(html, `a proof file with markup in it, ${what}`);
  const damaged = files.planCheck(bytes({ ...json('por-proof.json'), seed: MARK }), null);
  assert.equal(damaged.check, 'none');
  if (damaged.check === 'none') noForeignMarkup(screen.refusalHtml(damaged), 'a damaged proof file\'s problems');

  // An evidence package: the payment id, the state, element and axis names, a state, a status, a problem string.
  const base = await files.checkEvidenceWith(json('evidence-anchored.json'), null);
  const hostile = structuredClone(base);
  hostile.report.subject = { paymentId: MARK, state: MARK, generatedAt: MARK };
  hostile.report.signatures = { ok: false, elements: [{ element: MARK, status: MARK }, { element: 'constructor', status: '__proto__' }], problem: MARK };
  hostile.report.verdict = { ok: false, mine: { [MARK]: MARK, constructor: MARK }, theirs: { [MARK]: MARK }, problem: undefined };
  hostile.report.commitment = { ok: false, computed: MARK, stated: MARK };
  hostile.report.anchor = { ...hostile.report.anchor, problem: MARK };
  hostile.given = { matches: false, subject: { kind: 'remit-evidence', paymentId: MARK } };
  const html = screen.evidenceHtml(hostile, true);
  noForeignMarkup(html, 'an evidence package with markup in every field');
  assert.doesNotMatch(shown(html), /function Object|\[native code\]/, 'a name that is also a method of every object is shown as the name');
  const problems = structuredClone(base);
  problems.report.commitment = { ok: false, computed: null, stated: null, problem: MARK };
  problems.report.verdict = { ok: false, mine: null, theirs: null, problem: MARK };
  noForeignMarkup(screen.evidenceHtml(problems, false), 'problem strings');
});

test('what was not checked is refused in words, never left looking like a result', { skip }, async () => {
  const { files, screen } = await load();
  const why = (a: Uint8Array, b: Uint8Array | null = null): string => {
    const p = files.planCheck(a, b);
    assert.equal(p.check, 'none');
    return p.check === 'none' ? headline(screen.refusalHtml(p)) : '';
  };
  assert.equal(why(fixture('document.txt')), '검증할 수 있는 파일이 아닙니다');
  assert.equal(why(fixture('crafted/account-proof.json')), '계정 증명 파일입니다');
  assert.equal(why(fixture('document-bundle.json'), fixture('por-bundle.json')), '같은 종류의 파일이 두 개입니다');
  assert.equal(why(fixture('por-proof.json'), fixture('evidence-anchored.json')), '짝이 맞지 않는 두 파일입니다');
  assert.match(why(bytes({ ...json('por-proof.json'), seed: 'x' })), /^준비금 증명 파일이 손상되었습니다/);
  assert.match(why(bytes({ ...json('por-proof.json'), schema: 'stonehash.por-snapshot-proof.v9' })), /읽지 못하는 버전/);
});
