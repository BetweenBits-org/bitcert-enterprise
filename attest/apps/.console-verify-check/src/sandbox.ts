/**
 * The evaluation workspace.
 *
 * Six things a prospective customer can do before signing anything: pick a
 * record that resembles their own, watch evidence be built and checked, break
 * it deliberately, read the result apart item by item, carry the result away
 * as a file, and see the requests that produced all of it.
 *
 * ## The distinction the whole screen is arranged around
 *
 * "The document is genuine" and "the payment may be released" are different
 * questions, and most of the value here is in showing that they can disagree.
 * A forged seal leaves the figures agreeing. A resubmitted receipt leaves
 * everything verifying. So there is no single verdict light anywhere on this
 * page: six axes are reported separately, each as 통과 / 불일치 / 대기 /
 * 미검증, and the release decision is left to the reader — which is also what
 * the engine does, by returning `manualReviewRequired` instead of a pass.
 *
 * ## What is real
 *
 * Nothing here is drawn from a canned response. The verdict comes from
 * `POST /v1/settlements/reconcile` — the integration endpoint, not a console
 * one — and the API panel prints the calls as they were recorded at the
 * fetch, so the screen can be checked against the wire rather than believed.
 */
import { api, ApiError, calls, digestText, onApiCall } from './api.ts';
import { t } from './i18n.ts';
import { SCENARIO_KO, SCENARIO_TITLE_KO, TAMPER_KO } from './copy.ts';
import type {
  Catalogue, EvidencePackage, Finding, PackageCheck, TamperStep, Verdict,
} from './api.ts';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const $ = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

// ── tracks ─────────────────────────────────────────────────────────────────

/**
 * Three kinds of record, kept apart because Attest does different work on
 * each and a picker that blurred them would promise reconciliation for a
 * contract. Only the settlement track has cross-source rules to run; the other
 * two are single documents, where the question is existence and integrity.
 */
interface Track {
  id: string;
  label: string;
  blurb: string;
  kind: 'settlement' | 'document' | 'own';
  sample?: { name: string; text: string };
}

const CONTRACT_SAMPLE = `SERVICES AGREEMENT

Parties      Northwind Trading Pte Ltd  /  Halla Components Co., Ltd.
Effective    2026-03-01
Term         24 months, renewing annually unless notice is given 60 days prior
Fees         USD 18,000 per quarter, payable within 30 days of invoice
Governing    Singapore

Clause 7.2   Neither party may assign this agreement without written consent.
Clause 11.4  Amendments take effect only when signed by both parties.

Signed       /s/ L. Tan, Director            /s/ J. Park, CEO
             2026-02-24                      2026-02-25
`;

const AUDIT_SAMPLE = `2026-03-02T09:14:22Z  acct=svc-settlement  action=policy.update  from=v1 to=v1  result=noop
2026-03-02T09:17:03Z  acct=j.park         action=payment.approve  ref=INV-2026-001  amount=50000.00 USD
2026-03-02T09:17:04Z  acct=svc-settlement  action=transfer.submit  ref=INV-2026-001  txid=9f2c…
2026-03-02T09:41:55Z  acct=svc-settlement  action=transfer.confirm ref=INV-2026-001  confirmations=1
2026-03-02T10:02:11Z  acct=l.tan          action=evidence.export  ref=INV-2026-001  format=bundle
`;

const TRACKS: Track[] = [
  {
    id: 'own',
    label: '내 증빙 올리기',
    blurb: '샘플이 아니라 실제 자료로 확인하십시오. 유료 전환 후에도 같은 엔드포인트, 같은 규칙입니다 — 달라지는 것은 어느 DB와 어느 체인을 쓰느냐뿐입니다.',
    kind: 'own',
  },
  {
    id: 'settlement',
    label: '인보이스 · 송금 증빙 세트',
    blurb: '여섯 곳에서 온 서류를 서로 대조합니다. 금액·서명·누락·중복까지 직접 깨보고 결과를 항목별로 확인하십시오.',
    kind: 'settlement',
  },
  {
    id: 'contract',
    label: '계약서',
    blurb: '단일 문서입니다. 대조할 상대가 없으므로 확인되는 것은 존재와 무결성 — 이 계약서가 그때 그 계약서인지입니다.',
    kind: 'document',
    sample: { name: 'services-agreement.txt', text: CONTRACT_SAMPLE },
  },
  {
    id: 'auditlog',
    label: '감사로그',
    blurb: '한 줄만 바꿔도 해시가 달라집니다. 로그를 고친 뒤 다시 해시해 보시면 바로 드러납니다.',
    kind: 'document',
    sample: { name: 'settlement-audit.log', text: AUDIT_SAMPLE },
  },
];


