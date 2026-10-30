const FIRST_CONTROL =
  ".sys-inspector-scroll :is(button, input, select, textarea, [tabindex]):not(:disabled, [tabindex='-1'])";

const NON_TEXT_INPUT = /^(button|checkbox|radio|range|submit|reset|image)$/;

function takesText(el: HTMLElement) {
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT.test(el.type);
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable
  );
}

/**
 * The first control takes focus unless it takes text: the keymap ignores a
 * typing target, so a field would swallow the shortcuts the user reaches for
 * after opening. The dialog itself holds focus then, and Tab enters the form.
 */
export function focusFirstControl(box: HTMLElement) {
  const dialog = box.querySelector<HTMLElement>('[role="dialog"]');
  const first = [...box.querySelectorAll<HTMLElement>(FIRST_CONTROL)].find(
    (el) => !el.closest("[hidden], [inert]"),
  );
  const target =
    first && !takesText(first)
      ? first
      : (dialog ??
        box.querySelector<HTMLElement>(".sys-inspector-grip, .dialog-close"));
  target?.focus({ preventScroll: true });
}
