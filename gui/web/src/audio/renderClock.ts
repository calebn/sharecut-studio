import { JOIN_GAP_TOLERANCE_SEC } from "../types/limits.generated";
import type { ClipRow } from "../types/project";

/**
 * Seconds each side of a blending join borrows from its recording (half the
 * overlap); `clips_ops.crossfade_borrow_sec`. 0 when the join does not blend or
 * a recording has no room beyond the seam.
 */
function borrowSec(left: ClipRow, right: ClipRow): number {
  if (
    right.join_in_mode !== "crossfade" ||
    right.join_left_clip_id !== left.id ||
    right.join_crossfade_blocked
  )
    return 0;
  const ms = right.join_crossfade_ms ?? 0;
  if (ms <= 0) return 0;
  const leftTotal = left.source_duration_sec;
  const rightTotal = right.source_duration_sec;
  if (leftTotal == null || rightTotal == null) return 0;
  const room = Math.min(
    ms / 2000,
    leftTotal - left.source_end,
    right.source_start,
    (left.source_end - left.source_start) * 0.25,
    (right.source_end - right.source_start) * 0.25,
  );
  return room >= 0.0005 ? room : 0;
}

/**
 * Place each lane's clips as render does. A blending crossfade centres on the
 * seam: the left clip plays on past its end and the right clip starts before
 * its start, each by `borrowOut` / `borrowIn` seconds of its recording, so the
 * join adds and removes no time. Only a gap inside the join tolerance closes up
 * and shifts the rest of the lane. `placed` clips start where their own audio
 * starts on the render clock; `overlapIn` / `overlapOut` are the blend lengths
 * (twice the borrow) that replace the edge fades.
 */
export function placeLikeRender(clips: readonly ClipRow[]): {
  readonly placed: readonly ClipRow[];
  readonly overlapIn: ReadonlyMap<string, number>;
  readonly overlapOut: ReadonlyMap<string, number>;
  readonly borrowIn: ReadonlyMap<string, number>;
  readonly borrowOut: ReadonlyMap<string, number>;
  /** Clock shift (seconds the lane runs earlier) once `clip` is placed. */
  readonly shiftAfter: ReadonlyMap<string, number>;
} {
  const overlapIn = new Map<string, number>();
  const overlapOut = new Map<string, number>();
  const borrowIn = new Map<string, number>();
  const borrowOut = new Map<string, number>();
  const placedStart = new Map<string, number>();
  const shiftAfter = new Map<string, number>();
  const byTrack = new Map<string, ClipRow[]>();
  for (const clip of clips) {
    const lane = byTrack.get(clip.track_id);
    if (lane) lane.push(clip);
    else byTrack.set(clip.track_id, [clip]);
  }
  // `timeline_render._place_clips`: a clip's start is its authored start less
  // the clock shift so far (snapped to the frontier inside the join
  // tolerance); a blending join starts it `2 * borrow` before the left body ends.
  for (const lane of byTrack.values()) {
    const ordered = [...lane].sort(
      (a, b) => a.timeline_start - b.timeline_start,
    );
    ordered.forEach((clip, index) => {
      const prev = ordered[index - 1];
      const h = prev ? borrowSec(prev, clip) : 0;
      if (prev && h > 0) {
        borrowIn.set(clip.id, h);
        borrowOut.set(prev.id, h);
        overlapIn.set(clip.id, 2 * h);
        overlapOut.set(prev.id, 2 * h);
      }
    });
    let prev: ClipRow | undefined;
    let componentEnd = Number.NaN;
    let frontier = 0;
    // Ends of the components left behind; only the last one still grows or shrinks.
    let settledEnd = 0;
    let authoredFrontier = 0;
    let clockShift = 0;
    for (const clip of ordered) {
      const hIn = borrowIn.get(clip.id) ?? 0;
      const hOut = borrowOut.get(clip.id) ?? 0;
      const body =
        Math.max(0, clip.timeline_end - clip.timeline_start) + hIn + hOut;
      let start: number;
      if (prev && hIn > 0) {
        start = componentEnd - 2 * hIn;
        componentEnd += body - 2 * hIn;
      } else {
        start = Math.max(0, clip.timeline_start - clockShift);
        if (Math.abs(start - frontier) <= JOIN_GAP_TOLERANCE_SEC)
          start = frontier;
        if (prev && Math.abs(start - componentEnd) < 1e-9) {
          componentEnd += body;
        } else {
          if (prev) settledEnd = Math.max(settledEnd, componentEnd);
          componentEnd = start + body;
        }
      }
      placedStart.set(clip.id, start + hIn);
      frontier = Math.max(settledEnd, componentEnd);
      authoredFrontier = Math.max(authoredFrontier, clip.timeline_end);
      clockShift = authoredFrontier - frontier;
      shiftAfter.set(clip.id, clockShift);
      // The left body ran on past its end until this clip blended in.
      if (prev && hIn > 0) shiftAfter.set(prev.id, clockShift);
      prev = clip;
    }
  }
  const placed = clips.map((clip) => {
    const start = placedStart.get(clip.id) ?? clip.timeline_start;
    return start === clip.timeline_start
      ? clip
      : {
          ...clip,
          timeline_start: start,
          timeline_end: start + (clip.timeline_end - clip.timeline_start),
        };
  });
  return {
    placed,
    overlapIn,
    overlapOut,
    borrowIn,
    borrowOut,
    shiftAfter,
  };
}

