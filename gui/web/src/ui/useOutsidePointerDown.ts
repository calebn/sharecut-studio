import { type RefObject, useEffect, useEffectEvent } from "react";

/**
 * Calls `onOutside` on a window `pointerdown` whose target is outside every
 * element in `refs` (a floating panel and its trigger). Shared by `Menu`, `Dialog`, and the view popover.
 */
export function useOutsidePointerDown(
  refs: readonly RefObject<HTMLElement | null>[],
  onOutside: () => void,
  enabled = true,
  { capture = false }: { capture?: boolean } = {},
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
    window.addEventListener("pointerdown", listener, { capture });
    return () =>
      window.removeEventListener("pointerdown", listener, { capture });
  }, [enabled, capture]);
}
