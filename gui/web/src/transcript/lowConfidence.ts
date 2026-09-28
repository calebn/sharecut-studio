import type { TranscriptReviewCursor } from "../state/types";
import type { CombinedUtterance, TranscriptWordView } from "../types/project";
import { wordSeekSec, wordsForUtterance } from "../utils/transcript";

/** ASR confidence below which a word is flagged for review (Annotate underline, WORD inspector note, walkthrough stops); same default as MCP `low_confidence_words_tool`. */
export const LOW_CONFIDENCE = 0.7;

export function isLowConfidenceWord(
  w: Pick<TranscriptWordView, "confidence">,
): boolean {
  return w.confidence != null && w.confidence < LOW_CONFIDENCE;
}

/** One stop of the low-confidence walkthrough (#634). */
export interface LowConfidenceStop {
  trackId: string;
  wordIndex: number;
  text: string;
  /** Timeline seek; null for a cut-away word (scroll only). */
  seekSec: number | null;
}

/** Indexed low-confidence words among `utterances`, in transcript order. */
export function lowConfidenceStops(
  utterances: readonly CombinedUtterance[],
): LowConfidenceStop[] {
  const stops: LowConfidenceStop[] = [];
  for (const u of utterances) {
    for (const w of wordsForUtterance(u)) {
      if (w.word_index == null || !isLowConfidenceWord(w)) continue;
      stops.push({
        trackId: u.track_id,
        wordIndex: w.word_index,
        text: w.text,
        seekSec: wordSeekSec(w),
      });
    }
  }
  return stops;
}

export type ReviewDirection = "next" | "prev";

/** Index of the cursor's word among `stops`, or -1. */
export function reviewCursorIndex(
  stops: readonly LowConfidenceStop[],
  cursor: TranscriptReviewCursor | null,
): number {
  if (!cursor) return -1;
  return stops.findIndex(
    (s) => s.trackId === cursor.trackId && s.wordIndex === cursor.wordIndex,
  );
}

/**
 * Index of the stop one step from `cursor`, wrapping at both ends; -1 when there are no stops.
 * No cursor: first (next) / last (prev). A cursor whose word left the list (corrected) steps
 * from its stored position: next = the stop now in that slot, prev = the one before it.
 */
export function stepLowConfidence(
  stops: readonly LowConfidenceStop[],
  cursor: TranscriptReviewCursor | null,
  direction: ReviewDirection,
): number {
  const n = stops.length;
  if (n === 0) return -1;
  if (!cursor) return direction === "next" ? 0 : n - 1;
  const at = reviewCursorIndex(stops, cursor);
  if (at >= 0) return (at + (direction === "next" ? 1 : n - 1)) % n;
  const slot = Math.min(Math.max(cursor.position, 0), n);
  return direction === "next" ? slot % n : (slot - 1 + n) % n;
}
