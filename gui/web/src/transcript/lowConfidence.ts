import type { TranscriptReviewCursor } from "../state/types";
import type { CombinedUtterance, TranscriptWordView } from "../types/project";
import { memoByRef } from "../utils/memoByRef";
import {
  isMappedUtterance,
  wordSeekSec,
  wordsForUtterance,
} from "../utils/transcript";

/**
 * The server's flag (`analysis.unsure_word_confidence`, suppressed words excluded) drives the low-confidence underline, WORD inspector note, walkthrough stops and Review.
 * A suppressed word is never unsure here, even inside an utterance that also has unsure words, so no surface counts one the server status leaves out.
 */
export function isLowConfidenceWord(
  w: Pick<TranscriptWordView, "unsure" | "suppressed">,
): boolean {
  return w.unsure === true && w.suppressed !== true;
}

/**
 * The pipeline's `suspect_hallucination` flag (no matching speech under the word), a separate signal from low confidence:
 * it never joins the unsure count or the walkthrough. A suppressed or ignored word is already out of the text, so it is not marked.
 */
export function isSuspectHallucinationWord(
  w: Pick<
    TranscriptWordView,
    "suspect_hallucination" | "suppressed" | "ignored"
  >,
): boolean {
  return (
    w.suspect_hallucination === true &&
    w.suppressed !== true &&
    w.ignored !== true
  );
}

/** One stop of the low-confidence walkthrough (#634). */
export interface LowConfidenceStop {
  trackId: string;
  sourceId?: string | null;
  wordIndex: number;
  text: string;
  /** Timeline seek, when the word is placed. */
  seekSec: number | null;
  /** Timeline end of the word, when placed. */
  endSec?: number;
  /** Transcript-order ordinal among every indexed word of the full utterance list (listed or not), so it survives corrections. */
  order: number;
}

/**
 * Indexed low-confidence words among the mapped utterances, in transcript order.
 * Pass the full `project.transcript.utterances`: `order` counts every indexed
 * word, cut-away ones included.
 */
export function lowConfidenceStops(
  utterances: readonly CombinedUtterance[],
): LowConfidenceStop[] {
  const stops: LowConfidenceStop[] = [];
  let order = 0;
  for (const u of utterances) {
    // suppressed-only rows are not stops; their words still count toward `order`
    const listed = !u.suppressed_only && isMappedUtterance(u);
    for (const w of wordsForUtterance(u)) {
      if (w.word_index == null) continue;
      const wordOrder = order++;
      if (!listed || !isLowConfidenceWord(w) || w.mappable === false) continue;
      stops.push({
        trackId: u.track_id,
        ...((w.timing_target?.source_id ?? u.source_id) != null
          ? { sourceId: w.timing_target?.source_id ?? u.source_id }
          : {}),
        wordIndex: w.word_index,
        text: w.text,
        seekSec: wordSeekSec(w),
        ...(w.timeline_end != null ? { endSec: w.timeline_end } : {}),
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
    (s) =>
      s.trackId === cursor.trackId &&
      (s.sourceId ?? null) === (cursor.sourceId ?? null) &&
      s.wordIndex === cursor.wordIndex,
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

/**
 * `lowConfidenceStops`, memoized per utterance array (`memoByRef`, a WeakMap),
 * so the transcript toolbar and each Next/Previous step share one O(words)
 * scan per project change, and callers on different arrays never evict each other.
 */
export const selectLowConfidenceStops = memoByRef(lowConfidenceStops);
