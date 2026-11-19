/**
 * Vectors that hold the pure parts of the Java console to the reference:
 *
 *   passwords   apps/core/src/account.ts: verifyPassword — a stored string read with the parameters it names
 *   emails      normaliseEmail, passwordProblem
 *   cookies     sessionCookie, clearedCookie, cookieToken
 *   audit       apps/core/src/audit.ts: searchAudit — the page size, a time bound, a piece of a path as a LIKE
 *               pattern, a cursor read and a cursor written (asked through a store that records what it is asked)
 *   months      the month a quota and a bill are counted over
 *   billing     apps/core/src/billing.ts: monthlyCharges
 *
 *   node apps/core-java/tools/make-console-vectors.mjs          write src/test/resources/vectors/console.json
 *   node apps/core-java/tools/make-console-vectors.mjs --check  fail when the file on disk differs
 *
 * Salts are random, so the stored passwords are made once and kept
 * (src/test/resources/vectors/console-materials.json): by the reference's
 * own hashPassword where it can make them, and by the same function of the
 * runtime, in the reference's format, for the parameters it never writes
 * itself. These are test passwords of no account.
 *
 * Every answer in console.json is the reference's. Where the Java service
 * answers differently on purpose, the case says so (`java`), with the row of
 * docs/JAVA-INTENDED-DIFFERENCES.md that says why.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearedCookie, cookieToken, hashPassword, normaliseEmail, passwordProblem, sessionCookie, verifyPassword } from '../../core/src/account.ts';
import { searchAudit } from '../../core/src/audit.ts';
import { monthlyCharges } from '../../core/src/billing.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '../src/test/resources/vectors');
const OUT = path.join(DIR, 'console.json');
const MATERIALS = path.join(DIR, 'console-materials.json');
const check = process.argv.includes('--check');

// ── passwords ────────────────────────────────────────────────────────────────

const PW = 'correct horse battery staple';
let m;
if (existsSync(MATERIALS)) {
  m = JSON.parse(readFileSync(MATERIALS, 'utf8'));
} else {
  const stored = (password, N, r, p, keylen = 32, salt = randomBytes(16), use = {}) => ['scrypt', N, r, p, salt.toString('base64'),
    scryptSync(password, salt, keylen, { N: use.N ?? N, r: use.r ?? r, p: use.p ?? p, maxmem: Math.max(256 * (use.N ?? N) * (use.r ?? r), 64 * 1024 * 1024) }).toString('base64')].join('$');
  m = {
    note: 'Made once by apps/core-java/tools/make-console-vectors.mjs and kept: salts are random. Test passwords of no account.',
    password: PW,
    byTheReference: hashPassword(PW),
    unicode: { password: 'pässwörd 😀 パスワード', stored: hashPassword('pässwörd 😀 パスワード') },
    halfACharacter: { password: 'half \ud83d of a pair', stored: hashPassword('half \ud83d of a pair') },
    empty: { password: '', stored: hashPassword('') },
    long: { password: 'p'.repeat(200), stored: hashPassword('p'.repeat(200)) },
    small: stored(PW, 16, 1, 1),
    otherParameters: stored(PW, 4096, 4, 2),
    r1: stored(PW, 32768, 1, 1),
    digest64: stored(PW, 1024, 8, 1, 64),
    digest16: stored(PW, 1024, 8, 1, 16),
    digest1: stored(PW, 1024, 8, 1, 1),
    emptySalt: stored(PW, 1024, 8, 1, 32, Buffer.alloc(0)),
    salt3: stored(PW, 1024, 8, 1, 32, Buffer.from('abc')),
    pAtTheEdge: stored(PW, 4, 8, 2),
    // A zero stands for the runtime's own default: N 16384, r 8, p 1.
    zeroN: stored(PW, 0, 8, 1, 32, randomBytes(16), { N: 16384 }),
    zeroR: stored(PW, 1024, 0, 1, 32, randomBytes(16), { r: 8 }),
    zeroP: stored(PW, 1024, 8, 0, 32, randomBytes(16), { p: 1 }),
    // More than the Java service computes for a sign-in: twice today's memory and beyond; four times today's time and beyond.
    doubleMemory: stored(PW, 65536, 8, 1),
    fourTimesTheMemory: stored(PW, 131072, 8, 1),
    fourTimesTheTime: stored(PW, 32768, 8, 4),
    sixteenTimesTheTime: stored(PW, 1024, 8, 512),
  };
  writeFileSync(MATERIALS, `${JSON.stringify(m, null, 1)}\n`);
}
const part = (stored, i, value) => { const p = stored.split('$'); p[i] = typeof value === 'function' ? value(p[i]) : value; return p.join('$'); };
const url = (b) => b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const S = m.small; // scrypt$16$1$1$salt$hash — cheap, so its variants cost nothing
const D = 'D-10';
const passwordCases = [
  ['made by the reference', PW, m.byTheReference], ['made by the reference, a wrong password', `${PW}!`, m.byTheReference], ['made by the reference, the password in capitals', PW.toUpperCase(), m.byTheReference],
  ['made by the reference, no password', '', m.byTheReference], ['letters beyond ASCII', m.unicode.password, m.unicode.stored], ['letters beyond ASCII, composed differently', m.unicode.password.normalize('NFD'), m.unicode.stored],
  ['half of a surrogate pair', m.halfACharacter.password, m.halfACharacter.stored], ['half of a surrogate pair, the other half', 'half \udc00 of a pair', m.halfACharacter.stored],
  ['an empty password that was stored', '', m.empty.stored], ['a password of 200 characters', m.long.password, m.long.stored], ['a password of 201 characters', `${m.long.password}p`, m.long.stored],
  ['small parameters', PW, S], ['small parameters, a wrong password', 'wrong', S], ['other parameters', PW, m.otherParameters], ['r = 1', PW, m.r1],
  ['a digest of 64 bytes', PW, m.digest64], ['a digest of 16 bytes', PW, m.digest16], ['a digest of one byte', PW, m.digest1], ['a digest of one byte, a wrong password', 'wrong', m.digest1],
  ['an empty salt', PW, m.emptySalt], ['a salt of three bytes', PW, m.salt3], ['p as large as N allows', PW, m.pAtTheEdge], ['p one more than N allows', PW, part(m.pAtTheEdge, 3, '3')],
  ['N = 0: the default', PW, m.zeroN], ['r = 0: the default', PW, m.zeroR], ['p = 0: the default', PW, m.zeroP], ['N empty: zero, the default', PW, part(m.zeroN, 1, '')],
  ['N = -0', PW, part(m.zeroN, 1, '-0')],
  // The numbers, as text the runtime reads as a number.
  ['N in hex', PW, part(S, 1, '0x10')], ['N with spaces around', PW, part(S, 1, ' 16 ')], ['N with an exponent', PW, part(S, 1, '1.6e1')], ['N with a fraction of zero', PW, part(S, 1, '16.0')],
  ['N with a leading zero', PW, part(S, 1, '016')], ['N in binary', PW, part(S, 1, '0b10000')], ['N with a plus sign', PW, part(S, 1, '+16')], ['r with a line end', PW, part(S, 2, '1\n')],
  ['N that is not a number', PW, part(S, 1, 'sixteen')], ['N with a suffix', PW, part(S, 1, '16n')], ['N with a separator', PW, part(S, 1, '1_6')], ['N infinite', PW, part(S, 1, 'Infinity')],
  ['N negative', PW, part(S, 1, '-16')], ['N with a fraction', PW, part(S, 1, '16.5')], ['N beyond 32 bits', PW, part(S, 1, '4294967296')], ['N = 4294967295', PW, part(S, 1, '4294967295')],
  ['N not a power of two', PW, part(S, 1, '15')], ['N = 1', PW, part(S, 1, '1')], ['N = 2: too little memory for it', PW, part(S, 1, '2')], ['N = 65536 with r = 1', PW, part(S, 1, '65536')],
  ['another N', PW, part(S, 1, '32')], ['another r', PW, part(S, 2, '2')], ['another p', PW, part(S, 3, '2')], ['r that is not a number', PW, part(S, 2, 'x')], ['p that is not a number', PW, part(S, 3, 'NaN')],
  ['r beyond 32 bits', PW, part(S, 2, '4294967296')], ['r = 4294967295', PW, part(S, 2, '4294967295')], ['p = 4294967295', PW, part(S, 3, '4294967295')], ['p = 1073741824', PW, part(S, 3, '1073741824')],
  ['N and r so large that their memory limit is no number', PW, part(part(S, 1, '2147483648'), 2, '2147483648')],
  // The shape of the string.
  ['five parts', PW, S.split('$').slice(0, 5).join('$')], ['seven parts', PW, `${S}$`], ['a part more in front', PW, `$${S}`], ['the scheme in capitals', PW, part(S, 0, 'SCRYPT')],
  ['the scheme with a space', PW, part(S, 0, 'scrypt ')], ['another scheme', PW, '$2b$12$abcdefghijklmnopqrstuuAbCdEfGhIjKlMnOpQrStUvWxYz0123456'], ['empty', PW, ''], ['one word', PW, 'password'],
  // Base64 as the runtime reads it.
  ['the digest in the URL alphabet', PW, part(S, 5, url)], ['the digest without padding', PW, part(S, 5, (h) => h.replace(/=+$/, ''))], ['the digest with line breaks', PW, part(S, 5, (h) => h.replace(/(.{10})/g, '$1\n'))],
  ['the digest with a character outside the alphabet', PW, part(S, 5, (h) => `${h.slice(0, 5)}*${h.slice(5)}`)], ['the digest with text after its padding', PW, part(S, 5, (h) => `${h}AAAA`)],
  ['the digest with more after it', PW, part(S, 5, (h) => `${h.replace(/=+$/, '')}AAAA`)], ['the digest cut short', PW, part(S, 5, (h) => h.slice(0, 20))],
  ['the salt in the URL alphabet', PW, part(S, 4, url)], ['the salt with spaces', PW, part(S, 4, (h) => ` ${h.slice(0, 8)} ${h.slice(8)} `)], ['another salt', PW, part(S, 4, 'AAAAAAAAAAAAAAAAAAAAAA==')],
  // Stricter in the Java service, on purpose.
  ['an empty digest', PW, part(S, 5, ''), { java: false, why: `${D}: an empty digest matches nothing` }],
  ['an empty digest, any password', 'anything at all', part(S, 5, ''), { java: false, why: `${D}: an empty digest matches nothing` }],
  ['a digest of padding only', PW, part(S, 5, '=='), { java: false, why: `${D}: an empty digest matches nothing` }],
  ['twice today\'s memory', PW, m.doubleMemory],
  ['four times today\'s memory', PW, m.fourTimesTheMemory, { java: false, why: `${D}: more memory than a sign-in is given` }],
  ['four times today\'s time', PW, m.fourTimesTheTime],
  ['sixteen times today\'s time', PW, m.sixteenTimesTheTime, { java: false, why: `${D}: more time than a sign-in is given` }],
].map(([name, password, stored, java]) => ({ name, password, stored, verifies: verifyPassword(password, stored), ...(java ?? {}) }));
for (const c of passwordCases) if ('java' in c && c.java === c.verifies) throw new Error(`"${c.name}" is listed as a difference, and the reference answers the same`);

// ── addresses and passwords as they are accepted ─────────────────────────────

const emails = ['a@b.co', ' A@B.CO ', 'Ops@Parity-Bank.Example', 'a@b', 'a@b.', 'a@.b', '@b.co', 'a@b.c', 'a b@c.de', 'a@b c.de', 'a@@b.co', 'a@b@c.de', 'a@b..co', 'a.b@c.de', 'a@b.c.d.e',
  'ab.co', '', '     ', 'a@b.co\n', '\ta@b.co', 'a b@c.de', '﻿a@b.co', 'a @b.co', 'İ@b.co', 'STRASSE@ß.de', 'ΑΣ@b.co', '😀@b.co', '\ud83d@b.co', `${'a'.repeat(248)}@b.co`, `${'a'.repeat(249)}@b.co`,
  `${'a'.repeat(250)}@b.co`, 'a@b.co.', 'a@b,co', '"a b"@c.de', 'a@[127.0.0.1]', 'a@b.co ', 5, null, true, ['a@b.co'], { email: 'a@b.co' }]
  .map((input) => ({ input, normalised: normaliseEmail(input) }));
const passwords = ['', 'short', '012345678', '0123456789', 'p'.repeat(200), 'p'.repeat(201), '😀😀😀😀', '😀😀😀😀😀', '          ', '\u0000'.repeat(10), 1234567890, null, true, ['0123456789'], { length: 12 }]
  .map((input) => ({ input, problem: passwordProblem(input) }));

// ── cookies ──────────────────────────────────────────────────────────────────

const instants = ['2026-11-18T09:10:11.123Z', '2026-12-02T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z', '2028-02-29T12:00:00.000Z', '2026-03-08T07:05:03.000Z',
  '2026-06-01T23:00:00.500Z', '2026-07-04T01:02:03.004Z', '2026-08-09T10:20:30.000Z', '2026-09-10T00:00:00.000Z', '2026-10-11T00:00:00.000Z', '2026-04-12T00:00:00.000Z', '2026-05-13T00:00:00.000Z',
  '2026-02-14T00:00:00.000Z', '2026-01-15T00:00:00.000Z', '1970-01-01T00:00:00.000Z', '2000-02-29T23:59:59.000Z', '9999-12-31T23:59:59.999Z'];
const set = instants.flatMap((at) => [false, true].map((secure) => ({ token: 'tok_EN-with_43-characters-of-base64url-000000', expiresAt: Date.parse(at), secure,
  cookie: sessionCookie('tok_EN-with_43-characters-of-base64url-000000', new Date(at), secure) })));
const cleared = [false, true].map((secure) => ({ secure, cookie: clearedCookie(secure) }));
const read = ['stonehash_session=abc', 'a=b; stonehash_session=abc; c=d', 'stonehash_session=abc; stonehash_session=def', 'stonehash_session=', 'stonehash_session=; stonehash_session=def',
  '  stonehash_session  =  abc  ', 'stonehash_session=a=b=c', 'stonehash_session="abc"', 'Stonehash_Session=abc', 'stonehash_session', '=abc', 'a; =b; stonehash_session=x; y', ';;;stonehash_session=abc;;;',
  'xstonehash_session=abc', 'stonehash_session=a b', 'stonehash_session=\tabc\t', 'stonehash_session=abc,other=1', 'other=stonehash_session=abc', '', ' ', 'stonehash_session=%20abc', 'stonehash_session= abc ']
  .map((header) => ({ header, token: cookieToken(header) ?? null }));

// ── the audit trail: what the store is asked ─────────────────────────────────

/** searchAudit against a store that answers with `rows` and keeps what it was asked. */
const asked = async (search, rows = []) => {
  let seen = null;
  const db = { prepare: (sql) => ({ all: async (...params) => { seen = { sql: sql.replace(/\s+/g, ' ').trim(), params }; return rows.map((r) => ({ ...r })); } }) };
  try {
    const page = await searchAudit(db, 'org', search);
    return { ...seen, page };
  } catch (e) {
    return { error: e.code, message: e.message };
  }
};
const num = (n) => (Number.isFinite(n) ? n : String(n));
const limits = [];
for (const limit of [undefined, 0, 1, 2, 2.5, 2.999, 49, 50, 199, 200, 201, 10_000, -1, -0.5, 0.5, 1e21, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  const r = await asked(limit === undefined ? {} : { limit });
  limits.push({ limit: limit === undefined ? null : num(limit), rowsAskedFor: Number(/LIMIT (\d+)$/.exec(r.sql)[1]) });
}
const bounds = [];
for (const raw of ['2026-03-02T00:00:00Z', '2026-03-02T00:00:00.000Z', '2026-03-02T09:00:00+09:00', '2026-03-01T19:00:00-05:00', '2026-03-02T00:00:00.5Z', '2026-03-02T00:00:00.123456Z', '2026-03-02',
  '2026-03', '2026', '2026-03-02T00:00Z', '2026-03-02T24:00:00Z', '2026-03-02T00:00:00+0900', '2026-03-02t00:00:00z', '2026-03-02 00:00:00Z', '2026-03-02T00:00:00', '2026-03-02T00:00',
  '2026-02-30T00:00:00Z', '2026-02-31', '+002026-03-02T00:00:00Z', '-000001-01-01T00:00:00Z', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z', '+275760-09-13T00:00:00.000Z',
  'yesterday', '2026-13-01', '2026-00-10', '2026-03-32', '2026-03-02T25:00:00Z', '2026-03-02T00:60:00Z', '2026-03-02T00:00:60Z', '2026-03-02T00:00:00+24:00', '+275760-09-13T00:00:00.001Z',
  '-000000-01-01T00:00:00Z', '2026-03-02T', 'T00:00:00Z', ' 2026-03-02T00:00:00Z', '2026-03-02T00:00:00Z ', '2026-3-2', '20260302', '2026-03-02T000000Z', 'null', '\u0000']) {
  const [from, to] = [await asked({ from: raw }), await asked({ to: raw })];
  bounds.push({ raw, ...(from.error ? { error: from.error, from: from.message, to: to.message } : { instant: from.params[1] }) });
}
const needles = [];
for (const q of ['keys', 'K_1', '%', '100%_done!', '!', '!!', '_', 'ß', 'ǆ', 'i̇', 'é', ' /v1 ', '😀', '%25', '\\']) needles.push({ q, pattern: (await asked({ q })).params[1] });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const AT = '2026-03-02T00:00:00.000Z';
const ID = '0ce9ef95-aafd-4198-afd3-42f5d3336332';
const good = b64(JSON.stringify({ c: AT, i: ID }));
const cursors = [];
for (const cursor of [good, Buffer.from(JSON.stringify({ c: AT, i: ID })).toString('base64'), `${good}==`, `${good.slice(0, 20)}\n${good.slice(20)}`, `${good.slice(0, 20)}*${good.slice(20)}`, ` ${good} `,
  b64(JSON.stringify({ i: ID, c: AT, more: [1, { x: null }] })), b64(` { "c" : "${AT}" , "i" : "${ID}" } `), b64('{"c":"","i":""}'), b64('{"c":"é😀","i":"\\ud83d"}'), b64('{"c":"a","i":"b","c":"z"}'),
  b64(`{"c":"${AT}","i":"${ID}?>"}`), b64(`{"c":"${AT}?>~","i":"${ID}"}`),
  'nope', '', b64('{}'), b64('[]'), b64('null'), b64('5'), b64('"c"'), b64('true'), b64('{"c":1,"i":"x"}'), b64('{"c":"x","i":1}'), b64('{"c":"x"}'), b64('{"i":"x"}'), b64('{"c":null,"i":"x"}'),
  b64('{"c":"x","i":null}'), b64('{"c":["x"],"i":"y"}'), b64('{"c":"x","i":"y"'), b64('{"c":"x","i":"y"}}'), b64('{\'c\':\'x\',\'i\':\'y\'}'), b64('[{"c":"x","i":"y"}]'), '%%%', '_____w', 'e', 'e30', 'e30=', '====']) {
  const r = cursor === '' ? { skipped: true } : await asked({ cursor });
  cursors.push({ cursor, ...(r.skipped ? { none: true } : r.error ? { error: r.error, message: r.message } : { at: r.params[1], id: r.params[3] }) });
}
const row = (n, at, id) => ({ id, at, actor_type: 'session', actor_id: 'acc', actor_label: 'a@example.com', service: 'console', method: 'POST', path: '/v1/console/keys', status: '201', duration_ms: `${n}` });
const written = [];
for (const [at, id] of [[AT, ID], ['2026-12-31T23:59:59.999Z', '00000000-0000-4000-8000-000000000070'], ['', ''], ['é😀', 'a/b+c?d'], ['2026-03-02T00:00:00.000Z', 'x'.repeat(40)], ['a"b\\c', '\n\t'], ['\ud83d', '\u007f\u0080']]) {
  // Two rows asked for one: the page is full and there is more, so the cursor of its last row is written.
  const r = await asked({ limit: 1 }, [row(1, at, id), row(2, 'older', 'other')]);
  written.push({ at, id, cursor: r.page.nextCursor });
}
const pages = [];
for (const [limit, n] of [[2, 0], [2, 1], [2, 2], [2, 3], [1, 2], [50, 51], [200, 201]]) {
  const r = await asked({ limit }, Array.from({ length: n }, (_, i) => row(i, `t${String(n - i).padStart(4, '0')}`, `id${i}`)));
  pages.push({ limit, rowsFound: n, returned: r.page.items.length, next: r.page.nextCursor, last: r.page.items.at(-1) ?? null });
}

// ── months ───────────────────────────────────────────────────────────────────

// The first instant of the month an instant is in (the expression apps/core/src/http/console.ts counts a quota
// from), and where the month after it begins (what it answers as `resets`, and what monthlyCharges ends a period with).
const SANDBOX = { currency: 'KRW', attest: { monthly_fee: 0, per_anchor: 0 }, por: { monthly_fee: 0, per_snapshot: 0 }, remit: { monthly_fee: 0, per_settlement: 0 } };
const months = ['2026-11-18T09:10:11.123Z', '2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.999Z', '2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z', '2028-02-29T12:00:00.000Z', '2027-02-28T23:59:59.999Z',
  '2026-03-31T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '1999-12-31T23:59:59.999Z', '1970-01-01T00:00:00.000Z', '2100-02-28T12:00:00.000Z', '9999-12-31T23:59:59.999Z'].map((at) => {
  const d = new Date(at);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const resets = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  const period = monthlyCharges(SANDBOX, { anchors: 0, settlements: 0, snapshots: 0 }, new Set(), start).period;
  if (period.start !== start.toISOString() || period.end !== resets) throw new Error(`the two ways to the month of ${at} disagree`);
  return { at: d.getTime(), start: start.toISOString(), next: resets };
});

