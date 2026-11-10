import { rollJoinInterval } from "../edit/rollLimits";
import { seamById } from "../edit/seam";
import { canApplyPass12 } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  ROLL_QUEUED_MESSAGE,
  replayIfInspected,
  rollSeam,
  rollSkipMessage,
} from "./seamCommands";

export function seamRollLimits(
  seamId: string,
): { minMs: number; maxMs: number } | null {
  const s = useDawStore.getState();
  if (
    !s.project ||
    s.joinMutationInFlight ||
    !canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities)
  )
    return null;
  const seam = seamById(s.project, seamId);
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
}

export async function commitSeamRoll(
  seamId: string,
  deltaMs: number,
  say: (message: string) => void,
): Promise<void> {
  const { project } = useDawStore.getState();
  const seam = project ? seamById(project, seamId) : null;
  if (!seam) return;
  const result = await rollSeam(seam, deltaMs);
  if (result.status === "failed")
    say(`Could not roll the seam. ${result.message}`);
  else if (result.status === "queued") say(ROLL_QUEUED_MESSAGE);
  else if (result.status === "skipped") {
    const reason = rollSkipMessage(seam, deltaMs);
    if (reason) say(reason);
  } else replayIfInspected(seamId);
}
