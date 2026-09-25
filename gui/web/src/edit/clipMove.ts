import { magnetSec, uniqueTicks } from "../timeline/snapOverlay";
import type { ClipRow, TrackView } from "../types/project";
import { EMPTY_ARR, EMPTY_OBJ, EMPTY_SET } from "../utils/empty";
import { originTrackId, sourceSecOnClipToTimeline } from "../utils/timebase";

export const MOVE_THRESHOLD_PX = 5;

export type ClipMoveItem = {
  clip_id: string;
  timeline_start: number;
  track_id: string;
};

export type ClipMovePointerInfo = {
  deltaSec: number;
  clientX: number;
  clientY: number;
  extraTicks: number[];
};

export type ClipSelectMods = {
  shift: boolean;
  mod: boolean;
};

export function allClipsFromTracks(
  tracks: Record<string, ClipRow[]>,
): ClipRow[] {
  const out: ClipRow[] = [];
  for (const list of Object.values(tracks)) {
    out.push(...list);
  }
  return out;
}

export function clipDurationSec(clip: ClipRow): number {
  return clip.timeline_end - clip.timeline_start;
}

/** Rigid group: dest lane is where the anchor lands; others shift by lane index. */
export function computeClipMoves(opts: {
  clips: ClipRow[];
  trackIds: string[];
  movingIds: string[];
  anchorId: string;
  destTrackId: string;
  deltaSec: number;
}): ClipMoveItem[] {
  const byId = new Map(opts.clips.map((c) => [c.id, c]));
  const anchor = byId.get(opts.anchorId);
  if (!anchor) {
    return [];
  }
  const fromIdx = opts.trackIds.indexOf(anchor.track_id);
  const destIdx = opts.trackIds.indexOf(opts.destTrackId);
  const laneDelta = fromIdx >= 0 && destIdx >= 0 ? destIdx - fromIdx : 0;
  const ids = opts.movingIds.includes(opts.anchorId)
    ? opts.movingIds
    : [opts.anchorId];
  const last = Math.max(0, opts.trackIds.length - 1);
  const moves: ClipMoveItem[] = [];
  for (const id of ids) {
    const clip = byId.get(id);
    if (!clip) {
      continue;
    }
    const srcIdx = opts.trackIds.indexOf(clip.track_id);
    const nextIdx =
      srcIdx < 0
        ? Math.max(0, destIdx)
        : Math.max(0, Math.min(last, srcIdx + laneDelta));
    const track_id = opts.trackIds[nextIdx] ?? clip.track_id;
    moves.push({
      clip_id: id,
      timeline_start: Math.max(0, clip.timeline_start + opts.deltaSec),
      track_id,
    });
  }
  return moves;
}

export function snapMoveDeltaSec(opts: {
  anchorStart: number;
  anchorEnd: number;
  deltaSec: number;
  ticks: number[];
  zoomPxPerSec: number;
}): number {
  const dur = Math.max(0, opts.anchorEnd - opts.anchorStart);
  const proposedStart = Math.max(0, opts.anchorStart + opts.deltaSec);
  const snappedStart = magnetSec(proposedStart, opts.ticks, opts.zoomPxPerSec);
  const proposedEnd = proposedStart + dur;
  const snappedEnd = magnetSec(proposedEnd, opts.ticks, opts.zoomPxPerSec);
  const startPulled = Math.abs(snappedStart - proposedStart) > 1e-12;
  const endPulled = Math.abs(snappedEnd - proposedEnd) > 1e-12;
  if (
    endPulled &&
    (!startPulled ||
      Math.abs(snappedEnd - proposedEnd) <
        Math.abs(snappedStart - proposedStart))
  ) {
    return Math.max(0, snappedEnd - dur) - opts.anchorStart;
  }
  if (startPulled) {
    return snappedStart - opts.anchorStart;
  }
  return proposedStart - opts.anchorStart;
}

export function moveSnapTicks(opts: {
  clips: ClipRow[];
  movingIds: ReadonlySet<string>;
  playheadSec: number;
  extraTicks?: number[];
}): number[] {
  const ticks = [opts.playheadSec];
  for (const clip of opts.clips) {
    if (opts.movingIds.has(clip.id)) {
      continue;
    }
    ticks.push(clip.timeline_start, clip.timeline_end);
  }
  if (opts.extraTicks) {
    ticks.push(...opts.extraTicks);
  }
  return uniqueTicks(ticks);
}

