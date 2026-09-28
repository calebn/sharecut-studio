import type { ProjectView } from "../types/project";
import { useGuestSync } from "./useGuestSync";
import { useProjectPoll } from "./useProjectPoll";

type GuestSyncArgs = Parameters<typeof useGuestSync>;

/**
 * Share-guest sync plus the project meta poll, gated so a tab runs exactly one
 * project poll at a time (#657): hosts always run useProjectPoll; guests run it
 * only while their socket is live, since useGuestSync polls on its own otherwise.
 */
export function useGuestSyncAndProjectPoll(
  projectPath: string,
  applyAgentSession: GuestSyncArgs[1],
  setProject: (project: ProjectView) => void,
  opts: { hostSyncEnabled: boolean; guestSyncEnabled: boolean },
): void {
  const guestWsReady = useGuestSync(
    projectPath,
    applyAgentSession,
    setProject,
    opts.guestSyncEnabled,
  );
  useProjectPoll(projectPath, setProject, opts.hostSyncEnabled || guestWsReady);
}
