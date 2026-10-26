export const STAGE_IDS = [
  "record",
  "prepare",
  "edit",
  "review",
  "deliver",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export type ReviewSection = "impact" | "comments" | "tighten";

/** Phone Edit shows the lanes or the Script, never both. */
export type EditSurface = "lanes" | "text";

export type StageSheet = "history" | "view" | "mix";

/** What a stage remembers while another stage is up. */
export type StageView = {
  zoomPxPerSec: number;
  scrollLeft: number;
  userZoomed: boolean;
  /** Scroll offsets of a stage's panes, by pane key. */
  panelScroll: Record<string, number>;
};

export type StageRole = "host" | "Editor" | "Commenter" | "Viewer";
