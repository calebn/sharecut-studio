/** True when keyboard events should not trigger ShareCut Studio shortcuts. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) {
    return false;
  }
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * Space or Enter on a focused button or summary is the browser's click, not a
 * shortcut. Shift+Space is a chord (Hear), so it is not an activation: words,
 * clips and the Action bar's own buttons are buttons, and Hear must work there.
 */
export function isButtonActivation(e: KeyboardEvent): boolean {
  return (
    e.target instanceof HTMLElement &&
    e.target.matches("button, summary") &&
    !hasCommandModifier(e) &&
    ((e.key === " " && !e.shiftKey) || e.key === "Enter")
  );
}

/**
 * True when Mod (Meta/Ctrl) or Alt is held, i.e. the key is part of a chord.
 * Shift is not a command modifier: Shift+key is still a bare key here.
 * Accepts DOM and React keyboard events.
 */
export function hasCommandModifier(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

/**
 * A Scrub field's value is a focusable span, not an input, so it owns its keys
 * the way a text field does: the window keymap must not run Split, Mute or
 * Undo from it. Escape is left to the keymap so it still closes the sheet.
 */
export function isScrubValue(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.matches('[role="spinbutton"]');
}

const VERTICAL_ARROWS = new Set(["ArrowUp", "ArrowDown"]);

/**
 * A focused choice control keeps the bare arrow keys its choices would use:
 * all four on a radio, which moves among its group, and Up and Down on a
 * segment of a SegmentedControl, where the window keymap would otherwise run
 * Move track. Left and Right on a segment still nudge the playhead.
 */
export function isChoiceControlArrow(e: KeyboardEvent): boolean {
  if (!(e.target instanceof HTMLElement) || hasCommandModifier(e)) {
    return false;
  }
  if (e.target.matches('[role="radio"]')) {
    return e.key.startsWith("Arrow");
  }
  return VERTICAL_ARROWS.has(e.key) && e.target.matches(".ui-segmented button");
}
