import { listensOn } from "../../state/stageRoutes";
import type { ShellBreakpoint } from "../../state/types";
import type { StageId, StageRole } from "../../types/stage";
import { isHostRole } from "../../utils/can";

/**
 * Which Player form a frame shows, and where.
 * - `bar`: the 56 px bar at the frame bottom; tap the time to expand it.
 * - `dock`: the Listen dock at the frame bottom, which never expands (phone
 *   or handheld-landscape Viewer and Commenter on Review).
 * - `card`: the expanded form at the top of the guest center column (tablet
 *   and desktop guest Review).
 * - `none`: Record has no Player.
 */
export type PlayerPlacement = "bar" | "dock" | "card" | "none";

export function playerPlacementOf(input: {
  stage: StageId;
  shell: ShellBreakpoint;
  role: StageRole;
  /** A window too short for the transcript above a card. */
  short: boolean;
  /** A handheld phone held sideways (the tablet shell, the Listen layout). */
  handheld: boolean;
}): PlayerPlacement {
  const { stage, shell, role, short, handheld } = input;
  if (stage === "record") return "none";
  if (stage !== "review") return "bar";
  if (listensOn(shell, role, handheld)) return "dock";
  if (shell === "phone") return "bar";
  return !isHostRole(role) && !short ? "card" : "bar";
}
