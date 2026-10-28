import { rosterDisplayName } from "../presence/colors";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";
import { Avatar } from "../ui/Avatar";
import { followTarget } from "./followTarget";
import { useTimelineMetrics } from "./timelineMetrics";

/**
 * Per-frame timeline leaves. Each selects the hot store fields (playhead,
 * scroll, presence, split hover) that `TimelineView` must not, so a tick
 * re-renders only the leaf, never the lanes and clips.
 */

/**
 * Alt-click Split preview: one guide per target lane, at the pointer's time
 * while Alt is held over the lanes. Target lanes are the selected tracks, or
 * every lane when none is selected.
 */
export function SplitGuide({
  tracks,
  selectedTrackIds,
  zoomPxPerSec,
}: {
  tracks: readonly TrackView[];
  selectedTrackIds: readonly string[];
  zoomPxPerSec: number;
}) {
  const splitHoverSec = useDawStore((s) => s.splitHoverSec);
  const { laneHeight } = useTimelineMetrics();
  if (splitHoverSec == null) {
    return null;
  }
  const left = splitHoverSec * zoomPxPerSec;
  return tracks.map((track, idx) =>
    selectedTrackIds.length === 0 || selectedTrackIds.includes(track.id) ? (
      <div
        key={track.id}
        className="split-guide"
        style={{ left, top: idx * laneHeight }}
        aria-hidden
      />
    ) : null,
  );
}

/** Fixed playhead: the avatar of the client being followed, if any. */
export function FollowPlayheadChip() {
  const target = useDawStore(followTarget);
  if (!target) {
    return null;
  }
  return (
    <span className="playhead-fixed-chip">
      <Avatar
        name={rosterDisplayName(target)}
        colorIndex={target.meta?.color_index}
        sessionRole={target.role}
        size="sm"
      />
    </span>
  );
}
