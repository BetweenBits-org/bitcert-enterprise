/**
 * Checks the **built** output, not the sources.
 *
 * The hub ships unbundled ES modules, so the emit step is load bearing:
 * `rewriteRelativeImportExtensions` turns every `./markdown.ts` specifier into
 * `./markdown.js`, and a missed one would fail at load in a browser while every
 * source-level test stayed green. There is no bundler to catch it, so this does.
 *
 * It also renders the published documents through the *emitted* renderer. A
 * documentation site whose own build is broken fails in the least visible way
 * available: the shell loads, the nav works, and every panel is empty.
 *
 * Run `pnpm build` first; the tests skip with a clear message otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
const built = existsSync(path.join(DIST, 'app.js'));
const skip = built ? false : 'dist/ not built — run `pnpm build` in apps/docs first';

const walk = (dir: string, ext: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), ext)
      : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);

test('every emitted import resolves to a real file', { skip }, () => {
  const files = walk(DIST, '.js');
  assert.ok(files.length >= 3, 'expected the emitted module graph');
  let checked = 0;
  for (const f of files) {
    const body = readFileSync(f, 'utf8');
    for (const m of body.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
      const spec = m[1]!;
      assert.match(spec, /\.js$/, `${path.relative(DIST, f)} imports ${spec} — not rewritten to .js`);
      assert.ok(existsSync(path.resolve(path.dirname(f), spec)),
        `${path.relative(DIST, f)} imports a missing ${spec}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected at least one relative import between the emitted modules');
});

test('no .ts specifier survives into the build', { skip }, () => {
  for (const f of walk(DIST, '.js')) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /from\s+["'][^"']*\.ts["']/,
      `${path.relative(DIST, f)} kept a .ts specifier`);
  }
});

test('the page references only files that shipped', { skip }, () => {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\.[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(refs.length >= 2, 'expected the page to reference its script and stylesheet');
  for (const ref of refs) {
    assert.ok(existsSync(path.join(DIST, ref)), `index.html references a missing ${ref}`);
  }
  // Nothing may be loaded from another origin: the hub ships under
  // `default-src 'none'` and is meant to work with the network off.
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//, 'the page loads a remote asset');
});

test('links out of this mount are configuration, not markup', { skip }, () => {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  // The hub, the Playground and the API share a host on a test box and split
  // across three in production. A hardcoded `../playground/` works in the
  // first case and 404s in the second, which is a failure nobody sees until
  // the deployment they care about.
  assert.doesNotMatch(html, /href="\.\.\//,
    'a hardcoded parent-relative link escapes this mount; use data-link with a <meta> target');
  for (const m of html.matchAll(/data-link="([^"]+)"/g)) {
    assert.match(html, new RegExp(`<meta name="${m[1]!}" content=`),
      `data-link="${m[1]}" has no matching <meta> target, so the link would be dropped`);
  }
});

test('every element the script reaches for exists in the page', { skip }, () => {
  // `$()` throws on a missing id, and it runs during module evaluation — so a
  // renamed element does not degrade the page, it blanks it. The two files are
  // only coupled by these strings, and nothing else checks them.
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const app = readFileSync(path.join(DIST, 'app.js'), 'utf8');

  const ids = [...app.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]!);
  assert.ok(ids.length >= 4, `expected the script to address the page by id, found ${ids.length}`);
  for (const id of new Set(ids)) {
    assert.match(html, new RegExp(`id="${id}"`), `app.js looks up #${id}, which the page does not contain`);
  }

  // The badge is populated from /v1/meta and must start hidden: an empty
  // network badge reads as "no network stated", and on regtest the network is
  // exactly the thing a reader must not have to guess at.
  assert.match(html, /id="netbadge"[^>]*hidden/, 'the network badge must ship hidden');
});

test('every document the app lists actually shipped', { skip }, () => {
  // The page's document set is declared in app.ts and fetched at runtime, so a
  // renamed file is a 404 the reader sees and no build step notices.
  const app = readFileSync(path.join(DIST, 'app.js'), 'utf8');
  const files = [...app.matchAll(/file:\s*'([^']+\.md)'/g)].map((m) => m[1]!);
  assert.ok(files.length >= 5, `expected the content set in app.js, found ${files.length}`);
  for (const f of files) {
    assert.ok(existsSync(path.join(DIST, 'content', f)), `app.js lists content/${f}, which did not ship`);
  }
  assert.ok(files.includes('bundle-schema.md'),
    'the Evidence Specification must be among the published documents');
});

test('the emitted renderer renders every shipped document', { skip }, async () => {
  const { renderMarkdown } = await import(path.join(DIST, 'markdown.js')) as
    typeof import('../src/markdown.ts');

  const docs = readdirSync(path.join(DIST, 'content')).filter((f) => f.endsWith('.md'));
  assert.ok(docs.length >= 5, `expected the published documents, found ${docs.length}`);
  for (const d of docs) {
    const src = readFileSync(path.join(DIST, 'content', d), 'utf8');
    const { html, headings } = renderMarkdown(src);
    assert.ok(html.length > src.length / 2, `${d} rendered suspiciously little output`);
    assert.ok(headings.length > 0, `${d} produced no headings — the contents rail would be empty`);
  }
});

test('the emitted reference renders the whole API surface', { skip }, async () => {
  const { renderReference, operationId } = await import(path.join(DIST, 'openapi.js')) as
    typeof import('../src/openapi.ts');
  const spec = JSON.parse(readFileSync(path.join(DIST, 'openapi.json'), 'utf8'));

  const { html, nav } = renderReference(spec);
  assert.ok(nav.length >= 5, `expected a nav entry per tag, got ${nav.length}`);

  // Every operation must reach the page with a deep-linkable id. A $ref the
  // renderer failed to resolve shows up as an empty cell, not an error.
  let operations = 0;
  for (const [p, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      operations++;
      assert.ok(html.includes(`id="${operationId(method, p)}"`),
        `${method.toUpperCase()} ${p} is missing from the rendered reference`);
    }
  }
  // Counted from the spec, not hardcoded. A literal here went stale the moment
  // the console routes were documented, failing a test about *rendering* for a
  // reason that had nothing to do with rendering. `openapi.test.ts` is what
  // guards the operation set against the server; this only has to establish
  // that every operation in the spec reached the page.
  assert.ok(operations >= 10,
    `expected the reference to cover the API surface, found ${operations} operations`);

  // Named schemas are what the operation tables point at; an unrendered one
  // leaves the reader with a type name and nowhere to look it up.
  for (const name of Object.keys(spec.components.schemas as Record<string, unknown>)) {
    assert.ok(html.includes(`id="schema-${name}"`), `schema ${name} did not render`);
  }
  assert.doesNotMatch(html, /#\/components\//, 'an unresolved $ref leaked into the output');
});

test('the reference never offers to send the reader request with their key', { skip }, async () => {
  const { renderReference } = await import(path.join(DIST, 'openapi.js')) as
    typeof import('../src/openapi.ts');
  const spec = JSON.parse(readFileSync(path.join(DIST, 'openapi.json'), 'utf8'));
  const { html } = renderReference(spec);

  // A "try it" console on a documentation page encourages pasting a live key
  // into a browser tab and sends it to whatever host the page was built with.
  // The Playground is where the API gets exercised, and it holds no keys.
  assert.doesNotMatch(html, /<(?:form|input|button)\b/i,
    'the reference grew an interactive control; it must stay a document');
  assert.doesNotMatch(html, /\bon[a-z]+\s*=/i, 'inline event handler in rendered output');
  assert.doesNotMatch(html, /sk_live_[A-Za-z0-9]/, 'a live-looking key appears in the reference');
});

test('the status colours do not paint an unperformed check as success', { skip }, () => {
  const css = readFileSync(path.join(DIST, 'docs.css'), 'utf8');
  // `--pass-bg` and `--brand` are the verified colours. The "no key" badge is a
  // statement of fact about the free tier, not an achievement, so it must not
  // borrow them — the same rule the Playground applies to NOT_CHECKED.
  const openBadge = /\.auth\.open\s*\{([^}]*)\}/.exec(css);
  assert.ok(openBadge, 'expected a .auth.open rule');
  assert.doesNotMatch(openBadge[1]!, /--pass-bg|--brand\b/,
    '.auth.open uses a success colour; "no key" must read as neutral');
});

test('nothing emits an inline style attribute', { skip }, () => {
  // `style-src 'self'` drops `style` attributes, and drops them silently: the
  // table alignment the renderer emitted never reached the page. Static values
  // belong in the stylesheet.
  for (const f of walk(DIST, '.js')) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\bstyle="/,
      `${path.relative(DIST, f)} emits a style attribute, which this page's CSP drops`);
  }
});

test('every SDK tarball on the download shelf exists and matches its checksum', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  for (const name of ['attest-sign', 'attest-remit', 'attest-por', 'attest-remit-java']) {
    const tar = path.join(DIST, 'download', `${name}.tar.gz`);
    const sha = path.join(DIST, 'download', `${name}.sha256`);
    const bytes = await readFile(tar);
    assert.ok(bytes.length > 10_000, `${name}.tar.gz is implausibly small`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const stated = (await readFile(sha, 'utf8')).split(/\s+/)[0];
    assert.equal(digest, stated,
      `${name}: the checksum beside the tarball must describe the tarball beside it`);
  }
});
