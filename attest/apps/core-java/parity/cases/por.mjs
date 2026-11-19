/**
 * Proof of reserves: a signed snapshot statement in, by either path, and
 * what is read back of it — by the exchange through its key, and by anyone
 * through the public material.
 *
 * The exchange side is the SDK's own (packages/attest-por): the trees, the
 * statements and the openings are built here as a customer builds them, and
 * signed with the keys the seed registered for the exchanges of these cases
 * (tools/seed-reference.mjs keeps their private halves in seed.json — test
 * keys of two throw-away schemas).
 *
 * The reserve chain is the stand-in node (tools/stand-in-eth-rpc.mjs), which
 * both servers are pointed at by their settings files: what it answers is
 * decided by the token contract an entry names, and a balance is a function
 * of the address alone, so both services are told the same. Start it before
 * the servers are asked anything; without it every read is "fetch failed" on
 * both sides, which is the same answer and proves less.
 *
 * A challenge is drawn at random, by each service for itself. With eight
 * leaves or fewer every leaf is challenged and the two answers are alike;
 * with more, each server is sent the openings of its own challenge
 * (`body: (vars) => …`) and the indices are compared as what they are.
 *
 * With the workers off nothing here reaches a wallet or a chain: a
 * commitment stays `accepted` on both sides, and tools/compare-sealing.mjs
 * then holds the two to the same batch and proof.
 */
import { createPrivateKey } from 'node:crypto';
import { buildPorTree, provePorLeaf } from '../../../../packages/attest-por/src/sumtree.ts';
import { leafFromRow } from '../../../../packages/attest-por/src/leaves.ts';
import { buildSnapshotStatement } from '../../../../packages/attest-por/src/snapshot.ts';
import { signEvent } from '../../../core/src/remit/sign.ts';
import { TOKENS } from '../../tools/stand-in-eth-rpc.mjs';

const J = { 'Content-Type': 'application/json' };
const ASSETS = ['BTC', 'ETH', 'USDT'];
const SPECS = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
const SEED = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const CHAIN = 'eip155:31337';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** What is new on every request: ids, times, and the record a commitment became. */
const NEW = [/snapshot_id$/, /created_at$/, /measured_at$/, /attestation_id$/, /\.attestation\.id$/, /issued_at$/, /expires_at$/, /generated_at$/];

/** A tree as an exchange builds one, with the opening of every leaf. */
function grow(exchangeId, leaves, algo = 'merkle-sum-sha256-v2') {
  const rows = Array.from({ length: leaves }, (_, i) => ({ user_ref: `U-${2000 + i}`,
    balances: { BTC: String(100000 * (i + 1)), ETH: i === 5 ? '0' : String(10n ** 18n * BigInt(i + 2)), USDT: String(2500000 * (leaves - i)) } }));
  const inputs = rows.map((r) => leafFromRow(exchangeId, SEED, r));
  const tree = buildPorTree(inputs, ASSETS, { algo });
  const proofs = inputs.map((input) => provePorLeaf(tree, tree.index[input.user_ref], { user_ref_hash: input.user_ref_hash, salt: input.salt, balances: input.balances }))
    .sort((a, b) => a.leaf_index - b.leaf_index);
  return { tree, proofs };
}

