import { memo, useCallback } from "react";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { selectedClipIdsOf } from "../state/selection";
import { xAtTime } from "../system/rulerMath";
import { bandSelected, type SessionBand } from "./sessionBands";
import { layoutPills } from "./sessionPillLayout";
import { useRootFontPx } from "./useRootFontPx";

type Props = {
  bands: readonly SessionBand[];
  /** The ruler window's first second and px width: the pills sit at the same px as its ticks. */
  start: number;
  width: number;
  pxPerSecond: number;
};

/**
 * The session pills over the Edit ruler: one button per band, a sibling of the
 * system Ruler (whose slider holds no interactive children). Pressing one seeks
 * to the session's start and selects its clips, like "Edit Session N". The
 * layer takes no pointer itself, so the ruler under it keeps seeking and scrubbing.
 * Pills are placed in px (`layoutPills`) so none covers another or leaves the row.
 */
export const SessionBandLayer = memo(function SessionBandLayer({
  bands,
  start,
  width,
  pxPerSecond,
}: Props) {
  const rootPx = useRootFontPx();
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
  const placements = layoutPills(
    bands,
    (seconds) => xAtTime(seconds, start, pxPerSecond),
    width,
    rootPx,
  );
  return (
    <div className="timeline-ruler-sessions">
      {placements.map(({ band, left }) => {
        const selected = bandSelected(band, selectedIds);
        return (
          <button
            key={band.sessionId}
            type="button"
            className="timeline-session-pill"
            title={band.title}
            aria-label={`${band.label}, ${band.title}: select its clips`}
            data-selected={selected || undefined}
            style={{ insetInlineStart: left }}
            onClick={() => select(band)}
          >
            <span className="timeline-session-pill-text">{band.label}</span>
          </button>
        );
      })}
    </div>
  );
});
