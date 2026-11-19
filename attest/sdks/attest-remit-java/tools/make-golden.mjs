/**
 * Writes the golden vectors the Java SDK is held to: what the TypeScript SDK
 * (`packages/attest-remit`, read here and never written) answers for every
 * case in `golden-cases.mjs` — and, for the submission scenarios, what
 * `RemitClient.submitSwift()` decides against a stand-in platform (`fetch` is
 * replaced while they run; nothing leaves the machine).
 *
 *   node sdks/attest-remit-java/tools/make-golden.mjs          write src/test/resources/golden/*.json
 *   node sdks/attest-remit-java/tools/make-golden.mjs --check  fail when the files on disk differ
 *   … --only=parse,mapping                                     write or check just those files
 *
 * The output is a function of the SDK's source and the cases alone: the same
 * sources give the same bytes. (The one thing that cannot be reproduced —
 * an ECDSA signature — is kept from the file already there as long as it
 * still verifies.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RemitApiError, RemitClient,
  SwiftMappingError, buildPacs002, isoFieldNames, mapSwiftPayment, parseSwiftMessage, parseSwiftMessages,
  sourceMessageOf, swiftContentDigest, swiftPaymentId, swiftStatusOf, SWIFT_STATUS_TABLE,
  EVENT_DOMAIN, DIGEST_DOMAIN, elementDigest, eventSigningBytes, finishElement, signEvent, spkiOf, verifyEvent,
} from '../../../packages/attest-remit/src/index.ts';
import { jcs } from '../../../packages/attest-verify/src/index.ts';
import { signedBytes, keyring, verifyEvidenceSignatures } from '../../../packages/attest-rules/src/index.ts';
import { SourceLedger } from '../../../packages/attest-remit/test/support/source-ledger.ts';
import { INSTITUTIONS, jcsValues, mappingCases, parseCases, scenarioCases, signingInputs, statusCases } from './golden-cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../src/test/resources/golden');
const check = process.argv.includes('--check');

/** An error as the vectors record it: what kind, which code, where, and the words. */
function errorOf(e) {
  const out = { name: e?.name ?? typeof e };
  if (typeof e?.code === 'string') out.code = e.code;
  if (typeof e?.field === 'string') out.field = e.field;
  out.message = String(e?.message ?? e);
  return out;
}
const attempt = (fn) => { try { return { ok: fn() }; } catch (e) { return { error: errorOf(e) }; } };
const hex = (u8) => Buffer.from(u8).toString('hex');
/** A case's name is how a failing Java test names it: one name, one case. */
const names = new Set();
const unique = (file, name) => {
  if (names.has(`${file}:${name}`)) throw new Error(`${file}: two cases are named ${name}`);
  names.add(`${file}:${name}`);
};

// ── Messages in ────────────────────────────────────────────────────────────

const inputs = new Map();
function parseVectors() {
  const cases = [];
  for (const c of parseCases()) {
    unique('parse', c.name);
    // Too large to store: `prefix` and `text` written `times` times, as a string or as Latin-1 bytes.
    const repeated = c.repeat ? `${c.repeat.prefix ?? ''}${c.repeat.text.repeat(c.repeat.times)}` : undefined;
    const message = c.repeat ? (c.as === 'string' ? repeated : Buffer.from(repeated, 'latin1')) : c.input;
    inputs.set(c.name, message);
    const input = c.repeat ? { as: c.as ?? 'bytes', repeat: c.repeat }
      : typeof message === 'string' ? { as: 'string', text: message }
        : { as: 'bytes', base64: message.toString('base64') };
    const all = attempt(() => parseSwiftMessages(message));
    const entry = { name: c.name, ...(c.note ? { note: c.note } : {}), input };
    if (all.error) {
      entry.expect = { error: all.error };
    } else {
      entry.expect = {
        payments: all.ok,
        // What follows from each payment alone: its id for an institution, the digest of
        // what makes it this payment, and the ISO 20022 names of what it carried.
        derived: all.ok.map((p) => ({
          paymentIds: Object.fromEntries(INSTITUTIONS.map((i) => [i, swiftPaymentId(i, p)])),
          contentDigest: swiftContentDigest(p),
          isoFieldNames: isoFieldNames(p),
        })),
      };
      // Asked for "the one payment": refused when there are several and none is named.
      const one = attempt(() => parseSwiftMessage(message));
      entry.single = one.error ? { error: one.error } : { index: one.ok.index };
      const beyond = attempt(() => parseSwiftMessage(message, { index: all.ok.length }));
      entry.beyond = beyond.error ? { error: beyond.error } : { index: beyond.ok.index };
    }
    cases.push(entry);
  }
  return { about: 'parseSwiftMessages(input) → expect.payments | expect.error; parseSwiftMessage(input) → single; parseSwiftMessage(input, { index: payments.length }) → beyond', institutions: INSTITUTIONS, cases };
}

