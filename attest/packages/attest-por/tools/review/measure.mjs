// node measure.mjs <balance file> <assets file> <work dir>
//
// Times the two calls an exchange makes, on a ledger from gen-ledger.mjs:
//   anchorBalanceFile   read the export, build the tree, sign, submit (to a stand-in that answers at once),
//                       write the proof file
//   openSnapshot        rebuild the tree from the two files, then cut one account's proof
// Run it under `/usr/bin/time -f '%e s, %M KB'` for the peak memory of the whole run.
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { PorClient, anchorBalanceFile, openSnapshot, readAssetList } from '../../src/index.ts';

const [file, assetsFile, work] = process.argv.slice(2);
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ snapshot_id: 'snap-measure', status: 'ACCEPTED', spot_check: false, attestation_id: 'att-measure' }));
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const client = new PorClient({
  core: `http://127.0.0.1:${server.address().port}`, apiKey: 'sk_test_measure', institutionId: 'KR-EX-MEASURE', institutionName: 'Measure',
  key: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey,
});
const proofFile = path.join(work, 'por-proof.json');
rmSync(proofFile, { force: true });
const secs = (t0) => ((performance.now() - t0) / 1000).toFixed(1);
const assets = readAssetList(assetsFile);

let t0 = performance.now();
const anchored = await anchorBalanceFile(client, file, { assets, amounts: 'decimal', asof: '2026-11-18T00:00:00Z', proofFile });
const anchorSecs = secs(t0);
const afterAnchor = Math.round(process.memoryUsage().rss / 1048576);

t0 = performance.now();
const snapshot = await openSnapshot(proofFile, file);
const openSecs = secs(t0);
t0 = performance.now();
const proof = snapshot.proofFor(snapshot.leaves[Math.floor(snapshot.leaves.length / 2)].user_ref);
const proofSecs = secs(t0);

console.log(JSON.stringify({
  file: path.basename(file), file_mb: Math.round(statSync(file).size / 1048576), layout: anchored.report.layout,
  accounts: anchored.accounts, listed: assets.length,
  anchor_s: Number(anchorSecs), open_s: Number(openSecs), proof_s: Number(proofSecs),
  proof_file_bytes: statSync(proofFile).size, customer_proof_kb: Math.round(JSON.stringify(proof).length / 1024),
  rss_after_anchor_mb: afterAnchor, rss_end_mb: Math.round(process.memoryUsage().rss / 1048576),
  same_root: snapshot.tree.root === anchored.root,
}));
server.close();