export default ({ seed }) => {
  const P = seed.por;
  const EX = P.institutions.exchange;
  const key = { Authorization: `Bearer ${P.keys.exchange}` };
  const signer = (name) => createPrivateKey(P.signing[name].pem);
  const cases = [];
  const add = (...c) => cases.push(...c);
  const post = (name, target, body, { as = key, ...extra } = {}) => ({ name, method: 'POST', target, headers: { ...J, ...as }, body, ...extra });
  const get = (name, target, as = key, extra = {}) => ({ name, target, headers: as, ...extra });
  const snapshots = '/v1/por/snapshots';
  const published = (id) => `/v1/public/por/snapshots/${id}`;

  // Every statement of this run is of its own instant, so that each is a snapshot of its own.
  let minute = 0;
  const T8 = grow(EX, 8);
  const T8v1 = grow(EX, 8, 'merkle-sum-sha256-v1');
  const T12 = grow(EX, 12);
  const T3 = grow(EX, 3);
  const statementOf = (t, { exchange = EX, reserves, change } = {}) => {
    const at = new Date(Date.UTC(2026, 9, 1, 0, minute++));
    // A copy all the way down: the builder hands back the tree's own totals and the asset list it was given.
    const st = structuredClone(buildSnapshotStatement({ institutionId: exchange, name: 'Reserve Parity Exchange', asof: at.toISOString(), assets: SPECS, ...(reserves ? { reserves } : {}) }, t.tree, at));
    if (change) change(st);
    return st;
  };
  const signed = (statement, by = 'exchange', extra = {}) => ({ statement, sig: signEvent(statement, signer(by), EX, EX), ...extra });
  const submit = (name, body, extra = {}) => post(name, snapshots, body, { volatile: NEW, blur: [[UUID, '<id>']], ...extra });
  const openings = (name, id, body, extra = {}) => post(name, `${snapshots}/${id}/openings`, body, { volatile: NEW, blur: [[UUID, '<id>']], ...extra });
  const read = (name, id, extra = {}) => get(name, `${snapshots}/${id}`, key, { volatile: NEW, blur: [[UUID, '<id>']], ...extra });
  const publicly = (name, id, extra = {}) => ({ name, target: published(id), volatile: [...NEW, /\.bundle\.generated_at$/], blur: [[UUID, '<id>']], ...extra });

  // ── who is let in ─────────────────────────────────────────────────────────
  const anySigned = signed(statementOf(T8));
  for (const [method, target, body] of [['POST', snapshots, anySigned], ['POST', `${snapshots}/${P.snapshots.challengedOpen}/openings`, { openings: [] }],
    ['GET', snapshots], ['GET', `${snapshots}/${P.snapshots.acceptedConfirmed}`]]) {
    const base = { method, target, ...(body === undefined ? {} : { body }) };
    const h = method === 'POST' ? J : {};
    add(
      { name: `${method} ${target} without a key`, ...base, headers: h },
      { name: `${method} ${target} with a key that was revoked`, ...base, headers: { ...h, Authorization: `Bearer ${seed.keys.aRevoked}` } },
      { name: `${method} ${target} with no subscription`, ...base, headers: { ...h, Authorization: `Bearer ${seed.keys.a}` }, volatile: NEW },
      { name: `${method} ${target} with a subscription switched off`, ...base, headers: { ...h, Authorization: `Bearer ${seed.console.keys.quota.secret}` }, volatile: NEW },
      { name: `${method} ${target} with an exchange that has no key`, ...base, headers: { ...h, Authorization: `Bearer ${P.keys.noKey}` }, volatile: NEW },
    );
  }
  // The gate comes before the body is read: an organisation that may not submit is told so, whatever it sent.
  add(
    post('a body that is not JSON, from an organisation with no subscription', snapshots, '{', { as: { Authorization: `Bearer ${seed.keys.a}` } }),
    post('openings that are not JSON, from an organisation with no subscription', `${snapshots}/x/openings`, '{', { as: { Authorization: `Bearer ${seed.keys.a}` } }),
    { name: 'the public material needs no key', target: published(P.snapshots.acceptedConfirmed), volatile: [/\.bundle\.generated_at$/] },
    { name: 'the public material with a key that was revoked', target: published(P.snapshots.acceptedConfirmed), headers: { Authorization: `Bearer ${seed.keys.aRevoked}` }, volatile: [/\.bundle\.generated_at$/] },
    get('where the engine gave up: the snapshots of an organisation, read with the console\'s session', snapshots, { Cookie: `stonehash_session=${seed.console.sessions.main}` }),
  );

  // ── what a submission has to carry ────────────────────────────────────────
  const good = statementOf(T8);
  const sig = signEvent(good, signer('exchange'), EX, EX);
  add(
    post('a body that is not JSON', snapshots, '{'),
    post('a body that is null', snapshots, 'null'),
    post('a body that is a list', snapshots, '[]'),
    post('a body that is text', snapshots, '"statement"'),
    post('an empty body', snapshots, '{}'),
    post('a statement and no signature', snapshots, { statement: good }),
    post('a signature and no statement', snapshots, { sig }),
    post('a statement that is false', snapshots, { statement: false, sig }),
    post('a signature that is zero', snapshots, { statement: good, sig: 0 }),
    post('a spot check asked for with a word', snapshots, { statement: good, sig, spot_check: 'yes' }),
    post('a spot check asked for with a number', snapshots, { statement: good, sig, spot_check: 1 }),
    post('a spot check that is null', snapshots, { statement: good, sig, spot_check: null }),
    post('a statement that is text', snapshots, { statement: 'statement', sig }),
    post('a statement that is a list', snapshots, { statement: [1], sig }),
    post('a statement with nothing in it', snapshots, { statement: { a: 1 }, sig }),
  );
  // One rule broken at a time; the signature is not looked at before the shape holds.
  const broken = (name, change) => add(post(`a statement with ${name}`, snapshots, { statement: statementOf(T8, { change }), sig }));
  broken('a schema of another version', (s) => { s.schema = 'stonehash.por-snapshot.v2'; });
  broken('no exchange id', (s) => { s.exchange = { name: 'x' }; });
  broken('an as-of time that is no time', (s) => { s.asof = 'yesterday'; });
  broken('no assets', (s) => { s.assets = []; });
  broken('a tree format nobody wrote', (s) => { s.tree.algo = 'merkle-sum-sha256-v3'; });
  broken('the padding of the other format', (s) => { s.tree.padding = 'empty-zero'; });
  broken('a root in capitals', (s) => { s.tree.root = s.tree.root.toUpperCase(); });
  broken('no leaves', (s) => { s.tree.leaf_count = 0; });
  broken('a total below zero', (s) => { s.totals.BTC = '-1'; });
  broken('totals that are text', (s) => { s.totals = 'totals'; });
  broken('everything wrong at once', (s) => { for (const k of Object.keys(s)) delete s[k]; Object.assign(s, { schema: 'x', exchange: {}, asof: 'never', assets: [], tree: { algo: 'x', root: 'x', leaf_count: 0 }, totals: { A: '-1', B: 'x' } }); });
  // Where the reference failed inside its runtime (D-01): the same status, and no sentence of the runtime's here.
  add(post('where the engine gave up: a statement with a total that has a member named toString', snapshots, { statement: statementOf(T8, { change: (s) => { s.totals.BTC = { toString: 1 }; } }), sig }));
  // As-of times only the JavaScript engine reads (D-04): refused here, and nothing is stored on either side
  // because the signature below is over another statement.
  for (const [name, asof] of [['a date with slashes', '2026/10/01'], ['a date in words', 'Oct 1, 2026'], ['a number', 2026], ['a list holding the time', ['2026-10-01T00:00:00.000Z']]]) {
    add(post(`a statement whose as-of time is ${name}`, snapshots, { statement: statementOf(T8, { change: (s) => { s.asof = asof; } }), sig }));
  }

  // ── who signed it ─────────────────────────────────────────────────────────
  const other = statementOf(T8, { exchange: 'KR-EX-SOMEONE-ELSE' });
  const s1 = statementOf(T8);
  const sig1 = signEvent(s1, signer('exchange'), EX, EX);
  const std = (s) => s.replace(/-/g, '+').replace(/_/g, '/');
  add(
    post('a statement that names another exchange', snapshots, { statement: other, sig: signEvent(other, signer('exchange'), EX, EX) }),
    post('where the engine gave up: a statement that names an exchange with a member named toString', snapshots, { statement: statementOf(T8, { change: (s) => { s.exchange.institution_id = { toString: 1 }; } }), sig }),
    post('a signature by a key nobody registered', snapshots, signed(statementOf(T8), 'stranger')),
    post('a signature over another statement', snapshots, { statement: statementOf(T8), sig: sig1 }),
    post('a signature said to be RS256', snapshots, { statement: s1, sig: { ...sig1, alg: 'RS256' } }),
    post('a signature with no value', snapshots, { statement: s1, sig: { alg: 'ES256', key_id: EX, issuer: EX } }),
    post('a signature whose value is a number', snapshots, { statement: s1, sig: { ...sig1, sig: 5 } }),
    post('a signature whose value is a list of bytes', snapshots, { statement: s1, sig: { ...sig1, sig: [...Buffer.from(sig1.sig, 'base64url')] } }),
    post('a signature that is text', snapshots, { statement: s1, sig: sig1.sig }),
    post('a signature that is a list', snapshots, { statement: s1, sig: [sig1] }),
    post('a signature one character short', snapshots, { statement: s1, sig: { ...sig1, sig: sig1.sig.slice(1) } }),
    post('a statement with a number that has a fraction', snapshots, { statement: statementOf(T8, { change: (s) => { s.assets[0].decimals = 8.5; } }), sig }),
    post('a statement with a number beyond the safe range', snapshots, { statement: statementOf(T8, { change: (s) => { s.tree.leaf_count = 2 ** 60; } }), sig }),
  );

  // ── what cannot be measured or stored ─────────────────────────────────────
  const refused = (name, change) => add(submit(`a signed statement with ${name}`, signed(statementOf(T8, { change }))));
  refused('more leaves than a row holds', (s) => { s.tree.leaf_count = 2147483648; });
  refused('reserve entries that are not a list', (s) => { s.reserves = { mode: 'DECLARED', entries: { 0: {} }, note: 'x' }; });
  refused('reserves that are a list', (s) => { s.reserves = [{ chain: CHAIN }]; });
  refused('reserve entries of the wrong shape', (s) => { s.reserves = { mode: 'DECLARED', note: 'x', entries: [null, 'entry', [], {}, { chain: CHAIN, asset: 'USDT', address: '' },
    { chain: CHAIN, asset: 'USDT', address: '0x01', token_contract: 5 }, { chain: 1, asset: 'USDT', address: '0x01' }, { chain: CHAIN, asset: 'USDT', address: '0x01' }] }; });
  refused('both: too many leaves and entries of the wrong shape', (s) => { s.tree.leaf_count = 4294967296; s.reserves = { entries: [5] }; });

  // ── root only: anchored at once ───────────────────────────────────────────
  const a1 = signed(statementOf(T8));
  add(
    submit('a signed statement is accepted', a1, { capture: { accepted: '$.snapshot_id', acceptedRecord: '$.attestation_id' } }),
    read('the snapshot just accepted', '{accepted}'),
    get('the record its commitment became', '/v1/attestations/{acceptedRecord}', key, { volatile: [/^\$\.id$/, /created_at$/, /snapshot_id$/] }),
    publicly('the public material of the snapshot just accepted', '{accepted}'),
    submit('the same statement again is the same snapshot', a1),
    submit('the same statement again, asked for with spot_check false', { ...a1, spot_check: false }),
    openings('openings for a snapshot that was never challenged', '{accepted}', { openings: T8.proofs }),
    openings('openings that are not JSON, for a snapshot that was never challenged', '{accepted}', '{'),
    submit('a statement signed with the console\'s key', signed(statementOf(T8), 'console'), { capture: { byConsole: '$.snapshot_id' } }),
    publicly('the public material names the key that signed, as the store keeps it', '{byConsole}'),
    submit('a statement in the first tree format', signed(statementOf(T8v1)), { capture: { v1: '$.snapshot_id' } }),
    read('the snapshot in the first tree format', '{v1}'),
    submit('a statement that names no padding', signed(statementOf(T8, { change: (s) => { delete s.tree.padding; } }))),
    submit('a statement with members of its own', signed(statementOf(T8, { change: (s) => { s.note = 'é😀'; s.extra = { 10: 'ten', 9: 'nine', b: [1, 2] }; s.totals = { USDT: s.totals.USDT, BTC: s.totals.BTC, ETH: s.totals.ETH }; } })),
      { capture: { own: '$.snapshot_id' } }),
    publicly('a statement comes back as it was sent', '{own}'),
    submit('a statement whose totals are numbers', signed(statementOf(T3, { change: (s) => { s.totals = { BTC: 600000, ETH: s.totals.ETH, USDT: 15000000 }; } })), { capture: { numeric: '$.snapshot_id' } }),
    read('the snapshot whose totals are numbers', '{numeric}'),
    submit('a statement whose root is a list holding the root', signed(statementOf(T3, { change: (s) => { s.tree.root = [s.tree.root]; } })), { capture: { listed: '$.snapshot_id' } }),
    read('the snapshot whose root was a list', '{listed}'),
  );

  // ── the reserve side: measured, not trusted ───────────────────────────────
  const holder = (n) => `0x${n.toString(16).padStart(40, '0')}`;
  const entry = (asset, token, n, extra = {}) => ({ chain: CHAIN, asset, address: holder(n), ...(token ? { token_contract: token } : {}), ...extra });
  const reserves = (entries) => ({ mode: 'DECLARED', entries, note: 'declared for the comparison' });
  const measuring = (name, entries, extra = {}, tree = T8) => add(
    submit(`reserves: ${name}`, signed(statementOf(tree, { reserves: reserves(entries) })), { capture: { measured: '$.snapshot_id' }, ...extra }),
    read(`reserves: ${name}, read back`, '{measured}', extra),
    publicly(`reserves: ${name}, in the public material`, '{measured}', extra),
  );
  measuring('one address that covers its asset', [entry('USDT', TOKENS.balance, 123456789)]);
  measuring('two addresses of one asset, and an asset with none', [entry('USDT', TOKENS.balance, 30), entry('USDT', TOKENS.balance, 60), entry('BTC', TOKENS.balance, 1)]);
  measuring('declared on a chain this deployment does not read', [{ chain: 'eip155:1', asset: 'USDT', address: holder(5), token_contract: TOKENS.balance }, entry('ETH', undefined, 5), entry('BTC', '', 5)]);
  measuring('a contract that reverts, beside one that answers', [entry('USDT', TOKENS.reverted, 90), entry('USDT', TOKENS.balance, 45)]);
  measuring('an answer with neither a result nor an error', [entry('USDT', TOKENS.empty, 90)]);
  measuring('a connection cut without an answer', [entry('USDT', TOKENS.cut, 90)]);
  measuring('a balance written in decimal, and one under a status of 500', [entry('USDT', TOKENS.decimal, 90), entry('BTC', TOKENS.failing, 4)]);
  measuring('a result that is no number', [entry('USDT', TOKENS.words, 90)]);
  measuring('a balance below zero', [entry('USDT', TOKENS.negative, 90)]);
  measuring('a contract nobody deployed', [entry('USDT', holder(0xdead), 90)]);
  measuring('an address with no prefix, in capitals, and one that is no address', [{ ...entry('USDT', TOKENS.balance, 0xabcdef), address: holder(0xabcdef).slice(2).toUpperCase() }, { ...entry('BTC', TOKENS.balance, 1), address: 'not an address' }]);
  measuring('entries with members of their own', [entry('USDT', TOKENS.balance, 77, { label: 'cold wallet', n: 1 })]);
  // What the reference reports here is its runtime's complaint about the answer (D-16).
  measuring('an answer the engine could not read: a page where JSON belongs', [entry('USDT', TOKENS.page, 90)]);
  measuring('an answer the engine could not read: null', [entry('USDT', TOKENS.nothing, 90)]);
  // One read that takes longer than a read may: both services give up on it after five seconds and go on to the next.
  measuring('a node that answers too late, then one that answers', [entry('USDT', TOKENS.slow, 90), entry('USDT', TOKENS.balance, 9)]);

  // ── spot check: nothing is anchored until the openings pass ───────────────
  const c1 = signed(statementOf(T8, { reserves: reserves([entry('USDT', TOKENS.balance, 200)]) }), 'exchange', { spot_check: true });
  add(
    submit('a spot check is answered with a challenge', c1, { capture: { challenged: '$.snapshot_id' } }),
    read('a challenged snapshot', '{challenged}'),
    publicly('a challenged snapshot is not published', '{challenged}'),
    openings('openings that are not JSON', '{challenged}', '{'),
    openings('a body with no openings', '{challenged}', {}),
    openings('a body that is null', '{challenged}', 'null'),
    openings('openings that are not a list', '{challenged}', { openings: { 0: T8.proofs[0] } }),
    // Where the reference failed inside its runtime (D-01): nothing is settled, and the challenge stays open.
    openings('where the engine gave up: an opening that is null', '{challenged}', { openings: [...T8.proofs.slice(0, 7), null] }),
    openings('where the engine gave up: an opening with no siblings', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { leaf_index: p.leaf_index, leaf: p.leaf } : p)) }),
    openings('where the engine gave up: an opening whose sibling is null', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { ...p, siblings: [null, ...p.siblings.slice(1)] } : p)) }),
    openings('where the engine gave up: an opening whose index has a member named toString', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { ...p, leaf_index: { toString: 1 } } : p)) }),
    // Where its code refused with a sentence of its own, and the request failed with it: the same sentence.
    openings('an opening whose sibling hash is a number', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { ...p, siblings: [{ ...p.siblings[0], hash: 5 }, ...p.siblings.slice(1)] } : p)) }),
    openings('an opening whose sibling hash is not hex', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { ...p, siblings: [{ ...p.siblings[0], hash: 'zz'.repeat(32) }, ...p.siblings.slice(1)] } : p)) }),
    openings('an opening whose sibling sum is beyond the safe range', '{challenged}', { openings: T8.proofs.map((p, i) => (i === 2 ? { ...p, siblings: [{ ...p.siblings[0], sums: { ...p.siblings[0].sums, BTC: 2 ** 60 } }, ...p.siblings.slice(1)] } : p)) }),
    read('the challenge is still open', '{challenged}'),
    openings('every challenged leaf, opened', '{challenged}', { openings: T8.proofs }),
    read('a verified snapshot', '{challenged}'),
    publicly('a verified snapshot says it was sampled', '{challenged}'),
    openings('openings for a snapshot already verified', '{challenged}', { openings: T8.proofs }),
  );
  // Each way of getting it wrong settles the snapshot as rejected, so each has a snapshot of its own.
  const rejecting = (name, body) => add(
    submit(`${name}: the challenge`, signed(statementOf(T8), 'exchange', { spot_check: true }), { capture: { r: '$.snapshot_id' } }),
    openings(`${name}: the openings`, '{r}', body),
    read(`${name}: the snapshot afterwards`, '{r}'),
    publicly(`${name}: not published`, '{r}'),
    openings(`${name}: the right openings, too late`, '{r}', { openings: T8.proofs }),
  );
  const swap = (i, change) => ({ openings: T8.proofs.map((p, n) => (n === i ? change(structuredClone(p)) : p)) });
  rejecting('one leaf not opened', { openings: T8.proofs.slice(1) });
  rejecting('no leaf opened', { openings: [] });
  rejecting('one leaf opened twice', { openings: [...T8.proofs, T8.proofs[3]] });
  rejecting('the leaves in another order', { openings: [...T8.proofs].reverse().map((p) => ({ ...p, leaf_index: 7 - p.leaf_index })) });
  rejecting('a balance one unit lower', swap(4, (p) => { p.leaf.balances.BTC = String(BigInt(p.leaf.balances.BTC) - 1n); return p; }));
  rejecting('a sibling sum one unit higher', swap(4, (p) => { p.siblings[1].sums.USDT = String(BigInt(p.siblings[1].sums.USDT) + 1n); return p; }));
  rejecting('a sibling on the other side', swap(1, (p) => { p.siblings[0].dir = p.siblings[0].dir === 'left' ? 'right' : 'left'; return p; }));
  rejecting('a negative balance', swap(6, (p) => { p.leaf.balances.BTC = '-1'; return p; }));
  rejecting('a balance filed under __proto__', `{"openings":${JSON.stringify(T8.proofs).replace('"balances":{', '"balances":{"__proto__":"5",')}}`);
  rejecting('indices that are text', { openings: T8.proofs.map((p) => ({ ...p, leaf_index: String(p.leaf_index) })) });
  rejecting('worded by the engine: openings that are not openings', { openings: [5, 'opening', true, [], {}, { leaf_index: 'x' }, { leaf_index: [3] }, { leaf_index: null }] });
  // Where the reference caught its runtime's complaint and passed it on as the problem (D-03).
  rejecting('worded by the engine: an opening with no leaf', swap(2, (p) => { delete p.leaf; return p; }));
  rejecting('worded by the engine: an opening with no balances', swap(2, (p) => { delete p.leaf.balances; return p; }));
  rejecting('worded by the engine: a sibling with no sums', swap(2, (p) => { delete p.siblings[0].sums; return p; }));
  rejecting('worded by the engine: a balance with a member named toString', swap(2, (p) => { p.leaf.balances.BTC = { toString: 1 }; return p; }));

  // A snapshot of more than eight leaves: each service draws eight of twelve for itself, and is sent its own.
  add(
    submit('twelve leaves: the challenge', signed(statementOf(T12), 'exchange', { spot_check: true }), { capture: { twelve: '$.snapshot_id', indices: '$.challenge.indices' }, volatile: [...NEW, /^\$\.challenge\.indices$/] }),
    read('twelve leaves: the challenge, read back', '{twelve}', { volatile: [...NEW, /^\$\.challenge\.indices$/] }),
    { ...openings('twelve leaves: the eight that were asked for', '{twelve}', null), body: (vars) => ({ openings: vars.indices.map((i) => T12.proofs[i]) }) },
    read('twelve leaves: verified', '{twelve}', { volatile: [...NEW, /^\$\.challenge\.indices$/] }),
    publicly('twelve leaves: published, eight sampled of twelve', '{twelve}'),
  );
  // One statement taken down both paths shares one anchor, and each record keeps its own account of it.
  const both = statementOf(T3);
  add(
    submit('both paths: root only first', signed(both), { capture: { rootOnly: '$.snapshot_id', shared: '$.attestation_id' } }),
    submit('both paths: then a spot check of the same statement', signed(both, 'exchange', { spot_check: true }), { capture: { sampled: '$.snapshot_id' } }),
    openings('both paths: the three leaves, opened', '{sampled}', { openings: T3.proofs }),
    read('both paths: the root-only snapshot', '{rootOnly}'),
    read('both paths: the sampled snapshot', '{sampled}'),
    publicly('both paths: the sampled one says three of three', '{sampled}'),
  );

  // ── reading back what the store holds ─────────────────────────────────────
  const S = P.snapshots;
  const rotated = { Authorization: `Bearer ${P.keys.rotated}` };
  for (const name of ['acceptedConfirmed', 'verifiedConfirmed', 'acceptedSubmitted', 'acceptedBatched', 'acceptedWaiting', 'acceptedNoRecord', 'acceptedRecordGone', 'acceptedRecordOfAnother',
    'verifiedThreeLeaves', 'challengedOpen', 'challengedExpired', 'rejected', 'byConsoleKey', 'reservesNull', 'reservesEmpty', 'keyEmpty', 'noKeyVerifies']) {
    add(get(`stored (${name}): through the key`, `${snapshots}/${S[name]}`), { name: `stored (${name}): the public material`, target: published(S[name]), volatile: [/\.bundle\.generated_at$/] });
  }
  for (const name of ['noKeyRotated', 'noKeyNoInstitution', 'noKeySigUnreadable']) {
    add(get(`stored (${name}): through the key`, `${snapshots}/${S[name]}`, rotated), { name: `stored (${name}): the public material`, target: published(S[name]), volatile: [/\.bundle\.generated_at$/] });
  }
  // Stored text that is not JSON: read where the answer needs it, and nowhere else.
  add(
    get(`where the engine gave up: stored reserves that are not JSON, through the key`, `${snapshots}/${S.brokenReserves}`, rotated),
    { name: `where the engine gave up: stored reserves that are not JSON, in the public material`, target: published(S.brokenReserves) },
    get('a stored statement that is not JSON, through the key', `${snapshots}/${S.brokenStatement}`, rotated),
    { name: `where the engine gave up: a stored statement that is not JSON, in the public material`, target: published(S.brokenStatement) },
  );
  add(
    openings('openings for a challenge that has run out', S.challengedExpired, { openings: [] }),
    openings('openings for a snapshot already rejected', S.rejected, { openings: [] }),
    openings('openings for a snapshot of another organisation', S.list000, { openings: [] }),
    openings('openings for a snapshot nobody made', 'no-such-snapshot', { openings: [] }),
    openings('worded by the engine: openings of other leaves than the stored challenge asked for', S.challengedOpen, { openings: [{ leaf_index: 7 }, { leaf_index: '3' }, {}, { leaf_index: 1.5 }] }),
    get('a snapshot of another organisation', `${snapshots}/${S.list000}`),
    get('a snapshot nobody made', `${snapshots}/no-such-snapshot`),
    get('a snapshot whose id has to be decoded', `${snapshots}/a%20b%2Fc`),
    { name: 'public material nobody published', target: published('no-such-snapshot') },
    { name: 'public material under an id that has to be decoded', target: published('a%20b%2Fc') },
    get('the snapshots of an organisation, newest first', snapshots, key, { volatile: NEW, blur: [[UUID, '<id>']] }),
    get('more snapshots than a page holds', snapshots, { Authorization: `Bearer ${P.keys.list}` }),
    get('the snapshots of an organisation with none', snapshots, { Authorization: `Bearer ${seed.keys.b}` }),
    get('where the engine gave up: the snapshots of an organisation with one that cannot be read', snapshots, rotated),
    { name: 'the snapshots of an organisation, asked for with a query', target: `${snapshots}?limit=2&status=VERIFIED`, headers: { Authorization: `Bearer ${P.keys.list}` } },
    { name: 'a snapshot asked for with another method', method: 'DELETE', target: `${snapshots}/${S.acceptedConfirmed}`, headers: key },
    { name: 'the public material asked for with POST', method: 'POST', target: published(S.acceptedConfirmed), headers: J, body: {} },
  );
  return cases;
};
