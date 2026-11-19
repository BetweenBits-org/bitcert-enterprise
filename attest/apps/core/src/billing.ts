/**
 * This month's bill, from the deployment's price list.
 *
 * Pure: the endpoint hands in what it metered and which products are active;
 * this turns it into lines and a total. Kept apart from the route so the
 * arithmetic can be tested without a server, and so the price list has one
 * reader.
 */
import type { Pricing } from './config.ts';

export type BillableProduct = 'attest' | 'remit' | 'por';

export interface MonthlyUsage {
  /** Customer anchors created this month — the Attest meter. */
  anchors: number;
  settlements: number;
  snapshots: number;
}

export interface ChargeLine {
  product: BillableProduct;
  unit: 'anchor' | 'settlement' | 'snapshot';
  quantity: number;
  monthly_fee: number;
  unit_price: number;
  amount: number;
}

export interface Charges {
  currency: string;
  /** The UTC calendar month; `end` is exclusive — the next period's start. */
  period: { start: string; end: string };
  lines: ChargeLine[];
  total: number;
}

/** Two decimals, the finest any supported currency goes. */
const money = (n: number): number => Math.round(n * 100) / 100;

export function monthlyCharges(
  pricing: Pricing, usage: MonthlyUsage, active: ReadonlySet<string>, monthStart: Date,
): Charges {
  const line = (product: BillableProduct, unit: ChargeLine['unit'], quantity: number,
    fee: number, unitPrice: number): ChargeLine =>
    ({ product, unit, quantity, monthly_fee: fee, unit_price: unitPrice, amount: money(fee + quantity * unitPrice) });
  // The order the dashboard draws the products in. A product that is not
  // subscribed has no line: its monthly fee is not owed.
  const lines: ChargeLine[] = [
    ...(active.has('remit') ? [line('remit', 'settlement', usage.settlements, pricing.remit.monthly_fee, pricing.remit.per_settlement)] : []),
    ...(active.has('por') ? [line('por', 'snapshot', usage.snapshots, pricing.por.monthly_fee, pricing.por.per_snapshot)] : []),
    ...(active.has('attest') ? [line('attest', 'anchor', usage.anchors, pricing.attest.monthly_fee, pricing.attest.per_anchor)] : []),
  ];
  return {
    currency: pricing.currency,
    period: {
      start: monthStart.toISOString(),
      end: new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)).toISOString(),
    },
    lines,
    total: money(lines.reduce((a, l) => a + l.amount, 0)),
  };
}
