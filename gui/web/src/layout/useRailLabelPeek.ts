import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type LongPressHandlers, useLongPress } from "../hooks/useLongPress";

const PEEK_MS = 2500;

export type Peek = { text: string; centerX: number; bottom: number };

/** Text a person can see in a control; screen-reader-only and hidden text do not count. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.classList.contains("sr-only")) return "";
  if (getComputedStyle(node).display === "none") return "";
  return Array.from(node.childNodes).map(visibleText).join("").trim();
}

/** What an icon-only control is called, and why it is unavailable if it is. */
export function iconOnlyLabel(control: HTMLElement): string | null {
  if (visibleText(control) !== "") return null;
  const name = control.getAttribute("aria-label") ?? control.title;
  if (!name) return null;
  const note = control.title;
  // A title is a reason only on an unavailable control; elsewhere it repeats the name.
  const unavailable = control.getAttribute("aria-disabled") === "true";
  return unavailable && note && note !== name ? `${name}: ${note}` : name;
}

/**
 * A long press on an icon-only control in `container` shows its name (and
 * its reason, when it is unavailable) near the control without activating
 * it (docs/interaction-system.md, Shells and placement rule 4). Spread
 * `handlers` on the element that holds the controls and render `peek`
 * beside it.
 */
export function useRailLabelPeek() {
  const [peek, setPeek] = useState<Peek | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPeek(null);
  }, []);

  const press = useLongPress((target) => {
    const control =
      target instanceof Element
        ? target.closest<HTMLElement>("button, [role='button']")
        : null;
    const text = control ? iconOnlyLabel(control) : null;
    if (!control || !text) return;
    const rect = control.getBoundingClientRect();
    if (timerRef.current != null) clearTimeout(timerRef.current);
    setPeek({
      text,
      centerX: rect.left + rect.width / 2,
      bottom: window.innerHeight - rect.top,
    });
    timerRef.current = setTimeout(clear, PEEK_MS);
  });

  useLayoutEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  // Any press ends a showing label, so it never lingers into another gesture.
  useEffect(() => {
    if (!peek) return;
    window.addEventListener("pointerdown", clear, true);
    return () => window.removeEventListener("pointerdown", clear, true);
  }, [peek, clear]);

  // Only an icon-only control arms the press, so a slow tap on a labelled
  // button (Import, Cut at playhead) still activates it.
  const handlers: LongPressHandlers = {
    ...press,
    onPointerDown: (event) => {
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("button, [role='button']")
          : null;
      if (control && iconOnlyLabel(control)) press.onPointerDown(event);
    },
  };

  return { handlers, peek };
}
