/**
 * The swipeable drawer's header drag (#1051): the sheet follows the finger
 * 1:1 and settles at a detent on release (`drawerMotion.ts`).
 *
 * The drag never re-renders React. On the first touch the sheet takes its
 * whole slot (one layout) and a `translateY` shows only the part the finger
 * holds up; each pointer move writes that transform in the next animation
 * frame, which the compositor draws without layout. On release the chosen
 * detent is committed, and once React has drawn it the sheet slides from
 * where the finger left it to that detent's height, then drops back to its
 * own height. `data-drawer-motion` ("drag", then "settle") marks the moving
 * sheet for CSS; the settle slides only where motion is allowed, so under
 * reduced motion the sheet lands at once.
 */
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import type { DrawerDetent, SheetDrawer } from "./BottomSheet";
import { type DragSample, releaseVelocity, settleDetent } from "./drawerMotion";

/** On the sheet while it moves with a finger or settles. */
export const DRAWER_MOTION_ATTR = "data-drawer-motion";

interface Swipe {
  panel: HTMLElement;
  pointerId: number;
  startY: number;
  /** The sheet's drawn height when the finger landed, px. */
  startHeight: number;
  /** The slot the sheet rises in, px: its height while it moves. */
  slot: number;
  /** The drawn height the finger holds now, px. */
  height: number;
  samples: DragSample[];
  heights: (readonly [DrawerDetent, number])[];
  frame: number;
}

export interface DrawerSwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

const translate = (px: number) => `translateY(${px}px)`;

/** The vertical offset the sheet is drawn at, mid-settle included. */
function drawnOffset(panel: HTMLElement): number {
  const values = /matrix\(([^)]+)\)/
    .exec(getComputedStyle(panel).transform)?.[1]
    ?.split(",");
  return values ? Number(values[5]) : 0;
}

/** The sheet's own height, outside the full-slot height it moves at. */
function restingHeight(panel: HTMLElement): number {
  const inline = panel.style.height;
  panel.style.height = "";
  const px = panel.offsetHeight;
  panel.style.height = inline;
  return px;
}

/**
 * Each detent's height in this slot. Half and full are shares of the slot,
 * measured by trying their class; the strip is as tall as its content, which
 * only shows at the strip, so it is the last strip height seen (or the
 * header's, before any).
 */
function detentHeights(
  panel: HTMLElement,
  drawer: SheetDrawer,
  stripPx: number | null,
): (readonly [DrawerDetent, number])[] {
  const current = `bottom-sheet--${drawer.detent}`;
  return drawer.detents.map((detent) => {
    if (detent === drawer.detent) return [detent, restingHeight(panel)];
    if (detent === "peek") {
      const header = panel.querySelector<HTMLElement>(".bottom-sheet-chrome");
      return [detent, stripPx ?? header?.offsetHeight ?? 0];
    }
    panel.classList.replace(current, `bottom-sheet--${detent}`);
    const px = restingHeight(panel);
    panel.classList.replace(`bottom-sheet--${detent}`, current);
    return [detent, px];
  });
}

function rest(panel: HTMLElement): void {
  panel.removeAttribute(DRAWER_MOTION_ATTR);
  panel.style.height = "";
  panel.style.transform = "";
}

