/**
 * The same requests to two servers — the service being replaced (the
 * reference, TypeScript) and this one (Java) — and every answer compared.
 *
 *   node apps/core-java/parity/run.mjs --ref http://127.0.0.1:8791 --java http://127.0.0.1:8790 [--only text] [--file name] [--show]
 *
 * `--only` narrows the run to the cases whose name contains the text (and
 * the cases before them that set a variable up). `--file` runs one file of
 * cases and nothing else — which is how the cases for a deployment set up
 * differently (cases/console-off.mjs) are run, against two servers started
 * that way. Neither checks the list of known differences for stale entries.
 *
 * "The same answer" means: the status; the headers a client acts on
 * (content type, redirects, caching, cookies, CORS, retry-after, content
 * disposition, the security headers of a screen); and the body — as parsed
 * JSON where both say JSON (a field that is absent and a field that is null
 * are different; a number and text are different), byte for byte otherwise.
 * Values that differ on every request (ids, times, signatures) are named by
 * the case as `volatile` and compared by kind only; a sentence that quotes
 * such a value is compared with it taken out (`blur`: [pattern, replacement]);
 * a header named in `volatileHeaders` is compared with its digits taken out.
 * A case with `noAnswer: true` expects the connection to be cut without an
 * answer (status 0 on both sides); any answer at all is then a difference.
 *
 * The cases are scenarios: they run in order (files by name, cases as
 * listed), and each server has its own variables. A case may `capture`
 * values out of each server's own answer —
 *
 *     { name: 'mint a key', method: 'POST', target: '/v1/sandbox/keys', capture: { key: '$.api_key', org: '$.org.id' } }
 *
 * — and later cases use them as `{key}` in the target, in header values and
 * anywhere in the body; each server is sent its own value. (A `{word}` that
 * is no variable is left as it is.) A capture may be a whole object
 * (`$.evidence`, or `$` for the body itself); a body member that is exactly
 * `'{key}'` then becomes that object. A case with `swap: true` is sent the
 * OTHER server's values instead — a package one service sealed, verified by
 * the other. A body can also be a function of the server's variables
 * (`body: (vars) => ({ openings: vars.indices.map(open) })`), for an answer
 * that has to be worked out from what that server asked. Two services that are wrong the same way answer the same, so
 * such a case also says what the answer has to be, on both sides:
 * `expect: { '$.digestOk': true }`. Besides a place in the JSON body, a
 * capture can name a response header (`header:location`) or a cookie the
 * server set (`cookie:stonehash_session`: its value) — which is how a case
 * signs in on each server and goes on as that session:
 *
 *     { name: 'sign in', method: 'POST', target: '/v1/console/login', body: {…}, capture: { s: 'cookie:stonehash_session' } },
 *     { name: 'who am I', target: '/v1/console/me', headers: { Cookie: 'stonehash_session={s}' } }
 *
 * A cookie is compared whole — its name, every attribute, their order — but
 * for the two parts that are new on every request: the value (compared as
 * empty or not, by length and by alphabet) and the date of `Expires` (an
 * HTTP date on both sides, the two no more than ten seconds apart).
 *
 * An archive (`application/zip`) is compared as what it holds: the members
 * in order, each unpacked and compared byte for byte, and every field of the
 * ZIP around them — names, times, CRCs, sizes, methods, attributes. The two
 * services pack with different DEFLATE implementations, so the packed bytes
 * of a member (and with them the archive's own digest in `x-evidence-sha256`)
 * differ where nothing else does; that is reported as one difference,
 * `archive: packed bytes`, and each service's `x-evidence-sha256` has to be
 * the digest of what that service sent. An archive made with an id and a
 * time of the service's own choosing is a different archive each time: a
 * case names it `looseArchive: true`, and it is compared as what kind of
 * thing it is — a sound archive with the same members by name — with the id
 * taken out of the headers (`blurHeaders`: [pattern, replacement]).
 *
 * A list the service gives in no particular order (the SQL has no ORDER BY)
 * is named by the case as `unordered: { '$.issuer_keys': 'label' }` and is
 * compared sorted by that field. Values seeded into both schemas
 * (parity/seed.json, written by tools/seed-reference.mjs) are the same for
 * both servers, and a case file gets them as `seed`.
 *
 * A difference is either a defect or it is written down: `expected.json`
 * lists the differences that are known, each with its reason — what is not
 * ported yet, and what is different on purpose
 * (docs/JAVA-INTENDED-DIFFERENCES.md). Exit status 1 when a difference is
 * not on that list, or when an entry of the list no longer occurs. An entry
 * can be narrower than a case and a path: `pathMatches` (a pattern, for a
 * field of whichever row of a list), `ofSeed` (the difference is in the
 * object whose `id` is one of these seeded ids, e.g. `ids.inscription.confirmed`),
 * `ref` / `java` (the two values, exactly).
 *
 * For the settlement rail (cases/remit-*.mjs; parity/README.md, "송금 레일의 경우"):
 * each server has a partner stand-in of its own (tools/stand-in-partner.mjs),
 * `--partner-ref` / `--partner-java` (defaults :3302 / :3301, as
 * tools/run-parity.sh starts them). A case with `to: 'partner'` is sent to
 * each server's stand-in instead of the server — its control API: a plan for
 * a payment, a callback to send, a held request to release — and the two
 * answers are compared like any others. A case with
 * `settle: { target, until, idle, timeout }` starts work that goes on behind
 * the answer: before the next case, each server's own settlement (`GET
 * target`) is asked until it shows what `until` says — `{ state, last }`, the
 * state and the type of its last event, or a function of the view — and, with
 * `idle` (a payment id), until that server's stand-in has no callbacks under
 * way for it. A server that does not get there within `timeout` ms (10 s) fails
 * the case. `--seed <file>` names another seed file than parity/seed.json,
 * `--ref-env` / `--java-env` the two servers' settings files (handed to the
 * case files as `settings`, for the one value cases read from them: the
 * operator's token), `--cases <dir>` another folder of case files, and
 * `--file` may end in `*` (every file whose name starts so).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { exchange } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const REF = arg('--ref') ?? 'http://127.0.0.1:8791';
const JAVA = arg('--java') ?? 'http://127.0.0.1:8790';
const only = arg('--only');
const onlyFile = arg('--file');
const show = process.argv.includes('--show');
/** Each server's partner stand-in (the settlement rail): where a case with `to: 'partner'` goes, and where `settle` asks whether callbacks are under way. */
const PARTNER = { ref: arg('--partner-ref') ?? 'http://127.0.0.1:3302', java: arg('--partner-java') ?? 'http://127.0.0.1:3301' };
/** The two servers' settings files, for the case files that read a setting (never printed). */
const SETTINGS = { ref: path.resolve(arg('--ref-env') ?? path.join(HERE, '../.env.ref')), java: path.resolve(arg('--java-env') ?? path.join(HERE, '../.env.parity')) };
const CASES = path.resolve(HERE, arg('--cases') ?? 'cases');
/** `--file name` is that file; `--file prefix*` every file whose name starts so. */
const fileWanted = (f) => !onlyFile || (onlyFile.endsWith('*') ? f.startsWith(onlyFile.slice(0, -1)) : f === `${onlyFile}.mjs`);

