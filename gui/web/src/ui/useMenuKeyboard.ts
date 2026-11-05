import { useEffect, useEffectEvent } from "react";
import { noteMenuOpen } from "./modalGate";
import { listFocusable } from "./useDialogModal";

function menuItems(panel: HTMLElement): HTMLElement[] {
  return listFocusable(panel).filter(
    (el) =>
      el.getAttribute("role") === "menuitem" ||
      el.getAttribute("role") === "menuitemcheckbox" ||
      el.getAttribute("role") === "menuitemradio",
  );
}

function focusMenuItem(el: HTMLElement): void {
  el.focus();
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/**
 * Keyboard and focus contract shared by every popup menu: while `open`, it
 * suppresses Daw shortcuts, focuses the first item, closes on Escape, moves
 * between items with the arrows for its orientation plus Home/End, and on
 * close returns focus to where it was if the focus left with the panel.
 * GOVERNANCE: window keydown — allowlisted via this module.
 */
export function useMenuKeyboard({
  open,
  panel,
  close,
  fallbackTrigger,
  orientation = "vertical",
}: {
  open: boolean;
  panel: HTMLElement | null;
  close: () => void;
  fallbackTrigger?: HTMLElement | null;
  orientation?: "vertical" | "horizontal";
}): void {
  const focusFirst = useEffectEvent(() => {
    if (!panel) return;
    const first = menuItems(panel)[0] ?? listFocusable(panel)[0];
    if (first) focusMenuItem(first);
  });
  const onKey = useEffectEvent(
    (
      e: KeyboardEvent,
      closeForSession: () => void,
      prevKey: string,
      nextKey: string,
    ) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeForSession();
        return;
      }
      if (!panel || !panel.contains(document.activeElement)) {
        return;
      }
      if (fallbackTrigger && e.key === "Tab") {
        const trigger = fallbackTrigger;
        const doc = panel.ownerDocument;
        const candidates = listFocusable(doc.body).filter((el) => {
          if (panel.contains(el) || el.tabIndex < 0) return false;
          for (
            let parent: HTMLElement | null = el;
            parent;
            parent = parent.parentElement
          ) {
            const style = doc.defaultView?.getComputedStyle(parent);
            if (
              parent.hidden ||
              parent.inert ||
              style?.display === "none" ||
              style?.visibility === "hidden"
            ) {
              return false;
            }
          }
          return true;
        });
        const ordered = candidates
          .map((el, index) => ({ el, index, tabIndex: el.tabIndex }))
          .sort((a, b) => {
            const aPositive = a.tabIndex > 0;
            const bPositive = b.tabIndex > 0;
            if (aPositive !== bPositive) return aPositive ? -1 : 1;
            if (aPositive && a.tabIndex !== b.tabIndex)
              return a.tabIndex - b.tabIndex;
            return a.index - b.index;
          })
          .map(({ el }) => el);
        const triggerIndex = ordered.indexOf(trigger);
        const target = e.shiftKey
          ? trigger
          : ordered[triggerIndex >= 0 ? triggerIndex + 1 : 0];
        e.preventDefault();
        closeForSession();
        target?.focus();
        return;
      }
      const items = menuItems(panel);
      if (items.length === 0) {
        return;
      }
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const target =
        e.key === nextKey
          ? items[(idx + 1 + items.length) % items.length]
          : e.key === prevKey
            ? items[(idx - 1 + items.length) % items.length]
            : e.key === "Home"
              ? items[0]
              : e.key === "End"
                ? items[items.length - 1]
                : null;
      if (target) {
        e.preventDefault();
        focusMenuItem(target);
      }
    },
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    noteMenuOpen(true);
    return () => {
      noteMenuOpen(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const restore =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const [prevKey, nextKey] =
      orientation === "vertical"
        ? ["ArrowUp", "ArrowDown"]
        : ["ArrowLeft", "ArrowRight"];

    const raf = requestAnimationFrame(() => focusFirst());

    const listener = (event: KeyboardEvent) =>
      onKey(event, close, prevKey, nextKey);

    window.addEventListener("keydown", listener);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", listener);
      // Take focus back only when it left with the panel. When another menu's
      // trigger took it (exclusive menus), stealing it back would make that
      // menu record this trigger as the place Escape returns to.
      const active = document.activeElement;
      const focusLost =
        !active || active === document.body || !active.isConnected;
      if (focusLost && restore?.isConnected && !restore.closest("[inert]")) {
        restore.focus();
      }
    };
  }, [open, close, orientation]);
}
