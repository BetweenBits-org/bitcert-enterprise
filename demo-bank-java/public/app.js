// 화면은 요청만 보낸다: 지급은 Java 백엔드가 SDK로 실행하고, 여기서는 그 장부를 2초마다 다시 읽어 그린다.
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const two = (n) => String(n).padStart(2, '0');
const hhmmss = (iso) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
let corePort = 8787;
let last = '';

const CHIP = { running: ['run', '진행 중'], anchored: ['ok', '증빙 앵커 완료'], paused: ['hold', '대기'], stopped: ['hold', '종료'], failed: ['bad', '실패'] };
const CHECK_KO = {
  commitment: '커밋 재계산', signatures: '증거요소 서명', verdict: '6축 판정', anchor: '앵커 증명 파일',
  anchor_leaf: '앵커 기록의 리프', anchor_proof: '앵커 증명 파일', // 이전 버전 SDK가 남긴 기록의 이름
};
const STATE_KO = { PASS: '통과', FAIL: '실패', NOT_RUN: '재실행 안 함' };
// 다시 돌리지 않는 검사는 그렇다고 적는다 — 통과로 읽히면 안 된다.
const NOT_RUN_KO = {
  verdict: '이 지급을 낸 버전의 Java SDK는 6축 규칙을 다시 평가하지 않았습니다',
  anchor_proof: '이 지급을 낸 버전의 Java SDK는 증명 파일을 다시 검증하지 않았습니다',
};
// 앵커 검사가 본 것을 하나씩: SDK가 돌려준 "이름:결과"를 이 화면의 말로.
const ANCHOR_KO = { 'leaf==commitment': '리프 = 커밋', merkle: '묶음 포함', 'anchor-commitment': '앵커 커밋', 'txid-binding': '트랜잭션 결합' };
const MARK = { pass: '✓', true: '✓', fail: '✗', false: '✗', warn: '확인 불가', skip: '건너뜀' };
function anchorDetail(c) {
  const parts = String(c.detail).split(' — ')[0].split(' ').map((t) => t.split(':'));
  const seen = parts.filter(([id]) => ANCHOR_KO[id]).map(([id, state]) => `${ANCHOR_KO[id]} ${MARK[state] ?? state}`);
  if (seen.length === 0) return c.detail;
  const chain = parts.some(([id, state]) => id === 'onchain' && state === 'skip')
    ? ' · 체인 포함 여부는 확인하지 않음 — 이 샌드박스는 사설 테스트 체인' : '';
  return seen.join(' · ') + chain;
}
// 6축 판정: SDK가 Java에서 다시 계산한 여섯 축이 플랫폼의 판정과 같은가.
function verdictDetail(c) {
  if (c.state !== 'PASS') return c.detail;
  const axes = String(c.detail).split(' ').map((t) => t.split('='));
  return `Java에서 다시 계산한 여섯 축이 플랫폼 판정과 일치 — ${axes.map(([k, v]) => `${k} ${v}`).join(' · ')}`;
}
const DETAIL_KO = {
  anchor: anchorDetail, verdict: verdictDetail,
  anchor_leaf: (c) => (c.state === 'PASS' ? '앵커된 기록의 리프가 이 커밋입니다' : c.detail),
};
const BASIS = { stated: '전문', supplied: '고객원장', inferred: '추정' };
const SWIFT_MEANING = { ACTC: '접수·검증 완료', ACSP: '정산 진행 중', ACCC: '수취계좌 입금 완료', PDNG: '보류', RJCT: '거절·취소·반환' };

// 열어 둔 "변환 내역"이 다시 그려지며 닫히지 않게, 열림 상태를 기억한다.
const openMaps = new Set();
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.map) return;
  if (d.open) openMaps.add(d.dataset.map); else openMaps.delete(d.dataset.map);
}, true);

function mappingHtml(r) {
  const m = r.mapping;
  if (!m) return '';
  const fields = m.fields ?? [], unmapped = m.unmapped ?? [], issues = m.issues ?? [];
  const rows = fields.map((f) => `<tr><td class="k">${esc(f.target)}</td><td>${esc(f.value)}</td>
    <td><span class="basis ${esc(f.basis)}">${esc(BASIS[f.basis] ?? f.basis)}</span></td><td class="src">${esc(f.source)}</td></tr>`).join('');
  const left = unmapped.length
    ? `<div class="hint small">지급지시에 싣지 않는 내용</div><ul class="maplist">${unmapped.map((u) =>
      `<li><span class="mono">${esc(u.source)} = ${esc(u.value)}</span> — ${esc(u.why)}</li>`).join('')}</ul>` : '';
  const missing = issues.length
    ? `<div class="err">전문에 없는 값</div><ul class="maplist">${issues.map((i) =>
      `<li><b>${esc(i.target)}</b> — ${esc(i.problem)} <span class="mono">(${esc(i.source)})</span></li>`).join('')}</ul>` : '';
  return `<details class="map" data-map="${esc(r.id)}"${openMaps.has(r.id) ? ' open' : ''}>
    <summary>변환 내역 — 전문의 어느 값이 지급지시의 어디로 갔는가 (${fields.length}개 항목)</summary>
    <div class="tablescroll"><table class="maptable">${rows}</table></div>${left}${missing}</details>`;
}