const HEADERS = ['content-type', 'location', 'cache-control', 'retry-after', 'content-disposition', 'content-security-policy',
  'x-content-type-options', 'referrer-policy', 'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-max-age', 'access-control-allow-credentials', 'vary', 'www-authenticate', 'allow', 'x-evidence-bundle-id'];

/** A ZIP as what it holds: every member unpacked, with the fields of its two headers. `null` when the bytes are not an archive this reads. */
function readZip(buf) {
  try {
    const end = buf.length - 22;
    if (end < 0 || buf.readUInt32LE(end) !== 0x06054b50) return null;
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const members = [];
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) return null;
      const nameLength = buf.readUInt16LE(at + 28);
      const m = {
        madeBy: buf.readUInt16LE(at + 4), needed: buf.readUInt16LE(at + 6), flags: buf.readUInt16LE(at + 8), method: buf.readUInt16LE(at + 10),
        time: buf.readUInt16LE(at + 12), date: buf.readUInt16LE(at + 14), crc: buf.readUInt32LE(at + 16), packed: buf.readUInt32LE(at + 20), size: buf.readUInt32LE(at + 24),
        extra: buf.readUInt16LE(at + 30), comment: buf.readUInt16LE(at + 32), internal: buf.readUInt16LE(at + 36), external: buf.readUInt32LE(at + 38), offset: buf.readUInt32LE(at + 42),
        name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      };
      // The local header says the same as the directory, and the data follows it.
      const local = m.offset;
      if (buf.readUInt32LE(local) !== 0x04034b50) return null;
      m.localAgrees = buf.readUInt16LE(local + 4) === m.needed && buf.readUInt16LE(local + 6) === m.flags && buf.readUInt16LE(local + 8) === m.method && buf.readUInt16LE(local + 10) === m.time
        && buf.readUInt16LE(local + 12) === m.date && buf.readUInt32LE(local + 14) === m.crc && buf.readUInt32LE(local + 18) === m.packed && buf.readUInt32LE(local + 22) === m.size
        && buf.subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26)).toString('utf8') === m.name && buf.readUInt16LE(local + 28) === 0;
      const data = buf.subarray(local + 30 + nameLength, local + 30 + nameLength + m.packed);
      m.data = data;
      m.bytes = m.method === 8 ? inflateRawSync(data) : Buffer.from(data);
      m.unpacks = m.bytes.length === m.size;
      members.push(m);
      at += 46 + nameLength + m.extra + m.comment;
    }
    return members;
  } catch { return null; }
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Two archives compared as what they hold. Returns false when either is not an archive, and the bytes are compared instead. */
function compareArchives(ref, java, out, loose) {
  const a = readZip(ref.body); const b = readZip(java.body);
  if (!a || !b) return false;
  for (const [who, r, members] of [['reference', ref, a], ['java', java, b]]) {
    const said = (r.headers['x-evidence-sha256'] ?? [''])[0];
    if (said !== sha256(r.body)) out.push({ path: `archive: x-evidence-sha256 of the ${who} is the digest of what it sent`, ref: who === 'reference' ? said : '-', java: who === 'java' ? said : '-' });
    for (const m of members) if (!m.localAgrees || !m.unpacks) out.push({ path: `archive: ${m.name} reads back out of the ${who}'s archive`, ref: who === 'reference' ? 'no' : '-', java: who === 'java' ? 'no' : '-' });
  }
  if (a.length !== b.length || a.some((m, i) => m.name !== b[i].name)) { out.push({ path: 'archive: members', ref: a.map((m) => m.name).join(', '), java: b.map((m) => m.name).join(', ') }); return true; }
  if (loose) return true;
  let packedDifferently = 0;
  for (const [i, m] of a.entries()) {
    const n = b[i];
    if (!m.bytes.equals(n.bytes)) out.push({ path: `archive: ${m.name}`, ref: `${m.bytes.length} bytes, sha256 ${sha256(m.bytes)}`, java: `${n.bytes.length} bytes, sha256 ${sha256(n.bytes)}` });
    for (const field of ['madeBy', 'flags', 'time', 'date', 'crc', 'size', 'extra', 'comment', 'internal', 'external']) {
      if (m[field] !== n[field]) out.push({ path: `archive: ${m.name} ${field}`, ref: m[field], java: n[field] });
    }
    // Whether a member is packed, and what it packs to, is the DEFLATE implementation's; one that would not get smaller is stored by both.
    if (m.method !== n.method || m.needed !== n.needed || !m.data.equals(n.data)) packedDifferently++;
    if (![0, 8].includes(m.method) || ![0, 8].includes(n.method)) out.push({ path: `archive: ${m.name} method`, ref: m.method, java: n.method });
  }
  if (packedDifferently > 0) out.push({ path: 'archive: packed bytes', ref: `${ref.body.length} bytes`, java: `${java.body.length} bytes` });
  else if (!ref.body.equals(java.body)) out.push({ path: 'archive: bytes outside the members', ref: `${ref.body.length} bytes`, java: `${java.body.length} bytes` });
  return true;
}

