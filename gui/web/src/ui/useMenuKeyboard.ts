import { type RefObject, useEffect } from "react";
import { noteMenuOpen } from "./menuGate";
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
  panelRef,
  close,
  orientation = "vertical",
}: {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  close: () => void;
  orientation?: "vertical" | "horizontal";
}): void {
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

    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const first = menuItems(panel)[0] ?? listFocusable(panel)[0];
      if (first) {
        focusMenuItem(first);
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      const panel = panelRef.current;
      if (!panel || !panel.contains(document.activeElement)) {
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
    };

    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      // Take focus back only when it left with the panel. When another menu's
      // trigger took it (exclusive menus), stealing it back would make that
      // menu record this trigger as the place Escape returns to.
      const active = document.activeElement;
      const focusLost =
        !active || active === document.body || !active.isConnected;
      if (focusLost && restore?.isConnected) {
        restore.focus();
      }
    };
  }, [open, close, orientation, panelRef]);
}
