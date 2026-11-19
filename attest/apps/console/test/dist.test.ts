/**
 * Checks the **built** console, not the sources.
 *
 * The app ships unbundled ES modules, so the emit step is load bearing: a
 * `./api.ts` specifier that was not rewritten to `.js` fails at load in a
 * browser while every source-level test stays green. There is no bundler to
 * catch it.
 *
 * The rest of this file guards the two things that would be worst here. This is
 * the screen that holds a customer's credential, so it must not cache it; and
 * it is the screen a sceptical evaluator reads most carefully, so it must not
 * overstate what the sandbox can prove.
 *
 * Run `pnpm build` first; the tests skip with a clear message otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../dist');
const built = existsSync(path.join(DIST, 'app.js'));
const skip = built ? false : 'dist/ not built — run `pnpm build` in apps/console first';

const js = (): string[] =>
  readdirSync(DIST).filter((f) => f.endsWith('.js')).map((f) => path.join(DIST, f));

const read = (f: string): string => readFileSync(path.join(DIST, f), 'utf8');

/**
 * Source with comments removed.
 *
 * `tsc` preserves JSDoc, and the comments here discuss the very APIs the
 * prohibitions below scan for — "never written to `localStorage`" tripped the
 * test that forbids `localStorage`. Follows `attest-verify/test/portability.test.ts`,
 * which strips comments for the same reason.
 */
const code = (f: string): string =>
  read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('every emitted import resolves to a real file', { skip }, () => {
  let checked = 0;
  for (const f of js()) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s+["'](\.[^"']*)["']/g)) {
      const spec = m[1]!;
      assert.match(spec, /\.js$/, `${path.basename(f)} imports ${spec} — not rewritten to .js`);
      assert.ok(existsSync(path.resolve(path.dirname(f), spec)),
        `${path.basename(f)} imports a missing ${spec}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected the app to import its api module');
});

test('no .ts specifier survives into the build', { skip }, () => {
  for (const f of js()) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /from\s+["'][^"']*\.ts["']/,
      `${path.basename(f)} kept a .ts specifier`);
  }
});

test('the page references only files that shipped, and nothing remote', { skip }, () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="(\.[^"]+)"/g)].map((m) => m[1]!);
  assert.ok(refs.length >= 2, 'expected the page to reference its script and stylesheet');
  for (const ref of refs) {
    assert.ok(existsSync(path.join(DIST, ref)), `index.html references a missing ${ref}`);
  }
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//, 'the page loads a remote asset');
});

test('links out of this mount are configuration, not markup', { skip }, () => {
  const html = read('index.html');
  // One host on a test box, four in production. A hardcoded `../playground/`
  // works in the first case and 404s in the second.
  assert.doesNotMatch(html, /href="\.\.\//,
    'a hardcoded parent-relative link escapes this mount; use data-link with a <meta> target');
  for (const m of html.matchAll(/data-link="([^"]+)"/g)) {
    assert.match(html, new RegExp(`<meta name="${m[1]!}" content=`),
      `data-link="${m[1]}" has no matching <meta> target, so the link would be dropped`);
  }
});

test('every element the script reaches for exists in the page', { skip }, () => {
  // `$()` throws on a missing id. The two files are coupled only by these
  // strings, and a renamed element blanks the console rather than degrading it.
  const html = read('index.html');
  const app = read('app.js');
  // Only the ids present in the static shell; the rest are rendered by the app
  // into those containers.
  for (const id of ['gate', 'gate-main', 'gate-form', 'shell', 'sections', 'topright', 'dashboard']) {
    assert.match(html, new RegExp(`id="${id}"`), `app.js looks up #${id}, which the page lacks`);
    assert.ok(app.includes(`'${id}'`), `#${id} exists in the page but the app never uses it`);
  }
  // Both shells ship hidden; the app decides which to show once it knows
  // whether there is a session. Otherwise a signed-in visitor sees the sign-in
  // form flash before being replaced. The dashboard is inside the shell now,
  // so it is the shell that carries the attribute.
  assert.match(html, /id="gate"[^>]*hidden/);
  assert.match(html, /id="shell"[^>]*hidden/);
});

// ── the credential ─────────────────────────────────────────────────────────

test('the console never persists the secret key', { skip }, () => {
  const app = code('app.js');
  const api = code('api.js');
  // The service stores only a hash, so nothing here could recover a cached key
  // anyway — but caching it would put a credential somewhere the customer did
  // not choose, and quietly outlive the one render it was meant for.
  for (const [name, src] of [['app.js', app], ['api.js', api]] as const) {
    assert.doesNotMatch(src, /localStorage/, `${name} uses localStorage`);
    assert.doesNotMatch(src, /sessionStorage/, `${name} uses sessionStorage`);
    assert.doesNotMatch(src, /indexedDB/i, `${name} uses IndexedDB`);
    assert.doesNotMatch(src, /document\.cookie/, `${name} writes a cookie itself`);
  }
  // The one-time panel must clear the value as it renders it.
  assert.match(app, /freshKey = null/, 'the fresh key is never dropped from state');
});

test('the session cookie is not readable by this script', { skip }, () => {
  // It is set `HttpOnly` by the server, so the app has to ask `/me` whether a
  // session exists rather than inspecting a cookie. A page that read the cookie
  // would be relying on it *not* being HttpOnly.
  assert.match(code('app.js'), /api\.me\(\)/, 'the app must resume a session by asking the API');
});

