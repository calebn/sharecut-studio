import type { ScriptSpan, ScriptTurn } from "../../system/scriptPieces";

/**
 * Where `query` occurs in the turns' text, as spans of word indices for the
 * Script pane's `matches`. A turn reads as its words joined by single spaces,
 * so a phrase can match across words but never across turns. A hit covers every
 * word it touches. Hits do not overlap each other; a word that holds two hits
 * is covered by two equal spans only once.
 */
export function findMatches(
  turns: readonly ScriptTurn[],
  query: string,
  caseSensitive: boolean,
): ScriptSpan[] {
  const needle = (caseSensitive ? query : query.toLowerCase()).trim();
  if (needle === "") return [];
  return turns.flatMap((turn) => {
    const starts: number[] = [];
    let text = "";
    for (const word of turn.words) {
      starts.push(text.length);
      text += `${word.text} `;
    }
    const haystack = caseSensitive ? text : text.toLowerCase();
    const spans: ScriptSpan[] = [];
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const first = starts.findLastIndex((start) => start <= at);
      const last = starts.findLastIndex((start) => start < end);
      const span = {
        start: turn.words[first].index,
        end: turn.words[last].index,
      };
      const previous = spans[spans.length - 1];
      if (
        !previous ||
        previous.start !== span.start ||
        previous.end !== span.end
      ) {
        spans.push(span);
      }
      from = end;
    }
    return spans;
  });
}

/** The count the Find bar shows and a screen reader hears. Nothing for an empty query. */
export function findCountText(
  query: string,
  count: number,
  current: number,
): string {
  if (query.trim() === "") return "";
  if (count === 0) return "No matches";
  return `${current + 1} of ${count}`;
}
