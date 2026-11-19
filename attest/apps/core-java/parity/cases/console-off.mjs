/**
 * The console's routes on a deployment that has no console: one where it is
 * switched off (CONSOLE_ENABLED=0), or a live one (STONEHASH_ENV=live), where
 * self-serve accounts do not exist. Every route says so before it looks at
 * anything else — a session, a body, an allowance — and the keyed API's
 * door for a console session is shut.
 *
 * These run only against two servers started that way
 * (`node apps/core-java/parity/run.mjs --file console-off`, see the README);
 * against the usual pair this file has no cases.
 */
const J = { 'Content-Type': 'application/json' };

export default async ({ seed, ref, exchange }) => {
  if ((await exchange(ref, { target: '/v1/console/me' })).status === 401) return [];
  const C = seed.console;
  const main = { Cookie: `stonehash_session=${C.sessions.main}` };
  const R = C.ids;
  const P = seed.por;
  const cases = [{ name: 'what this deployment says it is', target: '/v1/meta' }];
  const routes = [['POST', '/v1/console/signup', { email: 'off-1@parity.example', password: 'a password long enough' }], ['POST', '/v1/console/login', { email: C.account.email, password: C.account.password }],
    ['GET', '/v1/console/me'], ['GET', '/v1/console/dashboard'], ['GET', '/v1/console/audit?service=billing'], ['GET', '/v1/console/attestations?product=x'], ['POST', '/v1/console/attestations', { sha256: 'ab'.repeat(32) }],
    // No document for the inscription route: were this door ever open, there would be nothing to inscribe.
    ['POST', '/v1/console/attestations/inscribe'], ['POST', '/v1/console/attestations/signed', { statement: C.signed.es256 }], ['GET', '/v1/console/issuer-keys'],
    ['POST', '/v1/console/issuer-keys', { public_key: C.issuerKeys.spareSpki }], ['POST', `/v1/console/issuer-keys/${C.issuerKeys.spare}/revoke`, {}], ['GET', `/v1/console/tx/${R.txids.reveal}`], ['GET', '/v1/console/tx/x'],
    ['GET', `/v1/console/attestations/${R.attest.confirmed[0]}/bundle`], ['GET', '/v1/console/keys'], ['POST', '/v1/console/keys', { label: 'off' }], ['POST', `/v1/console/keys/${C.keys.ci.id}/label`, { label: 'off' }],
    ['POST', `/v1/console/keys/${C.keys.ci.id}/revoke`, {}], ['POST', '/v1/console/keys/rotate', {}], ['POST', '/v1/console/sessions/revoke-others', {}], ['GET', '/v1/console/products'],
    ['POST', '/v1/console/products', { product: 'attest' }], ['POST', '/v1/console/products', { product: 'billing' }],
    // What the settlement rail registers for the console: behind the same door.
    ['POST', '/v1/console/products/attest/deactivate', {}], ['POST', `/v1/console/institutions/${C.institutions.bank}/signing-key`, { issuer_key_id: C.issuerKeys.spare }],
    ['POST', `/v1/console/institutions/${C.institutions.exchange}/console-key`, { public_key: C.issuerKeys.spareSpki }],
    // The sandbox's material and the settlement evidence it feeds: a console session opens them only where there is a console.
    ['GET', '/v1/console/sandbox'], ['POST', '/v1/console/sandbox/evidence', {}], ['POST', '/v1/console/sandbox/package', {}], ['POST', '/v1/console/sandbox/package/verify', {}],
    ['POST', '/v1/settlements/reconcile', {}], ['POST', '/v1/settlements/bundle', {}]];
  for (const [method, target, body] of routes) {
    const base = { method, target, ...(body === undefined ? {} : { body }) };
    cases.push(
      { name: `${method} ${target} without a session`, ...base, headers: method === 'POST' ? J : {} },
      { name: `${method} ${target} with a session`, ...base, headers: { ...(method === 'POST' ? J : {}), ...main } },
    );
  }
  cases.push(
    { name: 'signing in with a body that is not JSON', method: 'POST', target: '/v1/console/login', headers: J, body: '{' },
    { name: 'signing up with a body that is not JSON', method: 'POST', target: '/v1/console/signup', headers: J, body: '{' },
    // Signing out asks nothing of the deployment: it ends the session it is shown, here too.
    { name: 'signing out', method: 'POST', target: '/v1/console/logout', headers: { Cookie: `stonehash_session=${C.sessions.third}` } },
    { name: 'signing out with no session', method: 'POST', target: '/v1/console/logout' },
    // The keyed API: a console session opens it only where there is a console.
    { name: 'the keyed API with a console session', target: `/v1/attestations/${R.attest.confirmed[0]}`, headers: main },
    { name: 'the keyed API with a key', target: `/v1/attestations/${R.attest.confirmed[0]}`, headers: { Authorization: `Bearer ${C.keys.primary.secret}` } },
    { name: 'the keyed API with a key and a console session', target: `/v1/attestations/${R.attest.confirmed[0]}`, headers: { ...main, Authorization: `Bearer ${C.keys.primary.secret}` } },
    // A key opens the sandbox's material whether there is a console or not.
    { name: 'the sandbox catalogue with a key', target: '/v1/console/sandbox', headers: { Authorization: `Bearer ${C.keys.primary.secret}` } },
    { name: 'sandbox evidence with a key', method: 'POST', target: '/v1/console/sandbox/evidence', headers: { ...J, Authorization: `Bearer ${C.keys.primary.secret}` }, body: { scenario: 'B' } },
    { name: 'reconciling with a key and a console session', method: 'POST', target: '/v1/settlements/reconcile', headers: { ...J, ...main, Authorization: `Bearer ${C.keys.primary.secret}` }, body: {} },
    // Proof of reserves: the keyed routes are open to a key the deployment admits, whether there is a console or not;
    // the public material needs nothing. (None of these changes what is stored. parity/cases/por.mjs is the full
    // set, for a deployment that admits the seeded keys.)
    { name: 'reserve snapshots with a key', target: '/v1/por/snapshots', headers: { Authorization: `Bearer ${P.keys.list}` } },
    { name: 'reserve snapshots with a console session', target: '/v1/por/snapshots', headers: main },
    { name: 'reserve snapshots with nothing', target: '/v1/por/snapshots' },
    { name: 'one reserve snapshot with a key', target: `/v1/por/snapshots/${P.snapshots.acceptedConfirmed}`, headers: { Authorization: `Bearer ${P.keys.exchange}` } },
    { name: 'a reserve submission with a key and nothing in it', method: 'POST', target: '/v1/por/snapshots', headers: { ...J, Authorization: `Bearer ${P.keys.exchange}` }, body: {} },
    { name: 'a reserve submission with a console session', method: 'POST', target: '/v1/por/snapshots', headers: { ...J, ...main }, body: {} },
    { name: 'openings for a challenge that has run out, with a key', method: 'POST', target: `/v1/por/snapshots/${P.snapshots.challengedExpired}/openings`, headers: { ...J, Authorization: `Bearer ${P.keys.exchange}` }, body: { openings: [] } },
    { name: 'the public material of a published snapshot', target: `/v1/public/por/snapshots/${P.snapshots.acceptedConfirmed}`, volatile: [/\.bundle\.generated_at$/] },
    { name: 'the public material of a sampled snapshot', target: `/v1/public/por/snapshots/${P.snapshots.verifiedConfirmed}`, volatile: [/\.bundle\.generated_at$/] },
    { name: 'the public material of a snapshot not yet anchored', target: `/v1/public/por/snapshots/${P.snapshots.acceptedWaiting}` },
    { name: 'the public material of a challenge still open', target: `/v1/public/por/snapshots/${P.snapshots.challengedOpen}` },
    { name: 'a sandbox key', method: 'POST', target: '/v1/sandbox/keys', headers: { ...J, 'X-Forwarded-For': '198.51.100.200' }, body: {}, volatile: ['$.org.id', '$.org.slug', '$.api_key'] },
  );
  return cases;
};
