/**
 * The console owns the Korean copy; the engine owns the scenarios.
 *
 * That split is deliberate — `teaches` is library text, read by tests and by
 * integrators, and translating it there would put product copy in a package
 * that has no screen. The cost is that a scenario can be added to the engine
 * and never reach this page's prose. This test is what makes that a build
 * failure rather than a paragraph of English appearing in a Korean screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIOS } from '@stonehash/attest-rules';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
const skip = existsSync(path.join(DIST, 'copy.js'))
  ? false : 'dist/ not built — run `pnpm build` in apps/console first';

test('every engine scenario has console copy', { skip }, async () => {
  const { SCENARIO_KO, SCENARIO_TITLE_KO, TAMPER_KO } = await import(path.join(DIST, 'copy.js')) as {
    SCENARIO_KO: Record<string, string>;
    SCENARIO_TITLE_KO: Record<string, string>;
    TAMPER_KO: Record<string, { label: string; asks: string }>;
  };
  for (const s of SCENARIOS) {
    const copy = SCENARIO_KO[s.id];
    assert.ok(copy, `scenario ${s.id} (${s.title}) has no Korean line`);
    assert.ok(copy.length > 40, `scenario ${s.id}: say what a reviewer learns`);
    assert.ok(SCENARIO_TITLE_KO[s.id], `scenario ${s.id} has no Korean title`);
  }
  // The server's catalogue is the list the screen draws from, so it is the
  // list that has to be covered — reading the module keeps this honest
  // without standing a service up.
  const server = readFileSync(
    path.resolve(HERE, '../../../apps/core/src/http/sandbox.ts'), 'utf8');
  const ids = [...server.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map((m) => m[1]!);
  assert.ok(ids.length >= 5, `expected the tamper catalogue, found ${ids.length}`);
  for (const id of ids) {
    assert.ok(TAMPER_KO[id], `tamper "${id}" has no Korean copy`);
  }
});

/**
 * The verdict has to come from the endpoint a customer integrates against.
 * If the console called a console-only evaluator, agreement between what a
 * prospect sees here and what their own system returns would be a hope.
 */
test('the sandbox reconciles against the integration endpoint', { skip }, () => {
  const src = readFileSync(path.join(DIST, 'api.js'), 'utf8');
  assert.match(src, /'\/v1\/settlements\/reconcile'/,
    'reconciliation must go to the public settlement endpoint');
  assert.doesNotMatch(src, /\/v1\/console\/sandbox\/reconcile/,
    'a console-only evaluator would make the demonstration meaningless');
});

/** The transcript is only evidence if it is taken at the call. */
test('the API transcript records at the fetch and redacts credentials', { skip }, () => {
  const src = readFileSync(path.join(DIST, 'api.js'), 'utf8');
  assert.match(src, /function record\(/);
  for (const secret of ['password', 'api_key_secret', 'token']) {
    assert.ok(src.includes(`'${secret}'`), `${secret} must be scrubbed from the transcript`);
  }
});

/** Hashing must survive the plain-http origin this console is reached on. */
test('hashing falls back when crypto.subtle is absent', { skip }, () => {
  const src = readFileSync(path.join(DIST, 'api.js'), 'utf8');
  assert.match(src, /vendor\/sha256\.js/);
  assert.ok(existsSync(path.join(DIST, 'vendor/sha256.js')), 'the fallback must ship');
});
