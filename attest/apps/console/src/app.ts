/**
 * The Sandbox Console.
 *
 * Two screens: a sign-in gate and a dashboard. No bundler, no framework, one
 * `tsc` pass — the same construction as the Playground and the Developer Hub,
 * and for the same reason: this is the screen where a prospective customer
 * decides whether the product is what it says, and the code behind it should be
 * readable in devtools while they look.
 *
 * ## What it deliberately does not store
 *
 * The secret key is shown once, when it is minted, and is never written to
 * `localStorage` or kept in a variable past the render that displays it. The
 * service only stores its hash, so nothing here can recover it later either —
 * and a console that quietly cached a customer's key in their browser would be
 * making a decision on their behalf that the rest of the design refuses to.
 */
import { api, ApiError, digestFile } from './api.ts';
import { applyLang, lang, langToggle, t, translateStatic } from './i18n.ts';
import type { ApiKey, Attestation, AuditEntry, IssuerKey, Overview, Quota } from './api.ts';
import { p256KeypairFromSeed } from './vendor/attest-verify/p256.ts';
import { initPor, porUntaken, resetPor, sectionPor } from './por.ts';
import { sectionVerify, wireVerify } from './verify.ts';
import { documentSigningRequest, checkDocumentSignature } from './document-signing.ts';
import type { SignedStatement, StatementCore } from './vendor/attest-verify/index.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const short = (hex: string, n = 10): string =>
  hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-n)}` : hex;

const when = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};

interface State {
  overview: Overview | null;
  attestations: Attestation[];
  /** null until the key list has been fetched for this screen. */
  keys: ApiKey[] | null;
  /** Held only between minting a key and the render that shows it. */
  freshKey: string | null;
  /**
   * The products this organisation subscribes to. null until asked, and when
   * the answer could not be had — the menu then lists every product, so a
   * read that failed never hides a screen.
   */
  products: Set<string> | null;
}
const st: State = { overview: null, attestations: [], keys: null, freshKey: null, products: null };

// ── status chips ───────────────────────────────────────────────────────────

/**
 * The lifecycle, as the stage actually reached.
 *
 * `confirmed` is the only state that gets the brand colour. Everything before
 * it is in progress and renders neutral — an `accepted` record shown in green
 * would tell the reader their document was on the chain when it is sitting in a
 * batch that has not been sealed.
 */
function statusChip(status: string): string {
  const cls = status === 'confirmed' ? 'ok' : status === 'submitted' ? 'wait' : 'inert';
  return `<span class="chip ${cls}">${esc(status)}</span>`;
}

function quotaBar(q: Quota): string {
  const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
  return `
    <div class="quota">
      <div class="qhead">
        <span>${q.used.toLocaleString()} / ${q.limit.toLocaleString()} this month</span>
        <span class="dim">resets ${when(q.resets)}</span>
      </div>
      <div class="qbar"><div class="qfill${pct >= 100 ? ' full' : ''}" data-pct="${pct}" data-used="${q.used}"></div></div>
    </div>`;
}

// ── the gate ───────────────────────────────────────────────────────────────

function showGate(mode: 'login' | 'signup', message?: string): void {
  $('shell').hidden = true;
  $('topright').hidden = true;
  $('gate-main').hidden = false;
  $('gate').hidden = false;
  const signup = mode === 'signup';

  $('gate-form').innerHTML = `
    <h1>${signup ? t('샌드박스 계정 만들기', 'Create a sandbox account') : t('로그인', 'Sign in')}</h1>
    <p class="lede">${signup
      ? t('승인 대기도 영업 상담도 없습니다. 가입하시면 API 키가 바로 발급되고, 예시 기록 한 건이 함께 들어 있습니다.',
          'Instant and ungated — no approval queue and no sales call. You get an API key and a worked example immediately.')
      : t('샌드박스 계정 전용입니다. 운영 환경 접근은 계약에 따라 별도로 제공됩니다.',
          'Sandbox accounts only. Production access is provisioned per contract.')}</p>
    ${message ? `<div class="note bad">${esc(message)}</div>` : ''}
    <label>${t('이메일', 'Email')}<input type="email" id="f-email" autocomplete="username" required></label>
    <label>${t('비밀번호', 'Password')}<input type="password" id="f-password"
      autocomplete="${signup ? 'new-password' : 'current-password'}" required
      minlength="10"></label>
    ${signup ? `<p class="hint">${t(
      '10자 이상. 이 배포는 메일을 보내지 않아 비밀번호를 재설정할 방법이 없으니, 따로 보관해 두십시오.',
      'At least 10 characters. There is no password reset on this deployment — no mail is sent from it — so use something you can retrieve.')}</p>` : ''}
    <button class="btn" id="f-submit">${signup ? t('계정 만들기', 'Create account') : t('로그인', 'Sign in')}</button>
    <p class="swap">${signup
      ? t('이미 계정이 있으십니까? <a href="#login">로그인</a>', 'Already have one? <a href="#login">Sign in</a>')
      : t('계정이 없으십니까? <a href="#signup">계정 만들기</a>', 'No account? <a href="#signup">Create one</a>')}</p>`;

  const submit = $('f-submit') as HTMLButtonElement;
  const run = async (): Promise<void> => {
    const email = ($('f-email') as HTMLInputElement).value.trim();
    const password = ($('f-password') as HTMLInputElement).value;
    submit.disabled = true;
    submit.textContent = signup ? t('만드는 중…', 'Creating…') : t('로그인 중…', 'Signing in…');
    try {
      const overview = signup ? await api.signup(email, password) : await api.login(email, password);
      // Whoever was signed in before in this tab: their balance file, result, proof file and session key go.
      resetPor();
      st.overview = overview;
      // Captured now and cleared by the render that shows it — see `showKeyOnce`.
      st.freshKey = overview.api_key_secret ?? null;
      await Promise.all([loadAttestations(), loadSubscriptions()]);
      /*
       * Drop the gate's `#signup` / `#login` without an event, and before the
       * render. Assigning `location.hash` fired hashchange, the route listener
       * rendered the dashboard a second time, and that render no longer had
       * the key the first had just shown — so the one-time panel vanished
       * within a frame and nobody who signed up through this form saw a key.
       */
      history.replaceState(null, '', location.pathname + location.search);
      showDashboard();
    } catch (e) {
      showGate(mode, e instanceof ApiError ? e.message : String(e));
      // Keep the address so a mistyped password does not cost it.
      ($('f-email') as HTMLInputElement).value = email;
      ($('f-password') as HTMLInputElement).focus();
    }
  };

  submit.addEventListener('click', () => { void run(); });
  for (const id of ['f-email', 'f-password']) {
    $(id).addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') void run();
    });
  }
}

// ── the dashboard ──────────────────────────────────────────────────────────

/**
 * The one-time key panel.
 *
 * Rendered only when a key was just minted, and the value is dropped from
 * state as soon as it is written to the DOM. There is no "show key again"
 * because there is nothing to show it from: the service holds a hash.
 *
 * Which means nothing may render the dashboard a second time on the way in:
 * that render has no key, and the panel goes. Leaving the gate therefore
 * clears its fragment with `replaceState`, which fires no hashchange.
 */
function showKeyOnce(): string {
  if (!st.freshKey) return '';
  const key = st.freshKey;
  st.freshKey = null;
  return `
    <section class="card urgent">
      <h2>${t('발급된 API 키', 'Your new API key')}</h2>
      <p>${t(
        '지금 복사해 두십시오. <b>다시 확인할 수 없습니다</b> — 해시만 저장되므로 저희를 포함해 누구도 '
          + '이 키를 다시 보여 드릴 수 없습니다. 잃어버리셨다면 새 키를 발급하고 이 키는 폐기하십시오.',
        'Copy this now. <b>It is not recoverable</b> — only its hash is stored, so '
          + 'nobody, including us, can show it to you again. Lose it and rotate.')}</p>
      <div class="keyrow">
        <code class="keyval" id="keyval">${esc(key)}</code>
        <button class="btn ghost" id="copy-key">${t('복사', 'Copy')}</button>
      </div>
    </section>`;
}

/**
 * Four sections, one errand each, in one flat list.
 *
 * Everything used to live on a single scroll: whether the product does what
 * it claims, and how to rotate a key, separated by a horizontal rule. That
 * reads as a settings page with a demo embedded in it, and it buries the one
 * thing a prospective customer came to find out.
 *
 *   앵커링      — put a document on the chain, by one of two routes
 *   앵커링 기록 — what was anchored, and what the node says about it now
 *   검증        — take a bundle back and check it against Bitcoin
 *   연동        — the key, the calls this page actually made, cURL, errors
 *   계정        — who you are here, how much is left, how to leave
 *
 * Anchoring and its history were one screen until the record list grew a
 * per-transaction view of the chain. Two errands — "put this on Bitcoin" and
 * "what happened to the things I put there" — were sharing a scroll, and the
 * form kept getting pushed above a table that was the reason most visits
 * happen at all.
 *
 * Four items do not need headings above them. 작업 / 설정 / 참고 filed these
 * into groups of two, one and one — taxonomy for its own sake, since each
 * label already says which errand it is, and the headings only pushed the
 * first item further down the sidebar.
 *
 * Nine items are a different list, and they are not all one kind: six are
 * work done with a product, three are the organisation's own administration
 * — what it subscribes to, the keys it holds, the record of what was called.
 * 구독 sat among the products and read as one of them. A rule marks where the
 * kind changes (`ORG_FROM`); still no headings, for the reason above.
 *
 * Of the six, three are a product's own screen and three belong to every
 * product: the dashboard, 앵커링 기록 and 검증. Whatever a product anchors
 * is listed in the one record, and whatever file it hands out is checked on
 * the one screen — a check that lived on one product's page was missing
 * from the others'.
 *
 * Anchoring leads: it is the errand the product exists for, and the rest of
 * the console is about trusting, wiring up or administering what it produced.
 *
 * The route is a hash so a section can be linked to and survives a reload.
 * An unknown value falls back to whichever section leads rather than to one
 * named here, so the order and the landing cannot drift apart.
 */
