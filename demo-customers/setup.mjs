/**
 * 고객사 3사 프로비저닝 — 각 타깃 고객 유형이 실제로 밟는 셀프서브 경로를
 * 스크립트로 재현한다 (가입 → 키 → 구독 활성화). 전부 공개 API만 사용.
 *
 *   docs     한빛정밀 (문서·기록 앵커링만 쓰는 제조사)
 *   exchange OrbitX 거래소 (주기적 PoR 발행)
 *   bank     한빛은행 (국경간 스테이블코인 정산) — 예비 계정
 *
 * 은행 탭은 2026-11-17부터 데모은행 계정(ops@demo-bank.example, VN-BANK-001)으로
 * 지급합니다: server.mjs 의 loadBankPersona() 가 ../demo-bank 의 계정과 HSM 키를
 * 읽습니다. 여기서 만드는 bank 고객은 데모은행이 프로비저닝되지 않은 환경에서만
 * 쓰이는 대체 계정입니다.
 *
 * state.json 은 "고객사 시스템"이 보관하는 비밀(API 키·서명키)이다 —
 * 데모 서버가 곧 고객사 서버라는 전제.
 */
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKey } from '../attest/packages/attest-sign/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';

if (existsSync(STATE)) {
  console.error('state.json already exists — delete it to re-provision.');
  process.exit(1);
}

const CUSTOMERS = {
  docs: { email: 'ops@hanbit-precision.example', name: '한빛정밀 (가상 제조사)' },
  exchange: { email: 'ops@orbitx.example', name: 'OrbitX Exchange (sim)', product: 'por', country: 'KY' },
  bank: { email: 'ops@hanbit-bank.example', name: 'Hanbit Bank (sim)', product: 'remit', country: 'VN' },
};

const state = { provisionedAt: new Date().toISOString(), core: CORE, customers: {} };

for (const [slug, c] of Object.entries(CUSTOMERS)) {
  // ① 가입 (Attest Core 자동 구독)
  const password = `demo-${slug}-${Math.random().toString(36).slice(2, 10)}`;
  const su = await fetch(`${CORE}/v1/console/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: c.email, password }),
  });
  const suB = await su.json();
  if (su.status !== 201) { console.error(`${slug} signup ${su.status}:`, JSON.stringify(suB)); process.exit(1); }
  const cookie = su.headers.get('set-cookie').split(';')[0];

  // ② 서명키 — attest-sign SDK로 생성, 공개키만 등록
  const key = await generateKey('ES256');
  const reg = await (await fetch(`${CORE}/v1/console/issuer-keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ public_key: key.publicKeySpkiBase64, label: `${c.name} 서명키`, algorithm: 'ES256' }),
  })).json();

  const entry = {
    email: c.email, name: c.name,
    // Kept so an operator can open the console as this customer later —
    // losing it meant the portal accounts were unenterable by hand.
    password,
    apiKey: suB.api_key_secret,
    issuerKeyId: reg.id,
    key: {
      keyId: key.keyId, algorithm: key.algorithm,
      privateKeyPkcs8Base64: key.privateKeyPkcs8Base64,
      publicKeySpkiBase64: key.publicKeySpkiBase64,
    },
  };

  // ③ 상품 활성화 (기관 ID는 플랫폼이 발급)
  if (c.product) {
    const act = await fetch(`${CORE}/v1/console/products`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        product: c.product,
        institution: { name: c.name, country: c.country },
        issuer_key_id: reg.id,
      }),
    });
    const actB = await act.json();
    if (act.status !== 201) { console.error(`${slug} ${c.product} activate:`, JSON.stringify(actB)); process.exit(1); }
    entry.institutionId = actB.institution_id;
  }

  state.customers[slug] = entry;
  console.log(`provisioned ${slug}: ${c.email}${entry.institutionId ? ` · ${entry.institutionId}` : ''}`);
}

writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
chmodSync(STATE, 0o600);
console.log('three customers ready.');
