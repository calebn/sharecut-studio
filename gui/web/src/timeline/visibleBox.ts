import type { Bounds } from "../stages/edit/createMenuLayout";

/** The part of `element` inside the viewport (the viewport if none). */
export function visibleBox(element: Element | null): Bounds {
  const r = element?.getBoundingClientRect();
  return {
    left: Math.max(0, r?.left ?? 0),
    top: Math.max(0, r?.top ?? 0),
    right: Math.min(window.innerWidth, r?.right ?? Number.POSITIVE_INFINITY),
    bottom: Math.min(window.innerHeight, r?.bottom ?? Number.POSITIVE_INFINITY),
  };
}
