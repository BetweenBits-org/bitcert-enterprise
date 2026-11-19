/**
 * The settlement rail, the doors: who may ask each route that needs no partner, and what the others are told.
 *
 *   POST /v1/quotes        POST /v1/settlements        GET /v1/settlements        GET /v1/settlements/:id   …/chain   …/evidence
 *   POST /v1/manifests/daily                           GET /v1/manifests/daily
 *
 * In the reference's order: no key or a key that is none → 401, before anything else is looked at; a key of an
 * organisation that may not use the rail → 403 (no subscription, one that is switched off, no bank, a bank without
 * a key) on the routes that write, while the routes that read need a key and nothing more; only then the request
 * itself (the Idempotency-Key header, the body). Every request that writes carries a body that is no JSON, so that a
 * door which read the body first would answer something else. Also here: the routes that lie over each other
 * (`GET /v1/settlements/reconcile` is a settlement that does not exist, not the evaluator), methods nobody
 * registered, and the paths a router could mistake for these.
 *
 * (The doors of cancel, rfi-response and the partners' callbacks are in remit-b-*: those routes need the pipeline.)
 */
import { remitKit } from '../remit-kit.mjs';

export default (ctx) => {
  const k = remitKit(ctx);
  if (!k) { console.log('remit-a-01: the settlement rail is not seeded — no cases'); return []; }
  const { R, O, J, key } = k;
  const { seed } = ctx;
  const cases = [];
  const add = (name, c) => cases.push({ name, ...c });
  const seeded = 'PAY-SEED-ANCHORED-A'; // of the read organisation
  const NOT_JSON = '{"payment_id":';

  /** Every route, as [what, request]: the writing ones with a body that is no JSON. */
  const routes = (headers, id = seeded) => [
    ['a quote', { method: 'POST', target: '/v1/quotes', headers: { ...J, ...headers }, body: NOT_JSON }],
    ['an instruction', { method: 'POST', target: '/v1/settlements', headers: { ...J, ...headers, 'Idempotency-Key': 'ra-gate-key-0001' }, body: NOT_JSON }],
    ['an instruction without its key header', { method: 'POST', target: '/v1/settlements', headers: { ...J, ...headers }, body: NOT_JSON }],
    ['the ledger', { target: '/v1/settlements?limit=2', headers }],
    ['a settlement', { target: `/v1/settlements/${id}`, headers }],
    ['its chain', { target: `/v1/settlements/${id}/chain`, headers }],
    ['its evidence', { target: `/v1/settlements/${id}/evidence`, headers, volatile: ['$.attestation.bundle.generated_at'] }],
    ['a manifest', { method: 'POST', target: '/v1/manifests/daily', headers: { ...J, ...headers }, body: NOT_JSON }],
    ['the manifests', { target: '/v1/manifests/daily', headers }],
  ];

  // ── nobody ───────────────────────────────────────────────────────────────────────────────────────────────────
  const nobody = [
    ['no key', {}],
    ['a key that is no key', { Authorization: 'Bearer sk_test_nothing-of-the-kind' }],
    ['a key under another scheme', { Authorization: `Basic ${O.read.key}` }],
    ['a key with the scheme in lower case', { Authorization: `bearer ${O.read.key}` }],
    ['a scheme and no key', { Authorization: 'Bearer ' }],
    ['a key with a space after it: the space is no part of the header', { Authorization: `Bearer ${O.read.key} ` }],
    ['a key with two spaces before it', { Authorization: `Bearer  ${O.read.key}` }],
    ['a revoked key', { Authorization: `Bearer ${seed.keys.aRevoked}` }],
    ['a session that has expired', { Cookie: `stonehash_session=${seed.sessions.expired}` }],
    ['the operator\'s token instead of a key', { 'X-Admin-Token': k.TOKEN }],
  ];
  for (const [who, headers] of nobody) for (const [what, request] of routes(headers)) add(`${what}, with ${who}`, request);

  // ── an organisation that may not use the rail ────────────────────────────────────────────────────────────────
  for (const [name, why] of [['nosub', 'has no subscription'], ['off', 'has its subscription switched off'], ['nobank', 'has no bank'], ['nokey', 'has a bank without a key']]) {
    const own = Object.values(R.settlements[name] ?? {})[0]?.id;
    for (const [what, request] of routes(key(O[name]), own ?? seeded)) add(`${what}, of an organisation that ${why}`, request);
  }
  // An organisation of the platform's other products, with a key and no rail subscription at all.
  for (const [what, request] of routes({ Authorization: `Bearer ${seed.keys.a}` })) add(`${what}, with a key of an organisation that only anchors documents`, request);

  // ── somebody who may: the door is passed, and the request itself is looked at ────────────────────────────────
  for (const [what, request] of routes(key(O.b), 'PAY-OTHER-ANCHORED')) add(`${what}, of an organisation that may`, request);
  // A console session is taken on the key routes of a test deployment: the reads of that organisation.
  add('the ledger, with a console session', { target: '/v1/settlements?limit=3', headers: { Cookie: `stonehash_session=${seed.console.sessions.main}` } });
  add('the manifests, with a console session', { target: '/v1/manifests/daily', headers: { Cookie: `stonehash_session=${seed.console.sessions.main}` } });
  add('a settlement of another organisation, with a console session', { target: `/v1/settlements/${seeded}`, headers: { Cookie: `stonehash_session=${seed.console.sessions.main}` } });
  // A key and a session together: the key decides.
  add('the ledger, with a key and another organisation\'s session', { target: '/v1/settlements?limit=1', headers: { ...key(O.b), Cookie: `stonehash_session=${seed.console.sessions.main}` } });
  add('the ledger, with a key that is none and a session that is good', { target: '/v1/settlements?limit=1', headers: { Authorization: 'Bearer sk_test_nothing', Cookie: `stonehash_session=${seed.console.sessions.main}` } });

  // ── routes that lie over each other ──────────────────────────────────────────────────────────────────────────
  for (const word of ['reconcile', 'bundle']) {
    add(`GET /v1/settlements/${word}: a settlement of that name, which there is none of`, { target: `/v1/settlements/${word}`, headers: key(O.read) });
    add(`GET /v1/settlements/${word} without a key`, { target: `/v1/settlements/${word}` });
    add(`the chain of "${word}"`, { target: `/v1/settlements/${word}/chain`, headers: key(O.read) });
    add(`the evidence of "${word}"`, { target: `/v1/settlements/${word}/evidence`, headers: key(O.read) });
  }
  add('GET /v1/manifests: no route', { target: '/v1/manifests', headers: key(O.read) });
  add('GET /v1/manifests/daily/2026-10-05: no route', { target: '/v1/manifests/daily/2026-10-05', headers: key(O.read) });
  add('GET /v1/quotes: no route', { target: '/v1/quotes', headers: key(O.rail) });
  add('GET /v1/quotes/:id: no route', { target: `/v1/quotes/${R.quotes.fresh.rail[0].quote_id}`, headers: key(O.rail) });
  add('GET /v1/remit: no route', { target: '/v1/remit' });
  add('GET /v1/remit/registry/institutions: no route', { target: '/v1/remit/registry/institutions', headers: { 'X-Admin-Token': k.TOKEN } });
  add('GET /v1/remit/callbacks: no route', { target: '/v1/remit/callbacks' });

  // ── methods nobody registered, and paths written another way ─────────────────────────────────────────────────
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    add(`${method} /v1/settlements`, { method, target: '/v1/settlements', headers: { ...J, ...key(O.read) }, body: {} });
    add(`${method} /v1/settlements/:id`, { method, target: `/v1/settlements/${seeded}`, headers: { ...J, ...key(O.read) }, body: {} });
    add(`${method} /v1/quotes`, { method, target: '/v1/quotes', headers: { ...J, ...key(O.rail) }, body: {} });
    add(`${method} /v1/manifests/daily`, { method, target: '/v1/manifests/daily', headers: { ...J, ...key(O.read) }, body: {} });
  }
  add('HEAD /v1/settlements', { method: 'HEAD', target: '/v1/settlements', headers: key(O.read) });
  add('OPTIONS /v1/settlements', { method: 'OPTIONS', target: '/v1/settlements', headers: { ...key(O.read), Origin: 'https://playground.example', 'Access-Control-Request-Method': 'GET' } });
  add('a settlement with a slash after it', { target: `/v1/settlements/${seeded}/`, headers: key(O.read) });
  add('the ledger with a slash after it', { target: '/v1/settlements/?limit=1', headers: key(O.read) });
  add('the ledger with its slashes doubled', { target: '/v1//settlements?limit=1', headers: key(O.read) });
  add('a settlement with its slashes doubled', { target: `/v1/settlements//${seeded}`, headers: key(O.read) });
  add('the ledger in capitals', { target: '/V1/SETTLEMENTS', headers: key(O.read) });
  add('a settlement whose path goes on', { target: `/v1/settlements/${seeded}/chain/again`, headers: key(O.read) });
  add('the ledger with a fragment and an empty query', { target: '/v1/settlements?', headers: key(O.b) });
  return cases;
};
