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
 * place in that recording (source seconds, which no cut moves) and its text
 * are: its line and its `word_index` both change when a cut splits a line or
 * renumbers. `ref` and `time` are what the store was given for it.
 */
export type SelectionEnd = {
  index: number;
  trackId: string;
  sourceId: string | null;
  start: number;
  text: string;
  ref: ScriptWordRef | undefined;
  time: Time | undefined;
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
  return {
    index,
    trackId: ref.trackId,
    sourceId: ref.sourceId,
    start: word.start,
    text: word.text,
    ref,
    time: model.times[index],
  };
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

function findEnd(model: SelectionModel, end: SelectionEnd): Found {
  let held = false;
  for (let index = 0; index < model.words.length; index++) {
    const ref = model.refs[index];
    const word = model.words[index];
    if (
      ref?.trackId !== end.trackId ||
      ref.sourceId !== end.sourceId ||
      !word ||
      word.text !== end.text ||
      Math.abs(word.start - end.start) > SAME
    )
      continue;
    if (model.wordStarts[index] !== null) return { kind: "at", index };
    held = true;
  }
  if (held) return { kind: "wait" };
  const covered = model.turns.some((turn, at) => {
    const span = model.spans[at];
    return (
      turn.words.length === 0 &&
      span?.trackId === end.trackId &&
      span.sourceId === end.sourceId &&
      span.start - SAME <= end.start &&
      end.start <= span.end + SAME
    );
  });
  return covered ? { kind: "wait" } : { kind: "gone" };
}

const sameTime = (a: Time | undefined, b: Time | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.start - b.start) < SAME &&
    Math.abs(a.end - b.end) < SAME);

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
