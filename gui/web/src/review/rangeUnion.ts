/** Total length covered by the ranges, counting overlaps once; empty, reversed and non-finite ranges are ignored. */
export function unionSeconds(
  ranges: readonly (readonly [start: number, end: number])[],
): number {
  const usable = ranges
    .filter(
      ([start, end]) =>
        Number.isFinite(start) && Number.isFinite(end) && end > start,
    )
    .map(([start, end]) => [start, end] as const)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let edge = Number.NEGATIVE_INFINITY;
  for (const [start, end] of usable) {
    const from = Math.max(start, edge);
    if (end > from) covered += end - from;
    edge = Math.max(edge, end);
  }
  return covered;
}
