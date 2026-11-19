// What a customer can do with the two files the console leaves them — the proof file it hands back and the
// balance file they anchored — checked with the SDK and nothing of the console: rebuild the snapshot, hold it
// against what the platform publishes, issue an account's proof. Where the walk also took the record's bundle
// from the record list, that is held against the proof file too.
//   node check-downloads.mjs <report-keep-ko.json | report-shapes-ko.json written by drive.mjs>
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  CsvLedgerReader, ledgerOptionsOf, openSnapshot, parseSnapshotProof, porUserRefHash, readAccountsJson, restoreSnapshot,
  validateSnapshotStatement, verifySnapshotSignature,
} from '../../../packages/attest-por/src/index.ts';
import { porSnapshotCommitment, verifyBundle, verifyPorInclusion } from '../../../packages/attest-verify/src/index.ts';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const CORE = process.env.CORE ?? 'http://127.0.0.1:8787';
const SAMPLES = path.resolve(import.meta.dirname, '../../../packages/attest-por/samples');
const CLI = path.resolve(import.meta.dirname, '../../../packages/attest-por/src/cli.ts');
const SOURCE = { long: ['--csv', 'balances.long.csv'], wide: ['--csv', 'balances.wide.csv'], sheet: ['--csv', 'balances.sheet.csv'], json: ['--accounts-json', 'accounts.json'] };
const work = mkdtempSync(path.join(os.tmpdir(), 'por-offline-'));
let bad = 0;
const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };

/** Every snapshot the report names, whichever walk wrote it. */
const snapshots = [];
if (report.keep) snapshots.push({ name: 'wide (two-files walk)', ...report.keep });
for (const [shape, x] of Object.entries(report.keepShapes ?? {})) snapshots.push({ name: `${shape} (two-files walk)`, ...x });
for (const [shape, x] of Object.entries(report.shapes ?? {})) {
  const files = readdirSync(x.dir);
  snapshots.push({
    name: shape, snapshot_id: x.snapshot_id, root: x.root,
    proofFile: path.join(x.dir, files.find((f) => f.startsWith('por-proof-')) ?? 'missing'),
    ledger: path.join(SAMPLES, SOURCE[shape][1]), ledgerFlag: SOURCE[shape][0],
  });
}
if (snapshots.length === 0) { console.log('the report names no snapshot'); process.exit(1); }

