import { presenceAnchor } from "../presence/anchors";
import type {
  CombinedUtterance,
  ProjectView,
  TimelineSpan,
  TranscriptWordView,
} from "../types/project";
import { memoByRef } from "./memoByRef";

/** First indexed word on a track among these utterances, in transcript order. */
export function findTranscriptWordIn(
  utterances: readonly CombinedUtterance[],
  trackId: string,
  wordIndex: number,
): TranscriptWordView | null {
  for (const utterance of utterances) {
    if (utterance.track_id !== trackId) {
      continue;
    }
    for (const word of utterance.words ?? []) {
      if (word.word_index === wordIndex) {
        return word;
      }
    }
  }
  return null;
}

/** First indexed word on a track, in transcript order. */
export function findTranscriptWord(
  project: ProjectView | null,
  trackId: string,
  wordIndex: number,
): TranscriptWordView | null {
  return findTranscriptWordIn(
    project?.transcript?.utterances ?? [],
    trackId,
    wordIndex,
  );
}

/** Indexed words on `trackId` with `lo <= word_index <= hi`, in transcript order (duplicates included). */
function* trackWordsInRange(
  project: ProjectView | null,
  trackId: string,
  lo: number,
  hi: number,
): Generator<{ index: number; word: TranscriptWordView }> {
  for (const utterance of project?.transcript?.utterances ?? []) {
    if (utterance.track_id !== trackId) {
      continue;
    }
    for (const word of utterance.words ?? []) {
      const index = word.word_index;
      if (index == null || index < lo || index > hi) {
        continue;
      }
      yield { index, word };
    }
  }
}

