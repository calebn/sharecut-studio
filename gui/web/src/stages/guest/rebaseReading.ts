import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";

/**
 * The reading position of a word position captured in an earlier set of
 * turns, expressed in `turns`. A word's key is not the identity here: a cut
 * renumbers a track's `word_index`, so the same word can wear a new key. A
 * line's id (track, source, start) is stable, so the reader's word is looked
 * for in that line: the word with the same key and text (a hydration that only
 * dropped a word), else the same place in the line. When the line is
 * gone, the first word of the next line of the old order that survived; when
 * none did, the position as it was (the pane then falls back to its pixel
 * offset).
 */
export function rebaseReading(
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
