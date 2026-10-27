/** A progress value held to 0..1. NaN, infinities and a missing value read as 0 (or 1 for +Infinity). */
export function clampUnit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A progress value as a whole percent, 0 to 100. */
export function percentOf(value: number | undefined): number {
  return Math.round(clampUnit(value) * 100);
}
