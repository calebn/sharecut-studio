import { setTrackMetaCommand } from "../api";
import { redisplayDrafts } from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { useDawStore } from "../state/dawStore";
import { useProjectMutation } from "./useProjectMutation";

export function useTrackMetaMutation(trackId: string) {
  const mutation = useProjectMutation();
  const saveMetaFields = async (
    fields: Parameters<typeof setTrackMetaCommand>[2],
  ) => {
    const previous = useDawStore.getState().projectEditBasis();
    if (!previous) return;
    const seqAtStart = currentDocumentSeq();
    return mutation.run(async () => {
      // The command begins its draft before it first awaits, so showing the
      // drafts now shows the new metadata at once.
      const sending = setTrackMetaCommand(
        mutation.projectPath,
        trackId,
        fields,
      );
      redisplayDrafts();
      const optimistic = useDawStore.getState().project;
      try {
        const result = await sending;
        if (
          result.queued &&
          useDawStore.getState().projectPath === mutation.projectPath
        ) {
          useDawStore
            .getState()
            .announceStatus("Track metadata change queued. Still sending.");
        }
        return true;
      } catch (error) {
        if (optimistic)
          revertOptimisticIfUnchanged(
            previous,
            seqAtStart,
            mutation.projectPath,
            optimistic,
          );
        throw error;
      }
    });
  };
  return { ...mutation, saveMetaFields };
}
