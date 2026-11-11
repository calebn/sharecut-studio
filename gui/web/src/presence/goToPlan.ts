import type { SessionClient } from "../types/session";
import type { StageId } from "../types/stage";
import { type FollowApply, planFollowUi } from "./followPlan";
import { type FollowUiCaps, remotePlayheadSec } from "./followSync";

export type GoToPlan = {
  apply: FollowApply;
  sec: number | null;
  moves: boolean;
};

export function planGoTo(
  client: Pick<SessionClient, "meta" | "playhead_sec">,
  caps: FollowUiCaps,
  durationSec: number,
  currentStage: StageId,
  nowMs?: number,
): GoToPlan | null {
  const { apply, degraded } = planFollowUi(client.meta?.ui ?? {}, caps);
  if (degraded.tab) return null;
  const sec = remotePlayheadSec(client, durationSec, nowMs);
  return {
    apply,
    sec,
    moves:
      (apply.stage !== undefined && apply.stage.stage !== currentStage) ||
      apply.editSurface !== undefined ||
      sec !== null,
  };
}
