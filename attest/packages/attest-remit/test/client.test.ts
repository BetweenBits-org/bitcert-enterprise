/**
 * The client against a platform that is not there: `fetch` is replaced by a
 * small stand-in that records what was sent, so these tests cover what the
 * SDK signs and sends — and need no service running.
 *
 * Two of them reach across into the platform's own source on purpose: the
 * Travel Rule message the SDK builds in mode B must be the one the platform
 * builds in mode A, and the JWE the SDK writes must open with the
 * platform's decryptor. A bank's ciphertext that only the SDK can read back
 * would prove nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import { keyring, verifyEvidenceSignatures } from '@stonehash/attest-rules';
import {
  RemitApiError, RemitClient, SignerError, SwiftMappingError, commandSigner, derToRaw, jwkThumbprint, parseSwiftMessage, parseSwiftMessages,
  readSignatureBytes, sha256hex, signWith, spkiOf, splitCommand, swiftContentDigest, swiftPaymentId, verifyEvent, signEvent,
} from '../src/index.ts';
import type { ExternalSigner, Quote, SettlementView } from '../src/index.ts';
import { FolderAdapter } from '../src/adapter.ts';
import { SourceLedger } from './support/source-ledger.ts';
import { decryptJwe } from '../../../apps/core/src/remit/jwe.ts';
import { buildIvms101 } from '../../../apps/core/src/remit/ivms101.ts';
import { fieldsAssertionProblem } from '../../../apps/core/src/remit/orchestrator.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sample = (name: string): Buffer => readFileSync(path.join(HERE, '..', 'samples', name));

const bank = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const bankSpki = spkiOf(bank.privateKey);
const bankPem = bank.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const platform = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const bfiEnc = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const QUOTE: Quote = {
  quote_id: 'QT-test', corridor: { origin: 'VN', destination: 'SG' },
  trade: { currency: 'USD', amount: '12500.00' },
  settlement: { asset: 'USDC', amount: '12500.00', chain: 'eip155:31337' },
  collect: { currency: 'VND', amount: '322537500', rate: '25803', rate_pair: 'USD/VND' },
  payout: { currency: 'SGD', amount: '16687.50', rate: '1.3350', rate_pair: 'USD/SGD' },
  fees: [{ type: 'platform', currency: 'USD', amount: '0.50' }],
  quoted_at: '2026-11-17T00:00:00.000Z', expires_at: '2026-11-17T00:10:00.000Z',
  required_travel_rule_fields: ['originator.name', 'originator.country', 'originator.address',
    'originator.registration_number', 'beneficiary.name', 'beneficiary.country', 'beneficiary.account', 'beneficiary.bank'],
};
const META = {
  platform_signer: { key_id: 'STONEHASH-SIGN-test', spki: spkiOf(platform.privateKey) },
  institutions: [
    { id: 'VN-BANK-T1', role: 'COLLECTION_BANK', name: 'Test Bank (VN)', country: 'VN', signing_spki: bankSpki },
    { id: 'SG-BFI-001', role: 'BENEFICIARY_FI', name: 'Test BFI', country: 'SG',
      encryption_jwk: bfiEnc.publicKey.export({ format: 'jwk' }) },
    { id: 'SETTLE-ENTITY-001', role: 'SETTLEMENT_ENTITY', name: 'Test Settlement Entity', country: null },
  ],
};
const PARTIES = {
  debtor: { name: 'Vina Trading Co., Ltd.', country: 'VN', address: '12 Le Loi', registration_number: '0312345678', account: 'VN-ACC-1' },
  creditor: { name: 'Pacific Supply Pte Ltd', country: 'SG', account: 'SG-ACC-9', bank: 'Demo Payout Bank' },
};

interface Call { method: string; path: string; query: string; body: Record<string, unknown> | undefined; idem: string | undefined }

/** A stand-in platform: quotes, accepts settlements, remembers them. */
function fakePlatform(): {
  calls: Call[]; settlements: Map<string, SettlementView>; restore: () => void;
  /** Something in between answers instead of the platform: a block page, served with 200. */
  inTheWay: { on: boolean };
  /** Settlements that were on the platform before it kept one settlement per message. */
  fromBefore: (views: SettlementView[]) => Promise<void>;
} {
  const calls: Call[] = [];
  const settlements = new Map<string, SettlementView>();
  // One message, one settlement: the platform's own store decides, on a database of its own.
  let opened: Promise<SourceLedger> | null = null;
  const ledger = (): Promise<SourceLedger> => (opened ??= SourceLedger.open());
  const inTheWay = { on: false };
  const real = globalThis.fetch;
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, query: url.searchParams.toString(), body, idem: headers['idempotency-key'] });
    if (inTheWay.on) {
      return new Response('<html><body>Request blocked</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/v1/remit/meta') return reply(200, META);
    if (url.pathname === '/v1/quotes') {
      return reply(201, { ...QUOTE, trade: { currency: 'USD', amount: Number((body!.trade as { amount: string }).amount).toFixed(2) } });
    }
    if (method === 'POST' && url.pathname === '/v1/settlements') {
      const id = body!.payment_id as string;
      const refusal = await (await ledger()).accept(id, body!.evidence_elements);
      if (refusal) return reply(refusal.status, refusal.body);
      settlements.set(id, {
        payment_id: id, state: 'BANK_AUTHORIZED', evidence_level: null, evidence_available: false,
        chain_tx: null, attestation: null,
        events: [{ seq: 0, type: 'REQUEST_ACCEPTED', issuer: 'STONEHASH', at: '2026-11-17T00:00:00.000Z', payload: {}, sig: null },
          { seq: 1, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'VN-BANK-T1', at: '2026-11-17T00:00:00.100Z',
            payload: body!.evidence_elements, sig: null }],
      });
      return reply(202, { payment_id: id, state: 'BANK_AUTHORIZED' });
    }
    if (method === 'GET' && url.pathname === '/v1/settlements') {
      // The exact lookups (`source_uetr`, `source_content`): answered by the platform's own store.
      if (url.searchParams.has('source_uetr') || url.searchParams.has('source_content') || url.searchParams.has('source_value_date')) {
        const page = await (await ledger()).list(url.searchParams);
        if ('status' in page) return reply(page.status, page.body);
        const found = page.ids.map((id) => settlements.get(id)!).map((v) => ({ payment_id: v.payment_id, state: v.state }));
        return reply(200, { data: found, page: { total: page.total, returned: found.length, next_cursor: page.nextCursor } });
      }
      // The ledger search, the way the platform does it: a case-folded "contains"
      // over the payment id and the references of the message it was made from.
      const q = (url.searchParams.get('q') ?? '').toUpperCase();
      const rows = [...settlements.values()].filter((v) => {
        const src = (v.events[1]?.payload as { bankInstruction?: { sourceMessage?: Record<string, unknown> } } | undefined)
          ?.bankInstruction?.sourceMessage ?? {};
        return v.payment_id.toUpperCase().includes(q)
          || ['uetr', 'instructionId', 'endToEndId', 'messageId'].some((k) => String(src[k] ?? '').toUpperCase().includes(q));
      }).map((v) => ({ payment_id: v.payment_id, state: v.state }));
      return reply(200, { data: rows, page: { total: rows.length, returned: rows.length, next_cursor: null } });
    }
    const cancel = /^\/v1\/settlements\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === 'POST' && cancel) {
      const hit = settlements.get(decodeURIComponent(cancel[1]!));
      if (!hit) return reply(404, { error: 'not_found', message: 'no such settlement' });
      if (hit.state === 'CANCELLED') return reply(409, { error: 'not_cancellable', message: 'the settlement is already CANCELLED' });
      hit.state = 'CANCELLED';
      return reply(200, { payment_id: hit.payment_id, state: 'CANCELLED' });
    }
    const one = /^\/v1\/settlements\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && one) {
      const hit = settlements.get(decodeURIComponent(one[1]!));
      return hit ? reply(200, hit) : reply(404, { error: 'not_found', message: 'no such settlement' });
    }
    return reply(404, { error: 'not_found', message: url.pathname });
  }) as typeof fetch;
  const fromBefore = async (views: SettlementView[]): Promise<void> => {
    for (const v of views) settlements.set(v.payment_id, v);
    await (await ledger()).addFromBefore(views);
  };
  return { calls, settlements, inTheWay, fromBefore, restore: () => { globalThis.fetch = real; } };
}

