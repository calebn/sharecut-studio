import { useDawStore } from "../state/dawStore";

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

export function serverNowMs(offsetMs: number, nowMs = Date.now()): number {
  return nowMs + offsetMs;
}

export function applyServerClock(serverTimeNs?: number): void {
  if (serverTimeNs == null || serverTimeNs <= 0) {
    return;
  }
  const prev = useDawStore.getState().serverClockOffsetMs;
  useDawStore
    .getState()
    .setServerClockOffsetMs(updateClockOffset(prev, serverTimeNs));
}
