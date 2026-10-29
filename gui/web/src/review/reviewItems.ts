import type { DecisionKind } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import { selectLowConfidenceStops } from "../transcript/lowConfidence";
import type {
  CombinedUtterance,
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

export type WordTarget = {
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
  text: string;
  at: number | null;
  endSec: number | null;
};

const wordIdOf = (track: string, source: string | null, index: number) =>
  `word:${track}:${source ?? ""}:${index}`;

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
  const words = edit.unsure_words ?? [];
  const first = words[0];
  return {
    item: {
      id: reviewIdOf(edit.id),
      kind: decisionKindOf(edit.kind),
      at,
      savedSeconds,
      suggested,
      oneByOne:
        edit.listen_one_by_one === true ||
        (!!edit.join_risk && edit.join_risk.verdict !== "pass"),
      ...(first ? { unsure: true } : {}),
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
        ...(first
          ? {
              unsure: {
                word: first.text,
                guess: first.text,
                id: wordIdOf(first.track_id, first.source_id, first.word_index),
                step: { index: 1, total: words.length },
              },
            }
          : {}),
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
    words > 0
      ? `${words} ${words === 1 ? "word" : "words"} the transcript is unsure of.`
      : undefined;
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

/** One item per unsure word, whether it sits inside an open cut or only in the transcript. */
export function unsureEntriesOf(
  pending: readonly PendingEditView[],
  utterances: readonly CombinedUtterance[],
): { entries: ReviewEntry[]; targets: ReadonlyMap<string, WordTarget> } {
  const found = new Map<string, WordTarget & { cut?: string }>();
  for (const stop of selectLowConfidenceStops(utterances, false, false)) {
    found.set(wordIdOf(stop.trackId, stop.sourceId ?? null, stop.wordIndex), {
      trackId: stop.trackId,
      sourceId: stop.sourceId ?? null,
      wordIndex: stop.wordIndex,
      text: stop.text,
      at: stop.seekSec,
      endSec: stop.endSec ?? null,
    });
  }
  for (const edit of pending) {
    if (edit.applied || !edit.review_required) continue;
    for (const w of edit.unsure_words ?? []) {
      const id = wordIdOf(w.track_id, w.source_id, w.word_index);
      const known = found.get(id);
      const start = edit.timeline_start;
      found.set(id, {
        trackId: w.track_id,
        sourceId: w.source_id,
        wordIndex: w.word_index,
        text: w.text,
        endSec: null,
        ...known,
        at: known?.at ?? (Number.isFinite(start) ? (start as number) : null),
        cut: known?.cut ?? edit.label ?? undefined,
      });
    }
  }
  const targets = new Map<string, WordTarget>();
  const entries = [...found].map(([id, { cut, ...target }]): ReviewEntry => {
    targets.set(id, target);
    const at = target.at ?? Number.POSITIVE_INFINITY;
    const time = target.at === null ? "Unplaced" : formatTimeShort(at);
    return {
      item: {
        id,
        kind: "unsure-word",
        at,
        savedSeconds: 0,
      },
      content: {
        row: { snippet: target.text, time },
        card: {
          title: `Is this “${target.text}”?`,
          time,
          ...(cut ? { why: `Inside “${cut}”` } : {}),
          unsure: { word: target.text, guess: target.text },
        },
      },
    };
  });
  return { entries, targets };
}
