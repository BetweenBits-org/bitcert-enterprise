/**
 * Renders `openapi.json` into the reference page.
 *
 * ## Why not Scalar or Redoc
 *
 * Both are good, and both are loaded from a CDN. This hub ships under
 * `default-src 'none'; script-src 'self'` — the same policy as the Playground,
 * and for the same reason: a tool whose claim is "check this yourself" cannot
 * ask the reader to execute code from a third party while they do it. A CDN
 * script would simply be blocked, and vendoring one would put a build step and
 * a dependency tree in front of the API reference.
 *
 * The spec is thirteen operations. This renders them.
 *
 * ## What it deliberately does not do
 *
 * No "try it" console. A request button on a documentation page sends the
 * reader's key to whatever host the page was configured with, and encourages
 * pasting a live key into a browser tab. The Playground is the place to
 * exercise the API, and it holds no keys.
 *
 * ## Korean
 *
 * The prose has a Korean reading beside the English in the same file —
 * `x-ko-summary`, `x-ko-description`, `x-ko-name` next to the field they
 * translate — while paths, fields, codes and examples exist once. One contract,
 * two readings of its prose: `openapi.test.ts` fails the build when a Korean
 * reading is missing or has lost a code span the English carries, which is
 * what keeps the two from drifting into two contracts. The language is passed
 * in rather than read from the page, so this module stays free of the DOM.
 * The one thing it will take from a page, when the caller passes no `origin`,
 * is the page's own address — see `serverUrl`.
 */
export type RefLang = 'ko' | 'en';

const LABELS = {
  en: {
    field: 'Field', type: 'Type', required: 'required', default: 'default', responses: 'Responses',
    code: 'Code', body: 'Body', parameters: 'Parameters', requestBody: 'Request body', optional: '(optional)',
    baseUrl: 'Base URL', overview: 'Overview', schemas: 'Schemas', other: 'Other', example: 'Example',
    open: 'no key', keyed: 'Bearer key', session: 'console session', hook: 'webhook · platform-signed',
  },
  ko: {
    field: '필드', type: '타입', required: '필수', default: '기본값', responses: '응답',
    code: '코드', body: '본문', parameters: '파라미터', requestBody: '요청 본문', optional: '(선택)',
    // "Base URL" as the guides name it: they tell the reader to copy the value
    // shown under that label, and a translated label left them looking for it.
    baseUrl: 'Base URL', overview: '개요', schemas: '스키마', other: '기타', example: '예시',
    open: '키 없음', keyed: 'Bearer 키', session: '콘솔 세션', hook: '웹훅 · 플랫폼 서명',
  },
} as const;

/** The rendering's language, set once per `renderReference` call. */
let L: (typeof LABELS)[RefLang] = LABELS.en;
let KO = false;

/** A prose field in the page's language: its Korean reading when there is one. */
function tx(node: object | undefined, field: 'summary' | 'description' | 'name'): string | undefined {
  if (!node) return undefined;
  const o = node as Record<string, unknown>;
  const ko = o[`x-ko-${field}`];
  if (KO && typeof ko === 'string' && ko.trim()) return ko;
  const en = o[field];
  return typeof en === 'string' ? en : undefined;
}

/** Only the parts of OpenAPI this spec uses. */
export interface Spec {
  info: { title: string; version: string; summary?: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths: Record<string, PathItem>;
  /** OpenAPI 3.1: requests the platform makes to the customer, such as a settlement notification. */
  webhooks?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Schema>;
    parameters?: Record<string, Parameter>;
    responses?: Record<string, Response>;
    securitySchemes?: Record<string, { description?: string }>;
  };
}
type PathItem = Record<string, Operation | Parameter[] | undefined>;
export interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, Response>;
  security?: unknown[];
}
interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}
interface Response {
  $ref?: string;
  description?: string;
  headers?: Record<string, { description?: string; schema?: Schema }>;
  content?: Record<string, MediaType>;
}
interface MediaType { schema?: Schema; examples?: Record<string, { summary?: string; value?: unknown }> }
interface Schema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  default?: unknown;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
  examples?: unknown[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head'] as const;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Inline markup inside spec prose: `code`, **bold**, and links.
 *
 * The descriptions in `openapi.json` are written in Markdown because they are
 * long enough to need paragraphs. Reusing the document renderer here would
 * couple the reference to it for the sake of three constructs.
 */
function prose(src: string): string {
  return src.split(/\n\n+/).map((p) => `<p>${inline(p)}</p>`).join('');
}

/**
 * The same markup without paragraphs, for a table cell or a lede. A field's
 * description names fields and codes as `code spans` too — the Korean guard
 * holds them to that — and printing the backticks left them unmarked.
 */
function inline(src: string): string {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\n/g, ' ');
}