const client = (extra: { key?: typeof bank.privateKey; signer?: ExternalSigner }): RemitClient => new RemitClient({
  core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank', ...extra,
});

async function elementsVerify(body: Record<string, unknown>): Promise<string[]> {
  const ring = keyring([{ keyId: 'VN-BANK-T1', issuer: 'Test Bank', trustLevel: 'ATTESTED',
    publicKeyJwk: createPublicKey(bank.privateKey).export({ format: 'jwk' }) as JsonWebKey }]);
  const checked = await verifyEvidenceSignatures({
    schemaVersion: 'settlement-evidence/0.1', scenario: 't', dataMode: 'SYNTHETIC', notRealPayment: true,
    elements: body.evidence_elements,
  } as never, ring);
  return Object.values(checked.elements as Record<string, { signature: { status: string } }>).map((e) => e.signature.status);
}

// ── Signers ────────────────────────────────────────────────────────────────

test('a client needs exactly one way to sign', () => {
  assert.throws(() => new RemitClient({ core: 'x', apiKey: 'k', institutionId: 'i', institutionName: 'n' }), /signing key/);
  assert.throws(() => client({ key: bank.privateKey, signer: { publicKey: bankPem, sign: () => new Uint8Array(64) } }), /not both/);
});

test('a read-only client follows payments without holding a key, and sends nothing', async () => {
  const net = fakePlatform();
  try {
    const sent = await client({ key: bank.privateKey }).submitSwift(sample('pacs008.sample.xml'));
    const before = net.calls.length;

    const base = { core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank' };
    const reader = new RemitClient({ ...base, readOnly: true });
    assert.equal((await reader.status(sent.paymentId)).state, 'BANK_AUTHORIZED');
    assert.equal((await reader.swiftStatus(sent.paymentId)).code, 'ACTC');
    assert.match(await reader.statusReport(sent.paymentId), /<TxSts>ACTC<\/TxSts>/);
    assert.equal((await reader.list({ q: sent.paymentId })).data.length, 1);
    assert.ok((await reader.inspectSwift(sample('pacs008.sample.xml'))).input, 'reading a message needs no key');

    // Whatever would sign or send stops here, before anything leaves this machine.
    await assert.rejects(reader.submitSwift(sample('mt103.structured.sample.txt')), /read-only/);
    await assert.rejects(reader.instructionFromSwift(sample('mt103.structured.sample.txt')), /read-only/);
    await assert.rejects(reader.quote('100.00'), /read-only/);
    await assert.rejects(reader.cancel(sent.paymentId, 'changed our mind'), /read-only/);
    await assert.rejects(reader.assertRegistered(), /read-only/);
    assert.throws(() => reader.publicKey(), /read-only/);
    assert.deepEqual([...new Set(net.calls.slice(before).map((x) => x.method))], ['GET'], 'only reads were sent');
    assert.equal(net.settlements.get(sent.paymentId)!.state, 'BANK_AUTHORIZED', 'and the payment is as it was');

    // A key handed to a client that is declared read-only is a mistake, said at once.
    assert.throws(() => new RemitClient({ ...base, readOnly: true, key: bank.privateKey }), /holds no signing key/);
  } finally { net.restore(); }
});

test('commandSigner takes a list of arguments, and says so when handed a shell line', () => {
  // `'openssl dgst -sha256 -sign key.pem'` used to be taken apart letter by letter and fail as `spawn o ENOENT`.
  assert.throws(() => commandSigner({ publicKey: bankPem, command: 'openssl dgst -sha256 -sign key.pem' as unknown as string[] }),
    (e: unknown) => e instanceof SignerError && /list of arguments/.test(e.message) && /splitCommand/.test(e.message));
  assert.deepEqual(splitCommand('openssl dgst -sha256 -sign "my key.pem"'), ['openssl', 'dgst', '-sha256', '-sign', 'my key.pem']);
});

test('external signatures are accepted raw or DER, and checked before they are used', async () => {
  const bytes = Buffer.from('bytes to sign');
  const raw: ExternalSigner = { publicKey: bankSpki, sign: (b) => cryptoSign('sha256', b, { key: bank.privateKey, dsaEncoding: 'ieee-p1363' }) };
  const der: ExternalSigner = { publicKey: bankPem, sign: async (b) => cryptoSign('sha256', b, bank.privateKey) };
  assert.equal((await signWith(raw, bytes)).length, 64);
  const fromDer = await signWith(der, bytes);
  assert.equal(fromDer.length, 64);
  assert.deepEqual(derToRaw(cryptoSign('sha256', bytes, bank.privateKey))!.length, 64);
  assert.equal(derToRaw(new Uint8Array([1, 2, 3])), null);

  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const wrongKey: ExternalSigner = { publicKey: bankSpki, sign: (b) => cryptoSign('sha256', b, other.privateKey) };
  await assert.rejects(signWith(wrongKey, bytes), (e: unknown) => e instanceof SignerError && /does not verify/.test(e.message));
  await assert.rejects(signWith({ publicKey: bankSpki, sign: () => new Uint8Array(10) }, bytes), /neither a raw/);
  await assert.rejects(signWith({ publicKey: bankSpki, sign: () => { throw new Error('slot locked'); } }, bytes), /slot locked/);
  await assert.rejects(signWith({ publicKey: 'not a key', sign: () => new Uint8Array(64) }, bytes), SignerError);

  // What a command prints: binary, base64 or hex.
  const sig = cryptoSign('sha256', bytes, bank.privateKey);
  assert.deepEqual(Buffer.from(readSignatureBytes(sig)), sig);
  assert.deepEqual(Buffer.from(readSignatureBytes(Buffer.from(sig.toString('base64') + '\n'))), sig);
  assert.deepEqual(Buffer.from(readSignatureBytes(Buffer.from(sig.toString('hex')))), sig);
});

test('commandSigner: OpenSSL as the stand-in for an HSM', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { t.skip('openssl is not installed'); return; }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remit-signer-'));
  const keyFile = path.join(dir, 'hsm.key');
  writeFileSync(keyFile, bank.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const signer = commandSigner({ publicKey: bankPem, command: ['openssl', 'dgst', '-sha256', '-sign', keyFile] });
  const sig = await signWith(signer, Buffer.from('instruction bytes'));
  assert.equal(sig.length, 64);
  const failing = commandSigner({ publicKey: bankPem, command: ['openssl', 'dgst', '-sha256', '-sign', path.join(dir, 'missing.key')] });
  await assert.rejects(signWith(failing, Buffer.from('x')), /exited with status/);

  // A command given as one line: quotes keep an argument whole, and nothing else is special.
  assert.deepEqual(splitCommand(`pkcs11-tool --sign --id 01 --label "Bank Signing Key" -m 'ECDSA-SHA256'`),
    ['pkcs11-tool', '--sign', '--id', '01', '--label', 'Bank Signing Key', '-m', 'ECDSA-SHA256']);
  assert.deepEqual(splitCommand('  a   ""  b '), ['a', '', 'b']);
  assert.deepEqual(splitCommand('sign $HOME;rm -rf x'), ['sign', '$HOME;rm', '-rf', 'x'], 'no shell: nothing is expanded or run');
  assert.throws(() => splitCommand('sign "unclosed'), SignerError);
  const spaced = path.join(dir, 'key with space.pem');
  writeFileSync(spaced, bank.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const viaLine = commandSigner({ publicKey: bankPem, command: splitCommand(`openssl dgst -sha256 -sign "${spaced}"`) });
  assert.equal((await signWith(viaLine, Buffer.from('instruction bytes'))).length, 64);

  // A tool that hangs is stopped together with whatever it started, and a tool that floods is cut off.
  const hung = commandSigner({ publicKey: bankPem, command: ['sh', '-c', 'sleep 47.3 & wait'], timeoutMs: 300 });
  await assert.rejects(signWith(hung, Buffer.from('x')), /did not answer within 300 ms/);
  await new Promise((ok) => setTimeout(ok, 200));
  let left = '';
  try { left = execFileSync('pgrep', ['-f', '^sleep 47[.]3$'], { encoding: 'utf8' }); } catch { /* none: pgrep exits 1 */ }
  assert.equal(left.trim(), '', 'the tool the wrapper started is gone too');
  const flood = commandSigner({ publicKey: bankPem, command: ['sh', '-c', 'yes signature | head -c 3000000'] });
  await assert.rejects(signWith(flood, Buffer.from('x')), /not a signature/);
});

// ── Instructions ───────────────────────────────────────────────────────────

test('an instruction built through an external signer verifies exactly like one built with a key', async () => {
  const signer: ExternalSigner = { publicKey: bankSpki, sign: (b) => cryptoSign('sha256', b, bank.privateKey) };
  const viaSigner = await client({ signer }).buildInstructionAsync(QUOTE, PARTIES, { paymentId: 'PAY-1' });
  const viaKey = client({ key: bank.privateKey }).buildInstruction(QUOTE, PARTIES, { paymentId: 'PAY-1' });
  for (const built of [viaSigner, viaKey]) {
    assert.deepEqual(await elementsVerify(built.body), ['VALID', 'VALID', 'VALID']);
    assert.equal(verifyEvent(built.body.bank_authorization, built.body.bank_signature as never, bankSpki), true);
  }
  assert.deepEqual(Object.keys(viaSigner.body).sort(), Object.keys(viaKey.body).sort());
  // The synchronous form cannot reach an external signer, and says what to call instead.
  assert.throws(() => client({ signer }).buildInstruction(QUOTE, PARTIES), /buildInstructionAsync/);
  // The defaults of a first run are still what they were.
  const el = (viaKey.body.evidence_elements as { bankInstruction: { iso20022Fields: string[]; sourceMessage?: unknown } }).bankInstruction;
  assert.deepEqual(el.iso20022Fields.slice(0, 5), ['Dbtr', 'Cdtr', 'InstdAmt', 'Ccy', 'RmtInf']);
  assert.equal(el.sourceMessage, undefined);
});

test('the bank\'s own review results replace the sandbox defaults', () => {
  const { body } = client({ key: bank.privateKey }).buildInstruction(QUOTE, PARTIES, {
    paymentId: 'PAY-2', purposeCode: 'GDDS', instructionRef: 'BANK-REF-9',
    review: { kybStatus: 'VERIFIED', kybPolicyVersion: '2026.3', regulatorReportRef: 'SBV-C27-001', approvedByRole: 'Head of Trade Ops', fiatReceivedRef: 'RCPT-77' },
  });
  const auth = body.bank_authorization as Record<string, string>;
  assert.deepEqual([auth.instruction_ref, auth.kyb_policy_version, auth.purpose_code, auth.fiat_received_ref],
    ['BANK-REF-9', '2026.3', 'GDDS', 'RCPT-77']);
  const approval = (body.evidence_elements as { bankApproval: Record<string, string> }).bankApproval;
  assert.deepEqual([approval.regulatorReportRef, approval.approvedByRole], ['SBV-C27-001', 'Head of Trade Ops']);
  assert.equal((body.compliance_payload as { purpose_code: string }).purpose_code, 'GDDS');
});

test('Travel Rule mode B: the SDK\'s message is the platform\'s, and its ciphertext opens with the platform\'s code', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const { body } = await c.buildInstructionAsync(QUOTE, PARTIES, { paymentId: 'PAY-B', travelRule: 'B', purposeCode: 'GDDS' });
    const cp = body.compliance_payload as {
      mode: string; ciphertext: string; ivms101_digest: string; originator?: unknown;
      fields_assertion: { payload: Record<string, unknown>; sig: never };
    };
    assert.equal(cp.mode, 'B');
    assert.equal(cp.originator, undefined, 'no plaintext party data leaves in mode B');
    assert.ok(!JSON.stringify(body.compliance_payload).includes('0312345678'));

    const opened = JSON.parse(decryptJwe(cp.ciphertext, bfiEnc.privateKey).toString('utf8')) as JcsValue;
    assert.equal(sha256hex(jcs(opened)), cp.ivms101_digest);
    // Field for field what the platform's relay builds from the same inputs in mode A.
    const platformBuilds = buildIvms101({ originator: PARTIES.debtor, beneficiary: PARTIES.creditor, purpose_code: 'GDDS' }, {
      paymentId: 'PAY-B', tradeAmount: '12500.00', tradeCurrency: 'USD',
      originatingInstitution: { id: 'VN-BANK-T1', name: 'Test Bank (VN)', country: 'VN' },
      beneficiaryInstitution: { id: 'SG-BFI-001', name: 'Test BFI', country: 'SG' },
      settlementEntity: { id: 'SETTLE-ENTITY-001', name: 'Test Settlement Entity' },
      usdcAmount: '12500.00',
    });
    assert.equal(sha256hex(jcs(platformBuilds as JcsValue)), cp.ivms101_digest);

    assert.equal(verifyEvent(cp.fields_assertion.payload, cp.fields_assertion.sig, bankSpki), true);
    assert.deepEqual([cp.fields_assertion.payload.payment_id, cp.fields_assertion.payload.required_fields_present], ['PAY-B', true]);
    // The bank's statement is about this message and this ciphertext, and the
    // platform's own check accepts it — and refuses another ciphertext under it.
    assert.deepEqual([cp.fields_assertion.payload.ivms101_digest, cp.fields_assertion.payload.ciphertext_sha256],
      [cp.ivms101_digest, sha256hex(cp.ciphertext)]);
    const expect = { paymentId: 'PAY-B', ivms101Digest: cp.ivms101_digest, ciphertext: cp.ciphertext, bankSpki };
    assert.equal(fieldsAssertionProblem(cp.fields_assertion, expect), null);
    const another = await c.buildInstructionAsync(QUOTE, { ...PARTIES, creditor: { ...PARTIES.creditor, account: 'SG-ACC-ATTACKER' } }, { paymentId: 'PAY-B', travelRule: 'B' });
    const swapped = another.body.compliance_payload as { ciphertext: string; ivms101_digest: string };
    assert.match(fieldsAssertionProblem(cp.fields_assertion, { ...expect, ciphertext: swapped.ciphertext, ivms101Digest: swapped.ivms101_digest })!,
      /both must be the ones submitted/);
    // An LEI is typed as one on both sides, so the two messages stay the same message.
    const lei = { ...PARTIES, debtor: { ...PARTIES.debtor, registration_number: '9845003X7Y4K2B1Q8W63' } };
    const withLei = (await c.buildInstructionAsync(QUOTE, lei, { paymentId: 'PAY-L', travelRule: 'B', purposeCode: 'GDDS' })).body.compliance_payload as { ciphertext: string; ivms101_digest: string };
    assert.match(decryptJwe(withLei.ciphertext, bfiEnc.privateKey).toString('utf8'), /"nationalIdentifierType":"LEIX"/);
    assert.equal(withLei.ivms101_digest, sha256hex(jcs(buildIvms101({ originator: lei.debtor, beneficiary: lei.creditor, purpose_code: 'GDDS' }, {
      paymentId: 'PAY-L', tradeAmount: '12500.00', tradeCurrency: 'USD',
      originatingInstitution: { id: 'VN-BANK-T1', name: 'Test Bank (VN)', country: 'VN' },
      beneficiaryInstitution: { id: 'SG-BFI-001', name: 'Test BFI', country: 'SG' },
      settlementEntity: { id: 'SETTLE-ENTITY-001', name: 'Test Settlement Entity' }, usdcAmount: '12500.00',
    }) as JcsValue)));
    assert.throws(() => c.buildInstruction(QUOTE, PARTIES, { travelRule: 'B' }), /buildInstructionAsync/);

    // The key the message is encrypted to is the one the bank expects — when the bank says which.
    const jwk = bfiEnc.publicKey.export({ format: 'jwk' });
    const pinned = (thumbprint: string): RemitClient => new RemitClient({
      core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank',
      key: bank.privateKey, beneficiaryKeys: { 'SG-BFI-001': thumbprint },
    });
    assert.match(jwkThumbprint(jwk), /^[A-Za-z0-9_-]{43}$/);
    await pinned(jwkThumbprint(jwk)).buildInstructionAsync(QUOTE, PARTIES, { paymentId: 'PAY-P', travelRule: 'B' });
    const strangers = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    await assert.rejects(pinned(jwkThumbprint(strangers)).buildInstructionAsync(QUOTE, PARTIES, { paymentId: 'PAY-P', travelRule: 'B' }),
      (e: unknown) => e instanceof RemitApiError && e.code === 'bfi_key_mismatch' && /nothing was encrypted/.test(e.message));
  } finally { net.restore(); }
});

