import type { DecisionKind } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import { selectLowConfidenceStops } from "../transcript/lowConfidence";
import type {
  CombinedUtterance,
  PendingEditView,
  PendingKind,
  SessionSuggestionView,
  TimelineComment,
  TrackView,
  TranscriptCheckStatus,
} from "../types/project";
import { formatTimeShort } from "../utils/time";
import { wordSeekSec, wordsForUtterance } from "../utils/transcript";
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

const decisionKindOf = (kind: unknown): DecisionKind =>
  typeof kind === "string" && Object.hasOwn(KIND_OF, kind)
    ? KIND_OF[kind as PendingKind]
    : "suggestion";

const PREFIX = "edit:";

export const reviewIdOf = (editId: string) => `${PREFIX}${editId}`;

export const editIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(PREFIX) ? reviewId.slice(PREFIX.length) : null;

const COMMENT_PREFIX = "comment:";

export const commentItemId = (commentId: string) =>
  `${COMMENT_PREFIX}${commentId}`;

export const commentIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(COMMENT_PREFIX)
    ? reviewId.slice(COMMENT_PREFIX.length)
    : null;

const SESSION_PREFIX = "session:";

export const sessionItemId = (suggestionId: string) =>
  `${SESSION_PREFIX}${suggestionId}`;

export const sessionIdOf = (reviewId: string): string | null =>
  reviewId.startsWith(SESSION_PREFIX)
    ? reviewId.slice(SESSION_PREFIX.length)
    : null;

/** The take Accept places for a replace: the picked one, else the server's default (the last). */
export const takeToPlace = (s: SessionSuggestionView): number | undefined =>
  s.kind !== "replace"
    ? undefined
    : (s.selected_take ?? s.take_indexes[s.take_indexes.length - 1]);

/** Where the session sits on the timeline: its insert point, or the start of its replace range. */
export const sessionStartSec = (s: SessionSuggestionView): number | null => {
  const at = s.kind === "insert" ? s.at_sec : s.from_sec;
  return at !== null && Number.isFinite(at) ? at : null;
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const joinNames = (names: readonly string[]) =>
  names.length < 3
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** One item per staged record session still waiting for a decision. Host payload only. */
export function sessionEntriesOf(
  suggestions: readonly SessionSuggestionView[],
  tracks: readonly Pick<TrackView, "id" | "label">[],
): ReviewEntry[] {
  return suggestions.map((s): ReviewEntry => {
    const start = sessionStartSec(s);
    const at = start ?? Number.POSITIVE_INFINITY;
    const end =
      s.kind === "replace" && s.to_sec !== null && Number.isFinite(s.to_sec)
        ? s.to_sec
        : null;
    const time = start === null ? "Unplaced" : formatTimeShort(start);
    const title =
      s.kind === "insert"
        ? `Insert Session ${s.session_number} at ${time}`
        : start !== null && end !== null
          ? `Replace ${time}–${formatTimeShort(end)} with Session ${s.session_number}`
          : `Replace with Session ${s.session_number}`;
    const names = s.track_ids.map(
      (id) => tracks.find((t) => t.id === id)?.label ?? id,
    );
    const take = takeToPlace(s);
    const at1 = take === undefined ? -1 : s.take_indexes.indexOf(take);
    const takeLine =
      s.kind === "replace" && s.take_count > 1 && at1 >= 0
        ? `Take ${at1 + 1} of ${s.take_count}`
        : plural(s.take_count, "take", "takes");
    const why = names.length ? `${takeLine} · ${joinNames(names)}` : takeLine;
    return {
      item: {
        id: sessionItemId(s.id),
        kind: "pickup",
        at,
        savedSeconds: 0,
        pickup: { kind: s.kind, number: s.session_number },
      },
      content: {
        row: { snippet: title, time, value: takeLine },
        card: {
          title,
          time,
          why,
          ...(start !== null ? { change: { start, end: end ?? start } } : {}),
        },
      },
    };
  });
}

/** "This also removes speech from Host and Guest." from a held replace's reply, or null when it was not held. */
export function pickupConfirmation(
  reply: Record<string, unknown>,
  tracks: readonly Pick<TrackView, "id" | "label">[],
): string | null {
  const ask = reply.needs_confirmation;
  if (typeof ask !== "object" || ask === null) return null;
  const speech = (ask as { speech?: { tracks?: unknown } }).speech;
  const rows = Array.isArray(speech?.tracks) ? speech.tracks : [];
  const names = rows.flatMap((row: unknown): string[] => {
    if (typeof row !== "object" || row === null) return [];
    const { track_id: id, speaker } = row as {
      track_id?: unknown;
      speaker?: unknown;
    };
    const name =
      typeof speaker === "string" && speaker
        ? speaker
        : tracks.find((t) => t.id === id)?.label;
    return name ? [name] : [];
  });
  return names.length
    ? `This also removes speech from ${joinNames([...new Set(names)])}.`
    : "This also removes speech from another track.";
}

export type WordTarget = {
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
  text: string;
  at: number | null;
  endSec: number | null;
};

export const wordIdOf = (track: string, source: string | null, index: number) =>
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

const needsReview = (e: PendingEditView) => !e.applied && e.review_required;

export const reviewEntriesOf = (
  pending: readonly PendingEditView[],
): ReviewEntry[] => pending.filter(needsReview).map(entryOf);

/** `guest` leaves out the cuts over an unsure word, which only the host decides. */
export const reviewCountOf = (
  pending: readonly PendingEditView[],
  guest = false,
): number =>
  pending.filter((e) => needsReview(e) && !(guest && e.unsure_words?.length))
    .length;

const firstLine = (body: string) => body.trim().split("\n", 1)[0] ?? "";

/**
 * One item per comment. A resolved one is already decided, so it sits in
 * Decided. `optimistic` holds the state a pending resolve or reopen is
 * moving a comment to, until the project shows it.
 */
export function commentEntriesOf(
  comments: readonly TimelineComment[],
  optimistic: ReadonlyMap<string, boolean> = new Map(),
): ReviewEntry[] {
  return comments.map((c): ReviewEntry => {
    const placed = Number.isFinite(c.timeline_start);
    const at = placed ? c.timeline_start : Number.POSITIVE_INFINITY;
    const time = placed ? formatTimeShort(at) : "Unplaced";
    const replies = c.replies.length;
    const resolved = optimistic.get(c.id) ?? c.resolved;
    return {
      item: {
        id: commentItemId(c.id),
        kind: "comment",
        at,
        savedSeconds: 0,
        ...(resolved ? { result: "applied" as const } : {}),
      },
      content: {
        row: {
          snippet: firstLine(c.body),
          time,
          author: { name: c.author },
          value:
            replies > 0
              ? `${replies} ${replies === 1 ? "reply" : "replies"}`
              : undefined,
        },
        card: {
          title: `Comment from ${c.author}`,
          time,
          comment: {
            author: { name: c.author },
            time,
            body: c.body,
            replies,
          },
        },
      },
    };
  });
}

function ownStart(
  utterances: readonly CombinedUtterance[],
  track: string,
  source: string | null,
  index: number,
): number | null {
  for (const u of utterances) {
    if (u.track_id !== track) continue;
    for (const w of wordsForUtterance(u))
      if (
        w.word_index === index &&
        (w.timing_target?.source_id ?? u.source_id ?? null) === source
      )
        return wordSeekSec(w);
  }
  return null;
}

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
        at:
          known?.at ??
          ownStart(utterances, w.track_id, w.source_id, w.word_index) ??
          (Number.isFinite(start) ? (start as number) : null),
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
