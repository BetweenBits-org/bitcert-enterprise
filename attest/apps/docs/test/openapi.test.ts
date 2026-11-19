/**
 * Keeps `openapi.json` honest about the server it claims to describe.
 *
 * A hand-written specification drifts. It drifts silently, and it drifts in the
 * direction that flatters the product: a route gets added and never documented,
 * or one gets removed and the reference keeps advertising it. Either way the
 * first person to notice is an integrator whose call 404s.
 *
 * So the route table is not transcribed here — it is read out of
 * `apps/core/src/http/routes.ts` and compared. Adding a route to the server
 * without documenting it turns this red, which is the only mechanism that has
 * ever kept a reference current.
 *
 * Scanning the source rather than importing the router is deliberate, and
 * follows `attest-verify/test/portability.test.ts`: `buildRouter` needs a
 * database, a config and a live anchor backend, and its `routes` array is
 * private. A documentation test should not need bitcoind running.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderReference } from '../src/openapi.ts';
import type { Spec as RenderedSpec } from '../src/openapi.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(readFileSync(path.resolve(HERE, '../openapi.json'), 'utf8')) as Spec;
// The whole served surface: the base router plus the remit and PoR route
// modules it mounts. A new route file must be added here or its operations
// hide from the honesty tests below.
const ROUTES_TS = [
  '../../core/src/http/routes.ts',
  '../../core/src/remit/routes.ts',
  '../../core/src/por/routes.ts',
].map((f) => readFileSync(path.resolve(HERE, f), 'utf8')).join('\n');

interface Operation {
  summary?: string;
  description?: string;
  responses?: Record<string, unknown>;
  security?: unknown[];
  requestBody?: { content?: Record<string, unknown> };
}
interface Spec {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; responses?: Record<string, unknown>; parameters?: Record<string, unknown> };
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Every operation in the spec, as `GET /v1/meta`. */
function specOperations(): string[] {
  const out: string[] = [];
  for (const [p, item] of Object.entries(SPEC.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) out.push(`${method.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

/**
 * Every route the server registers, read out of its source.
 *
 * `r.get(…)` / `r.post(…)` carry the method in the call; `r.add('OPTIONS', …)`
 * states it as the first argument. Express-style `:id` becomes OpenAPI `{id}`.
 */
function serverRoutes(): { op: string; method: string; path: string }[] {
  const code = ROUTES_TS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: { op: string; method: string; path: string }[] = [];

  for (const m of code.matchAll(/\br\.(get|post)\(\s*'([^']+)'/g)) {
    const method = m[1]!.toUpperCase();
    const p = m[2]!.replace(/:(\w+)/g, '{$1}');
    found.push({ op: `${method} ${p}`, method, path: p });
  }
  for (const m of code.matchAll(/\br\.add\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g)) {
    const method = m[1]!;
    const p = m[2]!.replace(/:(\w+)/g, '{$1}');
    found.push({ op: `${method} ${p}`, method, path: p });
  }
  return found;
}

test('the source scan finds the router — if this fails, the scan broke, not the spec', () => {
  const routes = serverRoutes();
  assert.ok(routes.length >= 13,
    `expected at least 13 route registrations in routes.ts, found ${routes.length}. `
    + 'The registration syntax probably changed; fix this scanner before trusting the tests below.');
  assert.ok(routes.some((r) => r.op === 'GET /v1/meta'), 'expected GET /v1/meta among the scanned routes');
});

test('every documented operation exists on the server', () => {
  const live = new Set(serverRoutes().map((r) => r.op));
  const phantom = specOperations().filter((op) => !live.has(op));
  assert.deepEqual(phantom, [],
    'openapi.json documents operations the server does not serve. An integrator '
    + 'following the reference would get a 404.');
});

/**
 * The converse, with one stated exemption.
 *
 * CORS preflight is transport rather than API surface: the three `OPTIONS`
 * handlers exist so a browser on `playground.` can call `api.`, and documenting
 * them as operations would imply a caller should invoke them. The exemption is
 * listed by path so a *new* undocumented route still fails.
 */
test('every served operation is documented — preflight excepted', () => {
  const documented = new Set(specOperations());
  const undocumented = serverRoutes()
    .filter((r) => r.method !== 'OPTIONS')
    .map((r) => r.op)
    .filter((op) => !documented.has(op));
  assert.deepEqual(undocumented, [],
    'the server serves routes openapi.json does not document. Add them to the '
    + 'spec, or the Developer Hub is advertising a smaller API than exists.');
});

test('preflight handlers are OPTIONS only, so the exemption cannot hide a real route', () => {
  const exempt = serverRoutes().filter((r) => r.method === 'OPTIONS');
  assert.equal(exempt.length, 3, 'expected exactly the three /v1/public/anchors preflight handlers');
  for (const r of exempt) {
    assert.match(r.path, /^\/v1\/public\/anchors/, `unexpected OPTIONS route ${r.op}`);
  }
});

test('every operation documents its responses, including failures', () => {
  for (const [p, item] of Object.entries(SPEC.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      const where = `${method.toUpperCase()} ${p}`;
      assert.ok(op.summary, `${where} has no summary`);
      assert.ok(op.description, `${where} has no description`);
      const codes = Object.keys(op.responses ?? {});
      assert.ok(codes.length > 0, `${where} documents no responses`);
      assert.ok(codes.some((c) => c.startsWith('2')), `${where} documents no success response`);
      // A reference that lists only the happy path is the reason integrators
      // discover error shapes in production.
      if (method !== 'get' || !['/healthz', '/readyz', '/v1/meta'].includes(p)) {
        assert.ok(codes.some((c) => c.startsWith('4') || c.startsWith('5')),
          `${where} documents no failure response`);
      }
    }
  }
});

test('every $ref resolves — a broken ref renders as a blank field', () => {
  const refs: string[] = [];
  JSON.stringify(SPEC, (k, v) => {
    if (k === '$ref' && typeof v === 'string') refs.push(v);
    return v as unknown;
  });
  assert.ok(refs.length > 0, 'expected the spec to use component refs');
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/'), `external ref ${ref} — the hub must stay self-contained`);
    let node: unknown = SPEC;
    for (const seg of ref.slice(2).split('/')) {
      assert.ok(node && typeof node === 'object' && seg in node, `unresolvable ref ${ref}`);
      node = (node as Record<string, unknown>)[seg];
    }
  }
});

test('the keyed API requires a key and the free tier does not', () => {
  const needsKey = (p: string, m: string): boolean => {
    const op = SPEC.paths[p]?.[m];
    assert.ok(op, `${m.toUpperCase()} ${p} missing from the spec`);
    // `security: []` on an operation clears the document-level requirement.
    return op.security === undefined;
  };
  // Authenticated: `requireAuth` is the first line of each of these handlers.
  for (const [p, m] of [
    ['/v1/attestations', 'post'], ['/v1/attestations', 'get'],
    ['/v1/attestations/{id}', 'get'], ['/v1/attestations/{id}/bundle', 'get'],
    ['/v1/settlements/reconcile', 'post'], ['/v1/settlements/bundle', 'post'],
  ] as const) {
    assert.ok(needsKey(p, m), `${m.toUpperCase()} ${p} must document a key requirement`);
  }
  // Deliberately open. Documenting these as authenticated would misrepresent
  // the free tier, which is the whole no-signup claim.
  for (const [p, m] of [
    ['/healthz', 'get'], ['/readyz', 'get'], ['/v1/meta', 'get'],
    ['/v1/public/anchors', 'post'], ['/v1/public/anchors/{id}', 'get'],
    ['/v1/public/anchors/{id}/bundle', 'get'], ['/v1/sandbox/keys', 'post'],
  ] as const) {
    assert.ok(!needsKey(p, m), `${m.toUpperCase()} ${p} must document that no key is needed`);
  }
});

/**
 * The anti-exaggeration guards of `DESIGN.md §10`, applied to the reference.
 *
 * The rules engine already enforces these at runtime and in its own tests. The
 * reference is a second place the claim gets made, and a document that promises
 * a compliance verdict is as damaging as code that returns one.
 */
test('the reference cannot promise a regulatory determination', () => {
  const verdict = SPEC.components.schemas['Verdict'] as
    { properties?: { regulatoryDecision?: { const?: string } } } | undefined;
  assert.ok(verdict, 'the Verdict schema is missing');
  assert.equal(verdict.properties?.regulatoryDecision?.const, 'NOT_EVALUATED',
    'regulatoryDecision must be pinned to NOT_EVALUATED in the documented schema, '
    + 'not left as an open enum a reader could take as a compliance verdict');
});

test('the network field is documented as an enum that includes the test chains', () => {
  const net = SPEC.components.schemas['BitcoinNetwork'] as { enum?: string[] } | undefined;
  assert.ok(net?.enum, 'BitcoinNetwork must be an enum');
  for (const n of ['mainnet', 'testnet', 'signet', 'regtest']) {
    assert.ok(net.enum.includes(n), `BitcoinNetwork omits ${n}`);
  }
  // A bundle whose network is not stated could be passed off as mainnet.
  const bundle = SPEC.components.schemas['ProofBundle'] as { required?: string[] } | undefined;
  assert.ok(bundle?.required?.includes('bitcoin_network'),
    'bitcoin_network must be required on ProofBundle — it is what stops a regtest '
    + 'proof being presented as a mainnet one');
});

test('the spec is self-contained — no remote schemas', () => {
  // The hub ships under a `default-src 'none'` CSP and is meant to work
  // offline, so a schema that has to be fetched would render as a blank panel
  // for exactly the reader who most needs it: one checking our claims on a
  // machine with no route to us.
  assert.doesNotMatch(JSON.stringify(SPEC), /"\$ref"\s*:\s*"https?:/, 'remote $ref');
});

/**
 * The hub may not tell a reader to run something that cannot work.
 *
 * Three separate instructions on this site turned out to be fiction, each
 * found by someone pasting it rather than by review: `docker pull
 * stonehash/attest-sign` (no such registry image), `npm i
 * @stonehash/attest-verify` (404 on npm), and a `github.com/stonehash/attest`
 * label (404). They are all the same defect — a published command is a
 * promise, and a broken one costs more trust than a missing feature.
 *
 * The rule is narrow enough to enforce: nothing here installs or pulls a
 * `@stonehash` / `stonehash/` artefact from a registry, because none are
 * published. Lift an entry when the thing it names actually exists.
 */
test('the hub never instructs a reader to fetch something that is not published', () => {
  const dir = path.join(HERE, '../content');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'expected the content pages to be present');

  const offences: string[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // Prose may discuss these; only an imperative command is a promise.
      if (/^\s*(npm|pnpm|yarn)\s+(i|install|add)\s+@stonehash\//.test(line)
        || /^\s*docker\s+(pull|run)[^\n]*\bstonehash\//.test(line)) {
        offences.push(`${file}:${i + 1}  ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offences, [],
    'these commands name artefacts that are not published:\n' + offences.join('\n'));
});

