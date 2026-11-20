/**
 * The console's one network module.
 *
 * Every call goes through `send`, which is the only place a fetch is made and
 * therefore the only place that has to get credentials, errors and the API's
 * base URL right. The alternative — a fetch at each call site — is how a page
 * ends up with three different ideas about what a 401 means.
 *
 * `credentials: 'include'` is required even same-origin here, because the
 * console is served from its own host in production (`app-sandbox.` against
 * `api-sandbox.`) and a cookie would otherwise be dropped on exactly the
 * deployment that matters.
 */
import { t } from './i18n.ts';

/** Where the API lives. Empty means same origin, which is the test box. */
const BASE = document.querySelector<HTMLMetaElement>('meta[name="attest-api"]')?.content ?? '';


/**
 * A failed call, carrying the server's own machine code.
 *
 * The service writes its error messages for whoever has to fix them, so the UI
 * shows `message` verbatim rather than substituting something vaguer. `code`
 * is for the two cases the page must handle structurally rather than display:
 * `not_signed_in` and `quota_exhausted`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

/**
 * What this page actually sent, in order.
 *
 * The sandbox shows these so a reader can check the screen against the wire.
 * That only means something if the record is taken at the point of the call
 * rather than written by the feature describing itself — a hand-maintained
 * list would drift the first time someone changed a request and forgot, and
 * the drift would be invisible precisely where the claim is "this is real".
 *
 * Capped, because a long session should not grow a transcript without bound.
 */
export interface ApiCall {
  method: string;
  path: string;
  request?: unknown;
  status: number;
  response: unknown;
  ms: number;
  at: string;
}

const CALLS: ApiCall[] = [];
const CALL_LIMIT = 40;
let onCall: (() => void) | null = null;

export const calls = (): readonly ApiCall[] => CALLS;
export const onApiCall = (fn: () => void): void => { onCall = fn; };

function record(c: ApiCall): void {
  CALLS.unshift(c);
  if (CALLS.length > CALL_LIMIT) CALLS.length = CALL_LIMIT;
  onCall?.();
}

/** Credentials must never reach the transcript the page renders. */
function scrub(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of ['password', 'api_key_secret', 'token']) {
    if (k in out) out[k] = '[redacted]';
  }
  return out;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
  } catch {
    record({ method, path, request: scrub(body), status: 0, response: { error: 'unreachable' },
      ms: Math.round(performance.now() - started), at: new Date().toISOString() });
    // Distinguished from an API error on purpose: "the service said no" and "we
    // could not reach the service" need different reactions from the reader.
    throw new ApiError(0, 'unreachable', t(
      'API에 연결할 수 없습니다. 서비스가 멈췄거나, 이 페이지가 다른 호스트를 가리키도록 설정되어 있을 수 있습니다.',
      'Could not reach the API. It may be down, or this page may be configured for a different host.'));
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError(res.status, 'bad_response', t(
        `API가 JSON이 아닌 응답을 돌려주었습니다 (HTTP ${res.status}).`,
        `The API returned something that is not JSON (HTTP ${res.status}).`));
    }
  }
  record({
    method, path, request: scrub(body), status: res.status, response: scrub(json),
    ms: Math.round(performance.now() - started), at: new Date().toISOString(),
  });

  if (!res.ok) {
    throw new ApiError(res.status,
      typeof json['error'] === 'string' ? json['error'] : 'error',
      typeof json['message'] === 'string' ? json['message'] : `HTTP ${res.status}`);
  }
  return json as T;
}

// ── the evaluation sandbox ─────────────────────────────────────────────────

export interface ScenarioInfo { id: string; title: string; teaches: string }
export interface TamperInfo {
  id: string; label: string; asks: string;
  needs: { target?: readonly string[]; amount?: string; document?: readonly string[] };
}
export interface Catalogue {
  scenarios: ScenarioInfo[];
  tampers: TamperInfo[];
  policy: Record<string, unknown>;
  policyDigest: string;
  dataMode: string;
  notRealPayment: boolean;
  reconcileEndpoint: string;
  bundleEndpoint: string;
}
export interface TamperStep { id: string; target?: string; amount?: string; document?: string }