function recHtml(r) {
  const [cls, label] = CHIP[r.status] ?? ['hold', r.status];
  const consoleUrl = `${location.protocol}//${location.hostname}:${corePort}/console/#/remit?q=${encodeURIComponent(r.paymentId ?? '')}`;
  const src = r.source;
  const refs = src ? `<div class="mono refs">${esc(src.type)}${src.uetr ? ` · UETR ${esc(src.uetr)}` : ''}${
    src.instructionId ? ` · 지시번호 ${esc(src.instructionId)}` : ''}${src.endToEndId ? ` · E2E ${esc(src.endToEndId)}` : ''
  } · SHA-256 ${esc(String(src.sha256 ?? '').slice(0, 16))}…</div>` : (r.message
    ? `<div class="mono refs">${esc(r.message.type)} · SHA-256 ${esc(String(r.message.sha256 ?? '').slice(0, 16))}…</div>` : '');
  const swift = r.swift ? `<span class="chip swift">SWIFT 상태 ${esc(r.swift.code)}${
    SWIFT_MEANING[r.swift.code] ? ` · ${esc(SWIFT_MEANING[r.swift.code])}` : ''}</span>` : '';
  return `<div class="rec">
    <div class="rec-head"><b>${esc(r.amount ?? (r.kind === 'swift' ? 'SWIFT 전문' : ''))}</b><span class="chip ${cls}">${esc(label)}</span>${swift}
      ${r.paymentId ? `<span class="mono">${esc(r.paymentId)}</span>` : ''}
      ${r.evidenceLevel ? `<span class="chip ok">${esc(r.evidenceLevel)}</span>` : ''}
      ${r.creditReference ? `<span class="chip ok">입금 참조 ${esc(r.creditReference)}</span>` : ''}</div>
    ${refs}
    <div class="steps">${r.steps.map((s) => `<div><time>${esc(hhmmss(s.at))}</time><span>${esc(s.title)}</span></div>`).join('')}</div>
    ${mappingHtml(r)}
    ${r.evidence ? `<div class="checks">${r.evidence.map((c) => `<div><span class="st ${esc(c.state)}">${esc(STATE_KO[c.state] ?? c.state)}</span>
      <span>${esc(CHECK_KO[c.name] ?? c.name)} <small>${esc(c.state === 'NOT_RUN' ? (NOT_RUN_KO[c.name] ?? c.detail) : (DETAIL_KO[c.name]?.(c) ?? c.detail))}</small></span></div>`).join('')}</div>` : ''}
    ${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}
    ${r.paymentId ? `<div class="acts"><a href="${esc(consoleUrl)}" target="_blank" rel="noopener">콘솔에서 추적 보기 ↗</a>
      <a href="/api/payments/${esc(r.id)}/pacs002" download>상태 보고 내려받기 (pacs.002)</a></div>` : ''}
  </div>`;
}

async function refresh() {
  try {
    const { data } = await (await fetch('/api/payments')).json();
    const html = data.length ? data.map(recHtml).join('')
      : '<div class="empty">아직 지급이 없습니다 — 표본 전문을 불러와 실행해 보십시오.</div>';
    if (html !== last) { last = html; $('#feed').innerHTML = html; }
  } catch { /* 다음 주기에 다시 */ }
}

async function send(button, url, body) {
  const err = $('#formError');
  err.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); err.textContent = e.message ?? '실행하지 못했습니다'; err.hidden = false; }
    await refresh();
  } catch {
    err.textContent = '서버에 닿지 못했습니다'; err.hidden = false;
  } finally { button.disabled = false; }
}
$('#pay').addEventListener('click', () => send($('#pay'), '/api/payments', { amount: $('#amount').value }));
$('#paySwift').addEventListener('click', () => send($('#paySwift'), '/api/payments/swift', { message: $('#swift').value }));

// 입력 방식 전환: 폼과, 그 방식에서 도는 Java 코드가 함께 바뀐다.
$('#mode').addEventListener('click', (e) => {
  const mode = e.target.closest('button[data-mode]')?.dataset.mode;
  if (!mode) return;
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.mode === mode);
  for (const p of document.querySelectorAll('[data-modepane]')) p.hidden = p.dataset.modepane !== mode;
  $('#formError').hidden = true;
});

async function loadSamples() {
  try {
    const { data } = await (await fetch('/api/samples')).json();
    $('#samples').innerHTML = data.map((s) => `<button type="button" data-file="${esc(s.file)}">${esc(s.label)}</button>`).join('');
  } catch { /* 표본 없이도 붙여 넣을 수 있다 */ }
}
$('#samples').addEventListener('click', async (e) => {
  const file = e.target.closest('button[data-file]')?.dataset.file;
  if (!file) return;
  const res = await fetch(`/api/samples/${encodeURIComponent(file)}`);
  if (res.ok) $('#swift').value = await res.text();
});

(async () => {
  try {
    const c = await (await fetch('/api/config')).json();
    corePort = c.corePort || 8787;
    $('#who').innerHTML = `<b>${esc(c.bank)}</b> · 기관 ID <span class="mono">${esc(c.institution)}</span><br>${esc(c.signing)}<br>${esc(c.sdk)} · Java ${esc(c.java)}`;
  } catch { /* 설정 없이도 장부는 보인다 */ }
  $('#tsDemo').href = `${location.protocol}//${location.hostname}:3400/`;
  await Promise.all([refresh(), loadSamples()]);
  setInterval(refresh, 2000);
})();
