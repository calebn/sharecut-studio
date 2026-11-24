import { useEffectEvent, useLayoutEffect, useRef } from "react";

/**
 * Calls `onChange` when the inline `style` of any element `targets()` lists
 * changes inside `root()`. `targets` is read when a change arrives, so a
 * target that was replaced is still heard. The root is resolved after every
 * commit and the observer is kept while it stays the same element. A no-op
 * while `enabled` is false or where `MutationObserver` does not exist.
 */
export function useStyleObserver(
  root: () => Element | null | undefined,
  targets: () => readonly (Node | null | undefined)[],
  onChange: () => void,
  enabled = true,
): void {
  const notify = useEffectEvent(onChange);
  const isTarget = useEffectEvent((node: Node) => targets().includes(node));
  const rootOf = useEffectEvent(root);
  const observerRef = useRef<MutationObserver | null>(null);
  const observedRef = useRef<Element | null>(null);

  // No dependency list: the root's element can change without any input here changing.
  useLayoutEffect(() => {
    const next =
      enabled && typeof MutationObserver !== "undefined"
        ? (rootOf() ?? null)
        : null;
    if (next === observedRef.current) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedRef.current = next;
    if (!next) return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => isTarget(record.target))) notify();
    });
    observer.observe(next, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    observerRef.current = observer;
  });

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current = null;
    },
    [],
  );
}
