import { type RefObject, useEffect } from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

/** The tool rail's height (rem) on the root, for the compact inspector's slot (`bottom-sheet.css`). */
export const TOOL_RAIL_BLOCK_SIZE_VAR = "--tool-rail-block-size";

/**
 * The room (rem) the compact strip needs above the rail: its header and nudge
 * row, and a lane's height beside them. Less than this and the strip covers
 * the rail as it did before, rather than starve its own header and body at
 * large text on a phone held sideways.
 */
export const STRIP_SLOT_MIN_REM = 10;

/**
 * How far (rem) the compact strip stands clear of the screen's bottom edge so
 * it sits above the rail, or 0 when the screen has no room for both.
 */
export function toolRailInsetRem(measure: {
  viewportPx: number;
  railPx: number;
  /** The row under the rail: the phone's mode nav, or the status row. */
  bottomRowPx: number;
  rootPx: number;
}): number {
  const { viewportPx, railPx, bottomRowPx, rootPx } = measure;
  const slotPx = viewportPx - railPx - bottomRowPx;
  return slotPx >= STRIP_SLOT_MIN_REM * rootPx ? railPx / rootPx : 0;
}

function tokenPx(name: string, rootPx: number): number {
  const rem = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return (Number.isFinite(rem) ? rem : 0) * rootPx;
}

function publishToolRailInset(rail: HTMLElement | null): void {
  const root = document.documentElement;
  if (!rail) {
    root.style.removeProperty(TOOL_RAIL_BLOCK_SIZE_VAR);
    return;
  }
  const rootPx = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
  const phone = root.dataset.shell === "phone";
  const inset = toolRailInsetRem({
    viewportPx: window.innerHeight,
    railPx: rail.offsetHeight,
    bottomRowPx: tokenPx(
      phone ? "--mobile-nav-height" : "--status-height",
      rootPx,
    ),
    rootPx,
  });
  root.style.setProperty(TOOL_RAIL_BLOCK_SIZE_VAR, `${inset}rem`);
}

/**
 * Publishes the tool rail's height while it is shown and the screen has room.
 * The compact inspector is a fixed strip over the timeline; it leaves the
 * rail's row clear, so Undo and Redo stay visible and tappable beneath it
 * instead of under it.
 */
export function useToolRailBlockSize(
  railRef: RefObject<HTMLElement | null>,
): void {
  useResizeObserver(railRef, () => publishToolRailInset(railRef.current));
  useEffect(() => {
    const onResize = () => publishToolRailInset(railRef.current);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.documentElement.style.removeProperty(TOOL_RAIL_BLOCK_SIZE_VAR);
    };
  }, [railRef]);
}
