/**
 * demo-customers — 타깃 고객 3유형의 "고객사 시스템" 포털 (:3400).
 *
 * 세 탭이 각각 하나의 고객사이고, 각 탭의 백엔드는 그 고객사가 실제로
 * 작성할 연동 코드다 — 전부 당사 공개 API와 SDK만 사용한다:
 *
 *   docs(한빛정밀)   @stonehash/attest-sign  (signStatement) + REST + attest-verify
 *   exchange(OrbitX) @stonehash/attest-por   (buildPorTree · PorClient)
 *   bank(데모은행)    @stonehash/attest-remit (RemitClient · submitSwift · swiftStatus
 *                                              · statusReport · commandSigner
 *                                              · verifyEvidencePackage)
 *
 * 은행 탭은 샌드박스 콘솔 계정 ops@demo-bank.example(데모은행, VN-BANK-001)로
 * 지급을 실행한다 — 여기서 낸 지급이 그 계정의 콘솔 원장에 그대로 보인다.
 * 서명키는 데모은행의 HSM(openssl) 안에 있고 이 프로세스로 들어오지 않는다:
 * SDK의 외부 서명기(commandSigner)가 서명할 바이트만 건넨다.
 *
 * 플랫폼 내부 모듈은 어디에서도 import하지 않는다. 이 데모가 돌면,
 * 공개된 연동 표면이 돈다는 뜻이다.
 */
import http from 'node:http';
import { createHash, createPrivateKey, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signStatement } from '../attest/packages/attest-sign/src/index.ts';
import { verifyBundle, statementLeaf, porUserRefHash, verifyPorInclusion }
  from '../attest/packages/attest-verify/src/index.ts';
import {
  PorClient, buildPorTree, buildSnapshotStatement, provePorLeaf, synthesiseLiabilities,
} from '../attest/packages/attest-por/src/index.ts';
import {
  RemitClient, SwiftMappingError, SwiftMessageError, commandSigner,
  swiftStatusOf, verifyEvidencePackage,
} from '../attest/packages/attest-remit/src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3400);
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const PUBLIC_CORE = process.env.ATTEST_PUBLIC_BASE ?? 'http://3.36.101.90:8787';
const state = JSON.parse(readFileSync(path.join(HERE, 'state.json'), 'utf8'));

// ── 고객사별 장부 (각사 자기 데이터만 보관) ────────────────────────────────
function book(file) {
  const p = path.join(HERE, 'data', file);
  const rows = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  const save = () => { writeFileSync(`${p}.tmp`, JSON.stringify(rows, null, 2)); renameSync(`${p}.tmp`, p); };
  return { rows, save };
}
const docsBook = book('docs-records.json');
const snapBook = book('exchange-snapshots.json');
const payBook = book('bank-payments.json');
for (const b of [docsBook, snapBook, payBook]) {
  for (const r of b.rows) if (r.status === 'running') { r.status = 'failed'; r.error = '서버 재시작으로 중단'; }
  b.save();
}