test('the digest path hashes locally and sends only the hash', { skip }, () => {
  const api = code('api.js');
  assert.match(api, /crypto\.subtle\.digest\(\s*['"]SHA-256['"]/,
    'hashing must happen in the browser');

  /*
   * This used to forbid *any* file body in the client, which was the right
   * rule while the console had one anchoring path. It now has two, and the
   * second exists to put the document itself on the chain — a file body there
   * is the feature, not a regression.
   *
   * So the invariant moves rather than disappearing: exactly one call may
   * carry a file, it must be the inscription endpoint, and `anchor` — the
   * digest path, the one whose copy promises the document never leaves the
   * browser — must still send JSON and nothing else.
   */
  const bodies = [...api.matchAll(/body:\s*([A-Za-z.]+)/g)].map((m) => m[1]);
  assert.deepEqual(bodies.filter((b) => b === 'file'), ['file'],
    'exactly one call may send a file body');
  assert.match(api, /sendRaw\([^)]*inscribe/,
    'and it must be the inscription endpoint');

  // Still no multipart anywhere: the bytes on the wire are the bytes inscribed.
  assert.doesNotMatch(api, /FormData/, 'the console must not post multipart form data');
  assert.doesNotMatch(api, /multipart/i);
});

test('the inscription path says what it costs, and asks', { skip }, () => {
  const app = read('app.js');
  // Inscribing is irreversible and public. The console must say so on the
  // control itself, not only in prose further up the page, and must confirm
  // before sending — the one action here that cannot be undone.
  assert.match(app, /window\.confirm/, 'inscription must confirm before sending');
  assert.match(app, /되돌릴 수 없습니다|지울 수 없습니다/,
    'the screen must state that an inscription is permanent');
  assert.match(app, /문서는 기기를 떠나지 않습니다/,
    'and the digest path must still make its own, different promise');
});

test('credentials are included so the cookie survives the host split', { skip }, () => {
  // In production the console is served from `app-sandbox.` while the API
  // answers on `api-sandbox.`, and a cross-origin fetch drops cookies by
  // default — on exactly the deployment that matters.
  assert.match(code('api.js'), /credentials:\s*['"]include['"]/);
});

// ── honesty ────────────────────────────────────────────────────────────────

test('the sign-in screen states that nothing here is a public proof', { skip }, () => {
  const html = read('index.html');
  // Before signing up, not after. Someone deciding whether to evaluate the
  // product should not discover the chain's limits on the next screen.
  //
  // The screen is Korean; the English term is kept in parentheses because it
  // is the phrase the rest of the documentation uses, and a reader comparing
  // the two should not have to guess that they mean the same thing. Either
  // spelling satisfies this — what must not happen is neither.
  assert.match(html, /테스트 체인|test[- ]chain/i);
  assert.match(html, /공개적으로 검증 가능한 증명이 아닙니다|not a publicly verifiable proof/i);
});

test('copying works where this console is actually served', { skip }, () => {
  /*
   * `navigator.clipboard` is withheld outside a secure context, and this
   * console is reached over plain http at an IP. The idiomatic
   * `navigator.clipboard?.writeText(…).then(…)` then fails *silently* —
   * optional chaining short-circuits the whole expression, so the button did
   * nothing and said nothing. It shipped that way on the button that reveals
   * a secret key exactly once.
   *
   * So: every copy goes through one helper that falls back, and no caller
   * reaches for the API directly.
   */
  const app = code('app.js');
  assert.match(app, /function copyText/, 'the fallback helper must exist');
  assert.match(app, /execCommand/, 'and it must have a non-secure-context path');

  const direct = [...app.matchAll(/navigator\.clipboard/g)].length;
  assert.equal(direct, 1,
    'navigator.clipboard may be named once, inside copyText — every other '
    + 'caller must go through it or it will fail silently again');
});

test('every command the console prints can actually be run', { skip }, () => {
  /*
   * The signing instructions named `stonehash/attest-sign`, an image on no
   * registry, and failed with "pull access denied" for the first person who
   * pasted them. A command shown to a customer is a promise that it works.
   *
   * No registry reference is the rule, not a one-off fix: pulling an image
   * means trusting it, and this one generates private keys.
   */
  const app = code('app.js');
  assert.doesNotMatch(app, /docker (pull|run)[^\n]*\w+\/attest-sign/,
    'the console must not reference a registry image; build it locally instead');
  assert.match(app, /docker build -t attest-sign/,
    'and must show how to produce the image it then runs');
  assert.match(app, /node packages\/attest-sign\/src\/cli\.ts/,
    'with a Docker-free path, since the package has no dependencies');
});

test('controls inside a re-rendered panel are delegated, not bound', { skip }, () => {
  /*
   * "이 키 등록하기" sits in the panel that reports a successful anchor. That
   * panel is written, then `afterAnchor` re-renders the dashboard to refresh
   * the quota and puts the same *HTML* back — a new element, with no
   * listener. The button looked right and did nothing.
   *
   * Anything in a panel that survives a re-render by being re-inserted has
   * this bug, so those controls carry their state in `data-` attributes and
   * are handled by a document-level listener.
   */
  const app = code('app.js');
  assert.match(app, /data-register-key/,
    'the register control must carry its key in markup, not in a closure');
  assert.doesNotMatch(app, /maybe\('sg-reg'\)|getElementById\('sg-reg'\)/,
    'binding it directly is what broke; it must be delegated');
  assert.match(app, /closest[^\n]*data-register-key/,
    'the document listener must match on the attribute');
});

/**
 * Every visible string exists in both languages.
 *
 * `t(ko, en)` makes a missing translation a type error at the call site, but
 * nothing stops a new string being written as a bare literal. This finds
 * those: it blanks out every balanced `t( … )` call and then looks for
 * Korean in what is left. What remains is, by construction, copy that an
 * English reader would be shown in Korean.
 *
 * Scoped to the sources rather than the bundle because the check is about
 * how the string was written, not what it renders to.
 */
test('no user-visible string is written in one language only', { skip }, () => {
  const strip = (text: string): string => {
    // Comments first — they discuss the Korean copy at length.
    let src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    let out = '';
    let i = 0;
    for (;;) {
      const at = src.indexOf('t(', i);
      // Only a real call, not the tail of an identifier like `format(`.
      if (at < 0) { out += src.slice(i); break; }
      if (at > 0 && /[\w$.]/.test(src[at - 1]!)) { out += src.slice(i, at + 2); i = at + 2; continue; }
      out += src.slice(i, at);
      let j = at + 2;
      let depth = 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      i = j;
    }
    return out;
  };

  const offences: string[] = [];
  for (const file of ['app.ts', 'api.ts', 'por.ts', 'por-words.ts', 'verify.ts', 'verify-files.ts', 'evidence-check.ts', 'por-ledger.ts']) {
    const src = readFileSync(path.resolve(HERE, '../src', file), 'utf8');
    for (const line of strip(src).split('\n')) {
      if (/[가-힣]/.test(line)) offences.push(`${file}  ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(offences, [],
    'these strings are Korean-only; wrap them in t(ko, en):\n' + offences.join('\n'));
});

test('the language toggle is present and switches by URL, not by storage', { skip }, () => {
  // Storage is forbidden in this client — see the prohibitions above — so the
  // choice rides in `?lang=`, which also makes a link shareable in the
  // language it was read in.
  // The app ships unbundled, so the mechanism is its own module rather than
  // inlined into `app.js` — check where the code actually is.
  const i18n = code('i18n.js');
  assert.match(i18n, /searchParams[^\n]*lang/, 'the language must come from the URL');
  assert.match(i18n, /hreflang/, 'the toggle should mark the alternate language');
  assert.doesNotMatch(i18n, /localStorage|sessionStorage|document\.cookie/,
    'and must not persist it anywhere this client is forbidden to write');
  assert.match(code('app.js'), /langToggle/, 'and the masthead must render the toggle');
});

test('the toggle sits at the far right of the bar, and only once', { skip }, () => {
  // Two masthead children each carrying `margin-left: auto` do not both go
  // right — flexbox splits the free space between them, which parked the
  // language pair mid-bar. One right-hand group, with language last in it.
  const html = read('index.html');
  const slots = html.match(/id="langs"/g) ?? [];
  assert.equal(slots.length, 1, 'one toggle: a second rendered from the nav put two on screen');

  const group = html.match(/<div class="topend">([\s\S]*?)<\/div>\s*<\/div>\s*<\/header>/);
  assert.ok(group, 'the right-hand items must live in one group');
  const inner = group[1]!;
  assert.ok(inner.includes('id="topright"') && inner.includes('id="langs"'),
    'identity and language both belong to that group');
  assert.ok(inner.indexOf('id="langs"') > inner.indexOf('id="topright"'),
    'language comes last — of everything in this bar it is the control nobody arrives wanting');

  const css = read('console.css');
  assert.match(css, /\.topend \{[^}]*margin-left: auto/, 'the group is what gets pushed right');
  assert.doesNotMatch(css, /\.masthead \.langs \{[^}]*margin-left: auto/,
    'and the toggle no longer competes for that free space');
});

test('an outbound link that promises a section points at that section', { skip }, () => {
  // "SDK · Docker 받기" landing on the reference's front page is the same
  // defect as a dead link, just harder to notice.
  const app = code('app.js');
  assert.match(app, /data-link-hash/, 'the resolver must support a fragment');
  assert.match(app, /linkHash/, 'and read it when building the href');
});

test('a dashboard link that narrows a section names a state that section knows', { skip }, () => {
  /*
   * The attention queue links to the settlements ledger already filtered —
   * `#/remit?state=EXCEPTION`. The ledger ignores a state it does not know
   * rather than sending it to the server, so a typo here would not error:
   * it would quietly show every settlement under a count that promised the
   * exceptions. Both halves of each such link are checked against the
   * tables that define them.
   */
  const app = code('app.js');
  const sections = [...app.matchAll(/\bid: '([a-z]+)', label: t\(/g)].map((m) => m[1]);
  assert.ok(sections.includes('remit'), 'expected the section table');
  const table = /const REMIT_STATE = \{([\s\S]*?)\n\};/.exec(app);
  assert.ok(table, 'expected the REMIT_STATE table');
  const known = new Set([...table[1]!.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]));
  const links = [...app.matchAll(/#\/([a-z]+)\?state=([A-Z_]+)/g)];
  assert.ok(links.length > 0, 'expected at least one narrowed link');
  for (const [, route, state] of links) {
    assert.ok(sections.includes(route!), `#/${route} is not a section`);
    assert.ok(known.has(state!), `${state} is not a settlement state the ledger knows`);
  }
});

test('the verifier the page runs is the independent one', { skip }, () => {
  // Checking a bundle with the code that produced it proves nothing: both
  // sides would share any mistake. The console vendors `attest-verify` and
  // calls that, and the producer lives in apps/core — never imported here.
  const check = code('verify-files.js');
  assert.match(check, /from ['"]\.\/vendor\/attest-verify\/index\.js['"]/, 'verification must go through the vendored verifier');
  assert.match(check, /verifyBundle\(bundle, /, 'a bundle is checked by the verifier\'s own driver');
  assert.ok(existsSync(path.join(DIST, 'vendor/attest-verify/bundle.js')),
    'the verifier must actually ship');
});

test('the dashboard names its chain on every section, from the API', { skip }, () => {
  const app = code('app.js');
  // Taken from the API's own fields rather than a string in the page, so a
  // console pointed at a mainnet deployment cannot keep claiming regtest
  // limits, nor the reverse.
  assert.match(app, /bitcoin_network/);
  // `anchor_backend` is no longer in the masthead — the daemon's name is an
  // implementation detail, while the chain is the caveat. It still reaches
  // the reader through the transaction view, which reports what the node
  // answering the lookup actually is.
  assert.match(app, /backend/);

  /*
   * And drawn outside the route.
   *
   * The 이 샌드박스가 증명할 수 있는 것 card that used to carry the API's
   * limitation sentence is gone, which leaves the masthead chip as the
   * dashboard's only standing statement of which chain this is. It earns that
   * by rendering for every section — so it must stay in the nav render and
   * out of the per-section switch, where two of four sections would be silent
   * about the chain again.
   */
  const nav = /function renderNav\(\)[\s\S]*?\n\}/.exec(app);
  const dash = /function renderDashboard\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(nav && dash, 'expected renderNav and renderDashboard');
  assert.match(nav[0], /netchip/, 'the network chip must render with the nav, for every route');
  assert.doesNotMatch(dash[0], /netchip/,
    'the network chip is inside the route switch; sections without it would say nothing');
});

test('the menu is one flat list', { skip }, () => {
  const app = code('app.js');
  // 작업 / 설정 / 참고 filed four items into groups of two, one and one. The
  // labels already say which errand each one is, so the headings only pushed
  // the first item further down the sidebar.
  assert.doesNotMatch(app, /navgroup/, 'a group heading is back in the menu');
  assert.doesNotMatch(read('console.css'), /\.navgroup/, 'and the stylesheet still dresses one');
  // Anchoring leads, and the fallback route follows the order rather than
  // naming a section, so the landing cannot drift away from the first item.
  // `as const` is erased by the emit, so match the plain array.
  const sections = /const SECTIONS = \[([\s\S]*?)\n\];/.exec(app);
  assert.ok(sections, 'expected a SECTIONS list');
  assert.match(sections[1]!, /^\s*\{\s*id:\s*'home'/, 'the dashboard should be the first section');
  assert.match(app, /SECTIONS\[0\]/, 'the unknown-route fallback should follow the order');

  // Nine items are not all one kind — six are work done with a product,
  // three are the organisation's own administration — and 구독 read as a
  // product while it sat among them. A rule marks the change; still no
  // headings, for the reason above.
  assert.equal([...app.matchAll(/class="navsep"/g)].length, 1, 'the menu should carry exactly one rule');
  assert.match(app, /const ORG_FROM = 'products'/, 'the rule sits above 구독, the first of the organisation\'s own sections');
  assert.match(read('console.css'), /\.navsep\s*\{/, 'and the stylesheet has to draw it');
});

test('the menu lists a product\'s screen only for an organisation that subscribes to it', { skip }, () => {
  /*
   * Anchoring is in every product — a settlement's evidence and a reserve
   * snapshot end on the chain as a document does — so the menu is divided by
   * product, and the one item that carries the word is the document product:
   * 문서 앵커링. A product's screen is listed only for an organisation that
   * subscribes to it, as the dashboard draws only those products' rows. The
   * record of what was anchored belongs to all of them and is always listed.
   */
  const app = code('app.js');
  const map = /const SECTION_PRODUCT = \{([^}]*)\}/.exec(app);
  assert.ok(map, 'expected the section → product table');
  assert.match(map[1]!, /remit: 'remit'/);
  assert.match(map[1]!, /por: 'por'/);
  assert.match(map[1]!, /anchor: 'attest'/);
  assert.doesNotMatch(map[1]!, /records/, '앵커링 기록 is every product\'s record and must not be tied to one');
  const menu = /function renderSections\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(menu, 'expected renderSections');
  // The section on screen stays listed: a link can lead to a product that is
  // not subscribed, and the menu still has to say where the reader is.
  assert.match(menu[0], /SECTIONS\.filter\(\(x\) => inMenu\(x\.id\) \|\| x\.id === here\)/,
    'the menu must follow the subscriptions, keeping the section on screen');
  // Subscriptions that could not be read list everything — a failed request
  // must never be the reason a screen is missing.
  assert.match(app, /!st\.products \|\| st\.products\.has\(product\)/);
  assert.match(app, /id: 'anchor', label: t\('문서 앵커링'/,
    'the document product is 문서 앵커링 in the menu; 앵커링 alone names what every product does');
});

test('앵커링 기록 names the product behind each record and narrows by it', { skip }, () => {
  const app = code('app.js');
  // Asked of the server, where the limit is applied: the newest fifty of
  // everything a bank anchored are nearly all settlement evidence.
  assert.match(code('api.js'), /\/v1\/console\/attestations\$\{product \? `\?product=\$\{product\}` : ''\}/,
    'the narrowed list must be requested by product');
  // The server answers with the newest fifty and does not say how many there are. A list that long may
  // have more behind it, and a snapshot's id is read off this list — so the rest has to be within reach.
  assert.match(code('api.js'), /limit \? `\$\{product \? '&' : '\?'\}limit=\$\{limit\}` : ''/, 'more than the newest fifty can be asked for');
  assert.match(app, /if \(shown < recordsView\.limit\)\s*return '';/, 'a list that is whole draws no pager');
  assert.match(app, /id="att-more"/, 'a list that may be a part offers the rest');
  assert.match(app, /class="rprod"/, 'each row has to say which product anchored it');
  // …and narrowed again in the page, so a server that ignores the parameter
  // cannot have every product's rows shown under one product's name.
  assert.match(app, /\.filter\(\(a\) => \(a\.product \?\? 'attest'\) === product\)/);
  // The choice is in the address, so it survives a reload and can be linked
  // to — written with replaceState, as the settlements ledger writes its own.
  // Assigning the hash redraws the whole screen, the select included, and a
  // keyboard user loses the control after one step.
  assert.match(app, /history\.replaceState\(null, '', chosen \? `#\/records\?product=\$\{chosen\}` : '#\/records'\)/);
  // Unnarrowed, the list read at sign-in is drawn and then asked for again:
  // without that, what another product anchored since would be listed under
  // its own product and missing from 전체 상품.
  const load = /async function loadRecords\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(load, 'expected loadRecords');
  assert.match(load[0], /api\.attestations\(product \|\| undefined, /, 'both views must ask the server');
  assert.match(load[0], /st\.attestations = r\.data/, 'and the unnarrowed answer replaces the list held since sign-in');
  // The document product's dashboard row links to its own records, not to
  // every product's newest fifty.
  assert.match(app, /href="#\/records\?product=attest"/);
  // …and the reserve row to its own, which is where the snapshot history went.
  assert.match(app, /href="#\/records\?product=por"/);
});

test('only a confirmed record gets the success colour', { skip }, () => {
  const app = code('app.js');
  const css = read('console.css');
  // `accepted` means "in a batch that has not been sealed". Showing that green
  // would tell the customer their document is on the chain when it is not.
  const chip = /function statusChip\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(app);
  assert.ok(chip, 'expected a statusChip function');
  assert.match(chip[1]!, /confirmed['"]?\s*\?\s*['"]ok['"]/,
    'confirmed must be the state that maps to the success class');
  assert.match(chip[1]!, /inert/, 'the in-progress states must map to a neutral class');

  const inert = /\.chip\.inert\s*\{([^}]*)\}/.exec(css);
  assert.ok(inert, 'expected a .chip.inert rule');
  assert.doesNotMatch(inert[1]!, /--pass-bg|--brand\b/,
    '.chip.inert borrows a success colour; an unconfirmed record must read neutral');
});

test('the console points at the reference rather than restating it', { skip }, () => {
  /*
   * This used to require a curl example on the dashboard, on the theory that
   * showing the equivalent call is what makes "the console does nothing you
   * could not do with the key" checkable.
   *
   * It made the claim checkable and the examples wrong. They were copied into
   * two panels, drifted to endpoints the console had stopped calling, and
   * nothing failed when they did — the test only asked that *a* curl existed.
   * The reference is generated from the served routes and has a test that it
   * covers every one of them, so the honest arrangement is one source and a
   * link to it.
   */
  const app = code('app.js');
  assert.match(app, /data-link="attest-docs"/, 'the reference must be reachable from here');
  assert.doesNotMatch(app, /curl /,
    'API examples belong in the reference, where a test checks they match the routes');
});

test('nothing emits an inline style attribute', { skip }, () => {
  /*
   * The page ships under `style-src 'self'`, which blocks `style` attributes
   * outright — and blocks them *silently* as far as the layout is concerned.
   * A quota bar written as `style="width:37%"` simply never filled, and two
   * section headings rendered at the browser's default size, with nothing in
   * the UI to suggest a rule had been dropped.
   *
   * Computed values go through the CSSOM (`el.style.width = …`), which is not
   * an inline style and is allowed; static values belong in the stylesheet.
   */
  for (const f of js()) {
    const src = code(path.basename(f));
    assert.doesNotMatch(src, /\bstyle="/,
      `${path.basename(f)} emits a style attribute, which this page's CSP drops`);
  }
  assert.doesNotMatch(read('index.html'), /\bstyle="/, 'index.html carries an inline style');
});

test('the hidden attribute outranks the panel display rules', { skip }, () => {
  /*
   * Both panels are `display: grid`, which beats the UA stylesheet's
   * `[hidden] { display: none }`. Without an explicit override, signing in
   * left the sign-in card on screen above the dashboard — and it looked fine
   * beforehand only because an unrendered dashboard occupies no space.
   */
  const css = read('console.css');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'the stylesheet must force [hidden] to win, or toggling a panel does nothing');
});

/**
 * The console must not send an evaluator back to the cut-down version.
 *
 * The Playground is the public, no-account demo. Someone who has signed in
 * has strictly more here — their own evidence, the tamper catalogue, packages
 * — so a link to it in the masthead was pointing at less than they already
 * had. The reference stays, in the sidebar and beside the key, where the work
 * that needs it happens.
 */
test('the console links to the reference, not to the lite demo', { skip }, () => {
  const html = read('index.html');
  const app = read('app.js');
  assert.doesNotMatch(html + app, /attest-playground/,
    'the console should not point a signed-in evaluator at the no-account demo');
  assert.match(app, /data-link="attest-docs"/, 'the API reference must still be reachable');
  assert.match(html, /name="attest-docs"/, 'and its target must be configurable');
});

test('a feed row that names one settlement lands on that settlement', { skip }, () => {
  /*
   * The dashboard's recent-settlements feed links each settlement by ID
   * (`#/remit?q=…`). That is
   * only honest if the ledger reads `q` from the address and searches by it,
   * the way it reads `state` — otherwise the link would open the whole
   * ledger under an ID that promised one row.
   */
  const app = code('app.js');
  assert.match(app, /#\/remit\?q=\$\{encodeURIComponent\(/, 'feed rows link by settlement id');
  assert.match(app, /routeQuery\(\)\.get\('q'\)/, 'the ledger honours the id in the address');
});

// ── the dashboard's two zones ───────────────────────────────────────────────

test('the billing card does not read as one more operations row', { skip }, () => {
  // 구독 · 빌링 is the account's standing; the rows beneath it are what the
  // products did. On the same white card the first read as one of the second.
  assert.match(read('console.css'), /\.card\.bill\s*\{[^}]*--dark/, 'the billing card should sit on the dark surface');
  assert.match(code('app.js'), /class="zonehead"/, 'and the operations rows should be named as their own zone');
});

// ── 추적 ────────────────────────────────────────────────────────────────────

test('the tracker picture says nothing the signed events do not', { skip }, () => {
  const app = code('app.js');
  const journey = /function journeyHtml\([\s\S]*?\n\}/.exec(app);
  assert.ok(journey, 'expected journeyHtml');
  // Every mark is one of legVerdicts' statuses. A picture that read the state
  // string for itself could show a leg complete that no signed event completed.
  assert.doesNotMatch(journey[0], /d2\.state\b/, 'the picture must be drawn from the leg verdicts');
  assert.match(app, /journeyHtml\(d2, verdicts, live, fresh\)/, 'and from the same verdicts as the list beneath it');
  // An amount whose leg has not completed is the quoted figure, and says so.
  assert.match(journey[0], /planned/, 'an amount that has not moved yet must be labelled as planned');

  // Following a payment is bounded, and ends with its row.
  const follow = /async function followSettlement\([\s\S]*?\n\}/.exec(app);
  assert.ok(follow, 'expected followSettlement');
  assert.match(follow[0], /isConnected/, 'a follow must end when its row leaves the page');
  assert.match(follow[0], /rx-hidden/, 'and when the row is closed');
  assert.match(follow[0], /polls < FOLLOW_MAX/, 'and after a bounded number of asks');
  assert.doesNotMatch(app, /setInterval\(/,
    'a chained timeout ends by not being rescheduled; an interval has to be remembered and cleared');

  // Failure stays neutral in the picture too — a fact to read, not an alarm.
  const failed = /\.jstep\.failed \.jnode\s*\{([^}]*)\}/.exec(read('console.css'));
  assert.ok(failed, 'expected a rule for a failed station');
  assert.match(failed[1]!, /--inert/);
  assert.doesNotMatch(failed[1]!, /--fail/);
});

// ── 준비금 증명 ─────────────────────────────────────────────────────────────

test('the reserve screen keeps the balance file and the key in the page', { skip }, () => {
  /*
   * The point of the exchange SDK is that the ledger never leaves the
   * exchange. This screen does the SDK's job in a browser, so the same has to
   * hold for it: it reads a file and a key, and the only thing it sends is the
   * JSON of a signed statement, through the API module.
   */
  const por = code('por.js');
  for (const banned of [/\bfetch\(/, /XMLHttpRequest/, /FormData/, /sendBeacon/, /WebSocket/,
    /localStorage/, /sessionStorage/, /indexedDB/i, /document\.cookie/]) {
    assert.doesNotMatch(por, banned, `por.js reaches for ${banned} — the file or the key could leave the page`);
  }
  // What it may ask of the API: reads, and the two calls of the snapshot protocol.
  const calls = [...new Set([...por.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]!))].sort();
  assert.deepEqual(calls, ['porConsoleKey', 'porOpenings', 'porSnapshot', 'porSubmit', 'products']);
  assert.match(por, /api\.porSubmit\(\{ statement, sig\b/,
    'a submission is the statement and its signature');
  assert.match(code('api.js'), /porSubmit:[\s\S]{0,200}?send\('POST', '\/v1\/por\/snapshots', body\)/,
    'and it goes as JSON, like every other call');

  // A spot check opens leaves by their hash. The account identifier is the
  // one field of a leaf that must not be in what is sent.
  const opening = /provePorLeaf\(tree, i, \{([^}]*)\}\)/.exec(por);
  assert.ok(opening, 'expected the spot-check openings to be built from the tree');
  assert.doesNotMatch(opening[1]!, /user_ref(?!_hash)/, 'an opening must not carry the account identifier');

  // The key it signs with is made for the session. Only the public half is
  // registered; the private half is never downloaded, shown or sent.
  assert.match(por, /api\.porConsoleKey\(ex\.id, key\.spki\)/, 'the console key registered must be the public half');
  assert.doesNotMatch(por, /download\([^)]*key\b/, 'the session key must not be offered as a file');
  assert.doesNotMatch(por, /key\.d\b(?!\))/, 'the private half may only ever be handed to the signer');
});

test('the reserve screen asks for a file and nothing else', { skip }, () => {
  /*
   * The first version asked for the asset list with decimal places, how
   * amounts were written, the as-of time and a signing key. Every one of
   * those is a decision on a server; on a screen meant to be tried they were
   * four ways to stop before anything happened. The page now reads them off
   * the file and says what it settled on next to the result.
   */
  const por = code('por.js');
  for (const id of ['por-assets', 'por-amounts', 'por-asof', 'por-key', 'por-build', 'por-submit', 'por-mint']) {
    assert.doesNotMatch(por, new RegExp(`['"#]${id}['"]|id="${id}"`), `the screen still has #${id}`);
  }
  assert.match(por, /id="por-file"/, 'the balance file is the one thing asked for');
  assert.match(por, /id="por-go"/, 'and one button anchors it');
  assert.match(por, /id="por-settled"/, 'what was read off the file has to be said with the result');
  // Amounts are taken as written: the reader is never told they are base units.
  assert.match(por, /amounts: 'decimal'/);
  assert.doesNotMatch(por, /amounts: 'base'/);
});

test('the reserve screen runs the SDK\'s own rules, not a copy of them', { skip }, () => {
  /*
   * A root made on this screen has to be the root the SDK makes from the same
   * file and seed, or the screen is demonstrating a different product. The
   * modules are copied from the package when the console is built; the only
   * edit is the verifier's specifier, which a browser with no bundler cannot
   * follow by package name.
   */
  const pkg = path.resolve(HERE, '../../../packages/attest-por/src');
  const vendored = path.resolve(HERE, '../src/vendor/attest-por');
  const names = readdirSync(vendored).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(names, ['accounts-json.ts', 'amounts.ts', 'csv.ts', 'ledger.ts', 'portable.ts', 'snapshot-proof.ts', 'snapshot.ts', 'sumtree.ts']);
  for (const f of names) {
    const want = readFileSync(path.join(pkg, f), 'utf8')
      .replaceAll("from '@stonehash/attest-verify'", "from '../attest-verify/index.ts'");
    assert.equal(readFileSync(path.join(vendored, f), 'utf8'), want,
      `vendor/attest-por/${f} has drifted from the SDK — rebuild the console`);

    // None of them may need a server. This console is reached over plain
    // http, where the browser withholds `crypto.subtle`, so that is out too.
    const shipped = path.join(DIST, 'vendor/attest-por', f.replace(/\.ts$/, '.js'));
    assert.ok(existsSync(shipped), `${f} did not ship`);
    const src = readFileSync(shipped, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /from 'node:|\bBuffer\b|crypto\.subtle|\brequire\(/, `${f} is not portable`);
  }
});

test('the example the reserve screen offers is the SDK\'s own file', { skip }, () => {
  /*
   * The screen runs an example and hands the same file out as a download. A
   * copy typed into the screen would drift from the file the guide points at
   * and the SDK's own tests pin a root for, so the build writes the package's
   * file into a module and this checks the module that shipped still says
   * what that file says.
   *
   * One example, not one per shape the reader takes: the screen once offered
   * four, and four example links read as a choice to be made before a first
   * try. The one offered is the standard shape — one row per account, one
   * column per asset. The other shapes are still read, and are in the guide.
   */
  const samples = path.resolve(HERE, '../../../packages/attest-por/samples');
  const shipped = read('vendor/attest-por-samples.js');
  const text = readFileSync(path.join(samples, 'balances.wide.csv'), 'utf8');
  assert.match(text, /^account_id,BTC,ETH,USDT\n/, 'the standard example is one row per account, with a column per asset');
  assert.ok(shipped.includes(`export const SAMPLE_WIDE = ${JSON.stringify(text)};`), 'the example as shipped differs from the SDK\'s');
  assert.ok(shipped.includes('export const SAMPLE_WIDE_NAME = "balances.wide.csv";'), 'the example must be offered under its own name');
  assert.deepEqual([...shipped.matchAll(/export const (\w+)_NAME\b/g)].map((m) => m[1]), ['SAMPLE_WIDE'], 'one example ships, and only one');
  const por = code('por.js');
  assert.deepEqual([...por.matchAll(/data-por-sample="(\w+)"/g)].map((m) => m[1]), ['wide'], 'the screen offers exactly one example to download');
  assert.match(por, /data-link-hash="por-data"/, 'and a link to the guide, where the other shapes are');
  assert.match(por, /s\.fileText = SAMPLE_WIDE\b/, 'the example that runs is the file that downloads');
  assert.match(por, /download\(SAMPLE_WIDE_NAME, SAMPLE_WIDE, 'text\/csv'\)/);
  // …and it is under that file's own name that the proof file records it, or the download could not be matched to it later.
  assert.match(por, /s\.fileText !== null \? SAMPLE_WIDE_NAME :/, 'the example is recorded as the SDK file it is');
  // An identifier alone is the proof field's placeholder; one followed by a comma would be a row.
  assert.doesNotMatch(por, /U-1000\d\d,/, 'no row of the example may be typed into the screen itself');
});

test('the reserve screen leaves one file to keep', { skip }, () => {
  /*
   * The first version handed back five files — the statement, every leaf, the
   * seed, a tree header, the submission — to be kept together in a folder.
   * That was the SDK's directory, offered through a browser, and it asked a
   * visitor to store a second copy of every balance they already had. What is
   * kept now is the balance file itself and one small proof file.
   */
  const por = code('por.js');
  assert.doesNotMatch(por, /data-por-file=/, 'the five-file folder must be gone');
  for (const gone of ['leaves.jsonl', 'seed.hex', 'tree.json', 'submission.json']) {
    assert.ok(!por.includes(gone), `the screen still speaks of ${gone}`);
  }
  // One download in the result, and it is the SDK's proof file as the SDK writes it.
  assert.match(por, /id="por-proof-dl"/, 'the result must offer the proof file');
  assert.match(por, /download\(proofFileName\(a\.proof\), snapshotProofText\(a\.proof\)\)/);
  // It is made — and so checked for being writable — before the statement is
  // sent: an accepted snapshot with no proof file could never issue a proof.
  const made = por.indexOf('buildSnapshotProof(');
  const sent = por.indexOf('api.porSubmit(');
  assert.ok(made > 0 && sent > made, 'the proof file must be built before the statement is submitted');
  // Neither the proof file nor the seed is ever an argument of an API call.
  assert.doesNotMatch(por, /api\.\w+\([^)]*\b(seed|draft|proofText|snapshotProofText|proofBytes)\b/,
    'the proof file and the seed stay in the page');
});

test('the reserve screen anchors and does nothing else', { skip }, () => {
  /*
   * It carried two more cards: a check of the proof file against the balance
   * file with an account's proof behind it, and a table of past snapshots.
   * Checking a file is what 검증 is for, whichever product the file came
   * from, and a snapshot once anchored is a record like any other — so the
   * screen is one card, and says where the other two things are now.
   */
  const por = code('por.js');
  for (const gone of ['por-check', 'por-proof-in', 'por-ledger-in', 'por-account', 'por-prove', 'por-held', 'por-platform', 'por-history']) {
    assert.ok(!por.includes(gone), `the reserve screen still carries #${gone}`);
  }
  assert.doesNotMatch(por, /restoreSnapshot|parseSnapshotProof|provePorLeaf\(h\.tree/, 'rebuilding a snapshot and issuing an account\'s proof are not this screen\'s');
  assert.match(por, /root\.innerHTML = anchorCardHtml\(\);/, 'the screen is the anchoring card');
  // What the removed cards did is one sentence each, where the result is.
  assert.match(por, /href="#\/verify"/, 'the result must say where the two files are checked');
  assert.match(por, /href="#\/records\?product=por"/, 'and where the snapshot is listed');
  assert.match(por, /href="\/playground\/por\.html"/, 'the public verify page is named where the snapshot id is shown');
  // The one copy of a proof file is in this page until it is downloaded. Choosing another file or anchoring
  // again takes its result box away, never the file: each one not yet taken keeps a line of its own, and
  // leaving the document with one outstanding is confirmed first.
  assert.match(por, /s\.kept\.push\(proof\)/, 'an accepted snapshot\'s proof file is kept until it is downloaded');
  assert.match(por, /s\.kept\.filter\(\(p\) => p !== s\.anchored\?\.proof\)/, 'every proof file whose result is no longer shown gets a line');
  assert.match(por, /addEventListener\('beforeunload'[\s\S]{0,200}s\.kept\.length === 0/, 'leaving with a proof file outstanding asks first');
  // Signing out, or in as another account, must leave nothing of the last one behind.
  const reset = /export function resetPor\(\)[\s\S]*?\n\}/.exec(por);
  assert.ok(reset, 'expected resetPor');
  for (const field of ['s.anchored = null', 's.kept = []', 's.key = null', 's.file = null', 's.fileText = null']) {
    assert.ok(reset[0].includes(field), `resetPor must clear ${field.split(' ')[0]}`);
  }
  const appJs = code('app.js');
  const signOut = /maybe\('sign-out'\)\?\.addEventListener\('click', \(\) => \{[\s\S]*?showGate\('login'\);/.exec(appJs);
  assert.ok(signOut, 'expected the sign-out handler');
  assert.match(signOut[0], /resetPor\(\);/, 'signing out forgets the reserve screen');
  for (const id of ['dashboard', 'sections', 'topright']) {
    assert.match(signOut[0], new RegExp(`\\$\\('${id}'\\)\\.innerHTML = ''`), `signing out takes #${id} out of the document behind the gate`);
  }
  // A proof file not yet downloaded is lost by signing out, so that is asked first — before the session is ended.
  assert.match(signOut[0], /porUntaken\(\) > 0 && !window\.confirm\([\s\S]*?\)\)\s*return;[\s\S]*api\.logout\(\)/, 'an undownloaded proof file is asked about before signing out');
  assert.match(appJs, /resetPor\(\);\s*st\.overview = overview;/, 'and signing in starts from nothing, before the new account is on screen');
  // An anchoring waits on the network; if the account changes meanwhile its answer must be dropped at every
  // wait — the platform's answer above all, which carries the proof file.
  const anchoring = /async function anchor\(\)[\s\S]*?\n\}/.exec(por);
  assert.ok(anchoring, 'expected anchor()');
  assert.match(anchoring[0], /const gone = \(\) => account !== s\.account;/);
  assert.match(anchoring[0], /await api\.porSubmit\([^\n]*\);\s*if \(gone\(\)\)\s*return;/, 'the platform\'s answer is dropped when the account has changed');
  assert.ok([...anchoring[0].matchAll(/if \(gone\(\)\)\s*return;/g)].length >= 5, 'every wait in an anchoring is followed by the check');
  assert.match(anchoring[0], /const fail = [^\n]*if \(gone\(\)\)\s*return;/, 'not even a failure is written on another account\'s screen');
  assert.match(reset[0], /s\.account\+\+/, 'and resetPor is what moves the account on');
  const init = /export async function initPor\([\s\S]*?\n\}/.exec(por);
  assert.ok(init, 'expected initPor');
  assert.match(init[0], /if \(account !== s\.account\)\s*return;/, 'a start-up answer about the last account is dropped too');
  // The result links away from the screen; back on it, the watch over the anchor is taken up again.
  assert.match(init[0], /void watchAnchor\(\+\+s\.run, a\.proof\.snapshot_id, 0\)/, 'the anchor is followed again on return');
  const css = read('console.css');
  for (const dead of ['.porpair', '.porgrid', '.porproof', '#por-check', '#por-account', '#por-prove', '#por-held']) {
    assert.ok(!css.includes(dead), `the stylesheet still dresses ${dead}`);
  }
});

test('checking a downloaded proof is one screen, common to every product', { skip }, () => {
  /*
   * The check sat at the foot of 문서 앵커링 — the screen of one product, not
   * listed for an organisation that does not subscribe to it — while a bank's
   * evidence and an exchange's proof file are checked the same way. It is a
   * section of its own now, beside the record list, and belongs to no product.
   */
  const app = code('app.js');
  const sections = /const SECTIONS = \[([\s\S]*?)\n\];/.exec(app);
  assert.ok(sections, 'expected a SECTIONS list');
  const order = [...sections[1]!.matchAll(/\bid: '(\w+)'/g)].map((m) => m[1]!);
  assert.deepEqual(order, ['home', 'remit', 'por', 'anchor', 'records', 'verify', 'products', 'integrate', 'audit'],
    '검증 follows 앵커링 기록, above the rule');
  const map = /const SECTION_PRODUCT = \{([^}]*)\}/.exec(app);
  assert.ok(map, 'expected the section → product table');
  assert.doesNotMatch(map[1]!, /verify/, '검증 is every product\'s and must not be tied to one');
  // The address reaches the screen itself, and nothing sends a reader to the foot of another page.
  assert.doesNotMatch(app, /want === 'verify'/, '#/verify must not be redirected to another section');
  assert.doesNotMatch(app, /focus=verify/, 'no link may still point at the foot of 문서 앵커링');
  assert.match(app, /here === 'verify' \? sectionVerify\(st\.products\)/, 'the section is drawn for the route');
  const anchor = /function sectionAnchor\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(anchor, 'expected sectionAnchor');
  assert.doesNotMatch(anchor[0], /sectionVerify/, '문서 앵커링 must not carry the check any more');
  assert.match(app, /<a href="#\/verify">/, 'the record list has to say where a bundle is checked');

  // One card, two slots, one button — and it explains only the files this organisation can hold.
  const screen = code('verify.js');
  assert.equal([...screen.matchAll(/<input type="file"/g)].length, 2, 'two slots');
  assert.equal([...screen.matchAll(/<button class="btn"/g)].length, 1, 'one button');
  // A verdict belongs to the files it was computed from: filling either slot removes it.
  const changed = /function changed\(\)[\s\S]*?\n\}/.exec(screen);
  assert.ok(changed, 'expected changed()');
  assert.match(changed[0], /v\.run\+\+/, 'a check still running is forgotten');
  assert.match(changed[0], /out\.innerHTML = ''/, 'and the result on the screen goes');
  assert.equal([...screen.matchAll(/\bchanged\(\);/g)].length, 3, 'both file choosers and a drop');
  assert.match(screen, /has\('remit'\) \?/, 'settlement evidence is explained to an organisation that has settlements');
  assert.match(screen, /has\('por'\) \?/, 'and reserve proof files to one that has reserves');
});

test('the verify screen sends nothing and asks no server', { skip }, () => {
  /*
   * A check that needed this platform would be the platform's word again.
   * Every file is read in the page; none of these modules may reach the
   * network, the API module, or anything that outlives the page.
   */
  for (const f of ['verify.js', 'verify-files.js', 'evidence-check.js', 'por-ledger.js']) {
    const src = code(f);
    for (const banned of [/\bfetch\(/, /XMLHttpRequest/, /FormData/, /sendBeacon/, /WebSocket/, /\bapi\./,
      /localStorage/, /sessionStorage/, /indexedDB/i, /document\.cookie/]) {
      assert.doesNotMatch(src, banned, `${f} reaches for ${banned}`);
    }
    assert.doesNotMatch(src, /from ['"]\.\/api\.js['"]/, `${f} must not import the API module`);
  }
  // Not importing it is not enough: a module that imports the reserve screen for one word can reach the API
  // through it. Every module the verify screen loads, followed to the end, must stay clear of it.
  const reached = new Set<string>();
  const follow = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) follow(path.resolve(path.dirname(file), m[1]!));
  };
  // The deciding half is loaded when a check is run, not with every page: a visit that never opens 검증
  // does not fetch the rules engine. The walk follows that load as it follows the static ones.
  const screenSrc = readFileSync(path.join(DIST, 'verify.js'), 'utf8');
  assert.match(screenSrc, /await import\(['"]\.\/verify-files\.js['"]\)/, 'the deciding half is loaded on demand');
  assert.doesNotMatch(screenSrc, /^import [^\n]*from ['"]\.\/(verify-files|evidence-check)\.js['"]/m, 'and is not part of the first load');
  follow(path.join(DIST, 'verify.js'));
  const names = [...reached].map((f) => path.relative(DIST, f));
  assert.ok(names.includes('verify-files.js') && names.includes('evidence-check.js'), 'the walk must have followed the imports');
  for (const banned of ['api.js', 'por.js', 'app.js']) {
    assert.ok(!names.includes(banned), `the verify screen can reach ${banned}: ${names.join(', ')}`);
  }
});

test('each product\'s file is held against the anchored hash by that product\'s rule', { skip }, () => {
  /*
   * A bundle labels its preimage `sha256-file` whatever anchored it, but a
   * reserve snapshot's hash is a commitment over its statement and a
   * settlement's is one over its evidence package. Hashed as documents, the
   * honest files would be called forgeries. The behaviour is held by
   * `verify-files.test.ts`; this pins that the rules are the SDKs' own.
   */
  const check = code('verify-files.js');
  assert.match(check, /porSnapshotCommitment\(original\.proof\.statement\) === leafOf\(bundle\)/,
    'a snapshot\'s statement is held against the hash with the function the platform anchors with');
  assert.match(check, /restoreSnapshot\(proof, read\.rows\)/, 'a balance file is held against a proof file by the SDK\'s own rebuild');
  assert.match(check, /ledgerOptionsOf\(proof\)/, 'and read the way the proof file records');
  // The evidence package: the four checks, with the rules engine's own files and no `crypto.subtle`.
  const evidence = code('evidence-check.js');
  assert.match(evidence, /from ['"]\.\/vendor\/attest-rules\/engine\.js['"]/, 'the verdict is recomputed by the rules engine itself');
  assert.match(evidence, /signedBytes\(element\)/, 'what an issuer signed is the rules engine\'s definition');
  assert.doesNotMatch(evidence, /crypto\.subtle|verifySignature\(|verifyEvidenceSignatures\(/,
    'on plain http `crypto.subtle` is absent and the engine\'s own verifier would call every signature invalid');
});

test('앵커링 기록 says what each record is of', { skip }, () => {
  /*
   * A row named its product and nothing else: which settlement an evidence
   * anchor belonged to could not be told, and a snapshot's id — what the
   * public verify page asks for — could be read only on the screen that made
   * it, in a table of its own. The table is gone; the row carries it.
   */
  const app = code('app.js');
  assert.match(app, /data-snapshot="\$\{esc\(about\.snapshot_id\)\}"/, 'a reserve record opens its snapshot');
  assert.match(app, /href="#\/remit\?q=\$\{uriPart\(about\.payment_id\)\}"/, 'a settlement record leads to its settlement');
  // The note beside a record is its caller's own; which product anchored it is the platform's word. A document
  // whose note says `kind: por-snapshot` must not be listed, or explained, as a snapshot.
  assert.match(app, /from === 'por' && about\.kind === 'por-snapshot'/, 'a snapshot reference only on a reserve record');
  assert.match(app, /from === 'remit' && about\.kind === 'remit-evidence'/, 'a settlement reference only on a settlement record');
  assert.match(app, /product === 'por' && kind === 'por-snapshot'/, 'and the explainer words a hash as a commitment only for that product\'s records');
  // One value that cannot be put in an address must not cost the whole list.
  assert.match(app, /const uriPart = [\s\S]{0,160}try \{[\s\S]{0,80}encodeURIComponent/, 'an id is made part of an address inside a try');
  const panel = /function wireSnapshotLookup\(\)[\s\S]*?\n\}/.exec(app);
  assert.ok(panel, 'expected wireSnapshotLookup');
  assert.match(panel[0], /api\.porSnapshot\(id\)/, 'the snapshot is read from the platform\'s own record of it');
  assert.match(panel[0], /id="snap-id"/, 'the full id must be there to copy');
  assert.match(panel[0], /data-copy-from="snap-id"/, 'through the delegated copy control');
  assert.match(panel[0], /href="\/playground\/por\.html"/, 'with the public verify page, where the id is used');
});

// ── a new bank's first run ─────────────────────────────────────────────────

test('signing up through the form shows the new key', { skip }, () => {
  /*
   * The sign-up form lives at `#signup`, and the success path cleared it with
   * `location.hash = ''`. That fires hashchange; the route listener rendered
   * the dashboard a second time, and that render no longer had the key the
   * first had shown and dropped — so the one-time panel was gone within a
   * frame, and nobody who signed up through the form ever saw a key. The
   * fragment now goes with `replaceState`, which fires no event, before the
   * one render that shows the key.
   */
  const app = code('app.js');
  const gate = /function showGate\([\s\S]*?\n\}/.exec(app);
  assert.ok(gate, 'expected showGate');
  assert.doesNotMatch(gate[0], /location\.hash\s*=(?!=)/,
    'assigning the hash fires hashchange, and the re-render drops the key panel');
  assert.match(gate[0], /history\.replaceState\([^;]*;\s*showDashboard\(\)/,
    'the gate\'s fragment must go without an event, before the render that shows the key');
});

test('after activating Settlements the console hands over what integration starts from, and no command', { skip }, () => {
  /*
   * A bank applies the SDK inside its own system's source; it does not run
   * the corridor from a terminal. The panel used to print a download check
   * and a command-line submission. It now carries the institution id, the
   * SDK's two files and the one guide — and the files it names have to be
   * ones the hub publishes.
   */
  const app = code('app.js');
  const panel = /function remitFirstRunHtml\([\s\S]*?\n\}/.exec(app);
  assert.ok(panel, 'expected remitFirstRunHtml');
  assert.doesNotMatch(panel[0], /cli\.ts|export STONEHASH_|sha256sum|tar xzf|<pre/,
    'the panel must not hand a bank a command to run');
  assert.match(panel[0], /data-link-hash="corridor"/, 'the guide is the cross-border page');
  assert.doesNotMatch(app, /data-link-hash="swift"/, 'the SWIFT page was folded into the cross-border guide');
  const files = [...panel[0].matchAll(/file\(["']([\w.-]+)["']\)/g)].map((m) => m[1]!).sort();
  assert.deepEqual(files, ['attest-remit.sha256', 'attest-remit.tar.gz']);
  const hub = readFileSync(path.resolve(HERE, '../../docs/build.mjs'), 'utf8');
  assert.match(hub, /attest-remit/, 'the hub must publish the archive the panel links');
  // The institution id is what the bank's code is configured with: copied
  // through the one helper, by a control that survives the card's redraw.
  assert.match(panel[0], /id="remit-next-inst"/, 'the institution id must be there to copy');
  assert.match(app, /closest[^\n]*data-copy-from/, 'the copy button must be delegated');
});

test('the first-run guide goes for good once a payment exists', { skip }, () => {
  /*
   * The billing count restarts every period. Keyed on that alone, the guide
   * came back on the 1st of each month for a bank that had been sending for a
   * year. Whether a bank has ever sent is a question for the ledger.
   */
  const app = code('app.js');
  const load = /async function loadProducts\([\s\S]*?\n\}/.exec(app);
  assert.ok(load, 'expected loadProducts');
  assert.match(load[0], /api\.settlements\(\{\s*limit:\s*1\s*\}\)/, 'the ledger must be asked, not only the period\'s count');
  assert.match(load[0], /page\.total === 0/, 'and the guide shown only when it holds nothing');
  assert.match(load[0], /\(\) => false/, 'a ledger that cannot be read is no reason to show the guide');
});

test('an empty ledger says how it fills, not where another bank\'s does', { skip }, () => {
  /*
   * It sent a new developer to the demo bank (`:3200/remit.html`), which is
   * another organisation: what is instructed there never appears in this
   * account's ledger, however long they wait.
   */
  const app = code('app.js');
  assert.doesNotMatch(app, /:3200|remit\.html/, 'the console must not send a bank to the demo bank');
  const page = /async function fetchRemitPage\([\s\S]*?\n\}/.exec(app);
  assert.ok(page, 'expected fetchRemitPage');
  assert.match(page[0], /data-link-hash="corridor"/, 'the empty ledger should open the cross-border guide');
  assert.match(page[0], /resolveLinks\(list\)/, 'and resolve that link, which is drawn after the page\'s own pass');
});

test('a link into the hub keeps the reader\'s language and lands where it says', { skip }, () => {
  // A Korean console opened the hub in the browser's language, and "API 문서"
  // opened the overview rather than the reference.
  const app = code('app.js');
  const resolve = /function resolveLinks\([\s\S]*?\n\}/.exec(app);
  assert.ok(resolve, 'expected resolveLinks');
  assert.match(resolve[0], /searchParams\.set\('lang', lang\)/, 'the hub must open in the console\'s language');
  assert.match(app, /data-link="attest-docs" data-link-hash="api"/, 'the reference button must open the reference');
});

test('the activation form fits its card', { skip }, () => {
  // A select is as wide as its longest option; the "mint a key" option made
  // the form, and the page, scroll sideways — 245px in English at 1440.
  const css = read('console.css');
  assert.match(css, /\.grid \.prodform \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.prodform input, \.prodform select \{[^}]*width: 100%; min-width: 0/);
  assert.match(css, /\.grid > \.card \{[^}]*min-width: 0/);
});

