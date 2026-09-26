import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { presenceColorVar, rosterDisplayName } from "../presence/colors";
import { createCursorMotion } from "../presence/cursorMotion";
import {
  isObservingClient,
  remotePresenceClients,
  serverNowMs,
} from "../presence/followSync";
import { useDawStore } from "../state/dawStore";
import type { ClipRow, ProjectView, TrackView } from "../types/project";
import type {
  PresenceCursor,
  SessionClient,
  SessionSelection,
} from "../types/session";
import { Avatar } from "../ui/Avatar";
import { useTimelineMetrics } from "./timelineMetrics";

type Props = {
  clients: SessionClient[];
  localClientId: string | null;
  zoomPxPerSec: number;
  height: number;
  tracks: TrackView[];
  clipsByTrack: Record<string, ClipRow[]>;
  hidePlayheadForClientId?: string | null;
};

/**
 * A remote selection box: `left` and `width` in seconds, `top` in px, and
 * the narrowest it may draw (px), so a point or a short span stays visible
 * at any zoom.
 */
type SelectionBox = { left: number; width: number; top: number; minPx: number };

/** Narrowest remote span (px), e.g. a one-word transcript selection. */
const SPAN_MIN_PX = 2;
/** Width of a remote pending / applied point selection (px). */
const POINT_PX = 2;
/** Width of a remote envelope-point selection (px). */
const ENVELOPE_POINT_PX = 5;

function laneCursorTop(
  cursor: PresenceCursor,
  tracks: TrackView[],
  laneHeight: number,
): number | null {
  // lane_pos is in lane units, so viewers with different lane heights agree.
  if (cursor.lane_pos != null && Number.isFinite(cursor.lane_pos)) {
    const maxPos = Math.max(0, tracks.length);
    return Math.min(cursor.lane_pos, maxPos) * laneHeight;
  }
  if (cursor.track_id) {
    const idx = tracks.findIndex((t) => t.id === cursor.track_id);
    return idx < 0 ? null : idx * laneHeight + laneHeight / 2;
  }
  return null;
}

function isLaneCursor(
  cursor: PresenceCursor | null | undefined,
): cursor is PresenceCursor & { t_sec: number } {
  return Boolean(
    cursor && cursor.anchor == null && typeof cursor.t_sec === "number",
  );
}

function clipBox(
  clipsByTrack: Record<string, ClipRow[]>,
  tracks: TrackView[],
  id: string,
  laneHeight: number,
): SelectionBox | null {
  for (const [trackId, clips] of Object.entries(clipsByTrack)) {
    const clip = clips.find((c) => c.id === id);
    if (!clip) {
      continue;
    }
    const idx = tracks.findIndex((t) => t.id === trackId);
    return {
      left: clip.timeline_start,
      width: Math.max(0, clip.timeline_end - clip.timeline_start),
      top: (idx < 0 ? 0 : idx) * laneHeight,
      minPx: SPAN_MIN_PX,
    };
  }
  return null;
}

function transcriptWordBox(
  project: ProjectView | null,
  tracks: TrackView[],
  sel: SessionSelection,
  laneHeight: number,
): SelectionBox | null {
  if (
    (sel.kind !== "transcriptWord" && sel.kind !== "transcriptRange") ||
    !sel.track_id ||
    sel.word_index == null
  ) {
    return null;
  }
  const lo = Math.min(
    sel.word_index,
    sel.kind === "transcriptRange"
      ? (sel.word_end ?? sel.word_index)
      : sel.word_index,
  );
  const hi = Math.max(
    sel.word_index,
    sel.kind === "transcriptRange"
      ? (sel.word_end ?? sel.word_index)
      : sel.word_index,
  );
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const u of project?.transcript?.utterances ?? []) {
    if (u.track_id !== sel.track_id) {
      continue;
    }
    for (const w of u.words ?? []) {
      if (w.word_index == null || w.word_index < lo || w.word_index > hi) {
        continue;
      }
      t0 = Math.min(t0, w.timeline_start ?? w.start);
      t1 = Math.max(t1, w.timeline_end ?? w.end);
    }
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) {
    return null;
  }
  const idx = tracks.findIndex((t) => t.id === sel.track_id);
  return {
    left: t0,
    width: t1 - t0,
    minPx: SPAN_MIN_PX,
    top: (idx < 0 ? 0 : idx) * laneHeight,
  };
}

function selectionBox(
  clipsByTrack: Record<string, ClipRow[]>,
  tracks: TrackView[],
  project: ProjectView | null,
  sel: SessionClient["meta"] extends infer M
    ? M extends { selection?: infer S }
      ? S
      : never
    : never,
  laneHeight: number,
): SelectionBox | null {
  if (!sel) {
    return null;
  }
  if (sel.kind === "clip" && sel.id) {
    return clipBox(clipsByTrack, tracks, sel.id, laneHeight);
  }
  if (
    (sel.kind === "pending" || sel.kind === "applied") &&
    sel.track_id &&
    sel.time != null
  ) {
    const idx = tracks.findIndex((t) => t.id === sel.track_id);
    if (idx < 0) {
      return null;
    }
    return { left: sel.time, width: 0, top: idx * laneHeight, minPx: POINT_PX };
  }
  if (sel.kind === "envelopePoint" && sel.track_id && sel.time != null) {
    const idx = tracks.findIndex((t) => t.id === sel.track_id);
    if (idx < 0) {
      return null;
    }
    return {
      left: sel.time,
      width: 0,
      top: idx * laneHeight,
      minPx: ENVELOPE_POINT_PX,
    };
  }
  return transcriptWordBox(project, tracks, sel, laneHeight);
}

