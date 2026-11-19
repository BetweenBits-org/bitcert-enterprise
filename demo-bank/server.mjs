/**
 * 데모은행 — StoneHash Attest 연동 데모 (은행 측 레퍼런스 구현)
 *
 * This process plays the CUSTOMER. Everything it does is what a bank's own
 * integration would do, using only what a bank would have:
 *
 *   - the attest-sign Docker image, built from the tarball the hub serves
 *   - an "HSM" (openssl holding a P-256 key the container never sees)
 *   - a bearer API key from the sandbox console
 *   - the REST API: POST /v1/attestations/signed, GET status, GET bundle
 *   - the independent verifier, vendored from the same tarball
 *
 * No StoneHash internals are imported. If this demo works, the published
 * integration surface works.
 */
import http from 'node:http';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundle, statementLeaf } from
  './vendor/attest/packages/attest-verify/src/index.ts';
import { handleRemit } from './remit.mjs';

const execFile = promisify(execFileCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3200);
const CORE = process.env.ATTEST_BASE ?? 'http://127.0.0.1:8787';
const PUBLIC_CORE = process.env.ATTEST_PUBLIC_BASE ?? 'http://3.36.101.90:8787';
const MAX_UPLOAD = 10 * 1024 * 1024;

const state = JSON.parse(readFileSync(path.join(HERE, 'state.json'), 'utf8'));
const HSM_KEY = path.join(HERE, 'hsm', 'bank-hsm.key');
const HSM_PUB = path.join(HERE, 'hsm', 'issuer-public.pem');
const RECORDS = path.join(HERE, 'data', 'records.json');

