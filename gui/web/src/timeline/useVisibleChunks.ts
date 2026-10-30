import { useCallback, useMemo } from "react";
import { useDawStore } from "../state/dawStore";
import { viewportChunkRange } from "../utils/timelineViewport";

/**
 * The on-screen {@link import("../utils/timelineViewport").VIEWPORT_CHUNK_PX}
 * chunk range of a `widthPx`-wide overlay, as a stable tuple. Used by
 * `EnvelopeOverlay` and `ProsodyOverlay` so a deep zoom never mounts millions
 * of px of SVG.
 */
export function useVisibleChunks(widthPx: number): readonly [number, number] {
  const chunkRange = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) =>
        viewportChunkRange(s.scrollLeft, s.timelineViewportWidth, widthPx).join(
          ":",
        ),
      [widthPx],
    ),
  );
  return useMemo(() => {
    const [start = 0, end = 0] = chunkRange.split(":").map(Number);
    return [start, end] as const;
  }, [chunkRange]);
}