test('the bank signs the quote it asked for, and no other', async () => {
  const net = fakePlatform();
  const real = globalThis.fetch;
  try {
    const c = client({ key: bank.privateKey });
    // A quote that comes back for another amount, or another route, is not signed.
    for (const wrong of [{ trade: { currency: 'USD', amount: '99999.00' } }, { corridor: { origin: 'VN', destination: 'US' } }, { payout: { ...QUOTE.payout, currency: 'USD' } }]) {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (String(input).endsWith('/v1/quotes')
        ? new Response(JSON.stringify({ ...QUOTE, ...wrong }), { status: 201, headers: { 'content-type': 'application/json' } })
        : real(input as never, init))) as typeof fetch;
      await assert.rejects(c.submitSwift(sample('pacs008.sample.xml')),
        (e: unknown) => e instanceof RemitApiError && e.code === 'quote_mismatch' && /nothing was signed/.test(e.message), JSON.stringify(wrong));
    }
    assert.equal(net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length, 0);
  } finally { globalThis.fetch = real; net.restore(); }
});

// ── From a SWIFT message ───────────────────────────────────────────────────

test('submitSwift: one message becomes one settlement, however many times it is handed over', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const first = await c.submitSwift(sample('pacs008.sample.xml'));
    assert.equal(first.already, false);
    assert.match(first.paymentId, /^PAY-3f1c9a52-[0-9a-f]{10}$/);
    const posted = net.calls.find((x) => x.method === 'POST' && x.path === '/v1/settlements')!;
    assert.equal(posted.idem, `swift-${first.paymentId}`);
    const body = posted.body!;
    assert.deepEqual(await elementsVerify(body), ['VALID', 'VALID', 'VALID']);
    const instr = (body.evidence_elements as { bankInstruction: Record<string, unknown> }).bankInstruction;
    assert.equal(instr.ref, first.paymentId);
    assert.equal((instr.sourceMessage as { uetr: string }).uetr, '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10');
    assert.equal((instr.sourceMessage as { sha256: string }).sha256, sha256hex(sample('pacs008.sample.xml')));
    assert.ok((instr.iso20022Fields as string[]).includes('UETR') && (instr.iso20022Fields as string[]).includes('INV-2026-0457'));
    const auth = body.bank_authorization as Record<string, string>;
    assert.deepEqual([auth.instruction_ref, auth.purpose_code, auth.uetr], ['OUT-2026-000123', 'GDDS', '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10']);
    assert.equal((body.commercial_reference as { invoice_ref: string }).invoice_ref, 'INV-2026-0457');
    assert.deepEqual((body.compliance_payload as { originator: unknown }).originator, {
      name: 'Vina Trading Co., Ltd.', country: 'VN', address: 'Le Loi Boulevard 12, District 1, Ho Chi Minh City',
      registration_number: '0312345678', account: 'VN-ACC-000777',
    });

    // Again — the same file, then the same payment re-exported with different whitespace.
    const posts = (): number => net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    const again = await c.submitSwift(sample('pacs008.sample.xml'));
    const reexport = await c.submitSwift(sample('pacs008.sample.xml').toString('utf8').replace(/\n\s+/g, '\n'));
    assert.deepEqual([again.already, again.paymentId, reexport.already, reexport.paymentId],
      [true, first.paymentId, true, first.paymentId]);
    assert.equal(posts(), 1, 'nothing was sent the second and third time');

    // A different payment that someone forces onto the same id is refused, not merged.
    await assert.rejects(c.submitSwift(sample('pain001.sample.xml'), { paymentId: first.paymentId }), /different message/);

    // The worst case: a sender reuses the UETR on another payment. It must not be
    // answered "already submitted" — that would lose the second payment silently.
    const reused = sample('pacs008.sample.xml').toString('utf8').replaceAll('12500.00', '9900.00');
    await assert.rejects(c.submitSwift(reused),
      (e: unknown) => e instanceof RemitApiError && e.code === 'reference_reused' && /nothing was sent/.test(e.message));
    const otherCreditor = sample('pacs008.sample.xml').toString('utf8').replace('<Nm>Pacific Supply Pte Ltd</Nm>', '<Nm>Another Exporter Pte Ltd</Nm>');
    await assert.rejects(c.submitSwift(otherCreditor), (e: unknown) => e instanceof RemitApiError && e.code === 'reference_reused');
    assert.equal(posts(), 1, 'and nothing was posted for either');
  } finally { net.restore(); }
});

