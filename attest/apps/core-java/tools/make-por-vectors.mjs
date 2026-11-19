/**
 * Vectors that hold the Java service's reserve proofs to the reference:
 *
 *   statements   packages/attest-por/src/snapshot.ts: validateSnapshotStatement — named cases (one broken rule each,
 *                every rule at once, both tree formats) and a table: every place of a statement × values of every kind
 *   commitments  packages/attest-verify/src/merkle-sum.ts: porSnapshotCommitment
 *   inclusion    verifyPorInclusion — the repository's own proofs (fixtures/por), proofs broken in each way, and a
 *                table: every place of an opening and of what it is checked against × values of every kind
 *   solvency     apps/core/src/por/reserves.ts: solvency
 *   rpc          measureReserves against a node of one method that this tool starts itself (never the deployment's):
 *                every kind of answer, what was sent, and what the report says of it
 *
 *   node apps/core-java/tools/make-por-vectors.mjs          write src/test/resources/vectors/por.json
 *   node apps/core-java/tools/make-por-vectors.mjs --check  fail when the file on disk differs
 *
 * Every input is kept as the JSON text it was (`…Json` fields): a member named `__proto__`, the order of members and
 * `-0` do not survive being a value twice. Every answer is the reference's: `{ value }`, or `{ plain }` where its
 * code refused with a sentence of its own, or `{ engine }` where its runtime threw. Where the Java service answers
 * differently on purpose the case says so (`java`), with the row of docs/JAVA-INTENDED-DIFFERENCES.md that says why;
 * a sentence the reference took from its runtime is marked (`engineWorded`: the positions in `problems`), and there
 * the Java service has a sentence of its own.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshotStatement } from '../../../packages/attest-por/src/snapshot.ts';
import { buildPorTree, provePorLeaf } from '../../../packages/attest-por/src/sumtree.ts';
import { leafFromRow } from '../../../packages/attest-por/src/leaves.ts';
import { verifyPorInclusion, porSnapshotCommitment } from '../../../packages/attest-verify/src/merkle-sum.ts';
import { measureReserves, solvency } from '../../core/src/por/reserves.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/vectors/por.json');
const FIX = path.resolve(HERE, '../../../fixtures/por');
const check = process.argv.includes('--check');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIX, name), 'utf8'));

// ── answers ────────────────────────────────────────────────────────────────────────────────────────────────────
/** A sentence the reference did not write: its runtime's complaint about its own source, caught and passed on. */
const ENGINE_WORDS = /Cannot read properties of|Cannot convert (undefined|null|object)|is not a function|is not iterable|Cannot use 'in' operator|Unexpected (token|end|non-whitespace)|is not valid JSON/;
const answer = (fn) => {
  try { return { value: fn() }; } catch (e) {
    return e?.constructor === Error ? { plain: e.message } : { engine: `${e?.constructor?.name}: ${e?.message}` };
  }
};
const D03 = 'D-03: where the reference caught its own runtime\'s complaint and passed it on as the problem, the sentence here is one about the opening';
const D04 = 'D-04: an as-of time has to be text written the ISO 8601 way; the reference took whatever the JavaScript engine reads, of a value of any kind';

/** A JSON text with one place replaced (`absent` removes the member). Paths are dotted; a number is a list position. */
const at = (baseJson, where, valueJson) => {
  if (where === '$') return valueJson === 'absent' ? null : valueJson;
  const root = JSON.parse(baseJson);
  const steps = where.split('.');
  let o = root;
  for (const s of steps.slice(0, -1)) o = o[s];
  const last = steps[steps.length - 1];
  if (valueJson === 'absent') { if (Array.isArray(o)) o.splice(Number(last), 1); else delete o[last]; } else o[last] = JSON.parse(valueJson);
  return JSON.stringify(root);
};

// ── statements ─────────────────────────────────────────────────────────────────────────────────────────────────
const F = fixture('statement.json');
const S = JSON.stringify(F.statement);
const V2 = fixture('trees-v2.json').statement;
const statements = [];
const stmt = (name, json, extra = {}) => {
  const a = answer(() => validateSnapshotStatement(JSON.parse(json)));
  statements.push({ name, statementJson: json, answer: a, ...extra });
};
/** What the Java service says of a statement whose as-of time it does not read: the reference's answer for one whose time nothing reads. */
const withUnreadAsof = (json) => answer(() => { const s = JSON.parse(json); if (s && typeof s === 'object') s.asof = 'not a time'; return validateSnapshotStatement(s); });

