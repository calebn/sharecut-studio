import { useCallback, useRef } from "react";
import { hearAcross, type SeamCommit } from "../../commands/seamCommands";
import { seamById } from "../../edit/seam";
import { useDawStore } from "../../state/dawStore";
import { inspectorOpenFor } from "../../state/selection";

export function useSeamReplay() {
  const generation = useRef(0);
  const supersede = useCallback(() => {
    generation.current += 1;
  }, []);
  const commit = useCallback(
    async (
      seamId: string,
      save: () => Promise<SeamCommit>,
    ): Promise<SeamCommit> => {
      generation.current += 1;
      const mine = generation.current;
      const result = await save();
      if (result.status !== "done" || generation.current !== mine) {
        return result;
      }
      const s = useDawStore.getState();
      const open =
        s.selection?.kind === "seam" &&
        s.selection.id === seamId &&
        inspectorOpenFor(s.selection, s.inspectorKey);
      const seam = s.project ? seamById(s.project, seamId) : null;
      if (open && seam && !s.isPlaying) hearAcross(seam);
      return result;
    },
    [],
  );
  return { commit, supersede };
}
