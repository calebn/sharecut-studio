import { useCallback, useRef } from "react";
import {
  replayIfInspected,
  type SeamCommit,
} from "../../commands/seamCommands";

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
      replayIfInspected(seamId);
      return result;
    },
    [],
  );
  return { commit, supersede };
}
