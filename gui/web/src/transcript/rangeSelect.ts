import type { Selection } from "../types/project";

export type TranscriptRangeSelection = Extract<
  NonNullable<Selection>,
  { kind: "transcriptRange" }
>;

export type RangeEdge = "start" | "end";

/** Move one edge of a word range by one word: `by` -1 reaches earlier, +1 later. */
export type RangeStep = { edge: RangeEdge; by: 1 | -1 };

export type WordSpan = { startWordIndex: number; endWordIndex: number };

export type RangeStepResult =
  | { ok: true; span: WordSpan }
  | { ok: false; reason: string };

export const ONE_WORD_REASON = "The range is one word. Clear it to start over.";
export const NO_EARLIER_WORD_REASON = "There is no earlier word to add.";
export const NO_LATER_WORD_REASON = "There is no later word to add.";

/** The word range controls, in the order a person grows then trims a range. */
export const RANGE_STEP_CONTROLS: readonly {
  step: RangeStep;
  label: string;
}[] = [
  { step: { edge: "start", by: -1 }, label: "Add word before" },
  { step: { edge: "end", by: 1 }, label: "Add word after" },
  { step: { edge: "start", by: 1 }, label: "Drop first word" },
  { step: { edge: "end", by: -1 }, label: "Drop last word" },
];

export function isRangeStep(value: unknown): value is RangeStep {
  if (typeof value !== "object" || value === null) return false;
  const { edge, by } = value as Record<string, unknown>;
  return (edge === "start" || edge === "end") && (by === 1 || by === -1);
}

/**
 * The span after one edge moves by one word. Growing needs a word there
 * (`exists`); trimming keeps at least one word, so a range never empties.
 */
export function stepWordSpan(
  span: WordSpan,
  { edge, by }: RangeStep,
  exists: (wordIndex: number) => boolean,
): RangeStepResult {
  const lo = Math.min(span.startWordIndex, span.endWordIndex);
  const hi = Math.max(span.startWordIndex, span.endWordIndex);
  const moved = (edge === "start" ? lo : hi) + by;
  const growing = edge === "start" ? by < 0 : by > 0;
  if (growing) {
    if (!exists(moved)) {
      return {
        ok: false,
        reason:
          edge === "start" ? NO_EARLIER_WORD_REASON : NO_LATER_WORD_REASON,
      };
    }
  } else if (hi === lo) {
    return { ok: false, reason: ONE_WORD_REASON };
  }
  return edge === "start"
    ? { ok: true, span: { startWordIndex: moved, endWordIndex: hi } }
    : { ok: true, span: { startWordIndex: lo, endWordIndex: moved } };
}

export function wordCountOf(span: WordSpan): number {
  return Math.abs(span.endWordIndex - span.startWordIndex) + 1;
}

export function selectedWordsMessage(span: WordSpan): string {
  const n = wordCountOf(span);
  return n === 1 ? "1 word selected" : `${n} words selected`;
}

/** The span between an anchor word and the word the finger is over. */
export function spanBetween(anchor: number, to: number): WordSpan {
  return {
    startWordIndex: Math.min(anchor, to),
    endWordIndex: Math.max(anchor, to),
  };
}

export type WordTarget = { trackId: string; wordIndex: number };

/** The word chip a viewport point is over, even where a sheet covers it. */
export function wordAtPoint(
  doc: Pick<Document, "elementsFromPoint">,
  x: number,
  y: number,
): WordTarget | null {
  for (const el of doc.elementsFromPoint(x, y)) {
    const chip = el.closest<HTMLElement>("[data-transcript-word]");
    if (!chip) continue;
    const wordIndex = Number(chip.dataset.wordIndex);
    const trackId = chip.dataset.trackId;
    if (trackId && Number.isInteger(wordIndex)) return { trackId, wordIndex };
  }
  return null;
}
