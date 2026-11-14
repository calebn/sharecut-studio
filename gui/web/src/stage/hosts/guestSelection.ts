import type { ScriptTurn } from "../../system/scriptPieces";
import type { ScriptWordRef } from "../edit/script/scriptModel";

type Time = { start: number; end: number } | null;

/** What the Script knows about its words, index for index. */
export type SelectionModel = {
  turns: readonly ScriptTurn[];
  refs: readonly ScriptWordRef[];
  times: readonly Time[];
  /** Null for a held word, whose time is not known yet. */
  wordStarts: readonly (number | null)[];
};

/**
 * One end of a selection: the line (its id is stable across a cut, a word's
 * `word_index` is not), the place among the line's drawn words, the word, and
 * the numbers and times the store was given for it.
 */
export type SelectionEnd = {
  index: number;
  line: string;
  at: number;
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
  for (const turn of model.turns) {
    const at = turn.words.findIndex((word) => word.index === index);
    if (at >= 0)
      return {
        index,
        line: turn.id,
        at,
        text: turn.words[at]!.text,
        ref: model.refs[index],
        time: model.times[index],
      };
  }
  return null;
}

export type SelectionFollow =
  | { kind: "keep" }
  /** A line of the selection is bars or held: its words are not known yet. */
  | { kind: "wait" }
  | { kind: "clear" }
  | { kind: "move"; anchor: number; head: number };

type Found =
  | { kind: "at"; index: number }
  | { kind: "wait" }
  | { kind: "gone" };

function findEnd(model: SelectionModel, end: SelectionEnd): Found {
  const turn = model.turns.find((t) => t.id === end.line);
  if (!turn) return { kind: "gone" };
  if (turn.words.length === 0) return { kind: "wait" };
  const word = turn.words[end.at];
  if (!word || word.text !== end.text) return { kind: "gone" };
  return model.wordStarts[word.index] === null
    ? { kind: "wait" }
    : { kind: "at", index: word.index };
}

const sameTime = (a: Time | undefined, b: Time | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.start - b.start) < 1e-6 &&
    Math.abs(a.end - b.end) < 1e-6);

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
 * other words, and it waits while a line is not live.
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
