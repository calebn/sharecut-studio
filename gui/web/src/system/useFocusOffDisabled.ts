import { type RefObject, useEffect } from "react";

/**
 * A control that has focus and then turns disabled would leave the keyboard
 * on a button that no longer takes keys. When that happens inside `container`,
 * focus moves to the first enabled button there (End early gives way to Cancel).
 */
export function useFocusOffDisabled(
  container: RefObject<HTMLElement | null>,
  disabled: boolean,
): void {
  useEffect(() => {
    const root = container.current;
    const active = document.activeElement;
    if (!disabled || !root || !(active instanceof HTMLButtonElement)) {
      return;
    }
    if (root.contains(active) && active.disabled) {
      root.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    }
  }, [container, disabled]);
}