test('submitSwift: a reference that comes back on another payment is never taken for a repeat', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const posts = (): number => net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    const reused = (message: string, opts: { index?: number } = {}): Promise<void> => assert.rejects(c.submitSwift(message, opts),
      (e: unknown) => e instanceof RemitApiError && e.code === 'reference_reused' && /nothing was sent/.test(e.message));
    const xml = sample('pacs008.sample.xml').toString('utf8');
    assert.equal((await c.submitSwift(xml)).already, false);

    // The UETR copied from a template. Amount and names are the same; what
    // differs is what a name-and-amount comparison never looked at.
    await reused(xml.replace('INV-2026-0457', 'INV-2026-0999'));
    await reused(xml.replace('SG-ACC-000009', 'SG-ACC-000010'));
    await reused(xml.replace('OUT-2026-000123', 'OUT-2026-000999').replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000001'));
    assert.equal(posts(), 1);

    // One file, two transactions under one UETR.
    const fresh = xml.replaceAll('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '77777777-7b0e-4d6a-9c1f-2e8b5a7d4c10');
    const block = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(fresh)![0];
    const twoInvoices = fresh.replace(block, block + block.replace('INV-2026-0457', 'INV-2026-0458').replace('OUT-2026-000123', 'OUT-2026-000124'));
    assert.equal(parseSwiftMessages(twoInvoices).length, 2);
    assert.equal((await c.submitSwift(twoInvoices, { index: 0 })).already, false);
    await reused(twoInvoices, { index: 1 });
    // …even when the second is a copy of the first to the letter.
    const copied = fresh.replaceAll('77777777-', '88888888-');
    const copiedBlock = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(copied)![0];
    const twice = copied.replace(copiedBlock, copiedBlock + copiedBlock);
    assert.equal((await c.submitSwift(twice, { index: 0 })).already, false);
    await assert.rejects(c.submitSwift(twice, { index: 1 }), /two transactions of this file/);
    assert.equal(posts(), 3);

    // No UETR at all (a pain.001): the message's own identifiers are the reference.
    const pain = sample('pain001.sample.xml').toString('utf8');
    const p1 = await c.submitSwift(pain);
    assert.equal(p1.already, false);
    assert.match(p1.paymentId, /^PAY-[0-9a-f]{8}-[0-9a-f]{10}$/);
    assert.deepEqual([(await c.submitSwift(pain.replace(/\n\s+/g, '\n'))).already, posts()], [true, 4]);
    await reused(pain.replaceAll('INV-2026-0470', 'INV-2026-0471'));
    // The identifiers on another day are another payment — the reference-and-date rule.
    const laterDay = await c.submitSwift(pain.replace(/<ReqdExctnDt>\s*<Dt>[^<]+<\/Dt>/, '<ReqdExctnDt><Dt>2026-12-01</Dt>'));
    assert.deepEqual([laterDay.already, laterDay.paymentId === p1.paymentId, posts()], [false, false, 5]);

    // An id of the caller's choosing names a settlement; it does not put a UETR on a second payment.
    await assert.rejects(c.submitSwift(xml.replace('INV-2026-0457', 'INV-2026-0999'), { paymentId: 'PAY-OWN-0001' }),
      (e: unknown) => e instanceof RemitApiError && e.code === 'reference_reused' && e.existingPaymentId === 'PAY-3f1c9a52-175c822e37'
        && /give this one its own UETR$/.test(e.message));
    assert.equal(posts(), 5);
    // Without a UETR the reference is the bank's own numbering, which it may mean to use again:
    // there, an id of its own makes the payment one of its own.
    const own = await c.submitSwift(pain.replaceAll('INV-2026-0470', 'INV-2026-0471'), { paymentId: 'PAY-OWN-0001' });
    assert.deepEqual([own.already, own.paymentId, posts()], [false, 'PAY-OWN-0001', 6]);
  } finally { net.restore(); }
});

