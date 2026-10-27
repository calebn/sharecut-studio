import { clamp } from "../../utils/math";

export type ClipWord = { text: string; start: number; end: number };

export type TrimEdge = "start" | "end";

export type TimeWindow = { start: number; end: number };

const edgeOf = (word: ClipWord, edge: TrimEdge) =>
  edge === "start" ? word.start : word.end;

/** Words in time order, without any whose times are not numbers. */
export function normaliseWords(words: readonly ClipWord[]): ClipWord[] {
  return words
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** In goes to the nearest word start and Out to the nearest word end; with no words the time stays. */
export function snapToWord(
  words: readonly ClipWord[],
  edge: TrimEdge,
  time: number,
): number {
  let best = time;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const word of words) {
    const gap = Math.abs(edgeOf(word, edge) - time);
    if (gap < bestGap) {
      best = edgeOf(word, edge);
      bestGap = gap;
    }
  }
  return best;
}

/** The stretch the strip draws: the clip with a margin each side, kept inside the episode; the whole episode if that leaves nothing. */
export function trimWindow(
  clip: { start: number; end: number },
  total: number,
  margin = 3,
): TimeWindow {
  const start = clamp(clip.start - margin, 0, total);
  const end = clamp(clip.end + margin, 0, total);
  return end > start ? { start, end } : { start: 0, end: Math.max(total, 1) };
}

export function peaksForWindow(
  peaks: readonly number[],
  total: number,
  window: TimeWindow,
): number[] {
  if (peaks.length === 0 || total <= 0) return [];
  const first = Math.max(0, Math.floor((window.start / total) * peaks.length));
  const last = Math.min(
    peaks.length,
    Math.ceil((window.end / total) * peaks.length),
  );
  return peaks.slice(first, Math.max(first + 1, last));
}
