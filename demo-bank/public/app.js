/* 데모은행 프런트 — vanilla JS, no storage, no framework. */
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS = {
  processing: ['처리 중', 'blue'],
  accepted:   ['접수됨', 'amber'],
  batched:    ['배치 합류', 'amber'],
  submitted:  ['전송됨', 'amber'],
  confirmed:  ['확정', 'green'],
  failed:     ['실패', 'red'],
};
const STEP_ORDER = ['hash', 'prepare', 'hsm', 'assemble', 'submit', 'anchor', 'bundle'];

let config = null;
const details = new Map();   // id → full record
const openSteps = new Set(); // `${id}:${stepKey}` kept open across re-renders

async function loadConfig() {
  config = await (await fetch('/api/config')).json();
  $('#config').innerHTML = `
    <dt>연동 대상</dt><dd><code>${esc(config.core)}</code></dd>
    <dt>API 키</dt><dd><code>${esc(config.apiKeyPrefix)}</code></dd>
    <dt>발행인 키</dt><dd>${esc(config.issuerKey.algorithm)}
      <span class="badge green">콘솔 등록됨 · registered</span></dd>
    <dt>콘솔 계정</dt><dd><code>${esc(config.account.email)}</code><br>
      <code>${esc(config.account.password)}</code></dd>`;
  $('#links').innerHTML = `
    <a href="${esc(config.consoleUrl)}" target="_blank">샌드박스 콘솔</a>
    <a href="${esc(config.docsUrl)}" target="_blank">개발자 허브</a>
    <a href="${esc(config.playgroundUrl)}" target="_blank">검증 플레이그라운드</a>`;
}

function badge(kind) {
  const [label, color] = STATUS[kind] ?? [kind, 'grey'];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

function stepHtml(r, s) {
  const icon = s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : '●';
  const key = `${r.id}:${s.key}`;
  const body = esc(JSON.stringify(s.detail, null, 2));
  return `<div class="step ${s.state}">
    <span class="icon">${icon}</span>
    <div class="title">${esc(s.title)}
      <details data-k="${esc(key)}" ${openSteps.has(key) ? 'open' : ''}>
        <summary>상세</summary><pre>${body}</pre>
      </details>
    </div>
    <span class="ms">${s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : ''}</span>
  </div>`;
}

function recordHtml(r) {
  const trust = r.issuerTrust === 'registered'
    ? '<span class="badge green">발행기관 확인 · registered</span>'
    : r.issuerTrust ? `<span class="badge grey">${esc(r.issuerTrust)}</span>` : '';
  const done = r.status === 'confirmed' && r.bundleVerified?.verified;
  const kb = r.size > 1048576 ? `${(r.size / 1048576).toFixed(1)}MB` : `${Math.ceil(r.size / 1024)}KB`;
  return `<article class="rec" data-id="${r.id}">
    <div class="rec-head">
      <span class="rec-name">${esc(r.filename)}</span>
      <span class="rec-meta">${kb} · ${new Date(r.createdAt).toLocaleString('ko-KR')}</span>
      <span class="spacer"></span>
      ${trust} ${badge(r.status)}
      ${done ? '<span class="badge green">독립 검증 통과</span>' : ''}
    </div>
    ${r.digest ? `<div class="digest">SHA-256&nbsp; ${r.digest}</div>` : ''}
    <div class="steps">${(r.steps ?? []).map((s) => stepHtml(r, s)).join('')}</div>
    ${r.error ? `<div class="error-line">⚠ ${esc(r.error)}</div>` : ''}
    <div class="rec-actions">
      <a class="${done ? '' : 'disabled'}" href="/api/records/${r.id}/bundle">증빙 파일 내려받기</a>
      <a class="${done ? '' : 'disabled'}" href="${config ? esc(config.playgroundUrl) : '#'}" target="_blank"
         title="내려받은 증빙 파일을 플레이그라운드에 올려 제3자 입장에서 검증">플레이그라운드에서 검증</a>
    </div>
  </article>`;
}

function render(list) {
  $('#count').textContent = list.length ? `${list.length}건` : '';
  $('#empty').hidden = list.length > 0;
  $('#records').innerHTML = list.map((r) => recordHtml(details.get(r.id) ?? r)).join('');
  document.querySelectorAll('.step details').forEach((d) => {
    d.addEventListener('toggle', () =>
      d.open ? openSteps.add(d.dataset.k) : openSteps.delete(d.dataset.k));
  });
}

/* In flight means "the pipeline has not written its last word": neither
 * failed nor carrying finishedAt. Polling on `status === 'processing'` alone
 * froze the screen at the anchor-wait step — the submit step overwrites the
 * status with the server's ('accepted', 'batched', …) while the pipeline is
 * still very much running. The 10-minute cap stops a record orphaned by a
 * server restart from keeping the page polling forever. */
const inFlight = (r) => r.status !== 'failed' && !r.finishedAt
  && Date.now() - new Date(r.createdAt).getTime() < 10 * 60 * 1000;

async function refresh() {
  const { data } = await (await fetch('/api/records')).json();
  await Promise.all(data.map(async (r) => {
    const cached = details.get(r.id);
    if (inFlight(r) || !cached || cached.status !== r.status
        || (cached.steps?.length ?? 0) < r.stepCount) {
      details.set(r.id, await (await fetch(`/api/records/${r.id}`)).json());
    }
  }));
  render(data);
  if (data.some(inFlight)) setTimeout(refresh, 2000);
}

// ── upload ──────────────────────────────────────────────────────────────────
let picked = null;
function arm(file) {
  picked = file;
  $('#dropText').textContent = file ? `${file.name} (${Math.ceil(file.size / 1024)}KB)` : '파일을 끌어다 놓거나 클릭하여 선택';
  $('#drop').classList.toggle('armed', !!file);
  $('#submit').disabled = !file;
}
$('#file').addEventListener('change', (e) => arm(e.target.files[0] ?? null));
$('#drop').addEventListener('click', () => $('#file').click());
$('#drop').addEventListener('dragover', (e) => { e.preventDefault(); });
$('#drop').addEventListener('drop', (e) => {
  e.preventDefault();
  arm(e.dataTransfer.files[0] ?? null);
});
$('#submit').addEventListener('click', async () => {
  if (!picked) return;
  $('#submit').disabled = true;
  $('#submit').textContent = '등록 중…';
  try {
    const res = await fetch('/api/anchor', {
      method: 'POST',
      headers: {
        'x-filename': encodeURIComponent(picked.name),
        'content-type': picked.type || 'application/octet-stream',
      },
      body: picked,
    });
    if (res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      alert(err.error ?? `등록 실패 (${res.status})`);
    }
  } finally {
    arm(null);
    $('#file').value = '';
    $('#submit').textContent = '등록 및 체인 기록';
    refresh();
  }
});

loadConfig().then(refresh);
