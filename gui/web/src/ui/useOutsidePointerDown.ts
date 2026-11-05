import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onOutside` on a window `pointerdown` whose target is outside every
 * supplied node or live reference target. Owned nodes are committed inputs;
 * foreign live references are resolved at the actual event (Dialog anchors).
 * Shared by `Menu`, `Dialog`, and the view popover.
 */
export function useOutsidePointerDown({
  nodes = [],
  liveRefs = [],
  onOutside,
  enabled = true,
  capture = false,
}: {
  nodes?: readonly (HTMLElement | null)[];
  liveRefs?: readonly RefObject<HTMLElement | null>[];
  onOutside: () => void;
  enabled?: boolean;
  capture?: boolean;
}): void {
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
    const listener = (e: PointerEvent) => onPointerDown(e.target as Node);
    window.addEventListener("pointerdown", listener, { capture });
    return () =>
      window.removeEventListener("pointerdown", listener, { capture });
  }, [enabled, capture]);
}
