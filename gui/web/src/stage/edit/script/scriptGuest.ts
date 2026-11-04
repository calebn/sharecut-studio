import { isShareProjectKey, type rangeEditMode } from "../../../shareMode";
import type { ScriptGuest } from "../../../system/ScriptPane";

/**
 * The header label for a guest's Script, from what the link may do. One
 * helper for the Edit stage and the Review stage, so both say the same.
 * An editor link gets no label: its cuts apply, so neither "read only" nor
 * "suggest" would be true.
 */
export function scriptGuestOf(
  projectPath: string,
  guestMode: string | null,
  mode: ReturnType<typeof rangeEditMode>,
): ScriptGuest | undefined {
  if (!isShareProjectKey(projectPath) && guestMode === null) return undefined;
  if (guestMode === "view") return "viewer";
  if (mode === "edit") return undefined;
  if (mode === "suggest") return "suggester";
  return guestMode === "comment" ? "commenter" : "viewer";
}
