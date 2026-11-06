import { isTauri } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { moveProjectFolder } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { errorMessage } from "../../utils/apiError";
import { projectUrl } from "../../utils/projectUrl";

const MOVE_UNAVAILABLE = "This computer has no folder dialog.";

/**
 * Move… for the open episode, or undefined where it cannot work: only the
 * desktop app is on the computer that holds the folder. After a move the app
 * reopens the episode from its new folder.
 */
export function useMoveProjectFolder(
  projectPath: string | undefined,
): (() => void) | undefined {
  const move = useCallback(() => {
    if (projectPath === undefined) return;
    const say = (message: string) =>
      useDawStore
        .getState()
        .announceStatus(message, { toast: false, tone: "error" });
    moveProjectFolder(projectPath)
      .then((result) => {
        if ("project_path" in result) {
          window.location.assign(
            projectUrl(window.location.href, result.project_path),
          );
        } else if ("unavailable" in result) {
          say(result.detail ?? MOVE_UNAVAILABLE);
        }
      })
      .catch((error) => say(errorMessage(error)));
  }, [projectPath]);
  return projectPath !== undefined && isTauri() ? move : undefined;
}
