/**
 * Stream-first fallback poll: run `tick` every `intervalMs` only while a live
 * stream (SSE / WebSocket) is down. Callers `start()` when the stream drops
 * and `stop()` as soon as it proves live again (open, or any frame).
 *
 * Shared by `usePipelineJob` (pipeline SSE) and `useGuestSync` (guest WS) so
 * the "any frame proves liveness, stop the fallback poll" rule lives in one
 * place. `startJobStatusRecheck` in `api/pipeline.ts` is a different shape:
 * a periodic backstop while a one-job waiter's stream is open.
 */
export type FallbackPoll = {
  /** Start polling (no-op while already running); `immediate` also ticks now. */
  start: (opts?: { immediate?: boolean }) => void;
  stop: () => void;
  readonly active: boolean;
};

export function createFallbackPoll(
  tick: () => void,
  intervalMs: number,
): FallbackPoll {
  let id: ReturnType<typeof setInterval> | null = null;
  return {
    start(opts) {
      if (id != null) {
        return;
      }
      id = setInterval(tick, intervalMs);
      if (opts?.immediate) {
        tick();
      }
    },
    stop() {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    },
    get active() {
      return id != null;
    },
  };
}
