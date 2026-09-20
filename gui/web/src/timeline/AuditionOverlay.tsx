interface AuditionOverlayProps {
  startSec: number;
  endSec: number;
  zoomPxPerSec: number;
  height: number;
  label?: string | null;
}

export function AuditionOverlay({
  startSec,
  endSec,
  zoomPxPerSec,
  height,
  label,
}: AuditionOverlayProps) {
  const left = startSec * zoomPxPerSec;
  const width = Math.max(3, (endSec - startSec) * zoomPxPerSec);
  return (
    <div
      className="audition-overlay"
      style={{ left, width, height }}
      title={label ?? `${startSec.toFixed(1)}–${endSec.toFixed(1)}s`}
    >
      {label && width > 80 && (
        <span className="audition-overlay-label">{label}</span>
      )}
    </div>
  );
}