/** Inclusive indexed range on a track; uses mapped times when present. */
export function transcriptWordRange(
  project: ProjectView | null,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
): { start: number; end: number; text: string } | null;
export function transcriptWordRange(
  project: ProjectView | null,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  options: { boundsOnly: true },
): { start: number; end: number } | null;
export function transcriptWordRange(
  project: ProjectView | null,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  options?: { boundsOnly: true },
): { start: number; end: number; text?: string } | null {
  const lo = Math.min(startWordIndex, endWordIndex);
  const hi = Math.max(startWordIndex, endWordIndex);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const texts: string[] | null = options?.boundsOnly ? null : [];
  for (const { word } of trackWordsInRange(project, trackId, lo, hi)) {
    start = Math.min(start, word.timeline_start ?? word.start);
    end = Math.max(end, word.timeline_end ?? word.end);
    if (texts) {
      texts.push(word.text);
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return texts ? { start, end, text: texts.join(" ") } : { start, end };
}

/**
 * Space-joined text of an inclusive word-index range on a track, or null unless
 * every index in the range is in this snapshot (#650 stale-correction guard).
 * A word listed under two utterances (one straddling an utterance boundary)
 * normally counts once, since the mapper emits both listings from the same
 * per-track word view, so their text is identical. If two loaded listings for
 * the same index disagree on text, the span is unverifiable and this returns
 * null rather than guessing which listing is current.
 */
export function transcriptSpanText(
  project: ProjectView | null,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
): string | null {
  if (
    !Number.isInteger(startWordIndex) ||
    !Number.isInteger(endWordIndex) ||
    endWordIndex < startWordIndex
  ) {
    return null;
  }
  const byIndex = new Map<number, string>();
  for (const { index, word } of trackWordsInRange(
    project,
    trackId,
    startWordIndex,
    endWordIndex,
  )) {
    const seen = byIndex.get(index);
    if (seen === undefined) {
      byIndex.set(index, word.text);
    } else if (seen !== word.text) {
      return null;
    }
  }
  if (byIndex.size !== endWordIndex - startWordIndex + 1) {
    return null;
  }
  const texts: string[] = [];
  for (let i = startWordIndex; i <= endWordIndex; i += 1) {
    texts.push(byIndex.get(i) ?? "");
  }
  return texts.join(" ");
}

/** Timeline intervals for a mapped utterance; empty when cut away / unmapped. */
export function utteranceTimelineSpans(u: CombinedUtterance): TimelineSpan[] {
  if (u.mappable === false) {
    return [];
  }
  if (u.timeline_spans && u.timeline_spans.length > 0) {
    return u.timeline_spans;
  }
  if (u.timeline_start != null && u.timeline_end != null) {
    return [{ start: u.timeline_start, end: u.timeline_end }];
  }
  return [];
}

export function utteranceTimelineStart(u: CombinedUtterance): number | null {
  const spans = utteranceTimelineSpans(u);
  return spans.length > 0 ? spans[0].start : null;
}

export function utteranceTimelineEnd(u: CombinedUtterance): number | null {
  const spans = utteranceTimelineSpans(u);
  return spans.length > 0 ? spans[spans.length - 1].end : null;
}

/** True when playhead lies in any surviving timeline span (half-open). */
export function isUtteranceActive(
  u: CombinedUtterance,
  playheadSec: number,
): boolean {
  for (const span of utteranceTimelineSpans(u)) {
    if (playheadSec >= span.start && playheadSec < span.end) {
      return true;
    }
  }
  return false;
}

/** Seek target for a click, or null when the utterance is cut away. */
export function utteranceSeekSec(u: CombinedUtterance): number | null {
  return utteranceTimelineStart(u);
}

/** Timeline seek for a word, or null when cut away / unmapped. */
export function wordSeekSec(w: TranscriptWordView): number | null {
  if (w.mappable === false) {
    return null;
  }
  return w.timeline_start ?? null;
}

/** How far from its start a zero-length word still counts as active (s). */
export const INSTANT_WORD_SEC = 0.05;

/** True when playhead lies in this word's timeline span (half-open). */
export function isWordActive(
  w: TranscriptWordView,
  playheadSec: number,
): boolean {
  if (w.mappable === false || w.timeline_start == null) {
    return false;
  }
  const end = w.timeline_end ?? w.timeline_start;
  if (end <= w.timeline_start) {
    return Math.abs(playheadSec - w.timeline_start) < INSTANT_WORD_SEC;
  }
  return playheadSec >= w.timeline_start && playheadSec < end;
}

export function selectUnmappedUtterances(
  utterances: CombinedUtterance[],
): CombinedUtterance[] {
  return utterances.filter((u) => u.mappable === false);
}

/** Whether the transcript panel lists `u`: cut-away ones only under Annotate + Show cut away. */
export function isTranscriptUtteranceVisible(
  u: CombinedUtterance,
  annotate: boolean,
  showCutAway: boolean,
): boolean {
  return (annotate && showCutAway) || u.mappable !== false;
}

/** Utterances the transcript panel lists: cut-away ones only under Annotate + Show cut away. */
export function visibleTranscriptUtterances(
  utterances: CombinedUtterance[],
  annotate: boolean,
  showCutAway: boolean,
): CombinedUtterance[] {
  return annotate && showCutAway
    ? utterances
    : utterances.filter((u) =>
        isTranscriptUtteranceVisible(u, annotate, showCutAway),
      );
}

/** Display turn: consecutive same-speaker (same track) utterances. */
export interface TranscriptTurn {
  speaker: string;
  trackId: string;
  utterances: CombinedUtterance[];
  /** Flat list indices covered by this turn. */
  startIndex: number;
  endIndex: number;
}

/** First mapped seek time in a turn (block start), or null. */
export function turnSeekSec(turn: TranscriptTurn): number | null {
  for (const u of turn.utterances) {
    const seek = utteranceSeekSec(u);
    if (seek != null) {
      return seek;
    }
  }
  return null;
}

/**
 * Group consecutive same-speaker / same-track rows into turns for denser
 * transcript display. Does not rewrite on-disk combined.json.
 */
export function groupConsecutiveSpeakerTurns(
  utterances: CombinedUtterance[],
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === u.speaker && prev.trackId === u.track_id) {
      prev.utterances.push(u);
      prev.endIndex = i;
      continue;
    }
    turns.push({
      speaker: u.speaker,
      trackId: u.track_id,
      utterances: [u],
      startIndex: i,
      endIndex: i,
    });
  }
  return turns;
}

/** Words to render for an utterance; one synthetic token when timings are missing. */
export function wordsForUtterance(u: CombinedUtterance): TranscriptWordView[] {
  if (u.words && u.words.length > 0) {
    return u.words;
  }
  // Fallback when ProjectView lacks word timings: one synthetic token.
  return [
    {
      text: u.text,
      start: u.start,
      end: u.end,
      timeline_start: u.timeline_start,
      timeline_end: u.timeline_end,
      mappable: u.mappable,
    },
  ];
}

