/**
 * 준비금 증명 — a balance file, anchored from this page.
 *
 * The visitor chooses a balance file and presses one button. The page reads
 * the file, builds the Merkle sum tree over it, signs a statement of the
 * root and the totals, and hands that statement to the platform, which
 * anchors it. Nothing else is asked for.
 *
 * What makes that honest is where each step runs. The balance file is read by
 * this page and is never sent — there is no upload in this module, only the
 * JSON of the signed statement. The tree is built here, by the exchange
 * SDK's own code (vendored, not rewritten: the same CSV rules, the same
 * amount conversion, the same hashes).
 *
 * ## What the page decides, because nobody is asked
 *
 * On a server the SDK makes the exchange declare its assets, their decimal
 * places, how amounts are written and the moment the balances stand for;
 * those are the exchange's decisions and the SDK will not guess them. A
 * screen that takes a file and nothing else has to read them off the file:
 *
 *   - the assets are the ones the file names, in the order it names them;
 *   - an amount is taken exactly as it is written, so every total is the sum
 *     of that column and nothing has been scaled;
 *   - an asset gets as many decimal places as its values use, and never
 *     fewer than eight;
 *   - the snapshot stands for the moment it is submitted.
 *
 * None of that is hidden. What was settled on is shown with the result and
 * is in the statement itself.
 *
 * ## The key
 *
 * A statement has to be signed. The exchange's signing key lives on the
 * exchange's server, with the SDK, and this page neither asks for it nor
 * replaces it. It makes a key for the session, registers the public half as
 * the institution's console key — a second key the platform accepts beside
 * the first — and signs with that. The private half is never shown, stored
 * or sent; it is gone when the page is.
 *
 * ## What is kept, and by whom
 *
 * The page keeps two things, in memory only: the result on the screen, and
 * the proof file of every snapshot anchored here until it has been
 * downloaded — it is the one copy, and it holds the seed. Both go when the
 * document is left or the account in the tab changes; the tree itself is
 * gone as soon as the statement has been signed. What the visitor keeps is two files — the balance file they
 * already have, and one proof file this screen hands them once the platform
 * has accepted the statement. The proof file carries the statement, its
 * signature, the seed the salts come from and how the balance file was read;
 * it has no account and no balance in it.
 *
 * Those two files are the snapshot again: on the exchange's server the SDK's
 * `openSnapshot` rebuilds the tree from them and issues every account's
 * proof, and the console's 검증 screen (`verify.ts`) puts the same two
 * together to say whether they still make the anchored root.
 *
 * ## One errand
 *
 * This screen anchors and does nothing else. It once carried two more cards
 * — a check of the two files with an account's proof behind it, and a list
 * of past snapshots. Checking a file is what 검증 is for, whichever product
 * the file came from, and a snapshot once anchored is a record like any
 * other: 앵커링 기록 lists it, with its id.
 */
import { api, ApiError } from './api.ts';
import { t } from './i18n.ts';
import { sha256, bytesToHex, utf8 } from './vendor/attest-verify/index.ts';
import type { PorInclusionProof } from './vendor/attest-verify/index.ts';
import { fromBaseUnits } from './vendor/attest-por/amounts.ts';
import { CsvError, CsvParser } from './vendor/attest-por/csv.ts';
import type { CsvRecord } from './vendor/attest-por/csv.ts';
import { parseAssetSpecs } from './vendor/attest-por/ledger.ts';
import type { LedgerReport } from './vendor/attest-por/ledger.ts';
import { buildPorTree, provePorLeaf } from './vendor/attest-por/sumtree.ts';
import type { PorTree } from './vendor/attest-por/sumtree.ts';
import { buildSnapshotStatement } from './vendor/attest-por/snapshot.ts';
import type { PorAssetSpec } from './vendor/attest-por/snapshot.ts';
import { leafFromRowPortable, publicSpkiFromScalar, signSnapshotStatementPortable } from './vendor/attest-por/portable.ts';
import { buildSnapshotProof, snapshotProofText } from './vendor/attest-por/snapshot-proof.ts';
import type { PorSnapshotProof } from './vendor/attest-por/snapshot-proof.ts';
import { SAMPLE_WIDE, SAMPLE_WIDE_NAME } from './vendor/attest-por-samples.ts';
import { MAX_ACCOUNTS, MAX_TREE_SUMS, looksLikeJson, readLedger, treeSums } from './por-ledger.ts';
import { shapeName } from './por-words.ts';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const grouped = (n: number): string => n.toLocaleString();
/** The anchor's state, coloured as everywhere else in the console: only `confirmed` reads as success. */
const anchorChip = (status: string): string =>
  `<span class="chip ${status === 'confirmed' ? 'ok' : status === 'submitted' ? 'wait' : 'inert'}">${esc(status)}</span>`;
/** ASCII only, as the SDK folds a header: other letters are left alone. */
const lower = (text: string): string => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The usual precision of an exchange ledger; an asset is never given fewer places than this. */
const MIN_DECIMALS = 8;
const MAX_DECIMALS = 36;

