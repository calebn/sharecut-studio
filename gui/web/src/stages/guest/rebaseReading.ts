import type { ScriptPaneReadingPosition } from "../../system/ScriptPane";
import type { ScriptTurn, ScriptWord } from "../../system/scriptPieces";

type Flat = {
  words: readonly ScriptWord[];
  byKey: ReadonlyMap<string, number>;
};

const flats = new WeakMap<readonly ScriptTurn[], Flat>();

function flatOf(turns: readonly ScriptTurn[]): Flat {
  const cached = flats.get(turns);
  if (cached) return cached;
  const words = turns.flatMap((turn) => turn.words);
  const byKey = new Map<string, number>();
  for (const word of words) {
    if (word.key !== undefined && !byKey.has(word.key))
      byKey.set(word.key, word.index);
  }
  const flat = { words, byKey };
  flats.set(turns, flat);
  return flat;
}

/**
 * The reading position of a word position captured in an earlier set of
 * turns, expressed in `turns`: the same word by key at the same pixel offset,
 * else the next word of the old order that survived, else the position as it
 * was (the pane then falls back to its pixel offset).
 */
export function rebaseReading(
  position: Extract<ScriptPaneReadingPosition, { kind: "word" }>,
  turns: readonly ScriptTurn[],
): ScriptPaneReadingPosition {
  const before = position.turns;
  if (!before || before === turns) return position;
  const old = flatOf(before);
  const now = flatOf(turns);
  const at = old.words.findIndex((word) => word.index === position.index);
  if (at < 0) return position;
  for (const word of old.words.slice(at)) {
    const index = word.key === undefined ? undefined : now.byKey.get(word.key);
    if (index !== undefined) return { ...position, index, turns };
  }
  return position;
}
