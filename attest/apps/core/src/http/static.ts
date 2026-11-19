/**
 * Static file serving for the Playground.
 *
 * The Playground is a pure client: it imports `@stonehash/attest-verify` and
 * does every check in the browser, so it needs no API of its own. Serving its
 * files from this process means one port to open and one thing to run on a test
 * box. In production the host split (`playground.` vs `api.`) is a reverse-proxy
 * concern, which is why the directory is configuration rather than a constant.
 *
 * Path handling is the whole security surface here, so it is deliberate: the
 * resolved path must stay inside the root, checked after `realpath`-style
 * resolution rather than by inspecting the request for `..`, which is the check
 * that classically gets bypassed.
 */
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // The Developer Hub fetches its documents as Markdown and renders them in
  // the browser. Without this they fall through to octet-stream, which the
  // reader's proxy is entitled to treat as a download.
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticOptions {
  /** Absolute directory to serve from. */
  root: string;
  /** URL prefix this mount answers, e.g. `/playground`. */
  mount: string;
}

/**
 * The bare address: `/` has no page of its own.
 *
 * This process is an API with up to three screens mounted beside it, so a
 * browser pointed at the host alone used to fall through to the router's JSON
 * 404 — which, to anyone who is not looking for an endpoint, reads as "the
 * site is down". Where a screen is mounted, send the visitor to it instead;
 * which screen is the caller's choice (`routes.ts` picks the console).
 *
 * Temporary (302) and uncached, so the landing can change without a browser
 * holding on to the old answer. Only `/` itself is claimed and the target is a
 * fixed local path, so nothing in the request can steer the redirect
 * elsewhere; the query is carried over because it is how the language is
 * chosen.
 */
export function redirectRoot(
  landing: string, req: IncomingMessage, res: ServerResponse,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/') return false;
  res.writeHead(302, { location: `${landing}${url.search}`, 'cache-control': 'no-store' });
  res.end();
  return true;
}

/**
 * Returns `true` if the request was handled. The caller falls through to its
 * own routes otherwise, so the API keeps priority over any same-named file.
 */
export function serveStatic(
  opts: StaticOptions, req: IncomingMessage, res: ServerResponse,
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(opts.mount)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // A malformed escape (`%E0`) names no file, and it is the client's error,
  // so it is a 400 here. Thrown, it would escape the router's error mapping —
  // fallbacks run outside it — and come back as a bare 500 at best.
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(opts.mount.length));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('malformed percent-encoding in path');
    return true;
  }

  /*
   * A directory without its trailing slash is a redirect, not a page.
   *
   * Serving `index.html` directly at `/playground` looks like it works — the
   * HTML arrives with a 200 — but every relative reference in it resolves one
   * level too high. `./app.css` becomes `/app.css`, which does not exist, so
   * the visitor gets unstyled markup with no script and no error to explain
   * it. The page is served and broken at the same time, which is the hardest
   * kind of failure to diagnose from the outside.
   *
   * Redirecting first is what a static server is expected to do, and it makes
   * the relative paths resolve the way the document was written.
   */
  if (rel === '') {
    res.writeHead(301, { location: `${opts.mount}/${url.search}` });
    res.end();
    return true;
  }
  if (rel === '/') rel = '/index.html';

  const resolved = path.resolve(opts.root, `.${rel}`);
  // Containment check on the resolved path, with the separator appended so
  // `/srv/app-evil` cannot pass as being inside `/srv/app`.
  if (resolved !== opts.root && !resolved.startsWith(opts.root + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return true;
  }

  let target = resolved;
  try {
    if (statSync(target).isDirectory()) {
      // Same reasoning as the mount above: a nested directory reached without
      // its trailing slash would serve an index whose relative links all point
      // one level too high.
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { location: `${url.pathname}/${url.search}` });
        res.end();
        return true;
      }
      target = path.join(target, 'index.html');
    }
    statSync(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }

  const type = TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    // The Playground is a verification tool, so a stale copy is worse than a
    // slow one: a cached build could disagree with the SDK beside it.
    'cache-control': 'no-cache',
    // It executes no remote code and loads no remote assets, so the policy can
    // be this strict — and saying so is part of the product's claim.
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
      + "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  // Stat and read are two moments: a rebuild between them removes the file,
  // and an unhandled stream error would end the process. Cut this response
  // instead.
  const stream = createReadStream(target);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
  return true;
}