stmt('the repository\'s statement (v1 tree, reserves declared)', S);
stmt('the repository\'s v2 statement (120 assets)', JSON.stringify(V2.statement));
stmt('a statement that names no padding', at(S, 'tree.padding', 'absent'));
stmt('v2 with its own padding', at(at(S, 'tree.algo', '"merkle-sum-sha256-v2"'), 'tree.padding', '"empty"'));
stmt('v2 with the padding of v1', at(S, 'tree.algo', '"merkle-sum-sha256-v2"'));
stmt('v1 with the padding of v2', at(S, 'tree.padding', '"empty"'));
stmt('a schema of another version', at(S, 'schema', '"stonehash.por-snapshot.v2"'));
stmt('no exchange', at(S, 'exchange', 'absent'));
stmt('an exchange with no id', at(S, 'exchange.institution_id', '""'));
stmt('no as-of time', at(S, 'asof', 'absent'));
stmt('an as-of time that is no time', at(S, 'asof', '"yesterday"'));
stmt('no assets', at(S, 'assets', '[]'));
stmt('assets that are not a list', at(S, 'assets', '{"0":{"symbol":"A1","decimals":8}}'));
stmt('a tree format nobody wrote', at(S, 'tree.algo', '"merkle-sum-sha256-v3"'));
stmt('a root in capitals', at(S, 'tree.root', JSON.stringify(F.statement.tree.root.toUpperCase())));
stmt('a root one character short', at(S, 'tree.root', JSON.stringify(F.statement.tree.root.slice(1))));
stmt('a root followed by a line break', at(S, 'tree.root', JSON.stringify(`${F.statement.tree.root}\n`)));
stmt('no leaves', at(S, 'tree.leaf_count', '0'));
stmt('a leaf count that is text', at(S, 'tree.leaf_count', '"12"'));
stmt('a leaf count with a fraction', at(S, 'tree.leaf_count', '12.5'));
stmt('a leaf count beyond what a row holds', at(S, 'tree.leaf_count', '2147483648'));
stmt('no totals', at(S, 'totals', 'absent'));
stmt('totals that are a list', at(S, 'totals', '["5","x","07"]'));
stmt('a negative total', at(S, 'totals.A1', '"-1"'));
stmt('a total with a leading zero', at(S, 'totals.B2', '"007"'));
stmt('a total with a fraction', at(S, 'totals.C3', '"1.5"'));
stmt('a total that is a number', at(S, 'totals.D4', '5'));
stmt('a total followed by a line break', at(S, 'totals.E5', '"5\\n"'));
stmt('a total in full-width digits', at(S, 'totals.E5', '"５"'));
stmt('a total filed under __proto__', `${S.slice(0, S.indexOf('"totals":{') + 10)}"__proto__":"x",${S.slice(S.indexOf('"totals":{') + 10)}`);
stmt('totals filed under names that are numbers', at(S, 'totals', '{"b":"1","10":"x","9":"y","a":"z"}'));
stmt('everything wrong at once',
  '{"schema":"x","exchange":{},"asof":"never","assets":[],"tree":{"algo":"x","padding":"x","root":"x","leaf_count":0},"totals":{"A":"-1","B":"x"}}');
stmt('an empty object', '{}');
stmt('a list', '[]');
stmt('text', '"statement"');
stmt('a number', '5');
// As-of times only the JavaScript engine reads (D-04). The Java answer is the reference's for a time nothing reads.
for (const [name, v] of [['a year alone, as a number', '2026'], ['a date with slashes', '"2026/11/18"'], ['a date in words', '"Nov 18, 2026"'],
  ['a list holding an ISO time', '["2026-11-18T00:00:00.000Z"]'], ['the number 5', '5'], ['true in a list', '[true]']]) {
  const json = at(S, 'asof', v);
  const a = answer(() => validateSnapshotStatement(JSON.parse(json)));
  const java = withUnreadAsof(json);
  statements.push({ name: `an as-of time that is ${name}`, statementJson: json, answer: a, ...(JSON.stringify(a) === JSON.stringify(java) ? {} : { java, why: D04 }) });
}

