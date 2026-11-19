/**
 * The SDK as an exchange applies it in its own source: one call anchors a
 * balance export and leaves one proof file; another opens the two files and
 * issues proofs.
 *
 * The platform here is a stand-in that speaks the published contract, checks
 * signatures as the real one does, and remembers every request — because half
 * of what is claimed is about what leaves the machine and what is left on it:
 * the statement and its signature and nothing else go out, and one file, not
 * a directory of them, stays behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPorInclusion } from '@stonehash/attest-verify';
import type { PorInclusionProof } from '@stonehash/attest-verify';
import {
  PorApiError, PorClient, PorLedgerError, SnapshotProofError, SnapshotRestoreError, anchorBalanceFile, openSnapshot,
  parseSnapshotProof, porSnapshotCommitment, snapshotProofText, verifySnapshotSignature,
} from '../src/index.ts';
import type { AnchorBalanceFileOptions, PorSignature, PorSnapshotStatement } from '../src/index.ts';

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
const SAMPLES = path.resolve(import.meta.dirname, '../samples');
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const EXCHANGE = 'KR-EX-0a1b2c';
const ASSETS = [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }];
/** The root `handoff.test.ts` pins for the sample ledger under this seed. */
const SAMPLE_ROOT = 'eeb2534289eb2a990c5b526a511a5d0ebf80a06069488a9cf1b8ef905feba297';
const SAMPLE_TOTALS = { BTC: '2463358024', ETH: '114050000000000000001', USDT: '255810750000' };
const WIDE = path.join(SAMPLES, 'balances.wide.csv');

interface Request { method: string; path: string; body: Record<string, unknown> }

/** A platform that follows the contract, checks the signature, and can be told to fail once. */
async function platform(spki: string): Promise<{
  base: string; requests: Request[]; posts: () => Request[];
  /** The next submission is stored and then answered with a server error: the caller cannot tell it arrived. */
  dropNextAnswer: () => void;
  close: () => Promise<void>;
}> {
  const requests: Request[] = [];
  const byCommitment = new Map<string, string>();
  const statements = new Map<string, PorSnapshotStatement>();
  const state = new Map<string, string>();
  let drop = false;
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
      requests.push({ method: req.method ?? '', path: url, body });

      if (req.method === 'GET' && url === '/v1/remit/meta') {
        return send(200, { institutions: [{ id: EXCHANGE, signing_spki: spki }] });
      }
      if (req.method === 'POST' && url === '/v1/por/snapshots') {
        const st = body['statement'] as PorSnapshotStatement;
        if (!verifySnapshotSignature(st, body['sig'] as PorSignature, spki)) {
          return send(400, { error: 'invalid_signature', message: 'sig does not verify over the statement with the registered EXCHANGE key' });
        }
        if (body['spot_check'] === true) {
          const id = `snap-${statements.size + 1}`;
          statements.set(id, st);
          state.set(id, 'CHALLENGED');
          return send(201, { snapshot_id: id, status: 'CHALLENGED', spot_check: true, challenge: { indices: [0, 3, 7] } });
        }
        // Root only: the same statement again is the same snapshot.
        const commitment = porSnapshotCommitment(st);
        const held = byCommitment.get(commitment);
        if (held) return send(200, { snapshot_id: held, status: 'ACCEPTED', spot_check: false, attestation_id: `att-${held}`, already: true });
        const id = `snap-${statements.size + 1}`;
        statements.set(id, st);
        state.set(id, 'ACCEPTED');
        byCommitment.set(commitment, id);
        if (drop) { drop = false; return send(500, { error: 'internal', message: 'the answer was lost' }); }
        return send(201, { snapshot_id: id, status: 'ACCEPTED', spot_check: false, attestation_id: `att-${id}` });
      }
      const opened = /^\/v1\/por\/snapshots\/([^/]+)\/openings$/.exec(url);
      if (req.method === 'POST' && opened) {
        const st = statements.get(opened[1]!)!;
        const openings = body['openings'] as PorInclusionProof[];
        const ok = openings.every((o) => verifyPorInclusion(o, { root: st.tree.root, totals: st.totals }).ok);
        state.set(opened[1]!, ok ? 'VERIFIED' : 'REJECTED');
        return send(ok ? 200 : 422, { status: ok ? 'VERIFIED' : 'REJECTED', attestation_id: `att-${opened[1]}`, sampled_leaves: openings.length });
      }
      const one = /^\/v1\/por\/snapshots\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && one && statements.has(one[1]!)) {
        const st = statements.get(one[1]!)!;
        return send(200, { snapshot_id: one[1], status: state.get(one[1]!), root: st.tree.root, totals: st.totals,
          leaf_count: st.tree.leaf_count, attestation: { id: `att-${one[1]}`, status: 'confirmed' } });
      }
      return send(404, { error: 'not_found', message: url });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    posts: () => requests.filter((r) => r.method === 'POST'),
    dropNextAnswer: () => { drop = true; },
    close: () => new Promise<void>((ok) => { server.close(() => ok()); }),
  };
}

