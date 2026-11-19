/* 고객사 포털 — 탭 전환 + 각 사의 작업 피드. vanilla JS. */
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = (status) => {
  const m = { running: ['진행 중', 'run'], confirmed: ['확정', 'ok'], anchored: ['앵커 완료', 'ok'],
    stopped: ['정지(의도된 레버)', 'hold'], failed: ['실패', 'bad'], 'verify-failed': ['재검증 실패', 'bad'] };
  const [label, cls] = m[status] ?? [status, 'hold'];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
};
const stepsHtml = (steps) => `<div class="steps">${(steps ?? []).map((s) => `
  <div><time>${esc(s.at.slice(11, 19))}</time><span>${esc(s.title)}${s.checks ? ` <span class="mono">${esc(s.checks)}</span>` : ''}</span></div>`).join('')}</div>`;

// ── 탭 ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
}));

// ── 설정 ────────────────────────────────────────────────────────────────────
let cfg = null;
async function loadConfig() {
  cfg = await (await fetch('/api/config')).json();
  const who = (slug, el) => {
    const c = cfg.customers[slug];
    el.innerHTML = `계정 <b>${esc(c.email)}</b> · API 키 <span class="mono">${esc(c.apiKeyPrefix)}</span>${
      c.institution ? ` · 기관 <span class="mono">${esc(c.institution)}</span> (자동 발급)` : ''}`;
  };
  who('docs', $('#docsWho')); who('exchange', $('#exWho')); who('bank', $('#bankWho'));
  // 은행 탭의 지급은 이 계정의 콘솔 송금 원장에 그대로 보인다.
  const bank = cfg.customers.bank;
  $('#bankWho').innerHTML += `<br>서명 <b>${esc(bank.signing ?? '')}</b><br>
    <a href="${esc(cfg.core)}/console/#/remit" target="_blank">콘솔에서 이 은행의 송금 원장 보기 ↗</a>`;
  const host = new URL(cfg.core).hostname;
  $('#bankPartnersLink').href = `http://${host}:3300/`;
  $('#bankDeepLink').href = `http://${host}:3200/remit.html`;
  $('#bankJavaLink').href = `http://${host}:3500/`;
}

// ── ① 한빛정밀 ──────────────────────────────────────────────────────────────
let docsPicked = null;
$('#docsDrop').addEventListener('click', () => $('#docsFile').click());
$('#docsFile').addEventListener('change', (e) => {
  docsPicked = e.target.files[0] ?? null;
  $('#docsDropText').textContent = docsPicked ? `${docsPicked.name} (${Math.ceil(docsPicked.size / 1024)}KB)` : '파일을 끌어다 놓거나 클릭';
  $('#docsSubmit').disabled = !docsPicked;
});
$('#docsSubmit').addEventListener('click', async () => {
  if (!docsPicked) return;
  $('#docsSubmit').disabled = true;
  await fetch('/api/docs/anchor', {
    method: 'POST',
    headers: { 'content-type': docsPicked.type || 'application/octet-stream', 'x-filename': encodeURIComponent(docsPicked.name) },
    body: docsPicked,
  });
  docsPicked = null; $('#docsFile').value = ''; $('#docsDropText').textContent = '파일을 끌어다 놓거나 클릭';
  refresh();
});
function docsRec(r) {
  return `<article class="rec"><div class="rec-head">
      <b>${esc(r.filename)}</b><span class="mono">${esc((r.digest ?? '').slice(0, 24))}${r.digest ? '…' : ''}</span>
      ${chip(r.status)}${r.issuerTrust === 'registered' ? '<span class="chip ok">발행인 확인</span>' : ''}</div>
    ${stepsHtml(r.steps)}
    ${r.error ? `<div class="mono" style="color:#a02222">${esc(r.error)}</div>` : ''}
    ${r.hasBundle ? `<div class="acts"><a href="/api/docs/records/${r.id}/bundle" download>증빙 번들 다운로드</a></div>` : ''}
  </article>`;
}

// ── ② OrbitX ────────────────────────────────────────────────────────────────
$('#exSubmit').addEventListener('click', async () => {
  $('#exSubmit').disabled = true;
  await fetch('/api/exchange/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ users: Number($('#exUsers').value || 1000) }) });
  setTimeout(() => { $('#exSubmit').disabled = false; }, 1500);
  refresh();
});
function exRec(r) {
  const fmt = (v, d) => { const s = String(v).padStart(d + 1, '0'); return Number(s.slice(0, -d) + '.' + s.slice(-d)).toLocaleString(); };
  return `<article class="rec"><div class="rec-head">
      <b>스냅샷 ${esc((r.snapshotId ?? r.id).slice(0, 8))}…</b>
      <span class="mono">${r.leafCount ? `${r.leafCount.toLocaleString()} leaves` : `${r.users} users`}</span>
      ${chip(r.status)}</div>
    ${r.totals ? `<div class="mono">부채 총액 — BTC ${fmt(r.totals.BTC, 8)} · ETH ${fmt(r.totals.ETH, 18)} · USDT ${fmt(r.totals.USDT, 6)}</div>` : ''}
    ${stepsHtml(r.steps)}
    ${r.error ? `<div class="mono" style="color:#a02222">${esc(r.error)}</div>` : ''}
    <div class="acts">
      ${r.hasProof ? `<a href="/api/exchange/snapshots/${r.id}/proof" download>사용자 포함증명 다운로드</a>` : ''}
      ${r.publicUrl ? `<a href="${esc(r.publicUrl)}" target="_blank">공개 검증 자료</a>
        <a href="${esc(new URL(r.publicUrl).origin)}/playground/por.html" target="_blank">브라우저 검증 페이지</a>` : ''}
    </div>
  </article>`;
}

// ── ③ 데모은행 ──────────────────────────────────────────────────────────────
// 입력 방식 전환: SWIFT 전문 / 금액만
document.querySelectorAll('#bankMode button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#bankMode button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-modepane]').forEach((pane) => { pane.hidden = pane.dataset.modepane !== b.dataset.mode; });
}));

