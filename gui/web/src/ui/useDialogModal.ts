import { type RefObject, useEffect, useRef } from "react";
import { cancelInlineConfirm } from "./inlineConfirmGate";
import { peekMenuOpen } from "./menuGate";
import { closeOverlay, isInnermostOverlay, openOverlay } from "./modalGate";
import { openerControl } from "./pressedControl";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function listFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if (el.closest("[inert]")) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

export type DialogModalMode = "modal" | "sheet";

export type UseDialogModalOptions = {
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Element focus returns to on close; default: the control that opened it
   * (`openerControl`: the focused one, or the one just clicked in Safari).
   * A popover passes its trigger, since another overlay closing in the same
   * commit may already have moved focus.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Element that should become inert while open (modal only). Default: [data-daw-app-chrome] */
  backgroundSelector?: string;
  /**
   * modal: Tab trap + inert chrome + Escape + restore.
   * sheet: Escape + initial focus + restore (no trap / inert) — peek BottomSheet.
   */
  mode?: DialogModalMode;
  /**
   * Keymap command ids this modal lets through (`modalGate`); every other app
   * shortcut is held while it is open.
   */
  shortcuts?: readonly string[];
};

/**
 * Overlay a11y without Radix.
 *
 * GOVERNANCE: installs a window keydown listener for Escape (+ Tab in modal) —
 * allowlisted via this module in commands/governance.test.ts. Each overlay
 * registers in `modalGate`: only the innermost overlay handles Escape, and
 * while a modal is open the Daw keymap runs none of its shortcuts but the
 * ones the modal hands on (`shortcuts`).
 */
export function useDialogModal({
  open,
  onClose,
  panelRef,
  initialFocusRef,
  returnFocusRef,
  backgroundSelector = "[data-daw-app-chrome]",
  mode = "modal",
  shortcuts,
}: UseDialogModalOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A string, so a caller's inline array does not reopen the overlay each render.
  const shortcutIds = shortcuts?.join(" ") ?? "";
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previous = openerControl();
    restoreFocusRef.current = previous;
    // Read once, not in the cleanup: the ref's value could differ by unmount time.
    const returnTarget = returnFocusRef?.current ?? null;
    const openedPanel = panelRef.current;

    const background =
      mode === "modal"
        ? document.querySelector<HTMLElement>(backgroundSelector)
        : null;
    if (background) {
      background.inert = true;
    }
    const layer = openOverlay(
      mode === "modal",
      shortcutIds ? shortcutIds.split(" ") : [],
    );

    const focusInitial = () => {
      const preferred = initialFocusRef?.current;
      if (preferred) {
        preferred.focus();
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      listFocusable(panel)[0]?.focus();
    };
    const raf = requestAnimationFrame(focusInitial);
    let escaped = false;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Open menus own Escape first (transport Menu over peek BottomSheet).
        if (peekMenuOpen()) {
          return;
        }
        // A dialog opened over this one (a confirm over a sheet) owns Escape.
        if (!isInnermostOverlay(layer)) {
          return;
        }
        e.preventDefault();
        // An open inline confirm is the innermost layer: Escape keeps (cancels) it.
        if (cancelInlineConfirm()) {
          return;
        }
        escaped = true;
        onCloseRef.current();
        return;
      }
      if (mode !== "modal" || e.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = listFocusable(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      if (background) {
        background.inert = false;
      }
      closeOverlay(layer);
      const restore = returnTarget ?? restoreFocusRef.current;
      const active = document.activeElement;
      const movedOutsideSheet =
        mode === "sheet" &&
        !escaped &&
        returnTarget == null &&
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== previous &&
        active.isConnected &&
        !openedPanel?.contains(active);
      if (restore?.isConnected && !movedOutsideSheet) {
        restore.focus();
      }
      restoreFocusRef.current = null;
    };
  }, [
    open,
    panelRef,
    initialFocusRef,
    returnFocusRef,
    backgroundSelector,
    mode,
    shortcutIds,
  ]);
}
