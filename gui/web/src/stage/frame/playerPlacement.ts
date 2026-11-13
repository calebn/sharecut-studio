import { stageRoleOf } from "../../state/stageRoutes";
import type { ShellBreakpoint } from "../../state/types";
import type { StageId, StageRole } from "../../types/stage";

/**
 * Which Player form a frame shows, and where.
 * - `bar`: the 56 px bar at the frame bottom; tap the time to expand it.
 * - `dock`: the Listen dock at the frame bottom, which never expands (phone
 *   Viewer and Commenter on Review).
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
}): PlayerPlacement {
  const { stage, shell, role, short } = input;
  if (stage === "record") return "none";
  if (stage !== "review") return "bar";
  if (shell === "phone") {
    return role === "viewer" || role === "commenter" ? "dock" : "bar";
  }
  return role !== "host" && !short ? "card" : "bar";
}

/** Whether the phone Listen layout (the dock under a Script) hosts Review for this link. */
export function listenLayoutOf(
  shell: ShellBreakpoint,
  guestMode: string | null,
): boolean {
  return (
    playerPlacementOf({
      stage: "review",
      shell,
      role: stageRoleOf(guestMode),
      short: false,
    }) === "dock"
  );
}
