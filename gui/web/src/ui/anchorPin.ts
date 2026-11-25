import type { AnchorRect } from "./anchoredPlacement";

export type PinEdge = "top" | "bottom" | "start" | "end";

export type Pin = {
  /** True when the anchor lies wholly outside the box. */
  readonly pinned: boolean;
  /** The side it left by; a corner reports the vertical side. Null while attached. */
  readonly edge: PinEdge | null;
  /** Where to place against: the visible part while attached, the nearest edge point once pinned. */
  readonly rect: AnchorRect | null;
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
export function pinOf(rect: AnchorRect | null, box: AnchorRect): Pin {
  if (rect === null) return { pinned: false, edge: null, rect: null };
  if (box.right <= box.left || box.bottom <= box.top)
    return { pinned: false, edge: null, rect };
  // A node with no size at all has no layout (hidden or not drawn yet).
  if (rect.left === rect.right && rect.top === rect.bottom)
    return { pinned: false, edge: null, rect };
  const above = rect.bottom <= box.top;
  const below = rect.top >= box.bottom;
  const before = rect.right <= box.left;
  const after = rect.left >= box.right;
  const [left, right] = clampSpan(rect.left, rect.right, box.left, box.right);
  const [top, bottom] = clampSpan(rect.top, rect.bottom, box.top, box.bottom);
  const clamped = { left, top, right, bottom };
  if (!(above || below || before || after))
    return { pinned: false, edge: null, rect: clamped };
  const edge = above ? "top" : below ? "bottom" : before ? "start" : "end";
  return { pinned: true, edge, rect: clamped };
}