const SECTIONS = [
  {
    id: 'home', label: t('대시보드', 'Dashboard'),
    icon: '<rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1"/>',
  },
  // Settlements sit right under the dashboard: for a bank this is the screen
  // the console exists for, and anchoring is what happens behind it.
  {
    id: 'remit', label: t('송금', 'Settlements'),
    icon: '<path d="M2.5 6h9l-2-2M13.5 10h-9l2 2"/>',
  },
  // Reserve snapshots sit beside settlements: the two product screens, then
  // the anchoring they both end in.
  {
    id: 'por', label: t('준비금 증명', 'Proof of Reserves'),
    icon: '<path d="M8 2.4 13 4.6v3.6c0 2.9-2.1 4.6-5 5.4-2.9-.8-5-2.5-5-5.4V4.6z"/><path d="m5.9 8.1 1.5 1.5 2.8-2.9"/>',
  },
  {
    // 문서 앵커링, not 앵커링: a settlement's evidence and a reserve snapshot
    // are anchored too, so the bare word no longer names this product alone.
    id: 'anchor', label: t('문서 앵커링', 'Document anchoring'),
    // Inline, because the console ships under `style-src 'self'` and an icon
    // font would be one more request on a page that makes none.
    icon: '<path d="M8 5.5V14"/><circle cx="8" cy="3.6" r="1.9"/><path d="M3 9.2a5 5 0 0 0 10 0"/>',
  },
  {
    id: 'records', label: t('앵커링 기록', 'Records'),
    icon: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  },
  // Checking a downloaded proof is common to every product, as the record
  // list is: it sat at the foot of 문서 앵커링, where an organisation that
  // anchors no document never came.
  {
    id: 'verify', label: t('검증', 'Verify'),
    icon: '<circle cx="7" cy="7" r="4.4"/><path d="m10.3 10.3 3.2 3.2"/><path d="m5.2 7.1 1.3 1.3 2.3-2.5"/>',
  },
  {
    id: 'products', label: t('구독', 'Subscriptions'),
    icon: '<rect x="2.5" y="5" width="11" height="8" rx="1.5"/><path d="M5.5 5V3.5h5V5"/>',
  },
  {
    id: 'integrate', label: t('연동', 'Integrate'),
    icon: '<path d="M6 10.5 3.5 8 6 5.5"/><path d="m10 5.5 2.5 2.5L10 10.5"/>',
  },
  {
    id: 'audit', label: t('감사 기록', 'Audit log'),
    icon: '<path d="M4 2.5h8v11H4z"/><path d="M6 6h4M6 8.5h4M6 11h2.5"/>',
  },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

const routeOf = (): SectionId => {
  // `#/remit?state=EXCEPTION`: a section can be linked to already narrowed,
  // so the route is what precedes the query and the section reads the rest.
  const want = location.hash.replace(/^#\/?/, '').split('?')[0]!;
  return SECTIONS.some((x) => x.id === want) ? want as SectionId : SECTIONS[0]!.id;
};

/** What follows `?` in the hash, for the section that reads it. */
const routeQuery = (): URLSearchParams => new URLSearchParams(location.hash.split('?')[1] ?? '');

/** The first of the organisation's own sections; the sidebar draws a rule above it. */
const ORG_FROM: SectionId = 'products';

/**
 * The product a section is the screen of.
 *
 * Anchoring is in every product — a settlement's evidence, a reserve snapshot
 * and a document all end on the chain — so it is not what tells the products
 * apart; what the customer does with each is. A section named here is listed
 * in the menu only for an organisation that subscribes to its product, as the
 * dashboard already draws only those products' rows. 앵커링 기록 is not named:
 * it is the one record of what every product anchored. A product added later
 * (token issuance) takes one entry here and one in `PRODUCTS`.
 */
type ProductId = 'attest' | 'remit' | 'por';
const SECTION_PRODUCT: Partial<Record<SectionId, ProductId>> = { remit: 'remit', por: 'por', anchor: 'attest' };

/** Whether the menu lists a section for this organisation. */
const inMenu = (id: SectionId): boolean => {
  const product = SECTION_PRODUCT[id];
  return !product || !st.products || st.products.has(product);
};

/**
 * The menu itself, apart from the masthead beside it.
 *
 * Drawn on its own because a subscription can change while a screen is open
 * — 구독 activates a product — and the menu has to follow without the
 * masthead being rebuilt under the listener `wireDashboard` put on it.
 */
function renderSections(): void {
  const here = routeOf();
  // The section on screen stays listed even when its product is not
  // subscribed: a link or a typed address can still lead there, and the menu
  // has to say where the reader is.
  $('sections').innerHTML = SECTIONS.filter((x) => inMenu(x.id) || x.id === here).map((x) => `${x.id === ORG_FROM ? '<span class="navsep" role="separator"></span>' : ''}
    <a class="sec ${x.id === here ? 'on' : ''}" href="#/${x.id}"
       ${x.id === here ? 'aria-current="page"' : ''}>
      <svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor"
           stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">${x.icon}</svg>
      <span>${esc(x.label)}</span>
    </a>`).join('');
}

/**
 * Take the subscription list a screen has just read, for the menu.
 *
 * Read at sign-in, and again wherever the list is fetched anyway — the
 * dashboard and 구독 — so activating a product puts its screen in the menu
 * without a reload.
 */
function noteProducts(prod: { products: { product: string; status: string }[] }): void {
  // An answer that arrives after sign-out belongs to nobody: kept, it would
  // be the next account's menu until that account's own answer came.
  if (!st.overview) return;
  const next = new Set(prod.products.filter((x) => x.status === 'active').map((x) => x.product));
  const was = st.products;
  st.products = next;
  const same = was !== null && was.size === next.size && [...next].every((p) => was.has(p));
  if (!same && !$('shell').hidden) renderSections();
}

async function loadSubscriptions(): Promise<void> {
  try {
    noteProducts(await api.products());
  } catch {
    // Not known, so not assumed: the menu lists every product — see `State.products`.
    st.products = null;
  }
}

function renderNav(): void {
  renderSections();

  /*
   * Identity and the chain, in the masthead.
   *
   * The network chip stays in the masthead, and since the 샌드박스가 증명할 수
   * 있는 것 card came out it is the dashboard's only standing statement of
   * which chain this is. That is the reason it is not in the account dropdown:
   * a caveat the reader must open something to find is not a caveat. The
   * sentence spelling out what regtest costs still greets them at the gate,
   * before they decide to sign up at all.
   *
   * `<details>` rather than a scripted dropdown: it opens, closes and handles
   * the keyboard without any of that being written here, and it needs no
   * inline style, which the page's policy blocks.
   */
  const o = st.overview!;
  const mainnet = o.bitcoin_network === 'mainnet';
  $('topright').hidden = false;
  $('topright').innerHTML = `
    <span class="netchip">
      <span class="chip ${mainnet ? 'ok' : 'wait'}">${esc(o.bitcoin_network.toUpperCase())}</span>
    </span>
    <details class="acct">
      <summary>${esc(o.account.email)} <span class="caret" aria-hidden="true">⌄</span></summary>
      <div class="acctmenu">
        <dl>
          <dt>${t('조직', 'Organisation')}</dt><dd class="mono">${esc(o.org.slug)}</dd>
          <dt>${t('가입', 'Joined')}</dt><dd>${when(o.account.created_at)}</dd>
          <dt>${t('마지막 로그인', 'Last sign-in')}</dt><dd>${when(o.account.last_login_at)}</dd>
          <dt>${t('API 키', 'API key')}</dt><dd class="mono">${o.api_key ? `${esc(o.api_key.prefix)}…` : t('없음', 'none')}</dd>
        </dl>
        <a class="acctlink" href="#/integrate">${t('연동 · API 키 관리', 'Integrate · API keys')}</a>
        <button class="btn ghost" id="sign-out">${t('로그아웃', 'Sign out')}</button>
      </div>
    </details>`;

  // The API reference is linked where the work happens — the Integrate
  // section and each product card — rather than as a masthead item.
}

/**
 * Two ways onto the chain, and they are not the same promise.
 *
 * The difference is what leaves the browser, so the screen is split at
 * exactly that line rather than offering one file picker with a checkbox:
 *
 *   **해시만**   the file is hashed here; 32 bytes go to the server.
 *   **원본**     the file is sent, inscribed into a Bitcoin transaction's
 *               witness, and released. The document becomes public — that is
 *               the feature, not a side effect — and it is permanent.
 *
 * The second is irreversible in a way the first is not, so it states the
 * consequence on the control itself and asks again before sending. A reader
 * who skims the headings still cannot confuse the two.
 */
/** The hash-only path. Rendered on its own when inscription is unavailable. */
function digestModeCard(): string {
  return `
      <section class="card mode safe">
        <div class="mh"><span class="chip ok">${t('해시만 전송', 'Hash only')}</span>
          <b>${t('문서는 기기를 떠나지 않습니다', 'The document never leaves your machine')}</b></div>
        <p>${t(
          '파일을 고르면 <b>이 브라우저에서</b> SHA-256이 계산되고, 서버로는 32바이트 해시값만 갑니다.',
          'Pick a file and its SHA-256 is computed <b>in this browser</b>; only the 32-byte hash is sent.')}</p>

        <label class="drop" id="drop">
          <input type="file" id="file" hidden>
          <span class="dk">${t('문서 고르기', 'Choose a file')}</span>
          <span class="dv" id="file-name">${t('파일을 고르면 여기에서 해시합니다', 'Hashed here, not uploaded')}</span>
        </label>

        <div class="digestbox" id="digestbox" hidden>
          <span class="dlabel">${t('이 문서의 해시값 — 서버로 가는 것은 이 값뿐입니다',
            'This document\u2019s hash — the only thing that is sent')}</span>
          <code class="digestval mono" id="digestval"></code>
          <span class="dmeta dim" id="digestmeta"></span>
        </div>

        <details class="paste">
          <summary>${t('이미 계산한 해시값이 있습니다', 'I already have a hash')}</summary>
          <p class="hint">${t('직접 계산한 SHA-256 해시값을 붙여 넣으십시오.', 'Paste a SHA-256 you computed yourself.')}</p>
          <input type="text" id="digest" class="mono" spellcheck="false" autocomplete="off"
            placeholder="${t('SHA-256 해시 64자리', 'SHA-256 hash, 64 hex')}">
        </details>

        <div class="row">
          <button class="btn" id="anchor" disabled>${t('해시 앵커링', 'Anchor the hash')}</button>
        </div>
        <div class="outcome" id="digest-result"></div>
      </section>`;
}

function sectionAnchor(): string {
  const o = st.overview!;
  const chain = o.bitcoin_network.toUpperCase();
  // Falls back only so an older service does not blank the screen; the real
  // number always comes from the server, because a limit hardcoded here would
  // drift from the one that actually rejects the upload.
  const lim = o.inscription
    ?? { enabled: false, max_bytes: 0, standard_relay_max_bytes: 0, hard_ceiling_bytes: 0 };
  if (!lim.enabled) {
    return `
      <section class="card">
        <span class="eyebrow">ANCHOR</span>
      <h2>${t('문서 앵커링', 'Anchor a document')}</h2>
        <p class="lede">${t('이 배포에서는 해시 앵커링만 가능합니다.',
          'This deployment offers hash anchoring only.')}</p>
      </section>
      <div class="modes">${digestModeCard()}${signModeCard(lim)}</div>`;
  }
  return `
    <div class="modes">
      ${digestModeCard()}

      <section class="card mode heavy">
        <div class="mh"><span class="chip warn-chip">${t('원본 전송', 'Full document')}</span>
          <b>${t('문서 자체가 비트코인에 영구 기록됩니다', 'The document itself goes on Bitcoin, permanently')}</b></div>
        <p>${t(
          '문서 자체가 비트코인에 기록됩니다. 저희 서버에 파일은 남지 않으며, 나중에 원본을 '
            + '잃어버려도 비트코인에서 그대로 되찾을 수 있습니다.',
          'The document itself is written to Bitcoin. No file is kept on our servers, and if '
            + 'you later lose the original you can recover it from the chain.')}</p>

        <p class="hint warnhint"><b>${t('되돌릴 수 없습니다.', 'This cannot be undone.')}</b> ${t(
          `${esc(chain)}에 공개되고 삭제할 수 없습니다. 비공개 자료는 왼쪽을 쓰십시오.`,
          `It becomes public on ${esc(chain)} and cannot be deleted. For anything confidential, `
            + 'use the left-hand route.')}</p>

        <div class="limitbox">
          <div class="lrow"><b>${t(`최대 ${esc(fmtBytes(lim.max_bytes))}`, `Up to ${esc(fmtBytes(lim.max_bytes))}`)}</b>
            <span class="dim">${t('한 번에 올릴 수 있는 크기', 'per document')}</span></div>
        </div>

        <label class="drop" id="ins-drop">
          <input type="file" id="ins-file" hidden
            data-max="${esc(String(lim.max_bytes))}">
          <span class="dk">${t('인스크립션할 원본', 'Document to inscribe')}</span>
          <span class="dv" id="ins-name">${t(`최대 ${esc(fmtBytes(lim.max_bytes))}`, `Up to ${esc(fmtBytes(lim.max_bytes))}`)}</span>
        </label>

        <div class="digestbox" id="ins-digestbox" hidden>
          <span class="dlabel">${t('이 문서의 해시값', 'This document\u2019s hash')}</span>
          <code class="digestval mono" id="ins-digestval"></code>
          <span class="dmeta dim" id="ins-digestmeta"></span>
        </div>

        <div class="row">
          <button class="btn danger" id="ins-go" disabled>${t('원본 인스크립션', 'Inscribe the document')}</button>
        </div>
        <div class="outcome" id="ins-result"></div>
      </section>
      ${signModeCard(lim)}
    </div>`;
}

/**
 * The optional third path: the same anchor, with the issuer's signature.
 *
 * Laid out as a sequence rather than a form, because it is one: the console
 * can hash the document and it can anchor the result, but the step in the
 * middle happens on a machine we have no access to. Pretending otherwise —
 * a "sign" button here — would be claiming we hold the key.
 *
 * So the screen does the two things it honestly can: it states exactly what
 * must be signed, and it checks the signature in this browser before sending
 * anything, so a mistake is caught where it was made rather than by a
 * recipient months later.
 */
function signModeCard(lim: { max_bytes: number }): string {
  void lim;
  return `
    <section class="card mode signed">
      <div class="mh"><span class="chip inert">${t('선택', 'Optional')}</span>
        <b>${t('발행인 서명 붙이기', 'Add an issuer signature')}</b></div>
      <p>${t('연동 메뉴에 등록한 공개키를 선택하고, 짝이 되는 개인키로 귀사 환경에서 서명합니다. 개인키는 보내지 않습니다.',
        'Choose a public key registered in Integrate, then sign with its matching private key in your own environment. The private key stays with you.')}</p>
      <ol class="signsteps">
        <li>
          <b>${t('문서 선택', 'Choose the document')}</b>
          <label class="drop" id="sg-drop">
            <input type="file" id="sg-file" hidden>
            <span class="dk">${t('서명할 문서', 'Document to sign')}</span>
            <span class="dv" id="sg-name">${t('브라우저에서 해시만 계산합니다', 'Hashed here; nothing is uploaded')}</span>
          </label>
          <div class="digestbox" id="sg-digestbox" hidden>
            <span class="dlabel">${t('문서 해시', 'Document hash')}</span>
            <code class="digestval mono" id="sg-digest"></code>
            <span class="dmeta dim" id="sg-meta"></span>
          </div>
        </li>
        <li>
          <label for="sg-key"><b>${t('발행인 공개키 선택', 'Choose the issuer public key')}</b></label>
          <select id="sg-key" disabled><option value="">${t('등록된 키를 불러오는 중…', 'Loading registered keys…')}</option></select>
          <p class="hint" id="sg-key-info" aria-live="polite"></p>
          <div class="row">
            <a class="link" href="#/integrate">${t('공개키 등록·관리', 'Register or manage public keys')}</a>
            <button type="button" class="link" id="sg-refresh">${t('목록 새로고침', 'Refresh keys')}</button>
          </div>
        </li>
        <li>
          <b>${t('귀사 환경에서 서명', 'Sign in your own environment')}</b>
          <p class="hint">${t('서명 요청 파일에는 문서 해시와 선택한 공개키, 발행 시각이 담깁니다. 해당 공개키와 짝이 되는 개인키로 서명하십시오.',
            'The request contains the document hash, selected public key and issue time. Sign it with the matching private key.')}</p>
          <div class="row"><button type="button" class="btn ghost small" id="sg-request" disabled>${t('서명 요청 파일 다운로드', 'Download signing request')}</button></div>
          <p class="hint" id="sg-request-info" aria-live="polite">${t('문서와 공개키를 선택하면 다운로드할 수 있습니다.', 'Choose a document and public key to download.')}</p>
          <div class="sign-guides">
            <a class="sign-guide" data-link="attest-docs" data-link-hash="signing-existing" target="_blank" rel="noopener">
              <b>${t('기존 서명 도구·HSM/KMS', 'Existing signer · HSM/KMS')} ↗</b>
              <span>${t('보유한 개인키로 서명하는 방법', 'Sign with the private key you already hold')}</span></a>
            <a class="sign-guide" data-link="attest-docs" data-link-hash="signing-tool" target="_blank" rel="noopener">
              <b>${t('당사 Docker·SDK', 'Our Docker · SDK')} ↗</b>
              <span>${t('도구 설치, 키 준비와 서명 방법', 'Install the tools, prepare a key and sign')}</span></a>
          </div>
        </li>
        <li>
          <label for="sg-json"><b>${t('서명 결과 가져오기', 'Import the signed result')}</b></label>
          <p class="hint">${t('서명 결과 JSON 파일을 선택하거나 전체 내용을 붙여 넣으십시오. 개인키 파일은 받지 않습니다.',
            'Choose the signed JSON file or paste its entire contents. Private key files are not accepted.')}</p>
          <div class="row"><label class="btn ghost small" for="sg-result-file">${t('서명 결과 파일 선택', 'Choose signed result file')}</label>
            <input type="file" id="sg-result-file" accept=".json,application/json" hidden>
            <span class="dim" id="sg-result-name"></span></div>
          <textarea id="sg-json" class="mono" rows="5" spellcheck="false" placeholder="${esc(t('서명 결과 JSON 전체를 붙여 넣으십시오', 'Paste the complete signed JSON'))}"></textarea>
          <div id="sg-check" aria-live="polite"></div>
        </li>
      </ol>
      <div class="row"><button class="btn" id="sg-go" disabled>${t('서명과 함께 앵커링', 'Anchor with the signature')}</button></div>
      <div class="outcome" id="sg-result"></div>
    </section>`;
}

/**
 * The record list, and what the chain says about it now.
 *
 * `status` is our database's memory of the lifecycle. The txid lookup beside
 * it is the node's answer this second — mempool or block — and the two are
 * shown separately because when they disagree, that disagreement is the
 * information.
 */
function sectionRecords(): string {
  return `
    <section class="card">
      <p class="lede">${t(
        `<b>해시</b>는 비트코인에 고정하는 값입니다 — 문서는 그 문서의 SHA-256, 송금 증빙과 준비금 증명 스냅샷은 그 기록에서 계산한 해시. <b>트랜잭션</b>은 그 해시를 비트코인에 고정한 거래입니다. 원본 방식은 문서를 거래에 그대로 싣고, 해시 방식은 여러 기록을 하나의 값으로 묶어 싣기 때문에 거래 안의 값은 이 해시와 다르며 여러 기록이 한 트랜잭션을 함께 쓸 수 있습니다 — 내 해시가 그 값에 들어 있음은 각 행의 <span class="imark">i</span> 가 보여 줍니다. 트랜잭션 ID를 누르면 ${esc(st.overview!.bitcoin_network)} 노드에 지금 상태를 묻습니다${st.overview?.explorer_base_url ? '. ↗ 는 익스플로러에서 엽니다' : ''}.`,
        `<b>Hash</b> is the value that is fixed to Bitcoin — a document’s SHA-256; for a settlement’s evidence or a reserve snapshot, a hash computed from that record. <b>Transaction</b> is the Bitcoin transaction that anchors it. A Full record puts the document itself in the transaction; a Hash record is combined with others into one value, so the value in the transaction differs from your hash and several records can share one transaction — the <span class="imark">i</span> on a row shows how yours leads to it. Click a transaction id to ask the ${esc(st.overview!.bitcoin_network)} node what it says right now${st.overview?.explorer_base_url ? '; ↗ opens it in the explorer' : ''}.`)}</p>
      <div id="att-tools"></div>
      <div id="att-list"></div>

      <div class="note">${t(
        '<b>번들을 내려받으면 그 파일만으로 검증됩니다.</b> 저희 서버도, 계정도, 인터넷 '
          + '연결도 필요 없습니다 — 받는 쪽에 그대로 건네주시거나 <a href="#/verify">검증</a> 화면에 넣어 보십시오. '
          + '번들이 보여 주는 것은 해시가 그 트랜잭션에 들어 있다는 것이고, 송금·준비금 증명 기록은 '
          + '그 증빙이나 준비금 증명 파일을 함께 넣어야 내용까지 확인됩니다. 각 행의 '
          + '<span class="imark">i</span> 를 누르면 그 번들에 무엇이 들어 있는지 볼 수 있습니다.',
        '<b>Download the bundle and that file verifies on its own.</b> No server of ours, no '
          + 'account, no internet — hand it straight to whoever needs it, or drop it into <a href="#/verify">Verify</a>. '
          + 'What a bundle shows is that the hash is inside that transaction; for a settlement or reserve record, '
          + 'add its evidence or its reserve proof file to check the contents too. The '
          + '<span class="imark">i</span> on each row shows what is inside one.')}
      </div>

      <p class="hint">${t(
        '상태는 실제로 도달한 단계입니다 — <span class="mono">accepted → batched → submitted '
          + '→ confirmed</span> — 하나의 체크로 합쳐지지 않습니다. 해시 앵커는 배치에 묶인 '
          + '뒤부터, 인스크립션은 즉시 번들을 내보낼 수 있습니다.',
        'Status is the stage actually reached — <span class="mono">accepted → batched → '
          + 'submitted → confirmed</span> — never collapsed into one tick. A digest anchor can '
          + 'be exported once batched; an inscription, immediately.')}</p>
    </section>
    <div id="txview"></div>`;
}

/**
 * What is in the bundle, read off the bundle itself.
 *
 * The temptation is a static "anatomy of a proof file" page. It would be
 * wrong twice over: it would describe a shape rather than the reader's own
 * record, and it would be a second description to keep in step with the
 * Evidence Specification in the hub. So this fetches the exact file the
 * download button produces and annotates that.
 *
 * Grouped by the question each field answers rather than by its position in
 * the JSON, because the four questions are the product's whole mental model
 * and the JSON order is an implementation detail.
 *
 * Absences are listed too, with the reason. A digest anchor has no
 * `witness_envelope` and an inscription has no `merkle`, and saying why is
 * the clearest explanation of the difference between the two modes that this
 * screen can give.
 */
interface SpecField {
  path: string;
  value: unknown;
  why: string;
}

const dig = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);

function specGroups(b: Record<string, unknown>, product = ''): { title: string; note: string; fields: SpecField[] }[] {
  const has = (p: string): boolean => dig(b, p) !== undefined;
  const f = (path: string, why: string): SpecField[] =>
    has(path) ? [{ path, value: dig(b, path), why }] : [];
  /*
   * A settlement's evidence and a reserve snapshot are anchored as a
   * commitment — a hash over the record and a fixed prefix — not as the
   * SHA-256 of a file, though the bundle labels every preimage `sha256-file`.
   * Told that the hash is "the document's SHA-256", a reader would hash the
   * file they hold, get another value and conclude the proof is broken. So
   * for those two the panel says what the hash is of, and where the pair is
   * checked.
   */
  // Which of those a record is, is the product the platform filed it under. The label inside the bundle is the
  // caller's own note and only says which of that product's records it is.
  const kind = dig(b, 'record.descriptor.kind');
  const record = product === 'por' && kind === 'por-snapshot' ? kind
    : product === 'remit' && (kind === 'remit-evidence' || kind === 'remit-manifest') ? kind : null;

  return [
    {
      title: record === 'por-snapshot' ? t('어떤 스냅샷인가', 'Which snapshot')
        : record === 'remit-evidence' ? t('어떤 송금의 증빙인가', 'Which settlement\u2019s evidence')
          : record === 'remit-manifest' ? t('어느 날의 마감인가', 'Which day\u2019s close')
            : t('어떤 문서인가', 'Which document'),
      note: t('이 번들이 무엇에 대한 증명인지.', 'What this bundle is a proof of.'),
      fields: [
        ...f('record.leaf_bytes', record === 'por-snapshot' ? t(
          '스냅샷(머클 루트와 총액)을 정해진 접두어와 함께 SHA-256 한 해시입니다. '
            + '파일의 SHA-256이 아니므로, 맞는지는 검증 화면에 이 번들과 그 스냅샷의 준비금 증명 파일을 함께 넣어 확인합니다.',
          'The hash of the snapshot (the Merkle root and the totals) — SHA-256 of it with a fixed prefix. '
            + 'It is not a file\u2019s SHA-256: to check it, add this bundle and the snapshot\u2019s reserve proof '
            + 'file on Verify together.')
          : record === 'remit-evidence' ? t(
            '송금 증빙을 난수, 정해진 접두어와 함께 SHA-256 한 해시입니다. '
              + '파일의 SHA-256이 아니므로, 맞는지는 검증 화면에 그 송금의 증빙을 넣어 확인합니다.',
            'The hash of the settlement\u2019s evidence — SHA-256 of it with a nonce and a fixed prefix. '
              + 'It is not a file\u2019s SHA-256: to check it, add that settlement\u2019s evidence on Verify.')
            : record === 'remit-manifest' ? t(
              '그날의 마감 목록과 플랫폼의 대사 결과를 정해진 접두어와 함께 SHA-256 한 해시입니다. '
                + '파일의 SHA-256이 아닙니다.',
              'The hash of that day\u2019s manifest and the platform\u2019s reconciliation of it — SHA-256 of the two '
                + 'with a fixed prefix. It is not a file\u2019s SHA-256.')
            : t(
              '문서의 SHA-256 해시 — 32바이트, 16진수 64자. 받는 쪽은 가진 원본을 같은 방식으로 '
                + '해시해 이 값과 글자 하나까지 같은지 봅니다.',
              'The document\u2019s SHA-256 — 32 bytes, 64 hex. A recipient hashes their copy the '
                + 'same way and compares, character for character.')),
        ...f('record.preimage.scheme', record ? t(
          '번들 형식이 적는 표기입니다. 이 기록의 해시는 파일 하나의 SHA-256이 아니라 위에 적은 해시입니다.',
          'The label the bundle format writes. This record\u2019s hash is not one file\u2019s SHA-256 but the hash described above.')
          : t(
            '해시를 만든 규칙. sha256-file 은 파일 바이트 전체에 SHA-256 을 한 번 적용했다는 '
              + '뜻이며, 받는 쪽이 같은 규칙을 적용할 수 있도록 번들이 스스로 밝힙니다.',
            'How the digest was made. `sha256-file` means one SHA-256 over the whole file; the '
              + 'bundle states it so a recipient can apply the same rule.')),
        ...f('record.preimage.content_type', t(
          '원본의 종류. 사람이 읽기 위한 표시이고 검증에는 쓰이지 않습니다.',
          'What kind of file it was. For a human reader; not used in verification.')),
        ...f('record.descriptor', t(
          '발급할 때 함께 남긴 참조값. 증명의 일부가 아니므로 이 값이 달라져도 검증 결과는 같습니다.',
          'A reference recorded with the anchor. Not part of the proof — changing it does '
            + 'not change the verdict.')),
      ],
    },
    {
      title: t('어떻게 묶였는가', 'How it was batched'),
      note: has('merkle')
        ? t('해시를 하나씩 올리는 대신 여러 건을 하나의 값으로 접어 올립니다. 아래 값들은 '
              + '내 해시에서 그 값까지 다시 접어 올라가 보기 위한 것이며, 그 계산만으로 내 '
              + '해시가 거기 있었음이 드러납니다.',
            'Rather than one transaction per digest, several are folded into a single value. '
              + 'The fields below let you fold your own digest back up to it — and that '
              + 'arithmetic alone shows yours was among them.')
        : t('이 번들에는 접는 과정이 없습니다. 체인에 올라간 값이 곧 내 해시값 자체입니다.',
            'Nothing was folded here. The value on the chain is your digest itself.'),
      fields: [
        ...f('merkle.root', t('접어 올라간 끝에 나와야 하는 32바이트 값.',
          'The 32 bytes the folding must arrive at.')),
        ...f('merkle.leaf_index', t('접기를 시작하는 내 자리.', 'Where yours sits in the batch.')),
        ...f('merkle.siblings', t(
          '각 단계에서 함께 해시할 상대값. 배열 길이가 곧 접는 횟수입니다.',
          'The companion value to hash at each step. Its length is the number of steps.')),
        ...f('merkle.directions', t(
          '각 단계에서 상대값을 왼쪽에 둘지 오른쪽에 둘지. siblings 와 길이가 같습니다.',
          'Whether that companion goes left or right at each step. Same length as siblings.')),
      ],
    },
    {
      title: t('원본은 어디에 있는가', 'Where the original is'),
      note: has('anchor.witness_envelope')
        ? t('문서 바이트가 트랜잭션 안에 그대로 들어 있습니다. 받는 쪽은 원본 파일이 없어도 '
              + '트랜잭션에서 꺼내어 위 해시와 대조할 수 있습니다.',
            'The document\u2019s bytes are inside the transaction. A recipient can pull them '
              + 'out and check them against the digest above without holding the file.')
        // 문서나 기록: this panel opens on a settlement's evidence and a
        // reserve snapshot too, and neither of those is a document.
        : t('이 방식은 해시만 올립니다. 그 문서나 기록이 맞는지까지 보려면 원본 파일이 따로 있어야 합니다.',
            'This route publishes the digest only. Checking that it is *your* document or record needs '
              + 'the original alongside.'),
      fields: [
        ...f('anchor.witness_envelope.input_index',
          t('문서를 꺼낼 입력의 번호.', 'Which input the document is in.')),
        ...f('anchor.witness_envelope.content_type',
          t('기록할 때 함께 넣어 둔 문서 종류.', 'The file type recorded alongside it.')),
        ...f('anchor.witness_envelope.protocol_tag',
          t('봉투를 알아보기 위한 표시값.', 'A marker identifying the envelope format.')),
        ...f('commit_txid', t('같은 건에 딸린 선행 트랜잭션 참조. 검증에는 쓰이지 않고 추적용입니다.',
          'A reference to the preceding transaction. Not used in verification; useful for tracing.')),
      ],
    },
    {
      title: t('비트코인 어디에 있는가', 'Where on Bitcoin'),
      note: t('여기까지는 네트워크 없이, 이 파일 안에서만으로 확인됩니다.',
        'Everything to this point is checkable from this file alone, with no network.'),
      fields: [
        ...f('anchor.reveal_txid', t('트랜잭션 번호 — 16진수 64자, 탐색기가 보여 주는 순서 그대로.',
          'The transaction id — 64 hex, in the order an explorer shows it.')),
        ...f('anchor.op_return_payload_hex', t(
          '체인에 올라간 바이트. 이 값이 아래 트랜잭션 안에 실제로 들어 있는지 대조합니다.',
          'The bytes that went on the chain. Checked to be genuinely inside the transaction below.')),
        ...f('anchor.reveal_tx_hex', t(
          '트랜잭션 전체 바이트. 받는 쪽은 이것만으로 번호를 다시 계산해 위 번호와 같은지 '
            + '봅니다 — 저희 말을 믿지 않아도 되는 지점입니다.',
          'The whole transaction. A recipient recomputes its id from this and compares — the '
            + 'point at which you need not take our word for anything.')),
        ...f('anchor.confirmed.block_height', t(
          '저희가 관측한 시점의 블록 높이. 주장이며, 비트코인에서 직접 확인하는 것은 받는 쪽의 몫입니다.',
          'The block height we observed. A claim — confirming it against Bitcoin is the '
            + 'recipient\u2019s to do.')),
        ...f('anchor.confirmed.block_hash', t('그 블록의 해시.', 'That block\u2019s hash.')),
      ],
    },
    {
      title: t('이 파일 자체', 'The file itself'),
      note: '',
      fields: [
        ...f('schema', t('번들 형식의 버전. 검증기가 이 값을 보고 읽는 법을 정합니다.',
          'The bundle format version. A verifier reads this to know how to read the rest.')),
        ...f('bitcoin_network', t(
          '어느 체인인지. 번들이 스스로 적으므로 테스트 체인의 기록을 메인넷인 것처럼 '
            + '내보일 수 없습니다.',
          'Which chain. The bundle states it itself, so a test-chain record cannot be passed '
            + 'off as mainnet.')),
        ...f('generated_at', t('이 파일을 내보낸 시각. 앵커된 시각이 아닙니다.',
          'When this file was exported — not when it was anchored.')),
      ],
    },
  ].filter((g) => g.fields.length > 0 || g.note);
}

/**
 * The detail panels — a transaction, a snapshot, a bundle's contents — render
 * below the table, so opening one has to bring it into view. Without this the row's button appears to do nothing on a short
 * window — the same complaint the anchoring screen's shared result panel
 * earned before it was moved into the cards.
 */
function revealPanel(host: HTMLElement): void {
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Long hex and arrays are summarised; the raw file is one click away. */
function specValue(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? t('[] (빈 배열)', '[] (empty)') : `[${v.length}${t('개', '')}]`;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  // Not `t` — that is the translation helper now, and shadowing it here made
  // the file compile only because this function happened not to need one.
  const text = String(v);
  return text.length > 48 ? `${text.slice(0, 24)}…${text.slice(-12)}` : text;
}

function renderSpec(id: string, bundle: Record<string, unknown>, product = ''): string {
  const groups = specGroups(bundle, product);
  const bytes = new TextEncoder().encode(JSON.stringify(bundle)).length;
  return `<section class="card">
    <div class="cardhead">
      <div>
        <span class="eyebrow">BUNDLE</span>
        <h2>${t('이 번들에 들어 있는 것', 'What is in this bundle')}</h2>
      </div>
      <a class="btn ghost small" href="${esc(api.bundleUrl(id))}">${t('내려받기', 'Download')}</a>
    </div>
    <p class="lede">${t('아래는 설명이 아니라 <b>내려받게 될 바로 그 파일</b>을 읽은 것입니다.',
      'Below is not a description — it is <b>the very file you would download</b>, read back.')}
    ${esc(fmtBytes(bytes))} · <code>${esc(String(bundle['schema'] ?? ''))}</code></p>

    ${groups.map((g) => `<div class="specgrp">
      <h3>${esc(g.title)}</h3>
      ${g.note ? `<p class="dim">${esc(g.note)}</p>` : ''}
      ${g.fields.length ? `<dl class="spec">${g.fields.map((x) => `
        <dt><code>${esc(x.path)}</code></dt>
        <dd><span class="mono sv">${esc(specValue(x.value))}</span>
          <small>${esc(x.why)}</small></dd>`).join('')}</dl>` : ''}
    </div>`).join('')}

    <details class="rawjson">
      <summary>${t('원본 JSON 보기', 'Show the raw JSON')}</summary>
      <pre class="code"><code>${esc(JSON.stringify(bundle, null, 2))}</code></pre>
    </details>
  </section>`;
}

function wireSpec(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-spec]')) {
    b.addEventListener('click', () => {
      const host = maybe('txview');
      if (!host) return;
      host.innerHTML = `<section class="card"><p class="dim">${t('번들을 읽는 중…', 'Reading the bundle…')}</p></section>`;
      void (async () => {
        try {
          host.innerHTML = renderSpec(b.dataset['spec']!, await api.bundle(b.dataset['spec']!), b.dataset['product'] ?? '');
          revealPanel(host);
        } catch (e) {
          host.innerHTML = `<section class="card"><div class="note bad">${esc(
            e instanceof ApiError ? e.message : String(e))}</div></section>`;
        }
      })();
    });
  }
}

/**
 * Key management, not key rotation.
 *
 * The screen used to offer one button — rotate — which mints a key and kills
 * the old one in the same instant. That is the one operation an integration
 * cannot survive: every caller breaks at the swap, and the customer has no
 * window to move them over. Issuing a second key, moving traffic, then
 * revoking the first is the way this is actually done, so the console does
 * that instead.
 *
 * The secret appears once, when it is minted, and is dropped from state by
 * the render that shows it — see `showKeyOnce`. Nothing here can show it
 * again because the service keeps only a hash.
 */
function sectionIntegrate(): string {
  return `
    <section class="card">
      <!--
        The reference is a destination, not a step in issuing a key. It sat in
        the same row as the label field and the issue button, where it read as
        a third thing to do before getting a credential.
      -->
      <div class="cardhead">
        <div>
          <span class="eyebrow">CREDENTIAL</span>
          <h2>${t('API 키', 'API keys')}</h2>
        </div>
        <a class="btn ghost small" data-link="attest-docs" data-link-hash="api" target="_blank" rel="noopener">
          ${t('API 문서', 'Reference')} <span aria-hidden="true">↗</span></a>
      </div>
      <p class="lede">${t(
        '여러 개를 동시에 둘 수 있습니다. 교체할 때는 새 키를 발급해 호출하는 쪽을 옮긴 뒤 옛 '
          + '키를 폐기하십시오 — 그래야 중단 없이 바뀝니다.',
        'Several can be live at once. To rotate, issue a new one, move your callers, then '
          + 'revoke the old — that is how it happens without a gap.')}</p>
      <div id="keylist"><p class="dim">${t('불러오는 중…', 'Loading…')}</p></div>
      <div class="row">
        <input type="text" id="key-label" maxlength="60" placeholder="${t('라벨 — 예: 정산 배치 서버', 'Label — e.g. settlement batch server')}">
        <button class="btn" id="key-new">${t('키 발급', 'Issue a key')}</button>
      </div>
      <p class="hint">${t(
        '비밀값은 발급 순간 한 번만 표시됩니다. 저희는 해시만 보관하므로 다시 보여 드릴 수 '
          + '없고, 폐기는 즉시 적용됩니다.',
        'The secret is shown once, when it is minted. We keep only its hash, so it cannot be '
          + 'shown again; revocation takes effect immediately.')}</p>
    </section>

    <!--
      What the platform trusts as this organisation: the public keys it
      accepts signatures from, and the institutions that sign with them. A
      messaging network shows a bank its certificates and relationships for
      the same reason — trust that cannot be inspected cannot be revoked.
    -->
    <section class="card">
      <div class="cardhead">
        <div>
          <span class="eyebrow">TRUST</span>
          <h2>${t('서명 공개키 · 기관', 'Signing public keys · institutions')}</h2>
        </div>
        <a class="btn ghost small" data-link="attest-docs" data-link-hash="signing" target="_blank" rel="noopener">
          ${t('서명 가이드', 'Signing guide')} <span aria-hidden="true">↗</span></a>
      </div>
      <p class="lede">${t(
        '플랫폼이 이 조직의 것으로 신뢰하는 공개키와, 그 키로 서명하는 기관입니다. 공개키 해시(SHA-256)는 귀사 HSM의 키와 '
          + '대조하십시오. 폐기는 즉시 적용됩니다: 송금·준비금 증명 SDK의 제출은 거부되고, 서명 앵커는 '
          + '그 키를 "미등록"으로 보고합니다.',
        'The public keys the platform trusts as this organisation\'s, and the institutions that sign '
          + 'with them. Compare the key hashes with the keys in your own HSM. Revocation is immediate: '
          + 'settlement and reserve-proof submissions signed with the key are refused, and signed anchors '
          + 'report it as unregistered.')}</p>
      <div id="trustlist"><p class="dim">${t('불러오는 중…', 'Loading…')}</p></div>
    </section>

`;
}

/**
 * What a registrable key looks like — a throwaway P-256 public key, generated
 * once for this purpose; nobody holds its private half. The fixed prefix is
 * the DER header every uncompressed P-256 SPKI shares, so a pasted key that
 * does not begin with it is not one.
 */
const SAMPLE_SPKI_PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDFqjOCZQbMQRhcsnsKa/AXGH1Pio\nKRMml/4LFkYRZg1uwcILlN8MRU/VgUJG5mIj1RqZS7NBpP6WY2wKeR6tZA==\n-----END PUBLIC KEY-----";
const SAMPLE_SPKI_B64 = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDFqjOCZQbMQRhcsnsKa/AXGH1PioKRMml/4LFkYRZg1uwcILlN8MRU/VgUJG5mIj1RqZS7NBpP6WY2wKeR6tZA==";