// ── 은행 탭의 신원 ─────────────────────────────────────────────────────────
// 데모은행(:3200)과 같은 조직·같은 기관으로 지급한다. 계정 정보와 HSM 키는
// 데모은행 쪽 파일을 그대로 읽으며 여기로 복사하지 않는다 — 키가 두 군데에
// 있으면 한쪽만 교체되는 날이 온다. 데모은행이 프로비저닝되지 않은 환경에서는
// 이 포털이 직접 가입시킨 은행 고객으로 되돌아간다.
const SAMPLES_DIR = path.join(HERE, '..', 'attest', 'packages', 'attest-remit', 'samples');
function loadBankPersona() {
  const dir = path.join(HERE, '..', 'demo-bank');
  const stateFile = path.join(dir, 'state.json');
  const keyFile = path.join(dir, 'hsm', 'bank-hsm.key');
  const pubFile = path.join(dir, 'hsm', 'issuer-public.pem');
  if (existsSync(stateFile) && existsSync(keyFile) && existsSync(pubFile)) {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    return {
      name: '데모은행 (가상)', email: s.email, apiKey: s.apiKey, institutionId: 'VN-BANK-001',
      signing: 'HSM (openssl) — 개인키는 이 프로세스에 들어오지 않음',
      // 서명할 바이트는 표준입력으로, 서명은 표준출력으로. 실제 HSM이면 이 명령만 바뀐다.
      signer: commandSigner({
        publicKey: readFileSync(pubFile, 'utf8'),
        command: ['openssl', 'dgst', '-sha256', '-sign', keyFile],
      }),
    };
  }
  const c = state.customers.bank;
  return {
    name: c.name, email: c.email, apiKey: c.apiKey, institutionId: c.institutionId,
    signing: '프로세스 내 키 (샌드박스 PEM)',
    key: createPrivateKey({ key: Buffer.from(c.key.privateKeyPkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' }),
  };
}
const BANK = loadBankPersona();
// 은행 고객의 고객원장 발췌 — 전문에 없는 값(자유형식 MT103의 사업자번호 등)을 채운다.
const BANK_PARTIES = existsSync(path.join(SAMPLES_DIR, 'parties.sample.json'))
  ? JSON.parse(readFileSync(path.join(SAMPLES_DIR, 'parties.sample.json'), 'utf8')) : {};

// 은행 탭이 다른 계정으로 바뀌면 이전 계정의 지급 기록은 따로 보관한다 —
// 화면에 남겨 두면 "콘솔에 안 보이는 지급"이 목록에 섞인다.
{
  const marker = path.join(HERE, 'data', 'bank-persona.json');
  const current = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).email : null;
  if (current !== BANK.email) {
    if (payBook.rows.length > 0) {
      const tag = (current ?? state.customers.bank?.email ?? 'previous').replace(/[^a-z0-9.-]+/gi, '_');
      writeFileSync(path.join(HERE, 'data', `bank-payments.${tag}.archive.json`), JSON.stringify(payBook.rows, null, 2));
      payBook.rows.length = 0;
      payBook.save();
    }
    writeFileSync(marker, JSON.stringify({ email: BANK.email, institution: BANK.institutionId, since: new Date().toISOString() }, null, 2));
  }
}

function bankClient() {
  return new RemitClient({
    core: CORE, apiKey: BANK.apiKey,
    institutionId: BANK.institutionId, institutionName: BANK.name,
    ...(BANK.signer ? { signer: BANK.signer } : { key: BANK.key }),
  });
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const step = (rec, save, title, detail = {}) => { rec.steps.push({ at: new Date().toISOString(), title, ...detail }); save(); };

// ── ① 한빛정밀: 문서 앵커링 (attest-sign + REST + attest-verify) ───────────
async function docsAnchor(rec, bytes) {
  const c = state.customers.docs;
  const save = docsBook.save;
  try {
    rec.digest = sha256hex(bytes);
    step(rec, save, '사내 서버에서 SHA-256 생성 — 원본은 밖으로 안 나감', { digest: rec.digest });

    const statement = await signStatement(c.key, { documentSha256: rec.digest, contentType: rec.contentType });
    step(rec, save, 'attest-sign SDK로 발행인 서명 (ES256)', { key_id: c.key.keyId });

    const res = await fetch(`${CORE}/v1/attestations/signed`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ statement }),
    });
    const att = await res.json();
    if (res.status !== 201) throw new Error(`API ${res.status}: ${att.message ?? att.error}`);
    if (att.leaf_bytes !== statementLeaf(statement)) throw new Error('leaf 불일치 — 로컬 계산과 서버가 다름');
    rec.attestationId = att.id;
    rec.issuerTrust = att.issuer_trust;
    step(rec, save, 'POST /v1/attestations/signed — 접수', { id: att.id, issuer_trust: att.issuer_trust });

    let current = att;
    for (let i = 0; i < 40 && current.status !== 'confirmed'; i++) {
      await new Promise((ok) => setTimeout(ok, 3000));
      current = await (await fetch(`${CORE}/v1/attestations/${att.id}`,
        { headers: { authorization: `Bearer ${c.apiKey}` } })).json();
    }
    if (current.status !== 'confirmed') throw new Error('앵커 미확정 (시간 초과)');
    step(rec, save, '배치 → 머클 → 비트코인 확정', { status: current.status });

    const bundle = await (await fetch(`${CORE}/v1/attestations/${att.id}/bundle`,
      { headers: { authorization: `Bearer ${c.apiKey}` } })).json();
    const verdict = await verifyBundle(bundle, { originalBytes: new Uint8Array(bytes) });
    if (verdict.verified !== true) throw new Error('번들 독립 검증 실패');
    rec.bundle = bundle;
    rec.status = 'confirmed';
    step(rec, save, 'attest-verify로 독립 재검증 — 플랫폼 없이 성립', {
      checks: (verdict.checks ?? []).map((x) => `${x.id}:${x.state}`).join(' '),
    });
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message ?? e);
    save();
  }
}

