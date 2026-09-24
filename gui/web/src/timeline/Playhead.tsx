interface PlayheadProps {
  playheadSec: number;
  zoomPxPerSec: number;
  /** Lane-stack px, or `"100%"` inside the ruler. */
  height: number | string;
}

/**
 * Timeline needle. Moves with `transform` (see `.playhead` in timeline.css) so
 * the playing glow composites each frame instead of repainting a strip.
 */
export function Playhead({ playheadSec, zoomPxPerSec, height }: PlayheadProps) {
  return (
    <div
      className="playhead"
      style={{
        height,
        transform: `translateX(${playheadSec * zoomPxPerSec}px)`,
      }}
    />
  );
}
