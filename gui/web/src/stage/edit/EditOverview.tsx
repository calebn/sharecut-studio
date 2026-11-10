import { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import { needsReview } from "../../review/reviewItems";
import { useDawStore } from "../../state/dawStore";
import { OverviewStrip } from "../../system/OverviewStrip";
import { transportTimecode } from "../../utils/time";
import { overviewTicks } from "./overviewTicks";

const NONE: readonly never[] = [];

export interface EditOverviewProps {
  /** 16 on the phone, 32 in Script focus. */
  height: 16 | 32;
}

function EditOverviewView({ height }: EditOverviewProps) {
  const { comments, pendingEdits, duration, guest } = useDawStore(
    useShallow((s) => ({
      comments: s.project?.comments,
      pendingEdits: s.project?.pending_edits,
      duration: s.project?.timeline_duration_sec ?? 0,
      guest: s.guestMode !== null,
    })),
  );
  const playheadSec = useDawStore((s) => s.playheadSec);
  const ticks = useMemo(
    () =>
      overviewTicks({
        commentTimes: (comments ?? NONE).map((c) => c.timeline_start),
        suggestionTimes: (pendingEdits ?? NONE)
          .filter((e) => needsReview(e) && !(guest && e.unsure_words?.length))
          .flatMap((e) =>
            e.timeline_start === null ? [] : [e.timeline_start],
          ),
        durationSec: duration,
      }),
    [comments, pendingEdits, duration, guest],
  );
  const onSeek = useCallback(
    (fraction: number) => void seekTransport(fraction * duration),
    [duration],
  );
  if (!(duration > 0)) return null;
  return (
    <div className="edit-overview">
      <OverviewStrip
        height={height}
        label="Episode overview"
        playhead={Math.min(1, Math.max(0, playheadSec / duration))}
        valueText={transportTimecode(playheadSec, duration).title}
        ticks={ticks}
        onSeek={onSeek}
      />
    </div>
  );
}

export const EditOverview = memo(EditOverviewView);