export interface Finding {
  code: string; axis: string; severity: 'info' | 'warning' | 'blocking';
  element?: string; field?: string; expected?: string; actual?: string;
  tolerance?: string; detail: string;
}
export interface Verdict {
  policyVersion: string;
  policyDigest: string;
  scenario: string;
  dataMode: string;
  axes: Record<string, { state: string; findings: Finding[] }>;
  findings: Finding[];
  manualReviewRequired: boolean;
  regulatoryDecision: string;
}
export interface EvidencePackage {
  schema: string; bundleId: string; generatedAt: string;
  evidence: Record<string, unknown>; policy: Record<string, unknown>;
  verdict: Verdict;
  verificationMaterial: {
    issuerKeys: { id: string; issuer: string; trustLevel: string; publicKeyJwk: unknown }[];
    policyDigest: string;
  };
  digest: string;
}
export interface PackageCheck {
  digestOk: boolean;
  recordedDigest: string;
  recomputedDigest: string;
  policyUnchanged: boolean;
  reproduced: boolean;
  differences: { axis: string; recorded: string; now: string }[];
  verdict: Verdict;
}

// ── shapes the dashboard renders ───────────────────────────────────────────

export interface Quota { used: number; limit: number; remaining: number; resets: string }

export interface Overview {
  account: { id: string; email: string; created_at: string; last_login_at: string | null };
  org: { id: string; slug: string; name: string; created_at: string };
  api_key: { id: string; label: string; prefix: string; created_at: string } | null;
  issuer_keys: { id: string; label: string; algorithm: string }[];
  quota: Quota;
  bitcoin_network: string;
  anchor_backend: string;
  /** The honest sentence about what this network can and cannot support. */
  public_verifiability: string;
  /** Inscription ceilings. Absent on a deployment that predates them. */
  inscription?: InscriptionLimits;
  /** Explorer indexing this chain, or '' when none does. */
  explorer_base_url?: string;
  /** Explorer for the settlement rail's chain, as a `{tx}` template; null on the sandbox's local chain. */
  settlement_explorer_tx_url?: string | null;
  /** Present only in the signup response. Shown once, never recoverable. */
  api_key_secret?: string;
  note?: string;
}

export interface Attestation {
  id: string;
  leaf_bytes: string;
  content_type: string | null;
  status: 'accepted' | 'batched' | 'submitted' | 'confirmed';
  batch_id: string | null;
  leaf_index: number | null;
  created_at: string;
  expires_at?: string | null;
  descriptor?: string;
  quota?: Quota;
  /** 'digest' — only the hash was sent. 'inscription' — the document is on the chain. */
  kind?: 'digest' | 'inscription';
  /** The product that anchored it: a document (`attest`), a settlement's evidence, a reserve snapshot. */
  product?: 'attest' | 'remit' | 'por';
  /** Signed anchors only. `unregistered` ≠ a weaker `registered` — see the console copy. */
  issuer_trust?: 'registered' | 'unregistered' | null;
  statement?: string | null;
  commit_txid?: string | null;
  reveal_txid?: string | null;
  /** A batched digest's anchoring transaction — the batch's, shared with its neighbours. */
  anchor_txid?: string | null;
  body_length?: number | null;
  protocol_tag?: string | null;
  block_height?: number | null;
  confirmations?: number;
}

/** What the node says about one of our transactions, right now. */
/** The inscription ceilings, straight from the server. Never hardcoded here. */
export interface InscriptionLimits {
  enabled: boolean;
  max_bytes: number;
  /** What an ordinary Bitcoin node relays. Above it a reveal needs -acceptnonstdtxn. */
  standard_relay_max_bytes: number;
  hard_ceiling_bytes: number;
}

/** One active key. The secret is absent and unrecoverable by construction. */
export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
}

