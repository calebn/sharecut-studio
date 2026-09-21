import { type ReactNode, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { capabilityTooltip } from "../capabilities/copy";
import { execute } from "../commands/execute";
import {
  audioFilesFromDrop,
  fileCountFromDataTransfer,
  newTracksDropLabel,
} from "../ingest/dropLabels";
import { ingestFiles } from "../ingest/ingestFiles";
import { canIngestMedia } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { FocusToggle } from "../ui";
import { MARKER_LANE_HEIGHT, RULER_HEIGHT } from "../utils/layout";
import { TrackHeader } from "./TrackHeader";
import { reorderInsertIndex } from "./trackReorder";

interface Props {
  /** Desktop focus toggle in the ruler spacer; phone uses an empty spacer. */
  showFocusToggle?: boolean;
  /** Host ingest “+ Track” row under the headers. */
  showAddTrack?: boolean;
  addDropOver?: boolean;
  addFileCount?: number;
  onAddDropOverChange?: (over: boolean, fileCount?: number) => void;
}

function deselectAllTracks(): void {
  void execute("track.deselectAll", {}, { skipWhen: true });
}

export function TrackHeadersColumn({
  showFocusToggle = false,
  showAddTrack = false,
  addDropOver = false,
  addFileCount = 1,
  onAddDropOverChange,
}: Props): ReactNode {
  const {
    tracks,
    selection,
    setSelection,
    selectedTrackIds,
    toggleTrackSelected,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDawStore(
    useShallow((s) => ({
      tracks: s.project?.tracks ?? null,
      selection: s.selection,
      setSelection: s.setSelection,
      selectedTrackIds: s.selectedTrackIds,
      toggleTrackSelected: s.toggleTrackSelected,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    })),
  );
  const mayIngest =
    showAddTrack && canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayReorder = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const deselectTip = capabilityTooltip("daw.track.deselectAll");
  const [dragTrackId, setDragTrackId] = useState<string | null>(null);
  const dragTrackIdRef = useRef<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    trackId: string;
    edge: "before" | "after";
  } | null>(null);

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
            height: RULER_HEIGHT + MARKER_LANE_HEIGHT,
            borderBottom: "1px solid var(--border)",
          }}
        />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="track-header-row timeline-skeleton-lane"
            aria-hidden
          />
        ))}
      </div>
    );
  }

  const clearReorderUi = () => {
    dragTrackIdRef.current = null;
    setDragTrackId(null);
    setDropHint(null);
  };

  const commitReorder = (
    targetId: string,
    targetIndex: number,
    placeAfter: boolean,
  ) => {
    const sourceId = dragTrackIdRef.current;
    if (!sourceId) {
      clearReorderUi();
      return;
    }
    const sourceIndex = tracks.findIndex((t) => t.id === sourceId);
    if (sourceIndex < 0 || sourceId === targetId) {
      clearReorderUi();
      return;
    }
    const index = reorderInsertIndex(sourceIndex, targetIndex, placeAfter);
    clearReorderUi();
    if (index === sourceIndex) {
      return;
    }
    void execute(
      "track.reorder",
      { trackId: sourceId, index },
      { skipWhen: true },
    );
  };

  return (
    <div className="track-headers" role="group" aria-label="Tracks">
      <div
        className="track-headers-chrome"
        style={{
          height: RULER_HEIGHT + MARKER_LANE_HEIGHT,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {showFocusToggle ? (
          <FocusToggle mode="timeline" label="Timeline" />
        ) : null}
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
      </div>
      {tracks.map((track, idx) => (
        <TrackHeader
          key={track.id}
          track={track}
          trackIndex={idx}
          selected={
            selectedTrackIds.includes(track.id) ||
            (selection?.kind === "track" && selection.trackId === track.id)
          }
          onSelect={(additive) => {
            toggleTrackSelected(track.id, additive);
            setSelection({ kind: "track", trackId: track.id });
          }}
          reorderEnabled={mayReorder}
          isReorderDragActive={() => dragTrackIdRef.current != null}
          dragging={dragTrackId === track.id}
          dropEdge={
            dropHint?.trackId === track.id && dragTrackId !== track.id
              ? dropHint.edge
              : null
          }
          onReorderDragStart={(id) => {
            dragTrackIdRef.current = id;
            setDragTrackId(id);
            setSelection({ kind: "track", trackId: id });
          }}
          onReorderDragEnd={clearReorderUi}
          onReorderDragOver={(id, _index, placeAfter) => {
            setDropHint({ trackId: id, edge: placeAfter ? "after" : "before" });
          }}
          onReorderDrop={commitReorder}
        />
      ))}
      {mayIngest ? (
        <button
          type="button"
          className={`track-add-row${addDropOver ? " lane-drop-target" : ""}`}
          onClick={() => {
            void execute("track.add", {}, { skipWhen: true });
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            onAddDropOverChange?.(
              true,
              Math.max(1, fileCountFromDataTransfer(e.dataTransfer)),
            );
          }}
          onDragLeave={() => onAddDropOverChange?.(false)}
          onDrop={(e) => {
            e.preventDefault();
            onAddDropOverChange?.(false);
            const files = audioFilesFromDrop(e.dataTransfer.files);
            if (files.length) {
              void ingestFiles(files, { kind: "new" });
            }
          }}
        >
          {addDropOver ? newTracksDropLabel(addFileCount) : "+ Track"}
        </button>
      ) : null}
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