/** 서명 공개키 · 기관 — the trust table, with the one destructive action it needs. */
async function loadTrust(): Promise<void> {
  const host = maybe('trustlist');
  if (!host) return;
  try {
    const [keys, prod] = await Promise.all([api.issuerKeys(), api.products()]);
    const { sha256 } = await import('./vendor/sha256.ts');
    // SHA-256 over the DER-encoded public key — the fingerprint a key
    // management tool prints, so the two can be compared by eye.
    const fingerprint = (spkiB64: string): string => {
      try {
        const bytes = Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0));
        return [...sha256(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { return ''; }
    };
    const role = (r: string): string =>
      r === 'COLLECTION_BANK' ? t('수납 은행', 'collection bank') : r === 'EXCHANGE' ? t('거래소', 'exchange') : r;
    const es256 = keys.data.filter((k) => k.algorithm === 'ES256' && keyShape(k.public_key) === 'spki');
    // Which registered key an institution's submissions are verified against:
    // the rails hold a copy of the public key, so it is matched by value.
    const keyFor = (spki: string | null | undefined): IssuerKey | null =>
      spki ? keys.data.find((k) => k.public_key === spki) ?? null : null;
    const institutions = prod.institutions.length === 0
      ? `<p class="dim">${esc(t('등록된 기관이 없습니다 — 송금·PoR를 활성화하면 기관 ID가 발급됩니다.', 'No institutions yet — activating Settlement or PoR issues an institution id.'))}</p>`
      : `<div class="tablewrap"><table>
        <thead><tr><th>${esc(t('기관 ID', 'Institution id'))}</th><th>${esc(t('역할', 'Role'))}</th><th>${esc(t('이름', 'Name'))}</th><th>${esc(t('국가', 'Country'))}</th>
          <th>${esc(t('서명 검증 키', 'Verification key'))}</th></tr></thead>
        <tbody>${prod.institutions.map((i) => {
          const current = keyFor(i.signing_spki);
          const options = es256.map((k) =>
            `<option value="${esc(k.id)}"${current?.id === k.id ? ' selected' : ''}>${esc(k.label)} · ${esc(short(fingerprint(k.public_key), 6))}</option>`).join('');
          return `<tr>
          <td class="mono">${esc(i.id)}</td><td>${esc(role(i.role))}</td><td>${esc(i.name)}</td><td class="dim">${esc(i.country ?? '—')}</td>
          <td>${i.signing_spki === undefined
            ? '<span class="dim">—</span>'
            : `<span class="keyswitch">
                <span class="${current ? '' : 'dim'}">${esc(current ? current.label : i.signing_spki
                  ? t('등록 목록에 없는 키', 'a key not in the list') : t('없음 — 제출이 거부됩니다', 'none — submissions are refused'))}</span>
                ${es256.length ? `<select data-inst-key="${esc(i.id)}" aria-label="${esc(t('서명 검증 키 선택', 'Choose the verification key'))}">${options}</select>
                <button type="button" class="link" data-inst-apply="${esc(i.id)}">${esc(t('적용', 'Apply'))}</button>` : ''}
              </span>`}</td>
        </tr>`;
        }).join('')}</tbody></table></div>`;
    const keyRows = keys.data.length === 0
      ? `<p class="dim">${esc(t('등록된 서명 공개키가 없습니다.', 'No signing public keys registered.'))}</p>`
      : `<div class="tablewrap"><table>
        <thead><tr><th>${esc(t('라벨', 'Label'))}</th><th>${esc(t('알고리즘', 'Algorithm'))}</th>
          <th>${esc(t('공개키 해시 — DER 공개키의 SHA-256', 'Key hash — SHA-256 of the DER public key'))}</th><th>${esc(t('등록', 'Registered'))}</th><th></th></tr></thead>
        <tbody>${keys.data.map((k) => {
          const fp = fingerprint(k.public_key);
          // A key whose material cannot be parsed can never verify a
          // signature — the sandbox seeds one such placeholder so the list
          // is not empty on day one. Said inline, not behind a tooltip.
          return `<tr${fp ? '' : ' class="dimrow"'}>
            <td>${esc(k.label)}</td>
            <td class="mono dim">${esc(k.algorithm)}</td>
            <td class="${fp ? 'mono' : 'dim'}"${fp ? ` title="${esc(fp)}"` : ''}>${fp ? esc(short(fp, 8))
              : esc(t('해석할 수 없는 자리표시 키 — 어떤 서명도 검증하지 못합니다', 'placeholder key, not parseable — verifies no signature'))}</td>
            <td class="dim">${when(k.created_at)}</td>
            <td><button type="button" class="link danger-link" data-revoke-issuer="${esc(k.id)}">${esc(t('폐기', 'Revoke'))}</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>`;
    host.innerHTML = `
      <span class="eyebrow">${esc(t('기관', 'Institutions'))}</span>
      ${institutions}
      <span class="eyebrow trusteyebrow">${esc(t('서명 공개키', 'Signing public keys'))}</span>
      ${keyRows}
      <div class="regkey">
        <span class="eyebrow trusteyebrow">${esc(t('공개키 등록', 'Register a public key'))}</span>
        <p class="hint">${esc(t(
          '귀사 HSM이나 키 관리 도구에서 만든 ES256(P-256) 공개키를 등록합니다. 개인키는 올리지 마십시오. 등록 뒤 위 기관 표에서 검증 키로 적용하면 이후 제출은 그 키로 검증됩니다.',
          'Register an ES256 (P-256) public key from your HSM or key tool. Never the private key. Once registered, apply it as an institution\'s verification key above and later submissions are checked against it.'))}</p>
        <input type="text" id="ik-label" maxlength="60" placeholder="${esc(t('라벨 — 예: 본점 HSM 2026', 'Label — e.g. head-office HSM 2026'))}">
        <textarea id="ik-pem" class="mono" rows="5" spellcheck="false" placeholder="${esc(SAMPLE_SPKI_PEM)}"></textarea>
        <div class="keyrow">
          <button type="button" class="btn small" id="ik-add">${esc(t('공개키 등록', 'Register the public key'))}</button>
          <span class="muted" id="ik-msg"></span>
        </div>
        <div class="keysample">
          <span class="eyebrow">${esc(t('형식 예시', 'Format'))}</span>
          <p>${esc(t('입력란의 PEM을 그대로 붙여 넣거나, 머리글 없이 base64 한 줄로 넣어도 됩니다:',
            'Paste the PEM as shown in the box, or the same key as one line of base64 without the header lines:'))}</p>
          <pre class="code"><code>${esc(SAMPLE_SPKI_B64)}</code></pre>
          <p><a data-link="attest-docs" data-link-hash="signing-existing" target="_blank" rel="noopener">${esc(t('공개키 준비·추출 가이드 ↗', 'Prepare or extract a public key ↗'))}</a></p>
          <p class="dim">${esc(t('위 값은 형식을 보여 주는 예시입니다 — 귀사 공개키로 바꿔 넣으십시오.',
            'The values above only show the format — paste your own public key.'))}</p>
        </div>
      </div>`;
    resolveLinks(host);
    // Register: PEM or bare base64 in, SPKI base64 out. A private key is
    // refused on sight — it must never reach this service.
    host.querySelector<HTMLButtonElement>('#ik-add')?.addEventListener('click', () => {
      const label = (host.querySelector('#ik-label') as HTMLInputElement).value.trim();
      const raw = (host.querySelector('#ik-pem') as HTMLTextAreaElement).value;
      const msg = host.querySelector('#ik-msg') as HTMLElement;
      const say = (x: string): void => { msg.textContent = x; };
      const privateKey = t('개인키입니다 — 공개키만 등록합니다. 이 값은 보내지 않았습니다.', 'That is a private key — only public keys are registered. Nothing was sent.');
      if (/PRIVATE KEY/i.test(raw)) { say(privateKey); return; }
      const b64 = raw.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
      const shape = keyShape(b64);
      // Bare base64 carries no armour to say what it is; the DER does.
      if (shape === 'private') { say(privateKey); return; }
      if (shape !== 'spki') { say(t('SPKI 형식의 공개키가 아닙니다.', 'Not an SPKI public key.')); return; }
      if (!label) { say(t('라벨을 적어 주십시오.', 'Give the key a label.')); return; }
      void (async () => {
        try {
          const r = await api.registerIssuerKey(b64, label, 'ES256');
          const done = r.already ? t('이미 등록된 키입니다.', 'Already registered.') : t('등록되었습니다.', 'Registered.');
          await loadTrust();
          // The card was redrawn; say it in the new one.
          const again = host.querySelector('#ik-msg');
          if (again) again.textContent = done;
        } catch (e) { say(e instanceof ApiError ? e.message : String(e)); }
      })();
    });
    for (const b of host.querySelectorAll<HTMLElement>('[data-inst-apply]')) {
      b.addEventListener('click', () => {
        const id = b.dataset['instApply']!;
        const sel = host.querySelector<HTMLSelectElement>(`[data-inst-key="${CSS.escape(id)}"]`);
        if (!sel) return;
        if (!window.confirm(t(
          '이 기관의 서명 검증 키를 교체합니다. 이후 제출은 선택한 공개키로 검증되며, 이전 키로 서명한 제출은 거부됩니다.',
          'This replaces the institution\'s verification key. Later submissions are checked against the chosen public key; ones signed with the previous key are refused.'))) return;
        void (async () => {
          try { await api.setInstitutionSigningKey(id, sel.value); await loadTrust(); }
          catch (e) { window.alert(e instanceof ApiError ? e.message : String(e)); }
        })();
      });
    }
    for (const b of host.querySelectorAll<HTMLElement>('[data-revoke-issuer]')) {
      b.addEventListener('click', () => {
        if (!window.confirm(t(
          '이 공개키를 폐기하면 이 키로 서명된 이후 제출은 즉시 거부됩니다. 활성 상품의 기관이 쓰는 키라면 그 연동이 멈춥니다. 되돌릴 수 없습니다.',
          'Revoking this public key refuses every later submission signed with it. If an active product\'s institution signs with it, that integration stops. This cannot be undone.'))) return;
        void (async () => {
          try { await api.revokeIssuerKey(b.dataset['revokeIssuer']!); await loadTrust(); }
          catch (e) { window.alert(e instanceof ApiError ? e.message : String(e)); }
        })();
      });
    }
  } catch (e) {
    host.innerHTML = `<p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

/** The key table. Re-rendered on its own so the rest of the screen stays put. */
function renderKeys(): void {
  const host = maybe('keylist');
  if (!host) return;
  if (st.keys === null) { host.innerHTML = `<p class="dim">${t('불러오는 중…', 'Loading…')}</p>`; return; }
  if (st.keys.length === 0) {
    host.innerHTML = `<p class="dim">${t('활성 키가 없습니다. 아래에서 발급하십시오.', 'No active keys. Issue one below.')}</p>`;
    return;
  }
  host.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>${t('라벨', 'Label')}</th><th>${t('접두사', 'Prefix')}</th><th>${t('발급', 'Issued')}</th><th></th></tr></thead>
    <tbody>${st.keys.map((k) => `<tr>
      <td><button class="link" data-rename="${esc(k.id)}"
            title="${t('라벨 바꾸기', 'Rename')}">${esc(k.label)}</button></td>
      <td class="mono dim">${esc(k.prefix)}…</td>
      <td class="dim">${when(k.created_at)}</td>
      <td><button class="link danger-link" data-revoke="${esc(k.id)}">${t('폐기', 'Revoke')}</button></td>
    </tr>`).join('')}</tbody></table></div>`;
  wireKeys();
}

function wireKeys(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-rename]')) {
    b.addEventListener('click', () => {
      const current = b.textContent ?? '';
      const next = window.prompt(t('이 키의 라벨', 'Label for this key'), current);
      if (next === null || next.trim() === current) return;
      void (async () => {
        try { await api.renameKey(b.dataset['rename']!, next.trim()); await loadKeys(); }
        catch (e) { window.alert(e instanceof ApiError ? e.message : String(e)); }
      })();
    });
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-revoke]')) {
    b.addEventListener('click', () => {
      // Immediate and irreversible, so it is confirmed — and the warning says
      // what actually happens rather than asking "are you sure".
      if (!window.confirm(
        t('이 키를 폐기하면 다음 호출부터 즉시 거부됩니다. 되돌릴 수 없습니다.',
        'Revoking this key rejects the next call that uses it. This cannot be undone.'))) return;
      void (async () => {
        try {
          const r = await api.revokeKey(b.dataset['revoke']!);
          await loadKeys();
          if (r.active_remaining === 0) {
            window.alert(t('활성 키가 하나도 남지 않았습니다. 연동이 멈춥니다.',
              'No active keys remain. Your integrations will stop working.'));
          }
        } catch (e) { window.alert(e instanceof ApiError ? e.message : String(e)); }
      })();
    });
  }
}

async function loadKeys(): Promise<void> {
  try { st.keys = (await api.keys()).data; }
  catch { st.keys = []; }
  renderKeys();
}

/** Platform state → console label. The 6/7 split (in progress ≠ credited) is the point. */
const REMIT_STATE: Record<string, { label: string; chip: 'ok' | 'wait' | 'inert' }> = {
  REQUEST_ACCEPTED: { label: t('접수됨', 'accepted'), chip: 'wait' },
  BANK_AUTHORIZED: { label: t('은행승인 검증', 'bank authorised'), chip: 'wait' },
  TRAVEL_RULE_PENDING: { label: t('트래블룰 심사중', 'travel rule pending'), chip: 'wait' },
  PAYOUT_PRE_APPROVED: { label: t('지급 사전승인', 'payout pre-approved'), chip: 'wait' },
  ONCHAIN_SETTLED: { label: t('USDC 정산 확정', 'on-chain settled'), chip: 'wait' },
  // "In progress" is not "credited": the distinction the tracker spells out
  // leg by leg; the chip keeps the short form so the row stays one line.
  PAYOUT_IN_PROGRESS: { label: t('지급 진행중', 'payout in progress'), chip: 'wait' },
  // Both are "paid out" to the bank: the credit is confirmed in the first and
  // the platform has additionally anchored the evidence in the second, which
  // the row's evidence button carries rather than the status.
  BENEFICIARY_CREDIT_CONFIRMED: { label: t('지급완료', 'paid out'), chip: 'ok' },
  EVIDENCE_ANCHORED: { label: t('지급완료', 'paid out'), chip: 'ok' },
  CANCELLED: { label: t('취소됨', 'cancelled'), chip: 'inert' },
  RETURNED: { label: t('반환됨', 'returned'), chip: 'inert' },
  EXCEPTION: { label: t('예외', 'exception'), chip: 'inert' },
};

/**
 * The table row for a state, or a neutral fallback. Own keys only: a plain
 * object answers `REMIT_STATE['constructor']` with a function, so a lookup
 * by truthiness would let a crafted or mistyped value through as a state.
 */
const remitStateOf = (state: string): { label: string; chip: 'ok' | 'wait' | 'inert' } =>
  Object.hasOwn(REMIT_STATE, state) ? REMIT_STATE[state]! : { label: state, chip: 'inert' };

/**
 * The state filter as the bank reads it: one "paid out" entry for the two
 * platform states that both mean the money arrived. The value is what the
 * API takes — a comma list of states.
 */
const REMIT_FILTERS: { value: string; label: string }[] = [
  ...['REQUEST_ACCEPTED', 'BANK_AUTHORIZED', 'TRAVEL_RULE_PENDING', 'PAYOUT_PRE_APPROVED',
    'ONCHAIN_SETTLED', 'PAYOUT_IN_PROGRESS'].map((k) => ({ value: k, label: REMIT_STATE[k]!.label })),
  { value: 'BENEFICIARY_CREDIT_CONFIRMED,EVIDENCE_ANCHORED', label: t('지급완료', 'paid out') },
  ...['CANCELLED', 'RETURNED', 'EXCEPTION'].map((k) => ({ value: k, label: REMIT_STATE[k]!.label })),
];

/** A filter value is one or more known states, comma-separated. */
const isRemitFilter = (value: string): boolean =>
  value.length > 0 && value.split(',').every((k) => Object.hasOwn(REMIT_STATE, k));

/**
 * 송금 — the platform-side ledger of what this organisation instructed.
 *
 * This is the console's answer to "did my adapter's call actually land, and
 * what does the platform think happened since": the same rows the bank's own
 * screen tracks, but read from the platform's state machine, with the evidence
 * export one click away. Scaffold now, data on
 * arrival, like records and products.
 */
function sectionRemit(): string {
  const stateOptions = REMIT_FILTERS
    .map((f) => `<option value="${esc(f.value)}">${esc(f.label)}</option>`).join('');
  return `
    <section class="card">
      <h2>${esc(t('송금 거래', 'Settlements'))}</h2>
      <p class="hint">${esc(t('내려받은 증빙 JSON 파일 하나로', 'Use the downloaded evidence JSON alone in'))}
        <a href="#/verify">${esc(t('검증 메뉴', 'Verify'))}</a>${esc(t('에서 검증할 수 있습니다. 별도 원본은 필요하지 않습니다.', '. No separate original file is needed.'))}</p>
      <div class="rtools">
        <input id="remitQ" type="search" autocomplete="off"
          placeholder="${esc(t('거래 ID · UETR · 은행 참조번호 · 거래해시 검색', 'Search by payment id, UETR, bank reference or tx hash'))}">
        <select id="remitState" aria-label="${esc(t('상태 필터', 'State filter'))}">
          <option value="">${esc(t('전체 상태', 'All states'))}</option>
          ${stateOptions}
        </select>
        <span class="daterange">
          <span class="dim">${esc(t('거래일', 'Date'))}</span>
          <input type="date" id="remitFrom" aria-label="${esc(t('거래일 시작', 'From date'))}">
          <span class="dim">~</span>
          <input type="date" id="remitTo" aria-label="${esc(t('거래일 끝', 'To date'))}">
        </span>
        <button type="button" class="btn ghost small" id="remitExport">${esc(t('CSV 내보내기', 'Export CSV'))}</button>
        <small class="muted" id="remitExportMsg"></small>
      </div>
      <div id="remitList"><p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p></div>
      <div id="remitPager" class="rpager"></div>
    </section>`;
}

// ── 감사 기록: who called what, by service ─────────────────────────────────

const AUDIT_SERVICE: Record<string, string> = {
  remit: t('송금', 'Settlements'), attest: t('문서 앵커링', 'Document anchoring'),
  por: t('준비금 증명', 'Proof of Reserves'), console: t('콘솔', 'Console'),
};
const AUDIT_PAGE_SIZE = 50;
const auditView = { service: '', actor: '', from: '', to: '', q: '', cursor: null as string | null, shown: 0, req: 0 };

function sectionAudit(): string {
  const opt = (v: string, label: string): string => `<option value="${esc(v)}">${esc(label)}</option>`;
  return `
    <section class="card">
      <div class="rtools">
        <select id="auditService" aria-label="${esc(t('서비스', 'Service'))}">
          ${opt('', t('전체 서비스', 'All services'))}${Object.entries(AUDIT_SERVICE).map(([v, l]) => opt(v, l)).join('')}
        </select>
        <select id="auditActor" aria-label="${esc(t('수행 주체', 'Actor'))}">
          ${opt('', t('전체 주체', 'All actors'))}${opt('api_key', t('API 키', 'API key'))}${opt('session', t('콘솔 계정', 'Console account'))}
        </select>
        <span class="daterange">
          <span class="dim">${esc(t('기간', 'Period'))}</span>
          <input type="date" id="auditFrom" aria-label="${esc(t('시작일', 'From date'))}">
          <span class="dim">~</span>
          <input type="date" id="auditTo" aria-label="${esc(t('끝일', 'To date'))}">
        </span>
        <input id="auditQ" type="search" autocomplete="off"
          placeholder="${esc(t('경로 검색 — 예: /v1/settlements', 'Search by path — e.g. /v1/settlements'))}">
      </div>
      <div id="auditList"><p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p></div>
      <div id="auditPager" class="rpager"></div>
    </section>`;
}

function auditRowHtml(e: AuditEntry): string {
  const ok = e.status < 400;
  return `
    <tr class="${ok ? '' : 'rbad'}">
      <td class="dim when">${when(e.at)}</td>
      <td>${esc(AUDIT_SERVICE[e.service] ?? e.service)}</td>
      <td><span class="chip inert">${esc(e.actor_type === 'api_key' ? t('API 키', 'API key') : t('콘솔', 'console'))}</span> ${esc(e.actor_label)}</td>
      <td class="mono"><span class="dim">${esc(e.method)}</span> ${esc(e.path)}</td>
      <td><span class="chip ${ok ? 'ok' : 'inert'}">${esc(String(e.status))}</span></td>
      <td class="num dim">${esc(String(e.duration_ms))} ms</td>
    </tr>`;
}

async function fetchAuditPage(reset: boolean): Promise<void> {
  const list = document.getElementById('auditList');
  const pager = document.getElementById('auditPager');
  if (!list || !pager) return;
  if (reset) { auditView.cursor = null; auditView.shown = 0; pager.innerHTML = ''; }
  else if (!auditView.cursor) return;
  const req = ++auditView.req;
  const r = await api.audit({
    service: auditView.service, actor_type: auditView.actor, q: auditView.q,
    from: auditView.from ? `${auditView.from}T00:00:00.000Z` : '',
    // The API's upper bound is exclusive, so the chosen day ends at the next one's start.
    to: auditView.to ? new Date(Date.parse(`${auditView.to}T00:00:00.000Z`) + 86_400_000).toISOString() : '',
    cursor: auditView.cursor ?? undefined, limit: AUDIT_PAGE_SIZE,
  });
  if (req !== auditView.req) return;
  if (reset) {
    list.innerHTML = r.data.length === 0
      ? `<p class="muted">${esc(t('기록이 없습니다 — API 키나 콘솔 계정으로 호출하면 여기에 남습니다.',
          'No entries — calls made with an API key or a console account appear here.'))}</p>`
      : `<div class="tablewrap"><table class="rtab">
        <thead><tr>
          <th>${esc(t('시각', 'Time'))}</th><th>${esc(t('서비스', 'Service'))}</th><th>${esc(t('수행 주체', 'Actor'))}</th>
          <th>${esc(t('요청', 'Request'))}</th><th>${esc(t('결과', 'Result'))}</th><th class="num">${esc(t('소요', 'Took'))}</th>
        </tr></thead><tbody id="auditTbody"></tbody></table></div>`;
  }
  document.getElementById('auditTbody')?.insertAdjacentHTML('beforeend', r.data.map(auditRowHtml).join(''));
  auditView.shown += r.data.length;
  auditView.cursor = r.page.next_cursor;
  pager.innerHTML = auditView.shown === 0 ? '' : `
    <small class="muted">${esc(t(`${auditView.shown}건 표시`, `${auditView.shown} shown`))}</small>
    ${auditView.cursor ? `<button type="button" class="ghost" id="auditMore">${esc(t('더 보기', 'Load more'))}</button>` : ''}`;
  document.getElementById('auditMore')?.addEventListener('click', () => {
    void fetchAuditPage(false).catch((e) => { pager.innerHTML = `<p class="muted">${esc(String(e))}</p>`; });
  });
}

async function loadAudit(): Promise<void> {
  const list = document.getElementById('auditList');
  if (!list) return;
  const fail = (e: unknown): void => { list.innerHTML = `<p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p>`; };
  const refetch = (): void => { void fetchAuditPage(true).catch(fail); };
  Object.assign(auditView, { service: '', actor: '', from: '', to: '', q: '' });
  for (const [id, key] of [['auditService', 'service'], ['auditActor', 'actor'], ['auditFrom', 'from'], ['auditTo', 'to']] as const) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    el?.addEventListener('change', () => { auditView[key] = el.value; refetch(); });
  }
  const q = document.getElementById('auditQ') as HTMLInputElement | null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  q?.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { if (!q.isConnected) return; auditView.q = q.value.trim(); refetch(); }, 300);
  });
  try { await fetchAuditPage(true); } catch (e) { fail(e); }
}

/**
 * The settlement ledger view, built for volume.
 *
 * The server owns filtering and pagination (`q`, `state`, keyset `cursor`);
 * this side only accumulates pages. "더 보기" appends — it never re-renders
 * rows already on screen, so an expanded event log stays expanded while the
 * list grows beneath it.
 */
const remitView = { q: '', state: '', from: '', to: '', cursor: null as string | null, total: 0, shown: 0, req: 0 };

/** The search parameters the current filter amounts to — one place, so the list and the export agree. */
function remitQuery(): { q?: string; state?: string; from?: string; to?: string } {
  return {
    ...(remitView.q ? { q: remitView.q } : {}),
    ...(remitView.state ? { state: remitView.state } : {}),
    // Calendar days, whole: a date picker gives a day, the API takes instants.
    ...(remitView.from ? { from: `${remitView.from}T00:00:00.000Z` } : {}),
    ...(remitView.to ? { to: `${remitView.to}T23:59:59.999Z` } : {}),
  };
}
/** The address for the current search and state, so a link into the ledger can be reloaded or shared. */
function remitHash(): string {
  const parts = [
    ...(remitView.q ? [`q=${encodeURIComponent(remitView.q)}`] : []),
    ...(remitView.state ? [`state=${remitView.state}`] : []),
  ];
  return parts.length ? `#/remit?${parts.join('&')}` : '#/remit';
}
const REMIT_PAGE_SIZE = 25;

/**
 * One ledger row, board-style: every fact in its own column, reading across.
 * The second `<tr>` is the signed event log, hidden until the 이벤트 button
 * toggles it — a `<details>` cannot live inside a table row, so the pair of
 * rows is the expand mechanism.
 */
function remitRowHtml(x: Awaited<ReturnType<typeof api.settlements>>['data'][number]): string {
  const st2 = remitStateOf(x.state);
  const rowCls = st2.chip === 'ok' ? 'rok' : st2.chip === 'inert' ? 'rbad' : 'rwait';
  // The anchor is not a column: for the bank the row is about the payout, and
  // the anchored evidence is the one button at the end — what it says on
  // hover is where the anchor stands.
  const anchorNote = !x.attestation
    ? t('증빙 내려받기', 'Download the evidence')
    : x.attestation.status === 'confirmed'
      ? t('증빙 내려받기 — 비트코인 앵커 확정', 'Download the evidence — Bitcoin anchor confirmed')
      : t('증빙 내려받기 — 앵커 확정 대기', 'Download the evidence — anchor pending');
  return `
    <tr class="${rowCls}">
      <td class="mono rid" title="${esc(x.payment_id)}">${esc(x.payment_id)}</td>
      <td><span class="chip ${st2.chip}">${esc(st2.label)}</span></td>
      <td class="dim">${esc(x.corridor.origin)}→${esc(x.corridor.destination)}</td>
      <td class="mid">${esc(fmtMoney(x.trade.value))} <span class="dim">${esc(x.trade.currency)}</span></td>
      <td class="mid">${esc(fmtMoney(x.collected.value))} <span class="dim">${esc(x.collected.currency)}</span></td>
      <td class="mid">${esc(fmtMoney(x.paid.value))} <span class="dim">${esc(x.paid.currency)}</span></td>
      <td class="txcell">${chainTxCellHtml(x.payment_id, x.chain_tx)}</td>
      <td class="dim when2">${when(x.created_at).split(' ').map((part) => `<span>${esc(part)}</span>`).join(' ')}</td>
      <td class="rowact">
        <button type="button" class="btn ghost small" data-remit-toggle="${esc(x.payment_id)}">${esc(t('추적', 'Track'))}</button>
        ${x.evidence_available
          ? `<button type="button" class="btn ghost small" data-remit-ev="${esc(x.payment_id)}" title="${esc(anchorNote)}">${esc(t('증빙', 'Evidence'))}${
            x.attestation?.status === 'confirmed' ? ' <span class="chip ok">⚓</span>' : ''}</button>`
          : ''}
      </td>
    </tr>
    <tr class="rx rx-hidden" data-rx="${esc(x.payment_id)}">
      <td colspan="9"><div class="rxbody"><p class="muted">${esc(t('추적을 누르면 불러옵니다…', 'Loads when Track is pressed…'))}</p></div></td>
    </tr>`;
}

// ── 추적: one settlement, leg by leg ───────────────────────────────────────

type SettlementDetail = Awaited<ReturnType<typeof api.settlement>>;
type SettlementEvent = SettlementDetail['events'][number];
type LegStatus = 'done' | 'active' | 'held' | 'failed' | 'pending' | 'unreached';

interface Leg {
  key: 'accept' | 'travel' | 'settle' | 'payout' | 'evidence';
  label: string;
  /** The same leg in two or three words, for the line of stations. */
  short: string;
  /** Every event type that belongs to this leg. */
  types: string[];
  /** Any of these completes the leg. */
  done: string[];
  /** An open request parks it until the closing event arrives. */
  hold?: { open: string; close: string };
}

/**
 * The five legs a settlement crosses, as a bank's operator follows a payment
 * on a messaging network's tracker — which leg it is on, what left and
 * arrived on each, and the identifier each counterparty handed over. Each
 * leg is read from the signed events, so "done" means the completing event
 * exists, not that the state says so.
 */
const LEGS: Leg[] = [
  { key: 'accept', label: t('접수 · 은행 승인 검증', 'accepted · bank authorisation verified'),
    short: t('접수 · 승인', 'Accepted'),
    types: ['REQUEST_ACCEPTED', 'BANK_EVIDENCE_SUBMITTED', 'BANK_AUTHORIZATION_VERIFIED'],
    done: ['BANK_AUTHORIZATION_VERIFIED'] },
  { key: 'travel', label: t('트래블룰 교환', 'travel-rule exchange'),
    short: t('트래블룰', 'Travel rule'),
    types: ['TRAVEL_RULE_SENT', 'TRAVEL_RULE_RECEIVED', 'TRAVEL_RULE_RFI', 'TRAVEL_RULE_RFI_RESOLVED'],
    done: ['TRAVEL_RULE_RECEIVED'],
    hold: { open: 'TRAVEL_RULE_RFI', close: 'TRAVEL_RULE_RFI_RESOLVED' } },
  { key: 'settle', label: t('지급 사전승인 · USDC 정산', 'payout pre-approval · USDC settlement'),
    short: t('USDC 정산', 'USDC settlement'),
    types: ['PAYOUT_ACCEPTED', 'SETTLEMENT_INSTRUCTED', 'USDC_TRANSFER_CONFIRMED', 'USDC_RECEIVED'],
    done: ['USDC_RECEIVED'] },
  { key: 'payout', label: t('현지 통화 지급', 'local-currency payout'),
    short: t('현지 지급', 'Local payout'),
    types: ['PAYOUT_SUBMITTED', 'PAYOUT_COMPLETED'],
    done: ['PAYOUT_COMPLETED'] },
  { key: 'evidence', label: t('입금 확정 · 증빙 앵커', 'credit confirmed · evidence anchored'),
    short: t('증빙 앵커', 'Evidence anchor'),
    types: ['EVIDENCE_INSUFFICIENT', 'SETTLEMENT_RECONCILED', 'EVIDENCE_COMMITTED', 'EVIDENCE_ANCHORED'],
    done: ['EVIDENCE_ANCHORED'] },
];

/**
 * The events that end a settlement before it completes, and the leg each
 * ends it on. `null` means "the first leg that had not completed": the
 * platform records an EXCEPTION from whichever leg threw, and a cancellation
 * lands wherever the payment was. A failed reconciliation is the evidence
 * leg's own ending, recognised by its payload rather than by its type.
 */
const TERMINAL: Record<string, Leg['key'] | null> = {
  EXCEPTION: null,
  CANCEL_REQUESTED: null,
  TRAVEL_RULE_REJECTED: 'travel',
  PAYOUT_FAILED: 'payout',
  USDC_RETURNED: 'payout',
};

interface LegVerdict { status: LegStatus; at: string | null; detail: string }

const payloadOf = (e: SettlementEvent | null): Record<string, unknown> =>
  e && e.payload && typeof e.payload === 'object' ? e.payload as Record<string, unknown> : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Read every leg from the events. The terminal events are the authority:
 * once one exists, the leg it ended is failed, nothing after it was
 * reached, and nothing can read "in progress" or "held" on a payment that
 * stopped. Without one, a leg is done when its completing event exists,
 * held while a request is open, and in progress while it has events.
 */
function legVerdicts(d2: SettlementDetail): LegVerdict[] {
  const events = d2.events;
  const has = (type: string): boolean => events.some((e) => e.type === type);
  const lastOf = (types: string[]): SettlementEvent | null =>
    [...events].reverse().find((e) => types.includes(e.type)) ?? null;
  const doneFlags = LEGS.map((leg) => leg.done.some(has));
  const reconciled = lastOf(['SETTLEMENT_RECONCILED']);
  const reconFailed = reconciled !== null && payloadOf(reconciled)['pass'] === false;
  const terminal = events.find((e) => Object.hasOwn(TERMINAL, e.type)) ?? null;

  let failedAt = -1;
  let failEvent: SettlementEvent | null = null;
  let failDetail = '';
  if (terminal) {
    const target = TERMINAL[terminal.type];
    failedAt = target ? LEGS.findIndex((l) => l.key === target) : doneFlags.findIndex((x) => !x);
    if (failedAt < 0) failedAt = LEGS.length - 1;
    failEvent = terminal;
    const p = payloadOf(terminal);
    const reason = str(p['error']) || str(p['reason']) || str(payloadOf(lastOf(['PAYOUT_FAILED']))['reason']);
    failDetail = reason || (
      terminal.type === 'CANCEL_REQUESTED' ? t('은행 요청으로 취소', "cancelled at the bank's request")
        : terminal.type === 'TRAVEL_RULE_REJECTED' ? t('수취기관 거절', 'rejected by the receiving institution')
          : terminal.type === 'USDC_RETURNED' ? t('USDC 반환', 'USDC returned')
            : t('현지 지급 실패', 'local payout failed'));
  } else if (reconFailed || d2.state === 'EXCEPTION') {
    failedAt = LEGS.length - 1;
    failEvent = reconciled;
    failDetail = t('대사 불일치 — 예외로 분류', 'reconciliation failed — filed as an exception');
  }

  return LEGS.map((leg, i): LegVerdict => {
    const last = lastOf(leg.types);
    const at = last?.at ?? null;
    if (failedAt >= 0) {
      if (i === failedAt) return { status: 'failed', at: failEvent?.at ?? at, detail: failDetail };
      if (i > failedAt) return { status: 'unreached', at: null, detail: '' };
      return { status: doneFlags[i] ? 'done' : 'unreached', at, detail: '' };
    }
    if (leg.key === 'evidence') {
      if (d2.state === 'EVIDENCE_ANCHORED' || doneFlags[i]) return { status: 'done', at, detail: '' };
      if (d2.state === 'BENEFICIARY_CREDIT_CONFIRMED') {
        return { status: 'active', at, detail: t('입금 확정 · 앵커 대기', 'credit confirmed · anchor pending') };
      }
      const held = lastOf(['EVIDENCE_INSUFFICIENT', 'SETTLEMENT_RECONCILED']);
      if (held?.type === 'EVIDENCE_INSUFFICIENT') {
        return { status: 'pending', at: null,
          detail: t('은행의 서명된 지급 확인이 오면 확정됩니다', 'confirmed once the bank\'s signed payout confirmation arrives') };
      }
      return { status: last ? 'active' : 'pending', at, detail: '' };
    }
    if (leg.key === 'payout' && doneFlags[i]) {
      // A completion that is only a message (L1) is not a completion the
      // platform confirms: the leg stays in caution until a signed one lands.
      const completed = lastOf(['PAYOUT_COMPLETED']);
      const level = str(payloadOf(completed)['evidence_level']) || (d2.evidence_level ?? '');
      const confirmed = reconciled !== null
        || d2.state === 'BENEFICIARY_CREDIT_CONFIRMED' || d2.state === 'EVIDENCE_ANCHORED';
      if (level === 'L1' && !confirmed) {
        return { status: 'held', at: completed?.at ?? at,
          detail: t('완료 보고 — 증거 불충분, 미검증', 'completion reported — insufficient evidence, unverified') };
      }
      return { status: 'done', at, detail: '' };
    }
    if (doneFlags[i]) return { status: 'done', at, detail: '' };
    if (leg.hold) {
      const h = lastOf([leg.hold.open, leg.hold.close]);
      if (h?.type === leg.hold.open) {
        return { status: 'held', at,
          detail: t('추가정보 요청(RFI) — 회신 대기', 'information request (RFI) — awaiting the reply') };
      }
    }
    return { status: last ? 'active' : 'pending', at, detail: '' };
  });
}

const LEG_STATUS: Record<LegStatus, { label: string; chip: string; glyph: string }> = {
  done: { label: t('완료', 'done'), chip: 'ok', glyph: '✓' },
  active: { label: t('진행중', 'in progress'), chip: 'wait', glyph: '' },
  held: { label: t('보류', 'held'), chip: 'wait', glyph: '‖' },
  failed: { label: t('실패', 'failed'), chip: 'inert', glyph: '✕' },
  pending: { label: t('대기', 'pending'), chip: 'inert', glyph: '' },
  unreached: { label: t('미진행', 'not reached'), chip: 'inert', glyph: '' },
};

/** "02:14:05" — seconds matter on a tracker: a sandbox payment crosses its legs in a few of them. */
const clockOf = (iso: string | null | undefined): string => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString().slice(11, 19);
};

/**
 * The same five legs, drawn: how far the payment has come, at a glance.
 *
 * The list beneath says what each leg carried. This says where the money is
 * — the three amounts it turns into, each lit once the leg that produces it
 * has completed, and the legs as a line of stations with the one in motion
 * marked. It adds no fact of its own: every mark is one of `legVerdicts`'
 * statuses, so the picture can never say more than the signed events do. An
 * amount that is not lit is the quoted figure, and is labelled as planned.
 */
function journeyHtml(d2: SettlementDetail, verdicts: LegVerdict[], live: boolean, fresh: boolean): string {
  const of = (key: Leg['key']): LegVerdict => verdicts[LEGS.findIndex((l) => l.key === key)]!;
  const money = (a: { value: string; currency?: string; asset?: string }): string =>
    `${fmtMoney(a.value)} ${a.currency ?? a.asset ?? ''}`;
  const failedAt = verdicts.findIndex((v) => v.status === 'failed');
  const heldAt = verdicts.findIndex((v) => v.status === 'held');
  const doneCount = verdicts.filter((v) => v.status === 'done').length;
  const allDone = doneCount === LEGS.length;
  const currentAt = failedAt >= 0 ? failedAt : heldAt >= 0 ? heldAt : verdicts.findIndex((v) => v.status !== 'done');
  const leg = currentAt >= 0 ? LEGS[currentAt]!.short : '';
  const tone = allDone ? 'ok' : failedAt >= 0 ? 'stop' : heldAt >= 0 ? 'hold' : 'run';
  const headline = allDone ? t('송금 완료 — 지급 확인, 증빙 앵커', 'Completed — payout confirmed, evidence anchored')
    : failedAt >= 0 ? t(`중단 — ${leg} 단계에서 멈췄습니다`, `Stopped at ${leg}`)
      : heldAt >= 0 ? t(`보류 — ${leg}`, `On hold — ${leg}`)
        : t(`진행중 — ${leg}`, `In progress — ${leg}`);
  // What a parked or waiting leg is waiting for. A leg that failed gives its
  // reason in the list beneath, as recorded — the picture says where.
  const note = currentAt >= 0 && failedAt < 0 ? verdicts[currentAt]!.detail : '';

  const first = d2.events[0]?.at ?? d2.created_at;
  const last = d2.events[d2.events.length - 1]?.at ?? d2.updated_at;
  const seconds = Math.max(0, Math.round((Date.parse(last) - Date.parse(first)) / 1000));
  const ended = allDone || failedAt >= 0;
  const meta = [
    t(`${LEGS.length}단계 중 ${doneCount}단계 완료`, `${doneCount} of ${LEGS.length} legs done`),
    ended ? (seconds > 0 ? t(`소요 ${fmtDur(seconds)}`, `took ${fmtDur(seconds)}`) : '')
      : clockOf(first) ? t(`시작 ${clockOf(first)} UTC`, `started ${clockOf(first)} UTC`) : '',
  ].filter(Boolean).join(' · ');

  const stops = [
    { lit: of('accept').status === 'done', who: t(`송금 은행 · ${d2.corridor.origin}`, `Sending bank · ${d2.corridor.origin}`),
      amount: money(d2.amounts.collected), what: t('수납', 'collected') },
    { lit: of('settle').status === 'done', who: t('정산 구간', 'Settlement leg'),
      amount: money(d2.amounts.settled), what: t('USDC 정산', 'settled in USDC') },
    { lit: of('payout').status === 'done', who: t(`수취기관 · ${d2.corridor.destination}`, `Receiving institution · ${d2.corridor.destination}`),
      amount: money(d2.amounts.paid), what: t('현지 통화 지급', 'paid out locally') },
  ];
  const planned = failedAt >= 0 ? t('미진행', 'not reached') : t('예정', 'planned');

  return `
    <div class="journey ${tone}${fresh ? ' fresh' : ''}">
      <div class="jhead">
        <span class="jstate"><i aria-hidden="true"></i><b>${esc(headline)}</b></span>
        <span class="jmeta">${esc(meta)}</span>
        ${live ? `<span class="jlive"><i aria-hidden="true"></i>${esc(t('실시간 갱신 중', 'live'))}</span>` : ''}
      </div>
      ${note ? `<p class="jnote">${esc(note.length > 160 ? `${note.slice(0, 160)}…` : note)}</p>` : ''}
      <div class="jflow">${stops.map((x, i) => `${i > 0 ? `<span class="jarrow${x.lit ? ' lit' : ''}" aria-hidden="true"></span>` : ''}
        <div class="jstop${x.lit ? ' lit' : ''}">
          <small>${esc(x.who)}</small>
          <b>${esc(x.amount)}</b>
          <small>${esc(x.what)}${x.lit ? '' : ` · ${esc(planned)}`}</small>
        </div>`).join('')}
      </div>
      <ol class="jsteps">${LEGS.map((l, i) => {
        const v = verdicts[i]!;
        return `
        <li class="jstep ${v.status}"${i === currentAt ? ' aria-current="step"' : ''}>
          <span class="jnode" aria-hidden="true">${LEG_STATUS[v.status].glyph || String(i + 1)}</span>
          <b>${esc(l.short)}</b>
          <small>${esc(v.status === 'done' && clockOf(v.at) ? clockOf(v.at) : LEG_STATUS[v.status].label)}</small>
        </li>`;
      }).join('')}</ol>
    </div>`;
}

function trackerHtml(d2: SettlementDetail, live = false, fresh = false): string {
  const lastOf = (types: string[]): SettlementEvent | null =>
    [...d2.events].reverse().find((e) => types.includes(e.type)) ?? null;
  const amt = (a: { value: string; currency?: string; asset?: string }): string =>
    `${fmtMoney(a.value)} ${a.currency ?? a.asset ?? ''}`;
  const hash = (h: string, label: string): string =>
    `<span class="dim">${esc(label)}</span> <span class="mono" title="${esc(h)}">${esc(short(h, 8))}</span>`;
  // What each leg says beneath its status: the figures that moved on it and
  // the identifier the counterparty handed over, or the verdict's own text.
  const detailOf = (leg: Leg, v: LegVerdict): string => {
    if (v.status === 'failed') {
      const ret = leg.key === 'payout' ? str(payloadOf(lastOf(['USDC_RETURNED']))['tx_hash']) : '';
      const sent = leg.key === 'settle' && d2.chain_tx
        ? ` · <span class="dim">${esc(t('거래해시', 'tx'))}</span> ${chainTxHtml(d2.chain_tx)}<div class="chainslot" data-chain-slot><span class="dim">${esc(t('체인 노드에 묻는 중…', 'Asking the chain node…'))}</span></div>`
        : '';
      return `<span title="${esc(v.detail)}">${esc(v.detail.length > 160 ? `${v.detail.slice(0, 160)}…` : v.detail)}</span>${
        ret ? ` · ${hash(ret, t('반환 거래해시', 'return tx'))}` : ''}${sent}`;
    }
    if (v.status === 'unreached') return '';
    switch (leg.key) {
      case 'accept': {
        // A payment made from the bank's own SWIFT message carries that
        // message's references, signed into the instruction by the bank —
        // the numbers the bank's operators already know the payment by.
        const instruction = payloadOf(lastOf(['BANK_EVIDENCE_SUBMITTED']))['bankInstruction'] as
          { sourceMessage?: Record<string, unknown> } | undefined;
        const src = instruction && typeof instruction === 'object' ? instruction.sourceMessage : undefined;
        const ref = (label: string, value: string): string =>
          (value ? ` · <span class="dim">${esc(label)}</span> <span class="mono">${esc(value)}</span>` : '');
        const source = src && typeof src === 'object'
          ? `${ref(t('SWIFT 전문', 'SWIFT message'), str(src['type']))}${ref('UETR', str(src['uetr']))}${
            ref(t('은행 지시번호', 'bank instruction id'), str(src['instructionId']))}`
          : '';
        return `${esc(t('지시', 'instructed'))} <b>${esc(amt(d2.amounts.trade))}</b> · ${esc(t('수납', 'collected'))} ${esc(amt(d2.amounts.collected))}${source}`;
      }
      case 'travel':
        return v.detail ? esc(v.detail)
          : v.status === 'done' ? esc(t('수취기관 수신 확인', 'acknowledged by the receiving institution')) : '';
      case 'settle': {
        const tx = d2.chain_tx ?? str(payloadOf(lastOf(['USDC_TRANSFER_CONFIRMED']))['tx_hash']);
        return `<b>${esc(amt(d2.amounts.settled))}</b>${tx ? ` · <span class="dim">${esc(t('거래해시', 'tx'))}</span> ${chainTxHtml(tx)}` : ''}${
          d2.chain_tx ? `<div class="chainslot" data-chain-slot><span class="dim">${esc(t('체인 노드에 묻는 중…', 'Asking the chain node…'))}</span></div>` : ''}`;
      }
      case 'payout': {
        // The proof that local money moved is the beneficiary institution's
        // own signed completion — the counterpart of a credit confirmation on
        // a messaging network. Named here, with its signature state; the
        // signed message itself is in the evidence package.
        const done = lastOf(['PAYOUT_COMPLETED']);
        const ref = str(payloadOf(done)['bank_reference']);
        // Every partner callback is signed in transit; what proves the payout
        // is the institution's signature on the receipt itself — the one the
        // evidence engine judges (absent, or status ABSENT, is unsigned: L1).
        const receipt = payloadOf(done)['payout_receipt_element'] as { signature?: { status?: string; value?: string } } | undefined;
        const signed = receipt && typeof receipt === 'object'
          ? Boolean(receipt.signature?.value) && receipt.signature?.status !== 'ABSENT'
          : str(payloadOf(done)['evidence_level']) !== 'L1';
        const by = done && done.issuer !== 'STONEHASH'
          ? ` · <span class="dim">${esc(t('확인 기관', 'confirmed by'))}</span> <span class="mono">${esc(done.issuer)}</span>${
              signed ? ` <span class="chip ok">${esc(t('서명됨', 'signed'))}</span>` : ` <span class="chip inert">${esc(t('서명 없음', 'unsigned'))}</span>`}`
          : '';
        return `<b>${esc(amt(d2.amounts.paid))}</b>${
          ref ? ` · <span class="dim">${esc(t('은행 참조번호', 'bank reference'))}</span> <span class="mono">${esc(ref)}</span>` : ''}${by}${
          v.detail ? ` · ${esc(v.detail)}` : ''}`;
      }
      case 'evidence': {
        const word = v.detail || (v.status === 'done' ? t('입금 확정', 'credit confirmed') : '');
        return `${esc(word)}${d2.attestation ? ` · <span class="dim">${esc(t('앵커', 'anchor'))}</span> ${statusChip(d2.attestation.status)}` : ''}`;
      }
      default:
        return '';
    }
  };
  const verdicts = legVerdicts(d2);
  return `${journeyHtml(d2, verdicts, live, fresh)}<ol class="legs">${LEGS.map((leg, i) => {
    const v = verdicts[i]!;
    return `
      <li class="leg ${v.status}">
        <span class="lmark" aria-hidden="true"></span>
        <div class="lbody">
          <div class="lhead"><b>${esc(leg.label)}</b>
            <span class="chip ${LEG_STATUS[v.status].chip}">${esc(LEG_STATUS[v.status].label)}</span>
            ${v.at ? `<span class="dim">${esc(when(v.at))}</span>` : ''}</div>
          <div class="ldetail">${detailOf(leg, v)}</div>
        </div>
      </li>`;
  }).join('')}</ol>`;
}

// ── 내보내기: the filtered ledger as a CSV ──────────────────────────────────

/*
 * Walks the same pages the screen walks, so what is exported is exactly what
 * the filter shows — for the reporting a bank's operations and compliance
 * teams do in a spreadsheet. Capped, and the cap is announced, never silent.
 */
const EXPORT_MAX = 5000;

async function exportRemitCsv(say: (msg: string) => void): Promise<void> {
  const rows: string[][] = [[
    'payment_id', 'state', 'origin', 'destination', 'trade_currency', 'trade_value',
    'collected_currency', 'collected_value', 'paid_currency', 'paid_value', 'evidence_level',
    'chain_tx', 'attestation_id', 'attestation_status', 'created_at', 'updated_at',
  ]];
  // The filter as it was when the button was pressed: a keyset cursor belongs
  // to one filter, and a change mid-export must not splice two into one file.
  const query = remitQuery();
  let cursor: string | null = null;
  let total = 0;
  do {
    const page = await api.settlements({
      ...query,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    total = page.page.total;
    for (const x of page.data) {
      rows.push([x.payment_id, x.state, x.corridor.origin, x.corridor.destination,
        x.trade.currency, x.trade.value, x.collected.currency, x.collected.value,
        x.paid.currency, x.paid.value, x.evidence_level ?? '', x.chain_tx ?? '',
        x.attestation?.id ?? '', x.attestation?.status ?? '', x.created_at, x.updated_at]);
    }
    cursor = page.page.next_cursor;
    say(`${rows.length - 1} / ${total}`);
  } while (cursor && rows.length - 1 < EXPORT_MAX);
  const n = rows.length - 1;
  // A byte-order mark, so a spreadsheet opening it by double-click reads the
  // UTF-8 rather than guessing a legacy encoding for any non-ASCII value.
  const csv = `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `settlements-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
  say(n < total
    ? t(`${n}건 내보냄 — 전체 ${total}건 중 처음 ${EXPORT_MAX}건까지`, `exported ${n} of ${total} — the first ${EXPORT_MAX}`)
    : t(`${n}건 내보냄`, `exported ${n}`));
}

/** One cell: quoted when it must be, and never read as a formula by a spreadsheet. */
function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Draw the customer-facing progress summary; signed events stay in the evidence export. */
function paintTracker(holder: Element, id: string, d2: SettlementDetail, live: boolean): void {
  // Animate the route only when first opened, not on a live refresh.
  const fresh = !holder.querySelector('.journey');
  holder.innerHTML = trackerHtml(d2, live, fresh);
  // The chain's own answer, after the legs: a slow node must not hold
  // up the tracker, and a failed ask is said where the answer would be.
  const slot = holder.querySelector<HTMLElement>('[data-chain-slot]');
  if (slot) {
    void api.settlementChain(id).then((c) => { slot.innerHTML = chainStatusHtml(c); })
      .catch(() => { slot.innerHTML = `<span class="dim">${esc(t('체인 노드에 묻지 못했습니다', 'the chain node could not be asked'))}</span>`; });
  }
}

/*
 * Following a payment.
 *
 * A tracker read once is a photograph: the payment moves on and the row keeps
 * saying where it was. While a row is open and the payment can still move,
 * the page asks again every few seconds and redraws only when the answer
 * changed — so nothing flickers, an open event log stays open, and the chain
 * node is asked again only when there is something new to ask about. It
 * stops when the row is closed, when the list is redrawn, when the payment
 * reaches an end, or after ten minutes: a payment parked on a request can
 * stay parked for days, and an open tab should not ask forever.
 */
const FOLLOW_EVERY_MS = 2_500;
const FOLLOW_MAX = 240;
/** payment id → the follow that is current. A click supersedes the one before it. */
const followGen = new Map<string, number>();

/** Whether anything the tracker shows can still change. */
function trackerSettled(d2: SettlementDetail, verdicts: LegVerdict[]): boolean {
  if (verdicts.some((v) => v.status === 'failed')) return true;
  return verdicts.every((v) => v.status === 'done') && (!d2.attestation || d2.attestation.status === 'confirmed');
}

async function followSettlement(list: HTMLElement, row: HTMLTableRowElement, id: string, gen: number, polls: number): Promise<void> {
  const current = (): boolean => followGen.get(id) === gen && row.isConnected && !row.classList.contains('rx-hidden');
  const holder = row.querySelector('.rxbody');
  if (!holder || !current()) return;
  const again = (): void => {
    window.setTimeout(() => { void followSettlement(list, row, id, gen, polls + 1); }, FOLLOW_EVERY_MS);
  };
  let d2: SettlementDetail;
  try {
    d2 = await api.settlement(id);
  } catch (e) {
    if (!current()) return;
    // Nothing drawn yet: say why, and let the next click try again.
    // Mid-follow: keep what is shown and ask again.
    if (row.dataset['stamp']) again();
    else holder.innerHTML = `<p class="muted">${esc(String(e))}</p>`;
    return;
  }
  if (!current()) return;
  const verdicts = legVerdicts(d2);
  const live = !trackerSettled(d2, verdicts) && polls < FOLLOW_MAX;
  const stamp = [d2.state, d2.events.length, d2.attestation?.status ?? '', d2.chain_tx ?? '', d2.evidence_level ?? '', live].join('|');
  if (row.dataset['stamp'] !== stamp) {
    const moved = Boolean(row.dataset['stamp']);
    row.dataset['stamp'] = stamp;
    paintTracker(holder, id, d2, live);
    // The line above an open tracker must not contradict it.
    if (moved) syncLedgerRow(list, row, d2);
  }
  if (live) again();
}

/** Redraw the ledger line of a payment the tracker has just seen move. */
function syncLedgerRow(list: HTMLElement, row: HTMLTableRowElement, d2: SettlementDetail): void {
  const main = row.previousElementSibling;
  if (!(main instanceof HTMLTableRowElement)) return;
  const tmp = document.createElement('tbody');
  tmp.innerHTML = remitRowHtml({
    payment_id: d2.payment_id, state: d2.state, corridor: d2.corridor,
    trade: d2.amounts.trade, collected: d2.amounts.collected, paid: d2.amounts.paid,
    evidence_level: d2.evidence_level, evidence_available: d2.evidence_available,
    chain_tx: d2.chain_tx, attestation: d2.attestation,
    created_at: d2.created_at, updated_at: d2.updated_at,
  });
  const fresh = tmp.querySelector('tr');
  if (!fresh) return;
  main.className = fresh.className;
  main.innerHTML = fresh.innerHTML;
  wireRemitRows(list);
}

/** Wire expand/download on rows that have not been wired yet. */
function wireRemitRows(list: HTMLElement): void {
  for (const btn of list.querySelectorAll<HTMLButtonElement>('button[data-remit-toggle]')) {
    if (btn.dataset['wired']) continue;
    btn.dataset['wired'] = '1';
    btn.addEventListener('click', () => {
      const id = btn.dataset['remitToggle']!;
      const row = list.querySelector<HTMLTableRowElement>(`tr[data-rx="${CSS.escape(id)}"]`);
      if (!row) return;
      row.classList.toggle('rx-hidden');
      // Either way the follow before this click is over: closing ends it,
      // and opening starts a fresh one from what the platform says now.
      const gen = (followGen.get(id) ?? 0) + 1;
      followGen.set(id, gen);
      if (!row.classList.contains('rx-hidden')) void followSettlement(list, row, id, gen, 0);
    });
  }
  for (const a of list.querySelectorAll<HTMLButtonElement>('button[data-remit-ev]')) {
    if (a.dataset['wired']) continue;
    a.dataset['wired'] = '1';
    a.addEventListener('click', () => {
      const id = a.dataset['remitEv']!;
      void api.settlementEvidence(id).then((pkg) => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
        const tmp = document.createElement('a');
        tmp.href = url;
        tmp.download = `evidence-${id}.json`;
        tmp.click();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      }).catch((e) => alert(e instanceof Error ? e.message : String(e)));
    });
  }
}

async function fetchRemitPage(reset: boolean): Promise<void> {
  const list = document.getElementById('remitList');
  const pager = document.getElementById('remitPager');
  if (!list || !pager) return;
  if (reset) {
    remitView.cursor = null;
    remitView.shown = 0;
    list.innerHTML = `<p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p>`;
    // A "더 보기" left from the old filter must not fetch into the new one.
    pager.innerHTML = '';
  } else if (!remitView.cursor) {
    return;
  }
  // Two filter changes in quick succession must not both land: the earlier
  // response would append its rows under the later filter's heading.
  const token = ++remitView.req;
  const page = await api.settlements({
    ...remitQuery(),
    ...(remitView.cursor ? { cursor: remitView.cursor } : {}),
    limit: REMIT_PAGE_SIZE,
  });
  if (token !== remitView.req) return;
  if (reset) {
    // Board layout: one column per fact, the three amounts centred as a
    // group, the whole thing scrolling sideways inside .tablewrap on a narrow
    // screen instead of wrapping. The time is the transaction's, named so.
    list.innerHTML = `<div class="tablewrap"><table class="rtab">
      <thead><tr>
        <th>${esc(t('거래 ID', 'Payment id'))}</th>
        <th>${esc(t('상태', 'State'))}</th>
        <th>${esc(t('경로', 'Corridor'))}</th>
        <th class="mid">${esc(t('송금액', 'Remittance'))}</th>
        <th class="mid">${esc(t('수납액', 'Collected'))}</th>
        <th class="mid">${esc(t('지급액', 'Paid out'))}</th>
        <th>${esc(t('체인 거래', 'Chain tx'))}</th>
        <th>${esc(t('거래일시', 'Transaction time'))}</th>
        <th></th>
      </tr></thead><tbody id="remitTbody"></tbody></table></div>`;
  }
  const tbody = document.getElementById('remitTbody');
  if (tbody && page.data.length > 0) {
    tbody.insertAdjacentHTML('beforeend', page.data.map(remitRowHtml).join(''));
    wireRemitRows(tbody);
  }
  remitView.cursor = page.page.next_cursor;
  remitView.total = page.page.total;
  remitView.shown += page.data.length;
  if (remitView.shown === 0) {
    /*
     * Empty and unfiltered: say how this ledger fills. It used to send the
     * reader to the demo bank, which is another organisation — nothing sent
     * there ever appears in this one's ledger.
     */
    list.innerHTML = remitView.q || remitView.state || remitView.from || remitView.to
      ? `<p class="muted">${esc(t('조건에 맞는 거래가 없습니다.', 'No settlements match the filter.'))}</p>`
      : `<p class="muted">${esc(t('아직 지시된 거래가 없습니다. 귀행이 SDK로 송금을 보내면 이 목록에 나타납니다.',
          'No settlements yet. They appear here once your bank sends one with the SDK.'))}
          <a data-link="attest-docs" data-link-hash="corridor" target="_blank" rel="noopener">${esc(t('국경간 송금 가이드 ↗', 'Cross-border Settlement guide ↗'))}</a></p>`;
    // Drawn after the page's own pass over its links.
    resolveLinks(list);
  }
  const counter = `${esc(t('전체', 'Total'))} ${remitView.total.toLocaleString()}${esc(t('건 중', ' —'))} ${remitView.shown.toLocaleString()}${esc(t('건 표시', ' shown'))}`;
  pager.innerHTML = `
    <small class="muted">${counter}</small>
    ${remitView.cursor ? `<button type="button" class="ghost" id="remitMore">${esc(t('더 보기', 'Load more'))}</button>` : ''}`;
  document.getElementById('remitMore')?.addEventListener('click', () => {
    void fetchRemitPage(false).catch((e) => { pager.innerHTML = `<p class="muted">${esc(String(e))}</p>`; });
  });
}

async function loadRemit(): Promise<void> {
  const list = document.getElementById('remitList');
  if (!list) return;
  // One listener on the list, which this render created: rows are appended
  // by "더 보기" and the tracker renders later, so per-button binding would miss.
  list.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    const b = target.closest<HTMLElement>('[data-copy-tx]');
    const src = b?.previousElementSibling;
    if (b && src instanceof HTMLElement) { copyText(src, b); return; }
    const open = target.closest<HTMLElement>('[data-remit-open]');
    if (!open) return;
    const id = open.dataset['remitOpen']!;
    const row = list.querySelector<HTMLElement>(`tr[data-rx="${CSS.escape(id)}"]`);
    if (row?.classList.contains('rx-hidden')) {
      list.querySelector<HTMLButtonElement>(`button[data-remit-toggle="${CSS.escape(id)}"]`)?.click();
    }
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  try {
    const prod = await api.products();
    if (!prod.products.some((x) => x.product === 'remit' && x.status === 'active')) {
      list.innerHTML = `<p class="muted">${esc(t('송금 상품이 비활성입니다.', 'The settlement product is not active.'))}
        <a href="#/products">${esc(t('구독에서 활성화', 'Activate under Subscriptions'))}</a></p>`;
      // Controls with nothing behind them are a promise the screen cannot keep.
      document.querySelector<HTMLElement>('.rtools')?.setAttribute('hidden', '');
      return;
    }

    // Toolbar: the input debounces into a server-side search; the select
    // narrows by state. Both reset to page one — the cursor belongs to one
    // filter combination and must not survive into another.
    const qInput = document.getElementById('remitQ') as HTMLInputElement | null;
    const stSelect = document.getElementById('remitState') as HTMLSelectElement | null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    qInput?.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        // The reader may have left the ledger while the timer was pending: a
        // detached input must not rewrite the address of the page now shown.
        if (!qInput.isConnected) return;
        remitView.q = qInput.value.trim();
        history.replaceState(null, '', remitHash());
        void fetchRemitPage(true).catch((e) => { list.innerHTML = `<p class="muted">${esc(String(e))}</p>`; });
      }, 300);
    });
    stSelect?.addEventListener('change', () => {
      remitView.state = stSelect.value;
      // Keep the address honest: a preset that arrived in the hash must not
      // outlive the reader changing their mind, or a reload re-applies it.
      // replaceState does not fire hashchange, so nothing re-renders.
      history.replaceState(null, '', remitHash());
      void fetchRemitPage(true).catch((e) => { list.innerHTML = `<p class="muted">${esc(String(e))}</p>`; });
    });
    // The transaction-date range: either end may be left open.
    for (const [id, key] of [['remitFrom', 'from'], ['remitTo', 'to']] as const) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      input?.addEventListener('change', () => {
        remitView[key] = input.value;
        void fetchRemitPage(true).catch((e) => { list.innerHTML = `<p class="muted">${esc(String(e))}</p>`; });
      });
    }
    const exportBtn = document.getElementById('remitExport') as HTMLButtonElement | null;
    exportBtn?.addEventListener('click', () => {
      const msg = document.getElementById('remitExportMsg');
      const say = (x: string): void => { if (msg) msg.textContent = x; };
      exportBtn.disabled = true;
      void exportRemitCsv(say)
        .catch((e) => say(e instanceof Error ? e.message : String(e)))
        .finally(() => { exportBtn.disabled = false; });
    });

    // A dashboard row can land here on one settlement (`?q=`) or one state;
    // an unknown state is ignored rather than sent to the server as a filter.
    const presetQ = routeQuery().get('q') ?? '';
    remitView.q = presetQ;
    if (qInput) qInput.value = presetQ;
    remitView.from = '';
    remitView.to = '';
    const preset = routeQuery().get('state') ?? '';
    remitView.state = isRemitFilter(preset) ? preset : '';
    if (stSelect) stSelect.value = remitView.state;
    await fetchRemitPage(true);
  } catch (e) {
    list.innerHTML = `<p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

/**
 * 상품 — the customer's self-serve path, end to end.
 *
 * Three product cards, one state each: inactive shows the setup form,
 * active shows what integration starts from. The signing key
 * a product needs can be minted **in this browser**: WebCrypto generates
 * P-256, the private half downloads to the visitor's machine as a PEM —
 * the only copy — and only the public half is registered. That is the same
 * custody story the HSM integrations tell, told at sandbox scale.
 */
/**
 * 대시보드 — 로그인 직후 서는 곳.
 *
 * Rows, not a grid. What needs a person comes first, then one full-width
 * row per subscribed product, in the order a bank reads its morning. The
 * two-across grid this replaced was right for three equal summaries and
 * wrong the moment a fourth card appeared: the subscriptions card restated
 * numbers the product rows already carried, and in a grid a new product
 * reshapes every other card, while a row only ever adds a row.
 *
 * Each row is two halves. The left is the operational numbers that were
 * already here. The right is what every console this product is measured
 * against — payment platforms, anchoring services, reserve-proof pages —
 * puts beside its numbers: the last few things that happened, so a figure
 * like "5 in flight" has faces. The API had been returning all of it since
 * the dashboard call was written; the page simply never drew it. Nothing
 * on this screen comes from a string in this file.
 */
type Dash = Awaited<ReturnType<typeof api.dashboard>>;
type AttestBilling = Awaited<ReturnType<typeof api.products>>['billing']['attest'];

function sectionHome(): string {
  return `
    <div id="homeCards" class="dashrows">
      <section class="card"><p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p></section>
    </div>`;
}

/** "3분 12초" — a duration a person reads, not a float. */
function fmtDur(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return `${seconds}${t('초', 's')}`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}${t('분', 'm')}`;
  return `${(seconds / 3600).toFixed(1)}${t('시간', 'h')}`;
}

