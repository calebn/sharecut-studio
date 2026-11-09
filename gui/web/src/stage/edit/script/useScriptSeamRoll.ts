import { useMemo } from "react";
import {
  ROLL_QUEUED_MESSAGE,
  replayIfInspected,
  rollSeam,
  rollSkipMessage,
} from "../../../commands/seamCommands";
import { rollJoinInterval } from "../../../edit/rollLimits";
import { seamById } from "../../../edit/seam";
import { canApplyPass12 } from "../../../shareMode";
import { useDawStore } from "../../../state/dawStore";

/**
 * Rolling a cut's seam from its pill in the Script. A roll needs clips that
 * abut, the rule the timeline draws a seam by; across a gap the pill has no
 * edges to drag, and none while another seam save is in flight. The roll's
 * token is read when the drag lets go, and a failed save is said in the
 * Script's status line.
 */
export function useScriptSeamRoll(say: (message: string) => void) {
  return useMemo(
    () => ({
      limits: (id: string) => {
        const s = useDawStore.getState();
        if (
          !s.project ||
          s.joinMutationInFlight ||
          !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)
        )
          return null;
        const seam = seamById(s.project, id);
        const interval =
          seam &&
          rollJoinInterval(
            s.project.clips.tracks[seam.trackId] ?? [],
            seam.left.id,
            seam.right.id,
          );
        return interval
          ? { minMs: interval.lo * 1000, maxMs: interval.hi * 1000 }
          : null;
      },
      commit: (id: string, deltaMs: number) => {
        const { project } = useDawStore.getState();
        const seam = project ? seamById(project, id) : null;
        if (!seam) return;
        void rollSeam(seam, deltaMs).then((result) => {
          if (result.status === "failed")
            say(`Could not roll the seam. ${result.message}`);
          else if (result.status === "queued") say(ROLL_QUEUED_MESSAGE);
          else if (result.status === "skipped") {
            const reason = rollSkipMessage(seam, deltaMs);
            if (reason) say(reason);
          } else replayIfInspected(id);
        });
      },
    }),
    [say],
  );
}
