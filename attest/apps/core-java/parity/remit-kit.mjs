/**
 * What the settlement rail's case files (cases/remit-a-*.mjs, cases/remit-b-*.mjs) share: the seeded organisations
 * and their keys, the bank's side (the deployed SDK, signing with the seeded test keys), requests to a server's
 * partner stand-in, and — the part that needs care — which members of an answer are new on every run.
 *
 * Nothing here is a case; parity/run.mjs loads the files of cases/ only.
 *
 * What changes from run to run, and nothing else, is named: the time of an event, a signature (ECDSA draws a fresh
 * number each time), a digest or a commitment over something that holds a time or a fresh nonce, an id a server
 * draws. Everything else in a settlement is compared to the letter: the state, the events' types, order and issuers,
 * every other member of every payload in the order written — the travel-rule digest, the deposit address, the
 * transaction hash and the bank reference among them, which the stand-in makes functions of the payment id so that
 * two servers are told the same.
 */
import { createPrivateKey } from 'node:crypto';
import { RemitClient } from '../../../packages/attest-remit/src/index.ts';
import { signEvent } from '../../core/src/remit/sign.ts';
import { readEnvFile } from '../tools/check-test-env.mjs';

const J = { 'Content-Type': 'application/json' };

/** Indices `from` and up, as a pattern: what a run appended to a seeded settlement, and not the seeded events before it. */
const indices = (from) => (from <= 0 ? '\\d+' : `(?:${Array.from({ length: 200 - from }, (_, i) => from + i).join('|')})`);

/** Members of an event's payload that are a time, a draw or a digest over one. */
const NEW_IN_PAYLOAD = ['accepted_at', 'verified_at', 'sent_at', 'ciphertext_commitment', 'raised_at', 'resolved_at', 'requested_at', 'received_at', 'approved_at', 'valid_until',
  'issued_at', 'observed_at', 'submitted_at', 'credited_at', 'failed_at', 'returned_at', 'reconciled_at', 'committed_at', 'anchored_at', 'attestation_id', 'commitment', 'noted_at'];
/** The same inside an evidence element a partner signed: its digest covers its times, its signature is fresh. */
const ELEMENTS = '(?:travel_rule_element|chain_transfer_element|payout_receipt_element)';
const NEW_IN_ELEMENT = ['digest', 'approvedAt', 'approvalDigest', 'observedAt', 'paidAt'];

/**
 * A list of events (`$.events` of a settlement, `$.package.events` of its evidence): what is new on every run, in the
 * events from index `from` on. `prefix` is the path of the list.
 */
export function eventsVolatile(prefix, from = 0) {
  const e = `^${prefix.replace(/[$.[\]]/g, '\\$&')}\\[${indices(from)}\\]`;
  return [
    new RegExp(`${e}\\.at$`),
    new RegExp(`${e}\\.sig\\.sig$`),
    new RegExp(`${e}\\.payload\\.(?:${NEW_IN_PAYLOAD.join('|')})$`),
    new RegExp(`${e}\\.payload\\.signature\\.sig$`), // the instruction's own signature, inside SETTLEMENT_INSTRUCTED
    new RegExp(`${e}\\.payload\\.${ELEMENTS}\\.(?:${NEW_IN_ELEMENT.join('|')})$`),
    new RegExp(`${e}\\.payload\\.${ELEMENTS}\\.signature\\.value$`),
    new RegExp(`${e}\\.payload\\.payout_receipt_element\\.local_credit_confirmation\\.(?:payload\\.credited_at|sig\\.sig)$`),
  ];
}

/**
 * `GET /v1/settlements/:id`. `from`: the index of the first event the run appended (0 for a settlement the run made;
 * for a seeded one carried on, the number of events it was seeded with — those are compared to the letter).
 * `made`: the settlement itself was made by the run (its `created_at` is each server's own).
 */
export const viewVolatile = (from = 0, { made = from === 0 } = {}) => [...(made ? ['$.created_at'] : []), '$.updated_at', '$.attestation.id', ...eventsVolatile('$.events', from)];

/** One row of `GET /v1/settlements` (`$.data[n]`), for rows the run made or moved. */
export const LEDGER_ROWS = [/^\$\.data\[\d+\]\.(?:created_at|updated_at)$/, /^\$\.data\[\d+\]\.attestation\.id$/];

/**
 * `GET /v1/settlements/:id/evidence` of a package made in the run. The package repeats the events and the elements;
 * the verdict quotes the elements' digests and times; the registry snapshot and the package say when they were made;
 * the commitment is over all of it and a fresh nonce.
 */
