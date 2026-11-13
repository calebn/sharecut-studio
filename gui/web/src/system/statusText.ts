import type { STATUS_GLYPHS } from "./verbs";

export type StatusState = (typeof STATUS_GLYPHS)[number]["state"];

export const STATUS_TEXT: Record<StatusState, string> = {
  done: "Done",
  running: "Running",
  "not-yet": "Not yet",
  "needs-you": "Needs you",
  failed: "Failed",
  offline: "Offline",
  queued: "Waiting to send",
  live: "Live",
  unavailable: "Not available",
};

export type StatusRowState =
  | "queued"
  | "running"
  | "done"
  | "needs-you"
  | "failed"
  /** The device or build cannot do this, and nothing will change that here. */
  | "unavailable";

/** The glyph each status row state draws. */
export const STATUS_ROW_GLYPH: Record<StatusRowState, StatusState> = {
  queued: "not-yet",
  running: "running",
  done: "done",
  "needs-you": "needs-you",
  failed: "failed",
  unavailable: "unavailable",
};
