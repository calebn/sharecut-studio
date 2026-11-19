import { canApplyPass12 } from "../shareMode";
import type { DawStore } from "../state/types";

export type FixTextAvailability = { ok: true } | { ok: false; reason: string };

type FixTextState = Pick<
  DawStore,
  "project" | "projectPath" | "guestMode" | "shareCapabilities"
>;

const NEEDS_EDITOR = "Fixing text needs Editor access";

/**
 * The one answer to "can this tab fix a word's text, or find and replace".
 * The server holds both to an Editor, so the host and an Editor link pass and a
 * Commenter or Viewer link reads why not. The F2 key, palette, action bar,
 * Script and Find all read it.
 */
export function fixTextAvailability(s: FixTextState): FixTextAvailability {
  if (!s.project) return { ok: false, reason: "No project loaded" };
  if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities))
    return { ok: false, reason: NEEDS_EDITOR };
  if (s.project.meta.hydration?.transcript_words === false)
    return { ok: false, reason: "Word correction unavailable" };
  return { ok: true };
}
