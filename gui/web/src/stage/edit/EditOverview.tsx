import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { suggestionTimesOf } from "../../review/reviewItems";
import { useDawStore } from "../../state/dawStore";
import { OverviewStrip } from "../../system/OverviewStrip";
import { clamp } from "../../utils/math";
import { playerTicks } from "../frame/playerModel";
import { useSeekFraction } from "../frame/useSeekFraction";

const NONE: readonly never[] = [];

export interface EditOverviewProps {
  height: 16 | 32;
  /** A guest never sees the cuts over an unsure word, which only the host decides. */
  guest: boolean;
}

function EditOverviewView({ height, guest }: EditOverviewProps) {
  const { comments, pendingEdits, duration } = useDawStore(
    useShallow((s) => ({
      comments: s.project?.comments,
      pendingEdits: s.project?.pending_edits,
      duration: s.project?.timeline_duration_sec ?? 0,
    })),
  );
  const playheadSec = useDawStore((s) => s.playheadSec);
  const ticks = useMemo(
    () =>
      playerTicks(
        [],
        (comments ?? NONE).map((c) => c.timeline_start),
        duration,
        suggestionTimesOf(pendingEdits ?? NONE, guest),
      ),
    [comments, pendingEdits, duration, guest],
  );
  const { onSeek, onScrub } = useSeekFraction(duration);
  if (!(duration > 0)) return null;
  return (
    <div className="edit-overview">
      <OverviewStrip
        height={height}
        label="Episode overview"
        playhead={clamp(playheadSec / duration, 0, 1)}
        duration={duration}
        ticks={ticks}
        onSeek={onSeek}
        onScrub={onScrub}
      />
    </div>
  );
}

export const EditOverview = memo(EditOverviewView);
