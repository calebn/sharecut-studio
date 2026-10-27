import type {
  ScriptSpan,
  ScriptTurn,
  ScriptWord,
} from "../../system/scriptPieces";

/**
 * A word as the backend compares it (`transcript_replace.py`): edge
 * punctuation stripped, then case folded unless the match is case sensitive.
 * Words are compared one by one, never as one joined string, so a fold that
 * changes a word's length cannot shift a hit onto its neighbour. `toUpperCase`
 * then `toLowerCase` approximates Python's `casefold` (ß is "ss", ς is "σ").
 */
function matchKey(text: string, caseSensitive: boolean): string {
  const bare = text.replace(/^\p{P}+/u, "").replace(/\p{P}+$/u, "");
  return caseSensitive ? bare : bare.toUpperCase().toLowerCase();
}

/** A muted word is skipped by the backend; a cut word is already cut. Neither can be found, and a phrase cannot run across one. */
const unfindable = (word: ScriptWord) =>
  word.mark?.kind === "muted" || word.mark?.kind === "cut";

/**
 * Where `query` occurs in the turns, as spans of word indices for the Script
 * pane's `matches`. It finds what the backend replaces: the query is split on
 * whitespace and each token is matched against a whole word, so "an" does not
 * match "banana" and "room." matches "room". A phrase can match across words
 * but never across turns, and hits do not overlap. Muted and cut words, shown
 * or not, are skipped, so Cut all never cuts a cut again. Linear in the words
 * of each turn.
 */
export function findMatches(
  turns: readonly ScriptTurn[],
  query: string,
  caseSensitive: boolean,
): ScriptSpan[] {
  const needle = query
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => matchKey(token, caseSensitive));
  if (needle.length === 0 || needle.some((token) => token === "")) return [];
  return turns.flatMap((turn) => {
    const { words } = turn;
    const keys = words.map((word) =>
      unfindable(word) ? null : matchKey(word.text, caseSensitive),
    );
    const spans: ScriptSpan[] = [];
    let at = 0;
    while (at + needle.length <= words.length) {
      if (needle.every((token, offset) => keys[at + offset] === token)) {
        spans.push({
          start: words[at].index,
          end: words[at + needle.length - 1].index,
        });
        at += needle.length;
      } else {
        at += 1;
      }
    }
    return spans;
  });
}

/**
 * The count the Find bar shows. Nothing for an empty query. When no hit is
 * current (-1) it says how many there are instead of "0 of N".
 */
export function findCountText(
  query: string,
  count: number,
  current: number,
): string {
  if (query.trim() === "") return "";
  if (count === 0) return "No matches";
  if (current < 0 || current >= count) {
    return `${count} ${count === 1 ? "match" : "matches"}`;
  }
  return `${current + 1} of ${count}`;
}

/** Whether the backend accepts this replacement: at least one token, each with a letter or a number. */
export function replacementOk(text: string): boolean {
  const tokens = text.split(/\s+/).filter((token) => token !== "");
  return (
    tokens.length > 0 && tokens.every((token) => /[\p{L}\p{N}]/u.test(token))
  );
}
