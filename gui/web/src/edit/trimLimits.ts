/**
 * Where a clip's trim edge may go: the one client mirror of
 * `edits/clips_ops.trim_edge_limits`. A held strip nudge, a handle drag and the
 * peer a ripple preview moves all clamp here, so none of them previews a place
 * the save would refuse. `contracts/trim-edge-limits.json` pins it to the server.
 */
import type { ClipRow } from "../types/project";
import {
  type EditMode,
  MIN_EDGE_SPAN_SEC,
  type TrimEdge,
} from "./clipEdgePreview";

/** `trim_edge_limits`' own tolerance when it looks for the next or previous clip in time. */
const EPS = 1e-9;

/** Source seconds a trim edge may move to. */
export interface TrimLimits {
  lo: number;
  hi: number;
}

/**
 * Two clips on one lane play the same recording when they name the same source
 * or their files are the same (`clips_ops._same_recording`): a trim edge stops
 * at a neighbour's source position only then.
 */
function sameRecording(a: ClipRow, b: ClipRow): boolean {
  return (
    a.source_id === b.source_id ||
    (a.recording_path != null && a.recording_path === b.recording_path)
  );
}

/**
 * The range `lane[index]`'s `edge` may move to (`lane` in timeline order).
 * Expansion stops at the neighbour's source when it is the same recording, and at
 * the clip's own recording's end when that is known. A gap trim moves only this
 * edge, so it also stops at the next clip in time (out) or the previous one (in).
 */
export function trimEdgeLimits(
  lane: readonly ClipRow[],
  index: number,
  edge: TrimEdge,
  mode: EditMode,
): TrimLimits {
  const clip = lane[index];
  if (!clip) throw new Error(`no clip at lane index ${index}`);
  const prev = lane[index - 1];
  const next = lane[index + 1];
  const others = lane.filter((_, i) => i !== index);
  if (edge === "out") {
    let hi = clip.source_duration_sec ?? clip.source_end;
    if (next && sameRecording(clip, next)) hi = Math.min(hi, next.source_start);
    if (mode === "gap") {
      const following = others
        .filter((c) => c.timeline_start >= clip.timeline_end - EPS)
        .map((c) => c.timeline_start);
      if (following.length > 0) {
        const room = Math.min(...following) - clip.timeline_end;
        hi = Math.min(hi, clip.source_end + Math.max(0, room));
      }
    }
    return { lo: clip.source_start + MIN_EDGE_SPAN_SEC, hi };
  }
  let lo = prev && sameRecording(clip, prev) ? Math.max(0, prev.source_end) : 0;
  if (mode === "gap") {
    const preceding = Math.max(
      0,
      ...others
        .filter((c) => c.timeline_end <= clip.timeline_start + EPS)
        .map((c) => c.timeline_end),
    );
    const room = clip.timeline_start - preceding;
    lo = Math.max(lo, clip.source_start - Math.max(0, room));
  }
  return { lo, hi: clip.source_end - MIN_EDGE_SPAN_SEC };
}

/** `value` moved inside `limits`, as `plan_trim` clamps the edge it is asked for. */
export function clampToTrimLimits(value: number, limits: TrimLimits): number {
  return Math.min(Math.max(value, limits.lo), limits.hi);
}

/**
 * What a handle drag clamps to: the `in` edge's lowest and the `out` edge's
 * highest source second of `lane[index]`. The span the clip keeps comes from
 * the clip itself (`clampTrimSourceSec`).
 */
export function trimNeighborBounds(
  lane: readonly ClipRow[],
  index: number,
  mode: EditMode,
): { neighborLo: number; neighborHi: number } {
  return {
    neighborLo: trimEdgeLimits(lane, index, "in", mode).lo,
    neighborHi: trimEdgeLimits(lane, index, "out", mode).hi,
  };
}
