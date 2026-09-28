import { useIntervalTick } from "../hooks/useIntervalTick";
import type { SessionClient } from "../types/session";
import { remotePresenceClients, serverNowMs } from "./followSync";

/** How often presence re-checks staleness while remote clients are listed. */
const PRESENCE_STALENESS_TICK_MS = 5_000;

export type LivePresenceClients = {
  /** Server-clock now, read once for this render. */
  nowMs: number;
  /** Remote clients still live at `nowMs` (the local client excluded). */
  others: SessionClient[];
};

/**
 * The live remote roster, filtered by staleness once per render at one
 * server-clock `nowMs`. Re-renders every PRESENCE_STALENESS_TICK_MS only
 * while some remote client is still live, so a client that stops
 * heartbeating drops out (and is announced as gone) without an unrelated
 * store update; once none is live the tick stops, and a fresh heartbeat (a
 * store update) re-renders and restarts it. Shared by every presence surface
 * that filters the roster by staleness (`PresenceOverlay`, `AvatarStack`,
 * `PresenceGhostLayer`).
 */
export function useLivePresenceClients(
  clients: SessionClient[],
  localId: string | null,
): LivePresenceClients {
  const nowMs = serverNowMs();
  const others = remotePresenceClients(clients, localId, nowMs);
  useIntervalTick(PRESENCE_STALENESS_TICK_MS, others.length > 0);
  return { nowMs, others };
}