/**
 * A cookie as it is compared: its name and every attribute as written, in the order written. The value is a fresh
 * secret each time, so it is reduced to what kind of value it is; the date of Expires is checked apart (expiresApart).
 */
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const valueShape = (v) => (v === '' ? '<empty>' : `<${v.length} of ${/^[A-Za-z0-9_-]+$/.test(v) ? 'base64url' : 'other characters'}>`);
const cookieShape = (c) => c.split('; ').map((p, i) => (i === 0 ? `${p.slice(0, p.indexOf('=') + 1)}${valueShape(p.slice(p.indexOf('=') + 1))}`
  : p.startsWith('Expires=') && HTTP_DATE.test(p.slice(8)) ? 'Expires=<http date>' : p)).join('; ');
const expiresOf = (c) => { const p = c.split('; ').find((x) => x.startsWith('Expires=')); return p && HTTP_DATE.test(p.slice(8)) ? Date.parse(p.slice(8)) : null; };
/** How far apart two cookies expire, in seconds, when both say when; otherwise 0. */
const expiresApart = (a, b) => (expiresOf(a) === null || expiresOf(b) === null ? 0 : Math.abs(expiresOf(a) - expiresOf(b)) / 1000);
/** The value of a cookie a response set, or undefined. */
const cookieValue = (response, name) => {
  for (const c of response.headers['set-cookie'] ?? []) { const first = c.split(';')[0]; if (first.slice(0, first.indexOf('=')).trim() === name) return first.slice(first.indexOf('=') + 1).trim(); }
  return undefined;
};

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'string'
  ? (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ? 'time' : /^[0-9a-f]{64}$/.test(v) ? 'hex64' : `text(${v.replace(/[0-9a-zA-Z_-]/g, 'x').slice(0, 12)})`) : typeof v);

