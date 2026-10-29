import { useCallback } from "react";
import { renameProjectCommand } from "../api";
import { redisplayDrafts } from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { useDawStore } from "../state/dawStore";

/**
 * Renames the open project (`meta.name` only; the folder and files keep their
 * names). A refusal rejects with the server's reason, and the title goes back
 * to what it was.
 */
export function useRenameProject(): (name: string) => Promise<void> {
  return useCallback(async (name: string) => {
    const state = useDawStore.getState();
    const previous = state.projectEditBasis();
    const projectPath = state.projectPath;
    if (!previous || !projectPath) throw new Error("No project is open.");
    const seqAtStart = currentDocumentSeq();
    // The command begins its draft before it first awaits, so showing the
    // drafts now shows the new name at once.
    const sending = renameProjectCommand(projectPath, name);
    redisplayDrafts();
    const optimistic = useDawStore.getState().project;
    try {
      await sending;
    } catch (error) {
      if (optimistic)
        revertOptimisticIfUnchanged(
          previous,
          seqAtStart,
          projectPath,
          optimistic,
        );
      throw error;
    }
  }, []);
}
