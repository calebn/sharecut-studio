import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A callback whose identity stays stable and calls the latest committed `fn`.
 * Pass it to memoized children instead of an inline closure. Call it from
 * handlers and effects, not during render. A source test rejects supported
 * direct render-time calls; the latest committed `fn` is swapped in before
 * layout effects run.
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
