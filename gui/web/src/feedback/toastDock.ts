import { type RefObject, useLayoutEffect } from "react";
import { lastPressedRect } from "../ui/pressedControl";

/**
 * Phone chrome docked to the bottom edge. The toast sits above the highest of
 * these that is shown: the mode nav, Listen's comment field, the Timeline tool
 * rail, an open join's crossfade rail, or an open sheet.
 */
const FLOOR_SELECTORS = [
  ".mobile-nav",
  ".mobile-dock",
  ".daw-shell--phone .editing-tool-rail",
  ".join-edit-rail",
  ".bottom-sheet:not(.bottom-sheet--column)",
] as const;

/**
 * Controls that sit in the page body and that a toast must not cover: Listen's
 * Play row. On a short phone the band above the bottom chrome is only just
 * taller than the toast, so docking there would land on them.
 */
const KEEP_CLEAR_SELECTORS = [".listen-hero-controls"] as const;

/**
 * Fields a toast must never cover, on any shell: the comment composer, the
 * Commenting as line, its Change field and the guest name step. A person types
 * into these right after the toast that reports their post appears, so it
 * moves even when that means covering other content (#2199).
 */
const PROTECT_SELECTORS = [
  ".comment-compose",
  ".comment-author-line",
  ".comment-author-edit",
  ".comment-name-step",
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
  /**
   * Top of the chrome the toast rests above when no free band fits: the mode
   * nav on a phone, the status bar on a tablet or desktop.
   */
  restTopPx: number;
  toastHeightPx: number;
  gapPx: number;
  /**
   * Vertical extent of the control just pressed (outside the toast), so the
   * toast that reports it does not cover it, e.g. "Move track down" in a full
   * sheet.
   */
  pressedPx?: { top: number; bottom: number } | null;
  /** Vertical extents of body controls the toast must clear (Listen's Play row). */
  keepClearPx?: readonly { top: number; bottom: number }[];
  /**
   * Vertical extents of fields the toast must never cover (the comment
   * composer and name step). Unlike `keepClearPx` they win over the ceiling:
   * on a window too short for a free band the toast covers the content above
   * them instead.
   */
  protectPx?: readonly { top: number; bottom: number }[];
};

/**
 * Where the phone toast's bottom edge goes, as a distance from the viewport
 * bottom. It docks just above the highest bottom chrome (an open sheet, the
 * tool rail, or the mode nav) when the band between that and the top
 * transport fits it, so it covers neither controls nor sheet fields. A
 * full-height sheet leaves no such band; the toast then sits above the rest
 * chrome (mode nav or status bar), over the sheet's scrolling body, which the
 * person can scroll past. If that spot covers the control just pressed or a
 * control that must stay clear (Listen's Play row on a short phone), the toast
 * moves just above it, or just below it when there is no room above; the first
 * spot that covers none of them wins. A protected field (the comment composer
 * or name step) is cleared even when that leaves no room under the ceiling: the
 * toast then goes above it or below it and covers other content instead.
 */
