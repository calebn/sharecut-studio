/**
 * Server clock offset as module state, outside the DAW store. The offset is
 * read far more often (every presence render) than it changes, and it never
 * needs to trigger a store notify or a component re-render on its own — see
 * `serverNowMs`. One offset per JS runtime: this assumes a single DAW
 * store/session per page; a multi-store app would need it keyed per store.
 * `test/setup.ts` resets it after every test.
 */
let offsetMs = 0;

export function updateClockOffset(
  prev: number,
  serverTimeNs: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(serverTimeNs) || serverTimeNs <= 0) {
    return prev;
  }
  const sample = serverTimeNs / 1e6 - nowMs;
  if (!Number.isFinite(sample)) {
    return prev;
  }
  return prev * 0.8 + sample * 0.2;
}

/** Server-clock now, from the module-level offset. */
export function serverNowMs(nowMs = Date.now()): number {
  return nowMs + offsetMs;
}

/** The current offset, for callers that still need the raw number. */
export function currentServerClockOffsetMs(): number {
  return offsetMs;
}

/**
 * Folds one server timestamp sample into the module offset. Module state
 * only — no store, no listeners, no re-render.
 */
export function applyServerClock(serverTimeNs?: number, nowMs?: number): void {
  if (serverTimeNs == null || serverTimeNs <= 0) {
    return;
  }
  offsetMs = updateClockOffset(offsetMs, serverTimeNs, nowMs);
}

/** Resets the offset, e.g. on a project switch that starts a new session. */
export function resetServerClock(): void {
  offsetMs = 0;
}

/** Test-only: set the offset directly instead of feeding it samples. */
export function setServerClockOffsetForTests(ms: number): void {
  offsetMs = ms;
}
