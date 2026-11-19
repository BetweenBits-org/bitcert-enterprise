/**
 * Minimal bitcoind JSON-RPC client over `node:http`.
 *
 * No dependency, because this is a dozen lines of POST and the alternative is
 * auditing a transitive tree for a service whose whole point is being auditable.
 */
import { request } from 'node:http';
import { request as requestHttps } from 'node:https';

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`bitcoind rpc ${code}: ${message}`);
    this.code = code;
    this.name = 'RpcError';
  }
}

export interface RpcOptions {
  url: string;
  user: string;
  password: string;
  timeoutMs?: number;
}

export async function rpc<T>(
  opts: RpcOptions, method: string, params: unknown[] = [], walletPath = '',
): Promise<T> {
  const base = new URL(opts.url);
  const path = walletPath ? `/wallet/${encodeURIComponent(walletPath)}` : (base.pathname || '/');
  const body = JSON.stringify({ jsonrpc: '1.0', id: method, method, params });
  const isHttps = base.protocol === 'https:';
  const send = isHttps ? requestHttps : request;

  return new Promise<T>((resolve, reject) => {
    const req = send(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(opts.user || opts.password
            ? { authorization: `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}` }
            : {}),
        },
        timeout: opts.timeoutMs ?? 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: { result?: T; error?: { code: number; message: string } };
          try {
            parsed = JSON.parse(text) as typeof parsed;
          } catch {
            reject(new Error(`bitcoind returned non-JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`));
            return;
          }
          if (parsed.error) { reject(new RpcError(parsed.error.code, parsed.error.message)); return; }
          resolve(parsed.result as T);
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('bitcoind rpc timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}