// ── billing ──────────────────────────────────────────────────────────────────

const LIST = { currency: 'KRW', attest: { monthly_fee: 49000, per_anchor: 10 }, por: { monthly_fee: 300000, per_snapshot: 50000 }, remit: { monthly_fee: 1000000, per_settlement: 1500 } };
const CENTS = { currency: 'USD', attest: { monthly_fee: 9.99, per_anchor: 0.005 }, por: { monthly_fee: 0.1, per_snapshot: 0.2 }, remit: { monthly_fee: 1e-7, per_settlement: 1.005 } };
const LARGE = { currency: 'VND', attest: { monthly_fee: 1e15, per_anchor: 0.3333333 }, por: { monthly_fee: 123456789.125, per_snapshot: 2.675 }, remit: { monthly_fee: 0, per_settlement: 1e-3 } };
const billing = [];
for (const [name, pricing] of [['sandbox', SANDBOX], ['a price list', LIST], ['cents', CENTS], ['large', LARGE]]) {
  for (const usage of [{ anchors: 0, settlements: 0, snapshots: 0 }, { anchors: 1, settlements: 1, snapshots: 1 }, { anchors: 3, settlements: 7, snapshots: 2 }, { anchors: 1001, settlements: 99, snapshots: 13 },
    { anchors: 123456789, settlements: 4503599627370496, snapshots: 1e6 }]) {
    for (const active of [['attest', 'remit', 'por'], ['attest'], ['remit', 'por'], ['por'], [], ['attest', 'billing']]) {
      billing.push({ name: `${name}, ${usage.anchors}/${usage.settlements}/${usage.snapshots}, ${active.join('+') || 'nothing active'}`, pricing, usage, active,
        monthStart: Date.parse('2026-12-01T00:00:00.000Z'), charges: monthlyCharges(pricing, usage, new Set(active), new Date('2026-12-01T00:00:00.000Z')) });
    }
  }
}

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-console-vectors.mjs from apps/core/src/{account,audit,billing}.ts. Do not edit by hand.',
  passwords: passwordCases, emails, passwordProblems: passwords,
  cookies: { set, cleared, read },
  audit: { limits, bounds, needles, cursors, written, pages },
  months, billing,
}, null, 1)}\n`;
const counts = `${passwordCases.length} stored passwords, ${emails.length} addresses, ${set.length + cleared.length + read.length} cookies, ${limits.length + bounds.length + needles.length + cursors.length + written.length + pages.length} audit questions, ${months.length} months, ${billing.length} bills`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('console.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`console.json is current (${counts})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${counts}`);
  for (const c of passwordCases) console.log(`  ${c.name.padEnd(56)} ${c.verifies}${'java' in c ? `   (java: ${c.java} — ${c.why})` : ''}`);
}