async function loadSamples() {
  try {
    const list = await (await fetch('/api/bank/samples')).json();
    $('#bankSamples').innerHTML = list.data
      .map((x) => `<button type="button" data-sample="${esc(x.file)}">${esc(x.label)}</button>`).join('');
    $('#bankSamples').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-sample]');
      if (!btn) return;
      const res = await fetch(`/api/bank/samples/${btn.dataset.sample}`);
      if (res.ok) $('#bankSwift').value = await res.text();
    });
  } catch { /* 표본 없이도 붙여넣기는 된다 */ }
}

$('#bankSwiftSubmit').addEventListener('click', async () => {
  const message = $('#bankSwift').value;
  if (message.trim() === '') { $('#bankSwift').focus(); return; }
  $('#bankSwiftSubmit').disabled = true;
  await fetch('/api/bank/remit-swift', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }) });
  setTimeout(() => { $('#bankSwiftSubmit').disabled = false; }, 1500);
  refresh();
});

$('#bankSubmit').addEventListener('click', async () => {
  $('#bankSubmit').disabled = true;
  await fetch('/api/bank/remit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: $('#bankAmount').value.trim() || '1000.00' }) });
  setTimeout(() => { $('#bankSubmit').disabled = false; }, 1500);
  refresh();
});

const BASIS = { stated: '전문', supplied: '고객원장', inferred: '추정' };
// SDK가 알려 주는 "싣지 않는 이유"(영문)를 이 화면의 말로 옮긴다. 모르는 문장은 원문 그대로.
const WHY = [
  [/^charges follow the quote: the platform fee is added to the funding leg; a charge/, '전문에 적힌 수수료는 은행의 회계에 남습니다 — 이 경로의 수수료는 견적을 따릅니다'],
  [/^charges follow/, '수수료는 견적을 따릅니다 — 플랫폼 수수료는 수납 구간에 더해지고 수취인은 무역금액 전액을 받습니다'],
  [/^the interbank settlement amount is what the bank hands over/, '은행이 실제로 넘기는 금액은 은행간 결제금액입니다 — 지시금액과의 차이는 환전 또는 이미 공제된 수수료입니다'],
  [/^the instructed amount is in the corridor/, '지시금액이 이 경로의 통화(USD)로 적혀 있어 무역금액이 됩니다 — 결제 구간은 견적에서 다시 계산합니다'],
  [/^the instruction carries one commercial reference/, '지급지시에는 상업 참조번호를 하나만 싣습니다 — 나머지 인보이스는 은행 전문에 남고, 지급지시는 그 전문의 해시를 인용합니다'],
  [/^a referred document that is not an invoice/, '인보이스가 아닌 참조 문서(구매주문서, 대변표 등)는 상업 참조번호로 쓰지 않습니다'],
  [/^the message is marked as a test/, '시험 전문(23B CRTS)입니다 — 시험용 키라서 받았고, 운영 키에서는 거절됩니다'],
  [/^both conversion rates/, '환율은 지급지시가 인용하는 견적이 고정합니다'],
  [/^settlement starts/, '지급지시가 접수되면 바로 정산이 시작됩니다 — 선일자 결제일은 없습니다'],
  [/^the corridor has no correspondent/, '중계은행 사슬이 없습니다 — 정산주체가 수취기관에 직접 지급합니다'],
  [/^one amount denominates/, '무역금액은 하나만 쓰고, 다른 구간은 견적에서 다시 계산합니다'],
  [/^regulatory reporting stays/, '규제 보고는 은행의 보고 시스템에 남으며 전달하지 않습니다'],
  [/^not read/, '읽지 않습니다 — 이 경로는 송금인과 수취인만 싣습니다'],
];
const whyKo = (text) => (WHY.find(([re]) => re.test(text)) ?? [null, text])[1];
const SWIFT_MEANING = { ACTC: '접수·검증 완료', ACSP: '정산 진행 중', ACCC: '수취계좌 입금 완료', PDNG: '보류', RJCT: '거절·취소·반환' };

// 열어 둔 "변환 내역"이 2.5초마다 다시 그려지며 닫히지 않게, 열림 상태를 기억한다.
const openMaps = new Set();
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.map) return;
  if (d.open) openMaps.add(d.dataset.map); else openMaps.delete(d.dataset.map);
}, true);

