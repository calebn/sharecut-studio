import { useEffect, useRef } from "react";
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
  offsetMs: number,
): void {
  const prevRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = serverNowMs(offsetMs);
    const ids = new Set(
      remotePresenceClients(clients, localId, now).map((c) => c.client_id),
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
  }, [clients, localId, offsetMs]);
}

/** Remote presence over the lanes, reading the session roster itself. */
export function PresenceOverlay(props: Props) {
  const clients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const project = useDawStore((s) => s.project);
  const { laneHeight } = useTimelineMetrics();
  usePresenceAnnouncer(clients, localClientId, offsetMs);

  return (
    <PresenceOverlayView
      {...props}
      clients={clients}
      localClientId={localClientId}
      nowMs={serverNowMs(offsetMs)}
      project={project}
      laneHeight={laneHeight}
    />
  );
}