/**
 * "4분 전" — for a feed, where the question is how recently, not when.
 * Callers put the exact instant in a `title`, so hovering answers that too.
 */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return t('방금', 'just now');
  if (m < 60) return `${m}${t('분 전', 'm ago')}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}${t('시간 전', 'h ago')}`;
  return `${Math.round(h / 24)}${t('일 전', 'd ago')}`;
}

const fmtUsd = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function statHtml(label: string, value: string, sub = ''): string {
  return `<div class="stat"><b>${value}</b><small>${esc(label)}${sub ? ` · ${esc(sub)}` : ''}</small></div>`;
}

/**
 * One product row: its heading and one outbound link, then the two halves —
 * or one, when there is nothing on the right yet and the left reads across.
 */
function opsRow(o: { product: string; title: string; sub: string; link: string; main: string; side?: string }): string {
  return `
    <section class="card prow${o.side === undefined ? ' single' : ''}" data-product="${esc(o.product)}">
      <div class="cardhead">
        <h2>${o.title} <span class="dim">· ${esc(o.sub)}</span></h2>
        ${o.link}
      </div>
      <div class="prowbody">
        <div class="prowmain">${o.main}</div>
        ${o.side === undefined ? '' : `<aside class="prowside">${o.side}</aside>`}
      </div>
    </section>`;
}