const HEX = 'ab'.repeat(32);
const VALUES = ['absent', 'null', 'true', 'false', '0', '1', '3', '5', '-1', '1.5', '1e21', '4294967299', '""', '"3"', '"5"', '"abc"', '"left"', '"right"',
  '"2026-11-18T00:00:00.000Z"', '"merkle-sum-sha256-v2"', '"empty"', '[]', '["5"]', '[3]', '[[5]]', '{}', '{"toString":1}', '{"a":"1"}', '{"length":0}', '{"length":4}',
  JSON.stringify(HEX), JSON.stringify([HEX]), JSON.stringify(HEX.toUpperCase()), JSON.stringify('zz'.repeat(32)), '"abcd"', '"0x"', '" 1"'];
const STATEMENT_PLACES = ['$', 'schema', 'exchange', 'exchange.institution_id', 'asof', 'assets', 'tree', 'tree.algo', 'tree.padding', 'tree.root', 'tree.leaf_count',
  'totals', 'totals.A1', 'params', 'reserves', 'generated_at'];
const ISO = '"2026-11-18T00:00:00.000Z"';
const statementTable = STATEMENT_PLACES.map((where) => VALUES.map((v) => {
  const json = at(S, where, v);
  if (json === null) return { skip: true };
  const a = answer(() => validateSnapshotStatement(JSON.parse(json)));
  // The one place where the Java service reads less: an as-of time that is not the ISO text.
  if (where === 'asof' && v !== ISO) {
    const java = withUnreadAsof(json);
    if (JSON.stringify(java) !== JSON.stringify(a)) return { ...a, java };
  }
  return a;
}));

// ── commitments ────────────────────────────────────────────────────────────────────────────────────────────────
const commitments = [];
const commit = (name, json) => commitments.push({ name, statementJson: json, answer: answer(() => porSnapshotCommitment(JSON.parse(json))) });
commit('the repository\'s statement', S);
commit('the repository\'s v2 statement', JSON.stringify(V2.statement));
commit('the same statement with its members in another order', JSON.stringify(Object.fromEntries(Object.entries(F.statement).reverse())));
commit('a whole number written with a fraction and an exponent', '{"a":1.0,"b":1e3,"c":-0,"d":9007199254740991}');
commit('a number with a fraction', '{"decimals":1.5}');
commit('a number beyond the safe range', '{"n":9007199254740993}');
commit('text of every kind', '{"é":"\\u2028\\"\\\\/","\\ud83d\\ude00":"😀","":"","lone":"\\ud83d"}');
commit('members named like numbers, and one named __proto__', '{"10":1,"9":2,"__proto__":{"a":1},"a":[[],{}]}');
commit('a list', '[1,"two",[3],null,true]');
commit('text', '"statement"');
commit('null', 'null');
if (porSnapshotCommitment(F.statement) !== F.commitment) throw new Error('the fixture statement no longer has the commitment the fixture states');

// ── inclusion ──────────────────────────────────────────────────────────────────────────────────────────────────
const inclusion = [];
const marked = (a) => {
  if (!a.value) return a;
  const engineWorded = a.value.problems.map((p, i) => (ENGINE_WORDS.test(p) ? i : -1)).filter((i) => i >= 0);
  return engineWorded.length ? { ...a, engineWorded } : a;
};
const check1 = (proofJson, againstJson) => marked(answer(() => {
  const against = JSON.parse(againstJson);
  const r = verifyPorInclusion(JSON.parse(proofJson), against);
  return { ok: r.ok, computedRoot: r.computedRoot, computedTotals: r.computedTotals, problems: r.problems };
}));
const incl = (name, proofJson, againstJson) => inclusion.push({ name, proofJson, againstJson, answer: check1(proofJson, againstJson) });
for (const file of ['trees.json', 'trees-v2.json']) {
  for (const c of fixture(file).cases) {
    c.proofs.forEach((p, i) => incl(`${file} ${c.name}: proof ${i}`, JSON.stringify(p.proof ?? p), JSON.stringify({ root: c.root, totals: c.totals })));
  }
}
const invalid = fixture('trees.json').invalid_proofs;
invalid.proofs.forEach((p, i) => incl(`trees.json: a proof that must not verify, ${i}${p.why ? ` (${p.why})` : ''}`, JSON.stringify(p.proof), JSON.stringify(invalid.against)));
for (const dir of ['snapshot-dir', 'snapshot-dir-v2']) {
  const exp = fixture(`${dir}.expected.json`);
  for (const o of fixture(exp.openings_file).openings) incl(`${dir}: opening of leaf ${o.leaf_index}`, JSON.stringify(o), JSON.stringify({ root: exp.root, totals: exp.totals }));
}

