import type { OverviewTick } from "../../system/OverviewStrip";
import { clamp } from "../../utils/math";

export interface OverviewTickTimes {
  commentTimes: readonly number[];
  suggestionTimes: readonly number[];
  durationSec: number;
}

export function overviewTicks({
  commentTimes,
  suggestionTimes,
  durationSec,
}: OverviewTickTimes): OverviewTick[] {
  if (!(durationSec > 0)) return [];
  const at = (time: number) => clamp(time / durationSec, 0, 1);
  return [
    ...commentTimes.map(
      (time): OverviewTick => ({
        at: at(time),
        kind: "comment",
      }),
    ),
    ...[...new Set(suggestionTimes.map(at))].map(
      (a): OverviewTick => ({ at: a, kind: "suggestion" }),
    ),
  ];
}
