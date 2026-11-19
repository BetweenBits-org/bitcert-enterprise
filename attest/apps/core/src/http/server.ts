/**
 * HTTP — `node:http` and about eighty lines of router.
 *
 * No framework, because the surface is nine routes and a framework would be the
 * only runtime dependency in the entire service. Keeping it at zero means
 * deployment is "copy the tree, run node": no install step that can fail on a
 * machine we have not seen, nothing to audit, nothing to upgrade for a CVE in
 * code we do not call.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AuditActor } from '../audit.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** The request path with the query string removed — what a log line names. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Bearer token, if the request carried one. */
  token: string | undefined;
  body: () => Promise<unknown>;
  /**
   * The request body as bytes, for the one route that receives a document.
   *
   * Separate from `body()` so the 1 MiB JSON cap stays where it is: every
   * other route carries digests, and raising their limit to suit this one
   * would widen the surface for all of them. The caller passes the ceiling it
   * is willing to accept.
   */
  raw: (maxBytes: number) => Promise<Buffer>;
  /**
   * Who this request acts as, once an auth helper has admitted it. Left
   * unset for anonymous requests, which is how the audit hook tells a call
   * worth recording from a probe that never reached a tenant.
   */
  audit?: AuditActor;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

/** Runs once per matched request with the status about to be sent. */
export type DoneHook = (ctx: Ctx, status: number, durationMs: number) => Promise<void> | void;

interface Route {
  method: string;
  /** Path split on `/`; a segment starting with `:` is a parameter. */
  segments: string[];
  handler: Handler;
}

/** Returned from a handler to control the status or send a non-JSON body. */
export class HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'HttpError';
  }
}

const MAX_BODY = 1 << 20; // 1 MiB: requests carry digests, never documents

/** What goes out for a request: status, body and any headers the handler set. */
type Reply = { status: number; body: unknown; headers: Record<string, string> };

/**
 * The request target as a URL, or a 400.
 *
 * Node passes the target through as the client sent it, so `GET http://[`
 * arrives intact and `new URL` throws on it. That throw used to escape the
 * router: fatal under plain node, a request that never gets an answer under
 * pm2.
 */
function requestUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    throw new HttpError(400, 'invalid_path', 'the request target is not a valid URL');
  }
}

