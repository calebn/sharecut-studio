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
  unsure?: boolean;
  /** The server will not apply it yet. */
  blocked?: boolean;
  suggested?: "cut" | "shorten" | "lower" | "leave";
  oneByOne?: boolean;
  /** The refine check: the only one that Cut anyway and the last unsure word resolve. */
  transcript?: boolean;
  result?: ReviewResult;
};

export type ReviewFilter = "all" | "suggestions" | "comments" | "checks";

type BulkAction = {
  verb: VerbId;
  ids: readonly string[];
  savedSeconds: number;
};

export type ReviewGroup = {
  kind: DecisionKind;
  label: string;
  items: readonly ReviewItem[];
  /** Null when the kind has no bulk verb or nothing in it may be bulk-applied. */
  bulk: BulkAction | null;
};

type QueueKind = {
  readonly group: string;
  readonly filter: Exclude<ReviewFilter, "all">;
  readonly gated: boolean;
  readonly bulk: boolean;
};

const held = (group: string, filter: QueueKind["filter"]): QueueKind => ({
  group,
  filter,
  gated: false,
  bulk: false,
});

const cut = (group: string, bulk = true): QueueKind => ({
  group,
  filter: "suggestions",
  gated: true,
  bulk,
});

const QUEUE_KIND: Readonly<Record<DecisionKind, QueueKind>> = {
  check: held("Checks", "checks"),
  "unsure-word": held("Unsure words", "checks"),
  comment: held("Comments", "comments"),
  filler: cut("Fillers"),
  pause: cut("Pauses"),
  repeat: cut("Repeats"),
  "false-start": cut("False starts"),
  sound: cut("Sounds"),
  suggestion: cut("Other suggestions", false),
};

export const KIND_ORDER = Object.keys(QUEUE_KIND) as DecisionKind[];

export const holdsGateKind = (item: ReviewItem) => QUEUE_KIND[item.kind].gated;

const isDecided = (item: ReviewItem) => item.result !== undefined;

/** Unsure words, blocked cuts, one-by-one and leave-alone items are decided one at a time. */
function bulkEligible(item: ReviewItem): boolean {
  return (
    QUEUE_KIND[item.kind].bulk &&
    !item.unsure &&
    !item.blocked &&
    !item.oneByOne &&
    item.suggested !== "leave" &&
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
        label: QUEUE_KIND[kind].group,
        items: inKind,
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
    : items.filter((item) => QUEUE_KIND[item.kind].filter === filter);
}

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
function secondsSaved(items: readonly ReviewItem[]): number {
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

/** The Undo toast text for one decision or a bulk. */
export function decisionMessage(
  items: readonly ReviewItem[],
  ids: readonly string[],
  result: ReviewResult,
): string {
  const picked = items.filter((item) => ids.includes(item.id));
  const first = picked[0];
  if (!first) return "Done";
  if (picked.length === 1) return resultText({ ...first, result });
  if (result === "kept") return `Kept ${picked.length}`;
  return `${verbOf(KIND_META[first.kind].verb).label} ${picked.length} · saves ${formatSeconds(sumSaved(picked))}`;
}
