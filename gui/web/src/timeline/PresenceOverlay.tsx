import { useEffect, useRef } from "react";
import { useIntervalTick } from "../hooks/useIntervalTick";
import { rosterDisplayName } from "../presence/colors";
import { remotePresenceClients, serverNowMs } from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import type { ClipRow, TrackView } from "../types/project";
import type { SessionClient } from "../types/session";
import { PresenceOverlayView } from "./PresenceOverlayView";
import { useTimelineMetrics } from "./timelineMetrics";

type Props = {
  zoomPxPerSec: number;
  height: number;
  tracks: TrackView[];
  clipsByTrack: Record<string, ClipRow[]>;
  hidePlayheadForClientId?: string | null;
};

function usePresenceAnnouncer(
  clients: SessionClient[],
  localId: string | null,
  nowMs: number,
): void {
  const prevRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(
      remotePresenceClients(clients, localId, nowMs).map((c) => c.client_id),
    );
    const prev = prevRef.current;
    prevRef.current = ids;
    if (prev == null) {
      return;
    }
    for (const id of ids) {
      if (!prev.has(id)) {
        const c = clients.find((x) => x.client_id === id);
        useDawStore
          .getState()
          .announceStatus(`${c ? rosterDisplayName(c) : id} joined`);
      }
    }
    for (const id of prev) {
      if (!ids.has(id)) {
        useDawStore.getState().announceStatus("Someone left");
      }
    }
  }, [clients, localId, nowMs]);
}

/** How often presence re-checks staleness while remote clients are listed. */
const PRESENCE_STALENESS_TICK_MS = 5_000;

/**
 * Server-clock now, read once per render. Re-renders every
 * PRESENCE_STALENESS_TICK_MS only while some remote client is still live, so
 * a client that stops heartbeating drops out (and is announced as gone)
 * without an unrelated store update; once none is live the tick stops, and a
 * fresh heartbeat (a store update) re-renders and restarts it.
 */
function useServerNowMs(
  clients: SessionClient[],
  localId: string | null,
): number {
  const nowMs = serverNowMs();
  const active = remotePresenceClients(clients, localId, nowMs).length > 0;
  useIntervalTick(PRESENCE_STALENESS_TICK_MS, active);
  return nowMs;
}

/** Remote presence over the lanes, reading the session roster itself. */
export function PresenceOverlay(props: Props) {
  const clients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const project = useDawStore((s) => s.project);
  const { laneHeight } = useTimelineMetrics();
  const nowMs = useServerNowMs(clients, localClientId);
  usePresenceAnnouncer(clients, localClientId, nowMs);

  return (
    <PresenceOverlayView
      {...props}
      clients={clients}
      localClientId={localClientId}
      nowMs={nowMs}
      project={project}
      laneHeight={laneHeight}
    />
  );
}