/** A sentence with the parts that differ on every request taken out: `blur` is a list of [pattern, replacement]. */
const blurred = (v, blur) => (typeof v === 'string' ? blur.reduce((s, [re, to]) => s.replace(re, to), v) : v);

/** `of`: the id of the object a difference is in, where both servers give that object the same id (a seeded record). */
function differences(a, b, where, volatile, out, blur = [], of = undefined) {
  if (volatile.some((p) => (p instanceof RegExp ? p.test(where) : p === where))) {
    if (kind(a) !== kind(b)) out.push({ path: where, ref: `<${kind(a)}>`, java: `<${kind(b)}>`, of });
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length !== b.length) { out.push({ path: `${where}.length`, ref: a.length, java: b.length, of }); return; }
      a.forEach((x, i) => differences(x, b[i], `${where}[${i}]`, volatile, out, blur, of));
      return;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    const own = typeof a.id === 'string' && a.id === b.id ? a.id : of;
    for (const k of keysA) {
      if (!(k in b)) out.push({ path: `${where}.${k}`, ref: a[k], java: '<absent>', of: own });
      else differences(a[k], b[k], `${where}.${k}`, volatile, out, blur, own);
    }
    for (const k of keysB) if (!(k in a)) out.push({ path: `${where}.${k}`, ref: '<absent>', java: b[k], of: own });
    // The order of keys is part of how a response reads; it is compared where the keys are the same.
    if (keysA.length === keysB.length && keysA.every((k) => k in b) && keysA.join('\u0000') !== keysB.join('\u0000')) {
      out.push({ path: `${where}.<key order>`, ref: keysA.join(','), java: keysB.join(','), of: own });
    }
    return;
  }
  if (blurred(a, blur) !== blurred(b, blur)) out.push({ path: where, ref: a, java: b, of });
}

