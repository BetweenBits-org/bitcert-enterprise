/**
 * Renders every document this hub publishes and checks the output.
 *
 * The renderer is ours (see `src/markdown.ts` for why), so it gets the scrutiny
 * a dependency would otherwise have received from its own test suite. The
 * inputs are not synthetic: the Evidence Specification is 500-odd lines of
 * tables, JSONC samples and byte-layout diagrams, which is precisely the
 * material a naive renderer mangles.
 *
 * The specification is also the document a regulator reads to write their own
 * verifier. Mangling a byte offset in it is not a cosmetic bug — it would send
 * someone to implement the wrong thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdown, slug } from '../src/markdown.ts';

/** Mirrors the code-span sentinel in src/markdown.ts. */
const SENTINEL = '\u0000';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.resolve(HERE, '../content');
const SPEC_MD = path.resolve(HERE, '../../../fixtures/bundle-schema.md');

/** The tags the renderer is allowed to emit. Anything else is a bug or an injection. */
const ALLOWED = /<\/?(?:h[1-6]|p|pre|code|ul|ol|li|table|thead|tbody|tr|th|td|div|blockquote|strong|em|hr|a|br)(?:\s[^>]*)?>/g;

function documents(): { name: string; src: string }[] {
  const docs = readdirSync(CONTENT).filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, src: readFileSync(path.join(CONTENT, f), 'utf8') }));
  assert.ok(docs.length > 0, 'expected markdown under content/');
  return docs;
}

test('the published content set is present', () => {
  const names = documents().map((d) => d.name);
  for (const required of ['quickstart.md', 'security.md', 'sdk.md', 'vectors.md', 'changelog.md']) {
    assert.ok(names.includes(required), `content/${required} is missing`);
  }
});

test('the Evidence Specification is published from fixtures, not a copy', () => {
  // A second copy under content/ would go stale the moment the wire contract
  // changed, and the stale one is the one the reader would be shown.
  assert.ok(existsSync(SPEC_MD), 'fixtures/bundle-schema.md not found');
  assert.ok(!existsSync(path.join(CONTENT, 'bundle-schema.md')),
    'the specification must be copied from fixtures/ at build time, never duplicated into content/');
});

test('every document renders without emitting unexpected markup', () => {
  const all = [...documents(), { name: 'bundle-schema.md', src: readFileSync(SPEC_MD, 'utf8') }];
  for (const { name, src } of all) {
    const { html } = renderMarkdown(src);
    assert.ok(html.length > 0, `${name} rendered empty`);

    // Strip the tags we emit; any angle bracket left over is text that escaped
    // unescaped, which in a JSONC sample full of `<` would be silent corruption.
    const stray = html.replace(ALLOWED, '');
    assert.equal(stray.match(/[<>]/g), null,
      `${name}: unescaped angle bracket survived rendering`);

    // The code-span sentinel is U+0000. If one reaches the output, reinsertion
    // failed and the reader sees a hole where a code span should be.
    assert.ok(!html.includes(SENTINEL), `${name}: code-span sentinel leaked into the output`);
  }
});

