/**
 * The Developer Hub page.
 *
 * Ten documents and an API reference, switched by the URL hash. No router, no
 * framework, no build step beyond one `tsc` pass — the same choices the
 * Playground makes, for the same reason: this site's argument is that our
 * claims can be checked without trusting our toolchain, and a reader who opens
 * devtools should find the code that rendered the page they are reading.
 *
 * Content is fetched from `./content/*.md` on first view and cached. The
 * Evidence Specification is 500-odd lines and most visitors want the Quick
 * Start, so fetching all of it up front would make the common case slower to
 * serve the uncommon one.
 */
import { renderMarkdown } from './markdown.ts';
import { applyLang, contentFallbackNote, contentPath, lang, langToggle, t, translateStatic } from './i18n.ts';
import { renderReference } from './openapi.ts';
import type { Spec } from './openapi.ts';

/**
 * The sidebar's groups, in order — the split a developer portal makes between
 * starting, the products, the contracts, and what keeps changing. Ten pages
 * in one flat list read as ten equal things; a bank's developer looking for
 * "how do I authenticate" or "where is the settlement guide" finds it by the
 * group. Each item is its name alone — the one-line descriptions under them
 * were removed at the owner's request (2026-11-12).
 */
type GroupId = 'start' | 'products' | 'reference' | 'tools' | 'trust';
// `key`, not `id`: the test that checks which pages are untranslated finds
// page entries by `{ id: '…'`, and a group is not a page.
const GROUPS: { key: GroupId; title: string }[] = [
  { key: 'start', title: t('시작하기', 'Getting started') },
  { key: 'products', title: t('상품 가이드', 'Product guides') },
  { key: 'reference', title: t('레퍼런스', 'Reference') },
  { key: 'tools', title: t('SDK · 도구', 'SDK & tools') },
  { key: 'trust', title: t('보안 · 변경 내역', 'Security & changes') },
];

interface Page {
  /** URL hash, without the `#`. */
  id: string;
  label: string;
  group: GroupId;
  /** Markdown under `content/`, or the reference, which is built from JSON. */
  source: { kind: 'markdown'; file: string } | { kind: 'openapi' };
  /**
   * Korean is available: under `content/ko/` for a Markdown page, beside
   * the English in `openapi.json` (`x-ko-*`) for the reference.
   *
   * False only for the specification. It is the contract an implementation
   * has to match byte for byte, and a translated contract is a second
   * normative text — the two drift, and then neither is authoritative. The
   * page says so rather than quietly serving English. The reference avoids
   * that by translating prose only, in the same file, under a test that
   * fails when a Korean reading is missing or loses a code span.
   */
  ko?: boolean;
}

