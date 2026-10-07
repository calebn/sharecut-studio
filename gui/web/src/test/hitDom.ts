/**
 * jsdom stand-ins for the timeline's hit targets: elements with a fixed box
 * (jsdom does no layout) and touch presses dispatched on them.
 */
import type { HitRect } from "../timeline/hitCandidates";

export function place(element: Element, r: HitRect): void {
  element.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
    }) as DOMRect;
}

export function button(
  attrs: Record<string, string>,
  r: HitRect,
): HTMLButtonElement {
  const el = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  place(el, r);
  return el;
}

export function surface(
  attrs: Record<string, string>,
  r: HitRect,
): HTMLDivElement {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  place(el, r);
  return el;
}

/** A pointer event (a touch by default) of `type` at (`x`, `y`), dispatched on `target`. */
export function press(
  target: Element,
  type: string,
  x: number,
  y: number,
  pointerId = 7,
  pointerType = "touch",
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType,
    isPrimary: pointerId === 7,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}
