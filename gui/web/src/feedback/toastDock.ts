import { type RefObject, useLayoutEffect } from "react";
import { lastPressedRect } from "../ui/pressedControl";

/**
 * Phone chrome docked to the bottom edge. The toast sits above the highest of
 * these that is shown: the mode nav, the Timeline tool rail, an open join's
 * crossfade rail, or an open sheet.
 */
const FLOOR_SELECTORS = [
  ".mobile-nav",
  ".daw-shell--phone .editing-tool-rail",
  ".join-edit-rail",
  ".bottom-sheet",
] as const;

/** Phone chrome docked to the top edge; the toast stays below it. */
const CEILING_SELECTORS = [
  ".daw-shell--phone .daw-shell-transport",
  ".daw-shell--phone .mobile-status-row",
] as const;

export type ToastDockInput = {
  viewportHeight: number;
  /** Bottom of the lowest top-docked control row (transport, status row). */
  ceilingPx: number;
  /** Tops of the bottom-docked chrome that is shown (nav, tool rail, sheet). */
  floorTopsPx: readonly number[];
  /** Top of the mode nav: the floor when no free band fits the toast. */
  navTopPx: number;
  toastHeightPx: number;
  gapPx: number;
  /**
   * Vertical extent of the control just pressed (outside the toast), so the
   * toast that reports it does not cover it, e.g. "Move track down" in a full
   * sheet.
   */
  pressedPx?: { top: number; bottom: number } | null;
};

/**
 * Where the phone toast's bottom edge goes, as a distance from the viewport
 * bottom. It docks just above the highest bottom chrome (an open sheet, the
 * tool rail, or the mode nav) when the band between that and the top
 * transport fits it, so it covers neither controls nor sheet fields. A
 * full-height sheet leaves no such band; the toast then sits above the mode
 * nav, over the sheet's scrolling body, which the person can scroll past. If
 * that spot covers the control just pressed, the toast moves just above that
 * control, or just below it when there is no room above.
 */
export function toastDockBottomPx({
  viewportHeight,
  ceilingPx,
  floorTopsPx,
  navTopPx,
  toastHeightPx,
  gapPx,
  pressedPx,
}: ToastDockInput): number {
  const floor = Math.min(navTopPx, ...floorTopsPx);
  const fits = floor - ceilingPx >= toastHeightPx + 2 * gapPx;
  const dockBottom = fits ? floor : navTopPx;
  const covers =
    pressedPx != null &&
    pressedPx.top < dockBottom - gapPx &&
    pressedPx.bottom > dockBottom - gapPx - toastHeightPx;
  if (!covers) {
    return viewportHeight - dockBottom + gapPx;
  }
  if (pressedPx.top - gapPx - toastHeightPx >= ceilingPx + gapPx) {
    return viewportHeight - pressedPx.top + gapPx;
  }
  if (pressedPx.bottom + gapPx + toastHeightPx <= navTopPx - gapPx) {
    return viewportHeight - (pressedPx.bottom + gapPx + toastHeightPx);
  }
  return viewportHeight - dockBottom + gapPx;
}

function shownRects(selectors: readonly string[]): DOMRect[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.height > 0 && rect.width > 0),
  );
}

/** Where the person just pressed a control (not Undo or Dismiss in a toast). */
function pressedExtent(): DOMRect | null {
  const rect = lastPressedRect();
  return rect && rect.height > 0 && rect.width > 0 ? rect : null;
}

/**
 * While a toast shows on the phone shell, keep its region's
 * `--toast-dock-bottom` (rem) on `toastDockBottomPx`, re-measured every frame
 * like an open menu, so a sheet opening, resizing or closing moves it.
 * Desktop and tablet keep the CSS placement above the status bar.
 */
export function usePhoneToastDock(
  regionRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!active || !region) return;
    let frame = 0;
    const layout = () => {
      frame = window.requestAnimationFrame(layout);
      const phone = document.documentElement.dataset.shell === "phone";
      const nav = document.querySelector(".mobile-nav");
      const card = region.firstElementChild;
      if (!phone || !(nav instanceof HTMLElement) || !card) {
        region.style.removeProperty("--toast-dock-bottom");
        return;
      }
      const rootStyle = getComputedStyle(document.documentElement);
      const rootPx = Number.parseFloat(rootStyle.fontSize) || 16;
      // The same gap the CSS placement uses: var(--space-3), in rem.
      const gapRem =
        Number.parseFloat(rootStyle.getPropertyValue("--space-3")) || 0.5;
      const bottomPx = toastDockBottomPx({
        viewportHeight: window.innerHeight,
        ceilingPx: Math.max(
          0,
          ...shownRects(CEILING_SELECTORS).map((rect) => rect.bottom),
        ),
        floorTopsPx: shownRects(FLOOR_SELECTORS).map((rect) => rect.top),
        navTopPx: nav.getBoundingClientRect().top,
        toastHeightPx: card.getBoundingClientRect().height,
        gapPx: gapRem * rootPx,
        pressedPx: pressedExtent(),
      });
      const value = `${bottomPx / rootPx}rem`;
      if (region.style.getPropertyValue("--toast-dock-bottom") !== value) {
        region.style.setProperty("--toast-dock-bottom", value);
      }
    };
    layout();
    return () => {
      window.cancelAnimationFrame(frame);
      region.style.removeProperty("--toast-dock-bottom");
    };
  }, [regionRef, active]);
}
