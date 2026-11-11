import type { SessionTakes } from "../api";
import type { DecisionKind } from "../system/decisionKinds";
import { formatSeconds } from "../system/seconds";
import type { TakeOption } from "../system/TakeSwitcher";
import { selectLowConfidenceStops } from "../transcript/lowConfidence";
import type {
  CombinedUtterance,
  PendingEditView,
  PendingKind,
  SessionSuggestionView,
  TimelineComment,
  TrackView,
  TranscriptCheckStatus,
  TranscriptWordView,
} from "../types/project";
import { formatTimeShort } from "../utils/time";
import { wordSeekSec, wordsForUtterance } from "../utils/transcript";
import type { ReviewContent, UnsureContext } from "./ReviewQueue";
import { unionSeconds } from "./rangeUnion";
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

/** A replace with more than one take has a take switcher; an insert plays its takes in order. */
export const hasTakeSwitcher = (s: SessionSuggestionView): boolean =>
  s.kind === "replace" && s.take_indexes.length > 1;

const wordsOf = (n: number) => plural(n, "word", "words");

/** The switcher's options: the position from the project, the detail from the takes route when it has arrived. */
function takeOptionsOf(
  s: SessionSuggestionView,
  detail: SessionTakes | undefined,
): TakeOption[] {
  return s.take_indexes.map((takeIndex): TakeOption => {
    const found = detail?.takes.find((t) => t.take_index === takeIndex);
    if (!found) return { takeIndex };
    return {
      takeIndex,
      length: formatSeconds(found.duration_s),
      ...(found.word_count === null
        ? {}
        : { words: wordsOf(found.word_count) }),
      ...(found.speech_text ? { snippet: found.speech_text } : {}),
      ...(found.refusal ? { refusal: found.refusal.message } : {}),
    };
  });
}

/**
 * One item per staged record session still waiting for a decision. Host payload only.
 * `details` holds each session's reply from the takes route, by suggestion id.
 */
