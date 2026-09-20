import { useCallback } from "react";
import { splitAtTime } from "../api";
import { canSuggestStructural } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { bladeTrackIds } from "../utils/bladeTracks";
import { useProjectMutation } from "./useProjectMutation";

/** Shared blade cut apply/propose + optional mobile confirm. */
export function useBladeCut() {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    selectedTrackIds,
    shellBreakpoint,
    setBladeConfirmSec,
    bladeConfirmSec,
  } = useDaw();
  const { busy, error, setError, run } = useProjectMutation();

  const allowed = canSuggestStructural(
    projectPath,
    guestMode,
    shareCapabilities,
  );

  const dialogueIds = useCallback(
    () =>
      (project?.tracks ?? [])
        .filter((t) => t.role === "dialogue")
        .map((t) => t.id),
    [project],
  );

  const executeAt = useCallback(
    async (atTime: number) => {
      if (!allowed || !project) {
        return;
      }
      const tids = bladeTrackIds(selectedTrackIds, dialogueIds());
      await run(async () => {
        await splitAtTime(projectPath, atTime, tids);
        setBladeConfirmSec(null);
      });
    },
    [
      allowed,
      project,
      selectedTrackIds,
      dialogueIds,
      projectPath,
      run,
      setBladeConfirmSec,
    ],
  );

  const requestCut = useCallback(
    (atTime: number) => {
      if (!allowed) {
        setError("Share capabilities do not allow blade cuts");
        return;
      }
      if (shellBreakpoint === "phone" || shellBreakpoint === "tablet") {
        setBladeConfirmSec(atTime);
        return;
      }
      void executeAt(atTime);
    },
    [allowed, setError, shellBreakpoint, setBladeConfirmSec, executeAt],
  );

  const confirmPending = useCallback(() => {
    if (bladeConfirmSec == null) {
      return;
    }
    void executeAt(bladeConfirmSec);
  }, [bladeConfirmSec, executeAt]);

  const cancelPending = useCallback(() => {
    setBladeConfirmSec(null);
  }, [setBladeConfirmSec]);

  return {
    allowed,
    busy,
    error,
    setError,
    requestCut,
    executeAt,
    confirmPending,
    cancelPending,
    bladeConfirmSec,
    trackIdsForCut: bladeTrackIds(selectedTrackIds, dialogueIds()),
  };
}
