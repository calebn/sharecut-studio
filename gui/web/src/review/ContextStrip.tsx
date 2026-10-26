import { OverviewStrip, type OverviewTick } from "../system/OverviewStrip";
import type { ReviewItem } from "./reviewQueue";

export type ContextStripProps = {
  items: readonly ReviewItem[];
  /** Episode length in seconds. */
  duration: number;
  selectedId: string | null;
  peaks?: readonly number[];
  playhead?: number;
};

/** The 32 px Overview strip above the Player: a tick for every undecided item, the current one accented. */
export function ContextStrip({
  items,
  duration,
  selectedId,
  peaks,
  playhead,
}: ContextStripProps) {
  const ticks: OverviewTick[] = items
    .filter((item) => item.result === undefined)
    .map((item) => ({
      at: item.at / duration,
      kind: item.kind === "comment" ? "comment" : "suggestion",
      current: item.id === selectedId,
    }));
  return (
    <OverviewStrip
      height={32}
      label="Episode overview"
      peaks={peaks}
      ticks={ticks}
      playhead={playhead}
    />
  );
}