export function useDrawerSwipe(
  panelRef: RefObject<HTMLElement | null>,
  drawer: SheetDrawer | undefined,
): DrawerSwipeHandlers {
  const swipe = useRef<Swipe | null>(null);
  const strip = useRef<number | null>(null);
  const stopSettle = useRef<() => void>(() => undefined);
  const live = useRef(false);

  // The sheet losing its drawer (a selection cleared, a track chosen, the
  // sheet closing) drops the drag or settle it was in, so its drag styles
  // cannot stay on a sheet that no longer handles the finger.
  const hasDrawer = drawer != null;
  useEffect(() => {
    if (!hasDrawer) return;
    const panel = panelRef.current;
    live.current = true;
    return () => {
      live.current = false;
      const s = swipe.current;
      swipe.current = null;
      if (s) cancelAnimationFrame(s.frame);
      stopSettle.current();
      const dragged = s?.panel ?? panel;
      if (dragged) rest(dragged);
    };
  }, [hasDrawer, panelRef]);

  /** Slides the sheet to `detent`'s height, once drawn there, then lets it rest. */
  const settle = (panel: HTMLElement, slot: number, detent: DrawerDetent) => {
    if (!live.current || swipe.current || !panel.isConnected) return;
    const target = restingHeight(panel);
    if (detent === "peek") strip.current = target;
    panel.setAttribute(DRAWER_MOTION_ATTR, "settle");
    // Read after the attribute: the transition starts from the drawn offset.
    const animates =
      Number.parseFloat(getComputedStyle(panel).transitionDuration) > 0 &&
      Math.abs(drawnOffset(panel) - (slot - target)) >= 1;
    if (!animates) {
      rest(panel);
      return;
    }
    const done = (event: TransitionEvent) => {
      if (event.target !== panel || event.propertyName !== "transform") return;
      stopSettle.current();
      rest(panel);
    };
    panel.addEventListener("transitionend", done);
    panel.addEventListener("transitioncancel", done);
    stopSettle.current = () => {
      panel.removeEventListener("transitionend", done);
      panel.removeEventListener("transitioncancel", done);
      stopSettle.current = () => undefined;
    };
    panel.style.transform = translate(slot - target);
  };

  /**
   * Ends the drag where the finger left it, bound for `detent`; the settle
   * waits a frame for React to draw that detent.
   */
  const release = (s: Swipe, detent: DrawerDetent) => {
    cancelAnimationFrame(s.frame);
    swipe.current = null;
    s.panel.style.transform = translate(s.slot - s.height);
    requestAnimationFrame(() => settle(s.panel, s.slot, detent));
  };

  const follow = (s: Swipe, clientY: number, t: number) => {
    s.samples.push({ y: clientY, t });
    s.height = Math.max(
      0,
      Math.min(s.slot, s.startHeight - (clientY - s.startY)),
    );
  };

  return {
    onPointerDown(event) {
      const panel = panelRef.current;
      if (!drawer || !panel) return;
      const live = swipe.current?.panel === panel ? swipe.current : null;
      // A second finger is not a swipe: the sheet goes back to its detent.
      if (live) {
        release(live, drawer.detent);
        return;
      }
      if (
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button"))
      ) {
        return;
      }
      const slot = panel.parentElement?.getBoundingClientRect().height ?? 0;
      // A sheet still settling is caught where it is drawn.
      const moving = panel.hasAttribute(DRAWER_MOTION_ATTR);
      const drawn = moving ? slot - drawnOffset(panel) : panel.offsetHeight;
      stopSettle.current();
      const heights = detentHeights(panel, drawer, strip.current);
      if (drawer.detent === "peek" && !moving) strip.current = drawn;
      panel.setAttribute(DRAWER_MOTION_ATTR, "drag");
      panel.style.height = "100%";
      panel.style.transform = translate(slot - drawn);
      swipe.current = {
        panel,
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: drawn,
        slot,
        height: drawn,
        samples: [{ y: event.clientY, t: event.timeStamp }],
        heights,
        frame: 0,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      const s = swipe.current;
      if (!s || s.pointerId !== event.pointerId) return;
      follow(s, event.clientY, event.timeStamp);
      if (s.frame) return;
      s.frame = requestAnimationFrame(() => {
        s.frame = 0;
        s.panel.style.transform = translate(s.slot - s.height);
      });
    },
    onPointerUp(event) {
      const s = swipe.current;
      if (!drawer || !s || s.pointerId !== event.pointerId) return;
      follow(s, event.clientY, event.timeStamp);
      const next = settleDetent(
        s.heights,
        s.height,
        releaseVelocity(s.samples, event.timeStamp),
      );
      release(s, next);
      if (next !== drawer.detent) drawer.onDetentChange(next);
    },
    onPointerCancel(event) {
      const s = swipe.current;
      if (drawer && s && s.pointerId === event.pointerId)
        release(s, drawer.detent);
    },
  };
}
