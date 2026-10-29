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