test('submitSwift: a payment is found by what it is, however short its reference', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const posts = (): number => net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    const made = (): number => net.settlements.size;
    const lookups = (): string[] => net.calls.filter((x) => x.method === 'GET' && x.path === '/v1/settlements').map((x) => x.query);
    // An MT103 whose field 20 has two characters and which carries no other reference of its
    // own: nothing in it is long enough to be searched for as "someone's unique number".
    const base = sample('mt103.structured.sample.txt').toString('latin1');
    assert.match(base, /:20:OUT2026000126/);
    const mt = (ref: string, uetr8: string): { full: string; bare: string } => {
      const full = base.replaceAll('OUT2026000126', ref).replace('e2a8c5f0-', `${uetr8}-`).replace(/\r?\n\/ROC\/[^\r\n]*/, '');
      return { full, bare: full.slice(full.indexOf(':20:'), full.indexOf('-}')) };
    };
    const a = mt('A1', 'aaaa0001');
    assert.deepEqual([parseSwiftMessage(a.full).instructionId, parseSwiftMessage(a.full).endToEndId, parseSwiftMessage(a.bare).uetr], ['A1', undefined, undefined]);

    // With its header blocks, then the same message without them: one settlement.
    const a1 = await c.submitSwift(a.full);
    const a2 = await c.submitSwift(a.bare);
    assert.deepEqual([a1.already, a2.already, a2.paymentId, made()], [false, true, a1.paymentId, 1]);
    // The SDK does not guess which settlement another rendering belongs to: it sent the
    // instruction, the platform refused it and named the settlement, and that is the answer.
    assert.equal(posts(), 2, 'sent twice, taken once');
    assert.ok(lookups().every((q) => !q.includes('q=') && !q.includes('source_content')), 'the ledger is not searched for look-alikes');
    // Handed over a third time, it is still that settlement.
    assert.deepEqual([(await c.submitSwift(a.bare)).paymentId, made()], [a1.paymentId, 1]);
    // The other way round: the settlement without a UETR is found by the one with it.
    const b = mt('B2', 'aaaa0002');
    const b1 = await c.submitSwift(b.bare);
    const b2 = await c.submitSwift(b.full);
    assert.deepEqual([b1.already, b2.already, b2.paymentId, made()], [false, true, b1.paymentId, 2]);
    // …and from then on it is that UETR's settlement: asked for exactly, it is found without sending anything.
    const sentSoFar = posts();
    assert.deepEqual([(await c.submitSwift(b.full.replace('SINGAPORE 048616', 'SINGAPORE  048616'))).paymentId, posts() - sentSoFar], [b1.paymentId, 0]);
    assert.ok(lookups().some((q) => q.startsWith('source_uetr=aaaa0002-')));

    // An id of the caller's choosing does not make a second payment out of the same message…
    const named = await c.submitSwift(a.full, { paymentId: 'BANK-RETRY-0002' });
    assert.deepEqual([named.already, named.paymentId, made()], [true, a1.paymentId, 2]);
    // …nor out of its other rendering.
    assert.deepEqual([(await c.submitSwift(a.bare, { paymentId: 'BANK-RETRY-0003' })).paymentId, made()], [a1.paymentId, 2]);

    // Both renderings handed over at the same moment by two processes: neither finds the other in
    // the ledger, both send — and the platform takes one. The other is told so, and answers "already".
    const d = mt('D4', 'aaaa0004');
    const both = await Promise.all([c.submitSwift(d.full), client({ key: bank.privateKey }).submitSwift(d.bare)]);
    assert.deepEqual(both.map((x) => x.already).sort(), [false, true]);
    assert.equal(both[0]!.paymentId, both[1]!.paymentId);
    assert.equal(made(), 3, 'both were sent; one was taken');
    assert.equal([...net.settlements.values()].filter((v) => JSON.stringify(v).includes(':"D4"')).length, 1);

    // The same two characters on another day, or with another amount, are other payments.
    const nextDay = await c.submitSwift(a.bare.replace(':32A:261117', ':32A:261118'));
    const otherAmount = await c.submitSwift(a.bare.replace('USD990,75', 'USD991,75'));
    assert.deepEqual([nextDay.already, otherAmount.already, made()], [false, false, 5]);
    // A second MT103 that reads alike under a UETR of its own: the settlement it could be a
    // rendering of already has a UETR — another one — so it is a payment of its own.
    const sibling = await c.submitSwift(mt('A1', 'aaaa0009').full);
    assert.deepEqual([sibling.already, made()], [false, 6]);
  } finally { net.restore(); }
});

test('submitSwift: a payment with no identifier of its own is still one payment', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const made = (): number => net.settlements.size;
    // The shape many systems write: no UETR, no instruction id, "NOTPROVIDED" for the end-to-end id.
    // All such a payment has is the file's message id and its place in the file.
    const plain = sample('pain001.sample.xml').toString('utf8')
      .replace(/\s*<InstrId>[^<]+<\/InstrId>/, '').replace(/<EndToEndId>[^<]+<\/EndToEndId>/, '<EndToEndId>NOTPROVIDED</EndToEndId>');
    const read = parseSwiftMessage(plain);
    assert.deepEqual([read.uetr, read.instructionId, read.endToEndId], [undefined, undefined, 'NOTPROVIDED']);
    const exportedAgain = plain.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:30:00+07:00<');
    assert.notEqual(exportedAgain, plain);

    const first = await c.submitSwift(plain);
    assert.equal(first.already, false);
    // The file written out again with a new creation time: the same payment.
    assert.deepEqual([(await c.submitSwift(exportedAgain)).paymentId, made()], [first.paymentId, 1]);
    // Under an id of the bank's own, too — the id is a name, whatever the message has to show for itself.
    assert.deepEqual([(await c.submitSwift(exportedAgain, { paymentId: 'BANK-RETRY-0002' })).paymentId, made()], [first.paymentId, 1]);
    const third = exportedAgain.replace('2026-11-18T08:30:00', '2026-11-18T09:45:00');
    const named = await c.submitSwift(third, { paymentId: 'BANK-RETRY-0003' });
    assert.deepEqual([named.already, named.paymentId, made()], [true, first.paymentId, 1]);
    // Two processes, each with its own export of the file, at the same moment.
    const other = plain.replace('VINATRD-20261117-0031', 'VINATRD-20261117-0044');
    const both = await Promise.all([c.submitSwift(other), client({ key: bank.privateKey })
      .submitSwift(other.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:31:00+07:00<'))]);
    assert.deepEqual([both.map((x) => x.already).sort(), both[0]!.paymentId === both[1]!.paymentId, made()], [[false, true], true, 2]);
    // Under another message id nothing says it is the same payment: it is a new one.
    assert.deepEqual([(await c.submitSwift(plain.replace('VINATRD-20261117-0031', 'VINATRD-20261117-0099'))).already, made()], [false, 3]);
  } finally { net.restore(); }
});

test('submitSwift: a payment made by an earlier SDK is still found after the upgrade', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const made = (): number => net.settlements.size;
    const plain = sample('pain001.sample.xml').toString('utf8')
      .replace(/\s*<InstrId>[^<]+<\/InstrId>/, '').replace(/<EndToEndId>[^<]+<\/EndToEndId>/, '<EndToEndId>NOTPROVIDED</EndToEndId>');
    // The earlier SDK counted "NOTPROVIDED" as part of the payment's identity, so its id for this
    // payment is not the one derived today. Submit it under that older id, as that SDK did.
    const before = await c.instructionFromSwift(plain, { paymentId: 'PAY-279099bd-b892b97146' });
    await c.submit(before.body, 'swift-PAY-279099bd-b892b97146');
    assert.notEqual(swiftPaymentId('VN-BANK-T1', parseSwiftMessage(plain)), 'PAY-279099bd-b892b97146');
    // The same file, and the file exported again: neither is paid a second time.
    assert.deepEqual([(await c.submitSwift(plain)).paymentId, made()], ['PAY-279099bd-b892b97146', 1]);
    const again = await c.submitSwift(plain.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-19T08:30:00+07:00<'));
    assert.deepEqual([again.already, again.paymentId, made()], [true, 'PAY-279099bd-b892b97146', 1]);

    // A settlement from before instructions carried a content digest, made from these very bytes
    // under an id of its own: the platform knows the file, names the settlement, and that is the answer.
    const xml = sample('pacs008.sample.xml');
    const p = parseSwiftMessage(xml);
    await net.fromBefore([{
      payment_id: 'PAY-20261117-0a1b2c3d4e', state: 'EVIDENCE_ANCHORED', evidence_level: null, evidence_available: false, chain_tx: null, attestation: null,
      events: [{ seq: 0, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'VN-BANK-T1', at: '2026-11-16T00:00:00.000Z', sig: null,
        payload: { bankInstruction: { ref: 'PAY-20261117-0a1b2c3d4e', sourceMessage: { type: p.messageType, sha256: p.digest } } } }],
    } as unknown as SettlementView]);
    const old = await c.submitSwift(xml);
    assert.deepEqual([old.already, old.paymentId, old.state], [true, 'PAY-20261117-0a1b2c3d4e', 'EVIDENCE_ANCHORED']);
    assert.equal(made(), 2);
  } finally { net.restore(); }
});