export function trackIdFromPoint(
  clientX: number,
  clientY: number,
): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  const row = el instanceof Element ? el.closest("[data-track-id]") : null;
  return row?.getAttribute("data-track-id") ?? null;
}

export function waveformTicksToTimeline(
  clip: ClipRow,
  sourceTicks: number[],
): number[] {
  return sourceTicks.map((t) => sourceSecOnClipToTimeline(clip, t));
}

export function movesDifferFromClips(
  clips: ClipRow[],
  moves: ClipMoveItem[],
): boolean {
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (const m of moves) {
    const clip = byId.get(m.clip_id);
    if (!clip) {
      return true;
    }
    if (clip.track_id !== m.track_id) {
      return true;
    }
    if (Math.abs(clip.timeline_start - m.timeline_start) >= 1e-4) {
      return true;
    }
  }
  return false;
}

export function patchClipsMove<
  T extends {
    clips: { tracks: Record<string, ClipRow[]>; clip_count: number };
    tracks: TrackView[];
    timeline_duration_sec: number;
  },
>(project: T, moves: ClipMoveItem[]): T {
  const byId = new Map(moves.map((m) => [m.clip_id, m]));
  const updated = allClipsFromTracks(project.clips.tracks).map((clip) => {
    const m = byId.get(clip.id);
    if (!m) {
      return clip;
    }
    const dur = clipDurationSec(clip);
    const originId =
      clip.origin_track_id ??
      (m.track_id !== clip.track_id ? clip.track_id : clip.origin_track_id);
    return {
      ...clip,
      track_id: m.track_id,
      timeline_start: m.timeline_start,
      timeline_end: m.timeline_start + dur,
      origin_track_id: originId ?? clip.origin_track_id,
    };
  });
  const tracks: Record<string, ClipRow[]> = {};
  for (const t of project.tracks) {
    tracks[t.id] = [];
  }
  for (const clip of updated) {
    (tracks[clip.track_id] ??= []).push(clip);
  }
  for (const list of Object.values(tracks)) {
    list.sort((a, b) => a.timeline_start - b.timeline_start);
  }
  let duration = 0;
  for (const clip of updated) {
    duration = Math.max(duration, clip.timeline_end);
  }
  return {
    ...project,
    clips: {
      ...project.clips,
      tracks,
      clip_count: updated.length,
    },
    timeline_duration_sec: duration,
  };
}

export type MoveGhost = {
  /** The moved clip on its destination lane; it keeps `origin_track_id`. */
  clip: ClipRow;
  originTrackId: string;
  trackIndex: number;
};

const IDLE_LANE_PREVIEW = Object.freeze({
  previewStartById: EMPTY_OBJ,
  hideIds: EMPTY_SET,
  ghosts: EMPTY_ARR,
});

export function laneMovePreview(opts: {
  trackId: string;
  laneClips: ClipRow[];
  allClips: ClipRow[];
  tracks: TrackView[];
  placements: ClipMoveItem[] | null;
}): {
  previewStartById: Readonly<Record<string, number>>;
  hideIds: ReadonlySet<string>;
  ghosts: readonly MoveGhost[];
} {
  if (!opts.placements?.length) {
    // Idle: shared empties, so memoized lanes see equal props.
    return IDLE_LANE_PREVIEW;
  }
  const previewStartById: Record<string, number> = {};
  const hideIds = new Set<string>();
  const ghosts: MoveGhost[] = [];
  const clipById = new Map(opts.allClips.map((c) => [c.id, c]));
  const trackIndex = new Map(opts.tracks.map((t, i) => [t.id, i]));
  for (const p of opts.placements) {
    const origin = clipById.get(p.clip_id);
    if (!origin) {
      continue;
    }
    if (origin.track_id === opts.trackId && p.track_id !== opts.trackId) {
      hideIds.add(origin.id);
    }
    if (origin.track_id === opts.trackId && p.track_id === opts.trackId) {
      previewStartById[origin.id] = p.timeline_start;
    }
    if (p.track_id === opts.trackId && origin.track_id !== opts.trackId) {
      const dur = clipDurationSec(origin);
      const originId = originTrackId(origin);
      ghosts.push({
        clip: {
          ...origin,
          track_id: p.track_id,
          timeline_start: p.timeline_start,
          timeline_end: p.timeline_start + dur,
          origin_track_id: originId,
        },
        originTrackId: originId,
        trackIndex: trackIndex.get(originId) ?? 0,
      });
    }
  }
  return { previewStartById, hideIds, ghosts };
}
