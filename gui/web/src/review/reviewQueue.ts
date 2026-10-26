import type { DecisionKind } from "../system/decisionKinds";
import { KIND_META } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import { verbOf } from "../system/verbDisplay";
import type { VerbId } from "../system/verbs";

export type ReviewResult = "applied" | "kept";

export type ReviewItem = {
  id: string;
  kind: DecisionKind;
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

export type ReviewFilter = "all" | "suggestions" | "comments" | "checks";

export type BulkAction = {
  verb: VerbId;
  ids: readonly string[];
  savedSeconds: number;
};

export type ReviewGroup = {
  kind: DecisionKind;
  label: string;
  items: readonly ReviewItem[];
  /** Seconds the group's items would remove. */
  savedSeconds: number;
  /** Null when the kind has no bulk verb or nothing in it may be bulk-applied. */
  bulk: BulkAction | null;
};

/** Checks first, then comments, then the suggestion kinds. */
const KIND_ORDER: readonly DecisionKind[] = [
  "check",
  "unsure-word",
  "comment",
  "filler",
  "pause",
  "sound",
];

const GROUP_LABEL: Record<DecisionKind, string> = {
  check: "Checks",
  "unsure-word": "Unsure words",
  comment: "Comments",
  filler: "Fillers",
  pause: "Pauses",
  sound: "Sounds",
};

const BULK_KINDS: readonly DecisionKind[] = ["filler", "pause", "sound"];

const FILTER_OF: Record<DecisionKind, Exclude<ReviewFilter, "all">> = {
  check: "checks",
  "unsure-word": "checks",
  comment: "comments",
  filler: "suggestions",
  pause: "suggestions",
  sound: "suggestions",
};

const isDecided = (item: ReviewItem) => item.result !== undefined;

/** Unsure words, and cuts that touch one, are decided one at a time. */
export function bulkEligible(item: ReviewItem): boolean {
  return (
    BULK_KINDS.includes(item.kind) &&
    !item.unsure &&
    !item.blocked &&
    !isDecided(item)
  );
}

const byTime = (a: ReviewItem, b: ReviewItem) =>
  a.at - b.at || a.id.localeCompare(b.id);

const sumSaved = (items: readonly ReviewItem[]) =>
  items.reduce((sum, item) => sum + item.savedSeconds, 0);

/** Groups of undecided items in queue order: kind order, then time. */
export function groupQueue(items: readonly ReviewItem[]): ReviewGroup[] {
  return KIND_ORDER.flatMap((kind) => {
    const inKind = items
      .filter((item) => item.kind === kind && !isDecided(item))
      .sort(byTime);
    if (inKind.length === 0) return [];
    const eligible = inKind.filter(bulkEligible);
    return [
      {
        kind,
        label: GROUP_LABEL[kind],
        items: inKind,
        savedSeconds: sumSaved(inKind),
        bulk:
          eligible.length === 0
            ? null
            : {
                verb: KIND_META[kind].verb,
                ids: eligible.map((item) => item.id),
                savedSeconds: sumSaved(eligible),
              },
      },
    ];
  });
}

export function decidedItems(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter(isDecided).sort(byTime);
}

/** Every id in queue order, decided ones included, so a decided item keeps its place. */
export function fullOrder(items: readonly ReviewItem[]): ReviewItem[] {
  return [...items].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byTime(a, b),
  );
}

export function filterItems(
  items: readonly ReviewItem[],
  filter: ReviewFilter,
): ReviewItem[] {
  return filter === "all"
    ? [...items]
    : items.filter((item) => FILTER_OF[item.kind] === filter);
}

/** Undecided items per filter. */
export function filterCounts(
  items: readonly ReviewItem[],
): Record<ReviewFilter, number> {
  const open = items.filter((item) => !isDecided(item));
  return {
    all: open.length,
    suggestions: filterItems(open, "suggestions").length,
    comments: filterItems(open, "comments").length,
    checks: filterItems(open, "checks").length,
  };
}

/** Only applied items count: kept and undecided ones save nothing. */
export function secondsSaved(items: readonly ReviewItem[]): number {
  return sumSaved(items.filter((item) => item.result === "applied"));
}

/** "6 of 14 decided · saves 7.8 s" */
export function progressLine(items: readonly ReviewItem[]): string {
  const decided = items.filter(isDecided).length;
  return `${decided} of ${items.length} decided · saves ${formatSeconds(secondsSaved(items))}`;
}

/** "Cut 0.8 s", "Looks right", "Kept". */
export function resultText(item: ReviewItem): string {
  if (item.result === "kept") return "Kept";
  const meta = KIND_META[item.kind];
  const word = meta.verbLabel ?? verbOf(meta.verb).label;
  return item.savedSeconds > 0
    ? `${word} ${formatSeconds(item.savedSeconds)}`
    : word;
}