test('submitSwift: of two payments that read alike, neither is called made because the other was', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const made = (): number => net.settlements.size;
    // One file, two instalments: the same end-to-end id, amount and parties, no instruction id.
    const pain = sample('pain001.sample.xml').toString('utf8').replace(/\s*<InstrId>[^<]+<\/InstrId>/, '');
    const block = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(pain)![0];
    const twoInstalments = pain.replace(block, block + block);
    assert.equal(parseSwiftMessages(twoInstalments).length, 2);
    const exportedAgain = twoInstalments.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T08:30:00+07:00<').replace('VINATRD-20261117-0031', 'VINATRD-20261118-0002');

    // Only the first went through before the file was written out again.
    const first = await c.submitSwift(twoInstalments, { index: 0 });
    assert.equal(first.already, false);
    // The re-export's first instalment is the one already made…
    assert.deepEqual([(await c.submitSwift(exportedAgain, { index: 0 })).paymentId, made()], [first.paymentId, 1]);
    // …and its second is the instalment that was never sent: it is paid now, not reported as paid.
    const second = await c.submitSwift(exportedAgain, { index: 1 });
    assert.deepEqual([second.already, second.paymentId === first.paymentId, made()], [false, false, 2]);
    // The original file's second instalment, handed over after all, is that second settlement — not a third.
    const late = await c.submitSwift(twoInstalments, { index: 1 });
    assert.deepEqual([late.already, late.paymentId, made()], [true, second.paymentId, 2]);
    // Asked again in any order, each keeps its settlement.
    assert.deepEqual([(await c.submitSwift(exportedAgain, { index: 1 })).paymentId, (await c.submitSwift(exportedAgain, { index: 0 })).paymentId,
      (await c.submitSwift(twoInstalments, { index: 0 })).paymentId, made()], [second.paymentId, first.paymentId, first.paymentId, 2]);

    // An MT103 without its header blocks, then two payments that read exactly like it, each under a UETR of its own:
    // the first is taken for that settlement's other rendering; the second is a payment of its own.
    const base = sample('mt103.structured.sample.txt').toString('latin1');
    const bare = base.slice(base.indexOf(':20:'), base.indexOf('-}'));
    const h = await c.submitSwift(bare);
    const w1 = await c.submitSwift(base);
    const w2 = await c.submitSwift(base.replace('e2a8c5f0-', 'bbbb0002-'));
    assert.deepEqual([h.already, w1.already, w1.paymentId, w2.already, made()], [false, true, h.paymentId, false, 4]);
    // …and afterwards each UETR is its own settlement's.
    assert.deepEqual([(await c.submitSwift(base)).paymentId, (await c.submitSwift(base.replace('e2a8c5f0-', 'bbbb0002-'))).paymentId, made()],
      [h.paymentId, w2.paymentId, 4]);
  } finally { net.restore(); }
});

test('submitSwift: what cannot be told apart is refused, not guessed', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const posts = (): number => net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    // No UETR and no value date: nothing says whether a second message is the first payment again or another one.
    const undated = sample('pacs008.sample.xml').toString('utf8')
      .replace(/\s*<UETR>[^<]+<\/UETR>/, '').replace(/\s*<IntrBkSttlmDt>[^<]+<\/IntrBkSttlmDt>/, '');
    assert.deepEqual([parseSwiftMessage(undated).uetr, parseSwiftMessage(undated).valueDate], [undefined, undefined]);
    const first = await c.submitSwift(undated);
    assert.equal(first.already, false);
    // The same file again is the same payment — that much is certain.
    assert.deepEqual([(await c.submitSwift(undated)).already, posts()], [true, 1]);
    // Under a new message id it is sent, and the platform refuses it: the SDK passes the refusal on
    // with the settlement it names, and does not call the payment "already made".
    await assert.rejects(c.submitSwift(undated.replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000001')),
      (e: unknown) => e instanceof RemitApiError && e.status === 409 && e.code === 'duplicate_source_message'
        && e.existingPaymentId === first.paymentId && /no value date/.test(e.message));
    assert.deepEqual([posts(), net.settlements.size], [2, 1]);
  } finally { net.restore(); }
});

test('submitSwift: the same payment written out again is one settlement', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    // Settlements on the platform — not instructions sent: a rendering the SDK cannot place
    // for certain is sent, and the platform refuses it with the settlement that stands.
    const posts = (): number => net.settlements.size;
    const xml = sample('pacs008.sample.xml').toString('utf8');
    const first = await c.submitSwift(xml);

    // Exported again the next day: a new message id, a new creation time — the same payment.
    const nextDay = xml.replace(/<CreDtTm>[^<]+</, '<CreDtTm>2026-11-18T09:00:00+07:00<').replace('DEMOVNVX20261117000123', 'DEMOVNVX20261118000007');
    const again = await c.submitSwift(nextDay);
    assert.deepEqual([again.already, again.paymentId, posts()], [true, first.paymentId, 1]);

    // A settlement made under an id of the caller's choosing is still found by its UETR.
    const other = xml.replaceAll('3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10', '99999999-7b0e-4d6a-9c1f-2e8b5a7d4c10');
    assert.equal((await c.submitSwift(other, { paymentId: 'BANK-TX-2026-000777' })).paymentId, 'BANK-TX-2026-000777');
    const found = await c.submitSwift(other.replace(/\n\s+/g, '\n'));
    assert.deepEqual([found.already, found.paymentId, posts()], [true, 'BANK-TX-2026-000777', 2]);

    // An MT103 with its header blocks, then the same text without them — and the other way round.
    const full = sample('mt103.structured.sample.txt').toString('latin1');
    const textOf = (m: string): string => m.slice(m.indexOf(':20:'), m.indexOf('-}'));
    const m1 = await c.submitSwift(full);
    const m2 = await c.submitSwift(textOf(full));
    assert.deepEqual([m1.already, m2.already, m2.paymentId, posts()], [false, true, m1.paymentId, 3]);
    const full2 = full.replaceAll('OUT2026000126', 'OUT2026000127').replace('e2a8c5f0-', 'aaaaaaaa-');
    const t1 = await c.submitSwift(textOf(full2));
    const t2 = await c.submitSwift(full2);
    assert.deepEqual([t1.already, t2.already, t2.paymentId, posts()], [false, true, t1.paymentId, 4]);
    // A field 20 that comes round again on a later day is another payment.
    const recycled = await c.submitSwift(textOf(full2).replace(':32A:261117', ':32A:261118'));
    assert.deepEqual([recycled.already, posts()], [false, 5]);
    // …and with other content on the same day it is not the header-stripped twin either.
    const sameDay = await c.submitSwift(full.replace('e2a8c5f0-', 'bbbbbbbb-').replace('USD990,75', 'USD991,75'));
    assert.deepEqual([sameDay.already, posts()], [false, 6]);
  } finally { net.restore(); }
});

