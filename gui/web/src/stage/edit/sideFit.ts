import { useCallback, useState } from "react";
import { useResizeObserver } from "../../ui/useResizeObserver";

/** Which pane steps aside when the side layout cannot hold them all. */
export type SideYield = "script" | "inspector" | null;

export interface SideSizes {
  inlinePx: number;
  /** The lanes' own floor; the track headers come on top of it. */
  lanePx: number;
  headersPx: number;
  scriptPx: number;
  inspectorPx: number;
  dividerPx: number;
}

/** A token's length in px; rem tracks the root font size. NaN when not a length. */
export function lengthPx(value: string, rootPx: number): number {
  const m = /^\s*(-?\d*\.?\d+)(rem|px)\s*$/.exec(value);
  if (!m) {
    return Number.NaN;
  }
  return Number(m[1]) * (m[2] === "rem" ? rootPx : 1);
}

/**
 * The pane that yields when the track headers, the lanes, the Script's floor,
 * the divider and the Inspector column do not fit the workspace. With Script
 * focus the lanes are hidden, so only the Script and the Inspector compete,
 * and the Inspector is the one to go. An unmeasured size never yields.
 */
export function sideYield(
  sizes: SideSizes,
  inspectorOpen: boolean,
  scriptFocus: boolean,
): SideYield {
  if (!inspectorOpen) {
    return null;
  }
  const { inlinePx, lanePx, headersPx, scriptPx, inspectorPx, dividerPx } =
    sizes;
  const need = scriptFocus
    ? scriptPx + inspectorPx
    : headersPx + lanePx + scriptPx + dividerPx + inspectorPx;
  if (!(inlinePx > 0) || Number.isNaN(need) || inlinePx >= need) {
    return null;
  }
  return scriptFocus ? "inspector" : "script";
}

function readSizes(el: Element, inlinePx: number): SideSizes {
  const rootPx = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const token = (name: string) =>
    lengthPx(getComputedStyle(el).getPropertyValue(name), rootPx);
  return {
    inlinePx,
    lanePx: token("--stage-lane-min"),
    headersPx: token("--header-width"),
    scriptPx: token("--stage-script-floor"),
    inspectorPx: token("--inspector-width"),
    dividerPx: token("--space-3"),
  };
}

/** Watches the workspace's inline size and says which pane yields. */
export function useSideYield(
  root: Element | null,
  inspectorOpen: boolean,
  scriptFocus: boolean,
): SideYield {
  const [sizes, setSizes] = useState<SideSizes | null>(null);
  const measure = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      const entry = entries[entries.length - 1];
      if (!root || !entry) {
        return;
      }
      const next = readSizes(root, entry.contentRect.width);
      setSizes((prev) =>
        prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    },
    [root],
  );
  useResizeObserver(root, measure);
  return sizes ? sideYield(sizes, inspectorOpen, scriptFocus) : null;
}