/**
 * What each refusal means and what to do about it, for a Korean reader.
 *
 * The SDK's own message is English and names the value that was refused; it
 * is shown beneath, as the SDK prints it, because that is the line the same
 * file will produce on the exchange's server. English readers get that line
 * alone — a paraphrase above it would only say it twice.
 */
const PROBLEM_KO: Record<string, string> = {
  csv_syntax: t('따옴표 짝이 맞지 않는 줄입니다 — CSV로 다시 내보내십시오', ''),
  file_encoding: t('UTF-8 파일이 아닙니다 — UTF-8로 다시 내보내십시오', ''),
  empty_file: t('파일이 비어 있습니다', ''),
  no_accounts: t('헤더만 있고 계정이 한 줄도 없습니다', ''),
  field_count: t('이 줄의 열 개수가 헤더와 다릅니다', ''),
  header: t('첫 줄(헤더)의 형식이 맞지 않습니다 — 예시 파일을 내려받아 확인하십시오', ''),
  account_empty: t('계정 식별자가 비어 있습니다', ''),
  account_whitespace: t('계정 식별자 앞뒤에 공백이 있습니다', ''),
  account_too_long: t('계정 식별자가 256바이트를 넘습니다', ''),
  account_control_character: t('계정 식별자에 줄바꿈 같은 제어 문자가 있습니다', ''),
  duplicate_row: t('같은 계정·자산이 두 번 나옵니다 — 한 줄로 합쳐 주십시오', ''),
  duplicate_account: t('같은 계정이 두 번 나옵니다 — 한 줄로 합쳐 주십시오', ''),
  unknown_asset: t('자산 이름이 다른 줄과 대소문자가 다릅니다 — 표기를 하나로 맞추십시오', ''),
  amount_empty: t('금액이 비어 있습니다 — 잔고가 없으면 0으로 적으십시오', ''),
  amount_negative: t('음수 잔고는 받지 않습니다', ''),
  amount_exponent: t('지수 표기(1e3)는 받지 않습니다 — 숫자 그대로 적으십시오', ''),
  amount_grouping: t('천 단위 구분 기호는 받지 않습니다 — 1,000 이 아니라 1000', ''),
  amount_format: t('숫자가 아닌 값입니다', ''),
  amount_precision: t('소수 자릿수가 너무 많습니다(최대 36자리)', ''),
  amount_too_long: t('금액이 너무 깁니다', ''),
  amount_not_text: t('금액이 숫자로 적혀 있습니다 — "0.5"처럼 따옴표로 감싼 문자열로 적으십시오', ''),
  debt_not_supported: t('부채(d_ 열)가 0이 아닌 계정은 받지 않습니다 — 스냅샷은 부채를 차감하지 않은 잔고만 담습니다', ''),
  json_syntax: t('JSON 문법이 맞지 않습니다', ''),
  json_shape: t('계정 배열 형태가 아닙니다 — [{"id": "…", "assets": {"BTC": "0.5"}}] 형태여야 합니다', ''),
  json_duplicate_key: t('한 계정 안에 같은 이름이 두 번 적혀 있습니다 — JSON은 뒤의 값만 남기므로 앞의 값이 빠집니다', ''),
};
const problemKo = (code: string): string => PROBLEM_KO[code.startsWith('header_') ? 'header' : code] ?? '';

interface Exchange { id: string; name: string }

/** A snapshot this page built and the platform took. */
interface Anchored {
  fileName: string;
  assets: PorAssetSpec[];
  report: LedgerReport;
  /** How the file was read: one of the CSV layouts, or `json`. */
  shape: string;
  /** The one file the visitor keeps beside the balance file. */
  proof: PorSnapshotProof;
  status: string;
  spotCheck: boolean;
  sampled: number;
  anchor: string;
}

/** Everything this screen knows. In memory only; a reload starts it empty. */
const s: {
  network: string;
  active: boolean | null;
  exchange: Exchange | null;
  file: File | null;
  fileText: string | null;
  fileLabel: string;
  spotCheck: boolean;
  busy: string;
  /** `items` are markup, escaped where they were built. */
  failure: { title: string; items: string[] } | null;
  anchored: Anchored | null;
  /**
   * The proof file of every snapshot anchored here that has not been
   * downloaded yet. The result box goes when another file is chosen or
   * another snapshot is anchored; the one copy of a proof file must not go
   * with it — a snapshot without its proof file can never issue a proof.
   */
  kept: PorSnapshotProof[];
  /** This session's signing key. Made on first use; never shown, stored or sent. */
  key: { d: Uint8Array; spki: string } | null;
  /** Bumped by every submission, so a superseded poll stops itself. */
  run: number;
  /**
   * Bumped when the account in this tab changes. An anchoring waits on the
   * network several times; one that was begun under the last account must
   * not finish under this one — its result and its proof file, seed
   * included, would be put on a stranger's screen.
   */
  account: number;
} = {
  network: '', active: null, exchange: null,
  file: null, fileText: null, fileLabel: '', spotCheck: false,
  busy: '', failure: null, anchored: null, kept: [], key: null,
  run: 0,
  account: 0,
};

