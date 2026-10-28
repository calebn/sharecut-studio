import type { DecisionKind } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import type { PendingEditView, PendingKind } from "../types/project";
import { formatTimeShort } from "../utils/time";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewItem } from "./reviewQueueModel";

export type ReviewEntry = {
  readonly item: ReviewItem;
  readonly content: ReviewContent;
};

const KIND_OF: Record<PendingKind, DecisionKind> = {
  filler: "filler",
  pause: "pause",
  repeat: "repeat",
  "false-start": "false-start",
  sound: "sound",
  other: "suggestion",
};

export function decisionKindOf(kind: unknown): DecisionKind {
  return typeof kind === "string" && Object.hasOwn(KIND_OF, kind)
    ? KIND_OF[kind as PendingKind]
    : "suggestion";
}

const PREFIX = "edit:";

export const reviewIdOf = (editId: string) => `${PREFIX}${editId}`;

export const editIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(PREFIX) ? reviewId.slice(PREFIX.length) : null;

const SUGGESTED = ["cut", "shorten", "lower", "leave"] as const;

const suggestedOf = (action: string | null | undefined) =>
  !action
    ? undefined
    : (SUGGESTED.find((a) => a === action) ?? ("leave" as const));

const spanSeconds = (s: { start: number; end: number }) => {
  const length = s.end - s.start;
  return Number.isFinite(length) && length > 0 ? length : 0;
};

const savedSecondsOf = (edit: PendingEditView, suggested?: string) =>
  suggested === "lower" || suggested === "leave"
    ? 0
    : (edit.timeline_spans ?? []).reduce((sum, s) => sum + spanSeconds(s), 0);

function entryOf(edit: PendingEditView): ReviewEntry {
  const at = Number.isFinite(edit.timeline_start)
    ? (edit.timeline_start as number)
    : Number.POSITIVE_INFINITY;
  const suggested = suggestedOf(edit.suggested_action);
  const savedSeconds = savedSecondsOf(edit, suggested);
  const title = edit.label ?? "Suggestion";
  const time = Number.isFinite(at) ? formatTimeShort(at) : "Unplaced";
  return {
    item: {
      id: reviewIdOf(edit.id),
      kind: decisionKindOf(edit.kind),
      at,
      savedSeconds,
      suggested,
      oneByOne: edit.listen_one_by_one === true || edit.harsh,
    },
    content: {
      row: {
        snippet: title,
        time,
        value: savedSeconds > 0 ? formatSeconds(savedSeconds) : undefined,
      },
      card: { title, time },
    },
  };
}

export const reviewEntriesOf = (
  pending: readonly PendingEditView[],
): ReviewEntry[] =>
  pending.filter((e) => !e.applied && e.review_required).map(entryOf);