/** A registered issuer key. Public material only — there is no private half here. */
/** One line of the organisation's audit log: who called what, when, with what result. */
export interface AuditEntry {
  id: string;
  at: string;
  actor_type: 'api_key' | 'session';
  actor_id: string;
  actor_label: string;
  service: 'attest' | 'remit' | 'por' | 'console';
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

export interface IssuerKey {
  id: string;
  label: string;
  algorithm: string;
  public_key: string;
  created_at: string;
}

export interface TxView {
  txid: string;
  network: string;
  backend: string;
  state: 'mempool' | 'confirmed' | 'pending' | 'unknown' | 'unavailable';
  confirmations?: number;
  block_hash?: string;
  block_height?: number;
  block_time?: string;
  size_bytes?: number;
  vsize?: number;
  weight?: number;
  fee_sats?: number;
  seen_at?: string;
  detail?: string;
  /** Present only when an explorer indexes this chain. */
  explorer_url?: string;
}

/** One reserve snapshot as the platform holds it: the statement's figures and where its anchor stands. */
export interface PorSnapshotView {
  snapshot_id: string; status: string; asof: string; root: string;
  /** False when the snapshot was accepted on the signature alone; absent on older deployments. */
  spot_check?: boolean;
  leaf_count: number; totals: Record<string, string>; commitment?: string;
  attestation: { id: string; status: string } | null; created_at: string;
}

export const api = {
  signup: (email: string, password: string): Promise<Overview> =>
    send('POST', '/v1/console/signup', { email, password }),

  login: (email: string, password: string): Promise<Overview> =>
    send('POST', '/v1/console/login', { email, password }),

  logout: (): Promise<unknown> => send('POST', '/v1/console/logout'),

  me: (): Promise<Overview> => send('GET', '/v1/console/me'),

  /** The newest records of every product, or of the one named — fifty unless more are asked for (the server gives up to 500). */
  attestations: (product?: 'attest' | 'remit' | 'por', limit?: number): Promise<{ data: Attestation[]; quota: Quota }> =>
    send('GET', `/v1/console/attestations${product ? `?product=${product}` : ''}${limit ? `${product ? '&' : '?'}limit=${limit}` : ''}`),

  anchor: (sha256: string, contentType?: string): Promise<Attestation> =>
    send('POST', '/v1/console/attestations',
      { sha256, ...(contentType ? { content_type: contentType } : {}) }),

  /**
   * The other path: send the document itself so it can be inscribed.
   *
   * This is the only call in the console that transmits file contents, and it
   * exists because the customer chose the mode where the original goes onto
   * the chain. Everything else here still sends a digest and nothing else —
   * `anchor` above is unchanged.
   *
   * Sent as a raw body rather than multipart: a form encoding would add a
   * filename and boundaries that have nothing to do with what gets inscribed,
   * and the bytes on the wire should be the bytes in the witness.
   */
  inscribe: (file: File): Promise<Attestation> =>
    sendRaw('/v1/console/attestations/inscribe', file,
      file.type || 'application/octet-stream'),

  /** Anchor a statement the customer signed on their own machine. */
  anchorSigned: (statement: unknown, issuerKeyId: string): Promise<Attestation> =>
    send('POST', '/v1/console/attestations/signed', { statement, issuer_key_id: issuerKeyId }),

  issuerKeys: (): Promise<{ data: IssuerKey[] }> => send('GET', '/v1/console/issuer-keys'),

  registerIssuerKey: (publicKey: string, label: string, algorithm: string):
    Promise<{ id: string; already: boolean }> =>
    send('POST', '/v1/console/issuer-keys',
      { public_key: publicKey, label, algorithm }),

  revokeIssuerKey: (id: string): Promise<{ ok: true }> =>
    send('POST', `/v1/console/issuer-keys/${encodeURIComponent(id)}/revoke`),

  /** Make a registered public key the one an institution's submissions are verified against. */
  setInstitutionSigningKey: (institutionId: string, issuerKeyId: string):
    Promise<{ institution_id: string; issuer_key_id: string; applied_at: string }> =>
    send('POST', `/v1/console/institutions/${encodeURIComponent(institutionId)}/signing-key`,
      { issuer_key_id: issuerKeyId }),

  /** The organisation's audit log, newest first, keyset-paged. */
  audit: (opts: { service?: string; actor_type?: string; from?: string; to?: string; q?: string;
    cursor?: string; limit?: number } = {}): Promise<{
    data: AuditEntry[];
    page: { returned: number; next_cursor: string | null };
  }> => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    return send('GET', `/v1/console/audit${s ? `?${s}` : ''}`);
  },

