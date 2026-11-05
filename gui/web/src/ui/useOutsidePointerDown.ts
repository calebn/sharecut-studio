import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onOutside` on a window `pointerdown` whose target is outside every
 * supplied node or live reference target. Owned nodes are committed inputs;
 * foreign live references are resolved at the actual event (Dialog anchors).
 */
export function useOutsidePointerDown({
  nodes = [],
  liveRefs = [],
  onOutside,
  enabled = true,
}: {
  nodes?: readonly (HTMLElement | null)[];
  liveRefs?: readonly RefObject<HTMLElement | null>[];
  onOutside: () => void;
  enabled?: boolean;
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
    window.addEventListener("pointerdown", listener);
    return () => window.removeEventListener("pointerdown", listener);
  }, [enabled]);
}
