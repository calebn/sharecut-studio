import type { CombinedUtterance, TranscriptWordView } from "../types/project";
import {
  INSTANT_WORD_SEC,
  isUtteranceActive,
  isWordActive,
  utteranceTimelineSpans,
  wordsForUtterance,
} from "../utils/transcript";

type IndexedUtterance = {
  utterance: CombinedUtterance;
  words: readonly TranscriptWordView[];
  /** Time range any of its words can be active in (empty when none can). */
  wordLo: number;
  wordHi: number;
  rowIndex: number;
  start: number;
  maxEnd: number;
};

/** Per-utterance words and word-time bounds, built once per utterance list. */
export type TranscriptActiveIndex = readonly IndexedUtterance[];

/** Transcript highlight at one playhead time. */
export type TranscriptActive = {
  /** Indexes (into the utterance list) of the active utterances. */
  utterances: ReadonlySet<number>;
  /** Active words, as {@link activeWordId}. */
  words: ReadonlySet<string>;
  /** First active utterance, or -1 (as `findActiveUtteranceIndex`). */
  first: number;
};

/** Id of word `wordIndex` of utterance `utteranceIndex` in {@link TranscriptActive}. */
export function activeWordId(
  utteranceIndex: number,
  wordIndex: number,
): string {
  return `${utteranceIndex}.${wordIndex}`;
}

export function buildTranscriptActiveIndex(
  utterances: readonly CombinedUtterance[],
): TranscriptActiveIndex {
  const entries: IndexedUtterance[] = [];
  utterances.forEach((utterance, rowIndex) => {
    if (utterance.suppressed_only) {
      return;
    }
    const words = wordsForUtterance(utterance);
    let wordLo = Number.POSITIVE_INFINITY;
    let wordHi = Number.NEGATIVE_INFINITY;
    for (const w of words) {
      if (w.mappable === false || w.timeline_start == null) {
        continue;
      }
      const end = w.timeline_end ?? w.timeline_start;
      wordLo = Math.min(wordLo, w.timeline_start - INSTANT_WORD_SEC);
      wordHi = Math.max(wordHi, end, w.timeline_start + INSTANT_WORD_SEC);
    }
    let start = wordLo;
    let end = wordHi;
    for (const span of utteranceTimelineSpans(utterance)) {
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
    }
    if (start <= end) {
      entries.push({
        utterance,
        words,
        wordLo,
        wordHi,
        rowIndex,
        start,
        maxEnd: end,
      });
    }
  });
  entries.sort((a, b) => a.start - b.start);
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    maxEnd = Math.max(maxEnd, entry.maxEnd);
    entry.maxEnd = maxEnd;
  }
  return entries;
}

/**
 * The highlight at `sec` as one string: equal strings mean an equal
 * highlight, so a store selector returning it re-renders the panel only when
 * an utterance or word starts or stops being active, not on every tick.
 */
export function transcriptActiveKey(
  index: TranscriptActiveIndex,
  sec: number,
): string {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (index[mid]!.maxEnd < sec) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const first = lo;
  hi = index.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (index[mid]!.start <= sec) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const candidates = index
    .slice(first, lo)
    .sort((a, b) => a.rowIndex - b.rowIndex);
  const utterances: number[] = [];
  const words: string[] = [];
  for (const { utterance, words: uw, wordLo, wordHi, rowIndex } of candidates) {
    if (isUtteranceActive(utterance, sec)) {
      utterances.push(rowIndex);
    }
    if (sec < wordLo || sec > wordHi) {
      continue;
    }
    uw.forEach((w, wi) => {
      if (isWordActive(w, sec)) {
        words.push(activeWordId(rowIndex, wi));
      }
    });
  }
  return `${utterances.join(",")}|${words.join(",")}`;
}

export function parseTranscriptActiveKey(key: string): TranscriptActive {
  const [u = "", w = ""] = key.split("|");
  const utterances = u ? u.split(",").map(Number) : [];
  return {
    utterances: new Set(utterances),
    words: new Set(w ? w.split(",") : []),
    first: utterances.length > 0 ? utterances[0]! : -1,
  };
}
