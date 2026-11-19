/**
 * 검증 — the one place a downloaded proof is checked, whichever product it
 * came from.
 *
 * The check used to sit at the foot of 문서 앵커링, and a second one — a
 * reserve snapshot's two files — sat on 준비금 증명. But every product ends
 * in an anchor and hands its customer a file to keep: the bundle of a record,
 * a settlement's evidence, a snapshot's proof file. "Does the file I
 * downloaded still check out" is one question, so it has one screen, and a
 * bank that never anchors a document can reach it.
 *
 * The visitor is not asked which kind of file they hold. The file says, and
 * `verify-files.ts` reads it: what each of the two slots is, what the pair
 * means, which check that calls for. This module only words the outcome.
 *
 * Everything runs in this page. No file is sent and no server is asked — a
 * check that needed us would be our word again, not a check. What that leaves
 * unchecked is said beside every result rather than left out: whether the
 * transaction is in a public block (this page consults no Bitcoin source),
 * whose key a signature was made with, and, for a pair of files that only
 * agree with each other, whether what they agree on was anchored.
 *
 * ## One name for each file
 *
 * Four files pass through here and each has one name on this screen: 번들
 * (a record's bundle), 송금 증빙 (a settlement's evidence), 준비금 증명 파일
 * (a reserve snapshot's proof file) and 계정 증명 파일 (one account's
 * proof). 원본 is a document or a balance file and nothing else. On this
 * screen a Bitcoin transaction is 트랜잭션, because on 송금 the word 거래 is
 * the payment.
 */
import { t } from './i18n.ts';
import type { LinkVerdicts } from './vendor/attest-verify/index.ts';
import { fromBaseUnits } from './vendor/attest-por/amounts.ts';
import type { SnapshotProofError, PorSnapshotProof, SnapshotMismatch } from './vendor/attest-por/snapshot-proof.ts';
import { shapeName } from './por-words.ts';
import type { BundleOutcome, BundleSubject, EvidenceOutcome, Plan, SnapshotOutcome } from './verify-files.ts';
import type { EvidenceCheckReport } from './evidence-check.ts';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const el = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const grouped = (n: number): string => n.toLocaleString();
const short = (hex: string, n = 10): string => (hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex);
/** Let the browser draw what was just written before a long computation starts. */
const breathe = (): Promise<void> => new Promise((ok) => setTimeout(ok, 30));

/**
 * The two files on the screen, and the products this organisation has. In
 * memory only; drawing the screen again starts the slots empty.
 */
const v: { first: File | null; second: File | null; run: number; products: ReadonlySet<string> | null } =
  { first: null, second: null, run: 0, products: null };

/** Whether this organisation has a product. Not knowing counts as having it: nothing is hidden on a failed read. */
const has = (product: string): boolean => !v.products || v.products.has(product);

/**
 * The files this organisation can hold, by their names on this screen — a
 * bank that subscribes to settlements is not told about balance files.
 * Whatever is put in a slot is still read for what it is; this only decides
 * what is named.
 */
const kinds = (): string[] => [
  t('앵커링 기록의 번들', 'a bundle from Records'),
  ...(has('remit') ? [t('송금 증빙', 'a settlement’s evidence')] : []),
  ...(has('por') ? [t('준비금 증명 파일', 'a reserve proof file')] : []),
];
const originals = (): string[] => [
  ...(has('attest') ? [t('원본 문서', 'the original document')] : []),
  ...(has('por') ? [t('원본 잔고 파일', 'the original balance file')] : []),
];
const FIRST_EMPTY = (): string => kinds().join(' · ');
const SECOND_EMPTY = (): string => (originals().length > 0 ? originals().join(' · ') : t('번들과 짝이 되는 파일', 'the file that goes with a bundle'));

/**
 * The screen: two slots and one button, and nothing to read first.
 *
 * The page's title says what it is for. What a second file adds is said by
 * the result that would gain from one, when it would — not in a list of
 * pairings to study before the first file is chosen.
 */
export function sectionVerify(products: ReadonlySet<string> | null): string {
  v.products = products;
  return `
    <section class="card" id="verify">
      <div class="two">
        <label class="drop" id="v-drop" tabindex="0">
          <input type="file" id="v-bundle" accept=".json,application/json" hidden>
          <span class="dk">${t('검증할 파일', 'File to check')}</span>
          <span class="dv" id="v-bundle-name">${esc(FIRST_EMPTY())}</span>
        </label>
        <label class="drop" id="v-orig-drop" tabindex="0">
          <input type="file" id="v-orig" hidden>
          <span class="dk">${t('원본 — 있을 때', 'Original — if there is one')}</span>
          <span class="dv" id="v-orig-name">${esc(SECOND_EMPTY())}</span>
        </label>
      </div>

      <div class="row"><button class="btn" id="v-run" disabled>${t('검증 실행', 'Run the check')}</button></div>
      <div id="v-result" aria-live="polite"></div>
    </section>`;
}

function names(): void {
  const first = el('v-bundle-name');
  const second = el('v-orig-name');
  const run = el<HTMLButtonElement>('v-run');
  if (first) first.textContent = v.first ? v.first.name : FIRST_EMPTY();
  if (second) second.textContent = v.second ? v.second.name : SECOND_EMPTY();
  if (run) run.disabled = !(v.first || v.second);
}

/**
 * A slot was filled: whatever is on the screen was found for other files.
 *
 * A "holds" left standing under a file that was not checked is the one thing
 * this screen must never show, and swapping a wrong file in after a pass is
 * the first thing a careful reader tries. So the result goes, and a check
 * still running is forgotten.
 */
function changed(): void {
  v.run++;
  const out = el('v-result');
  if (out) out.innerHTML = '';
  const run = el<HTMLButtonElement>('v-run');
  if (run) run.textContent = t('검증 실행', 'Run the check');
  names();
}

