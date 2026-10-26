import type { SuggestionRange } from "./silenceSnap";

export type AuditionSide = "A" | "B";

/** Review plays 3 s before the change through 3 s after. */
export const REVIEW_PAD_S = 3;

export type AuditionSegment = SuggestionRange;

/**
 * What each side plays, on the original timeline. A is the original: one run
 * across the change. B is the edit: the lead-in, then the lead-out, with the
 * change left out.
 */
export function auditionSegments(
  side: AuditionSide,
  change: SuggestionRange,
  pad: number = REVIEW_PAD_S,
): AuditionSegment[] {
  const from = Math.max(0, change.start - pad);
  if (side === "A") return [{ start: from, end: change.end + pad }];
  return [
    { start: from, end: change.start },
    { start: change.end, end: change.end + pad },
  ];
}