/**
 * Leaving the document — a reload, the language switch, closing the tab —
 * with a proof file not yet downloaded loses it for good, so the browser is
 * asked to confirm. Registered once; it does nothing while nothing is kept.
 */
window.addEventListener('beforeunload', (e) => {
  if (s.kept.length === 0) return;
  e.preventDefault();
  // Chrome asks only when this is set.
  e.returnValue = '';
});

/**
 * How many proof files are still to be downloaded. Signing out forgets them
 * with everything else, so whoever signs out is asked first.
 */
export const porUntaken = (): number => s.kept.length;

/**
 * Forget everything, when the account in this tab changes.
 *
 * What the screen holds is one organisation's: a balance file, a result, a
 * proof file with the seed in it, a signing key registered for that
 * organisation's institution. The next account to sign in must find none of it.
 */
export function resetPor(): void {
  // A submission or a start-up read still in flight belongs to nobody now.
  s.run++;
  s.account++;
  s.active = null;
  s.exchange = null;
  s.file = null;
  s.fileText = null;
  s.fileLabel = '';
  s.spotCheck = false;
  s.busy = '';
  s.failure = null;
  s.anchored = null;
  s.kept = [];
  s.key = null;
}

/** Hub links carry their target in data attributes; the app that owns the configuration resolves them. */
let resolveLinks: (root: ParentNode) => void = () => {};

/** The section's shell. Its contents are painted once the product state is known. */
export function sectionPor(network: string): string {
  s.network = network;
  return `<div id="por-root" class="porpage"><section class="card"><p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p></section></div>`;
}

/** Called after the shell is in the document. */
export async function initPor(links: (root: ParentNode) => void): Promise<void> {
  resolveLinks = links;
  const account = s.account;
  try {
    const prod = await api.products();
    // An answer about the last account's subscriptions is not this one's.
    if (account !== s.account) return;
    s.active = prod.products.some((p) => p.product === 'por' && p.status === 'active');
    const ex = prod.institutions.find((i) => i.role === 'EXCHANGE');
    s.exchange = ex ? { id: ex.id, name: ex.name } : null;
  } catch (e) {
    if (account !== s.account) return;
    s.active = null;
    paint(e instanceof Error ? e.message : String(e));
    return;
  }
  paint();
  // The result invites leaving — it links to 검증 and to 앵커링 기록 — and the watch over its anchor ends
  // when the screen is left. Back on the screen, a chip still reading "accepted" would look like an anchor
  // that never confirmed, so the watch is taken up again.
  const a = s.anchored;
  if (a && a.anchor !== 'confirmed' && a.proof.snapshot_id) void watchAnchor(++s.run, a.proof.snapshot_id, 0);
}

// ── drawing ────────────────────────────────────────────────────────────────

function paint(loadError = ''): void {
  const root = el('por-root');
  if (!root) return;
  if (loadError) {
    root.innerHTML = `<section class="card"><p class="muted">${esc(loadError)}</p></section>`;
    return;
  }
  if (!s.active || !s.exchange) {
    root.innerHTML = `
      <section class="card">
        <span class="eyebrow">PROOF OF RESERVES</span>
        <h2>${esc(t('준비금 증명이 아직 활성화되지 않았습니다', 'Proof of Reserves is not active yet'))}</h2>
        <p class="lede">${esc(t(
          '구독에서 Proof of Reserves를 활성화하면 이 화면에서 잔고 파일을 바로 앵커링할 수 있습니다.',
          'Activate Proof of Reserves under Subscriptions and a balance file can be anchored from this screen.'))}</p>
        <div class="row"><a class="btn" href="#/products">${esc(t('구독에서 활성화 →', 'Activate under Subscriptions →'))}</a></div>
      </section>`;
    return;
  }
  root.innerHTML = anchorCardHtml();
  wire();
}

