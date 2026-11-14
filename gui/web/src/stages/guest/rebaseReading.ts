import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn } from "../../system/scriptPieces";

/**
 * A word position captured in an earlier set of turns, expressed in `turns`.
 * A word's key is not the identity: a cut removes words from the track's
 * transcript, so `word_index` (a word's position in what is left) is
 * renumbered. The line id (track, source, start) is stable, so the word is
 * looked for in its line: same key and text, else the same place in the line.
 * A line that is there but drawn as bars keeps the position as it was. A line
 * that is gone gives the first word of the next old line that survived;
 * if none did, the position is returned as it was (the pane then falls back to
 * its pixel offset).
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