test('the specification keeps every table and code sample it has', () => {
  const src = readFileSync(SPEC_MD, 'utf8');
  const { html, headings } = renderMarkdown(src);

  // Counted from the source rather than guessed at, so this measures the
  // renderer against the document instead of against a number someone typed.
  // A table is its delimiter row; a sample is a pair of fences.
  const srcTables = (src.match(/^\|[\s:|-]+\|\s*$/gm) ?? []).length;
  const srcFences = Math.floor((src.match(/^```/gm) ?? []).length / 2);
  const srcHeadings = (src.match(/^#{1,6}\s/gm) ?? []).length;

  assert.ok(srcTables > 0 && srcFences > 0, 'the specification should contain tables and samples');
  assert.equal((html.match(/<table>/g) ?? []).length, srcTables,
    'a field table in the wire contract was dropped or merged');
  assert.equal((html.match(/<pre class="code/g) ?? []).length, srcFences,
    'a JSONC sample in the wire contract was dropped');
  assert.equal(headings.length, srcHeadings, 'a section heading was dropped');
});

test('code spans survive emphasis markers inside them', () => {
  // `**x**` inside backticks must stay literal: in a byte-layout document the
  // asterisks can be part of what is being specified.
  const { html } = renderMarkdown('A `**literal**` span and a **bold** word.');
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('numbers surrounded by spaces are not mistaken for code slots', () => {
  // This is the bug the U+0000 sentinel exists to prevent: the first renderer
  // marked extracted spans as " 0 ", and the specification's byte-offset tables
  // are full of bare numbers between spaces — so reinsertion overwrote them.
  const { html } = renderMarkdown(
    '| offset | len | field |\n|--|--|--|\n| 0 | 32 | `txid` |\n| 32 | 4 | `vout` |');
  assert.match(html, /<code>txid<\/code>/, 'the code span did not come back');
  assert.match(html, /<code>vout<\/code>/, 'the second code span did not come back');
  assert.match(html, /<td[^>]*>0<\/td>/, 'offset 0 was overwritten');
  assert.match(html, /<td[^>]*>32<\/td>/, 'offset 32 was overwritten');
});

test('links are restricted to relative, anchor and http(s) targets', () => {
  const { html } = renderMarkdown(
    '[rel](./x.md) [anchor](#y) [ext](https://example.org) [bad](javascript:alert(1))');
  assert.match(html, /href="\.\/x\.md"/);
  assert.match(html, /href="#y"/);
  assert.match(html, /href="https:\/\/example\.org"[^>]*rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /javascript:/, 'a javascript: target must not reach the document');
});

test('headings get unique, deep-linkable ids', () => {
  const { headings } = renderMarkdown('# Anchor\n## Anchor\n### Other');
  const ids = headings.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate heading ids: ${ids.join(', ')}`);
  assert.equal(slug('4. Anchor — `BC01`'), '4-anchor-bc01');
});

/**
 * The anti-exaggeration guards of `DESIGN.md §10`, applied to prose.
 *
 * The rules engine enforces these in code. Marketing copy is the other place
 * the claim gets made, and a document that oversells is as damaging as a UI
 * that does — it is just harder to test, which is why it is tested here.
 */
test('no document claims regtest proofs are publicly verifiable', () => {
  for (const { name, src } of documents()) {
    // Whitespace is collapsed first. Prose wraps, and the phrase that carries
    // the caveat lands across a line break often enough that a line-sensitive
    // match fails on documents that are in fact correct.
    const text = src.toLowerCase().replace(/\s+/g, ' ');
    if (!text.includes('regtest')) continue;
    // Wherever regtest is discussed, the limitation must be stated nearby —
    // not in a footnote on another page.
    assert.ok(
      /cannot be confirmed|not publicly verifiable|cannot be satisfied|we mine the blocks|not a publicly verifiable/.test(text),
      `content/${name} mentions regtest without stating that third-party chain confirmation is unavailable there`);
  }
});

test('no document promises a compliance or regulatory determination', () => {
  const banned = [
    /\bguarantees? (?:regulatory )?compliance\b/i,
    /\bcompliance (?:is )?(?:automatically )?(?:assured|guaranteed)\b/i,
    /\blegally binding\b/i,
    /\bcertified by\b/i,
  ];
  for (const { name, src } of documents()) {
    for (const re of banned) {
      assert.doesNotMatch(src, re,
        `content/${name} makes a compliance claim this product does not support`);
    }
  }
});

test('the Quick Start hashes locally and says the file is never uploaded', () => {
  const qs = readFileSync(path.join(CONTENT, 'quickstart.md'), 'utf8');
  assert.match(qs, /sha256|SHA-256/, 'the Quick Start must show how to hash');
  assert.match(qs, /never (?:uploaded|sent)|not uploaded|hash(?:ed)? locally/i,
    'the Quick Start must state that the document itself is never uploaded');
});

test('the cross-border guide is one page, about calling the SDK from the bank\'s own source', () => {
  /*
   * A bank applies the SDK inside its own system's source: it does not run
   * the corridor from a terminal, and it registers its key and activates the
   * product in the console. The guide once had a second page for SWIFT
   * messages that repeated half of this one, a "first payment" walk through
   * shell commands, and steps for the console's own screens. All three went;
   * this keeps them from coming back.
   */
  const app = readFileSync(path.resolve(HERE, '../src/app.ts'), 'utf8');
  assert.doesNotMatch(app, /id: 'swift'/, 'SWIFT Messages is no longer a page of its own');
  assert.match(app, /swift: 'corridor'/, 'and a link to it opens the guide its content went to');
  for (const dir of ['', 'ko']) {
    assert.ok(!existsSync(path.join(CONTENT, dir, 'swift.md')), `content/${dir}/swift.md came back`);
    for (const f of readdirSync(path.join(CONTENT, dir)).filter((n) => n.endsWith('.md'))) {
      assert.doesNotMatch(readFileSync(path.join(CONTENT, dir, f), 'utf8'), /\]\(#swift\)/, `${dir}/${f} links to the page that is gone`);
    }
    const guide = readFileSync(path.join(CONTENT, dir, 'corridor.md'), 'utf8');
    assert.doesNotMatch(guide, /```(?:bash|sh|shell|console)\b/, `${dir}/corridor.md: a bank is given code to call, not a shell to type into`);
    assert.doesNotMatch(guide, /cli\.ts|\bcurl\b|\bexport [A-Z_]+=|sha256sum|\bkeygen\b|--register\b|node [\w./-]+\.(?:ts|mjs)\b/,
      `${dir}/corridor.md: no command lines`);
    // What reading a SWIFT message needs is on this page now, not behind a link.
    for (const needed of ['submitSwift(', 'swiftStatus(', 'statusReport(', 'IntrBkSttlmAmt', '`ACCC`', 'reference_reused', 'readOnly: true']) {
      assert.ok(guide.includes(needed), `${dir}/corridor.md lost ${needed}`);
    }
    // The SDK is handed over as a link, and what it links has to be what the build packs.
    // (`./…`: the renderer turns a target it does not recognise as relative into `#`.)
    assert.match(guide, /\]\(\.\/download\/attest-remit\.tar\.gz\)/, `${dir}/corridor.md must link the SDK`);
    assert.match(guide, /\]\(\.\/download\/attest-remit\.sha256\)/, `${dir}/corridor.md must link its checksum`);
    assert.doesNotMatch(renderMarkdown(guide).html, /<a href="#">/, `${dir}/corridor.md has a link the renderer refused`);
  }
  const build = readFileSync(path.resolve(HERE, '../build.mjs'), 'utf8');
  assert.match(build, /file: 'attest-remit\.tar\.gz'/, 'the build must still pack the archive the guide links');
});

test('the guide\'s code examples compile in a strict TypeScript build', () => {
  /*
   * A bank that applies the SDK in its own source compiles that source. Node
   * runs the examples without checking a type, so two of them ran for a
   * reviewer and still failed `tsc --strict`: a lookup typed `unknown`, and
   * evidence typed as a bare record. They are compiled here under the
   * strictest settings this repository has, against the SDK as it stands.
   */
  const sdk = path.resolve(HERE, '../../../packages/attest-remit/src/index.ts');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guide-examples-'));
  try {
    const files: string[] = [];
    for (const lang of ['', 'ko']) {
      const md = readFileSync(path.join(CONTENT, lang, 'corridor.md'), 'utf8');
      const blocks = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
      assert.equal(blocks.length, 3, `${lang}/corridor.md: expected the three examples (message, own data, signer)`);
      blocks.forEach((code, i) => {
        assert.ok(code.includes("'./packages/attest-remit/src/index.ts'"),
          `${lang}/corridor.md example ${i + 1} must import the SDK by its path in the download`);
        const file = path.join(dir, `${lang || 'en'}-${i + 1}.ts`);
        writeFileSync(file, code.replaceAll("'./packages/attest-remit/src/index.ts'", JSON.stringify(sdk)));
        files.push(file);
      });
    }
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.resolve(HERE, '../../../tsconfig.base.json'),
      compilerOptions: { types: ['node'], typeRoots: [path.resolve(HERE, '../node_modules/@types')] },
      files,
    }));
    const tsc = spawnSync(path.resolve(HERE, '../node_modules/.bin/tsc'), ['-p', dir], { encoding: 'utf8' });
    assert.equal(tsc.status, 0, `the guide's examples do not compile:\n${tsc.stdout}${tsc.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reserve guide is about calling the SDK from the exchange\'s own source, and one file to keep', () => {
  /*
   * An exchange applies the SDK inside its own system's source, as a bank
   * does: it does not run a snapshot from a terminal, and it registers its
   * key and activates the product in the console. These two pages once walked
   * through eight commands, a key-registration script and a quick-start
   * script, and had the reader keep a directory of five files per snapshot.
   * What they show now is two calls and two files; this keeps the rest from
   * coming back.
   */
  for (const dir of ['', 'ko']) {
    for (const page of ['por.md', 'por-data.md']) {
      const guide = readFileSync(path.join(CONTENT, dir, page), 'utf8');
      assert.doesNotMatch(guide, /```(?:bash|sh|shell|console)\b/, `${dir}/${page}: an exchange is given code to call, not a shell to type into`);
      assert.doesNotMatch(guide, /cli\.ts|\bcurl\b|\bexport [A-Z_]+=|sha256sum|\bkeygen\b|--register\b|node [\w./-]+\.(?:ts|mjs)\b|\$POR\b/,
        `${dir}/${page}: no command lines`);
      assert.doesNotMatch(guide, /--(?:csv|accounts-json|assets|assets-file|amounts|asof|out|tree|key|core|layout|snapshot-proof|user-ref|all|wait|spot-check)\b/,
        `${dir}/${page}: an option is named as the code names it, not as a command-line flag`);
      // Registering the key and activating the product are done in the console; the guide names where, and no more.
      assert.doesNotMatch(guide, /registerIssuerKey|generateSigningKey|\/v1\/issuer-keys|quickstart\//, `${dir}/${page}: a console task is walked through`);
      assert.doesNotMatch(renderMarkdown(guide).html, /<a href="#">/, `${dir}/${page} has a link the renderer refused`);
    }
    const por = readFileSync(path.join(CONTENT, dir, 'por.md'), 'utf8');
    for (const needed of ['anchorBalanceFile(', 'openSnapshot(', 'proofFor(', 'writeAllProofs(', 'assertRegistered(', 'PorLedgerError',
      'proofFile:', 'STONEHASH_CORE', 'STONEHASH_API_KEY', 'STONEHASH_INSTITUTION', 'stonehash-por-signing-key.pem', 'spotCheck: true']) {
      assert.ok(por.includes(needed), `${dir}/por.md lost ${needed}`);
    }
    // The SDK is handed over as a link, and what it links has to be what the build packs.
    assert.match(por, /\]\(\.\/download\/attest-por\.tar\.gz\)/, `${dir}/por.md must link the SDK`);
    assert.match(por, /\]\(\.\/download\/attest-por\.sha256\)/, `${dir}/por.md must link its checksum`);
    const data = readFileSync(path.join(CONTENT, dir, 'por-data.md'), 'utf8');
    // The standard shape comes first, before any of the others is shown.
    const standard = data.indexOf('account_id,BTC,ETH,USDT');
    const long = data.indexOf('account_id,asset,balance');
    assert.ok(standard > 0 && long > standard, `${dir}/por-data.md must lead with one row per account`);
    for (const needed of ['readLiabilitiesCsv(', 'PorLedgerError', 'readAssetList(', '`seed`', '`source`', 'ignoreColumns', "amounts: 'decimal'"]) {
      assert.ok(data.includes(needed), `${dir}/por-data.md lost ${needed}`);
    }
    // One file to keep, and the directory of five is history, mentioned once.
    assert.doesNotMatch(data, /seed\.hex|tree\.json|submission\.json|build-report\.json/, `${dir}/por-data.md lists the directory an exchange no longer keeps`);
  }
  const build = readFileSync(path.resolve(HERE, '../build.mjs'), 'utf8');
  assert.match(build, /file: 'attest-por\.tar\.gz'/, 'the build must still pack the archive the guide links');
  assert.match(build, /'packages\/attest-por\/samples'/, 'with the example balance file the guide\'s code reads');
});