/** Float noise from `start + (end - start)` is not a shift. */
const IDENTITY_EPS_SEC = 1e-9;

interface LaneEntry {
  readonly id: string;
  readonly authoredStart: number;
  readonly authoredEnd: number;
  readonly placedStart: number;
  readonly placedEnd: number;
  readonly shiftAfter: number;
}

/**
 * The render's clock, per lane (#1888). A project keeps authored clip times;
 * `timeline_render._place_clips` plays each lane on a clock a blending
 * crossfade join pulls earlier by its overlap. A clip's offset is its placed
 * start less its authored start (0 or negative). The two clips of a blending
 * join overlap on the render clock, so a lane's authored-to-rendered map is
 * not one-to-one there: pass the clip you mean as `clipId`.
 */
export interface RenderClock {
  /** True when no lane is shifted, so every conversion is the identity. */
  readonly identity: boolean;
  /** Seconds the clip's start moves on the render clock (0 when unshifted). */
  offsetOf(clipId: string): number;
  /** Authored second to render-clock second on `trackId`, through `clipId` when given. */
  renderedAt(trackId: string, authoredSec: number, clipId?: string): number;
  /** Render-clock second back to authored; in a join's overlap the clip named by `clipId`, else the later one. */
  authoredAt(trackId: string, renderedSec: number, clipId?: string): number;
}

export function buildRenderClock(clips: readonly ClipRow[]): RenderClock {
  const { placed, shiftAfter } = placeLikeRender(clips);
  const lanes = new Map<string, LaneEntry[]>();
  const byId = new Map<string, LaneEntry>();
  let identity = true;
  clips.forEach((clip, index) => {
    const at = placed[index];
    if (!at) return;
    const entry: LaneEntry = {
      id: clip.id,
      authoredStart: clip.timeline_start,
      authoredEnd: clip.timeline_end,
      placedStart: at.timeline_start,
      placedEnd: at.timeline_end,
      shiftAfter: shiftAfter.get(clip.id) ?? 0,
    };
    if (
      Math.abs(entry.placedStart - entry.authoredStart) > IDENTITY_EPS_SEC ||
      Math.abs(entry.shiftAfter) > IDENTITY_EPS_SEC
    )
      identity = false;
    byId.set(clip.id, entry);
    const lane = lanes.get(clip.track_id);
    if (lane) lane.push(entry);
    else lanes.set(clip.track_id, [entry]);
  });
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.authoredStart - b.authoredStart);
  }
  const offset = (entry: LaneEntry) => entry.placedStart - entry.authoredStart;
  return {
    identity,
    offsetOf: (clipId) => {
      const entry = byId.get(clipId);
      return entry ? offset(entry) : 0;
    },
    renderedAt: (trackId, authoredSec, clipId) => {
      if (identity) return authoredSec;
      const hinted = clipId == null ? undefined : byId.get(clipId);
      if (hinted) return authoredSec + offset(hinted);
      const lane = lanes.get(trackId) ?? [];
      let started: LaneEntry | undefined;
      let containing: LaneEntry | undefined;
      for (const entry of lane) {
        if (entry.authoredStart > authoredSec) break;
        started = entry;
        if (authoredSec < entry.authoredEnd) containing = entry;
      }
      if (containing) return authoredSec + offset(containing);
      return started ? authoredSec - started.shiftAfter : authoredSec;
    },
    authoredAt: (trackId, renderedSec, clipId) => {
      if (identity) return renderedSec;
      const hinted = clipId == null ? undefined : byId.get(clipId);
      if (hinted) return renderedSec - offset(hinted);
      const lane = lanes.get(trackId) ?? [];
      let containing: LaneEntry | undefined;
      let ended: LaneEntry | undefined;
      for (const entry of lane) {
        if (renderedSec >= entry.placedStart && renderedSec < entry.placedEnd)
          containing = entry;
        if (entry.placedEnd <= renderedSec) ended = entry;
      }
      if (containing) return renderedSec - offset(containing);
      return ended ? renderedSec + ended.shiftAfter : renderedSec;
    },
  };
}
