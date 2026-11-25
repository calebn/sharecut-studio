import type { RefObject } from "react";
import { revealLane } from "../stage/edit/useRevealEditedLane";
import { useDawStore } from "../state/dawStore";
import { clamp } from "./math";
import { timelineHeaderOffsetWidth } from "./timelineViewport";

let current: RefObject<HTMLElement | null> | null = null;

/**
 * The anchor node of the selection whose Action bar is on screen, which
 * `view.revealSelection` brings back. The bar sets it; a command has no other
 * way to name a node.
 */
export const selectionAnchor = {
  set(ref: RefObject<HTMLElement | null>) {
    current = ref;
  },
  /** Drops `ref` only if it is still the registered one. */
  release(ref: RefObject<HTMLElement | null>) {
    if (current === ref) current = null;
  },
  clear() {
    current = null;
  },
  get(): HTMLElement | null {
    return current?.current?.isConnected ? current.current : null;
  },
};

const SCROLLS = /^(auto|scroll|overlay)$/;

/**
 * The element `node` scrolls inside: its timeline scroller, else the nearest
 * ancestor that scrolls (the Script pane for a word), else null.
 */
export function scrollerOf(node: HTMLElement): HTMLElement | null {
  const timeline = node.closest<HTMLElement>(".timeline-scroll");
  if (timeline) return timeline;
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY, overflowX } = getComputedStyle(el);
    if (SCROLLS.test(overflowY) || SCROLLS.test(overflowX)) return el;
  }
  return null;
}

/** Nudges a plain scroller the least distance that shows `target` whole where it fits. */
function revealWithin(target: HTMLElement, scroller: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const away = (lo: number, hi: number, min: number, max: number) =>
    lo < min ? lo - min : hi > max ? Math.min(hi - max, lo - min) : 0;
  scroller.scrollTop += away(rect.top, rect.bottom, box.top, box.bottom);
  scroller.scrollLeft += away(rect.left, rect.right, box.left, box.right);
}

function revealAcross(target: HTMLElement, scroller: HTMLElement) {
  const { clientLeft, clientWidth, scrollLeft, scrollWidth } = scroller;
  const scrollLimit = scrollWidth - clientWidth;
  if (scrollLimit <= 0) return;
  const viewportStart = scroller.getBoundingClientRect().left + clientLeft;
  const left = viewportStart + timelineHeaderOffsetWidth(scroller);
  const right = viewportStart + clientWidth;
  const rect = target.getBoundingClientRect();
  if (rect.right > left && rect.left < right) return;
  const alignLeft = rect.left - left;
  const alignRight = rect.right - right;
  const delta =
    rect.right <= left
      ? Math.max(alignLeft, alignRight)
      : Math.min(alignLeft, alignRight);
  useDawStore
    .getState()
    .setScrollLeft(clamp(scrollLeft + delta, 0, scrollLimit));
}

/**
 * Scrolls `target`'s timeline so it is on screen on both axes, instantly (so
 * reduced motion holds by construction). Each axis does nothing once it is
 * satisfied. It never moves the playhead, the selection or focus.
 */
export function revealAnchor(target: HTMLElement | null): void {
  if (!target) return;
  const scroller = target.closest<HTMLElement>(".timeline-scroll");
  if (!scroller) {
    const plain = scrollerOf(target);
    if (plain) revealWithin(target, plain);
    return;
  }
  revealAcross(target, scroller);
  const trackId = target.closest<HTMLElement>(".lane-row")?.dataset.trackId;
  if (trackId) revealLane(trackId);
}
