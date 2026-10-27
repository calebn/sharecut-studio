import { OverviewStrip, type OverviewTick } from "../system/OverviewStrip";
import type { ReviewItem } from "./reviewQueueModel";

/** 32 px Overview strip above the Player. */
export function ContextStrip({
  items,
  duration,
  selectedId,
  peaks,
}: {
  items: readonly ReviewItem[];
  /** Episode length in seconds. */
  duration: number;
  selectedId: string | null;
  peaks?: readonly number[];
}) {
  const ticks: OverviewTick[] = items
    .filter((item) => item.result === undefined)
    .map((item) => ({
      at: duration > 0 ? item.at / duration : 0,
      kind: item.kind === "comment" ? "comment" : "suggestion",
      current: item.id === selectedId,
    }));
  return (
    <OverviewStrip
      height={32}
      label="Episode overview"
      peaks={peaks}
      ticks={ticks}
    />
  );
}
