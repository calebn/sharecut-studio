import type { SuggestionSegment } from "../system/Suggestion";

/** 120 peaks across a 12 s window, quiet inside each `[from, to]` gap in seconds. */
export function windowPeaks(gaps: readonly [number, number][]): number[] {
  return Array.from({ length: 120 }, (_, index) => {
    const at = index * 0.1;
    if (gaps.some(([from, to]) => at >= from && at < to)) return 0.04;
    return (
      0.25 + 0.65 * Math.abs(Math.sin(index * 0.9) * Math.cos(index * 0.31))
    );
  });
}

export const fillerPeaks = windowPeaks([
  [0, 0.4],
  [4.4, 4.9],
  [7.3, 7.9],
  [11.5, 12],
]);

export const pausePeaks = windowPeaks([
  [0, 0.6],
  [4.3, 7.2],
  [11, 12],
]);

export const FILLER_EXCERPT: readonly SuggestionSegment[] = [
  { text: "So the thing about the old mill is " },
  { text: "um, you know,", struck: true },
  { text: " nobody asked the river what it wanted." },
];

export const UNSURE_EXCERPT: readonly SuggestionSegment[] = [
  { text: "I asked " },
  { text: "uncle", unsure: true },
  { text: " Rosa whether the boat was still there." },
];

export const FILLER_WITH_UNSURE: readonly SuggestionSegment[] = [
  { text: "We went to see " },
  { text: "uh, my", struck: true },
  { text: " " },
  { text: "uncle", unsure: true },
  { text: " about the boat." },
];

export const FILLER_WAVEFORM = {
  peaks: fillerPeaks,
  windowStart: 1108.8,
  start: 1114.4,
  end: 1115.2,
};