// ── ② OrbitX: PoR 스냅샷 (attest-por SDK) ──────────────────────────────────
async function exchangeSnapshot(rec, users) {
  const c = state.customers.exchange;
  const save = snapBook.save;
  try {
    const client = new PorClient({
      core: CORE, apiKey: c.apiKey,
      institutionId: c.institutionId, institutionName: c.name,
      key: createPrivateKey({ key: Buffer.from(c.key.privateKeyPkcs8Base64, 'base64'), format: 'der', type: 'pkcs8' }),
    });
    await client.assertRegistered();

    const assets = ['BTC', 'ETH', 'USDT'];
    const leaves = synthesiseLiabilities({ users, assets, seed: randomInt(1e9) }).map((u) => ({
      user_ref: u.user_ref,
      user_ref_hash: porUserRefHash(c.institutionId, u.user_ref),
      salt: randomBytes(32).toString('hex'),
      balances: u.balances,
    }));
    const t0 = Date.now();
    const tree = buildPorTree(leaves, assets);
    rec.root = tree.root; rec.totals = tree.totals; rec.leafCount = tree.leaf_count;
    step(rec, save, `거래소 서버에서 머클 합 트리 구축 (${Date.now() - t0}ms) — 부채 데이터 비반출`, { root: tree.root.slice(0, 20) + '…' });

    const statement = buildSnapshotStatement({
      institutionId: c.institutionId, name: c.name, asof: new Date().toISOString(),
      assets: [{ symbol: 'BTC', decimals: 8 }, { symbol: 'ETH', decimals: 18 }, { symbol: 'USDT', decimals: 6 }],
    }, tree);

    // 기본 제출: 서명된 선언문만 전송합니다 — 계정 단위 데이터는 나가지 않습니다.
    const pub = await client.publish({ statement });
    rec.snapshotId = pub.snapshotId;
    step(rec, save, '선언문 서명·제출 → 서명 확인·접수 (계정 단위 데이터 전송 없음)', { snapshot: pub.snapshotId });

    await client.waitAnchored(pub.snapshotId);
    step(rec, save, '스냅샷 커밋 비트코인 앵커 확정');

    const sorted = [...leaves].sort((x, y) => (x.user_ref_hash < y.user_ref_hash ? -1 : 1));
    const pick = randomInt(tree.leaf_count);
    const proof = provePorLeaf(tree, pick, sorted[pick]);
    const check = verifyPorInclusion(proof, { root: tree.root, totals: tree.totals });
    if (!check.ok) throw new Error('샘플 사용자 증명 검증 실패');
    rec.sampleProof = {
      schema: 'stonehash.por-proof.v1', exchange: statement.exchange, asof: statement.asof,
      root: tree.root, totals: tree.totals, leaf_count: tree.leaf_count,
      user_ref: sorted[pick].user_ref, proof,
    };
    rec.publicUrl = `${PUBLIC_CORE}/v1/public/por/snapshots/${pub.snapshotId}`;
    rec.status = 'anchored';
    step(rec, save, `사용자 ${sorted[pick].user_ref} 포함증명 발급·오프라인 검증 MATCH`);
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message ?? e);
    save();
  }
}

