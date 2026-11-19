#!/usr/bin/env node
/**
 * `attest-sign` — generate a key, hash a file, sign a statement.
 *
 * Three commands and no network. The whole point of running this yourself is
 * that the private key stays with you, so the tool is arranged to make that
 * checkable rather than asserted:
 *
 *   - it opens no sockets; `--offline-check` proves it by refusing to run
 *     where the network is reachable;
 *   - it writes the private key only to the path you name;
 *   - it reads a document only to hash it, and prints the digest so you can
 *     compare against `sha256sum` yourself.
 *
 * ## Usage
 *
 *   attest-sign keygen --out issuer.key.json [--algorithm ES256|RS256]
 *   attest-sign hash <file>
 *   attest-sign sign --key issuer.key.json --statement prepared.json
 *   attest-sign sign --key issuer.key.json --file contract.pdf
 *   attest-sign prepare --digest <hex> --public-key issuer-public.pem
 *   attest-sign assemble --statement prepared.json --signature sig.der
 *
 * `prepare` and `assemble` are `sign` split in half, for a key that lives in
 * an HSM or KMS and cannot leave it. Between them sits one operation — "sign
 * these bytes" — performed by whatever holds the key. No private key is read
 * by either half; everything in a statement except its signature is public.
 *
 * `--statement` is the path a console download lands at. Prefer it: the
 * console shows the exact bytes it will anchor, and signing those removes any
 * chance of signing a reconstruction that differs by a character.
 */
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildStatement, deriveKeyId, generateKey, signPreparedStatement,
  signPreparedStatementWith, signStatement, statementLeaf, statementSigningInput,
} from './index.ts';
import type { GeneratedKey, StatementAlgorithm, StatementCore } from './index.ts';

