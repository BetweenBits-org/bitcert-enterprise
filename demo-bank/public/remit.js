/* 데모은행 송금 화면 — vanilla JS. Webhook(서버 수신) + 폴링을 UI에서 병합 표시. */
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => Number(v).toLocaleString();

/** 플랫폼 상태 → 은행 화면 한글 라벨. 6/7 구분이 핵심 (라스트마일 문서). */
const PSTATE = {
  REQUEST_ACCEPTED:            ['접수됨', 'blue'],
  BANK_AUTHORIZED:             ['은행승인 검증', 'blue'],
  TRAVEL_RULE_PENDING:         ['트래블룰 심사중', 'amber'],
  PAYOUT_PRE_APPROVED:         ['지급 사전승인(BFI 서명)', 'amber'],
  ONCHAIN_SETTLED:             ['USDC 정산 확정', 'amber'],
  PAYOUT_IN_PROGRESS:          ['수취측 지급 진행중 — 입금확정 아님', 'amber'],
  BENEFICIARY_CREDIT_CONFIRMED:['수취인 입금 확인', 'green'],
  EVIDENCE_ANCHORED:           ['증빙 앵커 완료', 'green'],
  CANCELLED: ['취소됨', 'red'], EXCEPTION: ['예외', 'red'],
  RETURNED: ['반환됨 — USDC 회수·고객 환불 대상', 'red'],
};
const FLOW = ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED',
  'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS', 'BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED'];
const EVENT_KO = {
  REQUEST_ACCEPTED: '지급지시 접수', BANK_EVIDENCE_SUBMITTED: '은행 서명 증거 3건 제출',
  BANK_AUTHORIZATION_VERIFIED: '은행 서명·견적·한도 검증', TRAVEL_RULE_SENT: '트래블룰 암호문 송신 (IVMS101/JWE)',
  TRAVEL_RULE_RECEIVED: '수취기관 트래블룰 수신 확인', PAYOUT_ACCEPTED: '지급 사전승인 — 수취주소 발급',
  SETTLEMENT_INSTRUCTED: '정산주체에 전송 지시', USDC_TRANSFER_CONFIRMED: 'USDC 온체인 전송 확정',
  USDC_RECEIVED: '수취기관 USDC 수취 확인', PAYOUT_SUBMITTED: '현지 지급 개시 (FAST)',
  PAYOUT_COMPLETED: '현지 입금 완료 — 은행 참조번호 수령', SETTLEMENT_RECONCILED: '3단 대사 (VND↔USDC↔SGD) + 6축 판정',
  EVIDENCE_COMMITTED: '증빙 패키지 커밋 제출', EVIDENCE_ANCHORED: '비트코인 앵커 확정',
  BANK_AUTHORIZED: '은행승인 완료', TRAVEL_RULE_PENDING: '트래블룰 송신', PAYOUT_PRE_APPROVED: '사전승인 수신',
  ONCHAIN_SETTLED: 'USDC 정산 확정', PAYOUT_IN_PROGRESS: '지급 진행', BENEFICIARY_CREDIT_CONFIRMED: '입금 확인',
  RECONCILIATION_EXCEPTION: '대사 예외', EXCEPTION: '예외',
  TRAVEL_RULE_RFI: '수취기관 추가정보 요청 (RFI)', TRAVEL_RULE_RFI_RESOLVED: 'RFI 답변 수리',
  TRAVEL_RULE_REJECTED: '트래블룰 거절', CANCEL_REQUESTED: '은행 취소 요청 (서명)',
  PAYOUT_FAILED: '현지 지급 실패', USDC_RETURNED: 'USDC 반환 (정산주체 수령)',
  EVIDENCE_INSUFFICIENT: '증거 불충분 — 입금확정 보류 (L1)',
  CANCELLED: '취소 확정', RETURNED: '반환 확정',
};
const ISSUER_KO = {
  'STONEHASH': 'StoneHash', 'VN-BANK-001': '데모은행', 'SG-BFI-001': 'Triple-A(모의)',
  'SETTLE-ENTITY-001': '정산주체(모의)', 'SG-PAYBANK-001': 'SG수취은행(모의)',
};

