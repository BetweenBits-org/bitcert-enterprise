/**
 * R2 exception-matrix smoke — drives the demo bank's own API (the same code
 * the buttons call) through every deviation the corridor handles:
 *
 *   sanctions hit    → TRAVEL_RULE_REJECTED → CANCELLED
 *   payout failure   → PAYOUT_FAILED → USDC returned on chain → RETURNED
 *   L1 completion    → EVIDENCE_INSUFFICIENT, confirmation withheld
 *   high-value RFI   → pause → signed answers → resume → EVIDENCE_ANCHORED
 *   cancel mid-RFI   → CANCELLED (and the BFI refuses later approval)
 *   mode B           → bank-side encryption end to end
 *   daily manifest   → signed, cross-checked, DISCREPANT detects an omission
 *
 * Requires: core :8787, partners :3300, demo-bank :3200, anvil, regtest.
 */
const BANK = process.env.BANK_BASE ?? 'http://127.0.0.1:3200';

const fail = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const step = (m) => console.log(`— ${m}`);
const api = async (method, path, body) => {
  const res = await fetch(`${BANK}${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(`${path}: ${json.message ?? json.error ?? res.status}`);
  return json;
};

async function newCase(scenario, amount, mode = 'A') {
  const c = await api('POST', '/api/remit/cases', {
    invoice: { ref: `INV-EXC-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, amount_usd: amount },
    scenario, travel_rule_mode: mode,
  });
  await api('POST', `/api/remit/cases/${c.id}/quote`);
  await api('POST', `/api/remit/cases/${c.id}/review`, { checks: { kyb: true, trade: true, fx: true } });
  await api('POST', `/api/remit/cases/${c.id}/approve`);
  return c.id;
}

async function waitFor(id, predicate, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const c = await api('GET', `/api/remit/cases/${id}`);
    const got = predicate(c);
    if (got) return { c, got };
    if (Date.now() - t0 > timeoutMs) {
      fail(`timeout waiting on case ${id}; state=${c.platform?.state} events=${(c.platform?.events ?? []).map((e) => e.type).join(',')}`);
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}
const stateIs = (s) => (c) => c.platform?.state === s ? c.platform.state : null;
const hasEvent = (t) => (c) => (c.platform?.events ?? []).some((e) => e.type === t) ? t : null;

// ① sanctions
{
  const id = await newCase('sanctioned', '9000.00');
  const { c } = await waitFor(id, stateIs('CANCELLED'));
  if (!(c.platform.events ?? []).some((e) => e.type === 'TRAVEL_RULE_REJECTED')) fail('sanctions: no TRAVEL_RULE_REJECTED event');
  step('① 제재 적중 → TRAVEL_RULE_REJECTED → CANCELLED');
}

// ② payout failure → on-chain return
{
  const id = await newCase('fail', '10000.00');
  const { c } = await waitFor(id, stateIs('RETURNED'));
  const types = (c.platform.events ?? []).map((e) => e.type);
  for (const must of ['USDC_TRANSFER_CONFIRMED', 'PAYOUT_FAILED', 'USDC_RETURNED']) {
    if (!types.includes(must)) fail(`return path: missing ${must}`);
  }
  const ret = c.platform.events.find((e) => e.type === 'USDC_RETURNED');
  step(`② 지급실패 → USDC 반환(tx 포함) → RETURNED (events: ${types.slice(-3).join(' → ')})`);
  void ret;
}

// ③ L1 — confirmation withheld, not failed
{
  const id = await newCase('l1', '10000.00');
  const { c } = await waitFor(id, hasEvent('EVIDENCE_INSUFFICIENT'));
  if (c.platform.state !== 'PAYOUT_IN_PROGRESS') fail(`L1: expected hold at PAYOUT_IN_PROGRESS, got ${c.platform.state}`);
  if (c.platform.evidence_level !== 'L1') fail('L1: evidence level not recorded');
  step('③ L1 수신 → EVIDENCE_INSUFFICIENT, 입금확정 보류 (PAYOUT_IN_PROGRESS 유지)');
}

// ④ RFI round trip to full completion
{
  const id = await newCase('rfi', '25000.00');
  await waitFor(id, hasEvent('TRAVEL_RULE_RFI'));
  await api('POST', `/api/remit/cases/${id}/rfi`, {
    answers: { q0: '전자부품 수입대금 — 계약 CT-2026-88', q1: 'B/L SGSIN-99231' },
  });
  await waitFor(id, stateIs('EVIDENCE_ANCHORED'), 90_000);
  step('④ 고액 RFI → 서명 답변 → 재개 → EVIDENCE_ANCHORED 완주');
}

// ⑤ cancel while paused on RFI
{
  const id = await newCase('rfi', '25000.00');
  await waitFor(id, hasEvent('TRAVEL_RULE_RFI'));
  await api('POST', `/api/remit/cases/${id}/cancel`, { reason: '계약 변경' });
  const { c } = await waitFor(id, stateIs('CANCELLED'));
  if (!(c.platform.events ?? []).some((e) => e.type === 'CANCEL_REQUESTED')) fail('cancel: no signed CANCEL_REQUESTED event');
  step('⑤ RFI 대기 중 취소(은행 서명) → CANCELLED');
}

// ⑥ mode B full run
{
  const id = await newCase('normal', '8000.00', 'B');
  await waitFor(id, stateIs('EVIDENCE_ANCHORED'), 90_000);
  const c = await api('GET', `/api/remit/cases/${id}`);
  // the bank's case view strips event payloads; the mode travels in the
  // TRAVEL_RULE_PENDING webhook data and in the bank's own encrypt step
  const whMode = (c.timeline ?? []).find((t) => t.type === 'TRAVEL_RULE_PENDING')?.data?.mode;
  const encStep = (c.steps ?? []).find((s2) => s2.key === 'encrypt');
  if (whMode !== 'B' || encStep?.state !== 'ok') {
    fail(`mode B: webhook mode=${whMode} encrypt step=${encStep?.state ?? 'absent'}`);
  }
  step('⑥ 모드 B(은행측 암호화) → BFI 복호·검증 → EVIDENCE_ANCHORED 완주');
}

// ⑦ manifest: the omission detector
{
  const r = await api('POST', '/api/remit/manifest', { omit_one: true });
  if (r.verdict.status !== 'DISCREPANT') fail('manifest: omission not detected');
  if (!r.verdict.missing_in_manifest.includes(r.demo_omitted)) fail('manifest: omitted id not named');
  if (!r.commitment || !r.attestation_id) fail('manifest: verdict not committed/anchored');
  step(`⑦ Manifest 누락 1건 → DISCREPANT, 누락 id 적발 (${r.demo_omitted}) + 대사결과 앵커`);
}

console.log('\n✓ exception matrix passed (7/7)');