const PAGES: Page[] = [
  { id: 'overview', group: 'start', label: t('개요', 'Overview'), ko: true,
    source: { kind: 'markdown', file: 'overview.md' } },
  { id: 'quickstart', group: 'start', label: t('빠른 시작', 'Quick Start'), ko: true,
    source: { kind: 'markdown', file: 'quickstart.md' } },
  { id: 'corridor', group: 'products', label: t('국경간 송금', 'Cross-border Settlement'), ko: true,
    source: { kind: 'markdown', file: 'corridor.md' } },
  { id: 'por', group: 'products', label: t('준비금 증명', 'Proof of Reserves'), ko: true,
    source: { kind: 'markdown', file: 'por.md' } },
  { id: 'por-data', group: 'products', label: t('준비금 증명: 잔고 파일', 'PoR: Balance File'), ko: true,
    source: { kind: 'markdown', file: 'por-data.md' } },
  { id: 'signing', group: 'products', label: t('발행인 서명', 'Issuer Signing'), ko: true,
    source: { kind: 'markdown', file: 'signing.md' } },
  { id: 'signing-existing', group: 'products', label: t('서명: 기존 도구·HSM/KMS', 'Signing: Existing Tool · HSM/KMS'), ko: true,
    source: { kind: 'markdown', file: 'signing-existing.md' } },
  { id: 'signing-tool', group: 'products', label: t('서명: Docker·SDK', 'Signing: Docker · SDK'), ko: true,
    source: { kind: 'markdown', file: 'signing-tool.md' } },
  { id: 'api', group: 'reference', label: t('API 레퍼런스', 'API Reference'), ko: true, source: { kind: 'openapi' } },
  { id: 'spec', group: 'reference', label: t('증빙 규격', 'Evidence Specification'),
    source: { kind: 'markdown', file: 'bundle-schema.md' } },
  { id: 'vectors', group: 'tools', label: t('테스트 벡터', 'Test Vectors'), ko: true,
    source: { kind: 'markdown', file: 'vectors.md' } },
  { id: 'sdk', group: 'tools', label: t('TypeScript SDK', 'TypeScript SDK'), ko: true,
    source: { kind: 'markdown', file: 'sdk.md' } },
  { id: 'security', group: 'trust', label: t('보안과 프라이버시', 'Security & Privacy'), ko: true,
    source: { kind: 'markdown', file: 'security.md' } },
  { id: 'changelog', group: 'trust', label: t('변경 내역과 상태', 'Changelog & Status'), ko: true,
    source: { kind: 'markdown', file: 'changelog.md' } },
];

// The Overview, not the Quick Start: a bank developer following the console's
// "Developer Hub" link should land on the map, not on "hash your contract".
const DEFAULT_PAGE = 'overview';

// "SWIFT Messages" was a page of its own until its content became part of the
// one cross-border guide; links to it are already out there.
const MOVED: Record<string, string> = { swift: 'corridor' };

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

const cache = new Map<string, { html: string; nav: { id: string; label: string }[] }>();

/**
 * `{{ORIGIN}}` in a guide becomes the address of the deployment being read.
 *
 * A command that says `BASE=<this deployment's origin>` cannot be pasted —
 * the reader has to work out what to put there, and the angle brackets are
 * shell redirections on top. The page knows the answer: the API it documents
 * is the configured API host, or the origin it was served from. The guides
 * stay free of any hardcoded address, which would be wrong on every
 * deployment but one.
 */