// ── axis presentation ──────────────────────────────────────────────────────

type Verdictish = '통과' | '불일치' | '대기' | '미검증';

/**
 * Every axis state, mapped to one of four words.
 *
 * Exhaustive on purpose. An unmapped state falling through to "통과" is the
 * one bug class this screen cannot afford, so the default is 미검증 — the
 * reading that claims least.
 */
const STATE_WORD: Record<string, Verdictish> = {
  VALID: '통과', INVALID: '불일치', NOT_CHECKED: '미검증',
  UNKNOWN_ISSUER: '미검증',
  MATCH: '통과', MISMATCH: '불일치', PENDING: '대기',
  COMPLETE: '통과', INCOMPLETE: '대기',
  PRESENT: '통과', MISSING: '불일치', REVIEW_REQUIRED: '대기',
  VERIFIED_BY_SOURCE: '통과', UNVERIFIED: '미검증', DEMO_ONLY: '미검증',
};

const AXES: { key: string; label: string; asks: string }[] = [
  { key: 'integrity', label: '문서 무결성', asks: '제출된 서류가 서명 당시의 그 서류입니까?' },
  { key: 'issuer', label: '발행 기관', asks: '누가 서명했고, 그 키를 우리가 압니까?' },
  { key: 'matching', label: '업무 대조', asks: '서로 다른 출처의 금액·당사자·기한이 일치합니까?' },
  { key: 'completeness', label: '서류 완비', asks: '정책이 요구하는 서류가 모두 있습니까?' },
  { key: 'regulatoryMapping', label: '보고 항목', asks: '규제 서식이 묻는 필드가 채워져 있습니까?' },
  { key: 'businessFinality', label: '자금 확정', asks: '지급 기관이 실제로 자금 이동을 확인해 주었습니까?' },
];

const word = (state: string): Verdictish => STATE_WORD[state] ?? '미검증';
const toneOf = (w: Verdictish): string =>
  w === '통과' ? 'ok' : w === '불일치' ? 'bad' : w === '대기' ? 'wait' : 'inert';

/** `10000.00` − `9800.00` → `200.00`, without floating point. */
function difference(expected?: string, actual?: string): string | null {
  if (!expected || !actual) return null;
  const parse = (s: string): bigint | null => {
    const m = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(s.trim());
    if (!m) return null;
    const frac = (m[3] ?? '').padEnd(8, '0');
    return BigInt(`${m[1]}${m[2]}${frac}`);
  };
  const a = parse(expected); const b = parse(actual);
  if (a === null || b === null) return null;
  let d = a - b;
  const sign = d < 0n ? '-' : '';
  if (d < 0n) d = -d;
  const s = d.toString().padStart(9, '0');
  return `${sign}${s.slice(0, -8)}.${s.slice(-8).replace(/0+$/, '').padEnd(2, '0')}`;
}

/**
 * Repeated codes collapse into one row.
 *
 * Four elements signed by demonstration keys produced four identical
 * paragraphs of ISSUER_TRUST_INSUFFICIENT, and the single blocking finding
 * underneath them was the thing the reader needed. Identical text repeated is
 * not four pieces of information; the elements it applied to are, so those
 * are listed and the sentence is printed once.
 */
function group(list: Finding[]): { f: Finding; where: string[] }[] {
  const by = new Map<string, { f: Finding; where: string[] }>();
  for (const f of list) {
    const key = `${f.code}|${f.detail}|${f.expected ?? ''}|${f.actual ?? ''}`;
    const hit = by.get(key);
    const label = [f.element, f.field].filter(Boolean).join('.');
    if (hit) { if (label) hit.where.push(label); } else { by.set(key, { f, where: label ? [label] : [] }); }
  }
  return [...by.values()];
}

