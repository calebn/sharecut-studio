import type { ReviewItem } from "../review/reviewQueueModel";
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

export const QUEUE_ITEMS: readonly ReviewItem[] = [
  { id: "c1", kind: "check", at: 0, savedSeconds: 0, transcript: true },
  { id: "u1", kind: "unsure-word", at: 614, savedSeconds: 0 },
  { id: "m1", kind: "comment", at: 702, savedSeconds: 0 },
  { id: "f1", kind: "filler", at: 1116, savedSeconds: 0.8 },
  { id: "f2", kind: "filler", at: 1290, savedSeconds: 0.6 },
  { id: "f3", kind: "filler", at: 1544, savedSeconds: 0.9, unsure: true },
  { id: "f4", kind: "filler", at: 2010, savedSeconds: 0.7 },
  { id: "p1", kind: "pause", at: 1480, savedSeconds: 2.3 },
  { id: "p2", kind: "pause", at: 2210, savedSeconds: 1.9 },
  { id: "s1", kind: "sound", at: 2660, savedSeconds: 0 },
  { id: "f0", kind: "filler", at: 90, savedSeconds: 0.5, result: "applied" },
  { id: "p0", kind: "pause", at: 240, savedSeconds: 1.1, result: "kept" },
];

export const QUEUE_WITHOUT_CHECKS = QUEUE_ITEMS.filter(
  (item) => item.kind !== "check" && item.kind !== "unsure-word",
);

export const EXTRA_KIND_ITEMS: readonly ReviewItem[] = [
  { id: "r1", kind: "repeat", at: 800, savedSeconds: 0.6 },
  { id: "k1", kind: "false-start", at: 1900, savedSeconds: 0.9 },
  { id: "g1", kind: "suggestion", at: 2400, savedSeconds: 1.2 },
  {
    id: "g2",
    kind: "suggestion",
    at: Number.POSITIVE_INFINITY,
    savedSeconds: 0.4,
  },
];

export const QUEUE_CHECKED = QUEUE_ITEMS.map((item) =>
  item.kind === "check" ? { ...item, result: "applied" as const } : item,
);