  /** Read-only view of one of our own transactions on the anchoring chain. */
  tx: (txid: string): Promise<TxView> => send('GET', `/v1/console/tx/${encodeURIComponent(txid)}`),

  keys: (): Promise<{ data: ApiKey[]; max_active: number }> => send('GET', '/v1/console/keys'),

  createKey: (label: string): Promise<{ id: string; prefix: string; api_key_secret: string }> =>
    send('POST', '/v1/console/keys', { label }),

  renameKey: (id: string, label: string): Promise<{ ok: true }> =>
    send('POST', `/v1/console/keys/${encodeURIComponent(id)}/label`, { label }),

  revokeKey: (id: string): Promise<{ ok: true; active_remaining: number }> =>
    send('POST', `/v1/console/keys/${encodeURIComponent(id)}/revoke`),


  // ── products (remit · por) ───────────────────────────────────────────────
  products: (): Promise<{
    products: { product: string; plan: string; status: string; config: Record<string, unknown>; created_at: string }[];
    institutions: { id: string; role: string; name: string; country: string | null;
      /** The public key the rails verify this institution's signatures against; absent on older deployments. */
      signing_spki?: string | null }[];
    billing: {
      month_start: string;
      attest: { plan: string; meter: string; quota: number; used: number };
      remit: { meter: string; settlements: number; included_anchors: number };
      por: { meter: string; snapshots: number; included_anchors: number };
      /** This month's bill so far from the deployment's price list; absent on older deployments. */
      charges?: {
        currency: string;
        period: { start: string; end: string };
        lines: { product: string; unit: string; quantity: number; monthly_fee: number; unit_price: number; amount: number }[];
        total: number;
      };
    };
  }> => send('GET', '/v1/console/products'),

  activateProduct: (body: {
    product: string;
    /** Omitted for attest; id is issued server-side when absent. */
    institution?: { id?: string; name: string; country?: string };
    issuer_key_id?: string;
    webhook_url?: string;
  }): Promise<Record<string, unknown>> => send('POST', '/v1/console/products', body),

  deactivateProduct: (product: string): Promise<{ product: string; status: string }> =>
    send('POST', `/v1/console/products/${encodeURIComponent(product)}/deactivate`),

  porSnapshot: (id: string): Promise<PorSnapshotView> =>
    send('GET', `/v1/por/snapshots/${encodeURIComponent(id)}`),

  /**
   * Hand over a signed statement. Without `spot_check` the body is the
   * statement and its signature and nothing else — no account, no balance.
   */
  porSubmit: (body: { statement: unknown; sig: unknown; spot_check?: boolean }): Promise<{
    snapshot_id: string; status: string; spot_check: boolean; already?: boolean;
    attestation_id?: string; challenge?: { indices: number[] };
  }> => send('POST', '/v1/por/snapshots', body),

  /**
   * Register the public half of the key the reserve screen signs with. It is
   * a second key for the exchange, accepted beside its signing key; the
   * private half never leaves the page that made it.
   */
  porConsoleKey: (institutionId: string, publicKey: string): Promise<{ institution_id: string; applied_at: string }> =>
    send('POST', `/v1/console/institutions/${encodeURIComponent(institutionId)}/console-key`, { public_key: publicKey }),

  /** Answer a spot check: openings for exactly the challenged leaves, never an account reference. */
  porOpenings: (id: string, openings: unknown[]): Promise<{
    status: string; attestation_id: string; sampled_leaves: number;
  }> => send('POST', `/v1/por/snapshots/${encodeURIComponent(id)}/openings`, { openings }),