function findingRow({ f, where }: { f: Finding; where: string[] }): string {
  const diff = difference(f.expected, f.actual);
  const cells = [
    f.expected !== undefined ? `<span class="fv"><i>기대</i>${esc(f.expected)}</span>` : '',
    f.actual !== undefined ? `<span class="fv"><i>실제</i>${esc(f.actual)}</span>` : '',
    diff && diff !== '0.00' ? `<span class="fv diff"><i>차이</i>${esc(diff)}</span>` : '',
    f.tolerance ? `<span class="fv"><i>허용</i>${esc(f.tolerance)}</span>` : '',
  ].filter(Boolean).join('');
  return `<li class="fnd ${esc(f.severity)}">
    <div class="fh"><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      <code>${esc(f.code)}</code>
      ${where.length > 1 ? `<span class="dim">×${where.length}</span>` : ''}</div>
    <p>${esc(f.detail)}</p>
    ${where.length ? `<span class="where">${esc(where.join('  ·  '))}</span>` : ''}
    ${cells ? `<div class="fvals">${cells}</div>` : ''}
  </li>`;
}

function axisCard(v: Verdict, a: { key: string; label: string; asks: string }): string {
  const axis = v.axes[a.key];
  if (!axis) return '';
  const w = word(axis.state);
  const own = v.findings.filter((f) => f.axis === a.key && f.severity !== 'info');
  return `<article class="axis ${toneOf(w)}">
    <header><span class="chip ${toneOf(w)}">${w}</span><b>${esc(a.label)}</b>
      <code class="dim">${esc(axis.state)}</code></header>
    <p class="asks">${esc(a.asks)}</p>
    ${own.length ? `<ul class="fnds">${group(own).map(findingRow).join('')}</ul>`
      : '<p class="dim none">이 항목에서는 지적된 사항이 없습니다.</p>'}
  </article>`;
}

// ── state ──────────────────────────────────────────────────────────────────

interface S {
  cat: Catalogue | null;
  track: string;
  scenario: string;
  steps: TamperStep[];
  evidence: Record<string, unknown> | null;
  verdict: Verdict | null;
  pkg: EvidencePackage | null;
  check: PackageCheck | null;
  busy: boolean;
  error: string;
  docName: string;
  docText: string;
  docDigest: string;
  own: Record<string, unknown> | null;
  ownName: string;
  policy: Record<string, unknown> | null;
  polName: string;
}
const s: S = {
  cat: null, track: 'settlement', scenario: 'A', steps: [],
  evidence: null, verdict: null, pkg: null, check: null,
  busy: false, error: '', docName: '', docText: '', docDigest: '',
  own: null, ownName: '', policy: null, polName: '',
};

const track = (): Track => TRACKS.find((t) => t.id === s.track) ?? TRACKS[0]!;

// ── rendering ──────────────────────────────────────────────────────────────

function trackPicker(): string {
  return `<div class="picker">${TRACKS.map((t) => `
    <button class="pick ${t.id === s.track ? 'on' : ''}" data-track="${esc(t.id)}">
      <b>${esc(t.label)}</b><small>${esc(t.blurb)}</small>
    </button>`).join('')}</div>`;
}

function scenarioPicker(): string {
  const cat = s.cat!;
  const current = cat.scenarios.find((x) => x.id === s.scenario);
  return `
    <div class="step"><span class="n">2</span><div>
      <h3>상황을 고르십시오</h3>
      <p class="lede">여섯 가지 모두 같은 원본 한 건에서 파생됩니다. 그래야 결과의 차이가
        데이터가 달라서가 아니라 <b>규칙이 달라서</b> 생긴 것임이 분명합니다.</p>
      <div class="scens">${cat.scenarios.map((x) => `
        <button class="scen ${x.id === s.scenario ? 'on' : ''}" data-scen="${esc(x.id)}">
          <span class="sid">${esc(x.id)}</span>${esc(SCENARIO_TITLE_KO[x.id] ?? x.title)}</button>`).join('')}</div>
      ${current ? `<p class="teaches">${esc(SCENARIO_KO[current.id] ?? current.teaches)}</p>` : ''}
    </div></div>`;
}

