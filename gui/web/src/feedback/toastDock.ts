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
  ".stage-frame-tabs",
  ".stage-frame-player",
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

type VerticalSpan = Readonly<{ top: number; bottom: number }>;
type HorizontalSpan = Readonly<{ left: number; right: number }>;
type MeasuredRect = VerticalSpan & HorizontalSpan;

/** Movable-control spans already intersect the card horizontally. */
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
  pressedPx?: { top: number; bottom: number } | null;
  /** Vertical extents of body controls the toast must clear (Listen's Play row). */
  keepClearPx?: readonly { top: number; bottom: number }[];
  /** Fields take priority over the ceiling and other controls when a clear position fits. */
  protectPx?: readonly { top: number; bottom: number }[];
};

/**
 * Where the toast's bottom edge goes, as a distance from the viewport
 * bottom. It docks just above the highest bottom chrome (an open sheet, the
 * tool rail, or the mode nav) when the band between that and the top
 * transport fits it, so it covers neither controls nor sheet fields. A
 * full-height sheet leaves no such band; the toast then sits above the rest
 * chrome, over the sheet's scrolling body, which the person can scroll past. If that spot covers the control just pressed or a
 * control that must stay clear (Listen's Play row on a short phone), the toast
 * moves just above it, or just below it when there is no room above; the first
 * spot that covers none of them wins. If no position fits, it keeps the original
 * resting position.
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
  // if the viewport allows, else at least the protected fields.
  for (const keep of [avoid, protectPx]) {
    const clearOfKept = (bottom: number) =>
      keep.every((extent) => clearOf(extent, bottom));
    const past = [
      spot,
      ...keep.map((extent) => extent.top - gapPx),
      ...keep.map((extent) => extent.bottom + gapPx + toastHeightPx),
    ].find(
      (bottom) =>
        bottom - toastHeightPx >= 0 &&
        bottom <= viewportHeight &&
        clearOfKept(bottom),
    );
    if (past !== undefined) return viewportHeight - past;
  }
  return viewportHeight - spot;
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

function spansAcrossCard(
  rects: readonly MeasuredRect[],
  card: HorizontalSpan,
): VerticalSpan[] {
  return rects
    .filter((rect) => rect.left < card.right && rect.right > card.left)
    .map(({ top, bottom }) => ({ top, bottom }));
}

function visibleRects(selectors: readonly string[]): MeasuredRect[] {
  return selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap(
      (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.width <= 0) return [];
        let { top, bottom, left, right } = rect;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const style = getComputedStyle(a);
          const box = a.getBoundingClientRect();
          if (style.overflowX !== "visible") {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
          if (style.overflowY !== "visible") {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
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
      const cardRect = card.getBoundingClientRect();
      const pressed = phone ? pressedExtent() : null;
      const phoneOnly = phone
        ? {
            ceilingPx: Math.max(
              0,
              ...shownRects(CEILING_SELECTORS).map((rect) => rect.bottom),
            ),
            floorTopsPx: shownRects(FLOOR_SELECTORS).map((rect) => rect.top),
            pressedPx:
              spansAcrossCard(pressed ? [pressed] : [], cardRect)[0] ?? null,
            keepClearPx: spansAcrossCard(
              shownRects(KEEP_CLEAR_SELECTORS),
              cardRect,
            ),
          }
        : { ceilingPx: 0, floorTopsPx: [], pressedPx: null, keepClearPx: [] };
      const bottomPx = toastDockBottomPx({
        viewportHeight: window.innerHeight,
        restTopPx: restTop(rest),
        toastHeightPx: cardRect.height,
        gapPx: gapRem * rootPx,
        ...phoneOnly,
        protectPx: spansAcrossCard(visibleRects(PROTECT_SELECTORS), cardRect),
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