function compare(ref, java, c) {
  const out = [];
  if (ref.status !== java.status) out.push({ path: 'status', ref: ref.status, java: java.status });
  // A case about a cut connection: status 0 is "closed without an answer"; anything else was an answer.
  if (c.noAnswer && (ref.status !== 0 || java.status !== 0)) {
    out.push({ path: 'no answer', ref: ref.status === 0 ? 'the connection was cut' : `answered: ${ref.raw}`, java: java.status === 0 ? 'the connection was cut' : `answered: ${java.raw}` });
  }
  for (const h of HEADERS) {
    // A header a case names as volatile (the seconds left of a rate limit) is compared with its digits taken out.
    const digits = (c.volatileHeaders ?? []).includes(h) ? (v) => v.replace(/\d+/g, '<n>') : (v) => v;
    const loose = (v) => (c.blurHeaders ?? []).reduce((s, [re, to]) => s.replace(re, to), digits(v));
    const x = loose((ref.headers[h] ?? []).join(', '));
    const y = loose((java.headers[h] ?? []).join(', '));
    if (x !== y) out.push({ path: `header ${h}`, ref: x || '<absent>', java: y || '<absent>' });
  }
  const cookies = [ref, java].map((r) => (r.headers['set-cookie'] ?? []).map(cookieShape).join(' | '));
  if (cookies[0] !== cookies[1]) out.push({ path: 'header set-cookie', ref: cookies[0] || '<absent>', java: cookies[1] || '<absent>' });
  else {
    (ref.headers['set-cookie'] ?? []).forEach((c, i) => {
      const apart = expiresApart(c, java.headers['set-cookie'][i]);
      if (apart > 10) out.push({ path: 'header set-cookie Expires', ref: c.split('; ').find((x) => x.startsWith('Expires=')), java: java.headers['set-cookie'][i].split('; ').find((x) => x.startsWith('Expires=')) });
    });
  }
  const json = (r) => /^application\/json/.test((r.headers['content-type'] ?? [''])[0]);
  if (json(ref) && json(java) && c.method !== 'HEAD') {
    let a; let b;
    try { a = JSON.parse(ref.body.toString('utf8')); b = JSON.parse(java.body.toString('utf8')); } catch { a = undefined; }
    if (a === undefined) { if (!ref.body.equals(java.body)) out.push({ path: 'body', ref: ref.body.toString('utf8').slice(0, 200), java: java.body.toString('utf8').slice(0, 200) }); }
    else {
      // A list in no particular order is put in one before it is compared: by the field the case names.
      // What the case says the answer is, whoever gives it.
      for (const [where, value] of Object.entries(c.expect ?? {})) {
        if (at(a, where) !== value || at(b, where) !== value) out.push({ path: `expected ${where} = ${JSON.stringify(value)}`, ref: at(a, where), java: at(b, where) });
      }
      for (const [where, field] of Object.entries(c.unordered ?? {})) {
        for (const json of [a, b]) {
          const list = at(json, where);
          if (Array.isArray(list)) list.sort((x, y) => (String(x?.[field]) < String(y?.[field]) ? -1 : String(x?.[field]) > String(y?.[field]) ? 1 : 0));
        }
      }
      differences(a, b, '$', c.volatile ?? [], out, c.blur ?? []);
    }
  } else if (/^application\/zip/.test((ref.headers['content-type'] ?? [''])[0]) && /^application\/zip/.test((java.headers['content-type'] ?? [''])[0]) && compareArchives(ref, java, out, c.looseArchive === true)) {
    // compared as archives
  } else if (!ref.body.equals(java.body)) {
    out.push({ path: 'body', ref: `${ref.body.length} bytes: ${ref.body.toString('utf8').slice(0, 120)}`, java: `${java.body.length} bytes: ${java.body.toString('utf8').slice(0, 120)}` });
  }
  return out;
}

