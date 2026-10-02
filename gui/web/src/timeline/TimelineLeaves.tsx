import { rosterDisplayName } from "../presence/colors";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";
import { Avatar } from "../ui/Avatar";
import { followTarget } from "./followTarget";
import { useTimelineMetrics } from "./timelineMetrics";

/**
 * Per-frame timeline leaves. Each selects the hot store fields (playhead,
 * scroll, presence, blade hover) that `TimelineView` must not, so a tick
 * re-renders only the leaf, never the lanes and clips.
 */

/**
 * Blade-mode cut preview: one guide per target lane, at the pointer's time.
 * Target lanes are the selected tracks, or every lane when none is selected.
 */
export function BladeGuide({
  tracks,
  selectedTrackIds,
  zoomPxPerSec,
}: {
  tracks: readonly TrackView[];
  selectedTrackIds: readonly string[];
  zoomPxPerSec: number;
}) {
  const bladeHoverSec = useDawStore((s) => s.bladeHoverSec);
  const { laneHeight } = useTimelineMetrics();
  if (bladeHoverSec == null) {
    return null;
  }
  const left = bladeHoverSec * zoomPxPerSec;
  return tracks.map((track, idx) =>
    selectedTrackIds.length === 0 || selectedTrackIds.includes(track.id) ? (
      <div
        key={track.id}
        className="blade-cut-guide blade-cut-guide--lane"
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