/** records.json is the bank's ledger here; newest first, saved atomically. */
let records = existsSync(RECORDS) ? JSON.parse(readFileSync(RECORDS, 'utf8')) : [];
// A restart kills in-flight pipelines; their records would otherwise sit in
// a running state forever. Say what happened instead.
for (const r of records) {
  if (r.status !== 'failed' && !r.finishedAt) {
    r.status = 'failed';
    r.error = '서버 재시작으로 처리가 중단되었습니다 — 같은 파일을 다시 등록해 주세요.';
    for (const s of r.steps ?? []) if (s.state === 'run') s.state = 'fail';
  }
}
function save() {
  const tmp = `${RECORDS}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, RECORDS);
}
const byId = (id) => records.find((r) => r.id === id);

function step(record, key, title) {
  const s = { key, title, state: 'run', startedAt: Date.now(), ms: null, detail: {} };
  record.steps.push(s);
  save();
  return {
    ok(detail) { s.state = 'ok'; s.ms = Date.now() - s.startedAt; Object.assign(s.detail, detail ?? {}); save(); },
    fail(message) { s.state = 'fail'; s.ms = Date.now() - s.startedAt; s.detail.error = message; save(); },
  };
}

const hex = (buf, n = 48) => Buffer.from(buf).toString('hex').slice(0, n);

/** docker run --rm --network=none -v <job>:/work attest-sign <args> */
async function dockerSign(jobDir, args) {
  const full = ['run', '--rm', '--network=none', '--user', '1000:1000',
    '-v', `${jobDir}:/work`, 'attest-sign', ...args];
  const { stdout, stderr } = await execFile('docker', full, { maxBuffer: 1 << 20 });
  return { command: `docker ${full.join(' ')}`, stdout, stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pipeline(record, bytes, contentType) {
  const jobDir = path.join(HERE, 'work', record.id);
  mkdirSync(jobDir, { recursive: true });
  try {
    // 1 — the document stays in the bank. Only its digest ever leaves.
    let s = step(record, 'hash', '서류 접수 및 해시(SHA-256) 생성');
    writeFileSync(path.join(jobDir, 'document.bin'), bytes);
    record.digest = createHash('sha256').update(bytes).digest('hex');
    s.ok({ digest: record.digest, size: bytes.length, note: '원본은 은행 서버에만 저장됩니다. 외부로는 이 64자 해시만 전송됩니다.' });

    // 2 — prepare, in the container, from the public half only.
    s = step(record, 'prepare', '서명 준비 (attest-sign 컨테이너, 키 없음)');
    copyFileSync(HSM_PUB, path.join(jobDir, 'issuer-public.pem'));
    const prep = await dockerSign(jobDir, ['prepare', '--digest', record.digest,
      '--content-type', contentType,
      '--public-key', '/work/issuer-public.pem',
      '--out', '/work/prepared.json', '--input-out', '/work/signing-input.bin']);
    const prepared = JSON.parse(readFileSync(path.join(jobDir, 'prepared.json'), 'utf8'));
    s.ok({ command: prep.command, output: prep.stderr.trim(), statement: prepared,
      inputBytes: readFileSync(path.join(jobDir, 'signing-input.bin')).length });

    // 3 — the HSM signs. The container is not running and the key is not
    // in the mounted directory: the two halves genuinely never meet.
    s = step(record, 'hsm', '은행 HSM 전자서명 (openssl, ECDSA P-256)');
    await execFile('openssl', ['dgst', '-sha256', '-sign', HSM_KEY,
      '-out', path.join(jobDir, 'sig.der'), path.join(jobDir, 'signing-input.bin')]);
    const sig = readFileSync(path.join(jobDir, 'sig.der'));
    s.ok({ command: 'openssl dgst -sha256 -sign <은행HSM키> -out sig.der signing-input.bin',
      signatureDerHex: `${hex(sig)}… (${sig.length} bytes, DER)`,
      note: '개인키는 컨테이너에 마운트되지 않으며 이 서버 밖으로 나가지 않습니다.' });

    // 4 — assemble refuses to emit anything that does not verify.
    s = step(record, 'assemble', '서명 결합 및 사전 검증 (attest-sign 컨테이너)');
    const asm = await dockerSign(jobDir, ['assemble', '--statement', '/work/prepared.json',
      '--signature', '/work/sig.der', '--out', '/work/signed.json']);
    const signed = JSON.parse(readFileSync(path.join(jobDir, 'signed.json'), 'utf8'));
    const localLeaf = statementLeaf(signed);
    s.ok({ command: asm.command, output: asm.stderr.trim(), localLeaf });

    // 5 — the one network call that matters: the signed statement to the API.
    s = step(record, 'submit', 'StoneHash API 전송 (POST /v1/attestations/signed)');
    const res = await fetch(`${CORE}/v1/attestations/signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.apiKey}` },
      body: JSON.stringify({ statement: signed }),
    });
    const att = await res.json();
    if (res.status !== 201) throw new Error(`API ${res.status}: ${JSON.stringify(att)}`);
    if (att.leaf_bytes !== localLeaf) {
      throw new Error(`leaf mismatch: 은행 계산 ${localLeaf} ≠ 서버 ${att.leaf_bytes}`);
    }
    record.attestationId = att.id;
    record.issuerTrust = att.issuer_trust ?? null;
    record.status = att.status;
    s.ok({ request: { method: 'POST', path: '/v1/attestations/signed', body: '{ "statement": … }' },
      response: att, leafCheck: '은행이 로컬 계산한 leaf와 서버 leaf_bytes 일치' });

    // 6 — wait for the chain.
    s = step(record, 'anchor', '체인 기록 대기 (배치 → 트랜잭션 → 확정)');
    const seen = [att.status];
    let current = att;
    for (let i = 0; i < 40 && current.status !== 'confirmed'; i++) {
      await sleep(3000);
      const poll = await fetch(`${CORE}/v1/attestations/${att.id}`,
        { headers: { authorization: `Bearer ${state.apiKey}` } });
      current = await poll.json();
      if (current.status !== seen[seen.length - 1]) seen.push(current.status);
      record.status = current.status;
      save();
    }
    if (current.status !== 'confirmed') throw new Error(`120초 내 미확정 (현재: ${current.status})`);
    record.batchId = current.batch_id;
    record.leafIndex = current.leaf_index;
    s.ok({ statusTrail: seen.join(' → '), batchId: current.batch_id, leafIndex: current.leaf_index });

    // 7 — take the bundle and prove it without them.
    s = step(record, 'bundle', '증빙 파일 수령 및 독립 검증');
    const bres = await fetch(`${CORE}/v1/attestations/${att.id}/bundle`,
      { headers: { authorization: `Bearer ${state.apiKey}` } });
    if (bres.status !== 200) throw new Error(`bundle ${bres.status}`);
    const bundle = await bres.json();
    writeFileSync(path.join(jobDir, 'bundle.json'), JSON.stringify(bundle, null, 2));
    const verdict = await verifyBundle(bundle, { originalBytes: new Uint8Array(bytes) });
    const checks = (verdict.checks ?? []).map((c) => ({ id: c.id, state: c.state }));
    record.bundleVerified = {
      verified: verdict.verified === true,
      checks,
      note: '검증기는 타르볼에 동봉된 attest-verify — StoneHash 서버 없이 수행됨',
    };
    if (!record.bundleVerified.verified) throw new Error('번들 독립 검증 실패');
    s.ok({ verified: true, checks: checks.map((c) => `${c.id}:${c.state}`).join('  ') });

    record.finishedAt = new Date().toISOString();
    save();
  } catch (e) {
    const open = record.steps.find((x) => x.state === 'run');
    if (open) { open.state = 'fail'; open.detail.error = String(e.message ?? e); }
    record.status = 'failed';
    record.error = String(e.message ?? e);
    save();
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > (1 << 20)) { const e = new Error('body too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // 국경간 송금 모듈 — /api/remit/* 전부 위임
    if (url.pathname.startsWith('/api/remit/')) {
      const handled = await handleRemit(req, res, url, readJsonBody, json);
      if (handled !== false) return;
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/anchor') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_UPLOAD) { json(res, 413, { error: '10MB 이하만 등록할 수 있습니다' }); req.destroy(); return; }
        chunks.push(c);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) return json(res, 400, { error: '파일 내용이 비어 있습니다' });
      const filename = decodeURIComponent(req.headers['x-filename'] ?? 'document').slice(0, 120);
      const record = {
        id: randomUUID(), filename, size: bytes.length,
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
        digest: null, status: 'processing', issuerTrust: null,
        attestationId: null, batchId: null, leafIndex: null,
        bundleVerified: null, createdAt: new Date().toISOString(), steps: [],
      };
      records.unshift(record);
      save();
      void pipeline(record, bytes, record.contentType);
      return json(res, 202, { id: record.id });
    }

    if (req.method === 'GET' && url.pathname === '/api/records') {
      return json(res, 200, { data: records.map(({ steps, ...r }) => ({ ...r, stepCount: steps.length })) });
    }
    const detail = url.pathname.match(/^\/api\/records\/([0-9a-f-]+)$/);
    if (req.method === 'GET' && detail) {
      const r = byId(detail[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
    }
    const bundle = url.pathname.match(/^\/api\/records\/([0-9a-f-]+)\/bundle$/);
    if (req.method === 'GET' && bundle) {
      const file = path.join(HERE, 'work', bundle[1], 'bundle.json');
      if (!byId(bundle[1]) || !existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="proof-${bundle[1]}.json"`,
      });
      return res.end(readFileSync(file));
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, {
        bank: '데모은행 (가상)',
        core: PUBLIC_CORE,
        consoleUrl: `${PUBLIC_CORE}/console/`,
        docsUrl: `${PUBLIC_CORE}/docs/`,
        playgroundUrl: `${PUBLIC_CORE}/playground/`,
        account: { email: state.email, password: state.password },
        apiKeyPrefix: `${state.apiKey.slice(0, 12)}…`,
        issuerKey: { algorithm: state.issuerKey.algorithm, registered: true },
        provisionedAt: state.provisionedAt,
      });
    }

    // static
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

server.listen(PORT, () => console.log(`demo bank on :${PORT}`));