test('submitSwift: an incomplete message is refused before anything is quoted or signed', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    await assert.rejects(c.submitSwift(sample('mt103.sample.txt')),
      (e: unknown) => e instanceof SwiftMappingError && e.issues.length === 1 && e.issues[0]!.target === 'debtor.registration_number');
    assert.equal(net.calls.length, 0);
    // The customer master, looked up by the debtor's account, completes it.
    const done = await c.submitSwift(sample('mt103.sample.txt'), {
      supplement: (p) => (p.debtor.account === 'VN-ACC-000777' ? { debtor: { registration_number: '0312345678' } } : undefined),
    });
    assert.equal(done.already, false);
    assert.deepEqual((await c.inspectSwift(sample('mt103.structured.sample.txt'))).issues, []);
  } finally { net.restore(); }
});

test('verifyWebhook: only an envelope the platform signed is returned', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    const envelope = { event_id: 'e1', payment_id: 'PAY-1', sequence: 3, type: 'TRAVEL_RULE_PENDING', state: 'TRAVEL_RULE_PENDING', occurred_at: '2026-11-17T00:00:00Z', data: {} };
    const signature = signEvent(envelope, platform.privateKey, 'STONEHASH-SIGN-test', 'STONEHASH');
    assert.deepEqual(await c.verifyWebhook({ envelope, signature }), { valid: true, envelope });
    assert.equal((await c.verifyWebhook({ envelope: { ...envelope, state: 'EVIDENCE_ANCHORED' }, signature })).valid, false);
    assert.equal((await c.verifyWebhook({ envelope, signature: signEvent(envelope, bank.privateKey, 'x', 'x') })).valid, false);
    assert.equal((await c.verifyWebhook({})).valid, false);
    // Deliveries that do not verify cannot be turned into a stream of registry requests.
    const before = net.calls.filter((x) => x.path === '/v1/remit/meta').length;
    for (let i = 0; i < 25; i++) await c.verifyWebhook({ envelope, signature: signEvent(envelope, bank.privateKey, 'x', 'x') });
    assert.ok(net.calls.filter((x) => x.path === '/v1/remit/meta').length - before <= 1);
  } finally { net.restore(); }
});

// ── The folder adapter ─────────────────────────────────────────────────────

test('folder adapter: a dropped message becomes a settlement, status reports and a filed original', async () => {
  const net = fakePlatform();
  try {
    const root = mkdtempSync(path.join(os.tmpdir(), 'remit-adapter-'));
    const inbox = path.join(root, 'inbox');
    const outbox = path.join(root, 'outbox');
    const lines: string[] = [];
    const adapter = new FolderAdapter({
      client: client({ key: bank.privateKey }), inbox, outbox,
      parties: JSON.parse(sample('parties.sample.json').toString('utf8')) as never,
      log: (l) => lines.push(l),
    });
    const drop = (name: string, content: Buffer | string): void => {
      writeFileSync(path.join(inbox, name), content);
      const old = new Date(Date.now() - 5_000);
      utimesSync(path.join(inbox, name), old, old); // not "still being written"
    };
    drop('out-123.xml', sample('pacs008.sample.xml'));
    drop('out-125.fin', sample('mt103.sample.txt'));
    drop('broken.xml', '<Document><FIToFICstmrCdtTrf></Document>');
    drop('other.txt', 'not a payment message');

    assert.equal(await adapter.tick(), 2, 'two settlements are being followed');
    assert.deepEqual(readdirSync(path.join(inbox, 'processed')).sort(), ['out-123.xml', 'out-125.fin']);
    assert.deepEqual(readdirSync(path.join(inbox, 'failed')).sort(), ['broken.xml', 'other.txt']);
    const out = readdirSync(outbox).sort();
    // The bank's own reference, then the payment id: the files sort with the bank's records and never collide.
    const named = (ref: string, suffix: string): string => {
      const hits = out.filter((f) => f.startsWith(`${ref}.PAY-`) && f.endsWith(suffix));
      assert.equal(hits.length, 1, `${ref}…${suffix} in ${out.join(' ')}`);
      return hits[0]!;
    };
    const base = named('OUT-2026-000123', '.accepted.json').slice(0, -'.accepted.json'.length);
    assert.match(base, /^OUT-2026-000123\.PAY-3f1c9a52-[0-9a-f]{10}$/);
    named('OUT2026000125', '.accepted.json');
    assert.ok(out.includes(`${base}.status-01-ACTC.xml`), out.join(' '));
    assert.ok(out.includes('broken.xml.error.json') && out.includes('other.txt.error.json'));
    const accepted = JSON.parse(readFileSync(path.join(outbox, `${base}.accepted.json`), 'utf8')) as { payment_id: string; source: { uetr: string } };
    assert.equal(accepted.source.uetr, '3f1c9a52-7b0e-4d6a-9c1f-2e8b5a7d4c10');
    assert.match(readFileSync(path.join(outbox, `${base}.status-01-ACTC.xml`), 'utf8'), /<OrgnlUETR>3f1c9a52/);
    const status = JSON.parse(readFileSync(path.join(outbox, `${base}.status.json`), 'utf8')) as { swift_status: string };
    assert.equal(status.swift_status, 'ACTC');

    // The platform moves the payment on: one new report, the old one kept.
    const view = net.settlements.get(accepted.payment_id)!;
    view.state = 'CANCELLED';
    view.events.push({ seq: 2, type: 'TRAVEL_RULE_REJECTED', issuer: 'SG-BFI-001', at: '2026-11-17T00:00:02.000Z', payload: { reason: 'screening' }, sig: null });
    assert.equal(await adapter.tick(), 1, 'the rejected one is closed, the other still open');
    assert.ok(existsSync(path.join(outbox, `${base}.status-02-RJCT.xml`)));
    assert.match(readFileSync(path.join(outbox, `${base}.status-02-RJCT.xml`), 'utf8'), /<Prtry>TRAVEL_RULE_REJECTED<\/Prtry>/);

    // Dropping the same message again creates nothing new.
    const before = net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    drop('out-123-again.xml', sample('pacs008.sample.xml'));
    await adapter.tick();
    assert.equal(net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length, before);
    assert.ok(lines.some((l) => /already submitted/.test(l)));

    // A restart picks up where it left off.
    const resumed = new FolderAdapter({ client: client({ key: bank.privateKey }), inbox, outbox, log: () => {} });
    assert.equal(await resumed.tick(), 1);
  } finally { net.restore(); }
});