function anchorCardHtml(): string {
  const idle = !s.busy;
  return `
    <section class="card">
      <h2>${esc(t('잔고 파일 앵커링', 'Anchor a balance file'))}</h2>
      <label class="drop" id="por-drop" tabindex="0">
        <input type="file" id="por-file" accept=".csv,.json,text/csv,application/json,text/plain" hidden>
        <span class="dk">${esc(t('잔고 파일 (CSV · JSON)', 'Balance file (CSV · JSON)'))}</span>
        <span class="dv" id="por-filename">${esc(s.fileLabel || t('파일을 선택하십시오 — 이 브라우저에서만 읽고 서버로 올리지 않습니다', 'Choose a file — it is read in this browser only and is not uploaded'))}</span>
      </label>
      <div class="row">
        <button class="btn" id="por-go" ${idle && (s.file || s.fileText !== null) ? '' : 'disabled'}>${esc(t('앵커링', 'Anchor'))}</button>
        <button class="btn ghost" id="por-sample" type="button" ${idle ? '' : 'disabled'}>${esc(t('예시 파일로 앵커링', 'Anchor the example file'))}</button>
        ${s.busy ? `<span class="dim">${esc(s.busy)}</span>` : ''}
      </div>
      <p class="hint porsamples"><span>${esc(t('예시 파일 내려받기', 'Download the example'))}</span>
        <span class="porsample"><button class="link" type="button" data-por-sample="wide">${esc(SAMPLE_WIDE_NAME)}</button>${esc(t('계정당 한 줄, 자산마다 열 하나', 'one row per account, one column per asset'))}</span>
        <a data-link="attest-docs" data-link-hash="por-data" target="_blank" rel="noopener">${esc(t('형식 안내 ↗', 'Format guide ↗'))}</a></p>
      <details class="poropt">
        <summary>${esc(t('옵션', 'Options'))}</summary>
        <label class="porcheck"><input type="checkbox" id="por-spot" ${s.spotCheck ? 'checked' : ''}>
          <span>${esc(t('표본 확인도 받기', 'Also ask for a spot check'))}</span></label>
        <p class="hint">${esc(t(
          '기본은 루트와 총액만 보냅니다. 표본 확인을 켜면 플랫폼이 무작위로 고른 계정 8개의 해시된 식별자·잔고와 바로 옆 계정의 잔고가 함께 전송됩니다(계정 식별자 자체는 보내지 않습니다).',
          'By default only the root and the totals are sent. With a spot check, the hashed identifier and balances of eight accounts the platform picks at random go too, with the balances of the account next to each (the account identifier itself is never sent).'))}</p>
      </details>
      ${s.failure ? failureHtml(s.failure) : ''}
      ${s.anchored ? anchoredHtml(s.anchored) : ''}
      ${leftHtml()}
    </section>`;
}

/**
 * Proof files not yet taken, for snapshots whose result has left the screen.
 *
 * The result box carries its own download. It goes when another file is
 * chosen and is replaced when another snapshot is anchored; either way the
 * proof file it offered is still wanted, so each one stays here until it has
 * been downloaded.
 */
function leftHtml(): string {
  const left = s.kept.filter((p) => p !== s.anchored?.proof);
  if (left.length === 0) return '';
  return `<div id="por-left">${left.map((p, i) => `
      <p class="hint">${esc(t(
    `앵커링한 스냅샷(${p.snapshot_id ?? '—'})의 증명 파일을 아직 내려받지 않았습니다. 이 탭을 닫거나 새로 고치거나 로그아웃하면 다시 받을 수 없습니다.`,
    `The proof file of the snapshot anchored here (${p.snapshot_id ?? '—'}) has not been downloaded yet. It cannot be downloaded again once this tab is closed or reloaded, or you sign out.`))}
        <button class="link" type="button" data-por-left="${esc(p.snapshot_id ?? '')}"${i === 0 ? ' id="por-proof-dl2"' : ''}>${esc(t('증명 파일 내려받기', 'Download the proof file'))}</button></p>`).join('')}</div>`;
}

function failureHtml(f: { title: string; items: string[] }): string {
  return `
    <div class="porbox bad">
      <b>${esc(f.title)}</b>
      ${f.items.length ? `<ul class="porproblems">${f.items.map((l) => `<li>${l}</li>`).join('')}</ul>
      <p class="hint">${esc(t('문제가 하나라도 있으면 앵커링하지 않습니다. 파일을 고친 뒤 다시 시도하십시오.',
    'Nothing is anchored from a file with a problem in it. Fix the file and try again.'))}</p>` : ''}
    </div>`;
}

