/**
 * The sandbox console's API: who is let in, signing up, in and out, the
 * records and their allowance, API keys, issuer keys, the dashboard, the
 * audit trail, billing and the product screen. What it starts from is seeded
 * (tools/seed-reference.mjs): the console's organisation with records of all
 * three products in two months, an organisation one record short of its
 * allowance, accounts whose stored password is not what a new one gets, and
 * an audit trail of 70 rows.
 *
 * The order matters. The audit trail and the views are read first, while
 * every row is a seeded one and can be compared whole; then the cases that
 * write. Signing up and signing in are capped per address (CONSOLE_AUTH_MAX,
 * the same in both env files): every such request names the address it comes
 * from, five to an address, so that one group does not use up another's
 * allowance.
 *
 * Nothing here inscribes a document: the Java service of this run holds a
 * wallet that can pay, the reference of this run does not. The inscription
 * cases are refusals, each one before the wallet is asked for anything — and
 * no case rests on that one refusal alone: where the door is under test the
 * request carries no document, where it is the allowance the document is one
 * the organisation has already, and everywhere else it is longer than this
 * deployment inscribes (parity/documents.mjs). A build in which the rule
 * under test is broken then answers something else, and still inscribes
 * nothing. (A build with the allowance check broken on purpose once did.)
 */
import { overLimit } from '../documents.mjs';
import { createHash, generateKeyPairSync } from 'node:crypto';

const J = { 'Content-Type': 'application/json' };
const sess = (token) => ({ Cookie: `stonehash_session=${token}` });
const digest = (label) => createHash('sha256').update(`parity console run: ${label}`).digest('hex');
const cursorOf = (at, id) => Buffer.from(JSON.stringify({ c: at, i: id }), 'utf8').toString('base64url');
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const NEW = ['$.id', '$.created_at'];
const LOGIN = ['$.account.last_login_at'];
const SIGNED_UP = ['$.account.id', '$.account.created_at', '$.account.last_login_at', '$.org.id', '$.org.slug', '$.org.created_at',
  '$.api_key.id', '$.api_key.created_at', /^\$\.issuer_keys\[\d+\]\.(id|created_at)$/, '$.api_key_secret'];