function mappingVectors() {
  const cases = [];
  for (const c of mappingCases()) {
    unique('mapping', c.name);
    const message = inputs.get(c.parse);
    if (message === undefined) throw new Error(`mapping case ${c.name}: no parse case named ${c.parse}`);
    const payment = parseSwiftMessage(message, { index: c.index });
    const mapping = mapSwiftPayment(payment, c.options);
    const { payment: _same, ...rest } = mapping;
    void _same;
    cases.push({
      name: c.name, ...(c.note ? { note: c.note } : {}), parse: c.parse, index: c.index, options: c.options,
      expect: {
        ...rest,
        input: mapping.input ?? null,
        // What a caller sees when it insists on an instruction and there are issues.
        ...(mapping.input ? {} : { error: errorOf(new SwiftMappingError(mapping)) }),
      },
    });
  }
  return { about: 'mapSwiftPayment(parseSwiftMessage(<parse case>, { index }), options) → expect { fields, issues, unmapped, input | null, error? }', cases };
}

// ── Status out ─────────────────────────────────────────────────────────────

function statusVectors() {
  const cases = statusCases().map((c) => {
    unique('status', c.name);
    // The view as the Java test reads it back from the file: what JSON cannot hold is not part of it.
    const view = JSON.parse(JSON.stringify(c.view));
    return {
      name: c.name, view, options: c.options,
      expect: {
        status: swiftStatusOf(view),
        sourceMessage: sourceMessageOf(view) ?? null,
        pacs002: buildPacs002(view, c.options),
      },
    };
  });
  return { about: 'swiftStatusOf(view) → status; sourceMessageOf(view) → sourceMessage | null; buildPacs002(view, options) → pacs002', table: SWIFT_STATUS_TABLE, cases };
}

// ── The two signing conventions ────────────────────────────────────────────

