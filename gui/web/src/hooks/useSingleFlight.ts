import { useCallback, useRef, useState } from "react";
import { useMountedRef } from "./useMountedRef";

/**
 * Runs at most one async task at a time. The guard is a ref, so a second
 * `run` before `busy` re-renders (a double click) is dropped and resolves
 * `undefined`. `busy` is true from `run` until the task settles (left alone
 * after unmount). A task's rejection propagates to the caller.
 */
export function useSingleFlight(): {
  busy: boolean;
  run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
} {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useMountedRef();
  const run = useCallback(
    async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      if (inFlight.current) {
        return undefined;
      }
      inFlight.current = true;
      setBusy(true);
      try {
        return await task();
      } finally {
        inFlight.current = false;
        if (mountedRef.current) {
          setBusy(false);
        }
      }
    },
    [mountedRef],
  );
  return { busy, run };
}
