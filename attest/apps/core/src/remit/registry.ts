/**
 * Trust Registry and product subscriptions.
 *
 * The registry answers one question per signature: *was this key, under this
 * role, entitled to assert this kind of fact?* Public material only — the
 * platform never holds an institution's private key, exactly as with
 * `issuer_keys`. The keyring view feeds `verifyEvidenceSignatures`, so the
 * six-axis issuer verdict is computed against the same registry the API
 * trusts, not a parallel list.
 */
import { randomUUID } from 'node:crypto';
import { keyring } from '@stonehash/attest-rules';
import type { Keyring, VerificationKey } from '@stonehash/attest-rules';
import { ServiceError } from '../service.ts';
import { spkiToJwk } from './sign.ts';
import type { Db } from '../db.ts';

export type InstitutionRole =
  | 'COLLECTION_BANK' | 'BENEFICIARY_FI' | 'SETTLEMENT_ENTITY'
  | 'LOCAL_PAYOUT_BANK' | 'EXCHANGE' | 'STONEHASH';

export interface Institution {
  id: string;
  org_id: string | null;
  role: InstitutionRole;
  name: string;
  country: string | null;
  signing_spki: string | null;
  /** The console's reserve screen signs with this one; see `setConsoleKey`. Absent on rows read before the column existed. */
  console_spki?: string | null;
  encryption_jwk: string | null;
  authority: string;
  created_at: string;
}

export interface Subscription {
  id: string;
  org_id: string;
  product: string;
  plan: string;
  status: string;
  config: string;
  created_at: string;
}

const nowIso = (): string => new Date().toISOString();

export class Registry {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async institution(id: string): Promise<Institution | null> {
    return ((await this.db.prepare('SELECT * FROM institutions WHERE id = ?').get(id)) as unknown as Institution) ?? null;
  }

  async institutionForOrg(orgId: string, role: InstitutionRole): Promise<Institution | null> {
    return ((await this.db.prepare('SELECT * FROM institutions WHERE org_id = ? AND role = ?')
      .get(orgId, role)) as unknown as Institution) ?? null;
  }

  async list(): Promise<Institution[]> {
    return (await this.db.prepare('SELECT * FROM institutions ORDER BY created_at').all()) as unknown as Institution[];
  }

