/**
 * Vectors that hold `remit/PartnerAnswer` to the reference's partner client
 * (`apps/core/src/remit/partners-client.ts`, the function `post`): how an
 * answer of a partner is read, and the sentence a failed call leaves behind.
 *
 *   node apps/core-java/tools/make-remit-partner-vectors.mjs          write src/test/resources/vectors/remit-partner.json
 *   node apps/core-java/tools/make-remit-partner-vectors.mjs --check  fail when the file on disk differs
 *
 * The reference's own connector (`TripleAProfileSim`) is called with `fetch`
 * replaced, for the length of this tool, by a function that answers with a
 * `Response` made from a status and the bytes of a body — the runtime's own
 * `Response`, so `res.json()` decodes and parses as it does in the service.
 * Nothing is sent anywhere and no port is opened.
 *
 * Per answer the vector says what the call came to:
 *   returned  the value handed back to the caller (a status below 400), as JSON text; `parsed` says whether the
 *             body was JSON at all (when it was not, the reference hands back an empty object)
 *   refused   the reference's own error (502 `partner_error`): its sentence
 *   engine    the reference failed inside its runtime (it read a member of `null`, or wrote an object that names
 *             its own `toString` into a sentence): the runtime's complaint is recorded, and the Java service
 *             answers with a sentence of its own there (see the test that reads this file)
 * and for a call that never got an answer, the sentence around the runtime's cause.
 *
 * Nothing here is random: every run writes the same file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TripleAProfileSim } from '../../core/src/remit/partners-client.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/remit-partner.json');
const check = process.argv.includes('--check');

const BASE = 'http://partner.invalid:3300';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const utf8 = (text) => Buffer.from(text, 'utf8');

// ── the bodies ───────────────────────────────────────────────────────────────

const texts = [
  // no JSON at all
  '', ' ', '\n', 'not json', '<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>', '{"message":"cut', '{"message":"m"} trailing', 'undefined', 'NaN',
  "{'message':'single quotes'}", '{"message":"m",}', '{} {}',
  // JSON that is not an object
  'null', 'true', 'false', '0', '5', '-1.5', '1e21', '"text"', '""', '"message"', '[]', '[1,2,3]', '[{"message":"in a list","error":"e"}]', '["message"]',
  ' null ', '\tnull\r\n',
  // objects without what is looked for
  '{}', '{"Message":"another case"}', '{"msg":"m","err":"e"}', '{"status":"ACK"}', '{"data":{"message":"nested","error":"nested"}}',
  // message, error, both, neither
  '{"message":"not today"}', '{"error":"bad_request"}', '{"error":"request_error","message":"no accepted Travel Rule exchange for this payment — approval refused (pre-flight gate)"}',
  '{"message":"m","error":"e"}', '{"error":"e","message":"m"}', '{"message":null,"error":"e"}', '{"message":null,"error":null}', '{"message":null}', '{"error":null}',
  // values that are given and count although they look like nothing
  '{"message":""}', '{"message":"","error":"e"}', '{"message":0,"error":"e"}', '{"message":false,"error":"e"}', '{"error":""}', '{"error":0}', '{"error":false}',
  // values that are not text
  '{"message":5}', '{"message":-0}', '{"message":5.5}', '{"message":1e21}', '{"message":1e-7}', '{"message":123456789012345678901234567890}', '{"message":true}',
  '{"message":[]}', '{"message":[1,[2,3],null,"x",true]}', '{"message":[null]}', '{"message":[[]]}', '{"message":{}}', '{"message":{"a":1}}', '{"message":[{"a":1},{}]}',
  '{"error":["a","b"]}', '{"error":{"code":"x"}}', '{"error":7}',
  // where the reference's runtime gives up: an object that names its own toString cannot be written into the sentence
  '{"message":{"toString":1}}', '{"message":[{"toString":"x"}]}', '{"error":{"toString":null}}', '{"message":{"valueOf":1}}', '{"message":{"toString":1},"error":"e"}',
  // names and text of every kind
  '{"message":"한국어 메시지 — 🙂"}', '{"message":"line one\\nline two\\ttab \\"quoted\\" back\\\\slash"}', '{"message":"\\ud83d\\ude00 \\u00e9 \\u0000 end"}', '{"message":"half \\ud800 pair"}',
  '{"message":"m","message":"the second of two"}', '{"__proto__":{"message":"not inherited"}}', '{"constructor":"c","toString":"t"}', '{"message":"  spaces kept  "}',
  '  {"message":"white space around"}  ',
  // a little depth
  '{"a":'.repeat(50) + '{"message":"deep"}' + '}'.repeat(50), '['.repeat(60) + ']'.repeat(60),
];

/** Bodies given as bytes: a mark at the front, bytes that are no UTF-8. */
const raw = [
  { note: 'a byte order mark, then an object', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{"message":"after a mark"}')]) },
  { note: 'two byte order marks', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), utf8('{"message":"after two marks"}')]) },
  { note: 'a byte order mark and nothing else', bytes: Buffer.from([0xef, 0xbb, 0xbf]) },
  { note: 'a byte order mark, then null', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('null')]) },
  { note: 'bytes that are no UTF-8 inside a text', bytes: Buffer.concat([utf8('{"message":"bad '), Buffer.from([0xff, 0xfe, 0xc3]), utf8(' bytes"}')]) },
  { note: 'half a UTF-8 sequence at the end of a text', bytes: Buffer.concat([utf8('{"message":"cut '), Buffer.from([0xe2, 0x82]), utf8('"}')]) },
  { note: 'a UTF-16 answer', bytes: Buffer.from('﻿{"message":"utf-16"}', 'utf16le') },
  { note: 'a zero byte', bytes: Buffer.from([0x00]) },
];