let config = null;
const open = new Set();   // 열려있는 케이스
const details = new Map();

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
  return json;
}

async function loadConfig() {
  config = await api('GET', '/api/remit/config');
  $('#importerInfo').innerHTML = `
    <dt>송금인</dt><dd><b>${esc(config.importer.name_ko)}</b> · ${esc(config.importer.name)}</dd>
    <dt>사업자</dt><dd><code>${esc(config.importer.registration_number)}</code> <span class="badge green">KYB ${esc(config.importer.kyb_status)}</span></dd>
    <dt>출금계좌</dt><dd><code>${esc(config.importer.account)}</code> (VND)</dd>`;
  $('#beneInfo').innerHTML = `
    <dt>수취인</dt><dd><b>${esc(config.beneficiary.name)}</b> (싱가포르 수출업체)</dd>
    <dt>수취은행</dt><dd>${esc(config.beneficiary.bank)} · <code>${esc(config.beneficiary.account)}</code> (SGD)</dd>`;
  $('#partnerLinks').innerHTML = `
    <a href="${esc(config.partners_ui)}" target="_blank">Triple-A 콘솔 + SG 수취은행 통장 (모의)</a>`;
  const sel = $('#scenario');
  sel.innerHTML = (config.scenarios ?? []).map((sc) =>
    `<option value="${esc(sc.key)}">${esc(sc.label)}</option>`).join('');
  sel.addEventListener('change', () => {
    const sc = (config.scenarios ?? []).find((x) => x.key === sel.value);
    $('#scenarioNote').textContent = sc?.note ?? '';
  });
  renderSub();
}

function renderSub() {
  $('#subBody').innerHTML = config.subscribed
    ? `<dl class="kv">
        <dt>상태</dt><dd><span class="badge green">구독 활성</span></dd>
        <dt>기관 ID</dt><dd><code>${esc(config.institution)}</code> (Trust Registry 등록)</dd>
        <dt>Webhook</dt><dd><code>${esc(config.webhook_url)}</code></dd>
       </dl>
       <p class="note">당행 HSM 공개키가 COLLECTION_BANK 역할로 등록되어 있어,
       당행 서명이 증거로 인정됩니다.</p>`
    : `<p class="hint">Cross-border Settlement 상품을 구독하면 견적·지급지시 API와
       Webhook 수신이 활성화됩니다.</p>
       <button id="subBtn" class="primary">구독 활성화 (기관 등록 + Webhook)</button>`;
  $('#subBtn')?.addEventListener('click', async () => {
    $('#subBtn').disabled = true;
    try {
      await api('POST', '/api/remit/subscribe');
      config = await api('GET', '/api/remit/config');
      renderSub();
    } catch (e) { alert(`구독 실패: ${e.message}`); $('#subBtn').disabled = false; }
  });
}

// ── 목록 + 상세 ────────────────────────────────────────────────────────────
async function refresh() {
  const { data } = await api('GET', '/api/remit/cases');
  $('#count').textContent = data.length ? `${data.length}건` : '';
  $('#empty').hidden = data.length > 0;
  for (const row of data) {
    if (open.has(row.id) || !details.has(row.id)) {
      try { details.set(row.id, await api('GET', `/api/remit/cases/${row.id}`)); } catch {}
    }
  }
  $('#cases').innerHTML = data.map((row) => caseHtml(details.get(row.id) ?? row)).join('');
  bind();
}

function chip(state) {
  const [label, color] = PSTATE[state] ?? [state, 'grey'];
  return `<span class="badge ${color}">${esc(label)}</span>`;
}