function anchoredHtml(a: Anchored): string {
  const r = a.report;
  const st = a.proof.statement;
  return `
    <div class="porbox ok">
      <p><b>${esc(t('앵커링 접수', 'Accepted for anchoring'))}</b>
        <span class="chip ok">${esc(a.status)}</span>
        <span class="dim"> · ${esc(t('앵커', 'anchor'))}:</span> <span id="por-anchor">${anchorChip(a.anchor)}</span>
        <span class="dim"> · ${esc(s.network.toUpperCase())}</span></p>
      <div class="statrow">
        <div class="stat"><b>${esc(grouped(r.accounts))}</b>
          <small>${esc(t('계정', 'accounts'))}${r.zero_balance_accounts > 0 ? ` · ${esc(t(`잔고 0인 계정 ${grouped(r.zero_balance_accounts)}개 포함`, `${grouped(r.zero_balance_accounts)} with every balance zero`))}` : ''}</small></div>
        ${a.assets.map((x) => `
          <div class="stat"><b>${esc(fromBaseUnits(Object.hasOwn(st.totals, x.symbol) ? st.totals[x.symbol]! : '0', x.decimals))}</b>
            <small>${esc(x.symbol)} ${esc(t('총액', 'total'))} · ${esc(t(`보유 계정 ${grouped(r.holders[x.symbol] ?? 0)}개`, `held by ${grouped(r.holders[x.symbol] ?? 0)}`))}</small></div>`).join('')}
      </div>
      <div class="digestbox">
        <span class="dlabel">${esc(t('머클 루트', 'Merkle root'))}</span>
        <code class="digestval mono" id="por-rootval">${esc(st.tree.root)}</code>
        <span class="dmeta dim">${esc(t(`${a.fileName} · 줄 ${grouped(r.rows)}개 · 기준 시각 ${st.asof}`, `${a.fileName} · ${grouped(r.rows)} rows · as of ${st.asof}`))}</span>
      </div>
      <div class="digestbox">
        <span class="dlabel">${esc(t('스냅샷 ID', 'Snapshot id'))}</span>
        <code class="digestval mono" id="por-snapid">${esc(a.proof.snapshot_id ?? '')}</code>
        <span class="dmeta dim">${t(
          '<a href="/playground/por.html" target="_blank" rel="noopener">공개 검증 페이지 ↗</a>에서 이 ID로 스냅샷을 불러옵니다 · ID는 <a href="#/records?product=por">앵커링 기록</a>에 남습니다',
          'The <a href="/playground/por.html" target="_blank" rel="noopener">public verify page ↗</a> loads the snapshot by this id · the id stays in <a href="#/records?product=por">Records</a>')}</span>
      </div>
      <p class="hint" id="por-settled">${esc(t(
        `총액을 귀사 원장과 대조하십시오. 읽은 형식은 ${shapeName(a.shape)}입니다. 자산은 파일에 적힌 ${a.assets.length}개(${named(a.assets)})를 그대로 읽었고, 금액은 적힌 숫자 그대로 합산했습니다. 기준 시각은 제출 시각입니다.`,
        `Compare the totals with your ledger. The file was read as ${shapeName(a.shape)}. The ${a.assets.length} asset${a.assets.length === 1 ? '' : 's'} named in it (${named(a.assets)}) were read as they are, and amounts were summed exactly as written. The as-of time is the time of submission.`))}
        ${esc(a.spotCheck
          ? t(`표본 확인 통과 — 계정 ${a.sampled}개를 플랫폼에 열어 보였습니다.`, `Spot check passed — ${a.sampled} accounts were opened to the platform.`)
          : t('플랫폼으로 간 것은 루트와 총액을 담은 선언문과 서명뿐입니다.', 'What went to the platform is the signed statement of the root and the totals, and nothing else.'))}</p>
      <div class="porkeep">
        <button class="btn" id="por-proof-dl" type="button">${esc(t('증명 파일 내려받기', 'Download the proof file'))}</button>
        <p class="hint"><b>${esc(t('이 증명 파일과 원본 잔고 파일, 두 가지만 보관하십시오.', 'Keep this proof file and the original balance file — those two, and nothing else.'))}</b>
          ${t('계정 증명은 이 두 파일로 <a data-link="attest-docs" data-link-hash="por" target="_blank" rel="noopener">SDK ↗</a>가 발급하고, 두 파일은 <a href="#/verify">검증</a>에서 다시 맞춰 볼 수 있습니다.',
    'Account proofs are issued from these two by the <a data-link="attest-docs" data-link-hash="por" target="_blank" rel="noopener">SDK ↗</a>, and on <a href="#/verify">Verify</a> you can check the two against each other again.')}
          ${esc(t('증명 파일에는 계정별 솔트를 만드는 비밀값이 들어 있으니 공개하지 마십시오. 이 탭을 닫거나 새로 고치거나 로그아웃하면 다시 내려받을 수 없습니다.',
    'The proof file holds the secret the per-account salts come from, so do not publish it. It cannot be downloaded again once this tab is closed or reloaded, or you sign out.'))}</p>
      </div>
    </div>`;
}

/** The first few symbols, and how many more: an exchange may list hundreds. */
const named = (assets: PorAssetSpec[]): string =>
  assets.slice(0, 8).map((x) => x.symbol).join(', ') + (assets.length > 8 ? t(` 외 ${assets.length - 8}개`, ` and ${assets.length - 8} more`) : '');

/** The name a proof file is downloaded under: the day the balances stand for, and the start of the snapshot's id. */
const proofFileName = (proof: PorSnapshotProof): string =>
  `por-proof-${proof.statement.asof.slice(0, 10).replace(/[^0-9]/g, '')}-${(proof.snapshot_id ?? 'pending').replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}.json`;

// ── reading what the file says about itself ────────────────────────────────

/**
 * The assets a file names, and the decimal places its values use.
 *
 * A first pass over the file with the SDK's own CSV parser, looking only at
 * the header and at how each amount is written. It decides nothing about
 * whether the file is acceptable: the SDK's reader goes over every row again
 * with the result, and refuses whatever it would refuse on a server.
 */
