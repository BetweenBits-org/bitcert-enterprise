/**
 * The whole hand-off, as an exchange runs it: export → check → build → sign
 * → submit, then proofs for its customers.
 *
 * The platform here is a stand-in that speaks the published contract and
 * records exactly what it was sent, because the claim under test is about
 * what leaves the machine: by default the statement and its signature and
 * nothing else; with a spot check, the challenged openings and never an
 * account reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import {
  buildPorTree, buildSubmission, leafFromRow, loadTreeDir, validateSubmission, verifySnapshotSignature,
} from '../src/index.ts';
import type { PorSnapshotStatement, PorSubmission } from '../src/index.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
const SAMPLES = path.resolve(import.meta.dirname, '../samples');
const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const EXCHANGE = 'KR-EX-0a1b2c';
const BUILD = ['--amounts', 'decimal', '--assets', 'BTC:8,ETH:18,USDT:6', '--exchange', EXCHANGE,
  '--name', 'Sample Exchange', '--asof', '2026-11-16T00:00:00Z', '--seed-hex', SEED];

/**
 * Recomputed outside this package (a separate implementation written from the
 * published formulas) for samples/balances.long.csv with the seed above. If
 * this value changes, every root already anchored has changed meaning.
 */
const SAMPLE_ROOT = 'eeb2534289eb2a990c5b526a511a5d0ebf80a06069488a9cf1b8ef905feba297';
/** The same ledger in the v1 tree format, recomputed the same way: what the first snapshots were built with. */
const SAMPLE_ROOT_V1 = '0a869e853c04cbebcbdca7ca16477c691ace16830b1c950a1c38d9f0de4324aa';
const SAMPLE_TOTALS = { BTC: '2463358024', ETH: '114050000000000000001', USDT: '255810750000' };

