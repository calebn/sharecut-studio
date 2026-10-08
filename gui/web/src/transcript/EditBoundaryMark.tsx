import { useMemo } from "react";
import { rollClipJoin, trimClipEdge } from "../api";
import type { BoundaryGeometryClip, BoundaryTarget } from "../api/boundary";
import { rollNeighborBounds } from "../edit/clipEdgePreview";
import { clipsAbut } from "../edit/joinRender";
import { canApplyPass12, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { EditBoundaryMarkView } from "./EditBoundaryMarkView";

type Props = {
  boundary: EditBoundaryView;
  leftClip: ClipRow | null;
  rightClip: ClipRow | null;
};

/**
 * Live wiring: roll/trim commits, and roll clamps read from the store when a
 * drag starts (not on every project update). A roll needs clips that abut, the
 * rule the timeline draws a seam by (`clipsAbut`); across a gap the mark trims
 * the left clip's end instead.
 */
export function EditBoundaryMark({
  boundary,
  leftClip,
  rightClip: neighbour,
}: Props) {
  const rightClip =
    leftClip && neighbour && clipsAbut(leftClip, neighbour) ? neighbour : null;
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const canQuickEdit = canApplyPass12(
    projectPath,
    guestMode,
    shareCapabilities,
  );
  const canOpenPrecision = !guestMode && !isShareProjectKey(projectPath);
  const target = useMemo<BoundaryTarget | null>(() => {
    if (leftClip && rightClip)
      return {
        kind: "roll",
        left_clip_id: leftClip.id,
        right_clip_id: rightClip.id,
      };
    const clip = leftClip ?? rightClip;
    if (!clip) return null;
    return { kind: "trim", clip_id: clip.id, edge: leftClip ? "out" : "in" };
  }, [leftClip, rightClip]);
  const expectedGeometry = useMemo<BoundaryGeometryClip[]>(
    () =>
      [leftClip, rightClip]
        .filter((clip): clip is ClipRow => clip !== null)
        .map(({ id, source_start, source_end, timeline_start, source_id }) => ({
          id,
          source_start,
          source_end,
          timeline_start,
          source_id,
        })),
    [leftClip, rightClip],
  );
  return (
    <EditBoundaryMarkView
      projectPath={projectPath}
      boundary={boundary}
      leftClip={leftClip}
      rightClip={rightClip}
      getRollBounds={() =>
        rollNeighborBounds(useDawStore.getState().project, leftClip, rightClip)
      }
      onRoll={(l, r, d, token) => rollClipJoin(projectPath, l, r, d, token)}
      onTrim={(id, edge, sec, mode, token) =>
        trimClipEdge(projectPath, id, edge, sec, mode, token)
      }
      target={target ?? undefined}
      expectedGeometry={expectedGeometry}
      canEdit={canQuickEdit}
      canOpenPrecision={canOpenPrecision}
    />
  );
}
