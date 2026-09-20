import type {
  CombinedUtterance,
  TimelineSpan,
  TranscriptWordView,
} from "../types/project";

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
    return Math.abs(playheadSec - w.timeline_start) < 0.05;
  }
  return playheadSec >= w.timeline_start && playheadSec < end;
}

export function selectUnmappedUtterances(
  utterances: CombinedUtterance[],
): CombinedUtterance[] {
  return utterances.filter((u) => u.mappable === false);
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
