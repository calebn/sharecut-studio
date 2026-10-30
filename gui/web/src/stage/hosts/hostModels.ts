import { stagesForRole } from "../../state/stageRoutes";
import type { StageId, StageRole } from "../../types/stage";
import type { LoadFailure } from "../frame/LoadFailureBanner";

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

export type HostState = "loading" | "error" | "ready";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  if (project != null) return "ready";
  return loadFailure ? "error" : "loading";
}
