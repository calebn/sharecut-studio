import { useRef } from "react";
import { setEnvelope } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { AutomationEnvelope, Selection } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { sortedVolumePoints } from "../utils/envelopes";
import { EnvelopeOverlayView } from "./EnvelopeOverlayView";
import { useTimelineGestureHold, useTimelineMetrics } from "./timelineMetrics";
import { useVisibleChunks } from "./useVisibleChunks";

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
  const { projectPath, selection, setSelection, announceStatus } = useDaw(
    (s) => ({
      projectPath: s.projectPath,
      selection: s.selection,
      setSelection: s.setSelection,
      announceStatus: s.announceStatus,
    }),
  );
  const { laneHeight } = useTimelineMetrics();
  const visibleChunks = useVisibleChunks(width);
  // yToValue reads the lane height and SVG rect: the view holds both still
  // from pointerdown until the drag commits, cancels or unmounts.
  const holdGeometry = useTimelineGestureHold() ?? undefined;
  const priorSel = useRef<Selection>(null);

  const points = sortedVolumePoints(envelopes, trackId);
  const editable = !isShareProjectKey(projectPath);
  const selectedIndex =
    selection?.kind === "envelopePoint" && selection.trackId === trackId
      ? selection.index
      : null;

  return (
    <EnvelopeOverlayView
      points={points}
      zoomPxPerSec={zoomPxPerSec}
      width={width}
      height={laneHeight}
      visibleChunks={visibleChunks}
      editable={editable}
      selectedIndex={selectedIndex}
      onSelectTrack={onSelectTrack}
      onSelectPoint={(index) => {
        priorSel.current = selection;
        setSelection({ kind: "envelopePoint", trackId, index });
      }}
      onCommitPoints={(nextPoints, origin) =>
        setEnvelope(projectPath, trackId, nextPoints, origin)
      }
      onCommitError={(error) => {
        setSelection(priorSel.current);
        announceStatus(errorMessage(error, "Could not apply envelope"));
      }}
      holdGeometry={holdGeometry}
    />
  );
}