const ORIGIN_TOKEN = '{{ORIGIN}}';
function apiOrigin(): string {
  const configured = document.querySelector<HTMLMetaElement>('meta[name="attest-api"]')?.content ?? '';
  const origin = configured !== '' ? configured.replace(/\/+$/, '') : location.origin;
  return origin.replace(/[&<>"']/g, '');
}

async function load(page: Page): Promise<{ html: string; nav: { id: string; label: string }[] }> {
  const hit = cache.get(page.id);
  if (hit) return hit;

  let result: { html: string; nav: { id: string; label: string }[] };
  if (page.source.kind === 'openapi') {
    const res = await fetch('./openapi.json');
    if (!res.ok) throw new Error(`openapi.json: ${res.status}`);
    // Korean readings of the prose live beside the English in openapi.json;
    // the renderer picks them, so there is no separate Korean reference.
    const ref = renderReference((await res.json()) as Spec, { lang, origin: apiOrigin() });
    result = { html: contentFallbackNote(page.ko === true) + ref.html, nav: ref.nav };
  } else {
    const res = await fetch(contentPath(page.source.file, page.ko === true));
    if (!res.ok) throw new Error(`${page.source.file}: ${res.status}`);
    const { html, headings } = renderMarkdown(await res.text());
    // Only h2/h3 reach the contents rail. Every heading would reproduce the
    // document in the margin, which is not a table of contents.
    result = {
      html: contentFallbackNote(page.ko === true) + html.replaceAll(ORIGIN_TOKEN, apiOrigin()),
      nav: headings.filter((h) => h.depth >= 2 && h.depth <= 3)
        .map((h) => ({ id: h.id, label: h.text })),
    };
  }
  cache.set(page.id, result);
  return result;
}

function renderSidebar(active: string): void {
  const item = (p: Page): string => `
    <a href="#${p.id}" class="navitem${p.id === active ? ' on' : ''}">
      <span class="navlabel">${p.label}</span>
    </a>`;
  $('pages').innerHTML = GROUPS.map((g) => {
    const pages = PAGES.filter((p) => p.group === g.key);
    return pages.length === 0 ? '' : `
    <div class="navgroup">${g.title}</div>
    ${pages.map(item).join('')}`;
  }).join('');
}

/**
 * A copy button on every code sample.
 *
 * On plain http the browser withholds `navigator.clipboard`, so the fallback
 * is the old way: select the sample and ask for a copy. If even that is
 * refused the text is left selected and the button says so — Ctrl+C then
 * works, and the reader is never told "copied" when nothing was.
 */
function addCopyButtons(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>('pre.code')) {
    const wrap = document.createElement('div');
    wrap.className = 'codewrap';
    pre.replaceWith(wrap);
    wrap.append(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copybtn';
    btn.textContent = t('복사', 'Copy');
    wrap.append(btn);
  }
}

async function copySample(btn: HTMLElement): Promise<void> {
  const code = btn.parentElement?.querySelector('code');
  if (!code) return;
  const text = code.textContent ?? '';
  let copied = false;
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch { /* fall through to selection */ }
  if (!copied) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    try { copied = document.execCommand('copy'); } catch { copied = false; }
  }
  btn.textContent = copied ? t('복사됨', 'Copied') : t('선택됨 — Ctrl+C', 'Selected — press Ctrl+C');
  window.setTimeout(() => { btn.textContent = t('복사', 'Copy'); }, 1800);
}

document.addEventListener('click', (e) => {
  const btn = (e.target as Element | null)?.closest<HTMLElement>('.copybtn');
  if (btn) void copySample(btn);
});

/**
 * One example, in more than one language.
 *
 * A guide that shows an example in TypeScript and then in Java writes two code
 * fences one after the other, with nothing between them. Here such a run
 * becomes one box with a switch above it, and one fence is shown at a time.
 *
 * The choice is the reader's for the whole hub, not for one box: picking Java
 * in one example shows Java in every example that has it, on this page and on
 * the next, and is remembered where the browser allows it. An example written
 * in one language only is left exactly as it was.
 *
 * The markdown stays two fences, so the documents — and the tests that count
 * and compile their examples — are untouched by any of this.
 */
const CODE_LANGUAGES = new Map([['ts', 'TypeScript'], ['java', 'Java']]);
const CODE_LANGUAGE_KEY = 'stonehash.hub.code-language';

/** A private window refuses storage: the choice then lasts as long as the page does. */
let codeLanguage: string | null = (() => {
  try { return window.localStorage.getItem(CODE_LANGUAGE_KEY); } catch { return null; }
})();

function codeLanguageOf(wrap: Element): string | null {
  for (const name of wrap.querySelector('pre.code')?.classList ?? []) {
    if (name.startsWith('lang-') && CODE_LANGUAGES.has(name.slice(5))) return name.slice(5);
  }
  return null;
}

function groupCodeLanguages(root: HTMLElement): void {
  const grouped = new Set<Element>();
  for (const first of root.querySelectorAll<HTMLElement>('.codewrap')) {
    if (grouped.has(first)) continue;
    // The run: samples that follow one another directly, each in a language of its own.
    const run: { wrap: HTMLElement; lang: string }[] = [];
    for (let node: Element | null = first; node instanceof HTMLElement && node.classList.contains('codewrap'); node = node.nextElementSibling) {
      const lang = codeLanguageOf(node);
      if (!lang || run.some((r) => r.lang === lang)) break;
      run.push({ wrap: node, lang });
    }
    if (run.length < 2) continue;

    const set = document.createElement('div');
    set.className = 'codeset';
    const tabs = document.createElement('div');
    tabs.className = 'codetabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', t('예제 언어', 'Example language'));
    first.before(set);
    set.append(tabs);
    for (const { wrap, lang } of run) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'codetab';
      tab.dataset['lang'] = lang;
      tab.textContent = CODE_LANGUAGES.get(lang)!;
      tabs.append(tab);
      wrap.dataset['lang'] = lang;
      set.append(wrap);
      grouped.add(wrap);
    }
  }
  showCodeLanguage(root);
}