// ── ③ 데모은행: 국경간 송금 (attest-remit SDK) ─────────────────────────────
/** 접수 이후는 두 경로가 같다: 상태 추적 → 증빙 수령 → 독립 재검증. */
async function followPayment(client, rec, save) {
  let lastCode = '';
  await client.track(rec.paymentId, {
    onState: (state, current) => {
      const st = swiftStatusOf(current);
      rec.state = state;
      rec.swift = { code: st.code, reason: st.reason ?? null, detail: st.detail };
      const sig = `${st.code}/${st.reason ?? ''}`;
      step(rec, save, sig === lastCode ? `상태 → ${state}` : `상태 → ${state}  ·  SWIFT 상태 ${st.code}${st.reason ? ` (${st.reason})` : ''}`);
      lastCode = sig;
    },
  });
  // 추적이 멈춘 뒤의 상태는 가이드의 호출 그대로 읽는다 (client.swiftStatus).
  const final = await client.swiftStatus(rec.paymentId);
  rec.state = final.view.state;
  rec.swift = { code: final.code, reason: final.reason ?? null, detail: final.detail };
  if (rec.state !== 'EVIDENCE_ANCHORED') {
    rec.status = 'stopped';
    step(rec, save, `파이프라인 정지: ${rec.state} — SWIFT 상태 ${final.code}${final.reason ? ` (${final.reason})` : ''}`
      + (final.detail.length ? ` · ${final.detail.join(' / ')}` : ''));
    return;
  }
  const ev = await client.evidence(rec.paymentId);
  const report = await verifyEvidencePackage(ev);
  rec.evidenceReport = report.checks.map((x) => ({ name: x.name, ok: x.ok }));
  rec.fastRef = final.creditReference ?? null;
  rec.status = report.verified ? 'anchored' : 'verify-failed';
  step(rec, save, `증빙 수령 + SDK 독립 재검증 ${report.verified ? '4/4 통과' : '실패'}`, {
    checks: report.checks.map((x) => `${x.name}:${x.ok ? '✓' : '✗'}`).join(' '),
  });
}

/** ① 은행 자체 데이터로: 금액만 받아 견적 → 서명 → 지급지시. */
async function bankRemit(rec, amount) {
  const save = payBook.save;
  try {
    const client = bankClient();
    await client.assertRegistered();

    const quote = await client.quote(amount);
    rec.quote = {
      id: quote.quote_id, collect: `${Number(quote.collect.amount).toLocaleString()} VND`,
      settle: `${quote.settlement.amount} USDC`, payout: `${quote.payout.amount} SGD`,
    };
    step(rec, save, `견적 수신 — 수납 ${rec.quote.collect} → ${rec.quote.settle} → 지급 ${rec.quote.payout}`);

    const { paymentId, body } = await client.buildInstructionAsync(quote, {
      debtor: { name: 'Vina Trading Co., Ltd.', country: 'VN',
        address: '12 Le Loi Boulevard, District 1, Ho Chi Minh City', registration_number: '0312345678', account: 'VN-ACC-000777' },
      creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-000009', bank: 'DBS (sim)' },
    });
    rec.paymentId = paymentId;
    await client.submit(body);
    step(rec, save, '증거요소 3건·지급승인 서명(은행 HSM) → POST /v1/settlements 접수');
    await followPayment(client, rec, save);
  } catch (e) {
    rec.status = 'failed';
    rec.error = String(e.message ?? e);
    save();
  }
}

