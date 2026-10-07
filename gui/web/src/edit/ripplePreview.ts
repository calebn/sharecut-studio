/**
 * Ripple during a trim (#1135, #1154). A ripple trim closes or opens time on
 * every track `rippleTrackIds` names, so speakers stay in sync. A drag draws
 * that on every one of those lanes (arrows to where later clips go, the span
 * a lane loses), and a held strip nudge previews it in the project
 * (`trimDraft`). A gap trim moves nothing else.
 *
 * This mirrors `edits/ripple.py` (`ripple_track_ids`, `plan_trim`,
 * `apply_trim_geometry`); `contracts/ripple-scope.json` pins both sides.
 */
import type { ClipRow, ProjectView, TrackView } from "../types/project";
import type { EditMode, TrimEdge } from "./clipEdgePreview";

export type Span = { start: number; end: number };

/** A ripple trim being previewed: the trimmed clip as saved and its change in length. */
export interface RippleTrim {
  clipId: string;
  /** The trimmed clip's lane. */
  trackId: string;
  edge: TrimEdge;
  /** The trimmed clip's saved timeline start and end (s). */
  startSec: number;
  endSec: number;
  /** Its change in length (s): negative closes time, positive opens it. */
  deltaSec: number;
}

/** What a ripple trim does to one lane. */
export interface LaneRipple {
  /** Clips from here on, and the part of a clip past it, move by `deltaSec`. */
  fromSec: number;
  deltaSec: number;
  /**
   * Another speaker's clip whose edge sits where the trimmed one did: it
   * lengthens by the same amount at that edge instead of riding along.
   */
  grows: { clipId: string; edge: TrimEdge } | null;
  /** The time this lane loses when the trim shortens a clip on another lane. */
  cut: Span | null;
}

/** One downstream move a ripple preview draws: a clip, or the part of one, from `fromSec` to `toSec`. */
export interface RippleMove {
  key: string;
  fromSec: number;
  toSec: number;
}

/** `edits/ripple.py` `_EDGE_EPS_SEC`: an edge this close to the trimmed one moves with it. */
const EDGE_EPS_SEC = 1e-3;
const EPS = 1e-9;
/** `edits/clips_ops.py` `_MIN_CLIP_SPAN_SEC`. */
const MIN_CLIP_SPAN_SEC = 0.05;

/** Tracks a ripple moves: every dialogue track, then any edited track that is not one. */
export function rippleTrackIds(
  tracks: readonly Pick<TrackView, "id" | "role">[],
  editedTrackIds: Iterable<string>,
): string[] {
  const scope = tracks.filter((t) => t.role === "dialogue").map((t) => t.id);
  for (const id of new Set(editedTrackIds)) {
    if (!scope.includes(id) && tracks.some((t) => t.id === id)) scope.push(id);
  }
  return scope;
}

/** The ripple of trimming `clip` to `trimmed`, or null when nothing else moves. */
export function rippleTrimOf(
  clip: ClipRow,
  trimmed: { edge: TrimEdge; sourceStart: number; sourceEnd: number },
  mode: EditMode,
): RippleTrim | null {
  const deltaSec =
    trimmed.sourceEnd -
    trimmed.sourceStart -
    (clip.source_end - clip.source_start);
  if (mode === "gap" || Math.abs(deltaSec) < EPS) return null;
  return {
    clipId: clip.id,
    trackId: clip.track_id,
    edge: trimmed.edge,
    startSec: clip.timeline_start,
    endSec: clip.timeline_end,
    deltaSec,
  };
}

/**
 * The clip on another lane whose `edge` sits at `instant` and can move as far
 * as the trimmed one (`plan_trim`'s peer). The media end is the track's, as
 * the trim handles clamp it.
 */
function growingPeer(
  lane: readonly ClipRow[],
  track: Pick<TrackView, "duration_sec">,
  edge: TrimEdge,
  instant: number,
  deltaSec: number,
): string | null {
  const i = lane.findIndex(
    (c) =>
      Math.abs((edge === "in" ? c.timeline_start : c.timeline_end) - instant) <=
      EDGE_EPS_SEC,
  );
  const peer = lane[i];
  if (!peer) return null;
  const sameSource = (other: ClipRow | undefined) =>
    other != null && other.source_id === peer.source_id;
  if (edge === "in") {
    const prev = lane[i - 1];
    const lo = sameSource(prev) ? Math.max(0, prev.source_end) : 0;
    return peer.source_start - deltaSec >= lo - EPS ? peer.id : null;
  }
  const next = lane[i + 1];
  let hi = track.duration_sec ?? peer.source_end;
  if (sameSource(next)) hi = Math.min(hi, next.source_start);
  const target = peer.source_end + deltaSec;
  return target >= peer.source_start + MIN_CLIP_SPAN_SEC - EPS &&
    target <= hi + EPS
    ? peer.id
    : null;
}