/** `#/components/schemas/Meta` → the node it names. */
function deref<T>(spec: Spec, node: T & { $ref?: string }): T {
  if (!node?.$ref) return node;
  let cur: unknown = spec;
  for (const seg of node.$ref.slice(2).split('/')) {
    cur = (cur as Record<string, unknown> | undefined)?.[seg];
  }
  return (cur ?? node) as T;
}

/** The short name of a `$ref`, for labelling without expanding. */
function refName(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = /([^/]+)$/.exec(ref);
  return m ? m[1]! : null;
}

/** One line describing a schema's type, as an engineer would read it. */
function typeOf(spec: Spec, schema: Schema | undefined): string {
  if (!schema) return '';
  const named = refName(schema.$ref);
  if (named) return named;
  const s = deref(spec, schema);
  if (s.const !== undefined) return `<code>${esc(JSON.stringify(s.const))}</code>`;
  if (s.enum) return s.enum.map((e) => `<code>${esc(JSON.stringify(e))}</code>`).join(' · ');
  if (s.allOf) return s.allOf.map((a) => typeOf(spec, a)).filter(Boolean).join(' + ');
  // One of several shapes — the Travel Rule payload's two modes, a signature or null.
  if (s.oneOf) return s.oneOf.map((a) => typeOf(spec, a)).filter(Boolean).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? 'object';
  if (t === 'array' && s.items) return `${typeOf(spec, s.items)}[]`;
  return s.format ? `${t} <span class="dim">(${esc(s.format)})</span>` : t;
}

/**
 * A schema's fields as a table, one level deep.
 *
 * Deliberately not recursive. A fully expanded tree of every nested object
 * produces a page nobody reads; a named reference the reader can look up in the
 * Schemas section is more useful, and it is how the spec is structured.
 */
function fields(spec: Spec, schema: Schema | undefined): string {
  if (!schema) return '';
  let s = deref(spec, schema);
  if (s.allOf) {
    // Merge the branches, since `allOf` here means "the base plus these".
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const branch of s.allOf) {
      const b = deref(spec, branch);
      Object.assign(merged.properties!, b.properties ?? {});
      merged.required!.push(...(b.required ?? []));
    }
    s = merged;
  }
  if (!s.properties) return '';
  const required = new Set(s.required ?? []);
  const rows = Object.entries(s.properties).map(([name, propRaw]) => {
    const prop = propRaw.$ref ? propRaw : deref(spec, propRaw);
    const note = [
      tx(prop, 'description') ? inline(tx(prop, 'description')!) : '',
      prop.pattern ? `<code>${esc(prop.pattern)}</code>` : '',
      prop.default !== undefined ? `${L.default} <code>${esc(JSON.stringify(prop.default))}</code>` : '',
    ].filter(Boolean).join(' ');
    return `<tr>
      <td><code>${esc(name)}</code>${required.has(name) ? `<span class="req">${L.required}</span>` : ''}</td>
      <td class="ty">${typeOf(spec, propRaw)}</td>
      <td>${note}</td>
    </tr>`;
  });
  return `<div class="tablewrap"><table class="fields">
    <thead><tr><th>${L.field}</th><th>${L.type}</th><th></th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function examples(media: MediaType | undefined): string {
  if (!media?.examples) return '';
  return Object.entries(media.examples).map(([key, ex]) => `
    <div class="example">
      <div class="exhead">${esc(tx(ex, 'summary') ?? key)}</div>
      <pre class="code"><code>${esc(JSON.stringify(ex.value, null, 2))}</code></pre>
    </div>`).join('');
}

function responses(spec: Spec, op: Operation): string {
  const entries = Object.entries(op.responses ?? {});
  if (entries.length === 0) return '';
  const rows = entries.map(([code, raw]) => {
    const r = deref(spec, raw);
    const cls = code.startsWith('2') ? 'ok' : code.startsWith('4') ? 'warn' : 'bad';
    const media = r.content ? Object.entries(r.content)[0] : undefined;
    const bodyType = media ? typeOf(spec, media[1].schema) : '—';
    const hdrs = r.headers
      ? Object.entries(r.headers).map(([h, v]) =>
        `<div class="hdr"><code>${esc(h)}</code> ${prose(tx(v, 'description') ?? '')}</div>`).join('')
      : '';
    return `<tr>
      <td><span class="status ${cls}">${esc(code)}</span></td>
      <td class="ty">${media ? `<span class="dim">${esc(media[0])}</span> ${bodyType}` : bodyType}</td>
      <td>${prose(tx(r, 'description') ?? '')}${hdrs}</td>
    </tr>`;
  });
  return `<h4>${L.responses}</h4><div class="tablewrap"><table class="resp">
    <thead><tr><th>${L.code}</th><th>${L.body}</th><th></th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function parameters(spec: Spec, op: Operation, shared: Parameter[]): string {
  const all = [...shared, ...(op.parameters ?? [])].map((p) => deref(spec, p));
  if (all.length === 0) return '';
  const rows = all.map((p) => `<tr>
    <td><code>${esc(p.name ?? '')}</code>${p.required ? `<span class="req">${L.required}</span>` : ''}</td>
    <td class="ty"><span class="dim">${esc(p.in ?? '')}</span> ${typeOf(spec, p.schema)}</td>
    <td>${prose(tx(p, 'description') ?? '')}</td>
  </tr>`);
  return `<h4>${L.parameters}</h4><div class="tablewrap"><table class="fields">
    <tbody>${rows.join('')}</tbody></table></div>`;
}

