/**
 * One HTTP exchange over a plain socket: the request line goes out exactly
 * as written (a path with two slashes, a malformed escape, a method nobody
 * registered), which a client library would tidy up first.
 */
import net from 'node:net';

function unchunk(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const eol = buf.indexOf('\r\n', at);
    if (eol < 0) break;
    const size = parseInt(buf.subarray(at, eol).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * `noAnswer`: the case is about a connection the server cuts (an upload past
 * its ceiling). A reset or a broken pipe is then what happened, not a failure
 * of the exchange, and is reported like a connection closed without a word:
 * status 0.
 *
 * @returns {Promise<{status:number, headers:Record<string,string[]>, body:Buffer, raw:string}>}
 */
export function exchange(base, { method = 'GET', target = '/', headers = {}, body = null, noAnswer = false }) {
  const u = new URL(base);
  const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${u.host}`, 'Connection: close'];
  const given = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (payload && !('content-length' in given) && given['transfer-encoding'] === undefined) lines.push(`Content-Length: ${payload.length}`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 80) }, () => {
      socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload ?? Buffer.alloc(0)]));
    });
    socket.setTimeout(15_000, () => { socket.destroy(new Error(`no answer to ${method} ${target} from ${base}`)); });
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', (e) => {
      if (noAnswer && (e.code === 'ECONNRESET' || e.code === 'EPIPE')) resolve({ status: 0, headers: {}, body: Buffer.alloc(0), raw: `connection cut (${e.code})` });
      else reject(e);
    });
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf('\r\n\r\n');
      // Cut in the middle of an answer: what arrived is no answer either.
      if (split < 0 || noAnswer) { resolve({ status: split < 0 ? 0 : -1, headers: {}, body: Buffer.alloc(0), raw: all.toString('latin1').slice(0, 200) }); return; }
      const head = all.subarray(0, split).toString('latin1').split('\r\n');
      const status = Number(head[0].split(' ')[1]);
      const out = {};
      for (const line of head.slice(1)) {
        const i = line.indexOf(':');
        (out[line.slice(0, i).trim().toLowerCase()] ??= []).push(line.slice(i + 1).trim());
      }
      let rest = all.subarray(split + 4);
      if ((out['transfer-encoding'] ?? []).some((v) => /chunked/i.test(v))) rest = unchunk(rest);
      resolve({ status, headers: out, body: rest, raw: head[0] });
    });
  });
}