function assetsOf(text: string): PorAssetSpec[] | { problem: string } {
  if (looksLikeJson(text)) return assetsOfJson(text);
  const digits = new Map<string, number>();
  const see = (symbol: string, cell: string): void => {
    const fraction = /^[^.]*\.(\d+)$/.exec(cell.trim());
    digits.set(symbol, Math.max(digits.get(symbol) ?? 0, fraction ? fraction[1]!.length : 0));
  };
  const seen: { header: string[] | null; long: { asset: number; balance: number } | null; wide: { name: string; at: number }[] } =
    { header: null, long: null, wide: [] };
  const take = (records: CsvRecord[]): void => {
    for (const r of records) {
      if (!seen.header) {
        seen.header = r.fields.map((f) => f.trim());
        const names = seen.header.map(lower);
        if (!names.some((n) => ACCOUNT_COLUMNS.has(n))) return;
        const asset = names.indexOf('asset');
        const balance = names.indexOf('balance');
        // A sheet is known by an equity and a debt column for one asset, as the SDK's reader knows it.
        const after = (h: string, prefix: string): string | null =>
          (h.length > prefix.length && lower(h.slice(0, prefix.length)) === prefix ? h.slice(prefix.length) : null);
        const debts = new Set(seen.header.map((h) => after(h, 'd_')).filter((x): x is string => x !== null));
        const equity = seen.header.map((h, at) => ({ name: after(h, 'e_'), at })).filter((c): c is { name: string; at: number } => c.name !== null);
        if (asset >= 0 && balance >= 0) seen.long = { asset, balance };
        else if (equity.some((c) => debts.has(c.name))) seen.wide = equity;
        else seen.wide = seen.header.map((name, at) => ({ name, at })).filter((c) => !ACCOUNT_COLUMNS.has(lower(c.name)));
        for (const c of seen.wide) digits.set(c.name, 0);
        continue;
      }
      if (seen.long) {
        const symbol = (r.fields[seen.long.asset] ?? '').trim();
        if (symbol !== '') see(symbol, r.fields[seen.long.balance] ?? '');
      } else {
        for (const c of seen.wide) see(c.name, r.fields[c.at] ?? '');
      }
    }
  };
  try {
    const parser = new CsvParser();
    take(parser.push(text));
    take(parser.end());
  } catch (e) {
    // A syntax error stops the SDK's reader at the same place; it is reported
    // from there, with whatever was seen up to it.
    if (!(e instanceof CsvError)) throw e;
  }
  if (!seen.header || !seen.header.map(lower).some((n) => ACCOUNT_COLUMNS.has(n))) {
    return { problem: t(
      '첫 줄에서 account_id 열을 찾지 못했습니다. 예시 파일처럼 첫 줄을 account_id,BTC,ETH,… 로 적으십시오 — 계정당 한 줄, 자산마다 열 하나입니다.',
      'No account_id column in the first line. Write it as the example does — account_id,BTC,ETH,… — one row per account, one column per asset.') };
  }
  if (digits.size === 0) {
    return { problem: t('파일에 자산이 하나도 없습니다 — 잔고가 한 줄 이상 있어야 합니다.', 'The file names no asset — it needs at least one balance.') };
  }
  return [...digits].map(([symbol, used]) => ({ symbol, decimals: Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, used)) }));
}

/** The account column: this SDK's name for it, or the one an exchange's own balance sheet uses. */
const ACCOUNT_COLUMNS = new Set(['account_id', 'id']);

/** The assets a JSON array of accounts names. What is wrong with the file itself is left to the SDK's reader to say. */
function assetsOfJson(text: string): PorAssetSpec[] | { problem: string } {
  const digits = new Map<string, number>();
  try {
    const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (Array.isArray(data)) {
      for (const entry of data) {
        const assets = entry !== null && typeof entry === 'object' ? ((entry as Record<string, unknown>)['assets'] ?? (entry as Record<string, unknown>)['balances']) : null;
        if (assets === null || typeof assets !== 'object' || Array.isArray(assets)) continue;
        for (const [symbol, amount] of Object.entries(assets as Record<string, unknown>)) {
          const fraction = typeof amount === 'string' ? /^[^.]*\.(\d+)$/.exec(amount.trim()) : null;
          digits.set(symbol, Math.max(digits.get(symbol) ?? 0, fraction ? fraction[1]!.length : 0));
        }
      }
    }
  } catch { /* not JSON: the reader reports it */ }
  return [...digits].map(([symbol, used]) => ({ symbol, decimals: Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, used)) }));
}

/** The first problems of a refused file, each as markup: where, what it means, and the SDK's own line. */
function problemLines(report: LedgerReport, json: boolean): string[] {
  return report.problems.slice(0, 20).map((p) => {
    // A JSON file has no lines worth naming: the SDK counts its accounts instead.
    const where = p.line === 0 ? t('파일', 'file')
      : json ? t(`${p.line}번째 계정`, `account ${p.line}`) : t(`${p.line}번째 줄`, `line ${p.line}`);
    if (p.code === 'too_many_accounts') {
      return `<b>${esc(where)}</b> · ${esc(t(`이 화면은 계정 ${grouped(MAX_ACCOUNTS)}개까지 다룹니다. 더 큰 원장은 SDK를 쓰십시오.`,
        `This screen handles up to ${grouped(MAX_ACCOUNTS)} accounts. Use the SDK for a larger ledger.`))}`;
    }
    const ko = problemKo(p.code);
    return `<b>${esc(where)}</b>${ko ? ` · ${esc(ko)}` : ''}<span class="mono">${esc(p.code)} — ${esc(p.message)}</span>`;
  });
}