/**
 * Money as the API spelled it: the decimals it sent are the decimals shown,
 * with thousands grouped — "500.00 USD" stays "500.00", "22732866" VND
 * becomes "22,732,866". Rounding a settlement figure for display would make
 * the console disagree with the ledger it is a view of.
 */
/**
 * A settlement's on-chain transaction: a link when this deployment names an
 * explorer for its rail, otherwise the hash itself with a copy button — the
 * sandbox rail is a local chain no explorer indexes, and a link that opened
 * nothing would say less than the honest hash.
 */
function chainTxHtml(tx: string | null | undefined): string {
  if (!tx) return `<span class="dim">—</span>`;
  const tpl = st.overview?.settlement_explorer_tx_url;
  if (tpl) {
    return `<a class="mono txlink" href="${esc(tpl.replace('{tx}', encodeURIComponent(tx)))}" target="_blank" rel="noopener"
      title="${esc(t('익스플로러에서 보기', 'Open in the explorer'))}">${esc(short(tx, 5))} <span aria-hidden="true">↗</span></a>`;
  }
  // The hash is the button: narrow enough for the ledger, and one click
  // copies the full value (the off-screen span is what gets copied).
  return `<span class="txcopy"><span class="vh">${esc(tx)}</span><button type="button" class="link mono" data-copy-tx
      title="${esc(t('샌드박스 체인 — 공개 익스플로러가 없어 클릭하면 거래해시를 복사합니다', 'Sandbox chain — no public explorer; click to copy the hash'))}">${esc(short(tx, 5))}</button></span>`;
}

/**
 * What a pasted key is, from its DER alone: an SPKI public key opens with a
 * SEQUENCE (the algorithm), every private-key container (PKCS#8, SEC1,
 * PKCS#1) with an INTEGER (the version). Used to refuse a private key before
 * it leaves the page, and to keep keys that could never verify out of the
 * pickers. The server checks again; this only stops the obvious early.
 */
function keyShape(b64: string): 'spki' | 'private' | 'invalid' {
  let der: Uint8Array;
  try { der = Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)); } catch { return 'invalid'; }
  if (der.length < 60 || der[0] !== 0x30) return 'invalid';
  const lenByte = der[1]!;
  const start = lenByte < 0x80 ? 2 : 2 + (lenByte & 0x7f);
  const inner = der[start];
  return inner === 0x30 ? 'spki' : inner === 0x02 ? 'private' : 'invalid';
}

/**
 * The ledger's chain column. With an explorer configured for the rail the
 * hash opens it; without one (the sandbox's local chain) it opens this row's
 * tracker, whose settlement leg asks the chain node directly.
 */
function chainTxCellHtml(paymentId: string, tx: string | null | undefined): string {
  if (!tx) return `<span class="dim">—</span>`;
  if (st.overview?.settlement_explorer_tx_url) return chainTxHtml(tx);
  return `<button type="button" class="link mono" data-remit-open="${esc(paymentId)}"
      title="${esc(t('추적을 열어 체인 노드의 현재 답(블록·확인 수)을 봅니다', 'Open the tracker to see what the chain node says now — block and confirmations'))}">${esc(short(tx, 5))}</button>`;
}

/** The chain node's answer, as one line in the tracker's settlement leg. */
function chainStatusHtml(c: Awaited<ReturnType<typeof api.settlementChain>>): string {
  const chip = (tone: string, label: string): string => `<span class="chip ${tone}">${esc(label)}</span>`;
  const at = c.block_time ? ` · ${esc(when(c.block_time))}` : '';
  const explorer = c.explorer_url
    ? ` <a href="${esc(c.explorer_url)}" target="_blank" rel="noopener">${esc(t('익스플로러', 'explorer'))} <span aria-hidden="true">↗</span></a>` : '';
  switch (c.state) {
    case 'confirmed':
      return `${chip('ok', t('체인 확정', 'on chain'))} ${esc(t(`블록 #${c.block_number} · 확인 ${c.confirmations}회`, `block #${c.block_number} · ${c.confirmations} confirmations`))}${at}${explorer}`;
    case 'failed':
      return `${chip('inert', t('실패', 'failed'))} ${esc(t(`블록 #${c.block_number} — 체인에서 되돌려진 거래`, `block #${c.block_number} — reverted on chain`))}${explorer}`;
    case 'pending':
      return `${chip('wait', t('대기', 'pending'))} ${esc(t('전송됨 — 아직 블록에 포함되지 않았습니다', 'broadcast — not yet in a block'))}${explorer}`;
    case 'not_found':
      return `${chip('inert', t('기록 없음', 'not found'))} ${esc(t('체인 노드가 이 거래를 알지 못합니다 — 샌드박스 체인이 재시작되면 이전 거래는 남지 않습니다', 'the chain node does not know this transaction — a restarted sandbox chain keeps no earlier transactions'))}`;
    default:
      return `${chip('inert', t('확인 불가', 'unavailable'))} ${esc(t('체인 노드에 묻지 못했습니다', 'the chain node could not be asked'))}`;
  }
}

function fmtMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const d = (value.split('.')[1] ?? '').length;
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** The right half's feed: an eyebrow and one `<li>` per event, already escaped. */
const feedHtml = (eyebrow: string, items: string[]): string => `
      <span class="eyebrow">${esc(eyebrow)}</span>
      <ul class="feed">${items.join('')}</ul>`;

/*
 * Four, not the five the API sends. The feed sets the row's height, and at
 * five the right half ran to nearly three times the numbers beside it, which
 * left the left half mostly air — the opposite of what the right half was
 * added to fix. Four is a glance; the full history is the link above it.
 */
const FEED_MAX = 4;

/**
 * 오늘 확인할 것 — the queue, before the numbers.
 *
 * Every operations console this product is compared with opens the same
 * way: what needs a person, as counts that are also links. The API has
 * carried these counts since the dashboard call was written; the page only
 * ever folded the held settlements into one chip. Each count now links to
 * the screen where the work is, narrowed to it where that screen can
 * narrow.
 *
 * Quiet when there is nothing — one line, no counts — so an empty queue
 * reads as good news rather than as a widget with nothing in it.
 */
/**
 * 구독 · 빌링 — the card a subscription service opens with: what this month
 * comes to so far, on which plan, for which period, and the lines behind the
 * figure. Every number is the API's; the sandbox prices at 0 and the card
 * says "no charge" rather than presenting a bill of nothing.
 */
function billingHtml(prod: Awaited<ReturnType<typeof api.products>>): string {
  const active = prod.products.filter((x) => x.status === 'active');
  const c = prod.billing.charges;
  type Line = NonNullable<typeof c>['lines'][number];
  const planLabel = (p: string): string => (p === 'sandbox' ? t('샌드박스', 'Sandbox') : p);
  const plans = [...new Set(active.map((x) => x.plan))].map(planLabel);
  const money = (n: number): string => {
    if (!c) return '—';
    try {
      return new Intl.NumberFormat(t('ko-KR', 'en-US'), { style: 'currency', currency: c.currency }).format(n);
    } catch { return `${n} ${c.currency}`; }
  };
  const free = !!c && c.lines.every((l) => l.monthly_fee === 0 && l.unit_price === 0);
  const day = (iso: string): string => when(iso).slice(0, 10);
  // `period.end` is exclusive — the next period's first day.
  const lastDay = c ? day(new Date(Date.parse(c.period.end) - 86_400_000).toISOString()) : '';
  const UNIT: Record<string, { some: string; per: string }> = {
    settlement: { some: t('정산', 'settlements'), per: t('정산 건당', 'per settlement') },
    snapshot: { some: t('스냅샷', 'snapshots'), per: t('스냅샷 건당', 'per snapshot') },
    anchor: { some: t('앵커', 'anchors'), per: t('앵커 건당', 'per anchor') },
  };
  const usage = (l: Line): string => {
    const n = l.quantity.toLocaleString();
    const u = UNIT[l.unit]?.some ?? l.unit;
    return l.product === 'attest'
      ? `${u} ${n} / ${prod.billing.attest.quota.toLocaleString()}`
      : `${u} ${n}${t('건', '')}`;
  };
  const basis = (l: Line): string => {
    if (l.monthly_fee === 0 && l.unit_price === 0) return t('샌드박스 — 과금 없음', 'sandbox — no charge');
    const per = UNIT[l.unit]?.per ?? l.unit;
    const unitPart = t(`${per} ${money(l.unit_price)}`, `${money(l.unit_price)} ${per}`);
    const feePart = t(`월 ${money(l.monthly_fee)}`, `${money(l.monthly_fee)} monthly`);
    return l.monthly_fee > 0 && l.unit_price > 0 ? `${feePart} + ${unitPart}` : l.monthly_fee > 0 ? feePart : unitPart;
  };
  const productName = (id: string): string => {
    const spec = PRODUCTS.find((p) => p.id === id);
    return spec ? spec.name : id;
  };

  const stats = `
      <div class="statrow">
        ${statHtml(t('이번 달 비용', 'This month so far'), esc(money(c?.total ?? 0)),
          free ? t('샌드박스 · 과금 없음', 'sandbox · no charge') : t('월초부터 현재까지 (UTC)', 'month to date (UTC)'))}
        ${statHtml(t('플랜', 'Plan'), esc(plans.length ? plans.join(' · ') : t('구독 없음', 'none')),
          t(`상품 ${active.length}개 활성`, `${active.length} products active`))}
        ${c ? statHtml(t('청구 기간', 'Billing period'), `${esc(day(c.period.start))} ~ ${esc(lastDay.slice(5))}`, 'UTC') : ''}
        ${c ? statHtml(t('다음 기간 시작', 'Next period starts'), esc(day(c.period.end)),
          t('사용량 집계 초기화', 'usage counters reset')) : ''}
      </div>`;
  const lines = !c ? '' : c.lines.length === 0
    ? `<p class="hint">${esc(t('활성 상품이 없습니다 — 구독에서 상품을 활성화하면 요금 내역이 여기에 표시됩니다.',
        'No active products — activate one under Subscriptions and its charges appear here.'))}</p>`
    : `<div class="tablewrap"><table class="billtab">
        <thead><tr>
          <th>${esc(t('상품', 'Product'))}</th>
          <th>${esc(t('요금 기준', 'Pricing'))}</th>
          <th>${esc(t('이번 달 사용량', 'Usage this month'))}</th>
          <th class="num">${esc(t('금액', 'Amount'))}</th>
        </tr></thead>
        <tbody>${c.lines.map((l) => `
          <tr>
            <td class="pname">${esc(productName(l.product))}</td>
            <td>${esc(basis(l))}</td>
            <td>${esc(usage(l))}</td>
            <td class="num">${esc(money(l.amount))}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
  return `
    <section class="card bill">
      <div class="cardhead">
        <h2>${esc(t('구독 · 빌링', 'Subscription · Billing'))} <span class="dim">· ${esc(t('이번 달', 'this month'))}</span></h2>
        <a class="btn ghost small" href="#/products">${esc(t('구독 관리 →', 'Manage subscriptions →'))}</a>
      </div>
      ${stats}
      ${lines}
    </section>`;
}

// ── 국경간 송금 ─────────────────────────────────────────────────────────────

function remitOpsHtml(d2: Dash['remit']): string {
  const exceptionRate = d2.month.count > 0
    ? `${Math.round((d2.month.terminal_bad / d2.month.count) * 1000) / 10}%` : '0%';
  // Webhook health is deliberately not on this row: exhausted deliveries
  // are in the queue above, and pending retries are a normal wait. The
  // windows are the UTC calendar day and month, as the API counts them, and
  // the labels say so — a reader in Seoul at 08:00 is still on yesterday's
  // UTC day.
  const main = `
      <div class="statrow">
        ${statHtml(t('오늘 (UTC)', 'today (UTC)'), `${d2.today.count}${t('건', '')}`, `$${fmtUsd(d2.today.trade_usd)}`)}
        ${statHtml(t('이번 달 (UTC)', 'this month (UTC)'), `${d2.month.count}${t('건', '')}`, `$${fmtUsd(d2.month.trade_usd)}`)}
        ${statHtml(t('평균 입금확정 소요', 'avg time to credit'), fmtDur(d2.avg_credit_seconds))}
        ${statHtml(t('이달 예외율', 'exception rate (month)'), exceptionRate,
          `${d2.month.terminal_bad}/${d2.month.count}${t('건', '')}`)}
      </div>
      <p class="pipeline">
        <span class="chip wait">${d2.buckets.in_flight}</span> ${esc(t('진행중', 'in flight'))}
        · <span class="chip ok">${d2.buckets.completed}</span> <a href="#/remit?state=BENEFICIARY_CREDIT_CONFIRMED,EVIDENCE_ANCHORED">${esc(t('완료', 'completed'))}</a>
        · <span class="chip inert">${d2.buckets.returned_cancelled}</span> ${esc(t('반환·취소', 'returned / cancelled'))}
        · <span class="chip inert">${d2.buckets.exceptions}</span> <a href="#/remit?state=EXCEPTION">${esc(t('예외', 'exceptions'))}</a>
      </p>`;
  return opsRow({
    product: 'remit',
    title: esc(t('국경간 송금', 'Cross-border Settlement')),
    sub: t('운영 현황', 'operations'),
    link: `<a class="btn ghost small" href="#/remit">${esc(t('상세 이력 — 송금 거래 →', 'Full history — settlements →'))}</a>`,
    main,
    side: recentRemitHtml(d2.recent),
  });
}

/** The most recent settlements: the state, the figure, and what identifies it. */
function recentRemitHtml(rows: Dash['remit']['recent']): string {
  if (rows.length === 0) {
    return `
      <span class="eyebrow">${esc(t('최근 송금', 'Recent settlements'))}</span>
      <p class="muted">${esc(t('아직 지시된 거래가 없습니다.', 'No settlements instructed yet.'))}</p>`;
  }
  return feedHtml(t('최근 송금', 'Recent settlements'), rows.slice(0, FEED_MAX).map((x) => {
    const s2 = remitStateOf(x.state);
    return `
        <li>
          <div class="feedtop"><span class="chip ${s2.chip}">${esc(s2.label)}</span>
            <span class="num">${esc(fmtMoney(x.trade_amount))} <span class="dim">${esc(x.trade_currency)}</span></span></div>
          <div class="feedsub"><a class="mono" href="#/remit?q=${encodeURIComponent(x.id)}">${esc(x.id)}</a>
            · <span title="${esc(when(x.created_at))}">${esc(ago(x.created_at))}</span></div>
        </li>`;
  }));
}

// ── Proof of Reserves ──────────────────────────────────────────────────────

/**
 * Two good readings, and the name says which: ACCEPTED was anchored on the
 * exchange's signature alone, VERIFIED passed a spot check first. CHALLENGED
 * is still waiting for its openings; anything else is a terminal no.
 */