function keyPair(): { key: KeyObject; spki: string; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { key: privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

/** A directory, a platform and a client for one test; everything is removed and closed afterwards. */
async function bench<T>(body: (x: {
  dir: string; p: Awaited<ReturnType<typeof platform>>; client: PorClient; pem: string;
  options: (proofFile: string, extra?: Partial<AnchorBalanceFileOptions>) => AnchorBalanceFileOptions;
}) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-por-anchor-'));
  const k = keyPair();
  const p = await platform(k.spki);
  try {
    const client = new PorClient({ core: p.base, apiKey: 'sk_test_x', institutionId: EXCHANGE, institutionName: 'Sample Exchange', key: k.key });
    const options = (proofFile: string, extra: Partial<AnchorBalanceFileOptions> = {}): AnchorBalanceFileOptions => ({
      assets: ASSETS, amounts: 'decimal', asof: '2026-11-16T00:00:00Z', proofFile, seed: SEED, ...extra,
    });
    return await body({ dir, p, client, pem: k.pem, options });
  } finally {
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('one call anchors a balance export and leaves one file; the statement and its signature are all that is sent', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    const r = await anchorBalanceFile(client, WIDE, options(proofFile));

    assert.equal(r.status, 'ACCEPTED');
    assert.equal(r.already, false);
    assert.equal(r.root, SAMPLE_ROOT, 'the same root the directory flow and the console build from this ledger and seed');
    assert.deepEqual(r.totals, SAMPLE_TOTALS);
    assert.equal(r.accounts, 12);
    assert.equal(r.sampled, 0);
    assert.equal(r.anchor, 'pending');
    assert.equal(r.proofFile, proofFile);
    assert.equal(r.publicUrl, `${p.base}/v1/public/por/snapshots/${r.snapshotId}`);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.layout, 'wide');

    // One file, and nothing else: no leaves, no seed file, no directory of parts.
    assert.deepEqual(readdirSync(dir), ['por-proof.json']);
    assert.equal(statSync(proofFile).mode & 0o777, 0o600, 'the proof file holds the seed: readable by its owner only');
    const proof = parseSnapshotProof(readFileSync(proofFile, 'utf8'));
    assert.equal(proof.snapshot_id, r.snapshotId);
    assert.equal(proof.platform, p.base);
    assert.equal(proof.statement.tree.root, SAMPLE_ROOT);
    assert.equal(proof.seed, SEED.toString('hex'));
    assert.deepEqual(proof.source, {
      file: 'balances.wide.csv', bytes: statSync(WIDE).size, sha256: r.report.input.sha256, layout: 'wide', amounts: 'decimal',
    });
    assert.equal(r.commitment, porSnapshotCommitment(proof.statement));

    // What left the machine.
    const posts = p.posts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, '/v1/por/snapshots');
    assert.deepEqual(Object.keys(posts[0]!.body).sort(), ['sig', 'statement']);
    assert.doesNotMatch(JSON.stringify(p.requests), /U-1000\d\d/, 'no account identifier in any request');
    assert.ok(!JSON.stringify(p.requests).includes(SEED.toString('hex')), 'the seed is never sent');
  });
});

