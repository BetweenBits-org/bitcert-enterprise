/**
 * The remit API surface (arch doc §4-2) plus the sandbox's provisioning
 * endpoints. Mounted by `buildRouter` only when the remit rail is enabled —
 * a deployment without it has no trace of these routes.
 *
 * Route-shape note: `/v1/settlements/reconcile` and `/v1/settlements/bundle`
 * (the stateless evaluators) predate this rail and stay untouched; payment
 * ids are bank-issued and validated against a pattern that cannot collide
 * with those two literals.
 */
import { pageLimit } from '../http/server.ts';
import { chainTxStatus } from './chain-status.ts';
import { monthlyCharges } from '../billing.ts';
import { HttpError, HttpResult } from '../http/server.ts';
import type { Ctx, Router } from '../http/server.ts';
import { ServiceError } from '../service.ts';
import type { AttestService } from '../service.ts';
import { buildQuote } from './quotes.ts';
import type { QuoteRequest, QuoteConfig } from './quotes.ts';
import { es256PublicKeyProblem, sha256hex, signEvent, verifyEvent } from './sign.ts';
import type { PlatformKey, EventSig } from './sign.ts';
import { jcs } from '@stonehash/attest-verify';
import type { JcsValue } from '@stonehash/attest-verify';
import { randomUUID } from 'node:crypto';
import type { Registry, InstitutionRole } from './registry.ts';
import type { RemitStore } from './store.ts';
import type { RemitOrchestrator, SettlementRequest } from './orchestrator.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';

export interface RemitServices {
  store: RemitStore;
  registry: Registry;
  orchestrator: RemitOrchestrator;
  platform: PlatformKey;
  quoteCfg: QuoteConfig;
}

interface RemitRouteDeps {
  cfg: Config;
  db: Db;
  svc: AttestService;
  remit: RemitServices;
  requireAuth: (ctx: Ctx) => Promise<string>;
  requireSession: (ctx: Ctx) => Promise<{ org_id: string }>;
}

/** Bank-issued ids: generous but bounded, and never a reserved literal. */
const PAYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;
const RESERVED_IDS = new Set(['reconcile', 'bundle']);

/**
 * Refuse a registered key that cannot be an institution's verification key.
 *
 * Activation and the signing-key switch both copy an issuer key onto the
 * institution, and the registry builds one keyring from every institution's
 * key for every tenant's reconciliation. So the copy is checked here even
 * though console registration checks too: the keyed API's registration only
 * parses, and a key stored before any check existed — the placeholder every
 * org is seeded with at signup among them — must not reach the column.
 */
function requireInstitutionKey(publicKey: string): void {
  const problem = es256PublicKeyProblem(publicKey);
  if (problem) {
    throw new HttpError(400, problem.code,
      `that issuer key is ${problem.message}. An institution cannot verify signatures with it.`);
  }
}

