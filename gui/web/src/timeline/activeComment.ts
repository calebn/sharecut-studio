import type { TimelineComment } from "../types/project";

const INSTANT_EPS = 0.35;

function commentCovers(c: TimelineComment, t: number): boolean {
  const start = c.timeline_start;
  const end =
    c.timeline_end != null && c.timeline_end > start
      ? c.timeline_end
      : start + INSTANT_EPS;
  return t >= start && t <= end;
}

/** The comment to show at `playheadSec`: the selected one, else the nearest start. */
export function activeCommentId(
  comments: readonly TimelineComment[],
  playheadSec: number,
  selectedCommentId: string | null,
): string | null {
  const hits = comments.filter((c) => commentCovers(c, playheadSec));
  if (hits.length === 0) {
    return null;
  }
  if (hits.some((c) => c.id === selectedCommentId)) {
    return selectedCommentId;
  }
  return hits.reduce((best, c) => {
    const bestDist = Math.abs(best.timeline_start - playheadSec);
    const dist = Math.abs(c.timeline_start - playheadSec);
    return dist < bestDist ? c : best;
  }).id;
}
