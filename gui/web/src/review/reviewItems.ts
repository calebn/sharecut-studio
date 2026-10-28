import type { DecisionKind } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import type {
  PendingEditView,
  PendingKind,
  TranscriptCheckStatus,
} from "../types/project";
import { formatTimeShort } from "../utils/time";
import type { ReviewContent } from "./ReviewQueue";
import type { ReviewItem } from "./reviewQueueModel";

export type ReviewEntry = {
  readonly item: ReviewItem;
  readonly content: ReviewContent;
};

const KIND_OF: Readonly<Record<PendingKind, DecisionKind>> = {
  filler: "filler",
  pause: "pause",
  repeat: "repeat",
  "false-start": "false-start",
  sound: "sound",
  other: "suggestion",
};

export const decisionKindOf = (kind: unknown): DecisionKind =>
  typeof kind === "string" && Object.hasOwn(KIND_OF, kind)
    ? KIND_OF[kind as PendingKind]
    : "suggestion";

const PREFIX = "edit:";

export const reviewIdOf = (editId: string) => `${PREFIX}${editId}`;

export const editIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(PREFIX) ? reviewId.slice(PREFIX.length) : null;

const SUGGESTED = ["cut", "shorten", "lower", "leave"] as const;

function entryOf(edit: PendingEditView): ReviewEntry {
  const at = Number.isFinite(edit.timeline_start)
    ? (edit.timeline_start as number)
    : Number.POSITIVE_INFINITY;
  const action = edit.suggested_action;
  const suggested = !action
    ? undefined
    : (SUGGESTED.find((a) => a === action) ?? ("leave" as const));
  const savedSeconds =
    suggested === "lower" || suggested === "leave"
      ? 0
      : (edit.timeline_spans ?? []).reduce((sum, s) => {
          const length = s.end - s.start;
          return Number.isFinite(length) && length > 0 ? sum + length : sum;
        }, 0);
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
      card: {
        title,
        time,
        ...(Number.isFinite(edit.timeline_start) &&
        Number.isFinite(edit.timeline_end)
          ? {
              change: {
                start: edit.timeline_start as number,
                end: edit.timeline_end as number,
              },
            }
          : {}),
        ...(edit.why ? { why: edit.why } : {}),
      },
    },
  };
}

export const CHECK_ID = "check:transcript";

export function checkEntryOf(
  status: TranscriptCheckStatus,
): ReviewEntry | null {
  if (status.clear || status.status !== "pending") return null;
  const words = status.low_confidence_words;
  const detail =
    status.hint ??
    (words > 0
      ? `${words} ${words === 1 ? "word" : "words"} the transcript is unsure of.`
      : undefined);
  const title = "Check the transcript";
  return {
    item: {
      id: CHECK_ID,
      kind: "check",
      at: Number.NEGATIVE_INFINITY,
      savedSeconds: 0,
      transcript: true,
    },
    content: {
      row: { snippet: title, time: "" },
      check: { title, detail, actionLabel: "Review" },
      card: { title, time: "", why: detail },
    },
  };
}

export const reviewEntriesOf = (
  pending: readonly PendingEditView[],
): ReviewEntry[] =>
  pending.filter((e) => !e.applied && e.review_required).map(entryOf);