function tamperPicker(): string {
  const cat = s.cat!;
  const opts = (name: string, list: readonly string[] | undefined): string =>
    list ? `<select data-need="${esc(name)}">${list.map((o) =>
      `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>` : '';
  return `
    <div class="step"><span class="n">3</span><div>
      <h3>직접 훼손해 보십시오</h3>
      <p class="lede">시나리오 위에 추가로 적용됩니다. 무엇이 탐지되는지보다
        <b>무엇이 탐지되지 않는지</b>를 보시는 편이 판단에 도움이 됩니다.</p>
      <div class="tampers">${cat.tampers.map((t) => `
        <div class="tamper" data-tamper="${esc(t.id)}">
          <div class="th"><b>${esc(TAMPER_KO[t.id]?.label ?? t.label)}</b>
            <button class="btn tiny" data-apply="${esc(t.id)}">적용</button></div>
          <p>${esc(TAMPER_KO[t.id]?.asks ?? t.asks)}</p>
          <div class="tneeds">
            ${opts('target', t.needs.target)}
            ${opts('document', t.needs.document)}
            ${t.needs.amount ? '<input type="text" data-need="amount" placeholder="49800.00" class="mono" spellcheck="false">' : ''}
          </div>
        </div>`).join('')}</div>
      ${s.steps.length ? `<div class="applied"><b>적용된 변조</b>
        <ol>${s.steps.map((x, i) => `<li><code>${esc(x.id)}</code>
          ${esc([x.target, x.document, x.amount].filter(Boolean).join(' · '))}
          <button class="link" data-undo="${i}">되돌리기</button></li>`).join('')}</ol>
        </div>` : '<p class="dim none">아직 변조를 적용하지 않았습니다.</p>'}
    </div></div>`;
}

/**
 * The result, with the release decision withheld.
 *
 * The banner states the two answers separately because the engine does: it
 * reports what reconciled and raises `manualReviewRequired`, and it never says
 * "approved". A console that printed one combined verdict would be claiming an
 * authority the product deliberately refuses.
 */
function resultBlock(): string {
  if (!s.verdict) {
    return `<div class="step"><span class="n">4</span><div>
      <h3>항목별 검증 결과</h3>
      <p class="dim none">위에서 <b>검증 실행</b>을 누르면 결과가 여기에 나옵니다.</p>
    </div></div>`;
  }
  const v = s.verdict;
  const blocking = v.findings.filter((f) => f.severity === 'blocking');
  const integrityOk = word(v.axes['integrity']?.state ?? '') === '통과';
  return `
    <div class="step"><span class="n">4</span><div>
      <h3>항목별 검증 결과</h3>
      <div class="split">
        <div class="half ${integrityOk ? 'ok' : 'bad'}">
          <span class="lbl">문서 무결성</span>
          <b>${integrityOk ? '통과' : '통과하지 못함'}</b>
          <small>제출된 서류가 서명 당시 그대로인지에 대한 답입니다.</small>
        </div>
        <div class="half ${blocking.length ? 'bad' : 'wait'}">
          <span class="lbl">거래 승인</span>
          <b>${blocking.length ? `보류 — 차단 사유 ${blocking.length}건` : '자동 승인 없음'}</b>
          <small>${blocking.length
            ? '아래 차단 항목이 해소되기 전에는 집행할 수 없습니다.'
            : '막는 사유는 없습니다. 그래도 승인은 사람이 합니다 — 이 엔진은 대조만 합니다.'}</small>
        </div>
      </div>
      <div class="axes">${AXES.map((a) => axisCard(v, a)).join('')}</div>
      <dl class="meta">
        <dt>정책</dt><dd class="mono">${esc(v.policyVersion)} · ${esc(v.policyDigest.slice(0, 16))}…</dd>
        <dt>데이터</dt><dd>${esc(v.dataMode)}</dd>
        <dt>규제 판정</dt><dd class="mono">${esc(v.regulatoryDecision)}</dd>
        <dt>사람의 검토</dt><dd>${v.manualReviewRequired ? '필요' : '불필요'}</dd>
      </dl>
      <p class="hint">정책 다이제스트가 결과에 함께 남습니다. 어떤 규칙으로 내린 판정인지
        밝히지 않은 결과는 받는 쪽에서 확인할 수 없기 때문입니다.</p>
    </div></div>`;
}

function packageBlock(): string {
  const c = s.check;
  return `
    <div class="step"><span class="n">5</span><div>
      <h3>증빙 패키지</h3>
      <p class="lede">증거·정책·판정과 <b>서명 검증에 쓸 공개키</b>를 한 파일에 담습니다.
        받는 쪽이 우리를 믿는 대신 직접 다시 계산할 수 있어야 의미가 있습니다.</p>
      <div class="row">
        <button class="btn" id="sbx-pack" ${s.evidence ? '' : 'disabled'}>패키지 만들기</button>
        <button class="btn ghost" id="sbx-dl" ${s.pkg ? '' : 'disabled'}>JSON 내려받기</button>
        <button class="btn ghost" id="sbx-zip" ${s.evidence ? '' : 'disabled'}>검토자용 보고서 (ZIP)</button>
      </div>
      ${s.pkg ? `<dl class="meta">
        <dt>패키지</dt><dd class="mono">${esc(s.pkg.bundleId)}</dd>
        <dt>digest</dt><dd class="mono">${esc(s.pkg.digest.slice(0, 32))}…</dd>
        <dt>공개키</dt><dd>${s.pkg.verificationMaterial.issuerKeys.length}개
          (${esc(s.pkg.verificationMaterial.issuerKeys[0]?.trustLevel ?? '')})</dd>
      </dl>` : ''}
      <div class="reimport">
        <label class="drop" id="sbx-drop">
          <input type="file" id="sbx-file" accept=".json,application/json" hidden>
          <span class="dk">받은 패키지 다시 검증</span>
          <span class="dv" id="sbx-fname">패키지 JSON을 끌어다 놓거나 클릭</span>
        </label>
        ${c ? `<div class="recheck">
          <div class="rrow ${c.digestOk ? 'ok' : 'bad'}">
            <span class="chip ${c.digestOk ? 'ok' : 'bad'}">${c.digestOk ? '일치' : '불일치'}</span>
            <div><b>파일이 발급된 그대로입니까</b>
              <small class="mono">${esc(c.recomputedDigest.slice(0, 24))}… ${c.digestOk ? '' : `≠ ${esc(c.recordedDigest.slice(0, 24))}…`}</small></div>
          </div>
          <div class="rrow ${c.reproduced ? 'ok' : 'wait'}">
            <span class="chip ${c.reproduced ? 'ok' : 'wait'}">${c.reproduced ? '재현됨' : '달라짐'}</span>
            <div><b>지금 다시 돌려도 같은 결과입니까</b>
              <small>${c.differences.length
                ? esc(c.differences.map((d) => `${d.axis}: ${d.recorded} → ${d.now}`).join(', '))
                : '여섯 항목 모두 기록과 동일합니다.'}</small></div>
          </div>
          <p class="hint">두 질문은 따로 답해야 합니다. 파일이 바뀐 것과, 규칙이 바뀐 것은
            원인도 대응도 다릅니다.</p>
        </div>` : ''}
      </div>
    </div></div>`;
}


/**
 * The transcript, rendered into whichever section asks for it.
 *
 * It lives under 연동 because it is about wiring this into a system, and it
 * covers every call the page made — anchoring included — not only the ones
 * the evaluation workspace triggered.
 */
export function renderApiLog(): void {
  const host = $('apilog');
  if (host) host.innerHTML = apiBlock();
}

function apiBlock(): string {
  const log = calls();
  return `
    <div class="step bare"><div>
      <span class="eyebrow">TRANSCRIPT</span>
      <h3>${t('API 실행 기록', 'Request log')}</h3>
      <p class="lede">${t(
        '이 화면이 <b>실제로 보낸</b> 요청입니다. 기록은 fetch 지점에서 남으므로, 화면이 '
          + '말하는 것과 선로를 오간 것을 직접 대조하실 수 있습니다.',
        'What this page <b>actually sent</b>. Recorded at the fetch, so you can check the '
          + 'screen against the wire rather than believe it.')}</p>
      ${log.length ? `<div class="log">${log.slice(0, 8).map((c) => `
        <details class="call">
          <summary><span class="chip ${c.status >= 200 && c.status < 300 ? 'ok' : 'bad'}">${c.status || 'ERR'}</span>
            <code>${esc(c.method)} ${esc(c.path)}</code><span class="dim">${c.ms}ms</span></summary>
          ${c.request !== undefined ? `<pre class="code"><code>${esc(JSON.stringify(c.request, null, 2).slice(0, 1400))}</code></pre>` : ''}
          <pre class="code"><code>${esc(JSON.stringify(c.response, null, 2).slice(0, 1800))}</code></pre>
        </details>`).join('')}</div>`
        : `<p class="dim none">${t('아직 호출이 없습니다.', 'No calls yet.')}</p>`}
    </div></div>`;
}

/** In the workspace, a pointer rather than the whole transcript. */
function apiSummary(): string {
  const n = calls().length;
  return `<div class="step"><span class="n">6</span><div>
      <h3>API 실행 기록</h3>
      <p class="lede">이 화면이 방금 보낸 요청은 <b>${n}건</b>입니다. 요청·응답 본문과
        cURL, 오류 코드는 <a href="#/integrate">연동</a> 화면에 있습니다 —
        기록은 fetch 지점에서 남으므로 화면이 말하는 것과 선로를 대조하실 수 있습니다.</p>
    </div></div>`;
}

/**
 * Run the product over the reviewer's own settlement file.
 *
 * The samples exist to give someone a starting point, not to be the extent of
 * what the sandbox can do — a prospect evaluating this needs an answer about
 * their records, not ours. Same endpoints, same rules, same tamper catalogue;
 * the policy is theirs too if they send one.
 */
function ownTrack(): string {
  return `
    <div class="step"><span class="n">2</span><div>
      <h3>증빙과 정책을 올리십시오</h3>
      <p class="lede">실제 자료로 돌려 보십시오. 결과를 내는 것은
        <code>${esc(s.cat!.reconcileEndpoint)}</code> — 유료 고객이 연동하는 바로 그
        엔드포인트입니다. 샌드박스와 운영의 차이는 어느 DB를 열고, 어느 체인에
        앵커링하며, 어떤 키 접두사로 인증하는지뿐입니다.</p>
      <div class="two">
        <label class="drop" id="own-ev-drop">
          <input type="file" id="own-ev" accept=".json,application/json" hidden>
          <span class="dk">증빙 JSON <b class="req">필수</b></span>
          <span class="dv" id="own-ev-name">${esc(s.ownName || 'settlement-evidence JSON')}</span>
        </label>
        <label class="drop" id="own-pol-drop">
          <input type="file" id="own-pol" accept=".json,application/json" hidden>
          <span class="dk">정책 JSON <b class="opt">선택</b></span>
          <span class="dv" id="own-pol-name">${esc(s.polName || '비워 두면 기본 정책을 씁니다')}</span>
        </label>
      </div>
      <p class="hint">증빙 형식이 처음이시라면, <b>인보이스 · 송금 증빙 세트</b>에서
        패키지를 하나 내려받아 그 안의 <code>evidence</code>를 틀로 쓰시면 됩니다.
        스키마는 <code>settlement-evidence/0.1</code>입니다.</p>
      <p class="hint warnhint"><b>서명 키에 관해 먼저 말씀드립니다.</b>
        이 샌드박스는 서명을 <b>시연용 키링</b>으로만 검증합니다. 그러므로 올리신 증빙의
        서명이 귀사 키로 되어 있으면 발행 기관 항목은 <code>UNKNOWN_KEY</code> 또는
        <code>INVALID</code>로 나옵니다 — 서명이 잘못된 것이 아니라, 이 환경이 그 키를
        모르기 때문입니다. 무결성·대조·완전성·중복은 귀사 자료 그대로 정상 동작합니다.
        조직별 발행 키 등록은 유료 전환 시 설정합니다.</p>
    </div></div>`;
}

function documentTrack(): string {
  const t = track();
  return `
    <div class="step"><span class="n">2</span><div>
      <h3>${esc(t.label)} 해시 만들기</h3>
      <p class="lede">이 문서는 대조할 상대가 없습니다. 확인되는 것은 <b>존재와 무결성</b>입니다.
        아래 내용을 직접 고쳐 보시면 해시가 어떻게 달라지는지 바로 보입니다.</p>
      <textarea id="sbx-doc" class="doc mono" spellcheck="false">${esc(s.docText)}</textarea>
      <div class="row">
        <button class="btn" id="sbx-hash">해시 계산</button>
        <span class="mono dim" id="sbx-dg">${esc(s.docDigest || '—')}</span>
      </div>
      <p class="hint">계산은 이 브라우저에서 일어납니다. 본문은 전송되지 않으며,
        앵커링할 때도 32바이트 해시만 올라갑니다 — 위 대시보드의
        <b>Anchor a document</b> 칸에 이 값을 붙여 넣으시면 됩니다.</p>
    </div></div>`;
}

export function renderSandbox(): void {
  const host = $('sandbox');
  if (!host) return;
  if (!s.cat) { host.innerHTML = '<p class="dim">샌드박스를 불러오는 중…</p>'; return; }
  const t = track();

  host.innerHTML = `
    <div class="sbx-head">
      <h2>증빙 검증</h2>
      <p class="lede">증빙을 만들고, 깨뜨리고, 항목별로 읽고, 결과를 파일로 가져가는 곳입니다.
        화면의 모든 판정은 실제 연동 엔드포인트
        <code>${esc(s.cat.reconcileEndpoint)}</code>가 낸 것입니다.</p>
      <p class="warn-line"><b>${esc(s.cat.dataMode)}</b> —
        ${s.cat.notRealPayment ? '실제 지급 건이 아니며, 증거 자체가 그렇게 선언합니다.' : ''}</p>
    </div>

    <div class="step"><span class="n">1</span><div>
      <h3>업무를 고르십시오</h3>
      ${trackPicker()}
    </div></div>

    ${t.kind === 'own' ? ownTrack() : ''}
    ${t.kind === 'settlement' ? scenarioPicker() : ''}
    ${t.kind === 'settlement' || t.kind === 'own' ? `
      ${tamperPicker()}
      <div class="runbar">
        <button class="btn" id="sbx-run"
          ${s.busy || (t.kind === 'own' && !s.own) ? 'disabled' : ''}>
          ${s.busy ? '실행 중…' : t.kind === 'own' ? '내 증빙 검증 실행' : '증빙 생성 후 검증 실행'}</button>
        <button class="btn ghost" id="sbx-reset">처음으로</button>
        ${s.error ? `<span class="err">${esc(s.error)}</span>` : ''}
      </div>
      ${resultBlock()}
      ${packageBlock()}
    ` : ''}
    ${t.kind === 'document' ? documentTrack() : ''}

    ${apiSummary()}`;

  wire();
}

// ── behaviour ──────────────────────────────────────────────────────────────

function needsOf(el: Element): TamperStep {
  const id = (el as HTMLElement).dataset['tamper']!;
  const step: TamperStep = { id };
  for (const f of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-need]')) {
    const k = f.dataset['need']!;
    if (!f.value) continue;
    if (k === 'target') step.target = f.value;
    if (k === 'document') step.document = f.value;
    if (k === 'amount') step.amount = f.value;
  }
  return step;
}

async function run(): Promise<void> {
  s.busy = true; s.error = ''; renderSandbox();
  try {
    const built = s.own
      ? await api.buildEvidenceFrom(s.own, s.steps)
      : await api.buildEvidence(s.scenario, s.steps);
    s.evidence = built.evidence;
    s.verdict = await api.reconcile(built.evidence, s.policy ?? s.cat!.policy);
    s.pkg = null; s.check = null;
  } catch (e) {
    s.error = e instanceof ApiError ? `${e.code}: ${e.message}` : String(e);
    s.verdict = null;
  } finally {
    s.busy = false; renderSandbox();
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** The ZIP is a POST, so it cannot be an href. */
async function downloadZip(): Promise<void> {
  const res = await fetch('/v1/settlements/bundle', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ evidence: s.evidence, policy: s.policy ?? s.cat!.policy }),
  });
  if (!res.ok) { s.error = `보고서를 만들지 못했습니다 (HTTP ${res.status})`; renderSandbox(); return; }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
    ?? 'evidence-bundle.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function wire(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-track]')) {
    b.addEventListener('click', () => {
      s.track = b.dataset['track']!;
      const t = track();
      if (t.sample) { s.docText = t.sample.text; s.docName = t.sample.name; s.docDigest = ''; }
      // Results belong to the track that produced them.
      s.verdict = null; s.pkg = null; s.check = null; s.error = ''; s.steps = [];
      renderSandbox();
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-scen]')) {
    b.addEventListener('click', () => {
      s.scenario = b.dataset['scen']!; s.verdict = null; s.pkg = null; s.check = null;
      renderSandbox();
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-apply]')) {
    b.addEventListener('click', () => {
      const box = b.closest('[data-tamper]');
      if (box) { s.steps = [...s.steps, needsOf(box)]; renderSandbox(); }
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-undo]')) {
    b.addEventListener('click', () => {
      s.steps = s.steps.filter((_, i) => i !== Number(b.dataset['undo']));
      renderSandbox();
    });
  }
  $('sbx-run')?.addEventListener('click', () => { void run(); });
  $('sbx-reset')?.addEventListener('click', () => {
    s.steps = []; s.scenario = 'A'; s.verdict = null; s.pkg = null; s.check = null; s.error = '';
    renderSandbox();
  });

  $('sbx-pack')?.addEventListener('click', () => {
    void (async () => {
      try { s.pkg = await api.pack(s.evidence, s.policy ?? s.cat!.policy); }
      catch (e) { s.error = e instanceof ApiError ? e.message : String(e); }
      renderSandbox();
    })();
  });
  $('sbx-dl')?.addEventListener('click', () => {
    if (s.pkg) download(`${s.pkg.bundleId}.json`, JSON.stringify(s.pkg, null, 2));
  });
  $('sbx-zip')?.addEventListener('click', () => { void downloadZip(); });

  const file = $<HTMLInputElement>('sbx-file');
  file?.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    void (async () => {
      const name = $('sbx-fname');
      if (name) name.textContent = f.name;
      try {
        s.check = await api.checkPackage(JSON.parse(await f.text()));
        s.error = '';
      } catch (e) {
        s.check = null;
        s.error = e instanceof ApiError ? `${e.code}: ${e.message}` : '패키지 JSON이 아닙니다.';
      }
      renderSandbox();
    })();
  });

  const readJson = (inputId: string, nameId: string, set: (v: Record<string, unknown>, n: string) => void): void => {
    const input = $<HTMLInputElement>(inputId);
    input?.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      void (async () => {
        try {
          set(JSON.parse(await f.text()) as Record<string, unknown>, f.name);
          s.error = '';
        } catch {
          s.error = `${f.name} 을(를) JSON 으로 읽지 못했습니다.`;
        }
        const label = $(nameId);
        if (label) label.textContent = f.name;
        renderSandbox();
      })();
    });
  };
  readJson('own-ev', 'own-ev-name', (v, n) => { s.own = v; s.ownName = n; s.verdict = null; s.pkg = null; });
  readJson('own-pol', 'own-pol-name', (v, n) => { s.policy = v; s.polName = n; s.verdict = null; });

  const hash = $('sbx-hash');
  const doc = $<HTMLTextAreaElement>('sbx-doc');
  doc?.addEventListener('input', () => { s.docText = doc.value; });
  hash?.addEventListener('click', () => {
    void (async () => {
      s.docDigest = await digestText(s.docText);
      const out = $('sbx-dg');
      if (out) out.textContent = s.docDigest;
    })();
  });
}

export async function initSandbox(): Promise<void> {
  // Re-render on every call so the transcript stays current without the
  // features that make calls having to remember to refresh it.
  onApiCall(() => { if (s.cat) queueMicrotask(() => { if (!s.busy) refreshLog(); }); });
  try {
    s.cat = await api.catalogue();
  } catch {
    const host = $('sandbox');
    if (host) host.innerHTML = '<p class="dim">이 배포에서는 평가 샌드박스를 쓸 수 없습니다.</p>';
    return;
  }
  renderSandbox();
}

/** Repaint only the call count, so nothing else on screen is disturbed. */
function refreshLog(): void {
  const host = $('sandbox');
  const old = host?.querySelector('.step:last-of-type');
  if (!host || !old) return;
  const next = document.createElement('div');
  next.innerHTML = apiSummary();
  const fresh = next.firstElementChild;
  if (fresh) old.replaceWith(fresh);
  renderApiLog();
}