function flowHtml(c) {
  const st = c.platform?.state;
  if (!st) return '';
  const idx = FLOW.indexOf(st);
  const bad = ['CANCELLED', 'EXCEPTION', 'RETURNED'].includes(st);
  return `<div class="flow">${FLOW.map((s, i) => {
    const cls = bad ? (i <= idx ? 'done' : '') : i < idx ? 'done' : i === idx ? 'now' : '';
    return `<span class="fstep ${cls}">${i + 1}. ${esc((PSTATE[s] ?? [s])[0])}</span>${i < FLOW.length - 1 ? '<span class="arrow">→</span>' : ''}`;
  }).join('')}${bad ? `<span class="fstep bad">${esc(st)}</span>` : ''}</div>`;
}

function reviewHtml(c) {
  if (c.payment_id) return '';
  const q = c.quote;
  const ck = c.checks ?? {};
  const allChecked = ck.kyb && ck.trade && ck.fx;
  return `<div class="steps" style="border-top:1px solid #edf0f5">
    <p class="persona-inline" style="margin:4px 0 8px">은행 심사역 작업</p>
    ${q ? `<div class="quotebox">
        견적 <code>${esc(q.quote_id)}</code><br>
        고객 수납 <b>${num(q.collect.amount)} VND</b> (USD/VND ${esc(q.collect.rate)}, 수수료 USD ${esc(q.fees[0].amount)} 포함)<br>
        정산 <b>${esc(q.settlement.amount)} USDC</b> → 수취인 입금 <b>${num(q.payout.amount)} SGD</b> (USD/SGD ${esc(q.payout.rate)})<br>
        <span class="exp">만료 ${esc(q.expires_at.replace('T', ' ').slice(0, 19))} UTC</span>
      </div>`
      : `<button class="primary" data-act="quote" data-id="${c.id}">① 플랫폼 견적 조회 (POST /v1/quotes)</button>`}
    ${q ? `<div class="checks">
      <label><input type="checkbox" data-chk="kyb" data-id="${c.id}" ${ck.kyb ? 'checked' : ''}> KYB 확인 — 송금인 고객확인 유효 (정책 2026.3)</label>
      <label><input type="checkbox" data-chk="trade" data-id="${c.id}" ${ck.trade ? 'checked' : ''}> 무역서류 심사 — 인보이스·거래 실재성 확인</label>
      <label><input type="checkbox" data-chk="fx" data-id="${c.id}" ${ck.fx ? 'checked' : ''}> 외환심사 — 지급 사유·한도 적합</label>
    </div>
    <button class="primary" data-act="approve" data-id="${c.id}" ${allChecked ? '' : 'disabled'}>
      ② VND 수납 → HSM 서명 → 지급지시 제출 (POST /v1/settlements)</button>` : ''}
  </div>`;
}

function stepHtml(c, s) {
  const icon = s.state === 'ok' ? '✓' : s.state === 'fail' ? '✕' : '●';
  return `<div class="step ${s.state}">
    <span class="icon">${icon}</span>
    <div class="title">${esc(s.title)}
      <details><summary>상세</summary><pre>${esc(JSON.stringify(s.detail, null, 2))}</pre></details>
    </div>
    <span class="ms">${s.ms != null ? `${(s.ms / 1000).toFixed(1)}s` : ''}</span>
  </div>`;
}