/**
 * Stable identity for a turn (React key + virtualizer measurement key).
 * Filter-independent: does not use the flat `startIndex`, which shifts when
 * utterances are unmapped or **Show cut away** toggles.
 */
export function turnKey(turn: TranscriptTurn): string {
  const lead = turn.utterances[0];
  if (!lead) {
    return `${turn.trackId}:empty`;
  }
  return `${turn.trackId}:${lead.start}:${lead.words?.[0]?.word_index ?? lead.end}`;
}

/** Turn containing flat utterance index `i` (binary search on start/end), or -1. */
export function findTurnIndexForUtterance(
  turns: TranscriptTurn[],
  i: number,
): number {
  if (i < 0) {
    return -1;
  }
  let lo = 0;
  let hi = turns.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const turn = turns[mid]!;
    if (i < turn.startIndex) {
      hi = mid - 1;
    } else if (i > turn.endIndex) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/** Presence anchor for a rendered transcript word (word id, else turn-local position). */
export function transcriptWordAnchor(
  turnIndex: number,
  trackId: string,
  wordIndex: number | undefined,
  flatWordIndex: number,
): string {
  return wordIndex != null
    ? presenceAnchor("transcript", "word", trackId, wordIndex)
    : presenceAnchor("transcript", "turn", turnIndex, "w", flatWordIndex);
}

const anchorTurnIndexOf = memoByRef(buildAnchorTurnIndex);

function buildAnchorTurnIndex(turns: TranscriptTurn[]): Map<string, number> {
  const index = new Map<string, number>();
  const add = (anchor: string, turnIndex: number) => {
    // Truncated (96-char) anchors can collide; first turn wins, like the DOM.
    if (!index.has(anchor)) {
      index.set(anchor, turnIndex);
    }
  };
  turns.forEach((turn, turnIndex) => {
    add(presenceAnchor("transcript", "turn", turnIndex), turnIndex);
    let flatWordIndex = 0;
    for (const u of turn.utterances) {
      for (const w of wordsForUtterance(u)) {
        add(
          transcriptWordAnchor(
            turnIndex,
            u.track_id,
            w.word_index,
            flatWordIndex,
          ),
          turnIndex,
        );
        flatWordIndex += 1;
      }
    }
  });
  return index;
}

/**
 * Turn that renders presence `anchor`, or -1. Matches whole anchor strings
 * built by the same helpers as the DOM (no parsing), cached per `turns` array.
 */
export function transcriptAnchorTurnIndex(
  turns: TranscriptTurn[],
  anchor: string,
): number {
  return anchorTurnIndexOf(turns).get(anchor) ?? -1;
}

/** Index of the utterance covering the playhead, or -1 if none. */
export function findActiveUtteranceIndex(
  utterances: CombinedUtterance[],
  playheadSec: number,
): number {
  for (let i = 0; i < utterances.length; i++) {
    if (isUtteranceActive(utterances[i], playheadSec)) {
      return i;
    }
  }
  return -1;
}

/**
 * Target scrollTop that places the child's vertical center at `anchorRatio` of
 * the viewport (0.5 = middle of the scrollable window).
 */
export function centeredScrollTop(
  rootClientHeight: number,
  rootScrollHeight: number,
  childOffsetTop: number,
  childOffsetHeight: number,
  anchorRatio = 0.5,
): number {
  const childCenter = childOffsetTop + childOffsetHeight / 2;
  const target =
    childCenter - rootClientHeight * Math.min(1, Math.max(0, anchorRatio));
  const maxScroll = Math.max(0, rootScrollHeight - rootClientHeight);
  return Math.min(maxScroll, Math.max(0, target));
}

/**
 * Keep `el` centered (by default) in `root`'s scrollport.
 * Always adjusts when off-center — not only when fully scrolled out of view.
 */
export function scrollChildIntoParent(
  root: HTMLElement,
  el: HTMLElement,
  anchorRatio = 0.5,
): void {
  const rootRect = root.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const childOffsetTop = elRect.top - rootRect.top + root.scrollTop;
  const next = centeredScrollTop(
    root.clientHeight,
    root.scrollHeight,
    childOffsetTop,
    elRect.height,
    anchorRatio,
  );
  if (Math.abs(next - root.scrollTop) < 1) {
    return;
  }
  root.scrollTop = next;
}