/** What `trim` does to the lane of `track` (its clips `lane`), or null when it is outside `scope`. */
export function laneRipple(
  trim: RippleTrim,
  track: Pick<TrackView, "id" | "duration_sec">,
  lane: readonly ClipRow[],
  scope: readonly string[],
): LaneRipple | null {
  if (!scope.includes(track.id)) return null;
  const { deltaSec, edge } = trim;
  if (track.id === trim.trackId) {
    return { fromSec: trim.endSec, deltaSec, grows: null, cut: null };
  }
  const instant = edge === "in" ? trim.startSec : trim.endSec;
  if (deltaSec < 0) {
    const cut =
      edge === "out"
        ? { start: instant + deltaSec, end: instant }
        : { start: instant, end: instant - deltaSec };
    return { fromSec: cut.end, deltaSec, grows: null, cut };
  }
  const peer = growingPeer(lane, track, edge, instant, deltaSec);
  return {
    fromSec: instant,
    deltaSec,
    grows: peer ? { clipId: peer, edge } : null,
    cut: null,
  };
}

/** The downstream moves `ripple` draws on `lane`: each later clip, and the tail of a clip it splits. */
export function rippleMoves(
  lane: readonly ClipRow[],
  ripple: LaneRipple | null,
): RippleMove[] {
  if (!ripple) return [];
  const { fromSec, deltaSec } = ripple;
  const moves: RippleMove[] = [];
  for (const c of lane) {
    if (c.id === ripple.grows?.clipId) continue;
    if (c.timeline_start >= fromSec - EPS) {
      moves.push({
        key: c.id,
        fromSec: c.timeline_start,
        toSec: c.timeline_start + deltaSec,
      });
    } else if (c.timeline_end > fromSec + EPS) {
      moves.push({
        key: `${c.id}:tail`,
        fromSec,
        toSec: fromSec + deltaSec,
      });
    }
  }
  return moves;
}

/** `clip`'s audio between timeline seconds `start` and `end`, moved by `shift`. */
function piece(
  clip: ClipRow,
  id: string,
  start: number,
  end: number,
  shift = 0,
): ClipRow {
  return {
    ...clip,
    id,
    source_start: clip.source_start + (start - clip.timeline_start),
    source_end: clip.source_start + (end - clip.timeline_start),
    timeline_start: start + shift,
    timeline_end: end + shift,
  };
}

/** `lane` as `ripple` leaves it (`remove_timeline_range_from_clips`, `ripple_insert_clips`). */
function rippledLane(lane: readonly ClipRow[], ripple: LaneRipple): ClipRow[] {
  const { fromSec, deltaSec, cut, grows } = ripple;
  const out: ClipRow[] = [];
  for (const c of lane) {
    const start = c.timeline_start;
    const end = c.timeline_end;
    if (c.id === grows?.clipId) {
      out.push(
        grows.edge === "in"
          ? {
              ...c,
              source_start: c.source_start - deltaSec,
              timeline_end: end + deltaSec,
            }
          : {
              ...c,
              source_end: c.source_end + deltaSec,
              timeline_end: end + deltaSec,
            },
      );
    } else if (start >= fromSec - EPS) {
      out.push({
        ...c,
        timeline_start: start + deltaSec,
        timeline_end: end + deltaSec,
      });
    } else if (cut && end > cut.start + EPS) {
      if (start < cut.start) out.push(piece(c, c.id, start, cut.start));
      if (end > cut.end + EPS) {
        const id = start < cut.start ? `${c.id}:tail` : c.id;
        out.push(piece(c, id, cut.end, end, deltaSec));
      }
    } else if (!cut && end > fromSec + EPS) {
      out.push(piece(c, c.id, start, fromSec));
      out.push(piece(c, `${c.id}:tail`, fromSec, end, deltaSec));
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * `project` with `clipId`'s `edge` trimmed to `sourceSec` in `mode`, as the
 * saved trim will leave it: a held strip nudge previews this.
 */
export function trimDraft(
  project: ProjectView,
  trackId: string,
  clipId: string,
  edge: TrimEdge,
  sourceSec: number,
  mode: EditMode,
): ProjectView {
  const clip = project.clips.tracks[trackId]?.find((c) => c.id === clipId);
  if (!clip) return project;
  const sourceStart = edge === "in" ? sourceSec : clip.source_start;
  const sourceEnd = edge === "out" ? sourceSec : clip.source_end;
  const timelineStart =
    mode === "gap" && edge === "in"
      ? clip.timeline_start + (sourceStart - clip.source_start)
      : clip.timeline_start;
  const trimmed: ClipRow = {
    ...clip,
    source_start: sourceStart,
    source_end: sourceEnd,
    timeline_start: timelineStart,
    timeline_end: timelineStart + (sourceEnd - sourceStart),
  };
  const tracks = { ...project.clips.tracks };
  const trim = rippleTrimOf(clip, { edge, sourceStart, sourceEnd }, mode);
  if (trim) {
    const scope = rippleTrackIds(project.tracks, [trackId]);
    for (const track of project.tracks) {
      const lane = tracks[track.id] ?? [];
      const ripple = laneRipple(trim, track, lane, scope);
      if (ripple) tracks[track.id] = rippledLane(lane, ripple);
    }
  }
  tracks[trackId] = (tracks[trackId] ?? []).map((c) =>
    c.id === clipId ? trimmed : c,
  );
  return { ...project, clips: { ...project.clips, tracks } };
}

/** "later −6.7 s": how far a ripple moves the later clips. */
export function rippleDetail(deltaSec: number): string {
  const sign = deltaSec < 0 ? "−" : "+";
  return `later ${sign}${Math.abs(deltaSec).toFixed(1)} s`;
}
