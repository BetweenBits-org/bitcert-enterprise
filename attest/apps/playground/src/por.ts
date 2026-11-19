/**
 * PoR 사용자 검증 페이지 — 전부 브라우저 안에서.
 *
 * 다섯 가지를 서로 독립적으로 보여준다 (하나로 뭉치지 않는다):
 *   ① 거래소 서명 — 선언문이 그 거래소의 키로 서명되었는가
 *   ② 포함증명   — 내 리프가 루트·총액에 산술적으로 묶이는가
 *   ③ 계정 대조   — user_ref가 리프의 가명 해시와 일치하는가 (선택)
 *   ④ 커밋 재계산 — 선언문의 커밋이 공개값과 같은가
 *   ⑤ 앵커       — 그 커밋이 비트코인 번들로 검증되는가
 */
import {
  verifyPorInclusion, porUserRefHash, porSnapshotCommitment, verifyBundle,
  jcs, utf8, concat, verifyP256,
} from './vendor/attest-verify/index.ts';
import type { PorInclusionProof, ProofBundle } from './vendor/attest-verify/index.ts';

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;
const esc = (t: unknown): string => String(t ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]!);

interface ProofFile {
  schema?: string;
  exchange?: { institution_id?: string; name?: string };
  asof?: string;
  user_ref?: string;
  proof?: PorInclusionProof;
}
interface SolvencyLine {
  asset: string; liabilities: string; reserves_measured: string;
  coverage: string | null; status: string;
}
interface PublicSnapshot {
  snapshot_id?: string;
  statement?: {
    schema?: string;
    exchange?: { institution_id?: string; name?: string };
    asof?: string;
    assets?: { symbol: string; decimals: number }[];
    tree?: { root?: string; leaf_count?: number };
    totals?: Record<string, string>;
  };
  exchange_signature?: { alg?: string; sig?: string };
  exchange_key?: { spki?: string } | null;
  commitment?: string;
  attestation?: { id?: string; bundle?: ProofBundle | null } | null;
  reserves?: { solvency?: SolvencyLine[]; measurements?: { status: string }[]; note?: string };
  /** Whether the platform sampled the tree before anchoring. Absent on material published before the field existed. */
  spot_check?: boolean;
  verified_sampling?: { sampled?: number; of?: number };
}

const EVENT_DOMAIN = 'stonehash:remit:event:v1\n';

/**
 * The exchange's own file — the proof file it keeps beside its balance file.
 *
 * It is not what this page checks, and it carries the seed every account's
 * salt is derived from. Someone handed it by mistake should be told what it
 * is, not "something is missing", and the page should not go on showing it:
 * so it is recognised by name, cleared from the box, and never verified.
 */