/** One path parameter, percent-decoded, or a 400 when the escape is malformed (`%E0`). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'invalid_path', 'malformed percent-encoding in path');
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private onError: ((e: unknown) => HttpResult) | null = null;
  /** Consulted only when no route matches — e.g. static files. */
  private onMiss: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
  private onDoneHook: DoneHook | null = null;

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler): this { return this.add('GET', p, h); }
  post(p: string, h: Handler): this { return this.add('POST', p, h); }
  errorMapper(fn: (e: unknown) => HttpResult): this { this.onError = fn; return this; }
  /** Handler for unmatched requests. Returns `true` if it answered. */
  fallback(fn: (req: IncomingMessage, res: ServerResponse) => boolean): this {
    this.onMiss = fn;
    return this;
  }
  /**
   * Called after the outcome of a matched request is known — success, an
   * `HttpResult`, or a mapped error — with the status that will be sent,
   * and before it is sent. Awaited, so whoever asks right after the response
   * sees what the hook recorded; but a hook that throws is reported and the
   * response goes out regardless. An audit write must never be what fails
   * a call.
   */
  onDone(fn: DoneHook): this { this.onDoneHook = fn; return this; }

  /**
   * What a thrown error is answered with: the mapper's reply when one is set.
   * Without one an `HttpError` still keeps its own status — it is this
   * module's type and already says what the client got wrong — and anything
   * else is a 500.
   */
  private errorReply(e: unknown): Reply {
    const mapped = this.onError?.(e);
    if (mapped) return { status: mapped.status, body: mapped.body, headers: mapped.headers };
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message }, headers: {} };
    return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : String(e) }, headers: {} };
  }

  /**
   * The first route whose shape fits, with its parameters decoded.
   *
   * Literals are compared before anything is decoded, so only a route that
   * actually matched can refuse a malformed escape; a path no route claims
   * still falls through to the static mounts, which answer it themselves.
   */
  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      if (!route.segments.every((seg, i) => seg.startsWith(':') || seg === parts[i])) continue;
      const params: Record<string, string> = {};
      for (const [i, seg] of route.segments.entries()) {
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeSegment(parts[i]!);
      }
      return { route, params };
    }
    return null;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The target can be refused before any route owns the request: it does
    // not parse, or a parameter does not decode. Nobody has been admitted yet,
    // so there is nothing to audit; it is answered here, through the same
    // mapping a handler's error takes.
    let url: URL;
    let m: { route: Route; params: Record<string, string> } | null;
    try {
      url = requestUrl(req);
      m = this.match(req.method ?? 'GET', url.pathname);
    } catch (e) {
      const refused = this.errorReply(e);
      send(res, refused.status, refused.body, refused.headers);
      return;
    }
    if (!m) {
      if (this.onMiss?.(req, res)) return;
      send(res, 404, { error: 'not_found', message: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    const auth = req.headers['authorization'];
    const started = performance.now();
    const ctx: Ctx = {
      req, res,
      // Runs of `/` collapsed. The matcher skips empty segments, so the router
      // answers `/v1//settlements` as `/v1/settlements`; the audit has to file
      // it under the product that answered, not under console housekeeping.
      path: url.pathname.replace(/\/{2,}/g, '/'),
      params: m.params,
      query: url.searchParams,
      token: typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined,
      body: () => readJson(req),
      raw: (maxBytes: number) => readRaw(req, maxBytes),
    };
    // The outcome is settled before anything is written, so the hook sees
    // the status that will go out and runs before the client can act on it.
    // `null` means the handler streamed its own response and there is
    // nothing left to send.
    let reply: Reply | null;
    try {
      const out = await m.route.handler(ctx);
      if (res.writableEnded) reply = null;
      else if (out instanceof HttpResult) reply = { status: out.status, body: out.body, headers: out.headers };
      else reply = { status: 200, body: out, headers: {} };
    } catch (e) {
      reply = this.errorReply(e);
    }
    if (this.onDoneHook) {
      try {
        await this.onDoneHook(ctx, reply ? reply.status : res.statusCode, performance.now() - started);
      } catch (e) {
        console.error(`request hook failed for ${req.method} ${url.pathname}:`,
          e instanceof Error ? e.message : String(e));
      }
    }
    if (reply) send(res, reply.status, reply.body, reply.headers);
  };

  listen(port: number, host: string): Server {
    return createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => answerUnhandled(res, e));
    }).listen(port, host);
  }
}

/**
 * The last line, for a failure that escaped `handle` — a fallback that threw,
 * a reply body that would not serialise. Discarded, it was an unhandled
 * rejection: the end of the process under plain node, a request that never
 * gets an answer under pm2. So it is logged and answered, or the connection is
 * cut when a response was already under way, and the server goes on serving
 * everyone else. Only an `HttpError` says why; any other message was never
 * written for a client.
 */
function answerUnhandled(res: ServerResponse, e: unknown): void {
  console.error('request failed:', e instanceof Error ? e.message : String(e));
  if (res.headersSent) { res.destroy(); return; }
  if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
  else send(res, 500, { error: 'internal', message: 'internal error' });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined || body === null) { res.writeHead(status, headers); res.end(); return; }
  // Binary bodies (the evidence archive) are sent as-is. A caller-supplied
  // content-type wins, since only the handler knows what the bytes are.
  if (body instanceof Uint8Array) {
    res.writeHead(status, {
      'content-type': 'application/octet-stream',
      ...headers,
      'content-length': body.byteLength,
    });
    res.end(body);
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * Collect the body in memory, refusing anything over `maxBytes`.
 *
 * In memory and nowhere else: the document this carries is hashed, inscribed
 * and dropped, and a temporary file would turn "we do not store your
 * document" into a claim about cleanup rather than a fact about the code.
 * The stream is destroyed the moment the limit is passed, so an oversized
 * upload costs the cap and not the sender's whole file.
 */
async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) {
      req.destroy();
      throw new HttpError(413, 'payload_too_large',
        `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'request body exceeds 1 MiB');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

/**
 * `?limit=` as a page size: a whole number from 1 to `max`, or the default.
 * `2.5` used to reach SQL as a non-integer LIMIT (a 500), and `-1` as "no
 * limit" on one engine and an error on the other.
 */
export function pageLimit(raw: string | null, dflt: number, max: number): number {
  const n = Math.floor(Number(raw ?? dflt));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : dflt;
}
