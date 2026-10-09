import { useMemo } from "react";
import { rollClipJoin, trimClipEdge } from "../api";
import type { BoundaryGeometryClip } from "../api/boundary";
import { rollJoinInterval } from "../edit/rollLimits";
import { canApplyPass12, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { resolveBoundaryPresentation } from "./boundaryPresentation";
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
  const presentation = resolveBoundaryPresentation(leftClip, neighbour);
  const rightClip = presentation.kind === "roll" ? neighbour : null;
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
      getRollInterval={() =>
        leftClip && rightClip
          ? rollJoinInterval(
              useDawStore.getState().project?.clips.tracks[leftClip.track_id] ??
                [],
              leftClip.id,
              rightClip.id,
            )
          : null
      }
      onRoll={(l, r, d, token) => rollClipJoin(projectPath, l, r, d, token)}
      onTrim={(id, edge, sec, mode, token) =>
        trimClipEdge(projectPath, id, edge, sec, mode, token)
      }
      presentation={presentation}
      target={presentation.target ?? undefined}
      expectedGeometry={expectedGeometry}
      canEdit={canQuickEdit}
      canOpenPrecision={canOpenPrecision}
    />
  );
}
