import type { ProsodyOverlayTrack } from "../types/prosody";
import { energyTopPct, inPxRange, prosodyStatusLabel } from "./prosodyGeometry";

export interface ProsodyOverlayViewProps {
  track: ProsodyOverlayTrack;
  zoomPxPerSec: number;
  /** Visible px range of the lane (chunk-culled like EnvelopeOverlayView). */
  x0: number;
  x1: number;
}

/** Read-only prosody paint: energy band/contour, phrase boundaries and prominent words (#719). */
export function ProsodyOverlayView({
  track,
  zoomPxPerSec,
  x0,
  x1,
}: ProsodyOverlayViewProps) {
  const label = prosodyStatusLabel(track.status);
  if (track.status === "missing" || track.status === "unavailable") {
    return <div className="lane-prosody-status">{label}</div>;
  }
  return (
    <>
      <div
        className={`prosody-overlay${track.status === "stale" ? " prosody-overlay--stale" : ""}`}
        aria-hidden
      >
        {track.segments.map((seg, i) =>
          seg.spans.map((span, j) =>
            inPxRange(span.start, span.end, zoomPxPerSec, x0, x1) ? (
              <div
                key={`s${i}-${j}`}
                className="prosody-seg"
                data-trend={seg.trend}
                style={{
                  left: span.start * zoomPxPerSec,
                  width: Math.max(1, (span.end - span.start) * zoomPxPerSec),
                }}
              />
            ) : null,
          ),
        )}
        {track.segments.map((seg, i) =>
          seg.energy_thirds.map((third, k) =>
            third.spans.map((span, j) =>
              inPxRange(span.start, span.end, zoomPxPerSec, x0, x1) ? (
                <div
                  key={`e${i}-${k}-${j}`}
                  className="prosody-energy"
                  style={{
                    left: span.start * zoomPxPerSec,
                    width: Math.max(1, (span.end - span.start) * zoomPxPerSec),
                    top: `${energyTopPct(third.db, track.energy_db)}%`,
                  }}
                />
              ) : null,
            ),
          ),
        )}
        {track.boundaries.map((b, i) =>
          inPxRange(b.timeline_sec, b.timeline_sec, zoomPxPerSec, x0, x1) ? (
            <div
              key={`b${i}`}
              className={`prosody-boundary${b.kind === "segment_end" ? " prosody-boundary--end" : ""}`}
              style={{
                left: b.timeline_sec * zoomPxPerSec,
                height: `${Math.round(Math.min(1, Math.max(0, b.strength)) * 100)}%`,
              }}
            />
          ) : null,
        )}
        {track.prominent_words.map((w, i) =>
          w.timeline_sec != null &&
          inPxRange(w.timeline_sec, w.timeline_sec, zoomPxPerSec, x0, x1) ? (
            <div
              key={`p${i}`}
              className="prosody-prominent"
              style={{ left: w.timeline_sec * zoomPxPerSec }}
            />
          ) : null,
        )}
      </div>
      {label ? <div className="lane-prosody-status">{label}</div> : null}
    </>
  );
}
