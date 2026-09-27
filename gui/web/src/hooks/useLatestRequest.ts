/**
 * Latest-wins request token: `begin()` starts a request and returns its token;
 * `isCurrent(token)` stays true only until a later `begin()`, an `invalidate()`,
 * or unmount, so stale async results can be dropped; `peek()` reads the current
 * token so a caller can tell whether any request began since.
 */

import { useEffect, useMemo, useRef } from "react";

export interface LatestRequest {
  begin: () => number;
  isCurrent: (token: number) => boolean;
  invalidate: () => void;
  /** The current token without starting a request; `isCurrent(peek())` turns false on the next `begin()` / `invalidate()`. */
  peek: () => number;
}

export function useLatestRequest(): LatestRequest {
  const tokenRef = useRef(0);
  useEffect(() => {
    const tokens = tokenRef;
    return () => {
      tokens.current += 1;
    };
  }, []);
  return useMemo(
    () => ({
      begin: () => {
        tokenRef.current += 1;
        return tokenRef.current;
      },
      isCurrent: (token: number) => token === tokenRef.current,
      invalidate: () => {
        tokenRef.current += 1;
      },
      peek: () => tokenRef.current,
    }),
    [],
  );
}