// A tree of this tool's own, small enough to read: eight accounts, three assets, one account holding nothing of one.
const EXCHANGE = 'KR-EX-VECTORS';
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const ASSETS = ['BTC', 'ETH', 'USDT'];
const rows = Array.from({ length: 8 }, (_, i) => ({ user_ref: `U-${1000 + i}`,
  balances: { BTC: String(100000 * (i + 1)), ETH: i === 5 ? '0' : String(10n ** 18n * BigInt(i + 2)), USDT: String(2500000 * (8 - i)) } }));
const trees = {};
for (const algo of ['merkle-sum-sha256-v1', 'merkle-sum-sha256-v2']) {
  const inputs = rows.map((r) => leafFromRow(EXCHANGE, SEED, r));
  const tree = buildPorTree(inputs, ASSETS, { algo });
  // `provePorLeaf` wants the opening of the leaf it proves: the tree keeps hashes, the exchange keeps the openings.
  const proofs = inputs.map((input) => provePorLeaf(tree, tree.index[input.user_ref], { user_ref_hash: input.user_ref_hash, salt: input.salt, balances: input.balances }))
    .sort((a, b) => a.leaf_index - b.leaf_index);
  trees[algo] = { root: tree.root, totals: tree.totals, leaf_count: tree.leaf_count, proofs };
  proofs.forEach((p) => incl(`a tree of eight (${algo}): leaf ${p.leaf_index}`, JSON.stringify(p), JSON.stringify({ root: tree.root, totals: tree.totals })));
}
const T = trees['merkle-sum-sha256-v2'];
const P = JSON.stringify(T.proofs[3]);
const AGAINST = JSON.stringify({ root: T.root, totals: T.totals });
const other = JSON.parse(JSON.stringify(T.proofs[4]));
incl('the opening of one leaf under the index of another', at(P, 'leaf_index', '4'), AGAINST);
incl('one leaf\'s opening with another leaf\'s siblings', JSON.stringify({ ...JSON.parse(P), siblings: other.siblings }), AGAINST);
incl('a balance one unit higher', at(P, 'leaf.balances.BTC', JSON.stringify(String(BigInt(JSON.parse(P).leaf.balances.BTC) + 1n))), AGAINST);
incl('a sibling sum one unit lower', at(P, 'siblings.1.sums.BTC', JSON.stringify(String(BigInt(JSON.parse(P).siblings[1].sums.BTC) - 1n))), AGAINST);
incl('a sibling on the other side', at(P, 'siblings.0.dir', JSON.parse(P).siblings[0].dir === 'left' ? '"right"' : '"left"'), AGAINST);
incl('a sibling left out', at(P, 'siblings.2', 'absent'), AGAINST);
incl('a sibling twice', JSON.stringify({ ...JSON.parse(P), siblings: [...JSON.parse(P).siblings, JSON.parse(P).siblings[0]] }), AGAINST);
incl('a negative balance', at(P, 'leaf.balances.BTC', '"-1"'), AGAINST);
incl('a balance with a fraction', at(P, 'leaf.balances.BTC', '"1.5"'), AGAINST);
incl('a balance that is a number with a fraction', at(P, 'leaf.balances.BTC', '1.5'), AGAINST);
incl('a balance too large for a number', at(P, 'leaf.balances.BTC', '9007199254740993'), AGAINST);
incl('a balance of a hundred digits', at(P, 'leaf.balances.BTC', JSON.stringify('9'.repeat(100))), AGAINST);
incl('a sibling sum of a hundred digits', at(P, 'siblings.0.sums.BTC', JSON.stringify('9'.repeat(100))), AGAINST);
incl('a sibling sum too large for a number', at(P, 'siblings.0.sums.BTC', '9007199254740993'), AGAINST);
incl('a balance filed under __proto__', P.replace('"balances":{', '"balances":{"__proto__":"5",'), AGAINST);
incl('a sibling sum filed under __proto__', P.replace('"sums":{', '"sums":{"__proto__":"5",'), AGAINST);
incl('an asset the tree does not know', at(P, 'leaf.balances.DOGE', '"7"'), AGAINST);
incl('an asset named constructor', at(P, 'leaf.balances.constructor', '"7"'), AGAINST);
incl('declared totals with an asset more', P, at(AGAINST, 'totals.DOGE', '"7"'));
incl('declared totals one unit lower', P, at(AGAINST, 'totals.BTC', JSON.stringify(String(BigInt(T.totals.BTC) - 1n))));
incl('declared totals that are numbers', P, at(AGAINST, 'totals.BTC', '3600000'));
incl('another root', P, at(AGAINST, 'root', JSON.stringify('cd'.repeat(32))));
incl('a salt in capitals', at(P, 'leaf.salt', JSON.stringify(JSON.parse(P).leaf.salt.toUpperCase())), AGAINST);
incl('a sibling hash of two characters', at(P, 'siblings.0.hash', '"ab"'), AGAINST);
incl('a sibling hash that parses in part', at(P, 'siblings.0.hash', JSON.stringify(`1g -1${'0'.repeat(58)}`)), AGAINST);
incl('an index with a fraction', at(P, 'leaf_index', '3.9'), AGAINST);
incl('an index as text', at(P, 'leaf_index', '"3"'), AGAINST);
incl('thirty-three siblings', JSON.stringify({ ...JSON.parse(P), siblings: Array.from({ length: 33 }, () => JSON.parse(P).siblings[0]) }), AGAINST);

