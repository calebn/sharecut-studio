import type { OverviewTick } from "../../system/OverviewStrip";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";

export { SCRIPT_TURNS };

export const DURATION = 3120;

/** Each word starts 1.3 s after the last, from the first turn's 12:04. */
export const WORD_STARTS: readonly number[] = Array.from(
  { length: 54 },
  (_, index) => 724 + index * 1.3,
);

export const PEAKS = Array.from(
  { length: 64 },
  (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);

export const TICKS: readonly OverviewTick[] = [
  { at: 0.23, kind: "comment" },
  { at: 0.5, kind: "chapter" },
  { at: 0.75, kind: "chapter" },
];

export const PEOPLE = [
  { name: "Maya Okafor", colorIndex: 0 },
  { name: "Anneke de Vries", colorIndex: 1 },
];