function mappingHtml(r) {
  const m = r.mapping;
  if (!m) return '';
  const rows = m.fields.map((f) => `<tr><td class="k">${esc(f.target)}</td><td>${esc(f.value)}</td>
    <td><span class="basis ${esc(f.basis)}">${esc(BASIS[f.basis] ?? f.basis)}</span></td><td class="src">${esc(f.source)}</td></tr>`).join('');
  const unmapped = m.unmapped.length
    ? `<div class="hint small">지급지시에 싣지 않는 내용</div><ul class="maplist">${m.unmapped.map((u) =>
      `<li><span class="mono">${esc(u.source)} = ${esc(u.value)}</span> — ${esc(whyKo(u.why))}</li>`).join('')}</ul>` : '';
  const issues = m.issues.length
    ? `<div class="err">전문에 없는 값</div><ul class="maplist">${m.issues.map((i) =>
      `<li><b>${esc(i.target)}</b> — ${esc(i.problem)} <span class="mono">(${esc(i.source)})</span></li>`).join('')}</ul>` : '';
  return `<details class="map" data-map="${esc(r.id)}"${openMaps.has(r.id) ? ' open' : ''}>
    <summary>변환 내역 — 전문의 어느 값이 지급지시의 어디로 갔는가 (${m.fields.length}개 항목)</summary>
    <table class="maptable">${rows}</table>${unmapped}${issues}</details>`;
}

function bankRec(r) {
  const src = r.source;
  const refs = src ? `<div class="mono refs">${esc(src.type)}${src.uetr ? ` · UETR ${esc(src.uetr)}` : ''}${
    src.instructionId ? ` · 지시번호 ${esc(src.instructionId)}` : ''}${src.endToEndId ? ` · E2E ${esc(src.endToEndId)}` : ''
  } · SHA-256 ${esc(src.sha256.slice(0, 16))}…</div>` : (r.message
    ? `<div class="mono refs">${esc(r.message.type)} · SHA-256 ${esc(r.message.sha256.slice(0, 16))}…</div>` : '');
  const swift = r.swift ? `<span class="chip swift" title="${esc(SWIFT_MEANING[r.swift.code] ?? '')}">SWIFT 상태 ${esc(r.swift.code)}${
    SWIFT_MEANING[r.swift.code] ? ` · ${esc(SWIFT_MEANING[r.swift.code])}` : ''}</span>` : '';
  const acts = r.paymentId ? `<div class="acts">
      <a href="${esc(cfg.core)}/console/#/remit?q=${encodeURIComponent(r.paymentId)}" target="_blank">콘솔에서 이 지급 보기 ↗</a>
      <a href="/api/bank/payments/${esc(r.id)}/pacs002" download>상태 보고 내려받기 (pacs.002)</a>
    </div>` : '';
  return `<article class="rec"><div class="rec-head">
      <b>${esc(r.paymentId ?? (r.kind === 'swift' ? 'SWIFT 전문' : r.id.slice(0, 8)))}</b>
      ${r.amount ? `<span class="mono">${esc(r.kind === 'swift' ? r.amount : `USD ${r.amount}`)}</span>` : ''}
      ${chip(r.status)}${swift}
      ${r.fastRef ? `<span class="chip ok">입금 참조 ${esc(r.fastRef)}</span>` : ''}</div>
    ${refs}
    ${r.quote ? `<div class="mono">${esc(r.quote.collect)} → ${esc(r.quote.settle)} → ${esc(r.quote.payout)}</div>` : ''}
    ${stepsHtml(r.steps)}
    ${mappingHtml(r)}
    ${r.evidenceReport ? `<div class="mono">SDK 재검증: ${r.evidenceReport.map((c) => `${esc(c.name)}${c.ok ? '✓' : '✗'}`).join(' · ')}</div>` : ''}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}
    ${acts}
  </article>`;
}

// ── 피드 폴링 ───────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const [docs, ex, bank] = await Promise.all([
      fetch('/api/docs/records').then((r) => r.json()),
      fetch('/api/exchange/snapshots').then((r) => r.json()),
      fetch('/api/bank/payments').then((r) => r.json()),
    ]);
    $('#docsFeed').innerHTML = docs.data.length ? docs.data.map(docsRec).join('')
      : '<div class="empty">첫 서류를 등록해 보세요 — 해시·서명·앵커·독립검증이 자동으로 진행됩니다.</div>';
    $('#exFeed').innerHTML = ex.data.length ? ex.data.map(exRec).join('')
      : '<div class="empty">첫 스냅샷을 발행해 보세요 — 부채 원장은 이 서버를 떠나지 않습니다.</div>';
    $('#bankFeed').innerHTML = bank.data.length ? bank.data.map(bankRec).join('')
      : '<div class="empty">표본 전문을 불러와 실행해 보세요 — 지급은 콘솔(ops@demo-bank.example)의 송금 원장과 수취측 화면(:3300)에 그대로 나타납니다.</div>';
  } catch { /* 다음 틱 */ }
}
loadConfig().then(refresh);
loadSamples();
setInterval(refresh, 2500);
