/**
 * The free tier: anchor your own file without an account.
 *
 * ## What leaves the browser
 *
 * The file is read locally, hashed with the same `sha256` the verifier uses, and
 * only the 32-byte digest is posted. Nothing else — no name, no size, no
 * content. That is checkable in the network tab, and it is the reason the claim
 * "we cannot disclose what we were never sent" is true rather than a promise.
 *
 * ## Why it polls
 *
 * A free anchor joins the ordinary shared batch rather than triggering its own
 * transaction. That is the economic design — many digests, one transaction — and
 * it is also what stops a single visitor from making the service spend a fee on
 * demand. So the UI waits, and says what it is waiting for at each stage rather
 * than showing one spinner.
 */
import { bytesToHex, sha256, verifyBundle } from './vendor/attest-verify/index.ts';
import type { ProofBundle } from './vendor/attest-verify/index.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};
const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Where the API lives.
 *
 * Same origin on a single-host deployment; `api.` beside `playground.` in
 * production. Read from a meta tag so the built files are not pinned to one
 * hostname — the same `dist/` has to serve both.
 */
function apiBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="attest-api"]');
  return (tag?.content ?? '').replace(/\/$/, '');
}

interface AnchorState {
  bytes: Uint8Array | null;
  name: string;
  digest: string;
  id: string | null;
  /** Stops the poll loop when the user resets or navigates away. */
  polling: boolean;
}
const st: AnchorState = { bytes: null, name: '', digest: '', id: null, polling: false };

interface AnchorView {
  id: string;
  sha256: string;
  status: string;
  bundle_available: boolean;
  bundle_url: string | null;
  retrievable_until: string | null;
  bitcoin_network: string;
  public_verifiability: string;
  note?: string;
}

/** The four stages, so the wait is legible rather than a spinner. */
const STAGES = [
  { key: 'accepted', label: 'Accepted', detail: '다이제스트가 접수되었습니다' },
  { key: 'batched', label: 'Batched', detail: '공유 배치에 포함되어 Merkle 루트가 계산되었습니다' },
  { key: 'submitted', label: 'Submitted', detail: '앵커 트랜잭션이 브로드캐스트되었습니다' },
  { key: 'confirmed', label: 'Confirmed', detail: '블록에 포함되었습니다' },
];

function stagesHtml(status: string): string {
  const at = STAGES.findIndex((s) => s.key === status);
  return `<div class="stages">${STAGES.map((s, i) => {
    const state = i < at ? 'pass' : i === at ? 'pass' : 'skip';
    return `<div class="stage-row">
      <span class="state ${state}">${i <= at ? s.label.toUpperCase() : 'PENDING'}</span>
      <span class="stage-d">${esc(s.detail)}</span>
    </div>`;
  }).join('')}</div>`;
}

/**
 * The network banner, shown only when it changes what a reader can do.
 *
 * On mainnet it says so, because that is the case where the proof they are
 * about to make is publicly checkable. On anything else the banner is left
 * empty: naming the test chain put a line of jargon above the one control on
 * the page, and it is not something the reader can act on. The bundle still
 * carries its own `bitcoin_network`, so no proof can misrepresent itself and
 * every conforming verifier reports it.
 */
function renderNetwork(view: AnchorView): void {
  const b = $('anchor-net');
  if (view.bitcoin_network !== 'mainnet') { b.hidden = true; b.innerHTML = ''; return; }
  b.hidden = false;
  b.className = 'banner banner-ok';
  b.innerHTML = `<b>공개 비트코인(mainnet)에 앵커링됩니다.</b> ${esc(view.public_verifiability)}`;
}

async function poll(id: string): Promise<void> {
  st.polling = true;
  // Backs off from 1s to 5s: the first transition is quick on regtest, and a
  // tight loop on a shared endpoint would be rude.
  let delay = 1000;
  while (st.polling) {
    const res = await fetch(`${apiBase()}/v1/public/anchors/${id}`);
    if (!res.ok) throw new Error(`status check failed: HTTP ${res.status}`);
    const view = (await res.json()) as AnchorView;
    render(view);
    if (view.status === 'confirmed' && view.bundle_available) return;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1000, 5000);
  }
}