interface CliResult { code: number; stdout: string; stderr: string }
async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 1, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
  }
}

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-handoff-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function keyFile(dir: string, name = 'signing-key.pem'): { file: string; spki: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const file = path.join(dir, name);
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });
  return { file, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

/** A platform that follows the contract and remembers every request body. */
async function platform(spki: string): Promise<{
  base: string; posts: { path: string; body: Record<string, unknown>; auth: string }[]; close: () => Promise<void>;
}> {
  const posts: { path: string; body: Record<string, unknown>; auth: string }[] = [];
  const statements = new Map<string, PorSnapshotStatement>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '/';
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      if (req.method === 'POST') posts.push({ path: url, body, auth: String(req.headers.authorization) });

      if (req.method === 'GET' && url === '/v1/remit/meta') {
        return send(200, { institutions: [{ id: EXCHANGE, signing_spki: spki }] });
      }
      if (req.method === 'POST' && url === '/v1/por/snapshots') {
        const st = body['statement'] as PorSnapshotStatement;
        const id = `snap-${statements.size + 1}`;
        statements.set(id, st);
        if (body['spot_check'] === true) {
          return send(201, { snapshot_id: id, status: 'CHALLENGED', spot_check: true, challenge: { indices: [0, 3, 7] } });
        }
        return send(201, { snapshot_id: id, status: 'ACCEPTED', spot_check: false, attestation_id: `att-${id}` });
      }
      const opened = /^\/v1\/por\/snapshots\/([^/]+)\/openings$/.exec(url);
      if (req.method === 'POST' && opened) {
        const st = statements.get(opened[1]!)!;
        const openings = body['openings'] as PorInclusionProof[];
        const ok = openings.every((o) => verifyPorInclusion(o, { root: st.tree.root, totals: st.totals }).ok);
        return send(ok ? 200 : 422, { status: ok ? 'VERIFIED' : 'REJECTED', attestation_id: `att-${opened[1]}`, sampled_leaves: openings.length });
      }
      const one = /^\/v1\/por\/snapshots\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && one && statements.has(one[1]!)) {
        const st = statements.get(one[1]!)!;
        return send(200, { snapshot_id: one[1], status: 'ACCEPTED', root: st.tree.root, totals: st.totals,
          leaf_count: st.tree.leaf_count, attestation: { id: `att-${one[1]}`, status: 'confirmed' } });
      }
      send(404, { error: 'not_found', message: `no route for ${req.method} ${url}` });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

test('the sample export builds to the independently recomputed root, in either layout', async () => {
  const t = tmp();
  try {
    for (const layout of ['long', 'wide']) {
      const out = path.join(t.dir, layout);
      const r = await cli(['build', '--csv', path.join(SAMPLES, `balances.${layout}.csv`), ...BUILD, '--out', out]);
      assert.equal(r.code, 0, r.stderr);
      const st = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8')) as PorSnapshotStatement;
      assert.equal(st.tree.root, SAMPLE_ROOT, `${layout} layout`);
      assert.equal(st.tree.algo, 'merkle-sum-sha256-v2');
      assert.equal(st.tree.padding, 'empty');
      assert.deepEqual(st.totals, SAMPLE_TOTALS);
      assert.equal(st.tree.leaf_count, 12);
    }
    // The format the first snapshots were built in is still built on request,
    // to the root it always gave, and the directory it leaves is loaded back as v1.
    const old = path.join(t.dir, 'v1');
    const v1 = await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--tree-format', 'v1', '--out', old]);
    assert.equal(v1.code, 0, v1.stderr);
    const stV1 = JSON.parse(readFileSync(path.join(old, 'snapshot.json'), 'utf8')) as PorSnapshotStatement;
    assert.equal(stV1.tree.root, SAMPLE_ROOT_V1);
    assert.equal(stV1.tree.algo, 'merkle-sum-sha256-v1');
    assert.equal(stV1.tree.padding, 'empty-zero');
    assert.deepEqual(stV1.totals, SAMPLE_TOTALS);
    assert.equal((await loadTreeDir(old)).tree.root, SAMPLE_ROOT_V1);
    // What is kept and who may read it.
    const out = path.join(t.dir, 'long');
    for (const f of ['leaves.jsonl', 'seed.hex', 'tree.json']) {
      assert.equal(statSync(path.join(out, f)).mode & 0o777, 0o600, `${f} is private`);
    }
    const report = JSON.parse(readFileSync(path.join(out, 'build-report.json'), 'utf8'));
    assert.equal(report.source.kind, 'csv');
    assert.equal(report.source.layout, 'long');
    assert.equal(report.assets[0].total, '24.63358024');
    // The report is for the file cabinet: totals and the export's checksum, no account.
    assert.ok(!JSON.stringify(report).includes('U-1000'));
    assert.ok(!readFileSync(path.join(out, 'snapshot.json'), 'utf8').includes('U-1000'), 'the statement names no account');
  } finally { t.done(); }
});

test('check reports the totals a person can compare with the ledger, and stops a bad export', async () => {
  const t = tmp();
  try {
    const ok = await cli(['check', '--csv', path.join(SAMPLES, 'balances.long.csv'), '--assets', 'BTC:8,ETH:18,USDT:6', '--amounts', 'decimal']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /accounts {2}12 {2}\(1 with every balance zero\)/);
    assert.match(ok.stdout, /BTC {3}total 24\.63358024 {2}\(2463358024 smallest units\), held by 6/);
    assert.match(ok.stdout, /OK — this file can be built/);

    const bad = path.join(t.dir, 'bad.csv');
    writeFileSync(bad, 'account_id,asset,balance\nu1,BTC,0.123456789\nu2,BTC,-3\n');
    const r = await cli(['check', '--csv', bad, '--assets', 'BTC:8', '--amounts', 'decimal']);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /2 problems/);
    assert.match(r.stdout, /line 2 +amount_precision/);
    assert.match(r.stdout, /line 3 +amount_negative/);
    const json = await cli(['check', '--csv', bad, '--assets', 'BTC:8', '--amounts', 'decimal', '--json']);
    assert.equal(JSON.parse(json.stdout).problem_count, 2);

    // A build from that file writes nothing at all.
    const out = path.join(t.dir, 'out');
    const b = await cli(['build', '--csv', bad, '--amounts', 'decimal', '--assets', 'BTC:8', '--exchange', EXCHANGE,
      '--name', 'x', '--asof', '2026-11-16T00:00:00Z', '--out', out]);
    assert.equal(b.code, 2);
    assert.equal(existsSync(out), false);

    // A reserve list the platform could not read is refused here, before anything is signed.
    const reserves = path.join(t.dir, 'reserves.json');
    writeFileSync(reserves, JSON.stringify([{ chain: 'eip155:1', asset: 'USDT' }]));
    const good = path.join(SAMPLES, 'balances.long.csv');
    const withBadReserves = await cli(['build', '--csv', good, ...BUILD, '--out', path.join(t.dir, 'r'), '--reserves', reserves]);
    assert.equal(withBadReserves.code, 1);
    assert.match(withBadReserves.stderr, /must be a JSON list/);
    writeFileSync(reserves, JSON.stringify([{ chain: 'eip155:1', asset: 'USDT', address: '0xabc', token_contract: '0xdef' }]));
    assert.equal((await cli(['build', '--csv', good, ...BUILD, '--out', path.join(t.dir, 'r'), '--reserves', reserves])).code, 0);

    // The unit is never assumed.
    const noUnit = await cli(['check', '--csv', bad, '--assets', 'BTC:8']);
    assert.equal(noUnit.code, 1);
    assert.match(noUnit.stderr, /--amounts is required/);
    // A typing mistake gets a sentence, not a stack trace.
    const typo = await cli(['check', '--cvs', bad]);
    assert.equal(typo.code, 1);
    assert.doesNotMatch(typo.stderr, /at .*\(node:/);
    assert.equal((await cli(['--help'])).code, 0);
  } finally { t.done(); }
});

test('sign writes the one file that is sent; submit sends that and nothing else', async () => {
  const t = tmp();
  const key = keyFile(t.dir);
  const p = await platform(key.spki);
  try {
    const out = path.join(t.dir, 'snap');
    assert.equal((await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', out])).code, 0);

    // Not signed yet: submit says what to run.
    const early = await cli(['submit', '--tree', out, '--core', p.base], { STONEHASH_API_KEY: 'sk_test_x' });
    assert.equal(early.code, 1);
    assert.match(early.stderr, /run "sign" first/);

    const signed = await cli(['sign', '--tree', out, '--key', key.file]);
    assert.equal(signed.code, 0, signed.stderr);
    assert.match(signed.stdout, /holds no account and no balance/);
    const submission = JSON.parse(readFileSync(path.join(out, 'submission.json'), 'utf8')) as PorSubmission;
    assert.deepEqual(validateSubmission(submission), []);
    assert.equal(verifySnapshotSignature(submission.statement, submission.sig, key.spki), true);
    assert.equal(submission.sig.key_id, EXCHANGE);

    const noKey = await cli(['submit', '--tree', out, '--core', p.base], { STONEHASH_API_KEY: '' });
    assert.equal(noKey.code, 1);
    assert.match(noKey.stderr, /no API key/);
    assert.equal(p.posts.length, 0);

    const sent = await cli(['submit', '--tree', out, '--core', p.base, '--wait'], { STONEHASH_API_KEY: 'sk_test_x' });
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /no account was opened to the platform/);
    assert.match(sent.stdout, /anchor {7}confirmed/);

    // Exactly one request with a body, and the body is the file.
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0]!.path, '/v1/por/snapshots');
    assert.equal(p.posts[0]!.auth, 'Bearer sk_test_x');
    assert.deepEqual(p.posts[0]!.body, { statement: submission.statement, sig: submission.sig });
    const wire = JSON.stringify(p.posts[0]!.body);
    for (const leaf of readFileSync(path.join(out, 'leaves.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))) {
      assert.ok(!wire.includes(leaf.user_ref) && !wire.includes(leaf.salt) && !wire.includes(leaf.user_ref_hash),
        'no reference, salt or leaf hash in what was sent');
    }

    const receipt = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'ACCEPTED');
    assert.equal(receipt.spot_check, false);
    assert.equal(receipt.sampled_accounts, 0);
    assert.equal(receipt.root, SAMPLE_ROOT);
    assert.equal(receipt.anchor, 'confirmed');
    assert.equal(receipt.public_url, `${p.base}/v1/public/por/snapshots/${receipt.snapshot_id}`);
    assert.equal(existsSync(path.join(out, 'openings.json')), false);

    const status = await cli(['status', '--core', p.base, '--snapshot', receipt.snapshot_id], { STONEHASH_API_KEY: 'sk_test_x' });
    assert.equal(JSON.parse(status.stdout).root, SAMPLE_ROOT);
  } finally { await p.close(); t.done(); }
});

test('a spot check is asked for, answered from the local tree, and recorded', async () => {
  const t = tmp();
  const key = keyFile(t.dir);
  const p = await platform(key.spki);
  try {
    const out = path.join(t.dir, 'snap');
    await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', out]);
    await cli(['sign', '--tree', out, '--key', key.file]);
    const keyPath = path.join(t.dir, 'api-key');
    writeFileSync(keyPath, 'sk_test_file\n');
    const sent = await cli(['submit', '--tree', out, '--core', p.base, '--spot-check', '--api-key-file', keyPath], { STONEHASH_API_KEY: '' });
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /spot check {3}passed — 3 accounts opened/);

    assert.deepEqual(p.posts.map((x) => x.path), ['/v1/por/snapshots', '/v1/por/snapshots/snap-1/openings']);
    assert.equal(p.posts[0]!.body['spot_check'], true);
    assert.equal(p.posts[0]!.auth, 'Bearer sk_test_file');
    const openings = p.posts[1]!.body['openings'] as PorInclusionProof[];
    assert.deepEqual(openings.map((o) => o.leaf_index), [0, 3, 7]);
    for (const o of openings) {
      assert.equal((o.leaf as unknown as Record<string, unknown>)['user_ref'], undefined, 'pseudonymous: never the account reference');
    }
    assert.ok(!JSON.stringify(p.posts[1]!.body).includes('U-1000'));
    // What left the building is kept beside the snapshot, byte for byte.
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'openings.json'), 'utf8')).openings, openings);
    const receipt = JSON.parse(readFileSync(path.join(out, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'VERIFIED');
    assert.equal(receipt.spot_check, true);
    assert.equal(receipt.sampled_accounts, 3);
  } finally { await p.close(); t.done(); }
});