const OPENING_PLACES = ['$', 'leaf_index', 'leaf', 'leaf.user_ref_hash', 'leaf.salt', 'leaf.balances', 'leaf.balances.BTC', 'siblings', 'siblings.0', 'siblings.0.hash',
  'siblings.0.sums', 'siblings.0.sums.BTC', 'siblings.0.dir', 'siblings.1.dir', 'siblings.2.hash'];
const AGAINST_PLACES = ['root', 'totals', 'totals.BTC'];
const openingTable = OPENING_PLACES.map((where) => VALUES.map((v) => {
  const json = at(P, where, v);
  return json === null ? { skip: true } : check1(json, AGAINST);
}));
const againstTable = AGAINST_PLACES.map((where) => VALUES.map((v) => check1(P, at(AGAINST, where, v))));

// ── solvency ───────────────────────────────────────────────────────────────────────────────────────────────────
const lines = [];
const M = (asset, status, balance) => ({ chain: 'eip155:31337', asset, address: '0x01', status, ...(balance === undefined ? {} : { balance }) });
const solv = (name, totalsJson, measurements) => lines.push({ name, totalsJson, measurements, answer: answer(() => solvency(JSON.parse(totalsJson), measurements)) });
solv('nothing measured', '{"BTC":"100","USDT":"5"}', []);
solv('one asset measured, exactly covered', '{"BTC":"100","USDT":"5"}', [M('BTC', 'MEASURED', '100')]);
solv('two addresses of one asset', '{"BTC":"100"}', [M('BTC', 'MEASURED', '60'), M('BTC', 'MEASURED', '50')]);
solv('an address that could not be read does not count', '{"BTC":"100"}', [M('BTC', 'UNREACHABLE'), M('BTC', 'DECLARED_ONLY')]);
solv('one read and one not', '{"BTC":"100"}', [M('BTC', 'UNREACHABLE'), M('BTC', 'MEASURED', '99')]);
solv('no liabilities at all', '{"BTC":"0"}', [M('BTC', 'MEASURED', '5')]);
solv('nothing held against liabilities', '{"BTC":"7"}', [M('BTC', 'MEASURED', '0')]);
for (const [held, owed] of [['1', '3'], ['2', '3'], ['9999', '10000'], ['99999', '100000'], ['999999', '1000000'], ['9999999', '10000000'], ['1', '1000000'], ['1', '999999'], ['1', '10000000'],
  ['100001', '100000'], ['12345678901234567890123456789', '10000000000000000000000000000'], ['1', '100000000000000000000000000000'], ['300', '1']]) {
  solv(`coverage of ${held} over ${owed}`, JSON.stringify({ USDT: owed }), [M('USDT', 'MEASURED', held)]);
}
solv('a balance below zero', '{"BTC":"100"}', [M('BTC', 'MEASURED', '-1')]);
solv('a balance far below zero', '{"BTC":"3"}', [M('BTC', 'MEASURED', '-100')]);
solv('liabilities written as a number', '{"BTC":100}', [M('BTC', 'MEASURED', '50')]);
solv('liabilities written inside a list', '{"BTC":["100"]}', [M('BTC', 'MEASURED', '50')]);
solv('totals that are a list', '["100","7"]', [M('0', 'MEASURED', '50')]);
solv('assets named like numbers keep the order the engine gives them', '{"b":"1","10":"2","9":"3","a":"4"}', [M('9', 'MEASURED', '3'), M('a', 'MEASURED', '2')]);
solv('an asset the measurements name and the totals do not', '{"BTC":"100"}', [M('ETH', 'MEASURED', '5')]);

