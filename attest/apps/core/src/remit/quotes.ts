/**
 * The quote engine — static corridor table, exact fixed-point arithmetic.
 *
 * Rates are configuration, not a market feed: a sandbox quote must be
 * reproducible in the evidence that later cites it, and the swap-out point
 * for a real FX source is exactly this module. The trade is denominated in
 * USD — the unit of account the reconciliation policy groups 1:1 with USDC —
 * with the VND funding leg and the SGD payout leg carried as locked
 * conversions of it, which is how the engine can reconcile the corridor
 * without inventing rates (`FX conversion is performed outside this engine`).
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/server.ts';
import { REQUIRED_TRAVEL_RULE_FIELDS } from './ivms101.ts';

export interface RemitRates { usdVnd: string; usdSgd: string }

export interface QuoteRequest {
  corridor: { origin: string; destination: string };
  trade: { currency: string; amount: string };
  collect: { currency: string };
  payout: { currency: string };
  beneficiary_institution?: string;
}

export interface QuoteResponse {
  quote_id: string;
  corridor: { origin: string; destination: string };
  trade: { currency: string; amount: string };
  settlement: { asset: string; amount: string; chain: string };
  collect: { currency: string; amount: string; rate: string; rate_pair: string };
  payout: { currency: string; amount: string; rate: string; rate_pair: string };
  fees: { type: string; currency: string; amount: string }[];
  expires_at: string;
  quoted_at: string;
  required_travel_rule_fields: string[];
}

const DEC = /^\d+(\.\d+)?$/;

/** Fixed-point multiply: decimal strings in, decimal string out, half-up. */
export function mulDecimal(a: string, b: string, outScale: number): string {
  const parse = (s: string): { units: bigint; scale: number } => {
    if (!DEC.test(s)) throw new HttpError(400, 'invalid_amount', `not a positive decimal: ${s}`);
    const [whole, frac = ''] = s.split('.') as [string, string?];
    return { units: BigInt(whole + (frac ?? '')), scale: (frac ?? '').length };
  };
  const x = parse(a);
  const y = parse(b);
  const rawScale = x.scale + y.scale;
  let units = x.units * y.units;
  if (rawScale > outScale) {
    const div = 10n ** BigInt(rawScale - outScale);
    units = (units + div / 2n) / div; // half-up
  } else {
    units *= 10n ** BigInt(outScale - rawScale);
  }
  const text = units.toString().padStart(outScale + 1, '0');
  return outScale === 0 ? text : `${text.slice(0, -outScale)}.${text.slice(-outScale)}`;
}

export function addDecimal(a: string, b: string, scale: number): string {
  const toUnits = (s: string): bigint => BigInt(mulDecimal(s, '1', scale).replace('.', ''));
  const text = (toUnits(a) + toUnits(b)).toString().padStart(scale + 1, '0');
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

export interface QuoteConfig {
  rates: RemitRates;
  feeUsd: string;
  ttlMs: number;
  chainLabel: string;
}

export function buildQuote(req: QuoteRequest, cfg: QuoteConfig, now = new Date()): QuoteResponse {
  if (req.corridor?.origin !== 'VN' || req.corridor?.destination !== 'SG') {
    throw new HttpError(400, 'unsupported_corridor',
      'this sandbox quotes the VN→SG corridor only');
  }
  if (req.trade?.currency !== 'USD') {
    throw new HttpError(400, 'unsupported_trade_currency',
      'trades are denominated in USD in this corridor (the unit of account the settlement reconciles 1:1 with USDC)');
  }
  if (req.collect?.currency !== 'VND' || req.payout?.currency !== 'SGD') {
    throw new HttpError(400, 'unsupported_leg_currency', 'collection must be VND and payout SGD on VN→SG');
  }
  if (!DEC.test(req.trade.amount ?? '')) {
    throw new HttpError(400, 'invalid_amount', 'trade.amount must be a positive decimal string');
  }

  const usdc = mulDecimal(req.trade.amount, '1', 2);
  const fundedUsd = addDecimal(req.trade.amount, cfg.feeUsd, 2);
  const collectVnd = mulDecimal(fundedUsd, cfg.rates.usdVnd, 0);
  const payoutSgd = mulDecimal(req.trade.amount, cfg.rates.usdSgd, 2);

  return {
    quote_id: `QT-${randomUUID().slice(0, 13)}`,
    corridor: { origin: 'VN', destination: 'SG' },
    trade: { currency: 'USD', amount: usdc },
    settlement: { asset: 'USDC', amount: usdc, chain: cfg.chainLabel },
    collect: { currency: 'VND', amount: collectVnd, rate: cfg.rates.usdVnd, rate_pair: 'USD/VND' },
    payout: { currency: 'SGD', amount: payoutSgd, rate: cfg.rates.usdSgd, rate_pair: 'USD/SGD' },
    fees: [{ type: 'platform', currency: 'USD', amount: cfg.feeUsd }],
    quoted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + cfg.ttlMs).toISOString(),
    required_travel_rule_fields: [...REQUIRED_TRAVEL_RULE_FIELDS],
  };
}