test('the two files open the snapshot again and issue any account\'s proof', async () => {
  await bench(async ({ dir, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    const anchored = await anchorBalanceFile(client, WIDE, options(proofFile));

    const snapshot = await openSnapshot(proofFile, WIDE);
    assert.equal(snapshot.snapshotId, anchored.snapshotId);
    assert.equal(snapshot.tree.root, SAMPLE_ROOT);
    assert.equal(snapshot.leaves.length, 12);

    const proof = snapshot.proofFor('U-100008');
    assert.ok(proof);
    assert.equal(proof.schema, 'stonehash.por-proof.v1');
    assert.equal(proof.user_ref, 'U-100008');
    assert.equal(proof.root, SAMPLE_ROOT);
    assert.deepEqual(proof.proof.leaf.balances, { BTC: '2112345678' });
    assert.equal(verifyPorInclusion(proof.proof, { root: anchored.root, totals: anchored.totals }).ok, true);
    assert.equal(snapshot.proofFor('U-999999'), null, 'an account that is not in the snapshot has no proof');

    const out = path.join(dir, 'proofs');
    assert.equal(await snapshot.writeAllProofs(out), 12);
    const written = readdirSync(out, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
    assert.equal(written.length, 12);
    for (const f of written) {
      assert.match(f, /^[0-9a-f]{2}[\\/][0-9a-f]{64}\.json$/, 'filed under the hashed reference, never the account');
      const one = JSON.parse(readFileSync(path.join(out, f), 'utf8')) as { proof: PorInclusionProof };
      assert.equal(verifyPorInclusion(one.proof, { root: anchored.root, totals: anchored.totals }).ok, true);
    }
  });
});

test('a spot check is answered from the tree the call built, and opens no account by name', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const r = await anchorBalanceFile(client, WIDE, options(path.join(dir, 'p.json'), { spotCheck: true, waitAnchoredMs: 5_000 }));
    assert.equal(r.status, 'VERIFIED');
    assert.equal(r.sampled, 3);
    assert.equal(r.anchor, 'confirmed');
    const posts = p.posts();
    assert.deepEqual(posts.map((x) => x.path), ['/v1/por/snapshots', `/v1/por/snapshots/${r.snapshotId}/openings`]);
    assert.equal(posts[0]!.body['spot_check'], true);
    const openings = posts[1]!.body['openings'] as PorInclusionProof[];
    assert.equal(openings.length, 3);
    for (const o of openings) assert.equal('user_ref' in o.leaf, false, 'an opening carries the hashed reference, never the account');
    assert.doesNotMatch(JSON.stringify(p.requests), /U-1000\d\d/);
    assert.deepEqual(readdirSync(dir), ['p.json']);
  });
});

test('an export with a problem in it builds nothing, writes nothing and sends nothing', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const bad = path.join(dir, 'bad.csv');
    writeFileSync(bad, 'account_id,BTC,ETH,USDT\nU-1,0.5,,\nU-1,0.7,,\nU-2,,-3,\nU-3,,,1e3\n');
    const proofFile = path.join(dir, 'por-proof.json');
    await assert.rejects(anchorBalanceFile(client, bad, options(proofFile)), (e: unknown) => {
      assert.ok(e instanceof PorLedgerError, String(e));
      assert.equal(e.code, 'ledger_problems');
      assert.deepEqual(e.report!.problems.map((x) => `${x.line}:${x.code}`), ['3:duplicate_account', '4:amount_negative', '5:amount_exponent']);
      assert.match(e.message, /bad\.csv has 3 problems; nothing was built/);
      return true;
    });
    await assert.rejects(anchorBalanceFile(client, path.join(dir, 'missing.csv'), options(proofFile)), /missing\.csv not found/);
    await assert.rejects(anchorBalanceFile(client, WIDE, options(proofFile, { asof: 'yesterday' })), /is not a time/);
    assert.deepEqual(readdirSync(dir), ['bad.csv'], 'no proof file was left behind');
    assert.equal(p.requests.length, 0, 'the platform was never contacted');
  });
});