const USAGE = `attest-sign — issuer signing for StoneHash Attest

  keygen   --out <file> [--algorithm ES256|RS256]
           Generate a keypair. The private key is written only to <file>.

  hash     <file>
           SHA-256 of a file, so you can check it against sha256sum.

  sign     --key <keyfile> (--digest <hex> | --file <doc> | --statement <file>) [--out <file>]
           Sign an attestation statement. Prints the signed statement and
           the leaf the service will anchor.

           --digest is for signing on a machine the document never reaches:
           carry the 64-hex digest across, not the file.

  prepare  (--digest <hex> | --file <doc>) --public-key <file>
           [--algorithm ES256|RS256] [--content-type <mime>] [--key-id <id>]
           [--out prepared.json] [--input-out signing-input.bin]
           Build the statement and write the exact bytes to sign, for a key
           held in an HSM or KMS. No private key is involved. --public-key
           takes the public half only: PEM, DER, base64, or a key file from
           keygen. With --statement <file> instead, emit the bytes for a
           statement the console already composed.

  assemble --statement <prepared.json> --signature <file> [--out <file>]
           Attach a signature made elsewhere — raw r‖s or DER, as binary,
           base64 or hex — and verify it against the statement's public key
           before anything is emitted.

Nothing here contacts a network. Run it offline if you like:
  docker run --rm --network=none -v "$PWD:/work" attest-sign keygen --out /work/issuer.key.json
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Refuse to run where the network is reachable.
 *
 * Opt-in, because most people will run this on a normal workstation and a
 * hard requirement would make the tool unusable. Where it matters — an
 * air-gapped signing host, or an auditor watching — it turns "we make no
 * network calls" from a claim in a README into something the process itself
 * enforces.
 */
async function assertOffline(): Promise<void> {
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const done = (v: boolean): void => { socket.destroy(); resolve(v); };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(443, '1.1.1.1');
  });
  if (reachable) {
    die('--offline-check: this machine can reach the network. Re-run with '
      + '--network=none (docker) or disconnect, or drop --offline-check.');
  }
}

/** `--digest` (64 hex), or `--file` hashed here — the same pair `sign` takes. */
function resolveDigest(argv: string[]): string | undefined {
  const digestArg = arg(argv, 'digest');
  if (digestArg) {
    const digest = digestArg.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      die(`--digest must be 64 hex characters, got ${digestArg.length}`);
    }
    return digest;
  }
  const docFile = arg(argv, 'file');
  return docFile
    ? createHash('sha256').update(readFileSync(docFile)).digest('hex')
    : undefined;
}

/** The public half, however the key store exports it: PEM, raw DER, bare base64, or a key file from `keygen`. */
function readPublicKeySpki(file: string): { spkiBase64: string; algorithm?: StatementAlgorithm } {
  const buf = readFileSync(file);
  const text = buf.toString('utf8');
  if (text.includes('-----BEGIN')) {
    const pem = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/.exec(text);
    if (!pem) {
      die(`${file}: only SubjectPublicKeyInfo PEM is supported. Export it with\n`
        + `  openssl pkey -in <private> -pubout        (from a key)\n`
        + `  openssl x509 -in <cert> -pubkey -noout    (from a certificate)`);
    }
    return { spkiBase64: pem[1]!.replace(/\s+/g, '') };
  }
  if (text.trimStart().startsWith('{')) {
    const key = JSON.parse(text) as Partial<GeneratedKey>;
    if (!key.publicKeySpkiBase64) die(`${file}: no "publicKeySpkiBase64" in this file`);
    return {
      spkiBase64: key.publicKeySpkiBase64,
      ...(key.algorithm ? { algorithm: key.algorithm } : {}),
    };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) return { spkiBase64: text.replace(/\s+/g, '') };
  return { spkiBase64: buf.toString('base64') };
}

/** The OID inside the SPKI tells ES256 from RS256; an explicit flag overrides. */
function inferAlgorithm(spkiBase64: string): StatementAlgorithm | undefined {
  const der = Buffer.from(spkiBase64, 'base64');
  if (der.includes(Buffer.from('2a8648ce3d0201', 'hex'))) return 'ES256';
  if (der.includes(Buffer.from('2a864886f70d010101', 'hex'))) return 'RS256';
  return undefined;
}

/** A signature as the device wrote it: raw bytes, or the same as hex or base64 text. */
function readSignatureBytes(file: string): Uint8Array {
  const buf = readFileSync(file);
  const text = buf.toString('utf8').trim();
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 && text.length >= 96) {
    return new Uint8Array(Buffer.from(text, 'hex'));
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(text) && text.length >= 64) {
    return new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  }
  return new Uint8Array(buf);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h') { process.stdout.write(USAGE); return; }
  if (argv.includes('--offline-check')) await assertOffline();

  if (cmd === 'keygen') {
    const out = arg(argv, 'out') ?? die('keygen needs --out <file>');
    const algorithm = (arg(argv, 'algorithm') ?? 'ES256') as StatementAlgorithm;
    if (algorithm !== 'ES256' && algorithm !== 'RS256') die(`unsupported algorithm: ${algorithm}`);
    const key = await generateKey(algorithm);
    // 0600: the file holds the only copy of the secret, and a default umask
    // would leave it readable by everyone on a shared host.
    writeFileSync(out, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `key id      ${key.keyId}\n`
      + `algorithm   ${key.algorithm}\n`
      + `public key  ${key.publicKeySpkiBase64}\n`
      + `written to  ${out}  (mode 0600)\n\n`
      + 'The private key is in that file and nowhere else. We never received it and\n'
      + 'cannot recover it — if you lose it, signatures made with it stay valid but\n'
      + 'you cannot make new ones.\n');
    return;
  }

  if (cmd === 'hash') {
    const file = argv[1] ?? die('hash needs a file');
    process.stdout.write(`${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`);
    return;
  }

  if (cmd === 'sign') {
    const keyFile = arg(argv, 'key') ?? die('sign needs --key <keyfile>');
    const key = JSON.parse(readFileSync(keyFile, 'utf8')) as GeneratedKey;

    const statementFile = arg(argv, 'statement');
    const docFile = arg(argv, 'file');
    const digestArg = arg(argv, 'digest');
    if (!statementFile && !docFile && !digestArg) {
      die('sign needs --digest <hex>, --file <doc> or --statement <file>');
    }

    /*
     * `--digest` exists for the workflow that is actually safest: the signing
     * machine never sees the document. The console computes the digest, the
     * operator carries those 64 characters across, and the signature covers
     * them. Nothing is lost — the signature was always over the digest.
     */
    const documentSha256 = resolveDigest(argv);

    const signed = statementFile
      ? await signPreparedStatement(
          key, JSON.parse(readFileSync(statementFile, 'utf8')) as StatementCore)
      : await signStatement(key, {
          documentSha256: documentSha256!,
          ...(arg(argv, 'content-type') ? { contentType: arg(argv, 'content-type')! } : {}),
        });

    const text = `${JSON.stringify(signed, null, 2)}\n`;
    const out = arg(argv, 'out');
    if (out) writeFileSync(out, text);
    else process.stdout.write(text);

    /*
     * Everything explanatory goes to stderr so `> statement.json` still
     * yields a clean file, while someone reading the terminal is told what
     * to do with it. The first question the output drew was "which part do I
     * paste?" — the answer is all of it, and the tool should say so rather
     * than leaving it to the docs.
     */
    process.stderr.write(
      `\nanchor leaf  ${statementLeaf(signed)}\n`
      + (out
        ? `written to   ${out}\n\nPaste the whole file into the console.\n`
        : '\nPaste the whole JSON above — from { to } — into the console.\n'
          + 'Not just the signature: it covers the digest, the public key and\n'
          + 'the timestamp, so all of them are needed to check it.\n'));
    return;
  }

  if (cmd === 'prepare') {
    const statementFile = arg(argv, 'statement');
    let core: StatementCore;
    if (statementFile) {
      core = JSON.parse(readFileSync(statementFile, 'utf8')) as StatementCore;
    } else {
      const documentSha256 = resolveDigest(argv)
        ?? die('prepare needs --digest <hex>, --file <doc> or --statement <file>');
      const pubFile = arg(argv, 'public-key')
        ?? die('prepare needs --public-key <file> — the public half only; PEM, DER, base64, or a key file');
      const pub = readPublicKeySpki(pubFile);
      const algorithm = (arg(argv, 'algorithm') as StatementAlgorithm | undefined)
        ?? pub.algorithm ?? inferAlgorithm(pub.spkiBase64)
        ?? die('cannot tell ES256 from RS256 from this key — pass --algorithm');
      if (algorithm !== 'ES256' && algorithm !== 'RS256') die(`unsupported algorithm: ${algorithm}`);
      core = buildStatement({
        documentSha256,
        ...(arg(argv, 'content-type') ? { contentType: arg(argv, 'content-type')! } : {}),
        keyId: arg(argv, 'key-id') ?? await deriveKeyId(pub.spkiBase64),
        algorithm,
        publicKeySpkiBase64: pub.spkiBase64,
        issuedAt: new Date().toISOString(),
      });
    }

    const input = statementSigningInput(core);
    const inputOut = arg(argv, 'input-out') ?? 'signing-input.bin';
    writeFileSync(inputOut, input);
    let statementOut = statementFile;
    if (!statementOut) {
      statementOut = arg(argv, 'out') ?? 'prepared.json';
      writeFileSync(statementOut, `${JSON.stringify(core, null, 2)}\n`);
    }

    process.stderr.write(
      `statement   ${statementOut}\n`
      + `sign these  ${inputOut}  (${input.length} bytes)\n\n`
      + `Sign that file where the key lives — ${core.issuer.algorithm === 'ES256'
        ? 'ECDSA P-256 over SHA-256' : 'RSA PKCS#1 v1.5 over SHA-256'} — then:\n`
      + `  attest-sign assemble --statement ${statementOut} --signature <sigfile>\n`);
    return;
  }

  if (cmd === 'assemble') {
    const statementFile = arg(argv, 'statement')
      ?? die('assemble needs --statement <file> from `prepare`');
    const sigFile = arg(argv, 'signature')
      ?? die('assemble needs --signature <file> — raw r‖s or DER, as binary, base64 or hex');
    const core = JSON.parse(readFileSync(statementFile, 'utf8')) as StatementCore;
    const signatureBytes = readSignatureBytes(sigFile);

    // The closure ignores the input bytes on purpose: the signature already
    // exists. Routing through the same path as a live signer buys the DER
    // normalisation and the verify-before-emit for free.
    const signed = await signPreparedStatementWith(
      { algorithm: core.issuer.algorithm, sign: () => signatureBytes }, core);

    const text = `${JSON.stringify(signed, null, 2)}\n`;
    const out = arg(argv, 'out');
    if (out) writeFileSync(out, text);
    else process.stdout.write(text);

    process.stderr.write(
      `\nsignature verified against the statement's public key.\n`
      + `anchor leaf  ${statementLeaf(signed)}\n`
      + (out ? `written to   ${out}\n` : '')
      + '\nPaste the whole statement into the console, or send it as\n'
      + '{ "statement": ... } to POST /v1/attestations/signed.\n');
    return;
  }

  die(`unknown command: ${cmd}\n\n${USAGE}`);
}

void main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
