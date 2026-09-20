/** Shared expand-ghost range helpers (timeline waveform + transcript words). */

export type GhostWord = {
  track_id: string;
  word_index: number;
  text: string;
  start: number;
  end: number;
};

export type SourceRange = { start: number; end: number };

/** Words whose source interval overlaps [range.start, range.end). */
export function wordsOverlappingSourceRange(
  words: readonly GhostWord[],
  range: SourceRange,
): GhostWord[] {
  if (range.end <= range.start + 1e-9) {
    return [];
  }
  return words.filter((w) => {
    const wEnd = w.end <= w.start ? w.start + 0.001 : w.end;
    return wEnd > range.start && w.start < range.end;
  });
}

/**
 * Source range newly covered when expanding a clip edge into cutaway
 * (same idea as timeline ghost waveform width).
 */
export function expandGhostSourceRange(opts: {
  kind: "roll" | "trim";
  /** Clamped preview delta (roll) or edge delta (trim out +, trim in −). */
  deltaSec: number;
  edge?: "in" | "out";
  leftSourceEnd: number;
  rightSourceStart: number;
}): SourceRange | null {
  const { kind, deltaSec, edge, leftSourceEnd, rightSourceStart } = opts;
  if (kind === "roll") {
    if (deltaSec > 1e-3) {
      // Join later: left grows into cutaway.
      return { start: leftSourceEnd, end: leftSourceEnd + deltaSec };
    }
    if (deltaSec < -1e-3) {
      // Join earlier: right grows into cutaway.
      return { start: rightSourceStart + deltaSec, end: rightSourceStart };
    }
    return null;
  }
  if (edge === "out" && deltaSec > 1e-3) {
    return { start: leftSourceEnd, end: leftSourceEnd + deltaSec };
  }
  if (edge === "in" && deltaSec < -1e-3) {
    return { start: rightSourceStart + deltaSec, end: rightSourceStart };
  }
  return null;
}

export function ghostWordsForExpandPreview(
  cutawayWords: readonly GhostWord[],
  range: SourceRange | null,
): GhostWord[] {
  if (!range) {
    return [];
  }
  return wordsOverlappingSourceRange(cutawayWords, range);
}

/** Side of the boundary glyph to render expand ghosts on. */
export function ghostPlacementForExpand(opts: {
  kind: "roll" | "trim";
  deltaSec: number;
  edge?: "in" | "out";
}): "before" | "after" | null {
  const { kind, deltaSec, edge } = opts;
  if (kind === "roll") {
    if (deltaSec > 1e-3) {
      return "before"; // appended to left
    }
    if (deltaSec < -1e-3) {
      return "after"; // prepended to right
    }
    return null;
  }
  if (edge === "out" && deltaSec > 1e-3) {
    return "before";
  }
  if (edge === "in" && deltaSec < -1e-3) {
    return "after";
  }
  return null;
}