/** Called after the section is in the document. */
export function wireVerify(): void {
  const firstIn = el<HTMLInputElement>('v-bundle');
  const secondIn = el<HTMLInputElement>('v-orig');
  const run = el<HTMLButtonElement>('v-run');
  if (!firstIn || !secondIn || !run) return;
  // A screen drawn again has empty slots; whatever a check in flight comes back with belongs to the old one.
  v.first = null;
  v.second = null;
  v.run++;
  firstIn.addEventListener('change', () => { v.first = firstIn.files?.[0] ?? null; changed(); });
  secondIn.addEventListener('change', () => { v.second = secondIn.files?.[0] ?? null; changed(); });
  run.addEventListener('click', () => { void check(); });

  // The slots look like places to drop a file, so they are: a file let go over the page would otherwise
  // be opened by the browser in place of the console. Two files dropped together fill both slots — which
  // is which is worked out when they are read.
  const zone = (id: string, put: (file: File, other: File | null) => void): void => {
    const z = el(id);
    if (!z) return;
    // The input inside is hidden and cannot take the focus; the slot does, and Enter or Space opens the file chooser.
    z.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      z.querySelector<HTMLInputElement>('input[type="file"]')?.click();
    });
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => { z.classList.remove('over'); });
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      z.classList.remove('over');
      const dropped = e.dataTransfer?.files;
      const file = dropped?.[0];
      if (!file) return;
      put(file, dropped[1] ?? null);
      changed();
    });
  };
  zone('v-drop', (file, other) => { v.first = file; if (other) v.second = other; });
  zone('v-orig-drop', (file, other) => { v.second = file; if (other) v.first = other; });
  // A drop that misses the slots by a little is not a reason to lose the page.
  const section = el('verify');
  section?.addEventListener('dragover', (e) => { e.preventDefault(); });
  section?.addEventListener('drop', (e) => { e.preventDefault(); });
}

async function check(): Promise<void> {
  const out = el('v-result');
  const button = el<HTMLButtonElement>('v-run');
  // One file in the second slot alone is still one file to read.
  const a = v.first ?? v.second;
  const b = v.first ? v.second : null;
  if (!out || !button || !a) return;
  const run = ++v.run;
  const step = async (label: string): Promise<void> => {
    out.innerHTML = `<p class="dim" id="v-busy">${esc(label)}</p>`;
    await breathe();
  };
  button.disabled = true;
  button.textContent = t('검증 중…', 'Checking…');
  try {
    await step(t('파일을 읽는 중…', 'Reading…'));
    let first: Uint8Array;
    let second: Uint8Array | null;
    try {
      first = new Uint8Array(await a.arrayBuffer());
      second = b ? new Uint8Array(await b.arrayBuffer()) : null;
    } catch {
      // A folder put in a slot, or a file that has gone since it was chosen.
      if (run === v.run) out.innerHTML = boxHtml('bad', t('파일을 읽을 수 없습니다 — 폴더가 아닌 파일을 넣으십시오.', 'The file could not be read — choose a file, not a folder.'), []);
      return;
    }
    if (run !== v.run) return;
    // The deciding half — the readers, the rules engine, the evidence checker, a hundred kilobytes of it —
    // is fetched when a check is first run, not with every page of the console: most visits never come here.
    const { checkBundle, checkEvidenceWith, checkSnapshotFiles, planCheck } = await import('./verify-files.js');
    if (run !== v.run) return;
    const plan = planCheck(first, second);
    // The two slots the other way round is the likeliest slip, and nothing is lost by putting it right.
    if (plan.swapped && v.first && v.second) {
      [v.first, v.second] = [v.second, v.first];
      names();
    }
    let html: string;
    if (plan.check === 'bundle') {
      let outcome: BundleOutcome | null = null;
      // A bundle with a part missing makes the verifier stumble rather than answer; that is a damaged file, said as one.
      try { outcome = await checkBundle(plan.bundle, plan.original); } catch { /* said below */ }
      html = outcome ? bundleHtml(outcome)
        : boxHtml('bad', t('번들이 손상되었습니다 — 내려받은 그대로의 파일을 넣으십시오.', 'The bundle is damaged — choose the file as it was downloaded.'), []);
    } else if (plan.check === 'evidence') {
      html = evidenceHtml(await checkEvidenceWith(plan.evidence, plan.bundle), plan.spare);
    } else if (plan.check === 'snapshot') {
      if (plan.ledger === null) {
        html = snapshotAloneHtml(plan.proof);
      } else {
        await step(t(`계정 ${grouped(plan.proof.statement.tree.leaf_count)}개의 머클 루트를 다시 계산하는 중…`,
          `Rebuilding the Merkle root over ${grouped(plan.proof.statement.tree.leaf_count)} accounts…`));
        html = snapshotHtml(checkSnapshotFiles(plan.proof, plan.ledger));
      }
    } else {
      html = refusalHtml(plan);
    }
    if (run !== v.run) return;
    out.innerHTML = html;
  } catch (e) {
    if (run === v.run) out.innerHTML = boxHtml('bad', t('검증하지 못했습니다', 'The check could not be run'), [mono(e instanceof Error ? e.message : String(e))]);
  } finally {
    if (run === v.run) {
      button.textContent = t('검증 실행', 'Run the check');
      button.disabled = !(v.first || v.second);
    }
  }
}

// ── wording ────────────────────────────────────────────────────────────────
//
// Everything below builds markup from a result and touches nothing else. The
// builders are exported for the tests: what this screen says of a file is
// the product, and the lines that decide a headline or escape a value that
// came out of a file are held there one by one.

type Tone = 'ok' | 'bad' | 'wait' | 'inert';
const tone = (state: string): Tone => (state === 'pass' ? 'ok' : state === 'fail' ? 'bad' : state === 'warn' || state === 'none' ? 'wait' : 'inert');
const STATE = (): Record<string, string> => ({
  pass: t('통과', 'pass'), fail: t('실패', 'fail'), skip: t('확인 안 함', 'not checked'), warn: t('주의', 'caution'),
  none: t('번들 없음', 'no bundle'),
});
const chip = (state: string, as: Tone = tone(state)): string => `<span class="chip ${as}">${esc(named(STATE(), state))}</span>`;
const mono = (text: string): string => `<span class="mono">${esc(text)}</span>`;
/**
 * The reader's word for a key, or the key itself. The key may come out of a
 * file — an element or an axis under any name at all, `constructor` included
 * — so only the table's own entries are looked at.
 */
const named = (table: Record<string, string>, key: string): string => (Object.hasOwn(table, key) ? table[key]! : key);
/** One line of a check list: the chip, then everything said about it — `body` is markup, escaped where it was built. */
const line = (chipHtml: string, body: string, cls = ''): string => `<li${cls ? ` class="${cls}"` : ''}>${chipHtml}<span class="vt">${body}</span></li>`;

/** The verifier's own labels are an engineer's; these say the same per check. */
const BUNDLE_CHECK = (): Record<string, string> => ({
  schema: t('번들 형식과 네트워크', 'Bundle format and network'),
  preimage: t('넣은 원본과 해시의 일치', 'The original you added matches the hash'),
  merkle: t('해시가 묶음에 들어 있음', 'The hash is in the batch'),
  'anchor-commitment': t('트랜잭션에 실린 값의 일치', 'The value in the transaction matches'),
  'txid-binding': t('트랜잭션 ID와 트랜잭션 내용의 일치', 'The transaction id matches its contents'),
  'chain-entry': t('번들에 적힌 블록 기록', 'The block record the bundle gives'),
  'witness-original': t('트랜잭션 안의 원본 문서', 'The document inside the transaction'),
  onchain: t('공개 블록 포함 여부 — 이 화면은 확인하지 않음', 'In a public block — not checked on this screen'),
});

