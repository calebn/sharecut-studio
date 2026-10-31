import { useEffect, useMemo, useRef } from "react";
import { setEnvelope } from "../api";
import { canEditEnvelopes } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { AutomationEnvelope, ClipRow, Selection } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { findVolumeEnvelope, sortedVolumePoints } from "../utils/envelopes";
import { clipGainDips } from "./clipGainOverlay";
import { EnvelopeOverlayView } from "./EnvelopeOverlayView";
import { useTimelineGestureHold, useTimelineMetrics } from "./timelineMetrics";
import { useVisibleChunks } from "./useVisibleChunks";

function selectionKey(selection: Selection): string {
  return JSON.stringify(selection, (_key, value: unknown) => {
    if (value == null || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

interface EnvelopeOverlayProps {
  envelopes: readonly AutomationEnvelope[];
  clips: readonly ClipRow[];
  trackId: string;
  zoomPxPerSec: number;
  width: number;
  onSelectTrack: () => void;
}

export function EnvelopeOverlay({
  envelopes,
  clips,
  trackId,
  zoomPxPerSec,
  width,
  onSelectTrack,
}: EnvelopeOverlayProps) {
  const {
    projectPath,
    timelineEnd,
    guestMode,
    shareCapabilities,
    projectEpoch,
    selection,
    setSelection,
    announceStatus,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    timelineEnd: s.project?.timeline_duration_sec ?? 0,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    projectEpoch: s.projectEpoch,
    selection: s.selection,
    setSelection: s.setSelection,
    announceStatus: s.announceStatus,
  }));
  const selectionRevision = useRef(0);
  useEffect(
    () =>
      useDawStore.subscribe((current, previous) => {
        if (
          current.projectEpoch === previous.projectEpoch &&
          current.selection === previous.selection
        )
          return;
        if (
          current.projectEpoch !== previous.projectEpoch ||
          selectionKey(current.selection) !== selectionKey(previous.selection)
        )
          selectionRevision.current++;
      }),
    [],
  );
  const { laneHeight } = useTimelineMetrics();
  const visibleChunks = useVisibleChunks(width);
  // yToValue reads the lane height and SVG rect: the view holds both still
  // from pointerdown until the drag commits, cancels or unmounts.
  const holdGeometry = useTimelineGestureHold() ?? undefined;

  const points = sortedVolumePoints(envelopes, trackId);
  const dips = useMemo(
    () => clipGainDips(clips, sortedVolumePoints(envelopes, trackId)),
    [clips, envelopes, trackId],
  );
  const editable = canEditEnvelopes(projectPath, guestMode, shareCapabilities);
  const selectedPointId =
    selection?.kind === "envelopePoint" && selection.trackId === trackId
      ? selection.pointId
      : null;

  return (
    <EnvelopeOverlayView
      key={`${projectEpoch}:${trackId}`}
      points={points}
      clipDips={dips}
      timelineEnd={timelineEnd}
      baselinePoints={findVolumeEnvelope(envelopes, trackId)?.points ?? []}
      zoomPxPerSec={zoomPxPerSec}
      width={width}
      height={laneHeight}
      visibleChunks={visibleChunks}
      editable={editable}
      selectedPointId={selectedPointId}
      onSelectTrack={onSelectTrack}
      captureSelection={() => {
        const revision = selectionRevision.current;
        return (pointId) => {
          const current = useDawStore.getState();
          if (
            current.projectEpoch === projectEpoch &&
            selectionRevision.current === revision
          ) {
            setSelection({ kind: "envelopePoint", trackId, pointId });
          }
        };
      }}
      onCommitPoints={(nextPoints, origin) =>
        setEnvelope(projectPath, trackId, nextPoints, origin)
      }
      onCommitError={(error) => {
        announceStatus(errorMessage(error, "Could not apply envelope"), {
          tone: "error",
        });
      }}
      holdGeometry={holdGeometry}
    />
  );
}