  /** The landing screen's one aggregate call. */
  dashboard: (): Promise<{
    generated_at: string;
    attention: {
      rfi_waiting: number; l1_held: number; exceptions: number;
      webhook_exhausted: number; unconfirmed_anchors: number;
      /** The items behind the counts, five per kind at most; absent on older deployments. */
      items?: { kind: 'exception' | 'rfi' | 'held' | 'webhook';
        id: string; state: string; reason: string | null; at: string }[];
    };
    attest: {
      total: number;
      funnel: Record<string, number>;
      signed: { signed: number; registered: number };
      avg_confirm_seconds: number | null;
      recent:{ id: string; leaf_bytes: string; kind: string; status: string; created_at: string }[];
    };
    remit: {
      today: { count: number; trade_usd: number };
      month: { count: number; trade_usd: number; terminal_bad: number };
      buckets: { in_flight: number; completed: number; returned_cancelled: number; exceptions: number };
      manifest_today: string | null;
      /** The newest manifest of any date, for the queue; absent on older deployments. */
      manifest_latest?: { date: string; status: string } | null;
      webhooks: { pending: number; delivered: number; exhausted: number };
      avg_credit_seconds: number | null;
      recent: { id: string; state: string; trade_amount: string; trade_currency: string;
        evidence_level: string | null; created_at: string }[];
    };
    por: {
      latest: {
        id: string; status: string; asof: string; root: string; leaf_count: number;
        totals: Record<string, string>;
        coverage: { asset: string; coverage: string | null }[];
        anchor_status: string | null; created_at: string;
      } | null;
      trend: { id: string; asof: string; status: string;
        coverage: { asset: string; coverage: string | null }[] }[];
    };
  }> => send('GET', '/v1/console/dashboard'),

  // ── remit (cross-border settlement) ─────────────────────────────────────
  settlements: (opts: { q?: string; state?: string; from?: string; to?: string; cursor?: string; limit?: number } = {}): Promise<{
    data: {
      payment_id: string; state: string;
      corridor: { origin: string; destination: string };
      trade: { currency: string; value: string };
      collected: { currency: string; value: string };
      paid: { currency: string; value: string };
      evidence_level: string | null; evidence_available: boolean;
      chain_tx: string | null;
      attestation: { id: string; status: string } | null;
      created_at: string; updated_at: string;
    }[];
    page: { total: number; returned: number; next_cursor: string | null };
  }> => {
    const qs = new URLSearchParams();
    if (opts.q) qs.set('q', opts.q);
    if (opts.state) qs.set('state', opts.state);
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const tail = qs.toString();
    return send('GET', `/v1/settlements${tail ? `?${tail}` : ''}`);
  },

  settlement: (id: string): Promise<{
    payment_id: string; state: string;
    corridor: { origin: string; destination: string };
    amounts: {
      trade: { currency: string; value: string };
      collected: { currency: string; value: string };
      settled: { asset: string; value: string };
      paid: { currency: string; value: string };
    };
    quote_id: string; beneficiary_institution: string;
    deposit_address: string | null; chain_tx: string | null;
    evidence_level: string | null; evidence_available: boolean;
    attestation: { id: string; status: string } | null;
    created_at: string; updated_at: string;
    events: { seq: number; type: string; issuer: string; at: string; payload: unknown; sig: unknown }[];
  }> => send('GET', `/v1/settlements/${encodeURIComponent(id)}`),

  /** What the settlement chain says about this settlement's transfer, now. */
  settlementChain: (id: string): Promise<{
    tx_hash: string; chain: string;
    state: 'confirmed' | 'failed' | 'pending' | 'not_found' | 'unreachable';
    block_number?: number; confirmations?: number; block_time?: string;
    transfer?: { token: string; from: string; to: string; amount: string };
    detail?: string; explorer_url: string | null;
  }> => send('GET', `/v1/settlements/${encodeURIComponent(id)}/chain`),

  settlementEvidence: (id: string): Promise<Record<string, unknown>> =>
    send('GET', `/v1/settlements/${encodeURIComponent(id)}/evidence`),

  manifests: (): Promise<{
    data: {
      date: string; verdict: { status: string; platform_count: number; manifest_count: number;
        missing_in_manifest: string[]; unknown_to_platform: string[] };
      commitment: string; attestation: { id: string; status: string } | null; created_at: string;
    }[];
  }> => send('GET', '/v1/manifests/daily'),

  // ── sandbox ──────────────────────────────────────────────────────────────
  catalogue: (): Promise<Catalogue> => send('GET', '/v1/console/sandbox'),

  buildEvidence: (scenario: string, tampers: TamperStep[]):
  Promise<{ scenario: string; applied: string[]; evidence: Record<string, unknown> }> =>
    send('POST', '/v1/console/sandbox/evidence', { scenario, tampers }),