const statuses = [200, 201, 202, 299, 300, 302, 304, 399, 400, 401, 403, 404, 409, 413, 422, 429, 499, 500, 502, 503, 504, 599];
/** Every body under these; the others take a turn each so that every status meets several bodies. */
const everyBody = [200, 400, 500];

// ── asking the reference ─────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const sim = new TripleAProfileSim(BASE);

async function ask(status, bytes) {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), method: init?.method, contentType: init?.headers?.['content-type'], body: init?.body };
    // A response of 204, 205 or 304 has no body by definition: the runtime refuses to make one with a body.
    return new Response([204, 205, 304].includes(status) ? null : bytes, { status });
  };
  try {
    const returned = await sim.requestPayoutApproval({ probe: true });
    return { seen, out: { returned: returned === undefined ? 'undefined' : JSON.stringify(returned) } };
  } catch (e) {
    if (e?.name === 'ServiceError') return { seen, out: { refused: { status: e.status, code: e.code, message: e.message } } };
    return { seen, out: { engine: { name: e?.name ?? typeof e, message: String(e?.message ?? e) } } };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const isJson = (bytes) => {
  // As the runtime decodes a body before it parses it: UTF-8, one byte order mark at the front taken away.
  const text = new TextDecoder('utf-8').decode(bytes);
  try { JSON.parse(text); return true; } catch { return false; }
};

const answers = [];
let turn = 0;
const bodies = [...texts.map((text) => ({ bytes: utf8(text) })), ...raw];
for (const status of statuses) {
  for (const [i, body] of bodies.entries()) {
    if (!everyBody.includes(status) && (i + turn) % 7 !== 0) continue;
    if ([204, 205, 304].includes(status) && body.bytes.length > 0) continue;
    const { seen, out } = await ask(status, body.bytes);
    if (seen.url !== `${BASE}/bfi/payout-approval` || seen.method !== 'POST' || seen.contentType !== 'application/json' || seen.body !== '{"probe":true}') {
      throw new Error(`the reference's client asked something else than expected: ${JSON.stringify(seen)}`);
    }
    answers.push({ status, body: hex(body.bytes), ...(body.note ? { note: body.note } : {}), parsed: isJson(body.bytes), ...out });
  }
  turn++;
}

// ── a call that got no answer ────────────────────────────────────────────────

const unanswered = [];
for (const [pathOf, call] of [
  ['/bfi/travel-rule', () => sim.sendTravelRule('PAY-1', 'jwe', 'digest', { alg: 'ES256' })],
  ['/bfi/travel-rule-response', () => sim.sendTravelRuleResponse('PAY-1', 'jwe', 'digest', { alg: 'ES256' })],
  ['/bfi/payout-approval', () => sim.requestPayoutApproval({})],
  ['/wallet/transfer', () => sim.transfer({})],
  ['/bfi/settlement-notice', () => sim.notifySettlement('PAY-1', '0xabc', { alg: 'ES256' })],
  ['/bfi/cancel', () => sim.notifyCancel('PAY-1', 'reason', { alg: 'ES256' })],
]) {
  for (const cause of ['fetch failed', 'The operation was aborted due to timeout', 'connection refused', 'no answer within 20 s']) {
    globalThis.fetch = async () => { throw new TypeError(cause); };
    try {
      await call();
      throw new Error('the reference answered where it had to fail');
    } catch (e) {
      if (e?.name !== 'ServiceError') throw e;
      unanswered.push({ path: pathOf, base: BASE, cause, status: e.status, code: e.code, message: e.message });
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// ── what each call sends ─────────────────────────────────────────────────────

const requests = [];
const sender = { alg: 'ES256', key_id: 'STONEHASH-SIGN-00000000', issuer: 'STONEHASH', sig: 'c2ln' };
for (const [name, call] of [
  ['travel-rule', () => sim.sendTravelRule('PAY-REQ-1', 'a.b.c.d.e', 'd'.repeat(64), sender)],
  ['travel-rule-response', () => sim.sendTravelRuleResponse('PAY-REQ-1', 'a.b.c.d.e', 'e'.repeat(64), sender)],
  ['payout-approval', () => sim.requestPayoutApproval({ payment_id: 'PAY-REQ-1', quote_id: 'QT-1', usdc_amount: '1200.00', sender })],
  ['transfer', () => sim.transfer({ instruction: { payload: { payment_id: 'PAY-REQ-1', derived_from_approval_seq: 4 }, sig: sender } })],
  ['settlement-notice', () => sim.notifySettlement('PAY-REQ-1', '0x' + 'ab'.repeat(32), sender)],
  ['cancel', () => sim.notifyCancel('PAY-REQ-1', 'cancelled by instructing bank', sender)],
]) {
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), method: init?.method, headers: init?.headers, body: init?.body };
    return new Response('{}', { status: 200 });
  };
  try { await call(); } finally { globalThis.fetch = realFetch; }
  requests.push({ call: name, path: seen.url.slice(BASE.length), method: seen.method, headers: seen.headers, body: seen.body });
}

const file = JSON.stringify({
  note: 'Written by tools/make-remit-partner-vectors.mjs from the reference\'s partner client. Do not edit.',
  path: '/bfi/payout-approval',
  base: BASE,
  answers,
  unanswered,
  requests,
}, null, 1) + '\n';

if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== file) {
    console.error(`${path.relative(process.cwd(), OUT)} is not what this generator writes — run it without --check`);
    process.exit(1);
  }
  console.log(`remit-partner.json is up to date (${answers.length} answers, ${unanswered.length} unanswered calls, ${requests.length} requests)`);
} else {
  writeFileSync(OUT, file);
  const kinds = answers.reduce((n, a) => { const k = a.returned !== undefined ? 'returned' : a.refused ? 'refused' : 'engine'; n[k] = (n[k] ?? 0) + 1; return n; }, {});
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${answers.length} answers (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), `
    + `${unanswered.length} unanswered calls, ${requests.length} requests`);
}
