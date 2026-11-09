import { useCallback, useRef } from "react";
import { seekTransport } from "../../commands/seek";
import { useDawStore } from "../../state/dawStore";
import { clamp } from "../../utils/math";

/**
 * The seek every playhead surface shares: a 0 to 1 fraction of the episode through `transport.seek`.
 * `onScrub` brackets a drag: a cancelled drag puts back the clip stop bound the first move cleared.
 */
export function useSeekFraction(durationSec: number) {
  const bound = useRef<number | null>(null);
  const onSeek = useCallback(
    (fraction: number) => {
      if (durationSec <= 0) return;
      void seekTransport(clamp(fraction, 0, 1) * durationSec);
    },
    [durationSec],
  );
  const onScrub = useCallback((phase: "start" | "cancel") => {
    const store = useDawStore.getState();
    if (phase === "start") {
      bound.current = store.playUntilSec;
    } else {
      store.setPlayUntilSec(bound.current);
    }
  }, []);
  return { onSeek, onScrub };
}
