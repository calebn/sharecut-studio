import { stagesForRole } from "../../state/stageRoutes";
import type { StageId, StageRole } from "../../types/stage";

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

/** The shell load failed (or Try again is running): the stage body says so in place. */
export type LoadFailure = {
  message: string;
  onRetry: () => void;
  /** Try again is running: the button stays, busy. */
  recovering?: boolean;
};

export type HostState = "loading" | "error" | "ready";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  if (project != null) return "ready";
  return loadFailure ? "error" : "loading";
}
