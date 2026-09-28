import { useIntervalTick } from "../hooks/useIntervalTick";
import type { SessionClient } from "../types/session";
import { remotePresenceClients, serverNowMs } from "./followSync";

/** How often presence re-checks staleness while remote clients are listed. */
const PRESENCE_STALENESS_TICK_MS = 5_000;

/**
 * Server-clock now, read once per render. Re-renders every
 * PRESENCE_STALENESS_TICK_MS only while some remote client is still live, so
 * a client that stops heartbeating drops out (and is announced as gone)
 * without an unrelated store update; once none is live the tick stops, and a
 * fresh heartbeat (a store update) re-renders and restarts it. Shared by
 * every presence surface that filters the roster by staleness
 * (`PresenceOverlay`, `AvatarStack`, `PresenceGhostLayer`).
 */
export function useServerNowMs(
  clients: SessionClient[],
  localId: string | null,
): number {
  const nowMs = serverNowMs();
  const active = remotePresenceClients(clients, localId, nowMs).length > 0;
  useIntervalTick(PRESENCE_STALENESS_TICK_MS, active);
  return nowMs;
}
