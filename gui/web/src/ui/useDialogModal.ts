import { type RefObject, useEffect, useRef } from "react";
import { useStableCallback } from "../utils/useStableCallback";
import { focusHeld } from "./focusHold";
import { isValidFocusTarget } from "./focusTarget";
import { cancelInlineConfirm } from "./inlineConfirmGate";
import {
  claimEscape,
  closeOverlay,
  focusInnermostOverlay,
  isInnermostOverlay,
  menuOpen,
  openOverlay,
} from "./modalGate";
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
  stackKey?: string;
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
  stackKey,
}: UseDialogModalOptions): void {
  const close = useStableCallback(onClose);
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
    const focusInitial = () => {
      const panel = panelRef.current;
      if (
        !isInnermostOverlay(layer) ||
        !panel ||
        panel !== openedPanel ||
        !panel.isConnected ||
        panel.closest("[inert]")
      ) {
        return;
      }
      if (mode === "sheet" && focusHeld(panel.ownerDocument)) return;
      const active = panel.ownerDocument.activeElement;
      if (
        mode === "sheet" &&
        active instanceof HTMLElement &&
        panel.contains(active) &&
        isValidFocusTarget(active) &&
        active.closest(".pending-actionbar-host, .pending-actionbar")
      ) {
        return;
      }
      const preferred = initialFocusRef?.current;
      if (preferred) {
        preferred.focus();
        return;
      }
      listFocusable(panel)[0]?.focus();
    };
    const layer = openOverlay(
      mode === "modal",
      shortcutIds ? shortcutIds.split(" ") : [],
      focusInitial,
      stackKey,
    );
    const raf = requestAnimationFrame(focusInitial);
    let escaped = false;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Open menus own Escape first (transport Menu over peek BottomSheet).
        if (menuOpen()) {
          return;
        }
        // A dialog opened over this one (a confirm over a sheet) owns Escape.
        if (!isInnermostOverlay(layer) || !claimEscape(e)) {
          return;
        }
        e.preventDefault();
        // An open inline confirm is the innermost layer: Escape keeps (cancels) it.
        if (cancelInlineConfirm()) {
          return;
        }
        escaped = true;
        close();
        return;
      }
      if (mode !== "modal" || e.key !== "Tab" || !isInnermostOverlay(layer)) {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const items = listFocusable(panel);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      // The app toast stays in reach while the dialog traps Tab: its Undo is the
      // one way back from a step the dialog just took (Stop sharing). It joins
      // the cycle after the panel, wherever it sits in the document.
      const toast = document.querySelector<HTMLElement>(
        ".ui-toast-region--app.ui-toast-region--actionable",
      );
      const toastItems = toast ? listFocusable(toast) : [];
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      const inToast = !!toast?.contains(active);
      const inPanel = panel.contains(active);
      const go = (target: HTMLElement | undefined) => {
        e.preventDefault();
        target?.focus();
      };
      if (e.shiftKey) {
        if (inToast) {
          if (active === toastItems[0]) go(lastItem);
        } else if (!inPanel) go(lastItem);
        else if (active === firstItem) go(toastItems.at(-1) ?? lastItem);
      } else if (inToast) {
        if (active === toastItems.at(-1)) go(firstItem);
      } else if (!inPanel) go(firstItem);
      else if (active === lastItem) go(toastItems[0] ?? firstItem);
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
      const activeEl = active instanceof HTMLElement ? active : null;
      const movedOutsideSheet =
        mode === "sheet" &&
        !escaped &&
        returnTarget == null &&
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== previous &&
        active.isConnected &&
        !openedPanel?.contains(active);
      if (movedOutsideSheet) {
        restoreFocusRef.current = null;
        return;
      }
      const keepActive =
        !escaped &&
        returnTarget == null &&
        isValidFocusTarget(activeEl) &&
        activeEl !== document.body;
      if (!keepActive) {
        if (isValidFocusTarget(restore)) restore.focus();
        else if (
          !activeEl ||
          activeEl === document.body ||
          !isValidFocusTarget(activeEl)
        ) {
          focusInnermostOverlay();
        }
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
    stackKey,
    close,
  ]);
}