/** In every box: the reader's language where the box has it, otherwise the one written first. */
function showCodeLanguage(root: HTMLElement): void {
  for (const set of root.querySelectorAll<HTMLElement>('.codeset')) {
    const wraps = [...set.querySelectorAll<HTMLElement>(':scope > .codewrap')];
    const shown = wraps.some((w) => w.dataset['lang'] === codeLanguage) ? codeLanguage : wraps[0]?.dataset['lang'];
    for (const wrap of wraps) wrap.hidden = wrap.dataset['lang'] !== shown;
    for (const tab of set.querySelectorAll<HTMLElement>(':scope > .codetabs > .codetab')) {
      tab.setAttribute('aria-pressed', String(tab.dataset['lang'] === shown));
    }
  }
}

document.addEventListener('click', (e) => {
  const tab = (e.target as Element | null)?.closest<HTMLElement>('.codetab');
  const lang = tab?.dataset['lang'];
  if (!tab || !lang) return;
  // Every example on the page changes with it, and the two languages are not
  // the same height: the switch the reader pressed stays where it is on the screen.
  const before = tab.getBoundingClientRect().top;
  codeLanguage = lang;
  try { window.localStorage.setItem(CODE_LANGUAGE_KEY, lang); } catch { /* kept for this page only */ }
  showCodeLanguage($('doc'));
  window.scrollBy({ top: tab.getBoundingClientRect().top - before, behavior: 'instant' });
});

/** The in-page contents rail, and the scroll-spy that highlights it. */
let spy: IntersectionObserver | null = null;

$('toc').addEventListener('click', (e) => {
  // "## SDK" slugs to `sdk`, which is also a page: left to the hash router,
  // the contents rail would leave the page the reader is on.
  const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[data-for]');
  const id = link?.dataset['for'];
  if (!id || !PAGES.some((p) => p.id === id)) return;
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView();
});

function renderToc(nav: { id: string; label: string }[]): void {
  const toc = $('toc');
  if (nav.length < 2) { toc.innerHTML = ''; toc.hidden = true; return; }
  toc.hidden = false;
  toc.innerHTML = `<div class="tochead">${t('이 페이지에서', 'On this page')}</div>`
    + nav.map((n) => `<a href="#${n.id}" data-for="${n.id}">${n.label}</a>`).join('');

  spy?.disconnect();
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of toc.querySelectorAll<HTMLAnchorElement>('a[data-for]')) {
    links.set(a.dataset['for']!, a);
  }
  spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('on');
      links.get(e.target.id)?.classList.add('on');
    }
  }, { rootMargin: '-72px 0px -70% 0px' });
  for (const id of links.keys()) {
    const el = document.getElementById(id);
    if (el) spy.observe(el);
  }
}

async function show(id: string): Promise<void> {
  const page = PAGES.find((p) => p.id === id) ?? PAGES[0]!;
  renderSidebar(page.id);
  document.title = `${page.label} · StoneHash Attest ${t('개발자 허브', 'Developer Hub')}`;

  const body = $('doc');
  body.setAttribute('aria-busy', 'true');
  try {
    const { html, nav } = await load(page);
    body.innerHTML = html;
    addCopyButtons(body);
    groupCodeLanguages(body);
    renderToc(nav);
  } catch (e) {
    // Say which file and why. A docs site that fails silently sends the reader
    // to assume the content does not exist.
    body.innerHTML = `<div class="callout bad">
      <strong>${t('이 페이지를 불러오지 못했습니다.', 'That page did not load.')}</strong>
      <p>${String(e instanceof Error ? e.message : e)}</p>
      <p>${t('이 허브는 정적 사이트이므로, 서비스 장애보다는 배포에서 파일이 빠진 경우가 대부분입니다.',
        'The hub is static, so this is usually a missing file in the deployment rather than a service outage.')}</p></div>`;
    renderToc([]);
  } finally {
    body.removeAttribute('aria-busy');
  }
}

