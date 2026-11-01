import { memo, useCallback, useMemo } from "react";
import { canEditEnvelopes } from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  Envelope,
  type EnvelopeHitProps,
  type HitAttrs,
} from "../system/Envelope";
import { dbToGain } from "../system/envelopeMath";
import type { AutomationEnvelope, ClipRow } from "../types/project";
import { sortedVolumePoints } from "../utils/envelopes";
import { ClipGainDips } from "./ClipGainDips";
import {
  finitePoints,
  selectedPointId,
  toHitAttrs,
  toLeafPoints,
  withPreview,
} from "./envelopePoints";
import { hitTargetProps, OWN_TAP_HIT_SURFACE_PROPS } from "./hitTargets";
import { timelineTestIds } from "./selectors";
import { useTimelineMetrics } from "./timelineMetrics";
import { useEnvelopeEdits } from "./useEnvelopeEdits";
import { useRulerWindow } from "./useRulerWindow";

type Props = {
  trackId: string;
  trackName: string;
  /** Index into the presence palette: the track's colour. */
  colorIndex: number;
  /** The track's envelopes; the slice keeps its identity until they change. */
  envelopes: readonly AutomationEnvelope[];
  clips: readonly ClipRow[];
  zoomPxPerSec: number;
  /** The canvas width in px: the window never reaches past it. */
  width: number;
};

const LINE_HIT: HitAttrs = OWN_TAP_HIT_SURFACE_PROPS;

/**
 * One track's volume envelope over its lane (OVL-ENVELOPE): the system
 * Envelope leaf in the ruler's window, fed the track's points as dB and
 * writing through the envelope commands, one save and one undo step per
 * gesture. The clip fade and mute dips are drawn beneath it, read-only.
 */
export const LaneEnvelope = memo(function LaneEnvelope({
  trackId,
  trackName,
  colorIndex,
  envelopes,
  clips,
  zoomPxPerSec,
  width,
}: Props) {
  const {
    projectPath,
    guestMode,
    shareCapabilities,
    projectEpoch,
    selected,
    duration,
    viewport,
    touch,
  } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    projectEpoch: s.projectEpoch,
    selected: selectedPointId(s.selection, trackId),
    duration: s.project?.timeline_duration_sec ?? 0,
    viewport: s.timelineViewportWidth,
    touch: s.pointerKind === "coarse",
  }));
  const { laneHeight } = useTimelineMetrics();
  const { left, width: winPx } = useRulerWindow(width, viewport);
  const readOnly = !canEditEnvelopes(projectPath, guestMode, shareCapabilities);

  const stored = useMemo(
    () => finitePoints(sortedVolumePoints(envelopes, trackId)),
    [envelopes, trackId],
  );
  const base = useMemo(() => toLeafPoints(stored), [stored]);
  const edits = useEnvelopeEdits(trackId, stored, readOnly);
  const { preview } = edits;
  const points = useMemo(
    () => (preview ? withPreview(base, preview) : base),
    [base, preview],
  );

  const point = useCallback(
    (id: string, time: number, db: number, isSelected: boolean) =>
      toHitAttrs(
        hitTargetProps("envelope-point", id, time, {
          selected: isSelected,
          detail: dbToGain(db).toFixed(2),
        }),
      ),
    [],
  );
  const hitProps = useMemo<EnvelopeHitProps>(
    () => ({ point, line: LINE_HIT }),
    [point],
  );

  if (winPx <= 0) return null;
  const start = left / zoomPxPerSec;
  return (
    <div
      className="lane-envelope-window"
      data-testid={timelineTestIds.envelope}
      style={{ left, width: winPx, height: laneHeight }}
    >
      {/* The dips are read-only: they follow the saved points, not a drag or nudge preview. */}
      <ClipGainDips
        clips={clips}
        points={stored}
        start={start}
        pxPerSecond={zoomPxPerSec}
        width={winPx}
        height={laneHeight}
      />
      <Envelope
        key={projectEpoch}
        points={points}
        trackName={trackName}
        colorIndex={colorIndex}
        start={start}
        pxPerSecond={zoomPxPerSec}
        width={winPx}
        height={laneHeight}
        duration={duration}
        selected={selected}
        visible
        readOnly={readOnly}
        touch={touch}
        hitProps={hitProps}
        onSelect={edits.onSelect}
        onAdd={edits.onAdd}
        onRemove={edits.onRemove}
        onMove={edits.onMove}
        onDragStart={edits.onDragStart}
        onDragEnd={edits.onDragEnd}
        onNudgeEnd={edits.onNudgeEnd}
      />
    </div>
  );
});
