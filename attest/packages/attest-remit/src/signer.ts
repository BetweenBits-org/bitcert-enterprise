/**
 * Signing with a key this process never holds.
 *
 * A bank's instruction-signing key lives in an HSM, a KMS or a signing
 * service, and stays there. `ExternalSigner` is the seam: the SDK prepares
 * the exact bytes, the signer returns an ES256 signature, and the SDK
 * **verifies it against the registered public key before using it** — so a
 * misconfigured slot, a wrong key label or a truncated response fails here,
 * with a clear message, instead of at the platform as "invalid signature".
 *
 * Two field realities are absorbed rather than documented away:
 *   - ES256 signatures come back raw `r‖s` (PKCS#11, WebCrypto) or ASN.1 DER
 *     (OpenSSL, most KMS APIs). Both are tried and verification decides.
 *   - A command-line signer may print binary, base64 or hex.
 */
import { spawn } from 'node:child_process';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export interface ExternalSigner {
  /**
   * The public half of the key the signer holds — SPKI DER in base64, or a
   * PEM `PUBLIC KEY` block. It must be the key registered for the
   * institution; `assertRegistered()` checks that.
   */
  publicKey: string;
  /**
   * Sign `bytes` with ECDSA P-256 over SHA-256 and return the signature,
   * raw `r‖s` (64 bytes) or DER. The SDK hashes nothing itself: pass the
   * bytes to a "sign with SHA-256" operation, not a pre-hashed one.
   */
  sign(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export class SignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerError';
  }
}

/** PEM or base64 SPKI → base64 SPKI (DER), validated as a P-256 public key. */
export function spkiBase64Of(publicKey: string): string {
  const trimmed = publicKey.trim();
  let key: KeyObject;
  try {
    key = trimmed.startsWith('-----')
      ? createPublicKey(trimmed)
      : createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
  } catch (e) {
    throw new SignerError(`the signer's public key is neither a PEM PUBLIC KEY block nor base64 SPKI: ${e instanceof Error ? e.message : e}`);
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') {
    throw new SignerError('the signer\'s public key is not an ECDSA P-256 key (ES256 is the only algorithm the corridor signs with)');
  }
  return (key.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
}

/** ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` → raw 64 bytes, or null when it is not that. */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  let i = 0;
  if (der[i++] !== 0x30) return null;
  let seqLen = der[i++];
  if (seqLen === undefined) return null;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    if (n === 0 || n > 2) return null;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | (der[i++] ?? 0);
  }
  if (i + seqLen !== der.length) return null;
  const int = (): Uint8Array | null => {
    if (der[i++] !== 0x02) return null;
    let len = der[i++];
    if (len === undefined || len & 0x80 || i + len > der.length) return null;
    let start = i;
    i += len;
    while (len > 32 && der[start] === 0) { start++; len--; }
    if (len > 32) return null;
    const out = new Uint8Array(32);
    out.set(der.subarray(start, start + len), 32 - len);
    return out;
  };
  const r = int();
  const s = r ? int() : null;
  if (!r || !s || i !== der.length) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** What a command-line tool printed → signature bytes: binary, base64(url) or hex. */
export function readSignatureBytes(out: Uint8Array): Uint8Array {
  const buf = Buffer.from(out);
  const textual = buf.every((b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e));
  if (textual) {
    const t = buf.toString('ascii').replace(/\s+/g, '');
    if (t.length >= 96 && t.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(t)) return Buffer.from(t, 'hex');
    if (t.length >= 64 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
      return Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    }
  }
  return buf;
}

/**
 * Ask the signer for a signature and return it raw (`r‖s`), having checked
 * that it verifies over exactly these bytes with the signer's public key.
 */
