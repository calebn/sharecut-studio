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

const edges = (text: string): [string, string, string] => {
  const before = /^\p{P}*/u.exec(text)?.[0] ?? "";
  const after =
    before.length === text.length ? "" : (/\p{P}*$/u.exec(text)?.[0] ?? "");
  return [before, text.slice(before.length, text.length - after.length), after];
};

/** A muted word is skipped by the backend; a cut word is already cut. Neither can be found, and a phrase cannot run across one. */
const unfindable = (word: ScriptWord) =>
  word.mark?.kind === "muted" || word.mark?.kind === "cut";

/**
 * Where `query` occurs in the turns, as spans of word indices for the Script
 * pane's `matches`. It finds what the backend replaces: the query is split on
 * whitespace and each token is matched against a whole word, so "an" does not
 * match "banana" and "room." matches "room". A phrase can match across words
 * but never across turns, and hits do not overlap. Muted and cut words, shown
 * or not, are skipped, so Cut all never cuts a cut again. The cost is the words
 * of each turn (a query of k tokens costs at most k comparisons per word).
 *
 * Parity gap for W2, recorded in design-system.md: the backend matches over a
 * transcript's whole word list, so a phrase that ends one turn and starts the
 * next is replaced there but is neither highlighted nor counted here.
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

/**
 * The hits a Replace all would change. The backend drops a hit whose new words
 * are the words already there, so "Room" replaced by "room" with Match case on
 * is no change, and the host should count and replace only what this returns.
 * New words keep the old edge punctuation unless they bring their own, as the
 * backend does. A replacement the backend refuses (`replacementOk`) changes
 * nothing.
 */
export function replacementChanges(
  turns: readonly ScriptTurn[],
  hits: readonly ScriptSpan[],
  replacement: string,
): ScriptSpan[] {
  if (!replacementOk(replacement)) return [];
  const next = replacement.split(/\s+/).filter((token) => token !== "");
  const words = new Map<number, ScriptWord>();
  for (const turn of turns) {
    for (const word of turn.words) words.set(word.index, word);
  }
  return hits.filter((hit) => {
    const old = Array.from(
      { length: hit.end - hit.start + 1 },
      (_, at) => words.get(hit.start + at)?.text ?? "",
    );
    const parts = old.map(edges);
    const made =
      old.length === next.length
        ? next.map((token, at) => {
            const [before, , after] = edges(token);
            return (
              (before ? "" : parts[at][0]) + token + (after ? "" : parts[at][2])
            );
          })
        : next.map((token, at) => {
            const [before, , after] = edges(token);
            return (
              (at === 0 && !before ? parts[0][0] : "") +
              token +
              (at === next.length - 1 && !after
                ? parts[parts.length - 1][2]
                : "")
            );
          });
    return (
      made.length !== old.length || made.some((text, at) => text !== old[at])
    );
  });
}
