/** True when keyboard events should not trigger Sharecut Studio shortcuts. */
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

/** Let Space/Enter activate a focused native button before the DAW keymap. */
export function isButtonActivation(e: KeyboardEvent): boolean {
  return (
    e.target instanceof HTMLButtonElement &&
    !hasCommandModifier(e) &&
    (e.key === " " || e.key === "Enter")
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