export function evidenceVolatile(from = 0) {
  const el = '(?:chainTransfer|payoutReceipts\\[\\d+\\]|travelRule)';
  return [
    ...eventsVolatile('$.package.events', from),
    new RegExp(`^\\$\\.package\\.evidence\\.elements\\.${el}\\.(?:${NEW_IN_ELEMENT.join('|')})$`),
    new RegExp(`^\\$\\.package\\.evidence\\.elements\\.${el}\\.signature\\.value$`),
    /^\$\.package\.evidence\.elements\.payoutReceipts\[\d+\]\.local_credit_confirmation\.(?:payload\.credited_at|sig\.sig)$/,
    '$.package.trust_registry.taken_at', '$.package.generated_at', '$.commitment.value', '$.commitment.nonce', '$.attestation.id',
    '$.attestation.bundle.generated_at',
  ];
}

/**
 * The stand-in's answer to `POST /control/callback`: `{ sent, answer }` — what it signed and sent, and what the
 * server answered (status and body: compared to the letter).
 */
export const CALLBACK_SENT = [
  '$.sent.sig.sig',
  new RegExp(`^\\$\\.sent\\.payload\\.(?:${NEW_IN_PAYLOAD.join('|')})$`),
  new RegExp(`^\\$\\.sent\\.payload\\.${ELEMENTS}\\.(?:${NEW_IN_ELEMENT.join('|')})$`),
  new RegExp(`^\\$\\.sent\\.payload\\.${ELEMENTS}\\.signature\\.value$`),
  /^\$\.sent\.payload\.payout_receipt_element\.local_credit_confirmation\.(?:payload\.credited_at|sig\.sig)$/,
];

/** A sentence that quotes a server's own partner address, or its runtime's word for why a connection failed. */
export const PARTNER_ADDRESS = [[/not reachable at http:\/\/127\.0\.0\.1:\d+/, 'not reachable at <its partner>']];
/** An institution id a server issued on the way (an earlier case activated a product): country, role, six characters of its own. */
export const ISSUED = [[/-(BANK|EX)-[0-9A-F]{6}$/, '-$1-<id>']];

