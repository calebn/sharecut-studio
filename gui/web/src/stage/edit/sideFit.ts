import { useCallback, useLayoutEffect, useState } from "react";
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

/**
 * An unseen element one rem wide in the workspace. A text-size change leaves
 * the workspace's own width as it was while every rem token grows, so only a
 * box that tracks the root font size can say the tokens moved.
 */
function useRemProbe(root: Element | null): Element | null {
  const [probe, setProbe] = useState<Element | null>(null);
  useLayoutEffect(() => {
    if (!root) {
      return;
    }
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;inline-size:1rem;block-size:0";
    root.appendChild(el);
    setProbe(el);
    return () => {
      el.remove();
      setProbe(null);
    };
  }, [root]);
  return probe;
}

/**
 * Watches the workspace's inline size and the root text size, and says which
 * pane yields.
 */
export function useSideYield(
  root: Element | null,
  inspectorOpen: boolean,
  scriptFocus: boolean,
): SideYield {
  const [sizes, setSizes] = useState<SideSizes | null>(null);
  const measure = useCallback(
    (entries: readonly ResizeObserverEntry[]) => {
      if (!root) {
        return;
      }
      // The probe reports a text-size change; the width is then the last one.
      const own = entries.findLast((entry) => entry.target === root);
      setSizes((prev) => {
        const inlinePx = own ? own.contentRect.width : prev?.inlinePx;
        if (inlinePx === undefined) {
          return prev;
        }
        const next = readSizes(root, inlinePx);
        return prev && JSON.stringify(prev) === JSON.stringify(next)
          ? prev
          : next;
      });
    },
    [root],
  );
  const probe = useRemProbe(root);
  useResizeObserver([root, probe], measure);
  return sizes ? sideYield(sizes, inspectorOpen, scriptFocus) : null;
}