const SNAPSHOT_PROOF_SCHEMA = 'stonehash.por-snapshot-proof.v1';
const EXCHANGE_FILE_BANNER = '<div class="banner">이 파일은 거래소가 보관하는 증명 파일입니다. 이 페이지에는 계정 한 개의 포함증명 파일을 넣어 주세요 — 거래소 보관용 파일에는 비밀값이 들어 있으니 외부에 전달하거나 공개하지 마십시오.</div>';
function isExchangeFile(text: string): boolean {
  try {
    return (JSON.parse(text) as { schema?: unknown } | null)?.schema === SNAPSHOT_PROOF_SCHEMA;
  } catch {
    return false;
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The exchange's signature, checked with the verifier package's own P-256
 * arithmetic rather than `crypto.subtle`.
 *
 * Browsers withhold `crypto.subtle` on a plain-http origin, which is how this
 * page is reached on a test deployment. There the check could not run at all,
 * the failure was indistinguishable from a bad signature, and a valid
 * snapshot was reported to its own customers as failing.
 */
function verifyExchangeSig(statement: unknown, sigB64u: string, spkiB64: string): boolean {
  try {
    return verifyP256(b64ToBytes(sigB64u), concat(utf8(EVENT_DOMAIN), jcs(statement as never)), b64ToBytes(spkiB64));
  } catch {
    return false;
  }
}

function fmtAmount(v: string, decimals: number): string {
  const s = v.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? `.${s.slice(s.length - decimals)}`.replace(/\.?0+$/, '') : '';
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac}`;
}

interface Check { name: string; state: 'ok' | 'fail' | 'skip'; detail: string }

async function run(): Promise<void> {
  const out = $('#out');
  out.innerHTML = '<p class="por-busy">검증 중…</p>';
  const checks: Check[] = [];
  const add = (name: string, state: Check['state'], detail: string): void => { checks.push({ name, state, detail }); };

  let proofFile: ProofFile;
  let snap: PublicSnapshot;
  try {
    proofFile = JSON.parse(($('#proofIn') as HTMLTextAreaElement).value || '{}');
    snap = JSON.parse(($('#snapIn') as HTMLTextAreaElement).value || '{}');
  } catch (e) {
    out.innerHTML = `<div class="banner">JSON을 읽을 수 없습니다: ${esc((e as Error).message)}</div>`;
    return;
  }
  if (proofFile?.schema === SNAPSHOT_PROOF_SCHEMA) {
    ($('#proofIn') as HTMLTextAreaElement).value = '';
    out.innerHTML = EXCHANGE_FILE_BANNER;
    return;
  }
  const statement = snap.statement;
  const proof = proofFile.proof;
  if (!statement?.tree?.root || !statement.totals || !proof) {
    out.innerHTML = '<div class="banner">① 포함증명과 ② 스냅샷 공개 자료를 모두 넣어 주세요.</div>';
    return;
  }

  // ① exchange signature over the statement
  if (snap.exchange_key?.spki && snap.exchange_signature?.sig) {
    const ok = verifyExchangeSig(statement, snap.exchange_signature.sig, snap.exchange_key.spki);
    add('거래소 서명 (선언문, ES256)', ok ? 'ok' : 'fail',
      ok ? `서명자 ${statement.exchange?.institution_id ?? '?'} — 등록된 공개키로 검증됨`
         : '서명이 선언문과 공개키에 대해 검증되지 않습니다');
  } else {
    add('거래소 서명 (선언문, ES256)', 'skip', '공개 자료에 서명/공개키가 없어 건너뜀');
  }

  // ② inclusion against root AND totals
  const incl = verifyPorInclusion(proof, {
    root: statement.tree.root, totals: statement.totals,
  });
  add('포함증명 — 루트·자산별 총액 동시 바인딩', incl.ok ? 'ok' : 'fail',
    incl.ok
      ? `leaf #${proof.leaf_index} → root ${incl.computedRoot.slice(0, 16)}… · 총액 일치 (${Object.keys(incl.computedTotals).join(', ')})`
      : incl.problems.join(' · '));

  // ③ optional user_ref ↔ pseudonymous hash
  const userRef = ($('#userRef') as HTMLInputElement).value.trim() || proofFile.user_ref || '';
  if (userRef && statement.exchange?.institution_id) {
    const expect = porUserRefHash(statement.exchange.institution_id, userRef);
    const ok = expect === proof.leaf.user_ref_hash;
    add('내 계정 대조 (user_ref → 가명 해시)', ok ? 'ok' : 'fail',
      ok ? `sha256(domain‖${statement.exchange.institution_id}‖user_ref) 일치` : '이 증명은 입력한 계정의 것이 아닙니다');
  } else {
    add('내 계정 대조 (user_ref → 가명 해시)', 'skip', 'user_ref 미입력 — 증명 소유 확인은 생략됨');
  }

  // ④ statement commitment
  const commit = porSnapshotCommitment(statement);
  if (snap.commitment) {
    add('선언문 커밋 재계산', commit === snap.commitment ? 'ok' : 'fail',
      `SHA256(domain‖JCS) = ${commit.slice(0, 20)}…`);
  } else {
    add('선언문 커밋 재계산', 'skip', `커밋 ${commit.slice(0, 20)}… (공개값 미제공으로 대조 생략)`);
  }

  // ⑤ the Bitcoin anchor
  const bundle = snap.attestation?.bundle ?? null;
  if (bundle) {
    const leafOk = (bundle as { record?: { leaf_bytes?: string } }).record?.leaf_bytes === commit;
    let report: { verified?: boolean; checks?: { id: string; state: string }[] } = {};
    try {
      report = await verifyBundle(bundle, {});
    } catch { /* report stays unverified */ }
    const ok = leafOk && report.verified === true;
    add('비트코인 앵커 (번들 독립 검증)', ok ? 'ok' : 'fail',
      `anchored-leaf==커밋: ${leafOk} · ${(report.checks ?? []).map((c) => `${c.id}:${c.state}`).join(' ')}`);
  } else {
    add('비트코인 앵커 (번들 독립 검증)', 'skip', '번들 미포함 — 앵커 확정 전이거나 공개 자료가 축약본');
  }

  // Balance display
  const decimals = new Map((statement.assets ?? []).map((a) => [a.symbol, a.decimals]));
  const balances = Object.entries(proof.leaf.balances)
    .filter(([, v]) => v !== '0')
    .map(([k, v]) => `<b>${fmtAmount(v, decimals.get(k) ?? 0)}</b> ${esc(k)}`)
    .join(' · ');

  // Solvency — the reserve side, measured by the platform on chain. Shown,
  // not merged into the proof verdict: liabilities inclusion and reserve
  // coverage are different claims with different verifiers.
  let solvencyHtml = '';
  const sol = snap.reserves?.solvency ?? [];
  if (sol.length > 0) {
    solvencyHtml = `<div class="balbox"><b>준비금 커버리지</b> <span class="vdetail">(플랫폼이 체인에서 실측; 주소 소유는 거래소 선언)</span><br>${
      sol.map((l) => {
        const dec = decimals.get(l.asset) ?? 0;
        const cov = l.status === 'MEASURED' && l.coverage
          ? `<b>${esc(l.coverage)}</b> (준비금 ${fmtAmount(l.reserves_measured, dec)} / 부채 ${fmtAmount(l.liabilities, dec)})`
          : '<span class="vdetail">미실측 — 선언만 (이 체인에 RPC 없음)</span>';
        return `${esc(l.asset)}: ${cov}`;
      }).join('<br>')}</div>`;
  }

  /*
   * What the platform itself looked at before anchoring — stated, not folded
   * into the verdict. The five checks above are the reader's own and do not
   * depend on it; but a page that said "sampled" under a snapshot nobody
   * sampled would be lending the platform's name to a check that never ran.
   * Older material has no `spot_check` field and was always sampled.
   */
  const sampled = snap.spot_check !== false;
  const platformHtml = sampled
    ? `<div class="balbox"><b>플랫폼이 확인한 것</b><br>거래소 서명 · 선언문 형식 · 표본 확인 (${
      esc(snap.verified_sampling?.sampled ?? '?')} / ${esc(snap.verified_sampling?.of ?? '?')}개 계정)</div>`
    : `<div class="balbox"><b>플랫폼이 확인한 것</b><br>거래소 서명 · 선언문 형식 — 표본 확인은 하지 않았습니다 <span class="vdetail">(거래소가 요청하지 않음)</span></div>`;
  const noteHtml = sampled
    ? '표본 확인은 무작위로 고른 일부 계정으로 트리의 구조를 본 것입니다. 모든 계정이 실제 고객임을 증명하지는 않습니다 — 이 페이지는 그 경계를 숨기지 않습니다.'
    : '이 스냅샷은 거래소의 서명만으로 앵커링되었습니다. 플랫폼은 트리의 내용을 확인하지 않았고, 트리는 지금 이 화면과 같은 사용자 각자의 포함 확인으로 검증됩니다 — 이 페이지는 그 경계를 숨기지 않습니다.';

  const allHard = checks.filter((c) => c.state !== 'skip');
  const pass = allHard.length > 0 && allHard.every((c) => c.state === 'ok');
  out.innerHTML = `
    <div class="balbox">
      이 증명이 말하는 내 잔고 (as of ${esc(statement.asof ?? '?')}):<br>${balances || '0'}
      <span class="statuschip ${pass ? 'pass' : 'fail'}">${pass ? '검증 통과' : '검증 실패'}</span>
    </div>
    ${solvencyHtml}
    ${platformHtml}
    ${checks.map((c) => `
      <div class="vrow">
        <span class="vicon">${c.state === 'ok' ? '✅' : c.state === 'fail' ? '❌' : '◻️'}</span>
        <span><span class="vname">${esc(c.name)}</span><br><span class="vdetail">${esc(c.detail)}</span></span>
      </div>`).join('')}
    <p class="por-note">${noteHtml}</p>`;
}

$('#verifyBtn').addEventListener('click', () => { void run(); });
($('#proofFile') as HTMLInputElement).addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  const text = await f.text();
  if (isExchangeFile(text)) {
    // Not put into the box at all: the box is on screen, and this file is not for showing.
    ($('#proofIn') as HTMLTextAreaElement).value = '';
    input.value = '';
    $('#out').innerHTML = EXCHANGE_FILE_BANNER;
    return;
  }
  ($('#proofIn') as HTMLTextAreaElement).value = text;
});
$('#fetchSnap').addEventListener('click', async () => {
  const id = ($('#snapId') as HTMLInputElement).value.trim();
  if (!id) return;
  try {
    const res = await fetch(`/v1/public/por/snapshots/${encodeURIComponent(id)}`);
    ($('#snapIn') as HTMLTextAreaElement).value = JSON.stringify(await res.json(), null, 2);
  } catch (e) {
    ($('#snapIn') as HTMLTextAreaElement).value = `가져오기 실패: ${(e as Error).message}`;
  }
});
