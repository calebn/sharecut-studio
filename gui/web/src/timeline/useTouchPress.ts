/**
 * The touch press layer of the touch input grammar (#1051): React Aria's
 * `usePress` and `useLongPress` own a timeline touch while the hit router
 * decides what it was.
 *
 * - A touch the browser takes to scroll ends in pointercancel; React Aria
 *   ends the press, and no target ever saw it.
 * - A long press (`LONG_PRESS_MS`) calls `HitRouter.longPress`; React Aria
 *   also blocks the touch context menu that follows it.
 * - While pressed, React Aria turns off text selection and stops the
 *   browser's click from reaching the targets. The router replays a tap
 *   itself, at the release (see `hitRouting.ts`).
 *
 * Its handlers run in the capture phase on the routed root, so the press
 * stops there. Only touches the router deferred (`HitRouter.defers`) reach
 * it; mouse, pen, selected targets and an armed Select range go straight to
 * their owners.
 */
import { useLongPress, usePress } from "@react-aria/interactions";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from "react";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import type { HitRouter } from "./hitRouting";

export interface TouchPressProps {
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useTouchPress(router: HitRouter | null): TouchPressProps {
  const pressing = useRef(false);
  const { pressProps } = usePress({
    isDisabled: !router,
    onPressStart: () => {
      pressing.current = true;
    },
    onPressEnd: () => {
      pressing.current = false;
    },
  });
  const { longPressProps } = useLongPress({
    isDisabled: !router,
    pointerType: "touch",
    threshold: LONG_PRESS_MS,
    onLongPress: () => router?.longPress(),
  });
  return {
    onPointerDownCapture(event) {
      if (!router?.defers(event.nativeEvent)) return;
      pressProps.onPointerDown?.(event);
      longPressProps.onPointerDown?.(event);
    },
    onClickCapture(event) {
      // The press ends on the browser's click, which no target should see;
      // any other click (a replayed tap, a mouse click) is its target's.
      if (!pressing.current) return;
      pressProps.onClick?.(event);
      longPressProps.onClick?.(event);
    },
  };
}