function timelineHtml(c) {
  const fromWebhook = (c.timeline ?? []).map((t) => ({
    at: t.at, type: t.type, issuer: 'STONEHASH', source: 'webhook',
    sigok: t.signature_valid, seq: t.sequence,
  }));
  const fromPoll = (c.platform?.events ?? []).map((e) => ({
    at: e.at, type: e.type, issuer: e.issuer, source: 'poll', seq: e.seq,
  }));
  const seen = new Set();
  const rows = [...fromPoll, ...fromWebhook]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.at).localeCompare(String(b.at)))
    .filter((r) => {
      const k = `${r.seq}:${r.type}:${r.source}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  if (rows.length === 0) return '';
  return `<div class="timeline">${rows.map((r) => `
    <div class="tl">
      <span class="at">${esc(String(r.at).replace('T', ' ').slice(5, 19))}</span>
      <span class="who">${esc(ISSUER_KO[r.issuer] ?? r.issuer)}</span>
      <span>${esc(EVENT_KO[r.type] ?? r.type)}</span>
      <span class="src ${r.source}">${r.source === 'webhook' ? 'Webhook' : '폴링'}</span>
      ${r.sigok ? '<span class="sigok">서명검증✓</span>' : ''}
    </div>`).join('')}</div>`;
}

function rfiHtml(c) {
  const evs = c.platform?.events ?? [];
  const rfi = evs.find((e) => e.type === 'TRAVEL_RULE_RFI');
  const resolved = evs.some((e) => e.type === 'TRAVEL_RULE_RECEIVED' || e.type === 'TRAVEL_RULE_RFI_RESOLVED');
  if (!rfi || resolved || ['CANCELLED', 'EXCEPTION', 'RETURNED'].includes(c.platform?.state)) return '';
  const data = (c.timeline ?? []).find((t) => t.type === 'TRAVEL_RULE_RFI')?.data ?? {};
  const questions = data.questions ?? ['추가 정보를 제공해 주십시오'];
  return `<div class="steps" style="border-top:1px solid #f1e3c0;background:#fffaf0">
    <p class="persona-inline" style="color:#8a5a00">⚠ 수취기관 RFI — 답변 전까지 정산이 멈춰 있습니다</p>
    ${questions.map((q, i) => `
      <label class="fl">${esc(q)}
        <input type="text" data-rfi-q="${i}" data-id="${c.id}" placeholder="답변 입력">
      </label>`).join('')}
    <button class="primary" data-act="rfi" data-id="${c.id}">답변 서명·제출 (HSM) → 정산 재개</button>
  </div>`;
}

function exceptionHtml(c) {
  const st = c.platform?.state;
  const evs = c.platform?.events ?? [];
  if (st === 'RETURNED') {
    const failed = (c.timeline ?? []).find((t) => t.type === 'PAYOUT_FAILED')?.data ?? {};
    const ret = (c.timeline ?? []).find((t) => t.type === 'RETURNED' || t.type === 'USDC_RETURNED')?.data ?? {};
    return `<div class="result" style="background:#fdf1f1;border-top:1px solid #f0d4d4">
      <div class="ritem"><b style="color:#a02222">현지 지급 실패 → USDC 반환 완료</b>
        사유: ${esc(failed.reason ?? ret.reason ?? '—')}<br>
        반환 TX: <code>${esc(ret.return_tx ?? '—')}</code><br>
        다음 절차: 당행이 고객 VND를 환불합니다 (수납 전표 역분개). 반환·실패 이벤트는 전부 수취기관 서명과 함께 보존됩니다.</div>
    </div>`;
  }
  const insufficient = evs.some((e) => e.type === 'EVIDENCE_INSUFFICIENT');
  if (insufficient && st === 'PAYOUT_IN_PROGRESS') {
    return `<div class="result" style="background:#fff8e8;border-top:1px solid #efe2bb">
      <div class="ritem"><b style="color:#8a5a00">증거 불충분 (L1) — 입금확정 보류</b>
        지급 완료 통보가 왔지만 기관 서명이 없어(L1) '수취인 입금 확인'을 선언하지 않습니다.<br>
        실패가 아니라 <b>INSUFFICIENT_EVIDENCE</b>입니다 — L2 이상 서명 확인서 또는 일별 서명 명세로 보완해야 합니다.</div>
    </div>`;
  }
  return '';
}

function resultHtml(c) {
  const p = c.platform;
  if (!p || !['BENEFICIARY_CREDIT_CONFIRMED', 'EVIDENCE_ANCHORED'].includes(p.state)) return '';
  const completed = (c.timeline ?? []).find((t) => t.type === 'PAYOUT_COMPLETED');
  const fast = completed?.data?.bank_reference ?? '';
  return `<div class="result">
    <div class="ritem"><b>증거 등급</b><span class="badge green">${esc(p.evidence_level ?? 'L3')} · 현지은행 참조 + BFI 서명</span></div>
    ${fast ? `<div class="ritem"><b>FAST 참조</b><code>${esc(fast)}</code></div>` : ''}
    <div class="ritem"><b>USDC 전송 TX (사설체인)</b><code>${esc(p.chain_tx ?? '')}</code></div>
    <div class="ritem"><b>증빙 앵커</b>${p.attestation ? `<code>${esc(p.attestation.id)}</code> <span class="badge ${p.attestation.status === 'confirmed' ? 'green' : 'amber'}">${esc(p.attestation.status)}</span>` : '<span class="badge amber">대기</span>'}</div>
  </div>`;
}

function verifyHtml(c) {
  const v = c.verification;
  if (!v) return '';
  return `<div class="verify-report">
    <p class="persona-inline">독립 검증 리포트 — StoneHash 서버 없이, 벤더링된 검증기로 재계산 (${esc(v.verified_at?.slice(0, 19) ?? '')})</p>
    ${v.checks.map((k) => `<div class="vr"><span>${k.ok ? '✅' : '❌'}</span><span><b>${esc(k.name)}</b><div class="d">${esc(k.detail)}</div></span></div>`).join('')}
  </div>`;
}

function caseHtml(c) {
  const pstate = c.platform?.state ?? c.platform_state;
  const canEvidence = c.platform?.evidence_available;
  return `<article class="rec" data-id="${c.id}">
    <div class="rec-head" data-act="toggle" data-id="${c.id}" style="cursor:pointer">
      <span class="rec-name">${esc(c.invoice?.ref ?? '')}</span>
      <span class="rec-meta">USD ${esc(c.invoice?.amount_usd ?? '')} · ${esc(typeof c.importer === 'string' ? c.importer : c.importer?.name_ko ?? '')} → ${esc(typeof c.beneficiary === 'string' ? c.beneficiary : c.beneficiary?.name ?? '')}</span>
      <span class="spacer"></span>
      ${c.payment_id ? `<code class="rec-meta">${esc(c.payment_id)}</code>` : `<span class="badge grey">${esc(c.status)}</span>`}
      ${pstate ? chip(pstate) : ''}
    </div>
    ${open.has(c.id) ? `
      ${flowHtml(c)}
      ${reviewHtml(c)}
      ${(c.steps ?? []).length ? `<div class="steps">${c.steps.map((s) => stepHtml(c, s)).join('')}</div>` : ''}
      ${rfiHtml(c)}
      ${timelineHtml(c)}
      ${exceptionHtml(c)}
      ${resultHtml(c)}
      ${verifyHtml(c)}
      <div class="rec-actions">
        ${canEvidence ? `<a href="/api/remit/cases/${c.id}/evidence" download>증빙 패키지 다운로드 (JSON)</a>
        <button data-act="verify" data-id="${c.id}">독립 검증 실행 (벤더링 검증기)</button>` : ''}
        ${c.payment_id && ['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING'].includes(pstate)
          ? `<button data-act="cancel" data-id="${c.id}">취소 (사전승인 전 — HSM 서명)</button>` : ''}
      </div>
      ${c.error ? `<div class="error-line">${esc(c.error)}</div>` : ''}` : ''}
  </article>`;
}

function bind() {
  document.querySelectorAll('[data-act="toggle"]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      open.has(id) ? open.delete(id) : open.add(id);
      refresh();
    });
  });
  document.querySelectorAll('[data-act="quote"]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation(); el.disabled = true;
      try { await api('POST', `/api/remit/cases/${el.dataset.id}/quote`); } catch (e) { alert(e.message); }
      details.delete(el.dataset.id); refresh();
    });
  });
  document.querySelectorAll('[data-chk]').forEach((el) => {
    el.addEventListener('change', async () => {
      const id = el.dataset.id;
      const c = details.get(id);
      const checks = { ...(c?.checks ?? {}), [el.dataset.chk]: el.checked };
      await api('POST', `/api/remit/cases/${id}/review`, { checks });
      details.delete(id); refresh();
    });
  });
  document.querySelectorAll('[data-act="approve"]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation(); el.disabled = true; el.textContent = '제출 중…';
      try { await api('POST', `/api/remit/cases/${el.dataset.id}/approve`); } catch (e) { alert(e.message); }
      details.delete(el.dataset.id); refresh();
    });
  });
  document.querySelectorAll('[data-act="cancel"]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation(); el.disabled = true;
      try { await api('POST', `/api/remit/cases/${el.dataset.id}/cancel`, { reason: '은행 심사역 취소' }); }
      catch (e) { alert(e.message); }
      details.delete(el.dataset.id); refresh();
    });
  });
  document.querySelectorAll('[data-act="rfi"]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation(); el.disabled = true; el.textContent = '제출 중…';
      const id = el.dataset.id;
      const answers = {};
      document.querySelectorAll(`[data-rfi-q][data-id="${id}"]`).forEach((input) => {
        answers[`q${input.dataset.rfiQ}`] = input.value;
      });
      try { await api('POST', `/api/remit/cases/${id}/rfi`, { answers }); }
      catch (e) { alert(e.message); }
      details.delete(id); refresh();
    });
  });
  document.querySelectorAll('[data-act="verify"]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation(); el.disabled = true; el.textContent = '검증 중…';
      try { await api('POST', `/api/remit/cases/${el.dataset.id}/verify`); } catch (e) { alert(e.message); }
      details.delete(el.dataset.id); refresh();
    });
  });
}

$('#requestBtn').addEventListener('click', async () => {
  const ref = $('#invRef').value.trim() || `INV-2026-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const amt = $('#invAmt').value.trim();
  try {
    const c = await api('POST', '/api/remit/cases', {
      invoice: { ref, amount_usd: amt },
      scenario: $('#scenario').value || 'normal',
      travel_rule_mode: $('#modeB').checked ? 'B' : 'A',
    });
    open.add(c.id);
    refresh();
  } catch (e) { alert(e.message); }
});