const DUP = [[/attested as [0-9a-f-]{36}/, 'attested as <id>']];
const WAIT = { blur: [[/retry in \d+s/, 'retry in <n>s']] };
const UUIDS = [[/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>']];

export default async ({ seed, ref, exchange }) => {
  // These cases are for a deployment that has a console. Where the reference says it has none (switched off, or a
  // live deployment), parity/cases/console-off.mjs has the cases instead.
  if ((await exchange(ref, { target: '/v1/console/me' })).status !== 401) return [];
  const LIMIT = JSON.parse((await exchange(ref, { target: '/v1/meta' })).body.toString('utf8')).inscription.max_bytes;
  const C = seed.console;
  const main = sess(C.sessions.main);
  const other = sess(C.sessions.other);
  const quota = sess(C.sessions.quota);
  const cases = [];
  const add = (...c) => cases.push(...c);
  const get = (name, target, headers = {}, extra = {}) => ({ name, target, headers, ...extra });
  const post = (name, target, headers, body, extra = {}) => ({ name, method: 'POST', target, headers: { ...J, ...headers }, body, ...extra });
  // Signing up and signing in: five requests to an address.
  let knocks = 0;
  const door = () => ({ 'X-Forwarded-For': `198.51.100.${100 + Math.floor(knocks++ / 5)}` });

  // ── the audit trail, while every row is a seeded one ──────────────────────
  const a = '/v1/console/audit';
  const hour = (n) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 12) + 3_600_000 * n).toISOString();
  add(
    get('the audit trail, the default page', a, main, { capture: { page2: '$.page.next_cursor' } }),
    get('the audit trail, the page after it', `${a}?cursor={page2}`, main),
    get('the audit trail of an organisation with one row', a, quota),
    // The keyed cases before these acted as that organisation: its rows are theirs, new on each side.
    get('the audit trail of another organisation', a, other, { volatile: [/^\$\.data\[\d+\]\.(id|at|duration_ms)$/] }),
  );
  for (const [k, values] of [
    ['service', ['attest', 'remit', 'por', 'console', 'billing', 'ATTEST', '', 'attest&service=remit', '%20attest']],
    ['actor_type', ['api_key', 'session', 'robot', '', 'Session']],
    ['from', [hour(60), hour(60).replace('Z', '+09:00'), hour(60).slice(0, 10), hour(60).slice(0, 19), hour(60).slice(0, 16), hour(60).replace('T', '%20'), hour(60).replace('.000Z', 'Z'),
      'yesterday', '2026-13-01', '2026-02-30T00:00:00Z', '', '2026', '2026-11', '2099-01-01T00:00:00Z', '%2B010000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z']],
    ['to', [hour(10), hour(10).replace('Z', '-05:30'), 'tomorrow', '', '1970-01-01T00:00:00Z']],
    ['q', ['keys', 'KEYS', 'k_1', '%25', '_', '!', 'p-today', '%2Fv1%2Fpor', 'nothing-like-this', '', '%20', '%C3%A9', '100%2525_DONE']],
    ['limit', ['1', '0', '-5', '2.9', '200', '201', '5000', 'abc', '', '1e1', '0x10', 'Infinity', '-Infinity', '%207%20', '7&limit=1', '00012', '1_0']],
  ]) {
    for (const v of values) add(get(`the audit trail with ${k}=${v}`, `${a}?${k}=${v}`, main));
  }
  // Times the JavaScript engine reads and ISO 8601 does not have: the reference took them as bounds (D-04).
  for (const v of ['1', 'Nov%2018%202026', '2026%2F11%2F01', '2026-3-2']) add(get(`the audit trail from a time only the engine reads: ${v}`, `${a}?from=${v}`, main));
  add(
    get('the audit trail of one hour', `${a}?from=${hour(20)}&to=${hour(21)}`, main),
    get('the audit trail from after to', `${a}?from=${hour(30)}&to=${hour(20)}`, main),
    get('the audit trail by service, actor and a piece of the path', `${a}?service=console&actor_type=session&q=keys&limit=3`, main, { capture: { narrowed: '$.page.next_cursor' } }),
    get('the same, the next page', `${a}?service=console&actor_type=session&q=keys&limit=3&cursor={narrowed}`, main),
    get('the audit trail with a bad service and a bad cursor', `${a}?service=billing&cursor=nope`, main),
    get('the audit trail with a bad time and a bad cursor', `${a}?from=yesterday&cursor=nope`, main),
    get('the audit trail with a bad actor and a bad time', `${a}?actor_type=robot&to=never`, main),
    // One row to a page: the newest two share a time, so the second page is found by the id.
    get('the audit trail, one row', `${a}?limit=1`, main, { capture: { one: '$.page.next_cursor' } }),
    get('the audit trail, the second row', `${a}?limit=1&cursor={one}`, main, { capture: { two: '$.page.next_cursor' } }),
    get('the audit trail, the third row', `${a}?limit=1&cursor={two}`, main),
    // A cursor written here the way the reference writes one: the place after the seeded row 40.
    get('the audit trail after a cursor made elsewhere', `${a}?limit=4&cursor=${cursorOf(hour(40), '00000000-0000-4000-8000-000000000040')}`, main),
    get('the audit trail after a cursor before every row', `${a}?cursor=${cursorOf('2000-01-01T00:00:00.000Z', 'x')}`, main),
    get('the audit trail after a cursor after every row', `${a}?limit=2&cursor=${cursorOf('2999-01-01T00:00:00.000Z', 'x')}`, main),
    get('the audit trail after a cursor with more in it', `${a}?limit=2&cursor=${b64url(JSON.stringify({ i: '00000000-0000-4000-8000-000000000040', x: [1, { y: null }], c: hour(40) }))}`, main),
    get('the audit trail after a cursor in the other base64 alphabet', `${a}?limit=2&cursor=${encodeURIComponent(Buffer.from(JSON.stringify({ c: hour(40), i: '00000000-0000-4000-8000-00000000004?' })).toString('base64'))}`, main),
    get('the audit trail after a cursor of another organisation\'s row', `${a}?limit=2&cursor=${cursorOf(hour(0), '00000000-0000-4000-8000-000000000071')}`, other),
  );
  for (const [name, cursor] of [['a word', 'nope'], ['an empty object', b64url('{}')], ['a list', b64url('[]')], ['null', b64url('null')], ['a number', b64url('5')], ['text', b64url('"c"')],
    ['a time that is a number', b64url('{"c":1,"i":"x"}')], ['no id', b64url('{"c":"x"}')], ['an id that is null', b64url('{"c":"x","i":null}')], ['not JSON', b64url('{"c":"x","i":"y"')],
    ['percent signs', '%25%25%25'], ['bytes that are not text', '_____w'], ['one character', 'e']]) {
    add(get(`the audit trail after a cursor that is ${name}`, `${a}?cursor=${cursor}`, main));
  }

  // ── the views, on what was seeded ─────────────────────────────────────────
  add(
    get('the overview', '/v1/console/me', main),
    get('the overview of a colleague', '/v1/console/me', sess(C.sessions.colleague)),
    // The keyed cases before these registered a key for that organisation: its keys come in no particular order.
    get('the overview of another organisation', '/v1/console/me', other, { volatile: [/^\$\.issuer_keys\[\d+\]\.(id|created_at)$/], unordered: { '$.issuer_keys': 'label' } }),
    get('the overview of an organisation near its allowance', '/v1/console/me', quota),
    get('the overview with the session among other cookies', '/v1/console/me', { Cookie: `theme=dark; stonehash_session=${C.sessions.main}; other=1` }),
    get('the overview with the session in a second cookie header', '/v1/console/me', { Cookie: 'a=b', cookie: `stonehash_session=${C.sessions.main}` }),
    get('the overview with two session cookies, the first one nobody\'s', '/v1/console/me', { Cookie: `stonehash_session=nobody; stonehash_session=${C.sessions.main}` }),
    get('the overview with a session and a query', '/v1/console/me?x=1', main),
    get('the overview with a slash after it', '/v1/console/me/', main),
    get('the dashboard', '/v1/console/dashboard', main, { volatile: ['$.generated_at'] }),
    get('the dashboard of a colleague', '/v1/console/dashboard', sess(C.sessions.colleague), { volatile: ['$.generated_at'] }),
    get('the dashboard of another organisation', '/v1/console/dashboard', other, { volatile: ['$.generated_at', /^\$\.attest\.recent\[\d+\]\.(id|created_at)$/] }),
    get('the dashboard of an organisation near its allowance', '/v1/console/dashboard', quota, { volatile: ['$.generated_at'] }),
    get('the products', '/v1/console/products', main),
    get('the products of another organisation', '/v1/console/products', other),
    get('the products of an organisation with one switched off', '/v1/console/products', quota),
    get('the records', '/v1/console/attestations', main),
    get('the records of another organisation', '/v1/console/attestations', other, { volatile: [/^\$\.data\[\d+\]\.(id|created_at)$/] }),
    get('the records of an organisation near its allowance', '/v1/console/attestations', quota),
    get('the keys', '/v1/console/keys', main),
    get('the keys of another organisation', '/v1/console/keys', other),
    get('the issuer keys', '/v1/console/issuer-keys', main),
    get('the issuer keys of another organisation', '/v1/console/issuer-keys', other, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
  );
  for (const limit of ['1', '2', '0', '-1', '2.5', 'abc', '1e1', '500', '501', '', '%203%20', '0x3', '4&limit=1']) add(get(`the records with limit=${limit}`, `/v1/console/attestations?limit=${limit}`, main));
  for (const product of ['attest', 'remit', 'por', '', 'ATTEST', 'console', 'attest&product=remit', 'remit&limit=1', '%20attest', 'attest%00']) {
    add(get(`the records with product=${product}`, `/v1/console/attestations?product=${product}`, main));
  }
  add(get('the records of one product of an organisation near its allowance', '/v1/console/attestations?product=por', quota), get('the records with a bad product and a bad limit', '/v1/console/attestations?product=x&limit=x', main));
  const R = C.ids;
  const records = [...R.attest.confirmed, R.attest.signedRegistered, R.attest.signedUnregistered, ...R.attest.lastMonth, ...R.attest.submitted, ...R.attest.batched, ...R.attest.accepted,
    R.remit.lastMonth, R.remit.confirmed, R.remit.submitted, R.remit.accepted, R.por.lastMonth, R.por.confirmed, R.por.accepted, R.inscription.confirmed, R.inscription.submitted];
  for (const id of records) add(get(`the bundle of ${id}`, `/v1/console/attestations/${id}/bundle`, main, { volatile: ['$.generated_at'] }));
  add(
    get('the bundle of a record of another organisation', `/v1/console/attestations/${seed.ids.confirmed[0]}/bundle`, main),
    get('the bundle of the console\'s record, asked by another organisation', `/v1/console/attestations/${R.attest.confirmed[0]}/bundle`, other),
    get('the bundle of a record nobody made', '/v1/console/attestations/00000000-0000-4000-8000-000000000000/bundle', main),
    get('the bundle of a record id in upper case', `/v1/console/attestations/${R.attest.confirmed[0].toUpperCase()}/bundle`, main),
    get('the bundle of a record through the keyed route, with the session', `/v1/attestations/${R.attest.confirmed[0]}/bundle`, main, { volatile: ['$.generated_at'] }),
    get('a record through the keyed route, with the session', `/v1/attestations/${R.remit.confirmed}`, main),
  );
  // A transaction of the organisation's own anchors, as the node sees it. These were never broadcast (the seed
  // builds them and sends nothing), so the node knows none of them — and says so through both services.
  const t = '/v1/console/tx';
  for (const [name, txid] of Object.entries(R.txids)) add(get(`the transaction ${name}`, `${t}/${txid}`, main));
  add(
    get('a transaction in upper case', `${t}/${R.txids.reveal.toUpperCase()}`, main),
    get('a transaction of the console\'s, asked by another organisation', `${t}/${R.txids.batchConfirmed}`, other),
    get('a transaction nobody anchored with', `${t}/${'0'.repeat(64)}`, main),
    get('a transaction id one character short', `${t}/${'a'.repeat(63)}`, main),
    get('a transaction id one character long', `${t}/${'a'.repeat(65)}`, main),
    get('a transaction id that is not hex', `${t}/${'g'.repeat(64)}`, main),
    get('a transaction id with a space', `${t}/${'a'.repeat(63)}%20`, main),
    get('a transaction id with a line end', `${t}/${'a'.repeat(64)}%0A`, main),
    get('no transaction id', `${t}/`, main),
  );

  // ── who is let in ─────────────────────────────────────────────────────────
  const someKey = C.keys.primary.id;
  const routes = [['GET', '/v1/console/me'], ['GET', '/v1/console/dashboard'], ['GET', '/v1/console/audit'], ['GET', '/v1/console/attestations'], ['POST', '/v1/console/attestations'],
    ['POST', '/v1/console/attestations/inscribe'], ['POST', '/v1/console/attestations/signed'], ['GET', '/v1/console/issuer-keys'], ['POST', '/v1/console/issuer-keys'],
    ['POST', `/v1/console/issuer-keys/${C.issuerKeys.spare}/revoke`], ['GET', `/v1/console/tx/${R.txids.reveal}`], ['GET', `/v1/console/attestations/${R.attest.confirmed[0]}/bundle`],
    ['GET', '/v1/console/keys'], ['POST', '/v1/console/keys'], ['POST', `/v1/console/keys/${someKey}/label`], ['POST', `/v1/console/keys/${someKey}/revoke`], ['POST', '/v1/console/keys/rotate'],
    ['POST', '/v1/console/sessions/revoke-others'], ['GET', '/v1/console/products'], ['POST', '/v1/console/products']];
  for (const [method, target] of routes) {
    // No document for the inscription route: were the door ever open, there would be nothing to inscribe.
    const body = method === 'POST' && !target.endsWith('/inscribe') ? {} : undefined;
    const base = { method, target, ...(body === undefined ? {} : { body }) };
    add(
      { name: `${method} ${target} without a session`, ...base, headers: method === 'POST' ? J : {} },
      { name: `${method} ${target} with a session nobody has`, ...base, headers: { ...(method === 'POST' ? J : {}), Cookie: 'stonehash_session=nobody' } },
      { name: `${method} ${target} with the session of a disabled account`, ...base, headers: { ...(method === 'POST' ? J : {}), ...sess(C.sessions.disabled) } },
      { name: `${method} ${target} with an API key and no session`, ...base, headers: { ...(method === 'POST' ? J : {}), Authorization: `Bearer ${C.keys.primary.secret}` } },
    );
  }
  add(
    get('the overview with an expired session', '/v1/console/me', sess(C.sessions.expired)),
    get('the overview with the expired session again', '/v1/console/me', sess(C.sessions.expired)),
    get('the overview with an empty session cookie', '/v1/console/me', { Cookie: 'stonehash_session=' }),
    get('the overview with the session cookie under another name', '/v1/console/me', { Cookie: `Stonehash_Session=${C.sessions.main}` }),
    get('the overview with the session in quotes', '/v1/console/me', { Cookie: `stonehash_session="${C.sessions.main}"` }),
    get('the overview with spaces around the session', '/v1/console/me', { Cookie: `  stonehash_session =  ${C.sessions.main}  ` }),
    { name: 'the overview with another method', method: 'POST', target: '/v1/console/me', headers: main },
    { name: 'the records with another method', method: 'PUT', target: '/v1/console/attestations', headers: main },
  );

  // ── signing in ────────────────────────────────────────────────────────────
  const li = '/v1/console/login';
  const login = (name, body, extra = {}) => post(name, li, door(), body, extra);
  add(
    login('signing in', { email: C.account.email, password: C.account.password }, { volatile: LOGIN, capture: { s1: 'cookie:stonehash_session' } }),
    get('the overview as the session just made', '/v1/console/me', { Cookie: 'stonehash_session={s1}' }, { volatile: LOGIN }),
    login('signing in with the address in capitals and spaces', { email: `  ${C.account.email.toUpperCase()}\n`, password: C.account.password }, { volatile: LOGIN }),
    login('signing in with a wrong password', { email: C.account.email, password: `${C.account.password}!` }),
    login('signing in with the password in capitals', { email: C.account.email, password: C.account.password.toUpperCase() }),
    login('signing in with a space after the password', { email: C.account.email, password: `${C.account.password} ` }),
    login('signing in with an empty password', { email: C.account.email, password: '' }),
    login('signing in with no password', { email: C.account.email }),
    login('signing in with a password that is a number', { email: C.account.email, password: 12345678901 }),
    login('signing in with a password that is null', { email: C.account.email, password: null }),
    login('signing in with a password that is a list', { email: C.account.email, password: [C.account.password] }),
    login('signing in with an address nobody registered', { email: 'nobody@parity.example', password: C.account.password }),
    login('signing in with no address', { password: C.account.password }),
    login('signing in with an address that is not one', { email: 'console', password: C.account.password }),
    login('signing in with an address that is a number', { email: 5, password: C.account.password }),
    login('signing in with nothing', {}),
    login('signing in to a disabled account', { email: C.accounts.disabled.email, password: C.accounts.disabled.password }),
    login('signing in to an account made with other parameters', { email: C.accounts.otherParameters.email, password: C.accounts.otherParameters.password }, { volatile: LOGIN, capture: { odd: 'cookie:stonehash_session' } }),
    login('signing in to that account with a wrong password', { email: C.accounts.otherParameters.email, password: 'made with other parameters?' }),
    login('signing in to an account with a longer digest', { email: C.accounts.longerDigest.email, password: C.accounts.longerDigest.password }, { volatile: LOGIN }),
    login('signing in to an account whose stored password is cut short', { email: C.accounts.malformed.email, password: C.accounts.malformed.password }),
    login('signing in to an account whose stored parameters cannot be computed', { email: C.accounts.badParameters.email, password: C.accounts.badParameters.password }),
    login('signing in to an account stored under another scheme', { email: C.accounts.otherScheme.email, password: C.accounts.otherScheme.password }),
    login('signing in to another organisation', { email: C.accounts.other.email, password: C.accounts.other.password }, { volatile: [...LOGIN, /^\$\.issuer_keys\[\d+\]\.(id|created_at)$/], unordered: { '$.issuer_keys': 'label' } }),
    login('signing in with a user agent of 300 characters', { email: C.account.email, password: C.account.password }, { volatile: LOGIN, headers: { ...J, ...door(), 'User-Agent': 'u'.repeat(300) } }),
    { name: 'signing in with no body', method: 'POST', target: li, headers: door() },
    login('signing in with a body that is not JSON', '{"email":'),
    login('signing in with a body that is null', 'null'),
    login('signing in with a body that is a list', '[]'),
    login('signing in with a body that is text', '"console@parity.example"'),
    login('signing in with a body that is a number', '7'),
    login('signing in with a body over 1 MiB', `{"email":"${C.account.email}","password":"${'p'.repeat(1 << 20)}"}`),
    { name: 'signing in with another method', target: li, headers: door() },
    get('the overview of the account made with other parameters', '/v1/console/me', { Cookie: 'stonehash_session={odd}' }, { volatile: LOGIN }),
    get('the products of an organisation with one product', '/v1/console/products', { Cookie: 'stonehash_session={odd}' }),
    get('the dashboard of an organisation with nothing in it', '/v1/console/dashboard', { Cookie: 'stonehash_session={odd}' }, { volatile: ['$.generated_at'] }),
  );
  // One address, until its allowance is used up: every knock counts, whatever it is answered — and both doors count together.
  const crowd = { 'X-Forwarded-For': '203.0.113.9' };
  for (let i = 1; i <= 4; i++) add(post(`sign-in ${i} from one address`, li, crowd, { email: 'nobody@parity.example', password: 'x' }, WAIT));
  for (let i = 5; i <= 6; i++) add(post(`sign-up ${i} from that address`, '/v1/console/signup', crowd, { email: 'not-an-address', password: 'x' }, WAIT));
  add(
    post('sign-in 7 from that address', li, crowd, { email: C.account.email, password: C.account.password }, WAIT),
    post('sign-up 8 from that address', '/v1/console/signup', crowd, { email: 'held-back@parity.example', password: 'a password long enough' }, WAIT),
    post('a sign-in from that address, with a body that is not JSON', li, crowd, '{', WAIT),
    post('the first of several addresses in the header decides', li, { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' }, { email: 'nobody@parity.example', password: 'x' }, WAIT),
    post('another address is not held back', li, { 'X-Forwarded-For': ' 203.0.113.10 , 203.0.113.9' }, { email: 'nobody@parity.example', password: 'x' }, WAIT),
    get('that address may still do what needs no knock', '/v1/console/me', { ...main, ...crowd }, { volatile: LOGIN }),
    { name: 'signing out from that address', method: 'POST', target: '/v1/console/logout', headers: crowd },
  );

  // ── signing up ────────────────────────────────────────────────────────────
  const su = '/v1/console/signup';
  const signup = (name, body, extra = {}) => post(name, su, door(), body, extra);
  const FIRST = [/^\$\.data\[0\]\.(id|created_at|org_id|leaf_bytes)$/];
  add(
    signup('signing up', { email: 'new-1@parity.example', password: 'a password long enough' }, { volatile: SIGNED_UP, capture: { n1: 'cookie:stonehash_session', n1key: '$.api_key_secret', n1keyId: '$.api_key.id' } }),
    get('the overview of the new account', '/v1/console/me', { Cookie: 'stonehash_session={n1}' }, { volatile: SIGNED_UP }),
    get('the records of the new account: the sample', '/v1/console/attestations', { Cookie: 'stonehash_session={n1}' }, { volatile: FIRST }),
    get('the key of the new account works on the keyed API', '/v1/attestations', { Authorization: 'Bearer {n1key}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at|leaf_bytes)$/] }),
    get('the keys of the new account', '/v1/console/keys', { Cookie: 'stonehash_session={n1}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    get('the issuer keys of the new account: the placeholder', '/v1/console/issuer-keys', { Cookie: 'stonehash_session={n1}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/], capture: { n1placeholder: '$.data[0].id' } }),
    get('the products of the new account', '/v1/console/products', { Cookie: 'stonehash_session={n1}' }, { volatile: ['$.products[0].created_at'] }),
    get('the dashboard of the new account', '/v1/console/dashboard', { Cookie: 'stonehash_session={n1}' }, { volatile: ['$.generated_at', /^\$\.attest\.recent\[0\]\.(id|created_at|leaf_bytes)$/] }),
    get('the audit trail of the new account: signing up', '/v1/console/audit', { Cookie: 'stonehash_session={n1}' }, { volatile: [/^\$\.data\[\d+\]\.(id|at|duration_ms|actor_id)$/] }),
    signup('signing up with the same address', { email: 'new-1@parity.example', password: 'another password entirely' }),
    signup('signing up with the same address in capitals', { email: ' NEW-1@Parity.Example ', password: 'another password entirely' }),
    signup('signing up with an address that is seeded', { email: C.account.email, password: 'another password entirely' }),
    signup('signing up with an address in capitals and spaces', { email: '  New-2@Parity.Example \n', password: 'a password long enough' }, { volatile: SIGNED_UP }),
    post('signing in to the account made in capitals', li, door(), { email: 'new-2@parity.example', password: 'a password long enough' }, { volatile: SIGNED_UP }),
    signup('signing up with a password of exactly ten characters', { email: 'new-3@parity.example', password: '0123456789' }, { volatile: SIGNED_UP }),
    signup('signing up with a password of ten characters as the language counts them', { email: 'new-4@parity.example', password: '😀😀😀😀😀' }, { volatile: SIGNED_UP }),
    post('signing in with that password', li, door(), { email: 'new-4@parity.example', password: '😀😀😀😀😀' }, { volatile: SIGNED_UP }),
    signup('signing up with a password of two hundred characters', { email: 'new-5@parity.example', password: 'p'.repeat(200) }, { volatile: SIGNED_UP }),
    signup('signing up with a password of nine characters', { email: 'new-6@parity.example', password: '012345678' }),
    signup('signing up with a password of two hundred and one characters', { email: 'new-6@parity.example', password: 'p'.repeat(201) }),
    signup('signing up with a password that is a number', { email: 'new-6@parity.example', password: 12345678901 }),
    signup('signing up with a password that is null', { email: 'new-6@parity.example', password: null }),
    signup('signing up with no password', { email: 'new-6@parity.example' }),
    signup('signing up with no address', { password: 'a password long enough' }),
    signup('signing up with an address that is a number', { email: 7, password: 'a password long enough' }),
    signup('signing up with an address with no dot', { email: 'new@parity', password: 'a password long enough' }),
    signup('signing up with an address with a space', { email: 'new 6@parity.example', password: 'a password long enough' }),
    signup('signing up with an address with two at signs', { email: 'new@6@parity.example', password: 'a password long enough' }),
    signup('signing up with an address ending in a dot', { email: 'new-6@parity.example.', password: 'a password long enough' }),
    signup('signing up with an address of four characters', { email: 'a@b.', password: 'a password long enough' }),
    signup('signing up with an address of 255 characters', { email: `${'a'.repeat(243)}@parity.test`, password: 'a password long enough' }),
    signup('signing up with a no-break space in the address', { email: 'new 6@parity.example', password: 'a password long enough' }),
    signup('signing up with a bad address and a bad password', { email: 'nope', password: 'short' }),
    signup('signing up with nothing', {}),
    { name: 'signing up with no body', method: 'POST', target: su, headers: door() },
    signup('signing up with a body that is not JSON', '{"email":'),
    signup('signing up with a body that is null', 'null'),
    signup('signing up with a body that is a list', '[]'),
    signup('signing up with a body over 1 MiB', `{"email":"new-7@parity.example","password":"${'p'.repeat(1 << 20)}"}`),
    { name: 'signing up with another method', target: su, headers: door() },
    get('the address that was held back has no account', '/v1/console/me', { Cookie: 'stonehash_session=' }),
    post('and cannot sign in', li, door(), { email: 'held-back@parity.example', password: 'a password long enough' }),
  );

  // ── signing out ───────────────────────────────────────────────────────────
  const lo = '/v1/console/logout';
  add(
    get('the overview with the third session', '/v1/console/me', sess(C.sessions.third), { volatile: LOGIN }),
    { name: 'signing out', method: 'POST', target: lo, headers: sess(C.sessions.third) },
    get('the overview with the session signed out', '/v1/console/me', sess(C.sessions.third)),
    { name: 'signing out again', method: 'POST', target: lo, headers: sess(C.sessions.third) },
    { name: 'signing out with no session', method: 'POST', target: lo },
    { name: 'signing out with a session nobody has', method: 'POST', target: lo, headers: { Cookie: 'stonehash_session=nobody' } },
    { name: 'signing out with a body that is not JSON', method: 'POST', target: lo, headers: J, body: '{' },
    { name: 'signing out with another method', target: lo, headers: main },
    get('the first session is untouched by it', '/v1/console/me', main, { volatile: LOGIN }),
  );

  // ── handing in a digest ───────────────────────────────────────────────────
  const r = '/v1/console/attestations';
  const create = (name, body, extra = {}) => post(name, r, main, body, extra);
  add(
    create('a digest', { sha256: digest('first') }, { volatile: NEW, capture: { made: '$.id' } }),
    get('the bundle of a record just made', '/v1/console/attestations/{made}/bundle', main, { blur: UUIDS }),
    create('the same digest again', { sha256: digest('first') }, { blur: DUP }),
    create('the same digest in capitals', { sha256: digest('first').toUpperCase() }, { blur: DUP }),
    create('a digest as leaf_bytes', { leaf_bytes: digest('second') }, { volatile: NEW }),
    create('a digest under both names', { sha256: digest('third'), leaf_bytes: digest('never used') }, { volatile: NEW }),
    create('a digest under leaf_bytes, sha256 null', { sha256: null, leaf_bytes: digest('fourth') }, { volatile: NEW }),
    create('a digest in capitals', { sha256: digest('fifth').toUpperCase() }, { volatile: NEW }),
    create('a digest with a content type and a descriptor', { sha256: digest('sixth'), content_type: 'application/pdf', descriptor: { invoice: 'INV-9', n: 1, list: [1, 'a', null], nested: { 2: 'b', 1: 'a' } } }, { volatile: NEW }),
    create('a digest with a descriptor that is text', { sha256: digest('seventh'), descriptor: 'just text' }, { volatile: NEW }),
    create('a digest with a content type that is a number', { sha256: digest('eighth'), content_type: 5 }, { volatile: NEW }),
    create('a digest with a content type that is true', { sha256: digest('ninth'), content_type: true }, { volatile: NEW }),
    create('a digest with a content type that is null', { sha256: digest('tenth'), content_type: null, descriptor: null }, { volatile: NEW }),
    create('a digest that the other organisation has too', { sha256: seed.digests.accepted0 }, { volatile: NEW }),
    create('no digest', {}),
    create('a digest that is a number', { sha256: 5 }),
    create('a digest that is a number, leaf_bytes given', { sha256: 5, leaf_bytes: digest('never used') }),
    create('a digest that is false, leaf_bytes given', { sha256: false, leaf_bytes: digest('never used') }),
    create('a digest that is a list', { sha256: [digest('never used')] }),
    create('an empty digest', { sha256: '' }),
    create('a digest one character short', { sha256: digest('never used').slice(1) }),
    create('a digest that is not hex', { sha256: 'z'.repeat(64) }),
    create('a digest with a space after it', { sha256: `${digest('never used')} ` }),
    create('a body that is not JSON', '{"sha256":'),
    create('a body that is null', 'null'),
    create('a body that is a list', '[]'),
    create('a body that is text', `"${digest('never used')}"`),
    create('a body over 1 MiB', `{"sha256":"${digest('never used')}","pad":"${'a'.repeat(1 << 20)}"}`),
    { name: 'a digest with no body at all', method: 'POST', target: r, headers: main },
    post('a digest handed in by the other organisation', r, other, { sha256: digest('first') }, { volatile: NEW }),
  );

  // ── handing in a signed statement ─────────────────────────────────────────
  const sg = '/v1/console/attestations/signed';
  const tampered = { ...C.signed.es256Again, document: { ...C.signed.es256Again.document, sha256: digest('tampered') } };
  add(
    post('a signed statement, its key not on file', sg, main, { statement: C.signed.es256 }, { volatile: NEW }),
    post('the same statement again', sg, main, { statement: C.signed.es256 }, { blur: DUP }),
    post('a signed statement under RS256', sg, main, { statement: C.signed.rs256, descriptor: { ignored: true } }, { volatile: NEW }),
    post('a signed statement, its key on file', sg, main, { statement: C.signed.onFile }, { volatile: NEW }),
    post('a signed statement that was changed after signing', sg, main, { statement: tampered }),
    post('a signed statement with no signature', sg, main, { statement: { ...C.signed.es256Again, signature: undefined } }),
    post('a statement that is text', sg, main, { statement: 'signed' }),
    post('a statement that is a number', sg, main, { statement: 0 }),
    post('a statement that is null', sg, main, { statement: null }),
    post('a statement that is a list', sg, main, { statement: [C.signed.es256Again] }),
    post('a statement that is an empty object', sg, main, { statement: {} }),
    post('no statement', sg, main, {}),
    post('a signed body that is not JSON', sg, main, '{'),
    post('a signed body that is null', sg, main, 'null'),
    post('a signed body that is a list', sg, main, '[]'),
    post('a signed body over 1 MiB', sg, main, `{"statement":{"pad":"${'a'.repeat(1 << 20)}"}}`),
    { name: 'a signed statement with no body at all', method: 'POST', target: sg, headers: main },
  );

  // ── handing in the document itself: refusals only ─────────────────────────
  const ins = '/v1/console/attestations/inscribe';
  const doc = (name, body, headers = { 'Content-Type': 'text/plain' }, extra = {}) => ({ name, method: 'POST', target: ins, headers: { ...main, ...headers }, body, ...extra });
  // No case rests on the one refusal it is about: every document here is longer than this deployment inscribes
  // (parity/documents.mjs), so a build in which the duplicate rule is broken refuses it for its size.
  const known = overLimit('parity console run: a document whose digest was handed in before', LIMIT);
  add(
    doc('no document at all', null),
    doc('a document of no bytes', ''),
    doc('no document and no content type', null, {}),
    create('the digest of a document', { sha256: createHash('sha256').update(known).digest('hex') }, { volatile: NEW }),
    doc('the document of that digest', known, undefined, { blur: DUP }),
    doc('a document that is inscribed already', overLimit('parity console: an inscribed document', LIMIT), undefined, { blur: DUP }),
    doc('a document that is inscribed and not yet in a block', overLimit('parity console: an inscribed document, not yet in a block', LIMIT), {}, { blur: DUP }),
    doc('a document one byte over the limit', Buffer.alloc(LIMIT + 1, 0x61)),
    doc('a document one byte over the upload ceiling', Buffer.alloc(LIMIT + 64 * 1024 + 1, 0x61), undefined, { noAnswer: true }),
  );

  // ── the month's allowance ─────────────────────────────────────────────────
  // Seeded one record short. Only document anchoring's own records of this month count against it.
  add(
    post('the last record of the month', r, quota, { sha256: digest('quota last') }, { volatile: NEW }),
    post('one more than the month allows', r, quota, { sha256: digest('quota over') }),
    post('a digest that is no digest, over the allowance', r, quota, { sha256: 'x' }),
    post('a body that is not JSON, over the allowance', r, quota, '{'),
    post('a signed statement over the allowance', sg, quota, { statement: C.signed.es256Again }),
    post('a signed body that is null, over the allowance', sg, quota, 'null'),
    // A document whose digest that organisation has already (seeded): not read here, and not inscribable either. (Small
    // on purpose: a server that answers without reading a large upload cuts the connection under the sender.)
    { name: 'a document over the allowance', method: 'POST', target: ins, headers: { ...quota, 'Content-Type': 'text/plain' }, body: 'parity seed: quota attest 0' },
    { name: 'no document, over the allowance', method: 'POST', target: ins, headers: quota },
    get('the overview at the allowance', '/v1/console/me', quota),
    // The keyed API has no allowance: the same organisation's key still anchors, and the console counts it.
    post('a digest through the keyed API, at the allowance', '/v1/attestations', { Authorization: `Bearer ${C.keys.quota.secret}` }, { leaf_bytes: digest('quota keyed') }, { volatile: NEW }),
    get('the records at the allowance', '/v1/console/attestations?limit=3', quota, { volatile: [/^\$\.data\[[01]\]\.(id|created_at)$/] }),
    get('the products at the allowance', '/v1/console/products', quota),
  );

  // ── API keys ──────────────────────────────────────────────────────────────
  const k = '/v1/console/keys';
  const MINTED = ['$.id', '$.api_key_secret'];
  const KEYS = [/^\$\.data\[\d+\]\.(id|created_at)$/];
  const key = (name, body, extra = {}) => post(name, k, main, body, { volatile: MINTED, ...extra });
  add(
    key('a new key', {}, { capture: { k1: '$.api_key_secret', k1id: '$.id' } }),
    get('the new key works', '/v1/attestations?limit=1', { Authorization: 'Bearer {k1}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    key('a key with a label', { label: 'deploy' }, { capture: { k2id: '$.id' } }),
    key('a key with a label of 61 characters', { label: 'l'.repeat(61) }),
    key('a key with a label cut inside a character', { label: `${'l'.repeat(59)}😀` }),
    key('a key with control characters and spaces in its label', { label: '\u0000  a\tb\u007f \n' }),
    key('a key with a label that is a number', { label: 5 }),
    key('a key with a label of spaces', { label: ' \t ' }),
    get('the keys, newest first', k, main, { volatile: KEYS }),
    get('the overview shows the newest key', '/v1/console/me', main, { volatile: [...LOGIN, '$.api_key.id', '$.api_key.created_at'] }),
    post('a key with a body that is not JSON', k, main, '{'),
    key('a key with a body that is null', 'null'),
    post('the eleventh key', k, main, { label: 'one too many' }),
    post('the eleventh key, with a body that is not JSON', k, main, '{'),
    // Renaming.
    post('renaming a key', `${k}/${C.keys.ci.id}/label`, main, { label: '  ci, renamed\u0007 ' }),
    post('renaming it to the name it has', `${k}/${C.keys.ci.id}/label`, main, { label: 'ci, renamed' }),
    post('renaming a key to nothing', `${k}/${C.keys.ci.id}/label`, main, {}),
    post('renaming a key with a body that is null', `${k}/${C.keys.ci.id}/label`, main, 'null'),
    post('renaming a key with a body that is not JSON', `${k}/${C.keys.ci.id}/label`, main, '{'),
    post('renaming a key that was revoked', `${k}/${C.keys.revoked.id}/label`, main, { label: 'back' }),
    post('renaming a key of another organisation', `${k}/${C.keys.ci.id}/label`, other, { label: 'taken' }),
    post('renaming a key nobody has', `${k}/00000000-0000-4000-8000-000000000000/label`, main, { label: 'x' }),
    post('renaming a key just made', `${k}/{k2id}/label`, main, { label: 'deploy, renamed' }),
    get('the keys after renaming', k, main, { volatile: KEYS }),
    // Revoking the key a system is using.
    get('a seeded key works', '/v1/attestations?limit=1', { Authorization: `Bearer ${C.keys.ci.secret}` }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    post('revoking a key of another organisation', `${k}/${C.keys.ci.id}/revoke`, other, {}),
    post('revoking that key', `${k}/${C.keys.ci.id}/revoke`, main, {}),
    get('the revoked key no longer works', '/v1/attestations?limit=1', { Authorization: `Bearer ${C.keys.ci.secret}` }),
    post('revoking it again', `${k}/${C.keys.ci.id}/revoke`, main, {}),
    post('revoking a key that was revoked long ago', `${k}/${C.keys.revoked.id}/revoke`, main, {}),
    post('revoking a key nobody has', `${k}/nobody/revoke`, main, {}),
    { name: 'revoking a key with a body that is not JSON', method: 'POST', target: `${k}/{k2id}/revoke`, headers: { ...main, ...J }, body: '{' },
    key('a key again, now that there is room', { label: 'room' }, { capture: { k3: '$.api_key_secret' } }),
    // Rotating: a new key, and the newest of the old ones stopped.
    get('the newest key works', '/v1/attestations?limit=1', { Authorization: 'Bearer {k3}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    post('rotating', `${k}/rotate`, main, {}, { volatile: ['$.api_key_secret', '$.revoked.id', '$.revoked.at'], capture: { rotated: '$.api_key_secret' } }),
    get('the key that was newest no longer works', '/v1/attestations?limit=1', { Authorization: 'Bearer {k3}' }),
    get('the rotated key works', '/v1/attestations?limit=1', { Authorization: 'Bearer {rotated}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    get('an older key still works', '/v1/attestations?limit=1', { Authorization: 'Bearer {k1}' }, { volatile: [/^\$\.data\[0\]\.(id|created_at)$/] }),
    { name: 'rotating with a body that is not JSON', method: 'POST', target: `${k}/rotate`, headers: { ...main, ...J }, body: '{', volatile: ['$.api_key_secret', '$.revoked.id', '$.revoked.at'] },
    post('a key with a body over 1 MiB', k, main, `{"label":"${'l'.repeat(1 << 20)}"}`),
    { name: 'a key with no body at all', method: 'POST', target: k, headers: main, volatile: MINTED },
    post('renaming a key with a body over 1 MiB', `${k}/${C.keys.primary.id}/label`, main, `{"label":"${'l'.repeat(1 << 20)}"}`),
    { name: 'renaming a key with no body at all', method: 'POST', target: `${k}/${C.keys.primary.id}/label`, headers: main },
    get('the keys after rotating', k, main, { volatile: KEYS }),
    // An organisation with no key left: rotating has nothing to stop.
    post('revoking the only key of the new account', `${k}/{n1keyId}/revoke`, { Cookie: 'stonehash_session={n1}' }, {}),
    get('the overview with no key', '/v1/console/me', { Cookie: 'stonehash_session={n1}' }, { volatile: SIGNED_UP }),
    post('rotating with no key to stop', `${k}/rotate`, { Cookie: 'stonehash_session={n1}' }, {}, { volatile: ['$.api_key_secret'] }),
    get('the key of the new account no longer works', '/v1/attestations', { Authorization: 'Bearer {n1key}' }),
  );

  // ── issuer keys ───────────────────────────────────────────────────────────
  const ik = '/v1/console/issuer-keys';
  const spki = (pair) => pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p256b = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const REG = { volatile: ['$.id'] };
  const BY_LABEL = { unordered: { '$.issuer_keys': 'label' } };
  const IKEYS = [/^\$\.data\[\d+\]\.(id|created_at)$/];
  add(
    post('registering an issuer key', ik, main, { public_key: spki(p256), label: 'run key' }, { ...REG, capture: { ik1: '$.id' } }),
    post('registering it again', ik, main, { public_key: spki(p256), label: 'another label' }, REG),
    post('registering it again with spaces around it', ik, main, { public_key: `  ${spki(p256)}\n` }, REG),
    post('registering an RSA key as RS256', ik, main, { public_key: spki(rsa), algorithm: 'RS256', label: `${'r'.repeat(70)}` }, REG),
    post('registering an RSA key as ES256', ik, main, { public_key: spki(rsa) }),
    post('registering a P-384 key as ES256', ik, main, { public_key: spki(p384), algorithm: 'ES256' }),
    post('registering a P-256 key under an algorithm nobody knows', ik, main, { public_key: spki(p256b), algorithm: 'PS256', label: 5 }, { ...REG, capture: { ik2: '$.id' } }),
    post('registering a private key', ik, main, { public_key: p256.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }),
    post('registering a private key in PEM', ik, main, { public_key: p256.privateKey.export({ format: 'pem', type: 'pkcs8' }) }),
    post('registering the sign-up placeholder', ik, main, { public_key: 'DEMO-PUBLIC-KEY-PLACEHOLDER' }),
    post('registering text that is no key', ik, main, { public_key: 'not a key at all' }),
    post('registering a key that is a number', ik, main, { public_key: 5 }),
    post('registering a key of spaces', ik, main, { public_key: '   ' }),
    post('registering no key', ik, main, {}),
    post('registering with a body that is null', ik, main, 'null'),
    post('registering with a body that is not JSON', ik, main, '{'),
    post('registering with a body over 1 MiB', ik, main, `{"public_key":"${'A'.repeat(1 << 20)}"}`),
    { name: 'registering with no body at all', method: 'POST', target: ik, headers: main },
    post('registering a key another organisation has', ik, main, { public_key: C.issuerKeys.spareSpki, label: 'spare again' }, REG),
    get('the issuer keys after registering', ik, main, { volatile: IKEYS }),
    get('the overview after registering', '/v1/console/me', main, { volatile: [...LOGIN, '$.api_key.id', '$.api_key.created_at', /^\$\.issuer_keys\[\d+\]\.(id|created_at)$/], ...BY_LABEL }),
    post('revoking an issuer key', `${ik}/${C.issuerKeys.spare}/revoke`, main, {}),
    post('revoking it again', `${ik}/${C.issuerKeys.spare}/revoke`, main, {}),
    post('revoking an issuer key that was revoked long ago', `${ik}/${C.issuerKeys.revoked}/revoke`, main, {}),
    post('revoking an issuer key of another organisation', `${ik}/${C.issuerKeys.ofAnother}/revoke`, main, {}),
    post('revoking an issuer key nobody has', `${ik}/nobody/revoke`, main, {}),
    post('revoking an issuer key just registered', `${ik}/{ik1}/revoke`, main, {}),
    { name: 'revoking an issuer key with a body that is not JSON', method: 'POST', target: `${ik}/nobody/revoke`, headers: { ...main, ...J }, body: '{' },
    get('the issuer keys after revoking', ik, main, { volatile: IKEYS }),
  );

  // ── products ──────────────────────────────────────────────────────────────
  const pr = '/v1/console/products';
  const I = C.institutions;
  const act = (name, body, extra = {}) => post(name, pr, main, body, extra);
  const fresh = { Cookie: 'stonehash_session={n1}' };
  add(
    act('activating a product nobody sells', { product: 'billing' }),
    act('activating no product', {}),
    act('activating a product that is a number', { product: 5 }),
    act('activating with a body that is null', 'null'),
    act('activating with a body that is a list', '[]'),
    act('activating with a body that is not JSON', '{'),
    act('activating with a body over 1 MiB', `{"product":"remit","pad":"${'a'.repeat(1 << 20)}"}`),
    { name: 'activating with no body at all', method: 'POST', target: pr, headers: main },
    act('activating document anchoring again', { product: 'attest', institution: { name: 'ignored' } }),
    act('activating settlements with no institution', { product: 'remit', issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an institution that is text', { product: 'remit', institution: 'Parity Bank', issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an institution with no name', { product: 'remit', institution: { id: I.bank, country: 'VN' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an empty name', { product: 'remit', institution: { name: '' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an id in lower case', { product: 'remit', institution: { id: 'vn-bank-001', name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an id that is too short', { product: 'remit', institution: { id: 'VN-B', name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an id that is too long', { product: 'remit', institution: { id: `VN-${'B'.repeat(33)}`, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an id and a line end', { product: 'remit', institution: { id: `${I.bank}\n`, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with an id that is a number', { product: 'remit', institution: { id: 5, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements with no issuer key', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' } }),
    act('activating settlements with an issuer key nobody has', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: 'nobody' }),
    act('activating settlements with an issuer key that was revoked', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.revoked }),
    act('activating settlements with an issuer key of another organisation', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.ofAnother }),
    act('activating settlements with an RS256 key', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.rs256 }),
    act('activating settlements with the sign-up placeholder', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.placeholder }),
    act('activating settlements as an institution of another organisation', { product: 'remit', institution: { id: I.ofAnother, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements as a partner\'s institution', { product: 'remit', institution: { id: I.partner, name: 'Parity Bank' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating reserve proofs with an id and no issuer key', { product: 'por', institution: { id: I.exchange, name: 'Parity Exchange' } }),
    // An organisation with no institution yet, and no id given: the country decides the id.
    post('activating settlements with no id and no country', pr, fresh, { product: 'remit', institution: { name: 'New Bank' }, issuer_key_id: 'x' }),
    post('activating settlements with no id and a country of three letters', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 'VNM' }, issuer_key_id: 'x' }),
    post('activating settlements with no id and a country that is a number', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 84 }, issuer_key_id: 'x' }),
    post('activating settlements with no id, a country and no key', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 'vn' } }),
    post('activating settlements with no id, a country and a key nobody has', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 'vn' }, issuer_key_id: 'x' }),
    post('activating settlements with no id, a country and the placeholder', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 'vn' }, issuer_key_id: '{n1placeholder}' }),
    post('registering a key in the new account', ik, fresh, { public_key: spki(p256b), label: 'bank key' }, { ...REG, capture: { nk: '$.id' } }),
    post('activating settlements with no id and a country', pr, fresh, { product: 'remit', institution: { name: 'New Bank', country: 'vn' }, issuer_key_id: '{nk}', webhook_url: 5 }, { volatile: ['$.institution_id'] }),
    post('activating settlements again: the institution is kept', pr, fresh, { product: 'remit', institution: { name: 7 }, issuer_key_id: '{nk}' }, { volatile: ['$.institution_id'] }),
    post('activating reserve proofs with no id and a country', pr, fresh, { product: 'por', institution: { name: 'New Exchange', country: 'KR' }, issuer_key_id: '{nk}' }, { volatile: ['$.institution_id'] }),
    get('the products of the new account after activating', pr, fresh, { volatile: [/^\$\.products\[\d+\]\.created_at$/, /^\$\.products\[\d+\]\.config\.institution_id$/, /^\$\.institutions?(\[\d+\])?\.id$/] }),
    // The console's organisation, activating again: with the ids it has, and with another key.
    act('activating settlements again, with a webhook', { product: 'remit', institution: { id: I.bank, name: 'Parity Collection Bank, renamed' }, issuer_key_id: '{ik2}', webhook_url: 'https://bank.example/hooks/v2' }),
    act('activating reserve proofs again, with no id', { product: 'por', institution: { name: 'Parity Exchange', country: 'KR' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating settlements under a new id', { product: 'remit', institution: { id: 'VN-BANK-RUN-1', name: 'Run Bank', country: 'VN' }, issuer_key_id: C.issuerKeys.es256, webhook_url: '' }),
    get('the products after activating', pr, main),
    // Revoking the key an institution signs with withdraws it from the institution too.
    post('revoking the key the exchange signs with', `${ik}/${C.issuerKeys.es256}/revoke`, main, {}),
    get('the products after that key was revoked', pr, main),
    act('activating reserve proofs with the revoked key', { product: 'por', institution: { name: 'Parity Exchange' }, issuer_key_id: C.issuerKeys.es256 }),
    act('activating reserve proofs with another key', { product: 'por', institution: { name: 'Parity Exchange' }, issuer_key_id: '{ik2}' }),
    get('the products with the exchange signing again', pr, main),
  );

  // ── switching a product off ───────────────────────────────────────────────
  // The settlement rail registers this route and the two below for the console. What each did is read back from the
  // product screen, and — for what that screen does not show — from the two stores (tools/compare-registry.mjs).
  const off = (product) => `${pr}/${product}/deactivate`;
  add(
    post('switching a product off without a session', off('por'), {}, {}),
    post('switching a product off with an expired session', off('por'), sess(C.sessions.expired), {}),
    post('switching off a product nobody sells', off('billing'), main, {}),
    post('switching off a product named in capitals', off('POR'), main, {}),
    post('switching off a product named with a malformed escape', `${pr}/%E0%A4%A/deactivate`, main, {}),
    post('switching off a product the organisation never had', off('por'), other, {}),
    post('switching off reserve proofs', off('por'), main, {}),
    post('switching off reserve proofs again', off('por'), main, {}),
    post('switching off settlements, the name percent-encoded, with a body that is not JSON', `${pr}/r%65mit/deactivate`, main, '{'),
    { name: 'switching off document anchoring, with no body', method: 'POST', target: off('attest'), headers: main },
    get('the products with everything switched off', pr, main),
    get('switching a product off with GET', off('por'), main),
    act('activating document anchoring after it was switched off', { product: 'attest' }),
    act('activating reserve proofs after they were switched off', { product: 'por', institution: { name: 'Parity Exchange', country: 'KR' }, issuer_key_id: '{ik2}' }),
    // Stored text: half of a surrogate pair is kept as U+FFFD, here in a name and in what a key is looked up by.
    act('activating settlements after they were switched off, under a name with half a character', { product: 'remit', institution: { id: I.bank, name: 'Parity \ud83d Bank', country: 'VN' }, issuer_key_id: '{ik2}' }),
    act('activating settlements with a key id that is half a character', { product: 'remit', institution: { id: I.bank, name: 'Parity Bank' }, issuer_key_id: 'key \ude00' }),
    get('the products switched on again', pr, main),
  );

  // ── an institution's signing key ──────────────────────────────────────────
  const sk = (id) => `/v1/console/institutions/${id}/signing-key`;
  const APPLIED = { volatile: ['$.applied_at', '$.issuer_key_id'] };
  const p256c = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  add(
    post('registering a key to switch to', ik, main, { public_key: spki(p256c), label: 'switch' }, { ...REG, capture: { ik3: '$.id' } }),
    post('another signing key without a session', sk(I.bank), {}, { issuer_key_id: '{ik3}' }),
    post('another signing key for an institution of another organisation', sk(I.ofAnother), main, { issuer_key_id: '{ik1}' }),
    post('another signing key for a partner\'s institution', sk(I.partner), main, { issuer_key_id: '{ik1}' }),
    post('another signing key for an institution nobody registered', sk('VN-BANK-NOBODY'), main, { issuer_key_id: '{ik1}' }),
    post('another signing key for an institution named with a malformed escape', sk('%E0%A4%A'), main, { issuer_key_id: '{ik1}' }),
    post('another signing key, and no key named', sk(I.bank), main, {}),
    post('another signing key, with a key id that is empty', sk(I.bank), main, { issuer_key_id: '' }),
    post('another signing key, with a key id that is a number', sk(I.bank), main, { issuer_key_id: 5 }),
    post('another signing key, with a body that is null', sk(I.bank), main, 'null'),
    post('another signing key, with a body that is a list', sk(I.bank), main, '[]'),
    post('another signing key, with a body that is not JSON', sk(I.bank), main, '{'),
    post('another signing key, with a body that is not JSON, for an institution of another organisation', sk(I.ofAnother), main, '{'),
    post('another signing key that nobody registered', sk(I.bank), main, { issuer_key_id: 'nobody' }),
    post('another signing key that is another organisation\'s', sk(I.bank), main, { issuer_key_id: C.issuerKeys.ofAnother }),
    post('another signing key that was revoked', sk(I.bank), main, { issuer_key_id: C.issuerKeys.revoked }),
    post('another signing key that was revoked in this run', sk(I.bank), main, { issuer_key_id: '{ik1}' }),
    post('another signing key that is RS256', sk(I.bank), main, { issuer_key_id: C.issuerKeys.rs256 }),
    post('another signing key that is the sign-up placeholder', sk(I.bank), main, { issuer_key_id: C.issuerKeys.placeholder }),
    post('another signing key for the bank', sk(I.bank), main, { issuer_key_id: '{ik3}' }, APPLIED),
    post('the same signing key again', sk(I.bank), main, { issuer_key_id: '{ik3}' }, APPLIED),
    get('the products with the bank signing with the new key', pr, main),
    post('another signing key for the exchange, its id percent-encoded', sk(I.exchange.replace('KR', '%4BR')), main, { issuer_key_id: C.issuerKeys.statementKey }, APPLIED),
    post('a colleague gives the bank another signing key', sk(I.bank), sess(C.sessions.colleague), { issuer_key_id: '{ik2}' }, APPLIED),
    get('the signing key with GET', sk(I.bank), main),
    get('the products after the signing keys were switched', pr, main),
  );

  // ── the key the console's reserve screen signs with ───────────────────────
  const ck = (id) => `/v1/console/institutions/${id}/console-key`;
  const SET = { volatile: ['$.applied_at'] };
  add(
    post('a console key without a session', ck(I.exchange), {}, { public_key: spki(p256) }),
    post('a console key for a bank', ck(I.bank), main, { public_key: spki(p256) }),
    post('a console key for an institution of another organisation', ck(I.ofAnother), main, { public_key: spki(p256) }),
    post('a console key for an exchange of another organisation', ck(I.quotaExchange), main, { public_key: spki(p256) }),
    post('a console key for an institution nobody registered', ck('KR-EX-NOBODY'), main, { public_key: spki(p256) }),
    post('a console key, and no key', ck(I.exchange), main, {}),
    post('a console key, with a body that is null', ck(I.exchange), main, 'null'),
    post('a console key, with a body that is a list', ck(I.exchange), main, '[]'),
    post('a console key, with a body that is not JSON', ck(I.exchange), main, '{'),
    post('a console key that is empty', ck(I.exchange), main, { public_key: '' }),
    post('a console key that is a number', ck(I.exchange), main, { public_key: 5 }),
    post('a console key that is no key', ck(I.exchange), main, { public_key: 'AAAA' }),
    post('a console key on another curve', ck(I.exchange), main, { public_key: spki(p384) }),
    post('a console key that is an RSA key', ck(I.exchange), main, { public_key: spki(rsa) }),
    post('a console key that is a private key', ck(I.exchange), main, { public_key: p256.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }),
    post('a console key for the exchange', ck(I.exchange), main, { public_key: spki(p256) }, SET),
    post('a console key with spaces around it', ck(I.exchange), main, { public_key: `  ${spki(p256b)}\n` }, SET),
    post('a console key in armour', ck(I.exchange), main, { public_key: p256.publicKey.export({ format: 'pem', type: 'spki' }) }, SET),
    post('the next session\'s console key replaces the last', ck(I.exchange), sess(C.sessions.colleague), { public_key: spki(p256b) }, SET),
    post('a console key for the exchange of the organisation at its allowance', ck(I.quotaExchange), quota, { public_key: spki(p256) }, SET),
    get('the console key with GET', ck(I.exchange), main),
    get('the products after the console keys', pr, main),
  );

  // ── ending every other session ────────────────────────────────────────────
  const ro = '/v1/console/sessions/revoke-others';
  add(
    get('the second session works', '/v1/console/me', sess(C.sessions.second), { volatile: [...LOGIN, '$.api_key.id', '$.api_key.created_at', /^\$\.issuer_keys\[\d+\]\.(id|created_at)$/], ...BY_LABEL }),
    { name: 'ending every other session', method: 'POST', target: ro, headers: main },
    get('the second session is ended', '/v1/console/me', sess(C.sessions.second)),
    get('the fourth session is ended', '/v1/console/me', sess(C.sessions.fourth)),
    get('the session made by signing in is ended', '/v1/console/me', { Cookie: 'stonehash_session={s1}' }),
    get('the session that asked goes on', '/v1/console/keys', main, { volatile: KEYS }),
    get('a colleague\'s session goes on', '/v1/console/keys', sess(C.sessions.colleague), { volatile: KEYS }),
    { name: 'ending every other session again', method: 'POST', target: ro, headers: { ...main, ...J }, body: '{' },
    { name: 'ending every other session with another method', target: ro, headers: main },
  );

  // ── the views again, after everything above ───────────────────────────────
  add(
    get('the dashboard after the run', '/v1/console/dashboard', main, { volatile: ['$.generated_at', /^\$\.attest\.recent\[\d+\]\.(id|created_at)$/] }),
    get('the records after the run', '/v1/console/attestations?product=attest&limit=20', main, { volatile: [/^\$\.data\[\d+\]\.(id|created_at)$/] }),
    get('the audit trail after the run', '/v1/console/audit?limit=200', main, { volatile: [/^\$\.data\[\d+\]\.(id|at|duration_ms|actor_id)$/, '$.page.next_cursor'], blur: UUIDS }),
    get('the audit trail after the run: what keys did', '/v1/console/audit?actor_type=api_key&limit=12', main, { volatile: [/^\$\.data\[\d+\]\.(id|at|duration_ms|actor_id)$/, '$.page.next_cursor'], blur: UUIDS }),
  );

  return cases;
};