// ── rpc ────────────────────────────────────────────────────────────────────────────────────────────────────────
const CHAIN = 'eip155:31337';
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const HOLDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const result = (r) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }) });
const error = (e, extra = {}) => ({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: e, ...extra }) });
const NOT_JSON = 'the reserve RPC did not answer in JSON';
const D16 = 'D-16: what the reference reports here is its runtime\'s complaint about the answer; the sentence here says what was wrong with it';
const RPC = [
  ['a balance in 32 bytes of hex', result(`0x${(123456789n * 10n ** 18n).toString(16).padStart(64, '0')}`)],
  ['zero', result('0x0')],
  ['hex in capitals with a capital prefix', result('0X1F')],
  ['decimal text', result('12')],
  ['decimal text with white space around it', result(' 12\n')],
  ['decimal text with a sign', result('-5')],
  ['decimal text with a plus', result('+5')],
  ['decimal text with leading zeros', result('007')],
  ['binary and octal text', result('0b11')],
  ['octal text', result('0o17')],
  ['a prefix and nothing after it', result('0x')],
  ['hex with a sign', result('-0x1')],
  ['hex with a letter too many', result('0x1G')],
  ['an exponent', result('1e3')],
  ['a fraction', result('1.5')],
  ['white space alone', result('  ')],
  ['empty text', result('')],
  ['words', result('abc')],
  ['a number', result(5)],
  ['a number with a fraction', result(1.5)],
  ['a large number', result(1e21)],
  ['zero as a number', result(0)],
  ['true', result(true)],
  ['false', result(false)],
  ['null', result(null)],
  ['an empty list', result([])],
  ['a list of one number', result([5])],
  ['a list of one hex text', result(['0x10'])],
  ['a list of two', result([1, 2])],
  ['an object', result({})],
  ['an object with a member named toString', result({ toString: 1 })],
  ['an error with a message', error({ code: 3, message: 'execution reverted' })],
  ['an error with a message and a result', error({ message: 'both' }, { result: '0x1' })],
  ['an error whose message is a number', error({ message: 5 })],
  ['an error whose message is null', error({ message: null })],
  ['an error whose message is empty', error({ message: '' })],
  ['an error with no message', error({})],
  ['an error that is text', error('boom')],
  ['an error that is true', error(true)],
  ['an error whose message is an object', error({ message: { a: 1 } })],
  ['an error whose message is a list', error({ message: ['a', null, 'b'] })],
  ['an error whose message has a member named toString', error({ message: { toString: 1 } })],
  ['an error that is false, beside a result', error(false, { result: '0x2' })],
  ['an answer with neither', { body: '{}' }],
  ['an answer that is null', { body: 'null' }, { detail: 'the reserve RPC answered null' }],
  ['an answer that is a number', { body: '5' }],
  ['an answer that is text', { body: '"0x5"' }],
  ['an answer that is a list', { body: '[{"result":"0x5"}]' }],
  ['a page instead of JSON', { body: '<html><body>502</body></html>', headers: { 'content-type': 'text/html' } }, { detail: NOT_JSON }],
  ['no body', { body: '' }, { detail: NOT_JSON }],
  ['JSON cut short', { body: '{"jsonrpc":"2.0","id":1,"result":"0x' }, { detail: NOT_JSON }],
  ['JSON after a byte-order mark', { body: `﻿${JSON.stringify({ result: '0x7' })}` }],
  ['a balance beside a status of 500', { status: 500, ...result('0x9') }],
  ['an error beside a status of 404', { status: 404, ...error({ message: 'no such method' }) }],
  ['moved, and the balance is at the new place', { status: 302, headers: { location: '/moved' }, body: '', then: result('0xa') }],
  ['moved for good with the method kept', { status: 308, headers: { location: '/kept' }, body: '', then: result('0xb') }],
  ['a connection closed without an answer', { close: true }],
  ['an answer that takes longer than the read may', { delayMs: 5600, ...result('0x1') }],
];
const ENTRIES = [
  ['the usual entry', { chain: CHAIN, asset: 'USDT', address: HOLDER, token_contract: TOKEN }],
  ['an address with no prefix, in capitals', { chain: CHAIN, asset: 'USDT', address: HOLDER.slice(2).toUpperCase(), token_contract: TOKEN }],
  ['an address with a capital prefix', { chain: CHAIN, asset: 'USDT', address: `0X${HOLDER.slice(2)}`, token_contract: TOKEN }],
  ['a short address', { chain: CHAIN, asset: 'USDT', address: '0x1', token_contract: TOKEN }],
  ['an address longer than a word', { chain: CHAIN, asset: 'USDT', address: `0x${'f'.repeat(70)}`, token_contract: TOKEN }],
  ['an address that is no hex', { chain: CHAIN, asset: 'USDT', address: 'İstanbul "quoted"  ', token_contract: 'not a contract' }],
  ['another chain', { chain: 'eip155:1', asset: 'USDT', address: HOLDER, token_contract: TOKEN }],
  ['no token contract', { chain: CHAIN, asset: 'ETH', address: HOLDER }],
  ['an empty token contract', { chain: CHAIN, asset: 'ETH', address: HOLDER, token_contract: '' }],
];

