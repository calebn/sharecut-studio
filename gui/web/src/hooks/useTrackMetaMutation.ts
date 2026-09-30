import { setTrackMetaCommand } from "../api";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { patchTrackMeta } from "../document/projectPatch";
import { useDawStore } from "../state/dawStore";
import { useProjectMutation } from "./useProjectMutation";

export function useTrackMetaMutation(trackId: string) {
  const mutation = useProjectMutation();
  const saveMetaFields = async (
    fields: Parameters<typeof setTrackMetaCommand>[2],
  ) => {
    const previous = useDawStore.getState().project;
    const seqAtStart = currentDocumentSeq();
    const optimistic = previous
      ? patchTrackMeta(previous, trackId, fields)
      : null;
    if (optimistic) useDawStore.getState().setProject(optimistic);
    return mutation.run(async () => {
      try {
        const result = await setTrackMetaCommand(
          mutation.projectPath,
          trackId,
          fields,
        );
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
        if (previous && optimistic)
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
