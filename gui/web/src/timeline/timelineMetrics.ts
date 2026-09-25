import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import {
  LANE_HEIGHT,
  MARKER_LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  MAX_FIT_LANE_HEIGHT,
} from "../utils/layout";

export type TimelineMetrics = {
  laneHeight: number;
  markerLaneHeight: number;
};

const TimelineMetricsContext = createContext<TimelineMetrics>({
  laneHeight: LANE_HEIGHT,
  markerLaneHeight: MARKER_LANE_HEIGHT,
});

export const TimelineMetricsProvider = TimelineMetricsContext.Provider;

/** Lane and marker-lane heights for the timeline being rendered. */
export function useTimelineMetrics(): TimelineMetrics {
  return useContext(TimelineMetricsContext);
}

/** Starts a hold on the lane geometry; call the result to release it. */
export type HoldTimelineMetrics = () => () => void;

const TimelineGestureContext = createContext<HoldTimelineMetrics | null>(null);

export const TimelineGestureProvider = TimelineGestureContext.Provider;

/**
 * Hold the lane geometry still while `active` (a clip move, trim, fade, roll
 * or envelope drag). Lane and marker heights follow live data, so without
 * this a collaborator's update (a first comment adds a marker row, a new
 * track re-fits the lanes) could move lanes under the pointer mid-drag.
 */
export function useHoldTimelineMetrics(active: boolean): void {
  const hold = useContext(TimelineGestureContext);
  useEffect(() => {
    if (!active || !hold) {
      return;
    }
    return hold();
  }, [active, hold]);
}

/**
 * `live`, or the value it had when the first hold began, until every hold is
 * released; then the latest live value applies.
 */
export function useGestureStable<T>(live: T): {
  value: T;
  hold: HoldTimelineMetrics;
} {
  const [frozen, setFrozen] = useState<{ value: T } | null>(null);
  const liveRef = useRef(live);
  const holdsRef = useRef(0);
  useLayoutEffect(() => {
    liveRef.current = live;
  });
  const hold = useCallback(() => {
    holdsRef.current += 1;
    if (holdsRef.current === 1) {
      setFrozen({ value: liveRef.current });
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      holdsRef.current -= 1;
      if (holdsRef.current === 0) {
        setFrozen(null);
      }
    };
  }, []);
  return { value: frozen ? frozen.value : live, hold };
}

/**
 * Lane height that fills the stage when every track fits (between the
 * default lane and {@link MAX_FIT_LANE_HEIGHT}); the default when they don't,
 * so the lanes scroll.
 */
export function fitLaneHeight(available: number, trackCount: number): number {
  if (trackCount <= 0 || !Number.isFinite(available) || available <= 0) {
    return LANE_HEIGHT;
  }
  const each = Math.floor(available / trackCount);
  return Math.max(LANE_HEIGHT, Math.min(MAX_FIT_LANE_HEIGHT, each));
}

export type MarkerRows = {
  chapters: boolean;
  social: boolean;
  comments: boolean;
};

/** Marker rows that have content to show; empty rows collapse. */
export function markerRows(input: {
  chapters: readonly ChapterMarker[];
  socialClips: readonly SocialClipView[];
  comments: readonly TimelineComment[];
  showMarkers: boolean;
  showComments: boolean;
}): MarkerRows {
  return {
    chapters: input.showMarkers && input.chapters.length > 0,
    social: input.showMarkers && input.socialClips.length > 0,
    comments: input.showComments && input.comments.length > 0,
  };
}

/** Marker lane height: one row per visible row, one quiet row when empty. */
export function markerLaneHeight(rows: MarkerRows): number {
  const count = [rows.chapters, rows.social, rows.comments].filter(
    Boolean,
  ).length;
  return Math.max(1, count) * MARKER_ROW_HEIGHT;
}
