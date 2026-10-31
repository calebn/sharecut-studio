import {
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { capabilityTooltip } from "../../capabilities/copy";
import { runPointerCommand } from "../../commands/pointer";
import { useStaleRenderBreakdown } from "../../hooks/useStaleRenderBreakdown";
import { canEditMix, canIngestMedia } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { TrackHeader, type TrackHeaderForm } from "../../system/TrackHeader";
import { useTimelineMetrics } from "../../timeline/timelineMetrics";
import { SoloChip } from "../../tracks/SoloChip";
import {
  reorderInsertIndex,
  setTrackReorderData,
} from "../../tracks/trackReorder";
import type { TrackView } from "../../types/project";
import { RULER_HEIGHT } from "../../utils/layout";
import { trackHasSourceAudio } from "../../utils/projectMedia";
import {
  REGIONAL_CHIP_LABEL,
  reasonChipLabel,
  wholeTrackReasonsForTrack,
} from "../../utils/staleRender";
import {
  dropEdge,
  type TrackHeaderShared,
  useTrackHeaderProps,
} from "./useTrackHeaderProps";

export type TrackColumnProps = {
  /** The 168 px column, or the 56 px phone column with the avatar alone. */
  form?: TrackHeaderForm;
  /** Desktop and tablet: Solo on, Clear solo in the corner above the headers. */
  showSoloChip?: boolean;
  /** The Edit "+" menu, under the last header. */
  addRow?: ReactNode;
};

const STEM_STALE = "Stem out of date";

function deselectAllTracks(): void {
  runPointerCommand("track.deselectAll", {});
}

type Stale = { stale: boolean; status: string | undefined };
const FRESH: Stale = { stale: false, status: undefined };

type RowProps = {
  track: TrackView;
  trackIndex: number;
  reorder: "lifted" | "before" | "after" | undefined;
  stale: boolean;
  status: string | undefined;
  shared: TrackHeaderShared;
  dropTarget: boolean;
  onDragOverRow: (id: string, event: DragEvent<HTMLDivElement>) => void;
  onDropRow: (id: string, event: DragEvent<HTMLDivElement>) => void;
};

/**
 * One header in its lane-high slot. The slot takes a header being dragged over
 * it and a file dropped on its track; the header itself is the system part.
 */
const TrackRow = memo(function TrackRow({
  track,
  trackIndex,
  reorder,
  stale,
  status,
  shared,
  dropTarget,
  onDragOverRow,
  onDropRow,
}: RowProps) {
  const props = useTrackHeaderProps(
    { track, trackIndex, reorder, stale, status },
    shared,
  );
  return (
    <div
      className={`track-column-row${dropTarget ? " lane-drop-target" : ""}`}
      onDragOver={(event) => onDragOverRow(track.id, event)}
      onDrop={(event) => onDropRow(track.id, event)}
    >
      <TrackHeader {...props} />
    </div>
  );
});

/**
 * The Edit stage's track headers: the corner above them (the deselect surface
 * and the Solo on chip), one `system/TrackHeader` per track in a lane-high
 * slot, the Edit "+" row, and the well under them that deselects. Owns the
 * drag-to-reorder drop; the headers own the drag start.
 */
function TrackColumnView({
  form = "default",
  showSoloChip = false,
  addRow,
}: TrackColumnProps): ReactNode {
  const { markerLaneHeight } = useTimelineMetrics();
  const {
    project,
    tracks,
    highlightStaleRender,
    ingestDropTrackId,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    project: s.project,
    tracks: s.project?.tracks ?? null,
    highlightStaleRender: s.highlightStaleRender,
    ingestDropTrackId: s.ingestDropTrackId,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const breakdown = useStaleRenderBreakdown(project);
  const mayReorder = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayMix = canEditMix(projectPath, guestMode, shareCapabilities);
  const deselectTip = capabilityTooltip("daw.track.deselectAll");
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const dragTrackIdRef = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    trackId: string;
    edge: "before" | "after";
  } | null>(null);

  const clearReorderUi = useCallback(() => {
    dragTrackIdRef.current = null;
    setDragTrackId(null);
    setDropHint(null);
  }, []);

  const onDragStart = useCallback((id: string, event: DragEvent) => {
    event.stopPropagation();
    setTrackReorderData(event.dataTransfer, id);
    dragTrackIdRef.current = id;
    setDragTrackId(id);
    useDawStore.getState().setSelection({ kind: "track", trackId: id });
  }, []);

  const onDragOverRow = useCallback(
    (id: string, event: DragEvent<HTMLDivElement>) => {
      if (!dragTrackIdRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropHint({ trackId: id, edge: dropEdge(event) });
    },
    [],
  );

  const onDropRow = useCallback(
    (id: string, event: DragEvent<HTMLDivElement>) => {
      const sourceId = dragTrackIdRef.current;
      if (!sourceId) return;
      event.preventDefault();
      event.stopPropagation();
      const placeAfter = dropEdge(event) === "after";
      const list = useDawStore.getState().project?.tracks ?? [];
      const sourceIndex = list.findIndex((t) => t.id === sourceId);
      const targetIndex = list.findIndex((t) => t.id === id);
      clearReorderUi();
      if (sourceIndex < 0 || targetIndex < 0 || sourceId === id) return;
      const index = reorderInsertIndex(sourceIndex, targetIndex, placeAfter);
      if (index === sourceIndex) return;
      runPointerCommand("track.reorder", { trackId: sourceId, index });
    },
    [clearReorderUi],
  );

  const shared = useMemo<TrackHeaderShared>(
    () => ({
      form,
      mayMix,
      onDragStart: mayReorder ? onDragStart : undefined,
      onDragEnd: mayReorder ? clearReorderUi : undefined,
    }),
    [form, mayMix, mayReorder, onDragStart, clearReorderUi],
  );

  const staleByTrack = useMemo(() => {
    const found = new Map<string, Stale>();
    for (const track of tracks ?? []) {
      const stem =
        trackHasSourceAudio(track) &&
        breakdown.staleTrackIds.includes(track.id);
      const reasons = highlightStaleRender
        ? wholeTrackReasonsForTrack(breakdown, track.id)
        : [];
      const regional =
        highlightStaleRender &&
        reasons.length === 0 &&
        breakdown.invalidations.some(
          (inv) =>
            inv.track_ids.includes(track.id) &&
            inv.timeline_start != null &&
            inv.timeline_end != null,
        );
      const parts = reasons.map(reasonChipLabel);
      if (regional) parts.push(REGIONAL_CHIP_LABEL);
      const status =
        parts.length > 0
          ? `${STEM_STALE}: ${parts.join(", ")}`
          : stem
            ? STEM_STALE
            : undefined;
      if (stem || status) found.set(track.id, { stale: stem, status });
    }
    return found;
  }, [tracks, breakdown, highlightStaleRender]);

  if (!tracks) {
    return (
      <div
        className="track-headers"
        role="group"
        aria-label="Tracks"
        aria-busy="true"
      >
        <div
          className="track-headers-chrome"
          style={{
            height: RULER_HEIGHT + markerLaneHeight,
            borderBottom: "1px solid var(--color-border)",
          }}
        />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="track-column-row timeline-skeleton-lane"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="track-headers"
      role="group"
      aria-label="Tracks"
      tabIndex={-1}
    >
      <div
        className="track-headers-chrome"
        style={{
          height: RULER_HEIGHT + markerLaneHeight,
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        {/*
          Pointer-only chrome; keyboard uses the well / Mod+Shift+A.
          Same pattern as .lane-seek / .envelope-hit: a div (not button) so
          Lighthouse target-size ignores this full-bleed hit area. Do not
          restore a hidden button or a title that names a second deselect control.
        */}
        <div
          className="track-headers-deselect"
          role="presentation"
          onClick={deselectAllTracks}
        />
        {showSoloChip ? <SoloChip /> : null}
      </div>
      {tracks.map((track, index) => {
        const state = staleByTrack.get(track.id) ?? FRESH;
        const reorder =
          dragTrackId === track.id
            ? "lifted"
            : dropHint?.trackId === track.id
              ? dropHint.edge
              : undefined;
        return (
          <TrackRow
            key={track.id}
            track={track}
            trackIndex={index}
            reorder={reorder}
            stale={state.stale}
            status={state.status}
            shared={shared}
            dropTarget={ingestDropTrackId === track.id}
            onDragOverRow={onDragOverRow}
            onDropRow={onDropRow}
          />
        );
      })}
      {addRow ?? null}
      <button
        type="button"
        className="track-headers-well"
        title={deselectTip}
        aria-label={deselectTip}
        onClick={deselectAllTracks}
      />
    </div>
  );
}

export const TrackColumn = memo(TrackColumnView);
