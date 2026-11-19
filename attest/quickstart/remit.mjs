/**
 * 송금 퀵스타트 — @stonehash/attest-remit SDK가 전부입니다:
 *   quote → buildInstruction(내 키 서명) → submit → track → evidence
 *   → verifyEvidencePackage(커밋·서명·6축·앵커 독립 재검증)
 *
 *   node quickstart/remit.mjs --core $BASE --api-key $STONEHASH_API_KEY \
 *     --key bank-signing.key --institution $STONEHASH_INSTITUTION [--amount 1000.00]
 *
 * --key 는 기관에 등록된 서명키의 개인키 PEM입니다 — 서버에서 만든 키 파일이거나,
 * 콘솔 활성화 때 브라우저가 내려준 파일입니다.
 * 금액 레버 그대로: *.13 반환 · *.01 확정 보류 · ≥20000 수취기관 추가정보 요청.
 *
 * 은행 시스템이 이미 만드는 SWIFT 전문(MT103 · pacs.008 · pain.001)으로 보내려면
 * 아래 quote → buildInstruction → submit 대신 client.submitSwift(전문) 한 번입니다 —
 * 개발자 허브의 "국경간 송금" 가이드를 보십시오.
 */
import { parseArgs } from 'node:util';
import { createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemitClient, verifyEvidencePackage } from '../packages/attest-remit/src/index.ts';

const USAGE = `usage / 사용법:\n  node quickstart/remit.mjs --core <platform origin> --api-key sk_test_... --key <signing-key.pem> --institution <id> [--amount 1000.00]`;
const { values: a } = parseArgs({ options: {
  core: { type: 'string' }, 'api-key': { type: 'string' }, key: { type: 'string' },
  institution: { type: 'string' }, amount: { type: 'string' },
  help: { type: 'boolean' },
} });
if (a.help) { console.log(USAGE); process.exit(0); }
const need = (k) => a[k] ?? (console.error(`--${k} is required / --${k} 가 필요합니다\n${USAGE}`), process.exit(1));
const step = (m) => console.log(`— ${m}`);

// 실패는 한 줄로, 무엇을 고치면 되는지와 함께 — 스택 추적은 연동 첫날의 사람에게 아무것도 알려 주지 않습니다.
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
process.on('unhandledRejection', (e) => {
  if (e?.code === 'unauthorized' || e?.status === 401) fail('API 키가 거부되었습니다 (401) — 콘솔 연동 → API 키에서 발급한 sk_test_… 키인지 확인하십시오. / the API key was refused.');
  if (e?.code === 'key_mismatch') fail('--key 의 키가 이 기관에 등록된 서명 공개키와 다릅니다 — 콘솔 연동 → 기관 표에서 검증 키를 확인하거나, 등록한 키의 개인키 파일을 지정하십시오. / the local key is not the registered one.');
  if (e?.code === 'institution_unregistered') fail('기관 ID가 등록되어 있지 않습니다 — 콘솔 구독에서 국경간 송금을 활성화하면 발급됩니다. / unknown institution id.');
  if (e?.cause?.code === 'ECONNREFUSED' || e?.message === 'fetch failed') fail('--core 주소에 연결할 수 없습니다. / cannot reach --core.');
  fail(e?.status ? `플랫폼이 거부했습니다 (${e.status} ${e.code}): ${e.message}` : (e?.message ?? String(e)));
});

let key;
try {
  key = createPrivateKey(readFileSync(need('key'), 'utf8'));
} catch (e) {
  fail(e.code === 'ENOENT'
    ? `--key 파일이 없습니다: ${a.key} / key file not found`
    : `--key 파일을 개인키 PEM으로 읽을 수 없습니다 (${e.message}) / not a private-key PEM`);
}

const client = new RemitClient({
  core: need('core'),
  apiKey: need('api-key'),
  institutionId: need('institution'),
  // 서명에 붙는 표시 이름입니다. 증빙에는 Trust Registry에 등록된 기관명이 기록됩니다.
  institutionName: 'SDK Quickstart Bank',
  key,
});

await client.assertRegistered();
step('서명키 확인: Trust Registry 등록 공개키와 일치');

const quote = await client.quote(a.amount ?? '1000.00');
step(`견적 ${quote.quote_id}: 수납 ${Number(quote.collect.amount).toLocaleString()} VND → ${quote.settlement.amount} USDC → 지급 ${quote.payout.amount} SGD`);

const { paymentId, body } = client.buildInstruction(quote, {
  debtor: { name: 'Quickstart Importer Co., Ltd.', country: 'VN',
    address: '12 Le Loi Blvd, HCMC', registration_number: 'VN-QS-0001', account: 'VN-ACC-QS' },
  creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-QS-001', bank: 'Demo Payout Bank' },
});
const accepted = await client.submit(body);
step(`접수: ${accepted.payment_id} @ ${accepted.state} (증거요소 3건 + 지급승인, 전부 이 기계에서 서명됨)`);

const view = await client.track(paymentId, { onState: (s2) => console.log(`  상태 → ${s2}`) });
if (view.state !== 'EVIDENCE_ANCHORED') {
  console.log(`  파이프라인 정지: ${view.state} — 금액 트리거(반환/L1/RFI)를 썼다면 의도된 결과입니다.`);
  process.exit(0);
}

const ev = await client.evidence(paymentId);
const report = await verifyEvidencePackage(ev);
if (!report.verified) {
  console.error('✗ 증빙 재검증 실패:', JSON.stringify(report.checks, null, 2));
  process.exit(1);
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', paymentId);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(ev, null, 2));

const receipt = ev.package.events.find((e) => e.type === 'PAYOUT_COMPLETED');
console.log(`\n✓ 송금 퀵스타트 완료: ${paymentId}`);
console.log(`  ${receipt?.payload?.evidence_level ?? '?'} · FAST ${receipt?.payload?.bank_reference ?? '—'}`);
console.log(`  SDK 재검증 4체크: ${report.checks.map((c) => `${c.name}✓`).join(' ')}`);
console.log(`  증빙: ${outDir}/evidence.json`);
