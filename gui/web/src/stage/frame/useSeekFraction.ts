import { useCallback } from "react";
import { seekTransport } from "../../commands/seek";
import { clamp } from "../../utils/math";

/** The seek every playhead surface shares: a 0 to 1 fraction of the episode through `transport.seek`. */
export function useSeekFraction(durationSec: number) {
  return useCallback(
    (fraction: number) => {
      if (durationSec <= 0) return;
      void seekTransport(clamp(fraction, 0, 1) * durationSec);
    },
    [durationSec],
  );
}