test('a file signed with an unregistered key is stopped before anything is sent', async () => {
  const t = tmp();
  const registered = keyFile(t.dir, 'registered.pem');
  const other = keyFile(t.dir, 'other.pem');
  const p = await platform(registered.spki);
  try {
    const out = path.join(t.dir, 'snap');
    await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', out]);
    await cli(['sign', '--tree', out, '--key', other.file]);
    const r = await cli(['submit', '--tree', out, '--core', p.base], { STONEHASH_API_KEY: 'sk_test_x' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not signed with the key registered/);
    assert.equal(p.posts.length, 0);

    // An edited statement no longer carries a valid signature either.
    await cli(['sign', '--tree', out, '--key', registered.file]);
    const file = path.join(out, 'submission.json');
    const s = JSON.parse(readFileSync(file, 'utf8')) as PorSubmission;
    s.statement.totals['BTC'] = '1';
    writeFileSync(file, JSON.stringify(s));
    const edited = await cli(['submit', '--tree', out, '--core', p.base], { STONEHASH_API_KEY: 'sk_test_x' });
    assert.equal(edited.code, 1);
    assert.equal(p.posts.length, 0);

    const notAKey = path.join(t.dir, 'junk.pem');
    writeFileSync(notAKey, 'not a key');
    assert.match((await cli(['sign', '--tree', out, '--key', notAKey])).stderr, /not a private key/);
  } finally { await p.close(); t.done(); }
});

test('proofs: one, or all of them, each checkable offline', async () => {
  const t = tmp();
  try {
    const out = path.join(t.dir, 'snap');
    await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', out]);
    const one = path.join(t.dir, 'proof.json');
    assert.equal((await cli(['prove', '--tree', out, '--user-ref', 'U-100008', '--out', one])).code, 0);
    const v = await cli(['verify-proof', '--proof', one, '--snapshot', path.join(out, 'snapshot.json')]);
    assert.match(v.stdout, /root\+totals {2}MATCH/);
    assert.match(v.stdout, /"BTC":"2112345678"/);
    assert.match((await cli(['prove', '--tree', out, '--user-ref', 'nobody', '--out', one])).stderr, /no leaf for user_ref nobody/);

    const all = path.join(t.dir, 'proofs');
    const r = await cli(['prove', '--tree', out, '--all', '--out-dir', all]);
    assert.equal(r.code, 0, r.stderr);
    const files = readdirSync(all).flatMap((d) => readdirSync(path.join(all, d)).map((f) => path.join(all, d, f)));
    assert.equal(files.length, 12);
    for (const f of files) {
      // Filed under the hashed reference: no file name is an account id.
      assert.match(path.basename(f), /^[0-9a-f]{64}\.json$/);
      assert.equal(path.basename(path.dirname(f)), path.basename(f).slice(0, 2));
      const ok = await cli(['verify-proof', '--proof', f, '--snapshot', path.join(out, 'snapshot.json')]);
      assert.equal(ok.code, 0, f);
    }
  } finally { t.done(); }
});

test('the private files are checked before anything is issued from them', async () => {
  const t = tmp();
  try {
    const out = path.join(t.dir, 'snap');
    await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', out]);
    const loaded = await loadTreeDir(out);
    assert.equal(loaded.tree.root, SAMPLE_ROOT);
    assert.equal(loaded.leaves.length, 12);
    // Tree order: the leaf at index i is the i-th by hashed reference.
    assert.deepEqual(loaded.leaves.map((l) => l.user_ref_hash), [...loaded.leaves.map((l) => l.user_ref_hash)].sort());

    const leavesPath = path.join(out, 'leaves.jsonl');
    const original = readFileSync(leavesPath, 'utf8');
    writeFileSync(leavesPath, original.replace('"2112345678"', '"2112345679"'));
    const r = await cli(['prove', '--tree', out, '--user-ref', 'U-100008', '--out', path.join(t.dir, 'p.json')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not the file this snapshot was built from/);
    writeFileSync(leavesPath, original);

    // A directory written by the first version (everything in tree.json) still reads.
    const legacy = path.join(t.dir, 'legacy');
    await cli(['build', '--csv', path.join(SAMPLES, 'balances.long.csv'), ...BUILD, '--out', legacy]);
    writeFileSync(path.join(legacy, 'tree.json'), JSON.stringify({
      schema: 'stonehash.por-tree.v1', exchange_id: EXCHANGE, tree: loaded.tree, leaves: loaded.leaves,
    }));
    rmSync(path.join(legacy, 'leaves.jsonl'));
    const opened = path.join(t.dir, 'openings.json');
    assert.equal((await cli(['open', '--tree', legacy, '--indices', '0,11', '--out', opened])).code, 0);
    assert.equal(JSON.parse(readFileSync(opened, 'utf8')).openings.length, 2);
    assert.match((await cli(['open', '--tree', legacy, '--indices', '12', '--out', opened])).stderr, /out of range/);
  } finally { t.done(); }
});

test('library path: a row becomes a leaf the same way the CLI makes it', () => {
  const seed = Buffer.from(SEED, 'hex');
  const leaf = leafFromRow(EXCHANGE, seed, { user_ref: 'U-100008', balances: { BTC: '2112345678' } });
  assert.match(leaf.salt, /^[0-9a-f]{64}$/);
  assert.match(leaf.user_ref_hash, /^[0-9a-f]{64}$/);
  const tree = buildPorTree([leaf], ['BTC']);
  assert.equal(tree.root.length, 64);
  // A number where a string belongs would give the same total under another root.
  assert.throws(() => buildPorTree([{ ...leaf, balances: { BTC: 2112345678 as unknown as string } }], ['BTC']), /decimal string/);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => buildSubmission({ schema: 'nope' } as unknown as PorSnapshotStatement, privateKey), /not valid/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => buildSubmission({
    schema: 'stonehash.por-snapshot.v1', exchange: { institution_id: EXCHANGE, name: 'x' }, asof: '2026-11-16T00:00:00Z',
    assets: [{ symbol: 'BTC', decimals: 8 }], tree: { algo: 'merkle-sum-sha256-v1', leaf_count: 1, root: tree.root, padding: 'empty-zero' },
    totals: tree.totals, params: {} as never, generated_at: '2026-11-16T00:00:00Z',
  }, rsa), /P-256/);
});
