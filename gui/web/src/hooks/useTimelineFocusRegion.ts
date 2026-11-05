import { useCallback, useRef } from "react";
import { useStableCallback } from "../utils/useStableCallback";

/**
 * Callback-ref focus capture for timeline vs panels without JSX mouse
 * handlers (jsx-a11y). Safe for conditionally mounted regions.
 */
export function useTimelineFocusRegion<T extends HTMLElement>(
  focused: boolean,
  setTimelineFocused: (focused: boolean) => void,
): (node: T | null) => void {
  const set = useStableCallback(() => setTimelineFocused(focused));
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (node: T | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!node) {
        return;
      }
      node.addEventListener("mousedown", set);
      node.addEventListener("focusin", set);
      cleanupRef.current = () => {
        node.removeEventListener("mousedown", set);
        node.removeEventListener("focusin", set);
      };
    },
    [set],
  );
}
