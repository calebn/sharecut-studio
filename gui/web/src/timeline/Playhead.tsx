import { useLayoutEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";

interface PlayheadProps {
  /** Lane-stack px, or `"100%"` inside the ruler. */
  height: number | string;
}

function playheadTransform(s: {
  playheadSec: number;
  zoomPxPerSec: number;
}): string {
  return `translateX(${s.playheadSec * s.zoomPxPerSec}px)`;
}

/**
 * Timeline needle. Moves with `transform` (see `.playhead` in timeline.css) so
 * the playing glow composites each frame instead of repainting a strip. The
 * transform is written straight from the store, so a playhead tick or zoom
 * re-renders nothing.
 */
export function Playhead({ height }: PlayheadProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.style.transform = playheadTransform(useDawStore.getState());
    return useDawStore.subscribe((s, prev) => {
      if (
        s.playheadSec !== prev.playheadSec ||
        s.zoomPxPerSec !== prev.zoomPxPerSec
      ) {
        el.style.transform = playheadTransform(s);
      }
    });
  }, []);
  return <div ref={ref} className="playhead" style={{ height }} />;
}
