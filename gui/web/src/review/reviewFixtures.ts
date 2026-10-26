import type { SuggestionSegment } from "../system/Suggestion";
import type { ReviewItem } from "./reviewQueue";

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

const item = (
  id: string,
  kind: ReviewItem["kind"],
  at: number,
  savedSeconds: number,
  extra: Partial<ReviewItem> = {},
): ReviewItem => ({ id, kind, at, savedSeconds, ...extra });

export const QUEUE_ITEMS: readonly ReviewItem[] = [
  item("c1", "check", 0, 0),
  item("u1", "unsure-word", 614, 0),
  item("m1", "comment", 702, 0),
  item("f1", "filler", 1116, 0.8),
  item("f2", "filler", 1290, 0.6),
  item("f3", "filler", 1544, 0.9, { unsure: true }),
  item("f4", "filler", 2010, 0.7),
  item("p1", "pause", 1480, 2.3),
  item("p2", "pause", 2210, 1.9),
  item("s1", "sound", 2660, 0),
  item("f0", "filler", 90, 0.5, { result: "applied" }),
  item("p0", "pause", 240, 1.1, { result: "kept" }),
];
