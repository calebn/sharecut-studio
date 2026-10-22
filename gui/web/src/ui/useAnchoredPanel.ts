import { type RefObject, useLayoutEffect } from "react";
import { useStableCallback } from "../utils/useStableCallback";
import {
  placeAnchored,
  placeAnchoredClear,
  unionRect,
  visualViewportBox,
} from "./anchoredPlacement";
import { useResizeObserver } from "./useResizeObserver";

/** Where an anchored `Dialog` sits: beside `ref`, clear of `avoidRef`. */
export type DialogAnchor = {
  /**
   * Why this dialog stays a panel beside its subject instead of becoming a
   * sheet on phone and tablet. Written at the call site; `dialogSheet.test.ts`
   * fails an anchor without one.
   */
  reason: string;
  /** The element the dialog is about, which stays visible and unobscured. */
  ref: RefObject<HTMLElement | null>;
  /** Chrome the panel must not cover (the timeline's endpoint rail). */
  avoidRef?: RefObject<HTMLElement | null>;
  /** A control the panel must never cover (the join popover's length grip). */
  clearRef?: RefObject<HTMLElement | null>;
  /** A value that moves the anchor without a scroll or resize, such as the seam time. */
  moves?: unknown;
};

/**
 * Keeps `panelRef` fixed beside `anchor` while `enabled`: on mount, when the
 * window resizes or anything scrolls, when the panel or the avoided chrome
 * resizes (a mode change adds a row), and when `anchor.moves` changes.
 */
export function useAnchoredPanel(
  panelRef: RefObject<HTMLElement | null>,
  anchor: DialogAnchor | undefined,
  enabled: boolean,
): void {
  const anchorRef = anchor?.ref;
  const avoidRef = anchor?.avoidRef;
  const clearRef = anchor?.clearRef;
  const moves = anchor?.moves;
  const active = enabled && anchorRef != null;

  const place = useStableCallback(() => {
    const anchorEl = anchorRef?.current;
    const panel = panelRef.current;
    if (!anchorEl || !panel) {
      return;
    }
    const rootPx =
      Number.parseFloat(
        getComputedStyle(panel.ownerDocument.documentElement).fontSize,
      ) || 16;
    const anchorRect = anchorEl.getBoundingClientRect();
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const options = {
      margin: 0.5 * rootPx,
      gap: 0.5 * rootPx,
      align: "center",
    } as const;
    const clearEl = clearRef?.current;
    const placed = clearEl
      ? placeAnchoredClear(
          anchorRect,
          size,
          visualViewportBox(null),
          avoidRef?.current?.getBoundingClientRect().top ?? null,
          unionRect(anchorRect, clearEl.getBoundingClientRect()),
          { ...options, minWidth: 12 * rootPx },
        )
      : placeAnchored(
          anchorRect,
          size,
          visualViewportBox(avoidRef?.current ?? null),
          options,
        );
    panel.style.left = `${placed.left}px`;
    panel.style.top = `${placed.top}px`;
    panel.style.maxHeight = `${placed.maxHeight}px`;
    panel.style.maxWidth = `${placed.maxWidth}px`;
    panel.style.minWidth = `min(15rem, ${placed.maxWidth}px)`;
  });

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    place();
    // The grip is positioned by a later layout effect than this one.
    const frame = clearRef ? requestAnimationFrame(place) : 0;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, moves, place, clearRef]);
  useResizeObserver(panelRef, place, active);
  useResizeObserver(avoidRef, place, active);
  useResizeObserver(clearRef, place, active);
}
