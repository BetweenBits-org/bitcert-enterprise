#!/usr/bin/env node
/**
 * attest-remit — the bank adapter from a terminal.
 *
 *   inspect   read a SWIFT message and show the instruction it would become
 *   submit    send one message
 *   status    where a payment stands, as an ISO 20022 status
 *   run       the folder adapter: messages in, status reports out
 *   keygen    make a signing key pair (and register its public half)
 *
 * Runs from the extracted download with Node 22.18 or later, no install:
 *   node packages/attest-remit/src/cli.ts inspect packages/attest-remit/samples/pacs008.sample.xml
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FolderAdapter, describeMapping, supplementFrom } from './adapter.ts';
import { RemitApiError, RemitClient } from './client.ts';
import type { RemitClientOptions, ReviewAssertions } from './client.ts';
import { generateSigningKey, registerIssuerKey } from './keys.ts';
import { SignerError, commandSigner, splitCommand } from './signer.ts';
import { SwiftMappingError, mapSwiftPayment } from './swift/mapping.ts';
import type { PartySupplement } from './swift/mapping.ts';
import { SwiftMessageError } from './swift/model.ts';
import { parseSwiftMessage } from './swift/parse.ts';
import { buildPacs002, swiftStatusOf } from './swift/status.ts';
import { verifyEvidencePackage } from './verify.ts';

const USAGE = `attest-remit — bank adapter for cross-border settlement

usage: node packages/attest-remit/src/cli.ts <command> [options]

commands
  inspect <message-file>     show what a SWIFT message (MT103, pacs.008, pain.001) would
                             become: every value and where it came from, what is missing,
                             what is not carried. Offline — nothing is signed or sent.
  submit <message-file>      turn the message into a signed instruction and send it
  status <payment-id>        the payment's status (add --pacs002 for the status report).
                             Reads only: no signing key is needed or touched.
  run                        folder adapter: take messages from --inbox, write status
                             reports and evidence to --outbox, until stopped
  keygen                     create an ES256 signing key pair; --register sends the
                             public half to the platform

connection (submit, status, run, keygen --register)
  --core <origin>            platform origin                   [env STONEHASH_CORE]
  --api-key <key>            API key                           [env STONEHASH_API_KEY]
  --institution <id>         your institution id               [env STONEHASH_INSTITUTION]
  --name <text>              your institution's name           (default: the id)
  --key <file>               signing key, PEM (a key on disk — sandbox)
  --sign-command "<cmd …>"   or a command that signs standard input with the key
                             (HSM / KMS), together with
  --public-key <file>          the public half of that key, PEM
  --config <file.json>       the same settings in a file; flags win over it

message handling
  --parties <file.json>      customer-master extract keyed by the debtor's account,
                             for what the message does not carry
  --index <n>                which transaction, when a message carries several (from 0)
  --travel-rule <A|B>        A: the platform encrypts the party data (default)
                             B: this adapter encrypts it; the platform cannot read it
  --wait                     submit: follow the payment until it finishes or pauses.
                             Exit status: 0 credited and evidence re-verified · 3 not paid
                             (refused, cancelled, returned) · 4 waiting on someone
  --out <dir>                submit --wait: write status reports and evidence here
  --inbox <dir>              run: where messages are dropped
  --outbox <dir>             run: where results are written
  --once                     run: stop when everything dropped so far has finished
  --pacs002                  status: print the pacs.002 status report (XML)
  --out <file>               keygen: where to write the private key (default bank-signing.key)
  --register                 keygen: register the public half (needs --core and --api-key)
  --label <text>             keygen --register: a label for the key
`;

class UsageError extends Error {}

interface Settings {
  core?: string; apiKey?: string; apiKeyEnv?: string; institution?: string; name?: string;
  key?: string; signCommand?: string[] | string; publicKey?: string;
  parties?: string; travelRule?: string; inbox?: string; outbox?: string;
  review?: ReviewAssertions;
}

function loadSettings(v: Record<string, string | boolean | undefined>): Settings {
  let file: Settings = {};
  if (typeof v.config === 'string') {
    let text: string;
    try {
      text = readFileSync(v.config, 'utf8');
    } catch (e) {
      throw new UsageError(`--config ${v.config}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      file = JSON.parse(text) as Settings;
    } catch {
      // The parser's own message quotes the text around the error — which, in
      // a settings file, may be a key.
      throw new UsageError(`--config ${v.config}: the file is not valid JSON`);
    }
    if (file === null || typeof file !== 'object' || Array.isArray(file)) {
      throw new UsageError(`--config ${v.config}: the file must hold a JSON object`);
    }
  }
  const s = (flag: string): string | undefined => (typeof v[flag] === 'string' ? v[flag] as string : undefined);
  const env = process.env;
  const out: Settings = { ...file };
  const set = <K extends keyof Settings>(k: K, value: Settings[K] | undefined): void => {
    if (value !== undefined && value !== '') out[k] = value;
  };
  set('core', s('core') ?? file.core ?? env.STONEHASH_CORE);
  set('apiKey', s('api-key') ?? file.apiKey ?? env[file.apiKeyEnv ?? 'STONEHASH_API_KEY']);
  set('institution', s('institution') ?? file.institution ?? env.STONEHASH_INSTITUTION);
  set('name', s('name') ?? file.name);
  set('key', s('key') ?? file.key);
  set('signCommand', s('sign-command') ?? file.signCommand);
  set('publicKey', s('public-key') ?? file.publicKey);
  set('parties', s('parties') ?? file.parties);
  set('travelRule', s('travel-rule') ?? file.travelRule);
  set('inbox', s('inbox') ?? file.inbox);
  set('outbox', s('outbox') ?? file.outbox);
  if (out.core) {
    let url: URL;
    try { url = new URL(out.core); } catch { throw new UsageError('--core is not a URL (expected https://… or http://…)'); }
    if (!/^https?:$/.test(url.protocol)) throw new UsageError('--core is not an http(s) URL');
    // The API key is the credential, and it goes in a header. A URL with a
    // user and password in it ends up in logs and error messages.
    if (url.username || url.password) throw new UsageError('--core must not carry a user name or password — the API key is the credential');
  }
  return out;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === '') throw new UsageError(`${what} is required`);
  return value;
}

function clientFrom(st: Settings, opts: { readOnly?: boolean } = {}): RemitClient {
  const base: Omit<RemitClientOptions, 'key' | 'signer'> = {
    core: need(st.core, '--core (or STONEHASH_CORE)'),
    apiKey: need(st.apiKey, '--api-key (or STONEHASH_API_KEY)'),
    institutionId: need(st.institution, '--institution (or STONEHASH_INSTITUTION)'),
    institutionName: st.name ?? st.institution!,
  };
  // Reading a status signs nothing: the key stays where it is, whatever was configured.
  if (opts.readOnly) return new RemitClient({ ...base, readOnly: true });
  if (st.signCommand) {
    let command: string[];
    try {
      command = Array.isArray(st.signCommand) ? st.signCommand : splitCommand(st.signCommand);
    } catch (e) {
      throw new UsageError(`--sign-command: ${e instanceof Error ? e.message : e}`);
    }
    const publicKey = readFileSync(need(st.publicKey, '--public-key (the public half of the key the command signs with)'), 'utf8');
    return new RemitClient({ ...base, signer: commandSigner({ publicKey, command }) });
  }
  const keyFile = need(st.key, '--key <file.pem>, or --sign-command with --public-key');
  return new RemitClient({ ...base, key: createPrivateKey(readFileSync(keyFile, 'utf8')) });
}

function partiesFrom(st: Settings): Record<string, PartySupplement> | undefined {
  if (!st.parties) return undefined;
  let text: string;
  try {
    text = readFileSync(st.parties, 'utf8');
  } catch (e) {
    throw new UsageError(`--parties ${st.parties}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const parsed = JSON.parse(text) as Record<string, PartySupplement> | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('not an object');
    return parsed;
  } catch {
    // Customer records are not echoed back in an error message.
    throw new UsageError(`--parties ${st.parties}: the file is not a JSON object keyed by account`);
  }
}

function travelRuleOf(st: Settings): 'A' | 'B' | undefined {
  if (st.travelRule === undefined) return undefined;
  if (st.travelRule !== 'A' && st.travelRule !== 'B') throw new UsageError('--travel-rule is A or B');
  return st.travelRule;
}

const indexOf = (v: Record<string, string | boolean | undefined>): number | undefined => {
  if (typeof v.index !== 'string') return undefined;
  if (!/^\d+$/.test(v.index)) throw new UsageError('--index is a number, from 0');
  return Number(v.index);
};

async function main(): Promise<number> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      core: { type: 'string' }, 'api-key': { type: 'string' }, institution: { type: 'string' },
      name: { type: 'string' }, key: { type: 'string' }, 'sign-command': { type: 'string' },
      'public-key': { type: 'string' }, config: { type: 'string' }, parties: { type: 'string' },
      index: { type: 'string' }, 'travel-rule': { type: 'string' }, wait: { type: 'boolean' },
      out: { type: 'string' }, inbox: { type: 'string' }, outbox: { type: 'string' },
      once: { type: 'boolean' }, pacs002: { type: 'boolean' }, register: { type: 'boolean' },
      label: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target] = positionals;
  if (v.help || !command) { console.log(USAGE); return v.help ? 0 : 1; }
  const st = loadSettings(v);

  if (command === 'inspect') {
    const file = need(target, 'a message file');
    const index = indexOf(v);
    const payment = parseSwiftMessage(readFileSync(file), index === undefined ? {} : { index });
    const supplement = supplementFrom(partiesFrom(st))?.(payment);
    // Offline, but told the same thing a submission would be: a message marked
    // as a test is taken with a test key only.
    const mapping = mapSwiftPayment(payment, {
      allowTestMessages: (st.apiKey ?? '').startsWith('sk_test_'),
      ...(supplement ? { supplement } : {}),
    });
    for (const line of describeMapping(mapping)) console.log(line);
    return mapping.issues.length === 0 ? 0 : 2;
  }

  if (command === 'keygen') {
    const out = typeof v.out === 'string' ? v.out : 'bank-signing.key';
    if (existsSync(out)) throw new UsageError(`${out} already exists — a signing key is never overwritten; choose another --out`);
    const key = generateSigningKey();
    try {
      // Created, never opened: a name that already exists — a file, or a link
      // pointing somewhere else — is refused rather than written through.
      writeFileSync(out, key.privateKeyPem, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new UsageError(`${out} already exists — a signing key is never overwritten; choose another --out`);
      }
      throw e;
    }
    const publicPem = createPublicKey(key.privateKeyPem).export({ format: 'pem', type: 'spki' }).toString();
    writeFileSync(`${out}.pub.pem`, publicPem);
    console.log(`private key  ${out}   (the only copy — the platform never sees it)`);
    console.log(`public key   ${out}.pub.pem`);
    console.log(`public key, base64 SPKI (paste into the console, or use --register):\n${key.publicKeySpkiBase64}`);
    if (v.register) {
      const r = await registerIssuerKey({
        core: need(st.core, '--core'), apiKey: need(st.apiKey, '--api-key'),
        publicKeySpkiBase64: key.publicKeySpkiBase64,
        ...(typeof v.label === 'string' ? { label: v.label } : {}),
      });
      console.log(`registered   ${r.id}${r.already ? ' (was already registered)' : ''} — select it when activating the product in the console`);
    }
    return 0;
  }

  if (command === 'status') {
    const client = clientFrom(st, { readOnly: true });
    const view = await client.status(need(target, 'a payment id'));
    if (v.pacs002) { process.stdout.write(buildPacs002(view)); return 0; }
    const s = swiftStatusOf(view);
    console.log(`${view.payment_id}  ${view.state}`);
    console.log(`status   ${s.code} — ${s.meaning}${s.reason ? `\nreason   ${s.reason}` : ''}`);
    for (const d of s.detail) console.log(`         ${d}`);
    if (s.creditReference) console.log(`credit   ${s.creditReference}`);
    return 0;
  }

  if (command === 'submit') {
    const file = need(target, 'a message file');
    const client = clientFrom(st);
    await client.assertRegistered();
    const index = indexOf(v);
    const supplement = supplementFrom(partiesFrom(st));
    const travelRule = travelRuleOf(st);
    const done = await client.submitSwift(readFileSync(file), {
      ...(index === undefined ? {} : { index }),
      ...(supplement ? { supplement } : {}),
      ...(st.review ? { review: st.review } : {}),
      ...(travelRule ? { travelRule } : {}),
    });
    for (const line of describeMapping(done.mapping)) console.log(line);
    console.log(`\npayment  ${done.paymentId}  ${done.already ? '(this message was submitted before — nothing sent)' : 'accepted'}  ${done.state}`);
    if (!v.wait) return 0;

    const outDir = typeof v.out === 'string' ? v.out : undefined;
    if (outDir) mkdirSync(outDir, { recursive: true });
    let lastCode = '';
    const view = await client.track(done.paymentId, {
      onState: (_state, current) => {
        const s = swiftStatusOf(current);
        const sig = `${s.code}/${s.reason ?? ''}`;
        if (sig === lastCode) return;
        lastCode = sig;
        console.log(`  → ${s.code}${s.reason ? ` (${s.reason})` : ''}   ${current.state}`);
        if (outDir) {
          const seq = String(current.events.at(-1)?.seq ?? 0).padStart(2, '0');
          writeFileSync(path.join(outDir, `${done.paymentId}.status-${seq}-${s.code}.xml`), buildPacs002(current));
        }
      },
    });
    const final = swiftStatusOf(view);
    for (const d of final.detail) console.log(`    ${d}`);
    if (view.state === 'EVIDENCE_ANCHORED') {
      const evidence = await client.evidence(done.paymentId);
      const report = await verifyEvidencePackage(evidence);
      console.log(`credited ${final.creditReference ?? ''}`);
      console.log(`evidence re-verified: ${report.checks.map((c) => `${c.name} ${c.ok ? 'ok' : 'FAILED'}`).join(' · ')}`);
      if (outDir) {
        writeFileSync(path.join(outDir, `${done.paymentId}.evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(`written to ${outDir}/`);
      }
      return report.verified ? 0 : 1;
    }
    console.log(`stopped at ${view.state} — ${final.code}${final.reason ? ` (${final.reason})` : ''}`);
    // The exit status says how it ended, for the script that called this:
    // 3 — the payment was not made (refused, cancelled, returned);
    // 4 — it is not finished and waits on someone (a question, a stopped payment).
    return final.final ? 3 : 4;
  }

  if (command === 'run') {
    const client = clientFrom(st);
    await client.assertRegistered();
    const parties = partiesFrom(st);
    const travelRule = travelRuleOf(st);
    const adapter = new FolderAdapter({
      client,
      inbox: need(st.inbox, '--inbox'),
      outbox: need(st.outbox, '--outbox'),
      ...(parties ? { parties } : {}),
      ...(st.review ? { review: st.review } : {}),
      ...(travelRule ? { travelRule } : {}),
    });
    const stop = new AbortController();
    process.on('SIGINT', () => stop.abort());
    process.on('SIGTERM', () => stop.abort());
    console.log(`adapter running — inbox ${st.inbox}  outbox ${st.outbox}${v.once ? '  (once)' : '  (Ctrl+C to stop)'}`);
    await adapter.run({ once: v.once === true, signal: stop.signal });
    return 0;
  }

  throw new UsageError(`unknown command "${command}"`);
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`${e.message}\n\nrun with --help for the options`);
    process.exitCode = 1;
  } else if (e instanceof SwiftMappingError) {
    for (const line of describeMapping(e.mapping)) console.error(line);
    process.exitCode = 2;
  } else if (e instanceof SwiftMessageError) {
    console.error(e.code === 'multiple_transactions'
      ? `${e.message.split(' — ')[0]} — add --index <n> (from 0) to choose one, or drop the file into the folder adapter's inbox (\`run\`), which takes each in turn`
      : `the message could not be read (${e.code}): ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof RemitApiError) {
    console.error(e.code === 'not_a_platform_answer'
      ? `the platform was not reached: ${e.message}`
      : `the platform refused (${e.status} ${e.code}): ${e.message}`);
    process.exitCode = 1;
  } else if (e instanceof SignerError) {
    console.error(`signing failed: ${e.message}`);
    process.exitCode = 1;
  } else {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
});
