import {
  findSelectionEnd,
  type SelectionEnd,
  selectionEndOf,
} from "../../edit/selectionFollow";
import type { GuestScriptModel } from "../../stage/hosts/guestScript";
import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";

export type GuestBookmark = {
  position: ScriptPaneReadingPosition;
  end: SelectionEnd | null;
  alternates?: readonly { end: SelectionEnd; offset: number }[];
};

export function captureReading(
  position: ScriptPaneReadingPosition,
  model: GuestScriptModel,
): GuestBookmark {
  const end =
    position.kind === "word" &&
    position.turns === model.turns &&
    model.wordStarts[position.index] != null
      ? selectionEndOf(model, position.index)
      : null;
  const alternates =
    end && position.kind === "word"
      ? position.visibleAlternates?.flatMap(({ index, offset }) => {
          const alternate = selectionEndOf(model, index);
          return alternate ? [{ end: alternate, offset }] : [];
        })
      : undefined;
  return { position, end, alternates };
}

export function rebaseReading(
  { position, end, alternates }: GuestBookmark,
  model: GuestScriptModel,
) {
  if (position.kind === "scroll" || position.turns === model.turns)
    return position;
  if (end) {
    const found = findSelectionEnd(model, end);
    if (found.kind === "wait") {
      for (const alternate of alternates ?? []) {
        const visible = findSelectionEnd(model, alternate.end, "layout");
        if (visible.kind === "at" && visible.unique)
          return {
            ...position,
            index: visible.index,
            offset: alternate.offset,
            turns: model.turns,
          };
      }
      return found;
    }
    if (found.kind === "at" && found.unique)
      return { ...position, index: found.index, turns: model.turns };
  }
  return replacementPosition(position, model.turns);
}

function replacementPosition(
  position: Extract<ScriptPaneReadingPosition, { kind: "word" }>,
  turns: readonly ScriptTurn[],
): ScriptPaneReadingPosition {
  const before = position.turns;
  if (!before || before === turns) return position;
  const from = before.findIndex((turn) =>
    turn.words.some((word) => word.index === position.index),
  );
  if (from < 0) return position;
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const word = before[from]!.words.find((w) => w.index === position.index)!;
  const ordinal = before[from]!.words.indexOf(word);
  for (let at = from; at < before.length; at++) {
    const turn = byId.get(before[at]!.id);
    // The reader's own line is still there but not drawn with words yet: stay.
    if (at === from && turn && turn.words.length === 0) return position;
    if (!turn || turn.words.length === 0) continue;
    const found =
      at === from
        ? (turn.words.find((w) => w.key === word.key && w.text === word.text) ??
          turn.words[Math.min(ordinal, turn.words.length - 1)]!)
        : turn.words[0]!;
    return { ...position, index: found.index, turns };
  }
  return position;
}
