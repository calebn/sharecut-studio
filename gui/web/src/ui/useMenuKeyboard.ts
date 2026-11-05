import { type RefObject, useEffect, useEffectEvent } from "react";
import { noteMenuOpen } from "./modalGate";
import { openerControl } from "./pressedControl";
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

export function focusFirstMenuItem(panel: HTMLElement): void {
  const first = menuItems(panel)[0] ?? listFocusable(panel)[0];
  if (first) focusMenuItem(first);
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
    focusFirstMenuItem(panel);
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
    const restore = openerControl();
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

/**
 * Keyboard contract of a non-modal popover that holds controls rather than
 * menu items: while focus is inside `panelRef`, Escape closes it and Tab out of
 * either end closes it (the caller returns focus to its trigger). Focus moving
 * from the panel to an element outside it and its trigger (a dialog or the
 * palette that a shortcut opened) closes it too, so no stale popover is left
 * unreachable by keyboard. Unlike a
 * menu it leaves the Daw shortcuts running. Both keys are taken in the capture
 * phase and stopped, so a modal Dialog around the trigger (the Tools sheet on
 * a short desktop frame) neither closes nor pulls focus back into itself
 * behind the popover. Escape typed in a text field inside the panel is left to
 * that field, which uses it to revert its edit.
 * GOVERNANCE: window keydown — allowlisted via this module.
 */
export function usePopoverKeyboard({
  panelRef,
  anchorRef,
  close,
  closeAway,
}: {
  panelRef: RefObject<HTMLElement | null>;
  /** The trigger: focus moving to it is not "away". */
  anchorRef: RefObject<HTMLElement | null>;
  /** Escape and Tab out of an end: the caller returns focus to its trigger. */
  close: () => void;
  /** Focus moved to another element (a dialog, the palette): close in place. */
  closeAway: () => void;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      const active = document.activeElement;
      if (!panel || !active || !panel.contains(active)) {
        return;
      }
      if (e.key === "Escape") {
        if (e.target instanceof HTMLInputElement) {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (e.key !== "Tab") {
        return;
      }
      e.stopImmediatePropagation();
      const stops = listFocusable(panel);
      const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
      if (active === edge) {
        e.preventDefault();
        close();
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      const panel = panelRef.current;
      const next = e.relatedTarget;
      if (
        panel &&
        next instanceof Node &&
        !panel.contains(next) &&
        !anchorRef.current?.contains(next)
      ) {
        closeAway();
      }
    };
    const panel = panelRef.current;
    window.addEventListener("keydown", onKey, true);
    panel?.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      panel?.removeEventListener("focusout", onFocusOut);
    };
  }, [panelRef, anchorRef, close, closeAway]);
}
