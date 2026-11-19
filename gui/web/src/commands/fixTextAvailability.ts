import { canApplyPass12 } from "../shareMode";
import type { DawStore } from "../state/types";

export type FixTextAvailability = { ok: true } | { ok: false; reason: string };

type FixTextState = Pick<
  DawStore,
  "project" | "projectPath" | "guestMode" | "shareCapabilities"
>;

const NEEDS_EDITOR = "Fixing text needs Editor access";

/** The server holds Fix text and Find and replace to an Editor, so the client refuses a Commenter or Viewer link too. */
export function fixTextAvailability(s: FixTextState): FixTextAvailability {
  if (!s.project) return { ok: false, reason: "No project loaded" };
  if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities))
    return { ok: false, reason: NEEDS_EDITOR };
  if (s.project.meta.hydration?.transcript_words === false)
    return { ok: false, reason: "Word correction unavailable" };
  return { ok: true };
}
