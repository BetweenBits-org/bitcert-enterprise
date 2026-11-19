/**
 * Vectors that hold the Java core's reading of a request — its target, a
 * path parameter, a page size — and of its settings to the service it
 * replaces. The answers come from Node and from that service's own code
 * (`apps/core/src/http/server.ts`, `apps/core/src/config.ts`), not from a
 * description of them.
 *
 *   node apps/core-java/tools/make-http-vectors.mjs          write src/test/resources/vectors/http.json
 *   node apps/core-java/tools/make-http-vectors.mjs --check  fail when the file on disk differs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageLimit } from '../../core/src/http/server.ts';
import { loadConfig } from '../../core/src/config.ts';
import { serviceOf, isAudited } from '../../core/src/audit.ts';
import { cookieToken } from '../../core/src/account.ts';
import { RateLimiter, clientKey } from '../../core/src/http/ratelimit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/http.json');
const check = process.argv.includes('--check');

// ── request targets: [path, query] as a servlet container hands them over ───

const targets = [
  ['/', null], ['/healthz', null], ['/v1/meta', null], ['/v1/meta', ''], ['/v1/meta', 'a=1'], ['/v1//meta/', null], ['//v1/meta', null], ['/v1/meta//', null],
  ['/a/../b', null], ['/a/./b', null], ['/a/%2e/b', null], ['/a/%2E%2e/b', null], ['/a/.%2e/b', null], ['/a/%2e./b', null], ['/..', null], ['/../..', null], ['/a/..', null], ['/a/../', null],
  ['/a/.', null], ['/a/./', null], ['/./a', null], ['/...', null], ['/a/.../b', null], ['/.a', null], ['/a.', null], ['/%2e%2e%2f', null], ['/a/%2e%2e%2fb', null],
  ['/a\\b', null], ['/a\\..\\b', null], ['\\a', null], ['/\\a', null], ['\\\\a\\b', null],
  ['/a%20b', null], ['/a%2Fb', null], ['/a%2fb', null], ['/a%5Cb', null], ['/%E0', null], ['/%zz', null], ['/%', null], ['/%2', null], ['/a%00b', null], ['/caf%C3%A9', null],
  ['/a^b', null], ['/a{b}', null], ['/a|b', null], ['/a`b', null], ['/a[b]', null], ['/a"b', null], ['/a<b>', null], ['/a;b=c', null], ['/a:b@c', null], ["/a'b", null], ['/a~b!$&()*+,=', null],
  ['/x', 'a=1&b=2'], ['/x', 'a=1&a=2'], ['/x', 'a'], ['/x', 'a='], ['/x', '=a'], ['/x', '&&a=1&&'], ['/x', 'a=b=c'], ['/x', 'a+b=c+d'], ['/x', 'a%20b=%41'], ['/x', 'a=%E0'], ['/x', 'a=%zz'],
  ['/x', 'a=%'], ['/x', 'limit=25'], ['/x', 'q=%EC%95%88%EB%85%95'], ['/x', "a='b'"], ['/x', 'a="b"'], ['/x', 'a=<b>'], ['/x', 'a=b c'], ['/x', 'a=^{}|`[]'], ['/x', 'a=1?b=2'], ['/x', '?'],
  ['/x', 'cursor=eyJjIjoiMjAyNiJ9&state=A,B'], ['/x', 'a=%26&b=%3D&c=%2B&d=%25'], ['/x', 'source_uetr=3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10'],
  ['//host/x', null], ['//host', null], ['//', null], ['///x/y', null], ['//[/x', null], ['//[::1]/x', null], ['//[::1/x', null], ['//h:80/x', 'q=1'], ['//h:99999/x', null], ['//h:8a/x', null],
  ['//h:/x', null], ['//user:pw@h/x', null], ['//@h/x', null], ['//a b/x', null], ['//1.2.3.4/x', null], ['//1.2.3.4.5/x', null], ['//0x7f.1/x', null], ['//1.2.3.256/x', null],
  ['//256/x', null], ['//4294967296/x', null], ['//1..2/x', null], ['//h./x', null], ['//1./x', null], ['//%68/x', null], ['//h%2Fz/x', null], ['//a^b/x', null], ['//a|b/x', null],
  ['//a%00b/x', null], ['//a%zzb/x', null], ['//a<b/x', null], ['//012.1/x', null], ['//09/x', null], ['//0x/x', null], ['//1.2.3/x', null], ['//999.1/x', null], ['/\\/h/x', null],
  ['*', null], ['x', null], ['/console', 'lang=en'], ['/console/', null], ['/docs/guide.md', null], ['/console/..%2f..%2fetc%2fpasswd', null], ['/console/%2e%2e/%2e%2e/x', null],
];
const requestTargets = targets.map(([p, q]) => {
  try {
    const u = new URL(p + (q === null ? '' : `?${q}`), 'http://localhost');
    return { path: p, query: q, pathname: u.pathname, search: u.search, params: [...u.searchParams], collapsed: u.pathname.replace(/\/{2,}/g, '/'), parts: u.pathname.split('/').filter(Boolean) };
  } catch {
    return { path: p, query: q, fails: true };
  }
});

// ── decodeURIComponent ──────────────────────────────────────────────────────

const escapes = ['', 'abc', 'a%20b', 'a+b', '%41%42', '%e2%82%ac', '%E2%82%AC', '%F0%9F%98%80', '%E0', '%E0%A4', '%C0%80', '%ED%A0%80', '%F4%90%80%80', '%FF', '%80', '%C3', '%C3%28', '%zz', '%', '%2',
  '%2G', 'a%', '%%41', '%25', '%2525', '%00', 'PAY-1', 'PAY%2D1', 'a%2Fb', 'a%2fb', '%41%E0', '%E0%41', 'é', '%C3%A9é', '%EF%BF%BD', '%EF%BB%BF', '%F8%88%80%80%80', '%E2%82', '%e2%82%ac%e2', '100%'];
const decode = escapes.map((text) => { try { return { text, decoded: decodeURIComponent(text) }; } catch { return { text, fails: true }; } });

// ── pageLimit ───────────────────────────────────────────────────────────────

const raws = [null, '', ' ', '0', '1', '2', '25', '100', '101', '1000', '-1', '-0', '2.5', '2.999', '0.5', '0.999', '1e2', '1e3', 'abc', '25abc', ' 25 ', '+25', '0x10', '0b11', 'Infinity', '-Infinity',
  'NaN', '1e999', '99999999999999999999', '25.0', '.5', '5.', 'null', 'undefined', 'true', '１２', '2,5', '1_0'];
const limits = [];
for (const raw of raws) for (const [dflt, max] of [[25, 100], [50, 200], [100, 500], [20, 20]]) limits.push({ raw, dflt, max, limit: pageLimit(raw, dflt, max) });

// ── settings ────────────────────────────────────────────────────────────────

const BASE = { STONEHASH_DATA_DIR: '/srv/stonehash/data' };
const envs = [
  {}, { STONEHASH_ENV: 'live', ANCHOR_BACKEND: 'mainnet' }, { STONEHASH_ENV: 'live' }, { STONEHASH_ENV: 'live', ALLOW_REGTEST_IN_LIVE: '1' }, { STONEHASH_ENV: 'prod' }, { STONEHASH_ENV: '' },
  { ANCHOR_BACKEND: 'testnet' }, { PORT: '8790', HOST: '0.0.0.0' }, { PORT: 'abc' }, { PORT: '-1' }, { PORT: '1.5' }, { PORT: ' 80 ' }, { PORT: '0x50' }, { PORT: '1e3' }, { PORT: '' }, { PORT: '0' },
  { STONEHASH_DB_URL: 'mysql://u:p@127.0.0.1:3306/stonehash_test_x', BITCOIND_URL: 'http://127.0.0.1:18443', BITCOIND_USER: 'u', BITCOIND_PASSWORD: 'p', BITCOIND_WALLET: 'w' },
  { BATCH_MAX_LEAVES: '8', BATCH_FLUSH_INTERVAL_MS: '500', WORKER_TICK_MS: '0' }, { BATCH_MAX_LEAVES: 'many' }, { WORKER_TICK_MS: '2.5' },
  { EXPLORER_BASE_URL: 'https://mempool.example///' }, { EXPLORER_BASE_URL: '/' }, { INSCRIPTION_MAX_BYTES: '0' }, { INSCRIPTION_MAX_BYTES: '99999999' }, { INSCRIPTION_MAX_BYTES: '5000' },
  { PLAYGROUND_DIR: '/srv/pg', DOCS_DIR: '/srv/docs', CONSOLE_DIR: '/srv/console', PUBLIC_BASE_URL: 'https://attest.example' },
  { CONSOLE_ENABLED: '0', COOKIE_SECURE: '1', CONSOLE_MONTHLY_QUOTA: '5', CONSOLE_AUTH_WINDOW_MS: '1000', CONSOLE_AUTH_MAX: '2' }, { CONSOLE_ENABLED: 'true' }, { COOKIE_SECURE: 'yes' },
  { TRUST_PROXY: '1', SIGNUP_RATE_WINDOW_MS: '10', SIGNUP_RATE_MAX: '1' },
  { PUBLIC_ANCHOR_ENABLED: '0' }, { PUBLIC_ANCHOR_WINDOW_MS: '1', PUBLIC_ANCHOR_MAX: '2', PUBLIC_ANCHOR_GLOBAL_WINDOW_MS: '3', PUBLIC_ANCHOR_GLOBAL_MAX: '4', PUBLIC_ANCHOR_RETENTION_DAYS: '5' },
  { PUBLIC_ANCHOR_ORIGINS: 'https://a.example, https://b.example ,,\u00a0https://c.example\u00a0' }, { PUBLIC_ANCHOR_ORIGINS: ' , ' },
  { REMIT_ENABLED: '0' }, { STONEHASH_ENV: 'live', ANCHOR_BACKEND: 'mainnet', REMIT_ENABLED: '1', REMIT_CHAIN_RPC: 'https://rpc.example' },
  { REMIT_PARTNERS_BASE: 'http://127.0.0.1:3301', REMIT_ADMIN_TOKEN: 't', REMIT_PLATFORM_KEY_PATH: '/srv/key.pem', REMIT_ACCEPT_DEMO_FINALITY: '0', REMIT_QUOTE_TTL_MS: '1000' },
  { REMIT_RATE_USD_VND: '25803', REMIT_RATE_USD_SGD: '1.3', REMIT_FEE_USD: '0.50', REMIT_CHAIN_LABEL: 'eip155:1', REMIT_WEBHOOK_MAX_ATTEMPTS: '9' },
  { REMIT_EXPLORER_TX_URL: 'https://etherscan.io/tx/{tx}' }, { REMIT_EXPLORER_TX_URL: 'http://127.0.0.1:5106/tx/{tx}' }, { REMIT_EXPLORER_TX_URL: 'etherscan.io/tx/{tx}' },
  { REMIT_EXPLORER_TX_URL: 'https://etherscan.io/tx/' }, { REMIT_EXPLORER_TX_URL: 'ftp://x/{tx}' },
  { REMIT_CHAIN_RPC: 'http://127.0.0.1:8545' }, { REMIT_CHAIN_RPC: 'https://user:pw@rpc.example' }, { REMIT_CHAIN_RPC: 'https://user@rpc.example' }, { REMIT_CHAIN_RPC: 'https://@rpc.example' },
  { REMIT_CHAIN_RPC: 'rpc.example:8545' }, { REMIT_CHAIN_RPC: 'ws://rpc.example' }, { REMIT_CHAIN_RPC: 'not a url' }, { REMIT_CHAIN_RPC: 'http://' }, { REMIT_CHAIN_RPC: 'http://h:99999' },
  { REMIT_CHAIN_RPC: 'HTTP://RPC.example/path?x=1#f' }, { REMIT_CHAIN_RPC: 'http:rpc.example' }, { REMIT_CHAIN_RPC: 'http://[::1]:8545' }, { REMIT_CHAIN_RPC: 'http://a b' },
  { REMIT_CHAIN_RPC: ' http://127.0.0.1:8545 ' }, { REMIT_CHAIN_RPC: 'file:///etc/passwd' }, { REMIT_CHAIN_RPC: 'mailto:x@y' }, { REMIT_CHAIN_RPC: '//rpc.example' },
  // The settlement rail's other keys: values that are not what they have to be, what a live deployment gets when it sets none of them, and paths.
  { REMIT_QUOTE_TTL_MS: 'soon' }, { REMIT_QUOTE_TTL_MS: '1.5' }, { REMIT_QUOTE_TTL_MS: '-1' }, { REMIT_QUOTE_TTL_MS: '0' }, { REMIT_QUOTE_TTL_MS: '' }, { REMIT_QUOTE_TTL_MS: ' 1000 ' }, { REMIT_QUOTE_TTL_MS: '1e3' },
  { REMIT_WEBHOOK_MAX_ATTEMPTS: 'five' }, { REMIT_WEBHOOK_MAX_ATTEMPTS: '0' }, { REMIT_WEBHOOK_MAX_ATTEMPTS: '2.5' }, { REMIT_WEBHOOK_MAX_ATTEMPTS: '-3' }, { REMIT_WEBHOOK_MAX_ATTEMPTS: '' },
  { REMIT_ACCEPT_DEMO_FINALITY: '1' }, { REMIT_ACCEPT_DEMO_FINALITY: 'true' }, { REMIT_ACCEPT_DEMO_FINALITY: '' }, { REMIT_ENABLED: 'yes' }, { REMIT_ENABLED: '' }, { REMIT_ENABLED: '1' },
  { STONEHASH_ENV: 'live', ANCHOR_BACKEND: 'mainnet', REMIT_ENABLED: '1' },
  { STONEHASH_ENV: 'live', ANCHOR_BACKEND: 'mainnet', REMIT_ENABLED: '1', REMIT_CHAIN_RPC: 'https://rpc.example', REMIT_ACCEPT_DEMO_FINALITY: '1', REMIT_ADMIN_TOKEN: 'x', REMIT_PARTNERS_BASE: 'https://partner.example/' },
  { REMIT_PLATFORM_KEY_PATH: 'relative/key.pem' }, { REMIT_PLATFORM_KEY_PATH: '' }, { STONEHASH_DATA_DIR: '/srv/a/../b' }, { STONEHASH_DATA_DIR: '/srv/a/' },
  { REMIT_PARTNERS_BASE: '' }, { REMIT_PARTNERS_BASE: 'http://127.0.0.1:3301/' }, { REMIT_ADMIN_TOKEN: '' }, { REMIT_RATE_USD_VND: 'abc', REMIT_RATE_USD_SGD: '', REMIT_FEE_USD: '-1' }, { REMIT_CHAIN_LABEL: '' },
  // Two keys only the Java service reads (docs/JAVA-REMIT-DESIGN.md 17): the reference is unmoved by them, whatever they say.
  { REMIT_STEP_RETRY_MS: 'off', REMIT_INTAKE_PAUSED: '1' }, { REMIT_STEP_RETRY_MS: '100,200', REMIT_INTAKE_PAUSED: '0' }, { REMIT_STEP_RETRY_MS: '', REMIT_INTAKE_PAUSED: '' },
  { POR_CHAIN_RPC: 'https://u:p@por.example' }, { POR_CHAIN_RPC: 'http://127.0.0.1:9545' }, { POR_CHAIN_RPC: 'nope' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":1000,"per_anchor":10},"por":{"monthly_fee":0,"per_snapshot":2.5},"remit":{"monthly_fee":0,"per_settlement":1e3}}' },
  { CONSOLE_PRICING: '  ' }, { CONSOLE_PRICING: 'not json' }, { CONSOLE_PRICING: '[]' }, { CONSOLE_PRICING: 'null' }, { CONSOLE_PRICING: '"x"' }, { CONSOLE_PRICING: '{}' },
  { CONSOLE_PRICING: '{"currency":"krw"}' }, { CONSOLE_PRICING: '{"currency":"KRW"}' }, { CONSOLE_PRICING: '{"currency":"KRW","attest":[]}' },
  { CONSOLE_PRICING: '{"currency":"KRW","extra":1}' }, { CONSOLE_PRICING: '{"toString":1,"currency":"KRW","attest":{"monthly_fee":0,"per_anchor":0},"por":{"monthly_fee":0,"per_snapshot":0},"remit":{"monthly_fee":0,"per_settlement":0}}' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":0,"per_anchor":0,"x":1},"por":{},"remit":{}}' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":0},"por":{},"remit":{}}' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":-1,"per_anchor":0},"por":{},"remit":{}}' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":"0","per_anchor":0},"por":{},"remit":{}}' },
  { CONSOLE_PRICING: '{"currency":"KRW","attest":{"monthly_fee":1e999,"per_anchor":0},"por":{},"remit":{}}' },
  { CONSOLE_PRICING: '{"currency":"USD","attest":{"per_anchor":0.1,"monthly_fee":19.99},"por":{"monthly_fee":0,"per_snapshot":0},"remit":{"monthly_fee":0,"per_settlement":0.25}}' },
  { CONSOLE_PRICING: '{"2":1,"currency":"KRW"}' },
];
const KEYS = new Set(envs.flatMap((e) => Object.keys(e)).concat(Object.keys(BASE), ['STONEHASH_DB_PATH']));
const settings = envs.map((given) => {
  const env = { ...BASE, ...given };
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const { dbPath, ...config } = loadConfig();
    return { env, config };
  } catch (e) {
    return { env, error: e.message };
  }
});

// ── the audit trail's sorting, the session cookie, the caller's address, the limiter ──

const paths = ['/healthz', '/readyz', '/v1/meta', '/v1/attestations', '/v1/attestations/x/bundle', '/v1/attestationsx', '/v1/issuer-keys', '/v1/issuer-keys/x', '/v1/public/anchors', '/v1/public/anchors/x',
  '/v1/console/attestations', '/v1/console/attestations/signed', '/v1/console/tx/abc', '/v1/console/tx', '/v1/console/audit', '/v1/console/me', '/v1/console/dashboard', '/v1/console/products', '/v1/console/sandbox',
  '/v1/console/sandbox/evidence', '/v1/console/keys', '/v1/settlements', '/v1/settlements/PAY-1/cancel', '/v1/settlementsx', '/v1/quotes', '/v1/manifests/2026-11-18', '/v1/remit/institutions', '/v1/remit', '/v1/por',
  '/v1/por/snapshots', '/v1/porx', '/v1/sandbox/keys', '/', '', '/V1/ATTESTATIONS', '/v1/console/audit/', '/healthz/'];
const audit = paths.map((p) => ({ path: p, service: serviceOf(p), audited: Object.fromEntries(['GET', 'POST', 'HEAD', 'DELETE'].map((m) => [m, isAudited(m, p)])) }));
const cookieHeaders = [null, '', 'stonehash_session=abc', 'a=b; stonehash_session=abc; c=d', 'stonehash_session=abc; stonehash_session=def', 'stonehash_session=', 'stonehash_session=; stonehash_session=def',
  ' stonehash_session = abc ', 'stonehash_session=a=b=c', 'Stonehash_Session=abc', 'xstonehash_session=abc', 'stonehash_session', '=abc', ';;;', 'a; =b; stonehash_session=; x=y', 'stonehash_session="quoted"',
  'stonehash_session=a b', 'stonehash_session=%41', 'a=b;stonehash_session=abc', 'stonehash_session=abc;', '\u00a0stonehash_session\u00a0=\u00a0abc\u00a0', 'stonehash_session=abc, other=1'];
const cookies = cookieHeaders.map((header) => ({ header, token: cookieToken(header ?? undefined) ?? null }));
const addresses = [];
for (const xff of [null, '', ' ', '198.51.100.1', '198.51.100.1, 10.0.0.1', ' 198.51.100.2 ,10.0.0.1', ',10.0.0.1', ' , ', 'unknown', '\u00a0198.51.100.3\u00a0', '2001:db8::1', '198.51.100.1,']) {
  for (const socket of ['127.0.0.1', null]) for (const trustProxy of [true, false]) {
    addresses.push({ xff, socket, trustProxy, key: clientKey(xff === null ? {} : { 'x-forwarded-for': xff }, socket ?? undefined, trustProxy) });
  }
}
const limiters = [[{ windowMs: 1000, max: 3 }, [['a', 0], ['a', 1], ['a', 2], ['a', 3], ['a', 999], ['b', 999], ['a', 1000], ['a', 1001], ['a', 1500], ['a', 1999], ['a', 2000], ['b', 1998], ['b', 1999]]],
  [{ windowMs: 3_600_000, max: 1 }, [['x', 10], ['x', 11], ['x', 1010], ['x', 3_599_010], ['x', 3_600_009], ['x', 3_600_010], ['x', 3_600_011]]],
  [{ windowMs: 500, max: 0 }, [['z', 0], ['z', 1], ['z', 499], ['z', 500], ['z', 501]]],
  [{ windowMs: 0, max: 2 }, [['w', 5], ['w', 5], ['w', 5]]]].map(([options, events]) => {
  const l = new RateLimiter(options);
  return { options, events: events.map(([key, now]) => ({ key, now, wait: l.check(key, now) })) };
});

const text = `${JSON.stringify({
  note: 'Generated by apps/core-java/tools/make-http-vectors.mjs from Node and from apps/core/src. Do not edit by hand.',
  requestTargets, decode, limits, settings, audit, cookies, addresses, limiters,
}, null, 1)}\n`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('http.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`http.json is current (${requestTargets.length} targets, ${settings.length} settings)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${requestTargets.length} targets (${requestTargets.filter((t) => t.fails).length} refused), ${decode.length} escapes, `
    + `${limits.length} page sizes, ${settings.length} settings (${settings.filter((s) => s.error).length} refused)`);
}