/** One of the verifier's own checks, in the reader's words. */
const bundleLine = (c: { id: string; state: string }): string => line(chip(c.state),
  esc(Object.hasOwn(BUNDLE_CHECK(), c.id) ? BUNDLE_CHECK()[c.id]! : t('기타 검사', 'Other check')), esc(c.state));

/** Something no result on this page can say: its name, and — where there is more to say — a line under it. */
interface Unchecked { title: string; small?: string }

/**
 * A verdict, and beside it what was not checked.
 *
 * `small` and each `Unchecked.small` are markup, escaped where they were
 * built. The first unchecked thing is drawn at the size of the verdict; any
 * more are listed under it.
 */
const split = (left: { tone: Tone; label: string; title: string; small: string }, right: Unchecked[]): string => `
    <div class="split${right.length > 0 ? '' : ' one'}">
      <div class="half ${left.tone}" id="v-verdict">
        <span class="lbl">${esc(left.label)}</span>
        <b>${esc(left.title)}</b>
        ${left.small ? `<small>${left.small}</small>` : ''}
      </div>
      ${right.length > 0 ? `<div class="half wait" id="v-unchecked">
        <span class="lbl">${t('확인하지 않은 것', 'Not checked')}</span>
        ${right.map((u, i) => `<b${i === 0 ? '' : ' class="also"'}>${esc(u.title)}</b>${u.small ? `<small>${u.small}</small>` : ''}`).join('')}
      </div>` : ''}
    </div>`;

