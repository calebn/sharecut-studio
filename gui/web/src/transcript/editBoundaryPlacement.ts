import type { EditBoundaryView } from "../types/project";

/** Flattened word clock used only for placing boundary glyphs. */
export type PlacementWord = {
  timelineStart: number;
  timelineEnd: number;
};

export type PlacementTurn = {
  trackId: string;
  words: PlacementWord[];
};

export type BoundaryPlacement = {
  boundary: EditBoundaryView;
  turnIndex: number;
  /** -1 = before the first word of the turn; otherwise after that word index. */
  afterWordIndex: number;
};

/**
 * Place every edit boundary once in the transcript flow.
 *
 * 1. Pick the last turn on that track whose start is ≤ join time (precedes or
 *    contains the join). If none, pin to the first turn on that track.
 * 2. Within the turn, put the glyph after the last word whose end is ≤ join
 *    (or before the first word when the join is earlier than all words).
 */
export function placeEditBoundaries(
  turns: readonly PlacementTurn[],
  boundaries: readonly EditBoundaryView[],
): BoundaryPlacement[] {
  const out: BoundaryPlacement[] = [];
  for (const boundary of boundaries) {
    let turnIndex = -1;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (turn.trackId !== boundary.track_id) {
        continue;
      }
      const turnStart =
        turn.words.length > 0
          ? Math.min(...turn.words.map((w) => w.timelineStart))
          : Number.NEGATIVE_INFINITY;
      if (turnStart <= boundary.timeline_join_sec + 1e-3) {
        turnIndex = i;
      }
    }
    if (turnIndex < 0) {
      turnIndex = turns.findIndex((t) => t.trackId === boundary.track_id);
    }
    if (turnIndex < 0) {
      continue;
    }

    const words = turns[turnIndex]?.words ?? [];
    let afterWordIndex = -1;
    for (let wi = 0; wi < words.length; wi++) {
      if (words[wi].timelineEnd <= boundary.timeline_join_sec + 0.05) {
        afterWordIndex = wi;
      }
    }
    out.push({ boundary, turnIndex, afterWordIndex });
  }

  out.sort(
    (a, b) =>
      a.turnIndex - b.turnIndex ||
      a.afterWordIndex - b.afterWordIndex ||
      a.boundary.timeline_join_sec - b.boundary.timeline_join_sec,
  );
  return out;
}

/** turnIndex → afterWordIndex → boundaries (stable for render). */
export function indexBoundaryPlacements(
  placements: readonly BoundaryPlacement[],
): Map<number, Map<number, EditBoundaryView[]>> {
  const byTurn = new Map<number, Map<number, EditBoundaryView[]>>();
  for (const p of placements) {
    let byWord = byTurn.get(p.turnIndex);
    if (!byWord) {
      byWord = new Map();
      byTurn.set(p.turnIndex, byWord);
    }
    const list = byWord.get(p.afterWordIndex) ?? [];
    list.push(p.boundary);
    byWord.set(p.afterWordIndex, list);
  }
  return byTurn;
}
