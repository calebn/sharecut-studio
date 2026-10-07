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
  clampLaneHeightPx,
  type LaneHeightMode,
} from "../utils/laneHeightPref";
import {
  COMPACT_LANE_HEIGHT,
  LANE_HEIGHT,
  MARKER_LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  MAX_FIT_LANE_HEIGHT,
} from "../utils/layout";
import type { ClippingFlag } from "./clippingFlags";

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
 * The provider's hold, for a gesture that must freeze the geometry inside its
 * own event handler (an envelope drag) rather than one effect later; null
 * outside a `TimelineGestureProvider`.
 */
export function useTimelineGestureHold(): HoldTimelineMetrics | null {
  return useContext(TimelineGestureContext);
}

/**
 * Hold the lane geometry still while `active` (a clip move, trim, fade, roll
 * or envelope drag). Lane and marker heights follow live data, so without
 * this a collaborator's update (a first comment adds a marker row, a new
 * track re-fits the lanes) could move lanes under the pointer mid-drag.
 */
export function useHoldTimelineMetrics(active: boolean): void {
  const hold = useTimelineGestureHold();
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
 * so the lanes scroll. Used only in fit mode — see {@link resolveLaneHeight}.
 */
export function fitLaneHeight(available: number, trackCount: number): number {
  if (trackCount <= 0 || !Number.isFinite(available) || available <= 0) {
    return LANE_HEIGHT;
  }
  const each = Math.floor(available / trackCount);
  return Math.max(LANE_HEIGHT, Math.min(MAX_FIT_LANE_HEIGHT, each));
}

/**
 * How lanes size for the input and screen. A mouse or pen gets the plain
 * floor; touch keeps 104 px lanes so the track details and clip-light targets
 * stay apart; a short touch screen (a phone held sideways, #1077) uses the
 * compact lane, `floorPx` ({@link shortTouchFloorPx}), so three or more fit.
 * The compact lane ignores the stage height, so a sheet that opens or closes
 * never resizes the lanes under a finger.
 */
export type LaneFit =
  | { kind: "pointer" }
  | { kind: "touch" }
  | { kind: "touchShort"; floorPx: number };

/** The 2.75rem identity chip plus its 0.5rem meter row, in rem. */
const SHORT_TOUCH_FLOOR_REM = 3.25;

/**
 * Shortest touch lane on a short screen: the 72 px compact lane, or taller
 * when large text grows the identity chip past it.
 */
export function shortTouchFloorPx(rootFontPx: number): number {
  return Math.max(LANE_HEIGHT, Math.ceil(rootFontPx * SHORT_TOUCH_FLOOR_REM));
}

/**
 * Lane height for the current mode (#529): the saved fixed height, or the
 * fitted height when "Fit tracks to window height" is on, bounded by
 * {@link LaneFit}.
 */
export function resolveLaneHeight(input: {
  mode: LaneHeightMode;
  fixedPx: number;
  availablePx: number;
  trackCount: number;
  fit: LaneFit;
}): number {
  const preferred =
    input.mode === "fit"
      ? fitLaneHeight(input.availablePx, input.trackCount)
      : clampLaneHeightPx(input.fixedPx);
  switch (input.fit.kind) {
    case "pointer":
      return preferred;
    case "touch":
      return Math.max(COMPACT_LANE_HEIGHT, preferred);
    case "touchShort":
      // Fit mode still fills the stage; a fixed height drops to the
      // compact lane.
      return input.mode === "fit"
        ? Math.max(input.fit.floorPx, preferred)
        : input.fit.floorPx;
  }
}

export type MarkerRows = {
  chapters: boolean;
  social: boolean;
  comments: boolean;
  clipping: boolean;
};

/** Marker rows that have content to show; empty rows collapse. */
export function markerRows(input: {
  chapters: readonly ChapterMarker[];
  socialClips: readonly SocialClipView[];
  comments: readonly TimelineComment[];
  clippingFlags?: readonly ClippingFlag[];
  showMarkers: boolean;
  showComments: boolean;
}): MarkerRows {
  return {
    chapters: input.showMarkers && input.chapters.length > 0,
    social: input.showMarkers && input.socialClips.length > 0,
    comments: input.showComments && input.comments.length > 0,
    clipping: input.showMarkers && (input.clippingFlags?.length ?? 0) > 0,
  };
}

/**
 * Marker lane height: one row per visible row, and one quiet row when empty,
 * except on a short touch screen (#1077), where an empty lane gives its row
 * to the tracks.
 */
export function markerLaneHeight(
  rows: MarkerRows,
  fit: LaneFit = { kind: "pointer" },
): number {
  const count = [
    rows.chapters,
    rows.social,
    rows.comments,
    rows.clipping,
  ].filter(Boolean).length;
  const quietRows = fit.kind === "touchShort" ? 0 : 1;
  return Math.max(quietRows, count) * MARKER_ROW_HEIGHT;
}
