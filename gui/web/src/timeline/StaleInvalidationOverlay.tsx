import type { RenderInvalidationView } from "../utils/staleRender";
import { isRegionalInvalidation } from "../utils/staleRender";

type Props = {
  invalidations: RenderInvalidationView[];
  trackId: string;
  zoomPxPerSec: number;
  width: number;
};

/** Diagnostic bands for cause-based stale regions (hover Stale pill). */
export function StaleInvalidationOverlay({
  invalidations,
  trackId,
  zoomPxPerSec,
  width,
}: Props) {
  const bands = invalidations.filter(
    (inv) =>
      inv.track_ids.includes(trackId) &&
      isRegionalInvalidation(inv) &&
      inv.timeline_start != null &&
      inv.timeline_end != null,
  );
  if (!bands.length) {
    return null;
  }
  return (
    <div className="stale-inv-overlay" aria-hidden>
      {bands.map((inv) => {
        const start = inv.timeline_start!;
        const end = inv.timeline_end!;
        const left = Math.max(0, start * zoomPxPerSec);
        const w = Math.max(3, (end - start) * zoomPxPerSec);
        return (
          <div
            key={inv.id}
            className="stale-inv-band"
            title={`${inv.reason} · ${start.toFixed(1)}–${end.toFixed(1)}s`}
            style={{ left, width: Math.min(w, Math.max(0, width - left)) }}
          />
        );
      })}
    </div>
  );
}