try {
  for (const x of snapshots) {
    const n = x.name;
    if (!existsSync(x.proofFile)) { say(false, `${n}: no proof file was downloaded`); continue; }
    const text = readFileSync(x.proofFile, 'utf8');

    // 1. The one file: what it is, and what is not in it.
    const proof = parseSnapshotProof(text);
    const st = proof.statement;
    say(proof.snapshot_id === x.snapshot_id && st.tree.root === x.root, `${n}: the proof file is for the snapshot the console showed (${x.snapshot_id.slice(0, 8)}…, root ${x.root.slice(0, 12)}…)`);
    say(st.tree.algo === 'merkle-sum-sha256-v2' && st.tree.padding === 'empty' && validateSnapshotStatement(st).length === 0,
      `${n}: its statement names the v2 tree (${st.tree.algo}, padding ${st.tree.padding})`);
    const ledgerBytes = readFileSync(x.ledger);
    const options = ledgerOptionsOf(proof);
    const rows = proof.source.layout === 'json'
      ? readAccountsJson(ledgerBytes.toString('utf8'), options).rows
      : (() => { const r = new CsvLedgerReader(options); r.pushBytes(ledgerBytes); return r.end().rows; })();
    const leaked = rows.filter((r) => text.includes(r.user_ref) || text.includes(porUserRefHash(st.exchange.institution_id, r.user_ref)));
    say(rows.length > 0 && leaked.length === 0, `${n}: the proof file (${text.length} bytes) names none of the ${rows.length} accounts, by identifier or by hash`);

    // 2. With the balance file, it is the snapshot again — by the SDK's own rebuild.
    const { tree, leaves } = restoreSnapshot(proof, rows);
    say(tree.root === x.root && leaves.length === st.tree.leaf_count, `${n}: the SDK rebuilds the console's root from the two files`);

    // 3. What the platform publishes is what the proof file says was signed.
    const pub = await (await fetch(`${CORE}/v1/public/por/snapshots/${x.snapshot_id}`)).json();
    say(porSnapshotCommitment(pub.statement) === porSnapshotCommitment(st) && (pub.commitment === undefined || pub.commitment === porSnapshotCommitment(st)),
      `${n}: the published statement is the one in the proof file (commitment ${porSnapshotCommitment(st).slice(0, 12)}…)`);
    say(Boolean(pub.exchange_key?.spki) && verifySnapshotSignature(st, proof.sig, pub.exchange_key.spki), `${n}: the signature in the proof file verifies under the key the platform publishes for the snapshot`);
    const against = { root: pub.statement.tree.root, totals: pub.statement.totals };
    // The record's bundle, when the walk took it from the record list: what it ties to a transaction is this statement.
    if (x.bundle) {
      const bundle = JSON.parse(readFileSync(x.bundle, 'utf8'));
      const checked = verifyBundle(bundle);
      say(checked.verified && checked.links.B === 'pass' && checked.links.C1 === 'pass' && bundle.record.leaf_bytes === porSnapshotCommitment(st),
        `${n}: the record's bundle verifies, and the hash it ties to transaction ${String(checked.txid).slice(0, 12)}… is the commitment of the proof file's statement`);
    }

    // 4. An account's proof. The console no longer issues one: the SDK does, from the same two files — as an
    //    exchange's own code calls it (`openSnapshot`), and from the command line. What it issues verifies
    //    against the published snapshot, and both ways issue the same file.
    const opened = await openSnapshot(x.proofFile, x.ledger);
    const holder = (rows.find((r) => Object.values(r.balances).some((v) => v !== '0')) ?? rows[0]).user_ref;
    const issued = opened.proofFor(holder);
    say(issued !== null && issued.root === x.root && verifyPorInclusion(issued.proof, against).ok,
      `${n}: openSnapshot(proof file, balance file).proofFor("${holder}") verifies against the published snapshot`);
    const asset = issued ? Object.keys(issued.proof.leaf.balances)[0] : undefined;
    if (asset) {
      const tampered = structuredClone(issued.proof);
      tampered.leaf.balances[asset] = String(BigInt(tampered.leaf.balances[asset]) + 1n);
      say(!verifyPorInclusion(tampered, against).ok, `${n}: one unit more in that leaf and it no longer verifies`);
    }
    say(opened.proofFor('U-999999') === null, `${n}: an account that is not in the snapshot is issued nothing`);
    const ref = rows[rows.length - 1].user_ref;
    const proved = path.join(work, `${n.replace(/\W+/g, '-')}-proof.json`);
    execFileSync('node', [CLI, 'prove', '--snapshot-proof', x.proofFile, x.ledgerFlag, x.ledger, '--user-ref', ref, '--out', proved], { stdio: 'pipe' });
    const fromCli = JSON.parse(readFileSync(proved, 'utf8'));
    say(verifyPorInclusion(fromCli.proof, against).ok && JSON.stringify(fromCli) === JSON.stringify(opened.proofFor(ref)),
      `${n}: the SDK command line cuts the same file from the two files, and it verifies against the published snapshot (${ref})`);

    // 5. A balance file with one figure changed is refused by the command line too, and nothing is written.
    const changed = path.join(work, `${n.replace(/\W+/g, '-')}-changed${path.extname(x.ledger)}`);
    writeFileSync(changed, ledgerBytes.toString('utf8').replace(/0\.50000000/, '0.50000001'));
    const never = path.join(work, 'never.json');
    const refused = spawnSync('node', [CLI, 'prove', '--snapshot-proof', x.proofFile, x.ledgerFlag, changed, '--user-ref', ref, '--out', never], { encoding: 'utf8' });
    say(refused.status === 2 && /does not rebuild snapshot/.test(refused.stderr) && !existsSync(never), `${n}: the command line refuses a balance file with one figure changed (exit ${refused.status})`);

    // 6. The SDK's own build, given the same file, seed and exchange, makes the same root.
    const out = path.join(work, `${n.replace(/\W+/g, '-')}-build`);
    execFileSync('node', [CLI, 'build', x.ledgerFlag, x.ledger, '--amounts', proof.source.amounts,
      '--assets', st.assets.map((a) => `${a.symbol}:${a.decimals}`).join(','), '--exchange', st.exchange.institution_id,
      '--name', st.exchange.name, '--asof', st.asof, '--seed-hex', proof.seed, '--out', out], { stdio: 'pipe' });
    const cli = JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8'));
    say(cli.tree.root === x.root && JSON.stringify(cli.totals) === JSON.stringify(st.totals), `${n}: "build" on a server makes the same root and totals from the same file and seed`);
  }

  // 7. With one seed, the four example files are one tree.
  const roots = new Set();
  for (const [shape, src] of Object.entries(SOURCE)) {
    const out = path.join(work, `same-${shape}`);
    execFileSync('node', [CLI, 'build', src[0], path.join(SAMPLES, src[1]), '--amounts', 'decimal', '--assets', 'BTC:8,ETH:18,USDT:8',
      '--exchange', 'KR-EX-SAME', '--name', 'Same', '--asof', '2026-11-17T00:00:00Z', '--seed-hex', '11'.repeat(32), '--out', out], { stdio: 'pipe' });
    roots.add(JSON.parse(readFileSync(path.join(out, 'snapshot.json'), 'utf8')).tree.root);
  }
  say(roots.size === 1, `with one seed the four example files build one root (${[...roots][0].slice(0, 12)}…)`);
} finally { rmSync(work, { recursive: true, force: true }); }
console.log(bad === 0 ? 'ALL OK' : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
