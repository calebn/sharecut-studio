import type { ProsodyOverlayTrack } from "../types/prosody";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";
import { ProsodyOverlayView } from "./ProsodyOverlayView";
import { useVisibleChunks } from "./useVisibleChunks";

interface ProsodyOverlayProps {
  track: ProsodyOverlayTrack;
  zoomPxPerSec: number;
  width: number;
}

/** Live adapter: culls `ProsodyOverlayView` to the on-screen px chunk range (#719). */
export function ProsodyOverlay({
  track,
  zoomPxPerSec,
  width,
}: ProsodyOverlayProps) {
  const [c0, c1] = useVisibleChunks(width);
  return (
    <ProsodyOverlayView
      track={track}
      zoomPxPerSec={zoomPxPerSec}
      x0={c0 * VIEWPORT_CHUNK_PX}
      x1={Math.min(width, (c1 + 1) * VIEWPORT_CHUNK_PX)}
    />
  );
}