export async function signWith(signer: ExternalSigner, bytes: Uint8Array): Promise<Uint8Array> {
  const spki = spkiBase64Of(signer.publicKey);
  let produced: Uint8Array;
  try {
    produced = await signer.sign(bytes);
  } catch (e) {
    throw new SignerError(`the external signer failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(produced instanceof Uint8Array) || produced.length === 0) {
    throw new SignerError('the external signer returned no signature bytes');
  }
  const candidates: Uint8Array[] = [];
  if (produced.length === 64) candidates.push(produced);
  const fromDer = derToRaw(produced);
  if (fromDer) candidates.push(fromDer);
  const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
  for (const c of candidates) {
    if (cryptoVerify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, c)) return c;
  }
  throw new SignerError(candidates.length === 0
    ? `the external signer returned ${produced.length} bytes that are neither a raw r‖s signature (64 bytes) nor DER`
    : 'the external signer\'s signature does not verify with its public key — the signer is using a different key, '
      + 'or signed a digest instead of the message (it must sign the bytes with SHA-256 itself)');
}

/**
 * A command line as a list of arguments, with quotes honoured — so a path
 * with a space in it, or a PKCS#11 URI in quotes, stays one argument. No
 * shell is involved: nothing is expanded, and nothing but quotes is special.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let open = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || open) out.push(cur);
      cur = '';
      open = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new SignerError('the command has an unclosed quote');
  if (cur !== '' || open) out.push(cur);
  return out;
}

/**
 * A signer that runs a command: the bytes to sign go to its standard input,
 * the signature is read from its standard output (binary, base64 or hex).
 *
 * ```ts
 * // OpenSSL, for a sandbox key on disk — or an engine/provider-backed key:
 * commandSigner({ publicKey: pem, command: ['openssl', 'dgst', '-sha256', '-sign', 'bank-signing.key'] })
 * ```
 * The command is run without a shell: arguments are passed as given.
 */
const MAX_SIGNER_OUTPUT = 1024 * 1024;

export function commandSigner(opts: { publicKey: string; command: string[]; timeoutMs?: number }): ExternalSigner {
  if (!Array.isArray(opts.command)) {
    throw new SignerError('commandSigner takes the command as a list of arguments, run without a shell — '
      + "for example ['openssl', 'dgst', '-sha256', '-sign', keyFile]; splitCommand(line) turns one line into that list");
  }
  const [program, ...args] = opts.command;
  if (!program) throw new SignerError('commandSigner needs a command to run');
  return {
    publicKey: opts.publicKey,
    sign: (bytes) => new Promise<Uint8Array>((resolve, reject) => {
      // Its own process group: a wrapper script starts the real signing tool,
      // and stopping only the wrapper would leave that tool running — one more
      // for every retry.
      const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let settled = false;
      const stop = (): void => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const giveUp = (why: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop();
        reject(new SignerError(why));
      };
      const timer = setTimeout(() => giveUp(`"${program}" did not answer within ${opts.timeoutMs ?? 30_000} ms`),
        opts.timeoutMs ?? 30_000);
      child.stdout.on('data', (c: Buffer) => {
        size += c.length;
        // A signature is under a hundred bytes; a megabyte of output is something else.
        if (size > MAX_SIGNER_OUTPUT) giveUp(`"${program}" printed more than ${MAX_SIGNER_OUTPUT} bytes — that is not a signature`);
        else out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => { if (err.length < 64) err.push(c); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new SignerError(`could not run "${program}": ${e.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const said = Buffer.concat(err).toString('utf8').trim().slice(0, 400);
        if (code !== 0) {
          reject(new SignerError(`"${program}" exited with status ${code}: ${said}`));
          return;
        }
        try {
          resolve(readSignatureBytes(Buffer.concat(out)));
        } catch (e) {
          // What the tool said on its error stream is usually the reason it printed no signature.
          reject(said && e instanceof SignerError ? new SignerError(`${e.message} — "${program}" said: ${said}`) : e);
        }
      });
      child.stdin.on('error', () => { /* the command closed its input early; its exit status says why */ });
      child.stdin.end(Buffer.from(bytes));
    }),
  };
}
