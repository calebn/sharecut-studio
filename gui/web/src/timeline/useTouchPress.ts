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

function setSelectable(selectable: boolean): void {
  const style = document.documentElement.style;
  style.userSelect = selectable ? "" : "none";
  style.setProperty("-webkit-user-select", selectable ? "" : "none");
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
    restoreTimer.current = setTimeout(
      () => setSelectable(true),
      SELECTION_RESTORE_MS,
    );
  };
  const endRef = useRef(end);
  endRef.current = end;

  useEffect(
    () => () => {
      endRef.current(false);
      clearTimeout(restoreTimer.current);
      setSelectable(true);
    },
    [],
  );

  return {
    onPointerDownCapture(event) {
      if (!router?.defers(event.nativeEvent)) return;
      // The touch is the router's: its target never sees the pointerdown.
      event.stopPropagation();
      if (event.button !== 0 || press.current) return;
      const { pointerId } = event;
      const onUp = (up: PointerEvent) => {
        if (up.pointerId === pointerId) end(true);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) end(false);
      };
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onCancel, true);
      clearTimeout(restoreTimer.current);
      setSelectable(false);
      const started: Press = {
        pointerId,
        longPressed: false,
        timer: setTimeout(() => {
          started.longPressed = true;
          routerRef.current?.longPress();
        }, LONG_PRESS_MS),
        stop() {
          document.removeEventListener("pointerup", onUp, true);
          document.removeEventListener("pointercancel", onCancel, true);
        },
      };
      press.current = started;
      clickUntil.current = 0;
    },
    onClickCapture(event) {
      // The browser's click after a press must not reach a target; any other
      // click (a replayed tap, a mouse click) is its target's.
      if (isReplayed(event.nativeEvent)) return;
      if (!press.current && Date.now() >= clickUntil.current) return;
      clickUntil.current = 0;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenuCapture(event) {
      if (
        !press.current?.longPressed &&
        Date.now() >= contextMenuUntil.current
      ) {
        return;
      }
      event.preventDefault();
    },
  };
}
