import { type RefObject, useEffect, useRef } from "react";
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

const BACK_TO_PLAYHEAD_LABEL = "Back to playhead in timeline";

/**
 * It unmounts on activation, so focus moves to the scroller first and a
 * keyboard user is not dropped.
 */
export function TimelineFollowPill({
  timeViewportPx,
  scrollRef,
}: {
  timeViewportPx: number;
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const visibility = useDawStore((s) => {
    if (s.followingClientId) return "following-person";
    const show =
      !s.timelineFollowPlayhead &&
      isPlayheadOffscreen({
        playheadSec: s.playheadSec,
        zoomPxPerSec: s.zoomPxPerSec,
        viewportPx: timeViewportPx,
        scrollPx: s.scrollLeft,
      });
    return show ? "visible" : "hidden";
  });
  const hasMeasuredViewport = timeViewportPx > 0;
  const availability =
    !hasMeasuredViewport && visibility === "visible" ? "hidden" : visibility;
  const previousAvailability = useRef(availability);
  useEffect(() => {
    const appearedWhileBrowsingLocally =
      availability === "visible" && previousAvailability.current === "hidden";
    previousAvailability.current = availability;
    if (appearedWhileBrowsingLocally) {
      useDawStore
        .getState()
        .announceStatus(BACK_TO_PLAYHEAD_LABEL, { toast: false });
    }
  }, [availability]);

  if (visibility !== "visible") {
    return null;
  }
  return (
    <CommandButton
      bare
      commandId="view.followPlayhead"
      className="timeline-follow-pill"
      aria-label={BACK_TO_PLAYHEAD_LABEL}
      onClick={() => scrollRef.current?.focus({ preventScroll: true })}
    >
      <SystemIcon name="locate-fixed" size={14} />
      Back to playhead
    </CommandButton>
  );
}