/** This session's key: made once, and only when something is about to be signed. */
function sessionKey(): { d: Uint8Array; spki: string } {
  for (;;) {
    if (s.key) return s.key;
    const d = crypto.getRandomValues(new Uint8Array(32));
    try {
      s.key = { d, spki: publicSpkiFromScalar(d) };
    } catch { /* outside the curve's scalar range, about one draw in 2^32: draw again */ }
  }
}

// ── doing ──────────────────────────────────────────────────────────────────

/** Let the browser draw what was just written before a long computation starts. */
const breathe = (): Promise<void> => new Promise((ok) => setTimeout(ok, 30));

function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** The whole errand: read, build, sign, submit. Stops, with the reason, at the first thing that is not right. */
async function anchor(): Promise<void> {
  s.spotCheck = el<HTMLInputElement>('por-spot')?.checked ?? s.spotCheck;
  s.failure = null;
  s.anchored = null;
  const ex = s.exchange;
  // Everything below waits — on the page, on a file, on the platform. If the account has changed by the time
  // a wait is over, nothing more is written: not a result, not a failure, not a line of progress.
  const account = s.account;
  const gone = (): boolean => account !== s.account;
  const fail = (title: string, items: string[] = []): void => { if (gone()) return; s.failure = { title, items }; s.busy = ''; paint(); };
  const step = async (label: string): Promise<void> => { if (gone()) return; s.busy = label; paint(); await breathe(); };
  if (!ex) return;
  if (!s.file && s.fileText === null) return fail(t('잔고 파일을 선택하십시오.', 'Choose a balance file.'));

  await step(t('파일을 읽는 중…', 'Reading the file…'));
  let bytes: Uint8Array;
  let text: string;
  try {
    bytes = s.fileText !== null ? utf8(s.fileText) : new Uint8Array(await s.file!.arrayBuffer());
  } catch {
    return fail(t('파일을 읽을 수 없습니다.', 'The file could not be read.'));
  }
  if (gone()) return;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(t('UTF-8 파일이 아닙니다 — UTF-8로 다시 내보내십시오.', 'This is not a UTF-8 file — export it again as UTF-8.'));
  }
  const json = looksLikeJson(text);
  const found = assetsOf(text);
  if (!Array.isArray(found)) return fail(found.problem);
  const spec = found.length === 0 ? { assets: [], problems: [] } : parseAssetSpecs(found.map((a) => `${a.symbol}:${a.decimals}`).join(','));
  if (spec.problems.length > 0) {
    return fail(t('파일의 자산 이름을 읽을 수 없습니다 — 영문·숫자로 된 기호(BTC, USDT)여야 합니다.',
      'An asset name in the file could not be read — it has to be a symbol of letters and digits (BTC, USDT).'),
    spec.problems.map((m) => `<span class="mono">${esc(m)}</span>`));
  }

  const { rows, report, shape } = readLedger(bytes, text, json, { assets: spec.assets, amounts: 'decimal' });
  if (!report.ok) {
    const lines = problemLines(report, json);
    return fail(t(`문제 ${grouped(report.problem_count)}건${report.problem_count > lines.length ? ` (처음 ${lines.length}건 표시)` : ''}`,
      `${grouped(report.problem_count)} problem${report.problem_count === 1 ? '' : 's'}${report.problem_count > lines.length ? ` (first ${lines.length} shown)` : ''}`), lines);
  }
  if (spec.assets.length === 0) {
    return fail(t('파일에 자산이 하나도 없습니다 — 잔고가 한 건 이상 있어야 합니다.', 'The file names no asset — it needs at least one balance.'));
  }
  if (treeSums(rows, spec.assets.length) > MAX_TREE_SUMS) {
    return fail(t(
      `이 화면이 다루기에는 큽니다 — 계정 ${grouped(rows.length)}개, 자산 ${grouped(spec.assets.length)}개. 이 크기의 원장은 SDK를 쓰십시오.`,
      `Too large for this screen — ${grouped(rows.length)} accounts over ${grouped(spec.assets.length)} assets. Use the SDK for a ledger of this size.`));
  }

  await step(t(`계정 ${grouped(rows.length)}개의 머클 루트를 계산하는 중…`, `Computing the Merkle root over ${grouped(rows.length)} accounts…`));
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const unordered = rows.map((r) => leafFromRowPortable(ex.id, seed, r));
  let tree: PorTree;
  try {
    tree = buildPorTree(unordered, spec.assets.map((a) => a.symbol));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const leaves = [...unordered].sort((a, b) => (a.user_ref_hash < b.user_ref_hash ? -1 : 1));
  const asof = `${new Date().toISOString().slice(0, 19)}Z`;
  const statement = buildSnapshotStatement({ institutionId: ex.id, name: ex.name, asof, assets: spec.assets }, tree);
  // The balance file under its own name: the example is the SDK's file, whatever the label beside it says.
  const fileName = s.fileText !== null ? SAMPLE_WIDE_NAME : (s.file?.name ?? 'balances.csv');
  const source = { file: fileName, bytes: bytes.length, sha256: bytesToHex(sha256(bytes)), layout: shape as PorSnapshotProof['source']['layout'], amounts: 'decimal' as const };

  if (gone()) return;
  await step(t('서명해 제출하는 중…', 'Signing and submitting…'));
  if (gone()) return;
  const run = ++s.run;
  try {
    const key = sessionKey();
    // Before every submission, not once: another tab of the same
    // organisation may have registered its own since, and only one stands.
    await api.porConsoleKey(ex.id, key.spki);
    if (gone()) return;
    const sig = signSnapshotStatementPortable(statement, key.d);
    // Made before anything is sent, with the id still to come: a statement
    // must never be accepted and then turn out to have no proof file.
    const draft = buildSnapshotProof({ snapshotId: null, platform: location.origin, statement, sig, seed, source });
    const sent = await api.porSubmit({ statement, sig, ...(s.spotCheck ? { spot_check: true } : {}) });
    // The platform has the statement. If the account changed while its answer was on the way, the answer is
    // dropped here — with the proof file, which must not be handed to whoever signed in next.
    if (gone()) return;
    let status = sent.status;
    let sampled = 0;
    if (sent.challenge) {
      const openings: PorInclusionProof[] = sent.challenge.indices.map((i) => {
        const leaf = leaves[i];
        if (!leaf) throw new Error(`challenged index ${i} is not in the tree`);
        // Pseudonymous by construction: the hash and the balances, never the identifier.
        return provePorLeaf(tree, i, { user_ref_hash: leaf.user_ref_hash, salt: leaf.salt, balances: leaf.balances });
      });
      const verified = await api.porOpenings(sent.snapshot_id, openings);
      if (gone()) return;
      status = verified.status;
      sampled = verified.sampled_leaves;
    }
    const proof: PorSnapshotProof = { ...draft, snapshot_id: sent.snapshot_id };
    s.anchored = {
      fileName: s.fileLabel || fileName, assets: spec.assets, report, shape, proof,
      status, spotCheck: Boolean(sent.challenge), sampled, anchor: 'accepted',
    };
    s.kept.push(proof);
    s.busy = '';
    paint();
    void watchAnchor(run, sent.snapshot_id);
  } catch (e) {
    fail(t('앵커링하지 못했습니다.', 'It could not be anchored.'),
      [`<span class="mono">${esc(e instanceof ApiError ? `${e.code} — ${e.message}` : e instanceof Error ? e.message : String(e))}</span>`]);
  }
}