test('every external link in the hub is one we have actually checked', () => {
  /*
   * Not a network test — those are flaky and slow. An allowlist instead, so
   * adding a URL is a deliberate act that someone had to verify once.
   * `github.com/stonehash/attest` sat in a Docker label for a day pointing
   * at a 404.
   */
  const KNOWN = new Set([
    'https://stonehash.com',
    'https://www.rfc-editor.org/rfc/rfc8785',
  ]);
  const dir = path.join(HERE, '../content');
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^)\s"'`]+/g)) {
      found.add(m[0].replace(/[.,]$/, ''));
    }
  }
  const unknown = [...found].filter((u) => !KNOWN.has(u));
  assert.deepEqual(unknown, [],
    'new external links must be verified and added to the allowlist: ' + unknown.join(', '));
});

test('every page that claims a Korean copy has one, and it is not a stub', () => {
  /*
   * `Page.ko` tells the app to fetch `content/ko/<file>`; a missing file
   * there is a blank page, and a thin one is worse than English because the
   * reader cannot tell they are missing anything.
   *
   * The specification and the API reference are deliberately absent: both
   * are contracts an implementation must match, and a translated contract is
   * a second normative text. The app says so in place of the page rather
   * than serving English silently.
   */
  const en = path.join(HERE, '../content');
  const ko = path.join(HERE, '../content/ko');
  // Within each page entry: a fixed character window reached into the next
  // entry's `file:` as soon as one page (the reference) was translated
  // without a Markdown file of its own.
  const declared = [...readFileSync(path.resolve(HERE, '../src/app.ts'), 'utf8')
    .matchAll(/\{ id: '[^']+',[\s\S]*?\},\n/g)]
    .filter((m) => m[0].includes('ko: true'))
    .map((m) => /file: '([^']+)'/.exec(m[0])?.[1])
    .filter((f): f is string => Boolean(f));
  assert.ok(declared.length >= 5, `expected several translated pages, found ${declared.length}`);

  for (const file of declared) {
    const target = path.join(ko, file);
    assert.ok(existsSync(target), `declared ko: true but content/ko/${file} is missing`);
    const korean = readFileSync(target, 'utf8');
    const english = readFileSync(path.join(en, file), 'utf8');

    assert.match(korean, /[가-힣]/, `content/ko/${file} contains no Korean`);
    // A translation that lost most of its text is a stub, not a translation.
    assert.ok(korean.length > english.length * 0.5,
      `content/ko/${file} is ${Math.round(korean.length / english.length * 100)}% the length `
      + 'of the English — looks like a stub');

    // Headings carry the in-page contents rail and the #anchors other pages
    // link to, so the two copies must have the same shape.
    const heads = (text: string): number => (text.match(/^##\s/gm) ?? []).length;
    assert.equal(heads(korean), heads(english),
      `content/ko/${file} has ${heads(korean)} sections against the English ${heads(english)}`);
  }
});

test('the untranslated pages are the contracts, and only those', () => {
  const app = readFileSync(path.resolve(HERE, '../src/app.ts'), 'utf8');
  const untranslated = [...app.matchAll(/\{ id: '([^']+)',[\s\S]{0,400}?\},\n/g)]
    .filter((m) => !m[0].includes('ko: true'))
    .map((m) => m[1]!);
  assert.deepEqual(untranslated.sort(), ['spec'],
    'only the specification may be English-only — the reference translates its prose in openapi.json');
});

test('the language toggle sits at the far right of the masthead', () => {
  // Same position as the marketing site's header pair, for the same reason
  // given there: of everything in this bar, switching language is the one
  // control nobody arrives wanting. The hub and the console must agree, or
  // moving between them means hunting for it twice.
  const html = readFileSync(path.resolve(HERE, '../public/index.html'), 'utf8');
  const bar = html.match(/<nav class="outbound">([\s\S]*?)<\/nav>/);
  assert.ok(bar, 'the masthead keeps its right-hand items in one nav');
  const inner = bar[1]!;
  const langs = inner.indexOf('id="langs"');
  assert.ok(langs > -1, 'the toggle belongs in that nav');
  assert.ok(langs > inner.indexOf('id="to-playground"') && langs > inner.indexOf('id="netbadge"'),
    'and comes last in it');
  assert.equal((html.match(/id="langs"/g) ?? []).length, 1, 'exactly one toggle');
});

/**
 * The reference reads in Korean too — and stays one contract.
 *
 * Paths, fields, codes and examples exist once; the prose carries a Korean
 * reading beside the English (`x-ko-summary`, `x-ko-description`, `x-ko-name`).
 * What keeps the two from drifting into two contracts is this test: a new or
 * changed English text without its Korean fails the build, and a Korean
 * reading that dropped or altered a `code span` — a path, a field, an error
 * code — fails it too.
 */
test('every prose field of the reference has a Korean reading that keeps its code spans', () => {
  const spans = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();
  const missing: string[] = [];
  const drifted: string[] = [];
  const checked: string[] = [];
  // Inside `properties` or `headers` every key is a name — a field called
  // `value`, a header called `x-evidence-sha256` — and is visited like any
  // other node. Elsewhere `value` and `example` hold example payloads and
  // `x-*` the readings themselves, which is all the skip below is for; applied
  // to names as well, it once hid three English-only descriptions.
  const visit = (node: unknown, where: string, names = false): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => visit(v, `${where}/${i}`)); return; }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (names) { visit(v, `${where}/${k}`); continue; }
      if (k === 'example' || k === 'value' || k.startsWith('x-')) continue;
      if ((k === 'summary' || k === 'description') && typeof v === 'string' && v.trim()) {
        checked.push(`${where}/${k}`);
        const ko = o[`x-ko-${k}`];
        if (typeof ko !== 'string' || !/[가-힣]/.test(ko)) { missing.push(`${where}/${k}`); continue; }
        if (JSON.stringify(spans(v)) !== JSON.stringify(spans(ko))) drifted.push(`${where}/${k}`);
        if (/지문/.test(ko)) drifted.push(`${where}/${k} (says 지문; the word is 해시)`);
      } else visit(v, `${where}/${k}`, k === 'properties' || k === 'headers');
    }
  };
  visit(SPEC, '');
  for (const [i, tag] of ((SPEC as unknown as { tags?: Record<string, unknown>[] }).tags ?? []).entries()) {
    if (typeof tag['x-ko-name'] !== 'string') missing.push(`/tags/${i}/name`);
  }
  assert.deepEqual(missing, [], 'prose without a Korean reading — add x-ko-* beside it');
  assert.deepEqual(drifted, [], 'a Korean reading lost or changed a code span the English carries');
  // The three the old skip hid must stay within reach.
  for (const p of [
    '/components/schemas/Signature/properties/value/description',
    '/paths//v1/settlements/bundle/post/responses/200/headers/x-evidence-sha256/description',
    '/paths//v1/settlements/bundle/post/responses/200/headers/x-evidence-bundle-id/description',
  ]) {
    assert.ok(checked.includes(p), `the Korean guard no longer reaches ${p}`);
  }
});

