/**
 * Korean and English, chosen by the URL.
 *
 * ## Why the pair is written inline rather than keyed into a dictionary
 *
 * The obvious design is `t('anchor.title')` against a JSON file, and it is
 * what the marketing site does — correctly, because that site is rendered by
 * a server and its copy is handled by people who do not read the templates.
 *
 * This app is different: the copy *is* the code, dense and argumentative, and
 * a key file would put every sentence a screen away from the condition that
 * produces it. Two things follow from `t(ko, en)` that a key table cannot
 * give:
 *
 *   - **A missing translation is a type error.** Both arguments are required,
 *     so there is no path where a key resolves to nothing and the UI renders
 *     a dotted identifier at a customer.
 *   - **The two readings stay side by side**, so a change to one is visibly a
 *     change to the other. Key tables drift precisely because the English is
 *     edited in a file the Korean is not in.
 *
 * ## Why the URL and not storage
 *
 * `?lang=` rather than storage, matching the console — a link is then
 * shareable in the language it was read in, and `location.hash` carries the
 * route so the query survives navigation.
 *
 * A near-copy of `apps/console/src/i18n.ts`. Shared deliberately by copy
 * rather than by package: the two apps ship separately, the module is forty
 * lines, and this one has to grow a markdown fallback the console has no use
 * for. A shared package would couple two independent builds to carry that.
 */

export type Lang = 'ko' | 'en';

/**
 * The language for this page load.
 *
 * `?lang=` wins; otherwise the browser's own preference decides, so a Korean
 * reader is not greeted in English on a product whose copy was written in
 * Korean first. Read once: it cannot change without a navigation.
 */
export const lang: Lang = ((): Lang => {
  const want = new URLSearchParams(location.search).get('lang');
  if (want === 'ko' || want === 'en') return want;
  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
})();

/** Pick one of the two readings. Both are required — see the module note. */
export const t = (ko: string, en: string): string => (lang === 'ko' ? ko : en);

/**
 * The same URL in the other language.
 *
 * Built from the current location so the route in the hash and any other
 * query survive the switch — a toggle that dropped the reader back at the
 * dashboard root would be a worse answer than no toggle.
 */
export function urlForLang(next: Lang): string {
  const url = new URL(location.href);
  url.searchParams.set('lang', next);
  return url.href;
}

/**
 * The KR / EN control, in the marketing site's shape.
 *
 * Anchors rather than buttons: the alternate language is a real address, so
 * it should be openable in a new tab and visible on hover like any other
 * link. `hreflang` lets a browser or crawler know what is on the other side.
 */
export function langToggle(): string {
  const item = (code: Lang, label: string): string =>
    code === lang
      ? `<span class="lang on" aria-current="true">${label}</span>`
      : `<a class="lang" href="${urlForLang(code)}" hreflang="${code}">${label}</a>`;
  // Matches the marketing site's header pair, globe included — same control,
  // same shape, so moving between the sites is not a relearn.
  const globe =
    '<svg class="globe" width="14" height="14" viewBox="0 0 16 16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.15" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.4"/><ellipse cx="8" cy="8" rx="2.75" ry="6.4"/>' +
    '<path d="M1.75 5.75h12.5M1.75 10.25h12.5"/></svg>';
  return `<span class="langs" role="group" aria-label="Language / 언어">` +
    `${globe}${item('ko', 'KR')}<i aria-hidden="true">/</i>${item('en', 'EN')}</span>`;
}

/** Set `<html lang>` so screen readers and hyphenation follow the choice. */
export function applyLang(): void {
  document.documentElement.lang = lang;
}

/**
 * Translate the static shell.
 *
 * The sign-in page is markup, not a render — it has to say something before
 * any script has decided anything, and it is written in Korean because that
 * is the language the product was written in. English lives in a `data-en`
 * attribute beside it, so the two readings sit together exactly as `t()`
 * keeps them together in code.
 *
 * Only swapped when English is wanted; the Korean is already in the DOM.
 */
export function translateStatic(root: ParentNode = document): void {
  if (lang === 'ko') return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-en]')) {
    const en = el.dataset['en'];
    if (en !== undefined) el.innerHTML = en;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-en-label]')) {
    const en = el.dataset['enLabel'];
    if (en !== undefined) el.setAttribute('aria-label', en);
  }
}

/**
 * Which copy of a content page to fetch.
 *
 * Korean pages live under `content/ko/`. Where one does not exist the English
 * is served instead — see `contentFallbackNote`. That is deliberate for the
 * two documents that are contracts rather than prose: translating a normative
 * text produces two normative texts, and they drift.
 */
export function contentPath(file: string, hasKorean: boolean): string {
  return lang === 'ko' && hasKorean ? `./content/ko/${file}` : `./content/${file}`;
}

/** Shown above a page that is only available in English. */
export function contentFallbackNote(hasKorean: boolean): string {
  if (lang !== 'ko' || hasKorean) return '';
  return '<div class="langnote">이 문서는 <b>영문만</b> 제공됩니다. 증빙 규격은 구현이 '
    + '그대로 맞춰야 하는 계약 문서이며, 번역본을 함께 두면 두 개의 정본이 생겨 서로 '
    + '어긋나기 때문입니다.</div>';
}
