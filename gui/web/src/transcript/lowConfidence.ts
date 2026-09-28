import type { TranscriptReviewCursor } from "../state/types";
import type { CombinedUtterance, TranscriptWordView } from "../types/project";
import { memoByRef } from "../utils/memoByRef";
import {
  isTranscriptUtteranceVisible,
  wordSeekSec,
  wordsForUtterance,
} from "../utils/transcript";

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
  /** Transcript-order ordinal among every indexed word of the full utterance list (listed or not), so it survives corrections and a Show cut away toggle. */
  order: number;
}

/**
 * Indexed low-confidence words among the utterances the transcript panel lists
 * (`isTranscriptUtteranceVisible`), in transcript order. Pass the full
 * `project.transcript.utterances`: `order` counts every indexed word, hidden
 * cut-away ones included.
 */
export function lowConfidenceStops(
  utterances: readonly CombinedUtterance[],
  annotate: boolean,
  showCutAway: boolean,
): LowConfidenceStop[] {
  const stops: LowConfidenceStop[] = [];
  let order = 0;
  for (const u of utterances) {
    const listed = isTranscriptUtteranceVisible(u, annotate, showCutAway);
    for (const w of wordsForUtterance(u)) {
      if (w.word_index == null) continue;
      const wordOrder = order++;
      if (!listed || !isLowConfidenceWord(w)) continue;
      stops.push({
        trackId: u.track_id,
        wordIndex: w.word_index,
        text: w.text,
        seekSec: wordSeekSec(w),
        order: wordOrder,
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
 * No cursor: first (next) / last (prev). A cursor whose word left the list (corrected) resumes
 * by transcript order: next = the first stop at or after its `order`, prev = the last stop
 * before it, wrapping.
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
  // The cursor's word left the list (corrected, possibly with others in one
  // batch): resume at the nearest stop after / before it in transcript order.
  if (direction === "next") {
    const after = stops.findIndex((s) => s.order >= cursor.order);
    return after >= 0 ? after : 0;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (stops[i].order < cursor.order) return i;
  }
  return n - 1;
}

// Visibility only matters as `annotate && showCutAway` (isTranscriptUtteranceVisible),
// so one cache per effective visibility, each keyed by the utterance array.
const listedStops = memoByRef((utterances: readonly CombinedUtterance[]) =>
  lowConfidenceStops(utterances, false, false),
);
const allStops = memoByRef((utterances: readonly CombinedUtterance[]) =>
  lowConfidenceStops(utterances, true, true),
);

/**
 * `lowConfidenceStops`, memoized per utterance array (`memoByRef`, a WeakMap)
 * and effective visibility, so the transcript toolbar and each Next/Previous
 * step share one O(words) scan per project change, and callers on different
 * arrays never evict each other.
 */
export function selectLowConfidenceStops(
  utterances: readonly CombinedUtterance[],
  annotate: boolean,
  showCutAway: boolean,
): LowConfidenceStop[] {
  return annotate && showCutAway
    ? allStops(utterances)
    : listedStops(utterances);
}