  /**
   * Register or update an institution. Idempotent on id: partner simulators
   * re-register on boot, and a changed key is a rotation, recorded by
   * overwriting — history-preserving rotation is a live-tier requirement the
   * sandbox documents rather than fakes.
   */
  async upsert(inst: {
    id: string; role: InstitutionRole; name: string; country?: string;
    org_id?: string | null; signing_spki?: string; encryption_jwk?: unknown;
    authority?: string[];
  }): Promise<Institution> {
    const existing = await this.institution(inst.id);
    const enc = inst.encryption_jwk === undefined ? null : JSON.stringify(inst.encryption_jwk);
    if (existing) {
      await this.db.prepare(
        `UPDATE institutions SET role = ?, name = ?, country = ?, org_id = ?,
           signing_spki = COALESCE(?, signing_spki),
           encryption_jwk = COALESCE(?, encryption_jwk),
           authority = ? WHERE id = ?`,
      ).run(inst.role, inst.name, inst.country ?? null, inst.org_id ?? existing.org_id,
        inst.signing_spki ?? null, enc, JSON.stringify(inst.authority ?? []), inst.id);
    } else {
      await this.db.prepare(
        `INSERT INTO institutions (id, org_id, role, name, country, signing_spki, encryption_jwk, authority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(inst.id, inst.org_id ?? null, inst.role, inst.name, inst.country ?? null,
        inst.signing_spki ?? null, enc, JSON.stringify(inst.authority ?? []), nowIso());
    }
    return (await this.institution(inst.id))!;
  }

  /**
   * Point an institution at a different key. The rails verify against this
   * column and nothing else, so the switch holds from the next signature
   * checked — no restart, no re-subscription.
   */
  async setSigningKey(institutionId: string, spki: string): Promise<void> {
    await this.db.prepare('UPDATE institutions SET signing_spki = ? WHERE id = ?').run(spki, institutionId);
  }

  /**
   * The key the console's reserve screen signs with — a second key, beside
   * the signing key and never instead of it. The exchange's own key stays
   * where the exchange keeps it, on its server with the SDK; a page that
   * swapped it for one made in a browser would break that server the first
   * time someone tried the screen. Each session's key replaces the last.
   */
  async setConsoleKey(institutionId: string, spki: string): Promise<void> {
    await this.db.prepare('UPDATE institutions SET console_spki = ? WHERE id = ?').run(spki, institutionId);
  }

  /**
   * The registry as a verification keyring, trust level `ATTESTED`.
   *
   * `keyId` is the institution id: one signing key per institution in the
   * sandbox, so the id in a signature names its owner directly. The policy's
   * `sourceTrustLevel: 'ATTESTED'` is satisfied exactly by registered keys —
   * a signature from any other key verifies as UNKNOWN_KEY, never as identity.
   */
  async keyring(): Promise<Keyring> {
    const keys: VerificationKey[] = [];
    for (const inst of await this.list()) {
      if (!inst.signing_spki) continue;
      let publicKeyJwk: JsonWebKey;
      try {
        publicKeyJwk = spkiToJwk(inst.signing_spki);
      } catch {
        /*
         * One keyring serves every tenant, so one row that does not convert
         * would stop every tenant's reconciliation. The console routes that
         * write this column refuse such keys; a row from before they did, or
         * one the admin registration wrote, is left out — its own signatures
         * read UNKNOWN_KEY, nobody else's change — and named for an operator.
         * By id only: the column is meant to hold public material, but a row
         * that does not decode may not be that.
         */
        console.error(`registry: institution ${inst.id} has a signing key that does not convert; left out of the keyring`);
        continue;
      }
      keys.push({ keyId: inst.id, issuer: inst.name, trustLevel: 'ATTESTED', publicKeyJwk });
    }
    return keyring(keys);
  }

  /** Registry snapshot carried inside every evidence package. */
  async snapshot(): Promise<{ taken_at: string; institutions: Record<string, unknown>[] }> {
    return {
      taken_at: nowIso(),
      institutions: (await this.list()).map((i) => ({
        id: i.id, role: i.role, name: i.name, country: i.country,
        signing_spki: i.signing_spki, authority: JSON.parse(i.authority) as unknown,
        // Public key material only — a bank-SDK (mode B) encrypts to this.
        ...(i.encryption_jwk ? { encryption_jwk: JSON.parse(i.encryption_jwk) as unknown } : {}),
      })),
    };
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  async subscription(orgId: string, product: string): Promise<Subscription | null> {
    return ((await this.db.prepare('SELECT * FROM subscriptions WHERE org_id = ? AND product = ?')
      .get(orgId, product)) as unknown as Subscription) ?? null;
  }

  async subscriptions(orgId: string): Promise<Subscription[]> {
    return (await this.db.prepare('SELECT * FROM subscriptions WHERE org_id = ? ORDER BY created_at')
      .all(orgId)) as unknown as Subscription[];
  }

  async subscribe(orgId: string, product: string, config: Record<string, unknown>): Promise<Subscription> {
    const existing = await this.subscription(orgId, product);
    if (existing) {
      await this.db.prepare('UPDATE subscriptions SET config = ?, status = ? WHERE id = ?')
        .run(JSON.stringify(config), 'active', existing.id);
      return (await this.subscription(orgId, product))!;
    }
    await this.db.prepare(
      `INSERT INTO subscriptions (id, org_id, product, plan, status, config, created_at)
       VALUES (?, ?, ?, 'sandbox', 'active', ?, ?)`,
    ).run(randomUUID(), orgId, product, JSON.stringify(config), nowIso());
    return (await this.subscription(orgId, product))!;
  }

  /**
   * Deactivate a product. The row stays (history and billing continuity);
   * the gates read `status`, so inactive means every product API refuses
   * with `subscription_required` until reactivated.
   */
  async unsubscribe(orgId: string, product: string): Promise<Subscription | null> {
    const existing = await this.subscription(orgId, product);
    if (!existing) return null;
    await this.db.prepare("UPDATE subscriptions SET status = 'inactive' WHERE id = ?").run(existing.id);
    return this.subscription(orgId, product);
  }

  /** Gate for the PoR API: an active subscription and a registered exchange. */
  async requirePor(orgId: string): Promise<{ subscription: Subscription; exchange: Institution }> {
    const sub = await this.subscription(orgId, 'por');
    if (!sub || sub.status !== 'active') {
      throw new ServiceError(403, 'subscription_required',
        'this organisation has no active Proof of Reserves subscription; '
        + 'activate it from the console (Products) or POST /v1/console/products');
    }
    const exchange = await this.institutionForOrg(orgId, 'EXCHANGE');
    if (!exchange || !exchange.signing_spki) {
      throw new ServiceError(403, 'institution_unregistered',
        'no EXCHANGE institution with a signing key is registered for this organisation');
    }
    return { subscription: sub, exchange };
  }

  /** Gate for the remit API: an active subscription and a registered bank. */
  async requireRemit(orgId: string): Promise<{ subscription: Subscription; bank: Institution }> {
    const sub = await this.subscription(orgId, 'remit');
    if (!sub || sub.status !== 'active') {
      throw new ServiceError(403, 'subscription_required',
        'this organisation has no active Cross-border Settlement subscription; '
        + 'activate it from the console (Products) or POST /v1/console/products');
    }
    const bank = await this.institutionForOrg(orgId, 'COLLECTION_BANK');
    if (!bank || !bank.signing_spki) {
      throw new ServiceError(403, 'institution_unregistered',
        'no COLLECTION_BANK institution with a signing key is registered for this organisation');
    }
    return { subscription: sub, bank };
  }
}
