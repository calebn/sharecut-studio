import type { PresenceTab } from "../types/session";

export const TAB_LABELS: Record<PresenceTab, string> = {
  transcript: "Transcript",
  comments: "Comments",
  history: "History",
  impact: "Impact",
  tighten: "Tighten",
  pipeline: "Pipeline",
};

export function tabLabel(tab: PresenceTab): string {
  return TAB_LABELS[tab] ?? tab;
}
