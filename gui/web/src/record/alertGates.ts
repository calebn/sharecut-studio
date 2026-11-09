const WINDOW_MS = 30_000;
const COUNT = 3;

export function clippingGate(regions: readonly { startMs: number }[]): boolean {
  const starts = regions.map((r) => r.startMs).sort((a, b) => a - b);
  for (let i = 0; i + COUNT <= starts.length; i++) {
    if (starts[i + COUNT - 1] - starts[i] <= WINDOW_MS) return true;
  }
  return false;
}
