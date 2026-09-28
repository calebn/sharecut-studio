import { useMemo } from "react";
import { useIntervalTick } from "../hooks/useIntervalTick";
import type { SessionClient } from "../types/session";
import { remotePresenceClients, serverNowMs } from "./followSync";

/** How often presence re-checks staleness while remote clients are listed. */
const PRESENCE_STALENESS_TICK_MS = 5_000;

/** Joins client ids into one key; a unit separator never occurs in an id. */
const CLIENT_ID_SEPARATOR = "\u001f";

/** The ids of `clients`, in order, as one string that compares by value. */
export function presenceIdsKey(clients: readonly SessionClient[]): string {
  return clients.map((c) => c.client_id).join(CLIENT_ID_SEPARATOR);
}

export type LivePresenceClients = {
  /** Server-clock now, read once for this render. */
  nowMs: number;
  /**
   * Remote clients still live at `nowMs` (the local client excluded). The
   * same array while the roster and its live ids are unchanged.
   */
  others: SessionClient[];
};

/**
 * The live remote roster, filtered by staleness once per render at one
 * server-clock `nowMs`. Re-renders every PRESENCE_STALENESS_TICK_MS only
 * while some remote client is still live, so a client that stops
 * heartbeating drops out (and is announced as gone) without an unrelated
 * store update; once none is live the tick stops, and a fresh heartbeat (a
 * store update) re-renders and restarts it. `others` is memoised on the
 * roster and its live ids, so a render that only ticks the clock or changes
 * an unrelated prop hands callers the same array. Shared by every presence
 * surface that filters the roster by staleness (`PresenceOverlay`,
 * `AvatarStack`, `PresenceGhostLayer`).
 */
export function useLivePresenceClients(
  clients: SessionClient[],
  localId: string | null,
): LivePresenceClients {
  const nowMs = serverNowMs();
  const liveKey = presenceIdsKey(
    remotePresenceClients(clients, localId, nowMs),
  );
  const others = useMemo(() => {
    if (liveKey === "") {
      return [];
    }
    const live = new Set(liveKey.split(CLIENT_ID_SEPARATOR));
    return clients.filter((c) => live.has(c.client_id));
  }, [clients, liveKey]);
  useIntervalTick(PRESENCE_STALENESS_TICK_MS, others.length > 0);
  return { nowMs, others };
}
