/**
 * The router's edges: a request target it cannot parse, a parameter that
 * does not decode, and a failure outside every handler.
 *
 * Each of these used to escape `handle()` as an unhandled rejection — the end
 * of the process under plain node, a request left hanging under pm2 — so every
 * test here asks the same server one more question afterwards: one bad request
 * must never cost anyone else theirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Router } from '../src/http/server.ts';
import { serveStatic } from '../src/http/static.ts';

async function serve(r: Router): Promise<{ base: string; port: number; close: () => void }> {
  const server: Server = r.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** A GET that gives up rather than hangs, so a regression fails the suite instead of stalling it. */
const get = (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(5_000) });

/** One request line written by hand, for a target `fetch` would refuse to send. */
function rawGet(port: number, target: string): Promise<{ statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let received = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('no answer within 5 s')));
    socket.on('data', (c: Buffer) => { received += c.toString('utf8'); });
    socket.on('error', reject);
    socket.on('close', () => {
      const [head = '', body = ''] = received.split('\r\n\r\n');
      resolve({ statusLine: head.split('\r\n')[0] ?? '', body });
    });
  });
}

test('a route parameter that does not decode is a 400, and the server keeps answering', async () => {
  // No error mapper: the router itself has to know what its own error means.
  const r = new Router();
  r.get('/things/:id', (ctx) => ({ id: ctx.params['id'] }));
  const s = await serve(r);
  try {
    for (const bad of ['%E0', '%zz', 'trailing%']) {
      const res = await get(`${s.base}/things/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.deepEqual(await res.json(), { error: 'invalid_path', message: 'malformed percent-encoding in path' }, bad);
    }
    const ok = await get(`${s.base}/things/caf%C3%A9`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: 'café' }, 'a well-formed escape still decodes');
  } finally { s.close(); }
});

test('a static mount answers a malformed escape with a 400 of its own, not a 404 or a throw', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'attest-static-'));
  writeFileSync(path.join(root, 'app.js'), 'export {};\n');
  const r = new Router();
  r.fallback((req, res) => serveStatic({ root, mount: '/console' }, req, res));
  const s = await serve(r);
  try {
    const bad = await get(`${s.base}/console/%E0`);
    assert.equal(bad.status, 400, 'the mount answered it; left to the router it would read as a 404');
    assert.equal(await bad.text(), 'malformed percent-encoding in path');
    const ok = await get(`${s.base}/console/app.js`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'export {};\n');
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a request target that is not a URL is a 400, and the server keeps answering', async () => {
  const r = new Router();
  r.get('/healthz', () => ({ status: 'ok' }));
  const s = await serve(r);
  try {
    // Node hands `http://[` through as req.url untouched; `new URL` is what throws on it.
    const reply = await rawGet(s.port, 'http://[');
    assert.match(reply.statusLine, /^HTTP\/1\.1 400 /);
    assert.equal((JSON.parse(reply.body) as { error: string }).error, 'invalid_path');
    assert.equal((await get(`${s.base}/healthz`)).status, 200);
  } finally { s.close(); }
});

test('a failure outside every handler is answered or cut, never left hanging', async () => {
  const r = new Router();
  r.get('/healthz', () => ({ status: 'ok' }));
  // The handler succeeds; serialising its reply is what throws, after the mapping.
  r.get('/unserialisable', () => ({ amount: 10n }));
  // Fallbacks run outside the error mapping, so a throw here reaches the last line.
  r.fallback((req, res) => {
    if (req.url === '/mid-stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
    }
    throw new Error('fallback failed reading /srv/private/config');
  });
  const s = await serve(r);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
  try {
    const res = await get(`${s.base}/nowhere`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal', message: 'internal error' },
      'the message was written for a log, not for a client');
    const unserialisable = await get(`${s.base}/unserialisable`);
    assert.equal(unserialisable.status, 500);
    assert.deepEqual(await unserialisable.json(), { error: 'internal', message: 'internal error' });
    // A response already under way cannot be replaced, only cut short.
    await assert.rejects(get(`${s.base}/mid-stream`).then((x) => x.text()));
    assert.equal((await get(`${s.base}/healthz`)).status, 200, 'everyone else is still served');
    assert.equal(logged.filter((l) => l.includes('fallback failed')).length, 2, 'both failures reach the log');
  } finally {
    console.error = original;
    s.close();
  }
});

test('the path the request hook sees has its runs of slashes collapsed', async () => {
  // The matcher already skips empty segments; the audit hook files by this
  // path, so it has to name the route the matcher actually answered with.
  const r = new Router();
  r.get('/v1/settlements', () => ({ ok: true }));
  const seen: string[] = [];
  r.onDone((ctx) => { seen.push(ctx.path); });
  const s = await serve(r);
  try {
    assert.equal((await get(`${s.base}/v1//settlements`)).status, 200);
    assert.equal((await get(`${s.base}/v1///settlements`)).status, 200);
    assert.deepEqual(seen, ['/v1/settlements', '/v1/settlements']);
  } finally { s.close(); }
});