test('the same call again finishes or finds the snapshot; it never makes a second one', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    // Without a fixed seed, as an exchange calls it: the seed is drawn once and kept in the file.
    const first = await anchorBalanceFile(client, WIDE, options(proofFile, { seed: undefined }));
    const kept = readFileSync(proofFile, 'utf8');
    const again = await anchorBalanceFile(client, WIDE, options(proofFile, { seed: undefined }));
    assert.equal(again.already, true);
    assert.equal(again.snapshotId, first.snapshotId);
    assert.equal(again.root, first.root);
    assert.equal(again.anchor, 'confirmed', 'a finished snapshot is reported as the platform holds it');
    assert.equal(readFileSync(proofFile, 'utf8'), kept, 'the proof file is left exactly as it was');
    assert.equal(p.posts().length, 1, 'nothing was submitted a second time');
  });
});

test('a lost answer leaves a proof file that already works, and the next call completes it', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    p.dropNextAnswer();
    await assert.rejects(anchorBalanceFile(client, WIDE, options(proofFile)), (e: unknown) => e instanceof PorApiError && e.status === 500);

    // The seed was on disk before the statement went out: the snapshot the
    // platform now holds can issue proofs, even though this side never heard back.
    const pending = parseSnapshotProof(readFileSync(proofFile, 'utf8'));
    assert.equal(pending.snapshot_id, null);
    const opened = await openSnapshot(proofFile, WIDE);
    assert.equal(opened.snapshotId, null);
    assert.equal(opened.tree.root, SAMPLE_ROOT);
    assert.equal(verifyPorInclusion(opened.proofFor('U-100001')!.proof, { root: SAMPLE_ROOT, totals: SAMPLE_TOTALS }).ok, true);

    // Called again with other seed material on offer: the file's own seed is the one used.
    const done = await anchorBalanceFile(client, WIDE, options(proofFile, { seed: Buffer.alloc(32, 9) }));
    assert.equal(done.already, true, 'the platform already held the statement');
    assert.equal(done.root, SAMPLE_ROOT);
    const finished = parseSnapshotProof(readFileSync(proofFile, 'utf8'));
    assert.equal(finished.snapshot_id, done.snapshotId);
    assert.equal(finished.seed, pending.seed);
    assert.deepEqual(finished.statement, pending.statement, 'the statement sent the second time is the one written the first');
    assert.equal(new Set(p.posts().map((x) => porSnapshotCommitment(x.body['statement'] as PorSnapshotStatement))).size, 1);
    assert.deepEqual(readdirSync(dir), ['por-proof.json'], 'and no temporary file is left beside it');
  });
});

