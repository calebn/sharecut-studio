import { useEffect } from "react";

/** What counts as a control a person presses (and focus can return to). */
const CONTROL_SELECTOR =
  'button, [href], input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';

/** Presses inside a toast do not count as "the control just pressed" for placing one. */
const TOAST_SELECTOR = ".ui-toast-region";

type Pressed = {
  control: HTMLElement;
  /** Where it was when pressed: a control can re-render away (Move track up → down). */
  rect: DOMRect;
  inToast: boolean;
};

let pressed: Pressed | null = null;

/**
 * The control behind the latest click, while it is still in the page; null
 * when that click landed outside any control (the canvas, a scrim's body).
 */
export function lastPressedControl(): HTMLElement | null {
  return pressed?.control.isConnected ? pressed.control : null;
}

/**
 * Where the person last pressed a control outside any toast: its live box, or
 * the box it had when pressed if it has since re-rendered away. Null when the
 * last click hit no control, or a toast's own Undo or Dismiss.
 */
export function lastPressedRect(): DOMRect | null {
  if (!pressed || pressed.inToast) return null;
  return pressed.control.isConnected
    ? pressed.control.getBoundingClientRect()
    : pressed.rect;
}

/** Record the control behind a click target (exported for tests). */
export function rememberPressedControl(target: EventTarget | null): void {
  const control =
    target instanceof Element
      ? target.closest<HTMLElement>(CONTROL_SELECTOR)
      : null;
  pressed = control
    ? {
        control,
        rect: control.getBoundingClientRect(),
        inToast: control.closest(TOAST_SELECTOR) != null,
      }
    : null;
}

/**
 * The control that opened an overlay, for focus to return to. Safari and
 * WebKit do not focus a clicked button: focus stays on `<body>` or moves to a
 * focusable container around the button. So the clicked control wins when
 * focus is nowhere or holds it; otherwise (a keyboard shortcut) the focused
 * element does.
 */
export function openerControl(): HTMLElement | null {
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && active !== document.body ? active : null;
  const clicked = lastPressedControl();
  if (clicked && (focused == null || focused.contains(clicked))) {
    return clicked;
  }
  return focused;
}

/**
 * Mount once per app: remembers the control behind each click, in the capture
 * phase so it is known before that control's own handler opens a dialog.
 */
export function usePressedControl(): void {
  useEffect(() => {
    const onClick = (e: MouseEvent) => rememberPressedControl(e.target);
    window.addEventListener("click", onClick, { capture: true, passive: true });
    return () => {
      window.removeEventListener("click", onClick, true);
      pressed = null;
    };
  }, []);
}
