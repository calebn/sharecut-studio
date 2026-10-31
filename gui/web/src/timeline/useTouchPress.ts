/**
 * The touch press layer of the touch input grammar (#1051): native pointer code
 * owns a timeline touch while the hit router decides what it was.
 *
 * - A touch the browser takes to scroll ends in pointercancel; the press ends
 *   with it, and no target ever saw it.
 * - A long press (`LONG_PRESS_MS`) calls `HitRouter.longPress`; the touch
 *   context menu that follows it is blocked.
 * - While pressed, text selection is off, and the browser's click after the
 *   release does not reach the targets. The router replays a tap itself, at
 *   the release (see `hitRouting.ts`).
 *
 * Its handlers run in the capture phase on the routed root, so the press
 * stops there. Only touches the router deferred (`HitRouter.defers`) reach
 * it; mouse, pen, selected targets and an armed Select range go straight to
 * their owners.
 */
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from "react";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import { type HitRouter, isReplayed } from "./hitRouting";

export interface TouchPressProps {
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenuCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** How long after a release the browser's click for that press can still arrive. */
const CLICK_AFTER_RELEASE_MS = 1000;
/** Text selection stays off this long after a release: Safari selects on the lift. */
const SELECTION_RESTORE_MS = 300;

interface Press {
  pointerId: number;
  timer: ReturnType<typeof setTimeout>;
  longPressed: boolean;
  stop: () => void;
}

let selectionHolds = 0;

function holdSelectionOff(): void {
  selectionHolds += 1;
  const style = document.documentElement.style;
  style.userSelect = "none";
  style.setProperty("-webkit-user-select", "none");
}

function releaseSelection(): void {
  selectionHolds = Math.max(0, selectionHolds - 1);
  if (selectionHolds > 0) return;
  const style = document.documentElement.style;
  style.userSelect = "";
  style.setProperty("-webkit-user-select", "");
}

export function useTouchPress(router: HitRouter | null): TouchPressProps {
  const routerRef = useRef(router);
  routerRef.current = router;
  const press = useRef<Press | null>(null);
  const clickUntil = useRef(0);
  const contextMenuUntil = useRef(0);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const selectionHeld = useRef(false);

  const restoreSelection = () => {
    clearTimeout(restoreTimer.current);
    if (!selectionHeld.current) return;
    selectionHeld.current = false;
    releaseSelection();
  };

  const end = (landed: boolean) => {
    const current = press.current;
    if (!current) return;
    press.current = null;
    clearTimeout(current.timer);
    current.stop();
    if (landed) clickUntil.current = Date.now() + CLICK_AFTER_RELEASE_MS;
    if (current.longPressed) {
      contextMenuUntil.current = Date.now() + CLICK_AFTER_RELEASE_MS;
    }
    clearTimeout(restoreTimer.current);
    restoreTimer.current = setTimeout(restoreSelection, SELECTION_RESTORE_MS);
  };

  const unmount = useRef(() => {});
  unmount.current = () => {
    end(false);
    restoreSelection();
  };
  useEffect(() => () => unmount.current(), []);

  return {
    onPointerDownCapture(event) {
      if (!router?.defers(event.nativeEvent)) return;
      // The touch is the router's: its target never sees the pointerdown.
      event.stopPropagation();
      if (event.button !== 0) return;
      // A press whose release never arrived: its own pointer is down again.
      if (press.current?.pointerId === event.pointerId) end(false);
      if (press.current) return;
      const { pointerId } = event;
      const onUp = (up: PointerEvent) => {
        if (up.pointerId === pointerId) end(true);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) end(false);
      };
      // On the window, ahead of the router's document listeners, which stop a
      // finger's release once a second finger has taken the gesture.
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      clearTimeout(restoreTimer.current);
      if (!selectionHeld.current) {
        selectionHeld.current = true;
        holdSelectionOff();
      }
      const started: Press = {
        pointerId,
        longPressed: false,
        timer: setTimeout(() => {
          started.longPressed = true;
          routerRef.current?.longPress();
        }, LONG_PRESS_MS),
        stop() {
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
        },
      };
      press.current = started;
      clickUntil.current = 0;
    },
    onClickCapture(event) {
      // The browser's click after a press must not reach a target; any other
      // click (a replayed tap, a mouse click) is its target's.
      if (isReplayed(event.nativeEvent)) return;
      const { pointerType } = event.nativeEvent as PointerEvent;
      if (pointerType === "mouse" || pointerType === "pen") return;
      if (event.detail === 0) return;
      if (!press.current && Date.now() >= clickUntil.current) return;
      clickUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenuCapture(event) {
      if ((event.nativeEvent as PointerEvent).pointerType !== "touch") return;
      if (!press.current && Date.now() >= contextMenuUntil.current) return;
      event.preventDefault();
    },
  };
}
