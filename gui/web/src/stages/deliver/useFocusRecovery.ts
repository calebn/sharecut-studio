import { useEffect, useLayoutEffect, useRef } from "react";

type Lost = {
  el: Element;
  key: string | null;
  list: string | null;
  index: number;
};

const FOCUSABLE = "input, button, [tabindex]";

/**
 * Keeps keyboard focus inside the stage when the focused control goes away or
 * disables. It lands on an element with the same `data-focus-key`, else the item
 * now at the same place in the same `data-focus-list`, else the stage root.
 */
export function useFocusRecovery(root: HTMLElement | null): void {
  const last = useRef<Lost | null>(null);

  useEffect(() => {
    if (!root) return;
    const remember = (event: FocusEvent) => {
      const el = event.target;
      if (!(el instanceof Element) || el === root) return;
      const list = el.closest<HTMLElement>("[data-focus-list]");
      const item = list ? el.closest("li") : null;
      last.current = {
        el,
        key:
          el.closest("[data-focus-key]")?.getAttribute("data-focus-key") ??
          null,
        list: list?.getAttribute("data-focus-list") ?? null,
        index: item && list ? [...list.children].indexOf(item) : 0,
      };
    };
    root.addEventListener("focusin", remember);
    return () => root.removeEventListener("focusin", remember);
  }, [root]);

  useLayoutEffect(() => {
    const lost = last.current;
    if (!root || !lost) return;
    const gone =
      !lost.el.isConnected ||
      (lost.el instanceof HTMLButtonElement && lost.el.disabled);
    const active = root.ownerDocument.activeElement;
    if (!gone || (active && active !== root.ownerDocument.body)) return;
    last.current = null;
    const byKey = lost.key
      ? root.querySelector<HTMLElement>(`[data-focus-key="${lost.key}"]`)
      : null;
    if (byKey) return byKey.focus({ preventScroll: true });
    const list = lost.list
      ? root.querySelector(`[data-focus-list="${lost.list}"]`)
      : null;
    const items = list ? [...list.children] : [];
    const near = items[Math.min(lost.index, items.length - 1)];
    const target =
      near?.querySelector<HTMLElement>(FOCUSABLE) ??
      list?.closest("section")?.querySelector<HTMLElement>("button");
    (target ?? root).focus({ preventScroll: true });
  });
}
