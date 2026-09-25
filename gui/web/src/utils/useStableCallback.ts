import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A callback whose identity never changes but always calls the latest `fn`.
 * Pass it to memoized children instead of an inline closure. Call it from
 * handlers and effects, not during render: the latest `fn` is swapped in
 * before layout effects run.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
