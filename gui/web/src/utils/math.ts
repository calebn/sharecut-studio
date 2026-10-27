/** `value` limited to `[lo, hi]`; `hi` wins when the range is inverted. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Index of the last value at or before `target` in an ascending array, or undefined when every value is later. */
export function lastIndexAtOrBefore(
  ascending: readonly number[],
  target: number,
): number | undefined {
  let low = 0;
  let high = ascending.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((ascending[mid] as number) <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}
