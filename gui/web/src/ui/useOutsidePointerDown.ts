import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onOutside` on a window `pointerdown` whose target is outside every
 * element in `refs` (a floating panel and its trigger). Shared by `Menu` and
 * the timeline join popover.
 */
export function useOutsidePointerDown(
  refs: readonly RefObject<HTMLElement | null>[],
  onOutside: () => void,
  enabled = true,
): void {
  const onPointerDown = useEffectEvent((target: Node) => {
    if (refs.some((r) => r.current?.contains(target))) {
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