/** A key for these vectors and nothing else. It protects nothing: it is published here. */
const TEST_KEY_PKCS8_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbtC+yIN2Y8PpA7lC
Eo6GXvLq3CJP7spumHu7uVVl5yihRANCAAQZ4nCIpvLsfJyXyq9qNZX1lExp1PLI
YZ+OhJeU+dwQMjrtskPWbY/WwCPHkE6VMS8ahpTFPRUvB/Se8ihlAObv
-----END PRIVATE KEY-----
`;

function signingVectors(previous) {
  const key = createPrivateKey(TEST_KEY_PKCS8_PEM);
  const spki = spkiOf(key);
  const { events, elements } = signingInputs();
  const keyId = 'VN-BANK-T1';
  const issuer = 'Test Bank (VN)';
  const ring = keyring([{ keyId, issuer, trustLevel: 'ATTESTED', publicKeyJwk: createPublicKey(key).export({ format: 'jwk' }) }]);

  // A signature is new on every run; keep the ones on disk while they still verify.
  const keptEvent = (payload, i) => {
    const old = previous?.signedByTypeScript?.events?.[i]?.signature;
    return old && verifyEvent(payload, old, spki) ? old : signEvent(payload, key, keyId, issuer);
  };
  const keptElement = async (element, i) => {
    const old = previous?.signedByTypeScript?.elements?.[i];
    if (old && JSON.stringify({ ...old, digest: undefined, signature: undefined }) === JSON.stringify({ ...element, digest: undefined, signature: undefined })) {
      const checked = await verifyEvidenceSignatures({ schemaVersion: 'settlement-evidence/0.1', scenario: 't', dataMode: 'SYNTHETIC', notRealPayment: true, elements: { x: old } }, ring);
      if (checked.elements.x.signature.status === 'VALID') return old;
    }
    return finishElement(element, key, keyId, issuer);
  };
  return (async () => ({
    about: 'jcs: RFC 8785 bytes of each value. events: bytes an event signature is over. elements: the content digest and the bytes an element signature is over (the element with its digest, without its unsigned fields). signedByTypeScript: made with testKey — the Java SDK must verify them.',
    domains: { event: EVENT_DOMAIN, digest: DIGEST_DOMAIN },
    testKey: { warning: 'for these vectors only — it is published here and protects nothing', pkcs8Pem: TEST_KEY_PKCS8_PEM, spkiBase64: spki, keyId, issuer },
    jcs: jcsValues().map((value) => {
      const r = attempt(() => hex(jcs(value)));
      return r.error ? { value, error: r.error } : { value, utf8Hex: r.ok, text: Buffer.from(r.ok, 'hex').toString('utf8') };
    }),
    events: events.map((payload) => ({ payload, signingBytesHex: hex(eventSigningBytes(payload)) })),
    elements: elements.map((element) => {
      const digest = elementDigest(element);
      return { element, digest, signingBytesHex: hex(signedBytes({ ...element, digest })) };
    }),
    signedByTypeScript: {
      events: events.map((payload, i) => ({ payload, signature: keptEvent(payload, i) })),
      elements: await Promise.all(elements.map((element, i) => keptElement(element, i))),
    },
  }))();
}

// ── Submissions: what submitSwift() decides ────────────────────────────────

/** The quote the stand-in platform answers with: `QUOTE` of test/client.test.ts. */
const QUOTE = {
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

/**
 * The stand-in platform of test/client.test.ts (`fakePlatform()`): it quotes,
 * takes a settlement and keeps what was posted, answers the exact lookups of
 * the ledger, answers for one settlement and cancels one.
 *
 * What it accepts, refuses and finds is decided by the platform's own store
 * (`SourceLedger` runs `apps/core/src/remit/store.ts` on an in-memory
 * database) — one message, one settlement, exactly as the platform holds it.
 *
 * Its ledger can be filled beforehand: those are settlements from before the
 * platform kept that rule, and they take their places as a start gives them.
 * A step can be raced: `race: '<error>'` keeps the settlement and answers
 * that error, as when the same request got there first;
 * `race: { taken: <settlement> }` has another process's settlement accepted
 * just before this POST is looked at — the moment the client's own lookups
 * could not see.
 */
async function standInPlatform(ledger) {
  const calls = [];
  const settlements = new Map();
  const sources = await SourceLedger.open();
  const elementsOf = (v) => v.events.find((e) => e.type === 'BANK_EVIDENCE_SUBMITTED')?.payload;
  for (const v of ledger) settlements.set(v.payment_id, structuredClone(v));
  await sources.addFromBefore(ledger);
  const next = { race: null };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // What a GET of the ledger asked for: its parameters as sent, without the paging ones.
    const asked = [...url.searchParams].filter(([k]) => k !== 'limit' && k !== 'cursor').map(([k, v]) => `${k}=${v}`).join('&');
    calls.push({ method, path: url.pathname, asked, body, idem: init?.headers?.['idempotency-key'] });
    if (url.pathname === '/v1/quotes') {
      return reply(201, { ...QUOTE, trade: { currency: 'USD', amount: Number(body.trade.amount).toFixed(2) } });
    }
    if (method === 'POST' && url.pathname === '/v1/settlements') {
      const id = body.payment_id;
      const race = next.race;
      next.race = null;
      if (race && typeof race === 'object') {
        // The other process's instruction arrives first, and is judged like any other.
        const other = structuredClone(race.taken);
        if (!(await sources.accept(other.payment_id, elementsOf(other)))) settlements.set(other.payment_id, other);
      }
      const refusal = await sources.accept(id, body.evidence_elements);
      if (refusal) return reply(refusal.status, refusal.body);
      settlements.set(id, {
        payment_id: id, state: 'BANK_AUTHORIZED', evidence_level: null, evidence_available: false, chain_tx: null, attestation: null,
        events: [{ seq: 0, type: 'REQUEST_ACCEPTED', issuer: 'STONEHASH', at: '2026-11-17T00:00:00.000Z', payload: {}, sig: null },
          { seq: 1, type: 'BANK_EVIDENCE_SUBMITTED', issuer: 'VN-BANK-T1', at: '2026-11-17T00:00:00.100Z', payload: body.evidence_elements, sig: null }],
      });
      if (typeof race === 'string') return reply(409, { error: race, message: 'another request for this payment was taken a moment earlier' });
      return reply(202, { payment_id: id, state: 'BANK_AUTHORIZED' });
    }
    if (method === 'GET' && url.pathname === '/v1/settlements') {
      const page = await sources.list(url.searchParams);
      if ('status' in page) return reply(page.status, page.body);
      const rows = page.ids.map((id) => settlements.get(id)).map((v) => ({ payment_id: v.payment_id, state: v.state }));
      return reply(200, { data: rows, page: { total: page.total, returned: rows.length, next_cursor: page.nextCursor } });
    }
    const cancel = /^\/v1\/settlements\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === 'POST' && cancel) {
      const hit = settlements.get(decodeURIComponent(cancel[1]));
      if (!hit) return reply(404, { error: 'not_found', message: 'no such settlement' });
      if (hit.state === 'CANCELLED') return reply(409, { error: 'not_cancellable', message: 'the settlement is already CANCELLED' });
      hit.state = 'CANCELLED';
      return reply(200, { payment_id: hit.payment_id, state: 'CANCELLED' });
    }
    const one = /^\/v1\/settlements\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && one) {
      const hit = settlements.get(decodeURIComponent(one[1]));
      return hit ? reply(200, hit) : reply(404, { error: 'not_found', message: 'no such settlement' });
    }
    return reply(404, { error: 'not_found', message: url.pathname });
  };
  return { calls, next, fetch };
}

/** The error a step ends in: for a RemitApiError also its HTTP status and, where it names one, the settlement that already stands for the message. */
function stepError(e) {
  const out = errorOf(e);
  if (e instanceof RemitApiError) {
    out.name = 'RemitApiError';
    out.status = e.status;
    if (e.existingPaymentId !== undefined) out.existingPaymentId = e.existingPaymentId;
    if (e.ground !== undefined) out.ground = e.ground;
  }
  return out;
}

/** `{ sha256Of }`, `{ contentOf, index }` and `{ paymentIdOf, index }` in a ledger entry: the digests, and the derived payment id, of a parse case's message. */
function resolveLedger(value) {
  if (Array.isArray(value)) return value.map(resolveLedger);
  if (!value || typeof value !== 'object') return value;
  const message = (name) => {
    if (!inputs.has(name)) throw new Error(`ledger: no parse case named ${name}`);
    return inputs.get(name);
  };
  if (typeof value.sha256Of === 'string') return parseSwiftMessages(message(value.sha256Of))[0].digest;
  if (typeof value.contentOf === 'string') return swiftContentDigest(parseSwiftMessage(message(value.contentOf), { index: value.index ?? 0 }));
  // The id this SDK derives for that message, for the scenarios' client (institution VN-BANK-T1).
  if (typeof value.paymentIdOf === 'string') return swiftPaymentId('VN-BANK-T1', parseSwiftMessage(message(value.paymentIdOf), { index: value.index ?? 0 }));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveLedger(v)]));
}

async function scenarioVectors() {
  const key = createPrivateKey(TEST_KEY_PKCS8_PEM);
  const realFetch = globalThis.fetch;
  const cases = [];
  try {
    for (const sc of scenarioCases()) {
      unique('scenarios', sc.name);
      const ledger = resolveLedger(sc.ledger ?? []);
      const platform = await standInPlatform(ledger);
      globalThis.fetch = platform.fetch;
      const client = new RemitClient({
        core: 'http://platform.test', apiKey: sc.apiKey ?? 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank', key,
      });
      const answered = [];
      const steps = [];
      const count = (method, p) => platform.calls.filter((x) => x.method === method && x.path === p).length;
      const paymentIdOf = (ref) => {
        if (typeof ref === 'string' || ref === undefined) return ref;
        const id = answered[ref.step];
        if (typeof id !== 'string') throw new Error(`scenario ${sc.name}: step ${ref.step} answered no payment id`);
        return id;
      };
      for (const step of sc.steps) {
        const before = platform.calls.length;
        if (step.cancel) {
          const paymentId = paymentIdOf({ step: step.cancel.step });
          let outcome;
          try {
            const done = await client.cancel(paymentId, step.cancel.reason);
            outcome = { paymentId: done.payment_id, state: done.state };
          } catch (e) { outcome = { error: stepError(e) }; }
          answered.push(paymentId);
          steps.push({ cancel: { paymentId, reason: step.cancel.reason }, expect: { outcome, posts: count('POST', '/v1/settlements'), quotes: count('POST', '/v1/quotes') } });
          continue;
        }
        let message;
        let recorded;
        if (typeof step.message === 'string') {
          if (!inputs.has(step.message)) throw new Error(`scenario ${sc.name}: no parse case named ${step.message}`);
          message = inputs.get(step.message);
          recorded = { parse: step.message };
        } else {
          message = step.message.text;
          recorded = { as: 'string', text: step.message.text };
        }
        const { supplementByAccount, paymentId, ...rest } = step.options ?? {};
        const options = { ...rest, ...(paymentId === undefined ? {} : { paymentId: paymentIdOf(paymentId) }) };
        const given = { ...options, ...(supplementByAccount ? { supplementByAccount } : {}) };
        if (supplementByAccount) {
          options.supplement = (p) => (p.debtor.account && Object.hasOwn(supplementByAccount, p.debtor.account) ? supplementByAccount[p.debtor.account] : undefined);
        }
        const race = step.race === undefined ? null : resolveLedger(step.race);
        platform.next.race = race;
        let outcome;
        try {
          const sent = await client.submitSwift(message, options);
          outcome = { paymentId: sent.paymentId, state: sent.state, already: sent.already };
        } catch (e) { outcome = { error: stepError(e) }; }
        platform.next.race = null;
        answered.push(outcome.paymentId);
        const mine = platform.calls.slice(before);
        const post = mine.filter((x) => x.method === 'POST' && x.path === '/v1/settlements').at(-1);
        const expect = {
          outcome,
          posts: count('POST', '/v1/settlements'),
          quotes: count('POST', '/v1/quotes'),
          searched: mine.filter((x) => x.method === 'GET' && x.path === '/v1/settlements').map((x) => x.asked),
        };
        if (post) {
          const auth = post.body.bank_authorization;
          expect.posted = {
            idempotencyKey: post.idem,
            payment_id: post.body.payment_id,
            sourceMessage: post.body.evidence_elements.bankInstruction.sourceMessage ?? null,
            instruction_ref: auth.instruction_ref,
            ...(auth.uetr === undefined ? {} : { uetr: auth.uetr }),
          };
        }
        steps.push({ message: recorded, options: given, ...(race ? { race } : {}), expect });
      }
      cases.push({ name: sc.name, ...(sc.note ? { note: sc.note } : {}), ...(sc.apiKey ? { apiKey: sc.apiKey } : {}), ...(ledger.length ? { ledger } : {}), steps });
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return {
    about: 'Each case is one RemitClient against one stand-in platform, its steps in order: submitSwift(message, options) → expect.outcome; how many settlements and quotes had been posted after the step; what the ledger was asked for (`searched`: the query of each GET /v1/settlements, without limit and cursor); and, for a step that posted, what was posted. A step that posted and was refused still counts in `posts`.',
    client: { core: 'http://platform.test', apiKey: 'sk_test_x', institutionId: 'VN-BANK-T1', institutionName: 'Test Bank', key: 'testKey of signing.json' },
    platform: {
      quote: QUOTE,
      rules: [
        'POST /v1/quotes answers the quote above, its trade amount the one asked for, written with two decimals.',
        'One message, one settlement — the platform\'s own rule (apps/core/src/remit/store.ts: sourceRefOf, sourceConflict, createFromMessage, backfillSourceRefs), which this stand-in runs unchanged. A settlement whose events[..BANK_EVIDENCE_SUBMITTED].payload.bankInstruction.sourceMessage is there takes that message\'s place: a row { paymentId, sha256, index (0 when absent), uetr, valueDate, content, twinKey }. sha256, uetr and content are compared in lower case; instructionId, endToEndId and messageId are trimmed, and an endToEndId that is NOTPROVIDED, NONREF or NOREF (any case) counts as none. twinKey: none without content; with an instructionId or an endToEndId it is [instructionId, endToEndId, valueDate or "", content]; with neither but a messageId it is [type, messageId, index, valueDate or "", content]; otherwise none. A reference that is not well formed (no type, sha256 not 64 hex, index not an integer 0..1000000, uetr not a UUID, content not 64 hex, valueDate not a calendar day YYYY-MM-DD, an identifier that is not text of at most 256 characters) is answered 400 invalid_source_message.',
        'A new row N conflicts — checked in this order, the first that applies decides: (1) a row of the same sha256 and index → duplicate_source_message, ground "message"; (2) a recognition recorded earlier for N\'s (sha256, index) → duplicate_source_message, ground "twin", the settlement recorded; (3) N has a uetr and a row holds it → reference_reused (ground "uetr") when that row is another transaction of N\'s file (same sha256, other index) or both state content and it differs, else duplicate_source_message ground "uetr" and the recognition (N.sha256, N.index) → that settlement is recorded; (4) N has a twinKey: among the rows with that twinKey and another sha256 — only rows without a uetr when N has one — leaving out any settlement that a recognition of N\'s file (same sha256, any index) already points at, the oldest → duplicate_source_message: ground "twin_undated" when N states no valueDate (nothing is recorded), otherwise ground "twin", the recognition (N.sha256, N.index) → that settlement is recorded and, when N has a uetr, that row takes N\'s uetr. No conflict: the settlement is kept and takes its place.',
        'The ledger\'s settlements are on the platform before the first step, as settlements from before the rule: each takes its place in the order given — those in state CANCELLED, RETURNED or EXCEPTION after the others — by the same rule, its reference read leniently (whatever identifies it is kept; a sha256 that cannot be read is replaced by one of the settlement\'s own). One that conflicts takes no place.',
        'POST /v1/settlements: with `race: { taken }` that settlement is first judged like a POST of its own, and kept unless it is refused. A payment_id the platform already holds is answered 409 { error: "duplicate_payment", message: "exists" }. A conflict is answered 409 { existing_payment_id, ground, error, message } and nothing is kept; the messages are "UETR <uetr> is already on settlement <id>, which is a different payment", "this message\'s payment is already settlement <id> — the same transaction of the same message", "… — the same UETR", "… — the same payment in another message" and "this payment cannot be told from settlement <id>: the message states no value date". Otherwise the settlement is kept under its payment_id — state BANK_AUTHORIZED, events [REQUEST_ACCEPTED, BANK_EVIDENCE_SUBMITTED with payload = the posted evidence_elements] — and answered 202 { payment_id, state }; with `race: "<error>"` it is kept and answered 409 with that error and the message "another request for this payment was taken a moment earlier".',
        'GET /v1/settlements lists settlements newest first (the one taken last comes first), `limit` rows a page (default 25, at most 100) with page.next_cursor for the next. With source_uetr, or source_content (and source_value_date), only those that hold a place with that uetr (the one a row took from its other rendering included), or that content (and valueDate). A source_uetr that is not a UUID, a source_content that is not 64 hex characters, or a source_value_date without source_content or not YYYY-MM-DD is answered 400 invalid_source_lookup.',
        'GET /v1/settlements/{id} answers the settlement, or 404 not_found. POST /v1/settlements/{id}/cancel sets it CANCELLED.',
      ],
    },
    cases,
  };
}

// ── Write, or compare ──────────────────────────────────────────────────────

// `--only=parse,mapping` writes (or checks) just those files — for the one who changed a
// reader while someone else has the submission path open, and the other way round. The
// parse vectors are always computed: the other files look their messages up in them.
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').map((n) => n.trim()).filter(Boolean);
const wanted = (name) => !only || only.includes(name) || only.includes(`${name}.json`);
const parsed = parseVectors();
const files = {};
if (wanted('parse')) files['parse.json'] = parsed;
if (wanted('mapping')) files['mapping.json'] = mappingVectors();
if (wanted('status')) files['status.json'] = statusVectors();
const signingPath = path.join(OUT, 'signing.json');
if (wanted('signing')) files['signing.json'] = await signingVectors(existsSync(signingPath) ? JSON.parse(readFileSync(signingPath, 'utf8')) : null);
if (wanted('scenarios')) files['scenarios.json'] = await scenarioVectors();
if (Object.keys(files).length === 0) throw new Error(`--only names none of parse, mapping, status, signing, scenarios: ${only.join(', ')}`);

mkdirSync(OUT, { recursive: true });
let differs = 0;
for (const [name, value] of Object.entries(files)) {
  const text = `${JSON.stringify(value, null, 1)}\n`;
  const file = path.join(OUT, name);
  if (check) {
    const same = existsSync(file) && readFileSync(file, 'utf8') === text;
    if (!same) { differs++; console.error(`${name}: differs from what the TypeScript SDK answers now`); }
    continue;
  }
  writeFileSync(file, text);
  const n = value.cases?.length ?? (value.jcs.length + value.events.length + value.elements.length);
  console.log(`${name.padEnd(14)} ${String(n).padStart(4)} cases  ${(text.length / 1024).toFixed(0)} kB`);
}
if (check) {
  if (differs) process.exit(1);
  console.log('golden vectors are what the TypeScript SDK answers');
}
