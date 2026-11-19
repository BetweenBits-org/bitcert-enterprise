/**
 * Fixed-point decimal arithmetic over strings.
 *
 * ## Why not `number`
 *
 * Money comparisons decide whether a payment reconciles, and IEEE-754 cannot
 * represent most decimal fractions exactly: `0.1 + 0.2 !== 0.3`. An engine whose
 * whole promise is "same inputs always produce the same verdict" cannot be built
 * on a type where `50000.10 - 50000.00` is `0.09999999999417923`. A reviewer who
 * saw a mismatch flagged on a rounding artefact would be right to stop trusting
 * the result.
 *
 * So amounts travel as decimal **strings** end to end — in the evidence, in the
 * policy, and in the findings — and are compared as scaled `bigint`s here.
 * Nothing in this package ever converts an amount to `number`.
 */

/** A parsed decimal: `value / 10^scale`. */
export interface Decimal {
  /** Signed, already scaled. */
  value: bigint;
  scale: number;
}

const DECIMAL_RE = /^[+-]?(\d+)(\.(\d+))?$/;

/**
 * Parse a decimal string. Throws on anything else — including the empty string,
 * exponent notation and thousands separators.
 *
 * Rejecting rather than coercing is deliberate: a malformed amount is a data
 * problem the caller must see, not something to silently treat as zero.
 */
export function parseDecimal(s: string, field = 'amount'): Decimal {
  if (typeof s !== 'string') throw new Error(`${field}: expected a decimal string, got ${typeof s}`);
  const t = s.trim();
  const m = DECIMAL_RE.exec(t);
  if (!m) throw new Error(`${field}: not a plain decimal string: ${JSON.stringify(s)}`);
  const neg = t.startsWith('-');
  const int = m[1]!;
  const frac = m[3] ?? '';
  const value = BigInt(int + frac) * (neg ? -1n : 1n);
  return { value, scale: frac.length };
}

/** Re-scale two decimals to a common scale so they can be compared exactly. */
function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const pow = (n: number): bigint => 10n ** BigInt(n);
  return { a: a.value * pow(scale - a.scale), b: b.value * pow(scale - b.scale), scale };
}

export function add(x: Decimal, y: Decimal): Decimal {
  const { a, b, scale } = align(x, y);
  return { value: a + b, scale };
}

export function sub(x: Decimal, y: Decimal): Decimal {
  const { a, b, scale } = align(x, y);
  return { value: a - b, scale };
}

export function abs(x: Decimal): Decimal {
  return { value: x.value < 0n ? -x.value : x.value, scale: x.scale };
}

/** `-1` if `x < y`, `0` if equal, `1` if `x > y`. Exact. */
export function cmp(x: Decimal, y: Decimal): -1 | 0 | 1 {
  const { a, b } = align(x, y);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isZero(x: Decimal): boolean {
  return x.value === 0n;
}

/**
 * `x * bps / 10000`, rounded **up** in magnitude.
 *
 * Rounding away from zero widens a tolerance rather than narrowing it. A
 * tolerance that is a hair too tight would flag a payment that the policy
 * intended to accept, and a false mismatch costs a reviewer more than it saves.
 */
export function bps(x: Decimal, basisPoints: number): Decimal {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error(`basis points must be a non-negative integer, got ${basisPoints}`);
  }
  const scaled = abs(x).value * BigInt(basisPoints);
  const q = scaled / 10000n;
  const r = scaled % 10000n;
  return { value: r === 0n ? q : q + 1n, scale: x.scale };
}

/** Render back to a plain decimal string. Round-trips `parseDecimal`. */
export function formatDecimal(x: Decimal): string {
  const neg = x.value < 0n;
  const digits = (neg ? -x.value : x.value).toString().padStart(x.scale + 1, '0');
  const int = digits.slice(0, digits.length - x.scale) || '0';
  const frac = x.scale > 0 ? digits.slice(digits.length - x.scale) : '';
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Convenience: parse, operate, format — so callers stay in string space. */
export function diffString(a: string, b: string, field = 'amount'): string {
  return formatDecimal(abs(sub(parseDecimal(a, field), parseDecimal(b, field))));
}
