import { useEffect, useEffectEvent, useRef } from "react";
import { rosterDisplayName } from "../presence/colors";
import { sessionClientList } from "../presence/roster";
import {
  presenceIdsKey,
  useLivePresenceClients,
} from "../presence/useLivePresenceClients";
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

/**
 * Announces remote joins and departures. The effect keys on the live ids by
 * value, so a render that only replaces client objects (a cursor or playhead
 * move) or changes an unrelated prop does not re-run it.
 */
function usePresenceAnnouncer(others: SessionClient[]): void {
  const prevRef = useRef<Set<string> | null>(null);
  const idsKey = presenceIdsKey(others);
  const announceChanges = useEffectEvent(() => {
    const ids = new Set(others.map((c) => c.client_id));
    const prev = prevRef.current;
    prevRef.current = ids;
    if (prev == null) {
      return;
    }
    for (const c of others) {
      if (!prev.has(c.client_id)) {
        useDawStore.getState().announceStatus(`${rosterDisplayName(c)} joined`);
      }
    }
    for (const id of prev) {
      if (!ids.has(id)) {
        useDawStore.getState().announceStatus("Someone left");
      }
    }
  });
  useEffect(() => {
    announceChanges();
  }, [idsKey]);
}

/** Remote presence over the lanes, reading the session roster itself. */
export function PresenceOverlay(props: Props) {
  const clients = useDawStore((s) => sessionClientList(s.sessionClients));
  const localClientId = useDawStore((s) => s.localClientId);
  const project = useDawStore((s) => s.project);
  const { laneHeight } = useTimelineMetrics();
  const { nowMs, others } = useLivePresenceClients(clients, localClientId);
  usePresenceAnnouncer(others);

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
