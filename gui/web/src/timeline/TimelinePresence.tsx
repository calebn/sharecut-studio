import {
  memo,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { rosterDisplayName } from "../presence/colors";
import {
  isObservingClient,
  remotePlayheadSec,
  serverNowMs,
} from "../presence/followSync";
import { presencePeople } from "../presence/presencePeople";
import { sessionClientList } from "../presence/roster";
import {
  presenceIdsKey,
  useLivePresenceClients,
} from "../presence/useLivePresenceClients";
import { useDawStore } from "../state/dawStore";
import { laneRows } from "../system/laneMath";
import { Presence } from "../system/Presence";
import { presenceX } from "../system/presenceMath";
import type { SessionClient } from "../types/session";
import { RULER_HEIGHT } from "../utils/layout";
import { presenceSelections } from "./presenceSelections";
import { useRulerWindow } from "./useRulerWindow";

type Props = {
  /** The canvas width in px: the window never reaches past it. */
  canvasWidthPx: number;
  /** The time viewport in px: with the canvas it fixes the ruler's window. */
  viewportPx: number;
  zoomPxPerSec: number;
  /** The lanes' height in px, as the stack draws it (held steady in a drag). */
  laneHeight: number;
  /** The marker lane's height in px, as the stack draws it. */
  markerLaneHeightPx: number;
  /** The person you follow draws nothing: you already see what they see. */
  followingClientId: string | null;
};

const NO_TRACKS: never[] = [];

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
        useDawStore
          .getState()
          .announceStatus(`${rosterDisplayName(c)} joined`, { toast: false });
      }
    }
    for (const id of prev) {
      if (!ids.has(id)) {
        useDawStore.getState().announceStatus("Someone left", { toast: false });
      }
    }
  });
  useEffect(() => {
    announceChanges();
  }, [idsKey]);
}

/** Whether a remote playhead moves on its own: someone plays and is not riding another playhead. */
function isPlayingRemote(client: SessionClient, followed: string | null) {
  return (
    client.client_id !== followed &&
    !isObservingClient(client) &&
    client.meta?.transport?.playing === true
  );
}

/**
 * Re-renders (by returning a newer server-clock time) only while a remote playhead
 * plays, and only on a frame where one of them crosses into the next whole
 * px. The leaf draws a still playhead, so this is what keeps a playing one
 * moving between the roster's updates; with nobody playing no frame runs.
 */
function usePlayingFrame(
  others: SessionClient[],
  followed: string | null,
  durationSec: number,
  start: number,
  zoomPxPerSec: number,
): number {
  const [tickMs, setTickMs] = useState(0);
  const anyPlaying = others.some((c) => isPlayingRemote(c, followed));
  const pxKey = useEffectEvent(() => {
    const nowMs = serverNowMs();
    return others
      .filter((c) => isPlayingRemote(c, followed))
      .map((c) => {
        const sec = remotePlayheadSec(c, durationSec, nowMs);
        return sec === null ? "" : presenceX(sec, start, zoomPxPerSec);
      })
      .join(",");
  });
  useEffect(() => {
    if (!anyPlaying) return;
    let last = pxKey();
    let raf = 0;
    const tick = () => {
      const key = pxKey();
      if (key !== last) {
        last = key;
        setTickMs(serverNowMs());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anyPlaying]);
  return tickMs;
}

/**
 * Other people's playheads and selections over the whole time column
 * (OVL-PRESENCE): the system Presence leaf in the ruler's own window, fed by
 * the session roster and the project. It owns what the leaf leaves to its
 * host: who is live (and the join and leave announcements), the motion of a
 * playing playhead, and each selection's lane and span.
 */
export const TimelinePresence = memo(function TimelinePresence({
  canvasWidthPx,
  viewportPx,
  zoomPxPerSec,
  laneHeight,
  markerLaneHeightPx,
  followingClientId,
}: Props) {
  const clients = useDawStore((s) => sessionClientList(s.sessionClients));
  const localClientId = useDawStore((s) => s.localClientId);
  const project = useDawStore((s) => s.project);
  const { others } = useLivePresenceClients(clients, localClientId);
  usePresenceAnnouncer(others);

  const { left, width } = useRulerWindow(canvasWidthPx, viewportPx);
  const start = left / zoomPxPerSec;
  const durationSec = project?.timeline_duration_sec ?? Number.NaN;
  const tickMs = usePlayingFrame(
    others,
    followingClientId,
    durationSec,
    start,
    zoomPxPerSec,
  );

  const people = useMemo(
    // Never older than the ticker's last frame, never older than now.
    () => presencePeople(others, durationSec, Math.max(tickMs, serverNowMs())),
    [others, durationSec, tickMs],
  );
  const selections = useMemo(
    () => presenceSelections(others, project, zoomPxPerSec),
    [others, project, zoomPxPerSec],
  );
  const tracks = project?.tracks ?? NO_TRACKS;
  const rows = useMemo(
    () =>
      laneRows(
        tracks.map((t) => ({ id: t.id, height: laneHeight })),
        RULER_HEIGHT + markerLaneHeightPx,
      ),
    [tracks, laneHeight, markerLaneHeightPx],
  );

  return (
    <div
      className="timeline-presence-window"
      style={{ insetInlineStart: left, inlineSize: width }}
    >
      <Presence
        people={people}
        selections={selections}
        rows={rows}
        followed={followingClientId}
        start={start}
        pxPerSecond={zoomPxPerSec}
        width={width}
      />
    </div>
  );
});
