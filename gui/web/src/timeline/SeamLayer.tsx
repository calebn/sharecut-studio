import { useCallback, useMemo } from "react";
import { commitSeamRoll, seamRollLimits } from "../commands/seamRoll";
import type { RollPreview } from "../edit/clipEdgePreview";
import { type Seam, seamsOnTrack, seamTitle } from "../edit/seam";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { Seam as SeamMark, type SeamRoll } from "../system/Seam";
import { joinKind, markerLabel } from "../utils/editMarkerRegistry";
import { formatRulerTime } from "../utils/time";
import { hitTargetProps } from "./hitTargets";

interface SeamLayerProps {
  trackId: string;
  zoomPxPerSec: number;
  rollPreview: RollPreview | null;
  onRollPreview: (preview: RollPreview | null) => void;
  isMoving: (clipId: string) => boolean;
  onSelectSeam: (seamId: string) => void;
}

function drawn(seam: Seam): boolean {
  return seam.abuts || seam.kind === "cut";
}

function seamLabel(seam: Seam): string {
  const at = formatRulerTime(seam.joinSec, 0.1);
  return seam.kind === "cut" ? `Cut at ${at}` : `Split at ${at}`;
}

function seamDetail(seam: Seam): string {
  const join = `${markerLabel(joinKind(seam.right))} join`;
  return seam.kind === "cut" ? `${seamTitle(seam)} · ${join}` : join;
}

function SeamDiamond({
  seam,
  zoomPxPerSec,
  rolledSec,
  selected,
  onSelect,
  onRollPreview,
}: {
  seam: Seam;
  zoomPxPerSec: number;
  rolledSec: number;
  selected: boolean;
  onSelect: (seamId: string) => void;
  onRollPreview: (preview: RollPreview | null) => void;
}) {
  const say = useCallback((message: string) => {
    useDawStore.getState().announceStatus(message, { tone: "error" });
  }, []);
  const roll = useMemo<SeamRoll>(
    () => ({
      pxPerSec: zoomPxPerSec,
      limits: () => seamRollLimits(seam.id),
      onCommit: (deltaMs) => commitSeamRoll(seam.id, deltaMs, say),
      onPreview: (deltaMs) =>
        onRollPreview(
          deltaMs === null
            ? null
            : {
                leftClipId: seam.left.id,
                rightClipId: seam.right.id,
                deltaSec: deltaMs / 1000,
              },
        ),
    }),
    [seam.id, seam.left.id, seam.right.id, zoomPxPerSec, say, onRollPreview],
  );
  return (
    <span
      className="seam-mark"
      style={{ left: (seam.joinSec + rolledSec) * zoomPxPerSec }}
    >
      <SeamMark
        form="diamond"
        kind={seam.kind}
        label={seamLabel(seam)}
        detail={seamDetail(seam)}
        selected={selected}
        roll={roll}
        hit={hitTargetProps("roll", seam.right.id, seam.joinSec, { selected })}
        onSelect={() => onSelect(seam.id)}
      />
    </span>
  );
}

export function SeamLayer({
  trackId,
  zoomPxPerSec,
  rollPreview,
  onRollPreview,
  isMoving,
  onSelectSeam,
}: SeamLayerProps) {
  const project = useDaw((s) => s.project);
  const selectedId = useDaw((s) =>
    s.selection?.kind === "seam" ? s.selection.id : null,
  );
  const seams = useMemo(
    () => (project ? seamsOnTrack(project, trackId) : []),
    [project, trackId],
  );
  return (
    <>
      {seams
        .filter(
          (seam) =>
            drawn(seam) && !isMoving(seam.left.id) && !isMoving(seam.right.id),
        )
        .map((seam) => (
          <SeamDiamond
            key={seam.id}
            seam={seam}
            zoomPxPerSec={zoomPxPerSec}
            rolledSec={
              rollPreview?.leftClipId === seam.left.id &&
              rollPreview.rightClipId === seam.right.id
                ? rollPreview.deltaSec
                : 0
            }
            selected={selectedId === seam.id}
            onSelect={onSelectSeam}
            onRollPreview={onRollPreview}
          />
        ))}
    </>
  );
}