function usePresenceAnnouncer(
  clients: SessionClient[],
  localId: string | null,
): void {
  const prevRef = useRef<Set<string> | null>(null);
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
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
export function PresenceOverlay(
  props: Omit<Props, "clients" | "localClientId">,
) {
  const clients = useDawStore((s) => s.sessionClients);
  const localClientId = useDawStore((s) => s.localClientId);
  return (
    <PresenceOverlayView
      {...props}
      clients={clients}
      localClientId={localClientId}
    />
  );
}

export function PresenceOverlayView({
  clients,
  localClientId,
  zoomPxPerSec,
  height,
  tracks,
  clipsByTrack,
  hidePlayheadForClientId = null,
}: Props) {
  const offsetMs = useDawStore((s) => s.serverClockOffsetMs);
  const project = useDawStore((s) => s.project);
  const durationSec = project?.timeline_duration_sec ?? Number.NaN;
  const now = serverNowMs(offsetMs);
  const others = remotePresenceClients(clients, localClientId, now);
  usePresenceAnnouncer(clients, localClientId);

  const cursorEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const motion = useRef(createCursorMotion());
  const othersRef = useRef(others);
  othersRef.current = others;
  const zoomRef = useRef(zoomPxPerSec);
  zoomRef.current = zoomPxPerSec;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const { laneHeight } = useTimelineMetrics();
  const laneHeightRef = useRef(laneHeight);
  laneHeightRef.current = laneHeight;

  const hasRemoteCursor = others.some((c) => isLaneCursor(c.meta?.cursor));

  useEffect(() => {
    if (!hasRemoteCursor) {
      return;
    }
    let raf = 0;
    const tick = () => {
      const z = zoomRef.current;
      for (const c of othersRef.current) {
        const cursor = c.meta?.cursor;
        if (!isLaneCursor(cursor)) {
          continue;
        }
        const targetTop = laneCursorTop(
          cursor,
          tracksRef.current,
          laneHeightRef.current,
        );
        if (targetTop == null) {
          continue;
        }
        const el = cursorEls.current.get(c.client_id);
        motion.current.step(
          c.client_id,
          { left: cursor.t_sec * z, top: targetTop },
          el,
          `${cursor.t_sec}:${cursor.track_id ?? ""}:${cursor.lane_pos ?? ""}`,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasRemoteCursor]);

  if (others.length === 0) {
    return null;
  }

  return (
    <div className="presence-overlay" aria-hidden>
      {others.map((c) => {
        const color = presenceColorVar(c.meta?.color_index);
        const name = rosterDisplayName(c);
        const playhead = remotePlayheadSec(c, durationSec);
        const box = selectionBox(
          clipsByTrack,
          tracks,
          project,
          c.meta?.selection ?? null,
          laneHeight,
        );
        const lane = isLaneCursor(c.meta?.cursor)
          ? laneCursorTop(c.meta.cursor, tracks, laneHeight)
          : null;
        return (
          <div key={c.client_id}>
            {playhead != null &&
            c.client_id !== hidePlayheadForClientId &&
            !isObservingClient(c) ? (
              <div
                className="presence-playhead"
                style={
                  {
                    left: playhead * zoomPxPerSec,
                    height,
                    "--presence-color": color,
                  } as CSSProperties
                }
              >
                <span className="presence-playhead-chip">
                  <Avatar
                    name={name}
                    colorIndex={c.meta?.color_index}
                    sessionRole={c.role}
                    size="sm"
                  />
                </span>
              </div>
            ) : null}
            {isLaneCursor(c.meta?.cursor) && lane != null ? (
              <div
                className="presence-cursor"
                ref={(el) => {
                  if (el) {
                    cursorEls.current.set(c.client_id, el);
                  } else {
                    cursorEls.current.delete(c.client_id);
                  }
                }}
                style={
                  {
                    left: c.meta.cursor.t_sec * zoomPxPerSec,
                    top: lane,
                    "--presence-color": color,
                  } as CSSProperties
                }
              >
                <span className="presence-cursor-tag">{name}</span>
              </div>
            ) : null}
            {box ? (
              <div
                className="presence-selection"
                style={
                  {
                    left: box.left * zoomPxPerSec,
                    width: Math.max(box.minPx, box.width * zoomPxPerSec),
                    top: box.top,
                    height: laneHeight,
                    "--presence-color": color,
                  } as CSSProperties
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
