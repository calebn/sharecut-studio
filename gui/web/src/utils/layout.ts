/**
 * Timeline layout constants in CSS px: the one source for the ruler, marker
 * row and lane geometry. `TimelineView` sets them on `.timeline-area` as
 * `--ruler-height` / `--marker-row-height` (plus the live `--lane-height` /
 * `--marker-lane-height`), and timeline.css reads those vars, so rows and the
 * code that places markers agree at any root font size. styles/theme/tokens.css
 * keeps root fallbacks for chrome outside the timeline.
 */
export const LANE_HEIGHT = 72;
export const RULER_HEIGHT = 24;
/** One marker row (chapters, social clips, or comments). */
export const MARKER_ROW_HEIGHT = 24;
/** Chapters + social + comments rows. */
export const MARKER_LANE_HEIGHT = 3 * MARKER_ROW_HEIGHT;
/** Tallest a lane grows when few tracks fill the stage. */
export const MAX_FIT_LANE_HEIGHT = 240;
/**
 * Room left under the lanes: the header column's "+ Track" row and a
 * horizontal scrollbar, so fitting never forces a vertical scroll.
 */
export const FIT_GUTTER = 48;
/**
 * Below this lane height a desktop track header has no room for the name,
 * mute/solo and gain stacked; it switches to one row (name + M/S) with the
 * gain strip under it (`data-lane-density="compact"` on `.timeline-area`).
 */
export const COMPACT_LANE_HEIGHT = 104;
