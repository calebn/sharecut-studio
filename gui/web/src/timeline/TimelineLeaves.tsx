import type { RefObject } from "react";
import { rosterDisplayName } from "../presence/colors";
import { useDawStore } from "../state/dawStore";
import { SystemIcon } from "../system/SystemIcon";
import type { TrackView } from "../types/project";
import { Avatar } from "../ui/Avatar";
import { CommandButton } from "../ui/CommandButton";
import { isPlayheadOffscreen } from "../utils/timelineFollow";
import { followTarget } from "./followTarget";
import { useTimelineMetrics } from "./timelineMetrics";

/**
 * Per-frame timeline leaves. Each selects the hot store fields (playhead,
 * scroll, presence, split hover) that `TimelineView` must not, so a tick
 * re-renders only the leaf, never the lanes and clips.
 */

/**
 * Alt-click Split preview: one guide per lane the cut will land on, at the
 * pointer's time while Alt is held over the lanes. `cutTrackIds` is what
 * `edit.bladeCut` resolves: the selected tracks, else the dialogue tracks.
 */
export function SplitGuide({
  tracks,
  cutTrackIds,
  zoomPxPerSec,
}: {
  tracks: readonly TrackView[];
  cutTrackIds: readonly string[];
  zoomPxPerSec: number;
}) {
  const splitHoverSec = useDawStore((s) => s.splitHoverSec);
  const { laneHeight } = useTimelineMetrics();
  if (splitHoverSec == null) {
    return null;
  }
  const left = splitHoverSec * zoomPxPerSec;
  return tracks.map((track, idx) =>
    cutTrackIds.includes(track.id) ? (
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

/**
 * Back to playhead for the desktop timeline. It selects a boolean, so a tick
 * re-renders it only when the pill appears or goes; it unmounts on activation,
 * so focus moves to the scroller first.
 */
export function TimelineFollowPill({
  timeViewportPx,
  scrollRef,
}: {
  timeViewportPx: number;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const show = useDawStore(
    (s) =>
      !s.timelineFollowPlayhead &&
      !s.followingClientId &&
      isPlayheadOffscreen({
        playheadSec: s.playheadSec,
        zoomPxPerSec: s.zoomPxPerSec,
        viewportPx: timeViewportPx,
        scrollPx: s.scrollLeft,
      }),
  );
  if (!show) {
    return null;
  }
  return (
    <CommandButton
      bare
      commandId="view.followPlayhead"
      className="timeline-follow-pill"
      aria-label="Back to playhead in timeline"
      onClick={() => scrollRef.current?.focus({ preventScroll: true })}
    >
      <SystemIcon name="locate-fixed" size={14} />
      Back to playhead
    </CommandButton>
  );
}
