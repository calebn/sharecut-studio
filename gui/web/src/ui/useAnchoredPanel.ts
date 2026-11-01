import { type RefObject, useLayoutEffect } from "react";
import { useStableCallback } from "../utils/useStableCallback";
import {
  inlineSizeCaps,
  placeAnchored,
  placeAnchoredClear,
  placeAnchoredExcluding,
  unionRect,
  visualViewportBox,
} from "./anchoredPlacement";
import { useResizeObserver } from "./useResizeObserver";

export type AnchorExclusion = {
  ref: RefObject<HTMLElement | null>;
  withinRef: RefObject<HTMLElement | null>;
};

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
  exclusion?: AnchorExclusion;
  /** A value that moves the anchor without a scroll or resize, such as the seam time. */
  moves?: unknown;
  /** The side tried first; below unless the subject asks to be covered less from above. */
  prefer?: "below" | "above";
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
  const excludeRef = anchor?.exclusion?.ref;
  const withinRef = anchor?.exclusion?.withinRef;
  const moves = anchor?.moves;
  const prefer = anchor?.prefer;
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
    const scrollTop = panel.scrollTop;
    panel.style.maxHeight = "";
    panel.style.maxWidth = "";
    panel.style.minWidth = "";
    const anchorRect = anchorEl.getBoundingClientRect();
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const options = {
      margin: 0.5 * rootPx,
      gap: 0.5 * rootPx,
      align: "center",
      prefer,
    } as const;
    const clearEl = clearRef?.current;
    const excludedEl = excludeRef?.current;
    const withinEl = withinRef?.current;
    const placed = clearEl
      ? placeAnchoredClear(
          anchorRect,
          size,
          visualViewportBox(null),
          avoidRef?.current?.getBoundingClientRect().top ?? null,
          unionRect(anchorRect, clearEl.getBoundingClientRect()),
          { ...options, minWidth: 12 * rootPx },
        )
      : excludedEl && withinEl
        ? placeAnchoredExcluding(
            anchorRect,
            size,
            visualViewportBox(avoidRef?.current ?? null),
            excludedEl.getBoundingClientRect(),
            withinEl.getBoundingClientRect(),
            options,
          )
        : placeAnchored(
            anchorRect,
            size,
            visualViewportBox(avoidRef?.current ?? null),
            options,
          );
    panel.style.left = `${placed.left}px`;
    panel.style.top = `${placed.top}px`;
    const caps = inlineSizeCaps(placed, size);
    if (caps) {
      panel.style.maxHeight = `${caps.maxHeight}px`;
      panel.style.maxWidth = `${caps.maxWidth}px`;
      panel.style.minWidth = `min(15rem, ${caps.maxWidth}px)`;
      panel.scrollTop = scrollTop;
    }
  });

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    place();
    const frame = clearRef ? requestAnimationFrame(place) : 0;
    window.addEventListener("resize", place);
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [active, moves, place, clearRef, excludeRef, withinRef, panelRef]);
  useResizeObserver(panelRef, place, active);
  useResizeObserver(avoidRef, place, active);
  useResizeObserver(clearRef, place, active);
  useResizeObserver(excludeRef, place, active);
  useResizeObserver(withinRef, place, active);
}