export function registerRemitRoutes(r: Router, d: RemitRouteDeps): void {
  const { store, registry, orchestrator, platform, quoteCfg } = d.remit;

  // ── Public metadata: what a counterparty needs to verify us ─────────────
  r.get('/v1/remit/meta', async () => ({
    product: 'cross-border-settlement',
    mode: 'sandbox',
    corridor: { origin: 'VN', destination: 'SG' },
    platform_signer: { key_id: platform.keyId, spki: platform.publicSpkiBase64, algorithm: 'ES256' },
    institutions: (await registry.snapshot()).institutions,
    /** Per-transaction explorer template (`{tx}` = hash), or null when nothing indexes the chain. */
    explorer_tx_url: d.cfg.remit.explorerTxUrl || null,
    note: 'Synthetic demo rail: mock USDC on a private chain, no real funds move.',
  }));

  // ── Partner registration (sandbox provisioning) ─────────────────────────
  r.post('/v1/remit/registry/institutions', async (ctx) => {
    const token = ctx.req.headers['x-admin-token'];
    if (!d.cfg.remit.adminToken || token !== d.cfg.remit.adminToken) {
      throw new HttpError(403, 'forbidden', 'registry registration needs the remit admin token');
    }
    const body = await ctx.body() as {
      id?: string; role?: InstitutionRole; name?: string; country?: string;
      signing_spki?: string; encryption_jwk?: unknown; authority?: string[];
    };
    if (!body.id || !body.role || !body.name) {
      throw new HttpError(400, 'missing_field', 'id, role and name are required');
    }
    const inst = await registry.upsert({
      id: body.id, role: body.role, name: body.name,
      ...(body.country ? { country: body.country } : {}),
      ...(body.signing_spki ? { signing_spki: body.signing_spki } : {}),
      ...(body.encryption_jwk !== undefined ? { encryption_jwk: body.encryption_jwk } : {}),
      ...(body.authority ? { authority: body.authority } : {}),
    });
    return new HttpResult(201, { id: inst.id, role: inst.role, name: inst.name });
  });

  // ── Console: product subscription ───────────────────────────────────────
  r.get('/v1/console/products', async (ctx) => {
    const account = await d.requireSession(ctx);
    const subs = await registry.subscriptions(account.org_id);
    const institutions = (await Promise.all((['COLLECTION_BANK', 'EXCHANGE'] as const)
      .map((role) => registry.institutionForOrg(account.org_id, role))))
      .filter((i) => i !== null)
      // The key the rail currently verifies this institution with: public
      // material, and what the console compares against the registered keys
      // to say which one is active.
      .map((i) => ({ id: i!.id, role: i!.role, name: i!.name, country: i!.country, signing_spki: i!.signing_spki }));
    /*
     * The billing view a customer sees: what each product meters, and this
     * month's usage per meter. Solution-issued anchors are listed under the
     * solution ("included"), never under the Attest quota — the product
     * boundary, visible as numbers.
     */
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const since = monthStart.toISOString();
    const count = async (sql: string, ...args: unknown[]): Promise<number> =>
      Number(((await d.db.prepare(sql).get(...(args as never[]))) as unknown as { n: number }).n);
    const anchorsBy = (product: string): Promise<number> => count(
      'SELECT COUNT(*) AS n FROM attestations WHERE org_id = ? AND created_at >= ? AND product = ?',
      account.org_id, since, product);
    const billing = {
      month_start: since,
      attest: {
        plan: 'sandbox',
        meter: 'anchors / month',
        quota: d.cfg.console.monthlyQuota,
        used: await anchorsBy('attest'),
      },
      remit: {
        meter: 'per settlement + bps — evidence & anchoring included',
        settlements: await count(
          'SELECT COUNT(*) AS n FROM remit_payments WHERE org_id = ? AND created_at >= ?',
          account.org_id, since),
        included_anchors: await anchorsBy('remit'),
      },
      por: {
        meter: 'per snapshot period — challenge, anchor & public verify included',
        snapshots: await count(
          'SELECT COUNT(*) AS n FROM por_snapshots WHERE org_id = ? AND created_at >= ?',
          account.org_id, since),
        included_anchors: await anchorsBy('por'),
      },
    };
    const charges = monthlyCharges(d.cfg.pricing, {
      anchors: billing.attest.used, settlements: billing.remit.settlements, snapshots: billing.por.snapshots,
    }, new Set(subs.filter((x) => x.status === 'active').map((x) => x.product)), monthStart);
    return {
      products: subs.map((s) => ({
        product: s.product, plan: s.plan, status: s.status,
        config: JSON.parse(s.config) as unknown, created_at: s.created_at,
      })),
      institution: institutions[0] ?? null,   // kept for existing callers
      institutions,
      billing: { ...billing, charges },
    };
  });

  r.post('/v1/console/products', async (ctx) => {
    const account = await d.requireSession(ctx);
    const body = await ctx.body() as {
      product?: string; institution?: { id?: string; name?: string; country?: string };
      webhook_url?: string; issuer_key_id?: string;
    };
    if (body.product !== 'remit' && body.product !== 'por' && body.product !== 'attest') {
      throw new HttpError(400, 'unknown_product', 'subscribable products: attest, remit, por');
    }
    // Attest Core needs no institution or key — it is the base platform, and
    // this path exists for orgs created before it became an explicit record.
    if (body.product === 'attest') {
      const sub = await registry.subscribe(account.org_id, 'attest', {});
      return new HttpResult(201, {
        product: 'attest', status: sub.status,
        anchor_endpoint: '/v1/attestations', console_quota: d.cfg.console.monthlyQuota,
      });
    }
    const instIn = body.institution ?? {};
    if (!instIn.name) {
      throw new HttpError(400, 'missing_field', 'institution.name is required');
    }
    /*
     * The institution id is registry bookkeeping, not something a customer
     * should have to invent: when omitted it is issued here —
     * country + role marker + random suffix — and returned. An explicit id
     * is still accepted (the demo estate and adapters pin well-known ones).
     */
    if (!instIn.id) {
      // Reactivation reuses the institution the org already registered for
      // this role — the id is an identity, and identities should survive a
      // subscription pause rather than multiply.
      const role = body.product === 'por' ? 'EXCHANGE' as const : 'COLLECTION_BANK' as const;
      const existing = await registry.institutionForOrg(account.org_id, role);
      if (existing) {
        instIn.id = existing.id;
      } else {
        const country = (instIn.country ?? '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) {
          throw new HttpError(400, 'missing_field', 'institution.country (ISO2) is required to issue an institution id');
        }
        const marker = body.product === 'por' ? 'EX' : 'BANK';
        let candidate: string;
        do {
          candidate = `${country}-${marker}-${randomUUID().slice(0, 6).toUpperCase()}`;
        } while (await registry.institution(candidate));
        instIn.id = candidate;
      }
    } else if (!/^[A-Z]{2}-[A-Z0-9-]{2,32}$/.test(instIn.id)) {
      throw new HttpError(400, 'invalid_institution_id',
        'institution ids look like VN-BANK-001 (country prefix, uppercase)');
    }
    // The signing key is one the org already registered as an issuer key —
    // the same governance step the attestation product uses.
    if (!body.issuer_key_id) throw new HttpError(400, 'missing_field', 'issuer_key_id is required');
    const key = (await d.db.prepare(
      'SELECT public_key, algorithm FROM issuer_keys WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
    ).get(body.issuer_key_id, account.org_id)) as unknown as { public_key: string; algorithm: string } | undefined;
    if (!key) throw new HttpError(404, 'issuer_key_not_found', 'no such issuer key for this organisation');
    if (key.algorithm !== 'ES256') {
      throw new HttpError(400, 'unsupported_algorithm', 'the remit rail signs with ES256 keys');
    }
    // The label is a claim; the material is what both branches below copy.
    requireInstitutionKey(key.public_key);

    const taken = await registry.institution(instIn.id);
    if (taken && taken.org_id !== account.org_id) {
      throw new HttpError(409, 'institution_id_taken', `${instIn.id} is registered to another organisation`);
    }
    if (body.product === 'por') {
      await registry.upsert({
        id: instIn.id, role: 'EXCHANGE', name: instIn.name,
        ...(instIn.country ? { country: instIn.country } : {}),
        org_id: account.org_id, signing_spki: key.public_key,
        authority: ['POR_SNAPSHOT'],
      });
      const sub = await registry.subscribe(account.org_id, 'por', { institution_id: instIn.id });
      return new HttpResult(201, {
        product: 'por', status: sub.status, institution_id: instIn.id,
        snapshot_endpoint: '/v1/por/snapshots',
        sdk: '@stonehash/attest-por — build the tree locally; submit the statement only',
      });
    }
    await registry.upsert({
      id: instIn.id, role: 'COLLECTION_BANK', name: instIn.name,
      ...(instIn.country ? { country: instIn.country } : {}),
      org_id: account.org_id, signing_spki: key.public_key,
      authority: ['FIAT_FUNDS_RECEIVED', 'PAYMENT_RELEASE_AUTHORIZED', 'bankInstruction', 'bankApproval', 'commercialDocs'],
    });
    const sub = await registry.subscribe(account.org_id, 'remit', {
      institution_id: instIn.id,
      ...(body.webhook_url ? { webhook_url: body.webhook_url } : {}),
    });
    return new HttpResult(201, {
      product: 'remit', status: sub.status, institution_id: instIn.id,
      webhook_url: body.webhook_url ?? null,
      quote_endpoint: '/v1/quotes', settlement_endpoint: '/v1/settlements',
    });
  });

  r.post('/v1/console/products/:product/deactivate', async (ctx) => {
    const account = await d.requireSession(ctx);
    const product = ctx.params.product!;
    if (!['attest', 'remit', 'por'].includes(product)) {
      throw new HttpError(400, 'unknown_product', 'deactivatable products: attest, remit, por');
    }
    const sub = await registry.unsubscribe(account.org_id, product);
    if (!sub) throw new HttpError(404, 'not_subscribed', `no ${product} subscription to deactivate`);
    return { product, status: sub.status };
  });

  /**
   * `POST /v1/console/institutions/:id/signing-key` — switch the key an
   * institution verifies with.
   *
   * Activation copied one registered key onto the institution; this is the
   * same copy made again with a different key, so a rotation does not have
   * to go through deactivate-and-reactivate. The candidates are the org's
   * own registered issuer keys and nothing else: an institution can only
   * ever verify with material its org has already vouched for.
   */
  r.post('/v1/console/institutions/:id/signing-key', async (ctx) => {
    const account = await d.requireSession(ctx);
    const inst = await registry.institution(ctx.params.id!);
    // 404 either way: whether an id belongs to someone else is not this
    // caller's to learn.
    if (!inst || inst.org_id !== account.org_id) {
      throw new HttpError(404, 'institution_not_found', 'no institution with that id in this organisation');
    }
    const body = await ctx.body() as { issuer_key_id?: unknown };
    if (typeof body.issuer_key_id !== 'string' || !body.issuer_key_id) {
      throw new HttpError(400, 'missing_field', 'issuer_key_id is required');
    }
    const key = (await d.db.prepare(
      'SELECT public_key, algorithm, revoked_at FROM issuer_keys WHERE id = ? AND org_id = ?',
    ).get(body.issuer_key_id, account.org_id)) as unknown as
      { public_key: string; algorithm: string; revoked_at: string | null } | undefined;
    if (!key) throw new HttpError(404, 'issuer_key_not_found', 'no such issuer key for this organisation');
    if (key.revoked_at) {
      throw new HttpError(409, 'key_revoked', 'that key was revoked; register a new one and pick it instead');
    }
    if (key.algorithm !== 'ES256') {
      throw new HttpError(400, 'unsupported_algorithm', 'institutions sign with ES256 keys');
    }
    // Decoding is not enough: a key that decodes on the wrong curve either
    // breaks the shared keyring or fails every signature. Refused here, where
    // it can be named, rather than in some other tenant's reconciliation.
    requireInstitutionKey(key.public_key);
    const appliedAt = new Date().toISOString();
    await registry.setSigningKey(inst.id, key.public_key);
    return { institution_id: inst.id, issuer_key_id: body.issuer_key_id, applied_at: appliedAt };
  });

  /**
   * `POST /v1/console/institutions/:id/console-key` — the key the console's
   * reserve screen signs with.
   *
   * That screen builds and signs a reserve statement in the visitor's page,
   * from nothing but the balance file. It has no way to hold the exchange's
   * signing key, and it must not replace it. So the page makes a key for the
   * session and registers the public half here; a statement is accepted
   * under either key, and the snapshot records which one verified it. Only
   * an EXCHANGE takes one: the settlement rail checks a bank's instructions
   * against its signing key and nothing else.
   */
  r.post('/v1/console/institutions/:id/console-key', async (ctx) => {
    const account = await d.requireSession(ctx);
    const inst = await registry.institution(ctx.params.id!);
    if (!inst || inst.org_id !== account.org_id) {
      throw new HttpError(404, 'institution_not_found', 'no institution with that id in this organisation');
    }
    if (inst.role !== 'EXCHANGE') {
      throw new HttpError(400, 'not_an_exchange', 'a console key signs reserve statements; only an EXCHANGE institution takes one');
    }
    const body = ((await ctx.body()) ?? {}) as { public_key?: unknown };
    if (typeof body.public_key !== 'string' || !body.public_key) {
      throw new HttpError(400, 'missing_field', 'public_key is required');
    }
    requireInstitutionKey(body.public_key);
    const appliedAt = new Date().toISOString();
    await registry.setConsoleKey(inst.id, body.public_key);
    return { institution_id: inst.id, applied_at: appliedAt };
  });

  /**
   * Sandbox operations: deactivate an org's subscriptions by account email.
   * Admin-token guarded like institution registration — the facility an
   * operator reaches for instead of editing the database by hand.
   */
  r.post('/v1/remit/registry/deactivate', async (ctx) => {
    const token = ctx.req.headers['x-admin-token'];
    if (!d.cfg.remit.adminToken || token !== d.cfg.remit.adminToken) {
      throw new HttpError(403, 'forbidden', 'deactivation needs the remit admin token');
    }
    const body = await ctx.body() as { email?: string; products?: string[] };
    if (!body.email) throw new HttpError(400, 'missing_field', 'email is required');
    const account = (await d.db.prepare('SELECT org_id FROM accounts WHERE email = ?')
      .get(body.email.toLowerCase())) as unknown as { org_id: string } | undefined;
    if (!account) throw new HttpError(404, 'not_found', 'no account with that email');
    const targets = body.products ?? ['attest', 'remit', 'por'];
    const results: Record<string, string> = {};
    for (const product of targets) {
      const sub = await registry.unsubscribe(account.org_id, product);
      results[product] = sub ? sub.status : 'not_subscribed';
    }
    return { email: body.email, results };
  });

  // ── Quotes ──────────────────────────────────────────────────────────────
  r.post('/v1/quotes', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    await registry.requireRemit(orgId);
    const body = await ctx.body() as QuoteRequest;
    const quote = buildQuote(body, quoteCfg);
    await store.saveQuote(orgId, quote.quote_id, quote.corridor.origin, quote.corridor.destination,
      body, quote, quote.expires_at);
    return new HttpResult(201, quote);
  });

  // ── Settlements ─────────────────────────────────────────────────────────
  r.post('/v1/settlements', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const { bank } = await registry.requireRemit(orgId);

    const idemKey = ctx.req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length < 8) {
      throw new HttpError(400, 'missing_idempotency_key',
        'supply an Idempotency-Key header (≥8 chars); it is what makes a retry safe');
    }
    const body = await ctx.body() as SettlementRequest;
    const requestHash = sha256hex(JSON.stringify(body));

    const hit = await store.idempotencyHit(orgId, idemKey);
    if (hit) {
      if (hit.request_hash === requestHash) {
        return new HttpResult(hit.response_status, JSON.parse(hit.response_body));
      }
      throw new HttpError(409, 'idempotency_conflict',
        'this Idempotency-Key was already used with a different request body — a rebuilt instruction '
        + '(new quote, new signatures) is a different body; if this is a retry, read the payment with '
        + 'GET /v1/settlements/{payment_id} instead of resending');
    }

    const pid = body.payment_id ?? '';
    if (!PAYMENT_ID.test(pid) || RESERVED_IDS.has(pid)) {
      throw new HttpError(400, 'invalid_payment_id',
        'payment_id must be 4–64 chars of [A-Za-z0-9_-] and not a reserved word');
    }

    const result = await orchestrator.acceptSettlement(orgId, bank, body);
    await store.idempotencyStore(orgId, idemKey, requestHash, 202, result);
    return new HttpResult(202, result);
  });

  /**
   * The exact lookups of the ledger: by the UETR of the message a settlement
   * was made from, or by the digest of that message's content (optionally
   * narrowed to one value date). A value that could never match is refused,
   * not answered with an empty page — "nothing found" must mean nothing is there.
   */
  const sourceLookup = (query: URLSearchParams): { sourceUetr?: string; sourceContent?: string; sourceValueDate?: string } => {
    const uetr = query.get('source_uetr');
    const content = query.get('source_content');
    const day = query.get('source_value_date');
    const out: { sourceUetr?: string; sourceContent?: string; sourceValueDate?: string } = {};
    if (uetr !== null) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uetr)) {
        throw new HttpError(400, 'invalid_source_lookup', 'source_uetr must be a UUID');
      }
      out.sourceUetr = uetr.toLowerCase();
    }
    if (content !== null) {
      if (!/^[0-9a-f]{64}$/i.test(content)) {
        throw new HttpError(400, 'invalid_source_lookup', 'source_content must be a SHA-256 digest in hex');
      }
      out.sourceContent = content.toLowerCase();
    }
    if (day !== null) {
      if (content === null) throw new HttpError(400, 'invalid_source_lookup', 'source_value_date narrows source_content and needs it');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, 'invalid_source_lookup', 'source_value_date must be YYYY-MM-DD');
      out.sourceValueDate = day;
    }
    return out;
  };

  /*
   * The settlement ledger, shaped for an org with thousands of rows: filters
   * run in SQL, pages are keyset-cursored (`cursor` from the previous
   * response), and `total` counts the filtered set. A bare GET keeps its old
   * meaning — the newest page of settlements under `data`.
   */
  r.get('/v1/settlements', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const page = await store.search(orgId, {
      ...(ctx.query.get('q') ? { q: ctx.query.get('q')! } : {}),
      ...sourceLookup(ctx.query),
      ...(ctx.query.get('state') ? { state: ctx.query.get('state')! } : {}),
      ...(ctx.query.get('from') ? { from: ctx.query.get('from')! } : {}),
      ...(ctx.query.get('to') ? { to: ctx.query.get('to')! } : {}),
      ...(ctx.query.get('cursor') ? { cursor: ctx.query.get('cursor')! } : {}),
      limit: pageLimit(ctx.query.get('limit'), 25, 100),
    });
    const data = await Promise.all(page.items.map(async (p) => ({
      payment_id: p.id,
      state: p.state,
      corridor: { origin: p.corridor_origin, destination: p.corridor_destination },
      trade: { currency: p.trade_currency, value: p.trade_amount },
      collected: { currency: p.collect_currency, value: p.collect_amount },
      paid: { currency: p.payout_currency, value: p.payout_amount },
      evidence_level: p.evidence_level,
      evidence_available: p.package_json !== null,
      chain_tx: p.chain_tx,
      attestation: p.attestation_id
        ? { id: p.attestation_id, status: (await d.svc.get(orgId, p.attestation_id))?.status ?? 'unknown' }
        : null,
      created_at: p.created_at,
      updated_at: p.updated_at,
    })));
    return {
      data,
      page: {
        total: page.total,
        returned: data.length,
        next_cursor: page.nextCursor,
      },
    };
  });

  r.get('/v1/settlements/:id', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const p = await store.getForOrg(orgId, ctx.params.id!);
    if (!p) throw new HttpError(404, 'not_found', `no settlement ${ctx.params.id}`);
    const att = p.attestation_id ? await d.svc.get(orgId, p.attestation_id) : null;
    return {
      payment_id: p.id,
      state: p.state,
      corridor: { origin: p.corridor_origin, destination: p.corridor_destination },
      amounts: {
        trade: { currency: p.trade_currency, value: p.trade_amount },
        collected: { currency: p.collect_currency, value: p.collect_amount },
        settled: { asset: 'USDC', value: p.usdc_amount },
        paid: { currency: p.payout_currency, value: p.payout_amount },
      },
      quote_id: p.quote_id,
      beneficiary_institution: p.beneficiary_institution,
      deposit_address: p.deposit_address,
      chain_tx: p.chain_tx,
      evidence_level: p.evidence_level,
      evidence_available: p.package_json !== null,
      attestation: att ? { id: att.id, status: att.status } : null,
      created_at: p.created_at,
      updated_at: p.updated_at,
      events: (await store.events(p.id)).map((e) => ({
        seq: e.seq, type: e.type, issuer: e.issuer, at: e.created_at,
        payload: JSON.parse(e.payload) as unknown,
        sig: e.sig ? JSON.parse(e.sig) as unknown : null,
      })),
    };
  });

  /*
   * The node's answer about this settlement's on-chain transfer, now. Scoped
   * by the settlement, never by a raw hash, so a tenant can only ask about its
   * own transfer; read-only; the RPC address stays on the server.
   */
  r.get('/v1/settlements/:id/chain', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const p = await store.getForOrg(orgId, ctx.params.id!);
    if (!p) throw new HttpError(404, 'not_found', `no settlement ${ctx.params.id}`);
    if (!p.chain_tx) {
      throw new HttpError(404, 'no_chain_tx', `settlement ${p.id} has not reached the chain yet`);
    }
    const status = await chainTxStatus(d.cfg.remit.chainRpc, d.cfg.remit.chainLabel, p.chain_tx);
    const tpl = d.cfg.remit.explorerTxUrl;
    return { ...status, explorer_url: tpl ? tpl.replace('{tx}', encodeURIComponent(p.chain_tx)) : null };
  });

  r.get('/v1/settlements/:id/evidence', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const p = await store.getForOrg(orgId, ctx.params.id!);
    if (!p) throw new HttpError(404, 'not_found', `no settlement ${ctx.params.id}`);
    if (!p.package_json || !p.commitment || !p.nonce) {
      throw new HttpError(409, 'evidence_not_ready',
        `evidence is assembled at BENEFICIARY_CREDIT_CONFIRMED; this payment is ${p.state}`);
    }
    let bundle: unknown = null;
    if (p.attestation_id) {
      try {
        bundle = await d.svc.exportBundle(orgId, p.attestation_id);
      } catch (e) {
        if (!(e instanceof ServiceError) || (e.code !== 'not_batched' && e.code !== 'not_anchored')) throw e;
      }
    }
    return {
      package: JSON.parse(p.package_json) as unknown,
      commitment: {
        value: p.commitment,
        nonce: p.nonce,
        domain: 'STONEHASH-EVIDENCE-V1',
        how_to_verify: 'SHA256(domain || nonce_bytes || JCS(package)) must equal value, and value is the anchored leaf',
      },
      attestation: p.attestation_id ? {
        id: p.attestation_id,
        status: (await d.svc.get(orgId, p.attestation_id))?.status ?? 'unknown',
        bundle,
      } : null,
    };
  });

  r.post('/v1/settlements/:id/cancel', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const { bank } = await registry.requireRemit(orgId);
    const body = await ctx.body() as { reason?: string; sig?: EventSig };
    return orchestrator.cancel(orgId, bank, ctx.params.id!, body);
  });

  r.post('/v1/settlements/:id/rfi-response', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const { bank } = await registry.requireRemit(orgId);
    const body = await ctx.body() as { answers?: Record<string, string>; sig?: EventSig };
    return orchestrator.respondRfi(orgId, bank, ctx.params.id!, body);
  });

  // ── Daily settlement manifest (§7-4 completeness control) ──────────────
  r.post('/v1/manifests/daily', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const { bank } = await registry.requireRemit(orgId);
    const body = await ctx.body() as {
      manifest?: { date?: string; institution_id?: string; payment_ids?: string[]; count?: number };
      sig?: EventSig;
    };
    const manifest = body.manifest;
    if (!manifest?.date || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date)) {
      throw new HttpError(400, 'invalid_manifest', 'manifest.date must be YYYY-MM-DD');
    }
    if (!Array.isArray(manifest.payment_ids) || manifest.count !== manifest.payment_ids.length) {
      throw new HttpError(400, 'invalid_manifest', 'payment_ids[] and a matching count are required');
    }
    if (!body.sig || !bank.signing_spki || !verifyEvent(manifest, body.sig, bank.signing_spki)) {
      throw new HttpError(400, 'invalid_signature', 'sig must cover the manifest with the registered bank key');
    }

    /*
     * The cross-check the Merkle tree cannot do: completeness. The platform
     * lists everything this org instructed that day and compares both ways —
     * a payment the platform has but the manifest omits reads as the bank
     * hiding one; an id the platform never saw reads as a phantom.
     */
    const platformIds = ((await d.db.prepare(
      `SELECT id FROM remit_payments WHERE org_id = ? AND substr(created_at, 1, 10) = ? ORDER BY created_at`,
    ).all(orgId, manifest.date)) as unknown as { id: string }[]).map((r2) => r2.id);
    const bankSet = new Set(manifest.payment_ids);
    const platformSet = new Set(platformIds);
    const missingInManifest = platformIds.filter((id) => !bankSet.has(id));
    const unknownToPlatform = manifest.payment_ids.filter((id) => !platformSet.has(id));
    const verdict = {
      status: missingInManifest.length === 0 && unknownToPlatform.length === 0 ? 'MATCHED' : 'DISCREPANT',
      platform_count: platformIds.length,
      manifest_count: manifest.payment_ids.length,
      missing_in_manifest: missingInManifest,
      unknown_to_platform: unknownToPlatform,
      checked_at: new Date().toISOString(),
    };
    const platformSig = signEvent({ manifest, verdict }, platform.key, platform.keyId, 'STONEHASH');
    const commitment = sha256hex(Buffer.concat([
      Buffer.from('STONEHASH-MANIFEST-V1\n', 'utf8'),
      Buffer.from(jcs({ manifest, verdict } as unknown as JcsValue)),
    ]));

    let attestationId: string | null = null;
    try {
      attestationId = (await d.svc.issue(orgId, commitment, 'application/json',
        { kind: 'remit-manifest', date: manifest.date }, { product: 'remit' })).id;
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'duplicate_digest') {
        const existing = (await d.db.prepare('SELECT id FROM attestations WHERE org_id = ? AND leaf_bytes = ?')
          .get(orgId, commitment)) as unknown as { id: string };
        attestationId = existing.id;
      } else {
        throw e;
      }
    }
    // One row per (org, date); a resubmission replaces it. The two engines
    // spell that differently, and neither spelling parses on the other.
    const upsert = d.db.dialect === 'mysql'
      ? `INSERT INTO remit_manifests (id, org_id, date, manifest, sig, verdict, platform_sig, commitment, attestation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE
           manifest = new.manifest, sig = new.sig, verdict = new.verdict,
           platform_sig = new.platform_sig, commitment = new.commitment,
           attestation_id = new.attestation_id, created_at = new.created_at`
      : `INSERT INTO remit_manifests (id, org_id, date, manifest, sig, verdict, platform_sig, commitment, attestation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, date) DO UPDATE SET
           manifest = excluded.manifest, sig = excluded.sig, verdict = excluded.verdict,
           platform_sig = excluded.platform_sig, commitment = excluded.commitment,
           attestation_id = excluded.attestation_id, created_at = excluded.created_at`;
    await d.db.prepare(upsert).run(randomUUID(), orgId, manifest.date, JSON.stringify(manifest), JSON.stringify(body.sig),
      JSON.stringify(verdict), JSON.stringify(platformSig), commitment, attestationId, new Date().toISOString());

    return new HttpResult(201, { verdict, platform_signature: platformSig, commitment, attestation_id: attestationId });
  });

  r.get('/v1/manifests/daily', async (ctx) => {
    const orgId = await d.requireAuth(ctx);
    const date = ctx.query.get('date');
    const rows = date
      ? await d.db.prepare('SELECT * FROM remit_manifests WHERE org_id = ? AND date = ?').all(orgId, date)
      : await d.db.prepare('SELECT * FROM remit_manifests WHERE org_id = ? ORDER BY date DESC LIMIT 30').all(orgId);
    const typed = rows as unknown as { date: string; manifest: string; verdict: string; commitment: string; attestation_id: string | null; created_at: string }[];
    return {
      data: await Promise.all(typed.map(async (m) => ({
        date: m.date,
        manifest: JSON.parse(m.manifest) as unknown,
        verdict: JSON.parse(m.verdict) as unknown,
        commitment: m.commitment,
        attestation: m.attestation_id
          ? { id: m.attestation_id, status: (await d.svc.get(orgId, m.attestation_id))?.status ?? 'unknown' }
          : null,
        created_at: m.created_at,
      }))),
    };
  });

  // ── Partner callbacks (BFI → platform) ──────────────────────────────────
  r.post('/v1/remit/callbacks', async (ctx) => {
    const body = await ctx.body() as { type?: string; payload?: Record<string, unknown>; sig?: EventSig };
    return orchestrator.handleCallback(body);
  });
}