const rpc = [];
const sent = [];
let replies = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    sent.push({ method: req.method, target: req.url, contentType: req.headers['content-type'] ?? null, body: Buffer.concat(chunks).toString('utf8') });
    const reply = replies.shift();
    if (!reply || reply.close) { req.socket.destroy(); return; }
    const go = () => { res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) }); res.end(reply.body); };
    if (reply.delayMs) setTimeout(go, reply.delayMs); else go();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const clean = (m) => m.map((x) => ('measured_at' in x ? { ...x, measured_at: '<time>' } : x));
for (const [name, reply, java] of RPC) {
  replies = [reply, ...(reply.then ? [reply.then] : [])];
  sent.length = 0;
  const measurement = clean(await measureReserves([ENTRIES[0][1]], CHAIN, url))[0];
  rpc.push({ name, reply, requests: sent.map((s) => ({ ...s })), measurement,
    ...(java ? { java: { ...measurement, ...java }, why: D16 } : {}) });
}
const requests = [];
for (const [name, entry] of ENTRIES) {
  replies = [result('0x1')];
  sent.length = 0;
  const measurement = clean(await measureReserves([entry], CHAIN, url))[0];
  requests.push({ name, entry, request: sent[0]?.body ?? null, measurement });
}
// Several entries are read one after the other, each to its own outcome.
replies = [result('0x64'), error({ message: 'reverted' }), result('0x32')];
sent.length = 0;
const several = [ENTRIES[0][1], { ...ENTRIES[0][1], asset: 'DAI' }, ENTRIES[6][1], ENTRIES[0][1]];
const severalTotals = { USDT: '200', DAI: '1', ETH: '9' };
const severalMeasured = clean(await measureReserves(several, CHAIN, url));
const together = { entries: several, replies: [result('0x64'), error({ message: 'reverted' }), result('0x32')], measurements: severalMeasured,
  totals: severalTotals, solvency: solvency(severalTotals, severalMeasured) };
