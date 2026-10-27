import { useCallback } from "react";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { useDawStore } from "../../state/dawStore";
import { errorMessage } from "../../utils/apiError";
import type { CleanupSettings } from "./PrepareView";
import { applyCleanup, cleanupFromConfig } from "./prepareMappers";

/**
 * Cleanup for this project: How tight sets the tighten intensity and Loudness
 * the master target in the project's saved pipeline settings, so the next run
 * (and Tighten and Export) use them.
 */
export function useCleanup(workingSet: PipelineWorkingSet) {
  const cleanup = cleanupFromConfig(workingSet.cfg?.config);
  const { update } = workingSet;
  const onCleanup = useCallback(
    (next: CleanupSettings) => {
      void update((current) => ({
        config: applyCleanup(current.config, next),
      })).catch((error: unknown) =>
        useDawStore
          .getState()
          .announceStatus(`Could not save Cleanup: ${errorMessage(error)}`, {
            tone: "error",
          }),
      );
    },
    [update],
  );
  return { cleanup, onCleanup };
}
