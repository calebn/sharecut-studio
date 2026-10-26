import type { VerbId } from "../system/verbs";
import { KIND_META, REVIEW_KINDS, type ReviewKind } from "./reviewKinds";

export type ReviewResult = "applied" | "kept";

export type ReviewItem = {
  id: string;
  kind: ReviewKind;
  /** Seconds into the episode. */
  at: number;
  /** Seconds the item removes when applied. Zero for comments and checks. */
  savedSeconds: number;
  /** A suggestion whose range holds a word the transcript is unsure of. */
  unsure?: boolean;
  /** A suggestion the server will not apply yet. */
  blocked?: boolean;
  result?: ReviewResult;
};

export type BulkAction = {
  verb: VerbId;
  ids: readonly string[];
  count: number;
  savedSeconds: number;
};

export type ReviewGroup = {
  kind: ReviewKind;
  label: string;
  items: readonly ReviewItem[];
  undecided: number;
  /** Seconds the group's undecided items would remove. */
  savedSeconds: number;
  /** Null when the kind has no bulk verb or nothing in it may be bulk-applied. */
  bulk: BulkAction | null;
};

export type ReviewProgress = {
  decided: number;
  total: number;
  /** Seconds removed by applied items. */
  savedSeconds: number;
};

export const isDecided = (item: ReviewItem) => item.result !== undefined;

/** Unsure words and anything touching one are decided one at a time. */
export function bulkEligible(item: ReviewItem): boolean {
  return (
    KIND_META[item.kind].bulk &&
    item.kind !== "unsure-word" &&
    !item.unsure &&
    !item.blocked &&
    !isDecided(item)
  );
}

const byTime = (a: ReviewItem, b: ReviewItem) =>
  a.at - b.at || a.id.localeCompare(b.id);

/** Groups of undecided items in queue order: kind order, then time. */
export function groupQueue(items: readonly ReviewItem[]): ReviewGroup[] {
  return REVIEW_KINDS.flatMap((kind) => {
    const inKind = items
      .filter((item) => item.kind === kind && !isDecided(item))
      .sort(byTime);
    if (inKind.length === 0) return [];
    const eligible = inKind.filter(bulkEligible);
    const bulk: BulkAction | null =
      eligible.length === 0
        ? null
        : {
            verb: KIND_META[kind].verb,
            ids: eligible.map((item) => item.id),
            count: eligible.length,
            savedSeconds: sumSaved(eligible),
          };
    return [
      {
        kind,
        label: KIND_META[kind].plural,
        items: inKind,
        undecided: inKind.length,
        savedSeconds: sumSaved(inKind),
        bulk,
      },
    ];
  });
}

/** Decided items, newest decision last in the order the caller keeps them. */
export function decidedItems(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter(isDecided);
}

/** The undecided ids as the card walks them. */
export function queueOrder(items: readonly ReviewItem[]): string[] {
  return groupQueue(items).flatMap((group) => group.items.map((i) => i.id));
}

function sumSaved(items: readonly ReviewItem[]): number {
  return items.reduce((sum, item) => sum + item.savedSeconds, 0);
}

/** Seconds removed by applied items: the one number the stage shows. */
export function secondsSaved(items: readonly ReviewItem[]): number {
  return sumSaved(items.filter((item) => item.result === "applied"));
}

export function progressOf(items: readonly ReviewItem[]): ReviewProgress {
  return {
    decided: items.filter(isDecided).length,
    total: items.length,
    savedSeconds: secondsSaved(items),
  };
}

export function formatSeconds(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`;
}

/** "6 of 14 decided · saves 7.8 s" */
export function progressLine({
  decided,
  total,
  savedSeconds,
}: ReviewProgress): string {
  return `${decided} of ${total} decided · saves ${formatSeconds(savedSeconds)}`;
}

/** "Cut all 11" */
export function bulkLabel(
  group: ReviewGroup,
  verbLabel: string,
): string | null {
  return group.bulk ? `${verbLabel} all ${group.bulk.count}` : null;
}