export function remitKit({ seed, settings, ref }) {
  const R = seed.remit;
  if (!R || R.skipped || !R.orgs) return null;
  const O = R.orgs;
  const tokens = [settings.ref, settings.java].map((f) => readEnvFile(f).REMIT_ADMIN_TOKEN);
  if (!tokens[0] || tokens[0] !== tokens[1]) throw new Error('the two settings files do not carry the same REMIT_ADMIN_TOKEN (run.mjs --ref-env / --java-env name them)');
  const TOKEN = tokens[0];
  const key = (o) => ({ Authorization: `Bearer ${o.key}` });
  const jkey = (o) => ({ ...J, ...key(o) });
  const clients = new Map();
  const keys = new Map();
  const bankKey = (name) => { if (!keys.has(name)) keys.set(name, createPrivateKey(O[name].bank.pem)); return keys.get(name); };
  /** The bank of a seeded organisation, as its system would be set up: the deployed SDK with the seeded key. Asks nothing of a server but, for mode B, the registry. */
  const client = (name) => {
    if (!clients.has(name)) clients.set(name, new RemitClient({ core: ref, apiKey: O[name].key, institutionId: O[name].bank.id, institutionName: O[name].bank.name, key: bankKey(name) }));
    return clients.get(name);
  };
  /** What the bank signs beside an instruction: a cancel, an answer to a question, a day's manifest. */
  const sign = (name, payload) => signEvent(payload, bankKey(name), O[name].bank.id, O[name].bank.name);
  const P = R.partner.institutions;
  /** An instruction on a seeded quote, signed once: the same bytes go to both servers. */
  const build = (name, quote, id, opts = {}) => client(name).buildInstruction(quote, opts.parties ?? R.parties, { paymentId: id, beneficiaryInstitution: P.bfi.id, invoiceRef: `INV-${id}`, ...opts, parties: undefined }).body;
  const buildB = async (name, quote, id, opts = {}) => (await client(name).buildInstructionAsync(quote, opts.parties ?? R.parties, { paymentId: id, beneficiaryInstitution: P.bfi.id, invoiceRef: `INV-${id}`, ...opts, parties: undefined, travelRule: 'B' })).body;

  // ── requests to a server's partner stand-in (`to: 'partner'`) ────────────────────────────────────────────────
  const q = (params) => Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const partner = {
    /** What the stand-in does for a payment (tools/stand-in-partner.mjs, POST /control/plan). */
    plan: (name, body) => ({ name, to: 'partner', method: 'POST', target: '/control/plan', headers: J, body }),
    /** Returns when the n-th such request has arrived at the stand-in — the server has done everything before that call. */
    arrived: (name, id, step, more = {}) => ({ name, to: 'partner', target: `/control/wait?${q({ payment_id: id, step, timeout: 8000, ...more })}`, volatile: ['$.entry'], expect: { '$.arrived': true } }),
    release: (name, id, more = {}) => ({ name, to: 'partner', method: 'POST', target: '/control/release', headers: J, body: { payment_id: id, ...more } }),
    /** One callback, signed and sent by each server's own stand-in; the answer holds what the server said. */
    callback: (name, id, spec, more = {}) => ({ name, to: 'partner', method: 'POST', target: '/control/callback', headers: J, body: { payment_id: id, ...(typeof spec === 'string' ? { type: spec } : spec) }, volatile: CALLBACK_SENT, ...more }),
    idle: (name, id) => ({ name, to: 'partner', target: `/control/idle?${q({ payment_id: id, timeout: 8000 })}`, expect: { '$.idle': true } }),
    close: (name, ms) => ({ name, to: 'partner', method: 'POST', target: '/control/close', headers: J, body: { ms } }),
    /** What the stand-in remembers of a payment: its state there, the transaction it moved. */
    ledger: (name, id) => ({ name, to: 'partner', target: `/control/ledger?${q({ payment_id: id })}`, volatile: [/^\$\.record\.(?:received_at|approved_at|valid_until|ack_digest)$/] }),
    /** The requests it received for a payment and the callbacks it sent, as `step:status` — the order of the calls. */
    hook: (name, hookName) => ({ name, to: 'partner', target: `/hooks/${hookName}?summary=1` }),
  };
  // ── a settlement, from its acceptance to where it comes to rest ───────────────────────────────────────────────
  const S = '/v1/settlements';
  /** Where a settlement rests: its state and the type of its last event (run.mjs `settle.until`). */
  const REST = {
    confirmed: { state: 'BENEFICIARY_CREDIT_CONFIRMED', last: 'EVIDENCE_COMMITTED' }, rfi: { state: 'TRAVEL_RULE_PENDING', last: 'TRAVEL_RULE_RFI' },
    rejected: { state: 'CANCELLED', last: 'TRAVEL_RULE_REJECTED' }, returned: { state: 'RETURNED', last: 'USDC_RETURNED' }, l1: { state: 'PAYOUT_IN_PROGRESS', last: 'EVIDENCE_INSUFFICIENT' },
    exception: { state: 'EXCEPTION', last: 'EXCEPTION' }, mismatch: { state: 'EXCEPTION', last: 'SETTLEMENT_RECONCILED' }, onchain: { state: 'ONCHAIN_SETTLED', last: 'USDC_TRANSFER_CONFIRMED' },
  };
  const flow = {
    /** An instruction that is accepted: the answer, and then each server's own settlement asked until it rests at `until`. */
    accept: (name, org, id, body, until, more = {}) => ({ name, method: 'POST', target: S, headers: { ...jkey(O[org]), 'Idempotency-Key': `rb-${id}` }, body, volatile: ['$.accepted_at'],
      expect: { '$.state': 'BANK_AUTHORIZED', '$.payment_id': id }, settle: { target: `${S}/${id}`, headers: key(O[org]), until, idle: id }, ...more }),
    /** The settlement as it stands; `from` is the number of events it was seeded with (0: the run made it). */
    view: (name, org, id, from = 0, more = {}) => ({ name, target: `${S}/${id}`, headers: key(O[org]), volatile: viewVolatile(from), blur: PARTNER_ADDRESS, ...more }),
    /** A seeded settlement the run carried on: its seeded events (the first `from`) and its creation time are compared to the letter. */
    seeded: (name, org, id, from, more = {}) => ({ name, target: `${S}/${id}`, headers: key(O[org]), volatile: viewVolatile(from, { made: false }), blur: PARTNER_ADDRESS, ...more }),
    evidence: (name, org, id, from = 0, more = {}) => ({ name, target: `${S}/${id}/evidence`, headers: key(O[org]), volatile: evidenceVolatile(from), ...more }),
    chain: (name, org, id, more = {}) => ({ name, target: `${S}/${id}/chain`, headers: key(O[org]), ...more }),
  };
  /** How many events a seeded settlement has, asked of the reference when the file loads: what comes after is the run's. */
  const counts = new Map();
  const seededEvents = async (org, id) => {
    if (!counts.has(id)) {
      const res = await fetch(`${ref}${S}/${encodeURIComponent(id)}`, { headers: key(O[org]) });
      if (res.status !== 200) throw new Error(`the reference does not show the seeded settlement ${id} (${res.status}) — is the seed file the one of these schemas?`);
      counts.set(id, (await res.json()).events.length);
    }
    return counts.get(id);
  };
  return { R, O, P, TOKEN, J, S, key, jkey, admin: { ...J, 'X-Admin-Token': TOKEN }, client, sign, build, buildB, partner, flow, REST, seededEvents, quotes: (name) => R.quotes.fresh[name] };
}
