import type { STATUS_GLYPHS } from "./verbs";

export type StatusState = (typeof STATUS_GLYPHS)[number]["state"];

export const STATUS_TEXT: Record<StatusState, string> = {
  done: "Done",
  running: "Running",
  "not-yet": "Not yet",
  "needs-you": "Needs you",
  failed: "Failed",
  offline: "Waiting to send",
  live: "Live",
};
