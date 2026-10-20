/** `value` limited to `[lo, hi]`; `hi` wins when the range is inverted. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
