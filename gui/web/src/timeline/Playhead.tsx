interface PlayheadProps {
  playheadSec: number;
  zoomPxPerSec: number;
  height: number;
}

export function Playhead({ playheadSec, zoomPxPerSec, height }: PlayheadProps) {
  return (
    <div
      className="playhead"
      style={{ left: playheadSec * zoomPxPerSec, height }}
    />
  );
}