// ── variables: what each server answered earlier, for the requests that follow ──

const vars = { ref: {}, java: {} };
const fill = (value, store) => {
  // A member that is exactly one variable holding an object becomes that object.
  const whole = typeof value === 'string' ? /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value) : null;
  if (whole && whole[1] in store && store[whole[1]] !== null && typeof store[whole[1]] === 'object') return structuredClone(store[whole[1]]);
  if (typeof value === 'string') return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => (name in store ? String(store[name]) : m));
  if (Buffer.isBuffer(value) || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => fill(v, store));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, store)]));
};
const requestFor = (c, store) => ({
  method: c.method ?? 'GET', target: fill(c.target, store), headers: fill(c.headers ?? {}, store),
  // A body may be worked out from what the server answered earlier (`body: (vars) => …`): the leaves a challenge
  // asked for are that server's own, and no two challenges ask for the same.
  body: c.body === undefined || c.body === null ? null : typeof c.body === 'function' ? c.body(store) : fill(c.body, store),
  noAnswer: c.noAnswer === true,
});
/** `$.a.b[0].c` out of a JSON value, or undefined. */
const at = (json, where) => {
  let v = json;
  for (const step of where.replace(/^\$\.?/, '').split(/\.|(?=\[)/).filter(Boolean)) {
    if (v === null || v === undefined) return undefined;
    v = step.startsWith('[') ? v[Number(step.slice(1, -1))] : v[step];
  }
  return v;
};
function capture(c, response, store, who, name) {
  for (const [key, where] of Object.entries(c.capture ?? {})) {
    let value;
    if (where.startsWith('header:')) value = (response.headers[where.slice(7).toLowerCase()] ?? [])[0];
    else if (where.startsWith('cookie:')) value = cookieValue(response, where.slice(7));
    else { try { value = at(JSON.parse(response.body.toString('utf8')), where); } catch { value = undefined; } }
    if (value === undefined || value === null) throw new Error(`${name}: nothing to capture for {${key}} at ${where} in the ${who} answer (${response.status})`);
    store[key] = value;
  }
}
const seedFile = path.resolve(arg('--seed') ?? path.join(HERE, 'seed.json'));
const seed = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `settle`: the request started work that goes on behind its answer. Asks one server for its own settlement until it
 * shows what the case says, and its stand-in until no callbacks are under way. Returns null when it got there, or
 * what was last seen.
 */
async function settled(c, base, partner, store) {
  const s = c.settle;
  const end = Date.now() + (s.timeout ?? 10_000);
  const request = { method: 'GET', target: fill(s.target, store), headers: fill(s.headers ?? c.headers ?? {}, store) };
  const there = typeof s.until === 'function' ? s.until
    : (v) => (s.until?.state === undefined || [].concat(s.until.state).includes(v.state)) && (s.until?.last === undefined || v.events?.at(-1)?.type === s.until.last);
  for (;;) {
    let seen;
    try {
      const r = await exchange(base, request);
      const v = r.status === 200 ? JSON.parse(r.body.toString('utf8')) : null;
      if (v !== null && there(v)) {
        if (s.idle === undefined) return null;
        const idle = await exchange(partner, { target: `/control/idle?payment_id=${encodeURIComponent(fill(s.idle, store))}&timeout=50` });
        if (JSON.parse(idle.body.toString('utf8')).idle === true) return null;
        seen = 'callbacks of its partner stand-in still under way';
      } else seen = v === null ? `status ${r.status}` : `${v.state} after ${(v.events ?? []).slice(-3).map((e) => e.type).join(', ') || 'no event'}`;
    } catch (e) { seen = String(e.message ?? e); }
    if (Date.now() > end) return seen;
    await pause(40);
  }
}

const expected = JSON.parse(readFileSync(path.join(HERE, 'expected.json'), 'utf8')).differences;
const used = new Set();
const seeded = (where) => where.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), seed);
const isExpected = (name, d) => expected.findIndex((e, i) => {
  // An entry names one case (or a prefix of case names ending in *) and one path (or, ending in *, every path under a prefix;
  // or a pattern, `pathMatches`). It may also say whose object the difference is in (`ofSeed`) and what the two values are.
  const hit = (e.case === name || (e.case.endsWith('*') && name.startsWith(e.case.slice(0, -1))))
    && (e.pathMatches !== undefined ? new RegExp(e.pathMatches).test(d.path) : (e.path === d.path || (e.path.endsWith('*') && d.path.startsWith(e.path.slice(0, -1)))))
    && (e.ofSeed === undefined || (d.of !== undefined && e.ofSeed.map(seeded).includes(d.of)))
    && (!('ref' in e) || e.ref === d.ref) && (!('java' in e) || e.java === d.java);
  if (hit) used.add(i);
  return hit;
}) >= 0;

