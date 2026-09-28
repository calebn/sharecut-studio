import { type RefObject, useEffectEvent, useLayoutEffect, useRef } from "react";

/** What to observe: an element, a ref to one, or a getter read after each commit. */
export type ResizeObserverTarget =
  | Element
  | RefObject<Element | null>
  | (() => Element | null | undefined)
  | null
  | undefined;

function resolveTarget(target: ResizeObserverTarget): Element | null {
  if (target == null) {
    return null;
  }
  if (typeof target === "function") {
    return target() ?? null;
  }
  if (target instanceof Element) {
    return target;
  }
  return target.current;
}

function resolveTargets(
  targets: ResizeObserverTarget | readonly ResizeObserverTarget[],
): Element[] {
  const list = Array.isArray(targets) ? targets : [targets];
  const out: Element[] = [];
  for (const t of list as readonly ResizeObserverTarget[]) {
    const el = resolveTarget(t);
    if (el && !out.includes(el)) {
      out.push(el);
    }
  }
  return out;
}

/** Same elements in any order (both lists are de-duplicated): a reorder keeps the observer. */
function sameElements(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((el) => b.includes(el));
}

/**
 * Calls `onResize` with the entries whenever any target's box resizes, from
 * one `ResizeObserver`. Targets are resolved after every commit, so a ref
 * whose element changes is re-observed; otherwise the observer is kept across
 * renders and `onResize` is always the latest callback. A no-op while
 * `enabled` is false or where `ResizeObserver` does not exist. The only place
 * the GUI constructs a `ResizeObserver` (see the governance test).
 *
 * Getters run on every commit of the caller: keep them cheap (a ref read or
 * one `querySelector`) and return the same element while the target is
 * unchanged. A different element re-creates the observer, and each new
 * observer reports every target's size once. Order does not matter.
 */
export function useResizeObserver(
  targets: ResizeObserverTarget | readonly ResizeObserverTarget[],
  onResize: (entries: readonly ResizeObserverEntry[]) => void,
  enabled = true,
): void {
  const notify = useEffectEvent((entries: readonly ResizeObserverEntry[]) =>
    onResize(entries),
  );
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<readonly Element[]>([]);

  // No dependency list: a ref's element can change without any input here changing.
  useLayoutEffect(() => {
    const next =
      enabled && typeof ResizeObserver !== "undefined"
        ? resolveTargets(targets)
        : [];
    if (sameElements(next, observedRef.current)) {
      return;
    }
    // disconnect() drops any entry the old observer queued but had not
    // delivered; observe() below queues an initial size for every target, so
    // onResize still sees current sizes. Keep that if this switches to
    // unobserve() on a reused observer (re-measure explicitly then).
    observerRef.current?.disconnect();
    observerRef.current = null;
    observedRef.current = next;
    if (next.length === 0) {
      return;
    }
    const observer = new ResizeObserver((entries) => notify(entries));
    observerRef.current = observer;
    for (const el of next) {
      observer.observe(el);
    }
  });

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      observedRef.current = [];
    },
    [],
  );
}
