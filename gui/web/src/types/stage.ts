export const STAGE_IDS = [
  "record",
  "prepare",
  "edit",
  "review",
  "deliver",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/** Review is the Queue alone; comments are queue items for every role. */
export const REVIEW_SECTIONS = ["queue"] as const;

export type ReviewSection = (typeof REVIEW_SECTIONS)[number];

/** Phone Edit shows the lanes or the Script, never both. */
export type EditSurface = "lanes" | "text";

export const STAGE_SHEETS = ["history", "view", "mix", "tools"] as const;

export type StageSheet = (typeof STAGE_SHEETS)[number];

/** What a stage remembers while another stage is up. */
export type StageView = {
  zoomPxPerSec: number;
  scrollLeft: number;
  userZoomed: boolean;
  /** Scroll offsets of a stage's panes, by pane key. */
  panelScroll: Record<string, number>;
};

export type StageRole = "host" | "editor" | "commenter" | "viewer";
