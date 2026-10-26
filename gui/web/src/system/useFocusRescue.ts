import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

type Anchor = () => HTMLElement | null | undefined;

/**
 * Keeps focus from falling to the page when the control that has it is the one
 * a state change removes. While focus is inside `container`, `anchorFor` is
 * asked, for the focused element, how to find a stable place to hand focus to
 * (it may capture neighbours, since the element is gone when the answer is
 * needed). After a render that removed the focused element, and only if focus
 * fell to the body, focus moves to that place. Focus that went anywhere else is
 * left alone.
 */
export function useFocusRescue(
  container: RefObject<HTMLElement | null>,
  anchorFor: (target: HTMLElement) => Anchor,
): void {
  const resolve = useRef(anchorFor);
  resolve.current = anchorFor;
  const lost = useRef<{ target: HTMLElement; anchor: Anchor } | null>(null);

  useEffect(() => {
    const onIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!container.current?.contains(target)) {
        lost.current = null;
        return;
      }
      lost.current = { target, anchor: resolve.current(target) };
    };
    // A browser may report the blur of a removed element while it is still
    // attached, so a blur to nowhere only counts once the render has had its
    // turn and the element is still there.
    const onOut = (event: FocusEvent) => {
      const target = event.target;
      if (event.relatedTarget) return;
      queueMicrotask(() => {
        if (target === lost.current?.target && (target as Node).isConnected) {
          lost.current = null;
        }
      });
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, [container]);

  useLayoutEffect(() => {
    const held = lost.current;
    if (!held || held.target.isConnected) return;
    lost.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    held.anchor()?.focus();
  });
}