/** Follow the anchor to confirmation, for as long as this submission is the one on screen. */
async function watchAnchor(run: number, id: string, firstWait = 2_000): Promise<void> {
  for (let i = 0; i < 90; i++) {
    await new Promise((ok) => setTimeout(ok, i === 0 ? firstWait : 2_000));
    if (run !== s.run || !s.anchored || !el('por-root')) return;
    let status: string;
    try {
      status = (await api.porSnapshot(id)).attestation?.status ?? 'accepted';
    } catch {
      continue;
    }
    if (status === s.anchored.anchor) continue;
    s.anchored.anchor = status;
    const host = el('por-anchor');
    if (host) host.innerHTML = anchorChip(status);
    if (status === 'confirmed') return;
  }
}

function wire(): void {
  const file = el<HTMLInputElement>('por-file');
  file?.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    s.spotCheck = el<HTMLInputElement>('por-spot')?.checked ?? s.spotCheck;
    s.file = f;
    s.fileText = null;
    s.fileLabel = f.name;
    s.anchored = null;
    s.failure = null;
    paint();
  });
  // The input inside the slot is hidden and cannot take the focus; the slot does, and Enter or Space opens the file chooser.
  el('por-drop')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    file?.click();
  });
  el('por-go')?.addEventListener('click', () => { void anchor(); });
  el('por-sample')?.addEventListener('click', () => {
    s.file = null;
    s.fileText = SAMPLE_WIDE;
    s.fileLabel = t(`${SAMPLE_WIDE_NAME} (예시)`, `${SAMPLE_WIDE_NAME} (example)`);
    void anchor();
  });
  // One example, the one the button beside it anchors: a file to open, copy and fill in.
  document.querySelector<HTMLButtonElement>('#por-root button[data-por-sample]')
    ?.addEventListener('click', () => { download(SAMPLE_WIDE_NAME, SAMPLE_WIDE, 'text/csv'); });
  el('por-proof-dl')?.addEventListener('click', () => {
    const a = s.anchored;
    if (!a) return;
    download(proofFileName(a.proof), snapshotProofText(a.proof));
    s.kept = s.kept.filter((p) => p !== a.proof);
  });
  // A result box that is gone, and a proof file never taken: the last place to have it from.
  for (const button of document.querySelectorAll<HTMLButtonElement>('#por-left button[data-por-left]')) {
    button.addEventListener('click', () => {
      const proof = s.kept.find((p) => (p.snapshot_id ?? '') === button.dataset['porLeft']);
      if (!proof) return;
      download(proofFileName(proof), snapshotProofText(proof));
      s.kept = s.kept.filter((p) => p !== proof);
      paint();
    });
  }
  const root = el('por-root');
  if (root) resolveLinks(root);
}
