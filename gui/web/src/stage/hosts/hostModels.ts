import type { ShellFailure } from "../../shellLoadFailure";
import { stagesForRole } from "../../state/stageRoutes";
import type { StageId, StageRole } from "../../types/stage";

/** True when the role's link may open the stage. */
export function stageAvailable(stage: StageId, role: StageRole): boolean {
  return stagesForRole(role).includes(stage);
}

/**
 * A load that failed, and what the stage body says about it. `shell` is the
 * studio's first read of the episode: it carries the kind of failure and no
 * text, so the cover can only say a fixed sentence. `detail` is the
 * transcript's own refresh, whose words are fixed.
 */
export type LoadFailure =
  | {
      source: "detail";
      onRetry: () => void;
      /** Try again is running: the button stays, busy. */
      recovering?: boolean;
    }
  | {
      source: "shell";
      cause: ShellFailure;
      /** The episode's name from its path, or empty; a guest's is always empty. */
      name: string;
      onRetry: () => void;
      /** Any attempt is in flight: the press, the page's own retry, the connection back. */
      trying?: boolean;
      /** All projects, for a host; a guest has none. */
      onHome?: () => void;
    };

export type HostState = "loading" | "error" | "ready";

export function hostStateOf(
  project: unknown,
  loadFailure: LoadFailure | null | undefined,
): HostState {
  // A standing failure wins: a project without its transcript and history is
  // not safe to work on, so every stage says so rather than going silent.
  if (loadFailure) return "error";
  return project != null ? "ready" : "loading";
}
