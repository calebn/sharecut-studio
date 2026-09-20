import { type RefObject, useEffect, useRef } from "react";
import { peekMenuOpen } from "./menuGate";

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
  /** Element that should become inert while open (modal only). Default: [data-daw-app-chrome] */
  backgroundSelector?: string;
  /**
   * modal: Tab trap + inert chrome + Escape + restore.
   * sheet: Escape + initial focus + restore (no trap / inert) — peek BottomSheet.
   */
  mode?: DialogModalMode;
};

/**
 * Overlay a11y without Radix.
 *
 * GOVERNANCE: installs a window keydown listener for Escape (+ Tab in modal) —
 * allowlisted via this module in commands/governance.test.ts.
 */
export function useDialogModal({
  open,
  onClose,
  panelRef,
  initialFocusRef,
  backgroundSelector = "[data-daw-app-chrome]",
  mode = "modal",
}: UseDialogModalOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    restoreFocusRef.current = previous;

    const background =
      mode === "modal"
        ? document.querySelector<HTMLElement>(backgroundSelector)
        : null;
    if (background) {
      background.inert = true;
    }

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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Open menus own Escape first (transport Menu over peek BottomSheet).
        if (peekMenuOpen()) {
          return;
        }
        e.preventDefault();
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
      const restore = restoreFocusRef.current;
      if (restore?.isConnected) {
        restore.focus();
      }
      restoreFocusRef.current = null;
    };
  }, [open, panelRef, initialFocusRef, backgroundSelector, mode]);
}
