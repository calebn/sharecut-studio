import { isTauri } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { revealProjectFolder } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { errorMessage } from "../../utils/apiError";

/**
 * Reveal in folder for the open episode, or undefined where it cannot work:
 * only the desktop app is on the computer that holds the folder.
 */
export function useRevealProjectFolder(
  projectPath: string | undefined,
): (() => void) | undefined {
  const reveal = useCallback(() => {
    if (projectPath === undefined) return;
    revealProjectFolder(projectPath).catch((error) =>
      useDawStore
        .getState()
        .announceStatus(errorMessage(error), { toast: false, tone: "error" }),
    );
  }, [projectPath]);
  return projectPath !== undefined && isTauri() ? reveal : undefined;
}
