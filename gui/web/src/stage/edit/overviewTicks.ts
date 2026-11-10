import type { OverviewTick } from "../../system/OverviewStrip";

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
  const at = (time: number) => Math.min(1, Math.max(0, time / durationSec));
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