/** ② 은행이 이미 만드는 SWIFT 전문으로: MT103 · pacs.008 · pain.001을 그대로 넣는다. */
async function bankRemitSwift(rec, message) {
  const save = payBook.save;
  try {
    const client = bankClient();
    await client.assertRegistered();

    const mapping = await client.inspectSwift(message, {
      supplement: (p) => (p.debtor.account ? BANK_PARTIES[p.debtor.account] : undefined),
    });
    const p = mapping.payment;
    rec.message = { type: p.messageType, sha256: p.digest };
    rec.amount = `${p.amount.value} ${p.amount.currency}`;
    step(rec, save, `전문 판독 — ${p.messageType} · SHA-256 ${p.digest.slice(0, 16)}…`);
    rec.mapping = {
      fields: mapping.fields.map((f) => ({ target: f.target, value: f.value, source: f.source, basis: f.basis })),
      unmapped: mapping.unmapped,
      issues: mapping.issues,
    };
    if (!mapping.input) throw new SwiftMappingError(mapping);
    const supplied = mapping.fields.filter((f) => f.basis === 'supplied').map((f) => f.target);
    const inferred = mapping.fields.filter((f) => f.basis === 'inferred').map((f) => f.target);
    step(rec, save, `지급지시로 변환 — 전문에서 ${mapping.fields.filter((f) => f.basis === 'stated').length}개 항목`
      + (supplied.length ? ` · 고객원장에서 보충 ${supplied.length}개 (${supplied.join(', ')})` : '')
      + (inferred.length ? ` · 추정 ${inferred.length}개 (${inferred.join(', ')})` : ''));
    rec.source = mapping.input.source;

    const done = await client.submitSwift(message, {
      supplement: (pp) => (pp.debtor.account ? BANK_PARTIES[pp.debtor.account] : undefined),
    });
    rec.paymentId = done.paymentId;
    if (done.quote) {
      rec.quote = {
        id: done.quote.quote_id, collect: `${Number(done.quote.collect.amount).toLocaleString()} VND`,
        settle: `${done.quote.settlement.amount} USDC`, payout: `${done.quote.payout.amount} SGD`,
      };
    }
    step(rec, save, done.already
      ? `이미 제출된 전문 — 같은 지급(${done.paymentId})을 다시 만들지 않고 이어서 추적`
      : '견적 → 증거요소 3건·지급승인 서명(은행 HSM) → POST /v1/settlements 접수');
    await followPayment(client, rec, save);
  } catch (e) {
    rec.status = 'failed';
    if (e instanceof SwiftMappingError) {
      rec.error = '전문에 지급에 필요한 값이 없습니다: '
        + e.issues.map((i) => `${i.target} (${i.source})`).join(' · ');
    } else if (e instanceof SwiftMessageError) {
      rec.error = `전문을 읽을 수 없습니다 (${e.code}): ${e.message}`;
    } else if (e?.code === 'reference_reused') {
      rec.error = '같은 참조번호(UETR·전문번호)가 금액이나 당사자가 다른 지급에 이미 쓰였습니다 — '
        + '반복 제출로 보지 않고, 아무것도 보내지 않았습니다. 지급마다 고유한 UETR을 쓰십시오.';
    } else if (e?.code === 'duplicate_source_message') {
      // 플랫폼이 접수 단계에서 거절한 경우 — SDK가 "이미 제출됨"으로 바꾸지 못한 것은
      // 두 전문을 구분할 수 없을 때(식별자·내용이 같고 결제일이 없음)뿐이다.
      rec.error = `이 전문의 지급은 이미 송금${e.existingPaymentId ? ` ${e.existingPaymentId}` : ''}(으)로 접수되어 있어 `
        + '플랫폼이 두 번째 접수를 거절했습니다 — 아무것도 지급되지 않았습니다. 정말 다른 지급이라면 고유한 UETR이나 참조번호를 주십시오.';
    } else {
      rec.error = String(e.message ?? e);
    }
    save();
  }
}

/**
 * 표본 전문. 누를 때마다 새 참조번호(UETR·전문번호)로 내어 준다 — 같은 전문은
 * 같은 지급이므로, 번호가 같으면 두 번째부터는 "이미 제출된 전문"이 된다.
 */