  /** The same build pipeline, starting from the caller's own settlement file. */
  buildEvidenceFrom: (evidence: unknown, tampers: TamperStep[]):
  Promise<{ scenario: string | null; source: string; applied: string[]; evidence: Record<string, unknown> }> =>
    send('POST', '/v1/console/sandbox/evidence', { evidence, tampers }),

  /**
   * The integration endpoint, not a console one.
   *
   * A sandbox whose verdicts came from a sandbox-only evaluator would say
   * nothing about the system a customer connects to. Same route, same body;
   * the browser authenticates with its session where a server would send a
   * Bearer key, and the API panel says so.
   */
  reconcile: (evidence: unknown, policy: unknown): Promise<Verdict> =>
    send('POST', '/v1/settlements/reconcile', { evidence, policy }),

  pack: (evidence: unknown, policy?: unknown): Promise<EvidencePackage> =>
    send('POST', '/v1/console/sandbox/package',
      { evidence, ...(policy ? { policy } : {}) }),

  checkPackage: (pkg: unknown): Promise<PackageCheck> =>
    send('POST', '/v1/console/sandbox/package/verify', { package: pkg }),

  /** The bundle is a download, so it is a link rather than a fetch. */
  bundleUrl: (id: string): string => `${BASE}/v1/console/attestations/${id}/bundle`,

  /**
   * The same bundle, fetched rather than downloaded, so the console can
   * explain what is in it.
   *
   * Deliberately the identical endpoint: a spec panel built from a separate
   * description would drift from the file the customer actually receives,
   * and the whole point of showing it is that the two are the same thing.
   */
  bundle: (id: string): Promise<Record<string, unknown>> =>
    send('GET', `/v1/console/attestations/${encodeURIComponent(id)}/bundle`),
};

/**
 * SHA-256 of a file, computed in this browser.
 *
 * The file is never sent anywhere. That is not a courtesy — it is the product's
 * central claim, and a console that uploaded the document in order to hash it
 * would contradict every page describing the service.
 */
/**
 * POST a file as the raw request body.
 *
 * Kept apart from `send` so the transcript stays honest: logging the body
 * here would put the document into a panel the page then renders, which is
 * the opposite of what the rest of this module is careful about. The call is
 * recorded with its size and type instead of its contents.
 */
async function sendRaw<T>(path: string, file: File, contentType: string): Promise<T> {
  const started = performance.now();
  const note = { file_bytes: file.size, content_type: contentType };
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': contentType }, body: file,
    });
  } catch {
    record({ method: 'POST', path, request: note, status: 0, response: { error: 'unreachable' },
      ms: Math.round(performance.now() - started), at: new Date().toISOString() });
    throw new ApiError(0, 'unreachable', 'Could not reach the API.');
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try { json = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new ApiError(res.status, 'bad_response', `The API returned something that is not JSON (HTTP ${res.status}).`); }
  }
  record({ method: 'POST', path, request: note, status: res.status, response: scrub(json),
    ms: Math.round(performance.now() - started), at: new Date().toISOString() });
  if (!res.ok) {
    throw new ApiError(res.status, String(json['error'] ?? 'error'),
      String(json['message'] ?? `HTTP ${res.status}`));
  }
  return json as T;
}

export async function digestFile(file: File): Promise<string> {
  return digestBytes(new Uint8Array(await file.arrayBuffer()));
}

const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Two hashers, because the fast one is withheld outside a secure context.
 *
 * `crypto.subtle` does not exist over plain http, and this console is reached
 * at an IP address with no certificate — so the one button the sandbox is
 * built around threw, on the deployment where it matters, while every local
 * check passed because localhost counts as secure.
 *
 * The fallback is the SHA-256 from the verifier, vendored into this build. It
 * is the same function that will later check the proof, and it keeps the only
 * promise that matters here: the file is hashed in this browser and never
 * uploaded.
 */
export async function digestBytes(bytes: Uint8Array): Promise<string> {
  if (crypto?.subtle) {
    const view = new Uint8Array(bytes);
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer as ArrayBuffer)));
  }
  const { sha256 } = await import('./vendor/sha256.ts');
  return hex(sha256(bytes));
}

export const digestText = (text: string): Promise<string> =>
  digestBytes(new TextEncoder().encode(text));