export function sessionEntriesOf(
  suggestions: readonly SessionSuggestionView[],
  tracks: readonly Pick<TrackView, "id" | "label">[],
  details: ReadonlyMap<string, SessionTakes> = new Map(),
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
    const switcher = hasTakeSwitcher(s) && take !== undefined;
    // The switcher says "Take N of M", so the card's line then names the tracks only.
    const why = switcher
      ? names.length
        ? joinNames(names)
        : undefined
      : names.length
        ? `${takeLine} · ${joinNames(names)}`
        : takeLine;
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
        ...(switcher
          ? {
              takes: {
                takes: takeOptionsOf(s, details.get(s.id)),
                selected: take,
              },
            }
          : {}),
        card: {
          title,
          time,
          ...(why === undefined ? {} : { why }),
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
  editorIdentity?: string;
  readonly context?: UnsureContext;
};

export const wordIdOf = (track: string, source: string | null, index: number) =>
  `word:${track}:${source ?? ""}:${index}`;

function editorIdentityOf(row: CombinedUtterance, word: TranscriptWordView) {
  const recording = word.timing_target;
  return JSON.stringify([
    recording?.track_id ?? row.track_id,
    recording ? recording.source_id : (row.source_id ?? null),
    word.start,
    word.end,
    word.text,
  ]);
}

function contextsForTargets(
  utterances: readonly CombinedUtterance[],
  targets: ReadonlyMap<string, WordTarget>,
): ReadonlyMap<string, UnsureContext> {
  const locations = new Map<
    string,
    {
      utterance: CombinedUtterance;
      position: number;
      edgeSuppressed: ReadonlySet<number>;
    }[]
  >();

  for (const utterance of utterances) {
    const edgeSuppressed = new Set(utterance.edge_suppressed_word_indices);
    for (const [position, word] of (utterance.words ?? []).entries()) {
      if (word.word_index == null) continue;
      const id = wordIdOf(
        utterance.track_id,
        word.timing_target?.source_id ?? utterance.source_id ?? null,
        word.word_index,
      );
      if (!targets.has(id)) continue;
      const matches = locations.get(id) ?? [];
      matches.push({ utterance, position, edgeSuppressed });
      locations.set(id, matches);
    }
  }

  const contextAt = (
    target: WordTarget,
    utterance: CombinedUtterance,
    position: number,
    edgeSuppressed: ReadonlySet<number>,
  ) => {
    const words = utterance.words ?? [];
    const focus = words[position];
    if (
      utterance.mappable === false ||
      utterance.suppressed_only ||
      !focus ||
      focus.word_index !== target.wordIndex ||
      focus.text !== target.text ||
      focus.text.trim() === "" ||
      focus.mappable === false ||
      focus.suppressed === true ||
      edgeSuppressed.has(target.wordIndex)
    )
      return null;

    const collect = (direction: -1 | 1): string[] => {
      const result: string[] = [];
      let nextPosition = position + direction;
      let expectedIndex = target.wordIndex + direction;
      while (result.length < 4) {
        const word = words[nextPosition];
        if (
          !word ||
          word.word_index !== expectedIndex ||
          word.text.trim() === "" ||
          word.mappable === false ||
          word.suppressed === true ||
          edgeSuppressed.has(expectedIndex) ||
          (word.timing_target?.source_id ?? utterance.source_id ?? null) !==
            target.sourceId
        )
          break;
        if (direction < 0) result.unshift(word.text);
        else result.push(word.text);
        nextPosition += direction;
        expectedIndex += direction;
      }
      return result;
    };

    return {
      identity: editorIdentityOf(utterance, focus),
      context: {
        before: collect(-1),
        focus: focus.text,
        after: collect(1),
      },
    };
  };

  const contexts = new Map<string, UnsureContext>();
  for (const [id, target] of targets) {
    const matches = locations.get(id) ?? [];
    if (matches.length === 0) continue;
    const candidates = matches.flatMap(
      ({ utterance, position, edgeSuppressed }) => {
        const candidate = contextAt(
          target,
          utterance,
          position,
          edgeSuppressed,
        );
        return candidate ? [candidate] : [];
      },
    );
    if (candidates.length !== matches.length) continue;
    const signature = JSON.stringify(candidates[0]);
    if (
      candidates.every((candidate) => JSON.stringify(candidate) === signature)
    )
      contexts.set(id, candidates[0].context);
  }
  return contexts;
}

/** Why a cut needs a listen, from the server's flags; null for a clean cut. */
function riskOf(edit: PendingEditView): ReviewItem["risk"] | null {
  const verdict = edit.join_risk?.verdict;
  if (edit.harsh || verdict === "fail")
    return { rank: 3, reason: "Join may be audible" };
  if (verdict === "review") return { rank: 2, reason: "Join needs a listen" };
  if (edit.listen_one_by_one) return { rank: 1, reason: "Listen first" };
  return null;
}

const SUGGESTED = ["cut", "shorten", "lower", "leave"] as const;

function entryOf(
  edit: PendingEditView,
  tracks: readonly Pick<TrackView, "id" | "label">[],
  eligibleWords?: ReadonlyMap<string, WordTarget>,
): ReviewEntry {
  const at = Number.isFinite(edit.timeline_start)
    ? (edit.timeline_start as number)
    : Number.POSITIVE_INFINITY;
  const action = edit.suggested_action;
  const suggested = !action
    ? undefined
    : (SUGGESTED.find((a) => a === action) ?? ("leave" as const));
  // Mirrors the server's `edit_time_behavior`: a mute, a track-scope cut or an
  // exact-range cut leaves the timeline length alone, so it saves nothing.
  const inPlace =
    edit.type === "mute" || edit.scope === "track" || !!edit.exact_range;
  const spans =
    suggested === "lower" || suggested === "leave" || inPlace
      ? []
      : (edit.timeline_spans ?? [])
          .filter((s) => Number.isFinite(s.end - s.start) && s.end > s.start)
          .map((s) => [s.start, s.end] as const);
  const savedSeconds = unionSeconds(spans);
  const title = edit.label ?? "Suggestion";
  const time = Number.isFinite(at) ? formatTimeShort(at) : "Unplaced";
  const rawWords = edit.unsure_words ?? [];
  const words = rawWords.filter(
    (word) =>
      eligibleWords === undefined ||
      eligibleWords.has(
        wordIdOf(word.track_id, word.source_id, word.word_index),
      ),
  );
  const first = words[0];
  const firstId =
    first && wordIdOf(first.track_id, first.source_id, first.word_index);
  const target = firstId ? eligibleWords?.get(firstId) : undefined;
  const risk = riskOf(edit);
  const speaker = edit.track_id
    ? {
        id: edit.track_id,
        label:
          tracks.find((t) => t.id === edit.track_id)?.label ?? edit.track_id,
      }
    : null;
  return {
    item: {
      id: reviewIdOf(edit.id),
      kind: decisionKindOf(edit.kind),
      at,
      savedSeconds,
      ...(spans.length ? { spans } : {}),
      suggested,
      ...(risk ? { risk } : {}),
      ...(speaker ? { speaker } : {}),
      ...(rawWords.length ? { unsure: true } : {}),
      ...(eligibleWords !== undefined && rawWords.length > 0 && !first
        ? { blocked: true }
        : {}),
    },
    content: {
      row: {
        snippet: title,
        time,
        value:
          [risk?.reason, savedSeconds > 0 ? formatSeconds(savedSeconds) : null]
            .filter(Boolean)
            .join(" · ") || undefined,
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
                id: firstId,
                ...(target && {
                  editorIdentity: target.editorIdentity ?? target,
                }),
                step: { index: 1, total: words.length },
                ...(target?.context && target.context.focus === first.text
                  ? { context: target.context }
                  : {}),
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
  activeWordCount: number | null,
): ReviewEntry | null {
  if (status.clear || status.status !== "pending") return null;
  const words = activeWordCount;
  const detail =
    words !== null && words > 0
      ? `${words} unsure ${words === 1 ? "word" : "words"}`
      : undefined;
  const title = "Check the transcript before cutting";
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

export const needsReview = (e: PendingEditView) =>
  !e.applied && e.review_required;

export const reviewEntriesOf = (
  pending: readonly PendingEditView[],
  tracks: readonly Pick<TrackView, "id" | "label">[] = [],
  eligibleWords?: ReadonlyMap<string, WordTarget>,
): ReviewEntry[] =>
  pending
    .filter(needsReview)
    .map((edit) => entryOf(edit, tracks, eligibleWords));

const reviewableBy = (e: PendingEditView, guest: boolean) =>
  needsReview(e) && !(guest && e.unsure_words?.length);

/** `guest` leaves out the cuts over an unsure word, which only the host decides. */
export const reviewCountOf = (
  pending: readonly PendingEditView[],
  guest = false,
): number => pending.filter((e) => reviewableBy(e, guest)).length;

/** Where each cut waiting for this reader's review starts on the timeline; unmapped cuts have no time. */
export const suggestionTimesOf = (
  pending: readonly PendingEditView[],
  guest: boolean,
): number[] =>
  pending.flatMap((e) =>
    reviewableBy(e, guest) && e.timeline_start !== null
      ? [e.timeline_start]
      : [],
  );

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

/** One item per unsure word, whether it sits inside an open cut or only in the transcript. */
export function unsureEntriesOf(
  pending: readonly PendingEditView[],
  utterances: readonly CombinedUtterance[],
): { entries: ReviewEntry[]; targets: ReadonlyMap<string, WordTarget> } {
  const found = new Map<string, WordTarget & { cut?: string }>();
  const indexed = new Map<
    string,
    { row: CombinedUtterance; word: TranscriptWordView }
  >();
  for (const row of utterances) {
    for (const word of wordsForUtterance(row)) {
      if (word.word_index == null) continue;
      const id = wordIdOf(
        row.track_id,
        word.timing_target?.source_id ?? row.source_id ?? null,
        word.word_index,
      );
      if (!indexed.has(id)) indexed.set(id, { row, word });
    }
  }

  for (const stop of selectLowConfidenceStops(utterances)) {
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
      const own = indexed.get(id)?.word;
      if (own?.mappable === false) continue;
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
          (own ? wordSeekSec(own) : null) ??
          (Number.isFinite(start) ? (start as number) : null),
        cut: known?.cut ?? edit.label ?? undefined,
      });
    }
  }
  const contexts = contextsForTargets(utterances, found);
  const targets = new Map<string, WordTarget>();
  const entries = [...found].map(([id, { cut, ...placement }]): ReviewEntry => {
    const source = indexed.get(id);
    const context = contexts.get(id);
    const target = {
      ...placement,
      ...(source && {
        editorIdentity: editorIdentityOf(source.row, source.word),
      }),
      ...(context ? { context } : {}),
    };
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
          unsure: {
            word: target.text,
            guess: target.text,
            editorIdentity: target.editorIdentity ?? target,
            ...(context ? { context } : {}),
          },
        },
      },
    };
  });
  return { entries, targets };
}
