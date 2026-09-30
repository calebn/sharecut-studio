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
    if (previous) {
      useDawStore
        .getState()
        .setProject(patchTrackMeta(previous, trackId, fields));
    }
    return mutation.run(async () => {
      try {
        await setTrackMetaCommand(mutation.projectPath, trackId, fields);
        return true;
      } catch (error) {
        if (previous) revertOptimisticIfUnchanged(previous, seqAtStart);
        throw error;
      }
    });
  };
  return { ...mutation, saveMetaFields };
}
