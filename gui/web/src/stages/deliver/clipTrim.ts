export type ClipWord = { text: string; start: number; end: number };

export type TrimEdge = "start" | "end";

export type TimeWindow = { start: number; end: number };

const edgeOf = (word: ClipWord, edge: TrimEdge) =>
  edge === "start" ? word.start : word.end;

function nearestIndex(
  words: readonly ClipWord[],
  edge: TrimEdge,
  time: number,
): number {
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  words.forEach((word, index) => {
    const gap = Math.abs(edgeOf(word, edge) - time);
    if (gap < bestGap) {
      best = index;
      bestGap = gap;
    }
  });
  return best;
}

/** In goes to the nearest word start and Out to the nearest word end; with no words the time stays. */
export function snapToWord(
  words: readonly ClipWord[],
  edge: TrimEdge,
  time: number,
): number {
  const index = nearestIndex(words, edge, time);
  const word = words[index];
  return word ? edgeOf(word, edge) : time;
}

/** Moves a handle by whole words from where it sits; the ends of the list stop it. With no words the time stays. */
export function stepWords(
  words: readonly ClipWord[],
  edge: TrimEdge,
  from: number,
  count: number,
): number {
  const index = nearestIndex(words, edge, from);
  if (index < 0) return from;
  const next = Math.min(words.length - 1, Math.max(0, index + count));
  const word = words[next];
  return word ? edgeOf(word, edge) : from;
}

/** The stretch the strip draws: the clip with a margin each side, kept inside the episode. */
export function trimWindow(
  clip: { start: number; end: number },
  total: number,
  margin = 3,
): TimeWindow {
  const start = Math.max(0, clip.start - margin);
  const end = Math.min(total, clip.end + margin);
  return end > start ? { start, end } : { start: 0, end: Math.max(total, 1) };
}

/** Peaks spread evenly over the episode, cut to a window. */
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

/** The seconds one arrow press moves a handle that has no words to land on. */
export function fineStep(shift: boolean): number {
  return shift ? 0.1 : 0.01;
}