const SAMPLE_FILES = [
  { file: 'pacs008.sample.xml', label: 'pacs.008 (ISO 20022, 은행간)' },
  { file: 'mt103.sample.txt', label: 'MT103 (자유형식 50K/59)' },
  { file: 'mt103.structured.sample.txt', label: 'MT103 (구조화 50F/59F)' },
  { file: 'pain001.sample.xml', label: 'pain.001 (기업 → 은행)' },
  { file: 'pacs008.envelope.sample.xml', label: 'pacs.008 (봉투·접두사·자유주소)' },
];
function freshSample(file) {
  let text = readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
  const n = String(randomInt(100000, 999999));
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, () => randomUUID());
  // 전문번호·지시번호의 끝 여섯 자리(…000123, OUT2026000125, …-0031)를 새 번호로.
  text = text.replace(/(DEMOVNVX20261117|OUT-2026-|OUT2026)(\d{6})/g, (_, head) => `${head}${n}`);
  text = text.replace(/(VINATRD-(?:20261117|PMT|INS)-)(\d{4})/g, (_, head) => `${head}${n.slice(0, 4)}`);
  return text;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(body, null, 2));
};
async function readBody(req, max = 10 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > max) throw new Error('too large'); chunks.push(ch); }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, {
        core: PUBLIC_CORE,
        customers: {
          ...Object.fromEntries(Object.entries(state.customers).map(([k, v]) => [k, {
            name: v.name, email: v.email,
            institution: v.institutionId ?? null,
            apiKeyPrefix: `${v.apiKey.slice(0, 12)}…`,
          }])),
          bank: {
            name: BANK.name, email: BANK.email, institution: BANK.institutionId,
            apiKeyPrefix: `${BANK.apiKey.slice(0, 12)}…`, signing: BANK.signing,
          },
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/docs/anchor') {
      const bytes = await readBody(req);
      if (bytes.length === 0) return json(res, 400, { error: '파일이 비어 있습니다' });
      const rec = {
        id: randomUUID(), status: 'running', steps: [],
        filename: decodeURIComponent(req.headers['x-filename'] ?? 'document').slice(0, 120),
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
        size: bytes.length, createdAt: new Date().toISOString(),
      };
      docsBook.rows.unshift(rec); docsBook.save();
      void docsAnchor(rec, bytes);
      return json(res, 202, { id: rec.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/docs/records') {
      return json(res, 200, { data: docsBook.rows.map(({ bundle, ...r }) => ({ ...r, hasBundle: !!bundle })) });
    }
    let m;
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/docs\/records\/([0-9a-f-]+)\/bundle$/))) {
      const rec = docsBook.rows.find((r) => r.id === m[1]);
      if (!rec?.bundle) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/json',
        'content-disposition': `attachment; filename="proof-${rec.id}.json"` });
      return res.end(JSON.stringify(rec.bundle, null, 2));
    }

    if (req.method === 'POST' && url.pathname === '/api/exchange/snapshot') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const users = Math.min(Math.max(Number(body.users ?? 1000), 10), 20000);
      const rec = { id: randomUUID(), status: 'running', users, steps: [], createdAt: new Date().toISOString() };
      snapBook.rows.unshift(rec); snapBook.save();
      void exchangeSnapshot(rec, users);
      return json(res, 202, { id: rec.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/exchange/snapshots') {
      return json(res, 200, { data: snapBook.rows.map(({ sampleProof, ...r }) => ({ ...r, hasProof: !!sampleProof })) });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/exchange\/snapshots\/([0-9a-f-]+)\/proof$/))) {
      const rec = snapBook.rows.find((r) => r.id === m[1]);
      if (!rec?.sampleProof) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/json',
        'content-disposition': `attachment; filename="user-proof-${rec.id}.json"` });
      return res.end(JSON.stringify(rec.sampleProof, null, 2));
    }

    if (req.method === 'POST' && url.pathname === '/api/bank/remit') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const amount = String(body.amount ?? '1000.00');
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) return json(res, 400, { error: 'USD 금액 형식이 아닙니다' });
      const rec = { id: randomUUID(), status: 'running', amount, steps: [], createdAt: new Date().toISOString() };
      payBook.rows.unshift(rec); payBook.save();
      void bankRemit(rec, amount);
      return json(res, 202, { id: rec.id });
    }
    if (req.method === 'POST' && url.pathname === '/api/bank/remit-swift') {
      const body = JSON.parse((await readBody(req, 512 * 1024)).toString() || '{}');
      const message = typeof body.message === 'string' ? body.message : '';
      if (message.trim() === '') return json(res, 400, { error: 'SWIFT 전문을 붙여 넣으십시오' });
      const rec = { id: randomUUID(), kind: 'swift', status: 'running', amount: null, steps: [], createdAt: new Date().toISOString() };
      payBook.rows.unshift(rec); payBook.save();
      void bankRemitSwift(rec, message);
      return json(res, 202, { id: rec.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/bank/samples') {
      return json(res, 200, {
        data: SAMPLE_FILES.filter((x) => existsSync(path.join(SAMPLES_DIR, x.file)))
          .map((x) => ({ file: x.file, label: x.label })),
      });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/bank\/samples\/([a-z0-9.]+)$/))) {
      const hit = SAMPLE_FILES.find((x) => x.file === m[1]);
      if (!hit || !existsSync(path.join(SAMPLES_DIR, hit.file))) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(freshSample(hit.file));
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/bank\/payments\/([0-9a-f-]+)\/pacs002$/))) {
      const rec = payBook.rows.find((r) => r.id === m[1]);
      if (!rec?.paymentId) return json(res, 404, { error: 'not found' });
      const xml = await bankClient().statusReport(rec.paymentId);
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${rec.paymentId}.pacs002.xml"` });
      return res.end(xml);
    }
    if (req.method === 'GET' && url.pathname === '/api/bank/payments') {
      return json(res, 200, { data: payBook.rows });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });

    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const target = path.normalize(path.join(HERE, 'public', file));
    if (target.startsWith(path.join(HERE, 'public')) && existsSync(target)) {
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(readFileSync(target));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, () => console.log(`demo-customers on :${PORT}`));
