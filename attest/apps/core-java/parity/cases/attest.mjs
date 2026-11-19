/**
 * The keyed API of document anchoring: who is let in, what a digest and a
 * signed statement are accepted and refused with, reading records and their
 * bundles in every state, and issuer keys. The records it starts from are
 * the seeded ones (tools/seed-reference.mjs), the same in both schemas.
 */
import { overLimit } from '../documents.mjs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const materials = JSON.parse(readFileSync(path.resolve(HERE, '../../src/test/resources/vectors/key-materials.json'), 'utf8'));
const digest = (label) => createHash('sha256').update(`parity run: ${label}`).digest('hex');
const NEW = ['$.id', '$.created_at'];
const LISTED = [/^\$\.data\[\d+\]\.(id|created_at|batch_id)$/];
const DUP = [[/attested as [0-9a-f-]{36}/, 'attested as <id>']];
const set = (o, keys, value) => { const c = structuredClone(o); let at = c; for (const k of keys.slice(0, -1)) at = at[k]; if (value === undefined) delete at[keys.at(-1)]; else at[keys.at(-1)] = value; return c; };

export default async ({ seed, ref, exchange }) => {
  // This deployment's limit for an inscribed document, as the reference states it; the Java service's is compared in /v1/meta.
  const LIMIT = JSON.parse((await exchange(ref, { target: '/v1/meta' })).body.toString('utf8')).inscription.max_bytes;
  const CEILING = LIMIT + 64 * 1024;
  const A = { Authorization: `Bearer ${seed.keys.a}` };
  const B = { Authorization: `Bearer ${seed.keys.b}` };
  const post = (name, target, body, extra = {}) => ({ name, method: 'POST', target, headers: { ...A, 'Content-Type': 'application/json', ...(extra.headers ?? {}) }, body, ...extra, ...(extra.headers ? { headers: { ...A, ...extra.headers } } : {}) });
  const cases = [];
  const add = (...c) => cases.push(...c);

  // ── who is let in ─────────────────────────────────────────────────────────
  add(
    { name: 'list without a key', target: '/v1/attestations' },
    { name: 'list with an empty bearer', target: '/v1/attestations', headers: { Authorization: 'Bearer ' } },
    { name: 'list with a key nobody issued', target: '/v1/attestations', headers: { Authorization: 'Bearer sk_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
    { name: 'list with a key of the other environment', target: '/v1/attestations', headers: { Authorization: `Bearer sk_live_${seed.keys.a.slice(8)}` } },
    { name: 'list with a revoked key', target: '/v1/attestations', headers: { Authorization: `Bearer ${seed.keys.aRevoked}` } },
    { name: 'list with the scheme in lower case', target: '/v1/attestations', headers: { Authorization: `bearer ${seed.keys.a}` } },
    { name: 'list with two spaces after Bearer', target: '/v1/attestations', headers: { Authorization: `Bearer  ${seed.keys.a}` } },
    { name: 'list with Basic credentials', target: '/v1/attestations', headers: { Authorization: 'Basic dXNlcjpwYXNz' } },
    { name: 'list with the key and a space after it', target: '/v1/attestations?limit=1', headers: { Authorization: `Bearer ${seed.keys.a} ` } },
    { name: 'list with a session nobody has', target: '/v1/attestations', headers: { Cookie: 'stonehash_session=nobody' } },
    { name: 'list with a console session', target: '/v1/attestations?limit=2', headers: { Cookie: `theme=dark; stonehash_session=${seed.sessions.valid}; other=1` } },
    { name: 'list with a session and a wrong key', target: '/v1/attestations?limit=2', headers: { Authorization: 'Bearer sk_test_wrong', Cookie: `stonehash_session=${seed.sessions.valid}` } },
    { name: 'list with an expired session', target: '/v1/attestations', headers: { Cookie: `stonehash_session=${seed.sessions.expired}` } },
    { name: 'list with the expired session again', target: '/v1/attestations', headers: { Cookie: `stonehash_session=${seed.sessions.expired}` } },
    { name: 'list with the session of a disabled account', target: '/v1/attestations', headers: { Cookie: `stonehash_session=${seed.sessions.disabled}` } },
    { name: 'list with a cookie header that names no session', target: '/v1/attestations', headers: { Cookie: 'a; =b; stonehash_session=; x=y' } },
    { name: 'list with the session cookie under another name', target: '/v1/attestations', headers: { Cookie: `Stonehash_Session=${seed.sessions.valid}` } },
    { name: 'list with the session in a second cookie header', target: '/v1/attestations?limit=1', headers: { Cookie: 'a=b', cookie: `stonehash_session=${seed.sessions.valid}` } },
  );

  // ── reading what is there, before anything is added ───────────────────────
  add({ name: 'list everything', target: '/v1/attestations', headers: A }, { name: 'list of the other organisation', target: '/v1/attestations', headers: B });
  for (const limit of ['1', '2', '3', '0', '-1', '2.5', 'abc', '1e1', '500', '501', '99999', '', '%205%20', '0x3', '7&limit=1', 'Infinity']) {
    add({ name: `list with limit=${limit}`, target: `/v1/attestations?limit=${limit}`, headers: A });
  }
  const every = [...seed.ids.confirmed, seed.ids.signedRegistered, ...seed.ids.submitted, ...seed.ids.batched, ...seed.ids.accepted, seed.ids.inscription.confirmed, seed.ids.inscription.submitted];
  for (const id of every) add({ name: `record ${id}`, target: `/v1/attestations/${id}`, headers: A }, { name: `bundle of ${id}`, target: `/v1/attestations/${id}/bundle`, headers: A, volatile: ['$.generated_at'] });
  add(
    { name: 'a record of the other organisation', target: `/v1/attestations/${seed.ids.other[0]}`, headers: A },
    { name: 'the bundle of a record of the other organisation', target: `/v1/attestations/${seed.ids.other[0]}/bundle`, headers: A },
    { name: 'the other organisation reading its own', target: `/v1/attestations/${seed.ids.other[0]}`, headers: B },
    { name: 'the other organisation reading its signed record', target: `/v1/attestations/${seed.ids.signedUnregistered}`, headers: B },
    { name: 'a free-tier record through the keyed API', target: `/v1/attestations/${seed.ids.public.confirmed}`, headers: A },
    { name: 'a record nobody made', target: '/v1/attestations/00000000-0000-4000-8000-000000000000', headers: A },
    { name: 'the bundle of a record nobody made', target: '/v1/attestations/00000000-0000-4000-8000-000000000000/bundle', headers: A },
    { name: 'a record id in upper case', target: `/v1/attestations/${seed.ids.accepted[0].toUpperCase()}`, headers: A },
    { name: 'a record id with a slash after it', target: `/v1/attestations/${seed.ids.accepted[0]}/`, headers: A },
    { name: 'a record id that is a space', target: '/v1/attestations/%20', headers: A },
    { name: 'a record id with an encoded slash', target: '/v1/attestations/a%2Fb', headers: A },
    { name: 'a record id with odd characters', target: '/v1/attestations/%22%3Cb%3E%27%00%0A', headers: A },
    { name: 'a record id that is a malformed escape', target: '/v1/attestations/%E0', headers: A },
    { name: 'a malformed escape without a key', target: '/v1/attestations/%E0' },
    { name: 'a bundle id that is a malformed escape', target: '/v1/attestations/%zz/bundle', headers: A },
    { name: 'a record without a key', target: `/v1/attestations/${seed.ids.accepted[0]}` },
    { name: 'a bundle without a key', target: `/v1/attestations/${seed.ids.confirmed[0]}/bundle` },
    { name: 'a record with another method', method: 'DELETE', target: `/v1/attestations/${seed.ids.accepted[0]}`, headers: A },
    { name: 'a bundle with HEAD', method: 'HEAD', target: `/v1/attestations/${seed.ids.confirmed[0]}/bundle`, headers: A },
  );

  // ── handing in a digest ───────────────────────────────────────────────────
  const a = '/v1/attestations';
  add(
    { name: 'a digest without a key', method: 'POST', target: a, headers: { 'Content-Type': 'application/json' }, body: { leaf_bytes: digest('no key') } },
    { name: 'invalid JSON without a key', method: 'POST', target: a, body: '{' },
    post('a digest', a, { leaf_bytes: digest('plain') }, { volatile: NEW, capture: { made: '$.id' } }),
    { name: 'the record just made', target: '/v1/attestations/{made}', headers: A, volatile: NEW },
    { name: 'the bundle of the record just made', target: '/v1/attestations/{made}/bundle', headers: A },
    post('the same digest again', a, { leaf_bytes: digest('plain') }, { blur: DUP }),
    post('the same digest in upper case', a, { leaf_bytes: digest('plain').toUpperCase() }, { blur: DUP }),
    post('a digest that was seeded', a, { leaf_bytes: seed.digests.accepted0 }),
    post('a digest the other organisation holds', a, { leaf_bytes: createHash('sha256').update('parity seed: only in the other organisation').digest('hex') }, { volatile: NEW }),
    post('a digest in upper case', a, { leaf_bytes: digest('upper').toUpperCase() }, { volatile: NEW }),
    post('a digest as sha256', a, { sha256: digest('as sha256') }, { volatile: NEW }),
    post('both names: leaf_bytes decides', a, { leaf_bytes: digest('both names'), sha256: 'not hex' }, { volatile: NEW }),
    post('leaf_bytes that is not text, sha256 that is', a, { leaf_bytes: 5, sha256: digest('number then sha256') }, { volatile: NEW }),
    post('an empty leaf_bytes beside a good sha256', a, { leaf_bytes: '', sha256: digest('empty then sha256') }),
    post('a content type and a descriptor', a, { leaf_bytes: digest('typed'), content_type: 'application/pdf', descriptor: { invoice: 'INV-1', n: 1, f: 1.5, big: 1e21, list: [1, 'a', null, true], nested: { 2: 'b', 1: 'a', z: {} } } }, { volatile: NEW, capture: { typed: '$.id' } }),
    post('a descriptor that is a list', a, { leaf_bytes: digest('descriptor list'), descriptor: [1, 2, { a: 1 }] }, { volatile: NEW, capture: { withList: '$.id' } }),
    post('a descriptor that is text', a, { leaf_bytes: digest('descriptor text'), descriptor: 'just text é😀' }, { volatile: NEW, capture: { withText: '$.id' } }),
    post('a descriptor that is a number', a, { leaf_bytes: digest('descriptor number'), descriptor: 42.5 }, { volatile: NEW }),
    post('a descriptor that is null', a, { leaf_bytes: digest('descriptor null'), descriptor: null }, { volatile: NEW }),
    post('a descriptor that is false', a, { leaf_bytes: digest('descriptor false'), descriptor: false }, { volatile: NEW }),
    post('a content type that is not text', a, { leaf_bytes: digest('content type number'), content_type: 5 }, { volatile: NEW }),
    post('an empty content type', a, { leaf_bytes: digest('content type empty'), content_type: '' }, { volatile: NEW }),
    post('fields nobody asked for', a, { leaf_bytes: digest('extra fields'), id: 'mine', status: 'confirmed', org_id: seed.orgB.id }, { volatile: NEW }),
    post('no body at all', a, null),
    post('an empty object', a, {}),
    post('a body that is a list', a, '[]'),
    post('a body that is text', a, '"abc"'),
    post('a body that is a number', a, '5'),
    post('a body that is true', a, 'true'),
    post('a body that is null', a, 'null'),
    post('a body that is only white space', a, '  \n'),
    post('invalid JSON', a, '{"leaf_bytes":'),
    post('JSON with something after it', a, `{"leaf_bytes":"${digest('trailing')}"} x`),
    post('JSON behind a byte-order mark', a, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ leaf_bytes: digest('bom') }))])),
    post('a key written twice: the last one decides', a, `{"leaf_bytes":"zz","leaf_bytes":"${digest('twice')}"}`, { volatile: NEW }),
    post('bytes that are not UTF-8 in a descriptor', a, Buffer.concat([Buffer.from(`{"leaf_bytes":"${digest('bad utf8')}","descriptor":{"note":"a`), Buffer.from([0xff, 0xc3]), Buffer.from('b"}}')]), { volatile: NEW, capture: { badUtf8: '$.id' } }),
    post('JSON sent as text/plain', a, { leaf_bytes: digest('text plain') }, { headers: { 'Content-Type': 'text/plain' }, volatile: NEW }),
    post('JSON sent as a form', a, { leaf_bytes: digest('form') }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, volatile: NEW }),
    post('JSON with no content type', a, JSON.stringify({ leaf_bytes: digest('no content type') }), { headers: {}, volatile: NEW }),
    post('a digest too short', a, { leaf_bytes: 'abc' }),
    post('a digest too long', a, { leaf_bytes: 'a'.repeat(65) }),
    post('a digest that is not hex', a, { leaf_bytes: 'z'.repeat(64) }),
    post('a digest with a line end', a, { leaf_bytes: `${digest('line end')}\n` }),
    post('a digest with spaces around', a, { leaf_bytes: ` ${digest('spaces')} ` }),
    post('a digest that is a list', a, { leaf_bytes: [digest('list')] }),
    post('a body of exactly 1 MiB', a, (() => { const head = `{"leaf_bytes":"${digest('one mebibyte')}","pad":"`; return head + 'a'.repeat((1 << 20) - head.length - 2) + '"}'; })(), { volatile: NEW }),
    post('a body one byte over 1 MiB', a, (() => { const head = `{"leaf_bytes":"${digest('too large')}","pad":"`; return head + 'a'.repeat((1 << 20) - head.length - 1) + '"}'; })()),
    post('a descriptor nested 900 deep', a, `{"leaf_bytes":"${digest('deep enough')}","descriptor":${'['.repeat(900)}${']'.repeat(900)}}`, { volatile: NEW }),
    { name: 'the record with a descriptor', target: '/v1/attestations/{typed}', headers: A, volatile: NEW },
    { name: 'the list after the additions', target: '/v1/attestations?limit=500', headers: A, volatile: LISTED },
    { name: 'the newest three', target: '/v1/attestations?limit=3', headers: A, volatile: LISTED },
    // Last of the digests on purpose: the reference stores this one and the Java service refuses it (D-02), so no list is compared after it.
    post('a descriptor nested 1,200 deep', a, `{"leaf_bytes":"${digest('deep')}","descriptor":${'['.repeat(1200)}${']'.repeat(1200)}}`, { volatile: NEW }),
  );

  // ── handing in the document itself ────────────────────────────────────────
  // Refusals only, and each one before the wallet is asked for anything: a document that passed every check would really
  // be inscribed. So no case rests on the one refusal it is about: where the door is under test there is no document at
  // all, and everywhere else the document is longer than this deployment inscribes (parity/documents.mjs) — a build in
  // which the rule under test is broken then answers something else, and still inscribes nothing. (The real thing:
  // tools/check-inscription.mjs.)
  const i = '/v1/attestations/inscribe';
  const doc = (name, body, extra = {}) => ({ name, method: 'POST', target: i, headers: { ...A, 'Content-Type': 'text/plain', ...(extra.headers ?? {}) }, body, ...extra,
    ...(extra.headers ? { headers: { ...A, ...extra.headers } } : {}) });
  const filled = (n) => Buffer.alloc(n, 0x61);
  const known = overLimit('parity run: a document whose digest was handed in before', LIMIT);
  const large = filled(LIMIT + 1);
  add(
    { name: 'the inscription route without a key', method: 'POST', target: i, headers: { 'Content-Type': 'text/plain' } },
    { name: 'the inscription route with a key nobody issued', method: 'POST', target: i, headers: { Authorization: 'Bearer sk_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'Content-Type': 'text/plain' } },
    { name: 'the inscription route with a revoked key', method: 'POST', target: i, headers: { Authorization: `Bearer ${seed.keys.aRevoked}`, 'Content-Type': 'text/plain' } },
    doc('no document at all', null),
    doc('a document of no bytes', ''),
    doc('no document and no content type', null, { headers: {} }),
    { name: 'no document, a slash after the route', method: 'POST', target: `${i}/`, headers: A },
    post('the digest of a document', a, { leaf_bytes: createHash('sha256').update(known).digest('hex') }, { volatile: NEW }),
    doc('the document of that digest', known, { blur: DUP }),
    doc('the document of that digest, as another content type', known, { headers: { 'Content-Type': 'application/pdf' }, blur: DUP }),
    doc('a document that is inscribed already', overLimit('parity seed: an inscribed document', LIMIT)),
    doc('a document that is inscribed and not yet in a block', overLimit('parity seed: an inscribed document, not yet in a block', LIMIT), { headers: {} }),
    doc('a document one byte over the limit', large),
    doc('a document one byte over the limit, with no content type', large, { headers: {} }),
    doc('a document as large as the upload ceiling', filled(CEILING)),
    doc('a document one byte over the upload ceiling', filled(CEILING + 1), { noAnswer: true }),
    doc('an upload far over the ceiling', filled(CEILING * 4), { noAnswer: true }),
    // The content type is checked before the size, so a document over the limit is answered about its content type.
    doc('a document with an empty content type', large, { headers: { 'Content-Type': '' } }),
    doc('a document whose content type is longer than one push', large, { headers: { 'Content-Type': `text/${'x'.repeat(516)}` } }),
    // Latin-1 on the wire: 261 characters, 522 bytes once it is written into the script as UTF-8 (D-09). With a document
    // under the limit the reference would go on to the wallet with it; here it gets as far as the size.
    doc('a document whose content type does not fit in one push as bytes', large, { headers: { 'Content-Type': 'é'.repeat(261) } }),
    // How the header's bytes are read: 200 bytes that are not UTF-8 are 200 characters — 400 bytes in the script, so the
    // content type is accepted by both, and the size is what both refuse.
    doc('a document over the limit, its content type 200 Latin-1 bytes', large, { headers: { 'Content-Type': 'é'.repeat(200) } }),
    // And 262 bytes that are UTF-8 on the wire are 262 characters too, not 131: 524 bytes in the script (D-09 again).
    doc('a document over the limit, its content type UTF-8 on the wire', large, { headers: { 'Content-Type': Buffer.from('é'.repeat(131), 'utf8').toString('latin1') } }),
    { name: 'the inscription route read as a record', target: i, headers: A },
    { name: 'the inscription route with another method', method: 'PUT', target: i, headers: { ...A, 'Content-Type': 'text/plain' } },
  );

  // ── a signed statement ────────────────────────────────────────────────────
  const s = '/v1/attestations/signed';
  const es = seed.signed.es256Fresh;
  add(
    { name: 'a statement without a key', method: 'POST', target: s, headers: { 'Content-Type': 'application/json' }, body: { statement: es } },
    post('no statement', s, {}), post('a statement that is null', s, { statement: null }), post('a statement that is text', s, { statement: 'signed' }),
    post('a statement that is a number', s, { statement: 5 }), post('a statement that is false', s, { statement: false }), post('a statement that is zero', s, { statement: 0 }),
    post('a statement that is an empty list', s, { statement: [] }), post('a statement that is a list', s, { statement: [es] }), post('a statement that is an empty object', s, { statement: {} }),
    post('a signed body that is null', s, 'null'), post('a signed body that is a list', s, '[]'), post('a signed body that is not JSON', s, '{"statement":'),
    post('a statement signed by a key on file', s, { statement: seed.signed.es256Known, descriptor: { purpose: 'parity' } }, { volatile: NEW, capture: { signedKnown: '$.id' } }),
    post('the same statement again', s, { statement: seed.signed.es256Known }, { blur: DUP }),
    { name: 'the signed record', target: '/v1/attestations/{signedKnown}', headers: A, volatile: NEW },
    post('a statement signed by a key not on file', s, { statement: es }, { volatile: NEW }),
    post('an RSA statement signed by a key not on file', s, { statement: seed.signed.rs256Fresh }, { volatile: NEW }),
    post('a statement signed by a key on file, for the other organisation', s, { statement: seed.signed.rs256Known }, { headers: { ...B, 'Content-Type': 'application/json' }, volatile: NEW }),
    post('a statement whose document was changed', s, { statement: set(seed.signed.es256Fresh2, ['document', 'sha256'], digest('changed document')) }),
    post('a statement with a field added', s, { statement: set(seed.signed.es256Fresh2, ['extra'], 'x') }),
    post('a statement with one bit of the signature changed', s, { statement: set(seed.signed.es256Fresh2, ['signature'], (seed.signed.es256Fresh2.signature[0] === 'A' ? 'B' : 'A') + seed.signed.es256Fresh2.signature.slice(1)) }),
    post('a statement with a signature that is not base64', s, { statement: set(seed.signed.es256Fresh2, ['signature'], '***') }),
    post('a statement with a signature cut short', s, { statement: set(seed.signed.es256Fresh2, ['signature'], seed.signed.es256Fresh2.signature.slice(0, 40)) }),
    post('a statement with an empty signature', s, { statement: set(seed.signed.es256Fresh2, ['signature'], '') }),
    post('a statement without its signature', s, { statement: set(seed.signed.es256Fresh2, ['signature'], undefined) }),
    post('a statement with a signature that is a number', s, { statement: set(seed.signed.es256Fresh2, ['signature'], 5) }),
    post('a statement with a P-384 key', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'public_key'], seed.issuerKeys.otherKeys.p384) }),
    post('a statement with an RSA key under ES256', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'public_key'], seed.issuerKeys.rs256Spki) }),
    post('a statement with a key that is no key', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'public_key'], 'AAAA') }),
    post('a statement with a key that is not base64', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'public_key'], '!!!') }),
    post('a statement with a key that is a number', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'public_key'], 5) }),
    post('a statement of another schema', s, { statement: set(seed.signed.es256Fresh2, ['schema'], 'stonehash-attestation-statement/v2') }),
    post('a statement without its document', s, { statement: set(seed.signed.es256Fresh2, ['document'], undefined) }),
    post('a statement whose document is null', s, { statement: set(seed.signed.es256Fresh2, ['document'], null) }),
    post('a statement whose digest is in upper case', s, { statement: set(seed.signed.es256Fresh2, ['document', 'sha256'], seed.signed.es256Fresh2.document.sha256.toUpperCase()) }),
    post('a statement without its issuer', s, { statement: set(seed.signed.es256Fresh2, ['issuer'], undefined) }),
    post('a statement without a key id', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'key_id'], '') }),
    post('a statement of an algorithm nobody supports', s, { statement: set(seed.signed.es256Fresh2, ['issuer', 'algorithm'], 'EdDSA') }),
    post('a statement without a time', s, { statement: set(seed.signed.es256Fresh2, ['issued_at'], undefined) }),
    post('a statement with a time that is no time', s, { statement: set(seed.signed.es256Fresh2, ['issued_at'], 'yesterday') }),
    post('a statement with a time only the engine reads', s, { statement: set(seed.signed.es256Fresh2, ['issued_at'], 'Nov 18, 2026') }),
    post('a statement with a fraction in it', s, { statement: set(seed.signed.es256Fresh2, ['weight'], 1.5) }),
    post('a statement with a number beyond the safe range', s, { statement: set(seed.signed.es256Fresh2, ['count'], 9007199254740992) }),
    post('the second fresh statement, untouched', s, { statement: seed.signed.es256Fresh2, descriptor: 'text' }, { volatile: NEW }),
  );

  // ── issuer keys ───────────────────────────────────────────────────────────
  const k = '/v1/issuer-keys';
  const KEYS = [/^\$\.data\[\d+\]\.(id|created_at)$/];
  add(
    { name: 'issuer keys without a key', target: k },
    { name: 'issuer keys', target: k, headers: A },
    { name: 'issuer keys of the other organisation', target: k, headers: B },
    { name: 'registering without a key', method: 'POST', target: k, headers: { 'Content-Type': 'application/json' }, body: { public_key: materials.spki.p256 } },
    post('no public key', k, {}), post('an empty public key', k, { public_key: '' }), post('a public key of spaces', k, { public_key: ' \n\t ' }), post('a public key that is a number', k, { public_key: 5 }),
    post('an issuer-key body that is null', k, 'null'), post('an issuer-key body that is a list', k, '[]'),
    post('a private key', k, { public_key: materials.private.p256Pkcs8 }), post('a private key in armour', k, { public_key: materials.private.p256Pkcs8Pem }),
    post('an RSA private key under RS256', k, { public_key: materials.private.rsaPkcs1, algorithm: 'RS256' }),
    post('something that is no key', k, { public_key: 'AAAA' }), post('a P-384 key as ES256', k, { public_key: materials.spki.p384 }), post('an RSA key as ES256', k, { public_key: materials.spki.rsa }),
    post('an Ed25519 key as ES256', k, { public_key: materials.spki.ed25519, algorithm: 'ES256' }), post('a key that was revoked: it registers anew', k, { public_key: seed.issuerKeys.otherKeys.secondP256, label: 'back again' }, { volatile: ['$.id'] }),
    post('the key that is on file', k, { public_key: seed.issuerKeys.es256Spki }), post('the RSA key that is on file', k, { public_key: seed.issuerKeys.rs256Spki, algorithm: 'RS256' }),
    post('the key that is on file, with spaces around', k, { public_key: `  ${seed.issuerKeys.es256Spki}\n` }),
    post('a new P-256 key', k, { public_key: materials.spki.p256, label: '  a label that is rather long, longer than the sixty characters a label may have  ' }, { volatile: ['$.id'] }),
    post('the new key again', k, { public_key: materials.spki.p256, label: 'another label' }, { volatile: ['$.id'] }),
    post('a new key with a label of spaces', k, { public_key: materials.spki.p256Explicit, label: '   ' }, { volatile: ['$.id'] }),
    post('a new key with a label that is not text', k, { public_key: materials.spki.rsa1024, label: 7, algorithm: 'RS256' }, { volatile: ['$.id'] }),
    post('an EC key registered as RS256', k, { public_key: materials.spki.secp256k1, algorithm: 'RS256', label: 'é😀' }, { volatile: ['$.id'] }),
    post('an algorithm in lower case is ES256', k, { public_key: materials.spki.rsaPss, algorithm: 'rs256' }),
    // Stored text: half of a surrogate pair is kept as U+FFFD, as the previous service's driver wrote it.
    post('a new key under a label with half a character', k, { public_key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), label: 'half \ud83d and \ude00 half' }, { volatile: ['$.id'] }),
    post('the other organisation registers the same key', k, { public_key: seed.issuerKeys.es256Spki }, { headers: { ...B, 'Content-Type': 'application/json' }, volatile: ['$.id'] }),
    { name: 'issuer keys after the additions', target: k, headers: A, volatile: KEYS },
    { name: 'issuer keys of the other organisation after the additions', target: k, headers: B, volatile: KEYS },
  );
  return cases;
};
