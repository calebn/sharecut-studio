import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onOutside` on a window `pointerdown` (and, when `events` asks, a
 * `click` that had no pointerdown, as a script or an assistive tool sends one)
 * whose target is outside every supplied node or live reference target. Owned nodes are committed inputs;
 * foreign live references are resolved at the actual event (Dialog anchors).
 * Shared by `Menu`, `Dialog`, and the view popover.
 */
export function useOutsidePointerDown({
  nodes = [],
  liveRefs = [],
  onOutside,
  enabled = true,
  capture = false,
  events = ["pointerdown"],
}: {
  nodes?: readonly (HTMLElement | null)[];
  liveRefs?: readonly RefObject<HTMLElement | null>[];
  onOutside: () => void;
  enabled?: boolean;
  capture?: boolean;
  events?: readonly ("pointerdown" | "click")[];
}): void {
  const hearsClick = events.includes("click");
  const onPointerDown = useEffectEvent((target: Node) => {
    if (
      nodes.some((node) => node?.contains(target)) ||
      liveRefs.some((ref) => ref.current?.contains(target))
    ) {
      return;
    }
    onOutside();
  });
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const listener = (e: Event) => onPointerDown(e.target as Node);
    const types = hearsClick ? ["pointerdown", "click"] : ["pointerdown"];
    for (const type of types) {
      window.addEventListener(type, listener, { capture });
    }
    return () => {
      for (const type of types) {
        window.removeEventListener(type, listener, { capture });
      }
    };
  }, [enabled, capture, hearsClick]);
}
