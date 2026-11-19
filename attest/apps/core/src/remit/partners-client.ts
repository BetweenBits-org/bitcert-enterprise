/**
 * Outbound connectors: the BFI (Triple-A-profile simulator) and the
 * settlement-entity wallet, both living in demo-partners.
 *
 * This is the plug point the architecture names `BFI Connector` (§5-3): the
 * interface is the contract, `TripleAProfileSim` is its first
 * implementation, and a real receiving institution lands as a sibling class,
 * not a rewrite. Every response that asserts a fact comes back signed by the
 * asserting institution's key — transport security and content signatures
 * are separate concerns (§4-1), and only the second one reaches the
 * evidence.
 */
import { ServiceError } from '../service.ts';
import type { EventSig } from './sign.ts';

export interface BfiTravelRuleAck {
  status: 'ACK' | 'RFI' | 'REJECTED';
  reason?: string;
  rfi?: { id: string; questions: string[] };
  ack?: { payload: Record<string, unknown>; sig: EventSig };
}

export interface BfiPayoutApproval {
  approval: {
    payload: {
      payment_id: string;
      deposit_address: string;
      chain: string;
      asset: string;
      usdc_amount: string;
      approved_at: string;
      valid_until: string;
      travel_rule_element: Record<string, unknown>;
    };
    sig: EventSig;
  };
}

export interface WalletTransferResult {
  result: {
    payload: {
      payment_id: string;
      tx_hash: string;
      block: number;
      from_address: string;
      to_address: string;
      usdc_amount: string;
      observed_at: string;
      chain_transfer_element: Record<string, unknown>;
    };
    sig: EventSig;
  };
}

export interface BfiConnector {
  sendTravelRule(paymentId: string, jwe: string, digest: string, sender: EventSig): Promise<BfiTravelRuleAck>;
  sendTravelRuleResponse(paymentId: string, jwe: string, digest: string, sender: EventSig): Promise<BfiTravelRuleAck>;
  requestPayoutApproval(body: Record<string, unknown>): Promise<BfiPayoutApproval>;
  notifySettlement(paymentId: string, txHash: string, sender: EventSig): Promise<void>;
  notifyCancel(paymentId: string, reason: string, sender: EventSig): Promise<void>;
}

export interface SettlementWallet {
  transfer(body: Record<string, unknown>): Promise<WalletTransferResult>;
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ServiceError(502, 'partner_unreachable',
      `${path}: partner simulator not reachable at ${base} — is demo-partners running? (${e instanceof Error ? e.message : e})`);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400) {
    const msg = (json as { message?: string; error?: string });
    throw new ServiceError(502, 'partner_error',
      `${path} → HTTP ${res.status}: ${msg.message ?? msg.error ?? 'partner error'}`);
  }
  return json as T;
}

/** The first (and sandbox-only) BFI implementation: Triple-A profile, SG. */
export class TripleAProfileSim implements BfiConnector, SettlementWallet {
  private readonly base: string;
  constructor(base: string) { this.base = base; }

  sendTravelRule(paymentId: string, jwe: string, digest: string, sender: EventSig): Promise<BfiTravelRuleAck> {
    return post(this.base, '/bfi/travel-rule', { payment_id: paymentId, jwe, ivms101_digest: digest, sender });
  }

  sendTravelRuleResponse(paymentId: string, jwe: string, digest: string, sender: EventSig): Promise<BfiTravelRuleAck> {
    return post(this.base, '/bfi/travel-rule-response', { payment_id: paymentId, jwe, answers_digest: digest, sender });
  }

  async notifyCancel(paymentId: string, reason: string, sender: EventSig): Promise<void> {
    await post(this.base, '/bfi/cancel', { payment_id: paymentId, reason, sender });
  }

  requestPayoutApproval(body: Record<string, unknown>): Promise<BfiPayoutApproval> {
    return post(this.base, '/bfi/payout-approval', body);
  }

  async notifySettlement(paymentId: string, txHash: string, sender: EventSig): Promise<void> {
    await post(this.base, '/bfi/settlement-notice', { payment_id: paymentId, tx_hash: txHash, sender });
  }

  transfer(body: Record<string, unknown>): Promise<WalletTransferResult> {
    return post(this.base, '/wallet/transfer', body);
  }
}
