import { useEffect, useRef } from "react";

/**
 * Calls `onBack` once when the browser reports the connection back while
 * `armed`. An `online` event that comes while the page is not armed (the
 * failing attempt is still reading the saved copy, or the cover has not
 * mounted) is remembered and acted on when it arms, if the browser still
 * reports a connection. A new `attempt` owns its own events and forgets one
 * that came before it.
 */
export function useBackOnline(
  armed: boolean,
  attempt: number,
  onBack: () => void,
): void {
  const armedRef = useRef(armed);
  const onBackRef = useRef(onBack);
  const missedRef = useRef(false);

  useEffect(() => {
    armedRef.current = armed;
    onBackRef.current = onBack;
  });

  useEffect(() => {
    missedRef.current = false;
    const onOnline = () => {
      if (armedRef.current) {
        armedRef.current = false;
        onBackRef.current();
      } else {
        missedRef.current = true;
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [attempt]);

  useEffect(() => {
    if (armed && missedRef.current && navigator.onLine !== false) {
      missedRef.current = false;
      onBackRef.current();
    }
  }, [armed]);
}
