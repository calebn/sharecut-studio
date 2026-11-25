import type { AnchorRect } from "./anchoredPlacement";

export type Pin = {
  /** True when the anchor lies wholly outside the box. */
  readonly pinned: boolean;
  /** Where to place against: the visible part while attached, the nearest edge point once pinned. */
  readonly rect: AnchorRect;
};

/** Clamps `[lo, hi]` to `[min, max]`; a span wholly outside collapses onto the near edge. */
function clampSpan(lo: number, hi: number, min: number, max: number) {
  if (hi <= min) return [min, min] as const;
  if (lo >= max) return [max, max] as const;
  return [Math.max(lo, min), Math.min(hi, max)] as const;
}

/**
 * Whether `rect` has left `box`, and the rect to place a bar against. Any
 * overlap keeps the anchor attached. A zero or inverted box, or a node with no layout
 * (zero width and height), attaches, so a bar never pins on a measurement that is not there.
 */
export function pinOf(rect: AnchorRect, box: AnchorRect): Pin {
  if (box.right <= box.left || box.bottom <= box.top)
    return { pinned: false, rect };
  if (rect.left === rect.right && rect.top === rect.bottom)
    return { pinned: false, rect };
  const [left, right] = clampSpan(rect.left, rect.right, box.left, box.right);
  const [top, bottom] = clampSpan(rect.top, rect.bottom, box.top, box.bottom);
  const pinned =
    rect.bottom <= box.top ||
    rect.top >= box.bottom ||
    rect.right <= box.left ||
    rect.left >= box.right;
  return { pinned, rect: { left, top, right, bottom } };
}