export function toastDockBottomPx({
  viewportHeight,
  ceilingPx,
  floorTopsPx,
  restTopPx,
  toastHeightPx,
  gapPx,
  pressedPx,
  keepClearPx = [],
  protectPx = [],
}: ToastDockInput): number {
  const floor = Math.min(restTopPx, ...floorTopsPx);
  const fits = floor - ceilingPx >= toastHeightPx + 2 * gapPx;
  const dockBottom = fits ? floor : restTopPx;
  const spot = dockBottom - gapPx;
  const avoid = [
    ...(pressedPx ? [pressedPx] : []),
    ...keepClearPx,
    ...protectPx,
  ];
  const clearOf = (extent: { top: number; bottom: number }, bottom: number) =>
    extent.top >= bottom || extent.bottom <= bottom - toastHeightPx;
  const clear = (bottom: number) =>
    avoid.every((extent) => clearOf(extent, bottom));
  if (clear(spot)) {
    return viewportHeight - spot;
  }
  const above = avoid
    .map((extent) => extent.top - gapPx)
    .filter(
      (bottom) => bottom <= spot && bottom - toastHeightPx >= ceilingPx + gapPx,
    );
  const below = avoid
    .map((extent) => extent.bottom + gapPx + toastHeightPx)
    .filter(
      (bottom) =>
        bottom <= restTopPx - gapPx && bottom - toastHeightPx >= ceilingPx,
    );
  const moved = [...above, ...below].find(clear);
  if (moved !== undefined) return viewportHeight - moved;
  const clearOfProtected = (bottom: number) =>
    protectPx.every((extent) => clearOf(extent, bottom));
  if (protectPx.length === 0 || clearOfProtected(spot)) {
    return viewportHeight - spot;
  }
  const protectedSpot = [
    ...protectPx.map((extent) => extent.top - gapPx),
    ...protectPx.map((extent) => extent.bottom + gapPx + toastHeightPx),
  ].find(
    (bottom) =>
      bottom - toastHeightPx >= 0 &&
      bottom <= viewportHeight &&
      clearOfProtected(bottom),
  );
  return viewportHeight - (protectedSpot ?? spot);
}

function shownRects(selectors: readonly string[]): DOMRect[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.height > 0 && rect.width > 0),
  );
}

/** Where the toast rests: the mode nav's top on a phone, the status bar's elsewhere. A chrome row that is hidden leaves the viewport bottom. */
function restTop(chrome: HTMLElement): number {
  const rect = chrome.getBoundingClientRect();
  return rect.height > 0 ? rect.top : window.innerHeight;
}

/**
 * Vertical extents of the matching elements as the person can see them: each
 * one is clipped by every scrolling ancestor, so a composer scrolled out of
 * its panel does not count and a half-visible one counts for the visible part.
 */
function visibleExtents(
  selectors: readonly string[],
): { top: number; bottom: number }[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap(
      (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.width <= 0) return [];
        let { top, bottom } = rect;
        for (let a = el.parentElement; a; a = a.parentElement) {
          if (getComputedStyle(a).overflowY === "visible") continue;
          const box = a.getBoundingClientRect();
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        }
        return bottom > top ? [{ top, bottom }] : [];
      },
    ),
  );
}

/** Where the person just pressed a control (not Undo or Dismiss in a toast). */
function pressedExtent(): DOMRect | null {
  const rect = lastPressedRect();
  return rect && rect.height > 0 && rect.width > 0 ? rect : null;
}

/**
 * While a toast shows, keep its region's `--toast-dock-bottom` (rem) on
 * `toastDockBottomPx`, re-measured every frame like an open menu, so a sheet
 * opening, resizing or closing, or a comment field growing under it, moves it.
 * The phone shell docks it above its bottom chrome and clear of the pressed
 * control and Play row; every shell keeps it off the comment composer and name
 * step, resting above the status bar (tablet, desktop) or mode nav (phone)
 * otherwise.
 */
export function useToastDock(
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
      const rest = document.querySelector(
        phone ? ".mobile-nav" : ".status-bar",
      );
      const card = region.firstElementChild;
      if (!(rest instanceof HTMLElement) || !card) {
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
        ceilingPx: phone
          ? Math.max(
              0,
              ...shownRects(CEILING_SELECTORS).map((rect) => rect.bottom),
            )
          : 0,
        floorTopsPx: phone
          ? shownRects(FLOOR_SELECTORS).map((rect) => rect.top)
          : [],
        restTopPx: restTop(rest),
        toastHeightPx: card.getBoundingClientRect().height,
        gapPx: gapRem * rootPx,
        pressedPx: phone ? pressedExtent() : null,
        keepClearPx: phone ? shownRects(KEEP_CLEAR_SELECTORS) : [],
        protectPx: visibleExtents(PROTECT_SELECTORS),
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
