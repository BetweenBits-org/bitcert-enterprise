/**
 * Playground — the client. Everything here runs in the visitor's browser.
 *
 * It imports `@stonehash/attest-verify` and calls it directly, so the
 * verification a visitor watches is the same code a regulator would run from
 * npm. There is no API behind this page: no document is uploaded, no digest is
 * sent anywhere, and no StoneHash endpoint is contacted. That is checkable —
 * the network tab stays empty after load, and the page keeps working offline.
 *
 * Two product rules are enforced in the rendering rather than left to copy:
 *
 * 1. **Each link is reported separately.** A tampered document fails link A
 *    while links B and C1 remain perfectly valid, and the UI must say exactly
 *    that. Collapsing four claims into one tick is how a verification tool
 *    starts misleading people.
 * 2. **Nothing unchecked is ever green.** The verifier always abstains on C2,
 *    so a verdict there has to be merged in by whoever consulted a chain. On
 *    mainnet this page consults nothing and C2 stays grey. On a private chain
 *    the only possible source is its operator, so C2 turns green *attributed
 *    to the operator* — green for what the chain did, never green for
 *    independence it does not have. See `withChainInclusion`.
 */
import { verifyBundle, sha256, bytesToHex, decodeAnchorPayload, txidFromRaw, leafHash, nodeHash }
  from './vendor/attest-verify/index.ts';
import type { CheckState, ProofBundle, VerifyReport } from './vendor/attest-verify/index.ts';
import { initAnchor } from './anchor.ts';
import { withChainInclusion } from './chain.ts';

// ─── small DOM helpers ──────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Shorten a digest for display while keeping both ends recognisable. */
const short = (hex: string, keep = 10): string =>
  hex.length <= keep * 2 + 1 ? hex : `${hex.slice(0, keep)}…${hex.slice(-keep)}`;

// ─── state ──────────────────────────────────────────────────────────────────
interface State {
  bundle: ProofBundle | null;
  bundleName: string;
  original: Uint8Array | null;
  originalName: string;
  /** The Explore tab's pristine document, so it can be restored after editing. */
}
const state: State = {
  bundle: null, bundleName: '', original: null, originalName: '',
};

// ─── link descriptions ──────────────────────────────────────────────────────
const LINKS: { id: 'A' | 'B' | 'C1' | 'C2'; label: string; what: string }[] = [
  { id: 'A', label: 'Link A', what: '원본 → leaf_bytes' },
  { id: 'B', label: 'Link B', what: 'leaf_bytes → Merkle root' },
  { id: 'C1', label: 'Link C1', what: '앵커 바이트 ↔ txid (오프라인)' },
  { id: 'C2', label: 'Link C2', what: 'txid 가 공개 블록에 포함' },
];

const STATE_KO: Record<CheckState, string> = {
  pass: 'PASS', fail: 'FAIL', skip: 'NOT CHECKED', warn: 'INCONCLUSIVE',
};

// ─── rendering ──────────────────────────────────────────────────────────────
function linksHtml(r: VerifyReport): string {
  return `<div class="links">${LINKS.map((l) => {
    const st = r.links[l.id];
    const what = l.id === 'C2' && r.network !== 'mainnet'
      ? 'txid 가 운영 체인 블록에 포함'
      : l.what;
    return `<div class="link">
      <div class="lid">${l.label}</div>
      <div class="lt">${esc(what)}</div>
      <span class="state ${st}">${STATE_KO[st]}</span>
    </div>`;
  }).join('')}</div>`;
}

