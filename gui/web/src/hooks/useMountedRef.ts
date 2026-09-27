import { useEffect, useRef } from "react";

/**
 * `current` is true while the component is mounted and false after it
 * unmounts, for async work that settles later and must not touch an
 * unmounted component. StrictMode's mount, unmount, mount leaves it true.
 */
export function useMountedRef(): { readonly current: boolean } {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
