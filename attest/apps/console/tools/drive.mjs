/**
 * Drives the live sandbox console in headless Chrome. Set OUT to a directory for screenshots and the report.
 *
 *   MODE=bank   node drive.mjs   dashboard, menu, and a settlement followed live in the tracker (NO_CASE=1
 *                                for the layout alone, with nothing created: the dashboard, a settlement
 *                                already in the ledger, the reserve screen before a file is chosen, the
 *                                verify screen and the record list)
 *   MODE=file   node drive.mjs   the reserve screen: one file, one click, and what was sent; then the
 *                                snapshots it made, as rows of the record list
 *   MODE=shapes node drive.mjs   the four file shapes, files that must be refused, and how large a file
 *                                the screen takes on (QUICK=1 for two refused files and one shape); then
 *                                `node check-downloads.mjs <OUT>/report-shapes-ko.json` checks the proof
 *                                files it downloaded with the SDK alone
 *   MODE=keep   node drive.mjs   the two files: anchor, download the proof file, come back on a new page and
 *                                give the verify screen the proof file and the balance file; then every way
 *                                the pair can be wrong, the other shapes, a proof file left behind, and the
 *                                snapshot in the record list with its bundle. `node check-downloads.mjs
 *                                <OUT>/report-keep-ko.json` checks what was downloaded with the SDK alone
 *
 * Each run of file/shapes/keep signs up a throwaway organisation on the deployment it drives. The
 * deployment caps sign-ups and sign-ins per address, and every run from one machine draws on that one
 * allowance: a run refused for it says how long to wait.
 *
 * Nothing is injected into the page (it ships under a strict CSP); the script
 * only clicks, selects files and reads the DOM. The browser's profile lives
 * under /dev/shm and both are removed in `finally`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';

const CHROME = '/home/ubuntu/.cache/puppeteer/chrome/linux-152.0.7977.54/chrome-linux64/chrome';
const BASE = process.env.BASE ?? 'http://3.36.101.90:8787';
const OUT = process.env.OUT;
const MODE = process.env.MODE ?? 'bank';
const LANG = process.env.LANG_UI ?? 'ko';
const W = Number(process.env.W ?? 1440);
const H = 1000;
if (!OUT) throw new Error('set OUT');
mkdirSync(OUT, { recursive: true });
const DL = path.join(OUT, `downloads-${MODE}`);
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const PROFILE = `/dev/shm/cc-chrome-${process.pid}`;
const PORT = 9300 + (process.pid % 600);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
  '--force-device-scale-factor=1', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

const report = { mode: MODE, base: BASE, lang: LANG, steps: [], errors: [], dialogs: [] };
/** What a walk answers when a page asks before it is left: go on (true), or stay. */
let leaveWhenAsked = true;
const note = (k, v) => { report.steps.push({ [k]: v }); console.log(`· ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((x) => x.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('no devtools target');
}

let ws;
let seq = 0;
const pend = new Map();
const cmd = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pend.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const js = async (expression) => {
  const { result, exceptionDetails } = await cmd('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};
/** Run a real function in the page; its arguments travel as JSON. */
const run = (fn, ...args) => js(`(${fn.toString()})(...${JSON.stringify(args)})`);
const waitFor = async (fn, args = [], ms = 20_000, every = 200) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await run(fn, ...args);
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${fn.toString().slice(0, 120)}`);
    await sleep(every);
  }
};
const shot = async (name, selector = null) => {
  // Sticky masthead and sidebar repeat in a beyond-viewport capture, so the
  // viewport is grown to the page instead and captured as it is.
  const height = Math.min(await js('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)'), 6000);
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: Math.max(height, H), deviceScaleFactor: 1, mobile: false });
  // A page that scrolled itself — a panel opened beneath a list — would otherwise be captured from where it stopped.
  if (!selector) await js('scrollTo(0, 0)');
  await sleep(250);
  let clip;
  if (selector) {
    const r = await run((sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      e.scrollIntoView({ block: 'nearest' });
      const b = e.getBoundingClientRect();
      return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y + scrollY - 8), width: b.width + 16, height: b.height + 16 };
    }, selector);
    if (!r) throw new Error(`no element for ${selector}`);
    clip = { ...r, scale: 1 };
  }
  const png = await cmd('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(png.data, 'base64'));
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  return file;
};
const click = (selector) => run((sel) => {
  const e = document.querySelector(sel);
  if (!e) return false;
  e.click();
  return true;
}, selector);
const setFile = async (selector, file) => {
  const { root } = await cmd('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no input for ${selector}`);
  await cmd('DOM.setFileInputFiles', { files: [file], nodeId });
};
const go = async (hash) => {
  // A change of hash alone is not a load, and the app decides gate or
  // dashboard at load — so every visit here starts from a blank page.
  await cmd('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cmd('Page.navigate', { url: `${BASE}/console/?lang=${LANG}#/${hash}` });
  await sleep(700);
};

async function api(method, pathname, body, cookie) {
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, setCookie: r.headers.getSetCookie?.() ?? [] };
}
const cookiePair = (setCookie) => (setCookie[0] ?? '').split(';')[0];
async function installSession(pair) {
  const at = pair.indexOf('=');
  const ok = await cmd('Network.setCookie', { name: pair.slice(0, at), value: pair.slice(at + 1), url: BASE, httpOnly: true });
  if (!ok.success) throw new Error('the session cookie was not accepted by the browser');
}

// ── the two walks ───────────────────────────────────────────────────────────

async function bank() {
  const bankState = JSON.parse(readFileSync('/home/ubuntu/bitcert-attest/demo-bank/state.json', 'utf8'));
  const login = await api('POST', '/v1/console/login', { email: bankState.email, password: bankState.password });
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text.slice(0, 200)}`);
  await installSession(cookiePair(login.setCookie));

  await go('home');
  await waitFor(() => Boolean(document.querySelector('#homeCards .bill')));
  await sleep(500);
  note('menu', await run(() => [...document.querySelectorAll('#sections > *')].map((e) =>
    (e.classList.contains('navsep') ? '────' : e.textContent.trim()))));
  note('dashboard', await run(() => {
    const css = (e, p) => getComputedStyle(e)[p];
    const bill = document.querySelector('#homeCards .bill');
    const row = document.querySelector('#homeCards .prow');
    const zone = document.querySelector('#homeCards .zonehead');
    return {
      order: [...document.querySelectorAll('#homeCards > *')].map((e) => e.className || e.tagName),
      billBackground: css(bill, 'backgroundColor'), rowBackground: row ? css(row, 'backgroundColor') : null,
      zone: zone?.textContent.trim().replace(/\s+/g, ' ') ?? null,
      billStats: [...bill.querySelectorAll('.stat')].map((s) => s.textContent.trim().replace(/\s+/g, ' ')),
      links: [...document.querySelectorAll('#homeCards a[href^="#/"]')].map((a) => `${a.textContent.trim().replace(/\s+/g, ' ')} [${a.getAttribute('href')}]`),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }));
  note('shot', await shot(`dashboard-${LANG}-${W}`));
  note('shot', await shot(`sidebar-${LANG}`, '.side'));

  if (process.env.NO_CASE) {
    // Layout only: nothing is created. An existing payment; the reserve screen
    // before a file is chosen (its one button anchors, so it is not pressed);
    // and the two screens that belong to no product, as this bank sees them.
    const overflow = () => run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note('overflow home', await overflow());
    await go('remit');
    await waitFor(() => Boolean(document.querySelector('button[data-remit-toggle]')), [], 30_000);
    const id = await run(() => document.querySelector('button[data-remit-toggle]').dataset.remitToggle);
    await click(`button[data-remit-toggle="${id}"]`);
    await waitFor(() => Boolean(document.querySelector('.journey')), [], 20_000);
    await sleep(1300);
    note('tracker', await run(() => { const j = document.querySelector('.journey'); const r = j.getBoundingClientRect();
      return { headline: j.querySelector('.jstate b').textContent, meta: j.querySelector('.jmeta').textContent,
        steps: [...j.querySelectorAll('.jstep')].map((x) => x.querySelector('b').textContent + ' / ' + x.querySelector('small').textContent),
        stops: [...j.querySelectorAll('.jstop')].map((x) => x.textContent.trim().replace(/\s+/g, ' ')),
        width: Math.round(r.width), viewport: innerWidth,
        clipped: [...j.querySelectorAll('.jstop b, .jstep b')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent) }; }));
    note('overflow remit', await overflow());
    note('shot', await shot(`tracker-${LANG}-${W}`, '.journey'));
    await go('por');
    await waitFor(() => Boolean(document.querySelector('#por-sample')), [], 20_000);
    // The example file, downloaded from a page where nothing else has been done yet.
    await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    await click('button[data-por-sample="wide"]');
    await sleep(700);
    const sdk = '/home/ubuntu/bitcert-attest/attest/packages/attest-por/samples';
    note('example download', existsSync(path.join(DL, 'balances.wide.csv'))
      ? (readFileSync(path.join(DL, 'balances.wide.csv')).equals(readFileSync(path.join(sdk, 'balances.wide.csv'))) ? 'downloaded, byte-identical to the SDK sample' : 'DIFFERS from the SDK sample') : 'NOT DOWNLOADED');
    note('example line', await run(() => document.querySelector('.porsamples').innerText.replace(/\s+/g, ' ')));
    note('shot', await shot(`por-${LANG}-${W}-samples`, '.porsamples'));
    note('por texts', await run(() => ({ head: document.querySelector('.pagehead p')?.textContent,
      h2: [...document.querySelectorAll('#por-root h2')].map((h) => h.textContent.trim()),
      buttons: [...document.querySelectorAll('#por-root .btn')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`),
      hints: [...document.querySelectorAll('#por-root p')].map((b) => b.textContent.trim().replace(/\s+/g, ' ').slice(0, 110)) })));
    note('overflow por', await overflow());
    note('shot', await shot(`por-${LANG}-${W}`));

    // 검증: what this bank is told it can check there.
    await go('verify');
    await waitFor(() => Boolean(document.querySelector('#v-run')), [], 20_000);
    note('verify texts', await run(() => ({ head: document.querySelector('.pagehead p')?.textContent,
      slots: [...document.querySelectorAll('#verify .drop')].map((d) => d.innerText.replace(/\s*\n\s*/g, ' | ').replace(/\s+/g, ' ').trim()),
      buttons: [...document.querySelectorAll('#verify .btn')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`) })));
    note('overflow verify', await overflow());
    note('shot', await shot(`verify-${LANG}-${W}`));

    // 앵커링 기록: what each row is a record of, and a reserve record opened as its snapshot — a read, like the tracker's.
    await go('records');
    await waitFor(() => Boolean(document.querySelector('#att-list table')), [], 20_000);
    await sleep(800);
    note('record references', await run(() => {
      const refs = [...document.querySelectorAll('#att-list .rref')];
      const said = (e) => e?.textContent.trim().replace(/\s+/g, ' ') ?? null;
      const snapshots = refs.filter((e) => e.matches('[data-snapshot]'));
      const settlements = refs.filter((e) => e.matches('a[href^="#/remit?q="]'));
      const others = refs.filter((e) => !snapshots.includes(e) && !settlements.includes(e));
      return { rows: document.querySelectorAll('#att-list tbody tr').length,
        snapshots: snapshots.length, settlements: settlements.length, others: others.length,
        first: { snapshot: said(snapshots[0]), settlement: settlements[0] ? `${said(settlements[0])} [${settlements[0].getAttribute('href')}]` : null, other: said(others[0]) } };
    }));
    note('overflow records', await overflow());
    note('shot', await shot(`records-${LANG}-${W}`));
    await go('records?product=por');
    await waitFor(() => Boolean(document.querySelector('#att-list table, #att-list p.dim')), [], 20_000);
    if (await click('#att-list [data-snapshot]')) {
      await waitFor(() => Boolean(document.querySelector('#snapview')), [], 15_000);
      note('snapshot panel', await run(() => ({ heading: document.querySelector('#snapview h2')?.textContent.trim() ?? null,
        fields: [...document.querySelectorAll('#snapview dt')].map((dt) => `${dt.textContent.trim()}: ${[...dt.nextElementSibling?.childNodes ?? []].filter((n) => n.nodeName !== 'BUTTON').map((n) => n.textContent).join('').trim().replace(/\s+/g, ' ')}`),
        buttons: [...document.querySelectorAll('#snapview button')].map((b) => b.textContent.trim()),
        link: document.querySelector('#snapview a.btn')?.getAttribute('href') ?? null })));
      note('overflow records, a snapshot open', await overflow());
      note('shot', await shot(`records-${LANG}-${W}-snapshot`));
    } else note('snapshot panel', 'no reserve record in the list to open');
    return;
  }

  // A payment to follow: one case through the demo bank, as a visitor would.
  const BANK = 'http://127.0.0.1:3200';
  const bankPost = async (p, body) => {
    const r = await fetch(`${BANK}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const text = await r.text();
    if (r.status >= 300) throw new Error(`${p}: ${r.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  const cfg = await (await fetch(`${BANK}/api/remit/config`)).json();
  note('bank scenarios', cfg.scenarios.map((x) => x.key));
  const scenario = process.env.SCENARIO ?? 'normal';
  const made = await bankPost('/api/remit/cases', { invoice: { ref: `INV-UI-${Date.now()}`, amount_usd: '1250.00' }, scenario, travel_rule_mode: 'A' });
  await bankPost(`/api/remit/cases/${made.id}/quote`);
  await bankPost(`/api/remit/cases/${made.id}/review`, { checks: { kyb: true, trade: true, fx: true } });
  // Not awaited: the tracker is to be opened while the payment is moving.
  const approving = bankPost(`/api/remit/cases/${made.id}/approve`).catch((e) => ({ error: String(e) }));
  let paymentId = null;
  for (let i = 0; i < 80 && !paymentId; i++) {
    await sleep(250);
    const d = await (await fetch(`${BANK}/api/remit/cases/${made.id}`)).json();
    paymentId = d.payment_id ?? d.case?.payment_id ?? null;
  }
  if (!paymentId) throw new Error('the demo bank never reported a payment id');
  note('payment', paymentId);

  await go(`remit?q=${encodeURIComponent(paymentId)}`);
  await waitFor((id) => Boolean(document.querySelector(`button[data-remit-toggle="${id}"]`)), [paymentId], 30_000);
  await click(`button[data-remit-toggle="${paymentId}"]`);
  await waitFor(() => Boolean(document.querySelector('.journey')), [], 20_000);

  const read = () => run((id) => {
    const j = document.querySelector(`tr[data-rx="${id}"] .journey`);
    if (!j) return null;
    const main = document.querySelector(`tr[data-rx="${id}"]`).previousElementSibling;
    return {
      tone: j.className.replace('journey', '').trim(),
      headline: j.querySelector('.jstate b')?.textContent ?? '',
      meta: j.querySelector('.jmeta')?.textContent ?? '',
      live: Boolean(j.querySelector('.jlive')),
      steps: [...j.querySelectorAll('.jstep')].map((s) => `${s.className.replace('jstep', '').trim()}:${s.querySelector('small').textContent}`),
      stops: [...j.querySelectorAll('.jstop')].map((s) => `${s.classList.contains('lit') ? 'LIT' : 'dim'} ${s.querySelector('b').textContent}`),
      ledgerChip: main?.querySelector('.chip')?.textContent ?? '',
      legs: [...document.querySelectorAll(`tr[data-rx="${id}"] .legs .leg`)].map((l) => l.className.replace('leg', '').trim()),
    };
  }, paymentId);

  const seen = [];
  let answered = false;
  let last = '';
  let shots = 0;
  const started = Date.now();
  const limit = Number(process.env.FOLLOW_SEC ?? 150) * 1000;
  for (;;) {
    const now = await read();
    const key = JSON.stringify(now);
    if (now && key !== last) {
      last = key;
      seen.push({ t: Math.round((Date.now() - started) / 100) / 10, ...now });
      console.log(`  t+${seen.at(-1).t}s  ${now.tone}  ${now.headline}  [${now.steps.join(' | ')}]  ledger=${now.ledgerChip}  live=${now.live}`);
      if (shots < 8) { await sleep(900); await shot(`tracker-${scenario}-${LANG}-${String(++shots).padStart(2, '0')}`, `tr[data-rx="${paymentId}"]`); }
    }
    // The demo's information request: once the tracker shows it parked, the
    // bank answers — and the tracker has to move on by itself.
    if (now && now.tone.startsWith('hold') && scenario === 'rfi' && !answered) {
      answered = true;
      await sleep(4000);
      const requestsWhileHeld = requests.filter((u) => u.includes(`/v1/settlements/${paymentId}`)).length;
      console.log(`  (held for 4 s, still live=${(await read()).live}, ${requestsWhileHeld} asks so far) → the bank answers the request`);
      await bankPost(`/api/remit/cases/${made.id}/rfi`, { answers: { q0: 'Invoice and contract attached', q1: 'Trade payment for goods' } });
    }
    if (now && !now.live) break;
    if (Date.now() - started > limit) { note('follow', 'stopped watching at the time limit; the payment was still moving'); break; }
    await sleep(700);
  }
  report.tracker = seen;
  await sleep(900);
  note('shot', await shot(`tracker-${scenario}-${LANG}-final`, `tr[data-rx="${paymentId}"]`));
  if (process.env.ONLY_FOLLOW) return;
  note('approve result', await Promise.race([approving.then((x) => (x?.error ? x : { status: x?.status ?? 'ok' })), sleep(3000).then(() => 'still running')]));

  // Close: the follow must end with the row. Count requests for 6 s afterwards.
  await click(`button[data-remit-toggle="${paymentId}"]`);
  const before = requests.length;
  await sleep(6000);
  const after = requests.slice(before).filter((u) => u.includes(`/v1/settlements/${paymentId}`));
  note('requests in 6 s after closing the row', after.length);

  // Other endings already in the ledger: one stopped, one held if there is one.
  for (const state of ['EXCEPTION', 'CANCELLED']) {
    await go(`remit?state=${state}`);
    await sleep(1500);
    const id = await run(() => document.querySelector('button[data-remit-toggle]')?.dataset.remitToggle ?? null);
    if (!id) { note(`ledger state ${state}`, 'no rows'); continue; }
    await click(`button[data-remit-toggle="${id}"]`);
    try {
      await waitFor(() => Boolean(document.querySelector('.journey')), [], 15_000);
    } catch { note(`ledger state ${state}`, 'tracker did not paint'); continue; }
    await sleep(1300);
    const j = await run(() => {
      const el = document.querySelector('.journey');
      return { tone: el.className, headline: el.querySelector('.jstate b').textContent, note: el.querySelector('.jnote')?.textContent ?? '',
        steps: [...el.querySelectorAll('.jstep')].map((s) => s.className.replace('jstep', '').trim()), live: Boolean(el.querySelector('.jlive')) };
    });
    note(`ledger state ${state}`, j);
    await shot(`tracker-${LANG}-${state.toLowerCase()}`, `tr[data-rx="${id}"]`);
  }
}

async function fileOnly() {
  const sdk = '/home/ubuntu/bitcert-attest/attest/packages/attest-por/samples';
  let pair;
  let primarySpki = null;
  if (process.env.ACCOUNT === 'bank') {
    const bankState = JSON.parse(readFileSync('/home/ubuntu/bitcert-attest/demo-bank/state.json', 'utf8'));
    const login = await api('POST', '/v1/console/login', { email: bankState.email, password: bankState.password });
    if (login.status !== 200) throw new Error(`login: ${login.status} ${login.json?.message ?? ''}`);
    pair = cookiePair(login.setCookie);
  } else {
    const email = `console-check-${Date.now()}@example.com`;
    const signup = await api('POST', '/v1/console/signup', { email, password: `Chk-${Math.random().toString(36).slice(2)}-${Date.now()}` });
    if (signup.status >= 300) throw new Error(`signup: ${signup.status} ${signup.json?.message ?? ''}`);
    pair = cookiePair(signup.setCookie);
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    primarySpki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const reg = await api('POST', '/v1/console/issuer-keys', { public_key: primarySpki, label: 'the exchange server key (P-256)', algorithm: 'ES256' }, pair);
    const act = await api('POST', '/v1/console/products', { product: 'por', institution: { name: 'File Only Exchange', country: 'KY' }, issuer_key_id: reg.json.id }, pair);
    if (act.status >= 300) throw new Error(`activate: ${act.status} ${act.text.slice(0, 200)}`);
    note('throwaway organisation', email);
  }
  const before = (await api('GET', '/v1/console/products', null, pair)).json.institutions.find((i) => i.role === 'EXCHANGE');
  await installSession(pair);
  await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await go('por');
  await waitFor(() => Boolean(document.querySelector('#por-go')));
  note('what the screen asks for', await run(() => ({
    heading: [...document.querySelectorAll('#por-root h2')].map((h) => h.textContent.trim()),
    sub: document.querySelector('.pagehead p')?.textContent,
    inputs: [...document.querySelectorAll('#por-root input, #por-root select, #por-root textarea')].map((i) => `${i.tagName.toLowerCase()}[${i.type}]#${i.id}`),
    buttons: [...document.querySelectorAll('#por-root .btn')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`),
    cards: document.querySelectorAll('#por-root > section').length,
  })));
  note('shot', await shot(`file-${LANG}-${W}-1-empty`));

  const anchorIt = async (label, how) => {
    await how();
    await waitFor(() => Boolean(document.querySelector('#por-anchor')) || Boolean(document.querySelector('.porbox.bad')), [], 90_000);
    const r = await run(() => ({
      bad: document.querySelector('.porbox.bad')?.innerText.replace(/\s+/g, ' ').slice(0, 500) ?? null,
      chips: [...document.querySelectorAll('#por-root .porbox p .chip')].map((c) => c.textContent),
      stats: [...document.querySelectorAll('.porbox .stat')].map((x) => x.textContent.trim().replace(/\s+/g, ' ')),
      root: document.querySelector('#por-rootval')?.textContent ?? null,
      id: document.querySelector('#por-snapid')?.textContent ?? null,
      settled: document.querySelector('#por-settled')?.textContent.trim().replace(/\s+/g, ' ') ?? null,
    }));
    note(label, r);
    return r;
  };

  // 1. A file, one click.
  const first = await anchorIt('wide file, one click', async () => {
    await setFile('#por-file', `${sdk}/balances.wide.csv`);
    await waitFor(() => !document.querySelector('#por-go').disabled, [], 10_000);
    await click('#por-go');
  });
  const t0 = Date.now();
  try {
    await waitFor(() => document.querySelector('#por-anchor .chip')?.textContent === 'confirmed', [], 180_000, 1000);
    note('anchor', `confirmed after ${Math.round((Date.now() - t0) / 1000)} s, without a reload`);
  } catch { note('anchor', `not confirmed in time: ${await run(() => document.querySelector('#por-anchor')?.textContent)}`); }
  await sleep(600);
  note('shot', await shot(`file-${LANG}-${W}-2-anchored`));
  // The one file the result offers.
  await click('#por-proof-dl');
  await waitDownload((f) => f.startsWith('por-proof-'));
  note('downloads', readdirSync(DL).sort());
  report.first = { snapshot_id: first.id, root: first.root, downloads: DL };

  // 2. What was sent, and what happened to the exchange's own key.
  const after = (await api('GET', '/v1/console/products', null, pair)).json.institutions.find((i) => i.role === 'EXCHANGE');
  note('exchange signing key untouched', before.signing_spki === after.signing_spki && (primarySpki === null || after.signing_spki === primarySpki));
  note('requests the page made that carry a body', posts.map((x) => `${x.url} ${x.bytes}B keys=${(() => { try { return Object.keys(JSON.parse(x.body)).join('+'); } catch { return '?'; } })()}`));
  note('account ids in any request body', posts.reduce((n, x) => n + ((x.body ?? '').match(/U-1000\d\d/g) ?? []).length, 0));

  if (process.env.QUICK) { note('page overflow', await run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)); return; }

  // 3. Files that must not be anchored.
  const bad = path.join(OUT, 'bad.csv');
  writeFileSync(bad, 'account_id,asset,balance\nU-1,BTC,0.5\nU-1,BTC,0.7\nU-2,ETH,-3\nU-4,BTC,1e3\n');
  const refused = await anchorIt('file with problems', async () => { await setFile('#por-file', bad); await sleep(300); await click('#por-go'); });
  const noHeader = path.join(OUT, 'noheader.csv');
  writeFileSync(noHeader, 'user,coin,amount\nU-1,BTC,0.5\n');
  await anchorIt('file without account_id', async () => { await setFile('#por-file', noHeader); await sleep(300); await click('#por-go'); });
  note('snapshots after the refused files', (await api('GET', '/v1/por/snapshots', null, pair)).json.data.length);
  if (refused.bad) note('shot', await shot(`file-${LANG}-${W}-3-refused`, '#por-root > section:first-of-type'));

  // 4. Whole numbers are summed as whole numbers — nothing is scaled.
  const units = path.join(OUT, 'units.csv');
  writeFileSync(units, 'account_id,BTC,KRW\nA-1,50000000,1000000\nA-2,150000000,2500000\n');
  await anchorIt('whole-number file', async () => { await setFile('#por-file', units); await sleep(300); await click('#por-go'); });

  // 5. The example, and the one option.
  await anchorIt('example button', async () => { await click('#por-sample'); });
  await anchorIt('example with a spot check', async () => {
    await click('.poropt > summary'); await sleep(150);
    await run(() => { const c = document.querySelector('#por-spot'); if (!c.checked) c.click(); });
    await click('#por-sample');
  });
  await sleep(1500);
  note('page overflow', await run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
  note('shot', await shot(`file-${LANG}-${W}-4-final`));

  // 6. The snapshots are records now. The result's own link leads to them, narrowed to this product — and
  //    leads there within the page, so the proof files not yet downloaded are still offered on the way back.
  const byLink = await click('#por-root .porbox a[href="#/records?product=por"]');
  if (!byLink) await go('records?product=por');
  await waitFor(() => Boolean(document.querySelector('#att-list table, #att-list p.dim')), [], 20_000);
  await sleep(400);
  const stored = (await api('GET', '/v1/por/snapshots', null, pair)).json.data.length;
  const listed = await run(() => ({
    address: location.hash,
    filter: document.querySelector('#att-product')?.value ?? null,
    rows: document.querySelectorAll('#att-list tbody tr').length,
    references: [...document.querySelectorAll('#att-list tbody tr')].map((r) => r.querySelector('.rref')?.textContent.trim().replace(/\s+/g, ' ') ?? '(no reference)'),
  }));
  note('record list rows', { reached: byLink ? 'by the link in the result' : 'by its address — the result offered no link to it', ...listed, snapshotsStored: stored,
    oneRowEach: process.env.ACCOUNT === 'bank' ? 'not compared: the bank has records from before this run' : listed.rows === stored });
  note('record list overflow', await run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
  note('shot', await shot(`file-${LANG}-${W}-5-records`));
  if (!byLink) return;
  await click('#sections a[href="#/por"]');
  await waitFor(() => Boolean(document.querySelector('#por-go')), [], 15_000);
  await sleep(300);
  note('back on the reserve screen by the menu', await run(() => ({
    result: document.querySelector('#por-snapid')?.textContent ?? null,
    proofFileStillOffered: Boolean(document.querySelector('#por-proof-dl')),
    proofFilesOfEarlierSnapshots: [...document.querySelectorAll('#por-left button[data-por-left]')].map((b) => b.dataset.porLeft),
  })));
}

// ── run ─────────────────────────────────────────────────────────────────────

/** The four shapes of one ledger, files that must be refused, and how large a file the screen takes on. */
async function shapes() {
  const sdk = '/home/ubuntu/bitcert-attest/attest/packages/attest-por/samples';
  const email = `console-check-${Date.now()}@example.com`;
  const signup = await api('POST', '/v1/console/signup', { email, password: `Chk-${Math.random().toString(36).slice(2)}-${Date.now()}` });
  if (signup.status >= 300) throw new Error(`signup: ${signup.status} ${signup.json?.message ?? ''}`);
  const pair = cookiePair(signup.setCookie);
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const reg = await api('POST', '/v1/console/issuer-keys', { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), label: 'the exchange server key (P-256)', algorithm: 'ES256' }, pair);
  const act = await api('POST', '/v1/console/products', { product: 'por', institution: { name: 'Four Shapes Exchange', country: 'KY' }, issuer_key_id: reg.json.id }, pair);
  if (act.status >= 300) throw new Error(`activate: ${act.status} ${act.text.slice(0, 200)}`);
  note('throwaway organisation', email);
  await installSession(pair);
  await go('por');
  await waitFor(() => Boolean(document.querySelector('#por-go')));
  note('file input accepts', await run(() => document.querySelector('#por-file').accept));
  note('label', await run(() => document.querySelector('#por-drop .dk').textContent));
  note('example line', await run(() => document.querySelector('.porsamples').innerText.replace(/\s+/g, ' ')));
  note('shot', await shot(`shapes-${LANG}-1-empty`));

  // The example downloads are the SDK's own files, byte for byte.
  await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  // One example is offered, and it is the SDK's own file, byte for byte.
  note('examples offered', await run(() => [...document.querySelectorAll('#por-root button[data-por-sample]')].map((b) => b.textContent.trim())));
  await click('button[data-por-sample="wide"]');
  await sleep(500);
  note('example download', existsSync(path.join(DL, 'balances.wide.csv'))
    ? (readFileSync(path.join(DL, 'balances.wide.csv')).equals(readFileSync(path.join(sdk, 'balances.wide.csv'))) ? 'identical to the SDK sample' : 'DIFFERS') : 'missing');

  const anchorIt = async (label, file, ms = 240_000) => {
    await setFile('#por-file', file);
    await waitFor(() => !document.querySelector('#por-go').disabled, [], 10_000);
    const t0 = Date.now();
    await click('#por-go');
    await sleep(120);
    await waitFor(() => !document.querySelector('#por-go')?.disabled && (Boolean(document.querySelector('#por-anchor')) || Boolean(document.querySelector('.porbox.bad'))), [], ms, 250);
    const r = await run(() => ({
      bad: document.querySelector('.porbox.bad')?.innerText.replace(/\s+/g, ' ').slice(0, 700) ?? null,
      stats: [...document.querySelectorAll('.porbox .stat')].map((x) => x.textContent.trim().replace(/\s+/g, ' ')),
      root: document.querySelector('#por-rootval')?.textContent ?? null,
      id: document.querySelector('#por-snapid')?.textContent ?? null,
      settled: document.querySelector('#por-settled')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 260) ?? null,
    }));
    r.ms = Date.now() - t0;
    note(label, r);
    return r;
  };

  report.shapes = {};
  /** The proof file of the shape just anchored, into a directory of its own: what check-downloads.mjs goes by. */
  const keepProof = async (k, r) => {
    if (!r.id) { note(`shape ${k}: no proof file`, 'the file was not anchored'); return; }
    const dir = path.join(DL, k);
    mkdirSync(dir, { recursive: true });
    await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await click('#por-proof-dl');
    await waitDownload((f) => f.startsWith('por-proof-'), 15_000, dir);
    report.shapes[k] = { snapshot_id: r.id, root: r.root, dir, files: readdirSync(dir).sort() };
  };

  if (process.env.QUICK) {
    const writeQ = (name, text) => { const f = path.join(OUT, name); writeFileSync(f, text); return f; };
    await anchorIt('JSON: a key written twice', writeQ('twice.json', '[{"id":"u1","assets":{"BTC":"1","ETH":"2","BTC":"3"}},{"id":"u2","assets":{"BTC":"1"}}]'));
    note('shot', await shot(`shapes-${LANG}-q1-refused`, '#por-root > section:first-of-type'));
    await anchorIt('JSON: no asset anywhere', writeQ('empty-assets.json', '[{"id":"u1","assets":{}}]'));
    note('shot', await shot(`shapes-${LANG}-q2-no-assets`, '#por-root > section:first-of-type'));
    await keepProof('sheet', await anchorIt('shape sheet', path.join(sdk, 'balances.sheet.csv')));
    note('shot', await shot(`shapes-${LANG}-q3-sheet-anchored`));
    note('page overflow', await run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
    return;
  }
  // 1. One ledger, four shapes.
  for (const [k, f] of [['long', 'balances.long.csv'], ['wide', 'balances.wide.csv'], ['sheet', 'balances.sheet.csv'], ['json', 'accounts.json']]) {
    await keepProof(k, await anchorIt(`shape ${k}`, path.join(sdk, f)));
    if (k === 'json') note('shot', await shot(`shapes-${LANG}-2-json-anchored`));
  }

  // 2. Files that must not be anchored.
  const write = (name, text) => { const f = path.join(OUT, name); writeFileSync(f, text); return f; };
  await anchorIt('JSON: a key written twice', write('twice.json', '[{"id":"u1","assets":{"BTC":"1","ETH":"2","BTC":"3"}},{"id":"u2","assets":{"BTC":"1"}}]'));
  note('shot', await shot(`shapes-${LANG}-3-json-refused`, '#por-root > section:first-of-type'));
  await anchorIt('JSON: an amount as a number', write('number.json', '[{"id":"u1","assets":{"BTC":0.5}}]'));
  await anchorIt('JSON: not an array', write('object.json', '{"u1":{"BTC":"1"}}'));
  await anchorIt('JSON: no asset anywhere', write('empty-assets.json', '[{"id":"u1","assets":{}}]'));
  await anchorIt('sheet: an account with a debt', write('debt.csv', 'id,e_BTC,d_BTC,e_USDT,d_USDT\nu1,1,0,100,0\nu2,2,0.5,,\n'));
  await anchorIt('sheet: lower-case symbols, as such exports are often written', write('lower.csv', 'rn,id,e_btc,d_btc,btc,e_usdt,d_usdt,usdt,total_net_balance_usdt\n1,u1,1,0,1,100,0,100,\n2,u2,2,0,2,,,0,\n'));
  note('snapshots stored', (await api('GET', '/v1/por/snapshots', null, pair)).json.data.length);

  // 3. Many assets listed, few held — and where the screen stops.
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const sparse = (accounts, listed, held) => {
    const out = new Array(accounts);
    for (let i = 0; i < accounts; i++) {
      const assets = {};
      // Everyone holds the first two (a stable-coin and a major), the rest are spread over the list.
      assets.A0 = String(1 + Math.floor(rnd() * 1e6)); assets.A1 = (rnd() * 3).toFixed(8);
      for (let k = 2; k < held; k++) assets[`A${2 + Math.floor(rnd() * (listed - 2))}`] = (rnd() * 1000).toFixed(4);
      out[i] = { id: `U-${i + 1}`, assets };
    }
    // Make sure every listed asset is named at least once, so the file really lists them all.
    for (let a = 0; a < listed; a++) out[a % accounts].assets[`A${a}`] ??= '0.00000001';
    return out;
  };
  const wideOf = (rows, listed) => ['account_id,' + Array.from({ length: listed }, (_, a) => `A${a}`).join(','),
    ...rows.map((r) => [r.id, ...Array.from({ length: listed }, (_, a) => r.assets[`A${a}`] ?? '')].join(','))].join('\n') + '\n';
  const few = sparse(2_000, 400, 4);
  await anchorIt('2,000 accounts × 400 listed (≈4 held), wide CSV', write('many-assets.csv', wideOf(few, 400)));
  await anchorIt('the same ledger as JSON', write('many-assets.json', JSON.stringify(few)));
  await anchorIt('40,000 accounts × 500 listed (≈5 held), JSON', write('sparse-40k.json', JSON.stringify(sparse(40_000, 500, 5))));
  note('shot', await shot(`shapes-${LANG}-4-many-assets`, '#por-root > section:first-of-type'));
  await anchorIt('100,000 accounts × 500 listed (≈5 held), JSON — past the limit', write('sparse-100k.json', JSON.stringify(sparse(100_000, 500, 5))));
  const dense = ['account_id,BTC,ETH,USDT'];
  for (let i = 0; i < 100_000; i++) dense.push(`U-${i + 1},${(rnd() * 2).toFixed(8)},${(rnd() * 30).toFixed(6)},${(rnd() * 50000).toFixed(2)}`);
  await anchorIt('100,000 accounts × 3 assets, all held, wide CSV', write('dense-100k.csv', dense.join('\n') + '\n'));
  note('page overflow', await run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/** The next file to land in the download directory (`dir`, when the downloads were pointed elsewhere) that `match` accepts and that was not there before. */
const landed = new Set();
const waitDownload = async (match, ms = 15_000, dir = DL) => {
  const until = Date.now() + ms;
  for (;;) {
    const f = readdirSync(dir).find((x) => !landed.has(path.join(dir, x)) && !x.endsWith('.crdownload') && match(x));
    if (f) { landed.add(path.join(dir, f)); await sleep(150); return f; }
    if (Date.now() > until) throw new Error(`no download landed (have: ${readdirSync(dir).join(', ') || 'nothing'})`);
    await sleep(200);
  }
};

async function keep() {
  const sdk = '/home/ubuntu/bitcert-attest/attest/packages/attest-por/samples';
  const email = `console-check-${Date.now()}@example.com`;
  const signup = await api('POST', '/v1/console/signup', { email, password: `Chk-${Math.random().toString(36).slice(2)}-${Date.now()}` });
  if (signup.status >= 300) throw new Error(`signup: ${signup.status} ${signup.json?.message ?? ''}`);
  const pair = cookiePair(signup.setCookie);
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const reg = await api('POST', '/v1/console/issuer-keys', { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), label: 'the exchange server key (P-256)', algorithm: 'ES256' }, pair);
  const act = await api('POST', '/v1/console/products', { product: 'por', institution: { name: 'Two Files Exchange', country: 'KY' }, issuer_key_id: reg.json.id }, pair);
  if (act.status >= 300) throw new Error(`activate: ${act.status} ${act.text.slice(0, 200)}`);
  note('throwaway organisation', email);
  await installSession(pair);
  await cmd('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  /**
   * What 검증 shows: the file in each slot, the verdict and its colour, what it says it did not check, the
   * links and the checks behind them (a list the screen keeps folded while everything holds), the root it
   * names, and what else is written under it.
   */
  const said = () => run(() => {
    const text = (e) => e?.innerText.replace(/\s*\n\s*/g, ' | ').replace(/\s+/g, ' ').trim() || null;
    const all = (sel) => [...document.querySelectorAll(sel)].map(text);
    const v = document.querySelector('#v-verdict');
    const more = document.querySelector('#v-result details');
    const out = {
      slots: [text(document.querySelector('#v-bundle-name')), text(document.querySelector('#v-orig-name'))],
      tone: ['ok', 'bad', 'wait'].find((c) => v?.classList.contains(c)) ?? null,
      verdict: text(v),
      notChecked: text(document.querySelector('#v-unchecked')),
      links: all('#v-result .links .lk'),
      // Read from the nodes, not from what is drawn: folded, the list has no drawn text.
      checks: [...document.querySelectorAll('#v-result .vchecks li')].map((li) => [...li.children].flatMap((c) => (c.children.length > 0 ? [...c.childNodes] : [c]))
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')),
      checksShown: more ? (more.open ? 'open' : 'folded') : null,
      root: document.querySelector('#v-root')?.textContent ?? null,
      under: [...all('#v-result .dmeta'), ...all('#v-result p.hint')],
    };
    for (const k of Object.keys(out)) if (out[k] === null || out[k].length === 0) delete out[k];
    return out;
  });
  /** Press the one button and read the answer. Nothing is checked until it is pressed. */
  const check = async () => {
    await waitFor(() => !document.querySelector('#v-run').disabled, [], 5_000);
    await click('#v-run');
    await waitFor(() => { const r = document.querySelector('#v-result'); return r.children.length > 0 && !document.querySelector('#v-busy'); }, [], 60_000);
    return said();
  };
  /** 검증 on a new page — nothing in memory — with a file in each slot that is given one. */
  const verifyPage = async (first = null, second = null) => {
    await go('verify');
    await waitFor(() => Boolean(document.querySelector('#v-run')));
    if (first) await setFile('#v-bundle', first);
    if (second) await setFile('#v-orig', second);
  };
  const porPage = async () => { await go('por'); await waitFor(() => Boolean(document.querySelector('#por-go'))); };
  /** The proof file behind a button, once it has landed: its path. */
  const takeProof = async (button = '#por-proof-dl') => {
    await click(button);
    return path.join(DL, await waitDownload((f) => f.startsWith('por-proof-')));
  };
  const anchorFile = async (file) => {
    await setFile('#por-file', file);
    await waitFor(() => !document.querySelector('#por-go').disabled, [], 10_000);
    await click('#por-go');
    await waitFor(() => Boolean(document.querySelector('#por-anchor')) || Boolean(document.querySelector('.porbox.bad')), [], 90_000);
    return run(() => ({
      bad: document.querySelector('.porbox.bad')?.innerText.replace(/\s+/g, ' ').slice(0, 400) ?? null,
      root: document.querySelector('#por-rootval')?.textContent ?? null,
      id: document.querySelector('#por-snapid')?.textContent ?? null,
    }));
  };
  const write = (name, text) => { const f = path.join(OUT, name); writeFileSync(f, text); return f; };
  const overflow = () => run(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await porPage();
  note('the screen before anything', await run(() => ({
    headings: [...document.querySelectorAll('#por-root h2')].map((h) => h.textContent.trim()),
    inputs: [...document.querySelectorAll('#por-root input')].map((i) => `${i.type}#${i.id}${i.disabled ? ' (disabled)' : ''}`),
    buttons: [...document.querySelectorAll('#por-root .btn')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`),
    cards: document.querySelectorAll('#por-root > section').length,
  })));
  note('shot', await shot(`keep-${LANG}-${W}-1-empty`));

  // 1. Anchor a file. One file comes back, and the result says where the two files go from here.
  const wide = `${sdk}/balances.wide.csv`;
  const first = await anchorFile(wide);
  note('anchored', first);
  note('what the result offers', await run(() => ({
    keep: document.querySelector('.porkeep')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
    downloadButtons: [...document.querySelectorAll('#por-root .porbox button')].map((b) => b.textContent.trim()),
    links: [...document.querySelectorAll('#por-root .porbox a')].map((a) => `${a.textContent.trim()} [${a.getAttribute('href')}]`),
  })));
  const proofPath = await takeProof();
  const proofFile = JSON.parse(readFileSync(proofPath, 'utf8'));
  note('the proof file', { name: path.basename(proofPath), bytes: statSync(proofPath).size, fields: Object.keys(proofFile), schema: proofFile.schema,
    snapshot_id_matches: proofFile.snapshot_id === first.id, root_matches: proofFile.statement.tree.root === first.root, source: proofFile.source,
    holds_an_account_id: /U-1000\d\d/.test(readFileSync(proofPath, 'utf8')) });
  try {
    await waitFor(() => document.querySelector('#por-anchor .chip')?.textContent === 'confirmed', [], 120_000, 1000);
    note('anchor', 'confirmed');
  } catch { note('anchor', `not confirmed in time: ${await run(() => document.querySelector('#por-anchor')?.textContent)}`); }
  await sleep(400);
  note('overflow, reserve screen', await overflow());
  note('shot', await shot(`keep-${LANG}-${W}-2-anchored`));

  // 2. A new visit: nothing in memory. The two files are all there is, and 검증 is where they go.
  await verifyPage();
  await sleep(800);
  note('the verify screen before anything', await run(() => ({
    head: document.querySelector('.pagehead p')?.textContent ?? null,
    slots: [...document.querySelectorAll('#verify .drop')].map((d) => d.innerText.replace(/\s*\n\s*/g, ' | ').replace(/\s+/g, ' ').trim()),
    inputs: [...document.querySelectorAll('#verify input')].map((i) => `${i.type}#${i.id}${i.accept ? ` accept=${i.accept}` : ''}`),
    buttons: [...document.querySelectorAll('#verify .btn')].map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`),
  })));
  const requestsBefore = requests.length;
  const postsBefore = posts.length;
  await setFile('#v-bundle', proofPath);
  note('with the proof file alone', await check());
  await setFile('#v-orig', wide);
  note('choosing another file takes the last answer off the screen', await run(() => document.querySelector('#v-result').children.length === 0));
  const restored = await check();
  note('with both files', restored);
  note('the rebuilt root is the anchored one', restored.tone === 'ok' && restored.root === first.root);
  note('overflow, verify screen', await overflow());
  note('shot', await shot(`keep-${LANG}-${W}-3-verified`));
  const whileChecking = requests.slice(requestsBefore).map((u) => u.replace(BASE, ''));
  note('what the page asked the server while checking', whileChecking.filter((u) => !u.includes('/console/')));
  note('requests with a body while checking', posts.length - postsBefore);
  // The checking half of the console is fetched when a check is first run: the page's own scripts, and no file of the visitor's.
  note('its own scripts the page fetched to run the check', whileChecking.filter((u) => u.includes('/console/')).map((u) => u.replace(/^GET \/console\//, '')));
  report.keep = { snapshot_id: first.id, root: first.root, proofFile: proofPath, ledger: wide, ledgerFlag: '--csv' };

  // 3. Not the original. The proof file stays in its slot; the other is given one wrong file after another.
  const text = readFileSync(wide, 'utf8');
  const withOriginal = async (file) => { await setFile('#v-orig', file); return check(); };
  note('one figure changed', await withOriginal(write('one-figure.csv', text.replace('U-100001,0.50000000', 'U-100001,0.60000000'))));
  note('shot', await shot(`keep-${LANG}-${W}-4-mismatch`, '#verify'));
  note('one account removed', await withOriginal(write('one-row-less.csv', text.split('\n').filter((l) => !l.startsWith('U-100002,')).join('\n'))));
  note('one account renamed (totals unchanged)', await withOriginal(write('renamed.csv', text.replace('U-100001,', 'U-200001,'))));
  note('a file that does not read at all', await withOriginal(write('broken.csv', 'account_id,BTC,ETH,USDT\nU-1,-1,,\n')));
  note('the same ledger in another layout (not the file that was anchored)', await withOriginal(`${sdk}/balances.long.csv`));
  note('the original again', await withOriginal(wide));

  // 4. The two slots the other way round.
  await verifyPage(wide, proofPath);
  note('slots swapped', await check());

  // 5. The wrong thing where the proof file goes. The console no longer issues an account's proof; the SDK
  //    does, from the two files this walk now holds — which is how an exchange comes by one.
  const { openSnapshot } = await import('../../../packages/attest-por/src/index.ts');
  const account = write('account-proof-U-100008.json', `${JSON.stringify((await openSnapshot(proofPath, wide)).proofFor('U-100008'), null, 2)}\n`);
  await verifyPage(null, wide);
  const asProof = async (file) => { await setFile('#v-bundle', file); return check(); };
  note('an account proof in the proof file slot', await asProof(account));
  note('a balance file in the proof file slot', await asProof(`${sdk}/accounts.json`));
  note('a proof file with its seed cut short', await asProof(write('damaged.json', JSON.stringify({ ...proofFile, seed: proofFile.seed.slice(0, 20) }))));
  note('a proof file with another seed, and the right balance file', await asProof(write('other-seed.json', JSON.stringify({ ...proofFile, seed: 'ab'.repeat(32) }))));
  note('shot', await shot(`keep-${LANG}-${W}-5-proof-file-altered`, '#verify'));
  // The id is in neither the statement nor the tree, and this screen asks no server: it is shown as the file's own word.
  note('a proof file naming another snapshot id, and the right balance file', await asProof(write('other-id.json', JSON.stringify({ ...proofFile, snapshot_id: '00000000-0000-4000-8000-000000000000' }))));
  note('the real proof file again', await asProof(proofPath));

  // 6. The other shapes, and the example: each proof file goes with its own balance file.
  report.keepShapes = {};
  for (const [k, f] of [['json', 'accounts.json'], ['sheet', 'balances.sheet.csv'], ['long', 'balances.long.csv']]) {
    await porPage();
    const a = await anchorFile(path.join(sdk, f));
    if (!a.id) { note(`shape ${k}: NOT ANCHORED`, a.bad); continue; }
    const kept = await takeProof();
    await verifyPage(kept, path.join(sdk, f));
    const r = await check();
    note(`shape ${k}: anchored, then rebuilt from its two files`, { anchored: a.root, verdict: r.verdict?.slice(0, 80), same: r.tone === 'ok' && r.root === a.root });
    report.keepShapes[k] = { snapshot_id: a.id, root: a.root, proofFile: kept, ledger: path.join(sdk, f), ledgerFlag: k === 'json' ? '--accounts-json' : '--csv' };
  }
  await porPage();
  await click('#por-sample');
  await waitFor(() => Boolean(document.querySelector('#por-anchor')) || Boolean(document.querySelector('.porbox.bad')), [], 90_000);
  const example = await run(() => ({ root: document.querySelector('#por-rootval')?.textContent ?? null, id: document.querySelector('#por-snapid')?.textContent ?? null }));
  const exampleProof = await takeProof();
  await click('button[data-por-sample="wide"]');
  const exampleFile = await waitDownload((x) => x === 'balances.wide.csv');
  await verifyPage(exampleProof, path.join(DL, exampleFile));
  const ex = await check();
  note('the example: its proof file and the example download', { anchored: example.root, verdict: ex.verdict?.slice(0, 80), same: ex.tone === 'ok' && ex.root === example.root });

  // 7. The result leaves the page when another file is chosen; the proof file must still be within reach.
  await porPage();
  const again = await anchorFile(wide);
  await setFile('#por-file', `${sdk}/balances.long.csv`);
  await sleep(400);
  note('after choosing another file without anchoring it', await run(() => ({
    resultStillShown: Boolean(document.querySelector('#por-anchor')),
    left: document.querySelector('#por-left')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
  })));
  note('shot', await shot(`keep-${LANG}-${W}-6-result-gone`, '#por-root > section'));
  const late = await takeProof('#por-proof-dl2');
  note('the proof file offered there is that snapshot\'s', JSON.parse(readFileSync(late, 'utf8')).snapshot_id === again.id);
  await sleep(300);
  note('the line goes once the file has been taken', await run(() => !document.querySelector('#por-left')));
  // Leaving the document — a reload, a closed tab — loses a proof file not yet taken for good, so the page asks
  // first. A browser lets a page ask only once it has been touched: a real click on the heading, then away.
  const unsaved = await anchorFile(wide);
  const heading = await run(() => {
    const h = document.querySelector('.pagehead h1');
    h.scrollIntoView({ block: 'center' });
    const b = h.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...heading, button: 'left', clickCount: 1 });
  const asked = () => report.dialogs.map((d) => `${d.type}, answered "${d.answered}"`);
  leaveWhenAsked = false;
  // A navigation that is refused may never be answered for; it is not waited on for long.
  await Promise.race([cmd('Page.navigate', { url: 'about:blank' }).catch(() => null), sleep(5_000)]);
  leaveWhenAsked = true;
  await sleep(400);
  note('leaving with a proof file not yet taken, and staying when asked', { asked: asked(),
    stillOffered: await run((id) => document.querySelector('#por-snapid')?.textContent === id && Boolean(document.querySelector('#por-proof-dl')), unsaved.id) });

  // 8. A snapshot is a record like any other: 앵커링 기록 lists it under its id, and hands out its bundle.
  const records = async () => {
    await go('records?product=por');
    await waitFor(() => Boolean(document.querySelector('#att-list table, #att-list p.dim')), [], 20_000);
  };
  /** The row of the snapshot anchored first, known by the reference under its hash. */
  const row = `#att-list tbody tr:has([data-snapshot="${first.id}"])`;
  await records();
  note('and leaving when asked again, on the way to the record list', { asked: asked(), arrived: await run(() => location.hash) });
  const stored = (await api('GET', '/v1/por/snapshots', null, pair)).json.data.length;
  const listed = await run((mine) => {
    const rows = [...document.querySelectorAll('#att-list tbody tr')];
    return {
      rows: rows.length,
      references: rows.map((r) => r.querySelector('.rref')?.textContent.trim().replace(/\s+/g, ' ') ?? '(no reference)'),
      row: [...document.querySelector(mine)?.cells ?? []].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
    };
  }, row);
  note('the record list, narrowed to this product', { ...listed, snapshotsStored: stored, oneRowEach: listed.rows === stored });
  await click(`${row} [data-snapshot]`);
  await waitFor(() => Boolean(document.querySelector('#snapview')), [], 15_000);
  const panel = await run(() => ({
    id: document.querySelector('#snap-id')?.textContent ?? null,
    heading: document.querySelector('#snapview h2')?.textContent.trim() ?? null,
    fields: [...document.querySelectorAll('#snapview dt')].map((dt) => `${dt.textContent.trim()}: ${[...dt.nextElementSibling?.childNodes ?? []].filter((n) => n.nodeName !== 'BUTTON').map((n) => n.textContent).join('').trim().replace(/\s+/g, ' ')}`),
    buttons: [...document.querySelectorAll('#snapview button')].map((b) => b.textContent.trim()),
    link: document.querySelector('#snapview a.btn')?.getAttribute('href') ?? null,
  }));
  note('the snapshot panel', panel);
  note('the panel shows the anchored snapshot\'s id', panel.id === first.id);
  note('overflow, record list', await overflow());
  note('shot', await shot(`keep-${LANG}-${W}-7-record`));

  // The row offers its bundle once the record has been batched; the list is asked again until it does.
  const offered = () => run((link) => Boolean(document.querySelector(link)), `${row} .bundlecell a`);
  const until = Date.now() + 180_000;
  while (!await offered() && Date.now() < until) { await sleep(5_000); await records(); }
  if (!await offered()) {
    note('bundle', 'the row offered no bundle within 180 s — nothing was checked against it');
    return;
  }
  await click(`${row} .bundlecell a`);
  const bundle = path.join(DL, await waitDownload((f) => f.startsWith('proof-')));
  report.keep.bundle = bundle;
  await verifyPage(bundle, proofPath);
  const held = await check();
  note('the bundle with the proof file', held);
  note('the bundle holds, and what it anchors is the proof file\'s statement', held.tone === 'ok' && held.root === first.root);
  note('shot', await shot(`keep-${LANG}-${W}-8-bundle`));
  // The same bundle beside what is not its original, and by itself.
  await verifyPage(bundle, wide);
  note('the bundle with the balance file', await check());
  if (report.keepShapes.long) {
    await verifyPage(bundle, report.keepShapes.long.proofFile);
    note('the bundle with another snapshot\'s proof file', await check());
  }
  await verifyPage(bundle);
  note('the bundle alone', await check());
}

const requests = [];
const posts = [];
let failed = false;
try {
  ws = new WebSocket(await target());
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pend.has(x.id)) {
      const { resolve, reject } = pend.get(x.id);
      pend.delete(x.id);
      if (x.error) reject(new Error(`${JSON.stringify(x.error)}`)); else resolve(x.result);
      return;
    }
    if (x.method === 'Network.requestWillBeSent') {
      const r = x.params.request;
      requests.push(`${r.method} ${r.url}`);
      if (r.method !== 'GET') posts.push({ url: r.url.replace(BASE, ''), bytes: (r.postData ?? '').length, body: r.postData ?? null });
    }
    if (x.method === 'Runtime.exceptionThrown') report.errors.push(x.params.exceptionDetails.exception?.description ?? x.params.exceptionDetails.text);
    if (x.method === 'Runtime.consoleAPICalled' && x.params.type === 'error') report.errors.push(`console.error: ${x.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (x.method === 'Log.entryAdded' && x.params.entry.level === 'error') report.errors.push(`log: ${x.params.entry.text} ${x.params.entry.url ?? ''}`);
    // The reserve screen asks before it is left with a proof file not yet downloaded. A walk goes on unless it
    // means to stay, and the report says that it was asked.
    if (x.method === 'Page.javascriptDialogOpening') {
      report.dialogs.push({ type: x.params.type, message: x.params.message, url: x.params.url.replace(BASE, ''), answered: leaveWhenAsked ? 'leave' : 'stay' });
      ws.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: leaveWhenAsked } }));
    }
  };
  await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable'); await cmd('Log.enable'); await cmd('DOM.enable');
  await cmd('Network.setCacheDisabled', { cacheDisabled: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  note('secure context / crypto.subtle', await (async () => {
    await cmd('Page.navigate', { url: `${BASE}/console/?lang=${LANG}` });
    await sleep(1200);
    return run(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle }));
  })());
  if (MODE === 'bank') await bank(); else if (MODE === 'file') await fileOnly(); else if (MODE === 'shapes') await shapes();
  else if (MODE === 'keep') await keep(); else throw new Error(`MODE=${MODE} is not a walk: bank, file, shapes or keep`);
} catch (e) {
  failed = true;
  report.errors.push(`DRIVER: ${e.stack ?? e}`);
  console.log(`✖ ${e.message}`);
  try { await shot(`failure-${MODE}`); } catch { /* the browser may be gone */ }
} finally {
  report.pageErrors = report.errors.length;
  writeFileSync(path.join(OUT, `report-${MODE}-${LANG}.json`), JSON.stringify(report, null, 1));
  console.log(`errors: ${JSON.stringify(report.errors, null, 1)}`);
  if (report.dialogs.length > 0) console.log(`asked before leaving a page: ${JSON.stringify(report.dialogs)}`);
  try { ws?.close(); } catch { /* closing */ }
  chrome.kill('SIGKILL');
  await sleep(700);
  rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
