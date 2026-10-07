/**
 * Soft boundaries on the timeline (#1051 round 4): places an edit may stop
 * at but may also pass. A held nudge stops at the first one it would cross;
 * a single step crosses it. Hard limits (source bounds, fade length, point
 * order) are the targets' own clamps, not boundaries.
 *
 * Drags can reuse the same query for detents: `softBoundaries` says where
 * they are for whatever is moving, `firstBoundaryCrossed` which one a move
 * meets first.
 */
import type { ProjectView } from "../types/project";

export interface SoftBoundary {
  /** Timeline second. */
  sec: number;
  /** What it is, for the "Stopped at …" note: "the playhead", "a clip edge". */
  label: string;
}

/** What is moving, so it is not its own boundary (nor what rides with it). */
export type NudgeMover =
  /** A clip's fade or trim. A trim ripples the rest of its track along. */
  | { kind: "clip"; clipId: string; trackId: string; ripple: boolean }
  | { kind: "pending"; editId: string; trackId: string }
  | { kind: "envelope-point"; trackId: string; pointId: string }
  /**
   * A marker (a chapter or a social clip) at `sec`; it has no track, so no
   * clip or pending edges stop it.
   */
  | { kind: "marker"; sec: number };

/** Positions this close are the same place. */
const SAME_SEC = 1e-6;

/**
 * The soft boundaries for `mover`: the playhead, chapter markers, and the
 * clip and pending-edit edges on its own track, less its own edges and
 * anything that moves with it. A marker has no track: only the playhead and
 * the chapters (less itself) stop it.
 */
export function softBoundaries(
  project: ProjectView,
  mover: NudgeMover,
  playheadSec: number | null,
): SoftBoundary[] {
  const out: SoftBoundary[] = [];
  if (playheadSec != null && Number.isFinite(playheadSec)) {
    out.push({ sec: playheadSec, label: "the playhead" });
  }
  for (const chapter of project.chapters ?? []) {
    if (
      mover.kind === "marker" &&
      Math.abs(chapter.time - mover.sec) < SAME_SEC
    )
      continue;
    out.push({ sec: chapter.time, label: `chapter “${chapter.title}”` });
  }
  if (mover.kind === "marker") return out;
  const lane = project.clips.tracks[mover.trackId] ?? [];
  const self =
    mover.kind === "clip" ? lane.find((c) => c.id === mover.clipId) : null;
  // A ripple trim carries every later clip and pending edit on its track.
  const ridesAfter =
    mover.kind === "clip" && mover.ripple && self ? self.timeline_start : null;
  const rides = (sec: number) =>
    ridesAfter != null && sec >= ridesAfter - SAME_SEC;
  for (const clip of lane) {
    if (mover.kind === "clip" && clip.id === mover.clipId) continue;
    for (const sec of [clip.timeline_start, clip.timeline_end]) {
      if (!rides(sec)) out.push({ sec, label: "a clip edge" });
    }
  }
  for (const edit of project.pending_edits) {
    if (edit.track_id !== mover.trackId) continue;
    if (mover.kind === "pending" && edit.id === mover.editId) continue;
    for (const sec of [edit.timeline_start, edit.timeline_end]) {
      if (sec != null && !rides(sec)) {
        out.push({ sec, label: `the pending ${edit.type}` });
      }
    }
  }
  return out;
}

/**
 * The first boundary a move from `from` to `to` (timeline seconds) reaches
 * or crosses. One it starts on does not count, so a fresh move off a
 * boundary is free.
 */
export function firstBoundaryCrossed(
  from: number,
  to: number,
  boundaries: readonly SoftBoundary[],
): SoftBoundary | null {
  const dir = Math.sign(to - from);
  if (dir === 0) return null;
  let best: SoftBoundary | null = null;
  for (const b of boundaries) {
    const ahead = (b.sec - from) * dir;
    const reach = (to - from) * dir;
    if (ahead <= SAME_SEC || ahead > reach + SAME_SEC) continue;
    if (!best || ahead < (best.sec - from) * dir) best = b;
  }
  return best;
}