let same = 0; let listed = 0; let unexpected = 0; let ran = 0;
for (const file of readdirSync(CASES).filter((f) => f.endsWith('.mjs') && fileWanted(f)).sort()) {
  const mod = await import(path.join(CASES, file));
  const cases = typeof mod.default === 'function' ? await mod.default({ ref: REF, java: JAVA, exchange, seed, partner: PARTNER, settings: SETTINGS }) : mod.default;
  for (const c of cases) {
    const name = `${file.replace(/\.mjs$/, '')}: ${c.name ?? `${c.method ?? 'GET'} ${c.target}`}`;
    // A case that sets a variable up runs even when the run is narrowed: later cases need it.
    if (only && !name.includes(only) && !c.capture) continue;
    ran++;
    let ref; let java; let stuck = null;
    try {
      // `swap`: each server is sent what the other one answered earlier. `to: 'partner'`: the request goes to each server's stand-in.
      const [toRef, toJava] = c.to === 'partner' ? [PARTNER.ref, PARTNER.java] : [REF, JAVA];
      [ref, java] = await Promise.all([exchange(toRef, requestFor(c, c.swap ? vars.java : vars.ref)), exchange(toJava, requestFor(c, c.swap ? vars.ref : vars.java))]);
      capture(c, ref, vars.ref, 'reference', name);
      capture(c, java, vars.java, 'java', name);
      if (c.settle) {
        const [a, b] = await Promise.all([settled(c, REF, PARTNER.ref, vars.ref), settled(c, JAVA, PARTNER.java, vars.java)]);
        if (a !== null || b !== null) stuck = { path: 'settle', ref: a ?? 'settled', java: b ?? 'settled' };
      }
      // Two records made in the same millisecond have no order; a breath between requests keeps lists comparable.
      await pause(3);
    } catch (e) {
      unexpected++;
      console.log(`FAIL  ${name}\n      ${e.message}`);
      continue;
    }
    const diffs = compare(ref, java, c);
    // A server that did not come to rest where the case says is a difference like any other (path `settle`).
    if (stuck) diffs.push(stuck);
    const news = diffs.filter((d) => !isExpected(name, d));
    if (diffs.length === 0) { same++; if (show) console.log(`same  ${name} → ${ref.status}`); continue; }
    if (news.length === 0) { listed++; if (show) console.log(`known ${name} → ${diffs.map((d) => d.path).join(', ')}`); continue; }
    unexpected++;
    console.log(`DIFF  ${name}`);
    for (const d of news) console.log(`      ${d.path}\n        reference ${JSON.stringify(d.ref)}\n        java      ${JSON.stringify(d.java)}`);
  }
}
const stale = expected.filter((_, i) => !used.has(i)).filter((e) => !only && !onlyFile);
for (const e of stale) console.log(`STALE expected.json lists a difference that no longer occurs: ${e.case} ${e.path ?? e.pathMatches} (${e.why})`);
console.log(`${ran} requests: ${same} the same, ${listed} different as listed in expected.json, ${unexpected} different and not listed${stale.length ? `, ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}` : ''}`);
process.exit(unexpected === 0 && stale.length === 0 ? 0 : 1);
