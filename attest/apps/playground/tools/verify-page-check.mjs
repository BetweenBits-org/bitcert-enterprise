// One-off check of the public verification page on two origins, with a negative control.
//   node verify-page-check.mjs <an account's proof file> <snapshot id> [the exchange's own proof file]
// With the third argument, the page is also given the file an exchange keeps: it must say what that file is,
// clear it from the box and verify nothing.
// The browser and its profile are removed in `finally`.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, rmSync } from 'node:fs';

const CHROME = '/home/ubuntu/.cache/puppeteer/chrome/linux-152.0.7977.54/chrome-linux64/chrome';
const PORT = 9300 + (process.pid % 600);
const PROFILE = `/dev/shm/cc-chrome-${process.pid}`;
const [proofPath, snapshotId, exchangeFilePath] = process.argv.slice(2);
const proof = readFileSync(proofPath, 'utf8');
const exchangeFile = exchangeFilePath ? readFileSync(exchangeFilePath, 'utf8') : null;

// Runs inside the page. Kept as a real function so no string escaping is involved.
async function inPage(proofText, id, exchangeFileText) {
  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const read = () => {
    const text = $('#out').innerText;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.startsWith('거래소 서명 (선언문'));
    const platform = lines.findIndex((l) => l === '플랫폼이 확인한 것');
    return {
      verdict: text.includes('검증 통과') ? '검증 통과' : text.includes('검증 실패') ? '검증 실패' : '?',
      signatureMark: at > 0 ? lines[at - 1] : '?',
      signatureDetail: at >= 0 ? lines[at + 1] : '?',
      platformLine: platform >= 0 ? lines[platform + 1] : '?',
      marks: lines.filter((l) => l === '✅' || l === '❌' || l === '◻️').join(''),
    };
  };
  $('#proofIn').value = proofText;
  $('#snapId').value = id;
  $('#fetchSnap').click();
  await wait(1500);
  $('#userRef').value = 'U-100008';
  $('#verifyBtn').click();
  await wait(2500);
  const valid = read();
  // Negative control: the same material with one total changed must fail the signature check.
  const snap = JSON.parse($('#snapIn').value);
  snap.statement.totals.USDT = '1';
  $('#snapIn').value = JSON.stringify(snap);
  $('#verifyBtn').click();
  await wait(2500);
  const tampered = read();
  let exchangeFile = null;
  if (exchangeFileText) {
    // The file an exchange keeps, pasted where an account's proof belongs.
    $('#proofIn').value = exchangeFileText;
    $('#verifyBtn').click();
    await wait(800);
    exchangeFile = {
      says: $('#out').innerText.replace(/\s+/g, ' ').trim().slice(0, 160),
      boxCleared: $('#proofIn').value === '',
      verdictShown: /검증 통과|검증 실패/.test($('#out').innerText),
    };
  }
  return { secureContext: window.isSecureContext, hasSubtle: Boolean(window.crypto && window.crypto.subtle), valid, tampered, exchangeFile };
}

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1440,1400', 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch { /* not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('browser did not start');
  ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  for (const origin of (process.env.ORIGINS ?? 'http://127.0.0.1:8787,http://3.36.101.90:8787').split(',')) {
    await send('Page.navigate', { url: `${origin}/playground/por.html` });
    await sleep(2000);
    const r = await send('Runtime.evaluate', {
      returnByValue: true, awaitPromise: true,
      expression: `(${inPage.toString()})(${JSON.stringify(proof)}, ${JSON.stringify(snapshotId)}, ${JSON.stringify(exchangeFile)})`,
    });
    console.log(origin, JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r, null, 1));
  }
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill('SIGKILL');
  await sleep(300);
  rmSync(PROFILE, { recursive: true, force: true });
}
