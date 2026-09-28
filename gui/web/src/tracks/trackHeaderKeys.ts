import type { KeyboardEvent } from "react";
import { hasCommandModifier } from "../keymap/typing";

/**
 * onKeyDown for track-header buttons (open, reorder handle, M, S).
 * A bare Space or Enter activates the focused button instead of reaching the
 * window keymap, where Space toggles playback and Enter applies a tighten hit
 * (the keymap would also preventDefault and swallow the button's click).
 * Chords (Mod/Alt + key) still reach the keymap. Shift is not a chord:
 * Shift+Space and Shift+Enter still activate the button, as browsers do.
 */
export function keepActivationKeys(e: KeyboardEvent<HTMLElement>): void {
  if (hasCommandModifier(e)) {
    return;
  }
  if (e.key === " " || e.key === "Enter") {
    e.stopPropagation();
  }
}
