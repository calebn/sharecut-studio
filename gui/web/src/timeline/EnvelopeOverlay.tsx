import { useEffect, useRef } from "react";
import { setEnvelope } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { AutomationEnvelope, Selection } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { findVolumeEnvelope, sortedVolumePoints } from "../utils/envelopes";
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
  trackId: string;
  zoomPxPerSec: number;
  width: number;
  onSelectTrack: () => void;
}

export function EnvelopeOverlay({
  envelopes,
  trackId,
  zoomPxPerSec,
  width,
  onSelectTrack,
}: EnvelopeOverlayProps) {
  const { projectPath, projectEpoch, selection, setSelection, announceStatus } =
    useDaw((s) => ({
      projectPath: s.projectPath,
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
  const editable = !isShareProjectKey(projectPath);
  const selectedPointId =
    selection?.kind === "envelopePoint" && selection.trackId === trackId
      ? selection.pointId
      : null;

  return (
    <EnvelopeOverlayView
      key={`${projectEpoch}:${trackId}`}
      points={points}
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
        announceStatus(errorMessage(error, "Could not apply envelope"));
      }}
      holdGeometry={holdGeometry}
    />
  );
}
