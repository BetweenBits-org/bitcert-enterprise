/**
 * Keeps the package honest about two promises printed on its tin.
 *
 * 1. **Zero runtime dependencies.** A dependency here would have to be audited
 *    by every regulator who wants to re-run the verification themselves, which
 *    defeats the point of publishing it.
 * 2. **Runs unchanged in the browser.** The Playground imports this module
 *    directly, so a single `node:*` import in `src/` would break it at runtime —
 *    and would only be noticed in a browser, not in CI. This asserts it in CI.
 *
 * Tests may of course use Node APIs; only `src/` is constrained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const PKG = path.resolve(HERE, '../package.json');

test('package declares no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as Record<string, unknown>;
  assert.equal(pkg['dependencies'], undefined, 'attest-verify must stay dependency-free');
  assert.equal(pkg['peerDependencies'], undefined);
});

test('src/ imports nothing from Node — it must run in a browser unchanged', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'expected source files');
  for (const f of files) {
    const body = readFileSync(path.join(SRC, f), 'utf8');
    // Strip block and line comments so prose about `node:crypto` does not trip this.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /from\s+['"]node:/, `${f} imports a node: builtin`);
    assert.doesNotMatch(code, /require\s*\(/, `${f} uses require()`);
    assert.doesNotMatch(code, /\bprocess\./, `${f} touches process`);
    assert.doesNotMatch(code, /\bBuffer\b/, `${f} uses Buffer (not available in browsers)`);
  }
});

test('src/ only imports siblings by explicit .ts path — no bundler magic needed', () => {
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
    const body = readFileSync(path.join(SRC, f), 'utf8');
    for (const m of body.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
      assert.match(m[1]!, /\.ts$/, `${f}: relative import ${m[1]} must end in .ts`);
    }
  }
});
