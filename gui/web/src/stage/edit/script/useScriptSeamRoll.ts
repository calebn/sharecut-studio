import { useMemo } from "react";
import { rollClipJoin } from "../../../api";
import { loadBoundaryContext } from "../../../api/boundary";
import { rollJoinInterval } from "../../../edit/rollLimits";
import { canApplyPass12 } from "../../../shareMode";
import { useDawStore } from "../../../state/dawStore";
import { trackEditSave } from "../../../state/documentSendOrder";
import { errorMessage } from "../../../utils/apiError";

/** The two clips a cut's join rolls between, with the room the sources leave. */
function joinOf(id: string) {
  const s = useDawStore.getState();
  if (!canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities))
    return null;
  const boundary = s.project?.edit_boundaries?.find((b) => b.id === id);
  if (!boundary?.right_clip_id) return null;
  const lane = s.project?.clips.tracks[boundary.track_id] ?? [];
  return rollJoinInterval(lane, boundary.left_clip_id, boundary.right_clip_id);
}

/**
 * Rolling a cut's seam from its pill in the Script. A roll needs clips that
 * abut, the rule the timeline draws a seam by; across a gap the pill has no
 * edges to drag. The roll's token is read when the drag lets go, and a failed
 * save is said in the Script's status line.
 */
export function useScriptSeamRoll(say: (message: string) => void) {
  return useMemo(
    () => ({
      limits: (id: string) => {
        const interval = joinOf(id);
        return interval
          ? { minMs: interval.lo * 1000, maxMs: interval.hi * 1000 }
          : null;
      },
      commit: (id: string, deltaMs: number) => {
        const interval = joinOf(id);
        if (!interval) return;
        const { projectPath, projectEpoch } = useDawStore.getState();
        const { left, right } = interval;
        const save = (async () => {
          const context = await loadBoundaryContext(
            projectPath,
            { kind: "roll", left_clip_id: left.id, right_clip_id: right.id },
            [left, right].map(
              ({
                id,
                source_start,
                source_end,
                timeline_start,
                source_id,
              }) => ({
                id,
                source_start,
                source_end,
                timeline_start,
                source_id,
              }),
            ),
          );
          const now = useDawStore.getState();
          if (
            now.projectPath !== projectPath ||
            now.projectEpoch !== projectEpoch
          )
            throw new Error("The project changed during the roll");
          await rollClipJoin(
            projectPath,
            left.id,
            right.id,
            deltaMs / 1000,
            context.token,
          );
        })().catch((error) => {
          say(`Could not roll the seam. ${errorMessage(error)}`);
        });
        void trackEditSave(projectPath, save);
      },
    }),
    [say],
  );
}