await new Promise((resolve) => server.close(resolve));
// Nothing listens here any more.
const refused = clean(await measureReserves([ENTRIES[0][1]], CHAIN, url))[0];
const unparsable = clean(await measureReserves([ENTRIES[0][1]], CHAIN, ''))[0];

// ── the indices a set of openings covers ───────────────────────────────────────────────────────────────────────
// What the route does with what was sent where an index belongs: put in order as numbers, written into a sentence.
const orders = [];
const order = (name, json) => orders.push({ name, openingsJson: json, answer: answer(() => {
  const provided = JSON.parse(json).map((o) => o.leaf_index).sort((a, b) => a - b);
  return { stringified: JSON.stringify(provided), joined: provided.join(',') };
}) });
const idx = (...values) => JSON.stringify(values.map((v) => (v === undefined ? {} : { leaf_index: v })));
order('in order already', idx(0, 1, 2, 3));
order('backwards', idx(7, 5, 3, 1));
order('shuffled, with one twice', idx(5, 0, 7, 3, 3, 1));
order('none', '[]');
order('one', idx(4));
order('text that is a number, among numbers', idx(3, '2', 1, ' 0 '));
order('one with no index, among numbers', idx(3, undefined, 1, undefined, 0));
order('null, true and an empty list are numbers too', idx(2, null, true, [], [5], '0x10', 1.5, -1));
order('numbers in the tens of digits', idx(1e21, 4294967299, -1e21, 0));
order('words among numbers', idx(3, 'abc', 1, 2, 'x', 0));
order('an object among numbers', idx(3, {}, 1, { a: 1 }, 0, 2));
order('a list of two among numbers', idx(9, [1, 2], 8, 7));
order('words only', idx('b', 'a', 'c'));
order('forty numbers backwards', idx(...Array.from({ length: 40 }, (_, i) => 40 - i)));
order('forty with a word in the middle', idx(...Array.from({ length: 40 }, (_, i) => (i === 20 ? 'x' : (i * 7) % 40))));
order('sixty-three with words here and there', idx(...Array.from({ length: 63 }, (_, i) => (i % 9 === 4 ? 'x' : (i * 11) % 63))));
order('things that are not openings', '[5, "abc", true, [], {}]');
order('an opening that is null', '[{"leaf_index":1}, null]');
order('an index with a member named toString', '[{"leaf_index":1}, {"leaf_index":{"toString":1}}]');

// ── the file ───────────────────────────────────────────────────────────────────────────────────────────────────
const doc = {
  about: 'Written by tools/make-por-vectors.mjs from the reference (packages/attest-por, packages/attest-verify, apps/core/src/por). Do not edit.',
  values: VALUES,
  statements: { cases: statements, base: S, places: STATEMENT_PLACES, table: statementTable, tableWhy: D04 },
  commitments,
  inclusion: { cases: inclusion, base: P, against: AGAINST, places: OPENING_PLACES, table: openingTable, againstPlaces: AGAINST_PLACES, againstTable, engineWordedWhy: D03 },
  trees,
  solvency: lines,
  orders,
  rpc: { chain: CHAIN, cases: rpc, requests, together, refused, unparsable },
};
const text = `${JSON.stringify(doc, null, 1)}\n`;
const cells = (t) => t.flat().filter((c) => !c.skip).length;
const different = statements.filter((c) => c.java).length + rpc.filter((c) => c.java).length + statementTable.flat().filter((c) => c.java).length;
const worded = [...inclusion.map((c) => c.answer), ...openingTable.flat(), ...againstTable.flat()].filter((a) => a.engineWorded).length;
const counts = `${statements.length} statements and ${cells(statementTable)} cells, ${commitments.length} commitments, ${inclusion.length} openings and ${cells(openingTable) + cells(againstTable)} cells, `
  + `${lines.length} solvency reports, ${orders.length} orderings, ${rpc.length} answers of a node and ${requests.length} requests; ${different} where the Java service answers differently on purpose, ${worded} with a sentence of the runtime's`;
if (check) {
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) {
    console.error('por.json differs from what the reference answers now — run without --check and review the change');
    process.exit(1);
  }
  console.log(`por.json is current (${counts})`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${counts}`);
}