test('folder adapter: nothing ordinary stops it, and nothing is reported that did not happen', async () => {
  const net = fakePlatform();
  try {
    const root = mkdtempSync(path.join(os.tmpdir(), 'remit-adapter-'));
    const inbox = path.join(root, 'inbox');
    const outbox = path.join(root, 'outbox');
    const lines: string[] = [];
    const make = (): FolderAdapter => new FolderAdapter({
      client: client({ key: bank.privateKey }), inbox, outbox,
      parties: JSON.parse(sample('parties.sample.json').toString('utf8')) as never,
      log: (l) => lines.push(l),
    });
    const adapter = make();
    const drop = (name: string, content: Buffer | string): void => {
      writeFileSync(path.join(inbox, name), content);
      const old = new Date(Date.now() - 5_000);
      utimesSync(path.join(inbox, name), old, old);
    };
    const posts = (): number => net.calls.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').length;
    const xml = sample('pacs008.sample.xml').toString('utf8');

    // Something in between answers 200 with a page of its own. That is not an
    // acceptance: the file stays, nothing is filed as sent, and it goes out
    // once the platform is reachable again.
    net.inTheWay.on = true;
    drop('a.xml', xml);
    assert.equal(await adapter.tick(), 0);
    assert.deepEqual([readdirSync(inbox).includes('a.xml'), readdirSync(outbox).filter((f) => f.endsWith('.accepted.json')).length], [true, 0]);
    assert.ok(lines.some((l) => /a\.xml.*not the platform's own answer.*will retry/.test(l)), lines.join('\n'));
    net.inTheWay.on = false;
    assert.equal(await adapter.tick(), 1);
    assert.deepEqual([readdirSync(path.join(inbox, 'processed')), posts()], [['a.xml'], 1]);

    // A file that cannot be read, a decision file that is not an object, a
    // link to a message: none of them stops the file behind it.
    drop('b-unreadable.xml', xml);
    chmodSync(path.join(inbox, 'b-unreadable.xml'), 0o000);
    drop('c-null.cancel.json', 'null');
    writeFileSync(path.join(root, 'elsewhere.xml'), xml.replaceAll('3f1c9a52-', '44444444-'));
    utimesSync(path.join(root, 'elsewhere.xml'), new Date(Date.now() - 5_000), new Date(Date.now() - 5_000));
    symlinkSync(path.join(root, 'elsewhere.xml'), path.join(inbox, 'd-link.xml'));
    drop('e-good.xml', xml.replaceAll('3f1c9a52-', '55555555-'));
    const unreadable = process.getuid?.() !== 0; // root reads anything
    await adapter.tick();
    assert.ok(readdirSync(path.join(inbox, 'processed')).includes('e-good.xml'), 'the file behind the bad ones went out');
    assert.ok(readdirSync(path.join(inbox, 'processed')).includes('d-link.xml'), 'a link to a message is a message');
    assert.ok(readdirSync(path.join(inbox, 'failed')).includes('c-null.cancel.json'));
    if (unreadable) {
      assert.ok(readdirSync(inbox).includes('b-unreadable.xml'), 'left where it is');
      const said = lines.filter((l) => /b-unreadable\.xml/.test(l)).length;
      await adapter.tick();
      assert.equal(lines.filter((l) => /b-unreadable\.xml/.test(l)).length, said, 'and what is wrong with it is said once');
    }
    chmodSync(path.join(inbox, 'b-unreadable.xml'), 0o600);
    await adapter.tick();

    // A file of three transactions, the second incomplete: the first and the
    // third still go out, and the report names what failed and what did not.
    const block = /<CdtTrfTxInf>[\s\S]*<\/CdtTrfTxInf>/.exec(xml)![0];
    const nth = (n: number): string => block.replaceAll('3f1c9a52-', `6666666${n}-`).replaceAll('OUT-2026-000123', `OUT-2026-00020${n}`);
    const before = posts();
    drop('f-three.xml', xml.replace(block, nth(1) + nth(2).replace(/<CdtrAcct>[\s\S]*?<\/CdtrAcct>/, '') + nth(3)));
    await adapter.tick();
    assert.equal(posts() - before, 2);
    const report = JSON.parse(readFileSync(path.join(outbox, 'f-three.xml.error.json'), 'utf8')) as
      { error: string; transactions: number; sent: number; failures: { transaction: number; missing: { target: string }[] }[] };
    assert.deepEqual([report.error, report.transactions, report.sent, report.failures.map((f) => [f.transaction, f.missing[0]!.target])],
      ['transactions_failed', 3, 2, [[2, 'creditor.account']]]);

    // A cancellation the platform took, whose answer was lost: the retry is not a failure.
    const some = [...net.settlements.keys()][0]!;
    net.settlements.get(some)!.state = 'CANCELLED';
    drop('g.cancel.json', JSON.stringify({ payment_id: some, reason: 'duplicate order' }));
    await adapter.tick();
    assert.ok(readdirSync(path.join(inbox, 'processed')).includes('g.cancel.json'));
    assert.ok(lines.some((l) => /g\.cancel\.json: already cancelled/.test(l)));

    // The same field 20 on two days is two payments, and each keeps its own reports.
    const mt = sample('mt103.structured.sample.txt').toString('latin1');
    const text = mt.slice(mt.indexOf(':20:'), mt.indexOf('-}'));
    drop('h-day1.fin', text);
    drop('i-day2.fin', text.replace(':32A:261117', ':32A:261118'));
    await adapter.tick();
    assert.equal(readdirSync(outbox).filter((f) => f.startsWith('OUT2026000126.') && f.endsWith('.accepted.json')).length, 2);

    // One adapter per outbox while the first is alive; a restart takes over.
    writeFileSync(path.join(outbox, '.adapter.lock'), `${process.ppid}\n`);
    assert.throws(() => make(), /another adapter \(process \d+\) is already working/);
    writeFileSync(path.join(outbox, '.adapter.lock'), '2147483646\n'); // nobody
    const open = Object.keys(JSON.parse(readFileSync(path.join(outbox, '.adapter-state.json'), 'utf8')).open as object).length;
    assert.equal(await make().tick(), open);

    // A damaged state file is set aside, and the outbox itself says what was being followed.
    writeFileSync(path.join(outbox, '.adapter-state.json'), '{"open": {"PAY-');
    const rebuilt = make();
    assert.ok(lines.some((l) => /could not be read and was set aside/.test(l)));
    assert.ok(readdirSync(outbox).some((f) => f.startsWith('.adapter-state.json.damaged-')));
    assert.equal(await rebuilt.tick(), open, 'the payments still open are followed again');
    rebuilt.close();
    assert.equal(existsSync(path.join(outbox, '.adapter.lock')), false);
  } finally { net.restore(); }
});

test('the client takes only the platform\'s own answer for an outcome', async () => {
  const net = fakePlatform();
  try {
    const c = client({ key: bank.privateKey });
    net.inTheWay.on = true;
    for (const attempt of [() => c.quote('10.00'), () => c.status('PAY-1'), () => c.list(), () => c.submitSwift(sample('pacs008.sample.xml'))]) {
      await assert.rejects(attempt(), (e: unknown) => e instanceof RemitApiError && e.status === 502 && e.code === 'not_a_platform_answer');
    }
    net.inTheWay.on = false;
    // A JSON answer that names no payment is not an acceptance either.
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST' && String(input).endsWith('/v1/settlements')
        ? new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
        : real(input as never, init))) as typeof fetch;
    try {
      await assert.rejects(c.submitSwift(sample('pacs008.sample.xml')), (e: unknown) => e instanceof RemitApiError && e.code === 'not_a_platform_answer');
    } finally { globalThis.fetch = real; }

    // An error page is not the platform refusing: a gateway's 502 or 503 used to
    // come back as the code `error`, which no table of the guide names.
    for (const [status, type, body] of [[502, 'text/html', '<html>Bad Gateway</html>'], [503, 'text/html', 'Service Unavailable'],
      [401, 'application/json', '{"detail":"login required"}']] as const) {
      globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch;
      try {
        await assert.rejects(c.status('PAY-1'),
          (e: unknown) => e instanceof RemitApiError && e.code === 'not_a_platform_answer' && new RegExp(`HTTP ${status}`).test(e.message));
      } finally { globalThis.fetch = real; }
    }
    // The platform's own refusal keeps its status and its code.
    await assert.rejects(c.status('PAY-none'), (e: unknown) => e instanceof RemitApiError && e.status === 404 && e.code === 'not_found');
  } finally { net.restore(); }
});
