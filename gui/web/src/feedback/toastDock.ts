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

type Extent = { top: number; bottom: number };

export type ToastDockInput = {
  viewportHeight: number;
  /** Bottom of the lowest top-docked control row (transport, status row). */
  ceilingPx: number;
  /** Tops of the bottom-docked chrome that is shown (nav, tool rail, sheet). */
  floorTopsPx: readonly number[];
  /** Top of the chrome the toast rests above when no free band fits (mode nav on phone, status bar elsewhere). */
  restTopPx: number;
  toastHeightPx: number;
  gapPx: number;
  /**
   * Vertical extent of the control just pressed (outside the toast), so the
   * toast that reports it does not cover it, e.g. "Move track down" in a full
   * sheet.
   */
  pressedPx?: Extent | null;
  /** Vertical extents of body controls the toast must clear (Listen's Play row). */
  keepClearPx?: readonly Extent[];
  /** Fields the toast must never cover. Unlike keepClearPx they win over the ceiling. */
  protectPx?: readonly Extent[];
};

/**
 * Where the phone toast's bottom edge goes, as a distance from the viewport
 * bottom. It docks just above the highest bottom chrome (an open sheet, the
 * tool rail, or the mode nav) when the band between that and the top
 * transport fits it, so it covers neither controls nor sheet fields. A
 * full-height sheet leaves no such band; the toast then sits above the rest
 * chrome, over the sheet's scrolling body, which the person can scroll past. If that spot covers the control just pressed or a
 * control that must stay clear (Listen's Play row on a short phone), the toast
 * moves just above it, or just below it when there is no room above; the first
 * spot that covers none of them wins. If no spot clears a protected field, the
 * toast covers as little of the fields as it can above the rest chrome.
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
  if (protectPx.length === 0) return viewportHeight - spot;
  // Protected fields win over the ceiling: go past it, keeping everything clear
  // if the viewport allows, else at least the protected fields. The top edge is
  // a spot too, flush with no gap, for a field that starts just under the toast.
  const spotsAround = (extents: readonly Extent[]) => [
    spot,
    ...extents.map((extent) => extent.top - gapPx),
    ...extents.map((extent) => extent.bottom + gapPx + toastHeightPx),
    toastHeightPx,
  ];
  const onScreen = (bottom: number) =>
    bottom - toastHeightPx >= 0 && bottom <= viewportHeight;
  for (const keep of [avoid, protectPx]) {
    const past = spotsAround(keep).find(
      (bottom) =>
        onScreen(bottom) && keep.every((extent) => clearOf(extent, bottom)),
    );
    if (past !== undefined) return viewportHeight - past;
  }
  // No spot clears the fields: cover as little of them as possible, and never
  // the chrome the toast rests above.
  const covered = (extents: readonly Extent[], bottom: number) =>
    extents.reduce(
      (sum, extent) =>
        sum +
        Math.max(
          0,
          Math.min(extent.bottom, bottom) -
            Math.max(extent.top, bottom - toastHeightPx),
        ),
      0,
    );
  const [least = spot] = spotsAround(avoid)
    .filter((bottom) => onScreen(bottom) && bottom <= restTopPx)
    .sort(
      (a, b) =>
        covered(protectPx, a) - covered(protectPx, b) ||
        covered(avoid, a) - covered(avoid, b) ||
        Math.abs(a - spot) - Math.abs(b - spot),
    );
  return viewportHeight - least;
}

function shownRects(selectors: readonly string[]): DOMRect[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.height > 0 && rect.width > 0),
  );
}

/** A hidden chrome row leaves the viewport bottom. */
function restTop(chrome: HTMLElement): number {
  const rect = chrome.getBoundingClientRect();
  return rect.height > 0 ? rect.top : window.innerHeight;
}

/** Extents clipped by scrolling ancestors, so a field scrolled out of its panel does not count. */
function visibleExtents(
  selectors: readonly string[],
): (Extent & { left: number; right: number })[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap(
      (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.width <= 0) return [];
        let { top, bottom, left, right } = rect;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const { overflowX, overflowY } = getComputedStyle(a);
          if (overflowX === "visible" && overflowY === "visible") continue;
          const box = a.getBoundingClientRect();
          if (overflowY !== "visible") {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
          if (overflowX !== "visible") {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
        }
        return bottom > top && right > left
          ? [{ top, bottom, left, right }]
          : [];
      },
    ),
  );
}

/** Where the person just pressed a control (not Undo or Dismiss in a toast). */
function pressedExtent(): DOMRect | null {
  const rect = lastPressedRect();
  return rect && rect.height > 0 && rect.width > 0 ? rect : null;
}

/** Keeps the region's --toast-dock-bottom (rem) on toastDockBottomPx, re-measured every frame. */
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
      const phoneOnly = phone
        ? {
            ceilingPx: Math.max(
              0,
              ...shownRects(CEILING_SELECTORS).map((rect) => rect.bottom),
            ),
            floorTopsPx: shownRects(FLOOR_SELECTORS).map((rect) => rect.top),
            pressedPx: pressedExtent(),
            keepClearPx: shownRects(KEEP_CLEAR_SELECTORS),
          }
        : { ceilingPx: 0, floorTopsPx: [], pressedPx: null, keepClearPx: [] };
      const toast = card.getBoundingClientRect();
      const bottomPx = toastDockBottomPx({
        viewportHeight: window.innerHeight,
        restTopPx: restTop(rest),
        toastHeightPx: toast.height,
        gapPx: gapRem * rootPx,
        ...phoneOnly,
        protectPx: visibleExtents(PROTECT_SELECTORS).filter(
          (field) => field.left < toast.right && field.right > toast.left,
        ),
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