function detailHtml(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  const rows = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<b>${esc(k)}</b> ${esc(/^[0-9a-f]{64,}$/.test(s) ? s : s.slice(0, 220))}`;
    });
  return rows.length ? `<div class="cd">${rows.join('<br>')}</div>` : '';
}

function checksHtml(r: VerifyReport): string {
  return `<div class="checks">${r.checks.map((c) => `
    <div class="check">
      <div><span class="state ${c.state}">${STATE_KO[c.state]}</span></div>
      <div class="cl">${esc(c.label)}${c.gating ? '' : '<span class="nong">non-gating</span>'}</div>
      ${detailHtml(c.detail)}
    </div>`).join('')}</div>`;
}

/**
 * The network caveat. On a private chain this is the single most important
 * sentence on the page, so it is rendered from the bundle's own
 * `bitcoin_network` rather than from anything the page was told separately.
 */
function networkNote(r: VerifyReport): string {
  if (r.network === 'mainnet') {
    return `<div class="note"><p><b>공개 체인(mainnet)</b> 앵커입니다.
      Link C2는 이 페이지가 아니라 <b>여러분이 선택한</b> 비트코인 소스에서 확인하십시오 —
      본인 노드든 공개 탐색기든, StoneHash가 아니면 됩니다.</p></div>`;
  }
  const c = r.checks.find((x) => x.id === 'onchain');
  const at = (c?.state === 'pass' ? c.detail?.['block_height'] : null) ?? null;
  return `<div class="note warn"><p><b>${esc(r.network ?? '알 수 없음')}는 StoneHash가 직접 운영하는 체인입니다.</b>
    Link A·B·C1은 순수 수학이므로 여기서 완전히 검증됩니다.
    ${at === null
      ? 'Link C2는 포함 정보가 번들에 없어 미확인입니다.'
      : `Link C2도 <b>${esc(at)}번 블록에 실제로 포함</b>되어 통과했습니다 —
         다만 그것을 보증하는 쪽은 제3자가 아니라 <b>블록을 생성한 StoneHash 자신</b>입니다.`}</p>
    <p>즉 이 증거는 파이프라인 전 구간을 충실히 재현하지만
    <b>공개적으로 검증 가능한 증명은 아닙니다.</b> mainnet에서는 C2가 미확인으로 남고,
    여러분이 고른 비트코인 소스에서 직접 확인하게 됩니다. 이 구분은 와이어 포맷이 강제합니다 —
    <code>bitcoin_network</code>는 번들의 필수 필드이고, 규격을 따르는 모든 검증기가 읽어서 보고합니다.</p></div>`;
}

function reportHtml(r: VerifyReport, context: string): string {
  const gatingFails = r.checks.filter((c) => c.gating && c.state === 'fail');
  const headline = r.verified
    ? '암호학적으로 검증되었습니다'
    : gatingFails.length === 1
      ? `검증 실패 — ${esc(gatingFails[0]!.label)}`
      : '검증 실패';
  const sub = r.verified
    ? `${esc(context)} · ${r.links.C2 === 'pass'
      ? 'Link C2는 체인 운영자가 보고한 블록 포함으로 통과 — 제3자 확인은 아닙니다'
      : 'Link C2는 미확인 상태이며, 그것이 정직한 상태입니다'}`
    : `${gatingFails.length}개 검사가 실패했습니다 · 어느 주장이 무너졌는지 아래에서 구분해 보십시오`;

  return `
    <div class="verdict ${r.verified ? 'ok' : 'no'}">
      <div class="top">
        <span class="hl">${r.verified ? '✓' : '✗'} ${headline}</span>
        <span class="sub">${sub}</span>
      </div>
      ${linksHtml(r)}
    </div>
    ${networkNote(r)}
    ${checksHtml(r)}`;
}

// ─── verify tab ─────────────────────────────────────────────────────────────
function runVerify(): void {
  if (!state.bundle) return;
  const r = withChainInclusion(
    verifyBundle(state.bundle, state.original ? { originalBytes: state.original } : {}),
    state.bundle,
  );
  // What "no original" means depends on the bundle. An inscription carries its
  // document in the transaction and a balance row carries its fields in the
  // bundle, so link A is checked without a file; for a document's hash or a
  // signed statement nobody has looked at a document, and the line says so.
  const ctx = state.original
    ? `원본 ${esc(state.originalName)} 과 대조`
    : r.links.A === 'skip'
      ? '원본 미제공 — Link A는 확인하지 않았습니다'
      : r.witnessMode
        ? '원본 미제공 — Link A는 트랜잭션에 실린 문서로 확인했습니다'
        : '원본 미제공 — Link A는 번들에 실린 내용으로 확인했습니다';
  const box = $('result');
  box.hidden = false;
  box.innerHTML = reportHtml(r, ctx);
}

function setBundle(text: string, name: string): void {
  try {
    state.bundle = JSON.parse(text) as ProofBundle;
  } catch {
    const box = $('result');
    box.hidden = false;
    box.innerHTML = `<div class="note warn"><p><b>JSON 파싱 실패.</b>
      증명 번들은 단일 JSON 파일입니다.</p></div>`;
    return;
  }
  state.bundleName = name;
  const d = $('drop-bundle');
  d.classList.add('set');
  $('name-bundle').textContent = name;
  ($('btn-verify') as HTMLButtonElement).disabled = false;
  runVerify();
}

function setOriginal(bytes: Uint8Array, name: string): void {
  state.original = bytes;
  state.originalName = name;
  $('drop-original').classList.add('set');
  $('name-original').textContent = `${name} · ${bytes.length.toLocaleString('ko-KR')} bytes`;
  if (state.bundle) runVerify();
}

function wireDrop(dropId: string, inputId: string, onFile: (f: File) => void): void {
  const drop = $(dropId);
  const input = $<HTMLInputElement>(inputId);
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
}


function reset(): void {
  state.bundle = null; state.original = null;
  state.bundleName = ''; state.originalName = '';
  for (const id of ['drop-bundle', 'drop-original']) $(id).classList.remove('set');
  $('name-bundle').textContent = 'bundle.json 을 끌어다 놓거나 클릭';
  $('name-original').textContent = '링크 A 검증에 필요합니다';
  ($('btn-verify') as HTMLButtonElement).disabled = true;
  $('result').hidden = true;
  $('result').innerHTML = '';
}

// ─── boot ───────────────────────────────────────────────────────────────────
function boot(): void {
  wireDrop('drop-bundle', 'file-bundle', (f) => {
    void f.text().then((t) => setBundle(t, f.name));
  });
  wireDrop('drop-original', 'file-original', (f) => {
    void f.arrayBuffer().then((buf) => setOriginal(new Uint8Array(buf), f.name));
  });

  $('btn-verify').addEventListener('click', runVerify);
  $('btn-reset').addEventListener('click', reset);

  $('buildinfo').textContent = '@stonehash/attest-verify · 의존성 0';

  // Both steps are on the page now, so there is nothing to switch — the
  // anchor panel just needs starting. `#verify` still works as a deep link
  // for someone arriving with a bundle they were handed.
  initAnchor();
  if (location.hash === '#verify') $('panel-verify').scrollIntoView();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