/**
 * The remit rail is integrated by banks whose systems are not TypeScript, so
 * the reference has to carry everything a request is built from: a schema and
 * a worked example for each body a bank sends, and the header the server
 * insists on. All of it was missing once, and the only way to build a
 * settlement request was to read the SDK.
 */
type Media = { schema?: { $ref?: string }; examples?: Record<string, { value?: unknown }> };
type NamedSchema = { properties?: Record<string, unknown>; required?: string[] };
const schemaOf = (ref: string | undefined): NamedSchema | undefined =>
  ref ? SPEC.components.schemas[ref.split('/').pop()!] as NamedSchema | undefined : undefined;

test('every body a bank sends on the remit rail has a schema and a worked example', () => {
  const writes = [
    ['/v1/console/products', 'post'], ['/v1/quotes', 'post'], ['/v1/settlements', 'post'],
    ['/v1/settlements/{id}/cancel', 'post'], ['/v1/settlements/{id}/rfi-response', 'post'],
    ['/v1/manifests/daily', 'post'],
  ] as const;
  for (const [p, m] of writes) {
    const where = `${m.toUpperCase()} ${p}`;
    const body = SPEC.paths[p]?.[m]?.requestBody as { required?: boolean; content?: Record<string, Media> } | undefined;
    const json = body?.content?.['application/json'];
    const schema = schemaOf(json?.schema?.$ref);
    assert.ok(schema && schema.properties, `${where} documents no request body schema`);
    assert.equal(body?.required, true, `${where}: the server needs the body`);
    const examples = Object.entries(json?.examples ?? {});
    assert.ok(examples.length > 0, `${where} has no example a bank could copy`);
    for (const [name, ex] of examples) {
      const value = ex.value as Record<string, unknown> | undefined;
      assert.ok(value && typeof value === 'object', `${where}: example ${name} is empty`);
      // An example that drifts from its schema teaches the wrong field name.
      for (const r of schema.required ?? []) assert.ok(r in value, `${where}: example ${name} lacks required ${r}`);
      for (const k of Object.keys(value)) assert.ok(k in schema.properties, `${where}: example ${name} sends undocumented ${k}`);
    }
  }
  // The two Travel Rule modes are two different requests; both are shown.
  const settle = (SPEC.paths['/v1/settlements']?.post?.requestBody as { content?: Record<string, Media> } | undefined)
    ?.content?.['application/json'];
  const modes = Object.values(settle?.examples ?? {})
    .map((e) => (e.value as { compliance_payload?: { mode?: string } }).compliance_payload?.mode);
  assert.deepEqual([...new Set(modes)].sort(), ['A', 'B'], 'POST /v1/settlements needs a mode A and a mode B example');
});