function render(view: AnchorView, extra = ''): void {
  renderNetwork(view);
  $('anchor-result').innerHTML = `
    <div class="verdict ${view.status === 'confirmed' ? 'ok' : ''}">
      <div class="top">
        <span class="hl">${view.status === 'confirmed' ? '앵커링 완료' : '진행 중'}</span>
        <span class="sub">${view.note ? esc(view.note) : '상태는 단계별로 표시되며 하나의 플래그로 합쳐지지 않습니다'}</span>
      </div>
    </div>
    ${stagesHtml(view.status)}
    <div class="att-kv-lite">
      <div><span>anchor id</span><code>${esc(view.id)}</code></div>
      <div><span>your digest</span><code>${esc(view.sha256)}</code></div>
      <div><span>network</span><code>${esc(view.bitcoin_network)}</code></div>
      ${view.retrievable_until
        ? `<div><span>retrievable here until</span><code>${esc(view.retrievable_until)}</code></div>` : ''}
    </div>
    <div class="note">
      <p>이 기록은 위 시점까지만 여기서 조회됩니다. <b>내려받은 증명 번들은 우리를 참조하지 않으므로
      기한 없이 계속 검증됩니다</b> — 그래서 보존 기간을 두는 것이 안전합니다.</p>
    </div>
    ${view.bundle_available
      ? `<div class="row">
           <button class="btn" id="btn-anchor-bundle">증명 번들 내려받기</button>
         </div>`
      : ''}
    ${extra}`;

  if (view.bundle_available) {
    $('btn-anchor-bundle').addEventListener('click', () => { void download(view.id); });
  }
}

async function fetchBundle(id: string): Promise<ProofBundle> {
  const res = await fetch(`${apiBase()}/v1/public/anchors/${id}/bundle`);
  if (!res.ok) throw new Error(`bundle fetch failed: HTTP ${res.status}`);
  return (await res.json()) as ProofBundle;
}

async function download(id: string): Promise<void> {
  const bundle = await fetchBundle(id);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `proof-${id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}


async function submit(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-anchor');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '전송 중…';
  try {
    // The digest, and nothing else.
    const res = await fetch(`${apiBase()}/v1/public/anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: st.digest }),
    });
    const view = (await res.json()) as AnchorView & { error?: string; message?: string };
    if (!res.ok) {
      $('anchor-result').innerHTML = `<div class="note warn"><p><b>${esc(view.error ?? 'failed')}.</b>
        ${esc(view.message ?? `HTTP ${res.status}`)}</p></div>`;
      return;
    }
    st.id = view.id;
    render(view);
    await poll(view.id);
  } catch (e) {
    $('anchor-result').innerHTML = `<div class="note warn"><p><b>앵커링 실패.</b>
      ${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function setFile(f: File): void {
  void f.arrayBuffer().then((buf) => {
    st.bytes = new Uint8Array(buf);
    st.name = f.name;
    st.digest = bytesToHex(sha256(st.bytes));
    $('drop-anchor').classList.add('set');
    $('name-anchor').textContent = `${f.name} · ${st.bytes.length.toLocaleString('ko-KR')} bytes`;
    $('anchor-hashline').hidden = false;
    $('anchor-hash').textContent = st.digest;
    ($('btn-anchor') as HTMLButtonElement).disabled = false;
  });
}

export function initAnchor(): void {
  if ($('drop-anchor').dataset['wired'] === '1') return;
  $('drop-anchor').dataset['wired'] = '1';

  const drop = $('drop-anchor');
  const input = $<HTMLInputElement>('file-anchor');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const f = input.files?.[0]; if (f) setFile(f); });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) setFile(f);
  });

  $('btn-anchor').addEventListener('click', () => { void submit(); });
  $('btn-anchor-reset').addEventListener('click', () => {
    st.polling = false;
    st.bytes = null; st.name = ''; st.digest = ''; st.id = null;
    drop.classList.remove('set');
    $('name-anchor').textContent = '파일을 끌어다 놓거나 클릭 — 업로드되지 않습니다';
    $('anchor-hashline').hidden = true;
    ($('btn-anchor') as HTMLButtonElement).disabled = true;
    $('anchor-result').innerHTML = '';
  });

  // Report what this deployment can prove before anything is submitted.
  void fetch(`${apiBase()}/v1/meta`).then(async (r) => {
    const meta = (await r.json()) as { bitcoin_network: string; public_verifiability: string; free_tier: unknown };
    renderNetwork({ bitcoin_network: meta.bitcoin_network, public_verifiability: meta.public_verifiability } as AnchorView);
    if (meta.free_tier === null) {
      $('anchor-net').innerHTML += ' <b>이 배포에서는 무가입 앵커링이 비활성입니다.</b>';
      ($('btn-anchor') as HTMLButtonElement).disabled = true;
    }
  }).catch(() => {
    $('anchor-net').innerHTML = '<b>서비스 상태를 확인할 수 없습니다.</b> '
      + 'Verify 탭은 네트워크 없이도 동작합니다.';
  });
}
