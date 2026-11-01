import { isTypingTarget } from "../../keymap/typing";

const FIRST_CONTROL =
  ".sys-inspector-scroll :is(button, input:not([type='hidden']), select, textarea, [tabindex]):not(:disabled, [aria-disabled='true'], [tabindex='-1'])";

/**
 * The first control takes focus unless the keymap would ignore it as a typing
 * target (any field, date and time included, and a scrub field, whose arrow
 * keys commit a value): a field would swallow the
 * shortcuts the user reaches for after opening. The dialog's focus anchor
 * (inside the Escape wrapper) holds focus then, and Tab enters the form.
 */
export function focusFirstControl(box: HTMLElement) {
  const anchor = box.querySelector<HTMLElement>("[data-inspector-anchor]");
  const first = [...box.querySelectorAll<HTMLElement>(FIRST_CONTROL)].find(
    (el) => !el.closest("[hidden], [inert]"),
  );
  const target =
    first &&
    !isTypingTarget(first) &&
    first.getAttribute("role") !== "spinbutton"
      ? first
      : (anchor ??
        box.querySelector<HTMLElement>(".sys-inspector-grip, .dialog-close"));
  target?.focus({ preventScroll: true });
}