/** `GET /v1/attestations/{id}` → a stable element id for deep linking. */
export function operationId(method: string, path: string): string {
  return `op-${method.toLowerCase()}-${path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function operation(spec: Spec, method: string, path: string, op: Operation, shared: Parameter[], hook = false): string {
  // `security: []` on an operation clears the document-level requirement; a
  // `sessionCookie` entry names the console's own credential. The distinction
  // is the free tier's whole point, so it is stated on every operation rather
  // than left for the reader to infer from its absence — and a cookie route
  // must not be badged as if it took a key, or as if it took nothing.
  // A webhook runs the other way: the platform calls the customer, no key is
  // involved, and what authenticates the request is the signature in its body.
  const sec = op.security as { [scheme: string]: unknown }[] | undefined;
  const auth = hook ? 'hook'
    : sec === undefined ? 'keyed'
      : sec.length === 0 ? 'open'
        : sec.some((s) => 'sessionCookie' in s) ? 'session' : 'keyed';
  const AUTH_LABEL = { open: L.open, keyed: L.keyed, session: L.session, hook: L.hook } as const;
  const body = op.requestBody?.content?.['application/json'];

  // A webhook goes to the URL the customer registered, so the bar names that
  // field rather than the webhook's key, which is not an address.
  return `<article class="op" id="${operationId(method, hook ? `webhook-${path}` : path)}">
    <div class="opbar">
      <span class="verb ${method}">${method.toUpperCase()}</span>
      <code class="oppath">${esc(hook ? '{webhook_url}' : path)}</code>
      <span class="auth ${auth === 'hook' ? 'keyed hook' : auth}">${AUTH_LABEL[auth]}</span>
    </div>
    <h3>${esc(tx(op, 'summary') ?? path)}</h3>
    ${prose(tx(op, 'description') ?? '')}
    ${parameters(spec, op, shared)}
    ${body ? `<h4>${L.requestBody}${op.requestBody?.required ? '' : ` <span class="dim">${L.optional}</span>`}</h4>
      ${fields(spec, body.schema)}${examples(body)}` : ''}
    ${responses(spec, op)}
    ${Object.values(op.responses ?? {}).map((r) => {
      const d = deref(spec, r);
      const media = d.content?.['application/json'];
      return media?.examples ? examples(media) : '';
    }).join('')}
  </article>`;
}

/**
 * Where the API answers, as the reader should type it.
 *
 * `servers` holds a relative URL — OpenAPI's way of saying "the deployment
 * serving this document" — because an absolute one is right on one machine
 * only: the loopback address the file used to name was shown to every reader
 * on the public address, and the guides tell them to copy the Base URL. A
 * relative URL is resolved against the origin the caller passes, or the page's
 * own; with neither (a test, a build script) it is shown as written.
 */
function serverUrl(url: string, origin: string | undefined): string {
  if (!origin || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;
  return new URL(url, origin).href.replace(/\/$/, '');
}

/** `http(s)://host[:port]` of the page this runs in, if it runs in one. */
function pageOrigin(): string | undefined {
  const o = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof o === 'string' && /^https?:\/\//.test(o) ? o : undefined;
}

/** The whole reference, grouped by tag in the order the spec declares them. */
export function renderReference(spec: Spec, opts: { lang?: RefLang; origin?: string } = {}): { html: string; nav: { id: string; label: string }[] } {
  KO = opts.lang === 'ko';
  L = LABELS[KO ? 'ko' : 'en'];
  const origin = opts.origin ?? pageOrigin();
  const nav: { id: string; label: string }[] = [];
  const out: string[] = [];

  out.push(`<div class="specmeta">
    <h2 id="api-overview">${esc(spec.info.title)} <span class="dim">v${esc(spec.info.version)}</span></h2>
    ${tx(spec.info, 'summary') ? `<p class="lede">${esc(tx(spec.info, 'summary')!)}</p>` : ''}
    ${prose(tx(spec.info, 'description') ?? '')}
    ${spec.servers?.length
      ? `<p class="dim">${L.baseUrl}: ${spec.servers.map((s) =>
        `<code>${esc(serverUrl(s.url, origin))}</code>${tx(s, 'description') ? ` — ${esc(tx(s, 'description')!)}` : ''}`).join(', ')}</p>`
      : ''}
    ${tx(spec.components?.securitySchemes?.['bearerKey'], 'description')
      ? `<div class="callout">${prose(tx(spec.components!.securitySchemes!['bearerKey'], 'description')!)}</div>` : ''}
  </div>`);
  nav.push({ id: 'api-overview', label: L.overview });

  // Every operation, bucketed by its first tag.
  const byTag = new Map<string, string[]>();
  for (const [path, item] of Object.entries(spec.paths)) {
    const shared = (item['parameters'] as Parameter[] | undefined) ?? [];
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const tag = op.tags?.[0] ?? L.other;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(operation(spec, method, path, op, shared));
    }
  }
  // Then the webhooks, in their tag's section after the operations that cause
  // them: a reader of the settlements section looks for the notification there.
  for (const [name, item] of Object.entries(spec.webhooks ?? {})) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const tag = op.tags?.[0] ?? L.other;
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(operation(spec, method, name, op, [], true));
    }
  }

  const order = [...(spec.tags ?? []).map((t) => t.name), ...byTag.keys()];
  const emitted = new Set<string>();
  for (const name of order) {
    if (emitted.has(name) || !byTag.has(name)) continue;
    emitted.add(name);
    const tag = spec.tags?.find((t) => t.name === name);
    const id = `tag-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    // The id stays the English name's, so a deep link works in either language.
    const shown = tx(tag, 'name') ?? name;
    nav.push({ id, label: shown });
    out.push(`<section class="tag">
      <h2 id="${id}">${esc(shown)}</h2>
      ${tx(tag, 'description') ? `<p class="lede">${inline(tx(tag, 'description')!)}</p>` : ''}
      ${byTag.get(name)!.join('')}
    </section>`);
  }

  // The named schemas, once, at the end — what the operation tables refer to.
  const schemas = Object.entries(spec.components?.schemas ?? {});
  if (schemas.length > 0) {
    nav.push({ id: 'schemas', label: L.schemas });
    out.push(`<section class="tag">
      <h2 id="schemas">${L.schemas}</h2>
      ${schemas.map(([name, s]) => `<article class="op">
        <h3 id="schema-${esc(name)}"><code>${esc(name)}</code></h3>
        ${prose(tx(s, 'description') ?? '')}
        ${s.enum ? `<p class="ty">${typeOf(spec, s)}</p>` : ''}
        ${fields(spec, s)}
        ${(s.examples ?? []).map((ex) => `<div class="example">
          <div class="exhead">${L.example}</div>
          <pre class="code"><code>${esc(JSON.stringify(ex, null, 2))}</code></pre>
        </div>`).join('')}
      </article>`).join('')}
    </section>`);
  }

  return { html: out.join('\n'), nav };
}
