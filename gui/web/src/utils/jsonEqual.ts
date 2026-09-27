/**
 * Deep equality by JSON value: the same reference, or both sides serialize
 * to the same JSON. Key-order sensitive and serializes both values, so use
 * it only for small values with no identity-safe key of their own; a
 * different key order only costs a missed match.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