test('the reserve guide\'s code examples compile in a strict TypeScript build', () => {
  /*
   * The examples are what an exchange pastes into its own source, which it
   * compiles. Node runs them without checking a type, so they are compiled
   * here under the strictest settings this repository has, against the SDK
   * as it stands — a renamed option or a changed return type fails here
   * rather than in a reader's build.
   */
  const sdk = path.resolve(HERE, '../../../packages/attest-por/src/index.ts');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reserve-guide-examples-'));
  try {
    const files: string[] = [];
    for (const lang of ['', 'ko']) {
      for (const [page, expected] of [['por.md', 2], ['por-data.md', 1]] as const) {
        const md = readFileSync(path.join(CONTENT, lang, page), 'utf8');
        const blocks = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
        assert.equal(blocks.length, expected, `${lang}/${page}: expected ${expected} example${expected === 1 ? '' : 's'}`);
        blocks.forEach((code, i) => {
          assert.ok(code.includes("'./packages/attest-por/src/index.ts'"),
            `${lang}/${page} example ${i + 1} must import the SDK by its path in the download`);
          const file = path.join(dir, `${lang || 'en'}-${page.replace('.md', '')}-${i + 1}.ts`);
          writeFileSync(file, code.replaceAll("'./packages/attest-por/src/index.ts'", JSON.stringify(sdk)));
          files.push(file);
        });
      }
    }
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      extends: path.resolve(HERE, '../../../tsconfig.base.json'),
      compilerOptions: { types: ['node'], typeRoots: [path.resolve(HERE, '../node_modules/@types')] },
      files,
    }));
    const tsc = spawnSync(path.resolve(HERE, '../node_modules/.bin/tsc'), ['-p', dir], { encoding: 'utf8' });
    assert.equal(tsc.status, 0, `the reserve guide's examples do not compile:\n${tsc.stdout}${tsc.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an example written in two languages becomes one box with a switch', () => {
  /*
   * The Java examples are fences in the markdown like any other; it is the
   * page that turns a TypeScript fence and the Java fence after it into one
   * box showing one of the two. If that step goes missing the guide still
   * renders — with every example printed twice, back to back — so nothing
   * else would notice. The behaviour itself was checked in a browser; this
   * keeps the wiring from being dropped.
   */
  const app = readFileSync(path.resolve(HERE, '../src/app.ts'), 'utf8');
  assert.match(app, /addCopyButtons\(body\);\s*groupCodeLanguages\(body\);/, 'a rendered page must group its examples, after the copy buttons exist');
  assert.match(app, /\['ts', 'TypeScript'\], \['java', 'Java'\]/, 'the two languages the guides are written in');
  assert.match(app, /localStorage\.setItem\(CODE_LANGUAGE_KEY, lang\)/, 'the choice is remembered');
  assert.match(app, /try \{ return window\.localStorage\.getItem\(CODE_LANGUAGE_KEY\); \} catch \{ return null; \}/,
    'and a browser that refuses storage still gets a working page');
  const css = readFileSync(path.resolve(HERE, '../public/docs.css'), 'utf8');
  assert.match(css, /\.codeset \.codewrap\[hidden\] \{ display: none; \}/, 'the sample not chosen is hidden, not merely unstyled');
  assert.match(css, /\.codetab\[aria-pressed="true"\]/, 'and the chosen language is marked as pressed');
  // The renderer itself stays out of it: a fence is still one <pre>, whatever its language.
  const { html } = renderMarkdown('```ts\nconst a = 1;\n```\n\n```java\nint a = 1;\n```\n');
  assert.equal(html.match(/<pre class="code lang-(?:ts|java)">/g)?.length, 2);
  assert.doesNotMatch(html, /<button|codeset|codetab/);
});

test('every example of the cross-border guide is also given in Java, and the Java compiles', () => {
  /*
   * A bank whose systems are Java reads the same guide with the same
   * examples: each TypeScript example is followed directly by its Java twin,
   * and the page shows one of the two (`groupCodeLanguages` in src/app.ts).
   * A twin that is missing leaves a Java reader with TypeScript in the middle
   * of the page; one that no longer compiles is worse than none. So they are
   * counted, and compiled against the jar the hub hands out — with every
   * lint on, as a bank's own build would have it.
   *
   * A hub example is the lines a bank puts in its own method: imports, then
   * statements. Each is wrapped in a class to be compiled.
   */
  const jar = path.resolve(HERE, '../../../sdks/attest-remit-java/release/stonehash-attest-remit-0.1.0.jar');
  assert.ok(existsSync(jar), 'the Java SDK has no release: run sdks/attest-remit-java/release.sh');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guide-java-examples-'));
  try {
    const files: string[] = [];
    for (const lang of ['', 'ko']) {
      const md = readFileSync(path.join(CONTENT, lang, 'corridor.md'), 'utf8');
      const fences = [...md.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)]
        .map((m) => ({ language: m[1]!, code: m[2]!, start: m.index, end: m.index + m[0].length }));
      const java = fences.filter((f) => f.language === 'java');
      assert.equal(java.length, 3, `${lang}/corridor.md: expected the three examples in Java (message, own data, signer)`);
      fences.forEach((fence, i) => {
        if (fence.language !== 'ts') return;
        const twin = fences[i + 1];
        assert.ok(twin?.language === 'java' && md.slice(fence.end, twin.start).trim() === '',
          `${lang}/corridor.md: a TypeScript example is not followed directly by its Java twin — the page cannot pair them`);
      });
      java.forEach(({ code }, i) => {
        const name = `${lang === 'ko' ? 'Ko' : 'En'}Example${i + 1}`;
        const lines = code.split('\n');
        const imports = lines.filter((l) => l.startsWith('import '));
        assert.ok(imports.some((l) => l.startsWith('import com.stonehash.attest.remit.')), `${lang}/corridor.md Java example ${i + 1} must import the SDK`);
        const body = lines.filter((l) => !l.startsWith('import ')).map((l) => (l.trim() ? `        ${l}` : '')).join('\n');
        const file = path.join(dir, `${name}.java`);
        writeFileSync(file, `${imports.join('\n')}\n\npublic final class ${name} {\n    private ${name}() {\n    }\n\n`
          + `    public static void main(String[] args) throws Exception {\n${body}\n    }\n}\n`);
        files.push(file);
      });
    }
    const javac = spawnSync('javac', ['--release', '11', '-Xlint:all', '-Werror', '-encoding', 'UTF-8', '-cp', jar, '-d', path.join(dir, 'out'), ...files],
      { encoding: 'utf8' });
    assert.ok(!javac.error, `the Java examples could not be checked — javac did not start: ${javac.error?.message}`);
    assert.equal(javac.status, 0, `the guide's Java examples do not compile:\n${javac.stdout}${javac.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
