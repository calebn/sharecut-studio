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

/** The one place a wire kind is read. Missing, unknown or a prototype key gives "suggestion". */
export function decisionKindOf(kind: unknown): DecisionKind {
  return typeof kind === "string" && Object.hasOwn(KIND_OF, kind)
    ? KIND_OF[kind as PendingKind]
    : "suggestion";
}

const PREFIX = "edit:";

export const reviewIdOf = (editId: string) => `${PREFIX}${editId}`;

/** The only place the prefix is stripped. Callers never slice. */
export const editIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(PREFIX) ? reviewId.slice(PREFIX.length) : null;

const savedSecondsOf = (edit: PendingEditView) =>
  edit.suggested_action === "lower" || edit.suggested_action === "leave"
    ? 0
    : edit.timeline_spans.reduce((sum, s) => sum + (s.end - s.start), 0);

function entryOf(edit: PendingEditView): ReviewEntry {
  const at = edit.timeline_start ?? Number.POSITIVE_INFINITY;
  const savedSeconds = savedSecondsOf(edit);
  const title = edit.label ?? "Suggestion";
  const time = Number.isFinite(at) ? formatTimeShort(at) : "Unplaced";
  return {
    item: {
      id: reviewIdOf(edit.id),
      kind: decisionKindOf(edit.kind),
      at,
      savedSeconds,
      suggested: edit.suggested_action ?? undefined,
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

/** Listed iff !applied && review_required (same predicate as reviewPassOf). */
export const reviewEntriesOf = (
  pending: readonly PendingEditView[],
): ReviewEntry[] =>
  pending.filter((e) => !e.applied && e.review_required).map(entryOf);
