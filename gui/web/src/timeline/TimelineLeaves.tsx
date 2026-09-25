import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { rosterDisplayName } from "../presence/colors";
import { useDawStore } from "../state/dawStore";
import type { TrackView } from "../types/project";
import { Avatar } from "../ui/Avatar";
import {
  centerSecToScrollLeft,
  domToLogicalScrollLeft,
  PLAYHEAD_MOVE_MIN_PX,
  scrollLeftToCenterSec,
} from "../utils/timelineViewport";
import { followTarget } from "./followTarget";
import { useTimelineMetrics } from "./timelineMetrics";

/**
 * Per-frame timeline leaves. Each selects the hot store fields (playhead,
 * scroll, presence, blade hover) that `TimelineView` must not, so a tick
 * re-renders only the leaf, never the lanes and clips.
 */

export type WriteScroll = (
  el: HTMLElement,
  logical: number,
  lead: number,
) => void;

type ScrollerProps = {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Fixed-playhead lead pad (px) of this render; 0 when unpadded. */
  leadPx: number;
  writeScroll: WriteScroll;
};

/**
 * Writes the store scroll to the DOM in a layout effect. It re-renders with
 * `TimelineView` on a zoom, so the write lands in the commit that widens the
 * content (no clamp to the old width, zoom anchoring kept).
 */
export function TimelineScrollSync({
  scrollRef,
  leadPx,
  writeScroll,
}: ScrollerProps) {
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    writeScroll(el, scrollLeft, leadPx);
  }, [scrollLeft, zoomPxPerSec, leadPx, writeScroll, scrollRef]);
  return null;
}

/**
 * Fixed playhead: transport/seek recenters on the playhead. Pinch and
 * pointer zoom keep the time under the fingers still and move the playhead
 * to the new center; fit and command zoom (menu, keys) anchor at the line
 * (dawStore), so they keep it.
 */
export function FixedPlayheadRecenter({
  scrollRef,
  leadPx,
  writeScroll,
  fixedPlayhead,
  timeViewportPx,
}: ScrollerProps & { fixedPlayhead: boolean; timeViewportPx: number }) {
  const playheadSec = useDawStore((s) => s.playheadSec);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const userZoomed = useDawStore((s) => s.userZoomed);
  const project = useDawStore((s) => s.project);
  const setScrollLeft = useDawStore((s) => s.setScrollLeft);
  const setPlayheadSec = useDawStore((s) => s.setPlayheadSec);
  const prevZoomRef = useRef(zoomPxPerSec);

  useEffect(() => {
    const el = scrollRef.current;
    // Track every zoom, even while unpadded, so a later switch to a fixed
    // playhead does not read an old zoom as a pinch.
    const zoomChanged = prevZoomRef.current !== zoomPxPerSec;
    prevZoomRef.current = zoomPxPerSec;
    if (!el || !fixedPlayhead || !project || timeViewportPx <= 0) {
      return;
    }

    if (zoomChanged && userZoomed) {
      const centerSec = scrollLeftToCenterSec(
        scrollLeft,
        zoomPxPerSec,
        timeViewportPx,
        project.timeline_duration_sec,
      );
      if (
        Math.abs(centerSec - playheadSec) * zoomPxPerSec >
        PLAYHEAD_MOVE_MIN_PX
      ) {
        setPlayheadSec(centerSec);
      }
      return;
    }

    const target = centerSecToScrollLeft(
      playheadSec,
      zoomPxPerSec,
      timeViewportPx,
    );
    const current = domToLogicalScrollLeft(el.scrollLeft, leadPx);
    if (Math.abs(current - target) > PLAYHEAD_MOVE_MIN_PX) {
      writeScroll(el, target, leadPx);
      setScrollLeft(target);
    }
  }, [
    playheadSec,
    zoomPxPerSec,
    scrollLeft,
    fixedPlayhead,
    project,
    setScrollLeft,
    setPlayheadSec,
    isPlaying,
    userZoomed,
    leadPx,
    timeViewportPx,
    writeScroll,
    scrollRef,
  ]);
  return null;
}

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