const porStatusChip = (status: string): string =>
  `<span class="chip ${status === 'VERIFIED' || status === 'ACCEPTED' ? 'ok' : status === 'CHALLENGED' ? 'wait' : 'inert'}">${esc(status)}</span>`;

/** Coverage per asset — 100% and above is the only good reading. */
const covChip = (c: { asset: string; coverage: string | null }): string => {
  if (c.coverage === null) {
    return `<span class="chip inert">${esc(c.asset)} ${esc(t('미측정', 'not measured'))}</span>`;
  }
  const ok = Number.parseFloat(c.coverage) >= 100;
  return `<span class="chip ${ok ? 'ok' : 'wait'}">${esc(c.asset)} ${esc(c.coverage)}</span>`;
};

function porOpsHtml(d2: Dash['por']): string {
  const latest = d2.latest;
  // The snapshots' history is the record list, narrowed to this product — as the document row links to its own.
  const link = `<a class="btn ghost small" href="#/records?product=por">${esc(t('상세 이력 — 앵커링 기록 →', 'Full history — Records →'))}</a>`;
  const row = (main: string, side: string): string => opsRow({
    product: 'por', title: 'Proof of Reserves', sub: t('증명 현황', 'proof status'), link, main, side,
  });
  if (!latest) {
    // Nothing to measure yet, so the row is one column and says what the
    // first proof takes — three steps, and the guide that walks through them.
    return opsRow({
      product: 'por', title: 'Proof of Reserves', sub: t('증명 현황', 'proof status'), link,
      main: `
      <p class="muted">${esc(t('아직 앵커링한 스냅샷이 없습니다 — 이 콘솔에서 잔고 파일을 바로 앵커링하거나, 귀사 서버에서 SDK로 발행하십시오.',
        'No snapshots yet — anchor a balance file from this console, or publish from your own server with the SDK.'))}</p>
      <span class="eyebrow">${esc(t('첫 증명까지', 'To the first proof'))}</span>
      <ol class="sidesteps">
        <li>${esc(t('원장에서 잔고 파일을 내보내 귀사 서버에서 SDK로 루트를 만듭니다 — 파일은 귀사에 남습니다.', 'Export a balance file from your ledger and build the root with the SDK on your own server — the file stays with you.'))}</li>
        <li>${esc(t('서명한 선언문을 제출하면 플랫폼이 서명을 확인하고 앵커링합니다.', 'Submit the signed statement; the platform checks the signature and anchors it.'))}</li>
        <li>${esc(t('공개 검증 페이지에서 고객이 직접 확인합니다.', 'Customers check it themselves on the public verify page.'))}</li>
      </ol>
      <a href="#/por">${esc(t('콘솔에서 앵커링하기 →', 'Anchor one in the console →'))}</a>
      <span class="dim"> · </span>
      <a data-link="attest-docs" data-link-hash="por-data" target="_blank" rel="noopener">${esc(t('개발자 허브 · 잔고 파일 준비 ↗', 'Developer Hub · Preparing the balance file ↗'))}</a>
      <span class="dim"> · </span>
      <a data-link="attest-docs" data-link-hash="por" target="_blank" rel="noopener">${esc(t('준비금 증명 가이드 ↗', 'Proof of Reserves guide ↗'))}</a>`,
    });
  }
  const days = Math.floor((Date.now() - Date.parse(latest.created_at)) / 86_400_000);
  const main = `
      <div class="statrow">
        ${statHtml(t('기준 시점', 'as of'), when(latest.asof))}
        ${statHtml(t('부채 항목', 'liability entries'), latest.leaf_count.toLocaleString())}
        ${statHtml(t('마지막 제출', 'last submitted'),
          days === 0 ? t('오늘', 'today') : `${days}${t('일 전', 'd ago')}`)}
      </div>
      <p>
        <span class="dim">${esc(t('상태', 'status'))}:</span>
        ${porStatusChip(latest.status)}
        <span class="dim"> · ${esc(t('앵커', 'anchor'))}:</span>
        ${latest.anchor_status
          ? `<span class="chip ${latest.anchor_status === 'confirmed' ? 'ok' : 'wait'}">${esc(latest.anchor_status)}</span>`
          : '<span class="dim">—</span>'}
        <span class="dim"> · ${esc(t('준비금 커버리지', 'reserve coverage'))}:</span>
        ${latest.coverage.length > 0 ? latest.coverage.map(covChip).join(' ') : `<span class="dim">${esc(t('측정 없음', 'no measurement'))}</span>`}
      </p>
      ${latest.anchor_status ? '' : `<p class="muted">${esc(t(
    '이 스냅샷은 앵커링되지 않았습니다 — 앵커링 기록에는 앵커링된 스냅샷만 있습니다.',
    'This snapshot was not anchored — Records lists anchored snapshots only.'))}</p>`}`;
  return row(main, porTrendHtml(d2.trend));
}

/**
 * The last few snapshots, newest first, each with its coverage — the
 * history a reserve proof is judged on, and the one thing a single "latest"
 * figure cannot show: whether coverage is holding.
 */
function porTrendHtml(trend: Dash['por']['trend']): string {
  const rows = trend.slice(0, FEED_MAX);
  const eyebrow = trend.length > FEED_MAX
    ? t(`최근 스냅샷 ${FEED_MAX}건 · 커버리지`, `Last ${FEED_MAX} snapshots · coverage`)
    : t('스냅샷 이력 · 커버리지', 'Snapshot history · coverage');
  return feedHtml(eyebrow, rows.map((s2) => `
        <li>
          <div class="feedtop"><span>${esc(when(s2.asof))}</span>
            ${porStatusChip(s2.status)}</div>
          <div class="feedsub">${s2.coverage.length > 0
            ? s2.coverage.map(covChip).join(' ')
            : `<span class="dim">${esc(t('커버리지 측정 없음', 'no coverage measurement'))}</span>`}</div>
        </li>`));
}

// ── Attest Core ────────────────────────────────────────────────────────────

function attestOpsHtml(d2: Dash['attest'], b: AttestBilling): string {
  const f = d2.funnel;
  const unconfirmed = d2.total - (f['confirmed'] ?? 0);
  // Three numbers, not four: the share of signed anchors is a feature's
  // adoption, not a day's operations, and the registered-key count is a
  // settings fact that lives with the keys.
  const main = `
      <div class="statrow">
        ${statHtml(t('확정된 앵커', 'anchors confirmed'), String(f['confirmed'] ?? 0))}
        ${statHtml(t('미확정', 'unconfirmed'), String(unconfirmed))}
        ${statHtml(t('평균 확정 소요', 'avg time to confirm'), fmtDur(d2.avg_confirm_seconds))}
      </div>
      <p class="dim pipeline">${esc(t('접수', 'accepted'))} ${f['accepted'] ?? 0}
        → ${esc(t('배치', 'batched'))} ${f['batched'] ?? 0}
        → ${esc(t('제출', 'submitted'))} ${f['submitted'] ?? 0}
        → ${esc(t('확정', 'confirmed'))} ${f['confirmed'] ?? 0}</p>
      ${quotaMeterHtml(b)}`;
  return opsRow({
    product: 'attest',
    title: esc(t('문서 앵커링', 'Document anchoring')),
    sub: t('운영 현황', 'operations'),
    // Narrowed to this product: the unnarrowed record is every product's
    // newest fifty, and for a bank the documents this row lists are behind
    // its settlements there.
    link: `<a class="btn ghost small" href="#/records?product=attest">${esc(t('상세 이력 — 앵커링 기록 →', 'Full history — Records →'))}</a>`,
    main,
    side: recentAttestHtml(d2.recent),
  });
}

/**
 * 이번 달 사용량 — the one figure from the old subscriptions card worth
 * keeping, kept on the product it meters rather than in a card of its own.
 * Customer anchoring only: anchors the settlement and reserve products issue
 * are in their price and never draw on this.
 */
function quotaMeterHtml(b: AttestBilling): string {
  const pct = b.quota > 0 ? Math.min(100, Math.round((b.used / b.quota) * 100)) : 0;
  const resets = st.overview?.quota.resets;
  return `
      <div class="quota">
        <div class="qhead">
          <span>${esc(t('이번 달 앵커', 'Anchors this month'))} <b>${b.used.toLocaleString()}</b> / ${b.quota.toLocaleString()}
            <span class="dim">(${pct}%)</span></span>
          ${resets ? `<span class="dim">${esc(t('리셋', 'resets'))} ${esc(when(resets).slice(0, 10))}</span>` : ''}
        </div>
        <div class="qbar"><div class="qfill${pct >= 100 ? ' full' : ''}" data-pct="${pct}" data-used="${b.used}"></div></div>
        <small class="dim">${esc(t('고객이 직접 앵커링한 것만 계산 — 송금·PoR가 발행한 앵커는 해당 상품 가격에 포함',
          'Customer anchoring only — anchors issued by Settlement and PoR are included in those products'))}</small>
      </div>`;
}

/** The most recent anchors: which route, the digest, where it stands now. */
function recentAttestHtml(rows: Dash['attest']['recent']): string {
  if (rows.length === 0) {
    return `
      <span class="eyebrow">${esc(t('최근 앵커', 'Recent anchors'))}</span>
      <p class="muted">${esc(t('아직 앵커링한 것이 없습니다.', 'Nothing anchored yet.'))}
        <a href="#/anchor">${esc(t('앵커링 해보기 →', 'Try anchoring →'))}</a></p>`;
  }
  return feedHtml(t('최근 앵커', 'Recent anchors'), rows.slice(0, FEED_MAX).map((x) => `
        <li>
          <div class="feedtop">
            <span>${x.kind === 'inscription'
              ? `<span class="chip warn-chip">${esc(t('원본', 'Full'))}</span>`
              : `<span class="chip inert">${esc(t('해시', 'Hash'))}</span>`}
              ${statusChip(x.status)}</span>
            <span class="mono" title="${esc(x.leaf_bytes)}">${esc(short(x.leaf_bytes, 6))}</span>
          </div>
          <div class="feedsub"><span title="${esc(when(x.created_at))}">${esc(ago(x.created_at))}</span></div>
        </li>`));
}

// ── the page ───────────────────────────────────────────────────────────────

/** Which products are not on, named, and the one place to turn them on. */
function moreProductsHtml(active: Set<string>): string {
  const off = PRODUCTS.filter((p) => !active.has(p.id));
  if (off.length === 0) return '';
  return `
    <p class="dashmore hint">${esc(t('아직 구독하지 않은 상품', 'Not yet subscribed'))}: ${off.map((p) => `<b>${esc(p.name)}</b>`).join(' · ')}
      — <a href="#/products">${esc(t('구독 화면에서 활성화 →', 'activate under Subscriptions →'))}</a></p>`;
}

async function loadHome(): Promise<void> {
  const cards = document.getElementById('homeCards');
  if (!cards) return;
  try {
    const [prod, dash] = await Promise.all([api.products(), api.dashboard()]);
    noteProducts(prod);
    const active = new Set(prod.products.filter((x) => x.status === 'active').map((x) => x.product));
    cards.innerHTML = [
      billingHtml(prod),
      // The card above is the account's standing; what follows is what the
      // products did. Named, so the two are not read as one list of cards.
      active.size > 0
        ? `<h2 class="zonehead"><span>${esc(t('운영 현황', 'Operations'))}</span><small>${esc(t('상품별', 'by product'))}</small></h2>`
        : '',
      active.has('remit') ? remitOpsHtml(dash.remit) : '',
      active.has('por') ? porOpsHtml(dash.por) : '',
      active.has('attest') ? attestOpsHtml(dash.attest, prod.billing.attest) : '',
      moreProductsHtml(active),
    ].join('');
    // This arrives after renderDashboard's own pass over the section, so the
    // two things that pass does — bar widths, outbound links — are done again
    // for what was just inserted.
    applyBarWidths();
    resolveLinks(cards);
  } catch (e) {
    cards.innerHTML = `<section class="card"><p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p></section>`;
  }
}

interface ProductSpec {
  id: 'attest' | 'por' | 'remit';
  name: string;
  price: string;
  per: string;
  who: string;
  countryDefault?: string;
}

/** 샌드박스 국가 콤보 — 수요가 확인된 코리도 중심의 짧은 목록. */
const COUNTRIES = ['VN', 'SG', 'KR', 'HK', 'JP', 'KY', 'AE', 'US'] as const;

const PRODUCTS: ProductSpec[] = [
  {
    // The menu's name, in both languages: one product, one name on every screen.
    id: 'attest', name: t('문서 앵커링', 'Document anchoring'),
    price: t('월 구독 + 앵커 건당', 'Monthly + per anchor'),
    per: t('인스크립션은 용량 기준', 'Inscriptions by size'),
    who: t('문서·기록을 비트코인에 증빙하려는 기업', 'Companies anchoring documents and records'),
  },
  {
    id: 'por', name: 'Proof of Reserves',
    price: t('스냅샷 주기 구독', 'Subscription per snapshot cadence'),
    per: t('부채 규모 티어', 'Tiered by liability-set size'),
    who: t('준비금 증명을 정기 발행하는 거래소', 'Exchanges publishing recurring reserve proofs'),
    countryDefault: 'KY',
  },
  {
    id: 'remit', name: t('국경간 송금', 'Cross-border Settlement'),
    price: t('건당 + 금액 bps', 'Per settlement + bps'),
    per: t('증빙·앵커링 전부 포함', 'Evidence & anchoring included'),
    who: t('스테이블코인 정산을 쓰는 은행·송금사업자', 'Banks and remitters on stablecoin rails'),
    countryDefault: 'VN',
  },
];

function sectionProducts(): string {
  return `
    <p class="hint">${esc(t(
      '송금·PoR가 발행하는 앵커는 해당 상품 가격에 포함되어 문서 앵커링 쿼터를 쓰지 않습니다. SDK 연동·퀵스타트·레퍼런스는 전부 개발자 허브에 있습니다:',
      'Anchors issued by Settlement and PoR are included in those products and never draw on the document anchoring quota. SDK integration, quickstarts and the reference all live in the Developer Hub:'))}
      <a data-link="attest-docs" target="_blank" rel="noopener">${esc(t('개발자 허브 ↗', 'Developer Hub ↗'))}</a></p>
    <div id="productCards" class="grid"><section class="card"><p class="muted">${esc(t('불러오는 중…', 'Loading…'))}</p></section></div>`;
}

