/**
 * Ripple during a trim (#1135, #1154). A ripple trim closes or opens time on
 * every track `rippleTrackIds` names, so speakers stay in sync. A drag draws
 * that on every one of those lanes (arrows to where later clips go, the span
 * a lane loses), and a held strip nudge previews it in the project
 * (`trimDraft`). A gap trim moves nothing else.
 *
 * This mirrors `edits/ripple.py` (`ripple_track_ids`, `plan_trim`,
 * `apply_trim_geometry`); `contracts/ripple-scope.json` pins both sides. The
 * limits a peer's edge moves within come from `trimEdgeLimits`
 * (`contracts/trim-edge-limits.json`).
 */
import type { ClipRow, ProjectView, TrackView } from "../types/project";
import { TIME_EPS_SEC as EPS } from "../utils/timebase";
import type { EditMode, TrimEdge } from "./clipEdgePreview";
import { trimEdgeLimits } from "./trimLimits";

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

/** The operation a ripple applies to one lane. */
export type LaneRipple =
  | {
      kind: "edge";
      anchor: { clipId: string; edge: TrimEdge };
      deltaSec: number;
      cut: Span | null;
    }
  | { kind: "splice"; fromSec: number; deltaSec: number; cut: Span | null };

/** One downstream move a ripple preview draws: a clip, or the part of one, from `fromSec` to `toSec`. */
export interface RippleMove {
  key: string;
  fromSec: number;
  toSec: number;
}

/** `edits/ripple.py` `_EDGE_EPS_SEC`: an edge this close to the trimmed one moves with it. */
const EDGE_EPS_SEC = 1e-3;

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
 * as the trimmed one (`plan_trim`'s peer): it moves its own edge by `deltaSec`
 * instead of the lane splitting around it. Its limits are the ones the server
 * applies to it (`trimEdgeLimits`).
 */
function movingPeer(
  lane: readonly ClipRow[],
  edge: TrimEdge,
  instant: number,
  deltaSec: number,
): ClipRow | null {
  const i = lane.findIndex(
    (c) =>
      Math.abs((edge === "in" ? c.timeline_start : c.timeline_end) - instant) <=
      EDGE_EPS_SEC,
  );
  const peer = lane[i];
  if (!peer) return null;
  const target =
    edge === "in" ? peer.source_start - deltaSec : peer.source_end + deltaSec;
  const { lo, hi } = trimEdgeLimits(lane, i, edge, "ripple");
  return target >= lo - EPS && target <= hi + EPS ? peer : null;
}

/** What `trim` does to the lane of `track` (its clips `lane`), or null when it is outside `scope`. */
export function laneRipple(
  trim: RippleTrim,
  track: Pick<TrackView, "id">,
  lane: readonly ClipRow[],
  scope: readonly string[],
): LaneRipple | null {
  if (!scope.includes(track.id)) return null;
  const { deltaSec, edge } = trim;
  if (track.id === trim.trackId) {
    return {
      kind: "edge",
      anchor: { clipId: trim.clipId, edge },
      deltaSec,
      cut: null,
    };
  }
  const instant = edge === "in" ? trim.startSec : trim.endSec;
  const found = movingPeer(lane, edge, instant, deltaSec);
  const cut =
    deltaSec < 0
      ? edge === "out"
        ? { start: instant + deltaSec, end: instant }
        : { start: instant, end: instant - deltaSec }
      : null;
  if (found) {
    return {
      kind: "edge",
      anchor: { clipId: found.id, edge },
      deltaSec,
      cut,
    };
  }
  if (cut) return { kind: "splice", fromSec: cut.end, deltaSec, cut };
  return { kind: "splice", fromSec: instant, deltaSec, cut: null };
}

function followsEdge(anchor: ClipRow, other: ClipRow): boolean {
  return (
    other.timeline_start >= anchor.timeline_end - EPS ||
    (other.timeline_start > anchor.timeline_start + EPS &&
      other.timeline_end > anchor.timeline_end + EPS)
  );
}

/** The downstream moves `ripple` draws on `lane`: each later clip, and the tail of a clip it splits. */
export function rippleMoves(
  lane: readonly ClipRow[],
  ripple: LaneRipple | null,
): RippleMove[] {
  if (!ripple) return [];
  if (ripple.kind === "edge") {
    const anchor = lane.find((clip) => clip.id === ripple.anchor.clipId);
    if (!anchor) return [];
    return lane
      .filter((clip) => clip.id !== anchor.id && followsEdge(anchor, clip))
      .map((clip) => ({
        key: clip.id,
        fromSec: clip.timeline_start,
        toSec: clip.timeline_start + ripple.deltaSec,
      }));
  }
  const { fromSec, deltaSec } = ripple;
  const moves: RippleMove[] = [];
  for (const c of lane) {
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
  if (ripple.kind === "edge") {
    const anchor = lane.find((clip) => clip.id === ripple.anchor.clipId);
    if (!anchor) return [...lane];
    return lane
      .map((clip) => {
        if (clip.id === anchor.id) {
          return ripple.anchor.edge === "in"
            ? {
                ...clip,
                source_start: clip.source_start - ripple.deltaSec,
                timeline_end: clip.timeline_end + ripple.deltaSec,
              }
            : {
                ...clip,
                source_end: clip.source_end + ripple.deltaSec,
                timeline_end: clip.timeline_end + ripple.deltaSec,
              };
        }
        if (!followsEdge(anchor, clip)) return clip;
        return {
          ...clip,
          timeline_start: clip.timeline_start + ripple.deltaSec,
          timeline_end: clip.timeline_end + ripple.deltaSec,
        };
      })
      .sort((a, b) => a.timeline_start - b.timeline_start);
  }
  const { fromSec, deltaSec, cut } = ripple;
  const out: ClipRow[] = [];
  for (const c of lane) {
    const start = c.timeline_start;
    const end = c.timeline_end;
    if (start >= fromSec - EPS) {
      out.push({
        ...c,
        timeline_start: start + deltaSec,
        timeline_end: end + deltaSec,
      });
    } else if (cut && end > cut.start + EPS) {
      const head = start < cut.start - EPS;
      if (head) out.push(piece(c, c.id, start, cut.start));
      if (end > cut.end + EPS) {
        out.push(
          piece(c, head ? `${c.id}:tail` : c.id, cut.end, end, deltaSec),
        );
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
