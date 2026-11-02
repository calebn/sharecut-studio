import { type CSSProperties, memo, useCallback } from "react";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { selectedClipIdsOf } from "../state/selection";
import { xAtTime } from "../system/rulerMath";
import { clamp } from "../utils/math";
import { bandSelected, type SessionBand } from "./sessionBands";

type Props = {
  bands: readonly SessionBand[];
  /** The ruler window's first second and px width: the pills sit at the same px as its ticks. */
  start: number;
  width: number;
  pxPerSecond: number;
};

/** A later pill that starts inside an earlier band steps right by this much, so both stay pressable. */
const OVERLAP_STEP_PX = 2;

/**
 * The session pills over the Edit ruler: one button per band, a sibling of the
 * system Ruler (whose slider holds no interactive children). Pressing one seeks
 * to the session's start and selects its clips, like "Edit Session N". The
 * layer takes no pointer itself, so the ruler under it keeps seeking and scrubbing.
 */
export const SessionBandLayer = memo(function SessionBandLayer({
  bands,
  start,
  width,
  pxPerSecond,
}: Props) {
  const selectedIds = selectedClipIdsOf(useDawStore((s) => s.selection));
  const select = useCallback((band: SessionBand) => {
    void seekTransport(band.start);
    useDawStore.getState().setSelection({
      kind: "clip",
      id: band.primary.id,
      trackId: band.primary.trackId,
      ids: band.clipIds,
    });
  }, []);
  return (
    <div className="timeline-ruler-sessions">
      {bands.map((band, index) => {
        const from = clamp(xAtTime(band.start, start, pxPerSecond), 0, width);
        const to = clamp(xAtTime(band.end, start, pxPerSecond), 0, width);
        if (to <= from) return null;
        const under = bands
          .slice(0, index)
          .filter((b) => b.end > band.start).length;
        const selected = bandSelected(band, selectedIds);
        return (
          <button
            key={band.sessionId}
            type="button"
            className="timeline-session-pill"
            title={band.title}
            aria-label={`${band.title}, select its clips`}
            aria-pressed={selected}
            data-selected={selected || undefined}
            style={
              {
                "--session-x": `${from + under * OVERLAP_STEP_PX}px`,
                "--session-w": `${to - from}px`,
                zIndex: index + 1,
              } as CSSProperties
            }
            onClick={() => select(band)}
          >
            {band.label}
          </button>
        );
      })}
    </div>
  );
});
