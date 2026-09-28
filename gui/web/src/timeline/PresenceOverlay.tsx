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
 * Server-clock now, read once per render and re-rendered at least every
 * PRESENCE_STALENESS_TICK_MS while `active`, so a client that stops
 * heartbeating drops out (and is announced as gone) without waiting for an
 * unrelated store update.
 */
function useServerNowMs(offsetMs: number, active: boolean): number {
  useIntervalTick(PRESENCE_STALENESS_TICK_MS, active);
  return serverNowMs(offsetMs);
}

/** Remote presence over the lanes, reading the session roster itself. */
export function PresenceOverlay(props: Props) {
  const clients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const project = useDawStore((s) => s.project);
  const { laneHeight } = useTimelineMetrics();
  const nowMs = useServerNowMs(
    offsetMs,
    clients.some((c) => c.client_id !== localClientId),
  );
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
