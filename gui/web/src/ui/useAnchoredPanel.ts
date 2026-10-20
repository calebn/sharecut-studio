import { type RefObject, useLayoutEffect } from "react";
import { useStableCallback } from "../utils/useStableCallback";
import { placeAnchored, visualViewportBox } from "./anchoredPlacement";
import { useResizeObserver } from "./useResizeObserver";

/** Where an anchored `Dialog` sits: beside `ref`, clear of `avoidRef`. */
export type DialogAnchor = {
  /** The element the dialog is about, which stays visible and unobscured. */
  ref: RefObject<HTMLElement | null>;
  /** Chrome the panel must not cover (the timeline's endpoint rail). */
  avoidRef?: RefObject<HTMLElement | null>;
  /** A value that moves the anchor without a scroll or resize, such as the seam time. */
  moves?: unknown;
  /** Why this dialog is not a bottom sheet on phone and tablet. */
  reason: string;
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
    const { left, top } = placeAnchored(
      anchorEl.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      visualViewportBox(avoidRef?.current ?? null),
      { margin: 0.5 * rootPx, gap: 0.5 * rootPx, align: "center" },
    );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  });

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, moves, place]);
  useResizeObserver(panelRef, place, active);
  useResizeObserver(avoidRef, place, active);
}
