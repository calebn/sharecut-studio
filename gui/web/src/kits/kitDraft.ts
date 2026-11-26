import type { SegmentKind } from "../api";

/** The server's cap on entries in one kit (`MAX_KIT_ENTRIES`). */
export const MAX_ENTRIES = 32;

export type KitAt = "start" | "end";

/** One planned entry. `uid` is stable across reorders, so focus and keys follow the entry. */
export type DraftEntry = {
  uid: number;
  segmentId: string;
  at: KitAt;
};

export type KitDraft = {
  entries: readonly DraftEntry[];
  nextUid: number;
};

export type DraftAction =
  | { type: "add"; segmentId: string; kind: SegmentKind }
  | { type: "remove"; uid: number }
  | { type: "move"; uid: number; by: -1 | 1 }
  | { type: "setAt"; uid: number; at: KitAt }
  | { type: "reset" };

export const EMPTY_DRAFT: KitDraft = { entries: [], nextUid: 1 };

/**
 * An intro goes at the start and every other kind at the end. Start entries apply one
 * after another, each at the very start, so they end up in reverse order; that is why
 * only intros default to Start, and the sheet warns when a Start follows another Start.
 */
export function defaultAt(kind: SegmentKind): KitAt {
  return kind === "intro" ? "start" : "end";
}

export function draftReducer(draft: KitDraft, action: DraftAction): KitDraft {
  switch (action.type) {
    case "reset":
      return EMPTY_DRAFT;
    case "add":
      if (draft.entries.length >= MAX_ENTRIES) return draft;
      return {
        entries: [
          ...draft.entries,
          {
            uid: draft.nextUid,
            segmentId: action.segmentId,
            at: defaultAt(action.kind),
          },
        ],
        nextUid: draft.nextUid + 1,
      };
    case "remove":
      return {
        ...draft,
        entries: draft.entries.filter((entry) => entry.uid !== action.uid),
      };
    case "setAt":
      return {
        ...draft,
        entries: draft.entries.map((entry) =>
          entry.uid === action.uid ? { ...entry, at: action.at } : entry,
        ),
      };
    case "move": {
      const from = draft.entries.findIndex((entry) => entry.uid === action.uid);
      const to = from + action.by;
      if (from < 0 || to < 0 || to >= draft.entries.length) return draft;
      const next = [...draft.entries];
      [next[from], next[to]] = [next[to], next[from]];
      return { ...draft, entries: next };
    }
  }
}

/**
 * Start entries that come after another Start entry, each with the one before it. Every Start
 * entry goes to the very start when it applies, so a later one lands ahead of an earlier one.
 */
export function startsAfterStart(
  entries: readonly DraftEntry[],
): Map<number, number> {
  const late = new Map<number, number>();
  let previous: number | null = null;
  for (const entry of entries) {
    if (entry.at !== "start") continue;
    if (previous !== null) late.set(entry.uid, previous);
    previous = entry.uid;
  }
  return late;
}

/** How many entries use `segmentId`; a segment may appear twice. */
export function usesOf(
  entries: readonly DraftEntry[],
  segmentId: string,
): number {
  return entries.filter((entry) => entry.segmentId === segmentId).length;
}
