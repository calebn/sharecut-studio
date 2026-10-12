export const FEEDBACK_FOCUS_ATTRIBUTE = "data-feedback-focus";

export function isValidFocusTarget(
  target: HTMLElement | null,
): target is HTMLElement {
  if (
    !target?.isConnected ||
    target.matches(":disabled, [aria-disabled='true']") ||
    target.closest("[inert], [hidden]")
  )
    return false;
  const style = target.ownerDocument.defaultView?.getComputedStyle(target);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

export function isValidFeedbackAction(
  target: HTMLElement | null,
): target is HTMLButtonElement {
  return (
    target instanceof HTMLButtonElement &&
    target.closest(".ui-toast-region--app") !== null &&
    isValidFocusTarget(target)
  );
}

export function hasValidFocusedFeedbackAction(document: Document): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.hasAttribute(FEEDBACK_FOCUS_ATTRIBUTE) &&
    isValidFeedbackAction(active)
  );
}