test('a refusal leaves no proof file for a snapshot that does not exist', async () => {
  await bench(async ({ dir, p, options }) => {
    const stranger = new PorClient({ core: p.base, apiKey: 'sk_test_x', institutionId: EXCHANGE, institutionName: 'Sample Exchange', key: keyPair().key });
    await assert.rejects(anchorBalanceFile(stranger, WIDE, options(path.join(dir, 'por-proof.json'))),
      (e: unknown) => e instanceof PorApiError && e.code === 'invalid_signature');
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('a proof file is never overwritten by another snapshot\'s', async () => {
  await bench(async ({ dir, p, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    await anchorBalanceFile(client, WIDE, options(proofFile));
    const kept = readFileSync(proofFile, 'utf8');
    const refused = (e: unknown): boolean => {
      assert.ok(e instanceof SnapshotProofError, String(e));
      assert.equal(e.code, 'in_use');
      assert.match(e.message, /already holds the proof file of another snapshot .*never overwritten — choose another path/);
      return true;
    };
    // Another day's balances, another as-of time, another asset list: each is another snapshot.
    const other = path.join(dir, 'other.csv');
    writeFileSync(other, readFileSync(WIDE, 'utf8').replace('U-100001,0.50000000', 'U-100001,0.60000000'));
    await assert.rejects(anchorBalanceFile(client, other, options(proofFile)), refused);
    await assert.rejects(anchorBalanceFile(client, WIDE, options(proofFile, { asof: '2026-11-17T00:00:00Z' })), refused);
    await assert.rejects(anchorBalanceFile(client, WIDE, options(proofFile, { assets: [...ASSETS.slice(0, 2), { symbol: 'USDT', decimals: 8 }] })), refused);
    // Something that is not a proof file at all is not written over either.
    const notes = path.join(dir, 'notes.json');
    writeFileSync(notes, '{"todo": "rotate keys"}');
    await assert.rejects(anchorBalanceFile(client, WIDE, options(notes)), (e: unknown) => e instanceof SnapshotProofError && e.code === 'in_use'
      && /exists and is not a proof file/.test(e.message));
    assert.equal(readFileSync(notes, 'utf8'), '{"todo": "rotate keys"}');
    assert.equal(readFileSync(proofFile, 'utf8'), kept);
    assert.equal(p.posts().length, 1, 'none of the refused calls reached the platform');
  });
});

test('a JSON export and a CSV read with its own options are recorded as they were read', async () => {
  await bench(async ({ dir, client, options }) => {
    // JSON: known by its extension, read by the JSON reader both times.
    const json = path.join(SAMPLES, 'accounts.json');
    const fromJson = await anchorBalanceFile(client, json, options(path.join(dir, 'json.proof.json')));
    assert.equal(fromJson.root, SAMPLE_ROOT);
    assert.equal(parseSnapshotProof(readFileSync(fromJson.proofFile, 'utf8')).source.layout, 'json');
    assert.equal((await openSnapshot(fromJson.proofFile, json)).tree.root, SAMPLE_ROOT);

    // A CSV that departs from the standard in every way the reader allows.
    const odd = path.join(dir, 'export.txt');
    writeFileSync(odd, 'uid;memo;BTC;ETH;USDT\nA-1;vip;0.5;2;\nA-2;;0.25;;10\n');
    const reader = { columns: { account: 'uid' }, ignoreColumns: ['memo'], delimiter: ';' };
    const r = await anchorBalanceFile(client, odd, options(path.join(dir, 'odd.proof.json'), reader));
    const source = parseSnapshotProof(readFileSync(r.proofFile, 'utf8')).source;
    assert.deepEqual({ layout: source.layout, columns: source.columns, ignore_columns: source.ignore_columns, delimiter: source.delimiter },
      { layout: 'wide', columns: { account: 'uid' }, ignore_columns: ['memo'], delimiter: ';' });
    const opened = await openSnapshot(r.proofFile, odd);
    assert.equal(opened.tree.root, r.root);
    assert.deepEqual(opened.proofFor('A-2')!.proof.leaf.balances, { BTC: '25000000', USDT: '10000000' });
  });
});

test('an export that is not the anchored one opens nothing, and the error says which of the two files is at fault', async () => {
  await bench(async ({ dir, client, options }) => {
    const proofFile = path.join(dir, 'por-proof.json');
    await anchorBalanceFile(client, WIDE, options(proofFile));

    const changed = path.join(dir, 'changed.csv');
    writeFileSync(changed, readFileSync(WIDE, 'utf8').replace('U-100001,0.50000000', 'U-100001,0.60000000'));
    await assert.rejects(openSnapshot(proofFile, changed), (e: unknown) => {
      assert.ok(e instanceof SnapshotRestoreError, String(e));
      assert.equal(e.code, 'mismatch');
      assert.equal(e.sameFile, false);
      assert.deepEqual(e.mismatch!.totals, { BTC: ['2463358024', '2473358024'] });
      assert.equal(e.recorded.file, 'balances.wide.csv');
      assert.equal(e.given.file, 'changed.csv');
      assert.match(e.message, /changed\.csv does not rebuild snapshot snap-1; nothing was issued/);
      return true;
    });

    const forged = path.join(dir, 'forged.json');
    writeFileSync(forged, snapshotProofText({ ...parseSnapshotProof(readFileSync(proofFile, 'utf8')), seed: 'ab'.repeat(32) }));
    await assert.rejects(openSnapshot(forged, WIDE), (e: unknown) => e instanceof SnapshotRestoreError && e.sameFile === true);

    const unreadable = path.join(dir, 'unreadable.csv');
    writeFileSync(unreadable, 'account_id,BTC,ETH,USDT\nU-1,-1,,\n');
    await assert.rejects(openSnapshot(proofFile, unreadable), (e: unknown) => e instanceof PorLedgerError && e.report!.problems[0]!.code === 'amount_negative');
    await assert.rejects(openSnapshot(path.join(dir, 'nowhere.json'), WIDE), /not found/);
    await assert.rejects(openSnapshot(WIDE, WIDE), (e: unknown) => e instanceof SnapshotProofError && e.code === 'not_json');
  });
});

// ── the same calls from a shell ────────────────────────────────────────────

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

test('the command line does the same errand: anchor leaves one file, prove issues from the two', async () => {
  await bench(async ({ dir, p, pem }) => {
    const keyFile = path.join(dir, 'signing-key.pem');
    writeFileSync(keyFile, pem, { mode: 0o600 });
    const proofFile = path.join(dir, 'snapshots', 'por-proof-2026-11-16.json');
    const anchor = ['anchor', '--csv', WIDE, '--amounts', 'decimal', '--assets', 'BTC:8,ETH:18,USDT:6', '--exchange', EXCHANGE,
      '--name', 'Sample Exchange', '--asof', '2026-11-16T00:00:00Z', '--key', keyFile, '--core', p.base,
      '--proof-file', proofFile, '--seed-hex', SEED.toString('hex'), '--wait'];
    const env = { STONEHASH_API_KEY: 'sk_test_x' };

    const done = await cli(anchor, env);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /accepted: snapshot snap-1 {2}\(ACCEPTED\)/);
    assert.match(done.stdout, new RegExp(`root {9}${SAMPLE_ROOT}`));
    assert.match(done.stdout, /spot check {3}not requested — no account was opened to the platform/);
    assert.match(done.stdout, /anchor {7}confirmed/);
    assert.match(done.stdout, /the proof file — keep it with .*balances\.wide\.csv; the two are the snapshot/);
    assert.deepEqual(readdirSync(path.dirname(proofFile)), ['por-proof-2026-11-16.json'], 'a directory holding one file');
    assert.equal(parseSnapshotProof(readFileSync(proofFile, 'utf8')).snapshot_id, 'snap-1');

    const again = await cli(anchor, env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already held by the platform: snapshot snap-1/);

    const out = path.join(dir, 'proof.json');
    const proved = await cli(['prove', '--snapshot-proof', proofFile, '--csv', WIDE, '--user-ref', 'U-100008', '--out', out]);
    assert.equal(proved.code, 0, proved.stderr);
    const file = JSON.parse(readFileSync(out, 'utf8')) as { proof: PorInclusionProof };
    assert.equal(verifyPorInclusion(file.proof, { root: SAMPLE_ROOT, totals: SAMPLE_TOTALS }).ok, true);

    // A file with problems: the report on stderr, exit 2, nothing written.
    const bad = path.join(dir, 'bad.csv');
    writeFileSync(bad, 'account_id,BTC,ETH,USDT\nU-1,-1,,\n');
    const refused = await cli([...anchor.slice(0, 2), bad, ...anchor.slice(3, -5), '--proof-file', path.join(dir, 'never.json')], env);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /amount_negative/);
    assert.match(refused.stderr, /the export has problems; nothing was built or sent/);
    assert.equal(readdirSync(dir).includes('never.json'), false);

    // Another snapshot aimed at the same proof file.
    const clash = await cli([...anchor.slice(0, 12), '2026-11-17T00:00:00Z', ...anchor.slice(13)], env);
    assert.equal(clash.code, 2);
    assert.match(clash.stderr, /never overwritten — choose another path/);

    // A key the platform does not hold is said before anything is read or written.
    const otherKey = path.join(dir, 'other.pem');
    writeFileSync(otherKey, createPrivateKey(keyPair().pem).export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });
    const wrongKey = await cli([...anchor.slice(0, 14), otherKey, ...anchor.slice(15, -5), '--proof-file', path.join(dir, 'never.json')], env);
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stderr, /is not the key registered for KR-EX-0a1b2c/);
    assert.equal(readdirSync(dir).includes('never.json'), false);
  });
});