test('POST /v1/settlements documents the Idempotency-Key the server requires', () => {
  const code = readFileSync(path.resolve(HERE, '../../core/src/remit/routes.ts'), 'utf8');
  const min = /headers\['idempotency-key'\][\s\S]{0,200}?\.length < (\d+)/.exec(code);
  assert.ok(min, 'the Idempotency-Key check was not found in remit/routes.ts — fix this scan before trusting the test');
  const op = SPEC.paths['/v1/settlements']?.post as
    { parameters?: { name?: string; in?: string; required?: boolean; schema?: { minLength?: number } }[] } | undefined;
  const header = op?.parameters?.find((x) => x.in === 'header' && x.name?.toLowerCase() === 'idempotency-key');
  assert.ok(header, 'the Idempotency-Key header is not a documented parameter of POST /v1/settlements');
  assert.equal(header.required, true, 'the server refuses a settlement without the key');
  assert.equal(header.schema?.minLength, Number(min[1]), 'the documented minimum length is not the server\'s');
});

/**
 * A webhook consumer branches on `type` and looks the event up by `sequence`,
 * so both vocabularies are read out of the orchestrator rather than typed in:
 * a notification or an event the platform starts sending fails this until the
 * reference names it.
 */
test('the webhook and event vocabularies are the ones the orchestrator uses', () => {
  const code = readFileSync(path.resolve(HERE, '../../core/src/remit/orchestrator.ts'), 'utf8');
  const notified = new Set([...code.matchAll(/\bnotify\(\s*[\w.]+\s*,\s*[\w.]+\s*,\s*'([A-Z_]+)'/g)].map((m) => m[1]!));
  assert.ok(notified.size >= 10, `found ${notified.size} notify(…) calls in orchestrator.ts — the scan broke, not the spec`);
  const schemas = SPEC.components.schemas as Record<string, { properties?: Record<string, { enum?: string[]; description?: string }> }>;
  assert.deepEqual([...(schemas['WebhookEnvelope']?.properties?.['type']?.enum ?? [])].sort(), [...notified].sort(),
    'WebhookEnvelope.type must list exactly the notification types the platform sends');

  const recorded = new Set([
    ...[...code.matchAll(/\b(?:platformEvent|appendEvent)\(\s*[\w.]+\s*,\s*'([A-Z_]+)'/g)].map((m) => m[1]!),
    ...[...code.matchAll(/\bcase '([A-Z_]+)':/g)].map((m) => m[1]!),
  ]);
  assert.ok(recorded.size >= 15, `found ${recorded.size} event types in orchestrator.ts — the scan broke, not the spec`);
  const listed = schemas['SettlementEvent']?.properties?.['type']?.description ?? '';
  assert.deepEqual([...recorded].filter((t) => !listed.includes(`\`${t}\``)), [],
    'SettlementEvent.type does not name every event the platform records');

  const hooks = (SPEC as unknown as { webhooks?: Record<string, Record<string, Operation>> }).webhooks ?? {};
  const delivered = Object.values(hooks).flatMap((item) => Object.values(item))
    .map((op) => (op.requestBody?.content?.['application/json'] as { schema?: { $ref?: string } } | undefined)?.schema?.$ref);
  assert.ok(delivered.includes('#/components/schemas/WebhookDelivery'),
    'the webhook delivery must be documented under `webhooks`');
  const { html } = renderReference(SPEC as unknown as RenderedSpec, { lang: 'en' });
  const start = html.indexOf('id="tag-cross-border-settlement"');
  const end = html.indexOf('<section class="tag">', start);
  assert.ok(start > -1 && html.slice(start, end > -1 ? end : undefined).includes('id="op-post-webhook-settlement-event"'),
    'the notification must render in the settlements section, where its reader looks for it');
});

test('the settlement search documents every reference it matches', () => {
  const store = readFileSync(path.resolve(HERE, '../../core/src/remit/store.ts'), 'utf8');
  const search = /async search\([\s\S]*?\n {2}\}\n/.exec(store)?.[0] ?? '';
  const searched = new Set([
    ...[...search.matchAll(/'\$\.([\w.]+)'/g)].map((m) => m[1]!.split('.').pop()!),
    ...[...search.matchAll(/UPPER\((?:COALESCE\()?([a-z_]+)\b/g)].map((m) => m[1]!).filter((c) => c !== 'id'),
  ]);
  assert.ok(searched.size >= 5, `found ${searched.size} searched fields in store.ts — the scan broke, not the spec`);
  const op = SPEC.paths['/v1/settlements']?.get as { parameters?: { name?: string; description?: string }[] } | undefined;
  const q = op?.parameters?.find((x) => x.name === 'q')?.description ?? '';
  assert.deepEqual([...searched].filter((f) => !q.includes(f)), [],
    'GET /v1/settlements `q` matches fields its description does not name');
});

/**
 * The guides tell a reader to copy the Base URL the reference shows. It used
 * to show the loopback address, which is right on the box and wrong for
 * everyone reading the hub at the public one.
 */
test('the Base URL is the deployment the reader is on, never a loopback address', () => {
  const servers = (SPEC as unknown as { servers?: { url: string }[] }).servers ?? [];
  assert.ok(servers.length > 0, 'the reference must say where the API answers');
  for (const s of servers) {
    assert.doesNotMatch(s.url, /127\.0\.0\.1|localhost|\[::1\]/, `servers names ${s.url}, which is right on one machine only`);
  }
  for (const lang of ['en', 'ko'] as const) {
    const { html } = renderReference(SPEC as unknown as RenderedSpec, { lang, origin: 'https://sandbox.bank.example' });
    const meta = html.slice(0, html.indexOf('<div class="callout">'));
    assert.match(meta, /Base URL: <code>https:\/\/sandbox\.bank\.example<\/code>/,
      `${lang}: the Base URL is not the origin the page was served from`);
    assert.doesNotMatch(meta, /127\.0\.0\.1|localhost/, `${lang}: a loopback address reached the Base URL`);
  }
});

test('the reference points no reader at our source files', () => {
  // The intro once named the server file behind every path: internal
  // vocabulary to a customer, and a path that moves whenever the code does.
  assert.doesNotMatch(JSON.stringify(SPEC), /\b(?:apps|packages)\/[\w-]+\/src\//, 'a source path appears in openapi.json');
});
