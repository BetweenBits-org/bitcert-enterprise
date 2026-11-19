/**
 * PoR 퀵스타트 — @stonehash/attest-por SDK가 전부입니다:
 *   synthesiseLiabilities → buildPorTree(이 기계) → buildSnapshotStatement
 *   → PorClient.publish(서명·제출) → waitAnchored
 *   → provePorLeaf + verifyPorInclusion(사용자 오프라인 검증)
 *
 * 기본 제출은 서명된 선언문(루트·총액)만 보냅니다 — 계정 단위 데이터는
 * 나가지 않습니다. --spot-check 를 주면 플랫폼이 고른 계정의 개봉까지
 * 보내 표본 확인을 받습니다.
 *
 *   node quickstart/por.mjs --core http://127.0.0.1:8787 \
 *     --api-key sk_test_... --key <PEM> --institution <자동 발급 ID> [--users 1000] [--spot-check]
 */
import { parseArgs } from 'node:util';
import { createPrivateKey, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PorClient, buildPorTree, buildSnapshotStatement, leafFromRow, provePorLeaf, synthesiseLiabilities,
} from '../packages/attest-por/src/index.ts';
import { verifyPorInclusion } from '../packages/attest-verify/src/index.ts';

const USAGE = `usage / 사용법:\n  node quickstart/por.mjs --core <platform origin> --api-key sk_test_... --key <signing-key.pem> --institution <id> [--users 1000] [--spot-check]`;
const { values: a } = parseArgs({ options: {
  core: { type: 'string' }, 'api-key': { type: 'string' }, key: { type: 'string' },
  institution: { type: 'string' }, users: { type: 'string' },
  'spot-check': { type: 'boolean' }, help: { type: 'boolean' },
} });
if (a.help) { console.log(USAGE); process.exit(0); }
const need = (k) => a[k] ?? (console.error(`--${k} is required / --${k} 가 필요합니다\n${USAGE}`), process.exit(1));
const step = (m) => console.log(`— ${m}`);
const INST = need('institution');
const USERS = Number(a.users ?? 1000);

const client = new PorClient({
  core: need('core'), apiKey: need('api-key'),
  institutionId: INST, institutionName: 'SDK Quickstart Exchange',
  key: createPrivateKey(readFileSync(need('key'), 'utf8')),
});
await client.assertRegistered();
step('서명키 확인: Trust Registry 등록 공개키와 일치');

const assets = ['BTC', 'ETH', 'USDT'];
// 스냅샷마다 시드 하나 — 계정별 솔트는 여기서 파생됩니다. 실제 운영에서는
// 이 시드와 리프를 보관해야 나중에 사용자 증명을 다시 발급할 수 있습니다.
const seed = randomBytes(32);
const leaves = synthesiseLiabilities({ users: USERS, assets, seed: randomInt(1e9) })
  .map((u) => leafFromRow(INST, seed, u));
const t0 = Date.now();
const tree = buildPorTree(leaves, assets);
step(`머클 합 트리: ${tree.leaf_count} 리프, ${Date.now() - t0}ms · root ${tree.root.slice(0, 16)}…`);

const statement = buildSnapshotStatement({
  institutionId: INST, name: 'SDK Quickstart Exchange', asof: new Date().toISOString(),
  assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }],
}, tree);

const pub = await client.publish({ statement, tree, leaves, spotCheck: a['spot-check'] === true });
step(pub.status === 'VERIFIED'
  ? `제출·표본 확인 통과 (${pub.sampled}개 계정 개봉) → VERIFIED · snapshot ${pub.snapshotId}`
  : `제출 → ACCEPTED (계정 단위 데이터 전송 없음) · snapshot ${pub.snapshotId}`);
await client.waitAnchored(pub.snapshotId);
step('스냅샷 커밋 앵커 확정 (비트코인 테스트 체인)');

const sorted = [...leaves].sort((x, y) => (x.user_ref_hash < y.user_ref_hash ? -1 : 1));
const pick = randomInt(tree.leaf_count);
const proof = provePorLeaf(tree, pick, sorted[pick]);
const r = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
if (!r.ok) { console.error('✗ 사용자 증명 실패:', r.problems.join('; ')); process.exit(1); }
step(`사용자 ${sorted[pick].user_ref} 포함증명 오프라인 검증: root+totals MATCH`);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', `por-${pub.snapshotId.slice(0, 8)}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(statement, null, 2));
writeFileSync(path.join(outDir, 'user-proof.json'), JSON.stringify({
  schema: 'stonehash.por-proof.v1', exchange: statement.exchange, asof: statement.asof,
  root: tree.root, totals: tree.totals, leaf_count: tree.leaf_count,
  user_ref: sorted[pick].user_ref, proof,
}, null, 2));

console.log(`\n✓ PoR 퀵스타트 완료: ${pub.snapshotId}`);
console.log(`  totals ${JSON.stringify(statement.totals)}`);
console.log(`  공개 자료: ${client.publicUrl(pub.snapshotId)}`);
console.log(`  브라우저 검증: ${need('core')}/playground/por.html (user-proof.json: ${outDir}/)`);
