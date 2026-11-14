import type { ScriptTurn } from "../../system/scriptPieces";
import type { ScriptWordRef } from "../edit/script/scriptModel";
import type { TurnSpan } from "./guestScript";

type Time = { start: number; end: number } | null;

/** What the Script knows about its words, index for index. */
export type SelectionModel = {
  turns: readonly ScriptTurn[];
  spans: readonly TurnSpan[];
  refs: readonly ScriptWordRef[];
  times: readonly Time[];
  /** Null for a held word, whose time is not known yet. */
  wordStarts: readonly (number | null)[];
  words: readonly { start: number; text: string }[];
};

/**
 * One end of a selection. A word is the same word when its recording, its
 * place in that recording (its source-time start, which a cut does not move)
 * and its text are: its line and its `word_index` both change when a cut
 * splits a line or renumbers. A retime, a phrase correction that re-splits, or
 * the aligner changes the start, so such a word is not found and the selection
 * is cleared, not followed. `ref` and `time` are what the store was given for
 * it; `copies` is how many words matched it then, so a single match later
 * proves it only for a word that was alone.
 */
export type SelectionEnd = {
  index: number;
  trackId: string;
  sourceId: string | null;
  start: number;
  text: string;
  ref: ScriptWordRef | undefined;
  time: Time | undefined;
  copies: number;
};

export type RememberedSelection = {
  /** The selection the store held when this was written; anything else is someone else's. */
  stored: unknown;
  anchor: SelectionEnd;
  head: SelectionEnd;
};

export function selectionEndOf(
  model: SelectionModel,
  index: number,
): SelectionEnd | null {
  const ref = model.refs[index];
  const word = model.words[index];
  if (!ref || !word) return null;
  const end = {
    index,
    trackId: ref.trackId,
    sourceId: ref.sourceId,
    start: word.start,
    text: word.text,
    ref,
    time: model.times[index],
  };
  let copies = 0;
  for (let at = 0; at < model.words.length; at++)
    if (matches(model, end, at)) copies += 1;
  return { ...end, copies };
}

export type SelectionFollow =
  | { kind: "keep" }
  /** The word is held or inside a line drawn as bars: not known yet. */
  | { kind: "wait" }
  | { kind: "clear" }
  | { kind: "move"; anchor: number; head: number };

type Found =
  | { kind: "at"; index: number }
  | { kind: "wait" }
  | { kind: "gone" };

const SAME = 1e-6;

const sameTime = (a: Time | undefined, b: Time | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.start - b.start) < SAME &&
    Math.abs(a.end - b.end) < SAME);

function matches(
  model: SelectionModel,
  end: Omit<SelectionEnd, "copies">,
  index: number,
): boolean {
  const ref = model.refs[index];
  const word = model.words[index];
  return (
    ref?.trackId === end.trackId &&
    ref.sourceId === end.sourceId &&
    !!word &&
    word.text === end.text &&
    Number.isFinite(word.start) &&
    Number.isFinite(end.start) &&
    Math.abs(word.start - end.start) <= SAME
  );
}

/**
 * The one word this end names, or what to do instead. The same recording can
 * sit twice on the timeline, so the same track, source, start and text may
 * match more than once: then only the copy that still has the numbers and
 * times the store holds can be proven to be the one picked.
 */
function findEnd(model: SelectionModel, end: SelectionEnd): Found {
  const live: number[] = [];
  let held = false;
  for (let index = 0; index < model.words.length; index++) {
    if (!matches(model, end, index)) continue;
    if (model.wordStarts[index] === null) held = true;
    else live.push(index);
  }
  const barred =
    Number.isFinite(end.start) &&
    model.turns.some((turn, at) => {
      const span = model.spans[at];
      return (
        turn.words.length === 0 &&
        span?.trackId === end.trackId &&
        span.sourceId === end.sourceId &&
        span.start - SAME <= end.start &&
        end.start <= span.end + SAME
      );
    });
  // A copy may sit in a line not drawn yet: nothing can be counted.
  if (barred || held) return { kind: "wait" };
  if (live.length === 1 && end.copies === 1)
    return { kind: "at", index: live[0]! };
  const same = live.filter((index) => holds(model, end, index));
  return same.length === 1 ? { kind: "at", index: same[0]! } : { kind: "gone" };
}

/** The store holds numbers and times, not window positions: those decide. */
function holds(model: SelectionModel, end: SelectionEnd, index: number) {
  const ref = model.refs[index];
  return (
    ref?.trackId === end.ref?.trackId &&
    ref?.sourceId === end.ref?.sourceId &&
    ref?.wordIndex === end.ref?.wordIndex &&
    sameTime(model.times[index], end.time)
  );
}

/**
 * The selection against the Script as it is now. After an edit the same words
 * sit under new `word_index` numbers: the selection follows them once they
 * are live, or it is cleared when they are not there any more. It never names
 * other words, and it waits while the word is not live.
 */
export function followSelection(
  remembered: RememberedSelection,
  model: SelectionModel,
): SelectionFollow {
  const anchor = findEnd(model, remembered.anchor);
  const head = findEnd(model, remembered.head);
  if (anchor.kind === "gone" || head.kind === "gone") return { kind: "clear" };
  if (anchor.kind === "wait" || head.kind === "wait") return { kind: "wait" };
  return holds(model, remembered.anchor, anchor.index) &&
    holds(model, remembered.head, head.index)
    ? { kind: "keep" }
    : { kind: "move", anchor: anchor.index, head: head.index };
}
