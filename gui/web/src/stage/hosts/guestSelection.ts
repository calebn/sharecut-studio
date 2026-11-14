import type { ScriptTurn } from "../../system/scriptPieces";

/**
 * Where one end of a selection was: the line (its id is stable across a cut,
 * a word's `word_index` is not), the place among the line's drawn words, and
 * the word itself.
 */
export type SelectionEnd = {
  index: number;
  line: string;
  at: number;
  text: string;
};

export type RememberedSelection = {
  /** The selection the store held when this was written; anything else is someone else's. */
  stored: unknown;
  anchor: SelectionEnd;
  head: SelectionEnd;
};

export function selectionEndOf(
  turns: readonly ScriptTurn[],
  index: number,
): SelectionEnd | null {
  for (const turn of turns) {
    const at = turn.words.findIndex((word) => word.index === index);
    if (at >= 0)
      return { index, line: turn.id, at, text: turn.words[at]!.text };
  }
  return null;
}

export type SelectionFollow =
  | { kind: "keep" }
  /** A line of the selection is drawn as bars: its words are not known yet. */
  | { kind: "wait" }
  | { kind: "clear" }
  | { kind: "move"; anchor: number; head: number };

type Found =
  | { kind: "at"; index: number }
  | { kind: "bars" }
  | { kind: "gone" };

function findEnd(turns: readonly ScriptTurn[], end: SelectionEnd): Found {
  const turn = turns.find((t) => t.id === end.line);
  if (!turn) return { kind: "gone" };
  if (turn.words.length === 0) return { kind: "bars" };
  const word = turn.words[end.at];
  return word && word.text === end.text
    ? { kind: "at", index: word.index }
    : { kind: "gone" };
}

/**
 * The selection against the Script as it is now. After an edit the same words
 * sit under new `word_index` numbers: the selection follows them, or it is
 * cleared when they are not there any more. It never names other words.
 */
export function followSelection(
  remembered: RememberedSelection,
  turns: readonly ScriptTurn[],
): SelectionFollow {
  const anchor = findEnd(turns, remembered.anchor);
  const head = findEnd(turns, remembered.head);
  if (anchor.kind === "gone" || head.kind === "gone") return { kind: "clear" };
  if (anchor.kind === "bars" || head.kind === "bars") return { kind: "wait" };
  return anchor.index === remembered.anchor.index &&
    head.index === remembered.head.index
    ? { kind: "keep" }
    : { kind: "move", anchor: anchor.index, head: head.index };
}
