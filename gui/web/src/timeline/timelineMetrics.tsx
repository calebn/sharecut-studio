import { createContext, useContext } from "react";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { LANE_HEIGHT, MARKER_LANE_HEIGHT } from "../utils/layout";

/** One marker row (chapters, social clips, or comments), in CSS px. */
export const MARKER_ROW_HEIGHT = 24;
/** Tallest a lane grows when few tracks fill the stage. */
export const MAX_FIT_LANE_HEIGHT = 240;
/** Keeps a horizontal scrollbar from forcing a vertical one. */
export const FIT_GUTTER = 16;

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
  chapters: ChapterMarker[];
  socialClips: SocialClipView[];
  comments: TimelineComment[];
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
