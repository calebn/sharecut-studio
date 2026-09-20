import { useCallback, useRef } from "react";

/**
 * Callback-ref focus capture for timeline vs panels without JSX mouse
 * handlers (jsx-a11y). Safe for conditionally mounted regions.
 */
export function useTimelineFocusRegion<T extends HTMLElement>(
  focused: boolean,
  setTimelineFocused: (focused: boolean) => void,
): (node: T | null) => void {
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const setterRef = useRef(setTimelineFocused);
  setterRef.current = setTimelineFocused;
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((node: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node) {
      return;
    }
    const set = () => setterRef.current(focusedRef.current);
    node.addEventListener("mousedown", set);
    node.addEventListener("focusin", set);
    cleanupRef.current = () => {
      node.removeEventListener("mousedown", set);
      node.removeEventListener("focusin", set);
    };
  }, []);
}
