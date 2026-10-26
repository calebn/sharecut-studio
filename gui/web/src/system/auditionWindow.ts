import type { TimeRange } from "./seconds";

export type AuditionSide = "A" | "B";

/** Seconds of context either side of the change in an audition. */
const REVIEW_PAD_S = 3;

/**
 * What each side plays, on the original timeline. A is the original: one run
 * across the change. B is the edit: the lead-in, then the lead-out, with the
 * change left out.
 */
export function auditionSegments(
  side: AuditionSide,
  change: TimeRange,
): TimeRange[] {
  const from = Math.max(0, change.start - REVIEW_PAD_S);
  if (side === "A") return [{ start: from, end: change.end + REVIEW_PAD_S }];
  return [
    { start: from, end: change.start },
    { start: change.end, end: change.end + REVIEW_PAD_S },
  ].filter((segment) => segment.end > segment.start);
}
