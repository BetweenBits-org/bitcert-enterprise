/**
 * Canonical JSON — the RFC 8785 (JCS) subset the proof-bundle schemes use:
 * keys sorted by code unit, no insignificant whitespace.
 *
 * Deliberately a subset. Every object canonicalised here contains only strings
 * and safe integers (asset symbols, decimal amounts carried as strings, scales,
 * 0/1 flags). Full RFC 8785 number serialisation — the ECMAScript
 * `Number::toString` rules for floats — is the hard part of that spec and this
 * schema never needs it, so attempting it would add risk with no caller.
 * A float reaches here only as a schema violation, so it throws rather than
 * silently emitting bytes the Rust producer and Python verifier would not agree
 * on. That agreement is the whole point: a one-byte difference changes the hash.
 */

export type JcsValue = string | number | boolean | null | JcsValue[] | { [k: string]: JcsValue };

/** Serialise to canonical JSON bytes. */
export function jcs(value: JcsValue): Uint8Array {
  return new TextEncoder().encode(jcsString(value));
}

/** Serialise to a canonical JSON string. */
export function jcsString(value: JcsValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`jcs: only integers are supported in this schema, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`jcs: integer out of safe range: ${value}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcsString).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcsString(value[k] as JcsValue)}`).join(',')}}`;
}
