import { isValidFocusTarget } from "../ui/focusTarget";

export const FEEDBACK_FOCUS_ATTRIBUTE = "data-feedback-focus";

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
