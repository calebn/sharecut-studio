import type { Selection } from "../types/project";

/**
 * Related commands for each selection kind.
 * Shown in the "You might also want…" zone of the mobile selection sheet.
 *
 * These are commands users often need *next* after working with a selection,
 * making them discoverable without hunting through menus.
 */
export const RELATED_COMMANDS: Record<string, string[]> = {
  clip: [
    "edit.setClipFade", // "Apply fade recommendations" lives in ClipInspector; this is the manual fade
    "edit.rippleDelete",
    "edit.bladeCut",
  ],
  word: ["transcript.correctIntent", "edit.delete"],
  comment: ["transport.seek", "edit.delete"],
  track: ["track.muteToggle", "track.soloToggle", "track.remove"],
  pending: ["tighten.applyHit", "tighten.skipHit"],
};

export function relatedCommandsFor(selection: Selection | null): string[] {
  if (!selection) {
    return [];
  }
  return RELATED_COMMANDS[selection.kind] ?? [];
}