// ── 브라우저 키 생성: 개인키는 다운로드되는 PEM이 유일본 ────────────────────
function pemWrap(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** A key made in this page: where it is registered, and the private half the visitor was just handed. */
interface MintedKey { id: string; pem: string; spki: string; file: string }

async function mintSigningKey(product: string): Promise<string> {
  return (await mintSigningKeyPair(product)).id;
}

async function mintSigningKeyPair(product: string): Promise<MintedKey> {
  let pkcs8: ArrayBuffer;
  let spki: ArrayBuffer;
  if (crypto.subtle) {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  } else {
    /*
     * Plain-http origin: `crypto.subtle` does not exist there, but
     * `getRandomValues` does — so the curve arithmetic comes from the same
     * vendored pure-JS module that verifies signatures on this box. One
     * retry loop for the ≈2⁻³² chance the seed falls outside the scalar
     * range.
     */
    for (;;) {
      try {
        const pair = p256KeypairFromSeed(crypto.getRandomValues(new Uint8Array(32)));
        pkcs8 = pair.privateKeyPkcs8.slice().buffer;
        spki = pair.publicKeySpki.slice().buffer;
        break;
      } catch { /* redraw */ }
    }
  }

  // The private half goes to the visitor and nowhere else.
  const pem = pemWrap(pkcs8, 'PRIVATE KEY');
  const file = `stonehash-${product}-signing-key.pem`;
  const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-pem-file' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);

  const spkiB64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const reg = await api.registerIssuerKey(spkiB64,
    (() => {
      const name = PRODUCTS.find((p) => p.id === product)?.name ?? product;
      return t(`${name} 공개키 (브라우저 생성)`, `${name} public key (browser-minted)`);
    })(), 'ES256');
  return { id: reg.id, pem, spki: spkiB64, file };
}

function productSetupHtml(spec: ProductSpec, es256: { id: string; label: string }[], preselect: string | null): string {
  if (spec.id === 'attest') {
    return `<div class="keyrow"><button class="btn small" data-prod-activate="attest">${esc(t('활성화', 'Activate'))}</button></div>`;
  }
  const keyOptions = [
    `<option value="__new__">${esc(t('＋ 브라우저에서 새 키 쌍 생성 (개인키는 즉시 다운로드, 공개키만 등록)', '＋ Mint a new key pair in this browser (the private key downloads now; only the public key is registered)'))}</option>`,
    ...es256.map((k) => `<option value="${esc(k.id)}"${k.id === preselect ? ' selected' : ''}>${esc(k.label)} · ES256</option>`),
  ].join('');
  const countryOptions = COUNTRIES.map((c) =>
    `<option value="${c}" ${c === spec.countryDefault ? 'selected' : ''}>${c}</option>`).join('');
  return `
    <div class="prodform">
      <label>${esc(t('기관명', 'Institution name'))}
        <input data-f="${spec.id}-name" placeholder="${esc(t('회사·기관 이름', 'Company or institution name'))}">
        <small class="dim">${esc(t('입력하신 이름은 공개 Trust Registry(GET /v1/remit/meta)에 그대로 게시됩니다.',
          'Published as entered in the public Trust Registry (GET /v1/remit/meta).'))}</small></label>
      <label>${esc(t('국가', 'Country'))}
        <select data-f="${spec.id}-country">${countryOptions}</select></label>
      <label class="full">${esc(t('서명 공개키', 'Signing public key'))}
        <select data-f="${spec.id}-key">${keyOptions}</select>
        <small class="dim">${spec.id === 'remit'
          ? t('귀행 HSM이나 서버에 있는 키를 쓰려면 <a href="#/integrate">연동 → 서명 공개키</a>에서 그 공개키를 등록하십시오 — 이 목록에 나타납니다.',
            'To use a key held in your HSM or on your server, register its public half under <a href="#/integrate">Integrate → Signing public keys</a> — it then appears in this list.')
          : `${esc(t(
            '상용 경로: 서버에서 SDK generateSigningKey()로 생성하고 POST /v1/issuer-keys로 등록하면 이 목록에 나타납니다 — 절차:',
            'Production path: generate with the SDK\'s generateSigningKey() on your server and register via POST /v1/issuer-keys — it appears in this list. How:'))}
          <a data-link="attest-docs" data-link-hash="por" target="_blank" rel="noopener">${esc(t('준비금 증명 가이드 ↗', 'Proof of Reserves guide ↗'))}</a>`}</small></label>
      ${spec.id === 'remit' ? `<label class="full">${esc(t('Webhook URL (선택 — 비우면 폴링만)', 'Webhook URL (optional — polling works without one)'))}
        <input data-f="remit-webhook" placeholder="https://bank.example/webhook"></label>` : ''}
    </div>
    <div class="keyrow">
      <button class="btn small" data-prod-activate="${spec.id}">${esc(t('구독 활성화', 'Activate subscription'))}</button>
      <span class="muted" data-prod-msg="${spec.id}"></span>
    </div>
    <p class="hint">${esc(t('기관 ID는 활성화 시 자동 발급됩니다. 브라우저 생성 키의 개인키는 지금 내려받는 PEM 파일이 유일본 — 서버에는 공개키만 등록됩니다.',
      'The institution id is issued automatically on activation. For a browser-minted key the downloaded PEM is the only copy of the private half — only the public half is registered.'))}</p>`;
}

/**
 * 이번 달 사용량 — one line on each active product, next to its price. The
 * dashboard's subscriptions card used to carry these figures; they explain
 * an invoice, so they belong with the plan rather than with operations.
 */
function usageLine(id: ProductSpec['id'], b: Awaited<ReturnType<typeof api.products>>['billing']): string {
  const included = (n: number): string => `${t('포함 발행 앵커', 'included anchors')} ${n.toLocaleString()}`;
  const text = id === 'attest'
    ? `${t('이번 달 앵커', 'Anchors this month')} ${b.attest.used.toLocaleString()} / ${b.attest.quota.toLocaleString()}`
    : id === 'remit'
      ? `${t('이번 달 정산', 'Settlements this month')} ${b.remit.settlements.toLocaleString()}${t('건', '')} · ${included(b.remit.included_anchors)}`
      : `${t('이번 달 스냅샷', 'Snapshots this month')} ${b.por.snapshots.toLocaleString()} · ${included(b.por.included_anchors)}`;
  return `<p class="hint">${esc(text)} <span class="dim">· ${esc(t('집계 시작', 'since'))} ${esc(when(b.month_start).slice(0, 10))}</span></p>`;
}

/**
 * 다음 단계 — what a bank needs once Settlements is active, and nothing to run.
 *
 * A bank applies the SDK inside its own system's source; it does not operate
 * the corridor from a terminal. So this panel hands over the three things
 * that integration starts from and that are known right here — the
 * institution id the code is configured with, the SDK itself, and the one
 * guide — and no command. (It used to print a download check and a
 * command-line submission; the guide no longer has either.)
 *
 * The download is two links that resolve from the same `<meta>` target as
 * every other link into the hub.
 */
function remitFirstRunHtml(instId: string): string {
  // Delegated (see the listener on `data-copy-from`): this panel is redrawn
  // whenever the products are reloaded.
  const copy = (id: string): string =>
    `<button type="button" class="btn ghost small" data-copy-from="${id}">${esc(t('복사', 'Copy'))}</button>`;
  const file = (name: string): string =>
    `<a data-link="attest-docs" data-link-path="download/${name}" download>${esc(name)}</a>`;
  return `
    <section class="card firstrun">
      <span class="eyebrow">${esc(t('다음 단계', 'Next steps'))}</span>
      <h2>${esc(t('귀행 시스템에 연동하기', 'Integrate with your system'))}</h2>
      <p class="lede">${esc(t(
        '기관 ID가 발급되었습니다. 귀행 시스템의 소스에서 SDK를 호출해 첫 지급을 보내면 송금 화면에 나타나고, 그 뒤에는 이 안내가 사라집니다.',
        'Your institution id is issued. Call the SDK from your own system\'s source to send a first payment: it appears under Settlements, and after that this guide goes away.'))}</p>
      <ol class="nextsteps">
        <li>
          <div class="nshead"><b>${esc(t('기관 ID', 'Institution id'))} · <code class="mono" id="remit-next-inst">${esc(instId)}</code></b>${copy('remit-next-inst')}</div>
          <small>${t(
            'SDK 설정의 <code>institutionId</code> 값입니다. API 키는 가입 때 한 번 표시된 키나 <a href="#/integrate">연동</a>에서 발급한 키, '
              + '서명키는 활성화 때 내려받은 파일 — 귀행 서버에서 만든 키를 등록하셨다면 그 키입니다.',
            'The <code>institutionId</code> in the SDK\'s settings. The API key is the one shown once at sign-up or one issued under '
              + '<a href="#/integrate">Integrate</a>; the signing key is the file downloaded at activation — or, if you registered a key made '
              + 'on your own server, that key.')}</small>
        </li>
        <li>
          <div class="nshead"><b>SDK · ${file('attest-remit.tar.gz')} · ${file('attest-remit.sha256')}</b></div>
          <small>${esc(t(
            'Node 22.18 이상, 설치·빌드 단계 없음. 표본 SWIFT 전문이 함께 들어 있습니다.',
            'Node 22.18 or later, nothing to install or build. Sample SWIFT messages come with it.'))}</small>
        </li>
        <li>${esc(t('가이드', 'Guide'))}:
          <a data-link="attest-docs" data-link-hash="corridor" target="_blank" rel="noopener">${esc(t('국경간 송금 ↗', 'Cross-border Settlement ↗'))}</a>
          — ${esc(t('귀행 시스템이 이미 만드는 MT103 · pacs.008 · pain.001을 SDK 호출 한 번으로 서명된 지급지시로 바꿔 보내는 방법.',
            'how one SDK call turns the MT103, pacs.008 or pain.001 your system already writes into a signed instruction.'))}</li>
      </ol>
    </section>`;
}

function productNextHtml(spec: ProductSpec, instId: string | null): string {
  // Activation ends here for the other two. Their guidance lives in the
  // Developer Hub, linked once at the top of this section, and the card
  // carries what is uniquely its own: the institution identity and its
  // operational screen. A bank's first run is the full-width panel under the
  // cards (`remitFirstRunHtml`), shown until its first settlement exists.
  if (spec.id === 'attest') {
    return `
      <div class="keyrow">
        <a class="btn ghost small" href="#/anchor">${esc(t('문서 앵커링', 'Document anchoring'))}</a>
      </div>`;
  }
  return `
    <p class="hint">${esc(t('기관 ID', 'Institution id'))}: <span class="mono">${esc(instId ?? '—')}</span></p>
    <div class="keyrow">
      ${spec.id === 'remit'
        ? `<a class="btn ghost small" href="#/remit">${esc(t('송금 현황', 'Settlements'))}</a>`
        : `<a class="btn ghost small" href="#/por">${esc(t('준비금 증명', 'Proof of Reserves'))}</a>
           <a class="btn ghost small" href="/playground/por.html" target="_blank" rel="noopener">${esc(t('공개 검증 페이지 ↗', 'Public verify page ↗'))}</a>`}
    </div>`;
}

async function loadProducts(): Promise<void> {
  const cardsEl = document.getElementById('productCards');
  if (!cardsEl) return;
  try {
    const [prod, keys] = await Promise.all([api.products(), api.issuerKeys()]);
    // An activation made on this screen reloads it; the menu follows from here.
    noteProducts(prod);
    const active = new Set(prod.products.filter((x) => x.status === 'active').map((x) => x.product));
    // A key that is not an SPKI (the sandbox's seeded placeholder) could never
    // verify anything; offering it would only produce a refusal.
    const es256 = keys.data.filter((k) => k.algorithm === 'ES256' && keyShape(k.public_key) === 'spki');
    /*
     * The key to offer first: the newest one no institution verifies with
     * yet. That is what a bank with its own key leaves behind — it registers
     * the public half under Integrate, then activates here — and the
     * form used to default past it to minting another in the browser. A key
     * an institution already uses belongs to the other product; with no
     * unused key the browser mint stays the default.
     */
    const bound = new Set(prod.institutions.map((i) => i.signing_spki ?? ''));
    const preselect = es256.filter((k) => !bound.has(k.public_key))
      .reduce<IssuerKey | null>((newest, k) => (!newest || k.created_at > newest.created_at ? k : newest), null)?.id ?? null;
    const instOf = (product: string): string | null => {
      const sub = prod.products.find((x) => x.product === product);
      return (sub?.config as { institution_id?: string } | undefined)?.institution_id ?? null;
    };

    /*
     * A bank that has activated Settlements and not yet sent anything gets what
     * its integration starts from across the full width, under the cards — its
     * institution id, the SDK, the guide. It is guidance for
     * the first payment only: once a settlement exists the panel is gone, and
     * the screen is the three cards again.
     */
    const remitInst = instOf('remit');
    // The billing count restarts every period, so on its own it would bring
    // the guide back on the 1st of each month for a bank that has been live
    // for a year. When the period shows none, the ledger itself is asked —
    // one extra read, and only in that state.
    const neverSent = active.has('remit') && !!remitInst && prod.billing.remit.settlements === 0
      && (await api.settlements({ limit: 1 }).then((page) => page.page.total === 0, () => false));
    const firstRun = neverSent && remitInst ? remitFirstRunHtml(remitInst) : '';

    // 상품 카드 3종
    cardsEl.innerHTML = PRODUCTS.map((spec) => {
      const on = active.has(spec.id);
      return `
      <section class="card">
        <h2>${esc(spec.name)}
          <span class="chip ${on ? 'ok' : 'wait'}">${esc(on ? t('구독 중', 'subscribed') : t('비활성', 'not active'))}</span></h2>
        <p class="lede"><b>${esc(spec.price)}</b> · ${esc(spec.per)} — ${esc(spec.who)}</p>
        ${on ? usageLine(spec.id, prod.billing) : ''}
        ${on ? productNextHtml(spec, instOf(spec.id)) : productSetupHtml(spec, es256, preselect)}
      </section>`;
    }).join('') + firstRun;
    // Drawn after renderDashboard's pass over links, as on the dashboard.
    resolveLinks(cardsEl);

    // 활성화 동작
    // A key minted for a form is kept for that form: an activation that then
    // fails (a name the registry refuses, a dropped connection) must not mint
    // — and download — a second private key on the retry.
    const minted = new Map<string, string>();
    for (const btn of cardsEl.querySelectorAll<HTMLButtonElement>('[data-prod-activate]')) {
      btn.addEventListener('click', () => {
        void (async () => {
          const id = btn.dataset['prodActivate'] as 'attest' | 'por' | 'remit';
          const msg = cardsEl.querySelector(`[data-prod-msg="${id}"]`);
          const say = (x: string): void => { if (msg) msg.textContent = x; };
          btn.disabled = true;
          try {
            if (id === 'attest') {
              await api.activateProduct({ product: 'attest' });
            } else {
              const v = (f: string): string =>
                (cardsEl.querySelector(`[data-f="${f}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? '';
              // Asked before anything is minted: a key pair made for a form
              // that could not be submitted is a file nobody needs.
              if (!v(`${id}-name`)) {
                say(t('기관명을 입력하십시오.', 'Enter the institution name.'));
                btn.disabled = false;
                return;
              }
              let keyId = v(`${id}-key`);
              if (keyId === '__new__') {
                const kept = minted.get(id);
                if (kept) {
                  keyId = kept;
                } else {
                  say(t('브라우저에서 키 생성 중 — 개인키 PEM이 다운로드됩니다…', 'Minting in this browser — the private PEM is downloading…'));
                  keyId = await mintSigningKey(id);
                  minted.set(id, keyId);
                }
              }
              await api.activateProduct({
                product: id,
                institution: { name: v(`${id}-name`), country: v(`${id}-country`) },
                issuer_key_id: keyId,
                ...(id === 'remit' && v('remit-webhook') ? { webhook_url: v('remit-webhook') } : {}),
              });
            }
            void loadProducts();
          } catch (e) {
            say(e instanceof Error ? e.message : String(e));
            btn.disabled = false;
          }
        })();
      });
    }

  } catch (e) {
    cardsEl.innerHTML = `<section class="card"><p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p></section>`;
  }
}

/**
 * The section's own title, at the scale the rest of the brand uses.
 *
 * Without it the largest type on a screen was a 16px card heading, which
 * made the console read as a smaller product than the one the marketing site
 * describes — the same wordmark over a page whose most important line is the
 * least prominent. The eyebrow and the title are the marketing site's
 * pairing, carried through.
 */
function pageHeader(here: SectionId): string {
  const section = SECTIONS.find((x) => x.id === here);
  if (!section) return '';
  const SUB: Record<SectionId, string> = {
    anchor: t('문서를 비트코인에 고정합니다 — 해시만, 또는 문서 그대로.',
      'Fix a document to Bitcoin — its hash alone, or the document itself.'),
    records: t('고정한 것들과, 체인이 지금 그에 대해 말하는 내용.',
      'What you anchored, and what the chain says about it now.'),
    verify: t('내려받은 증명을 이 브라우저에서 확인합니다 — 파일은 서버로 가지 않습니다.',
      'Check a downloaded proof in this browser — the file goes to no server.'),
    integrate: t('서버 연동에 쓰는 API 키와, 플랫폼이 이 조직의 것으로 신뢰하는 서명 공개키.',
      'The API keys your servers use, and the signing public keys the platform trusts as yours.'),
    audit: t('이 조직의 API 키와 콘솔 계정이 수행한 호출 — 서비스별로, 결과와 함께.',
      'Every call made with this organisation\'s API keys and console accounts — by service, with its result.'),
    // 대시보드는 카드가 곧 설명이라 리드 문구를 두지 않는다 (사용자 결정).
    home: '',
    remit: t('귀행이 지시한 국경간 송금 — 지급 진행, 완료 내역과 증빙.',
      'Cross-border remittances your bank instructed — payout progress, completions and evidence.'),
    por: t('잔고 파일을 선택하면 머클 루트를 계산해 플랫폼이 앵커링합니다 — 파일은 이 브라우저에 남고, 루트와 총액만 전송됩니다.',
      'Choose a balance file: its Merkle root is computed here and the platform anchors it — the file stays in this browser, only the root and the totals are sent.'),
    products: t('세 상품의 구독 상태와 활성화 — 기관 등록과 서명 공개키까지 이 화면에서.',
      'Subscription state and activation for all three products — institutions and signing public keys included.'),

  };
  return `<header class="pagehead">
    <span class="eyebrow">${esc(section.id.toUpperCase())}</span>
    <h1>${esc(section.label)}</h1>
    ${SUB[here] ? `<p>${esc(SUB[here])}</p>` : ''}
  </header>`;
}

function renderDashboard(): void {
  const here = routeOf();
  renderNav();

  $('dashboard').innerHTML = `
    ${pageHeader(here)}
    ${showKeyOnce()}
    ${here === 'home' ? sectionHome() : ''}
    ${here === 'anchor' ? sectionAnchor() : ''}
    ${here === 'records' ? sectionRecords() : ''}
    ${here === 'verify' ? sectionVerify(st.products) : ''}
    ${here === 'integrate' ? sectionIntegrate() : ''}
    ${here === 'remit' ? sectionRemit() : ''}
    ${here === 'por' ? sectionPor(st.overview!.bitcoin_network) : ''}
    ${here === 'products' ? sectionProducts() : ''}
    ${here === 'audit' ? sectionAudit() : ''}`;

  resolveLinks($('dashboard'));
  wireDashboard();
  applyBarWidths();
  if (here === 'records') void loadRecords();
  if (here === 'integrate') { st.keys = null; void loadKeys(); void loadTrust(); }
  if (here === 'products') void loadProducts();
  if (here === 'audit') void loadAudit();
  if (here === 'remit') void loadRemit();
  if (here === 'por') void initPor(resolveLinks);
  if (here === 'home') void loadHome();
}

/**
 * Apply the computed widths the markup could not carry.
 *
 * The page ships under `style-src 'self'`, which blocks `style` attributes —
 * so a bar rendered as `style="width:37%"` simply never filled. Assigning
 * through the CSSOM is not an inline style and is allowed, so the value is
 * written here, once, after each render.
 */
function applyBarWidths(): void {
  for (const bar of document.querySelectorAll<HTMLElement>('.qfill[data-pct]')) {
    const pct = Number(bar.dataset['pct'] ?? 0);
    const used = Number(bar.dataset['used'] ?? 0);
    /*
     * A floor for any non-zero usage. One attestation against a thousand
     * rounds to 0%, and a zero-width bar reads as "you have used nothing" —
     * which is the opposite of what a quota display is for. Below the floor
     * the bar stops being proportional, so it only ever means "some".
     */
    bar.style.width = used > 0 && pct < 1 ? '3px' : `${pct}%`;
  }
}

/**
 * 앵커링 기록 — what every product anchored, in one list.
 *
 * A settlement's evidence, a reserve snapshot and a document are the same
 * kind of record once anchored: one bundle format, one way to check it. So
 * they are listed together, each row says which product it came from, and the
 * list can be narrowed to one product.
 *
 * The products are named as the menu names them, in the menu's order.
 */
const RECORD_PRODUCTS: readonly ProductId[] = ['remit', 'por', 'attest'];
const RECORD_PRODUCT: Record<ProductId, string> = {
  remit: t('송금', 'Settlements'),
  por: t('준비금 증명', 'Proof of Reserves'),
  attest: t('문서 앵커링', 'Document anchoring'),
};

/** Counts the narrowed list's requests, so an answer that arrives after a newer choice is dropped. */
const recordsView = { req: 0, limit: 50 };
/**
 * How many records a list asks for: the newest fifty, then more on request,
 * up to what the server gives in one answer. A reserve snapshot's id is read
 * off this list now, so an older record has to be within reach.
 */
const RECORD_LIMITS = [50, 200, 500] as const;

/** The product the address narrows the records to, or '' for all of them. */
const recordsProduct = (): ProductId | '' => {
  const want = routeQuery().get('product') ?? '';
  return RECORD_PRODUCTS.find((id) => id === want) ?? '';
};

/**
 * The choice of product, drawn only when there is one to make.
 *
 * What can be chosen: the products subscribed to, those the list on hand
 * already holds records from (a product since deactivated keeps its records),
 * and the one the address asks for. With one product there is nothing to
 * narrow, and a control that does nothing is not drawn.
 */
function renderRecordTools(product: ProductId | ''): void {
  const host = maybe('att-tools');
  if (!host) return;
  const have = new Set<string>([...(st.products ?? []), ...st.attestations.map((a) => a.product ?? 'attest')]);
  if (product) have.add(product);
  const options = RECORD_PRODUCTS.filter((id) => have.has(id));
  if (options.length < 2) {
    host.innerHTML = '';
    delete host.dataset['options'];
    return;
  }
  // Rebuilt only when the choices change. This runs while the control is in
  // use — every choice reloads the list — and a select replaced under the
  // keyboard loses its focus after a single step.
  const signature = options.join(',');
  if (host.dataset['options'] !== signature) {
    host.dataset['options'] = signature;
    host.innerHTML = `
      <div class="rtools">
        <select id="att-product" aria-label="${esc(t('상품 필터', 'Product filter'))}">
          <option value="">${esc(t('전체 상품', 'All products'))}</option>
          ${options.map((id) => `<option value="${id}">${esc(RECORD_PRODUCT[id])}</option>`).join('')}
        </select>
      </div>`;
    maybe<HTMLSelectElement>('att-product')?.addEventListener('change', (e) => {
      const chosen = (e.target as HTMLSelectElement).value;
      // The address carries the choice — it survives a reload and can be
      // linked to — and is written without an event. Assigning the hash
      // would redraw the whole screen, this control included; replaceState
      // fires no hashchange, as on the settlements ledger.
      history.replaceState(null, '', chosen ? `#/records?product=${chosen}` : '#/records');
      // The transaction shown below belonged to a row of the list being left.
      const tx = maybe('txview');
      if (tx) tx.innerHTML = '';
      recordsView.limit = RECORD_LIMITS[0];
      void loadRecords();
    });
  }
  const select = maybe<HTMLSelectElement>('att-product');
  if (select && select.value !== product) select.value = product;
}

/** What a list of records looks like to a reader — to tell whether a fresh answer changes it. */
const recordsShape = (records: Attestation[]): string =>
  JSON.stringify(records.map((a) => [a.id, a.status, a.batch_id, a.anchor_txid ?? null, a.reveal_txid ?? null]));

/**
 * Draw the records screen for the product the address names.
 *
 * Narrowed, the list is asked of the server: the newest fifty of everything
 * a bank anchored are nearly all settlement evidence, and narrowing those in
 * the page would show its document anchors as "none" while they sit behind
 * them.
 *
 * Unnarrowed, the list already held is drawn at once and then asked for
 * again. It was read at sign-in, and what the other products anchored since
 * — a snapshot made on 준비금 증명, a settlement's evidence — would otherwise
 * be listed under its own product and missing from 전체 상품, two views of
 * one screen contradicting each other.
 */
async function loadRecords(): Promise<void> {
  const product = recordsProduct();
  const req = ++recordsView.req;
  renderRecordTools(product);
  if (!product) {
    renderAttestations(st.attestations, '');
  } else {
    const list = maybe('att-list');
    if (list) list.innerHTML = `<p class="muted">${t('불러오는 중…', 'Loading…')}</p>`;
  }
  try {
    const more = recordsView.limit > RECORD_LIMITS[0];
    const r = await api.attestations(product || undefined, more ? recordsView.limit : undefined);
    if (req !== recordsView.req) return;
    if (!product) {
      // Redrawn only when the answer differs: a redraw closes whatever the
      // reader opened on a row in the meantime.
      const changed = recordsShape(r.data) !== recordsShape(st.attestations);
      // What is held for the other screens stays the newest fifty; a longer answer is this screen's alone.
      if (!more) st.attestations = r.data;
      if (changed || more) {
        renderRecordTools('');
        renderAttestations(r.data, '');
      }
      return;
    }
    // Narrowed here as well. A server that predates the parameter answers
    // with every product, and rows shown under a filter it ignored would be
    // a wrong statement about them.
    renderAttestations(r.data.filter((a) => (a.product ?? 'attest') === product), product);
  } catch (e) {
    // Unnarrowed, the list on hand is already on the screen and stays there.
    if (req !== recordsView.req || !product) return;
    const host = maybe('att-list');
    if (host) host.innerHTML = `<p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function renderAttestations(records: Attestation[], product: ProductId | ''): void {
  const list = maybe('att-list');
  if (!list) return;
  if (records.length === 0) {
    list.innerHTML = `<p class="dim">${product
      ? t('이 상품에서 나온 앵커가 없습니다.', 'Nothing anchored by this product yet.')
      : t('아직 앵커링한 것이 없습니다.', 'Nothing anchored yet.')}</p>`;
    return;
  }
  list.innerHTML = `<div class="tablewrap"><table>
    <thead><tr><th>${t('상품', 'Product')}</th><th>${t('방식', 'Route')}</th><th>${t('해시 (SHA-256)', 'Hash (SHA-256)')}</th><th>${t('상태', 'Status')}</th><th>${t('트랜잭션', 'Transaction')}</th><th>${t('생성', 'Created')}</th><th></th></tr></thead>
    <tbody>${records.map((a) => {
      // What the product wrote beside the anchor: which settlement, which snapshot.
      let about: { sample?: unknown; kind?: unknown; snapshot_id?: unknown; payment_id?: unknown; date?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse(a.descriptor ?? '{}');
        if (parsed !== null && typeof parsed === 'object') about = parsed;
      } catch { /* a descriptor we cannot parse is not a reason to fail the row */ }
      const sample = Boolean(about.sample);
      const inscribed = a.kind === 'inscription';
      // An inscription is exportable immediately; a digest only once batched.
      const exportable = inscribed || a.batch_id;
      // An inscription carries its own transaction; a digest shares its batch's.
      const txid = a.reveal_txid ?? a.anchor_txid ?? null;
      // A record made before products were told apart is a document's.
      const from = a.product ?? 'attest';
      // What the hash is of, under the hash: a snapshot opens beneath the
      // list, a settlement's evidence leads to that settlement. A snapshot's
      // id is what the public verify page asks for, and this list is where
      // it is found again. The line sits in the hash's cell because that
      // cell has the room; the first column must not widen.
      // The note beside a record is its caller's — anyone with an API key can write `kind: por-snapshot` next to
      // a document. Which product anchored it is the platform's word, so the note is read only for that product.
      const ref = from === 'por' && about.kind === 'por-snapshot' && typeof about.snapshot_id === 'string' && about.snapshot_id
        ? `<button type="button" class="link mono rref" data-snapshot="${esc(about.snapshot_id)}"
             title="${esc(t('이 스냅샷의 ID와 내용을 봅니다', 'Show this snapshot\u2019s id and contents'))}">${esc(t('스냅샷', 'snapshot'))} ${esc(about.snapshot_id.slice(0, 8))}</button>`
        : from === 'remit' && about.kind === 'remit-evidence' && typeof about.payment_id === 'string' && about.payment_id
          // An id that cannot be put in an address — one with half a surrogate pair in it — is shown without the link.
          ? (uriPart(about.payment_id)
            ? `<a class="mono rref" href="#/remit?q=${uriPart(about.payment_id)}"
               title="${esc(t('이 송금으로 이동합니다', 'Go to this settlement'))}">${esc(about.payment_id)}</a>`
            : `<span class="mono rref">${esc(about.payment_id)}</span>`)
          : from === 'remit' && about.kind === 'remit-manifest' && typeof about.date === 'string' && about.date
            ? `<span class="mono rref dim">${esc(t(`일별 마감 ${about.date}`, `daily close ${about.date}`))}</span>`
            : '';
      return `<tr>
        <td class="rprod">${esc(Object.hasOwn(RECORD_PRODUCT, from) ? RECORD_PRODUCT[from] : from)}</td>
        <td>${inscribed
          ? `<span class="chip warn-chip">${t('원본', 'Full')}</span>
             <small class="dim">${esc(fmtBytes(a.body_length ?? 0))} ${t('체인에', 'on chain')}</small>`
          : `<span class="chip inert">${t('해시', 'Hash')}</span>`}</td>
        <td class="rhash"><span class="mono" title="${esc(a.leaf_bytes)}">${esc(short(a.leaf_bytes))}</span>${
          sample ? ' <span class="chip inert">seeded</span>' : ''}${ref}</td>
        <td>${statusChip(a.status)}</td>
        <td>${txid
          ? `<button class="link mono" data-txid="${esc(txid)}"
               title="${t('노드에 이 트랜잭션의 현재 상태를 묻습니다', 'Ask the node about this transaction')}">${esc(short(txid, 6))}</button>${
               st.overview?.explorer_base_url
                 ? ` <a class="link" href="${esc(`${st.overview.explorer_base_url}/tx/${txid}`)}" target="_blank" rel="noopener"
                      title="${esc(t('익스플로러에서 보기 — 이 노드의 체인에 있는 거래만 열립니다', 'Open in the explorer — only transactions on this node\u2019s chain resolve'))}">↗</a>`
                 : ''}`
          : a.status === 'accepted'
            ? `<span class="dim">${t('배치 대기', 'awaiting batch')}</span>`
            : '<span class="dim">—</span>'}</td>
        <td class="dim">${when(a.created_at)}</td>
        <td>${exportable
          ? `<span class="bundlecell">
               <a class="btn ghost small" href="${esc(api.bundleUrl(a.id))}">${t('번들', 'Bundle')}</a>
               <button class="imark" data-spec="${esc(a.id)}" data-product="${esc(from)}"
                 title="${t('이 번들에 무엇이 들어 있는지', 'What is in this bundle')}">i</button>
             </span>`
          : '<span class="dim">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div>${recordsPagerHtml(records.length)}`;
  maybe('att-more')?.addEventListener('click', () => {
    recordsView.limit = RECORD_LIMITS.find((n) => n > recordsView.limit) ?? recordsView.limit;
    void loadRecords();
  });
  wireTxLookup();
  wireSnapshotLookup();
  wireSpec();
}

/**
 * What the list is a part of, said only when it may be a part.
 *
 * The server answers with the newest records up to a limit and does not say
 * how many there are in all. A list as long as what was asked for may
 * therefore have more behind it; a shorter one is everything. Nothing is
 * drawn for a list that is whole.
 */
function recordsPagerHtml(shown: number): string {
  if (shown < recordsView.limit) return '';
  const next = RECORD_LIMITS.find((n) => n > recordsView.limit);
  return `<div class="rpager" id="att-pager">
    <small class="muted">${esc(t(`최근 ${shown.toLocaleString()}건 표시`, `The newest ${shown.toLocaleString()} shown`))}</small>
    ${next ? `<button type="button" class="ghost" id="att-more">${esc(t('더 보기', 'Load more'))}</button>` : ''}
  </div>`;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** A value as part of an address, or '' when it cannot be one: `encodeURIComponent` throws on half a surrogate pair. */
const uriPart = (value: string): string => {
  try {
    return encodeURIComponent(value);
  } catch {
    return '';
  }
};

/** Present-or-not, since each section renders only its own controls. */
const maybe = <T extends HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function wireDashboard(): void {
  maybe('sign-out')?.addEventListener('click', () => {
    // A proof file not yet downloaded exists only in this page, and signing out forgets it: the snapshot
    // would stay anchored and could never issue an account's proof. So this is asked first, as leaving the
    // document is.
    if (porUntaken() > 0 && !window.confirm(t(
      '아직 내려받지 않은 준비금 증명 파일이 있습니다. 로그아웃하면 다시 받을 수 없습니다. 로그아웃하시겠습니까?',
      'A reserve proof file has not been downloaded yet. It cannot be downloaded again after you sign out. Sign out anyway?'))) return;
    void api.logout().finally(() => {
      st.overview = null;
      st.attestations = [];
      // The next account's menu must not start from this one's subscriptions.
      st.products = null;
      // Nor its reserve screen from this one's file, result, proof file — which holds a seed — or signing key.
      resetPor();
      // The last screen stays in the document behind the gate unless it is taken out: an address, an id, a root.
      $('dashboard').innerHTML = '';
      $('sections').innerHTML = '';
      $('topright').innerHTML = '';
      showGate('login');
    });
  });

  // Issue an additional key. Rotation is now two deliberate steps — mint,
  // then revoke the old one — which is what lets an integration move over
  // without a gap.
  maybe('key-new')?.addEventListener('click', () => {
    const field = maybe<HTMLInputElement>('key-label');
    void (async () => {
      try {
        const r = await api.createKey(field?.value.trim() ?? '');
        // Captured here and cleared by the render that writes it to the DOM.
        st.freshKey = r.api_key_secret;
        if (field) field.value = '';
        st.overview = await api.me();
        renderDashboard();
      } catch (e) {
        window.alert(e instanceof ApiError ? e.message : String(e));
      }
    })();
  });

  wireDigestPath();
  wireInscriptionPath();
  wireSignedPath();
  wireVerify();
}

/**
 * The signed path: hash here, sign there, check here again.
 *
 * The middle step is deliberately outside this page — the key is the
 * customer's and a browser that could sign would be a browser that held it.
 * What the console can do is bracket that step: compute the digest the
 * signature must cover, and verify the returned signature against the
 * document before anything is anchored.
 *
 * That last check is the reason this is worth building rather than just
 * documenting. A signature over the wrong digest, or made with a key whose
 * public half does not match, fails here in front of the person who can fix
 * it — instead of passing silently and failing for a recipient later.
 */
function wireSignedPath(): void {
  const input = maybe<HTMLInputElement>('sg-file');
  const json = maybe<HTMLTextAreaElement>('sg-json');
  const go = maybe<HTMLButtonElement>('sg-go');
  const select = maybe<HTMLSelectElement>('sg-key');
  const download = maybe<HTMLButtonElement>('sg-request');
  const resultFile = maybe<HTMLInputElement>('sg-result-file');
  if (!input || !json || !go || !select || !download || !resultFile) return;
  let digest = '', contentType = '';
  let keys: IssuerKey[] = [];
  let statement: SignedStatement | null = null;
  let request: StatementCore | null = null;
  let docVersion = 0, reviewVersion = 0, resultVersion = 0, keyVersion = 0;
  let submitting = false;
  const selectedKey = (): IssuerKey | null => keys.find((k) => k.id === select.value) ?? null;
  const invalidate = (): void => { reviewVersion++; statement = null; go.disabled = true; };
  const resetRequest = (): void => {
    request = null;
    download.disabled = !digest || !selectedKey() || submitting;
    $('sg-request-info').textContent = t('문서와 공개키를 선택한 뒤 요청 파일을 다운로드하십시오.', 'Download the request after choosing a document and public key.');
    invalidate();
  };
  const showError = (e: unknown): void => {
    $('sg-check').innerHTML = `<div class="note bad">${esc(e instanceof Error ? e.message : String(e))}</div>`;
  };
  const privateMaterial = (raw: string): boolean => /PRIVATE KEY|privateKey|private_key|privateKeyPkcs8Base64|"d"\s*:/i.test(raw);

  async function review(): Promise<void> {
    invalidate();
    const version = reviewVersion;
    const raw = json!.value.trim();
    if (!raw) { $('sg-check').innerHTML = ''; return; }
    if (privateMaterial(raw)) {
      json!.value = '';
      showError(t('개인키로 보이는 내용은 받지 않습니다. 입력을 지웠으며 서버로 보내지 않았습니다.', 'Private key material is not accepted. The input was cleared and nothing was sent.'));
      return;
    }
    try {
      const checked = await checkDocumentSignature(raw, digest, selectedKey());
      if (version !== reviewVersion || !go!.isConnected) return;
      const rows: [boolean, string][] = [
        [checked.matchesDocument, t('선택한 문서와 일치', 'Matches the selected document')],
        [checked.matchesKey, t('선택한 등록 공개키와 일치', 'Matches the selected registered public key')],
        [checked.signatureOk, t('서명 유효성 확인', 'Signature is valid')],
      ];
      $('sg-check').innerHTML = `<ul class="vchecks">${rows.map(([ok, label]) =>
        `<li><span class="chip ${ok ? 'ok' : 'bad'}">${ok ? 'pass' : 'fail'}</span>${esc(label)}</li>`).join('')}</ul>`;
      if (!checked.signatureOk && checked.error) {
        $('sg-check').innerHTML += `<p class="hint">${esc(checked.error)}</p>`;
      }
      if (checked.valid) { statement = checked.statement; go!.disabled = submitting; }
    } catch {
      if (version !== reviewVersion || !go!.isConnected) return;
      showError(t('서명 결과 JSON 전체가 필요합니다. 서명 값만 붙여 넣거나 서명 전 요청 파일을 선택하지 않았는지 확인하십시오.',
        'Provide the complete signed JSON, not just a signature or the unsigned request file.'));
    }
  }

  async function loadKeys(): Promise<void> {
    const version = ++keyVersion;
    const previous = select!.value;
    keys = []; select!.disabled = true; resetRequest();
    $('sg-key-info').textContent = t('등록된 키를 불러오는 중…', 'Loading registered keys…');
    try {
      const [result, { sha256 }] = await Promise.all([api.issuerKeys(), import('./vendor/sha256.ts')]);
      if (version !== keyVersion || !select!.isConnected) return;
      keys = result.data.filter((k) => (k.algorithm === 'ES256' || k.algorithm === 'RS256') && keyShape(k.public_key) === 'spki');
      select!.innerHTML = `<option value="">${esc(t('발행인 공개키를 선택하십시오', 'Choose an issuer public key'))}</option>` + keys.map((k) => {
        const fingerprint = [...sha256(Uint8Array.from(atob(k.public_key), (c) => c.charCodeAt(0)))].map((b) => b.toString(16).padStart(2, '0')).join('');
        return `<option value="${esc(k.id)}">${esc(k.label)} · ${esc(k.algorithm)} · ${esc(short(fingerprint, 8))}</option>`;
      }).join('');
      select!.disabled = submitting || keys.length === 0;
      select!.value = keys.some((k) => k.id === previous) ? previous : keys.length === 1 ? keys[0]!.id : '';
      $('sg-key-info').textContent = keys.length
        ? t('연동 메뉴의 등록 키입니다. 라벨과 공개키 지문을 확인하십시오.', 'Registered in Integrate. Check the label and public key fingerprint.')
        : t('사용할 수 있는 등록 키가 없습니다. 연동 메뉴에서 공개키를 먼저 등록하십시오.', 'No usable registered key. Register a public key in Integrate first.');
      resetRequest(); void review();
    } catch (e) {
      if (version !== keyVersion || !select!.isConnected) return;
      select!.innerHTML = `<option value="">${esc(t('키 목록을 불러오지 못했습니다', 'Could not load keys'))}</option>`;
      $('sg-key-info').textContent = e instanceof Error ? e.message : String(e);
    }
  }
  void loadKeys();
  $('sg-refresh').addEventListener('click', () => { if (!submitting) void loadKeys(); });
  select.addEventListener('change', () => { resetRequest(); void review(); });
  input.addEventListener('change', () => {
    const version = ++docVersion;
    const file = input.files?.[0];
    digest = ''; contentType = ''; resetRequest();
    $('sg-digestbox').hidden = true;
    if (!file) return;
    $('sg-name').textContent = `${file.name} — ${t('해시 계산 중…', 'hashing…')}`;
    void digestFile(file).then((hex) => {
      if (version !== docVersion || !input.isConnected) return;
      digest = hex; contentType = file.type;
      $('sg-name').textContent = file.name;
      $('sg-digestbox').hidden = false;
      $('sg-digest').textContent = hex;
      $('sg-meta').textContent = `${fmtBytes(file.size)} · ${t('문서는 전송되지 않습니다', 'The document is not sent')}`;
      resetRequest(); void review();
    }).catch((e: unknown) => { if (version === docVersion && input.isConnected) showError(e); });
  });
  download.addEventListener('click', () => {
    const key = selectedKey();
    if (!digest || !key || submitting) return;
    request ??= documentSigningRequest(digest, key, contentType);
    const url = URL.createObjectURL(new Blob([JSON.stringify(request, null, 2) + '\n'], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'signing-request.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('sg-request-info').textContent = t('요청 파일을 다운로드했습니다. 아래 가이드에 따라 서명한 결과를 가져오십시오.', 'Request downloaded. Follow a guide below and import the signed result.');
  });
  json.addEventListener('input', () => { resultVersion++; $('sg-result-name').textContent = ''; void review(); });
  resultFile.addEventListener('change', () => {
    const version = ++resultVersion;
    invalidate(); json.value = '';
    const file = resultFile.files?.[0];
    resultFile.value = '';
    if (!file) { void review(); return; }
    if (file.size > 1_000_000) {
      showError(t('서명 결과 파일은 1MB 이하여야 합니다.', 'The signed result file must be at most 1 MB.')); return;
    }
    void file.text().then((text) => {
      if (version !== resultVersion || !json.isConnected) return;
      $('sg-result-name').textContent = file.name;
      json.value = text; void review();
    }).catch((e: unknown) => { if (version === resultVersion && json.isConnected) showError(e); });
  });
  go.addEventListener('click', () => {
    const key = selectedKey(), signed = statement;
    if (!signed || !key || submitting) return;
    submitting = true; invalidate();
    input.disabled = true; select.disabled = true; json.disabled = true; resultFile.disabled = true; download.disabled = true;
    go.textContent = t('앵커링 중…', 'Anchoring…');
    void (async () => {
      try {
        const att = await api.anchorSigned(signed, key.id);
        $('sg-result').innerHTML = `<div class="note"><b>${t('등록된 발행인 서명과 함께 접수되었습니다', 'Accepted with the registered issuer signature')}</b> — <code>${esc(att.id)}</code><br>${esc(key.label)}</div>`;
        await afterAnchor('sg-result');
      } catch (e) {
        if (go.isConnected) $('sg-result').innerHTML = `<div class="note bad">${esc(e instanceof Error ? e.message : String(e))}</div>`;
      } finally {
        submitting = false;
        if (go.isConnected) {
          input.disabled = false; select.disabled = keys.length === 0; json.disabled = false; resultFile.disabled = false;
          download.disabled = !digest || !selectedKey();
          go.textContent = t('서명과 함께 앵커링', 'Anchor with the signature');
          void review();
        }
      }
    })();
  });
}

/**
 * One-click registration, delegated from the document.
 *
 * It was bound directly to the button and silently stopped working, because
 * the success panel is written, then `afterAnchor` re-renders the dashboard
 * to refresh the quota and puts the same *HTML* back — a new element, with
 * no listener. Anything bound inside a panel that survives a re-render by
 * being re-inserted has this bug.
 *
 * Delegation fixes it for good, and the key travels on the button rather
 * than in a closure, so the handler needs nothing the markup does not carry.
 */
document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-register-key]');
  if (!btn) return;
  const pub = btn.dataset['registerKey'] ?? '';
  if (!pub) return;
  const label = window.prompt(t('이 키의 이름', 'A name for this key'), t('발행 키', 'Issuing key'));
  if (label === null) return;
  void (async () => {
    btn.textContent = t('등록 중…', 'Registering…');
    try {
      await api.registerIssuerKey(pub, label.trim(), btn.dataset['registerAlg'] ?? 'ES256');
      btn.replaceWith(Object.assign(document.createElement('b'), {
        textContent: t('등록했습니다 — 이후 이 키의 서명은 등록된 키로 보고됩니다',
          'Registered — signatures from this key will now report as registered'),
      }));
    } catch (e) {
      btn.textContent = t('이 키 등록하기', 'Register this key');
      window.alert(e instanceof ApiError ? e.message : String(e));
    }
  })();
});

/** Hash locally, send 32 bytes. The digest is shown because it is the payload. */
function wireDigestPath(): void {
  const digestInput = maybe<HTMLInputElement>('digest');
  const anchorBtn = maybe<HTMLButtonElement>('anchor');
  const fileInput = maybe<HTMLInputElement>('file');
  if (!digestInput || !anchorBtn || !fileInput) return;

  const sync = (): void => { anchorBtn.disabled = !HEX64.test(digestInput.value.trim()); };
  digestInput.addEventListener('input', sync);

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    $('file-name').textContent = `${file.name} — ${t('해시 계산 중…', 'hashing…')}`;
    void digestFile(file).then((hex) => {
      digestInput.value = hex;
      $('file-name').textContent = file.name;
      $('digestbox').hidden = false;
      $('digestval').textContent = hex;
      $('digestmeta').textContent =
        `${file.name} · ${fmtBytes(file.size)} · ${t('이 브라우저에서 계산됨 · 전송되는 것은 32바이트',
          'hashed in this browser · 32 bytes are sent')}`;
      sync();
    });
  });

  anchorBtn.addEventListener('click', () => {
    void (async () => {
      const digest = digestInput.value.trim().toLowerCase();
      anchorBtn.disabled = true;
      anchorBtn.textContent = t('앵커링 중…', 'Anchoring…');
      try {
        const att = await api.anchor(digest, fileInput.files?.[0]?.type || undefined);
        $('digest-result').innerHTML = `<div class="note">
          <b>${t('해시가 접수되었습니다', 'Hash accepted')}</b> — <code>${esc(att.id)}</code>.
          ${t('자기만의 트랜잭션을 만들지 않고 다음 공유 배치에 들어갑니다. 진행 상황은 '
                + '<a href="#/records">앵커링 기록</a>에서 보실 수 있습니다.',
              'It joins the next batch rather than taking a transaction of its own. Follow it '
                + 'in <a href="#/records">Records</a>.')}</div>`;
        await afterAnchor('digest-result');
      } catch (e) {
        $('digest-result').innerHTML = `<div class="note bad">${esc(
          e instanceof ApiError ? e.message : String(e))}</div>`;
      } finally {
        anchorBtn.textContent = t('해시 앵커링', 'Anchor the hash');
        sync();
      }
    })();
  });
}

/**
 * Send the document itself.
 *
 * The digest is computed here too, before anything is sent — not because the
 * server needs it, but because it is what the reader will later use to check
 * that the bytes recovered from the chain are the ones they handed over. The
 * confirmation names the chain and the word "public", because after this the
 * document cannot be withdrawn.
 */
function wireInscriptionPath(): void {
  const input = maybe<HTMLInputElement>('ins-file');
  const go = maybe<HTMLButtonElement>('ins-go');
  if (!input || !go) return;

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) { go.disabled = true; return; }
    $('ins-name').textContent = `${file.name} — ${t('해시 계산 중…', 'hashing…')}`;
    // The ceiling comes from the input's data-max, which the server filled.
    // Checking here only saves the upload — the service checks again before
    // it spends anything, and that check is the one that decides.
    const max = Number(input.dataset['max'] ?? 0);
    const over = max > 0 && file.size > max;
    void digestFile(file).then((hex) => {
      $('ins-name').textContent = file.name;
      $('ins-digestbox').hidden = false;
      $('ins-digestval').textContent = hex;
      const box = $('ins-digestbox');
      box.classList.toggle('over', over);
      // Exact bytes when it is over: a file 1 B past the cap must not be
      // reported as the same rounded size as the cap it broke.
      $('ins-digestmeta').textContent = over
        ? t(`${fmtExact(file.size)} — 한도 ${fmtExact(max)}보다 ${fmtExact(file.size - max)} 큽니다`,
           `${fmtExact(file.size)} — ${fmtExact(file.size - max)} over the ${fmtExact(max)} limit`)
        : `${file.name} · ${fmtBytes(file.size)} / ${fmtBytes(max)} · ${t('이 바이트 전체가 체인에 올라갑니다',
           'every one of these bytes goes on the chain')}`;
      go.disabled = over;
      go.textContent = over ? t('한도 초과', 'Over the limit') : t('원본 인스크립션', 'Inscribe the document');
    });
  });

  go.addEventListener('click', () => {
    const file = input.files?.[0];
    if (!file) return;
    const net = st.overview!.bitcoin_network.toUpperCase();
    if (!window.confirm(
      t(`${file.name} 의 내용 전체가 ${net} 비트코인 체인에 공개되고, 지울 수 없습니다.\n\n`
          + '비공개로 두어야 할 자료가 아닌지 확인하셨습니까?',
        `The entire contents of ${file.name} will be published on the ${net} Bitcoin chain and `
          + 'cannot be removed.\n\nHave you checked that none of it is confidential?'))) return;
    void (async () => {
      go.disabled = true;
      go.textContent = t('인스크립션 중…', 'Inscribing…');
      try {
        const att = await api.inscribe(file);
        $('ins-result').innerHTML = `<div class="note">
          <b>${t('원본이 체인에 기록되었습니다', 'The document is on the chain')}</b> — <code>${esc(att.id)}</code><br>
          commit <code class="mono">${esc(short(att.commit_txid ?? '', 8))}</code> ·
          reveal <code class="mono">${esc(short(att.reveal_txid ?? '', 8))}</code> ·
          ${esc(String(att.body_length ?? 0))} ${t('바이트', 'bytes')}<br>
          ${t('서버에 남은 원본 파일은 없습니다. 이제 문서는 트랜잭션 안에 있고, '
                + '<a href="#/records">앵커링 기록</a>에서 노드에 직접 조회하실 수 있습니다.',
              'No copy of the file remains on our servers. The document is in the transaction '
                + 'now, and you can query the node for it from <a href="#/records">Records</a>.')}</div>`;
        await afterAnchor('ins-result');
      } catch (e) {
        $('ins-result').innerHTML = `<div class="note bad">${esc(
          e instanceof ApiError ? e.message : String(e))}</div>`;
      } finally {
        go.textContent = t('원본 인스크립션', 'Inscribe the document');
        go.disabled = false;
      }
      // falls through to the result panel above
    })();
  });
}

/**
 * Refresh quota and list, keeping the result the reader is looking at.
 *
 * The outcome lives inside the card whose button produced it, so the
 * re-render puts it back in that same slot. One shared panel below both cards
 * answered the left-hand button underneath the right-hand one, which is how
 * this was noticed.
 */
async function afterAnchor(slot: 'digest-result' | 'ins-result' | 'sg-result'): Promise<void> {
  const result = $(slot).innerHTML;
  await loadAttestations();
  st.overview = await api.me();
  renderDashboard();
  const host = maybe(slot);
  if (host) host.innerHTML = result;
}

/**
 * Decimal units, because the limits are decimal.
 *
 * The cap is 100,000 bytes, not 2^17. Rendering it over 1024 produced
 * "97.7 KB" for a number the API, the config and the error message all call
 * 100,000 — and the mismatch is worst exactly where it matters, with a file
 * one byte over the line reported as the same size as the limit it broke.
 */
const fmtBytes = (n: number): string =>
  n < 1000 ? `${n} B`
    : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`
      : `${(n / 1_000_000).toFixed(1)} MB`;

/** Exact, for the one place where rounding would hide the difference. */
const fmtExact = (n: number): string => `${n.toLocaleString()} B`;

/**
 * A reserve snapshot, opened from its row.
 *
 * 준비금 증명 used to keep its own table of snapshots. A snapshot is a record
 * like any other once anchored, so the table is gone and the row here carries
 * it; what the table told beyond the row — the id an outside verifier asks
 * for, how many accounts, whether a spot check was passed — is read when the
 * row is opened, from the platform's record of that snapshot.
 */
function wireSnapshotLookup(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-snapshot]')) {
    b.addEventListener('click', () => {
      const id = b.dataset['snapshot']!;
      const host = maybe('txview');
      if (!host) return;
      host.innerHTML = `<section class="card"><p class="dim">${t('불러오는 중…', 'Loading…')}</p></section>`;
      void (async () => {
        try {
          const v = await api.porSnapshot(id);
          // Whether a spot check was asked for and how it ended is what the snapshot's own status says; it is
          // given in words, in the list. The one coloured mark on the panel is the anchor's — only a confirmed
          // anchor is a success here.
          // Only an accepted or a verified snapshot is anchored, so only those have a row to open this from.
          const spot = v.spot_check === false ? t('없음 — 서명된 루트와 총액만으로 접수', 'none — accepted on the signed root and totals alone')
            : v.status === 'VERIFIED' ? t('통과', 'passed') : v.status;
          host.innerHTML = `<section class="card" id="snapview">
            <div class="cardhead">
              <div>
                <span class="eyebrow">SNAPSHOT</span>
                <h2>${t('준비금 증명 스냅샷', 'Reserve snapshot')}</h2>
              </div>
              <a class="btn ghost small" href="/playground/por.html" target="_blank" rel="noopener">${t('공개 검증 페이지', 'Public verify page')} <span aria-hidden="true">↗</span></a>
            </div>
            <dl>
              <dt>${t('스냅샷 ID', 'Snapshot id')}</dt>
              <dd><span class="mono" id="snap-id">${esc(v.snapshot_id)}</span>
                <button type="button" class="btn ghost small" data-copy-from="snap-id">${esc(t('복사', 'Copy'))}</button></dd>
              <dt>${t('기준 시각', 'As of')}</dt><dd class="mono">${esc(v.asof)}</dd>
              <dt>${t('머클 루트', 'Merkle root')}</dt><dd class="mono">${esc(v.root)}</dd>
              <dt>${t('계정', 'Accounts')}</dt><dd>${esc(v.leaf_count.toLocaleString())}</dd>
              <dt>${t('표본 확인', 'Spot check')}</dt><dd>${esc(spot)}</dd>
              <dt>${t('앵커', 'Anchor')}</dt><dd>${v.attestation ? statusChip(v.attestation.status) : '<span class="dim">—</span>'}</dd>
            </dl>
            <p class="hint">${t(
              '계정의 주인은 공개 검증 페이지에 이 스냅샷 ID와 자신의 계정 증명 파일을 넣어, 잔고가 이 스냅샷에 들어 있는지 확인합니다.',
              'An account\u2019s holder puts this snapshot id and their own account proof file into the public verify page to check that their balance is in this snapshot.')}</p>
          </section>`;
          revealPanel(host);
        } catch (e) {
          host.innerHTML = `<section class="card"><div class="note bad">${esc(
            e instanceof ApiError ? e.message : String(e))}</div></section>`;
        }
      })();
    });
  }
}

/**
 * Ask the node about one transaction.
 *
 * Deliberately a separate call rather than something folded into the list:
 * it reports the chain's answer at the moment it is asked, and pretending
 * that could be cached alongside a row would be the same mistake as trusting
 * our own `status` column.
 */
function wireTxLookup(): void {
  for (const b of document.querySelectorAll<HTMLElement>('[data-txid]')) {
    b.addEventListener('click', () => {
      const txid = b.dataset['txid']!;
      const host = maybe('txview');
      if (!host) return;
      host.innerHTML = `<section class="card"><p class="dim">${t('노드에 묻는 중…', 'Asking the node…')}</p></section>`;
      void (async () => {
        try {
          const v = await api.tx(txid);
          const tone = v.state === 'confirmed' ? 'ok' : v.state === 'mempool' ? 'wait' : 'inert';
          const rows: [string, string][] = [[t('상태', 'State'), v.state]];
          if (v.confirmations !== undefined) rows.push([t('확인 수', 'Confirmations'), String(v.confirmations)]);
          if (v.block_height !== undefined) rows.push([t('블록 높이', 'Block height'), String(v.block_height)]);
          if (v.block_hash) rows.push([t('블록 해시', 'Block hash'), v.block_hash]);
          if (v.block_time) rows.push([t('블록 시각', 'Block time'), v.block_time]);
          if (v.vsize !== undefined) rows.push(['vsize', `${v.vsize} vB (weight ${v.weight ?? '—'})`]);
          if (v.fee_sats !== undefined) rows.push([t('수수료', 'Fee'), `${v.fee_sats} sat`]);
          if (v.size_bytes !== undefined) rows.push([t('크기', 'Size'), fmtBytes(v.size_bytes)]);
          if (v.seen_at) rows.push([t('멤풀 진입', 'Seen in mempool'), v.seen_at]);
          if (v.detail) rows.push([t('비고', 'Note'), v.detail]);
          const known = v.state === 'mempool' || v.state === 'confirmed' || v.state === 'pending';
          host.innerHTML = `<section class="card">
            <div class="cardhead">
              <div>
                <span class="eyebrow">TRANSACTION</span>
                <h2>${esc(short(txid, 8))}</h2>
              </div>
              ${v.explorer_url && known
                ? `<a class="btn ghost small" href="${esc(v.explorer_url)}"
                     target="_blank" rel="noopener">${t('멤풀에서 보기', 'Open in mempool')} <span aria-hidden="true">↗</span></a>`
                : ''}
            </div>
            <div class="netline"><span class="chip ${tone}">${esc(v.state)}</span>
              <span class="dim mono">${esc(v.backend)}</span></div>
            <dl>${rows.map(([k, val]) =>
              `<dt>${esc(k)}</dt><dd class="mono">${esc(val)}</dd>`).join('')}</dl>
            <p class="hint">${t(
              '이 값들은 노드가 <b>지금</b> 답한 것입니다. 위 목록의 상태 칩은 저희 '
                + '데이터베이스가 마지막으로 기록한 단계이고, 둘이 다르면 그 차이 자체가 '
                + '정보입니다.',
              'These are what the node answers <b>right now</b>. The status chip above is the '
                + 'stage our database last recorded — when the two disagree, the disagreement '
                + 'is the information.')}</p>
          </section>`;
          revealPanel(host);
        } catch (e) {
          host.innerHTML = `<section class="card"><div class="note bad">${esc(
            e instanceof ApiError ? e.message : String(e))}</div></section>`;
        }
      })();
    });
  }
}

async function loadAttestations(): Promise<void> {
  try {
    const r = await api.attestations();
    st.attestations = r.data;
  } catch {
    // A dashboard that fails to list is still a usable dashboard.
    st.attestations = [];
  }
}

function showDashboard(): void {
  $('gate').hidden = true;
  $('gate-main').hidden = true;
  $('shell').hidden = false;
  // Registered once; re-entering showDashboard after a sign-out must not stack
  // a second listener that renders the page twice per navigation.
  if (!routeBound) {
    routeBound = true;
    window.addEventListener('hashchange', () => {
      if (st.overview) renderDashboard();
    });
  }
  renderDashboard();
}
let routeBound = false;

// ── boot ───────────────────────────────────────────────────────────────────

/**
 * Resume an existing session before showing the gate.
 *
 * The cookie is `HttpOnly`, so the page cannot read it and has to ask. Showing
 * the sign-in form first and then replacing it would flash a login screen at
 * someone who is already signed in.
 */
void (async () => {
  try {
    st.overview = await api.me();
    // Before the first render, so the menu is not drawn with every product
    // and then redrawn without the ones this organisation does not have.
    await Promise.all([loadAttestations(), loadSubscriptions()]);
    showDashboard();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unreachable') {
      $('gate').hidden = false;
      $('gate-form').innerHTML = `<h1>${t('API에 연결할 수 없습니다', 'Cannot reach the API')}</h1>
        <p class="lede">${esc(e.message)}</p>
        <p class="hint">${t('이 페이지는 정상적으로 열렸습니다. 응답하지 않은 것은 그 뒤의 서비스입니다.',
          'This page is static and loaded fine; it is the service behind it that did not answer.')}</p>`;
      return;
    }
    showGate(location.hash === '#signup' ? 'signup' : 'login');
  }
})();

/**
 * Outbound links come from `<meta>`, never from markup.
 *
 * The console, the Playground, the Hub and the API are one host on a test box
 * and four in production. A relative link hardcoded in the page works in the
 * first case and silently 404s in the second.
 */
// Before anything renders: the sign-in page is markup and must already be
// in the right language when it is first painted.
applyLang();
translateStatic();
const langSlot = document.getElementById('langs');
if (langSlot) langSlot.outerHTML = langToggle();

function resolveLinks(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLAnchorElement>('a[data-link]')) {
    const target = document.querySelector<HTMLMetaElement>(
      `meta[name="${el.dataset['link']}"]`)?.content;
    if (!target) { el.remove(); continue; }
    /*
     * `data-link-hash` points at a section of the target, not just the host.
     * Without it a link labelled "get the SDK" lands on the reference's front
     * page and the reader has to go looking for what the button promised.
     *
     * The reader's language goes too, as `?lang=` ahead of the fragment:
     * every surface here reads it, and without it a Korean console opened
     * the hub in whatever language the browser preferred. `data-link-path`
     * names a file under the target rather than a page — a download, with no
     * language to carry.
     */
    const hash = el.dataset['linkHash'];
    const file = el.dataset['linkPath'];
    // A target is a directory (`../docs/`): pages and files hang off it.
    const base = new URL(target, location.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const url = new URL(file ?? '', base);
    if (file === undefined) url.searchParams.set('lang', lang);
    if (hash) url.hash = hash;
    el.href = url.href;
  }
}

/**
 * Copy, on a page the browser does not consider secure.
 *
 * `navigator.clipboard` is withheld outside a secure context, exactly as
 * `crypto.subtle` is, and this console is reached over plain http at an IP.
 * Worse, the idiomatic `navigator.clipboard?.writeText(…).then(…)` fails
 * **silently**: optional chaining short-circuits the whole expression, so the
 * button did nothing and reported nothing. It shipped that way on the button
 * that reveals a secret key exactly once.
 *
 * `execCommand('copy')` is deprecated and is the only thing that works here.
 * Both paths end in visible feedback, because a copy button that cannot say
 * whether it copied is worse than no button.
 */
function copyText(source: HTMLElement, button: HTMLElement, done = t('복사됨', 'Copied')): void {
  const say = (msg: string): void => {
    const original = button.dataset['label'] ?? button.textContent ?? '';
    button.dataset['label'] = original;
    button.textContent = msg;
    setTimeout(() => { button.textContent = button.dataset['label'] ?? original; }, 1800);
  };
  const text = source.textContent ?? '';

  // Named once, here, so a test can assert no other caller reaches for it.
  const native = navigator.clipboard;
  if (native?.writeText) {
    void native.writeText(text).then(
      () => { say(done); },
      () => { selectInPlace(source); say(t('선택했습니다 — Ctrl+C', 'Selected — press Ctrl+C')); });
    return;
  }

  /*
   * Select the real element rather than a detached textarea.
   *
   * It makes `execCommand` more likely to succeed, and when it still fails
   * the user is left with the text highlighted and one keystroke away —
   * which is a working answer, where "copy failed" is not.
   */
  selectInPlace(source);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  say(ok ? done : t('선택했습니다 — Ctrl+C 로 복사하십시오', 'Selected — press Ctrl+C to copy'));
}

/** Highlight an element's text so the keyboard can take it from here. */
function selectInPlace(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
resolveLinks();

window.addEventListener('hashchange', () => {
  if (st.overview) return; // signed in: the hash is not a route
  showGate(location.hash === '#signup' ? 'signup' : 'login');
});

document.addEventListener('click', (ev) => {
  const btn = ev.target as HTMLElement;
  if (btn.id !== 'copy-key') return;
  // Same silent failure the signing command had — and this is the button
  // that hands over a secret shown exactly once.
  copyText($('keyval'), btn);
});

/**
 * A copy button that names what it copies — `data-copy-from` is the id of
 * the element holding the text. Delegated for the reason the registration
 * control is: the product cards are redrawn on every reload of the
 * products, and a listener bound to a button would leave with it.
 */
document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-copy-from]');
  if (!btn) return;
  const source = document.getElementById(btn.dataset['copyFrom'] ?? '');
  if (source) copyText(source, btn);
});