/** A result that is a statement and a list, not a set of checks: a refusal, a mismatch. `items` are markup, escaped where they were built. */
const boxHtml = (as: 'bad' | 'wait', title: string, items: string[], id = 'v-verdict'): string => `
    <div class="vbox ${as}" id="${id}">
      <b>${esc(title)}</b>
      ${items.length === 1 ? `<p>${items[0]}</p>` : items.length ? `<ul class="vlines">${items.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
    </div>`;

/**
 * The checks behind the tiles, one line each. Closed while everything holds —
 * the tiles have said it — and open as soon as something does not, because
 * then the line that failed is what the reader came for.
 */
const details = (lines: string[], open: boolean): string => `
    <details class="vmore"${open ? ' open' : ''}>
      <summary>${t('검사 내역', 'The checks, one by one')}</summary>
      <ul class="vchecks">${lines.join('')}</ul>
    </details>`;

/**
 * Whether the transaction is in a public block: the thing no result on this
 * page can say. The transaction id is given with it only when it was
 * recomputed from the transaction the bundle carries — an id the bundle
 * merely names is a label, and an explorer would "confirm" any real one.
 *
 * Which chain to look on is the bundle's own word. It chooses the sentence —
 * a regtest transaction is on no public explorer, and in this sandbox the
 * place that answers is the record list — and is otherwise given as what the
 * bundle says: a bundle can name any network.
 */
const uncheckedBlock = (report: { txid?: string; network: string | null; links: LinkVerdicts } | null): Unchecked => {
  const txid = report && report.links.C1 === 'pass' ? report.txid : undefined;
  const network = report && typeof report.network === 'string' ? report.network : '';
  const where = !txid ? t('이 화면은 비트코인 노드에 묻지 않습니다.', 'This screen asks no Bitcoin node.')
    : network === 'regtest'
      ? t('regtest는 이 샌드박스의 시험 체인이라 공개 익스플로러에 없습니다 — 이 배포의 노드가 하는 답은 앵커링 기록의 트랜잭션 열에서 볼 수 있습니다.',
        'regtest is this sandbox’s own test chain and is on no public explorer — what this deployment’s node says is in the Transaction column of Records.')
      : t(`이 화면은 비트코인 노드에 묻지 않습니다. 직접 확인하시려면 이 트랜잭션 ID를 익스플로러에서 조회하십시오${network ? ` — 번들에 적힌 네트워크: ${network}` : ''}.`,
        `This screen asks no Bitcoin node. To check it yourself, look this transaction id up in an explorer${network ? ` — network, as the bundle gives it: ${network}` : ''}.`);
  return {
    title: t('이 트랜잭션이 공개 블록에 있는지', 'Whether this transaction is in a public block'),
    small: `${esc(where)}${txid ? `<span class="mono vtx" id="v-txid">${esc(txid)}</span>` : ''}`,
  };
};

/** What the bundle names as its record, said as the label it is. */
function subjectLine(s: BundleSubject): string {
  if (!s) return '';
  const what = s.kind === 'por-snapshot' ? t(`준비금 증명 스냅샷 ${s.snapshotId}`, `reserve snapshot ${s.snapshotId}`)
    : s.kind === 'remit-evidence' ? t(`송금 ${s.paymentId}의 증빙`, `the evidence of settlement ${s.paymentId}`)
      : s.kind === 'remit-manifest' ? t(`송금 일별 마감 ${s.date}`, `the settlements closed on ${s.date}`)
        : s.name;
  return esc(t(`번들에 적힌 대상: ${what}.`, `The bundle gives its record as ${what}.`));
}

/**
 * The snapshot a reserve proof file gives: its root, and what identifies it.
 *
 * The id is outside what was anchored and outside the tree — no check covers
 * it — so it is always given as what the file says. `covered` names what the
 * check that just passed did cover: the whole snapshot (held against an
 * anchored hash), the tree (rebuilt from the balance file), or nothing yet.
 */
const snapshotBox = (proof: PorSnapshotProof, covered: 'snapshot' | 'tree' | 'nothing'): string => {
  const st = proof.statement;
  const id = t(`스냅샷 ID ${proof.snapshot_id ?? '—'}`, `snapshot id ${proof.snapshot_id ?? '—'}`);
  const asof = t(`기준 시각 ${st.asof}`, `as of ${st.asof}`);
  const accounts = t(`계정 ${grouped(st.tree.leaf_count)}개`, `${grouped(st.tree.leaf_count)} accounts`);
  // The time is in the snapshot and so in the anchored hash; a rebuild from the balance file does not reach it.
  const written = t('준비금 증명 파일에 적힌 값: ', 'as the reserve proof file gives it: ');
  return `
    <div class="digestbox">
      <span class="dlabel">${esc(t('머클 루트', 'Merkle root'))}</span>
      <code class="digestval mono" id="v-root">${esc(st.tree.root)}</code>
      <span class="dmeta dim">${esc(covered === 'snapshot' ? `${asof} · ${accounts} · ${written}${id}`
    : covered === 'tree' ? `${accounts} · ${written}${asof}, ${id}` : `${written}${accounts}, ${asof}, ${id}`)}</span>
    </div>`;
};

/**
 * A bundle: the four links, reported one by one.
 *
 * No single verdict light, for the same reason the rest of this product
 * refuses one: `skip` is not `pass`. The last link is always skipped here
 * because the page consults no Bitcoin source, and a green tick over that
 * would be claiming an on-chain confirmation nobody checked.
 */
export function bundleHtml(o: BundleOutcome): string {
  const r = o.report;
  // The first link is the file the visitor holds against what was anchored — `verify-files.ts` decides it,
  // so that it is never a pass over a file nobody looked at.
  const a = o.documentLink;
  const signed = o.issuer !== null;
  // What the anchored hash is of, for the wording: a settlement's evidence and a reserve snapshot are not
  // "documents", and a question about one must not be asked of the other. The bundle's own label chooses
  // the word and never the answer.
  const of = o.original === 'snapshot' || o.subject?.kind === 'por-snapshot' ? 'snapshot'
    : o.subject?.kind === 'remit-evidence' ? 'evidence'
      : o.subject ? 'record' : signed ? 'signed' : 'document';
  const QUESTION: Record<typeof of, string> = {
    snapshot: t('준비금 증명 파일의 스냅샷이 앵커링된 그대로입니까', 'Is the snapshot in the reserve proof file the one that was anchored?'),
    evidence: t('넣은 증빙이 앵커링된 그 증빙입니까', 'Is the evidence you added the one that was anchored?'),
    record: t('넣은 원본이 앵커링된 그 기록입니까', 'Is the original you added the record that was anchored?'),
    signed: t('넣은 문서가 발급자가 서명한 그 문서입니까', 'Is the document you added the one the issuer signed?'),
    document: t('넣은 문서가 앵커링된 그 문서입니까', 'Is the document you added the one that was anchored?'),
  };
  /** The verifier's own "original" check when nothing was held against the hash: not run, and said as that. */
  const UNHELD: Record<typeof of, string> = {
    snapshot: t('스냅샷과 해시의 일치 — 준비금 증명 파일을 함께 넣었을 때만', 'The snapshot matches the hash — when the reserve proof file is added'),
    evidence: t('증빙과 해시의 일치 — 송금 증빙을 함께 넣었을 때만', 'The evidence matches the hash — when the settlement’s evidence is added'),
    record: t('원본과 해시의 일치 — 이 화면에서는 확인하지 않음', 'The original matches the hash — not checked on this screen'),
    signed: t('서명된 선언문과 앵커링된 해시의 일치', 'The signed statement matches the anchored hash'),
    document: t('원본 문서와 해시의 일치 — 원본을 넣었을 때만', 'The original matches the hash — when one is added'),
  };
  const LINKS: [keyof LinkVerdicts, string][] = [
    ['A', QUESTION[of]],
    ['B', t('그 해시가 묶음에 들어 있습니까', 'Is that hash inside the batch?')],
    ['C1', t('그 묶음이 이 트랜잭션에 담겼습니까', 'Did that batch go into this transaction?')],
    ['C2', t('그 트랜잭션이 공개 블록에 있습니까', 'Is that transaction in a public block?')],
  ];
  // Only what the reader would not know from the file they chose: an inscription and a signed anchor.
  const kind = r.witnessMode
    ? t('원본이 트랜잭션 안에 들어 있는 인스크립션 번들입니다.', 'An inscription bundle — the document is inside the transaction.')
    : signed ? t('서명 앵커 번들입니다 — 고정된 것은 발급자가 서명한 선언문입니다.', 'A signed-anchor bundle — what is anchored is a statement its issuer signed.')
      : '';
  /** The bundle ties its hash to a transaction: its own part holds, whatever was added beside it. */
  const tied = r.links.C1 === 'pass' && (r.witnessMode || r.links.B === 'pass');
  // The bundle is sound and the file beside it is not what it anchors: a mistake in the pairing, and the
  // headline says so instead of blaming the bundle. Which file would be its pair is said with it.
  const mispaired = o.originalMatches === false && tied && (o.issuer === null || o.issuer.signature === 'pass');
  const pair = !mispaired ? ''
    : o.original === 'snapshot'
      ? (o.subject?.kind === 'por-snapshot' && o.snapshot?.snapshot_id && o.snapshot.snapshot_id !== o.subject.snapshotId
        ? t(`번들에 적힌 스냅샷(${o.subject.snapshotId})과 준비금 증명 파일의 스냅샷(${o.snapshot.snapshot_id})이 서로 다릅니다 — 같은 스냅샷의 두 파일을 넣으십시오.`,
          `The bundle gives snapshot ${o.subject.snapshotId} and the reserve proof file is of snapshot ${o.snapshot.snapshot_id} — add the two files of one snapshot.`)
        : t('준비금 증명 파일의 스냅샷이 이 번들이 고정한 것과 다릅니다.', 'The snapshot in the reserve proof file is not the one this bundle anchors.'))
      : o.subject?.kind === 'por-snapshot'
        ? t('이 번들과 짝이 되는 파일은 잔고 파일이 아니라 준비금 증명 파일(por-proof-….json)입니다.',
          'The file that goes with this bundle is not the balance file but the reserve proof file (por-proof-….json).')
        : o.subject?.kind === 'remit-evidence'
          ? t('이 번들과 짝이 되는 파일은 송금 화면의 증빙 버튼으로 내려받은 송금 증빙(evidence-….json)입니다.',
            'The file that goes with this bundle is the settlement’s evidence, downloaded with the Evidence button on Settlements (evidence-….json).')
          : '';
  // What a second file would add, said only when none was added and one would add something.
  const next = o.original === 'unused'
    ? t('이 번들은 원본 파일을 받지 않는 방식입니다 — 원본 칸의 파일은 쓰지 않았습니다.',
      'This bundle was made by a rule that takes no original file — the file in the original slot was not used.')
    : r.witnessMode || o.original !== 'none' ? ''
      : o.subject?.kind === 'por-snapshot'
        ? t('이 스냅샷의 준비금 증명 파일을 함께 넣으면, 그 스냅샷이 앵커링된 것인지까지 확인합니다.',
          'Add this snapshot’s reserve proof file to also check that the snapshot is what was anchored.')
        : o.subject?.kind === 'remit-evidence'
          ? t('이 송금의 증빙을 함께 넣으면, 서명과 판정까지 확인합니다.',
            'Add this settlement’s evidence to also check the signatures and the verdict.')
          : o.subject || (o.scheme !== 'sha256-file' && !signed) ? ''
            : signed ? t('원본 문서를 함께 넣으면, 발급자가 서명한 그 문서인지까지 확인합니다.',
              'Add the original document to also check that it is the one the issuer signed.')
              : t('원본 문서를 함께 넣으면, 그 문서가 맞는지까지 확인합니다.',
                'Add the original document to also check that it is your document.');
  // The snapshot can be the anchored one while the two files give different ids: the id is in neither the
  // hash nor the snapshot. Said, so that two ids under one pass are not left to be wondered at.
  const idsDiffer = o.original === 'snapshot' && o.originalMatches && o.subject?.kind === 'por-snapshot'
    && o.snapshot?.snapshot_id && o.snapshot.snapshot_id !== o.subject.snapshotId
    ? t(`번들에 적힌 스냅샷 ID(${o.subject.snapshotId})와 준비금 증명 파일에 적힌 ID(${o.snapshot.snapshot_id})가 다릅니다 — ID는 해시에 들어 있지 않은 표시이며, 대조한 것은 스냅샷과 해시입니다.`,
      `The bundle gives snapshot id ${o.subject.snapshotId} and the reserve proof file gives ${o.snapshot.snapshot_id} — an id is a label outside the hash; what was compared is the snapshot and the hash.`)
    : '';
  const held = line(chip(a), esc(t('준비금 증명 파일의 스냅샷과 앵커링된 해시의 일치', 'The snapshot in the reserve proof file matches the anchored hash')), a);
  const checks: string[] = [];
  for (const c of r.checks) {
    if (c.id !== 'preimage') { checks.push(bundleLine(c)); continue; }
    // The verifier's "original" check, said for what it was in this bundle.
    if (o.original === 'snapshot') {
      checks.push(held);
    } else if (signed) {
      checks.push(line(chip(c.state), esc(UNHELD.signed), esc(c.state)));
    } else if (o.scheme === 'sha256-jcs-fields') {
      checks.push(line(chip(c.state), esc(t('번들에 적힌 항목들과 해시의 일치', 'The fields the bundle declares match the hash')), esc(c.state)));
    } else if (o.original === 'none') {
      // The verifier marks this line for attention when no original came with the bundle. Nothing is wrong:
      // the check was not run, which is what the tile above says of the same fact.
      checks.push(line(chip('skip'), esc(UNHELD[of]), 'skip'));
    } else {
      checks.push(bundleLine(c));
    }
  }
  if (o.original === 'snapshot' && !r.checks.some((c) => c.id === 'preimage')) checks.unshift(held);
  // What this page held the visitor's own file against, where the verifier does not look at it.
  if (o.original === 'document' && signed) {
    checks.push(line(chip(a), esc(t('넣은 문서와 선언문에 적힌 해시의 일치', 'The document you added matches the hash the statement names')), a));
  } else if (o.original === 'document' && r.witnessMode) {
    checks.push(line(chip(a), esc(t('넣은 문서와 트랜잭션 안의 문서의 일치', 'The document you added is the one inside the transaction')), a));
  }
  if (o.issuer) {
    // The key id is the statement's own word; what was checked is the signature against the key beside it.
    checks.push(line(chip(o.issuer.signature), `${esc(t('발급자 서명 — 선언문에 실린 공개키로 확인', 'The issuer’s signature — checked with the key the statement carries'))}${
      mono(o.issuer.problem ?? t(`${o.issuer.algorithm} · 선언문에 적힌 키 ID ${o.issuer.keyId}`, `${o.issuer.algorithm} · key id as the statement gives it: ${o.issuer.keyId}`))}`, o.issuer.signature));
  }
  // A bundle that ties its hash to no transaction holds less than it claims, whatever its other checks say.
  if (r.verified && !tied) {
    checks.push(line(chip('fail'), esc(t('해시가 트랜잭션에 들어 있는지 — 번들에 트랜잭션이 없거나 맞지 않습니다',
      'Whether the hash is inside a transaction — the bundle carries no transaction, or it does not match'))));
  }
  const unknown = o.schemeKnown ? '' : t(`번들에 적힌 해시 규칙(${o.scheme})을 이 화면은 알지 못합니다 — 원본과 대조하지 못했습니다.`,
    `The bundle names a hash rule this screen does not know (${o.scheme}) — nothing could be held against it.`);
  const small = [
    mispaired ? esc(pair) : esc(kind),
    mispaired ? esc(t('번들 자체의 검사는 통과했습니다.', 'The bundle’s own checks pass.')) : '',
    subjectLine(o.subject),
    o.unsigned ? esc(t('나머지 검사는 통과했습니다 — 이 콘솔을 HTTPS 주소로 열거나 SDK로 서명을 확인하십시오.',
      'The other checks pass — open this console at an HTTPS address, or check the signature with the SDK.')) : '',
  ].filter(Boolean).join(' ');
  return `${split({
    tone: o.verified ? 'ok' : o.unsigned ? 'wait' : 'bad',
    label: t('번들 검증', 'Bundle check'),
    title: o.verified ? t('성립합니다', 'It holds')
      : o.unsigned ? t('발급자 서명을 확인하지 못했습니다', 'The issuer’s signature could not be checked here')
        : mispaired ? t('넣은 파일은 이 번들이 고정한 것이 아닙니다', 'The file you added is not what this bundle anchors')
          : t('성립하지 않습니다', 'It does not hold'),
    small,
  }, [uncheckedBlock(r), ...(signed ? [{ title: t('서명한 키가 누구의 것인지', 'Whose key signed') }] : [])])}
    <div class="links">${LINKS.map(([k, label]) => {
      const state = k === 'A' ? a : (r.links[k] ?? 'skip');
      return `<div class="lk ${tone(state)}">${chip(state)}
        <b>${esc(label)}</b></div>`;
    }).join('')}</div>
    ${details(checks, !o.verified)}
    ${o.snapshot && o.originalMatches ? `${snapshotBox(o.snapshot, 'snapshot')}
    <p class="hint">${esc(t('원본 잔고 파일이 이 루트를 만드는지는 준비금 증명 파일과 원본 잔고 파일을 함께 넣어 확인합니다.',
    'Whether the original balance file makes this root is checked by adding the reserve proof file and the balance file together.'))}</p>` : ''}
    ${idsDiffer ? `<p class="hint">${esc(idsDiffer)}</p>` : ''}
    ${unknown ? `<p class="hint">${esc(unknown)}</p>` : ''}
    ${next && !unknown ? `<p class="hint" id="v-next">${esc(next)}</p>` : ''}`;
}

/** The names the evidence elements go by on the settlements screen. */
const ELEMENT = (): Record<string, string> => ({
  bankInstruction: t('은행 지시', 'Bank instruction'),
  bankApproval: t('은행 승인', 'Bank approval'),
  commercialDocs: t('상업 서류', 'Commercial documents'),
  travelRule: t('트래블룰', 'Travel rule'),
  chainTransfer: t('체인 전송', 'Chain transfer'),
  payoutReceipts: t('지급 영수증', 'Payout receipt'),
});
const AXIS = (): Record<string, string> => ({
  integrity: t('문서 무결성', 'Integrity'),
  issuer: t('발행 기관', 'Issuer'),
  matching: t('업무 대조', 'Matching'),
  completeness: t('서류 완비', 'Completeness'),
  regulatoryMapping: t('보고 항목', 'Regulatory mapping'),
  businessFinality: t('자금 확정', 'Business finality'),
});
const SIGNATURE = (): Record<string, { text: string; tone: Tone }> => ({
  VALID: { text: t('유효', 'valid'), tone: 'ok' },
  INVALID: { text: t('무효', 'invalid'), tone: 'bad' },
  UNKNOWN_KEY: { text: t('등록되지 않은 키', 'key not registered'), tone: 'bad' },
  ABSENT: { text: t('서명 없음', 'no signature'), tone: 'bad' },
  NOT_VERIFIED: { text: t('확인 안 함', 'not checked'), tone: 'inert' },
});

/**
 * Why a check on an evidence file could not be made, for a Korean reader.
 *
 * The checking module gives its reasons in English, as the SDK does on a
 * server; the line is shown as it is, because that is what the same file
 * produces there. Above it goes what it means, for the reasons a real file
 * can produce. English readers get the line alone.
 */
const REASON_KO: [RegExp, string][] = [
  [/^not re-evaluated/, t('서명을 확인하지 못해 판정을 다시 계산하지 않았습니다', '')],
  [/^the verdict would depend on the machine/, t('판정에 쓰이는 시각에 시간대가 적혀 있지 않아, 계산하는 기계에 따라 판정이 달라집니다', '')],
  [/^the package carries no evidence element/, t('증빙에 서명된 항목이 하나도 없습니다', '')],
  [/^the signing key of /, t('증빙에 실린 서명 공개키 가운데 읽을 수 없는 것이 있습니다', '')],
  [/^the nonce is not/, t('증빙의 난수가 올바른 형식이 아닙니다', '')],
  [/ is missing$/, t('증빙에 있어야 할 항목이 빠져 있습니다', '')],
];
const reason = (problem: string): string => {
  const ko = REASON_KO.find(([re]) => re.test(problem))?.[1] ?? '';
  return `${ko ? `<span class="vko">${esc(ko)}</span>` : ''}${mono(problem)}`;
};

/**
 * A settlement's evidence: four checks, reported one by one.
 *
 * The fourth is the bundle. An evidence file downloaded before its anchor
 * was confirmed carries none, and that is a fact about the file — it is said
 * as "no bundle", never as an anchor that has not confirmed, which this page
 * cannot know. With one, what is checked is that the hash is inside the
 * transaction the bundle carries; whether that transaction is in a block is
 * the thing not checked.
 */
export function evidenceHtml(o: EvidenceOutcome, spare: boolean): string {
  const r: EvidenceCheckReport = o.report;
  const rest = r.commitment.ok && r.signatures.ok && r.verdict.ok;
  const anchor = o.anchor === 'pending' ? 'none' : o.anchor;
  const bare = rest && anchor === 'none';
  const holds = rest && anchor === 'pass';
  const state = (ok: boolean): string => (ok ? 'pass' : 'fail');
  const tiles: [string, string][] = [
    [state(r.commitment.ok), t('증빙 내용이 증빙에 적힌 해시와 맞습니까', 'Does the evidence match the hash it states?')],
    [state(r.signatures.ok), t('서명이 증빙에 실린 기관 서명 공개키로 검증됩니까', 'Do the signatures verify with the institutions’ signing public keys the evidence carries?')],
    [state(r.verdict.ok), t('판정을 다시 계산해도 같습니까', 'Does the verdict come out the same when computed again?')],
    [anchor, t('그 해시가 번들에 실린 트랜잭션에 들어 있습니까', 'Is that hash inside the transaction the bundle carries?')],
  ];
  const lines: string[] = [];
  lines.push(line(chip(state(r.commitment.ok)), `${esc(t('증빙 내용과 증빙에 적힌 해시의 일치', 'The evidence matches the hash it states'))}${
    r.commitment.ok ? '' : r.commitment.problem ? reason(r.commitment.problem)
      : mono(t(`다시 계산한 값 ${short(r.commitment.computed ?? '—')} · 증빙에 적힌 값 ${short(r.commitment.stated ?? '—')}`,
        `computed ${short(r.commitment.computed ?? '—')} · stated ${short(r.commitment.stated ?? '—')}`))}`));
  for (const e of r.signatures.elements) {
    const s = Object.hasOwn(SIGNATURE(), e.status) ? SIGNATURE()[e.status]! : { text: e.status, tone: 'bad' as Tone };
    lines.push(line(`<span class="chip ${s.tone}">${esc(s.text)}</span>`, esc(t(`${named(ELEMENT(), e.element)} 서명`, `${named(ELEMENT(), e.element)} signature`))));
  }
  if (r.signatures.problem) lines.push(line(chip('fail'), `${esc(t('기관 서명', 'Institution signatures'))}${reason(r.signatures.problem)}`));
  const axes = (m: Record<string, string>): string => Object.entries(m).map(([k, s]) => `${named(AXIS(), k)} ${s}`).join(' · ');
  lines.push(line(chip(state(r.verdict.ok)), `${esc(t('다시 계산한 판정과 플랫폼 판정의 일치', 'The verdict computed here equals the platform’s'))}${
    r.verdict.ok && r.verdict.mine ? mono(axes(r.verdict.mine))
      : r.verdict.problem ? reason(r.verdict.problem)
        : r.verdict.mine && r.verdict.theirs ? `${mono(t(`이 화면 ${axes(r.verdict.mine)}`, `here ${axes(r.verdict.mine)}`))}${mono(t(`플랫폼 ${axes(r.verdict.theirs)}`, `platform ${axes(r.verdict.theirs)}`))}` : ''}`));
  if (anchor === 'none') {
    lines.push(line(chip('none'), esc(t('앵커 번들 — 이 증빙에는 번들이 들어 있지 않습니다', 'Anchor bundle — this evidence carries none'))));
  } else {
    if (r.anchor.ok && anchor === 'fail') {
      lines.push(line(chip('fail'), esc(t('해시가 트랜잭션에 들어 있는지 — 번들에 트랜잭션이 없거나 맞지 않습니다',
        'Whether the hash is inside a transaction — the bundle carries no transaction, or it does not match'))));
    }
    lines.push(line(chip(state(r.anchor.leafMatches === true)), esc(t('번들이 고정한 해시가 이 증빙의 해시임', 'The hash the bundle anchors is this evidence’s'))));
    // The bundle's own "original" check is about a document handed in beside it; here the evidence is the
    // original, and the first line of this list has already held it against the hash.
    for (const c of r.anchor.bundle?.checks ?? []) if (c.id !== 'preimage') lines.push(bundleLine(c));
    if (r.anchor.problem) lines.push(line(chip('fail'), `${esc(t('번들 검사', 'Bundle check'))}${reason(r.anchor.problem)}`));
  }
  const notes = [
    o.given?.matches ? t('함께 넣은 번들을 이 증빙의 앵커로 확인했습니다.', 'The bundle you added beside it was checked as this evidence’s anchor.') : '',
    spare ? t('원본 칸의 파일은 쓰지 않았습니다 — 송금 증빙은 파일 하나로 검증됩니다.', 'The file in the original slot was not used — a settlement’s evidence is checked on its own.') : '',
  ].filter(Boolean);
  // A bundle of another record beside the evidence is a mistake in the pairing, and is said first and as that:
  // it is nothing against the evidence, which is then reported as it came.
  const mispaired = o.given && !o.given.matches ? boxHtml('bad', t('함께 넣은 번들은 이 증빙의 것이 아닙니다', 'The bundle you added is not this evidence’s'), [
    `${esc(t('번들이 고정한 해시가 이 증빙의 해시와 다릅니다.', 'The hash the bundle anchors is not this evidence’s.'))} ${subjectLine(o.given.subject)}`,
    esc(t('아래는 증빙만으로 한 검사입니다 — 그 번들은 쓰지 않았습니다.', 'What follows is the check of the evidence alone — that bundle was not used.')),
  ], 'v-pair') : '';
  // Whose keys: the signatures were verified with the keys the evidence itself carries, which shows the file
  // is consistent with them, not that they are those institutions' own.
  const keys: Unchecked = { title: t('서명 공개키가 실제 그 기관의 것인지', 'Whether the signing public keys are those institutions’ own') };
  return `${mispaired}${split({
    tone: holds ? 'ok' : bare ? 'wait' : 'bad',
    label: t('송금 증빙 검증', 'Settlement evidence check'),
    title: holds ? t('성립합니다', 'It holds')
      : bare ? t('앵커 번들이 없는 증빙입니다', 'This evidence carries no anchor bundle') : t('성립하지 않습니다', 'It does not hold'),
    small: r.subject.paymentId ? `${esc(t(`송금 ${r.subject.paymentId}`, `Settlement ${r.subject.paymentId}`))} <span class="dim">${esc(t('— 증빙에 적힌 내용', '— as the evidence gives it'))}</span>` : '',
  }, anchor === 'none' ? [{
    title: t('이 증빙의 앵커', 'This evidence’s anchor'),
    small: esc(t('증빙을 다시 내려받거나, 앵커링 기록에서 이 송금의 번들을 내려받아 함께 넣으십시오.',
      'Download the evidence again, or take this settlement’s bundle from Records and add it beside the evidence.')),
  }, keys] : [uncheckedBlock(r.anchor.bundle), keys])}
    <div class="links">${tiles.map(([s, label]) => `<div class="lk ${tone(s)}">${chip(s)}
        <b>${esc(label)}</b></div>`).join('')}</div>
    ${details(lines, !holds)}
    ${notes.map((n) => `<p class="hint">${esc(n)}</p>`).join('')}`;
}

/** A reserve proof file with nothing to hold it against: it gives a snapshot, and that is all. */
export function snapshotAloneHtml(proof: PorSnapshotProof): string {
  return `${boxHtml('wait', t('원본 잔고 파일을 함께 넣으십시오', 'Add the original balance file'), [
    esc(t('준비금 증명 파일만으로는 확인할 것이 없습니다 — 아래는 파일에 적힌 내용입니다.',
      'A reserve proof file alone gives nothing to check — below is what the file says.')),
  ])}
    ${snapshotBox(proof, 'nothing')}`;
}

/** Each thing that differed between what the proof file gives and what the balance file rebuilt, as markup. */
function mismatchLines(proof: PorSnapshotProof, m: SnapshotMismatch, sameFile: boolean): string[] {
  const decimals = new Map(proof.statement.assets.map((a) => [a.symbol, a.decimals]));
  const lines: string[] = [];
  if (m.root[0] !== m.root[1]) {
    lines.push(`<b>${esc(t('머클 루트', 'Merkle root'))}</b> · ${esc(t('잔고 파일로 다시 계산한 루트가 준비금 증명 파일에 적힌 루트와 다릅니다', 'the root rebuilt from the balance file is not the one the reserve proof file gives'))}`
      + `${mono(`${t('준비금 증명 파일', 'reserve proof file')} ${m.root[0]}`)}${mono(`${t('잔고 파일', 'balance file')} ${m.root[1] || '—'}`)}`);
  }
  if (m.accounts[0] !== m.accounts[1]) {
    lines.push(`<b>${esc(t('계정 수', 'Accounts'))}</b> · ${esc(t(`준비금 증명 파일 ${grouped(m.accounts[0])}개, 잔고 파일 ${grouped(m.accounts[1])}개`,
      `${grouped(m.accounts[0])} in the reserve proof file, ${grouped(m.accounts[1])} in the balance file`))}`);
  }
  for (const [asset, [stated, got]] of Object.entries(m.totals)) {
    const d = decimals.get(asset) ?? 0;
    lines.push(`<b>${esc(asset)} ${esc(t('총액', 'total'))}</b> · ${esc(t(`준비금 증명 파일 ${fromBaseUnits(stated, d)}, 잔고 파일 ${fromBaseUnits(got, d)}`,
      `${fromBaseUnits(stated, d)} in the reserve proof file, ${fromBaseUnits(got, d)} in the balance file`))}`);
  }
  lines.push(sameFile ? sameFileLine() : esc(t(`준비금 증명 파일에 기록된 원본은 ${proof.source.file} (${grouped(proof.source.bytes)}바이트)입니다 — 지금 넣은 파일은 내용이 다릅니다.`,
    `The reserve proof file was written for ${proof.source.file} (${grouped(proof.source.bytes)} bytes) — the file added now has different contents.`)));
  return lines;
}

/** The balance file is the recorded one, so what changed is the proof file. */
const sameFileLine = (): string => esc(t('잔고 파일은 준비금 증명 파일에 기록된 그 파일입니다(SHA-256 일치) — 준비금 증명 파일의 내용이 바뀌었습니다.',
  'The balance file is the one the reserve proof file records (same SHA-256) — it is the proof file that has been changed.'));

/**
 * A reserve proof file and a balance file: whether the two still make the
 * snapshot the proof file gives.
 *
 * The pair is held against itself. Nothing here was held against an anchor,
 * so no line says "anchored": that is the thing listed as not checked.
 */
export function snapshotHtml(o: SnapshotOutcome): string {
  const proof = o.proof;
  const src = proof.source;
  if (o.result === 'match') {
    return `${split({
      tone: 'ok',
      label: t('준비금 증명 검증', 'Reserve proof check'),
      title: t('원본과 일치합니다', 'The original matches'),
      small: esc(t('잔고 파일로 다시 계산한 루트·총액·계정 수가 준비금 증명 파일에 적힌 값과 같습니다.',
        'The root, the totals and the account count rebuilt from the balance file are the ones the reserve proof file gives.')),
    }, [{
      title: t('이 스냅샷이 앵커링되었는지', 'Whether this snapshot was anchored'),
      small: esc(t('앵커링 기록에서 이 스냅샷의 번들을 내려받아 준비금 증명 파일과 함께 넣으면 번들의 트랜잭션까지 확인합니다.',
        'Take this snapshot’s bundle from Records and add it with the reserve proof file to check as far as the bundle’s transaction.')),
    }])}
    ${snapshotBox(proof, 'tree')}`;
  }
  const altered = t('불일치 — 준비금 증명 파일이 내려받은 뒤 바뀌었습니다', 'No match — the reserve proof file has been changed since it was downloaded');
  if (o.result === 'mismatch') {
    return boxHtml('bad', o.sameFile ? altered : t('원본 불일치 — 이 잔고 파일은 준비금 증명 파일에 적힌 스냅샷을 만들지 않습니다', 'No match — this balance file does not make the snapshot the reserve proof file gives'),
      mismatchLines(proof, o.mismatch, o.sameFile));
  }
  if (o.result === 'too_many_rows') {
    return boxHtml('bad', t('원본 불일치 — 이 파일은 준비금 증명 파일에 적힌 스냅샷의 잔고 파일이 아닙니다', 'No match — this is not the balance file of the snapshot the reserve proof file gives'), [
      esc(t(`준비금 증명 파일의 스냅샷은 계정 ${grouped(o.accounts)}개인데, 이 파일에는 그보다 훨씬 많은 줄이 있습니다.`,
        `The reserve proof file’s snapshot has ${grouped(o.accounts)} accounts; this file has far more rows than that.`)),
    ]);
  }
  if (o.result === 'too_large') {
    return boxHtml('bad', t(
      `이 화면이 다루기에는 큽니다 — 계정 ${grouped(o.accounts)}개, 자산 ${grouped(o.assets)}개. 이 크기의 스냅샷은 SDK로 확인하십시오.`,
      `Too large for this screen — ${grouped(o.accounts)} accounts over ${grouped(o.assets)} assets. Check a snapshot of this size with the SDK.`), []);
  }
  if (o.result === 'failed') return boxHtml('bad', t('스냅샷을 다시 만들 수 없습니다.', 'The snapshot could not be rebuilt.'), [mono(o.message)]);
  if (o.why === 'not_text') return boxHtml('bad', t('원본 잔고 파일이 아닙니다 — UTF-8 파일이 아닙니다.', 'This is not the original balance file — it is not UTF-8.'), []);
  if (o.why === 'reader_failed') return boxHtml('bad', t('원본 잔고 파일을 읽을 수 없습니다.', 'The original balance file could not be read.'), [mono(o.message)]);
  // Not a file to be fixed — the original is wanted — so the reader's first line is given as it is, and no more.
  return boxHtml('bad', o.sameFile ? altered : t('원본 불일치 — 넣은 파일을 준비금 증명 파일에 기록된 형식의 잔고 파일로 읽을 수 없습니다', 'No match — the file you added does not read as a balance file of the shape the reserve proof file records'), [
    o.sameFile ? sameFileLine() : esc(t(`준비금 증명 파일에 기록된 원본은 ${src.file} (${grouped(src.bytes)}바이트, ${shapeName(src.layout)})입니다.`,
      `The reserve proof file was written for ${src.file} (${grouped(src.bytes)} bytes, ${shapeName(src.layout)}).`)),
    ...(o.message ? [mono(o.message)] : []),
  ]);
}

/** What is wrong with a reserve proof file that cannot be read, for a Korean reader; the SDK's own lines go beneath. */
function unreadableProof(e: SnapshotProofError | undefined): string {
  return e?.code === 'unsupported_version'
    ? t('이 화면이 읽지 못하는 버전의 준비금 증명 파일입니다.', 'This reserve proof file is of a version this screen does not read.')
    : t('준비금 증명 파일이 손상되었습니다 — 내려받은 그대로의 파일을 넣으십시오.', 'The reserve proof file is damaged — choose the file as it was downloaded.');
}

/** Nothing was checked, and why. */
export function refusalHtml(plan: Extract<Plan, { check: 'none' }>): string {
  switch (plan.why) {
    case 'account_proof':
      return boxHtml('wait', t('계정 증명 파일입니다', 'This is an account’s proof file'), [
        t('계정의 주인이 스냅샷 ID와 함께 <a href="/playground/por.html" target="_blank" rel="noopener">공개 검증 페이지 ↗</a>에 넣어 확인하는 파일입니다. 이 화면은 스냅샷의 준비금 증명 파일(por-proof-….json)을 확인합니다.',
          'It is the file an account’s holder puts into the <a href="/playground/por.html" target="_blank" rel="noopener">public verify page ↗</a> with the snapshot id. This screen checks a snapshot’s reserve proof file (por-proof-….json).'),
      ]);
    case 'snapshot_unreadable':
      return boxHtml('bad', unreadableProof(plan.error),
        (plan.error ? (plan.error.problems.length > 0 ? plan.error.problems : [plan.error.message]) : []).map(mono));
    case 'two_of_a_kind':
      return boxHtml('bad', t('같은 종류의 파일이 두 개입니다', 'The two files are of the same kind'), [
        esc(t('검증할 파일 하나와, 그 짝이 되는 원본을 넣으십시오.', 'Add one file to check, and the original that goes with it.')),
      ]);
    case 'no_pair':
      return boxHtml('bad', t('짝이 맞지 않는 두 파일입니다', 'These two files do not go together'), [
        esc(has('por')
          ? t('한 번에 한 가지만 넣으십시오 — 번들과 그 짝이 되는 파일, 또는 준비금 증명 파일과 원본 잔고 파일.',
            'Add one thing at a time — a bundle and the file that goes with it, or a reserve proof file and the original balance file.')
          : t('한 번에 한 가지만 넣으십시오 — 번들과 그 짝이 되는 파일.', 'Add one thing at a time — a bundle and the file that goes with it.')),
      ]);
    default:
      return boxHtml('bad', t('검증할 수 있는 파일이 아닙니다', 'This is not a file this screen checks'), [
        esc(t(`이 콘솔에서 내려받은 파일을 넣으십시오 — ${kinds().join(', ')}.`, `Add a file downloaded from this console — ${kinds().join(', ')}.`)),
      ]);
  }
}