/**
 * Hash routing, with one wrinkle: the hash is used both for pages (`#api`) and
 * for headings within a page (`#4-anchor-bc01`). A hash that names a page
 * switches pages; anything else is left to the browser to scroll to, which is
 * what makes a deep link into the specification work.
 */
function route(): void {
  const asked = location.hash.replace(/^#/, '');
  // A page that was folded into another: an old link opens where its content went.
  const hash = MOVED[asked] ?? asked;
  if (hash !== asked) history.replaceState(null, '', `#${hash}`);
  if (hash === '' || PAGES.some((p) => p.id === hash)) {
    void show(hash || DEFAULT_PAGE).then(() => {
      if (hash === '') window.scrollTo(0, 0);
    });
    return;
  }
  // An operation or schema of the reference, linked from a guide or from the
  // console: open the reference, then go to it.
  if (/^(op|schema)-/.test(hash) && !document.getElementById(hash)) {
    void show('api').then(() => document.getElementById(hash)?.scrollIntoView());
    return;
  }
  // A heading link. If its page is already shown the browser has handled it;
  // if not, the reader followed a cross-page anchor and we have nothing to
  // scroll to yet — fall back to the default page rather than a blank screen.
  if (!document.getElementById(hash) && $('doc').innerHTML.trim() === '') {
    void show(DEFAULT_PAGE);
  }
}

window.addEventListener('hashchange', route);
route();

/**
 * Outbound links come from `<meta>`, never from markup.
 *
 * The hub, the Playground and the API are one host on a test box and three in
 * production. A relative link hardcoded in the page works in the first case and
 * silently 404s in the second — so the destinations are configuration, and a
 * link with no configured target is removed rather than left pointing nowhere.
 */
for (const el of document.querySelectorAll<HTMLAnchorElement>('a[data-link]')) {
  const target = document.querySelector<HTMLMetaElement>(
    `meta[name="${el.dataset['link']}"]`)?.content;
  if (target) el.href = target;
  else el.remove();
}

// Language first: the masthead is markup and must be right before the first
// paint, not after a fetch.
applyLang();
translateStatic();
const langSlot = document.getElementById('langs');
if (langSlot) langSlot.outerHTML = langToggle();

// The deployment's live state, so the page cannot claim a network the service
// is not on. Failure is silent and the badge stays hidden: the hub is static
// and must keep working when the API is unreachable or on another host.
void (async () => {
  try {
    const api = document.querySelector<HTMLMetaElement>('meta[name="attest-api"]')?.content ?? '';
    const res = await fetch(`${api}/v1/meta`);
    if (!res.ok) return;
    const meta = (await res.json()) as { bitcoin_network?: string; version?: string };
    if (!meta.bitcoin_network) return;
    const badge = $('netbadge');
    badge.textContent = meta.bitcoin_network.toUpperCase();
    badge.className = `netbadge ${meta.bitcoin_network === 'mainnet' ? 'mainnet' : 'regtest'}`;
    badge.title = meta.bitcoin_network === 'mainnet'
      ? t('공개 비트코인에 앵커링됩니다.', 'Anchored to public Bitcoin.')
      : t('비공개 테스트 체인입니다. 증명의 수학적 검증은 오프라인에서 되지만, 체인 포함 여부를 제3자가 확인할 수는 없습니다.',
        'A private test chain: the proof verifies offline, but no third party can confirm chain inclusion here.');
    badge.hidden = false;
  } catch {
    // Offline, or the API is elsewhere. Neither is this page's problem.
  }
})();
