/**
 * Amounts: from what a ledger exports to the integers the tree commits to.
 *
 * Every balance in the tree is a whole number of the asset's smallest unit,
 * written as a decimal string — the only form in which "the totals add up" is
 * a statement about integers and not about rounding. Ledgers rarely store
 * that. They store `0.5` in a DECIMAL column, and the conversion from one to
 * the other is where a liability figure can change without anyone deciding it
 * should: a float that prints as `0.30000000000000004`, a ninth decimal place
 * quietly dropped, `1e-7` read as one.
 *
 * So the conversion is exact or it is refused. Nothing is rounded, nothing is
 * truncated, and nothing is guessed: a value this module cannot place on the
 * integer grid exactly is an error that names what was wrong with it, for the
 * exchange to resolve in its own export.
 *
 * The unit is always stated by the caller, never inferred. `1` is one bitcoin
 * or one satoshi depending on a fact only the exchange knows, and a wrong
 * guess is a liability total off by a factor of a hundred million that still
 * looks like a number.
 */

/** `decimal`: 0.5 means half a coin. `base`: 50000000 means that many smallest units. */
export type AmountUnit = 'decimal' | 'base';

export type AmountProblem =
  | 'amount_empty' | 'amount_negative' | 'amount_exponent' | 'amount_grouping'
  | 'amount_fraction_in_base' | 'amount_precision' | 'amount_format' | 'amount_too_long';

export class AmountError extends Error {
  readonly code: AmountProblem;
  constructor(code: AmountProblem, message: string) {
    super(message);
    this.code = code;
  }
}

/** Far beyond any real supply; a value longer than this is a formatting accident. */
const MAX_DIGITS = 60;

/** Most assets use 18 or fewer; the bound exists to catch `BTC:80`. */
export const MAX_DECIMALS = 36;

const stripLeadingZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

/**
 * Convert one exported value to a canonical base-unit integer string.
 *
 * `decimals` is the asset's number of decimal places (8 for BTC, 18 for ETH,
 * 0 for a currency with no minor unit).
 */
export function toBaseUnits(text: string, decimals: number, unit: AmountUnit): string {
  // Padding from a fixed-width export is not part of the number. Unlike an
  // account identifier, trimming it cannot merge two different values.
  const v = text.trim();
  if (v === '') throw new AmountError('amount_empty', 'the amount is empty');
  if (v.length > MAX_DIGITS + 2) {
    throw new AmountError('amount_too_long', `"${v.slice(0, 24)}…" is too long to be an amount`);
  }
  if (/^[-−]/.test(v)) {
    throw new AmountError('amount_negative',
      `"${v}" is negative; a liability cannot be below zero — settle or exclude it in the export`);
  }
  if (/[eE]/.test(v)) {
    throw new AmountError('amount_exponent',
      `"${v}" is in exponent notation; export the column as plain decimal text`);
  }
  if (/[,\s_']/.test(v)) {
    throw new AmountError('amount_grouping',
      `"${v}" contains a grouping separator or a decimal comma; export digits and "." only`);
  }

  if (unit === 'base') {
    if (/^\d+$/.test(v)) return stripLeadingZeros(v);
    if (/^\d*\.\d*$/.test(v)) {
      throw new AmountError('amount_fraction_in_base',
        `"${v}" has a decimal point, but amounts were declared as smallest units; use --amounts decimal`);
    }
    throw new AmountError('amount_format', `"${v}" is not a whole number`);
  }

  // `.5` is what some databases print for one half; `5.` is not what any prints.
  const m = /^(\d*)(?:\.(\d+))?$/.exec(v);
  if (!m || (m[1] === '' && m[2] === undefined)) {
    throw new AmountError('amount_format', `"${v}" is not a decimal number`);
  }
  const whole = m[1] === '' ? '0' : m[1]!;
  const fraction = m[2] ?? '';
  // A DECIMAL(36,18) column prints eighteen places for an asset that has
  // eight. Trailing zeros beyond the asset's precision carry no value; any
  // other digit there is value the tree could not represent.
  const kept = fraction.slice(0, decimals);
  const beyond = fraction.slice(decimals);
  if (/[1-9]/.test(beyond)) {
    throw new AmountError('amount_precision',
      `"${v}" has more than ${decimals} decimal place${decimals === 1 ? '' : 's'}; the asset was declared with ${decimals}`);
  }
  return stripLeadingZeros(whole + kept.padEnd(decimals, '0'));
}

/** The reverse, for reports a person reads: base units back to a decimal figure. */
export function fromBaseUnits(base: string, decimals: number): string {
  if (!/^\d+$/.test(base)) throw new Error(`"${base}" is not a base-unit integer`);
  if (decimals === 0) return stripLeadingZeros(base);
  const padded = base.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction === '' ? stripLeadingZeros(whole) : `${stripLeadingZeros(whole)}.${fraction}`;
}