$('#manifestBtn').addEventListener('click', async () => {
  const btn = $('#manifestBtn');
  btn.disabled = true; btn.textContent = '서명·제출 중…';
  try {
    const r = await api('POST', '/api/remit/manifest', { omit_one: $('#omitOne').checked });
    const v = r.verdict;
    const ok = v.status === 'MATCHED';
    $('#manifestOut').innerHTML = `
      <div class="quotebox" style="${ok ? '' : 'background:#fdf1f1;border-color:#e4b9b9'}">
        <b>${ok ? '✅ MATCHED' : '❌ DISCREPANT'}</b> — 은행 ${v.manifest_count}건 vs 플랫폼 ${v.platform_count}건<br>
        ${v.missing_in_manifest.length ? `은행 목록에 없음(누락 의심): <code>${v.missing_in_manifest.map(esc).join(', ')}</code><br>` : ''}
        ${v.unknown_to_platform.length ? `플랫폼이 모르는 건: <code>${v.unknown_to_platform.map(esc).join(', ')}</code><br>` : ''}
        ${r.demo_omitted ? `<span class="exp">(데모: ${esc(r.demo_omitted)} 를 일부러 뺐습니다)</span><br>` : ''}
        커밋 <code>${esc(r.commitment.slice(0, 20))}…</code> → 앵커 ${esc(r.attestation_id ?? '—')}
      </div>`;
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = '오늘자 Manifest 서명·제출';
});

loadConfig().then(refresh);
setInterval(refresh, 2500);
